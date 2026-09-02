//! Broker management via AMQP 1.0 — works for ActiveMQ Artemis (and Classic with the
//! AMQP module enabled). Sends RPC messages to the special address `activemq.management`
//! and reads responses from a dynamic temporary queue.
//!
//! Reference: https://activemq.apache.org/components/artemis/documentation/latest/management.html#management-via-amqp

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

use fe2o3_amqp::connection::ConnectionHandle;
use fe2o3_amqp::session::SessionHandle;
use fe2o3_amqp::{
    link::{ReceiverAttachError, SenderAttachError},
    Delivery, Receiver, Sender, Session,
};
use fe2o3_amqp_types::messaging::{
    AmqpValue, ApplicationProperties, Body, DistributionMode, Message, Properties, Source,
    TerminusDurability, TerminusExpiryPolicy,
};
use fe2o3_amqp_types::primitives::{OrderedMap, SimpleValue, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerQueue {
    pub name: String,
    pub address: String,
    pub message_count: i64,
    pub consumer_count: i64,
    pub routing_type: String, // "ANYCAST" | "MULTICAST" | "" (address-only)
    /// "queue" — actual queue with metrics; "address" — bound address without dedicated queue yet
    pub kind: String,
}

/// A message that was peeked (read but released back) from a queue.
/// All standard AMQP properties + application-properties are exposed for inspection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeekedMessage {
    pub message_id: Option<String>,
    pub user_id: Option<String>,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub reply_to: Option<String>,
    pub correlation_id: Option<String>,
    pub content_type: Option<String>,
    pub content_encoding: Option<String>,
    pub absolute_expiry_time: Option<i64>,
    pub creation_time: Option<i64>,
    pub group_id: Option<String>,
    pub group_sequence: Option<u32>,
    pub reply_to_group_id: Option<String>,
    pub application_properties: HashMap<String, String>,
    pub body_text: Option<String>,
    pub body_kind: String, // "text" | "binary" | "amqp-value" | "amqp-sequence" | "empty"
    pub body_size: usize,
    pub priority: Option<u8>,
    pub durable: Option<bool>,
    pub ttl_ms: Option<u32>,
    pub delivery_count: u32,
}

/// One AMQP / Core client connection on the broker — flat, frontend-ready
/// shape. Built by hand-walking the JSON Artemis returns, so we can support
/// the dozen+ slightly-different key namings across Artemis versions (and
/// ActiveMQ Classic when it accepts AMQP). The frontend uses these to
/// surface "who's connected right now" and join consumers back to their
/// connection.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BrokerConnection {
    pub connection_id: String,
    pub client_address: String,
    pub users: String,
    pub session_count: u32,
    pub creation_time: i64,
    pub implementation: String,
    pub protocol: String,
}

/// One AMQP / Core consumer on the broker. Joined to a connection via
/// `connection_id` and a queue via `queue`. The "interesting" metrics are
/// `messages_in_transit` (credit currently outstanding) and the count /
/// timestamps — they answer "who is holding this message right now".
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BrokerConsumer {
    pub id: i64,
    pub connection_id: String,
    pub session_id: String,
    pub queue: String,
    pub address: String,
    pub browse_only: bool,
    pub creation_time: i64,
    pub messages_in_transit: i64,
    pub messages_delivered: i64,
    pub messages_acknowledged: i64,
    pub last_delivered_time: i64,
    pub last_acknowledged_time: i64,
    pub protocol: String,
}

