//! AMQPush внутри FESB Toolkit: клиент брокеров AMQP 1.0.
//!
//! Модуль перенесён из отдельного приложения (github.com/DEADover/AMQPush)
//! целиком и живёт своей жизнью: собственное состояние, собственные файлы
//! в `~/.amqpush`, собственные команды. От хозяина окна он берёт только
//! окно, тему и место в навигации.
//!
//! Что осталось за бортом переноса — это не возможности, а обязанности
//! хозяина: иконка в Dock, меню «О программе» и проверка обновлений
//! у отдельного приложения были свои, здесь они принадлежат FESB Toolkit.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use fe2o3_amqp::{Receiver, Session};

pub mod amqp;
pub mod broker;
pub mod history_store;
pub mod notif_drainer;
pub mod profiles;
pub mod queues;
pub mod recordings;
pub mod subscriber;
pub mod templates;

use amqp::{AmqpClient, HistoryEntry, SendResult};
use broker::{BrokerConnection, BrokerConsumer, BrokerQueue, ManagementChannel, PeekedMessage};
use notif_drainer::DrainerHandle;
use profiles::Profile;
use queues::SavedQueue;
use recordings::{Recording, RecordingSummary};
use subscriber::SubscriberHandle;
use templates::Template;

impl AppState {
    /// Состояние модуля: клиент, подписчики и история отправок с диска.
    pub fn new() -> Self {
        Self {
            client: Arc::new(Mutex::new(AmqpClient::new())),
            shovel_target: Arc::new(Mutex::new(None)),
            subs: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(history_store::load())),
            mgmt: Arc::new(Mutex::new(None)),
            notif: Arc::new(Mutex::new(None)),
        }
    }
}

pub struct AppState {
    client: Arc<Mutex<AmqpClient>>,
    /// Secondary transient client used by the cross-broker shovel flow.
    /// Kept in its own slot so the user's primary connection isn't
    /// disturbed when shovel runs to a different broker. Opened on
    /// `shovel_open_target`, closed on `shovel_close_target` (or implicitly
    /// when the modal closes — the FE always pairs the two).
    shovel_target: Arc<Mutex<Option<AmqpClient>>>,
    /// Active subscriber tasks keyed by queue address. Multiple queues can be
    /// listened to concurrently; messages from all of them go through the
    /// shared `message_received` event tagged with `queue`.
    subs: Arc<Mutex<HashMap<String, SubscriberHandle>>>,
    history: Arc<Mutex<Vec<HistoryEntry>>>,
    /// Persistent management channel — opened lazily on first list_broker_queues
    /// call, reused across polls. Closed on disconnect.
    mgmt: Arc<Mutex<Option<ManagementChannel>>>,
    /// Background task that consumes `activemq.notifications` so internal
    /// broker events (BINDING_*, SESSION_CLOSED, …) don't accumulate in the
    /// DLQ. Started on connect, aborted on disconnect.
    notif: Arc<Mutex<Option<DrainerHandle>>>,
}

