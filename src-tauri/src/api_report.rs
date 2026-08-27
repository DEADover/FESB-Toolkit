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

use serde::{Deserialize, Serialize};

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

/// Параметры, по которым видно, что вызов защищён и как именно.
///
/// У точки, описанной фабрикой Jetty, всё это отдаёт шина. У обычного СОПС
/// фабрики нет, и единственный источник — сам адрес: там стоит и ссылка
/// на именованный контекст TLS, и логин с паролем.
const TLS_PARAM: &str = "sslcontextparameters";

/// Параметры адреса, значения которых в отчёт попадать не должны.
const SECRETS: [&str; 8] = [
    "password", "passwd", "pass", "secret", "privatekey", "publickey", "token", "authtoken",
];

/// Шаги, чей адрес считается исходящей точкой.
const OUTGOING: [&str; 6] = ["to", "toD", "wireTap", "recipientList", "pollEnrich", "enrich"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    pub direction: String,
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
    /// Слушает ли шина этот порт на самом деле.
    ///
    /// Имеет смысл только у точек входа: проверка идёт на хосте шины,
    /// а порт исходящей точки принадлежит чужой системе.
    pub listening: Option<bool>,
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

/// Проверяет, слушает ли шина перечисленные порты.
///
/// `/api/json/stat/port/{port}` отвечает, **свободен** ли порт, — значение
/// приходится перевернуть: свободный порт у точки входа означает, что там
/// никто не слушает, а это и есть находка. Проверка идёт на хосте шины,
/// поэтому исходящие точки спрашивать бессмысленно и они сюда не попадают.
pub async fn listening_ports(connection: &Connection, ports: &[u32]) -> BTreeMap<u32, bool> {
    let mut out = BTreeMap::new();
    let Ok(client) = connection.client() else { return out };
    for port in ports {
        let path = format!("/api/json/stat/port/{port}");
        let Ok(value) = crate::fesb_api::get_json(connection, &client, &path).await else { continue };
        let Some(free) = value.as_bool() else { continue };
        out.insert(*port, !free);
    }
    out
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
        // Адаптеры FESB называются `eik-<протокол>`, и протокол — это то,
        // как точку зовёт соседняя система: XI, RFC, AS2, IDOC.
        // Единственное исключение — `eik-ed`: это обмен с 1С.
        "eik-ed" => "1C ED",
        other => {
            return match other.strip_prefix("eik-") {
                Some(protocol) => protocol.to_ascii_uppercase(),
                None => other.to_ascii_uppercase(),
            }
        }
    }
    .to_string()
}

