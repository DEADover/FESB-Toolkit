//! Разделы шины, которые читаются и правятся напрямую через API:
//! модули, менеджеры очередей, константы и журналы.
//!
//! В отличие от трассировки, у всего этого есть нормальные методы, так что
//! возить конфигурацию через архивы не нужно — работаем с сервером как есть.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fesb_api::{ensure_ok, transport_error, ApiProgress, Connection};

/// Достаёт число из поля, как бы оно ни называлось в конкретном модуле.
fn number(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| value.get(*key).and_then(Value::as_i64))
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(String::from)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

// ───────────────────────────── модули ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRow {
    pub name: String,
    pub label: String,
    /// Модуль включён в конфигурации — то есть должен работать.
    pub active: bool,
    pub running: bool,
    pub warning: bool,
    /// Конфигурация изменилась, но модуль ещё работает со старой.
    pub await_restart: bool,
    pub await_system_restart: bool,
    pub dependencies: Vec<String>,
}

/// Список модулей вместе с их текущим состоянием.
///
/// Состав модулей и их состояние живут в разных методах: первый знает
/// зависимости и названия, второй — предупреждения и «ждёт перезапуска».
pub async fn modules(connection: &Connection) -> Result<Vec<ModuleRow>, String> {
    let client = connection.client()?;

    let response = connection
        .get(&client, "/api/module/info")
        .send()
        .await
        .map_err(transport_error)?;
    let info: Vec<Value> = ensure_ok(response, "Cannot read modules")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;

    // Состояние может быть недоступно — тогда обходимся тем, что знаем.
    let statuses: Value = match connection.get(&client, "/api/modules/status").send().await {
        Ok(response) => match ensure_ok(response, "Cannot read module status").await {
            Ok(body) => body.json().await.unwrap_or(Value::Null),
            Err(_) => Value::Null,
        },
        Err(_) => Value::Null,
    };
    let statuses = statuses.get("statuses").cloned().unwrap_or(Value::Null);

    Ok(info
        .into_iter()
        .map(|item| {
            let name = text(&item, "name").unwrap_or_default();
            let status = statuses.get(&name);
            ModuleRow {
                label: text(&item, "label").unwrap_or_else(|| name.clone()),
                active: flag(&item, "active"),
                running: status.map_or_else(|| flag(&item, "running"), |value| flag(value, "running")),
                warning: status.is_some_and(|value| flag(value, "warning")),
                await_restart: status.is_some_and(|value| flag(value, "awaitRestart")),
                await_system_restart: status.is_some_and(|value| flag(value, "awaitSystemRestart")),
                dependencies: item
                    .get("dependencies")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default(),
                name,
            }
        })
        .collect())
}

/// Запуск, остановка или перезапуск модуля.
pub async fn module_action(connection: &Connection, module: &str, action: &str) -> Result<(), String> {
    if !matches!(action, "start" | "stop" | "restart") {
        return Err(format!("Unknown module action: {action}"));
    }
    let client = connection.client()?;
    let response = connection
        .post(&client, &format!("/api/module/{module}/{action}"))
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Module action failed").await?;
    Ok(())
}

// ───────────────────────────── домены ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainActionResult {
    pub guid: String,
    pub action: String,
    /// Шина ответила согласием. Отказ приходит телом `false` при HTTP 200.
    pub done: bool,
}

/// Запуск, остановка или перезапуск домена.
///
/// Отдельный случай, ради которого и заведён результат: домен может не
/// подняться из-за собственной конфигурации — например, у СОПС не оказалось
/// нужного компонента, — и тогда сервер отвечает `200 false`, а причина
/// остаётся в `broker.log`. Молча считать это успехом нельзя.
pub async fn domain_action(
    connection: &Connection,
    guid: &str,
    action: &str,
) -> Result<DomainActionResult, String> {
    if !matches!(action, "start" | "stop" | "restart") {
        return Err(format!("Unknown domain action: {action}"));
    }
    let client = connection.client()?;
    let response = connection
        .post(&client, &format!("/api/domain/{guid}/{action}"))
        .query(&[("timeout", "120")])
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(transport_error)?;

    let body = ensure_ok(response, "Domain action failed")
        .await?
        .text()
        .await
        .unwrap_or_default();

    Ok(DomainActionResult {
        guid: guid.to_string(),
        action: action.to_string(),
        // Пустое тело считаем согласием: отказ шина проговаривает явным false.
        done: body.trim() != "false",
    })
}

// ───────────────────────── менеджеры очередей ─────────────────────────

/// Префикс, с которым менеджер пишется в значении `broker` объекта трассировки.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManagerKind {
    #[serde(rename = "QMS")]
    Qms,
    #[serde(rename = "QME")]
    Qme,
    #[serde(rename = "RQMS")]
    Rqms,
}

