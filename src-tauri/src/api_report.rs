//! Отчёт по внешним точкам входа и выхода всех СОПС сервера.
//!
//! Вопрос, ради которого он нужен, звучит так: «через какие адреса шина
//! разговаривает с внешним миром и как эти адреса защищены». Ответ собирается
//! из трёх мест, потому что в одном его нет:
//!
//! * сами СОПС — откуда сообщение приходит (`from`) и куда уходит (`to`);
//! * фабрики Jetty домена — порт, TLS, шифры и авторизация входящих;
//! * `jetty_usage` — состояние пулов потоков по портам.
//!
//! Внутренние адреса (`direct`, `localmq`, таймеры) в отчёт не попадают:
//! они никуда наружу не смотрят, а список раздувают вдвое.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::fesb_api::Connection;

/// Схемы, которые точкой входа или выхода не являются.
///
/// Две группы. Первая — внутренняя доставка и служебное: сообщение не покидает
/// шину. Вторая — преобразователи и проверки: `xslt-saxon`, `json-validator`
/// и им подобные стоят в СОПС как обычные шаги с адресом, но никуда не ходят,
/// а в отчёт добавляли треть строк ни о чём.
const NOT_A_POINT: [&str; 30] = [
    // никуда не уходит
    "direct", "direct-vm", "fesb-direct", "fesb-direct-vm", "seda", "vm", "localmq", "log", "mock",
    "bean", "class", "controlbus", "timer", "quartz", "scheduler", "stub", "dataset",
    // преобразует и проверяет
    "xslt", "xslt-saxon", "xj", "json-validator", "validator", "dozer", "atlasmap", "ehcache",
    "velocity", "freemarker", "jsonpath", "xquery", "string-template",
];

/// Параметры адреса, значения которых в отчёт попадать не должны.
const SECRETS: [&str; 8] = [
    "password", "passwd", "pass", "secret", "privatekey", "publickey", "token", "authtoken",
];

/// Шаги, чей адрес считается исходящей точкой.
const OUTGOING: [&str; 6] = ["to", "toD", "wireTap", "recipientList", "pollEnrich", "enrich"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub domain: String,
    pub domain_guid: String,
    /// Имя СОПС из редактора, а если его нет — идентификатор маршрута.
    pub route: String,
    pub route_id: String,
    /// Подпись шага: `customName` в терминах API, `factor-name` в файле.
    pub component: String,
    /// `in` — точка входа, `out` — точка выхода.
    pub direction: &'static str,
    /// Что это за точка: HTTP, SOAP, FTP, SQL… — по схеме адреса.
    pub kind: String,
    pub scheme: String,
    pub uri: String,
    pub host: Option<String>,
    pub port: Option<u32>,
    /// Настроен ли TLS. `None` — сведений нет, а не «нет».
    pub ssl: Option<bool>,
    pub protocol: Option<String>,
    pub ciphers: Option<String>,
    pub auth: Option<String>,
    /// Состояние пула Jetty на этом порту: работает или порт не слушают.
    pub state: Option<String>,
    /// Время непрерывной работы. Ни один метод шины его не отдаёт, поэтому
    /// колонка есть, а значения нет: пустая ячейка честнее выдуманной.
    pub uptime: Option<String>,
    /// Пул потоков Jetty на порту — вся восьмёрка счётчиков из `jetty_usage`.
    pub busy_threads: Option<i64>,
    pub utilized_threads: Option<i64>,
    pub ready_threads: Option<i64>,
    pub min_threads: Option<i64>,
    pub max_threads: Option<i64>,
    pub queue_size: Option<i64>,
    pub idle_timeout: Option<i64>,
    pub idle_threads: Option<i64>,
}

/// Сведения о порте: собираются один раз на сервер и раздаются точкам.
#[derive(Debug, Clone, Default)]
pub struct PortFacts {
    pub ssl: Option<bool>,
    pub protocol: Option<String>,
    pub ciphers: Option<String>,
    pub auth: Option<String>,
    pub state: Option<String>,
    pub busy_threads: Option<i64>,
    pub utilized_threads: Option<i64>,
    pub ready_threads: Option<i64>,
    pub min_threads: Option<i64>,
    pub max_threads: Option<i64>,
    pub queue_size: Option<i64>,
    pub idle_timeout: Option<i64>,
    pub idle_threads: Option<i64>,
}

