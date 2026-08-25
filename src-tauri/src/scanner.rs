//! Обход выбранной папки и сбор карточек доменов.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::domain_xml::parse_domain_xml;
use crate::properties::parse_properties;
use crate::route_xml::parse_routes;

const DOMAIN_XML: &str = "domain.xml";
const SETTINGS: &str = "settings.properties";
const ROUTES_DIR: &str = "routes";
const VERSION_FILE: &str = "version";
const SKIP_DIRS: [&str; 4] = ["node_modules", ".git", ".svn", "__MACOSX"];
const MAX_DEPTH: usize = 12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRow {
    pub bean_id: Option<String>,
    pub bean_name: Option<String>,
    pub broker: Option<String>,
    pub queue: Option<String>,
    pub client_type: Option<String>,
    pub trace_mode: Option<String>,
    pub line: usize,
    /// У bean-а есть соответствующий property — значит значение можно заменить.
    pub broker_editable: bool,
    pub queue_editable: bool,
    pub trace_mode_editable: bool,
}

/// СОПС — схема обработки потоков сообщений, она же route Apache Camel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRow {
    pub id: Option<String>,
    pub name: Option<String>,
    pub trace_enabled: bool,
    pub trace_configs: Vec<String>,
    pub inline_trace_config: bool,
    pub file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainRecord {
    pub id: String,
    pub dir_path: String,
    pub dir_name: String,
    pub domain_xml_path: String,
    pub settings_path: Option<String>,
    pub domain_name: String,
    pub guid: Option<String>,
    pub description: Option<String>,
    pub start_active: Option<bool>,
    pub start_mode: Option<String>,
    pub hidden: Option<bool>,
    pub traces: Vec<TraceRow>,
    pub routes: Vec<RouteRow>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    /// Версия шины из файла `version` рядом с выгрузкой, например `V8.6.461`.
    pub fesb_version: Option<String>,
    pub scanned_at: String,
    pub duration_ms: u128,
    pub domains: Vec<DomainRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: &'static str,
    pub visited: usize,
    pub found: usize,
    pub current: usize,
    pub total: usize,
}

/// Рекурсивно собирает каталоги, в которых лежит `domain.xml`.
pub fn find_domain_dirs<F: FnMut(ScanProgress)>(root: &Path, on_progress: &mut F) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut visited = 0usize;
    let mut head = 0usize;

    while head < queue.len() {
        let (dir, depth) = queue[head].clone();
        head += 1;

        // Нет прав или битая ссылка — молча пропускаем ветку.
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let entries: Vec<fs::DirEntry> = entries.flatten().collect();
        visited += 1;
        if visited % 25 == 0 {
            on_progress(ScanProgress { phase: "walk", visited, found: found.len(), current: 0, total: 0 });
        }

        if entries.iter().any(|e| e.file_name() == DOMAIN_XML && e.path().is_file()) {
            found.push(dir.clone());
        }
        if depth >= MAX_DEPTH {
            continue;
        }

        for entry in entries {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // Скрытые каталоги пропускаем: в них лежит .history — старые версии файлов.
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            queue.push((entry.path(), depth + 1));
        }
    }

    found.sort();
    found
}

