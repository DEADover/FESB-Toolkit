//! Что происходит на сервере прямо сейчас.
//!
//! Две вещи, которых не хватало во всех остальных разделах.
//!
//! Первая — **состояние самой шины**: сколько она работает, чем занята
//! память, сколько осталось на дисках. Отчёт по точкам входа честно
//! оставлял колонку Uptime пустой, потому что по портам его нет; по серверу
//! он есть, и лежит в `/api/json/stat`.
//!
//! Вторая — **незавершённые обмены**. Счётчик «в работе» есть и у домена,
//! и у СОПС, но он отвечает только «сколько», а спрашивают обычно «что
//! и где застряло»: домен, СОПС, шаг, поток и сколько времени сообщение
//! там уже висит.
//!
//! Списков таких обменов у шины три, по видам доменов, и одного мало:
//!
//! * `/api/broker/analytics/inflight-exchanges` — домены брокера;
//! * `/api/ws/domain/inflight-exchanges` — веб-сервисы;
//! * `/api/rest/domain/{guid}/inflight-exchanges` — REST, по домену.
//!
//! Поля у них общие, а различают их подробности: у REST это метод и адрес,
//! у веб-сервиса — операция и точка. Они и попадают в `detail`.

use serde::Serialize;

use crate::fesb_api::{get_json, Connection};

/// Состояние сервера: время работы, память, процессор и диски.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerUsage {
    /// Сколько шина работает, в миллисекундах.
    pub uptime: Option<u64>,
    pub version: Option<String>,
    pub jvm: Option<String>,
    pub os: Option<String>,
    pub path: Option<String>,
    /// Адреса, на которых шина себя видит.
    pub addresses: Vec<String>,
    pub memory_used: Option<u64>,
    pub memory_max: Option<u64>,
    pub processors: Option<u64>,
    /// Доля занятого процессора, 0..1.
    pub processor_usage: Option<f64>,
    pub disks: Vec<DiskUsage>,
}

/// Диск или рабочий каталог шины.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub name: String,
    /// Путь у каталога; у диска пусто.
    pub path: Option<String>,
    pub total: u64,
    pub used: u64,
    pub free: u64,
}

/// Обмен, который шина ещё не завершила.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct InflightExchange {
    pub id: String,
    /// Откуда обмен: `broker`, `rest` или `ws`.
    pub kind: String,
    pub domain: String,
    pub domain_guid: String,
    /// СОПС, в котором сообщение появилось.
    pub route: String,
    pub route_id: String,
    /// СОПС, в котором оно сейчас: при вызове одного СОПС из другого это не то же самое.
    pub at: Option<String>,
    /// Шаг, на котором оно стоит.
    pub node: Option<String>,
    pub thread: Option<String>,
    /// Подробность своего вида: `GET /users/{id}` у REST, имя операции у веб-сервиса.
    pub detail: Option<String>,
    /// Сколько миллисекунд обмен живёт целиком и сколько стоит на текущем шаге.
    pub duration: Option<u64>,
    pub elapsed: Option<u64>,
    pub interrupted: bool,
}