/// Схемы, у которых после `://` действительно стоит сетевой адрес.
///
/// У остальных адаптеров там имя ресурса: `eik-is://InterchangeAuthToken`
/// — это не хост, и складывать такие имена в колонку «хост» значит
/// придумать полсотни несуществующих систем.
const NETWORK: [&str; 16] = [
    "http", "https", "http4", "https4", "jetty", "netty-http", "netty4-http", "servlet",
    "undertow", "ahc", "ftp", "ftps", "sftp", "smtp", "smtps", "cxf",
];

/// Параметры, в которых адаптеры прячут настоящий адрес вызова.
const ADDRESS_PARAMS: [&str; 5] = ["httpuri", "url", "uri", "host", "address"];

/// Разбирает адрес настолько, насколько это вообще возможно.
///
/// В адресах СОПС встречается и `{{const.url.system}}`, и вложенная схема
/// (`jetty://http://0.0.0.0:8085/in`), и имя ресурса вместо хоста. Разбор
/// нестрогий: что удалось узнать — вернули, остальное осталось пустым.
/// Пустой хост честнее выдуманного: по нему группируют отчёт.
pub fn split_uri(uri: &str) -> (String, Option<String>, Option<u32>) {
    let uri = uri.trim();
    let Some((scheme, rest)) = uri.split_once(':') else { return (String::new(), None, None) };
    let scheme = scheme.to_ascii_lowercase();
    let rest = rest.trim_start_matches('/');

    let (head, query) = match rest.split_once('?') {
        Some((head, query)) => (head, Some(query)),
        None => (rest, None),
    };

    // `jetty://http://0.0.0.0:8085/in` — снаружи адаптер, внутри настоящий адрес.
    // Искать вложенную схему нужно до знака вопроса: в параметрах `://`
    // встречается сплошь и рядом, и это уже другой случай.
    if head.contains("://") {
        let (_, host, port) = split_uri(head);
        return (scheme, host, port);
    }

    let authority = head.split('/').next().unwrap_or("");

    // Порт адаптеры пишут и параметром: `eik-is://…?port=8086`.
    let param = |names: &[&str]| -> Option<String> {
        query?.split('&').find_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            names.contains(&name.to_ascii_lowercase().as_str()).then(|| value.to_string())
        })
    };
    let port_from_query = param(&["port"]).and_then(|value| value.parse().ok());

    let (host, port) = if NETWORK.contains(&scheme.as_str()) && !authority.is_empty() {
        match authority.rsplit_once(':') {
            Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
                (Some(host.to_string()), port.parse().ok())
            }
            _ => (Some(authority.to_string()), None),
        }
    } else {
        // У адаптера настоящий адрес спрятан в параметре — если он там есть.
        match param(&ADDRESS_PARAMS) {
            Some(value) => {
                let (_, host, port) = split_uri(&value);
                (host, port)
            }
            None => (None, None),
        }
    };

    // Хост из константы разобрать нельзя, и притворяться не надо.
    let host = host.filter(|value| !value.contains("{{") && !value.contains("${") && !value.is_empty());
    (scheme, host, port.or(port_from_query))
}

