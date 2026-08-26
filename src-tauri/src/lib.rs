//! FESB Settings Editor — бэкенд Tauri.
//!
//! Вся работа с файловой системой живёт здесь: фронтенд получает только
//! готовые структуры и не имеет прямого доступа к диску.

mod applier;
mod archive;
mod domain_xml;
mod fesb_api;
mod fesb_ops;
mod properties;
mod route_graph;
mod route_links;
mod route_xml;
mod scanner;
mod xml;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use applier::{apply_trace_change, ApplyReport, ApplyRequest};
use archive::{create_archive, extract_archive, ArchiveResult, ExtractResult};
use fesb_api::{ApiDomain, Connection, DomainRoutes, PullResult, PushResult, ServerInfo, VerifyResult};
use fesb_ops::{
    DomainActionResult, DomainStat, LogEntry, LogFileRow, LogRequest, ManagerKind, ModuleRow,
    PropertyRow, PropertyScope, QueueManager, QueueMessage, QueueRow, RouteState, SavePoint,
};
use route_graph::{parse_route_graphs, RouteGraph};
use route_links::{build_links, LinkGraph};
use scanner::{scan_root, ScanResult};

const SCAN_PROGRESS_EVENT: &str = "scan:progress";
const APPLY_PROGRESS_EVENT: &str = "apply:progress";
const ARCHIVE_PROGRESS_EVENT: &str = "archive:progress";
const EXTRACT_PROGRESS_EVENT: &str = "extract:progress";
const API_PROGRESS_EVENT: &str = "api:progress";

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

