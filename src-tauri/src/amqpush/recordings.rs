//! Receive-side recording & replay store.
//!
//! Each recording is a JSON file in `~/.amqpush/recordings/<name>.json` with
//! the captured messages and their relative arrival timings. The UI's
//! Recording mode in the Receive view feeds the file; the Replay tab walks
//! the file and re-sends each message via the existing `send_message`
//! plumbing.
//!
//! On-disk shape (versioned for forward-compat with future migrations):
//! ```json
//! {
//!   "version": 1,
//!   "name": "prod-orders-sample",
//!   "source_queue": "orders.created",
//!   "started_at_ms": 1730000000000,
//!   "messages": [
//!     {
//!       "offset_ms": 0,
//!       "body": "{\"id\":1}",
//!       "content_type": "application/json",
//!       "properties": { "type": "order" }
//!     },
//!     { "offset_ms": 142, "body": "{\"id\":2}", "properties": {} }
//!   ]
//! }
//! ```
//!
//! Recordings are append-only from the app's perspective — we don't expose
//! an edit-message API, only delete-whole-recording and a JSON-export so a
//! user can hand-tweak in `$EDITOR` if needed.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

const CURRENT_VERSION: u32 = 1;

/// One captured message + when it arrived relative to the recording start.
/// `offset_ms` is the wall-clock delta in milliseconds since the first
/// recorded message — drives replay timing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedMessage {
    pub offset_ms: u64,
    /// Body as text. AMQP `Data` bodies are best-effort UTF-8 decoded
    /// upstream; the field is required so a non-text body is recorded as
    /// its lossy-UTF-8 form rather than dropped.
    pub body: String,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub properties: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    #[serde(default = "default_version")]
    pub version: u32,
    pub name: String,
    /// Queue / address this recording was captured from. Surfaced as a hint
    /// in the Replay UI ("originally from orders.created") but the user can
    /// pick any destination on replay — recording carries no broker binding.
    #[serde(default)]
    pub source_queue: String,
    /// ms since epoch when recording started — for display in the picker
    /// list. Replay doesn't use this; offsets are relative to the first
    /// captured message.
    #[serde(default)]
    pub started_at_ms: i64,
    pub messages: Vec<RecordedMessage>,
}

fn default_version() -> u32 { CURRENT_VERSION }

/// Metadata-only view used by the recordings list — full message array is
/// not loaded for the list, only on Replay. Saves us deserialising every
/// body just to render filenames.
#[derive(Debug, Clone, Serialize)]
pub struct RecordingSummary {
    pub name: String,
    pub source_queue: String,
    pub started_at_ms: i64,
    pub message_count: usize,
    pub bytes: u64,
}

fn recordings_dir() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".amqpush")
        .join("recordings");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn safe_filename(name: &str) -> String {
    // Block path traversal + filesystem-hostile chars. The set is the union
    // of POSIX + Windows reserved characters so a recording recorded on Mac
    // is openable on Windows.
    name.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0') { '_' } else { c })
        .collect()
}

fn recording_path(name: &str) -> PathBuf {
    recordings_dir().join(format!("{}.json", safe_filename(name)))
}

/// Walk the recordings directory and return one summary per file. Files
/// that fail to parse are skipped silently (the UI shows the surviving
/// list rather than blocking on one corrupt file).
pub fn list_summaries() -> Vec<RecordingSummary> {
    let dir = recordings_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let size = bytes.len() as u64;
        let rec: Recording = match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(_) => continue,
        };
        out.push(RecordingSummary {
            name: rec.name,
            source_queue: rec.source_queue,
            started_at_ms: rec.started_at_ms,
            message_count: rec.messages.len(),
            bytes: size,
        });
    }
    // Newest-first by capture time, fall back to name.
    out.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms).then_with(|| a.name.cmp(&b.name)));
    out
}

pub fn load_one(name: &str) -> Result<Recording, String> {
    let path = recording_path(name);
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Read recording '{name}': {e}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| format!("Parse recording '{name}': {e}"))
}

pub fn save_one(rec: &Recording) -> Result<(), String> {
    if rec.name.trim().is_empty() {
        return Err("Recording name is required".into());
    }
    let path = recording_path(&rec.name);
    let json = serde_json::to_vec_pretty(rec)
        .map_err(|e| format!("Serialize recording: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Write recording '{}': {e}", rec.name))?;
    Ok(())
}

pub fn delete_one(name: &str) -> Result<(), String> {
    let path = recording_path(name);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Delete recording '{name}': {e}")),
    }
}
