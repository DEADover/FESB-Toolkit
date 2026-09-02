use chrono::Local;
use fe2o3_amqp::{Receiver, Session};
use fe2o3_amqp_types::messaging::{Body, FilterSet, Source};
use fe2o3_amqp_types::primitives::{Symbol, Value};
use serde::Serialize;
use serde_amqp::descriptor::Descriptor;
use serde_amqp::described::Described;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::amqpush::broker::{extract_peeked, PeekedMessage};

/// Heuristic — does an AMQP error string indicate a *permanent* failure that
/// retrying won't fix? If yes, the subscriber loop emits
/// `subscriber_unrecoverable` and stops instead of looping forever with
/// exponential backoff (which fills the log and hides the real problem).
///
/// Pattern-based because the underlying `fe2o3-amqp` error types are an enum
/// nested across multiple crates; string matching is simpler and works across
/// broker dialects.
fn is_unrecoverable_amqp_error(err: &str) -> bool {
    let s = err.to_ascii_lowercase();
    // Authorisation / authentication — credentials wrong, ACL denies access.
    if s.contains("unauthorized") || s.contains("unauthorised")
        || s.contains("not authorized") || s.contains("not authorised")
        || s.contains("access refused") || s.contains("forbidden")
        || s.contains("authentication") || s.contains("sasl")
    {
        return true;
    }
    // Source doesn't exist any more — address deleted, never created, or typo.
    if s.contains("not found") || s.contains("not-found")
        || s.contains("does not exist") || s.contains("no such")
        || s.contains("resource-deleted") || s.contains("address-not-found")
    {
        return true;
    }
    // Frame / protocol mismatch — usually a wrong port / non-AMQP endpoint.
    if s.contains("malformed frame") || s.contains("invalid frame")
        || s.contains("decode error") || s.contains("invalid header")
    {
        return true;
    }
    false
}

/// Insert one descriptor → string filter entry into a FilterSet. Used both
/// for JMS selectors and for topic-pattern bindings; both descriptors take
/// a single-string value, only the descriptor name differs.
fn insert_string_filter(fs: &mut FilterSet, descriptor: &str, value: &str) {
    let descriptor_name = Symbol::from(descriptor);
    fs.insert(
        descriptor_name.clone(),
        Value::Described(Box::new(Described {
            descriptor: Descriptor::Name(descriptor_name),
            value: Value::String(value.to_string()),
        })),
    );
}

/// Build the AMQP 1.0 filter set for a subscriber from the user-supplied
/// optional selector + optional topic pattern. Both filters can be present
/// simultaneously — selector narrows by message properties (`priority > 5`),
/// topic pattern narrows by routing key / topic name (`orders.*.created`).
///
/// Descriptors:
///   - `apache.org:selector-filter:string` — JMS selector (Artemis, ActiveMQ
///     Classic, Qpid).
///   - `apache.org:legacy-amqp-topic-binding:string` — topic pattern with
///     the broker's native wildcard syntax. Honored by Qpid Broker-J,
///     ActiveMQ Classic, and Artemis multicast addresses; ignored gracefully
///     by brokers that don't recognise it (the attach still succeeds).
///
/// Returns `None` when both inputs are empty so callers keep the simple
/// no-filter `Receiver::attach(...)` path.
fn build_filters(selector: &str, topic_pattern: &str) -> Option<FilterSet> {
    let sel = selector.trim();
    let topic = topic_pattern.trim();
    if sel.is_empty() && topic.is_empty() {
        return None;
    }
    let mut fs = FilterSet::new();
    if !sel.is_empty() {
        insert_string_filter(&mut fs, "apache.org:selector-filter:string", sel);
    }
    if !topic.is_empty() {
        insert_string_filter(&mut fs, "apache.org:legacy-amqp-topic-binding:string", topic);
    }
    Some(fs)
}

/// Live message pushed to the UI by the subscriber. Mirrors `PeekedMessage`
/// from broker.rs so Receive view can render the same rich detail panel as
/// Browser/peek (standard AMQP properties + application properties + body).
#[derive(Debug, Clone, Serialize)]
pub struct ReceivedMessage {
    pub id: String,
    pub timestamp: String,
    /// Truncated body text for the compact list view (`meta.body_text` for full).
    pub body: String,
    pub is_truncated: bool,
    /// Full AMQP metadata extracted from the delivery.
    pub meta: PeekedMessage,
    /// Queue (source address) this message arrived on. Used by the UI to tag
    /// messages in mixed multi-queue feeds.
    pub queue: String,
}

