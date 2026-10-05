//! Трассировка самих СОПС: включить, выключить, сменить объект трассировки.
//!
//! СОПС сохраняется тем же путём, что и кнопкой «Сохранить» в редакторе FESB:
//! прочитать модель (`GET …/route/{id}`), поменять в ней `trace`
//! и `traceConfig`, отдать обратно (`saveRoute`). Изменение вступает в силу
//! сразу и без перезапуска домена, а в истории СОПС остаётся комментарий.
//! Работающий СОПС шина при этом перезапускает — его счётчики обнуляются.
//!
//! Проверки ревизии у `saveRoute` нет: устаревшая модель сохраняется молча
//! и затирает чужую правку. Поэтому модель читается прямо перед сохранением,
//! а не берётся из списка, открытого минуты назад.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fesb_api::{ensure_ok, get_json, transport_error, Connection};

/// Что поменять. Пустое поле — не трогать.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTraceChange {
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Объекты трассировки через запятую; пустая строка — «по умолчанию
    /// домена»: атрибут `factor-trace-config` из СОПС тогда убирается.
    #[serde(default)]
    pub config: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceState {
    pub trace: bool,
    pub config: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTraceResult {
    /// `changed` — сохранено, `unchanged` — всё уже было так.
    pub status: &'static str,
    pub before: TraceState,
    pub after: TraceState,
}

fn state_of(model: &Value) -> TraceState {
    let config = model
        .get("traceConfig")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    TraceState { trace: model.get("trace").and_then(Value::as_bool).unwrap_or(false), config }
}

/// Каким станет СОПС после правки.
pub fn apply(before: &TraceState, change: &RouteTraceChange) -> TraceState {
    let config = match &change.config {
        None => before.config.clone(),
        Some(names) => {
            let joined = names.split(',').map(str::trim).filter(|name| !name.is_empty()).collect::<Vec<_>>().join(",");
            (!joined.is_empty()).then_some(joined)
        }
    };
    TraceState { trace: change.enabled.unwrap_or(before.trace), config }
}

/// Комментарий в истории СОПС — по нему видно, откуда правка.
pub fn comment_for(change: &RouteTraceChange) -> String {
    let mut parts = Vec::new();
    match change.enabled {
        Some(true) => parts.push("трассировка включена".to_string()),
        Some(false) => parts.push("трассировка выключена".to_string()),
        None => {}
    }
    match change.config.as_deref().map(str::trim) {
        Some("") => parts.push("объект трассировки — по умолчанию домена".to_string()),
        Some(names) => parts.push(format!("объект трассировки — {names}")),
        None => {}
    }
    format!("FESB Toolkit: {}", parts.join(", "))
}

/// Трассировка СОПС, как она стоит на сервере сейчас.
pub async fn current_state(connection: &Connection, domain: &str, route: &str) -> Result<TraceState, String> {
    let client = connection.client()?;
    let model = get_json(connection, &client, &format!("/api/broker/domain/{domain}/route/{route}")).await?;
    Ok(state_of(&model))
}

/// Сохраняет трассировку СОПС. `comment` — своя строка для истории СОПС;
/// без неё комментарий складывается из самой правки.
pub async fn set_route_trace(
    connection: &Connection,
    domain: &str,
    route: &str,
    change: &RouteTraceChange,
    comment: Option<&str>,
) -> Result<RouteTraceResult, String> {
    if change.enabled.is_none() && change.config.is_none() {
        return Err("Nothing to change".into());
    }
    let client = connection.client()?;
    let mut model = get_json(connection, &client, &format!("/api/broker/domain/{domain}/route/{route}")).await?;
    let before = state_of(&model);
    let after = apply(&before, change);
    if after == before {
        return Ok(RouteTraceResult { status: "unchanged", before, after });
    }

    let object = model.as_object_mut().ok_or("Unexpected route model")?;
    object.insert("trace".into(), Value::Bool(after.trace));
    object.insert("traceConfig".into(), after.config.clone().map(Value::String).unwrap_or(Value::Null));

    let comment = comment.map(str::to_string).unwrap_or_else(|| comment_for(change));
    let body = serde_json::json!({ "data": model, "comment": comment });
    let response = connection
        .post(&client, &format!("/api/broker/domain/{domain}/route/saveRoute"))
        .timeout(Duration::from_secs(120))
        .json(&body)
        .send()
        .await
        .map_err(transport_error)?;
    let saved: Value = ensure_ok(response, "Cannot save the route")
        .await?
        .json()
        .await
        .map_err(|err| format!("Unexpected answer: {err}"))?;

    // Шина отвечает сохранённой моделью — сверяемся с ней, а не с запросом.
    let stored = state_of(&saved);
    if stored != after {
        return Err(format!(
            "The bus stored trace={} config={} instead of trace={} config={}",
            stored.trace,
            stored.config.as_deref().unwrap_or("—"),
            after.trace,
            after.config.as_deref().unwrap_or("—"),
        ));
    }
    Ok(RouteTraceResult { status: "changed", before, after })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(trace: bool, config: Option<&str>) -> TraceState {
        TraceState { trace, config: config.map(str::to_string) }
    }

    #[test]
    fn switching_trace_keeps_the_object() {
        let change = RouteTraceChange { enabled: Some(true), config: None };
        assert_eq!(apply(&state(false, Some("TraceToQueue")), &change), state(true, Some("TraceToQueue")));
    }

    #[test]
    fn an_empty_object_means_the_domain_default() {
        let change = RouteTraceChange { enabled: None, config: Some(" ".into()) };
        assert_eq!(apply(&state(true, Some("TraceToQueue")), &change), state(true, None));
    }

    #[test]
    fn several_objects_are_joined_like_the_bus_does() {
        let change = RouteTraceChange { enabled: None, config: Some("TraceToQueue, MC.TRACE".into()) };
        assert_eq!(apply(&state(true, None), &change).config.as_deref(), Some("TraceToQueue,MC.TRACE"));
    }

    #[test]
    fn the_model_is_read_as_the_bus_writes_it() {
        let model = serde_json::json!({ "trace": true, "traceConfig": "" });
        assert_eq!(state_of(&model), state(true, None));
    }

    #[test]
    fn the_history_says_what_was_done() {
        let change = RouteTraceChange { enabled: Some(false), config: Some("MC.TRACE".into()) };
        assert_eq!(comment_for(&change), "FESB Toolkit: трассировка выключена, объект трассировки — MC.TRACE");
    }
}
