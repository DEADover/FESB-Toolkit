//! Форма профиля брокера — то, что уходит в движок AMQP при подключении
//! и при переливке сообщений между стендами.
//!
//! Своего хранилища у профиля больше нет: брокер — часть профиля стенда
//! и живёт там же, где адрес шины. Отдельный `~/.amqpush/profiles.json`
//! означал бы, что стенд заводят дважды и однажды переключат шину, забыв
//! про брокер.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Версия схемы профиля. Досталась от AMQPush, где профили лежали своим
/// файлом; здесь профиль приходит из приложения и версия просто едет
/// с ним — на случай, если у стенда однажды появится своя миграция.
pub const CURRENT_VERSION: u32 = 1;

fn default_version() -> u32 { 1 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// On-disk schema version. Missing in pre-versioning files; defaults to
    /// `1` so they're treated as the original shape.
    #[serde(default = "default_version")]
    pub version: u32,

    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub queue: String,
    #[serde(default)]
    pub use_tls: bool,

    // Advanced options — added later, default to "off"/"auto" so old
    // profiles without these keys keep loading.
    #[serde(default)]
    pub container_id: String,            // empty = autogenerate
    #[serde(default)]
    pub heartbeat_secs: u32,             // 0 = no idle-timeout
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_secs: u32,       // 0 = no timeout (block until connected)
    #[serde(default)]
    pub tls_skip_verify: bool,           // self-signed certs (insecure)
    #[serde(default)]
    pub sasl_anonymous: bool,            // force ANONYMOUS even with creds in form

    /// User-defined grouping label, e.g. "Dev" / "Staging" / "Prod" or per
    /// service / project. Profiles are sorted under their workspace in the
    /// global picker and the Cmd+K palette. Empty / missing → "Default".
    #[serde(default = "default_workspace")]
    pub workspace: String,

    // ── Reconnect-backoff tuning (subscriber loop) ─────────────────────
    // Wait base ms after the first failure; double on each subsequent
    // failure (×multiplier); cap at max_ms. Defaults match the previous
    // hardcoded behaviour so existing profiles see no change. Users with
    // long broker outages can crank max_ms way up to avoid log flood.
    #[serde(default = "default_reconnect_base_ms")]
    pub reconnect_base_ms: u64,
    #[serde(default = "default_reconnect_max_ms")]
    pub reconnect_max_ms: u64,
    #[serde(default = "default_reconnect_multiplier")]
    pub reconnect_multiplier: f64,

    // ── Send-retry budget (publisher) ──────────────────────────────────
    // When a send fails for a non-disconnect reason (broker rejected the
    // attach, server-side timeout, etc.), retry up to N-1 more times
    // sleeping `send_retry_delay_ms` between attempts. Default 1 = no
    // retry, preserves pre-1.5.x behaviour.
    #[serde(default = "default_send_retry_attempts")]
    pub send_retry_attempts: u32,
    #[serde(default = "default_send_retry_delay_ms")]
    pub send_retry_delay_ms: u64,

    // ── mTLS client certificate (optional) ─────────────────────────────
    // Path to a PEM `.crt` or a PKCS#12 `.p12` bundle. The file extension
    // picks the loader. `client_key_path` is required for PEM, ignored for
    // PKCS#12. `client_key_passphrase` decrypts the PKCS#12 bundle.
    #[serde(default)]
    pub client_cert_path: String,
    #[serde(default)]
    pub client_key_path: String,
    #[serde(default)]
    pub client_key_passphrase: String,

    // ── AMQP-over-WebSocket transport (optional) ───────────────────────
    // When `use_ws` is true, AMQP rides over ws://host:port/<path> (or
    // wss:// when `use_tls` is also on) instead of raw TCP. Useful behind
    // corporate firewalls and for cloud brokers (Azure SB, Amazon MQ,
    // RabbitMQ with rabbitmq_web_amqp plugin).
    #[serde(default)]
    pub use_ws: bool,
    #[serde(default)]
    pub ws_path: String,

    /// Catch-all for fields not modelled here. Without it, hand-edited custom
    /// keys (or fields from a newer AMQPush version) would be silently dropped
    /// on the first `save_profile`. With `#[serde(flatten)]` they ride
    /// through load → save round-trips intact.
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

fn default_connect_timeout() -> u32 { 10 }
fn default_workspace() -> String { "Default".into() }
fn default_reconnect_base_ms() -> u64 { 1_000 }
fn default_reconnect_max_ms() -> u64 { 30_000 }
fn default_reconnect_multiplier() -> f64 { 2.0 }
fn default_send_retry_attempts() -> u32 { 1 }
fn default_send_retry_delay_ms() -> u64 { 250 }

impl Default for Profile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            name: String::new(),
            host: "127.0.0.1".into(),
            port: 61616,
            username: String::new(),
            password: String::new(),
            queue: String::new(),
            use_tls: false,
            container_id: String::new(),
            heartbeat_secs: 0,
            connect_timeout_secs: 10,
            tls_skip_verify: false,
            sasl_anonymous: false,
            workspace: default_workspace(),
            reconnect_base_ms: default_reconnect_base_ms(),
            reconnect_max_ms: default_reconnect_max_ms(),
            reconnect_multiplier: default_reconnect_multiplier(),
            send_retry_attempts: default_send_retry_attempts(),
            send_retry_delay_ms: default_send_retry_delay_ms(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            client_key_passphrase: String::new(),
            use_ws: false,
            ws_path: String::new(),
            extra: HashMap::new(),
        }
    }
}