// ── connection ────────────────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn connect(
    state: tauri::State<'_, AppState>,
    host: String,
    port: u16,
    address: String,
    username: String,
    password: String,
    use_tls: bool,
    container_id: Option<String>,
    heartbeat_secs: Option<u32>,
    connect_timeout_secs: Option<u32>,
    sasl_anonymous: Option<bool>,
    tls_skip_verify: Option<bool>,
    // Reconnect-backoff settings — all optional so older callers (and the
    // command palette's "connect" action) still work. Subscribers attached
    // to this client read these on each reconnect.
    reconnect_base_ms: Option<u64>,
    reconnect_max_ms: Option<u64>,
    reconnect_multiplier: Option<f64>,
    // mTLS — optional path to a client certificate (PEM or PKCS#12), key
    // (PEM only), and passphrase (PKCS#12 only). Empty strings treated as
    // None so older callers / palette flows still work unchanged.
    client_cert_path: Option<String>,
    client_key_path: Option<String>,
    client_key_passphrase: Option<String>,
    // WebSocket transport — when true, AMQP rides over ws://host:port/<path>
    // (or wss:// when use_tls is also true). Useful behind corporate firewalls
    // that block 5671/5672, plus cloud brokers like Azure SB / Amazon MQ /
    // RabbitMQ with the web-amqp plugin.
    use_ws: Option<bool>,
    ws_path: Option<String>,
    // Send-retry knobs — per-profile budget for transient send failures.
    // Default 1 attempt + 250ms delay = no retry, matches pre-1.5.x behaviour.
    send_retry_attempts: Option<u32>,
    send_retry_delay_ms: Option<u64>,
) -> Result<(), String> {
    let client_cert = amqp::ClientCert {
        cert_path: client_cert_path.filter(|s| !s.trim().is_empty()),
        key_path: client_key_path.filter(|s| !s.trim().is_empty()),
        passphrase: client_key_passphrase.filter(|s| !s.is_empty()),
    };
    let transport = amqp::TransportOpts {
        use_ws: use_ws.unwrap_or(false),
        ws_path: ws_path.unwrap_or_default(),
    };
    let cert_clone = client_cert.clone();
    let transport_clone = transport.clone();
    {
        let mut client = state.client.lock().await;
        client
            .connect(
                &host,
                port,
                &address,
                &username,
                &password,
                use_tls,
                container_id.as_deref().unwrap_or(""),
                heartbeat_secs.unwrap_or(0),
                connect_timeout_secs.unwrap_or(10),
                sasl_anonymous.unwrap_or(false),
                tls_skip_verify.unwrap_or(false),
                client_cert,
                transport,
            )
            .await?;
        client.reconnect_base_ms = reconnect_base_ms.unwrap_or(1_000);
        client.reconnect_max_ms = reconnect_max_ms.unwrap_or(30_000);
        client.reconnect_multiplier = reconnect_multiplier.unwrap_or(2.0);
        client.send_retry_attempts = send_retry_attempts.unwrap_or(1).max(1);
        client.send_retry_delay_ms = send_retry_delay_ms.unwrap_or(250);
    }

    // Spawn the notifications drainer so internal broker events
    // (BINDING_*, SESSION_CLOSED, …) don't accumulate in the DLQ. Failure to
    // attach is non-fatal — some brokers don't expose notifications, or
    // permissions may forbid it; in either case the user just sees the same
    // DLQ behaviour as before, no other functionality is affected.
    {
        let mut notif = state.notif.lock().await;
        if let Some(old) = notif.take() {
            old.stop();
        }
        match notif_drainer::start(
            &host, port, &username, &password,
            use_tls, tls_skip_verify.unwrap_or(false),
            cert_clone, transport_clone,
        ).await {
            Ok(handle) => *notif = Some(handle),
            Err(e) => eprintln!("notif_drainer: not started ({e})"),
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    // Stop all subscribers if running
    {
        let mut subs = state.subs.lock().await;
        for (_, h) in subs.drain() { h.stop(); }
    }
    // Stop notifications drainer
    {
        let mut notif = state.notif.lock().await;
        if let Some(h) = notif.take() {
            h.stop();
        }
    }
    // Close management channel cleanly
    {
        let mut mgmt = state.mgmt.lock().await;
        if let Some(chan) = mgmt.take() {
            chan.close().await;
        }
    }
    let mut client = state.client.lock().await;
    client.disconnect().await
}

#[tauri::command]
pub async fn connection_info(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let client = state.client.lock().await;
    Ok(client.connection_info())
}

// ── messaging ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn send_message(
    state: tauri::State<'_, AppState>,
    address: String,
    text: Option<String>,
    file_name: Option<String>,
    file_data_b64: Option<String>,
    custom_props: HashMap<String, String>,
    reply_to: Option<String>,
    profile: Option<String>,
) -> Result<SendResult, String> {
    let reply_to_for_history = reply_to.clone();
    let result = {
        let mut client = state.client.lock().await;
        client
            .send_message(&address, text.clone(), file_name.clone(), file_data_b64.clone(), custom_props.clone(), reply_to)
            .await?
    };

    // Record history
    let mut history = state.history.lock().await;
    let body_preview = text
        .as_deref()
        .map(|t| t.chars().take(120).collect::<String>())
        .unwrap_or_else(|| format!("(file: {})", file_name.as_deref().unwrap_or("?")));

    // Store file content only for small files (≤ ~2 MB base64) so we can resend
    // without re-picking. Larger files are skipped to avoid bloating history.
    const MAX_BASE64_KEEP: usize = 2 * 1024 * 1024 + 4096;
    let kept_file_data = file_data_b64
        .as_ref()
        .filter(|b| b.len() <= MAX_BASE64_KEEP)
        .cloned();

    // Capture everything that goes on the wire alongside user-set custom_props.
    // Mirrors the construction in amqp::send_message.
    let mut auto_properties: HashMap<String, String> = HashMap::new();
    auto_properties.insert("message-id".into(), result.message_id.clone());
    auto_properties.insert("creation-time".into(), result.timestamp.clone());
    auto_properties.insert("priority".into(), "4".into());
    auto_properties.insert("durable".into(), "false".into());
    if let Some(ref rt) = reply_to_for_history {
        auto_properties.insert("reply-to".into(), rt.clone());
    }
    auto_properties.insert("_AMQ_ROUTING_TYPE".into(), "1".into());
    auto_properties.insert("is_file".into(), file_name.is_some().to_string());
    if let Some(ref name) = file_name {
        auto_properties.insert("file_name".into(), name.clone());
    }

    history.push(HistoryEntry {
        id: result.message_id.clone(),
        timestamp: result.timestamp.clone(),
        address: address.clone(),
        profile: profile.filter(|s| !s.is_empty()),
        body_preview,
        body_full: text,
        is_file: file_name.is_some(),
        file_name,
        file_data_b64: kept_file_data,
        properties: custom_props,
        auto_properties,
    });
    // Keep last 200 entries
    if history.len() > 200 {
        let drain_to = history.len() - 200;
        history.drain(0..drain_to);
    }

    // Persist to disk so history survives app restarts
    history_store::save(&history);

    Ok(result)
}

// ── subscriber ────────────────────────────────────────────────────────────────

/// Start a subscriber on `address`. `selector` is an optional JMS-style
/// filter expression (e.g. `priority > 5 AND type = 'order'`); empty or
/// `None` = no filter, broker delivers everything.
#[tauri::command]
pub async fn start_subscriber(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    address: String,
    selector: Option<String>,
    topic_pattern: Option<String>,
) -> Result<(), String> {
    let selector = selector.unwrap_or_default();
    let topic_pattern = topic_pattern.unwrap_or_default();
    let addr = address.trim().to_string();
    if addr.is_empty() {
        return Err("Queue address is required".into());
    }

    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport, base_ms, max_ms, mult) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected to broker".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
            client.reconnect_base_ms,
            client.reconnect_max_ms,
            client.reconnect_multiplier,
        )
    };

    // Reject duplicate subscriptions — surface a clear error rather than
    // silently replacing an existing receiver.
    {
        let subs = state.subs.lock().await;
        if subs.contains_key(&addr) {
            return Err(format!("Already subscribed to '{addr}'"));
        }
    }

    let handle = subscriber::start(
        &host, port, addr.clone(), &username, &password,
        use_tls, tls_skip_verify, client_cert, transport, selector, topic_pattern,
        base_ms, max_ms, mult,
        app,
    ).await?;

    let mut subs = state.subs.lock().await;
    subs.insert(addr, handle);
    Ok(())
}