impl ManagerKind {
    fn prefix(self) -> &'static str {
        match self {
            ManagerKind::Qms => "QMS",
            ManagerKind::Qme => "QME",
            ManagerKind::Rqms => "RQMS",
        }
    }

    fn list_path(self) -> &'static str {
        match self {
            ManagerKind::Qms => "/api/qms/brokers",
            ManagerKind::Qme => "/api/qme/servers",
            ManagerKind::Rqms => "/api/rqms/remotes",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueManager {
    pub kind: ManagerKind,
    pub id: String,
    /// То, что пишется в property `broker`: например `QME:EQM_MON`.
    pub broker: String,
    pub status: String,
    pub running: bool,
    /// Менеджер должен подниматься при старте шины.
    pub auto_start: bool,
}

/// Все менеджеры очередей сервера: мультименеджер, расширенные и удалённые.
///
/// Раздел, который не отвечает, просто пропускается: на стенде без удалённых
/// менеджеров `/api/rqms/remotes` возвращает пустой список, а на сборках без
/// модуля — ошибку, и ронять из-за этого весь экран незачем.
pub async fn queue_managers(connection: &Connection) -> Result<Vec<QueueManager>, String> {
    let client = connection.client()?;
    let mut managers = Vec::new();
    let mut failures = Vec::new();

    for kind in [ManagerKind::Qms, ManagerKind::Qme, ManagerKind::Rqms] {
        let list: Result<Vec<Value>, String> = async {
            let response = connection
                .get(&client, kind.list_path())
                .send()
                .await
                .map_err(transport_error)?;
            ensure_ok(response, "Cannot read queue managers")
                .await?
                .json()
                .await
                .map_err(|err| format!("Unexpected answer: {err}"))
        }
        .await;

        match list {
            Ok(items) => {
                for item in items {
                    let Some(id) = text(&item, "id") else { continue };
                    let status = text(&item, "status").unwrap_or_else(|| "UNKNOWN".into());
                    managers.push(QueueManager {
                        broker: format!("{}:{id}", kind.prefix()),
                        running: matches!(status.as_str(), "RUNNING" | "STARTED"),
                        auto_start: flag(&item, "start"),
                        kind,
                        id,
                        status,
                    });
                }
            }
            Err(error) => failures.push(format!("{}: {error}", kind.prefix())),
        }
    }

    if managers.is_empty() && !failures.is_empty() {
        return Err(failures.join("; "));
    }
    Ok(managers)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueRow {
    pub name: String,
    pub address: Option<String>,
    pub messages: i64,
    pub consumers: i64,
    pub producers: Option<i64>,
    pub enqueued: Option<i64>,
    pub dequeued: Option<i64>,
    /// Служебная очередь самого менеджера — её обычно скрывают.
    pub internal: bool,
    pub paused: bool,
    pub durable: bool,
}

/// Очереди одного менеджера.
///
/// Поля у мультименеджера и расширенных менеджеров называются по-разному
/// (`queueSize` против `messageCount`), поэтому читаем оба варианта.
pub async fn queues(connection: &Connection, kind: ManagerKind, id: &str) -> Result<Vec<QueueRow>, String> {
    let client = connection.client()?;
    let path = match kind {
        ManagerKind::Qms => format!("/api/qms/brokers/{id}/queues"),
        ManagerKind::Qme => format!("/api/qme/servers/{id}/queues"),
        ManagerKind::Rqms => format!("/api/rqms/brokers/{id}/queues"),
    };

    let mut request = connection.get(&client, &path).timeout(Duration::from_secs(120));
    if kind == ManagerKind::Qme {
        // У расширенных менеджеров фильтр обязателен, пустой означает «всё».
        request = request.query(&[("filter", "")]);
    }

    let response = request.send().await.map_err(transport_error)?;
    let items: Vec<Value> = ensure_ok(response, "Cannot read queues")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;

    Ok(items
        .into_iter()
        .filter_map(|item| {
            Some(QueueRow {
                name: text(&item, "name")?,
                address: text(&item, "address"),
                messages: number(&item, &["messageCount", "queueSize"]).unwrap_or(0),
                consumers: number(&item, &["consumerCount"]).unwrap_or(0),
                producers: number(&item, &["producerCount"]),
                enqueued: number(&item, &["messagesAdded", "enqueueCount"]),
                dequeued: number(&item, &["messagesAcknowledged", "dequeueCount"]),
                internal: flag(&item, "internalQueue"),
                paused: flag(&item, "paused"),
                durable: flag(&item, "durable"),
            })
        })
        .collect())
}

// ───────────────────────────── константы ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRow {
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub secured: bool,
    #[serde(default)]
    pub vault: bool,
    #[serde(default)]
    pub empty: bool,
    #[serde(default)]
    pub description: Option<String>,
}

/// Где живут константы: у приложения, у брокера или у конкретного домена.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropertyScope {
    Application,
    Broker,
    /// Значение — guid домена: по имени сервер константы не находит.
    Domain(String),
}

impl PropertyScope {
    fn list_path(&self) -> String {
        match self {
            PropertyScope::Application => "/api/properties/application".into(),
            PropertyScope::Broker => "/api/properties/broker".into(),
            PropertyScope::Domain(guid) => format!("/api/properties/{guid}/properties"),
        }
    }

    fn item_path(&self, key: &str) -> String {
        match self {
            PropertyScope::Application => format!("/api/properties/application/property/{key}"),
            PropertyScope::Broker => format!("/api/properties/broker/property/{key}"),
            PropertyScope::Domain(guid) => format!("/api/properties/domain/{guid}/property/{key}"),
        }
    }

    fn create_path(&self) -> String {
        match self {
            PropertyScope::Application => "/api/properties/application/property".into(),
            PropertyScope::Broker => "/api/properties/broker/property".into(),
            PropertyScope::Domain(guid) => format!("/api/properties/domain/{guid}/property"),
        }
    }
}

pub async fn properties(connection: &Connection, scope: PropertyScope) -> Result<Vec<PropertyRow>, String> {
    let client = connection.client()?;
    let response = connection
        .get(&client, &scope.list_path())
        .send()
        .await
        .map_err(transport_error)?;
    let mut rows: Vec<PropertyRow> = ensure_ok(response, "Cannot read constants")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;
    rows.sort_by(|a, b| a.key.to_lowercase().cmp(&b.key.to_lowercase()));
    Ok(rows)
}

/// Приводит флаг пустоты к значению, которое пишем.
///
/// Пустоту шина решает по флагу, а не по значению: с `empty: true` она
/// отвечает `200` и оставляет константу пустой, что бы ни лежало в `value`.
/// Флаг приходит из чтения, поэтому правка ранее пустой константы молча
/// не доезжала — сервер отвечал успехом, а значение не менялось. Считаем
/// его сами, ровно так же, как считает сама шина при создании.
fn with_empty_flag(mut property: PropertyRow) -> PropertyRow {
    property.empty = property.value.as_deref().unwrap_or_default().is_empty();
    property
}

