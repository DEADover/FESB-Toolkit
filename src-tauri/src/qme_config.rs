//! Что из настроек расширенного менеджера очередей хранится в конфигурации.
//!
//! У объектов РМО есть галочка «Хранить в конфигурации» — поле
//! `configurationManaged`. Объект с ней записан в файл конфигурации менеджера
//! и уезжает вместе с ним при переносе и восстановлении. Объект без неё живёт
//! только в журнале брокера, и при переносе его не будет.
//!
//! Галочка есть у шести разделов: очереди, адреса, виртуальные адреса,
//! адресация, авторизация и аутентификация. Что проверено на стенде
//! и определяет порядок записи:
//!
//! * очередь попадает в файл, только если там уже есть её адрес. Иначе шина
//!   отвечает успехом, но ничего не пишет, и после перезапуска галочки нет.
//!   Поэтому адреса сохраняются первыми, а очередь без сохранённого адреса
//!   не отправляется вовсе;
//! * пароль пользователя шина не отдаёт. Запись с пустым паролем переносит
//!   пользователя в файл без пароля: сейчас он входит, а после переноса
//!   конфигурации не сможет. Поэтому пользователь сохраняется только с
//!   заново введённым паролем;
//! * остальные объекты переписываются как есть: поля не меняются, сообщения
//!   в очереди остаются на месте.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fesb_api::{coded, ensure_ok, transport_error, Connection};
use crate::fesb_ops::encode_segment;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigKind {
    Address,
    Queue,
    Divert,
    AddressSetting,
    Security,
    User,
}

impl ConfigKind {
    /// Порядок записи: адрес раньше своих очередей.
    const ORDER: [ConfigKind; 6] = [
        ConfigKind::Address,
        ConfigKind::Queue,
        ConfigKind::Divert,
        ConfigKind::AddressSetting,
        ConfigKind::Security,
        ConfigKind::User,
    ];

