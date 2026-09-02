export interface Profile {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  queue: string;          // optional — empty allowed
  use_tls: boolean;

  // Advanced — all optional in the form, defaulted by Rust
  container_id?: string;
  heartbeat_secs?: number;
  connect_timeout_secs?: number;
  tls_skip_verify?: boolean;
  sasl_anonymous?: boolean;

  /** User-defined grouping label (e.g. "Dev" / "Staging" / "Prod"). Drives
   *  section headers in the header profile picker and Cmd+K palette.
   *  Empty / missing falls back to "Default". */
  workspace?: string;

  // Reconnect-backoff tuning for the subscriber attached to this profile.
  // Defaults if missing: base=1000 ms, max=30000 ms, multiplier=2.
  reconnect_base_ms?: number;
  reconnect_max_ms?: number;
  reconnect_multiplier?: number;

  /** Maximum number of attempts per send before giving up (1 = no retry). */
  send_retry_attempts?: number;
  /** Wait between user-visible retry attempts, in ms. */
  send_retry_delay_ms?: number;

  /** mTLS client certificate (optional). PEM `.crt` or PKCS#12 `.p12` /
   *  `.pfx`. Empty string = no client cert. */
  client_cert_path?: string;
  /** PEM `.key` path — required when `client_cert_path` is a PEM cert.
   *  Ignored when `client_cert_path` is a PKCS#12 bundle. */
  client_key_path?: string;
  /** Passphrase to decrypt the PKCS#12 bundle. Ignored for PEM keys (PEM
   *  must be unencrypted PKCS#8 to load via native-tls — convert with
   *  `openssl pkcs8 -topk8 -nocrypt -in encrypted.key -out plain.key`,
   *  or repackage cert+key as a `.p12` if you need passphrase protection). */
  client_key_passphrase?: string;

  /** When true, AMQP is tunnelled over WebSocket (ws:// + use_tls=false,
   *  wss:// + use_tls=true). Useful behind firewalls that block 5671/5672. */
  use_ws?: boolean;
  /** WebSocket URL path component, without leading slash. Empty = root. */
  ws_path?: string;
}

export interface SendResult {
  message_id: string;
  timestamp: string;
  address: string;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  address: string;
  profile: string | null;
  body_preview: string;
  body_full: string | null;
  is_file: boolean;
  file_name: string | null;
  file_data_b64: string | null;
  properties: Record<string, string>;
  auto_properties: Record<string, string>;
}

/** Full AMQP metadata extracted from a delivery — mirrors Rust `PeekedMessage`. */
export interface MessageMeta {
  message_id: string | null;
  user_id: string | null;
  to: string | null;
  subject: string | null;
  reply_to: string | null;
  correlation_id: string | null;
  content_type: string | null;
  content_encoding: string | null;
  absolute_expiry_time: number | null;
  creation_time: number | null;
  group_id: string | null;
  group_sequence: number | null;
  reply_to_group_id: string | null;
  application_properties: Record<string, string>;
  body_text: string | null;
  body_kind: string;
  body_size: number;
  priority: number | null;
  durable: boolean | null;
  ttl_ms: number | null;
  delivery_count: number;
}

export interface ReceivedMessage {
  /** UUID generated on receive — used as React key. */
  id: string;
  /** HH:MM:SS at receive time. */
  timestamp: string;
  /** Truncated body text for compact list display. */
  body: string;
  is_truncated: boolean;
  /** Full extracted AMQP metadata. */
  meta: MessageMeta;
  /** Queue (source address) this message arrived on. */
  queue: string;
}

/** Per-queue subscriber lifecycle event — for reconnecting/reconnected/error/stopped. */
export interface SubEvent {
  queue: string;
  message: string | null;
}

export interface LogEntry {
  id: number;
  /** Unix epoch milliseconds — primary timestamp used for sorting and date
   *  filtering. Display strings are derived from this on render. */
  tsMs: number;
  /** Legacy time-only string ("HH:MM:SS"). Kept on entries restored from
   *  pre-tsMs localStorage so we can show *something* for old logs without
   *  losing them. New entries don't set this. */
  ts?: string;
  kind: "info" | "ok" | "err";
  text: string;
}

export interface PropertyRow {
  id: number;
  enabled?: boolean;
  key: string;
  value: string;
  description?: string;
}

export interface SavedQueue {
  name: string;
  label: string;
  notes: string;
}

export interface Template {
  name: string;
  address: string;
  body: string;
  properties: Record<string, string>;

  // ── Optional fields (added in v1.2). Older saved templates won't have
  //    them; loaders fall back to sensible defaults. ──

  /** Saved Raw subtype. When `null/undefined`, auto-detect picks from body. */
  raw_type?: "text" | "json" | "xml" | null;

  /** Whether the Batch toggle was on when the template was saved. */
  batch_enabled?: boolean | null;
  repeat?: number | null;
  delay_ms?: number | null;

  /** Whether the Schedule toggle was on when the template was saved. */
  schedule_enabled?: boolean | null;
  /** Seconds to wait before the first send. */
  schedule_delay_secs?: number | null;

  /** Whether the Reply (request-reply) toggle was on when saved. */
  reply_enabled?: boolean | null;
  reply_to?: string | null;
  reply_timeout_ms?: number | null;

  /** User-defined variables from the Variables tab. Persists with template. */
  user_vars?: Array<{
    enabled: boolean;
    key: string;
    value: string;
    description?: string;
  }>;

  /** JavaScript pre-script source — runs before each send to set variables. */
  pre_script?: string | null;

  /** JSON Schema source — when set + body subtype is JSON, body is validated.
   *  @deprecated Kept for backward compat with templates saved before XSD
   *  support landed. New saves use `body_schema_json` instead. */
  body_schema?: string | null;

  /** JSON Schema source for the JSON Raw subtype. */
  body_schema_json?: string | null;
  /** XSD (XML Schema) source for the XML Raw subtype. */
  body_schema_xsd?: string | null;
}

export type View = "publisher" | "subscriber" | "history" | "connection" | "stats" | "console" | "browser" | "inspector";

/** One client connection observed by the broker. Matches the `BrokerConnection`
 *  serde struct in src-tauri/src/broker.rs — Artemis camelCase via rename. */
export interface BrokerConnection {
  connection_id: string;
  client_address: string;
  users: string;
  session_count: number;
  /** ms since epoch */
  creation_time: number;
  implementation: string;
  protocol: string;
}

/** One consumer attached to a connection / session, listening on a queue.
 *  Used by the Inspector and the per-message "who holds this?" lookup. */
export interface BrokerConsumer {
  id: number;
  connection_id: string;
  session_id: string;
  queue: string;
  address: string;
  browse_only: boolean;
  /** ms since epoch */
  creation_time: number;
  messages_in_transit: number;
  messages_delivered: number;
  messages_acknowledged: number;
  /** ms since epoch — 0 if never delivered */
  last_delivered_time: number;
  /** ms since epoch — 0 if never acked */
  last_acknowledged_time: number;
  protocol: string;
}
