//! Поиск по всем сообщениям очереди через её выгрузку.
//!
//! В списке сообщений шина тело не отдаёт, а по одному сообщению на запрос
//! очередь в тысячи сообщений читалась бы минутами. Зато у каждого менеджера
//! есть выгрузка очереди целиком — ZIP, где у сообщения свой каталог с
//! `headers.json` и телом. Один запрос, очередь не меняется, и в выгрузке есть
//! даже те тела, которые список показывает пустыми (двоичные сообщения AMQP
//! у мультименеджера).
//!
//! Архив разбирается по ходу скачивания: в памяти лежит только то, что ещё
//! не разобрано. Каталог ZIP стоит в конце, а у сжатых записей шина не пишет
//! размер в заголовок, поэтому обычный разбор, которому нужен архив целиком,
//! здесь не годится: запись читается, пока не кончится её сжатый поток.

use std::time::Duration;

use flate2::{Decompress, FlushDecompress, Status};
use serde::Serialize;
use serde_json::Value;

use crate::fesb_api::{ensure_ok, transport_error, Connection};
use crate::fesb_ops::{encode_segment, excerpt_around, message_from, ManagerKind, QueueMessage};

/// Сколько скачивать по умолчанию с одной очереди. Больше — редкость, и там
/// человек сам решает, ждать ли: экран предложит дочитать целиком.
pub const DEFAULT_LIMIT: u64 = 200 * 1024 * 1024;
/// Разбирать заново, только когда пришло столько нового: иначе большое
/// сообщение распаковывалось бы с начала на каждый кусок сети.
const PARSE_STEP: usize = 1024 * 1024;

const LOCAL_HEADER: u32 = 0x0403_4b50;
const CENTRAL_HEADER: u32 = 0x0201_4b50;
const END_OF_DIRECTORY: u32 = 0x0605_4b50;
const DATA_DESCRIPTOR: u32 = 0x0807_4b50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpMatch {
    /// Заголовки сообщения — тело не возвращается, только кусок вокруг найденного.
    pub message: QueueMessage,
    pub excerpt: String,
    pub in_body: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DumpScan {
    pub matches: Vec<DumpMatch>,
    /// Сколько сообщений прочитано.
    pub messages: usize,
    pub bytes: u64,
    /// Выгрузка больше предела — прочитана не вся очередь.
    pub truncated: bool,
}

fn export_path(kind: ManagerKind, id: &str, queue: &str) -> String {
    let queue = encode_segment(queue);
    match kind {
        ManagerKind::Qms => format!("/api/qms/brokers/{id}/queues/{queue}/messages/export"),
        ManagerKind::Rqms => format!("/api/rqms/brokers/{id}/queues/{queue}/messages/export"),
        ManagerKind::Qme => format!("/api/qme/servers/{id}/queues/{queue}/messages/download"),
    }
}

/// Ищет текст во всех сообщениях очереди. `on_bytes` получает, сколько скачано
/// и сколько всего, если шина это сказала.
pub async fn scan_queue<F: FnMut(u64, Option<u64>)>(
    connection: &Connection,
    kind: ManagerKind,
    id: &str,
    queue: &str,
    needle: &str,
    limit: u64,
    mut on_bytes: F,
) -> Result<DumpScan, String> {
    let needle = needle.trim().to_lowercase();
    let client = connection.client()?;
    let mut request = connection.get(&client, &export_path(kind, id, queue)).timeout(Duration::from_secs(3600));
    if kind == ManagerKind::Qme {
        // У расширенного менеджера фильтр обязателен, пустой означает «всё».
        request = request.query(&[("filter", "")]);
    }
    let mut response = ensure_ok(request.send().await.map_err(transport_error)?, "Cannot export the queue").await?;
    let total = response.content_length();

    let mut scanner = Scanner::new(&needle);
    let mut buffer: Vec<u8> = Vec::new();
    let mut unparsed_since = 0usize;
    let mut downloaded = 0u64;
    let mut truncated = false;
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        let room = limit.saturating_sub(downloaded) as usize;
        let take = chunk.len().min(room);
        buffer.extend_from_slice(&chunk[..take]);
        downloaded += take as u64;
        on_bytes(downloaded, total);
        unparsed_since += take;
        if unparsed_since >= PARSE_STEP {
            let consumed = scanner.feed(&buffer);
            buffer.drain(..consumed);
            unparsed_since = 0;
        }
        if take < chunk.len() {
            truncated = true;
            break;
        }
    }
    scanner.feed(&buffer);
    scanner.flush();
    // Дочитан только архив, разбор которого дошёл до каталога в конце: всё
    // остальное оборвано — пределом или сетью.
    let truncated = truncated || !scanner.finished;
    Ok(DumpScan { matches: scanner.matches, messages: scanner.messages, bytes: downloaded, truncated })
}

