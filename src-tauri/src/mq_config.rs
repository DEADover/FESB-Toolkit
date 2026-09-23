//! Что из настроек менеджеров очередей хранится в конфигурации.
//!
//! У объектов менеджеров очередей есть галочка «Хранить в конфигурации» —
//! поле `configurationManaged`. Объект с ней записан в файл конфигурации
//! менеджера (`conf/<модуль>/<менеджер>/local.xml`) и уезжает вместе с ним при
//! переносе и восстановлении. Объект без неё живёт только в хранилище брокера,
//! и при переносе конфигурации его не будет.
//!
//! **Расширенный менеджер (РМО, QME)** — галочка у шести разделов: очереди,
//! адреса, виртуальные адреса, адресация, авторизация и аутентификация.
//! Проверено на стенде:
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
//!
//! **Мультименеджер (QMS)** — галочка только у локальных очередей и топиков.
//! Составные, агрегирующие, сегментированные и сетевые хранятся в
//! конфигурации всегда: веб-интерфейс показывает им галочку включённой
//! и неактивной. Пользователи QMS галочки не имеют и в файле есть всегда.
//! Метода правки очереди у QMS нет, галочку включает повторное создание
//! с `ifNotExists=true`: ответ 200, сообщения остаются. Без этого параметра
//! шина отвечает 409 «уже существует», хотя галочку всё равно ставит.
//!
//! **Обратно, из конфигурации**, галочка снимается теми же вызовами. Проверено
//! на стенде с перезапуском менеджера: объекты всех типов остаются на сервере
//! со своими настройками, пользователь РМО входит со своим паролем. Адрес РМО
//! уходит из файла вместе со своими очередями — шина снимает галочку и с них,
//! молча, поэтому очереди адреса показываются в плане заранее.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::fesb_api::{coded, ensure_ok, transport_error, Connection};
use crate::fesb_ops::{encode_segment, ManagerKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigKind {
    Address,
    Queue,
    Topic,
    Divert,
    AddressSetting,
    Security,
    User,
}

/// Порядок записи у РМО: адрес раньше своих очередей.
const QME_KINDS: [ConfigKind; 6] = [
    ConfigKind::Address,
    ConfigKind::Queue,
    ConfigKind::Divert,
    ConfigKind::AddressSetting,
    ConfigKind::Security,
    ConfigKind::User,
];
const QMS_KINDS: [ConfigKind; 2] = [ConfigKind::Queue, ConfigKind::Topic];

/// Менеджер, с которым работаем, и путь к его разделам.
#[derive(Debug, Clone, Copy)]
struct Manager<'a> {
    kind: ManagerKind,
    id: &'a str,
}

impl Manager<'_> {
    fn new(kind: ManagerKind, id: &str) -> Result<Manager<'_>, String> {
        match kind {
            ManagerKind::Qme | ManagerKind::Qms => Ok(Manager { kind, id }),
            ManagerKind::Rqms => Err(coded("mq.unsupported", "RQMS")),
        }
    }

    fn kinds(self) -> &'static [ConfigKind] {
        match self.kind {
            ManagerKind::Qms => &QMS_KINDS,
            _ => &QME_KINDS,
        }
    }

    fn section(self, kind: ConfigKind) -> String {
        let (root, part) = match self.kind {
            ManagerKind::Qms => ("/api/qms/brokers", match kind {
                ConfigKind::Topic => "topics",
                _ => "queues",
            }),
            _ => ("/api/qme/servers", match kind {
                ConfigKind::Address => "addresses",
                ConfigKind::Queue => "queues",
                ConfigKind::Divert => "diverts",
                ConfigKind::AddressSetting => "settings/addresses",
                ConfigKind::Security => "security/addresses",
                ConfigKind::User => "users",
                ConfigKind::Topic => "topics",
            }),
        };
        format!("{root}/{}/{part}", encode_segment(self.id))
    }

    fn object(self, kind: ConfigKind, id: &str) -> String {
        format!("{}/{}", self.section(kind), encode_segment(id))
    }
}

