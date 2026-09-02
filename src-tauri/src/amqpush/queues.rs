use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQueue {
    pub name: String,
    pub label: String,
    pub notes: String,
}

fn path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".amqpush");
    std::fs::create_dir_all(&dir).ok();
    dir.join("queues.json")
}

pub fn load_all() -> Vec<SavedQueue> {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(queue: SavedQueue) -> Result<(), String> {
    let mut list = load_all();
    if let Some(existing) = list.iter_mut().find(|q| q.name == queue.name) {
        *existing = queue;
    } else {
        list.push(queue);
    }
    std::fs::write(path(), serde_json::to_string_pretty(&list).unwrap())
        .map_err(|e| e.to_string())
}

pub fn delete(name: &str) -> Result<(), String> {
    let mut list = load_all();
    list.retain(|q| q.name != name);
    std::fs::write(path(), serde_json::to_string_pretty(&list).unwrap())
        .map_err(|e| e.to_string())
}