/// Разбор записей и поиск по сообщениям, собранным из них.
struct Scanner<'a> {
    needle: &'a str,
    /// Каталог сообщения, записи которого сейчас идут, и что из них уже есть.
    current: Option<String>,
    headers: Option<Value>,
    body: Vec<u8>,
    matches: Vec<DumpMatch>,
    messages: usize,
    /// Встретился каталог архива — все записи позади.
    finished: bool,
}

impl<'a> Scanner<'a> {
    fn new(needle: &'a str) -> Self {
        Scanner { needle, current: None, headers: None, body: Vec::new(), matches: Vec::new(), messages: 0, finished: false }
    }

    /// Разбирает целые записи с начала буфера и говорит, сколько байт ушло.
    fn feed(&mut self, data: &[u8]) -> usize {
        let mut at = 0;
        while !self.finished {
            match next_entry(&data[at..]) {
                Entry::Complete { name, content, size } => {
                    self.entry(&name, content);
                    at += size;
                }
                Entry::End => self.finished = true,
                Entry::Incomplete => break,
            }
        }
        at
    }

    fn entry(&mut self, name: &str, content: Vec<u8>) {
        let (dir, file) = name.split_once('/').unwrap_or(("", name));
        if self.current.as_deref() != Some(dir) {
            self.flush();
            self.current = Some(dir.to_string());
        }
        if file == "headers.json" {
            self.headers = serde_json::from_slice(&content).ok();
        } else {
            self.body.extend_from_slice(&content);
        }
    }

    /// Сообщение собрано — проверить его и забыть тело.
    fn flush(&mut self) {
        let body = std::mem::take(&mut self.body);
        let Some(headers) = self.headers.take() else { return };
        let Some(mut message) = message_from(&headers) else { return };
        self.messages += 1;
        message.body = None;
        if self.needle.is_empty() {
            return;
        }
        if let Some(excerpt) = header_match(&message, self.needle) {
            self.matches.push(DumpMatch { message, excerpt, in_body: false });
            return;
        }
        let text = readable(&body);
        if let Some(excerpt) = excerpt_around(&text, self.needle) {
            self.matches.push(DumpMatch { message, excerpt, in_body: true });
        }
    }
}

/// Тело как текст. Двоичная обвязка AMQP и непечатаемое — пробелами: иначе
/// в куске вокруг найденного стоят квадратики вместо букв.
fn readable(body: &[u8]) -> String {
    String::from_utf8_lossy(body)
        .chars()
        .map(|symbol| if symbol.is_control() || symbol == '\u{FFFD}' { ' ' } else { symbol })
        .collect()
}