/// Pull a string field by trying each candidate key in order. Coerces
/// numbers / booleans to their string form and joins arrays (sets-as-arrays
/// are common — e.g. `users: ["alice"]` on Artemis ≥ 2.18).
fn obj_str(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> String {
    for k in keys {
        let Some(v) = obj.get(*k) else { continue };
        match v {
            serde_json::Value::String(s) => return s.clone(),
            serde_json::Value::Number(n) => return n.to_string(),
            serde_json::Value::Bool(b) => return b.to_string(),
            serde_json::Value::Array(arr) => {
                let joined = arr.iter()
                    .filter_map(|x| x.as_str().map(String::from).or_else(|| x.as_i64().map(|n| n.to_string())))
                    .collect::<Vec<_>>()
                    .join(", ");
                if !joined.is_empty() { return joined; }
            }
            serde_json::Value::Null => continue,
            _ => continue,
        }
    }
    String::new()
}

fn obj_i64(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> i64 {
    for k in keys {
        let Some(v) = obj.get(*k) else { continue };
        if let Some(n) = v.as_i64() { return n; }
        if let Some(s) = v.as_str() {
            if let Ok(n) = s.parse::<i64>() { return n; }
        }
    }
    0
}

fn obj_u32(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> u32 {
    obj_i64(obj, keys).clamp(0, u32::MAX as i64) as u32
}

fn obj_bool(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> bool {
    for k in keys {
        let Some(v) = obj.get(*k) else { continue };
        if let Some(b) = v.as_bool() { return b; }
    }
    false
}

/// Best-effort wire-protocol inference from Artemis's `implementation`
/// class name. Artemis's `listConnectionsAsJSON` often omits the `protocol`
/// field entirely (at least up through 2.x), but the implementation class
/// name reliably identifies the protocol stack. Falls back to the class
/// name itself if nothing matches — better than a blank cell.
fn infer_protocol_from_impl(s: &str) -> String {
    let lo = s.to_ascii_lowercase();
    if lo.contains("proton") || lo.contains("amqp") { return "AMQP".into(); }
    if lo.contains("stomp")    { return "STOMP".into(); }
    if lo.contains("mqtt")     { return "MQTT".into(); }
    if lo.contains("openwire") { return "OPENWIRE".into(); }
    if lo.contains("hornetq")  { return "HORNETQ".into(); }
    if lo.contains("core") || (lo.contains("activemq") && lo.contains("remoting")) { return "CORE".into(); }
    String::new()
}

fn parse_connection_obj(v: &serde_json::Value) -> Option<BrokerConnection> {
    let obj = v.as_object()?;
    let implementation = obj_str(obj, &["implementation", "implName", "transport"]);
    let mut protocol = obj_str(obj, &["protocol", "protocolName"]);
    if protocol.is_empty() {
        protocol = infer_protocol_from_impl(&implementation);
    }
    Some(BrokerConnection {
        connection_id:  obj_str(obj, &["connectionID", "connectionId", "id", "remoteAddress"]),
        client_address: obj_str(obj, &["clientAddress", "remoteAddress", "client", "address"]),
        users:          obj_str(obj, &["users", "user", "userName", "principal"]),
        session_count:  obj_u32(obj, &["sessionCount", "sessions", "nrOfSessions"]),
        creation_time:  obj_i64(obj, &["creationTime", "created", "createdTime", "connectionTimestamp", "connectTime"]),
        implementation,
        protocol,
    })
}

fn parse_consumer_obj(v: &serde_json::Value) -> Option<BrokerConsumer> {
    let obj = v.as_object()?;
    Some(BrokerConsumer {
        // `consumerID` on Artemis is often 0 (always-zero pseudo-id), so
        // prefer the actual unique `sequentialId` (camelCase) / `sequentialID`.
        id:                     obj_i64(obj,  &["sequentialId", "sequentialID", "id", "consumerID"]),
        connection_id:          obj_str(obj,  &["connectionID", "connectionId", "remoteAddress"]),
        session_id:             obj_str(obj,  &["sessionID", "sessionId", "session"]),
        queue:                  obj_str(obj,  &["queueName", "queue", "destinationName"]),
        address:                obj_str(obj,  &["address", "destination"]),
        browse_only:            obj_bool(obj, &["browseOnly", "browse"]),
        creation_time:          obj_i64(obj,  &["creationTime", "created", "createdTime"]),
        messages_in_transit:    obj_i64(obj,  &["messagesInTransit", "deliveringCount", "inflightCount", "credit"]),
        messages_delivered:     obj_i64(obj,  &["messagesDelivered", "deliveredCount"]),
        messages_acknowledged:  obj_i64(obj,  &["messagesAcknowledged", "ackedCount", "acknowledgedCount"]),
        last_delivered_time:    obj_i64(obj,  &["lastDeliveredTime", "lastDelivery", "lastDeliveredAt"]),
        last_acknowledged_time: obj_i64(obj,  &["lastAcknowledgedTime", "lastAckTime", "lastAckedAt"]),
        protocol:               obj_str(obj,  &["protocol", "protocolName"]),
    })
}

const MGMT_ADDRESS: &str = "activemq.management";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Filter out internal/system/temporary queues and addresses.
/// - `activemq.*`, `$sys.*`, `$.artemis.*` — broker internals (notifications, MQTT sessions, management)
/// - UUID-named queues — Artemis temporary queues (created for AMQP request/reply, dynamic links).
///   Both AMQPush and any other AMQP client (including FESB itself) create them; they're transient
///   and meaningless to the user.
fn is_internal_or_temp(name: &str) -> bool {
    name.starts_with("activemq.")
        || name.starts_with("$sys.")
        || name.starts_with("$.artemis.")
        || Uuid::parse_str(name).is_ok()
}

/// Long-lived management AMQP connection — opened once and reused for all
/// `list_queues` calls. Avoids generating a `SESSION_CLOSED` notification
/// per refresh (which Artemis publishes to `activemq.notifications` and may
/// route into DLQ when no consumer exists).
pub struct ManagementChannel {
    pub connection: ConnectionHandle<()>,
    pub session: SessionHandle<()>,
    pub sender: Sender,
    pub receiver: Receiver,
    pub reply_to: String,
}

impl ManagementChannel {
    #[allow(clippy::too_many_arguments)]
    pub async fn open(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        use_tls: bool,
        tls_skip_verify: bool,
        client_cert: &crate::amqpush::amqp::ClientCert,
        transport: &crate::amqpush::amqp::TransportOpts,
    ) -> Result<Self, String> {
        let mut connection = crate::amqpush::amqp::open_connection(
            host, port, username, password,
            use_tls, tls_skip_verify,
            "amqpush-mgmt", false, 0,
            client_cert, transport,
        )
        .await
        .map_err(|e| format!("Open conn: {e}"))?;

        let mut session = Session::begin(&mut connection)
            .await
            .map_err(|e| format!("Begin session: {e}"))?;

        let sender = Sender::attach(&mut session, "amqpush-mgmt-send", MGMT_ADDRESS)
            .await
            .map_err(|e: SenderAttachError| format!("Attach mgmt sender: {e}"))?;

        let dyn_source = Source::builder()
            .dynamic(true)
            .durable(TerminusDurability::None)
            .expiry_policy(TerminusExpiryPolicy::LinkDetach)
            .build();

        let receiver = Receiver::builder()
            .name("amqpush-mgmt-recv")
            .source(dyn_source)
            .attach(&mut session)
            .await
            .map_err(|e: ReceiverAttachError| format!("Attach mgmt receiver: {e}"))?;

        let reply_to = receiver
            .source()
            .as_ref()
            .and_then(|s| s.address.as_ref())
            .map(|a| a.to_string())
            .ok_or_else(|| "Broker did not assign a dynamic reply address".to_string())?;

        Ok(Self { connection, session, sender, receiver, reply_to })
    }

    pub async fn close(mut self) {
        let _ = self.sender.detach().await;
        let _ = self.receiver.detach().await;
        let _ = self.session.end().await;
        let _ = self.connection.close().await;
    }
}

/// Issue management RPCs over an existing channel. The channel is kept alive
/// across calls — only the per-RPC sender/receiver send/recv operations happen.
pub async fn list_queues_via(channel: &mut ManagementChannel) -> Result<Vec<BrokerQueue>, String> {
    call_management(&mut channel.sender, &mut channel.receiver, &channel.reply_to).await
}

/// Permanently delete every message currently sitting in the queue. Returns
/// the number of messages that were removed (Artemis reports this from
/// `removeAllMessages`). Destructive — caller must confirm with the user.
/// Measure round-trip latency to the broker via a trivial management RPC
/// (broker.getName). Returns milliseconds. Used by the header's "broker
/// latency" indicator to surface degrading network / broker conditions
/// before a send/recv stalls.
pub async fn ping_via(channel: &mut ManagementChannel) -> Result<u64, String> {
    let started = std::time::Instant::now();
    invoke_management::<String>(
        &mut channel.sender,
        &mut channel.receiver,
        &channel.reply_to,
        "broker",
        "getName",
        Body::Value(AmqpValue(Value::String("[]".into()))),
    ).await?;
    Ok(started.elapsed().as_millis() as u64)
}

/// Ask the broker its name (`broker.getName`). The cheapest management
/// call there is, and unlike a plain connect it proves the broker actually
/// answers requests — used by the stand's "test broker" button.
pub async fn name_via(channel: &mut ManagementChannel) -> Result<String, String> {
    invoke_management::<String>(
        &mut channel.sender,
        &mut channel.receiver,
        &channel.reply_to,
        "broker",
        "getName",
        Body::Value(AmqpValue(Value::String("[]".into()))),
    ).await
}

/// List active connections on the broker. Artemis returns the result as a
/// JSON-encoded string (legacy `*AsJSON` operation), so we deserialize the
/// inner String once via the management transport, then re-parse the JSON
/// payload to typed `BrokerConnection`s. Returns an empty list rather than
/// an error if the broker omits or formats the field unexpectedly — the
/// inspector view falls back to an "unknown" state gracefully.
pub async fn list_connections_via(channel: &mut ManagementChannel) -> Result<Vec<BrokerConnection>, String> {
    let raw = fetch_connections_raw_via(channel).await?;
    let arr: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|e| format!("decode listConnectionsAsJSON (expected array): {e} — raw: {raw}"))?;
    Ok(arr.iter().filter_map(parse_connection_obj).collect())
}

/// Raw `listConnectionsAsJSON` payload as Artemis returned it. Surfaced by
/// the inspector's "Raw" debug toggle so the user can see the actual field
/// names and diagnose parser mismatches across broker versions.
pub async fn fetch_connections_raw_via(channel: &mut ManagementChannel) -> Result<String, String> {
    invoke_management::<String>(
        &mut channel.sender,
        &mut channel.receiver,
        &channel.reply_to,
        "broker",
        "listConnectionsAsJSON",
        Body::Value(AmqpValue(Value::String("[]".into()))),
    ).await
}

/// List active consumers on the broker, joined to their connection / queue.
/// Same shape conventions as `list_connections_via`. Used by the inspector
/// view (grouped by connection or by queue) and by the per-message
/// "who holds this?" drill-down.
pub async fn list_consumers_via(channel: &mut ManagementChannel) -> Result<Vec<BrokerConsumer>, String> {
    let raw = fetch_consumers_raw_via(channel).await?;
    let arr: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|e| format!("decode listAllConsumersAsJSON (expected array): {e} — raw: {raw}"))?;
    Ok(arr.iter().filter_map(parse_consumer_obj).collect())
}

/// Raw `listAllConsumersAsJSON` payload — same purpose as the connections
/// raw fetch, used by the inspector debug overlay.
pub async fn fetch_consumers_raw_via(channel: &mut ManagementChannel) -> Result<String, String> {
    invoke_management::<String>(
        &mut channel.sender,
        &mut channel.receiver,
        &channel.reply_to,
        "broker",
        "listAllConsumersAsJSON",
        Body::Value(AmqpValue(Value::String("[]".into()))),
    ).await
}

pub async fn purge_queue_via(channel: &mut ManagementChannel, queue: &str) -> Result<i64, String> {
    invoke_management::<i64>(
        &mut channel.sender,
        &mut channel.receiver,
        &channel.reply_to,
        &format!("queue.{queue}"),
        "removeAllMessages",
        Body::Value(AmqpValue(Value::String("[]".into()))),
    ).await
}

/// Selectively delete messages from a queue by their AMQP message-id.
/// Builds an Artemis JMS-style selector `AMQUserID='id1' OR AMQUserID='id2' …`
/// and passes it to the queue's `removeMessages(filter)` management op,
/// which returns the count actually deleted. Empty id list is a no-op.
///
/// Requires Artemis (or ActiveMQ Classic with AMQP) — the management
/// operation isn't standardised across other brokers. Caller surfaces a
/// clear error when the RPC fails.
pub async fn remove_messages_by_ids_via(
    channel: &mut ManagementChannel,
    queue: &str,
    message_ids: &[String],
) -> Result<i64, String> {
    if message_ids.is_empty() {
        return Ok(0);
    }
    // Escape single quotes in IDs (rare but possible — selector strings
    // double single quotes for literal `'`). Anything else is left as-is.
    let filter = message_ids.iter()
        .map(|id| format!("AMQUserID='{}'", id.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(" OR ");
    // Management op args are a JSON array string; embed the filter as a
    // single string element, escaping `"` and `\` per JSON rules.
    let escaped_filter = filter.replace('\\', "\\\\").replace('"', "\\\"");
    let args = format!("[\"{escaped_filter}\"]");
    invoke_management::<i64>(
        &mut channel.sender,
        &mut channel.receiver,
        &channel.reply_to,
        &format!("queue.{queue}"),
        "removeMessages",
        Body::Value(AmqpValue(Value::String(args))),
    ).await
}

async fn call_management(
    sender: &mut Sender,
    receiver: &mut Receiver,
    reply_to: &str,
) -> Result<Vec<BrokerQueue>, String> {
    // 1. List queue names ----------------------------------------------------
    let names = invoke_management::<Vec<String>>(
        &mut *sender,
        &mut *receiver,
        reply_to,
        "broker",
        "getQueueNames",
        Body::Value(fe2o3_amqp_types::messaging::AmqpValue(Value::String(
            "[]".into(),
        ))),
    )
    .await?;

    // Also list addresses — picks up addresses that are pre-defined or auto-created
    // but don't yet have a bound queue (so user can pick them as send targets).
    let addresses = invoke_management::<Vec<String>>(
        &mut *sender,
        &mut *receiver,
        reply_to,
        "broker",
        "getAddressNames",
        Body::Value(fe2o3_amqp_types::messaging::AmqpValue(Value::String(
            "[]".into(),
        ))),
    )
    .await
    .unwrap_or_default();

    // 2. For each queue — fetch metrics in parallel-ish (sequential keeps it simple).
    //    System / temporary queues are skipped early.
    let mut out = Vec::with_capacity(names.len() + addresses.len());
    let queue_names_set: std::collections::HashSet<&String> = names.iter().collect();
    for name in &names {
        if is_internal_or_temp(name) {
            continue;
        }
        let address = invoke_management::<String>(
            &mut *sender,
            &mut *receiver,
            reply_to,
            &format!("queue.{name}"),
            "getAddress",
            Body::Value(fe2o3_amqp_types::messaging::AmqpValue(Value::String(
                "[]".into(),
            ))),
        )
        .await
        .unwrap_or_else(|_| name.clone());

        let message_count = invoke_management::<i64>(
            &mut *sender,
            &mut *receiver,
            reply_to,
            &format!("queue.{name}"),
            "getMessageCount",
            Body::Value(fe2o3_amqp_types::messaging::AmqpValue(Value::String(
                "[]".into(),
            ))),
        )
        .await
        .unwrap_or(0);

        let consumer_count = invoke_management::<i64>(
            &mut *sender,
            &mut *receiver,
            reply_to,
            &format!("queue.{name}"),
            "getConsumerCount",
            Body::Value(fe2o3_amqp_types::messaging::AmqpValue(Value::String(
                "[]".into(),
            ))),
        )
        .await
        .unwrap_or(0);

        let routing_type = invoke_management::<String>(
            &mut *sender,
            &mut *receiver,
            reply_to,
            &format!("queue.{name}"),
            "getRoutingType",
            Body::Value(fe2o3_amqp_types::messaging::AmqpValue(Value::String(
                "[]".into(),
            ))),
        )
        .await
        .unwrap_or_else(|_| "ANYCAST".into());

        out.push(BrokerQueue {
            name: name.clone(),
            address,
            message_count,
            consumer_count,
            routing_type,
            kind: "queue".into(),
        });
    }

    // 3. Add addresses that are not yet backed by a queue — user may want to send to them
    let bound_addresses: std::collections::HashSet<String> =
        out.iter().map(|q| q.address.clone()).collect();
    for addr in &addresses {
        if is_internal_or_temp(addr) {
            continue;
        }
        if bound_addresses.contains(addr) || queue_names_set.contains(addr) {
            continue;
        }
        out.push(BrokerQueue {
            name: addr.clone(),
            address: addr.clone(),
            message_count: 0,
            consumer_count: 0,
            routing_type: String::new(),
            kind: "address".into(),
        });
    }

    // Don't detach sender/receiver — they're owned by ManagementChannel and
    // reused for subsequent calls. Keeping them alive avoids per-call link
    // attach/detach churn.

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Send a management RPC call and parse the JSON response.
///
/// Artemis accepts management requests as AMQP messages with these
/// application-properties:
///   `_AMQ_ResourceName`  — e.g. "broker", "queue.MyQueue"
///   `_AMQ_OperationName` — e.g. "getQueueNames", "getMessageCount"
/// Body is a JSON-encoded array of arguments (often empty `"[]"`).
///
/// Reply arrives on `reply_to`. The response body is a JSON array whose first
/// element is an array `[result]`. So `[[ "Q1","Q2" ]]` — we unwrap one level.
async fn invoke_management<T: for<'de> Deserialize<'de>>(
    sender: &mut Sender,
    receiver: &mut Receiver,
    reply_to: &str,
    resource: &str,
    operation: &str,
    body: Body<Value>,
) -> Result<T, String> {
    let mut props = OrderedMap::new();
    props.insert(
        "_AMQ_ResourceName".to_string(),
        SimpleValue::String(resource.into()),
    );
    props.insert(
        "_AMQ_OperationName".to_string(),
        SimpleValue::String(operation.into()),
    );

    let msg_props = Properties {
        reply_to: Some(reply_to.into()),
        ..Default::default()
    };

    let message = Message {
        header: None,
        delivery_annotations: None,
        message_annotations: None,
        properties: Some(msg_props),
        application_properties: Some(ApplicationProperties(props)),
        body,
        footer: None,
    };

    sender
        .send(message)
        .await
        .map_err(|e| format!("send mgmt({operation}): {e}"))?;

    let delivery: Delivery<String> = tokio::time::timeout(REQUEST_TIMEOUT, receiver.recv())
        .await
        .map_err(|_| format!("mgmt({operation}) timeout"))?
        .map_err(|e| format!("recv mgmt({operation}): {e}"))?;

    receiver
        .accept(&delivery)
        .await
        .map_err(|e| format!("ack mgmt({operation}): {e}"))?;

    let raw = delivery.body().clone();
    parse_artemis_response::<T>(&raw, operation)
}

/// Artemis encodes management responses as JSON: `[[ <result> ]]` for normal
/// returns. We unwrap one level and return the inner element.
fn parse_artemis_response<T: for<'de> Deserialize<'de>>(
    raw: &str,
    operation: &str,
) -> Result<T, String> {
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("parse {operation} response: {e} — raw: {raw}"))?;

    // Outer is array, first element is the actual result (array or scalar).
    let inner = parsed
        .as_array()
        .and_then(|arr| arr.first())
        .ok_or_else(|| format!("{operation} returned non-array: {raw}"))?;

    serde_json::from_value::<T>(inner.clone())
        .map_err(|e| format!("decode {operation}: {e} — inner: {inner}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Message peek — read messages from a queue without consuming them.
//
// Approach: open a regular receiver, take up to N messages within a short
// per-message timeout, then `release` each delivery so the broker puts them
// back on the queue (delivery-count is incremented, but content is preserved).
//
// This is broker-portable AMQP 1.0 behaviour. For larger queues a true browser
// (distribution-mode = "copy" on the source) would be cleaner, but `release`
// works on every broker without configuration.

#[allow(clippy::too_many_arguments)]
pub async fn peek_messages(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    use_tls: bool,
    tls_skip_verify: bool,
    client_cert: &crate::amqpush::amqp::ClientCert,
    transport: &crate::amqpush::amqp::TransportOpts,
    queue: &str,
    max: u32,
    per_message_timeout_ms: u64,
) -> Result<Vec<PeekedMessage>, String> {
    let mut connection = crate::amqpush::amqp::open_connection(
        host, port, username, password,
        use_tls, tls_skip_verify,
        "amqpush-peek", false, 0,
        client_cert, transport,
    )
    .await
    .map_err(|e| format!("Open conn: {e}"))?;

    let mut session = Session::begin(&mut connection)
        .await
        .map_err(|e| format!("Begin session: {e}"))?;

    // Attach as a browser via `distribution-mode: copy` on the source —
    // that's the AMQP 1.0 way to read messages without consuming them.
    // Artemis honours this by delivering each message exactly once to the
    // browsing link and leaving the original queued. Falling back to plain
    // `release` / `modify` semantics produced duplicates on small queues
    // (Artemis re-delivers the same message until `max` is hit because the
    // `undeliverable_here` flag is unreliable across releases).
    let source = Source::builder()
        .address(queue.to_string())
        .distribution_mode(DistributionMode::Copy)
        .build();
    let mut receiver = Receiver::builder()
        .name("amqpush-peek-recv")
        .source(source)
        .attach(&mut session)
        .await
        .map_err(|e: ReceiverAttachError| format!("Attach receiver: {e}"))?;

    let mut out: Vec<PeekedMessage> = Vec::new();
    // Dedup by message-id as a safety net — even with `distribution_mode:
    // copy`, brokers that don't honour the flag (older Artemis, third-party
    // implementations) might still loop the same message. A repeat means
    // we've cycled through the queue; stop early.
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for _ in 0..max {
        let timeout = Duration::from_millis(per_message_timeout_ms);
        let recv_result =
            tokio::time::timeout(timeout, receiver.recv::<Body<Value>>()).await;
        match recv_result {
            Ok(Ok(delivery)) => {
                let peeked = extract_peeked(&delivery);
                // Always settle — in Copy mode this just releases link
                // credit; the broker keeps the message on the queue.
                let _ = receiver.accept(&delivery).await;

                if let Some(id) = peeked.message_id.as_ref() {
                    if !seen_ids.insert(id.clone()) {
                        // Repeat — the broker is looping us. Stop.
                        break;
                    }
                }
                out.push(peeked);
            }
            Ok(Err(e)) => {
                let _ = receiver.detach().await;
                let _ = session.end().await;
                let _ = connection.close().await;
                return Err(format!("recv error: {e}"));
            }
            Err(_) => break, // timeout — no more messages available
        }
    }

    let _ = receiver.detach().await;
    let _ = session.end().await;
    let _ = connection.close().await;
    Ok(out)
}

pub(crate) fn extract_peeked(delivery: &Delivery<Body<Value>>) -> PeekedMessage {
    let msg = delivery.message();

    let header = msg.header.as_ref();
    let priority = header.map(|h| h.priority.0);
    let durable = header.map(|h| h.durable);
    let ttl_ms = header.and_then(|h| h.ttl);
    let delivery_count = header.map(|h| h.delivery_count).unwrap_or(0);

    let p = msg.properties.as_ref();
    let message_id = p
        .and_then(|p| p.message_id.as_ref())
        .map(|id| format!("{id:?}"))
        .map(strip_debug_prefix);
    let user_id = p.and_then(|p| p.user_id.as_ref()).map(|b| format!("{:?}", b));
    let to = p.and_then(|p| p.to.as_ref()).map(|s| s.to_string());
    let subject = p
        .and_then(|p| p.subject.as_ref())
        .map(|s| s.to_string());
    let reply_to = p
        .and_then(|p| p.reply_to.as_ref())
        .map(|s| s.to_string());
    let correlation_id = p
        .and_then(|p| p.correlation_id.as_ref())
        .map(|id| format!("{id:?}"))
        .map(strip_debug_prefix);
    // Standard AMQP property first; fall back to app-properties["content-type"]
    // (some senders, including AMQPush itself, put it there for convenience).
    let content_type = p
        .and_then(|p| p.content_type.as_ref())
        .map(|s| s.to_string())
        .or_else(|| {
            msg.application_properties.as_ref().and_then(|ap| {
                ap.0.iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                    .map(|(_, v)| simple_value_to_string(v))
            })
        });
    let content_encoding = p
        .and_then(|p| p.content_encoding.as_ref())
        .map(|s| s.to_string());
    let absolute_expiry_time = p.and_then(|p| p.absolute_expiry_time.as_ref()).map(|ts| ts.milliseconds());
    let creation_time = p.and_then(|p| p.creation_time.as_ref()).map(|ts| ts.milliseconds());
    let group_id = p
        .and_then(|p| p.group_id.as_ref())
        .map(|s| s.to_string());
    let group_sequence = p.and_then(|p| p.group_sequence);
    let reply_to_group_id = p
        .and_then(|p| p.reply_to_group_id.as_ref())
        .map(|s| s.to_string());

    let application_properties: HashMap<String, String> = msg
        .application_properties
        .as_ref()
        .map(|ApplicationProperties(map)| {
            map.iter()
                .map(|(k, v)| (k.clone(), simple_value_to_string(v)))
                .collect()
        })
        .unwrap_or_default();

    let (body_kind, body_text, body_size) = describe_body(&msg.body);

    PeekedMessage {
        message_id,
        user_id,
        to,
        subject,
        reply_to,
        correlation_id,
        content_type,
        content_encoding,
        absolute_expiry_time,
        creation_time,
        group_id,
        group_sequence,
        reply_to_group_id,
        application_properties,
        body_text,
        body_kind: body_kind.to_string(),
        body_size,
        priority,
        durable,
        ttl_ms,
        delivery_count,
    }
}

/// Convert AMQP body to a printable form. Returns (kind, text, size).
///
/// Kind is normalised to user-facing labels — `text`, `binary`, or `empty` —
/// rather than the raw AMQP body section names (`amqp-value`, `data`, etc.).
/// This keeps the Browser/Receive/History chips human-readable; if the user
/// needs the lower-level type they can look at content-type / content-encoding
/// in the property panel.
fn describe_body(body: &Body<Value>) -> (&'static str, Option<String>, usize) {
    match body {
        Body::Data(batch) => {
            // AMQP allows multiple Data sections — take the first one for inspection.
            // The Data section is by definition opaque bytes; if the bytes happen to
            // decode as valid UTF-8 we treat it as text (this is how JMS TextMessage
            // and most JSON/XML producers actually ship payloads — encoded as Data).
            match batch.iter().next() {
                None => ("empty", None, 0),
                Some(data) => {
                    let bytes: &[u8] = data.0.as_ref();
                    let size = bytes.len();
                    match std::str::from_utf8(bytes) {
                        Ok(s) => ("text", Some(s.to_string()), size),
                        Err(_) => {
                            // Hex-preview the first 512 bytes so the UI has something
                            // to render in HEX mode without us having to send raw bytes.
                            let hex = bytes
                                .iter()
                                .take(512)
                                .map(|b| format!("{b:02x}"))
                                .collect::<Vec<_>>()
                                .join(" ");
                            ("binary", Some(hex), size)
                        }
                    }
                }
            }
        }
        // amqp-sequence: rare list-of-values payload. Serialise to a stringified
        // form (already done by simple_value_to_string_v on each element) and
        // present as text — there's no clean binary interpretation.
        Body::Sequence(_) => ("text", None, 0),
        Body::Value(AmqpValue(v)) => {
            // Distinguish Binary primitive (→ binary) from everything else (→ text).
            match v {
                Value::Binary(b) => {
                    let size = b.len();
                    let hex = b.iter().take(512).map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(" ");
                    ("binary", Some(hex), size)
                }
                _ => {
                    let s = simple_value_to_string_v(v);
                    let size = s.len();
                    ("text", Some(s), size)
                }
            }
        }
        Body::Empty => ("empty", None, 0),
        // Newer fe2o3-amqp may add multiple-data variant — fall back.
        #[allow(unreachable_patterns)]
        _ => ("text", None, 0),
    }
}

fn simple_value_to_string(v: &SimpleValue) -> String {
    match v {
        SimpleValue::String(s) => s.clone(),
        SimpleValue::Symbol(s) => s.to_string(),
        SimpleValue::Bool(b) => b.to_string(),
        SimpleValue::Byte(n) => n.to_string(),
        SimpleValue::Short(n) => n.to_string(),
        SimpleValue::Int(n) => n.to_string(),
        SimpleValue::Long(n) => n.to_string(),
        SimpleValue::Ubyte(n) => n.to_string(),
        SimpleValue::Ushort(n) => n.to_string(),
        SimpleValue::Uint(n) => n.to_string(),
        SimpleValue::Ulong(n) => n.to_string(),
        SimpleValue::Float(f) => f.to_string(),
        SimpleValue::Double(f) => f.to_string(),
        SimpleValue::Char(c) => c.to_string(),
        SimpleValue::Uuid(u) => format!("{u:?}"),
        SimpleValue::Binary(b) => format!("<binary {} bytes>", b.len()),
        SimpleValue::Null => "null".into(),
        other => format!("{other:?}"),
    }
}

fn simple_value_to_string_v(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Symbol(s) => s.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Int(n) => n.to_string(),
        Value::Long(n) => n.to_string(),
        Value::Uint(n) => n.to_string(),
        Value::Ulong(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(f) => f.to_string(),
        Value::Null => "null".into(),
        Value::Binary(b) => format!("<binary {} bytes>", b.len()),
        other => format!("{other:?}"),
    }
}

/// Strip Rust Debug prefixes like `String("foo")` -> `foo`
fn strip_debug_prefix(s: String) -> String {
    if let Some(stripped) = s.strip_prefix("String(\"").and_then(|s| s.strip_suffix("\")")) {
        return stripped.to_string();
    }
    if let Some(stripped) = s.strip_prefix("Symbol(\"").and_then(|s| s.strip_suffix("\")")) {
        return stripped.to_string();
    }
    s
}