/// Что это за точка: под каким протоколом её знает внешняя система.
///
/// Схема адреса называет адаптер Camel (`cxf`, `eik-xi`, `netty-http`),
/// а в отчёте нужен протокол — тот, о котором договариваются с соседней
/// системой. Всё, что не опознано, остаётся под своим именем: выдумывать
/// протокол за адаптер, которого мы не знаем, хуже, чем назвать его как есть.
pub fn point_kind(scheme: &str) -> String {
    match scheme {
        "cxf" | "cxfrs" | "cxfbean" => "SOAP",
        "http" | "https" | "http4" | "https4" | "jetty" | "netty-http" | "netty4-http"
        | "servlet" | "rest" | "undertow" | "ahc" => "HTTP",
        "ftp" | "ftps" | "sftp" => "FTP",
        "smtp" | "smtps" | "imap" | "imaps" | "pop3" => "MAIL",
        "sql" | "sql-stored" | "jdbc" | "jpa" | "mybatis" => "SQL",
        "file" => "FILE",
        "jms" | "activemq" | "amqp" | "kafka" | "rabbitmq" => "MQ",
        "eik-xi" | "eik-idoc" | "eik-rfc" | "eik-is" => "SAP",
        "eik-ed" => "EDI",
        other => return other.to_ascii_uppercase(),
    }
    .to_string()
}

/// Смотрит ли адрес наружу.
pub fn is_external(scheme: &str) -> bool {
    !scheme.is_empty() && !NOT_A_POINT.contains(&scheme)
}

/// Адрес в том виде, в каком его можно положить в отчёт.
///
/// Полный адрес читать невозможно: у `sql` в него уезжает весь запрос на
/// полторы тысячи символов, у адаптеров — десяток параметров подряд. Оставляем
/// схему с адресом и только те параметры, которые говорят, куда идёт вызов;
/// значения паролей и ключей заменяются, потому что отчёт уходит в переписку.
pub fn readable_uri(uri: &str) -> String {
    let (head, query) = match uri.split_once('?') {
        Some((head, query)) => (head, Some(query)),
        None => (uri, None),
    };

    // У `sql://` телом адреса идёт сам запрос — от него в отчёте толку нет.
    let head = if head.starts_with("sql:") || head.starts_with("sql-stored:") {
        head.split_once(':').map(|(scheme, _)| format!("{scheme}://")).unwrap_or_else(|| head.to_string())
    } else if head.chars().count() > 160 {
        let cut: String = head.chars().take(160).collect();
        format!("{cut}…")
    } else {
        head.to_string()
    };

    let Some(query) = query else { return head };
    let kept: Vec<String> = query
        .split('&')
        .filter_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            let lower = name.to_ascii_lowercase();
            if SECRETS.iter().any(|secret| lower.contains(secret)) {
                return Some(format!("{name}=***"));
            }
            // Куда идёт вызов и как называется интерфейс — это и есть точка.
            let useful = ["uri", "host", "port", "path", "url", "datasource", "interfacename",
                "receiversystem", "sendersystem", "queue", "topic", "address", "service"];
            useful.iter().any(|needle| lower.contains(needle)).then(|| {
                let trimmed: String = value.chars().take(80).collect();
                format!("{name}={trimmed}")
            })
        })
        .collect();

    if kept.is_empty() { head } else { format!("{head}?{}", kept.join("&")) }
}

/// Точки входа и выхода одного файла СОПС.
pub fn endpoints_of_route(xml: &str, domain: &str, domain_guid: &str) -> Vec<Endpoint> {
    let mut out = Vec::new();
    for graph in crate::route_graph::parse_route_graphs(xml) {
        let id = graph.id.clone().unwrap_or_default();
        let route = graph.name.clone().unwrap_or_else(|| id.clone());
        collect(&graph.nodes, &route, &id, domain, domain_guid, &mut out);
    }
    out
}

fn collect(
    nodes: &[crate::route_graph::RouteNode],
    route: &str,
    route_id: &str,
    domain: &str,
    domain_guid: &str,
    out: &mut Vec<Endpoint>,
) {
    for node in nodes {
        let direction = if node.kind == "from" {
            Some("in")
        } else if OUTGOING.contains(&node.kind.as_str()) {
            Some("out")
        } else {
            None
        };

        if let (Some(direction), Some(uri)) = (direction, node.uri.as_deref()) {
            let (scheme, host, port) = split_uri(uri);
            if is_external(&scheme) {
                out.push(Endpoint {
                    domain: domain.to_string(),
                    domain_guid: domain_guid.to_string(),
                    route: route.to_string(),
                    route_id: route_id.to_string(),
                    component: node.label.clone().unwrap_or_else(|| node.kind.clone()),
                    direction,
                    kind: point_kind(&scheme),
                    scheme,
                    uri: readable_uri(uri),
                    host,
                    port,
                    ssl: None,
                    protocol: None,
                    ciphers: None,
                    auth: None,
                    state: None,
                    uptime: None,
                    busy_threads: None,
                    utilized_threads: None,
                    ready_threads: None,
                    min_threads: None,
                    max_threads: None,
                    queue_size: None,
                    idle_timeout: None,
                    idle_threads: None,
                });
            }
        }
        collect(&node.children, route, route_id, domain, domain_guid, out);
    }
}