/// Stop a subscriber. If `address` is `Some`, stop only that one; otherwise
/// stop all active subscribers.
#[tauri::command]
pub async fn stop_subscriber(
    state: tauri::State<'_, AppState>,
    address: Option<String>,
) -> Result<(), String> {
    let mut subs = state.subs.lock().await;
    if let Some(addr) = address {
        if let Some(h) = subs.remove(&addr) {
            h.stop();
        }
    } else {
        for (_, h) in subs.drain() { h.stop(); }
    }
    Ok(())
}

/// List addresses currently being subscribed to.
#[tauri::command]
pub async fn list_subscribers(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let subs = state.subs.lock().await;
    Ok(subs.keys().cloned().collect())
}

// ── history ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_history(state: tauri::State<'_, AppState>) -> Result<Vec<HistoryEntry>, String> {
    let history = state.history.lock().await;
    Ok(history.iter().rev().cloned().collect())
}

#[tauri::command]
pub async fn clear_history(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut history = state.history.lock().await;
    history.clear();
    history_store::save(&history);
    Ok(())
}

// ── profiles ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_profiles() -> Vec<Profile> {
    profiles::load_all()
}

#[tauri::command]
pub fn save_profile(profile: Profile) -> Result<(), String> {
    profiles::save(profile)
}

#[tauri::command]
pub fn delete_profile(name: String) -> Result<(), String> {
    profiles::delete(&name)
}

#[tauri::command]
pub fn export_profiles(path: String) -> Result<usize, String> {
    profiles::export_to(&path)
}