/// Сохраняет одну константу: новую создаёт, существующую переписывает.
pub async fn save_property(
    connection: &Connection,
    scope: PropertyScope,
    property: PropertyRow,
    create: bool,
    comment: Option<String>,
) -> Result<(), String> {
    if property.key.trim().is_empty() {
        return Err("The constant needs a name".into());
    }
    let property = with_empty_flag(property);
    let client = connection.client()?;
    let body = serde_json::json!({
        "comment": comment.unwrap_or_else(|| "FESB Toolkit".into()),
        "data": property,
    });

    let request = if create {
        connection.post(&client, &scope.create_path())
    } else {
        connection.put(&client, &scope.item_path(&property.key))
    };

    let response = request.json(&body).send().await.map_err(transport_error)?;
    ensure_ok(response, "Cannot save the constant").await?;
    Ok(())
}

/// Сколько доменов опрашивается одновременно.
///
/// Константы мелкие: на стенде из 256 доменов их всего сто восемьдесят две,
/// и всё время уходит не на разбор, а на ход до сервера. Восемь запросов
/// разом превращают четверть тысячи ходов в тридцать.
const SWEEP_CONCURRENCY: usize = 8;

/// Константа вместе с тем, где она лежит.
///
/// Плоский список на весь стенд нужен, чтобы искать по значению: вопрос
/// «кто смотрит на старый хост» не привязан ни к какому домену заранее.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepRow {
    /// `application`, `broker` или guid домена — то же, чем адресуется правка.
    pub scope: String,
    /// Имя домена: guid в таблице читать невозможно.
    pub domain: Option<String>,
    #[serde(flatten)]
    pub property: PropertyRow,
}

/// Читает константы всех трёх уровней разом.
///
/// Уровни приложения и брокера идут первыми и всегда: их немного, а
/// подставляются они в те же СОПС, что и доменные, — искать старый адрес
/// только по доменам значит не найти его там, где он задан один раз на всех.
pub async fn properties_sweep<F: FnMut(ApiProgress)>(
    connection: &Connection,
    mut on_progress: F,
) -> Result<Vec<SweepRow>, String> {
    let domains = crate::fesb_api::domains(connection).await?;
    let total = domains.len() as u64 + 2;
    let mut done = 0u64;
    let mut rows = Vec::new();
    on_progress(ApiProgress { phase: "constants", current: 0, total });

    for (scope, name) in [(PropertyScope::Application, "application"), (PropertyScope::Broker, "broker")] {
        for property in properties(connection, scope).await? {
            rows.push(SweepRow { scope: name.to_string(), domain: None, property });
        }
        done += 1;
    }
    on_progress(ApiProgress { phase: "constants", current: done, total });

    for group in domains.chunks(SWEEP_CONCURRENCY) {
        let mut running = Vec::with_capacity(group.len());
        for domain in group {
            let connection = connection.clone();
            let guid = domain.guid.clone();
            let name = domain.name.clone();
            running.push(tauri::async_runtime::spawn(async move {
                let found = properties(&connection, PropertyScope::Domain(guid.clone())).await;
                (guid, name, found)
            }));
        }

        for handle in running {
            let (guid, name, found) = handle.await.map_err(|err| format!("Reading interrupted: {err}"))?;
            done += 1;
            // Домен, который не прочитался, не роняет обход: его могли
            // удалить, пока мы шли по списку, — важнее показать остальные.
            for property in found.unwrap_or_default() {
                rows.push(SweepRow { scope: guid.clone(), domain: Some(name.clone()), property });
            }
        }
        on_progress(ApiProgress { phase: "constants", current: done, total });
    }

    Ok(rows)
}

pub async fn delete_property(connection: &Connection, scope: PropertyScope, key: &str) -> Result<(), String> {
    let client = connection.client()?;
    let response = connection
        .delete(&client, &scope.item_path(key))
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Cannot delete the constant").await?;
    Ok(())
}

// ───────────────────────────── журналы ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileRow {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRequest {
    #[serde(default)]
    pub logs: Vec<String>,
    #[serde(default)]
    pub levels: Vec<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub thread: Option<String>,
    #[serde(default)]
    pub class_name: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

pub async fn log_files(connection: &Connection) -> Result<Vec<LogFileRow>, String> {
    let client = connection.client()?;
    let response = connection
        .get(&client, "/api/log/files")
        .send()
        .await
        .map_err(transport_error)?;
    let mut files: Vec<LogFileRow> = ensure_ok(response, "Cannot read the log list")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;
    // Пустые журналы внизу: смотреть в них нечего.
    files.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
    Ok(files)
}

