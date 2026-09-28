//! Поиск обмена по бизнес-ключу.
//!
//! Номер заказа, ИНН или идентификатор документа ищется разом там, где обмен
//! оставляет следы: в журналах сервера, среди незавершённых обменов и в
//! сообщениях очередей. По строкам журнала видно, какие СОПС его обработали,
//! по очередям и незавершённым обменам — где он сейчас.
//!
//! Сам по себе ключ шина нигде не индексирует, поэтому поиск — это проход
//! по всему: журналы ищет сервер, а тела сообщений приходится читать по
//! одному. Отсюда пределы ниже и честный счёт того, что осталось непрочитанным.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;

use crate::analytics::{self, InflightExchange};
use crate::fesb_api::{self, ApiProgress, Connection};
use crate::fesb_ops::{self, LogEntry, LogRequest, ManagerKind, QueueMessage};

/// Короче ключ не ищем: по двум знакам находится весь журнал.
pub const MIN_KEY: usize = 3;
/// Сервер отдаёт за раз не больше тысячи записей журнала.
const LOG_LIMIT: u32 = 1000;
/// Сколько найденных обменов дочитывать по их идентификатору.
const FOLLOW_EXCHANGES: usize = 5;
/// Сколько сообщений смотреть в одной очереди — столько же, сколько экран очередей.
const MESSAGES_PER_QUEUE: u32 = 200;
/// Сколько тел прочитать за весь поиск. Тело — отдельный запрос на сообщение,
/// и на стенде с тысячами сообщений в очередях без предела поиск шёл бы минутами.
const BODY_BUDGET: usize = 3000;
/// Хвост имени потока, который пишет журнал: `%-20.20thread`.
const LOG_THREAD_WIDTH: usize = 20;