/// Per-queue lifecycle event payload. Used for `subscriber_reconnecting`,
/// `subscriber_reconnected`, `subscriber_error`, `subscriber_stopped`.
#[derive(Debug, Clone, Serialize)]
pub struct SubEvent {
    pub queue: String,
    /// Free-form payload — backoff_ms for reconnecting, error string for error,
    /// empty for reconnected/stopped.
    pub message: Option<String>,
}

pub struct SubscriberHandle {
    abort: tokio::task::AbortHandle,
}

impl SubscriberHandle {
    pub fn stop(&self) {
        self.abort.abort();
    }
}

#[derive(Clone)]
struct SubParams {
    host: String,
    port: u16,
    address: String,
    username: String,
    password: String,
    use_tls: bool,
    tls_skip_verify: bool,
    /// Optional mTLS client identity, propagated from the main `AmqpClient`.
    client_cert: crate::amqpush::amqp::ClientCert,
    /// Transport choice (plain TCP vs WebSocket).
    transport: crate::amqpush::amqp::TransportOpts,
    /// JMS-style selector (e.g. `priority > 5`). Empty / whitespace = no filter,
    /// receiver attaches with no source filter (broker delivers everything).
    selector: String,
    /// Optional topic-pattern wildcard (e.g. `orders.*` for Artemis multicast,
    /// `events.>` for Solace). Attached as `apache.org:legacy-amqp-topic-binding`
    /// source filter. Empty = no topic filter.
    topic_pattern: String,
    /// Reconnect-backoff tuning: starting delay, ceiling, multiplier per step.
    /// Defaults if zero / negative pass-through preserve old behaviour.
    backoff_base_ms: u64,
    backoff_max_ms: u64,
    backoff_multiplier: f64,
}

async fn open_connection(p: &SubParams) -> Result<(Receiver, fe2o3_amqp::connection::ConnectionHandle<()>, fe2o3_amqp::session::SessionHandle<()>), String> {
    let mut connection = crate::amqpush::amqp::open_connection(
        &p.host, p.port, &p.username, &p.password,
        p.use_tls, p.tls_skip_verify,
        "amqpush-sub", false, 0,
        &p.client_cert, &p.transport,
    )
    .await
    .map_err(|e| format!("Subscriber connection failed: {e}"))?;

    let mut session = Session::begin(&mut connection)
        .await
        .map_err(|e| format!("Subscriber session failed: {e}"))?;

    // Use a UUID-based link name so multiple receivers in the same session
    // don't collide on link names (some brokers reject duplicate names).
    let link_name = format!("amqpush-recv-{}", Uuid::new_v4());

    // If a selector is set, build the receiver via the source-builder path so
    // we can attach the JMS selector filter; otherwise fall back to the simple
    // attach (kept for backward parity — no behavioural change for users who
    // never set a selector).
    let receiver = match build_filters(&p.selector, &p.topic_pattern) {
        Some(filter) => {
            let source = Source::builder()
                .address(p.address.clone())
                .filter(filter)
                .build();
            Receiver::builder()
                .name(link_name)
                .source(source)
                .attach(&mut session)
                .await
                .map_err(|e| format!("Subscriber link failed (with filter): {e}"))?
        }
        None => Receiver::attach(&mut session, link_name, &p.address)
            .await
            .map_err(|e| format!("Subscriber link failed: {e}"))?,
    };

    Ok((receiver, connection, session))
}

#[allow(clippy::too_many_arguments)]
pub async fn start(
    host: &str,
    port: u16,
    address: String,
    username: &str,
    password: &str,
    use_tls: bool,
    tls_skip_verify: bool,
    client_cert: crate::amqpush::amqp::ClientCert,
    transport: crate::amqpush::amqp::TransportOpts,
    selector: String,
    topic_pattern: String,
    backoff_base_ms: u64,
    backoff_max_ms: u64,
    backoff_multiplier: f64,
    app: AppHandle,
) -> Result<SubscriberHandle, String> {
    let params = SubParams {
        host: host.to_string(),
        port,
        address: address.clone(),
        username: username.to_string(),
        password: password.to_string(),
        use_tls,
        tls_skip_verify,
        client_cert,
        transport,
        selector,
        topic_pattern,
        // Defensive defaults — if a caller passes 0 / negative / NaN we want
        // working values, not a no-op loop.
        backoff_base_ms: if backoff_base_ms == 0 { 1_000 } else { backoff_base_ms },
        backoff_max_ms: if backoff_max_ms == 0 { 30_000 } else { backoff_max_ms },
        backoff_multiplier: if backoff_multiplier > 1.0 && backoff_multiplier.is_finite() { backoff_multiplier } else { 2.0 },
    };

    // Initial connection attempt (fail fast, surface error to UI)
    let (receiver, connection, session) = open_connection(&params).await?;

    let task = tokio::spawn(run_loop(receiver, connection, session, params, app, address));

    Ok(SubscriberHandle {
        abort: task.abort_handle(),
    })
}