/// Записи журнала, свежие сверху.
pub async fn log_entries(connection: &Connection, request: LogRequest) -> Result<Vec<LogEntry>, String> {
    let client = connection.client()?;
    // Сервер отдаёт максимум тысячу записей за раз.
    let limit = request.limit.unwrap_or(200).clamp(1, 1000);

    let mut call = connection
        .get(&client, "/api/log")
        .timeout(Duration::from_secs(120))
        .query(&[("limit", limit.to_string()), ("desc", "true".into())]);
    for log in &request.logs {
        call = call.query(&[("logs", log.as_str())]);
    }
    for level in &request.levels {
        call = call.query(&[("levels", level.as_str())]);
    }
    if let Some(search) = request.search.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        call = call.query(&[("search", search)]);
    }

    let response = call.send().await.map_err(transport_error)?;
    ensure_ok(response, "Cannot read the log")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_broker_value_the_way_domain_xml_writes_it() {
        assert_eq!(ManagerKind::Qme.prefix(), "QME");
        assert_eq!(ManagerKind::Qms.prefix(), "QMS");
    }

    #[test]
    fn reads_queue_counters_under_both_names() {
        // расширенный менеджер очередей
        let qme = serde_json::json!({ "name": "Mon.Trace", "messageCount": 12, "consumerCount": 1 });
        assert_eq!(number(&qme, &["messageCount", "queueSize"]), Some(12));
        // мультименеджер
        let qms = serde_json::json!({ "name": "Mon.Trace", "queueSize": 7, "consumerCount": 0 });
        assert_eq!(number(&qms, &["messageCount", "queueSize"]), Some(7));
    }

    /// Фронтенд присылает уровень как есть, поэтому форма ответа зафиксирована.
    const ACTION: &str = "Пользователь: root [ip=10.0.0.5], Действие: BROKER_DOMAINS_IMPORT \n\nАргументы: [domain-0001],null,true, \n\nРезультат: <200 OK OK,[Content-Type:\"application/json\"]>;";

    #[test]
    fn reads_who_did_what_from_the_audit_log() {
        let entry = parse_audit(Some("2026-08-27T00:06:10.488".into()), ACTION);
        assert_eq!(entry.kind, "action");
        assert_eq!(entry.user.as_deref(), Some("root"));
        assert_eq!(entry.ip.as_deref(), Some("10.0.0.5"));
        assert_eq!(entry.action.as_deref(), Some("BROKER_DOMAINS_IMPORT"));
        // Хвостовая запятая — часть разделителя, а не аргумент.
        assert_eq!(entry.arguments.as_deref(), Some("[domain-0001],null,true"));
        assert_eq!(entry.status, Some(200));
    }

    #[test]
    fn reads_session_events_too() {
        let text = "Закрытие сессии WebSessionInfo{ user=root, ip=10.0.0.5, created=2026-08-25T18:45:24.378, lastAccessed=2026-08-25T20:42:08.297}";
        let entry = parse_audit(None, text);
        assert_eq!(entry.kind, "session");
        assert_eq!(entry.user.as_deref(), Some("root"));
        assert_eq!(entry.ip.as_deref(), Some("10.0.0.5"));
        assert_eq!(entry.action.as_deref(), Some("Закрытие сессии"));

        // Анонимная сессия помечена прочерком — это не имя пользователя.
        let anonymous = parse_audit(None, "Закрытие сессии WebSessionInfo{ user=-, ip=10.0.0.1, created=x}");
        assert_eq!(anonymous.user, None);
        assert_eq!(anonymous.ip.as_deref(), Some("10.0.0.1"));
    }

    #[test]
    fn reads_logins_and_failed_attempts() {
        let ok = parse_audit(None, "Login: Local user - root [ip=10.0.0.5]");
        assert_eq!(ok.kind, "login");
        assert_eq!(ok.action.as_deref(), Some("Login"));
        assert_eq!(ok.user.as_deref(), Some("root"));
        assert_eq!(ok.ip.as_deref(), Some("10.0.0.5"));

        let failed = parse_audit(None, "Login failed: Bad credentials: user -  root [ip=10.0.0.5]");
        assert_eq!(failed.action.as_deref(), Some("Login failed"));
        assert_eq!(failed.user.as_deref(), Some("root"));
        assert_eq!(failed.ip.as_deref(), Some("10.0.0.5"));
    }

    #[test]
    fn keeps_a_line_it_does_not_understand() {
        let entry = parse_audit(None, "что-то своё");
        assert_eq!(entry.kind, "other");
        assert_eq!(entry.text, "что-то своё");
        assert!(entry.action.is_none());
    }

    #[test]
    fn survives_an_action_without_a_result() {
        // У асинхронных вызовов «Результат» в строку не попадает.
        let entry = parse_audit(None, "Пользователь: root [ip=1.2.3.4], Действие: MANAGER_MODULE_RESTART \n\nАргументы: [factor-broker], ");
        assert_eq!(entry.action.as_deref(), Some("MANAGER_MODULE_RESTART"));
        assert_eq!(entry.arguments.as_deref(), Some("[factor-broker]"));
        assert_eq!(entry.status, None);
    }

    #[test]
    fn decodes_the_message_body_the_bus_sends() {
        // именно так шина отдала «проверка просмотра сообщений»
        let encoded = "0L/RgNC+0LLQtdGA0LrQsCDQv9GA0L7RgdC80L7RgtGA0LAg0YHQvtC+0LHRidC10L3QuNC5";
        assert_eq!(decode_body(Some(encoded)).as_deref(), Some("проверка просмотра сообщений"));
        assert_eq!(decode_body(Some("")), None);
        assert_eq!(decode_body(None), None);
        // не UTF-8 — показывать нечего, но и падать не за что
        assert_eq!(decode_body(Some("//79")), None);
    }

    #[test]
    fn keeps_message_ids_usable_in_a_path() {
        assert_eq!(encode_segment("ID:host-1:1:0:0:1"), "ID:host-1:1:0:0:1");
        assert_eq!(encode_segment("Mon.Trace"), "Mon.Trace");
        assert_eq!(encode_segment("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn strips_the_wrapper_around_dates() {
        assert_eq!(
            clean_date(Some("/Date(2026-08-26T23:22:30.976)/".into())).as_deref(),
            Some("2026-08-26T23:22:30.976"),
        );
        assert_eq!(clean_date(Some("2026-08-26T23:22:30".into())).as_deref(), Some("2026-08-26T23:22:30"));
    }

    #[test]
    fn treats_a_false_body_as_a_refusal() {
        // Шина отвечает 200 и телом false, когда домен не смог подняться.
        assert!(!matches!("false".trim(), body if body != "false"));
        assert!(matches!("true".trim(), body if body != "false"));
        assert!(matches!("".trim(), body if body != "false"));
    }

    #[test]
    fn accepts_the_scope_the_way_the_interface_sends_it() {
        let application: PropertyScope = serde_json::from_str(r#""application""#).unwrap();
        assert_eq!(application.list_path(), "/api/properties/application");

        let broker: PropertyScope = serde_json::from_str(r#""broker""#).unwrap();
        assert_eq!(broker.list_path(), "/api/properties/broker");

        let domain: PropertyScope = serde_json::from_str(r#"{"domain":"domain-1"}"#).unwrap();
        assert_eq!(domain.list_path(), "/api/properties/domain-1/properties");
    }

    #[test]
    fn addresses_domain_constants_by_guid() {
        let scope = PropertyScope::Domain("domain-1".into());
        assert_eq!(scope.list_path(), "/api/properties/domain-1/properties");
        assert_eq!(scope.item_path("const.url"), "/api/properties/domain/domain-1/property/const.url");
        assert_eq!(PropertyScope::Broker.item_path("a"), "/api/properties/broker/property/a");
    }
}

// ───────────────────────── карта доменов ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainStat {
    pub guid: String,
    pub name: String,
    pub active: bool,
    pub routes: i64,
    pub running: i64,
    pub success: i64,
    pub errors: i64,
    pub inflight: i64,
}

/// Сводка по всем доменам сервера одним запросом.
///
/// Статистика знает только guid, поэтому имена подставляются из списка доменов;
/// то, чего в списке нет (служебные контексты вроде `dashboard`), показывается
/// под своим идентификатором, а не выбрасывается.
pub async fn domain_statistics(connection: &Connection) -> Result<Vec<DomainStat>, String> {
    let client = connection.client()?;
    let response = connection
        .get(&client, "/api/domains/statistics/all")
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(transport_error)?;
    let raw: Vec<Value> = ensure_ok(response, "Cannot read domain statistics")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;

    let names: std::collections::HashMap<String, String> = crate::fesb_api::domains(connection)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|domain| (domain.guid, domain.name))
        .collect();

    let mut stats: Vec<DomainStat> = raw
        .into_iter()
        .filter_map(|item| {
            let guid = text(&item, "domainGuid")?;
            Some(DomainStat {
                name: names.get(&guid).cloned().unwrap_or_else(|| guid.clone()),
                guid,
                active: flag(&item, "isActive"),
                routes: number(&item, &["routesCount"]).unwrap_or(0),
                running: number(&item, &["runningRoutes"]).unwrap_or(0),
                success: number(&item, &["successMessages"]).unwrap_or(0),
                errors: number(&item, &["errorMessages"]).unwrap_or(0),
                inflight: number(&item, &["inflightMessages"]).unwrap_or(0),
            })
        })
        .collect();
    stats.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(stats)
}

// ───────────────────────── СОПС на сервере ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteState {
    pub id: String,
    pub name: Option<String>,
    /// `Started`, `Stopped`, `Suspended` — как их называет сама шина.
    pub state: Option<String>,
    pub auto_startup: bool,
    pub trace: bool,
    pub trace_config: Option<String>,
    pub processed: i64,
    pub failed: i64,
    pub failures_handled: i64,
    pub inflight: i64,
    pub rate: f64,
    pub min_ms: i64,
    pub mean_ms: i64,
    pub max_ms: i64,
    pub first_processed: Option<String>,
    pub last_processed: Option<String>,
}

fn route_state_from(item: &Value) -> Option<RouteState> {
    Some(RouteState {
        id: text(item, "id")?,
        name: text(item, "name"),
        state: text(item, "routeState"),
        auto_startup: flag(item, "autoStartup"),
        trace: flag(item, "trace"),
        trace_config: item
            .get("traceConfig")
            .and_then(|value| value.get("name").and_then(Value::as_str).or_else(|| value.as_str()))
            .map(String::from),
        processed: number(item, &["processedQty"]).unwrap_or(0),
        failed: number(item, &["failed"]).unwrap_or(0),
        failures_handled: number(item, &["failuresHandled"]).unwrap_or(0),
        inflight: number(item, &["exchangesInflight"]).unwrap_or(0),
        rate: item.get("rate").and_then(Value::as_f64).unwrap_or(0.0),
        min_ms: number(item, &["minProcessingTime"]).unwrap_or(0),
        mean_ms: number(item, &["meanProcessingTime"]).unwrap_or(0),
        max_ms: number(item, &["maxProcessingTime"]).unwrap_or(0),
        first_processed: text(item, "firstProcessed"),
        last_processed: text(item, "lastProcessed"),
    })
}

/// Состояние и счётчики одного СОПС.
///
/// Работает и для остановленного маршрута: шина отдаёт его настройки вместе
/// с нулевыми счётчиками. Списком (`/api/broker/routes`) так не получится —
/// там только запущенные.
pub async fn route_state(
    connection: &Connection,
    domain: &str,
    route: &str,
) -> Result<RouteState, String> {
    let client = connection.client()?;
    let response = connection
        .get(&client, &format!("/api/broker/domain/{domain}/route/{route}"))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(transport_error)?;
    let item: Value = ensure_ok(response, "Cannot read the route")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;
    route_state_from(&item).ok_or_else(|| "The bus returned a route without an id".to_string())
}

/// Запуск, остановка, принудительная остановка или сброс счётчиков СОПС.
pub async fn route_action(
    connection: &Connection,
    domain: &str,
    route: &str,
    action: &str,
) -> Result<(), String> {
    let path = match action {
        "start" => "start",
        "stop" => "stop",
        "forceStop" => "forceStop",
        "reset" => "counter/reset",
        other => return Err(format!("Unknown route action: {other}")),
    };
    let client = connection.client()?;
    let response = connection
        .post(&client, &format!("/api/broker/domain/{domain}/route/{route}/{path}"))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Route action failed").await?;
    Ok(())
}

// ───────────────────────── точки восстановления ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePoint {
    pub version: Option<String>,
    pub filename: String,
    pub date: Option<String>,
}

