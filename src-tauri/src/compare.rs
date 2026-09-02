//! Сравнение двух стендов.
//!
//! Вопрос «что у нас на тесте не так, как на бою» встаёт перед каждым
//! релизом, и до сих пор на него отвечали двумя окнами браузера. Стенд
//! рассказывает о себе тремя дешёвыми запросами — домены, все СОПС и
//! константы всех уровней, — поэтому сравнение не требует ни выгрузки
//! конфигурации, ни записи: только чтение.
//!
//! Сравнивается то, за что отвечает интегратор: состав доменов и СОПС,
//! трассировка и значения констант. Счётчики и состояния СОПС намеренно
//! оставлены в стороне: на тесте всё остановлено, на бою всё работает,
//! и такая «разница» была бы шумом в каждой строке.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::fesb_api::Connection;
use crate::fesb_ops;
use crate::routes_overview::{routes_overview, RouteSummary};

/// Уровень констант, как он выглядит в отчёте.
const APPLICATION: &str = "application";
const BROKER: &str = "broker";

/// Чем строка отличается. Названия совпадают с теми, что рисует интерфейс.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    /// Есть только на левом стенде.
    OnlyLeft,
    /// Есть только на правом.
    OnlyRight,
    /// Есть на обоих, но значения разные.
    Differs,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub side: Side,
    /// Домен или уровень констант — то, внутри чего лежит найденное.
    pub scope: String,
    /// Имя домена, СОПС или константы.
    pub name: String,
    /// Что на левом стенде: значение константы, объекты трассировки.
    pub left: Option<String>,
    pub right: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandFacts {
    pub url: String,
    pub version: Option<String>,
    pub domains: usize,
    pub routes: usize,
    pub properties: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub left: StandFacts,
    pub right: StandFacts,
    pub domains: Vec<DiffRow>,
    pub routes: Vec<DiffRow>,
    pub properties: Vec<DiffRow>,
    /// Скрытые значения: сервер их не отдаёт, сравнивать нечего.
    pub secured_skipped: usize,
}

/// Всё, что стенд рассказывает о себе для сравнения.
struct Facts {
    info: crate::fesb_api::ServerInfo,
    domains: Vec<crate::fesb_api::ApiDomain>,
    routes: Vec<RouteSummary>,
    properties: Vec<fesb_ops::SweepRow>,
}

async fn read(connection: &Connection) -> Result<Facts, String> {
    let info = crate::fesb_api::connect(connection).await?;
    let domains = crate::fesb_api::domains(connection).await?;
    let routes = routes_overview(connection).await?;
    let properties = fesb_ops::properties_sweep(connection, |_| {}).await?;
    Ok(Facts { info, domains, routes, properties })
}

pub async fn compare(left: &Connection, right: &Connection) -> Result<Comparison, String> {
    // Стенды опрашиваются одновременно: они друг о друге не знают, и ждать
    // второй, пока отвечает первый, незачем.
    let one = {
        let connection = left.clone();
        tauri::async_runtime::spawn(async move { read(&connection).await })
    };
    let two = {
        let connection = right.clone();
        tauri::async_runtime::spawn(async move { read(&connection).await })
    };
    let left_facts = one
        .await
        .map_err(|err| format!("Comparison interrupted: {err}"))?
        .map_err(|err| format!("Left stand: {err}"))?;
    let right_facts = two
        .await
        .map_err(|err| format!("Comparison interrupted: {err}"))?
        .map_err(|err| format!("Right stand: {err}"))?;

    let (properties, secured_skipped) =
        diff_properties(&left_facts.properties, &right_facts.properties);

    Ok(Comparison {
        left: facts_of(&left_facts),
        right: facts_of(&right_facts),
        domains: diff_domains(&left_facts.domains, &right_facts.domains),
        routes: diff_routes(&left_facts.routes, &right_facts.routes),
        properties,
        secured_skipped,
    })
}

fn facts_of(facts: &Facts) -> StandFacts {
    StandFacts {
        url: facts.info.base_url.clone(),
        version: facts.info.api_version.clone(),
        domains: facts.domains.len(),
        routes: facts.routes.len(),
        properties: facts.properties.len(),
    }
}

