//! Сравнение двух стендов.
//!
//! Вопрос «что у нас на тесте не так, как на продуктиве» встаёт перед каждым
//! релизом, и до сих пор на него отвечали двумя окнами браузера. Стенд
//! рассказывает о себе тремя дешёвыми запросами — домены, все СОПС и
//! константы всех уровней, — поэтому сравнение не требует ни выгрузки
//! конфигурации, ни записи: только чтение.
//!
//! Сравнивается то, за что отвечает интегратор: состав доменов и СОПС,
//! трассировка и значения констант. Счётчики и состояния СОПС намеренно
//! оставлены в стороне: на тесте всё остановлено, на продуктиве всё работает,
//! и такая «разница» была бы шумом в каждой строке.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Одна сравниваемая единица: СОПС в домене или константа на уровне.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    /// Домен у СОПС, уровень у константы.
    pub scope: String,
    pub name: String,
    /// Трассировка у СОПС, значение у константы.
    pub value: String,
}

/// Стенд в том виде, в котором его сравнивают.
///
/// Всё, что не участвует в сравнении, — счётчики, состояния, guid — сюда
/// не попадает. Поэтому слепок и годится для хранения: снимок стенда —
/// это он же, положенный на диск, и сравнивается он тем же кодом, что
/// и живой стенд.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub facts: StandFacts,
    pub domains: Vec<String>,
    pub routes: Vec<Fact>,
    pub properties: Vec<Fact>,
    /// Скрытых констант — их значения сервер не отдаёт.
    pub secured: usize,
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

/// Читает стенд и сразу сводит к слепку.
pub async fn read_profile(connection: &Connection) -> Result<Profile, String> {
    Ok(profile_of(&read(connection).await?))
}

fn profile_of(facts: &Facts) -> Profile {
    let (properties, secured) = property_facts(&facts.properties);
    Profile {
        facts: StandFacts {
            url: facts.info.base_url.clone(),
            version: facts.info.api_version.clone(),
            domains: facts.domains.len(),
            routes: facts.routes.len(),
            properties: facts.properties.len(),
        },
        domains: facts.domains.iter().map(|domain| domain.name.clone()).collect(),
        routes: route_facts(&facts.routes),
        properties,
        secured,
    }
}

pub async fn compare(left: &Connection, right: &Connection) -> Result<Comparison, String> {
    // Стенды опрашиваются одновременно: они друг о друге не знают, и ждать
    // второй, пока отвечает первый, незачем.
    let one = {
        let connection = left.clone();
        tauri::async_runtime::spawn(async move { read_profile(&connection).await })
    };
    let two = {
        let connection = right.clone();
        tauri::async_runtime::spawn(async move { read_profile(&connection).await })
    };
    let left_profile = one
        .await
        .map_err(|err| format!("Comparison interrupted: {err}"))?
        .map_err(|err| format!("Left stand: {err}"))?;
    let right_profile = two
        .await
        .map_err(|err| format!("Comparison interrupted: {err}"))?
        .map_err(|err| format!("Right stand: {err}"))?;
    Ok(diff(&left_profile, &right_profile))
}

/// Разница двух слепков — живых стендов, снимков или того и другого.
pub fn diff(left: &Profile, right: &Profile) -> Comparison {
    Comparison {
        left: left.facts.clone(),
        right: right.facts.clone(),
        domains: diff_domains(&left.domains, &right.domains),
        routes: diff_facts(&left.routes, &right.routes),
        properties: diff_facts(&left.properties, &right.properties),
        secured_skipped: left.secured + right.secured,
    }
}

/// Домены сравниваются по имени, а не по guid.
///
/// Guid переживает перенос домена архивом, но не пересоздание руками, —
/// а разговаривают о доменах всё равно по именам.
fn diff_domains(left: &[String], right: &[String]) -> Vec<DiffRow> {
    let here: BTreeSet<&str> = left.iter().map(String::as_str).collect();
    let there: BTreeSet<&str> = right.iter().map(String::as_str).collect();

    let mut rows = Vec::new();
    for name in here.difference(&there) {
        rows.push(DiffRow { side: Side::OnlyLeft, scope: String::new(), name: (*name).to_string(), left: None, right: None });
    }
    for name in there.difference(&here) {
        rows.push(DiffRow { side: Side::OnlyRight, scope: String::new(), name: (*name).to_string(), left: None, right: None });
    }
    rows.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    rows
}