pub async fn save_points(connection: &Connection) -> Result<Vec<SavePoint>, String> {
    let client = connection.client()?;
    let response = connection
        .get(&client, "/api/web/save-point")
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Cannot read restore points")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))
}

/// Снятие точки восстановления. На боевой конфигурации это десятки секунд.
pub async fn create_save_point(connection: &Connection) -> Result<(), String> {
    let client = connection.client()?;
    let response = connection
        .post(&client, "/api/web/save-point")
        .timeout(Duration::from_secs(900))
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Cannot create a restore point").await?;
    Ok(())
}

pub async fn delete_save_point(connection: &Connection, point: SavePoint) -> Result<(), String> {
    let client = connection.client()?;
    let response = connection
        .delete(&client, "/api/web/save-point")
        .json(&point)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Cannot delete the restore point").await?;
    Ok(())
}

/// Возврат конфигурации сервера к точке восстановления.
pub async fn rollback_save_point(connection: &Connection, point: SavePoint) -> Result<(), String> {
    let client = connection.client()?;
    let response = connection
        .post(&client, "/api/web/save-point/rollback")
        .json(&point)
        .timeout(Duration::from_secs(900))
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Rollback failed").await?;
    Ok(())
}

// ───────────────────────── сообщения в очереди ─────────────────────────