#[tauri::command]
pub fn import_profiles(path: String, overwrite: bool) -> Result<profiles::ImportSummary, String> {
    profiles::import_from(&path, overwrite)
}

// ── saved queues ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_saved_queues() -> Vec<SavedQueue> {
    queues::load_all()
}

#[tauri::command]
pub fn save_queue(queue: SavedQueue) -> Result<(), String> {
    queues::save(queue)
}

#[tauri::command]
pub fn delete_queue(name: String) -> Result<(), String> {
    queues::delete(&name)
}

// ── templates ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_templates() -> Vec<Template> {
    templates::load_all()
}

#[tauri::command]
pub fn save_template(template: Template) -> Result<(), String> {
    templates::save(template);
    Ok(())
}

#[tauri::command]
pub fn delete_template(name: String) -> Result<(), String> {
    templates::delete(&name);
    Ok(())
}

#[tauri::command]
pub fn rename_template(old_name: String, new_name: String) -> Result<(), String> {
    templates::rename(&old_name, &new_name)
}

// ── recordings (Receive recording + replay) ──────────────────────────────────

#[tauri::command]
pub fn list_recordings() -> Vec<RecordingSummary> {
    recordings::list_summaries()
}

#[tauri::command]
pub fn get_recording(name: String) -> Result<Recording, String> {
    recordings::load_one(&name)
}

#[tauri::command]
pub fn save_recording(recording: Recording) -> Result<(), String> {
    recordings::save_one(&recording)
}

#[tauri::command]
pub fn delete_recording(name: String) -> Result<(), String> {
    recordings::delete_one(&name)
}

/// Walk a saved recording and resubmit each message to `target` with
/// inter-message delays scaled by `speed` (1.0 = real-time, 2.0 = twice as
/// fast, 0.0 / negative = max speed / no delays). Emits `replay_progress`
/// events so the UI can render a progress bar / cancel button. Stops cleanly
/// on cancel via the abort handle stored in `AppState`.
#[tauri::command]
pub async fn play_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    target: String,
    speed: f64,
) -> Result<(), String> {
    use tauri::Emitter;
    let target = target.trim().to_string();
    if target.is_empty() {
        return Err("Target queue is required".into());
    }
    if !state.client.lock().await.is_connected() {
        return Err("Not connected to broker".into());
    }
    let rec = recordings::load_one(&name)?;
    if rec.messages.is_empty() {
        return Err("Recording has no messages".into());
    }

    // Compute the inter-message gap (ms) scaled by speed. Treat speed <= 0
    // as "max speed" — send back-to-back with no delays.
    let total = rec.messages.len();
    let mut prev_offset: u64 = 0;
    for (i, m) in rec.messages.iter().enumerate() {
        if i > 0 && speed > 0.0 {
            let gap = m.offset_ms.saturating_sub(prev_offset) as f64 / speed.max(0.01);
            if gap > 0.5 {
                tokio::time::sleep(std::time::Duration::from_millis(gap as u64)).await;
            }
        }
        prev_offset = m.offset_ms;

        let mut client = state.client.lock().await;
        let send_res = client.send_message(
            &target,
            Some(m.body.clone()),
            None,
            None,
            m.properties.clone(),
            None,
        ).await;
        drop(client);

        let ok = send_res.is_ok();
        if let Err(e) = send_res {
            let _ = app.emit("replay_progress", serde_json::json!({
                "step": i + 1, "total": total, "ok": false, "error": e.to_string(),
            }));
            return Err(format!("Replay aborted at message {}/{}: {e}", i + 1, total));
        }
        let _ = app.emit("replay_progress", serde_json::json!({
            "step": i + 1, "total": total, "ok": ok,
        }));
    }
    Ok(())
}

/// Try to attach a sender link to `address`. On brokers with auto-create-queues
/// (ActiveMQ Classic/Artemis default config) this creates the queue if absent.
/// Returns Ok(()) if the address is reachable, Err if the broker refuses it.
#[tauri::command]
pub async fn verify_queue(
    state: tauri::State<'_, AppState>,
    address: String,
) -> Result<(), String> {
    let mut client = state.client.lock().await;
    client.verify_queue(&address).await
}

// ── shovel (cross-broker copy / move) ────────────────────────────────────────