/// Читает один каталог домена и собирает карточку.
pub fn read_domain(dir: &Path, root: &Path) -> DomainRecord {
    let domain_xml_path = dir.join(DOMAIN_XML);
    let settings_path = dir.join(SETTINGS);
    let dir_name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let id = dir
        .strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| dir_name.clone());

    let mut record = DomainRecord {
        id,
        dir_path: dir.to_string_lossy().to_string(),
        dir_name: dir_name.clone(),
        domain_xml_path: domain_xml_path.to_string_lossy().to_string(),
        settings_path: None,
        domain_name: String::new(),
        guid: None,
        description: None,
        start_active: None,
        start_mode: None,
        hidden: None,
        traces: Vec::new(),
        routes: Vec::new(),
        errors: Vec::new(),
    };

    match fs::read_to_string(&settings_path) {
        Ok(text) => {
            let props = parse_properties(&text);
            record.settings_path = Some(settings_path.to_string_lossy().to_string());
            record.domain_name = props.get("fesb.domain.name").cloned().unwrap_or_default();
            record.guid = props.get("fesb.domain.guid").cloned();
            record.description = props.get("fesb.domain.description").cloned().filter(|s| !s.is_empty());
            record.start_active = props.get("fesb.domain.start.active").map(|v| v == "true");
            record.start_mode = props.get("fesb.domain.start.mode").cloned();
            record.hidden = props.get("fesb.domain.hidden").map(|v| v == "true");
        }
        Err(err) => record.errors.push(format!("settings.properties: {err}")),
    }

    match fs::read_to_string(&domain_xml_path) {
        Ok(xml) => {
            let parsed = parse_domain_xml(&xml);
            if record.guid.is_none() {
                record.guid = parsed.camel_context_id;
            }
            record.traces = parsed
                .traces
                .into_iter()
                .map(|t| TraceRow {
                    line: t.broker_location.as_ref().map(|l| l.line).unwrap_or(t.bean_line),
                    broker_editable: t.broker_location.is_some(),
                    queue_editable: t.queue_location.is_some(),
                    trace_mode_editable: t.trace_mode_location.is_some(),
                    bean_id: t.bean_id,
                    bean_name: t.bean_name,
                    broker: t.broker,
                    queue: t.queue,
                    client_type: t.client_type,
                    trace_mode: t.trace_mode,
                })
                .collect();
        }
        Err(err) => record.errors.push(format!("domain.xml: {err}")),
    }

    read_domain_routes(dir, &mut record);

    if record.domain_name.is_empty() {
        record.domain_name = record.guid.clone().unwrap_or(dir_name);
    }
    record
}

/// Читает подпапку `routes` домена: в одном файле может быть несколько маршрутов.
fn read_domain_routes(dir: &Path, record: &mut DomainRecord) {
    let routes_dir = dir.join(ROUTES_DIR);
    let Ok(entries) = fs::read_dir(&routes_dir) else { return };

    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml")))
        .collect();
    files.sort();

    for file in files {
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        match fs::read_to_string(&file) {
            Ok(xml) => record.routes.extend(parse_routes(&xml).into_iter().map(|route| RouteRow {
                id: route.id,
                name: route.name,
                trace_enabled: route.trace_enabled,
                trace_configs: route.trace_configs,
                inline_trace_config: route.inline_trace_config,
                file: name.clone(),
            })),
            Err(err) => record.errors.push(format!("{name}: {err}")),
        }
    }
}

/// Читает версию шины из файла `version`.
///
/// Обычно выбирают папку `domains`, а файл лежит уровнем выше, рядом с ней,
/// поэтому смотрим оба места.
fn read_fesb_version(root: &Path) -> Option<String> {
    let mut candidates = vec![root.join(VERSION_FILE)];
    if let Some(parent) = root.parent() {
        candidates.push(parent.join(VERSION_FILE));
    }

    for path in candidates {
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let value = text.trim();
        // В файле только строка версии; всё длиннее — это точно не она.
        if !value.is_empty() && value.len() <= 64 {
            return Some(value.to_string());
        }
    }
    None
}

/// Полный проход по выбранной папке.
pub fn scan_root<F: FnMut(ScanProgress)>(root: &Path, mut on_progress: F) -> ScanResult {
    let started = std::time::Instant::now();
    let dirs = find_domain_dirs(root, &mut on_progress);
    let total = dirs.len();

    let mut domains = Vec::with_capacity(total);
    for (index, dir) in dirs.iter().enumerate() {
        domains.push(read_domain(dir, root));
        on_progress(ScanProgress { phase: "read", visited: 0, found: total, current: index + 1, total });
    }

    ScanResult {
        root: root.to_string_lossy().to_string(),
        fesb_version: read_fesb_version(root),
        scanned_at: chrono::Local::now().to_rfc3339(),
        duration_ms: started.elapsed().as_millis(),
        domains,
    }
}