/// Свойство сообщения: имя и значение, как их отдала шина.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageProperty {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMessage {
    pub id: String,
    pub correlation_id: Option<String>,
    pub timestamp: Option<String>,
    pub priority: Option<i64>,
    pub size: i64,
    pub body_size: i64,
    pub body_type: Option<String>,
    pub persistent: bool,
    pub redelivered: bool,
    pub reply_to: Option<String>,
    pub properties: Vec<MessageProperty>,
    /// Тело, если шина его отдала: она присылает его в base64.
    pub body: Option<String>,
    pub truncated: bool,
}

/// Дата у мультименеджера приходит как `/Date(2026-08-26T23:22:30.976)/`.
fn clean_date(value: Option<String>) -> Option<String> {
    value.map(|text| {
        text.trim_start_matches("/Date(")
            .trim_end_matches(")/")
            .to_string()
    })
}

/// Декодирует base64 в текст. Не текст — значит показывать нечего.
fn decode_body(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let bytes = decode_base64(raw)?;
    String::from_utf8(bytes).ok()
}

/// Свой декодер вместо зависимости: алфавит стандартный, задача разовая.
fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
            b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for byte in input.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let digit = value(byte)?;
        buffer = (buffer << 6) | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

fn message_from(item: &Value) -> Option<QueueMessage> {
    let properties = item
        .get("properties")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(name, value)| MessageProperty {
                    name: name.clone(),
                    value: value.as_str().map(String::from).unwrap_or_else(|| value.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();

    Some(QueueMessage {
        id: text(item, "messageId").or_else(|| text(item, "jmsMessageId"))?,
        correlation_id: text(item, "correlationId"),
        timestamp: clean_date(text(item, "timestamp")),
        priority: number(item, &["priority"]),
        size: number(item, &["size", "persistentSize"]).unwrap_or(0),
        body_size: number(item, &["bodySize"]).unwrap_or(0),
        body_type: text(item, "bodyType").or_else(|| text(item, "type")),
        persistent: flag(item, "persistent") || flag(item, "durable"),
        redelivered: flag(item, "redelivered"),
        reply_to: text(item, "replyTo"),
        properties,
        body: decode_body(item.get("bodyView").and_then(Value::as_str)),
        truncated: flag(item, "truncatedBody"),
    })
}

/// Часть пути может содержать что угодно — от точек до двоеточий в id.
fn encode_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Сообщения очереди. У расширенных менеджеров ответ страничный, у мультименеджера — список.
pub async fn queue_messages(
    connection: &Connection,
    kind: ManagerKind,
    id: &str,
    queue: &str,
    limit: u32,
) -> Result<Vec<QueueMessage>, String> {
    let client = connection.client()?;
    let queue = encode_segment(queue);
    let path = match kind {
        ManagerKind::Qms => format!("/api/qms/brokers/{id}/queues/{queue}/messages"),
        ManagerKind::Qme => format!("/api/qme/servers/{id}/queues/{queue}/messages"),
        ManagerKind::Rqms => format!("/api/rqms/brokers/{id}/queues/{queue}/messages"),
    };

    let mut request = connection.get(&client, &path).timeout(Duration::from_secs(120));
    if kind == ManagerKind::Qme {
        // Фильтр обязателен, страница — иначе придёт только первый десяток.
        request = request.query(&[("filter", ""), ("page", "0"), ("size", &limit.to_string())]);
    }

    let response = request.send().await.map_err(transport_error)?;
    let body: Value = ensure_ok(response, "Cannot read messages")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;

    let items = body
        .as_array()
        .cloned()
        .or_else(|| body.get("content").and_then(Value::as_array).cloned())
        .unwrap_or_default();

    Ok(items
        .iter()
        .filter_map(message_from)
        .take(limit as usize)
        .collect())
}

/// Одно сообщение целиком: в списке шина тело не отдаёт.
pub async fn queue_message(
    connection: &Connection,
    kind: ManagerKind,
    id: &str,
    queue: &str,
    message: &str,
) -> Result<QueueMessage, String> {
    let client = connection.client()?;
    let queue = encode_segment(queue);
    let message_id = encode_segment(message);
    let path = match kind {
        ManagerKind::Qms => format!("/api/qms/brokers/{id}/queues/{queue}/messages/{message_id}"),
        ManagerKind::Qme => format!("/api/qme/servers/{id}/queues/{queue}/messages/{message_id}"),
        ManagerKind::Rqms => format!("/api/rqms/brokers/{id}/queues/{queue}/messages/{message_id}"),
    };

    let response = connection
        .get(&client, &path)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(transport_error)?;
    let item: Value = ensure_ok(response, "Cannot read the message")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;
    message_from(&item).ok_or_else(|| "The bus returned a message without an id".to_string())
}

/// Сколько тел читается одновременно.
///
/// Сообщения мелкие, и узкое место — не полоса, а время хода до сервера:
/// восемь одновременных запросов превращают двести последовательных ходов
/// в двадцать пять.
const BODY_CONCURRENCY: usize = 8;

/// Сколько знаков показывать вокруг найденного.
const EXCERPT_BEFORE: usize = 60;
const EXCERPT_AFTER: usize = 120;

/// Сообщение, в теле которого нашёлся искомый текст.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueMatch {
    pub id: String,
    /// Кусок тела вокруг найденного — чтобы было видно, за что зацепилось.
    pub excerpt: String,
}

/// Ищет текст в телах сообщений очереди.
///
/// В списке тела нет: шина отдаёт его только у отдельно запрошенного
/// сообщения. Поэтому поиск по содержимому — это отдельный проход по всем
/// сообщениям, и запускать его сам по себе, на каждое нажатие клавиши,
/// нельзя. Идентификаторы приходят с фронтенда: список там уже есть,
/// а заодно можно искать только по тому, что осталось после фильтров.
pub async fn queue_search<F: FnMut(ApiProgress)>(
    connection: &Connection,
    kind: ManagerKind,
    id: &str,
    queue: &str,
    ids: Vec<String>,
    needle: &str,
    mut on_progress: F,
) -> Result<Vec<QueueMatch>, String> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let total = ids.len() as u64;
    let mut done = 0u64;
    let mut found = Vec::new();
    on_progress(ApiProgress { phase: "messages", current: 0, total });

    for group in ids.chunks(BODY_CONCURRENCY) {
        let mut running = Vec::with_capacity(group.len());
        for message in group {
            let connection = connection.clone();
            let id = id.to_string();
            let queue = queue.to_string();
            let message = message.clone();
            running.push(tauri::async_runtime::spawn(async move {
                let body = queue_message(&connection, kind, &id, &queue, &message)
                    .await
                    .ok()
                    .and_then(|loaded| loaded.body);
                (message, body)
            }));
        }

        for handle in running {
            let (message, body) = handle.await.map_err(|err| format!("Search interrupted: {err}"))?;
            done += 1;
            // Сообщение, которое не прочиталось, поиск не роняет: очередь
            // живая, и пока мы её листаем, часть сообщений уже забрали.
            if let Some(body) = body {
                if let Some(excerpt) = excerpt_around(&body, &needle) {
                    found.push(QueueMatch { id: message, excerpt });
                }
            }
        }
        on_progress(ApiProgress { phase: "messages", current: done, total });
    }

    Ok(found)
}