/// Build an `AmqpClient::connect`-friendly bundle from a saved `Profile`.
/// Used by the shovel target-open command to translate the JSON profile
/// shape into our internal types (TLS / cert / transport / SASL flags).
fn profile_to_connect_params(p: &Profile) -> (amqp::ClientCert, amqp::TransportOpts) {
    let cert = amqp::ClientCert {
        cert_path: if p.client_cert_path.trim().is_empty() { None } else { Some(p.client_cert_path.clone()) },
        key_path:  if p.client_key_path.trim().is_empty()  { None } else { Some(p.client_key_path.clone()) },
        passphrase: if p.client_key_passphrase.is_empty()  { None } else { Some(p.client_key_passphrase.clone()) },
    };
    let transport = amqp::TransportOpts {
        use_ws: p.use_ws,
        ws_path: p.ws_path.clone(),
    };
    (cert, transport)
}

/// Open a transient AMQP client connection to the shovel target profile.
/// Held in `AppState::shovel_target` separately from the user's primary
/// connection so the active session isn't disturbed. The FE always pairs
/// this with `shovel_close_target` when the shovel modal closes.
#[tauri::command]
pub async fn shovel_open_target(
    state: tauri::State<'_, AppState>,
    profile: Profile,
) -> Result<(), String> {
    let (cert, transport) = profile_to_connect_params(&profile);
    let mut client = AmqpClient::new();
    client
        .connect(
            &profile.host,
            profile.port,
            "",                              // no default address; senders attach lazily
            &profile.username,
            &profile.password,
            profile.use_tls,
            profile.container_id.as_str(),
            profile.heartbeat_secs,
            profile.connect_timeout_secs,
            profile.sasl_anonymous,
            profile.tls_skip_verify,
            cert,
            transport,
        )
        .await
        .map_err(|e| format!("Shovel target connect: {e}"))?;
    let mut slot = state.shovel_target.lock().await;
    if let Some(mut old) = slot.take() {
        // Replacing an existing target — close the old one to avoid stranded
        // connections on the previous broker.
        old.disconnect().await.ok();
    }
    *slot = Some(client);
    Ok(())
}

/// Send one message through the shovel target connection. Used in the
/// frontend's peek→transform→send loop. Errors out with a clear message
/// if the target hasn't been opened, so the caller can re-open and retry.
#[tauri::command]
pub async fn shovel_send_to_target(
    state: tauri::State<'_, AppState>,
    target: String,
    body: String,
    custom_props: HashMap<String, String>,
) -> Result<SendResult, String> {
    let mut slot = state.shovel_target.lock().await;
    let client = slot.as_mut()
        .ok_or("Shovel target is not open — call shovel_open_target first")?;
    client.send_message(&target, Some(body), None, None, custom_props, None).await
}

/// Tear down the transient shovel target connection. Idempotent — calling
/// when nothing is open is a no-op so the FE can fire-and-forget on modal
/// close.
#[tauri::command]
pub async fn shovel_close_target(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.shovel_target.lock().await;
    if let Some(mut client) = slot.take() {
        client.disconnect().await.ok();
    }
    Ok(())
}

// ── broker management (Artemis / ActiveMQ Classic with AMQP) ────────────────

#[tauri::command]
pub async fn list_broker_queues(state: tauri::State<'_, AppState>) -> Result<Vec<BrokerQueue>, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };

    let mut mgmt_guard = state.mgmt.lock().await;

    // Lazily open the management channel on first use
    if mgmt_guard.is_none() {
        let chan = ManagementChannel::open(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport).await?;
        *mgmt_guard = Some(chan);
    }

    // Try the call. On failure, drop the channel — next call will reopen.
    let chan = mgmt_guard.as_mut().expect("just opened");
    match broker::list_queues_via(chan).await {
        Ok(list) => Ok(list),
        Err(e) => {
            // Channel may be in a bad state — close it so next call re-opens fresh
            if let Some(c) = mgmt_guard.take() {
                c.close().await;
            }
            Err(e)
        }
    }
}

/// Round-trip latency probe against the broker — issues a trivial
/// management RPC and returns milliseconds. Used by the header's live
/// latency indicator. Reuses the same management channel as the queue
/// list so a healthy refresh / ping costs the broker effectively nothing.
#[tauri::command]
pub async fn ping_broker(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };

    let mut mgmt_guard = state.mgmt.lock().await;
    if mgmt_guard.is_none() {
        let chan = ManagementChannel::open(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport).await?;
        *mgmt_guard = Some(chan);
    }
    let chan = mgmt_guard.as_mut().expect("just opened");
    match broker::ping_via(chan).await {
        Ok(ms) => Ok(ms),
        Err(e) => {
            if let Some(c) = mgmt_guard.take() {
                c.close().await;
            }
            Err(e)
        }
    }
}