/// Совпадение в заголовках и свойствах: `orderNumber = INV-4815162342`.
pub(crate) fn header_match(message: &QueueMessage, needle: &str) -> Option<String> {
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

enum Entry {
    Complete { name: String, content: Vec<u8>, size: usize },
    /// Записи дальше нет целиком — нужны ещё данные (или архив оборван).
    Incomplete,
    /// Начался каталог архива: записей больше не будет.
    End,
}

fn u16_at(data: &[u8], at: usize) -> usize {
    u16::from_le_bytes([data[at], data[at + 1]]) as usize
}

fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

fn next_entry(data: &[u8]) -> Entry {
    if data.len() < 4 {
        return Entry::Incomplete;
    }
    let signature = u32_at(data, 0);
    if signature == CENTRAL_HEADER || signature == END_OF_DIRECTORY {
        return Entry::End;
    }
    if signature != LOCAL_HEADER || data.len() < 30 {
        return Entry::Incomplete;
    }
    let flags = u16_at(data, 6);
    let method = u16_at(data, 8);
    let compressed = u32_at(data, 18) as usize;
    let name_len = u16_at(data, 26);
    let extra_len = u16_at(data, 28);
    let start = 30 + name_len + extra_len;
    if data.len() < start {
        return Entry::Incomplete;
    }
    let name = String::from_utf8_lossy(&data[30..30 + name_len]).into_owned();
    let deferred = flags & 0x08 != 0;

    let (content, mut end) = if !deferred {
        if data.len() < start + compressed {
            return Entry::Incomplete;
        }
        let raw = &data[start..start + compressed];
        let content = match method {
            0 => raw.to_vec(),
            8 => match inflate(raw) {
                Some((content, _)) => content,
                None => return Entry::Incomplete,
            },
            _ => Vec::new(),
        };
        (content, start + compressed)
    } else if method == 8 {
        // Размер станет известен в конце записи; сжатый поток сам знает, где кончается.
        match inflate(&data[start..]) {
            Some((content, used)) => (content, start + used),
            None => return Entry::Incomplete,
        }
    } else {
        // Несжатую запись без размера не разобрать — таких шина не пишет.
        return Entry::Incomplete;
    };

    if deferred {
        // Дескриптор: по желанию сигнатура, потом CRC и два размера.
        if data.len() < end + 4 {
            return Entry::Incomplete;
        }
        let descriptor = if u32_at(data, end) == DATA_DESCRIPTOR { 16 } else { 12 };
        if data.len() < end + descriptor {
            return Entry::Incomplete;
        }
        end += descriptor;
    }
    Entry::Complete { name, content, size: end }
}

/// Распаковывает сжатый поток. `None` — поток не кончился в этих данных.
fn inflate(input: &[u8]) -> Option<(Vec<u8>, usize)> {
    let mut decoder = Decompress::new(false);
    let mut out = Vec::with_capacity(input.len().saturating_mul(3).clamp(4096, 64 * 1024 * 1024));
    loop {
        if out.len() == out.capacity() {
            out.reserve(out.capacity().max(4096));
        }
        let used_before = decoder.total_in();
        let produced_before = out.len();
        let status = decoder
            .decompress_vec(&input[decoder.total_in() as usize..], &mut out, FlushDecompress::None)
            .ok()?;
        if status == Status::StreamEnd {
            return Some((out, decoder.total_in() as usize));
        }
        let stalled = decoder.total_in() == used_before && out.len() == produced_before;
        if stalled && (decoder.total_in() as usize >= input.len() || out.len() < out.capacity()) {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Архив так, как его пишет шина: сжатые записи с дескриптором в конце.
    fn archive(messages: &[(&str, &str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (dir, headers, body) in messages {
            for (name, content) in [(format!("{dir}/headers.json"), headers.as_bytes()), (format!("{dir}/{dir}.txt"), *body)] {
                let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(content).unwrap();
                let compressed = encoder.finish().unwrap();
                out.extend_from_slice(&LOCAL_HEADER.to_le_bytes());
                out.extend_from_slice(&20u16.to_le_bytes());
                out.extend_from_slice(&0x0808u16.to_le_bytes());
                out.extend_from_slice(&8u16.to_le_bytes());
                out.extend_from_slice(&[0; 4]);
                out.extend_from_slice(&[0; 12]);
                out.extend_from_slice(&(name.len() as u16).to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(name.as_bytes());
                out.extend_from_slice(&compressed);
                out.extend_from_slice(&DATA_DESCRIPTOR.to_le_bytes());
                out.extend_from_slice(&[0; 4]);
                out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
                out.extend_from_slice(&(content.len() as u32).to_le_bytes());
            }
        }
        out.extend_from_slice(&CENTRAL_HEADER.to_le_bytes());
        out
    }

    const FIRST: &str = r#"{"messageId":"ID:1","properties":{"orderNumber":"INV-4815162342"}}"#;
    const SECOND: &str = r#"{"messageId":"ID:2","originalQueue":"Invoices.In","properties":{}}"#;

    fn scan(data: &[u8], needle: &str, step: usize) -> Scanner<'static> {
        let needle: &'static str = Box::leak(needle.to_lowercase().into_boxed_str());
        let mut scanner = Scanner::new(needle);
        let mut buffer = Vec::new();
        for chunk in data.chunks(step) {
            buffer.extend_from_slice(chunk);
            let used = scanner.feed(&buffer);
            buffer.drain(..used);
        }
        scanner.flush();
        scanner
    }

    #[test]
    fn a_key_is_found_in_properties_and_in_binary_bodies() {
        let data = archive(&[
            ("ID-1", FIRST, b"<order><inn>7707083893</inn></order>"),
            ("ID-2", SECOND, b"\x00St\xc0\x01<order><inn>7707083893</inn><number>INV-4815162343</number></order>"),
        ]);
        let found = scan(&data, "INV-4815162343", 7);
        assert_eq!(found.messages, 2);
        assert!(found.finished);
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].message.id, "ID:2");
        assert!(found.matches[0].in_body);
        assert!(found.matches[0].excerpt.contains("INV-4815162343"), "{}", found.matches[0].excerpt);
        assert!(!found.matches[0].excerpt.contains('\u{FFFD}'));
        assert_eq!(found.matches[0].message.original_queue.as_deref(), Some("Invoices.In"));

        let by_property = scan(&data, "inv-4815162342", 1000);
        assert_eq!(by_property.matches[0].excerpt, "orderNumber = INV-4815162342");
        assert!(!by_property.matches[0].in_body);
    }

    #[test]
    fn a_cut_archive_gives_what_was_read_and_says_it_is_not_finished() {
        let data = archive(&[("ID-1", FIRST, b"first 7707083893"), ("ID-2", SECOND, b"second 7707083893")]);
        let cut = &data[..data.len() * 3 / 4];
        let found = scan(cut, "7707083893", 64);
        assert!(!found.finished);
        assert_eq!(found.messages, 1);
        assert_eq!(found.matches.len(), 1);
    }

    #[test]
    fn each_manager_exports_through_its_own_path() {
        assert_eq!(export_path(ManagerKind::Qms, "QM", "DLQ.Invoices.In"), "/api/qms/brokers/QM/queues/DLQ.Invoices.In/messages/export");
        assert_eq!(export_path(ManagerKind::Qme, "EQM", "Orders In"), "/api/qme/servers/EQM/queues/Orders%20In/messages/download");
        assert_eq!(export_path(ManagerKind::Rqms, "R", "Q"), "/api/rqms/brokers/R/queues/Q/messages/export");
    }
}