/// Точки всех СОПС домена, лежащего в распакованной папке.
pub fn endpoints_of_domain(dir: &Path, domain: &str, domain_guid: &str) -> Vec<Endpoint> {
    let Ok(entries) = fs::read_dir(dir.join("routes")) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_route = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("route-") && name.ends_with(".xml"));
        if !is_route {
            continue;
        }
        if let Ok(xml) = fs::read_to_string(&path) {
            out.extend(endpoints_of_route(&xml, domain, domain_guid));
        }
    }
    out
}

/// Сведения о портах: TLS, шифры, авторизация и состояние пулов Jetty.
///
/// Фабрики спрашиваются по каждому домену, `jetty_usage` — один раз.
/// Чего сервер не сказал, остаётся пустым: пустая ячейка честнее выдуманной.
pub async fn port_facts(
    connection: &Connection,
    domain_guids: &[String],
) -> BTreeMap<u32, PortFacts> {
    let mut facts: BTreeMap<u32, PortFacts> = BTreeMap::new();
    let Ok(client) = connection.client() else { return facts };

    if let Ok(usage) = crate::fesb_api::get_json(connection, &client, "/api/jetty_usage/last").await {
        for group in ["web", "domains", "ws"] {
            for pool in usage.get(group).and_then(|v| v.as_array()).into_iter().flatten() {
                let Some(port) = pool.get("port").and_then(serde_json::Value::as_u64) else { continue };
                let entry = facts.entry(port as u32).or_default();
                let number = |name: &str| pool.get(name).and_then(serde_json::Value::as_i64);
                entry.busy_threads = number("busyThreads");
                entry.utilized_threads = number("utilizedThreads");
                entry.ready_threads = number("readyThreads");
                entry.min_threads = number("minThreads");
                entry.max_threads = number("maxThreads");
                entry.queue_size = number("queueSize");
                entry.idle_timeout = number("idleTimeout");
                entry.idle_threads = number("idleThreads");
                // Пул есть — значит, порт слушают.
                entry.state = Some("listening".into());
            }
        }
    }

    for guid in domain_guids {
        let path = format!("/api/broker/domain/{guid}/jetty-engine-factories");
        let Ok(list) = crate::fesb_api::get_json(connection, &client, &path).await else { continue };
        for factory in list.as_array().into_iter().flatten() {
            let Some(port) = factory.get("port").and_then(serde_json::Value::as_u64) else { continue };
            let entry = facts.entry(port as u32).or_default();
            let tls = factory.get("tlsServerParameters");
            entry.ssl = Some(tls.is_some_and(|value| !value.is_null()));
            entry.protocol = tls
                .and_then(|value| value.get("secureSocketProtocol"))
                .and_then(|value| value.as_str())
                .map(str::to_string);
            entry.ciphers = tls
                .and_then(|value| value.get("cipherSuites"))
                .and_then(|value| value.as_array())
                .map(|list| {
                    list.iter().filter_map(|item| item.as_str()).collect::<Vec<_>>().join(", ")
                })
                .filter(|text| !text.is_empty());
            entry.auth = factory
                .get("authentication")
                .or_else(|| factory.get("authorization"))
                .and_then(|value| value.as_str())
                .map(str::to_string);
            if let Some(status) = factory.get("status").and_then(|value| value.as_str()) {
                entry.state = Some(status.to_string());
            }
        }
    }

    facts
}