/// Кусок текста вокруг первого вхождения — или `None`, если его нет.
///
/// Всё считается в символах, а не в байтах: тело бывает русским, и срез
/// посреди буквы уронил бы поиск целиком. Регистр снимается посимвольно —
/// так строка и её версия в нижнем регистре остаются одной длины, и позиция,
/// найденная в одной, годится для другой.
fn excerpt_around(body: &str, needle: &str) -> Option<String> {
    let needle = fold(needle);
    if needle.is_empty() {
        return None;
    }
    let chars: Vec<char> = body.chars().collect();
    let lower = fold(body);
    if lower.len() < needle.len() {
        return None;
    }
    let at = lower.windows(needle.len()).position(|window| window == needle.as_slice())?;

    let start = at.saturating_sub(EXCERPT_BEFORE);
    let end = (at + needle.len() + EXCERPT_AFTER).min(chars.len());

    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    // Переводы строк и отступы в вырезке только мешают: она однострочная.
    let mut space = false;
    for symbol in &chars[start..end] {
        if symbol.is_whitespace() {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(*symbol);
    }
    if end < chars.len() {
        out.push('…');
    }
    Some(out)
}

/// Строка в нижнем регистре, символ в символ.
///
/// `str::to_lowercase` местами меняет длину (турецкое `İ` разворачивается
/// в два символа), и тогда позиция из одной строки не годится для другой.
/// Для поиска довольно первого символа развёртки.
fn fold(value: &str) -> Vec<char> {
    value.chars().map(|symbol| symbol.to_lowercase().next().unwrap_or(symbol)).collect()
}

#[cfg(test)]
mod message_search_tests {
    use super::*;

    #[test]
    fn the_excerpt_shows_what_was_found_and_what_is_around_it() {
        let body = "<order><number>4815162342</number></order>";
        let excerpt = excerpt_around(body, "4815").expect("нашлось");
        assert!(excerpt.contains("4815162342"), "{excerpt}");
        assert!(excerpt.contains("<order>"), "{excerpt}");
    }

    #[test]
    fn the_search_ignores_case_in_both_alphabets() {
        assert!(excerpt_around("Заявка ПРИНЯТА", "принята").is_some());
        assert!(excerpt_around("Status: ACCEPTED", "accepted").is_some());
        assert!(excerpt_around("статус", "СТАТУС").is_some());
    }

    #[test]
    fn a_russian_body_does_not_break_the_slicing() {
        let body = "начало ".repeat(40) + "нужное" + &" хвост".repeat(40);
        let excerpt = excerpt_around(&body, "нужное").expect("нашлось");
        assert!(excerpt.starts_with('…') && excerpt.ends_with('…'), "{excerpt}");
        assert!(excerpt.contains("нужное"), "{excerpt}");
    }

    #[test]
    fn the_excerpt_is_one_line() {
        let excerpt = excerpt_around("первая\n\tвторая   третья", "вторая").expect("нашлось");
        assert_eq!(excerpt, "первая вторая третья");
    }

    #[test]
    fn nothing_is_returned_when_the_text_is_not_there() {
        assert_eq!(excerpt_around("тело сообщения", "накладная"), None);
        assert_eq!(excerpt_around("тело", ""), None);
        assert_eq!(excerpt_around("", "тело"), None);
    }

    #[test]
    fn a_needle_longer_than_the_body_is_simply_not_found() {
        assert_eq!(excerpt_around("да", "длинная строка"), None);
    }
}

// ───────────────────────────── аудит ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub timestamp: Option<String>,
    /// `action` — действие пользователя, `session` — вход или выход, `other` — прочее.
    pub kind: String,
    pub user: Option<String>,
    pub ip: Option<String>,
    /// Код действия шины: `BROKER_DOMAINS_IMPORT`, `MANAGER_MODULE_RESTART`…
    pub action: Option<String>,
    pub arguments: Option<String>,
    /// Код ответа из «Результат: <200 OK …>», если он там был.
    pub status: Option<i64>,
    pub text: String,
}

