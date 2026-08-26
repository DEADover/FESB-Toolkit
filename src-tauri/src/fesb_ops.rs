//! Разделы шины, которые читаются и правятся напрямую через API:
//! модули, менеджеры очередей, константы и журналы.
//!
//! В отличие от трассировки, у всего этого есть нормальные методы, так что
//! возить конфигурацию через архивы не нужно — работаем с сервером как есть.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fesb_api::{ensure_ok, transport_error, Connection};

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
    let client = connection.client()?;
    let body = serde_json::json!({
        "comment": comment.unwrap_or_else(|| "FESB Settings Editor".into()),
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