/// List active broker connections (clients currently attached). Surfaces
/// the data behind the Inspector view. Reuses the long-lived management
/// channel; on RPC failure we drop it so the next call reopens.
#[tauri::command]
pub async fn list_broker_connections(state: tauri::State<'_, AppState>) -> Result<Vec<BrokerConnection>, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };

    let mut mgmt_guard = state.mgmt.lock().await;
    if mgmt_guard.is_none() {
        let chan = ManagementChannel::open(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport).await?;
        *mgmt_guard = Some(chan);
    }
    let chan = mgmt_guard.as_mut().expect("just opened");
    match broker::list_connections_via(chan).await {
        Ok(list) => Ok(list),
        Err(e) => {
            if let Some(c) = mgmt_guard.take() {
                c.close().await;
            }
            Err(e)
        }
    }
}

/// List all active consumers attached to the broker. Used by the Inspector
/// view (grouped by connection / queue) and by the "who holds this message?"
/// drill-down in the Browser. Reuses the management channel.
#[tauri::command]
pub async fn list_broker_consumers(state: tauri::State<'_, AppState>) -> Result<Vec<BrokerConsumer>, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };

    let mut mgmt_guard = state.mgmt.lock().await;
    if mgmt_guard.is_none() {
        let chan = ManagementChannel::open(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport).await?;
        *mgmt_guard = Some(chan);
    }
    let chan = mgmt_guard.as_mut().expect("just opened");
    match broker::list_consumers_via(chan).await {
        Ok(list) => Ok(list),
        Err(e) => {
            if let Some(c) = mgmt_guard.take() {
                c.close().await;
            }
            Err(e)
        }
    }
}

/// Raw `listConnectionsAsJSON` payload — verbatim broker output. Used by
/// the Clients view "Raw" debug toggle so the user can see exactly what
/// the broker reports when fields appear empty (field-name mismatch is
/// the usual culprit across Artemis versions).
#[tauri::command]
pub async fn fetch_broker_connections_raw(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };

    let mut mgmt_guard = state.mgmt.lock().await;
    if mgmt_guard.is_none() {
        let chan = ManagementChannel::open(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport).await?;
        *mgmt_guard = Some(chan);
    }
    let chan = mgmt_guard.as_mut().expect("just opened");
    match broker::fetch_connections_raw_via(chan).await {
        Ok(s) => Ok(s),
        Err(e) => {
            if let Some(c) = mgmt_guard.take() {
                c.close().await;
            }
            Err(e)
        }
    }
}

/// Raw `listAllConsumersAsJSON` payload. Companion to the connections raw
/// fetch above.
#[tauri::command]
pub async fn fetch_broker_consumers_raw(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };

    let mut mgmt_guard = state.mgmt.lock().await;
    if mgmt_guard.is_none() {
        let chan = ManagementChannel::open(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport).await?;
        *mgmt_guard = Some(chan);
    }
    let chan = mgmt_guard.as_mut().expect("just opened");
    match broker::fetch_consumers_raw_via(chan).await {
        Ok(s) => Ok(s),
        Err(e) => {
            if let Some(c) = mgmt_guard.take() {
                c.close().await;
            }
            Err(e)
        }
    }
}

/// Delete every message currently in the queue (destructive — UI must
/// confirm with the user before invoking). Returns the count of messages
/// that were removed. Reuses the long-lived management channel so we don't
/// spam SESSION_CLOSED notifications on every purge.
#[tauri::command]
pub async fn purge_queue(state: tauri::State<'_, AppState>, queue: String) -> Result<i64, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };

    let mut mgmt_guard = state.mgmt.lock().await;
    if mgmt_guard.is_none() {
        let chan = ManagementChannel::open(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport).await?;
        *mgmt_guard = Some(chan);
    }
    let chan = mgmt_guard.as_mut().expect("just opened");
    match broker::purge_queue_via(chan, &queue).await {
        Ok(removed) => Ok(removed),
        Err(e) => {
            if let Some(c) = mgmt_guard.take() {
                c.close().await;
            }
            Err(e)
        }
    }
}