/// Читает состояние сервера двумя запросами.
///
/// Общие сведения и загрузка лежат в разных методах, но по отдельности
/// не отвечают ни на один вопрос целиком: «сколько работает» без «чем
/// занята память» — половина ответа.
pub async fn server_usage(connection: &Connection) -> Result<ServerUsage, String> {
    let client = connection.client()?;
    let stat = get_json(connection, &client, "/api/json/stat").await?;
    // Загрузка может быть закрыта правами, а общие сведения — нет:
    // показать половину лучше, чем не показать ничего.
    let usage = get_json(connection, &client, "/api/json/stat/systemUsage")
        .await
        .unwrap_or(serde_json::Value::Null);

    let mut disks: Vec<DiskUsage> = usage
        .get("disks")
        .and_then(|value| value.as_array())
        .map(|list| {
            list.iter()
                .map(|disk| DiskUsage {
                    name: text(disk, "name").unwrap_or_default(),
                    path: None,
                    total: number(disk, "total").unwrap_or(0),
                    used: number(disk, "used").unwrap_or(0),
                    free: number(disk, "free").unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();

    // Каталоги важнее дисков: `conf` и `data` могут лежать на разных томах,
    // и кончится место сначала под одним из них.
    if let Some(map) = usage.get("directories").and_then(|value| value.as_object()) {
        for (name, entry) in map {
            disks.push(DiskUsage {
                name: name.clone(),
                path: text(entry, "path"),
                total: number(entry, "total").unwrap_or(0),
                used: number(entry, "used").unwrap_or(0),
                free: number(entry, "free").unwrap_or(0),
            });
        }
    }

    Ok(ServerUsage {
        // Шина отдаёт uptime строкой с числом миллисекунд.
        uptime: text(&stat, "uptime").and_then(|value| value.parse().ok()).or_else(|| number(&stat, "uptime")),
        version: text(&stat, "version"),
        jvm: text(&stat, "jvm"),
        os: text(&stat, "os"),
        path: text(&stat, "path"),
        addresses: stat
            .get("addressList")
            .and_then(|value| value.as_array())
            .map(|list| list.iter().filter_map(|item| text(item, "ip")).collect())
            .unwrap_or_default(),
        memory_used: number(&usage, "memoryUsed"),
        memory_max: number(&usage, "memoryMax").or_else(|| number(&usage, "memoryHeap")),
        processors: number(&usage, "processors"),
        processor_usage: usage.get("processorUsage").and_then(serde_json::Value::as_f64),
        disks,
    })
}

/// Обмены, которые шина ещё не довела до конца.
///
/// Дольше всего висящие идут первыми: список открывают, чтобы найти
/// застрявшее, а не пересчитать всё.
pub async fn inflight_exchanges(connection: &Connection) -> Result<Vec<InflightExchange>, String> {
    let client = connection.client()?;
    let mut rows = Vec::new();

    // Домены брокера — главный список, и только его отсутствие считается
    // ошибкой: остальные два бывают закрыты правами или выключенным модулем.
    let body = get_json(connection, &client, "/api/broker/analytics/inflight-exchanges").await?;
    rows.extend(body.as_array().into_iter().flatten().map(|value| read_exchange(value, "broker")));

    if let Ok(body) = get_json(connection, &client, "/api/ws/domain/inflight-exchanges").await {
        rows.extend(body.as_array().into_iter().flatten().map(|value| read_exchange(value, "ws")));
    }

    // У REST список свой на каждый домен, поэтому сначала нужен их перечень.
    if let Ok(domains) = get_json(connection, &client, "/api/rest/domain").await {
        for domain in domains.as_array().into_iter().flatten() {
            let Some(guid) = text(domain, "guid") else { continue };
            let path = format!("/api/rest/domain/{guid}/inflight-exchanges");
            let Ok(body) = get_json(connection, &client, &path).await else { continue };
            let name = text(domain, "name").unwrap_or_else(|| guid.clone());
            for value in body.as_array().into_iter().flatten() {
                let mut item = read_exchange(value, "rest");
                // REST-домен сам себя в обмене не называет.
                if item.domain.is_empty() {
                    item.domain = name.clone();
                    item.domain_guid = guid.clone();
                }
                rows.push(item);
            }
        }
    }

    rows.sort_by(|a, b| b.duration.unwrap_or(0).cmp(&a.duration.unwrap_or(0)));
    Ok(rows)
}

/// Подробность, по которой обмен узнают в своём виде домена.
///
/// У REST это вызов целиком, у веб-сервиса — операция или точка; у брокера
/// такой подписи нет, там всё сказано шагом.
fn detail_of(value: &serde_json::Value) -> Option<String> {
    if let Some(url) = text(value, "url") {
        return Some(match text(value, "method") {
            Some(method) => format!("{method} {url}"),
            None => url,
        });
    }
    text(value, "operationName")
        .or_else(|| text(value, "endpointName"))
        .or_else(|| text(value, "to"))
        .or_else(|| text(value, "group"))
}

fn read_exchange(value: &serde_json::Value, kind: &str) -> InflightExchange {
    let source = value.get("source");
    let domain = source.and_then(|item| item.get("domain"));
    let route = source.and_then(|item| item.get("route"));

    InflightExchange {
        id: text(value, "exchangeId").unwrap_or_default(),
        kind: kind.to_string(),
        domain: domain.and_then(|item| text(item, "name")).unwrap_or_default(),
        domain_guid: domain.and_then(|item| text(item, "guid")).unwrap_or_default(),
        route: route
            .and_then(|item| text(item, "name"))
            .or_else(|| value.get("from").and_then(|item| text(item, "name")))
            .unwrap_or_default(),
        route_id: route
            .and_then(|item| text(item, "id"))
            .or_else(|| value.get("from").and_then(|item| text(item, "id")))
            .unwrap_or_default(),
        at: value.get("at").and_then(|item| text(item, "name")),
        node: value.get("node").and_then(|item| text(item, "name")),
        thread: value.get("thread").and_then(|item| text(item, "name")),
        detail: detail_of(value),
        duration: number(value, "duration"),
        elapsed: number(value, "elapsed"),
        interrupted: value.get("interrupted").and_then(serde_json::Value::as_bool).unwrap_or(false),
    }
}

fn text(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(String::from)
}

fn number(value: &serde_json::Value, field: &str) -> Option<u64> {
    value.get(field).and_then(|item| {
        item.as_u64().or_else(|| item.as_f64().map(|number| number.max(0.0) as u64))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_exchange_says_where_it_is_stuck() {
        let value = json!({
            "exchangeId": "ID-7f2c",
            "thread": { "id": 42, "name": "Camel (broker) thread #3" },
            "source": {
                "domain": { "guid": "domain-0472", "name": "1C.IS", "mode": "DEFAULT" },
                "route": { "id": "route-6d70", "name": "InterchangeAuthToken" },
            },
            "from": { "id": "route-6d70", "name": "InterchangeAuthToken" },
            "at": { "id": "route-98a1", "name": "Atlas.CallAPI" },
            "node": { "id": "node-11", "name": "Отправка в SAP" },
            "duration": 184_000,
            "elapsed": 61_000,
            "interrupted": false,
        });
        let row = read_exchange(&value, "broker");
        assert_eq!(row.id, "ID-7f2c");
        assert_eq!(row.kind, "broker");
        assert_eq!(row.domain, "1C.IS");
        assert_eq!(row.route, "InterchangeAuthToken");
        assert_eq!(row.at.as_deref(), Some("Atlas.CallAPI"));
        assert_eq!(row.node.as_deref(), Some("Отправка в SAP"));
        assert_eq!(row.duration, Some(184_000));
    }

    #[test]
    fn an_exchange_without_a_source_falls_back_to_the_route_it_came_from() {
        let value = json!({
            "exchangeId": "ID-1",
            "from": { "id": "route-1", "name": "Приём заявки" },
        });
        let row = read_exchange(&value, "broker");
        assert_eq!(row.route, "Приём заявки");
        assert_eq!(row.route_id, "route-1");
        assert_eq!(row.domain, "");
    }

    #[test]
    fn a_bare_exchange_does_not_break_the_reader() {
        let row = read_exchange(&json!({}), "broker");
        assert_eq!(row, InflightExchange { kind: "broker".into(), ..InflightExchange::default() });
    }

    #[test]
    fn empty_strings_from_the_bus_count_as_missing() {
        let value = json!({ "exchangeId": "  ", "node": { "name": "" } });
        let row = read_exchange(&value, "broker");
        assert_eq!(row.id, "");
        assert_eq!(row.node, None);
    }

    #[test]
    fn a_rest_exchange_is_named_by_the_call_it_is_serving() {
        let value = json!({ "exchangeId": "ID-2", "method": "POST", "url": "/users/42" });
        assert_eq!(read_exchange(&value, "rest").detail.as_deref(), Some("POST /users/42"));
        // Без метода остаётся один адрес — это всё ещё узнаваемо.
        assert_eq!(detail_of(&json!({ "url": "/users" })).as_deref(), Some("/users"));
    }

    #[test]
    fn a_web_service_exchange_is_named_by_its_operation() {
        let value = json!({ "exchangeId": "ID-3", "operationName": "GetBalance", "endpointName": "SoapPort" });
        assert_eq!(read_exchange(&value, "ws").detail.as_deref(), Some("GetBalance"));
        assert_eq!(detail_of(&json!({ "endpointName": "SoapPort" })).as_deref(), Some("SoapPort"));
    }

    #[test]
    fn a_broker_exchange_has_no_extra_name() {
        assert_eq!(detail_of(&json!({ "exchangeId": "ID-1" })), None);
    }

    #[test]
    fn the_uptime_is_read_whether_it_comes_as_a_string_or_a_number() {
        assert_eq!(text(&json!({ "uptime": "244623257" }), "uptime"), Some("244623257".into()));
        assert_eq!(number(&json!({ "uptime": 244_623_257u64 }), "uptime"), Some(244_623_257));
    }

    #[test]
    fn a_fractional_size_is_rounded_down_rather_than_dropped() {
        assert_eq!(number(&json!({ "used": 1024.7 }), "used"), Some(1024));
        assert_eq!(number(&json!({ "used": -5.0 }), "used"), Some(0));
    }
}
