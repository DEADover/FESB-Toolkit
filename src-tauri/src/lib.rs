//! FESB Settings Editor — бэкенд Tauri.
//!
//! Вся работа с файловой системой живёт здесь: фронтенд получает только
//! готовые структуры и не имеет прямого доступа к диску.

mod applier;
mod archive;
mod domain_xml;
mod properties;
mod route_xml;
mod scanner;
mod xml;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use applier::{apply_trace_change, ApplyReport, ApplyRequest};
use archive::{create_archive, ArchiveResult};
use scanner::{scan_root, ScanResult};

const SCAN_PROGRESS_EVENT: &str = "scan:progress";
const APPLY_PROGRESS_EVENT: &str = "apply:progress";
const ARCHIVE_PROGRESS_EVENT: &str = "archive:progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    tauri: String,
    platform: String,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        tauri: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

/// Сканирует выбранную папку и возвращает таблицу «домен → broker».
#[tauri::command]
async fn scan_directory(app: AppHandle, root: String) -> Result<ScanResult, String> {
    let path = PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("Folder is not accessible: {root}"));
    }

    tauri::async_runtime::spawn_blocking(move || {
        scan_root(&path, |progress| {
            let _ = app.emit(SCAN_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(|err| format!("Scan interrupted: {err}"))
}

/// Заменяет значения property `broker` / `queue` в выбранных доменах.
#[tauri::command]
async fn apply_trace(app: AppHandle, request: ApplyRequest) -> Result<ApplyReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_trace_change(&request, |progress| {
            let _ = app.emit(APPLY_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(|err| format!("Apply interrupted: {err}"))?
}

/// Собирает zip-архив конфигурации для обратной загрузки в шину.
#[tauri::command]
async fn build_archive(
    app: AppHandle,
    root: String,
    output: String,
    domains: Option<Vec<String>>,
) -> Result<ArchiveResult, String> {
    let root = PathBuf::from(root);
    let output = PathBuf::from(output);

    tauri::async_runtime::spawn_blocking(move || {
        create_archive(&root, &output, domains.as_deref(), |progress| {
            let _ = app.emit(ARCHIVE_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(|err| format!("Archiving interrupted: {err}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            scan_directory,
            apply_trace,
            build_archive
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the application");
}

/// Реэкспорт внутренностей для интеграционных тестов.
#[doc(hidden)]
pub mod testing {
    pub use crate::applier::{apply_trace_change, ApplyRequest, ApplyTarget};
    pub use crate::archive::create_archive;
    pub use crate::domain_xml::{parse_domain_xml, BeanTarget, TraceUpdate};
    pub use crate::scanner::scan_root;
}
