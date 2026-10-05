//! FESB Toolkit — бэкенд Tauri.
//!
//! Вся работа с файловой системой живёт здесь: фронтенд получает только
//! готовые структуры и не имеет прямого доступа к диску.

mod applier;
mod analytics;
mod api_report;
mod archive;
mod broker_access;
mod amqpush;
mod certificates;
mod change_journal;
mod compare;
mod domain_copy;
mod domain_xml;
mod fesb_api;
mod fesb_ops;
mod journal_ops;
mod key_trace;
mod properties;
mod queue_dump;
mod mq_config;
mod report_store;
mod route_graph;
mod route_links;
mod route_trace;
mod route_xml;
mod routes_overview;
mod scanner;
mod snapshot_store;
mod stand_passport;
mod security;
mod settings_store;
mod trace_options;
mod xlsx;
mod xml;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use change_journal::Sink;
use journal_ops::Note;
use applier::{apply_trace_change, ApplyReport, ApplyRequest};
use archive::{create_archive, extract_archive, ArchiveResult, ExtractResult};
use fesb_api::{
    ApiDomain, ApiProgress, Connection, DomainRoutes, PullResult, PushResult, ServerInfo,
    VerifyResult,
};
use fesb_ops::{
    AuditEntry, DomainActionResult, DomainStat, LogEntry, LogFileRow, LogRequest, ManagerKind, ModuleRow,
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
    /// Не для показа: по нему интерфейс решает, отступать ли под кнопки macOS.
    platform: String,
    /// Портативная сборка: exe без установщика. Установщик меняет его на
    /// свою установку, поэтому такой exe обновляется скачиванием нового файла.
    portable: bool,
}

/// Как правку записать в журнал: в какую запись и под какими именами.
///
/// Без записи (`entry`) команда заводит свою — на одно изменение. Массовая
/// операция заводит запись сама (`journal_open`) и передаёт её в каждый вызов:
/// так двести СОПС оказываются одной строкой журнала, а не двумястами.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalNote {
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

fn journal_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(settings_dir(app)?.join("journal"))
}

/// Запись журнала для правки. Если журнал недоступен, правка всё равно идёт:
/// ошибка папки данных — не повод отказывать в работе со стендом.
fn journal_sink(app: &AppHandle, connection: &Connection, note: &Option<JournalNote>, origin: &str) -> Option<Sink> {
    let dir = journal_dir(app).ok()?;
    // Запись от интерфейса принимается, только если она есть и заведена на
    // этот же стенд: иначе правки легли бы в чужую запись или мимо журнала.
    match note.as_ref().and_then(|note| note.entry.clone()) {
        Some(entry) if change_journal::belongs(&dir, &entry, &connection.base()) => Some(Sink { dir, entry }),
        _ => journal_ops::open_entry(&dir, connection, origin).map_err(|err| eprintln!("journal: {err}")).ok(),
    }
}