/// Дополняет точки сведениями о портах.
pub fn enrich(endpoints: &mut [Endpoint], facts: &BTreeMap<u32, PortFacts>) {
    for point in endpoints.iter_mut() {
        let Some(port) = point.port else { continue };
        let Some(known) = facts.get(&port) else { continue };
        point.ssl = known.ssl;
        point.protocol = known.protocol.clone();
        point.ciphers = known.ciphers.clone();
        point.auth = known.auth.clone();
        point.state = known.state.clone();
        point.busy_threads = known.busy_threads;
        point.utilized_threads = known.utilized_threads;
        point.ready_threads = known.ready_threads;
        point.min_threads = known.min_threads;
        point.max_threads = known.max_threads;
        point.queue_size = known.queue_size;
        point.idle_timeout = known.idle_timeout;
        point.idle_threads = known.idle_threads;
    }
    // Схема сама по себе говорит про TLS больше, чем молчание фабрики.
    for point in endpoints.iter_mut() {
        if point.ssl.is_none() && (point.scheme.ends_with('s') || point.scheme.contains("https")) {
            point.ssl = Some(point.scheme.starts_with("https") || point.scheme.starts_with("ftps"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_what_it_can_and_admits_the_rest() {
        assert_eq!(split_uri("https://esb.corp:8443/api"), ("https".into(), Some("esb.corp".into()), Some(8443)));
        assert_eq!(split_uri("http://localhost/path"), ("http".into(), Some("localhost".into()), None));
        // Хост из константы: схему знаем, адрес — нет.
        assert_eq!(split_uri("http://{{const.url.sap}}/rec"), ("http".into(), None, None));
        assert_eq!(split_uri("https://${exchangeProperty.uri}"), ("https".into(), None, None));
        assert_eq!(split_uri("нечто"), (String::new(), None, None));
    }

    /// Имя ресурса — не хост, а вложенная схема — хост.
    #[test]
    fn the_authority_of_an_adapter_is_not_a_host() {
        // Снаружи адаптер, внутри настоящий адрес.
        assert_eq!(split_uri("jetty://http://0.0.0.0:8085/in"), ("jetty".into(), Some("0.0.0.0".into()), Some(8085)));
        // `InterchangeAuthToken` — имя точки, а не система; порт лежит параметром.
        assert_eq!(
            split_uri("eik-is://InterchangeAuthToken?port=8086&authToken=true"),
            ("eik-is".into(), None, Some(8086))
        );
        // Адрес вызова спрятан в параметре.
        assert_eq!(
            split_uri("eik-xi://none?httpUri=https://sap.corp:44300/xi"),
            ("eik-xi".into(), Some("sap.corp".into()), Some(44300))
        );
        // Хост из константы даже в параметре разобрать нельзя.
        assert_eq!(split_uri("eik-xi://none?httpUri=RAW({{const.URI.SAPBW}})").1, None);
        assert_eq!(split_uri("sql://?dataSource=%23conf.ds.X").1, None);
    }

    #[test]
    fn internal_delivery_is_not_a_point() {
        assert!(!is_external("direct"));
        assert!(!is_external("localmq"));
        assert!(!is_external("timer"));
        assert!(is_external("https"));
        assert!(is_external("cxf"));
        assert!(is_external("netty-http"));
    }

    #[test]
    fn takes_the_entry_and_the_outward_calls_only() {
        let xml = r#"<routes><route id="r" factor-name="Приём"><from uri="jetty://http://0.0.0.0:8085/in" factor-name="Вход"/>
            <to uri="direct://step" factor-name="Внутрь"/>
            <to uri="https://partner.example:443/accept" factor-name="Отправка"/>
            <log message="ok"/></route></routes>"#;
        let points = endpoints_of_route(xml, "POA", "domain-1");
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].direction, "in");
        assert_eq!(points[0].component, "Вход");
        assert_eq!(points[1].direction, "out");
        assert_eq!(points[1].scheme, "https");
        assert_eq!(points[1].port, Some(443));
        assert_eq!(points[1].route, "Приём");
    }

    #[test]
    fn tls_is_read_from_the_scheme_when_the_factory_says_nothing() {
        let mut points = vec![Endpoint {
            domain: "d".into(), domain_guid: "g".into(), route: "r".into(), route_id: "id".into(),
            component: "c".into(), direction: "out", kind: "HTTP".into(), scheme: "https".into(),
            uri: "https://x/y".into(), host: None, port: None, ssl: None, protocol: None,
            ciphers: None, auth: None, state: None, uptime: None, busy_threads: None,
            utilized_threads: None, ready_threads: None, min_threads: None, max_threads: None,
            queue_size: None, idle_timeout: None, idle_threads: None,
        }];
        enrich(&mut points, &BTreeMap::new());
        assert_eq!(points[0].ssl, Some(true));
    }
}

#[cfg(test)]
mod uri_tests {
    use super::*;

    #[test]
    fn transformations_are_not_endpoints() {
        for scheme in ["xslt-saxon", "json-validator", "dozer", "xj", "ehcache"] {
            assert!(!is_external(scheme), "{scheme} — это преобразование, а не точка");
        }
        for scheme in ["cxf", "https", "eik-xi", "sftp", "smtps", "sql"] {
            assert!(is_external(scheme), "{scheme} — это точка");
        }
    }

    #[test]
    fn sql_keeps_the_datasource_and_drops_the_query() {
        let uri = "sql://select a, b from very_long_table where x = 1 order by a?dataSource=%23conf.ds.Alfresco";
        assert_eq!(readable_uri(uri), "sql://?dataSource=%23conf.ds.Alfresco");
    }

    #[test]
    fn secrets_do_not_reach_the_report() {
        let uri = "eik-xi://none?httpUri=RAW(x)&httpLogin=tech&httpPasswd=RAW({{const.password}})&privateKey=abc";
        let out = readable_uri(uri);
        assert!(out.contains("httpUri=RAW(x)"));
        assert!(out.contains("httpPasswd=***"));
        assert!(out.contains("privateKey=***"));
        assert!(!out.contains("const.password"));
    }

    #[test]
    fn plain_addresses_are_left_alone() {
        assert_eq!(readable_uri("https://partner.example:443/accept"), "https://partner.example:443/accept");
    }
}

#[cfg(test)]
mod kind_tests {
    use super::*;

    #[test]
    fn names_the_protocol_the_neighbour_system_knows() {
        assert_eq!(point_kind("cxf"), "SOAP");
        assert_eq!(point_kind("jetty"), "HTTP");
        assert_eq!(point_kind("https"), "HTTP");
        assert_eq!(point_kind("sftp"), "FTP");
        assert_eq!(point_kind("sql-stored"), "SQL");
        assert_eq!(point_kind("eik-xi"), "SAP");
        assert_eq!(point_kind("eik-ed"), "EDI");
        // Незнакомый адаптер остаётся собой, а не притворяется протоколом.
        assert_eq!(point_kind("telegram"), "TELEGRAM");
    }

    #[test]
    fn the_whole_jetty_pool_reaches_the_point() {
        let facts = BTreeMap::from([(8443u32, PortFacts {
            busy_threads: Some(17), utilized_threads: Some(1), ready_threads: Some(13),
            min_threads: Some(30), max_threads: Some(1000), queue_size: Some(0),
            idle_timeout: Some(60000), idle_threads: Some(11), ..PortFacts::default()
        })]);
        let mut points = endpoints_of_route(
            r#"<routes><route id="r"><from uri="https://x:8443/in"/></route></routes>"#, "d", "g");
        enrich(&mut points, &facts);
        let point = &points[0];
        assert_eq!(point.busy_threads, Some(17));
        assert_eq!(point.utilized_threads, Some(1));
        assert_eq!(point.ready_threads, Some(13));
        assert_eq!(point.min_threads, Some(30));
        assert_eq!(point.queue_size, Some(0));
        assert_eq!(point.idle_timeout, Some(60000));
        assert_eq!(point.idle_threads, Some(11));
    }
}