/// Selectively delete N messages from a queue by their AMQP message-id.
/// Requires Artemis or ActiveMQ Classic with AMQP — uses the same
/// management RPC as `purge_queue`. Returns the count actually removed.
#[tauri::command]
pub async fn remove_messages_by_ids(
    state: tauri::State<'_, AppState>,
    queue: String,
    message_ids: Vec<String>,
) -> Result<i64, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };

    let mut mgmt_guard = state.mgmt.lock().await;
    if mgmt_guard.is_none() {
        let chan = ManagementChannel::open(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport).await?;
        *mgmt_guard = Some(chan);
    }
    let chan = mgmt_guard.as_mut().expect("just opened");
    match broker::remove_messages_by_ids_via(chan, &queue, &message_ids).await {
        Ok(removed) => Ok(removed),
        Err(e) => {
            if let Some(c) = mgmt_guard.take() {
                c.close().await;
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn peek_messages(
    state: tauri::State<'_, AppState>,
    queue: String,
    max: u32,
    timeout_ms: u64,
) -> Result<Vec<PeekedMessage>, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (
            client.host.clone(),
            client.port,
            client.username.clone(),
            client.password.clone(),
            client.use_tls,
            client.tls_skip_verify,
            client.client_cert.clone(),
            client.transport.clone(),
        )
    };
    broker::peek_messages(&host, port, &username, &password, use_tls, tls_skip_verify, &client_cert, &transport, &queue, max, timeout_ms)
        .await
}

// ── request-reply ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn await_reply(
    state: tauri::State<'_, AppState>,
    address: String,
    timeout_ms: u64,
) -> Result<Option<String>, String> {
    let (host, port, username, password, use_tls, tls_skip_verify, client_cert, transport) = {
        let client = state.client.lock().await;
        if !client.is_connected() {
            return Err("Not connected".into());
        }
        (client.host.clone(), client.port, client.username.clone(), client.password.clone(), client.use_tls, client.tls_skip_verify, client.client_cert.clone(), client.transport.clone())
    };

    let mut connection = amqp::open_connection(
        &host, port, &username, &password,
        use_tls, tls_skip_verify,
        "amqpush-reply", false, 0,
        &client_cert, &transport,
    )
    .await
    .map_err(|e| format!("Reply conn failed: {e}"))?;

    let mut session = Session::begin(&mut connection)
        .await
        .map_err(|e| format!("Reply session failed: {e}"))?;
    let mut receiver = Receiver::attach(&mut session, "amqpush-reply-recv", &address)
        .await
        .map_err(|e| format!("Reply link failed: {e}"))?;

    let result = tokio::time::timeout(
        tokio::time::Duration::from_millis(timeout_ms),
        receiver.recv::<String>(),
    )
    .await;

    let _ = receiver.detach().await;
    let _ = session.end().await;
    let _ = connection.close().await;

    match result {
        Ok(Ok(delivery)) => Ok(Some(delivery.body().clone())),
        Ok(Err(e)) => Err(format!("Receive error: {e}")),
        Err(_) => Ok(None), // timeout
    }
}

// ── export ────────────────────────────────────────────────────────────────────

fn csv_escape(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\"").replace('\n', " ").replace('\r', ""))
}

#[tauri::command]
pub async fn export_history(
    state: tauri::State<'_, AppState>,
    format: String,
) -> Result<String, String> {
    let history = state.history.lock().await;

    let filename = format!(
        "amqpush-history-{}.{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        format
    );
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_default();
    let path = dir.join(&filename);

    let content = if format == "csv" {
        let mut out = String::from("id,timestamp,address,body\n");
        for e in history.iter() {
            let body = e.body_full.as_deref().unwrap_or(&e.body_preview);
            out.push_str(&format!(
                "{},{},{},{}\n",
                csv_escape(&e.id),
                csv_escape(&e.timestamp),
                csv_escape(&e.address),
                csv_escape(body)
            ));
        }
        out
    } else {
        serde_json::to_string_pretty(&*history).map_err(|e| e.to_string())?
    };

    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ── macOS menu (custom About) ─────────────────────────────────────────────────
//
// Tauri's default macOS app menu wires the About item to display
// `Version <ver>` and `(<ver>)` from `tauri.conf.json` — duplicate strings.
// We rebuild the same default menu but inject an `AboutMetadata` whose
// `short_version` is the build date, so the parenthesised slot shows
// `(ddMMyyyy)` instead of repeating the version. The build date itself comes
// from `build.rs` via the `AMQPUSH_BUILD_DATE` env var (see that file).
