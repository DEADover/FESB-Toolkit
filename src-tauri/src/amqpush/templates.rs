use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Current schema version for `Template`. See `profiles.rs` for the
/// migration-system rationale — bump on breaking changes, add an arm to
/// `migrate_template`, files saved by older AMQPush versions get migrated
/// lazily on load.
pub const CURRENT_VERSION: u32 = 1;

fn default_version() -> u32 { 1 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    /// On-disk schema version. Missing in pre-versioning files; defaults to
    /// `1` so they're treated as the original shape.
    #[serde(default = "default_version")]
    pub version: u32,

    pub name: String,
    pub address: String,
    pub body: String,
    pub properties: HashMap<String, String>,

    // ── Optional fields added in v1.2 — older saved templates won't have
    //    them, so each one is `#[serde(default)]` for backward compat. ──

    /// Saved Raw subtype (`text` / `json` / `xml`). When `None`, the
    /// auto-detect on load will pick from body content.
    #[serde(default)]
    pub raw_type: Option<String>,

    /// Whether the Batch toggle was on when the template was saved.
    #[serde(default)]
    pub batch_enabled: Option<bool>,
    #[serde(default)]
    pub repeat: Option<u32>,
    #[serde(default)]
    pub delay_ms: Option<u32>,

    /// Whether the Schedule toggle was on (delayed first send).
    #[serde(default)]
    pub schedule_enabled: Option<bool>,
    #[serde(default)]
    pub schedule_delay_secs: Option<u32>,

    /// Whether the Reply (request-reply) toggle was on when saved.
    #[serde(default)]
    pub reply_enabled: Option<bool>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub reply_timeout_ms: Option<u32>,

    /// User-defined variables from the Variables tab. Each entry mirrors the
    /// `UserVariable` shape on the frontend.
    #[serde(default)]
    pub user_vars: Vec<TemplateVariable>,

    /// JavaScript pre-script source. Runs before each send to compute
    /// dynamic variable values. Empty / `None` → no script.
    #[serde(default)]
    pub pre_script: Option<String>,

    /// JSON Schema source — body is validated against this when subtype is JSON.
    /// Kept for backward compat with templates saved before XSD support landed;
    /// new saves use `body_schema_json` instead.
    #[serde(default)]
    pub body_schema: Option<String>,

    /// JSON Schema source for the JSON Raw subtype.
    #[serde(default)]
    pub body_schema_json: Option<String>,
    /// XSD (XML Schema) source for the XML Raw subtype.
    #[serde(default)]
    pub body_schema_xsd: Option<String>,

    /// Catch-all for fields not modelled here. Without it, hand-edited custom
    /// keys (or fields from a newer AMQPush version) would be silently dropped
    /// on the first `save_template`. With `#[serde(flatten)]` they ride
    /// through load → save round-trips intact.
    #[serde(flatten, default)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateVariable {
    pub enabled: bool,
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub description: String,
}

fn path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".amqpush")
        .join("templates.json")
}

/// Step a single `Template` forward one schema version at a time until it
/// reaches `CURRENT_VERSION`. No-op currently (v1 only); add match arms here
/// when a breaking change requires translation.
fn migrate_template(t: &mut Template) {
    while t.version < CURRENT_VERSION {
        match t.version {
            // 1 => { ...translate v1 → v2 here...; t.version = 2 }
            _ => {
                eprintln!("template '{}': unknown version {}, skipping migration", t.name, t.version);
                break;
            }
        }
    }
}

pub fn load_all() -> Vec<Template> {
    let mut list: Vec<Template> = fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for t in list.iter_mut() {
        migrate_template(t);
    }
    list
}

fn save_all(templates: &[Template]) {
    let p = path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&p, serde_json::to_string_pretty(templates).unwrap_or_default());
}

pub fn save(mut template: Template) {
    let mut all = load_all();
    if let Some(pos) = all.iter().position(|t| t.name == template.name) {
        // The frontend doesn't know about `extra` (it's a catch-all for
        // hand-edited custom fields or fields from a newer AMQPush version).
        // Preserve whatever was on disk so a vanilla save_template doesn't
        // wipe user customisations or future-version data.
        if template.extra.is_empty() {
            template.extra = std::mem::take(&mut all[pos].extra);
        }
        all[pos] = template;
    } else {
        all.push(template);
    }
    save_all(&all);
}

pub fn delete(name: &str) {
    let all: Vec<Template> = load_all().into_iter().filter(|t| t.name != name).collect();
    save_all(&all);
}

/// Rename a template in place. Returns `Err` if the new name is empty, the
/// old name doesn't exist, or another template already uses the new name —
/// callers surface those as user-facing validation errors.
pub fn rename(old_name: &str, new_name: &str) -> Result<(), String> {
    let new_trim = new_name.trim();
    if new_trim.is_empty() {
        return Err("New name cannot be empty".into());
    }
    if old_name == new_trim {
        return Ok(()); // no-op
    }
    let mut all = load_all();
    if all.iter().any(|t| t.name == new_trim) {
        return Err(format!("Template '{new_trim}' already exists"));
    }
    let pos = all.iter().position(|t| t.name == old_name)
        .ok_or_else(|| format!("Template '{old_name}' not found"))?;
    all[pos].name = new_trim.to_string();
    save_all(&all);
    Ok(())
}
