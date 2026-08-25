//! Низкоуровневый разбор XML без внешних библиотек.
//!
//! Нужен не полноценный DOM, а точные байтовые смещения атрибутов: только так
//! можно заменить одно значение и оставить остальной файл байт-в-байт прежним.
//! Этим сканером пользуются и `domain.xml`, и файлы маршрутов.

#[derive(Debug, Clone)]
pub struct Attr {
    pub name: String,
    pub value: String,
    pub value_start: usize,
    pub value_end: usize,
}

#[derive(Debug, Clone)]
pub struct Tag {
    pub name: String,
    pub is_end: bool,
    pub is_self_close: bool,
    pub start: usize,
    pub end: usize,
    pub attrs_from: usize,
    pub attrs_to: usize,
}

/// Локальное имя без префикса пространства имён.
pub fn local_name(name: &str) -> &str {
    match name.find(':') {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

fn is_name_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b':'
}

fn is_name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-' | b'.')
}

/// Разбирает атрибуты из «хвоста» тега. Смещения — абсолютные, от начала файла.
pub fn parse_attributes(xml: &str, from: usize, to: usize) -> Vec<Attr> {
    let bytes = xml.as_bytes();
    let mut attrs = Vec::new();
    let mut i = from;

    while i < to {
        while i < to && !is_name_start(bytes[i]) {
            i += 1;
        }
        if i >= to {
            break;
        }
        let name_start = i;
        while i < to && is_name_char(bytes[i]) {
            i += 1;
        }
        let name = &xml[name_start..i];

        while i < to && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= to || bytes[i] != b'=' {
            continue; // атрибут без значения — пропускаем
        }
        i += 1;
        while i < to && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= to || (bytes[i] != b'"' && bytes[i] != b'\'') {
            continue;
        }
        let quote = bytes[i];
        i += 1;
        let value_start = i;
        while i < to && bytes[i] != quote {
            i += 1;
        }
        let value_end = i.min(to);
        i = (value_end + 1).min(to);

        attrs.push(Attr {
            name: name.to_string(),
            value: xml[value_start..value_end].to_string(),
            value_start,
            value_end,
        });
    }
    attrs
}

/// Проход по тегам документа. Комментарии, CDATA, PI и DOCTYPE пропускаются.
pub fn scan_tags(xml: &str) -> Vec<Tag> {
    let bytes = xml.as_bytes();
    let mut tags = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        let Some(offset) = xml[i..].find('<') else { break };
        let lt = i + offset;

        if xml[lt..].starts_with("<!--") {
            i = xml[lt + 4..].find("-->").map_or(bytes.len(), |p| lt + 4 + p + 3);
            continue;
        }
        if xml[lt..].starts_with("<![CDATA[") {
            i = xml[lt + 9..].find("]]>").map_or(bytes.len(), |p| lt + 9 + p + 3);
            continue;
        }
        if xml[lt..].starts_with("<?") {
            i = xml[lt + 2..].find("?>").map_or(bytes.len(), |p| lt + 2 + p + 2);
            continue;
        }
        if xml[lt..].starts_with("<!") {
            i = xml[lt + 2..].find('>').map_or(bytes.len(), |p| lt + 2 + p + 1);
            continue;
        }

        // Обычный тег: ищем `>` вне кавычек.
        let mut j = lt + 1;
        let mut quote: Option<u8> = None;
        while j < bytes.len() {
            let ch = bytes[j];
            match quote {
                Some(q) if ch == q => quote = None,
                Some(_) => {}
                None if ch == b'"' || ch == b'\'' => quote = Some(ch),
                None if ch == b'>' => break,
                None => {}
            }
            j += 1;
        }
        if j >= bytes.len() {
            break;
        }

        let is_end = bytes.get(lt + 1) == Some(&b'/');
        let name_start = lt + if is_end { 2 } else { 1 };
        if name_start >= j || !is_name_start(bytes[name_start]) {
            i = j + 1;
            continue;
        }
        let mut name_end = name_start;
        while name_end < j && is_name_char(bytes[name_end]) {
            name_end += 1;
        }

        let is_self_close = bytes[j - 1] == b'/';
        tags.push(Tag {
            name: xml[name_start..name_end].to_string(),
            is_end,
            is_self_close,
            start: lt,
            end: j + 1,
            attrs_from: name_end,
            attrs_to: if is_self_close { j - 1 } else { j },
        });
        i = j + 1;
    }
    tags
}

/// Значение атрибута по локальному имени, уже без XML-сущностей.
pub fn attr_value(attrs: &[Attr], name: &str) -> Option<String> {
    attrs.iter().find(|a| local_name(&a.name) == name).map(|a| decode_xml(&a.value))
}

/// Номер строки (нумерация с единицы) для байтового смещения.
pub fn line_at(xml: &str, offset: usize) -> usize {
    xml.as_bytes()[..offset.min(xml.len())].iter().filter(|&&b| b == b'\n').count() + 1
}

pub fn decode_xml(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < s.len() {
        if bytes[i] != b'&' {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let Some(semi) = s[i..].find(';').map(|p| i + p) else {
            out.push('&');
            i += 1;
            continue;
        };
        let entity = &s[i + 1..semi];
        let decoded = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "amp" => Some('&'),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => entity[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                i = semi + 1;
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

pub fn encode_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn encode_xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
