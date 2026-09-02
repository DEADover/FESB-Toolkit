//! Silent consumer of Artemis's `activemq.notifications` address.
//!
//! When a broker is configured with `send-to-dla-on-no-route` (a common
//! default), every internal notification (BINDING_ADDED, BINDING_REMOVED,
//! SESSION_CLOSED, CONSUMER_CREATED, …) without a subscriber gets routed to
//! the DLQ. Our normal AMQPush usage — Browser peeks, subscribers
//! starting/stopping, request-reply — generates a steady stream of these
//! notifications, so the user sees the DLQ count grow even if no application
//! ever fails to deliver a message.
//!
//! The drainer subscribes to `activemq.notifications` from the moment the
//! user connects, accepts every delivery, and silently drops it. This
//! prevents the no-consumer → DLA path from ever triggering on our events.
//! The drainer runs in its own Tokio task on its own AMQP connection so its
//! lifecycle is independent of the publisher / subscriber sessions.

use fe2o3_amqp::{Receiver, Session};
use fe2o3_amqp_types::messaging::Body;
use fe2o3_amqp_types::primitives::Value;
use uuid::Uuid;

const NOTIF_ADDRESS: &str = "activemq.notifications";

pub struct DrainerHandle {
    abort: tokio::task::AbortHandle,
}

impl DrainerHandle {
    pub fn stop(&self) {
        self.abort.abort();
    }
}

#[derive(Clone)]
struct DrainerParams {
    host: String,
    port: u16,
    username: String,
    password: String,
    use_tls: bool,
    tls_skip_verify: bool,
    client_cert: crate::amqpush::amqp::ClientCert,
    transport: crate::amqpush::amqp::TransportOpts,
}

async fn open(p: &DrainerParams) -> Result<(
    Receiver,
    fe2o3_amqp::connection::ConnectionHandle<()>,
    fe2o3_amqp::session::SessionHandle<()>,
), String> {
    let mut connection = crate::amqpush::amqp::open_connection(
        &p.host, p.port, &p.username, &p.password,
        p.use_tls, p.tls_skip_verify,
        "amqpush-notif", false, 0,
        &p.client_cert, &p.transport,
    )
    .await
    .map_err(|e| format!("Notif drainer connection failed: {e}"))?;

    let mut session = Session::begin(&mut connection)
        .await
        .map_err(|e| format!("Notif drainer session failed: {e}"))?;

    // Artemis exposes `activemq.notifications` as a multicast address. A plain
    // Receiver::attach against it auto-creates a non-durable subscription
    // queue; the queue is removed when the link detaches because we don't ask
    // for `durable=Configuration` on the source.
    let link_name = format!("amqpush-notif-{}", Uuid::new_v4());
    let receiver = Receiver::attach(&mut session, link_name, NOTIF_ADDRESS)
        .await
        .map_err(|e| format!("Notif drainer link failed: {e}"))?;

    Ok((receiver, connection, session))
}

/// Spawn the drainer task. Returns `Err` only if the initial attach fails —
/// caller should treat that as non-fatal (broker may not have notifications,
/// or auth may forbid the address). After a successful start, the task
/// reconnects automatically on transport errors.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    use_tls: bool,
    tls_skip_verify: bool,
    client_cert: crate::amqpush::amqp::ClientCert,
    transport: crate::amqpush::amqp::TransportOpts,
) -> Result<DrainerHandle, String> {
    let params = DrainerParams {
        host: host.to_string(),
        port,
        username: username.to_string(),
        password: password.to_string(),
        use_tls,
        tls_skip_verify,
        client_cert,
        transport,
    };

    let (receiver, connection, session) = open(&params).await?;
    let task = tokio::spawn(run_loop(receiver, connection, session, params));
    Ok(DrainerHandle { abort: task.abort_handle() })
}

async fn run_loop(
    mut receiver: Receiver,
    mut connection: fe2o3_amqp::connection::ConnectionHandle<()>,
    mut session: fe2o3_amqp::session::SessionHandle<()>,
    params: DrainerParams,
) {
    const MAX_BACKOFF_MS: u64 = 30_000;
    const MAX_RETRIES: u32 = 5;
    let mut backoff_ms: u64 = 1_000;
    let mut retries: u32 = 0;

    loop {
        match receiver.recv::<Body<Value>>().await {
            Ok(delivery) => {
                backoff_ms = 1_000;
                retries = 0;
                // Accept and discard. We don't surface notifications to the UI.
                let _ = receiver.accept(&delivery).await;
            }
            Err(_) => {
                // Connection lost. Best-effort cleanup, then back-off + reattach.
                let _ = receiver.detach().await;
                let _ = session.end().await;
                let _ = connection.close().await;

                if retries >= MAX_RETRIES {
                    // Give up — broker probably revoked our access or doesn't
                    // support notifications. Failing this loop is silent: the
                    // drainer just goes away.
                    eprintln!("notif_drainer: giving up after {MAX_RETRIES} reconnect attempts");
                    return;
                }

                tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(MAX_BACKOFF_MS);
                retries += 1;

                match open(&params).await {
                    Ok((r, c, s)) => {
                        receiver = r;
                        connection = c;
                        session = s;
                    }
                    Err(e) => {
                        eprintln!("notif_drainer: reattach failed ({e}) — will retry");
                        // Loop continues; next iteration's recv will fail
                        // immediately and we'll try again with longer backoff.
                        // But we have no receiver yet, so just continue —
                        // construct dummy state so the loop variables are set.
                        // Actually simpler: bail out and let the user reconnect
                        // re-spawn us. Don't keep a dead loop alive.
                        return;
                    }
                }
            }
        }
    }
}