/// Что известно о защите вызова из самого адреса.
///
/// Возвращает «настроен ли TLS» и вид авторизации. Вид выведен из имён
/// параметров, а не придуман: `httpLogin` с `httpPasswd` — это basic,
/// `authToken` — токен, один контекст TLS без логина — сертификат.
pub fn security_of_uri(uri: &str) -> (Option<bool>, Option<String>) {
    let Some((_, query)) = uri.split_once('?') else { return (None, None) };
    let names: Vec<String> = query
        .split('&')
        .filter_map(|pair| pair.split_once('=').map(|(name, _)| name.to_ascii_lowercase()))
        .collect();

    let tls = names.iter().any(|name| name.contains(TLS_PARAM));
    let has = |needle: &str| names.iter().any(|name| name.contains(needle));

    let auth = if has("token") {
        Some("Token".to_string())
    } else if (has("login") || has("username") || has("user")) && (has("passwd") || has("password")) {
        Some("Basic".to_string())
    } else if has("passwd") || has("password") {
        Some("Password".to_string())
    } else if has("privatekey") || has("keystore") || has("certificate") {
        Some("Certificate".to_string())
    } else if tls {
        Some("TLS".to_string())
    } else {
        None
    };

    (tls.then_some(true), auth)
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
                let (tls, auth) = security_of_uri(uri);
                out.push(Endpoint {
                    domain: domain.to_string(),
                    domain_guid: domain_guid.to_string(),
                    route: route.to_string(),
                    route_id: route_id.to_string(),
                    component: node.label.clone().unwrap_or_else(|| node.kind.clone()),
                    direction: direction.to_string(),
                    kind: point_kind(&scheme),
                    scheme,
                    uri: readable_uri(uri),
                    host,
                    port,
                    ssl: tls,
                    protocol: None,
                    ciphers: None,
                    auth,
                    state: None,
        listening: None,
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

/// Точки входа REST-доменов.
///
/// REST-домен — это не СОПС: он описан отдельной сущностью шины и слушает
/// свой порт. В обходе маршрутов он не появится никогда, а точкой входа
/// является ровно так же, как `from` у любого СОПС.
pub async fn rest_endpoints(connection: &Connection) -> Vec<Endpoint> {
    let Ok(client) = connection.client() else { return Vec::new() };
    let Ok(list) = crate::fesb_api::get_json(connection, &client, "/api/rest/domain").await else {
        return Vec::new();
    };

    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|domain| {
            let configuration = domain.get("configuration")?;
            let text = |value: Option<&serde_json::Value>| {
                value.and_then(|v| v.as_str()).map(str::to_string)
            };
            let host = text(configuration.get("host"));
            let port: Option<u32> = configuration
                .get("port")
                .and_then(|value| value.as_str().and_then(|s| s.parse().ok()).or_else(|| value.as_u64().map(|v| v as u32)));
            let https = configuration.get("httpsScheme").and_then(serde_json::Value::as_bool).unwrap_or(false);
            let scheme = if https { "https" } else { "http" };
            let path = text(configuration.get("contextPath")).unwrap_or_default();
            let name = text(domain.get("name")).unwrap_or_else(|| "REST".into());

            Some(Endpoint {
                domain: name.clone(),
                domain_guid: text(domain.get("guid")).unwrap_or_default(),
                route: name,
                route_id: String::new(),
                component: "REST".into(),
                direction: "in".into(),
                kind: "REST".into(),
                scheme: scheme.into(),
                uri: format!(
                    "{scheme}://{}{}{}",
                    host.clone().unwrap_or_else(|| "0.0.0.0".into()),
                    port.map(|value| format!(":{value}")).unwrap_or_default(),
                    if path.starts_with('/') || path.is_empty() { path.clone() } else { format!("/{path}") },
                ),
                host,
                port,
                ssl: Some(https),
                protocol: None,
                ciphers: None,
                auth: None,
                state: domain
                    .get("active")
                    .and_then(serde_json::Value::as_bool)
                    .map(|active| if active { "active".into() } else { "stopped".into() }),
                listening: None,
                uptime: None,
                busy_threads: None,
                utilized_threads: None,
                ready_threads: None,
                min_threads: None,
                max_threads: None,
                queue_size: None,
                idle_timeout: None,
                idle_threads: None,
            })
        })
        .collect()
}

/// Дополняет точки сведениями о портах.
pub fn enrich(endpoints: &mut [Endpoint], facts: &BTreeMap<u32, PortFacts>) {
    for point in endpoints.iter_mut() {
        let Some(port) = point.port else { continue };
        let Some(known) = facts.get(&port) else { continue };
        // Фабрика знает больше, но молчание фабрики не отменяет того,
        // что уже прочитано из адреса.
        point.ssl = known.ssl.or(point.ssl);
        point.protocol = known.protocol.clone().or_else(|| point.protocol.take());
        point.ciphers = known.ciphers.clone().or_else(|| point.ciphers.take());
        point.auth = known.auth.clone().or_else(|| point.auth.take());
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
    // Проверка порта относится только ко входу: у исходящей точки порт
    // чужой, и «свободен» про него ничего не говорит.
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
            component: "c".into(), direction: "out".into(), kind: "HTTP".into(), scheme: "https".into(),
            uri: "https://x/y".into(), host: None, port: None, ssl: None, protocol: None,
            ciphers: None, auth: None, state: None, listening: None, uptime: None,
            busy_threads: None, utilized_threads: None, ready_threads: None, min_threads: None,
            max_threads: None, queue_size: None, idle_timeout: None, idle_threads: None,
        }];
        enrich(&mut points, &BTreeMap::new());
        assert_eq!(points[0].ssl, Some(true));
    }

    #[test]
    fn a_free_port_on_an_entry_point_means_nobody_is_listening() {
        let point = |direction: &str, port: u32| Endpoint {
            domain: "d".into(), domain_guid: "g".into(), route: "r".into(), route_id: "id".into(),
            component: "c".into(), direction: direction.into(), kind: "HTTP".into(), scheme: "https".into(),
            uri: "https://x/y".into(), host: None, port: Some(port), ssl: None, protocol: None,
            ciphers: None, auth: None, state: None, listening: None, uptime: None,
            busy_threads: None, utilized_threads: None, ready_threads: None, min_threads: None,
            max_threads: None, queue_size: None, idle_timeout: None, idle_threads: None,
        };
        let mut points = vec![point("in", 8181), point("in", 9999), point("out", 8181)];
        // `listening_ports` уже перевернула ответ шины: здесь true — «слушают».
        let known = BTreeMap::from([(8181u32, true), (9999u32, false)]);
        mark_listening(&mut points, &known);
        assert_eq!(points[0].listening, Some(true));
        assert_eq!(points[1].listening, Some(false), "порт свободен — там никто не слушает");
        // У исходящей точки порт чужой, и проверка на хосте шины про него молчит.
        assert_eq!(points[2].listening, None);
    }

    #[test]
    fn an_unchecked_port_stays_unknown_rather_than_becoming_false() {
        let mut points = vec![Endpoint {
            domain: "d".into(), domain_guid: "g".into(), route: "r".into(), route_id: "id".into(),
            component: "c".into(), direction: "in".into(), kind: "HTTP".into(), scheme: "https".into(),
            uri: "https://x/y".into(), host: None, port: Some(7777), ssl: None, protocol: None,
            ciphers: None, auth: None, state: None, listening: None, uptime: None,
            busy_threads: None, utilized_threads: None, ready_threads: None, min_threads: None,
            max_threads: None, queue_size: None, idle_timeout: None, idle_threads: None,
        }];
        mark_listening(&mut points, &BTreeMap::new());
        assert_eq!(points[0].listening, None);
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
        assert_eq!(point_kind("eik-xi"), "XI");
        assert_eq!(point_kind("eik-rfc"), "RFC");
        assert_eq!(point_kind("eik-as2"), "AS2");
        assert_eq!(point_kind("eik-idoc"), "IDOC");
        assert_eq!(point_kind("eik-is"), "IS");
        // Обмен с 1С называется не по адаптеру.
        assert_eq!(point_kind("eik-ed"), "1C ED");
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

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn tls_and_auth_are_read_from_the_address() {
        // Именованный контекст TLS — это и есть «настроен SSL».
        let (tls, auth) = security_of_uri("cxf://{{const.url}}?sslContextParameters=%23conf.SSLContext");
        assert_eq!(tls, Some(true));
        assert_eq!(auth.as_deref(), Some("TLS"));

        let (_, auth) = security_of_uri("eik-xi://none?httpLogin=tech&httpPasswd=x");
        assert_eq!(auth.as_deref(), Some("Basic"));

        let (_, auth) = security_of_uri("eik-is://x?authToken=true");
        assert_eq!(auth.as_deref(), Some("Token"));

        let (_, auth) = security_of_uri("eik-is://x?privateKey=abc");
        assert_eq!(auth.as_deref(), Some("Certificate"));

        // Ничего про защиту не сказано — и мы ничего не выдумываем.
        assert_eq!(security_of_uri("https://x/y"), (None, None));
    }

    /// Молчание фабрики не отменяет того, что прочитано из адреса.
    #[test]
    fn the_factory_does_not_erase_what_the_address_said() {
        let mut points = endpoints_of_route(
            r#"<routes><route id="r"><from uri="cxf://x?sslContextParameters=%23conf.SSLContext"/></route></routes>"#,
            "d", "g");
        assert_eq!(points[0].ssl, Some(true));
        enrich(&mut points, &BTreeMap::new());
        assert_eq!(points[0].ssl, Some(true));
        assert_eq!(points[0].auth.as_deref(), Some("TLS"));
    }
}

/// Раскладывает проверку портов по точкам входа.
pub fn mark_listening(endpoints: &mut [Endpoint], listening: &BTreeMap<u32, bool>) {
    for point in endpoints.iter_mut() {
        if point.direction != "in" {
            continue;
        }
        let Some(port) = point.port else { continue };
        point.listening = listening.get(&port).copied();
    }
}