/// СОПС и константы сравниваются одинаково: по паре «где и что», а
/// различие — по значению.
fn diff_facts(left: &[Fact], right: &[Fact]) -> Vec<DiffRow> {
    let map = |facts: &[Fact]| -> BTreeMap<(String, String), String> {
        facts.iter().map(|fact| ((fact.scope.clone(), fact.name.clone()), fact.value.clone())).collect()
    };
    let here = map(left);
    let there = map(right);

    let mut rows = Vec::new();
    for (key, value) in &here {
        match there.get(key) {
            None => rows.push(row(Side::OnlyLeft, key, Some(value.clone()), None)),
            Some(other) if other != value => rows.push(row(Side::Differs, key, Some(value.clone()), Some(other.clone()))),
            Some(_) => {}
        }
    }
    for (key, value) in &there {
        if !here.contains_key(key) {
            rows.push(row(Side::OnlyRight, key, None, Some(value.clone())));
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

fn row(side: Side, key: &(String, String), left: Option<String>, right: Option<String>) -> DiffRow {
    DiffRow { side, scope: key.0.clone(), name: key.1.clone(), left, right }
}

/// Трассировка СОПС одной строкой: её и показываем, и по ней же сравниваем.
fn route_facts(routes: &[RouteSummary]) -> Vec<Fact> {
    routes
        .iter()
        .map(|route| {
            let value = if route.trace_beans.is_empty() {
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
            Fact { scope: route.domain.clone(), name: route.name.clone(), value }
        })
        .collect()
}

/// Константы — по паре «уровень и имя».
///
/// Уровень домена — это его имя, а не guid: guid у одной и той же по смыслу
/// конфигурации на двух стендах разный, и по нему всё сошлось бы в «только
/// здесь» и «только там». Скрытые значения не берутся — только считаются.
fn property_facts(rows: &[fesb_ops::SweepRow]) -> (Vec<Fact>, usize) {
    let mut secured = 0;
    let mut facts = Vec::new();
    for row in rows {
        // Скрытое значение сервер не отдаёт: сравнивать было бы нечего,
        // а показать «разное» там, где мы просто не видим, — обман.
        if row.property.secured {
            secured += 1;
            continue;
        }
        let scope = match row.scope.as_str() {
            APPLICATION => APPLICATION.to_string(),
            BROKER => BROKER.to_string(),
            _ => row.domain.clone().unwrap_or_else(|| row.scope.clone()),
        };
        facts.push(Fact { scope, name: row.property.key.clone(), value: row.property.value.clone().unwrap_or_default() });
    }
    (facts, secured)
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
        assert_eq!(route_facts(&[route("D", "R", true, &[])])[0].value, "on");
        assert_eq!(route_facts(&[route("D", "R", false, &[])])[0].value, "off");
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
        let names = |list: &[crate::fesb_api::ApiDomain]| list.iter().map(|d| d.name.clone()).collect::<Vec<_>>();
        let rows = diff_domains(&names(&[domain("A"), domain("B")]), &names(&[domain("B"), domain("C")]));
        let names: Vec<_> = rows.iter().map(|r| (r.side, r.name.as_str())).collect();
        assert_eq!(names, vec![(Side::OnlyLeft, "A"), (Side::OnlyRight, "C")]);
    }

    #[test]
    fn a_route_with_other_tracing_is_a_difference() {
        let rows = diff_facts(
            &route_facts(&[route("D", "R", true, &["TraceToQueue"]), route("D", "Same", false, &[])]),
            &route_facts(&[route("D", "R", true, &["MC.Trace"]), route("D", "Same", false, &[])]),
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
        let rows = diff_facts(
            &property_facts(&[property("guid-here", Some("Orders"), "const.url", "http://a", false)]).0,
            &property_facts(&[property("guid-there", Some("Orders"), "const.url", "http://b", false)]).0,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].side, Side::Differs);
        assert_eq!(rows[0].scope, "Orders");
    }

    #[test]
    fn hidden_values_are_counted_not_compared() {
        let (left, left_secured) = property_facts(&[property("application", None, "secret", "", true)]);
        let (right, right_secured) = property_facts(&[property("application", None, "secret", "", true)]);
        assert!(diff_facts(&left, &right).is_empty());
        assert_eq!(left_secured + right_secured, 2, "по одному пропуску с каждой стороны");
    }

    #[test]
    fn a_named_bean_is_the_comparison_value() {
        assert_eq!(route_facts(&[route("D", "R", true, &["TraceToQueue", "MC.TRACE"])])[0].value, "TraceToQueue, MC.TRACE");
    }
}