/// Распаковывает zip с выгрузкой во временную папку и возвращает путь к ней.
#[tauri::command]
async fn open_archive(app: AppHandle, path: String) -> Result<ExtractResult, String> {
    let archive = PathBuf::from(&path);
    if !archive.is_file() {
        return Err(format!("File is not accessible: {path}"));
    }

    tauri::async_runtime::spawn_blocking(move || {
        extract_archive(&archive, |progress| {
            let _ = app.emit(EXTRACT_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(|err| format!("Extraction interrupted: {err}"))?
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

/// Проверяет доступность шины и права пользователя.
#[tauri::command]
async fn api_connect(connection: Connection) -> Result<ServerInfo, String> {
    fesb_api::connect(&connection).await
}

/// Список доменов сервера — по нему выбирают, что забирать.
#[tauri::command]
async fn api_domains(connection: Connection) -> Result<Vec<ApiDomain>, String> {
    fesb_api::domains(&connection).await
}

/// Забирает домены с сервера во временную папку в структуре выгрузки.
#[tauri::command]
async fn api_pull(
    app: AppHandle,
    connection: Connection,
    guids: Option<Vec<String>>,
) -> Result<PullResult, String> {
    fesb_api::pull(&connection, guids.as_deref(), |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Отправляет отредактированные домены обратно в шину.
#[tauri::command]
async fn api_push(
    app: AppHandle,
    connection: Connection,
    root: String,
    guids: Vec<String>,
    reload: bool,
) -> Result<PushResult, String> {
    let root = PathBuf::from(root);
    fesb_api::push(&connection, &root, &guids, reload, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Разбирает файл СОПС в дерево шагов — из него рисуется схема.
#[tauri::command]
async fn read_route(path: String) -> Result<Vec<RouteGraph>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let xml = std::fs::read_to_string(&path).map_err(|err| format!("{path}: {err}"))?;
        Ok(parse_route_graphs(&xml))
    })
    .await
    .map_err(|err| format!("Reading interrupted: {err}"))?
}

/// Связи СОПС между собой: кто кого вызывает адресом.
#[tauri::command]
async fn route_links(root: String) -> Result<LinkGraph, String> {
    let root = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || build_links(&root))
        .await
        .map_err(|err| format!("Link analysis interrupted: {err}"))
}

/// Забирает домены заново и сверяет трассировку с локальными файлами.
#[tauri::command]
async fn api_verify(
    app: AppHandle,
    connection: Connection,
    root: String,
    guids: Vec<String>,
) -> Result<VerifyResult, String> {
    let root = PathBuf::from(root);
    fesb_api::verify(&connection, &root, &guids, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Перезапуск модуля: без него брокер не перечитывает изменённую конфигурацию.
#[tauri::command]
async fn api_restart_module(connection: Connection, module: String) -> Result<(), String> {
    fesb_api::restart_module(&connection, &module).await
}

/// Модули шины и их состояние.
#[tauri::command]
async fn api_modules(connection: Connection) -> Result<Vec<ModuleRow>, String> {
    fesb_ops::modules(&connection).await
}

/// Запуск, остановка или перезапуск модуля.
#[tauri::command]
async fn api_module_action(connection: Connection, module: String, action: String) -> Result<(), String> {
    fesb_ops::module_action(&connection, &module, &action).await
}

/// Запуск, остановка или перезапуск домена.
#[tauri::command]
async fn api_domain_action(
    connection: Connection,
    guid: String,
    action: String,
) -> Result<DomainActionResult, String> {
    fesb_ops::domain_action(&connection, &guid, &action).await
}

/// Сводка по всем доменам сервера: СОПС, ошибки, незавершённые сообщения.
#[tauri::command]
async fn api_domain_statistics(connection: Connection) -> Result<Vec<DomainStat>, String> {
    fesb_ops::domain_statistics(&connection).await
}

/// Забирает один домен ради его СОПС — рабочую выгрузку не трогает.
#[tauri::command]
async fn api_domain_routes(connection: Connection, guid: String) -> Result<DomainRoutes, String> {
    fesb_api::fetch_domain_routes(&connection, &guid).await
}

/// Состояние и счётчики одного СОПС.
#[tauri::command]
async fn api_route_state(
    connection: Connection,
    domain: String,
    route: String,
) -> Result<RouteState, String> {
    fesb_ops::route_state(&connection, &domain, &route).await
}

/// Запуск, остановка или сброс счётчиков СОПС.
#[tauri::command]
async fn api_route_action(
    connection: Connection,
    domain: String,
    route: String,
    action: String,
) -> Result<(), String> {
    fesb_ops::route_action(&connection, &domain, &route, &action).await
}

#[tauri::command]
async fn api_save_points(connection: Connection) -> Result<Vec<SavePoint>, String> {
    fesb_ops::save_points(&connection).await
}

#[tauri::command]
async fn api_create_save_point(connection: Connection) -> Result<(), String> {
    fesb_ops::create_save_point(&connection).await
}

#[tauri::command]
async fn api_delete_save_point(connection: Connection, point: SavePoint) -> Result<(), String> {
    fesb_ops::delete_save_point(&connection, point).await
}

#[tauri::command]
async fn api_rollback_save_point(connection: Connection, point: SavePoint) -> Result<(), String> {
    fesb_ops::rollback_save_point(&connection, point).await
}

/// Менеджеры очередей всех трёх видов.
#[tauri::command]
async fn api_queue_managers(connection: Connection) -> Result<Vec<QueueManager>, String> {
    fesb_ops::queue_managers(&connection).await
}

/// Очереди одного менеджера.
#[tauri::command]
async fn api_queues(connection: Connection, kind: ManagerKind, id: String) -> Result<Vec<QueueRow>, String> {
    fesb_ops::queues(&connection, kind, &id).await
}

/// Сообщения очереди — без тела: его шина отдаёт только поштучно.
#[tauri::command]
async fn api_queue_messages(
    connection: Connection,
    kind: ManagerKind,
    id: String,
    queue: String,
    limit: u32,
) -> Result<Vec<QueueMessage>, String> {
    fesb_ops::queue_messages(&connection, kind, &id, &queue, limit).await
}

/// Одно сообщение целиком, вместе с телом.
#[tauri::command]
async fn api_queue_message(
    connection: Connection,
    kind: ManagerKind,
    id: String,
    queue: String,
    message: String,
) -> Result<QueueMessage, String> {
    fesb_ops::queue_message(&connection, kind, &id, &queue, &message).await
}

/// Константы приложения, брокера или домена.
#[tauri::command]
async fn api_properties(connection: Connection, scope: PropertyScope) -> Result<Vec<PropertyRow>, String> {
    fesb_ops::properties(&connection, scope).await
}

#[tauri::command]
async fn api_save_property(
    connection: Connection,
    scope: PropertyScope,
    property: PropertyRow,
    create: bool,
) -> Result<(), String> {
    fesb_ops::save_property(&connection, scope, property, create, None).await
}

#[tauri::command]
async fn api_delete_property(
    connection: Connection,
    scope: PropertyScope,
    key: String,
) -> Result<(), String> {
    fesb_ops::delete_property(&connection, scope, &key).await
}

/// Список файлов журналов сервера.
#[tauri::command]
async fn api_log_files(connection: Connection) -> Result<Vec<LogFileRow>, String> {
    fesb_ops::log_files(&connection).await
}

/// Записи журнала, свежие сверху.
#[tauri::command]
async fn api_log(connection: Connection, request: LogRequest) -> Result<Vec<LogEntry>, String> {
    fesb_ops::log_entries(&connection, request).await
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
            open_archive,
            build_archive,
            read_route,
            route_links,
            api_connect,
            api_domains,
            api_pull,
            api_push,
            api_verify,
            api_restart_module,
            api_modules,
            api_module_action,
            api_domain_action,
            api_domain_statistics,
            api_domain_routes,
            api_route_state,
            api_route_action,
            api_save_points,
            api_create_save_point,
            api_delete_save_point,
            api_rollback_save_point,
            api_queue_managers,
            api_queues,
            api_queue_messages,
            api_queue_message,
            api_properties,
            api_save_property,
            api_delete_property,
            api_log_files,
            api_log
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the application");
}

/// Реэкспорт внутренностей для интеграционных тестов.
#[doc(hidden)]
pub mod testing {
    pub use crate::applier::{apply_trace_change, ApplyRequest, ApplyTarget};
    pub use crate::fesb_api::{connect, domains, pull, push, verify, Connection};
    pub use crate::fesb_api::fetch_domain_routes;
    pub use crate::fesb_ops::{
        delete_property, domain_statistics, log_entries, log_files, modules, properties,
        queue_managers, queue_message, queue_messages, queues, route_state, save_property,
        LogRequest, ManagerKind, PropertyRow,
        PropertyScope,
    };
    pub use crate::archive::create_archive;
    pub use crate::domain_xml::{parse_domain_xml, BeanTarget, TraceUpdate};
    pub use crate::route_graph::{parse_route_graphs, RouteNode};
    pub use crate::route_links::build_links;
    pub use crate::scanner::scan_root;
}
