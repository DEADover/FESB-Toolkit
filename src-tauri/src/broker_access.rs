//! Брокеры стенда и доступ к ним.
//!
//! Раздел AMQP подключается к менеджеру очередей по сети, а у менеджера
//! FESB из коробки нет ни одного пользователя: `security-enabled` включён,
//! список пуст, и по TCP не пускает никого. Дальше человек ищет по конфигам
//! порт приёмника и заводит пользователя руками — притом что у шины есть
//! методы и на то, и на другое.
//!
//! Здесь эти два вопроса и решаются: какие у стенда есть брокеры и на каких
//! портах, и как выдать доступ тому пользователю, под которым приложение
//! собирается подключаться.
//!
//! Менеджеры QMS (ActiveMQ Classic) сюда не попадают намеренно: разделу
//! нужен Artemis — управление очередями он ведёт через `activemq.management`,
//! а на Classic такого адреса нет.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::fesb_api::{ensure_ok, get_json, transport_error, Connection};

/// Приёмник брокера: куда именно можно подключиться.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerEndpoint {
    /// Менеджер очередей: `EQM1`.
    pub server: String,
    /// Запущен ли он сейчас.
    pub running: bool,
    /// Имя приёмника в конфигурации: `default-listener`.
    pub acceptor: String,
    /// Узел из адреса приёмника; `0.0.0.0` означает «все адреса».
    pub host: String,
    pub port: u16,
    /// Поднят ли сам приёмник.
    pub started: bool,
}

/// Что сделала настройка доступа.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerAccessReport {
    pub server: String,
    /// Пользователь заведён сейчас; `false` — он уже был.
    pub user_created: bool,
    /// Права роли на все адреса выданы сейчас; `false` — они уже были.
    pub rights_granted: bool,
    /// Роль, которой выданы права.
    pub role: String,
}

#[derive(Debug, Deserialize)]
struct QmeUser {
    #[serde(default)]
    username: String,
    #[serde(default)]
    roles: Vec<String>,
}

/// Порт из адреса приёмника: `tcp://0.0.0.0:61617?x=1` → `0.0.0.0` и `61617`.
fn split_uri(uri: &str) -> Option<(String, u16)> {
    let without_scheme = uri.split("://").nth(1).unwrap_or(uri);
    let authority = without_scheme.split(['/', '?']).next()?;
    let (host, port) = authority.rsplit_once(':')?;
    Some((host.to_string(), port.parse().ok()?))
}

/// Все приёмники всех менеджеров QME стенда.
///
/// Остановленный менеджер из списка не выбрасывается: подключиться к нему
/// нельзя, но знать, что он есть, полезнее, чем гадать, куда делся брокер.
pub async fn broker_endpoints(connection: &Connection) -> Result<Vec<BrokerEndpoint>, String> {
    let client = connection.client()?;
    let servers = get_json(connection, &client, "/api/qme/servers").await?;
    let Some(servers) = servers.as_array() else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for server in servers {
        let Some(id) = server.get("id").and_then(Value::as_str) else { continue };
        let running = server.get("status").and_then(Value::as_str) == Some("STARTED");

        // Приёмники читаем по каждому менеджеру: у остановленного их может
        // не отдать вовсе, и это не повод ронять весь список.
        let path = format!("/api/qme/servers/{id}/acceptors");
        let Ok(acceptors) = get_json(connection, &client, &path).await else { continue };
        let Some(acceptors) = acceptors.as_array() else { continue };

        for acceptor in acceptors {
            let uri = acceptor.get("uri").and_then(Value::as_str).unwrap_or_default();
            let Some((host, port)) = split_uri(uri) else { continue };
            out.push(BrokerEndpoint {
                server: id.to_string(),
                running,
                acceptor: acceptor.get("name").and_then(Value::as_str).unwrap_or("—").to_string(),
                host,
                port,
                started: acceptor.get("started").and_then(Value::as_bool).unwrap_or(false),
            });
        }
    }

    out.sort_by(|a, b| (b.running, a.port).cmp(&(a.running, b.port)));
    Ok(out)
}