async fn run_loop(
    mut receiver: Receiver,
    mut connection: fe2o3_amqp::connection::ConnectionHandle<()>,
    mut session: fe2o3_amqp::session::SessionHandle<()>,
    params: SubParams,
    app: AppHandle,
    queue: String,
) {
    const MAX_BODY_LEN: usize = 4096;
    let max_backoff_ms = params.backoff_max_ms;
    let backoff_multiplier = params.backoff_multiplier;
    let mut backoff_ms: u64 = params.backoff_base_ms;

    loop {
        match receiver.recv::<Body<Value>>().await {
            Ok(delivery) => {
                backoff_ms = params.backoff_base_ms; // reset on successful receive

                let meta = extract_peeked(&delivery);

                let body_text = meta.body_text.clone().unwrap_or_default();
                let is_truncated = body_text.len() > MAX_BODY_LEN;
                let body = if is_truncated {
                    let mut end = MAX_BODY_LEN;
                    while end > 0 && !body_text.is_char_boundary(end) {
                        end -= 1;
                    }
                    format!("{}…", &body_text[..end])
                } else {
                    body_text
                };

                let _ = receiver.accept(&delivery).await;
                app.emit(
                    "message_received",
                    ReceivedMessage {
                        id: Uuid::new_v4().to_string(),
                        timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                        body,
                        is_truncated,
                        meta,
                        queue: queue.clone(),
                    },
                )
                .ok();
            }
            Err(e) => {
                // If the recv error itself names a permanent condition (auth
                // failure, address deleted, protocol mismatch), don't even
                // try to reconnect — surface as unrecoverable and let the
                // user fix the upstream problem.
                let err_str = format!("{e}");
                if is_unrecoverable_amqp_error(&err_str) {
                    let _ = receiver.detach().await;
                    let _ = session.end().await;
                    let _ = connection.close().await;
                    app.emit("subscriber_unrecoverable", SubEvent {
                        queue: queue.clone(),
                        message: Some(err_str),
                    }).ok();
                    app.emit("subscriber_stopped", SubEvent {
                        queue: queue.clone(),
                        message: None,
                    }).ok();
                    return;
                }

                // Best-effort cleanup of old connection
                let _ = receiver.detach().await;
                let _ = session.end().await;
                let _ = connection.close().await;

                // Notify UI: reconnecting (per-queue event)
                app.emit("subscriber_reconnecting", SubEvent {
                    queue: queue.clone(),
                    message: Some(backoff_ms.to_string()),
                }).ok();
                tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
                let next = (backoff_ms as f64 * backoff_multiplier) as u64;
                backoff_ms = next.min(max_backoff_ms);

                // Try to reconnect
                match open_connection(&params).await {
                    Ok((r, c, s)) => {
                        receiver = r;
                        connection = c;
                        session = s;
                        app.emit("subscriber_reconnected", SubEvent {
                            queue: queue.clone(),
                            message: None,
                        }).ok();
                    }
                    Err(e) => {
                        // Tag the failure as recoverable vs unrecoverable
                        // so the UI can show a clear "stopped permanently"
                        // banner instead of an ambiguous spinning state.
                        let event_name = if is_unrecoverable_amqp_error(&e) {
                            "subscriber_unrecoverable"
                        } else {
                            "subscriber_error"
                        };
                        app.emit(event_name, SubEvent {
                            queue: queue.clone(),
                            message: Some(e),
                        }).ok();
                        app.emit("subscriber_stopped", SubEvent {
                            queue: queue.clone(),
                            message: None,
                        }).ok();
                        return;
                    }
                }
            }
        }
    }
}