impl ConfigKind {
    /// Поле, по которому объект находится в своём разделе.
    fn key(self) -> &'static str {
        match self {
            ConfigKind::AddressSetting | ConfigKind::Security => "match",
            ConfigKind::User => "username",
            _ => "name",
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
    /// Галочку не поменять: у составных очередей QMS она включена всегда.
    pub fixed: bool,
    /// Служебный объект брокера: `$sys.*`, `activemq.*`, `ActiveMQ.*`,
    /// внутренние и временные. Решать про них нечего, поэтому они скрыты
    /// по умолчанию.
    pub system: bool,
    /// Создан брокером на лету, когда клиент обратился к несуществующему адресу.
    pub auto_created: bool,
    /// Адрес очереди РМО — от него зависит, можно ли её сохранить.
    pub address: Option<String>,
    /// Одна строка о сути объекта: куда пересылает, кому что разрешено.
    pub detail: Option<String>,
    /// Сообщений в очереди.
    pub messages: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigAudit {
    pub manager: ManagerKind,
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
    /// Каким сделать объект: `true` — хранить в конфигурации, `false` — убрать.
    #[serde(default = "yes")]
    pub stored: bool,
    /// Только для пользователей РМО: без пароля пользователь не сохраняется.
    #[serde(default)]
    pub password: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreOutcome {
    pub kind: ConfigKind,
    pub id: String,
    pub error: Option<String>,
}

/// Все объекты менеджера, у которых бывает галочка, с её состоянием.
pub async fn audit(connection: &Connection, manager: ManagerKind, server: &str) -> Result<ConfigAudit, String> {
    let target = Manager::new(manager, server)?;
    let client = connection.client()?;
    let mut items = Vec::new();
    let mut failures = Vec::new();

    for kind in target.kinds() {
        match list(connection, &client, &target.section(*kind)).await {
            Ok(values) => items.extend(values.iter().filter_map(|value| describe(manager, *kind, value))),
            Err(error) => failures.push(format!("{kind:?}: {error}")),
        }
    }
    if items.is_empty() && failures.len() == target.kinds().len() {
        return Err(failures.join("; "));
    }
    Ok(ConfigAudit { manager, server: server.to_string(), items, failures })
}

/// Включает или снимает объектам галочку «Хранить в конфигурации».
///
/// Сначала снимается, потом ставится: снимать удобнее от очередей к адресам,
/// ставить — от адресов к очередям. Каждый объект перечитывается перед записью — отправляется то, что лежит
/// на сервере сейчас, а не то, что было на экране. Ошибка одного объекта
/// не останавливает остальные.
pub async fn store(
    connection: &Connection,
    manager: ManagerKind,
    server: &str,
    requests: &[StoreRequest],
) -> Result<Vec<StoreOutcome>, String> {
    let target = Manager::new(manager, server)?;
    let client = connection.client()?;
    let order = target.kinds();
    let rank = |item: &&StoreRequest| order.iter().position(|kind| *kind == item.kind).unwrap_or(usize::MAX);
    let mut removed: Vec<&StoreRequest> = requests.iter().filter(|item| !item.stored).collect();
    removed.sort_by_key(|item| std::cmp::Reverse(rank(item)));
    let mut added: Vec<&StoreRequest> = requests.iter().filter(|item| item.stored).collect();
    added.sort_by_key(rank);
    let ordered = removed.into_iter().chain(added);

    // Адреса РМО, которые уже в конфигурации или попадут туда в этом же заходе.
    let mut stored_addresses: HashSet<String> = if manager == ManagerKind::Qme {
        list(connection, &client, &target.section(ConfigKind::Address))
            .await?
            .iter()
            .filter(|value| flag(value, "configurationManaged"))
            .filter_map(|value| text(value, "name"))
            .collect()
    } else {
        HashSet::new()
    };

    let mut outcomes = Vec::with_capacity(requests.len());
    for request in ordered {
        let result = if !order.contains(&request.kind) {
            Err(coded("mq.unsupported", format!("{:?}", request.kind)))
        } else if manager == ManagerKind::Qms {
            store_qms(connection, &client, target, request).await
        } else {
            store_qme(connection, &client, target, request, &stored_addresses).await
        };
        if result.is_ok() && request.kind == ConfigKind::Address {
            if request.stored {
                stored_addresses.insert(request.id.clone());
            } else {
                stored_addresses.remove(&request.id);
            }
        }
        outcomes.push(StoreOutcome { kind: request.kind, id: request.id.clone(), error: result.err() });
    }
    Ok(outcomes)
}

async fn store_qme(
    connection: &Connection,
    client: &reqwest::Client,
    target: Manager<'_>,
    request: &StoreRequest,
    stored_addresses: &HashSet<String>,
) -> Result<(), String> {
    let path = target.object(request.kind, &request.id);
    let mut value = read(connection, client, &path).await?;
    if flag(&value, "configurationManaged") == request.stored {
        return Ok(());
    }
    if request.stored && request.kind == ConfigKind::Queue {
        let address = text(&value, "address").unwrap_or_default();
        if !stored_addresses.contains(&address) {
            return Err(coded("qme.addressNotStored", address));
        }
    }
    if request.stored && request.kind == ConfigKind::User {
        let password = request.password.as_deref().unwrap_or("");
        if password.is_empty() {
            return Err(coded("qme.passwordRequired", request.id.clone()));
        }
        value["password"] = Value::String(password.to_string());
    }
    value["configurationManaged"] = Value::Bool(request.stored);

    let response = connection.put(client, &path).json(&value).send().await.map_err(transport_error)?;
    ensure_ok(response, "Cannot save the object").await?;
    confirm(connection, client, &path, request).await
}

async fn store_qms(
    connection: &Connection,
    client: &reqwest::Client,
    target: Manager<'_>,
    request: &StoreRequest,
) -> Result<(), String> {
    let path = target.object(request.kind, &request.id);
    let value = read(connection, client, &path).await?;
    if flag(&value, "configurationManaged") == request.stored {
        return Ok(());
    }
    if qms_fixed(request.kind, &value) {
        return Err(coded("qms.notLocal", request.id.clone()));
    }

    let response = connection
        .post(client, &target.section(request.kind))
        .query(&[("ifNotExists", "true")])
        .json(&json!({ "name": request.id, "configurationManaged": request.stored }))
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Cannot save the object").await?;
    confirm(connection, client, &path, request).await
}

/// Ответ «200» ещё не значит, что галочка встала как надо: перечитываем.
async fn confirm(connection: &Connection, client: &reqwest::Client, path: &str, request: &StoreRequest) -> Result<(), String> {
    let after = read(connection, client, path).await?;
    if flag(&after, "configurationManaged") == request.stored {
        Ok(())
    } else {
        Err(coded("qme.notStored", request.id.clone()))
    }
}

async fn read(connection: &Connection, client: &reqwest::Client, path: &str) -> Result<Value, String> {
    let response = connection.get(client, path).send().await.map_err(transport_error)?;
    ensure_ok(response, "Cannot read the object")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))
}

async fn list(connection: &Connection, client: &reqwest::Client, path: &str) -> Result<Vec<Value>, String> {
    let response = connection.get(client, path).send().await.map_err(transport_error)?;
    ensure_ok(response, "Cannot read the queue manager")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))
}