fn note_for<'a>(sink: &'a Option<Sink>, note: &Option<JournalNote>) -> Note<'a> {
    Note {
        sink: sink.as_ref(),
        domain: note.as_ref().and_then(|note| note.domain.clone()),
        name: note.as_ref().and_then(|note| note.name.clone()),
        undoes: None,
    }
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        // Сборщик записывает тип установщика в exe только на время упаковки,
        // а исходный exe, который и выкладывается как портативный, остаётся
        // без него.
        portable: cfg!(windows) && tauri::utils::platform::bundle_type().is_none(),
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
    let sink = journal_sink(&app, &connection, &None, "push");
    journal_ops::push(&connection, &root, &guids, reload, sink.as_ref(), |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Предпросмотр копирования доменов на другой сервер.
#[tauri::command]
async fn api_copy_plan(
    app: AppHandle,
    source: Connection,
    target: Connection,
    guids: Vec<String>,
) -> Result<domain_copy::CopyPlan, String> {
    domain_copy::plan(&source, &target, &guids, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Загружает на целевой сервер домены, показанные в предпросмотре.
#[tauri::command]
async fn api_copy_run(
    app: AppHandle,
    target: Connection,
    plan_id: String,
    reload: bool,
    remove_missing: bool,
) -> Result<domain_copy::CopyResult, String> {
    let sink = journal_sink(&app, &target, &None, "copy");
    domain_copy::run(&target, &plan_id, reload, remove_missing, sink.as_ref(), |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Объекты менеджера очередей и то, хранятся ли они в конфигурации.
#[tauri::command]
async fn api_mq_config(
    connection: Connection,
    manager: ManagerKind,
    server: String,
) -> Result<mq_config::ConfigAudit, String> {
    mq_config::audit(&connection, manager, &server).await
}

/// Включает объектам менеджера очередей «Хранить в конфигурации».
#[tauri::command]
async fn api_mq_store(
    app: AppHandle,
    connection: Connection,
    manager: ManagerKind,
    server: String,
    items: Vec<mq_config::StoreRequest>,
) -> Result<Vec<mq_config::StoreOutcome>, String> {
    let result = mq_config::store(&connection, manager, &server, &items).await;
    let sink = journal_sink(&app, &connection, &None, "mqConfig");
    match &result {
        Ok(outcomes) => {
            for outcome in outcomes {
                let note = Note { sink: sink.as_ref(), domain: Some(server.clone()), name: Some(outcome.id.clone()), undoes: None };
                let request = items.iter().find(|item| item.id == outcome.id && item.kind == outcome.kind);
                let action = if request.is_none_or(|item| item.stored) { "store" } else { "unstore" };
                let done: Result<(), String> = match &outcome.error {
                    Some(err) => Err(err.clone()),
                    None => Ok(()),
                };
                note.action("queueObject", action, serde_json::to_value(outcome.kind).ok().and_then(|v| v.as_str().map(str::to_string)), &done);
            }
        }
        Err(_) => Note { sink: sink.as_ref(), domain: Some(server.clone()), name: None, undoes: None }
            .action("queueObject", "store", None, &result),
    }
    result
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
async fn api_module_action(app: AppHandle, connection: Connection, module: String, action: String) -> Result<(), String> {
    let result = fesb_ops::module_action(&connection, &module, &action).await;
    let sink = journal_sink(&app, &connection, &None, "modules");
    Note { sink: sink.as_ref(), name: Some(module), ..Note::default() }.action("module", &action, None, &result);
    result
}

/// Запуск, остановка или перезапуск домена.
#[tauri::command]
async fn api_domain_action(
    app: AppHandle,
    connection: Connection,
    guid: String,
    action: String,
    journal: Option<JournalNote>,
) -> Result<DomainActionResult, String> {
    let result = fesb_ops::domain_action(&connection, &guid, &action).await;
    let sink = journal_sink(&app, &connection, &journal, "domains");
    let mut note = note_for(&sink, &journal);
    note.name = note.name.or_else(|| note.domain.take()).or(Some(guid));
    note.action("domain", &action, None, &result);
    result
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

/// Отчёт по внешним точкам входа и выхода всех СОПС сервера.
#[tauri::command]
async fn api_endpoint_report(
    app: AppHandle,
    connection: Connection,
) -> Result<Vec<api_report::Endpoint>, String> {
    fesb_api::endpoint_report(&connection, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Все СОПС сервера одним списком, вместе с их трассировкой.
#[tauri::command]
async fn api_routes_overview(connection: Connection) -> Result<Vec<routes_overview::RouteSummary>, String> {
    routes_overview::routes_overview(&connection).await
}

/// Роли, права и открытые сеансы: кто что может делать на сервере.
#[tauri::command]
async fn api_access(connection: Connection) -> Result<security::AccessReport, String> {
    security::access(&connection).await
}

/// Состояние сервера: время работы, память, процессор и диски.
#[tauri::command]
async fn api_server_usage(connection: Connection) -> Result<analytics::ServerUsage, String> {
    analytics::server_usage(&connection).await
}

/// Обмены, которые шина ещё не довела до конца.
#[tauri::command]
async fn api_inflight(connection: Connection) -> Result<Vec<analytics::InflightExchange>, String> {
    analytics::inflight_exchanges(&connection).await
}

/// Сертификаты из хранилищ ключей и доверенных хранилищ шины.
#[tauri::command]
async fn api_certificates(connection: Connection) -> Result<certificates::CertificateReport, String> {
    certificates::certificates(&connection).await
}

/// Каталог, в котором лежит история отчётов.
///
/// Временная папка для этого не годится: систему чистят, а полторы минуты
/// сборки терять на этом нельзя. Данные приложения переживают и перезапуск,
/// и уборку.
fn reports_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Cannot find the data folder: {err}"))?;
    Ok(base.join("reports"))
}

// Команды ниже объявлены async не ради ожидания внутри — там его нет, —
// а чтобы Tauri не выполнял их в потоке окна: запись отчёта на тысячи
// строк и сжатие листа Excel замораживали интерфейс на всё время работы.

/// История собранных отчётов: когда, по какому серверу и сколько точек.
#[tauri::command]
async fn report_history(app: AppHandle) -> Result<Vec<report_store::ReportEntry>, String> {
    Ok(report_store::list(&reports_dir(&app)?))
}

/// Кладёт собранный отчёт в историю.
#[tauri::command]
async fn save_report_history(
    app: AppHandle,
    server: String,
    built_at: String,
    endpoints: Vec<api_report::Endpoint>,
) -> Result<Vec<report_store::ReportEntry>, String> {
    report_store::save(&reports_dir(&app)?, &server, &built_at, &endpoints)
}

/// Открывает отчёт из истории.
#[tauri::command]
async fn read_report_history(app: AppHandle, id: String) -> Result<report_store::StoredReport, String> {
    report_store::read(&reports_dir(&app)?, &id)
}

/// Убирает отчёт из истории вместе с файлом.
#[tauri::command]
async fn delete_report_history(app: AppHandle, id: String) -> Result<Vec<report_store::ReportEntry>, String> {
    report_store::remove(&reports_dir(&app)?, &id)
}

/// Сохраняет готовый отчёт файлом Excel.
///
/// Шапка приходит с фронтенда: там она уже переведена, и дублировать словарь
/// в Rust ради одного файла незачем.
#[tauri::command]
async fn save_report(path: String, sheet: String, headers: Vec<String>, rows: Vec<Vec<String>>) -> Result<(), String> {
    xlsx::write_sheet(std::path::Path::new(&path), &sheet, &headers, &rows)
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
    app: AppHandle,
    connection: Connection,
    domain: String,
    route: String,
    action: String,
    journal: Option<JournalNote>,
) -> Result<(), String> {
    let result = fesb_ops::route_action(&connection, &domain, &route, &action).await;
    let sink = journal_sink(&app, &connection, &journal, "routes");
    let mut note = note_for(&sink, &journal);
    note.name = note.name.or(Some(route));
    note.action("route", &action, None, &result);
    result
}

/// Трассировка одного СОПС. Приложение зовёт по одному СОПС за раз:
/// так видно движение и можно остановиться посередине.
#[tauri::command]
async fn api_route_trace(
    app: AppHandle,
    connection: Connection,
    domain: String,
    route: String,
    change: route_trace::RouteTraceChange,
    journal: Option<JournalNote>,
) -> Result<route_trace::RouteTraceResult, String> {
    let sink = journal_sink(&app, &connection, &journal, "routeTrace");
    journal_ops::set_route_trace(&connection, &domain, &route, &change, None, &note_for(&sink, &journal)).await
}

#[tauri::command]
async fn api_domain_trace_beans(
    connection: Connection,
    guids: Vec<String>,
) -> Result<Vec<fesb_api::DomainTraceBeans>, String> {
    fesb_api::domain_trace_beans(&connection, &guids).await
}

#[tauri::command]
async fn api_save_points(connection: Connection) -> Result<Vec<SavePoint>, String> {
    fesb_ops::save_points(&connection).await
}

#[tauri::command]
async fn api_create_save_point(app: AppHandle, connection: Connection) -> Result<(), String> {
    let result = fesb_ops::create_save_point(&connection).await;
    let sink = journal_sink(&app, &connection, &None, "savePoints");
    Note { sink: sink.as_ref(), ..Note::default() }.action("savePoint", "create", None, &result);
    result
}

#[tauri::command]
async fn api_delete_save_point(app: AppHandle, connection: Connection, point: SavePoint) -> Result<(), String> {
    let name = point.filename.clone();
    let result = fesb_ops::delete_save_point(&connection, point).await;
    let sink = journal_sink(&app, &connection, &None, "savePoints");
    Note { sink: sink.as_ref(), name: Some(name), ..Note::default() }.action("savePoint", "delete", None, &result);
    result
}

#[tauri::command]
async fn api_rollback_save_point(app: AppHandle, connection: Connection, point: SavePoint) -> Result<(), String> {
    let name = point.filename.clone();
    let result = fesb_ops::rollback_save_point(&connection, point).await;
    let sink = journal_sink(&app, &connection, &None, "savePoints");
    Note { sink: sink.as_ref(), name: Some(name), ..Note::default() }.action("savePoint", "rollback", None, &result);
    result
}

/// Менеджеры очередей всех трёх видов.
#[tauri::command]
async fn api_queue_managers(connection: Connection) -> Result<Vec<QueueManager>, String> {
    fesb_ops::queue_managers(&connection).await
}

/// Приёмники менеджеров QME стенда: куда можно подключиться по AMQP.
#[tauri::command]
async fn api_broker_endpoints(connection: Connection) -> Result<Vec<broker_access::BrokerEndpoint>, String> {
    broker_access::broker_endpoints(&connection).await
}

/// Доступ к брокеру для пользователя, под которым подключается раздел AMQP.
#[tauri::command]
async fn api_broker_access(
    connection: Connection,
    server: String,
    username: String,
    password: String,
) -> Result<broker_access::BrokerAccessReport, String> {
    broker_access::grant_broker_access(&connection, &server, &username, &password).await
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

/// Переотправка, перенос, копирование или удаление отмеченных сообщений.
#[tauri::command]
async fn api_queue_messages_action(
    app: AppHandle,
    connection: Connection,
    kind: ManagerKind,
    id: String,
    queue: String,
    ids: Vec<String>,
    action: fesb_ops::MessageAction,
) -> Result<fesb_ops::MessageActionResult, String> {
    let count = ids.len();
    let (verb, to) = match &action {
        fesb_ops::MessageAction::Retry => ("retry", None),
        fesb_ops::MessageAction::Move { to } => ("move", Some(to.clone())),
        fesb_ops::MessageAction::Copy { to } => ("copy", Some(to.clone())),
        fesb_ops::MessageAction::Delete => ("delete", None),
    };
    let result = fesb_ops::queue_messages_action(&connection, kind, &id, &queue, ids, action).await;
    let sink = journal_sink(&app, &connection, &None, "messages");
    let manager = serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_uppercase)).unwrap_or_default();
    let detail = match to {
        Some(to) => format!("{count} → {to}"),
        None => count.to_string(),
    };
    Note { sink: sink.as_ref(), domain: Some(format!("{manager}:{id}")), name: Some(queue), undoes: None }
        .action("messages", verb, Some(detail), &result);
    result
}

/// Поиск обмена по бизнес-ключу: журналы, незавершённые обмены и очереди.
#[tauri::command]
async fn api_find_key(app: AppHandle, connection: Connection, key: String, full: bool) -> Result<key_trace::KeyTrace, String> {
    // `full` — дочитать очереди целиком, даже большие: человек сам решил ждать.
    let limit = if full { u64::MAX } else { queue_dump::DEFAULT_LIMIT };
    key_trace::find_key(&connection, &key, limit, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Поиск по всем сообщениям очереди через её выгрузку — одним запросом.
///
/// Ход приходит скачанными байтами; событие — не на каждый кусок сети, а раз
/// в четверть мегабайта, иначе их были бы тысячи.
#[tauri::command]
async fn api_queue_scan(
    app: AppHandle,
    connection: Connection,
    kind: ManagerKind,
    id: String,
    queue: String,
    needle: String,
    full: bool,
) -> Result<queue_dump::DumpScan, String> {
    const STEP: u64 = 256 * 1024;
    let limit = if full { u64::MAX } else { queue_dump::DEFAULT_LIMIT };
    let mut reported = 0u64;
    queue_dump::scan_queue(&connection, kind, &id, &queue, &needle, limit, |done, total| {
        if done >= reported + STEP || Some(done) == total {
            reported = done;
            let _ = app.emit(API_PROGRESS_EVENT, ApiProgress { phase: "download", current: done, total: total.unwrap_or(0) });
        }
    })
    .await
}

/// Поиск текста в телах сообщений очереди.
///
/// Тела в списке нет, поэтому каждое сообщение приходится забрать отдельно;
/// прогресс идёт теми же событиями, что у выгрузки доменов.
#[tauri::command]
async fn api_queue_search(
    app: AppHandle,
    connection: Connection,
    kind: ManagerKind,
    id: String,
    queue: String,
    ids: Vec<String>,
    needle: String,
) -> Result<Vec<fesb_ops::QueueMatch>, String> {
    fesb_ops::queue_search(&connection, kind, &id, &queue, ids, &needle, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Константы приложения, брокера или домена.
#[tauri::command]
async fn api_properties(connection: Connection, scope: PropertyScope) -> Result<Vec<PropertyRow>, String> {
    fesb_ops::properties(&connection, scope).await
}

/// Чем один стенд отличается от другого: домены, СОПС, константы.
#[tauri::command]
async fn api_compare_stands(
    left: Connection,
    right: Connection,
) -> Result<compare::Comparison, String> {
    compare::compare(&left, &right).await
}

/// Каталог снимков стендов — рядом с историей отчётов, в данных приложения.
fn snapshots_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Cannot find the data folder: {err}"))?;
    Ok(base.join("snapshots"))
}

/// Копия настроек интерфейса на диске — на случай, если хранилище WebView пропадёт.
#[tauri::command]
fn settings_read(app: AppHandle) -> Result<std::collections::BTreeMap<String, String>, String> {
    Ok(settings_store::read(&settings_dir(&app)?))
}

#[tauri::command]
fn settings_write(app: AppHandle, key: String, value: Option<String>) -> Result<(), String> {
    settings_store::write(&settings_dir(&app)?, &key, value.as_deref())
}

/// Конфигурационная часть отчёта о стенде: описания, точки и связи СОПС.
#[tauri::command]
async fn api_passport_walk(app: AppHandle, connection: Connection) -> Result<stand_passport::PassportWalk, String> {
    stand_passport::walk(&connection, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Книга Excel из нескольких листов — для отчёта о стенде.
#[tauri::command]
async fn save_workbook(path: String, sheets: Vec<xlsx::Sheet>) -> Result<(), String> {
    xlsx::write_book(std::path::Path::new(&path), &sheets)
}

/// Список стендов в файл — путь выбран человеком в окне сохранения.
#[tauri::command]
async fn stands_file_write(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|err| format!("Cannot write {path}: {err}"))
}

/// Список стендов из файла. Больше мегабайта такой файл не бывает —
/// значит, выбран не тот, и читать его в память незачем.
#[tauri::command]
async fn stands_file_read(path: String) -> Result<String, String> {
    const LIMIT: u64 = 1024 * 1024;
    let size = std::fs::metadata(&path).map_err(|err| format!("Cannot read {path}: {err}"))?.len();
    if size > LIMIT {
        return Err(format!("{path} is too large for a list of stands"));
    }
    std::fs::read_to_string(&path).map_err(|err| format!("Cannot read {path}: {err}"))
}

fn settings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("Cannot find the data folder: {err}"))
}

/// Снимки всех стендов, свежие сверху. Интерфейс сам оставляет снимки своего.
#[tauri::command]
async fn snapshot_list(app: AppHandle) -> Result<Vec<snapshot_store::SnapshotEntry>, String> {
    Ok(snapshot_store::list(&snapshots_dir(&app)?))
}

/// Снимает стенд: тот же слепок, что и для сравнения, только на диск.
#[tauri::command]
async fn snapshot_take(
    app: AppHandle,
    connection: Connection,
    taken_at: String,
    label: String,
) -> Result<Vec<snapshot_store::SnapshotEntry>, String> {
    let profile = compare::read_profile(&connection).await?;
    snapshot_store::save(&snapshots_dir(&app)?, &taken_at, &label, profile)
}

#[tauri::command]
async fn snapshot_delete(app: AppHandle, id: String) -> Result<Vec<snapshot_store::SnapshotEntry>, String> {
    snapshot_store::remove(&snapshots_dir(&app)?, &id)
}

/// Что поменялось: снимок «до» против другого снимка или против стенда сейчас.
#[tauri::command]
async fn snapshot_compare(
    app: AppHandle,
    before: String,
    after: Option<String>,
    connection: Option<Connection>,
) -> Result<compare::Comparison, String> {
    let dir = snapshots_dir(&app)?;
    let old = snapshot_store::read(&dir, &before)?.profile;
    let new = match (after, connection) {
        (Some(id), _) => snapshot_store::read(&dir, &id)?.profile,
        (None, Some(connection)) => compare::read_profile(&connection).await?,
        (None, None) => return Err("Nothing to compare the snapshot with".into()),
    };
    Ok(compare::diff(&old, &new))
}

/// Константы всех уровней разом — чтобы искать по значению на всём стенде.
#[tauri::command]
async fn api_properties_sweep(
    app: AppHandle,
    connection: Connection,
) -> Result<Vec<fesb_ops::SweepRow>, String> {
    fesb_ops::properties_sweep(&connection, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

#[tauri::command]
async fn api_save_property(
    app: AppHandle,
    connection: Connection,
    scope: PropertyScope,
    property: PropertyRow,
    create: bool,
    comment: Option<String>,
    journal: Option<JournalNote>,
) -> Result<(), String> {
    let sink = journal_sink(&app, &connection, &journal, "constants");
    journal_ops::save_constant(&connection, scope, property, create, comment, &note_for(&sink, &journal)).await
}

#[tauri::command]
async fn api_delete_property(
    app: AppHandle,
    connection: Connection,
    scope: PropertyScope,
    key: String,
    journal: Option<JournalNote>,
) -> Result<(), String> {
    let sink = journal_sink(&app, &connection, &journal, "constants");
    journal_ops::delete_constant(&connection, scope, &key, &note_for(&sink, &journal)).await
}

/// Заводит запись журнала под массовую операцию.
#[tauri::command]
fn journal_open(app: AppHandle, connection: Connection, origin: String) -> Result<String, String> {
    journal_ops::open_entry(&journal_dir(&app)?, &connection, &origin).map(|sink| sink.entry)
}

/// Записи журнала по стенду, свежие сверху.
#[tauri::command]
async fn journal_list(app: AppHandle, connection: Connection) -> Result<Vec<change_journal::EntrySummary>, String> {
    Ok(change_journal::list(&journal_dir(&app)?, &connection.base()))
}

#[tauri::command]
async fn journal_read(app: AppHandle, id: String) -> Result<change_journal::Entry, String> {
    change_journal::read(&journal_dir(&app)?, &id)
}

/// Что из записи можно вернуть и что на сервере сейчас.
#[tauri::command]
async fn journal_undo_plan(app: AppHandle, connection: Connection, id: String) -> Result<journal_ops::UndoPlan, String> {
    journal_ops::plan(&connection, &journal_dir(&app)?, &id).await
}

/// Возвращает выбранные изменения записи.
#[tauri::command]
async fn journal_undo_run(
    app: AppHandle,
    connection: Connection,
    id: String,
    indexes: Vec<usize>,
) -> Result<journal_ops::UndoResult, String> {
    let dir = journal_dir(&app)?;
    journal_ops::run(&connection, &dir, &id, &indexes, |progress| {
        let _ = app.emit(API_PROGRESS_EVENT, progress);
    })
    .await
}

/// Список файлов журналов сервера.
#[tauri::command]
async fn api_log_files(connection: Connection) -> Result<Vec<LogFileRow>, String> {
    fesb_ops::log_files(&connection).await
}

/// Журнал аудита: кто и что делал на стенде.
#[tauri::command]
async fn api_audit(connection: Connection, request: LogRequest) -> Result<Vec<AuditEntry>, String> {
    fesb_ops::audit(&connection, request).await
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Уведомления нужны разделу AMQP: он сообщает о пришедшем сообщении,
        // когда окно свёрнуто.
        .plugin(tauri_plugin_notification::init())
        // Состояние раздела AMQP: открытое соединение с брокером, живые
        // подписчики и история отправок. Живёт рядом с состоянием шины
        // и ничего о ней не знает.
        .manage(amqpush::AppState::new())
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
            api_copy_plan,
            api_copy_run,
            api_mq_config,
            api_mq_store,
            api_verify,
            api_restart_module,
            api_modules,
            api_module_action,
            api_domain_action,
            api_domain_statistics,
            api_domain_routes,
            api_endpoint_report,
            api_certificates,
            api_server_usage,
            api_access,
            api_routes_overview,
            api_inflight,
            save_report,
            report_history,
            save_report_history,
            read_report_history,
            delete_report_history,
            api_route_state,
            api_route_action,
            api_route_trace,
            api_domain_trace_beans,
            api_save_points,
            api_create_save_point,
            api_delete_save_point,
            api_rollback_save_point,
            api_queue_managers,
            api_broker_endpoints,
            api_broker_access,
            api_queues,
            api_queue_messages,
            api_queue_message,
            api_queue_messages_action,
            api_find_key,
            api_queue_scan,
            api_queue_search,
            api_properties,
            api_properties_sweep,
            api_compare_stands,
            settings_read,
            settings_write,
            stands_file_read,
            stands_file_write,
            snapshot_list,
            snapshot_take,
            snapshot_delete,
            snapshot_compare,
            api_save_property,
            api_delete_property,
            journal_open,
            journal_list,
            journal_read,
            journal_undo_plan,
            journal_undo_run,
            api_passport_walk,
            save_workbook,
            api_log_files,
            api_log,
            api_audit,
            // ── раздел AMQP: перенесённый движок AMQPush ──────────────────
            amqpush::connect,
            amqpush::disconnect,
            amqpush::connection_info,
            amqpush::send_message,
            amqpush::start_subscriber,
            amqpush::stop_subscriber,
            amqpush::list_subscribers,
            amqpush::get_history,
            amqpush::clear_history,
            amqpush::get_saved_queues,
            amqpush::save_queue,
            amqpush::delete_queue,
            amqpush::verify_queue,
            amqpush::get_templates,
            amqpush::save_template,
            amqpush::delete_template,
            amqpush::rename_template,
            amqpush::list_recordings,
            amqpush::get_recording,
            amqpush::save_recording,
            amqpush::delete_recording,
            amqpush::play_recording,
            amqpush::shovel_open_target,
            amqpush::shovel_send_to_target,
            amqpush::shovel_close_target,
            amqpush::export_history,
            amqpush::await_reply,
            amqpush::list_broker_queues,
            amqpush::peek_messages,
            amqpush::purge_queue,
            amqpush::remove_messages_by_ids,
            amqpush::ping_broker,
            amqpush::probe_broker,
            amqpush::list_broker_connections,
            amqpush::list_broker_consumers,
            amqpush::fetch_broker_connections_raw,
            amqpush::fetch_broker_consumers_raw
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the application");
}

/// Реэкспорт внутренностей для интеграционных тестов.
#[doc(hidden)]
pub mod testing {
    pub use crate::applier::{apply_trace_change, ApplyRequest, ApplyTarget};
    pub use crate::fesb_api::{connect, domains, pull, push, verify, Connection};
    pub use crate::fesb_api::{endpoint_report, fetch_domain_routes};
    pub use crate::certificates::{certificates, common_name, read_certificate};
    pub use crate::analytics::{inflight_exchanges, server_usage};
    pub use crate::api_report::{endpoints_of_domain, listening_ports, server_queue_manager};
    pub use crate::security::access;
    pub use crate::routes_overview::routes_overview;
    pub use crate::route_trace::{set_route_trace, RouteTraceChange};
    pub use crate::change_journal::{list as journal_list, open as journal_open, read as journal_read, Change, Sink};
    pub use crate::journal_ops::{
        open_entry as journal_entry, plan as undo_plan, push as journaled_push, run as undo_run, save_constant,
        set_route_trace as journaled_route_trace, Note, UndoPlan,
    };
    pub use crate::fesb_ops::{delete_domain, domain_action};
    pub use crate::stand_passport::walk as passport_walk;
    pub use crate::xlsx::{write_book, Sheet};
    pub use crate::fesb_api::domain_trace_beans;
    pub use crate::fesb_ops::{
        delete_property, domain_statistics, log_entries, log_files, modules, properties, properties_sweep,
        audit, queue_managers, queue_message, queue_messages, queue_search, queues, route_state,
        save_property,
        LogRequest, ManagerKind, PropertyRow,
        PropertyScope,
    };
    pub use crate::archive::create_archive;
    pub use crate::domain_copy::{plan as copy_plan, run as copy_run, RouteChange};
    pub use crate::mq_config::{audit as mq_config_audit, store as mq_store, ConfigKind, StoreRequest};
    pub use crate::xlsx::write_sheet as write_xlsx;
    pub use crate::compare::{diff as compare_profiles, read_profile, Side};
    pub use crate::key_trace::{find_key, KeyTrace};
    pub use crate::snapshot_store::{list as snapshot_list, read as read_snapshot, save as save_snapshot};
    pub use crate::report_store::{list as report_history, read as read_report, remove as remove_report, save as save_report_history};
    pub use crate::domain_xml::{parse_domain_xml, BeanTarget, TraceUpdate};
    pub use crate::route_graph::{parse_route_graphs, RouteNode};
    pub use crate::route_links::build_links;
    pub use crate::scanner::scan_root;
    // Проверка брокера: живой стенд нужен и ей, поэтому она рядом с остальными.
    pub use crate::broker_access::{broker_endpoints, grant_broker_access, BrokerEndpoint};
    pub use crate::amqpush::{probe_broker, BrokerProbe};
    pub use crate::amqpush::amqp::{AmqpClient, ClientCert, TransportOpts};
    pub use crate::amqpush::profiles::Profile as BrokerProfile;
}