/// СОПС, записавший строку журнала: `[Домен/СОПС] - …`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteRef {
    pub domain: String,
    pub route: String,
    /// Для перехода к СОПС нужен guid домена, а журнал пишет имя.
    pub domain_guid: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogHit {
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub file: Option<String>,
    pub thread: Option<String>,
    pub route: Option<RouteRef>,
    pub message: String,
    /// Строка найдена не по ключу, а по идентификатору найденного обмена.
    pub by_exchange: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueHit {
    pub kind: ManagerKind,
    pub manager: String,
    pub broker: String,
    pub queue: String,
    pub message_id: String,
    pub timestamp: Option<String>,
    pub original_queue: Option<String>,
    /// Где нашлось: в заголовках и свойствах или в теле — с куском вокруг.
    pub excerpt: String,
    pub in_body: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyTrace {
    pub key: String,
    pub logs: Vec<LogHit>,
    /// Журнал отдал предельное число строк — ранние могли не войти.
    pub logs_limited: bool,
    pub exchange_ids: Vec<String>,
    pub inflight: Vec<InflightExchange>,
    pub queues: Vec<QueueHit>,
    pub queues_checked: usize,
    pub messages_checked: usize,
    /// Сколько тел не прочитано: кончился общий предел.
    pub bodies_skipped: usize,
    /// Очереди, в которых сообщений больше, чем смотрится за раз.
    pub queues_truncated: Vec<String>,
    /// Что не удалось прочитать: поиск идёт дальше, но об этом надо сказать.
    pub problems: Vec<String>,
}

pub async fn find_key<F: FnMut(ApiProgress)>(connection: &Connection, key: &str, mut on_progress: F) -> Result<KeyTrace, String> {
    let key = key.trim();
    if key.chars().count() < MIN_KEY {
        return Err(format!("The key is too short: at least {MIN_KEY} characters"));
    }
    let mut trace = KeyTrace { key: key.to_string(), ..KeyTrace::default() };

    on_progress(ApiProgress { phase: "logs", current: 0, total: 0 });
    let guids: HashMap<String, String> = match fesb_api::domains(connection).await {
        Ok(domains) => domains.into_iter().map(|domain| (domain.name, domain.guid)).collect(),
        Err(error) => {
            trace.problems.push(format!("domains: {error}"));
            HashMap::new()
        }
    };
    search_logs(connection, &mut trace, &guids).await;

    on_progress(ApiProgress { phase: "inflight", current: 0, total: 0 });
    match analytics::inflight_exchanges(connection).await {
        Ok(exchanges) => trace.inflight = matching_inflight(exchanges, &trace),
        Err(error) => trace.problems.push(format!("in flight: {error}")),
    }

    search_queues(connection, &mut trace, &mut on_progress).await;
    Ok(trace)
}

async fn search_logs(connection: &Connection, trace: &mut KeyTrace, guids: &HashMap<String, String>) {
    let files = match fesb_ops::log_files(connection).await {
        Ok(files) => files
            .into_iter()
            // Журнал аудита — о действиях людей в интерфейсе, а не об обменах.
            .filter(|file| file.size > 0 && !file.name.to_lowercase().contains("audit"))
            .map(|file| file.name)
            .collect::<Vec<_>>(),
        Err(error) => {
            trace.problems.push(format!("logs: {error}"));
            return;
        }
    };
    if files.is_empty() {
        return;
    }

    let found = match read_log(connection, &files, &trace.key).await {
        Ok(entries) => entries,
        Err(error) => {
            trace.problems.push(format!("logs: {error}"));
            return;
        }
    };
    trace.logs_limited = found.len() >= LOG_LIMIT as usize;
    let mut seen = HashSet::new();
    for entry in found {
        push_hit(trace, &mut seen, entry, false, guids);
    }

    // Строки с ключом — обычно не все строки обмена: ключ пишут на входе,
    // а дальше обмен идёт под своим идентификатором. Если журнал его пишет,
    // обмен дочитывается целиком.
    trace.exchange_ids = trace
        .logs
        .iter()
        .flat_map(|hit| exchange_ids_in(&hit.message))
        .filter(|id| id != &trace.key)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    for id in trace.exchange_ids.clone().iter().take(FOLLOW_EXCHANGES) {
        match read_log(connection, &files, id).await {
            Ok(entries) => {
                for entry in entries {
                    push_hit(trace, &mut seen, entry, true, guids);
                }
            }
            Err(error) => trace.problems.push(format!("logs ({id}): {error}")),
        }
    }
    trace.logs.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
}

async fn read_log(connection: &Connection, files: &[String], needle: &str) -> Result<Vec<LogEntry>, String> {
    fesb_ops::log_entries(
        connection,
        LogRequest { logs: files.to_vec(), levels: Vec::new(), search: Some(needle.to_string()), limit: Some(LOG_LIMIT) },
    )
    .await
}

fn push_hit(trace: &mut KeyTrace, seen: &mut HashSet<String>, entry: LogEntry, by_exchange: bool, guids: &HashMap<String, String>) {
    let message = entry.message.unwrap_or_default();
    let identity = format!("{:?}|{:?}|{:?}|{message}", entry.timestamp, entry.file, entry.thread);
    if !seen.insert(identity) {
        return;
    }
    let route = route_of(&message).map(|(domain, route)| RouteRef {
        domain_guid: guids.get(&domain).cloned(),
        domain,
        route,
    });
    trace.logs.push(LogHit {
        timestamp: entry.timestamp,
        level: entry.level,
        file: entry.file,
        thread: entry.thread,
        route,
        message,
        by_exchange,
    });
}

/// Домен и СОПС из префикса строки журнала: `[EDI.Tessa/Tessa.In] - текст`.
pub fn route_of(message: &str) -> Option<(String, String)> {
    let rest = message.trim_start().strip_prefix('[')?;
    let (inside, _) = rest.split_once("] - ")?;
    let (domain, route) = inside.split_once('/')?;
    let (domain, route) = (domain.trim(), route.trim());
    if domain.is_empty() || route.is_empty() {
        return None;
    }
    Some((domain.to_string(), route.to_string()))
}

/// Идентификаторы обменов Camel в тексте: `8E5426EB6CFEDDE-0000000000000003`.
pub fn exchange_ids_in(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at + 32 <= bytes.len() {
        let candidate = &bytes[at..at + 32];
        let boundary_before = at == 0 || !bytes[at - 1].is_ascii_alphanumeric();
        let boundary_after = at + 32 == bytes.len() || !bytes[at + 32].is_ascii_alphanumeric();
        let shaped = candidate[15] == b'-'
            && candidate[..15].iter().all(u8::is_ascii_hexdigit)
            && candidate[16..].iter().all(u8::is_ascii_hexdigit);
        if boundary_before && boundary_after && shaped {
            found.push(String::from_utf8_lossy(candidate).to_uppercase());
            at += 32;
        } else {
            at += 1;
        }
    }
    found
}

/// Незавершённые обмены, к которым ведут найденные строки журнала.
///
/// Прямая связь — идентификатор обмена в журнале. Косвенная — тот же СОПС
/// и тот же поток: пул потоков переиспользуется, поэтому это только догадка,
/// но других связей между ключом и висящим обменом у шины нет.
fn matching_inflight(exchanges: Vec<InflightExchange>, trace: &KeyTrace) -> Vec<InflightExchange> {
    let ids: HashSet<String> = trace.exchange_ids.iter().map(|id| id.to_uppercase()).collect();
    let traces: HashSet<(String, String, String)> = trace
        .logs
        .iter()
        .filter_map(|hit| {
            let route = hit.route.as_ref()?;
            Some((route.domain.clone(), route.route.clone(), hit.thread.as_deref()?.trim().to_string()))
        })
        .collect();
    exchanges
        .into_iter()
        .filter(|exchange| {
            if ids.contains(&exchange.id.to_uppercase()) {
                return true;
            }
            let Some(thread) = exchange.thread.as_deref() else { return false };
            let tail = thread_tail(thread);
            traces.contains(&(exchange.domain.clone(), exchange.route.clone(), tail))
        })
        .collect()
}

fn thread_tail(thread: &str) -> String {
    let chars: Vec<char> = thread.chars().collect();
    let start = chars.len().saturating_sub(LOG_THREAD_WIDTH);
    chars[start..].iter().collect::<String>().trim().to_string()
}

async fn search_queues<F: FnMut(ApiProgress)>(connection: &Connection, trace: &mut KeyTrace, on_progress: &mut F) {
    let managers = match fesb_ops::queue_managers(connection).await {
        Ok(managers) => managers.into_iter().filter(|manager| manager.running).collect::<Vec<_>>(),
        Err(error) => {
            trace.problems.push(format!("queues: {error}"));
            return;
        }
    };

    // Сначала список всех непустых очередей: от него считается ход поиска.
    let mut targets = Vec::new();
    for manager in &managers {
        match fesb_ops::queues(connection, manager.kind, &manager.id).await {
            Ok(queues) => {
                for queue in queues.into_iter().filter(|queue| !queue.internal && queue.messages > 0) {
                    targets.push((manager.clone(), queue));
                }
            }
            Err(error) => trace.problems.push(format!("{}: {error}", manager.broker)),
        }
    }

    let total = targets.len() as u64;
    let needle = trace.key.to_lowercase();
    let mut budget = BODY_BUDGET;
    for (index, (manager, queue)) in targets.into_iter().enumerate() {
        on_progress(ApiProgress { phase: "queues", current: index as u64, total });
        let messages = match fesb_ops::queue_messages(connection, manager.kind, &manager.id, &queue.name, MESSAGES_PER_QUEUE).await {
            Ok(messages) => messages,
            Err(error) => {
                trace.problems.push(format!("{} / {}: {error}", manager.broker, queue.name));
                continue;
            }
        };
        trace.queues_checked += 1;
        trace.messages_checked += messages.len();
        if queue.messages > messages.len() as i64 {
            trace.queues_truncated.push(format!("{} / {}", manager.broker, queue.name));
        }

        let hit = |message: &QueueMessage, excerpt: String, in_body: bool| QueueHit {
            kind: manager.kind,
            manager: manager.id.clone(),
            broker: manager.broker.clone(),
            queue: queue.name.clone(),
            message_id: message.id.clone(),
            timestamp: message.timestamp.clone(),
            original_queue: message.original_queue.clone(),
            excerpt,
            in_body,
        };

        // Заголовки и свойства уже в списке — они проверяются без лишних запросов.
        let mut rest = Vec::new();
        for message in &messages {
            match header_match(message, &needle) {
                Some(excerpt) => trace.queues.push(hit(message, excerpt, false)),
                None => rest.push(message),
            }
        }

        let readable = rest.len().min(budget);
        trace.bodies_skipped += rest.len() - readable;
        budget -= readable;
        if readable == 0 {
            continue;
        }
        let ids = rest.iter().take(readable).map(|message| message.id.clone()).collect();
        match fesb_ops::queue_search(connection, manager.kind, &manager.id, &queue.name, ids, &trace.key, |_| {}).await {
            Ok(matches) => {
                let by_id: HashMap<&str, &QueueMessage> = rest.iter().map(|message| (message.id.as_str(), *message)).collect();
                for found in matches {
                    if let Some(message) = by_id.get(found.id.as_str()) {
                        trace.queues.push(hit(message, found.excerpt, true));
                    }
                }
            }
            Err(error) => trace.problems.push(format!("{} / {}: {error}", manager.broker, queue.name)),
        }
    }
    on_progress(ApiProgress { phase: "queues", current: total, total });
}

/// Совпадение в заголовках и свойствах: `orderNumber = INV-4815162342`.
fn header_match(message: &QueueMessage, needle: &str) -> Option<String> {
    let contains = |value: &str| value.to_lowercase().contains(needle);
    if contains(&message.id) {
        return Some(format!("id = {}", message.id));
    }
    if let Some(correlation) = message.correlation_id.as_deref().filter(|value| contains(value)) {
        return Some(format!("correlationId = {correlation}"));
    }
    message
        .properties
        .iter()
        .find(|property| contains(&property.value) || contains(&property.name))
        .map(|property| format!("{} = {}", property.name, property.value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_route_is_read_from_the_log_prefix() {
        assert_eq!(
            route_of("[EDI.Tessa/Tessa.In] - Получен документ 4815"),
            Some(("EDI.Tessa".into(), "Tessa.In".into())),
        );
        assert_eq!(route_of("  [TOOLKIT.INFLIGHT/Toolkit.SlowExchange] - done"), Some(("TOOLKIT.INFLIGHT".into(), "Toolkit.SlowExchange".into())));
        assert_eq!(route_of("Started domain EDI.Tessa"), None);
        assert_eq!(route_of("[no-slash] - text"), None);
        assert_eq!(route_of("[/Route] - text"), None);
    }

    #[test]
    fn camel_exchange_ids_are_found_inside_text() {
        let text = "Slow exchange done: 8E5426EB6CFEDDE-0000000000000002, next 8e5426eb6cfedde-0000000000000003.";
        assert_eq!(exchange_ids_in(text), vec!["8E5426EB6CFEDDE-0000000000000002", "8E5426EB6CFEDDE-0000000000000003"]);
        // Кусок длинного слова — не идентификатор.
        assert!(exchange_ids_in("X8E5426EB6CFEDDE-0000000000000002").is_empty());
        assert!(exchange_ids_in("order INV-4815162342").is_empty());
    }

    #[test]
    fn a_log_thread_is_compared_by_its_tail() {
        assert_eq!(thread_tail("Camel (domain-70011c17) thread #8 - timer://toolkit.slow"), "timer://toolkit.slow");
        assert_eq!(thread_tail("short"), "short");
    }

    #[test]
    fn in_flight_exchanges_are_linked_by_id_or_by_route_and_thread() {
        let exchange = |id: &str, route: &str, thread: &str| InflightExchange {
            id: id.into(), kind: "broker".into(), domain: "TOOLKIT".into(), domain_guid: "g".into(),
            route: route.into(), route_id: "r".into(), at: None, node: None, thread: Some(thread.into()),
            detail: None, duration: None, elapsed: None, interrupted: false,
        };
        let trace = KeyTrace {
            exchange_ids: vec!["8E5426EB6CFEDDE-0000000000000003".into()],
            logs: vec![LogHit {
                timestamp: None, level: None, file: None, thread: Some("timer://toolkit.slow".into()),
                route: Some(RouteRef { domain: "TOOLKIT".into(), route: "Slow".into(), domain_guid: None }),
                message: String::new(), by_exchange: false,
            }],
            ..KeyTrace::default()
        };
        let linked = matching_inflight(vec![
            exchange("8E5426EB6CFEDDE-0000000000000003", "Other", "pool-1"),
            exchange("AAAAAAAAAAAAAAA-0000000000000001", "Slow", "Camel thread #8 - timer://toolkit.slow"),
            exchange("BBBBBBBBBBBBBBB-0000000000000001", "Other", "Camel thread #8 - timer://toolkit.slow"),
        ], &trace);
        assert_eq!(linked.len(), 2);
        assert_eq!(linked[1].route, "Slow");
    }

    #[test]
    fn a_key_is_found_in_properties_without_reading_the_body() {
        let message = QueueMessage {
            id: "ID:1".into(), correlation_id: None, timestamp: None, priority: None, size: 0, body_size: 0,
            body_type: None, persistent: false, redelivered: false, reply_to: None, original_queue: None,
            properties: vec![fesb_ops::MessageProperty { name: "orderNumber".into(), value: "INV-4815162342".into() }],
            body: None, truncated: false,
        };
        assert_eq!(header_match(&message, "inv-4815162342").as_deref(), Some("orderNumber = INV-4815162342"));
        assert_eq!(header_match(&message, "7707083893"), None);
    }
}