/// Домены сравниваются по имени, а не по guid.
///
/// Guid переживает перенос домена архивом, но не пересоздание руками, —
/// а разговаривают о доменах всё равно по именам.
fn diff_domains(left: &[crate::fesb_api::ApiDomain], right: &[crate::fesb_api::ApiDomain]) -> Vec<DiffRow> {
    let here: BTreeSet<&str> = left.iter().map(|d| d.name.as_str()).collect();
    let there: BTreeSet<&str> = right.iter().map(|d| d.name.as_str()).collect();

    let mut rows = Vec::new();
    for name in here.difference(&there) {
        rows.push(DiffRow {
            side: Side::OnlyLeft,
            scope: String::new(),
            name: (*name).to_string(),
            left: None,
            right: None,
        });
    }
    for name in there.difference(&here) {
        rows.push(DiffRow {
            side: Side::OnlyRight,
            scope: String::new(),
            name: (*name).to_string(),
            left: None,
            right: None,
        });
    }
    rows.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    rows
}

/// СОПС сравниваются по паре «домен и имя», а различие — по трассировке.
fn diff_routes(left: &[RouteSummary], right: &[RouteSummary]) -> Vec<DiffRow> {
    let here = route_map(left);
    let there = route_map(right);

    let mut rows = Vec::new();
    for (key, trace) in &here {
        match there.get(key) {
            None => rows.push(route_row(Side::OnlyLeft, key, Some(trace.clone()), None)),
            Some(other) if other != trace => {
                rows.push(route_row(Side::Differs, key, Some(trace.clone()), Some(other.clone())))
            }
            Some(_) => {}
        }
    }
    for (key, trace) in &there {
        if !here.contains_key(key) {
            rows.push(route_row(Side::OnlyRight, key, None, Some(trace.clone())));
        }
    }
    rows.sort_by(|a, b| {
        a.scope
            .to_lowercase()
            .cmp(&b.scope.to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    rows
}

/// Трассировка СОПС одной строкой: её и показываем, и по ней же сравниваем.
fn route_map(routes: &[RouteSummary]) -> BTreeMap<(String, String), String> {
    routes
        .iter()
        .map(|route| {
            let trace = if route.trace_beans.is_empty() {
                if route.trace {
                    // Трассировка включена, а объект не назван: работает
                    // умолчание домена. Это не то же самое, что её отсутствие.
                    "on".to_string()
                } else {
                    "off".to_string()
                }
            } else {
                route.trace_beans.join(", ")
            };
            ((route.domain.clone(), route.name.clone()), trace)
        })
        .collect()
}

fn route_row(side: Side, key: &(String, String), left: Option<String>, right: Option<String>) -> DiffRow {
    DiffRow { side, scope: key.0.clone(), name: key.1.clone(), left, right }
}

/// Константы сравниваются по паре «уровень и имя».
///
/// Уровень домена — это его имя, а не guid: guid у одной и той же по смыслу
/// конфигурации на двух стендах разный, и по нему всё сошлось бы в «только
/// здесь» и «только там».
fn diff_properties(left: &[fesb_ops::SweepRow], right: &[fesb_ops::SweepRow]) -> (Vec<DiffRow>, usize) {
    let mut skipped = 0;
    let here = property_map(left, &mut skipped);
    let there = property_map(right, &mut skipped);

    let mut rows = Vec::new();
    for (key, value) in &here {
        match there.get(key) {
            None => rows.push(property_row(Side::OnlyLeft, key, Some(value.clone()), None)),
            Some(other) if other != value => {
                rows.push(property_row(Side::Differs, key, Some(value.clone()), Some(other.clone())))
            }
            Some(_) => {}
        }
    }
    for (key, value) in &there {
        if !here.contains_key(key) {
            rows.push(property_row(Side::OnlyRight, key, None, Some(value.clone())));
        }
    }
    rows.sort_by(|a, b| {
        a.scope
            .to_lowercase()
            .cmp(&b.scope.to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    (rows, skipped)
}

fn property_map(rows: &[fesb_ops::SweepRow], skipped: &mut usize) -> BTreeMap<(String, String), String> {
    let mut map = BTreeMap::new();
    for row in rows {
        // Скрытое значение сервер не отдаёт: сравнивать было бы нечего,
        // а показать «разное» там, где мы просто не видим, — обман.
        if row.property.secured {
            *skipped += 1;
            continue;
        }
        let scope = match row.scope.as_str() {
            APPLICATION => APPLICATION.to_string(),
            BROKER => BROKER.to_string(),
            _ => row.domain.clone().unwrap_or_else(|| row.scope.clone()),
        };
        map.insert(
            (scope, row.property.key.clone()),
            row.property.value.clone().unwrap_or_default(),
        );
    }
    map
}

fn property_row(side: Side, key: &(String, String), left: Option<String>, right: Option<String>) -> DiffRow {
    DiffRow { side, scope: key.0.clone(), name: key.1.clone(), left, right }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(domain: &str, name: &str, trace: bool, beans: &[&str]) -> RouteSummary {
        RouteSummary {
            id: format!("{domain}/{name}"),
            name: name.into(),
            domain: domain.into(),
            domain_guid: domain.into(),
            state: "Stopped".into(),
            trace,
            trace_beans: beans.iter().map(|b| (*b).to_string()).collect(),
            processed: 0,
            failed: 0,
            failures_handled: 0,
            inflight: 0,
            min_ms: None,
            mean_ms: None,
            max_ms: None,
            last_processed: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn trace_on_by_default_is_not_trace_off() {
        let map = route_map(&[route("D", "R", true, &[])]);
        assert_eq!(map.get(&("D".into(), "R".into())).map(String::as_str), Some("on"));
        let off = route_map(&[route("D", "R", false, &[])]);
        assert_eq!(off.get(&("D".into(), "R".into())).map(String::as_str), Some("off"));
    }

    fn domain(name: &str) -> crate::fesb_api::ApiDomain {
        serde_json::from_value(serde_json::json!({ "guid": format!("guid-{name}"), "name": name })).unwrap()
    }

    fn property(scope: &str, domain: Option<&str>, key: &str, value: &str, secured: bool) -> fesb_ops::SweepRow {
        fesb_ops::SweepRow {
            scope: scope.into(),
            domain: domain.map(str::to_string),
            property: fesb_ops::PropertyRow {
                key: key.into(),
                value: Some(value.into()),
                secured,
                vault: false,
                empty: value.is_empty(),
                description: None,
            },
        }
    }

    #[test]
    fn domains_are_matched_by_name() {
        let rows = diff_domains(&[domain("A"), domain("B")], &[domain("B"), domain("C")]);
        let names: Vec<_> = rows.iter().map(|r| (r.side, r.name.as_str())).collect();
        assert_eq!(names, vec![(Side::OnlyLeft, "A"), (Side::OnlyRight, "C")]);
    }

    #[test]
    fn a_route_with_other_tracing_is_a_difference() {
        let rows = diff_routes(
            &[route("D", "R", true, &["TraceToQueue"]), route("D", "Same", false, &[])],
            &[route("D", "R", true, &["MC.Trace"]), route("D", "Same", false, &[])],
        );
        assert_eq!(rows.len(), 1, "одинаковые СОПС в разницу попадать не должны");
        assert_eq!(rows[0].side, Side::Differs);
        assert_eq!(rows[0].left.as_deref(), Some("TraceToQueue"));
        assert_eq!(rows[0].right.as_deref(), Some("MC.Trace"));
    }

    /// Guid одного и того же по смыслу домена на двух стендах разный,
    /// поэтому уровень констант — имя домена.
    #[test]
    fn domain_properties_are_matched_by_domain_name() {
        let (rows, _) = diff_properties(
            &[property("guid-here", Some("Orders"), "const.url", "http://a", false)],
            &[property("guid-there", Some("Orders"), "const.url", "http://b", false)],
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].side, Side::Differs);
        assert_eq!(rows[0].scope, "Orders");
    }

    #[test]
    fn hidden_values_are_counted_not_compared() {
        let (rows, skipped) = diff_properties(
            &[property("application", None, "secret", "", true)],
            &[property("application", None, "secret", "", true)],
        );
        assert!(rows.is_empty());
        assert_eq!(skipped, 2, "по одному пропуску с каждой стороны");
    }

    #[test]
    fn a_named_bean_is_the_comparison_value() {
        let map = route_map(&[route("D", "R", true, &["TraceToQueue", "MC.TRACE"])]);
        assert_eq!(
            map.get(&("D".into(), "R".into())).map(String::as_str),
            Some("TraceToQueue, MC.TRACE"),
        );
    }
}

