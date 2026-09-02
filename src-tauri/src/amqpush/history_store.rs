//! On-disk persistence for the send history. Uses the same `~/.amqpush/`
//! directory as profiles/queues/templates. Best-effort: any I/O failures are
//! silently logged to stderr without breaking the send flow.

use crate::amqpush::amqp::HistoryEntry;
use std::path::PathBuf;

/// In-memory cap for history. Old installations may have files with many more
/// entries than this — they're trimmed on first load (see `load`).
pub const HISTORY_CAP: usize = 200;

fn history_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".amqpush");
    std::fs::create_dir_all(&dir).ok();
    dir.join("history.json")
}

pub fn load() -> Vec<HistoryEntry> {
    let path = history_path();
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut entries: Vec<HistoryEntry> = serde_json::from_str(&data).unwrap_or_default();

    // One-time trim. Older installations (before HISTORY_CAP was enforced in
    // memory) accumulated 500-1000+ entries on disk; cap on load and rewrite
    // so subsequent loads are fast and the file size stays bounded. Newest
    // entries win — `save_message` in lib.rs pushes to the tail, so we keep
    // the tail.
    if entries.len() > HISTORY_CAP {
        let drop = entries.len() - HISTORY_CAP;
        entries.drain(0..drop);
        save(&entries);
    }
    entries
}

pub fn save(history: &[HistoryEntry]) {
    let path = history_path();
    match serde_json::to_string_pretty(history) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                eprintln!("history: save failed: {e}");
            }
        }
        Err(e) => eprintln!("history: serialize failed: {e}"),
    }
}