/// Очередь или топик QMS, у которых галочки нет: составные, агрегирующие,
/// сегментированные, сетевые и виртуальные — они в конфигурации всегда.
fn qms_fixed(kind: ConfigKind, value: &Value) -> bool {
    let fields: &[&str] = match kind {
        ConfigKind::Topic => &["compositeTopic", "virtualTopic", "connector"],
        _ => &["compositeQueue", "aggregation", "fragmentation", "connector"],
    };
    fields.iter().any(|field| value.get(*field).is_some_and(|item| !item.is_null()))
}

fn describe(manager: ManagerKind, kind: ConfigKind, value: &Value) -> Option<ConfigItem> {
    let id = text(value, kind.key())?;
    let system_name = id.starts_with("$sys.") || id.starts_with("activemq.") || id.starts_with("ActiveMQ.");
    let system = system_name
        || flag(value, "internalQueue")
        || flag(value, "internal")
        || flag(value, "temporary");

    if manager == ManagerKind::Qms {
        let fixed = qms_fixed(kind, value);
        let detail = if fixed {
            let what = [
                ("compositeQueue", "composite"), ("compositeTopic", "composite"), ("virtualTopic", "virtual"),
                ("aggregation", "aggregation"), ("fragmentation", "fragmentation"), ("connector", "network"),
            ]
            .iter()
            .find(|(field, _)| value.get(*field).is_some_and(|item| !item.is_null()))
            .map(|(_, name)| (*name).to_string());
            what
        } else {
            None
        };
        return Some(ConfigItem {
            kind,
            stored: fixed || flag(value, "configurationManaged"),
            fixed,
            system,
            auto_created: false,
            address: None,
            detail,
            messages: if kind == ConfigKind::Queue { value.get("queueSize").and_then(Value::as_i64) } else { None },
            id,
        });
    }

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
        ConfigKind::Topic => None,
    };

    Some(ConfigItem {
        kind,
        stored: flag(value, "configurationManaged"),
        fixed: false,
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

    #[test]
    fn service_objects_of_the_broker_are_marked_as_system() {
        let queue = describe(ManagerKind::Qme, ConfigKind::Queue, &json!({
            "name": "$sys.mqtt.sessions", "address": "$sys.mqtt.sessions", "internalQueue": true,
            "configurationManaged": false,
        }))
        .unwrap();
        assert!(queue.system);

        let notifications = describe(ManagerKind::Qme, ConfigKind::Address, &json!({ "name": "activemq.notifications" })).unwrap();
        assert!(notifications.system);

        let advisory = describe(ManagerKind::Qms, ConfigKind::Topic, &json!({ "name": "ActiveMQ.Advisory.Queue" })).unwrap();
        assert!(advisory.system);

        let plain = describe(ManagerKind::Qme, ConfigKind::Queue, &json!({
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
        let item = describe(ManagerKind::Qme, ConfigKind::Security, &json!({
            "match": "Orders.#", "send": ["app", "admin"], "consume": ["app"], "manage": ["admin"],
            "configurationManaged": true,
        }))
        .unwrap();
        assert_eq!(item.detail.as_deref(), Some("admin, app"));
        assert!(item.stored);
    }

    #[test]
    fn composite_qms_queues_are_always_stored() {
        let composite = describe(ManagerKind::Qms, ConfigKind::Queue, &json!({
            "name": "Orders.Fanout", "queueSize": 0, "compositeQueue": { "forwardTo": [] },
            "configurationManaged": false,
        }))
        .unwrap();
        assert!(composite.stored && composite.fixed);
        assert_eq!(composite.detail.as_deref(), Some("composite"));

        let local = describe(ManagerKind::Qms, ConfigKind::Queue, &json!({
            "name": "Orders.In", "queueSize": 4, "compositeQueue": null, "configurationManaged": false,
        }))
        .unwrap();
        assert!(!local.stored && !local.fixed);
        assert_eq!(local.messages, Some(4));
    }

    #[test]
    fn addresses_are_written_before_their_queues() {
        let queue = QME_KINDS.iter().position(|kind| *kind == ConfigKind::Queue).unwrap();
        let address = QME_KINDS.iter().position(|kind| *kind == ConfigKind::Address).unwrap();
        assert!(address < queue);
    }

    #[test]
    fn paths_follow_the_manager() {
        let qms = Manager::new(ManagerKind::Qms, "QM").unwrap();
        assert_eq!(qms.object(ConfigKind::Queue, "A/B"), "/api/qms/brokers/QM/queues/A%2FB");
        let qme = Manager::new(ManagerKind::Qme, "EQM").unwrap();
        assert_eq!(qme.object(ConfigKind::Security, "Orders.#"), "/api/qme/servers/EQM/security/addresses/Orders.%23");
        assert!(Manager::new(ManagerKind::Rqms, "R").is_err());
    }
}
