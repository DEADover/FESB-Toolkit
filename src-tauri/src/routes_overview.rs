//! Все СОПС сервера одним списком.
//!
//! Долгое время в проекте было записано, что лёгкого способа спросить у шины
//! состав СОПС нет: `/api/broker/routes` отдаёт только запущенные, а на
//! остановленном домене это пустота. Вывод был верен — но для **того**
//! метода. Рядом лежат два других, которые тогда не проверили:
//!
//! * `/api/broker/routes/allRoutesNames` — имя, домен и состояние;
//! * `/api/broker/routes/all` — то же плюс счётчики, времена обработки
//!   и, главное для этого инструмента, состояние трассировки.
//!
//! Оба отдают и остановленные. На стенде из 255 доменов это 2293 СОПС
//! за две десятых секунды — вместо полутора минут, которые уходили
//! на выкачивание всей конфигурации ради тех же имён.
//!
//! Отсюда и берётся ответ на главный вопрос инструмента: **где какая
//! трассировка на всём сервере**. Раньше он стоил полной выгрузки.

use serde::Serialize;

use crate::fesb_api::{get_json, Connection};

/// СОПС в том виде, в каком его показывает обзор.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RouteSummary {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub domain_guid: String,
    /// `Started`, `Stopped` — как их называет сама шина.
    pub state: String,
    pub trace: bool,
    /// Объекты трассировки этого СОПС: шина склеивает их через запятую.
    pub trace_beans: Vec<String>,
    pub processed: i64,
    pub failed: i64,
    pub failures_handled: i64,
    pub inflight: i64,
    pub min_ms: Option<i64>,
    pub mean_ms: Option<i64>,
    pub max_ms: Option<i64>,
    pub last_processed: Option<String>,
    /// Метки СОПС: `Start`, `NotReady` и заведённые на стенде.
    pub tags: Vec<String>,
}

/// Читает все СОПС сервера одним запросом.
pub async fn routes_overview(connection: &Connection) -> Result<Vec<RouteSummary>, String> {
    let client = connection.client()?;
    let body = get_json(connection, &client, "/api/broker/routes/all").await?;

    let mut rows: Vec<RouteSummary> = body.as_array().into_iter().flatten().map(read_route).collect();
    rows.sort_by(|a, b| {
        a.domain
            .to_lowercase()
            .cmp(&b.domain.to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(rows)
}

fn read_route(value: &serde_json::Value) -> RouteSummary {
    let domain = value.get("domain");
    RouteSummary {
        id: text(value, "id").unwrap_or_default(),
        name: text(value, "name").unwrap_or_default(),
        domain: domain.and_then(|item| text(item, "name")).unwrap_or_default(),
        domain_guid: domain.and_then(|item| text(item, "guid")).unwrap_or_default(),
        state: text(value, "routeState").unwrap_or_default(),
        trace: value.get("trace").and_then(serde_json::Value::as_bool).unwrap_or(false),
        trace_beans: beans_of(text(value, "traceConfig").as_deref()),
        processed: number(value, "processedQty").unwrap_or(0),
        failed: number(value, "failed").unwrap_or(0),
        failures_handled: number(value, "failuresHandled").unwrap_or(0),
        inflight: number(value, "exchangesInflight").unwrap_or(0),
        min_ms: number(value, "minProcessingTime"),
        mean_ms: number(value, "meanProcessingTime"),
        max_ms: number(value, "maxProcessingTime"),
        last_processed: text(value, "lastProcessed"),
        tags: value
            .get("tags")
            .and_then(|item| item.as_array())
            .map(|list| list.iter().filter_map(as_text).collect())
            .unwrap_or_default(),
    }
}

/// Разбирает `traceConfig` на объекты трассировки.
///
/// Шина склеивает их запятой: `TraceToQueue,MC.TRACE`. Пустая строка и `null`
/// значат одно и то же — трассировки нет, — и списком это пустота, а не
/// строка из ничего.
pub fn beans_of(config: Option<&str>) -> Vec<String> {
    config
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(String::from)
        .collect()
}

fn text(value: &serde_json::Value, field: &str) -> Option<String> {
    value.get(field).and_then(as_text)
}

fn as_text(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|item| !item.is_empty()).map(String::from)
}

fn number(value: &serde_json::Value, field: &str) -> Option<i64> {
    value.get(field).and_then(|item| item.as_i64().or_else(|| item.as_f64().map(|n| n as i64)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_route_brings_its_domain_state_and_tracing() {
        let value = json!({
            "id": "route-6d70",
            "name": "InterchangeAuthToken",
            "domain": { "guid": "domain-0472", "name": "1C.IS" },
            "routeState": "Started",
            "trace": true,
            "traceConfig": "TraceToQueue",
            "processedQty": 128400,
            "failed": 17,
            "failuresHandled": 3,
            "exchangesInflight": 2,
            "minProcessingTime": 4,
            "meanProcessingTime": 11,
            "maxProcessingTime": 940,
            "lastProcessed": "2026-08-28T10:15:00",
            "tags": ["Start"],
        });
        let row = read_route(&value);
        assert_eq!(row.domain, "1C.IS");
        assert_eq!(row.state, "Started");
        assert!(row.trace);
        assert_eq!(row.trace_beans, vec!["TraceToQueue"]);
        assert_eq!(row.processed, 128_400);
        assert_eq!(row.inflight, 2);
        assert_eq!(row.tags, vec!["Start"]);
    }

    #[test]
    fn several_trace_objects_come_glued_by_a_comma() {
        assert_eq!(beans_of(Some("TraceToQueue,MC.TRACE")), vec!["TraceToQueue", "MC.TRACE"]);
        assert_eq!(beans_of(Some("TraceToQueue, conf.trace.General")), vec!["TraceToQueue", "conf.trace.General"]);
    }

    #[test]
    fn no_tracing_is_an_empty_list_rather_than_a_row_of_nothing() {
        assert!(beans_of(None).is_empty());
        assert!(beans_of(Some("")).is_empty());
        assert!(beans_of(Some(" , ")).is_empty());
    }

    #[test]
    fn a_route_the_bus_says_nothing_about_does_not_break_the_reader() {
        let row = read_route(&json!({}));
        assert_eq!(row, RouteSummary::default());
        assert!(!row.trace);
    }

    #[test]
    fn counters_survive_arriving_as_fractions() {
        let row = read_route(&json!({ "meanProcessingTime": 11.7, "processedQty": 5.0 }));
        assert_eq!(row.mean_ms, Some(11));
        assert_eq!(row.processed, 5);
    }
}