/// Забирает текст между двумя метками, не падая, если второй нет.
fn slice_between<'a>(text: &'a str, from: &str, to: &str) -> Option<&'a str> {
    let start = text.find(from)? + from.len();
    let rest = &text[start..];
    let end = rest.find(to).unwrap_or(rest.len());
    Some(rest[..end].trim())
}

/// Разбирает строку журнала аудита.
///
/// В файле два вида записей: действия пользователя от `AuditAspect`
/// («Пользователь: … Действие: … Аргументы: … Результат: …») и события сессий
/// от `SecurityAudit` («… WebSessionInfo{ user=…, ip=… }»). Всё остальное
/// остаётся как есть — терять строки аудита нельзя.
fn parse_audit(timestamp: Option<String>, text: &str) -> AuditEntry {
    let mut entry = AuditEntry {
        timestamp,
        kind: "other".into(),
        user: None,
        ip: None,
        action: None,
        arguments: None,
        status: None,
        text: text.to_string(),
    };

    if text.contains("Пользователь:") {
        entry.kind = "action".into();
        if let Some(head) = slice_between(text, "Пользователь:", ", Действие:") {
            let (user, ip) = match head.split_once("[ip=") {
                Some((user, rest)) => (user.trim(), Some(rest.trim_end_matches(']').trim().to_string())),
                None => (head, None),
            };
            entry.user = Some(user.trim().to_string()).filter(|value| !value.is_empty());
            entry.ip = ip.filter(|value| !value.is_empty());
        }
        entry.action = slice_between(text, "Действие:", "\n").map(|value| value.trim().to_string());
        entry.arguments = slice_between(text, "Аргументы:", "Результат:")
            .map(|value| value.trim().trim_end_matches(',').to_string())
            .filter(|value| !value.is_empty());
        entry.status = slice_between(text, "Результат: <", " ")
            .and_then(|value| value.trim().parse().ok());
        return entry;
    }

    // Вход и особенно неудачная попытка входа — то, ради чего аудит и читают.
    if text.starts_with("Login") {
        entry.kind = "login".into();
        entry.action = text.split(':').next().map(|value| value.trim().to_string());
        if let Some(head) = text.split("[ip=").nth(1) {
            entry.ip = Some(head.trim_end_matches(']').trim().to_string()).filter(|value| !value.is_empty());
        }
        entry.user = text
            .split("[ip=")
            .next()
            .and_then(|head| head.rsplit('-').next())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value != "-");
        return entry;
    }

    if let Some(info) = slice_between(text, "WebSessionInfo{", "}") {
        entry.kind = "session".into();
        // «Закрытие сессии WebSessionInfo{…}» — действие стоит перед скобкой.
        entry.action = text.split("WebSessionInfo").next().map(|value| value.trim().to_string());
        for part in info.split(',') {
            let Some((name, value)) = part.split_once('=') else { continue };
            let value = value.trim();
            match name.trim() {
                "user" if value != "-" => entry.user = Some(value.to_string()),
                "ip" => entry.ip = Some(value.to_string()),
                _ => {}
            }
        }
    }

    entry
}

/// Журнал аудита, разобранный по записям.
pub async fn audit(connection: &Connection, request: LogRequest) -> Result<Vec<AuditEntry>, String> {
    let entries = log_entries(
        connection,
        LogRequest {
            logs: vec!["audit.log".into()],
            levels: Vec::new(),
            search: request.search,
            limit: request.limit,
        },
    )
    .await?;

    Ok(entries
        .into_iter()
        .map(|entry| parse_audit(entry.timestamp, entry.message.as_deref().unwrap_or_default()))
        .collect())
}

#[cfg(test)]
mod property_tests {
    use super::*;

    fn property(value: Option<&str>, empty: bool) -> PropertyRow {
        PropertyRow {
            key: "const.url".into(),
            value: value.map(str::to_string),
            secured: false,
            vault: false,
            empty,
            description: None,
        }
    }

    #[test]
    fn value_over_a_stale_empty_flag() {
        // Флаг пришёл из чтения пустой константы, значение — новое.
        let row = with_empty_flag(property(Some("http://host:8080"), true));
        assert!(!row.empty, "с флагом пустоты шина оставила бы константу пустой");
    }

    #[test]
    fn empty_value_stays_empty() {
        assert!(with_empty_flag(property(Some(""), false)).empty);
        assert!(with_empty_flag(property(None, false)).empty);
    }
}