    fn path(self) -> &'static str {
        match self {
            ConfigKind::Address => "addresses",
            ConfigKind::Queue => "queues",
            ConfigKind::Divert => "diverts",
            ConfigKind::AddressSetting => "settings/addresses",
            ConfigKind::Security => "security/addresses",
            ConfigKind::User => "users",
        }
    }

    /// Поле, по которому объект находится в своём разделе.
    fn key(self) -> &'static str {
        match self {
            ConfigKind::Address | ConfigKind::Queue | ConfigKind::Divert => "name",
            ConfigKind::AddressSetting | ConfigKind::Security => "match",
            ConfigKind::User => "username",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigItem {
    pub kind: ConfigKind,
    pub id: String,
    /// Хранится ли в конфигурации.
    pub stored: bool,
    /// Служебный объект брокера: `$sys.*`, `activemq.*`, внутренние
    /// и временные. Решать про них нечего, поэтому они скрыты по умолчанию.
    pub system: bool,
    /// Создан брокером на лету, когда клиент обратился к несуществующему адресу.
    pub auto_created: bool,
    /// Адрес очереди — от него зависит, можно ли её сохранить.
    pub address: Option<String>,
    /// Одна строка о сути объекта: куда пересылает, кому что разрешено.
    pub detail: Option<String>,
    /// Сообщений в очереди.
    pub messages: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigAudit {
    pub server: String,
    pub items: Vec<ConfigItem>,
    /// Разделы, которые не удалось прочитать: остальное всё равно показывается.
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRequest {
    pub kind: ConfigKind,
    pub id: String,
    /// Только для пользователей: без пароля пользователь не сохраняется.
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreOutcome {
    pub kind: ConfigKind,
    pub id: String,
    pub error: Option<String>,
}

/// Все объекты шести разделов с признаком хранения.
pub async fn audit(connection: &Connection, server: &str) -> Result<ConfigAudit, String> {
    let client = connection.client()?;
    let mut items = Vec::new();
    let mut failures = Vec::new();

    for kind in ConfigKind::ORDER {
        match list(connection, &client, server, kind).await {
            Ok(values) => items.extend(values.iter().filter_map(|value| describe(kind, value))),
            Err(error) => failures.push(format!("{}: {error}", kind.path())),
        }
    }
    if items.is_empty() && failures.len() == ConfigKind::ORDER.len() {
        return Err(failures.join("; "));
    }
    Ok(ConfigAudit { server: server.to_string(), items, failures })
}

/// Сохраняет объекты в конфигурации: включает им галочку.
///
/// Каждый объект перечитывается перед записью — отправляется то, что лежит
/// на сервере сейчас, а не то, что было на экране. Ошибка одного объекта
/// не останавливает остальные.
pub async fn store(
    connection: &Connection,
    server: &str,
    requests: &[StoreRequest],
) -> Result<Vec<StoreOutcome>, String> {
    let client = connection.client()?;
    let mut ordered: Vec<&StoreRequest> = requests.iter().collect();
    ordered.sort_by_key(|item| ConfigKind::ORDER.iter().position(|kind| *kind == item.kind));

    // Адреса, которые уже в конфигурации или попадут туда в этом же заходе.
    let mut stored_addresses: HashSet<String> = list(connection, &client, server, ConfigKind::Address)
        .await?
        .iter()
        .filter(|value| flag(value, "configurationManaged"))
        .filter_map(|value| text(value, "name"))
        .collect();

    let mut outcomes = Vec::with_capacity(ordered.len());
    for request in ordered {
        let result = store_one(connection, &client, server, request, &stored_addresses).await;
        if result.is_ok() && request.kind == ConfigKind::Address {
            stored_addresses.insert(request.id.clone());
        }
        outcomes.push(StoreOutcome { kind: request.kind, id: request.id.clone(), error: result.err() });
    }
    Ok(outcomes)
}

async fn store_one(
    connection: &Connection,
    client: &reqwest::Client,
    server: &str,
    request: &StoreRequest,
    stored_addresses: &HashSet<String>,
) -> Result<(), String> {
    let path = format!(
        "/api/qme/servers/{}/{}/{}",
        encode_segment(server),
        request.kind.path(),
        encode_segment(&request.id)
    );
    let response = connection.get(client, &path).send().await.map_err(transport_error)?;
    let mut value: Value = ensure_ok(response, "Cannot read the object")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;

    if flag(&value, "configurationManaged") {
        return Ok(());
    }
    if request.kind == ConfigKind::Queue {
        let address = text(&value, "address").unwrap_or_default();
        if !stored_addresses.contains(&address) {
            return Err(coded("qme.addressNotStored", address));
        }
    }
    if request.kind == ConfigKind::User {
        let password = request.password.as_deref().unwrap_or("");
        if password.is_empty() {
            return Err(coded("qme.passwordRequired", request.id.clone()));
        }
        value["password"] = Value::String(password.to_string());
    }
    value["configurationManaged"] = Value::Bool(true);

    let response = connection
        .put(client, &path)
        .json(&value)
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Cannot save the object").await?;

    // Ответ «200» ещё не значит, что галочка встала: перечитываем.
    let response = connection.get(client, &path).send().await.map_err(transport_error)?;
    let after: Value = ensure_ok(response, "Cannot read the object")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;
    if flag(&after, "configurationManaged") {
        Ok(())
    } else {
        Err(coded("qme.notStored", request.id.clone()))
    }
}

async fn list(
    connection: &Connection,
    client: &reqwest::Client,
    server: &str,
    kind: ConfigKind,
) -> Result<Vec<Value>, String> {
    let path = format!("/api/qme/servers/{}/{}", encode_segment(server), kind.path());
    let response = connection.get(client, &path).send().await.map_err(transport_error)?;
    ensure_ok(response, "Cannot read the queue manager")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))
}

fn describe(kind: ConfigKind, value: &Value) -> Option<ConfigItem> {
    let id = text(value, kind.key())?;
    let system_name = id.starts_with("$sys.") || id.starts_with("activemq.");
    let system = system_name
        || flag(value, "internalQueue")
        || flag(value, "internal")
        || flag(value, "temporary");

    let detail = match kind {
        ConfigKind::Queue => {
            let routing = text(value, "type").unwrap_or_default();
            let durable = if flag(value, "durable") { "durable" } else { "non-durable" };
            Some(format!("{routing} · {durable}"))
        }
        ConfigKind::Address => {
            let routing = strings(value, "routingTypes").join(", ");
            (!routing.is_empty()).then_some(routing)
        }
        ConfigKind::Divert => {
            let targets = strings(value, "forwardingAddresses").join(", ");
            let source = text(value, "address").unwrap_or_default();
            Some(format!("{source} → {targets}"))
        }
        ConfigKind::AddressSetting => {
            let mut parts = Vec::new();
            if let Some(dla) = text(value, "deadLetterAddress") {
                parts.push(format!("DLA {dla}"));
            }
            if let Some(attempts) = value.get("maxDeliveryAttempts").and_then(Value::as_i64) {
                parts.push(format!("maxDeliveryAttempts {attempts}"));
            }
            (!parts.is_empty()).then(|| parts.join(" · "))
        }
        ConfigKind::Security => {
            let mut roles: Vec<String> = [
                "send", "consume", "browse", "manage", "createAddress", "deleteAddress",
                "createDurableQueue", "deleteDurableQueue", "createNonDurableQueue", "deleteNonDurableQueue",
            ]
            .iter()
            .flat_map(|field| strings(value, field))
            .collect();
            roles.sort();
            roles.dedup();
            (!roles.is_empty()).then(|| roles.join(", "))
        }
        ConfigKind::User => {
            let roles = strings(value, "roles").join(", ");
            (!roles.is_empty()).then_some(roles)
        }
    };

    Some(ConfigItem {
        kind,
        stored: flag(value, "configurationManaged"),
        system,
        auto_created: flag(value, "autoCreated"),
        address: if kind == ConfigKind::Queue { text(value, "address") } else { None },
        detail,
        messages: if kind == ConfigKind::Queue { value.get("messageCount").and_then(Value::as_i64) } else { None },
        id,
    })
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|item| !item.is_empty()).map(String::from)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn service_objects_of_the_broker_are_marked_as_system() {
        let queue = describe(ConfigKind::Queue, &json!({
            "name": "$sys.mqtt.sessions", "address": "$sys.mqtt.sessions", "internalQueue": true,
            "configurationManaged": false,
        }))
        .unwrap();
        assert!(queue.system);

        let notifications = describe(ConfigKind::Address, &json!({ "name": "activemq.notifications" })).unwrap();
        assert!(notifications.system);

        let plain = describe(ConfigKind::Queue, &json!({
            "name": "Orders.In", "address": "Orders.In", "type": "ANYCAST", "durable": true,
            "configurationManaged": false, "messageCount": 3,
        }))
        .unwrap();
        assert!(!plain.system);
        assert!(!plain.stored);
        assert_eq!(plain.address.as_deref(), Some("Orders.In"));
        assert_eq!(plain.messages, Some(3));
        assert_eq!(plain.detail.as_deref(), Some("ANYCAST · durable"));
    }

    #[test]
    fn security_lists_every_role_once() {
        let item = describe(ConfigKind::Security, &json!({
            "match": "Orders.#", "send": ["app", "admin"], "consume": ["app"], "manage": ["admin"],
            "configurationManaged": true,
        }))
        .unwrap();
        assert_eq!(item.detail.as_deref(), Some("admin, app"));
        assert!(item.stored);
    }

    #[test]
    fn addresses_are_written_before_their_queues() {
        let queue = ConfigKind::ORDER.iter().position(|kind| *kind == ConfigKind::Queue).unwrap();
        let address = ConfigKind::ORDER.iter().position(|kind| *kind == ConfigKind::Address).unwrap();
        assert!(address < queue);
    }
}