/// Заводит пользователя брокера и выдаёт его роли права на все адреса.
///
/// Роль называется как пользователь: на стенде, где раздают доступ по одному
/// человеку, отдельные имена ролей только запутывают. Обе операции
/// пропускаются, если сделаны раньше, — повторный вызов ничего не ломает
/// и ничего не переписывает: пароль существующего пользователя не трогаем,
/// чтобы не отобрать доступ у того, кто уже им пользуется.
pub async fn grant_broker_access(
    connection: &Connection,
    server: &str,
    username: &str,
    password: &str,
) -> Result<BrokerAccessReport, String> {
    if username.trim().is_empty() {
        return Err("Broker user name is empty".into());
    }
    let client = connection.client()?;
    let role = username.to_string();

    // ── пользователь ─────────────────────────────────────────────────────
    let users_path = format!("/api/qme/servers/{server}/users");
    let existing: Vec<QmeUser> = serde_json::from_value(
        get_json(connection, &client, &users_path).await?,
    )
    .map_err(|err| format!("Unexpected answer: {err}"))?;

    let known = existing.iter().find(|user| user.username == username);
    let user_created = known.is_none();
    if user_created {
        let response = connection
            .post(&client, &users_path)
            .json(&json!({ "username": username, "password": password, "roles": [role] }))
            .send()
            .await
            .map_err(transport_error)?;
        ensure_ok(response, "Cannot create the broker user").await?;
    }

    // Роль у существующего пользователя может быть другой — права выдаём той,
    // что у него есть, иначе выдали бы их в пустоту.
    let role = known
        .and_then(|user| user.roles.first().cloned())
        .unwrap_or(role);

    // ── права ────────────────────────────────────────────────────────────
    let security_path = format!("/api/qme/servers/{server}/security/addresses");
    let settings = get_json(connection, &client, &security_path).await?;
    let all = settings
        .as_array()
        .and_then(|list| list.iter().find(|item| item.get("match").and_then(Value::as_str) == Some("#")));

    let granted = all.is_some_and(|item| {
        ["send", "consume", "browse", "manage"].iter().all(|right| {
            item.get(*right)
                .and_then(Value::as_array)
                .is_some_and(|roles| roles.iter().any(|value| value.as_str() == Some(role.as_str())))
        })
    });

    let rights_granted = !granted;
    if rights_granted {
        // Права дописываем к тем, что уже есть: на стенде могли быть свои
        // роли, и стереть их ради одной новой — плохая плата за удобство.
        let mut body = json!({ "match": "#" });
        for right in [
            "send", "consume", "browse", "manage",
            "createAddress", "deleteAddress",
            "createDurableQueue", "deleteDurableQueue",
            "createNonDurableQueue", "deleteNonDurableQueue",
        ] {
            let mut roles: Vec<String> = all
                .and_then(|item| item.get(right))
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if !roles.iter().any(|value| value == &role) {
                roles.push(role.clone());
            }
            body[right] = json!(roles);
        }

        let response = if all.is_some() {
            connection.put(&client, &format!("{security_path}/%23")).json(&body).send().await
        } else {
            connection.post(&client, &security_path).json(&body).send().await
        }
        .map_err(transport_error)?;
        ensure_ok(response, "Cannot grant the broker rights").await?;
    }

    Ok(BrokerAccessReport {
        server: server.to_string(),
        user_created,
        rights_granted,
        role,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_port_out_of_an_acceptor_uri() {
        assert_eq!(split_uri("tcp://0.0.0.0:61617"), Some(("0.0.0.0".into(), 61617)));
        assert_eq!(split_uri("tcp://esb.corp:61616?maximumConnections=1000"), Some(("esb.corp".into(), 61616)));
        assert_eq!(split_uri("tcp://0.0.0.0:5445/path"), Some(("0.0.0.0".into(), 5445)));
    }

    #[test]
    fn an_address_without_a_port_is_not_an_endpoint() {
        assert_eq!(split_uri("vm://EQM1"), None);
        assert_eq!(split_uri(""), None);
    }
}
