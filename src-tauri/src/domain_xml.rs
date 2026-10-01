//! Разбор `domain.xml`: bean-ы трассировки и точные смещения их значений.
//!
//! Задача — не построить полноценное DOM-дерево, а найти bean-ы трассировки
//! (`factor:type="TRACE"`) и точные смещения значений их параметров:
//! менеджера, очереди, режима и остальных из [`crate::trace_options`].
//! Работа со смещениями позволяет заменять значение хирургически: остальной файл
//! (форматирование, порядок атрибутов, переводы строк, BOM) остаётся байт-в-байт
//! прежним, а это критично — файл потом заливается обратно в шину.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::trace_options::{self, OptionKind, EVENT_PREFIX, TRACE_EVENTS};
use crate::xml::{attr_value, decode_xml, encode_xml_attr, encode_xml_text, line_at, local_name, parse_attributes, scan_tags, Attr, Tag};

const TRACE_CLASS_SUFFIX: &str = ".TraceQueueConfig";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueKind {
    /// Значение записано атрибутом: `<property name="broker" value="…"/>`.
    Attr,
    /// Значение записано вложенным элементом: `<property name="broker"><value>…</value></property>`.
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueLocation {
    pub kind: ValueKind,
    pub start: usize,
    pub end: usize,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceBean {
    pub bean_id: Option<String>,
    pub bean_name: Option<String>,
    pub bean_class: Option<String>,
    pub bean_line: usize,
    pub broker: Option<String>,
    pub broker_location: Option<ValueLocation>,
    pub queue: Option<String>,
    pub queue_location: Option<ValueLocation>,
    pub client_type: Option<String>,
    pub trace_mode: Option<String>,
    pub trace_mode_location: Option<ValueLocation>,
    /// Ждать ли отправителя, когда очередь событий заполнена.
    ///
    /// У объекта, который пишет в память, очереди с именем нет, а этот
    /// признак есть: в редакторе шины он и стоит на месте очереди —
    /// «Блокирующая» или «Неблокирующая».
    pub block_on_full_queue: Option<bool>,
    /// Текущие значения параметров из [`trace_options::TRACE_OPTIONS`].
    ///
    /// Свойства нет или в нём нечего показать — ключа нет. События лежат
    /// поштучно: `events.TRACE_ENDPOINT` → `true` / `false`, и только если
    /// список событий в объекте вообще записан.
    pub options: BTreeMap<String, String>,
    #[serde(skip)]
    pub option_locations: BTreeMap<String, ValueLocation>,
    #[serde(skip)]
    pub events: Option<EventsSpan>,
    #[serde(skip)]
    pub insert_at: Option<InsertPoint>,
}

/// Где в файле лежит список событий: свойство целиком, от `<property` до `</property>`.
#[derive(Debug, Clone)]
pub struct EventsSpan {
    pub start: usize,
    pub end: usize,
    pub line: usize,
    /// Отступ строки, с которой начинается свойство.
    pub indent: String,
    pub values: Vec<String>,
}

/// Куда дописать свойство, которого в объекте нет: перед `</bean>`.
#[derive(Debug, Clone)]
pub struct InsertPoint {
    pub at: usize,
    pub line: usize,
    /// `</bean>` стоит на своей строке — новое свойство тоже встаёт на свою.
    pub own_line: bool,
    pub indent: String,
    pub newline: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainXml {
    pub camel_context_id: Option<String>,
    pub traces: Vec<TraceBean>,
}

fn is_trace_bean(attrs: &[Attr]) -> bool {
    if attrs.iter().any(|a| local_name(&a.name) == "type" && a.value == "TRACE") {
        return true;
    }
    attrs
        .iter()
        .any(|a| local_name(&a.name) == "class" && a.value.ends_with(TRACE_CLASS_SUFFIX))
}

struct FoundProperty {
    value: String,
    location: ValueLocation,
}

/// Ищет `<property name="X">` внутри диапазона `[from, to)` и возвращает
/// дескриптор его значения. Поддержаны обе формы записи.
/// Значение свойства, в котором есть что показать.
///
/// «Не задано» шина пишет не пустой строкой. В выгрузке встречается вот это:
///
/// ```text
/// <property name="broker" value="&#xa;&#x9;&#x9;&#xa;&#x9;&#x9;&#xa;&#xa;&#x9;&#x9;&#x9;&#x9;&#xa;"/>
/// ```
///
/// — переносы строк с табуляциями, а между ними три символа из частной
/// области Юникода (U+E000…U+E002). Имени менеджера здесь нет, но и пустой
/// строкой это не является: на экране получались три пустых квадрата
/// вместо значения, а сводка считала такой bean за настроенный.
///
/// Поэтому значение без единого осмысленного символа считается
/// отсутствующим. Место свойства в файле при этом сохраняется: свойство
/// есть, и заменить его по-прежнему можно.
fn meaningful(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let readable = |ch: char| !ch.is_whitespace() && !ch.is_control() && !is_private_use(ch);
    trimmed.chars().any(readable).then(|| trimmed.to_string())
}

/// Символ из частной области Юникода: смысл ему назначает тот, кто пишет,
/// и договориться о нём мы не можем — показывать такое нечем.
fn is_private_use(ch: char) -> bool {
    matches!(ch, '\u{e000}'..='\u{f8ff}' | '\u{f0000}'..='\u{ffffd}' | '\u{100000}'..='\u{10fffd}')
}

fn find_property(xml: &str, tags: &[Tag], from: usize, to: usize, prop_name: &str) -> Option<FoundProperty> {
    for (k, tag) in tags.iter().enumerate() {
        if tag.start < from {
            continue;
        }
        if tag.start >= to {
            break;
        }
        if tag.is_end || local_name(&tag.name) != "property" {
            continue;
        }

        let attrs = parse_attributes(xml, tag.attrs_from, tag.attrs_to);
        if attr_value(&attrs, "name").as_deref() != Some(prop_name) {
            continue;
        }

        if let Some(value_attr) = attrs.iter().find(|a| local_name(&a.name) == "value") {
            return Some(FoundProperty {
                value: decode_xml(&value_attr.value),
                location: ValueLocation {
                    kind: ValueKind::Attr,
                    start: value_attr.value_start,
                    end: value_attr.value_end,
                    line: line_at(xml, tag.start),
                },
            });
        }
        if tag.is_self_close {
            return None;
        }

        // Вложенный <value>…</value>
        for (n, inner) in tags.iter().enumerate().skip(k + 1) {
            if inner.start >= to {
                break;
            }
            if inner.is_end && local_name(&inner.name) == "property" {
                break;
            }
            if inner.is_end || inner.is_self_close || local_name(&inner.name) != "value" {
                continue;
            }
            let close = tags[n + 1..].iter().find(|t| t.is_end && local_name(&t.name) == "value")?;
            return Some(FoundProperty {
                value: decode_xml(&xml[inner.end..close.start]),
                location: ValueLocation {
                    kind: ValueKind::Text,
                    start: inner.end,
                    end: close.start,
                    line: line_at(xml, inner.start),
                },
            });
        }
        return None;
    }
    None
}
/// Начало строки, в которой стоит `offset`, и её отступ — если до `offset`
/// в этой строке одни пробелы.
fn line_indent(xml: &str, offset: usize) -> (usize, Option<String>) {
    let start = xml[..offset].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let lead = &xml[start..offset];
    let indent = lead.chars().all(|ch| ch == ' ' || ch == '\t').then(|| lead.to_string());
    (start, indent)
}

type Options = (BTreeMap<String, String>, BTreeMap<String, ValueLocation>, Option<EventsSpan>);

/// Текущие значения параметров объекта трассировки и их места в файле.
fn read_options(xml: &str, tags: &[Tag], from: usize, to: usize) -> Options {
    let mut values = BTreeMap::new();
    let mut locations = BTreeMap::new();
    for option in trace_options::properties() {
        if let Some(found) = find_property(xml, tags, from, to, option.key) {
            if let Some(value) = meaningful(&found.value) {
                values.insert(option.key.to_string(), value);
            }
            locations.insert(option.key.to_string(), found.location);
        }
    }
    let events = find_events(xml, tags, from, to);
    if let Some(span) = &events {
        for event in TRACE_EVENTS {
            let on = span.values.iter().any(|value| value == event);
            values.insert(format!("{EVENT_PREFIX}{event}"), on.to_string());
        }
    }
    (values, locations, events)
}

/// Свойство `events` целиком и перечисленные в нём события.
fn find_events(xml: &str, tags: &[Tag], from: usize, to: usize) -> Option<EventsSpan> {
    let (k, open) = tags.iter().enumerate().find(|(_, tag)| {
        tag.start >= from
            && tag.start < to
            && !tag.is_end
            && local_name(&tag.name) == "property"
            && attr_value(&parse_attributes(xml, tag.attrs_from, tag.attrs_to), "name").as_deref() == Some("events")
    })?;
    let (_, indent) = line_indent(xml, open.start);
    let indent = indent.unwrap_or_default();
    let line = line_at(xml, open.start);
    if open.is_self_close {
        return Some(EventsSpan { start: open.start, end: open.end, line, indent, values: Vec::new() });
    }

    let mut values = Vec::new();
    let mut end = None;
    for (n, inner) in tags.iter().enumerate().skip(k + 1) {
        if inner.start >= to {
            break;
        }
        if inner.is_end && local_name(&inner.name) == "property" {
            end = Some(inner.end);
            break;
        }
        if !inner.is_end && !inner.is_self_close && local_name(&inner.name) == "value" {
            if let Some(close) = tags[n + 1..].iter().find(|t| t.is_end && local_name(&t.name) == "value") {
                values.push(decode_xml(&xml[inner.end..close.start]).trim().to_string());
            }
        }
    }
    Some(EventsSpan { start: open.start, end: end?, line, indent, values })
}

/// Место для нового свойства — перед закрывающим `</bean>`, с отступом
/// соседних свойств, чтобы файл после правки читался как написанный шиной.
fn insert_point(xml: &str, tags: &[Tag], from: usize, to: usize) -> Option<InsertPoint> {
    if to <= from {
        return None;
    }
    let (line_start, close_indent) = line_indent(xml, to);
    let property_indent = tags
        .iter()
        .find(|tag| tag.start >= from && tag.start < to && !tag.is_end && local_name(&tag.name) == "property")
        .and_then(|tag| line_indent(xml, tag.start).1);
    let newline = if xml[..line_start].ends_with("\r\n") { "\r\n" } else { "\n" };
    let own_line = close_indent.is_some() && line_start > from;
    let indent = property_indent
        .or_else(|| close_indent.clone().map(|indent| format!("{indent}    ")))
        .unwrap_or_default();
    Some(InsertPoint {
        at: if own_line { line_start } else { to },
        line: line_at(xml, to),
        own_line,
        indent,
        newline,
    })
}

/// Список событий в том виде, в котором его пишет редактор шины.
fn events_block(span: &EventsSpan, events: &[&str], newline: &str) -> String {
    let indent = &span.indent;
    if events.is_empty() {
        return format!("<property name=\"events\">{newline}{indent}    <list/>{newline}{indent}</property>");
    }
    let mut text = format!("<property name=\"events\">{newline}{indent}    <list>{newline}");
    for event in events {
        text.push_str(&format!("{indent}        <value>{event}</value>{newline}"));
    }
    text.push_str(&format!("{indent}    </list>{newline}{indent}</property>"));
    text
}

/// Извлекает из `domain.xml` все bean-ы трассировки.
pub fn parse_domain_xml(xml: &str) -> DomainXml {
    let tags = scan_tags(xml);
    let mut stack: Vec<(String, usize, Vec<Attr>, bool)> = Vec::new();
    let mut traces = Vec::new();
    let mut camel_context_id = None;

    for tag in &tags {
        let name = local_name(&tag.name).to_string();

        if !tag.is_end && !tag.is_self_close {
            let attrs = if name == "bean" || name == "camelContext" {
                parse_attributes(xml, tag.attrs_from, tag.attrs_to)
            } else {
                Vec::new()
            };
            if name == "camelContext" && camel_context_id.is_none() {
                camel_context_id = attr_value(&attrs, "id");
            }
            let trace = name == "bean" && is_trace_bean(&attrs);
            stack.push((name, tag.end, attrs, trace));
            continue;
        }

        if tag.is_self_close {
            if name == "camelContext" && camel_context_id.is_none() {
                camel_context_id = attr_value(&parse_attributes(xml, tag.attrs_from, tag.attrs_to), "id");
            }
            continue;
        }

        // Закрывающий тег: сматываем стек до совпадения — на случай кривой вложенности.
        let Some(index) = stack.iter().rposition(|(open, _, _, _)| *open == name) else {
            continue;
        };
        let (_, body_start, attrs, is_trace) = stack.remove(index);
        stack.truncate(index);
        if !is_trace {
            continue;
        }

        let to = tag.start;
        let (options, option_locations, events) = read_options(xml, &tags, body_start, to);
        let insert_at = insert_point(xml, &tags, body_start, to);
        let broker = find_property(xml, &tags, body_start, to, "broker");
        let queue = find_property(xml, &tags, body_start, to, "queue");
        let trace_mode = find_property(xml, &tags, body_start, to, "traceMode");
        traces.push(TraceBean {
            bean_id: attr_value(&attrs, "id"),
            bean_name: attr_value(&attrs, "name"),
            bean_class: attr_value(&attrs, "class"),
            bean_line: line_at(xml, body_start),
            broker: broker.as_ref().and_then(|b| meaningful(&b.value)),
            broker_location: broker.map(|b| b.location),
            queue: queue.as_ref().and_then(|q| meaningful(&q.value)),
            queue_location: queue.map(|q| q.location),
            client_type: find_property(xml, &tags, body_start, to, "clientType")
                .and_then(|p| meaningful(&p.value)),
            block_on_full_queue: find_property(xml, &tags, body_start, to, "blockOnFullQueue")
                .and_then(|p| meaningful(&p.value))
                .and_then(|value| value.parse().ok()),
            trace_mode: trace_mode.as_ref().and_then(|m| meaningful(&m.value)),
            trace_mode_location: trace_mode.map(|m| m.location),
            options,
            option_locations,
            events,
            insert_at,
        });
    }

    DomainXml { camel_context_id, traces }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeanTarget {
    pub bean_id: Option<String>,
    pub bean_name: Option<String>,
    /// Значения, которые видел пользователь при сканировании. Если они уже
    /// не совпадают — файл изменили извне, и такое поле пропускается.
    #[serde(default)]
    pub expected_broker: Option<String>,
    #[serde(default)]
    pub expected_queue: Option<String>,
    #[serde(default)]
    pub expected_trace_mode: Option<String>,
    /// То же для остальных параметров. Ключ есть — значение проверяется,
    /// и `null` значит «свойства не было».
    #[serde(default)]
    pub expected_options: BTreeMap<String, Option<String>>,
}

impl BeanTarget {
    /// Какое значение ждём у параметра. `None` — не проверяем.
    fn expected(&self, key: &str) -> Option<Option<String>> {
        let legacy = match key {
            "broker" => &self.expected_broker,
            "queue" => &self.expected_queue,
            "traceMode" => &self.expected_trace_mode,
            _ => &None,
        };
        match legacy {
            Some(value) => Some(Some(value.clone())),
            None => self.expected_options.get(key).cloned(),
        }
    }
}

/// Что именно менять. `None` и отсутствующий ключ означают «не трогать».
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceUpdate {
    #[serde(default)]
    pub broker: Option<String>,
    #[serde(default)]
    pub queue: Option<String>,
    #[serde(default)]
    pub trace_mode: Option<String>,
    /// Остальные параметры: ключ из [`trace_options::TRACE_OPTIONS`] → новое значение.
    #[serde(default)]
    pub options: BTreeMap<String, String>,
}

impl TraceUpdate {
    /// Все правки в порядке формы редактора шины. Менеджер, очередь и режим,
    /// заданные своими полями, важнее одноимённых ключей в `options`.
    pub fn fields(&self) -> Vec<(&'static str, &str)> {
        let mut out = Vec::new();
        for option in trace_options::TRACE_OPTIONS {
            let own = match option.key {
                "broker" => self.broker.as_deref(),
                "queue" => self.queue.as_deref(),
                "traceMode" => self.trace_mode.as_deref(),
                _ => None,
            };
            if let Some(value) = own.or_else(|| self.options.get(option.key).map(String::as_str)) {
                out.push((option.key, value));
            }
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.fields().is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: String,
    pub from: Option<String>,
    pub to: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedChange {
    pub bean_id: Option<String>,
    pub bean_name: Option<String>,
    pub fields: Vec<FieldChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedChange {
    pub bean_id: Option<String>,
    pub bean_name: Option<String>,
    pub field: Option<String>,
    pub reason: String,
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplaceOutcome {
    pub text: String,
    pub changes: Vec<AppliedChange>,
    pub missed: Vec<SkippedChange>,
}

/// Возвращает новый текст файла с заменёнными значениями параметров трассировки.
///
/// Свойство есть — меняется только его значение, байт в байт на месте.
/// Свойства нет — оно дописывается перед `</bean>`: у многих объектов
/// в выгрузке нет, например, префиксов, и «нечего менять» на них было бы
/// неправдой. Исключение — список событий: чем шина считает его
/// отсутствие, по файлу не понять, поэтому из ничего он не создаётся.
pub fn replace_trace_values(xml: &str, targets: &[BeanTarget], update: &TraceUpdate) -> ReplaceOutcome {
    let parsed = parse_domain_xml(xml);
    let mut changes: Vec<AppliedChange> = Vec::new();
    let mut missed: Vec<SkippedChange> = Vec::new();
    // Правка — диапазон и то, что встаёт на его место; пустой диапазон — вставка.
    let mut edits: Vec<(usize, usize, String)> = Vec::new();

    for target in targets {
        let trace = parsed.traces.iter().find(|t| match (&target.bean_id, &target.bean_name) {
            (Some(id), _) => t.bean_id.as_ref() == Some(id),
            (None, Some(name)) => t.bean_name.as_ref() == Some(name),
            (None, None) => false,
        });

        let Some(trace) = trace else {
            missed.push(SkippedChange {
                bean_id: target.bean_id.clone(),
                bean_name: target.bean_name.clone(),
                field: None,
                reason: "bean-not-found".into(),
                actual: None,
            });
            continue;
        };
        let in_memory = crate::scanner::trace_kind(trace.bean_class.as_deref()) == "memory";

        let mut applied = Vec::new();
        let mut inserts: Vec<String> = Vec::new();
        let mut events: Vec<(&str, bool)> = Vec::new();

        for (key, new_value) in update.fields() {
            let Some(option) = trace_options::find(key) else { continue };
            let current = trace.options.get(key).cloned();

            let mut skip = |reason: &str, actual: Option<String>| {
                missed.push(SkippedChange {
                    bean_id: trace.bean_id.clone(),
                    bean_name: trace.bean_name.clone(),
                    field: Some(key.into()),
                    reason: reason.into(),
                    actual,
                })
            };

            if option.queue_only && in_memory {
                skip("not-applicable", None);
                continue;
            }
            if let Some(expected) = target.expected(key) {
                if current != expected {
                    skip("value-changed", current.clone());
                    continue;
                }
            }
            if current.as_deref() == Some(new_value) {
                skip("already-set", current.clone());
                continue;
            }

            let line = if option.kind == OptionKind::Event {
                let Some(span) = &trace.events else {
                    skip("property-not-found", None);
                    continue;
                };
                events.push((&key[EVENT_PREFIX.len()..], new_value == "true"));
                span.line
            } else if let Some(location) = trace.option_locations.get(key) {
                let encoded = match location.kind {
                    ValueKind::Attr => encode_xml_attr(new_value),
                    ValueKind::Text => encode_xml_text(new_value),
                };
                edits.push((location.start, location.end, encoded));
                location.line
            } else if let Some(point) = &trace.insert_at {
                inserts.push(format!(r#"<property name="{key}" value="{}"/>"#, encode_xml_attr(new_value)));
                point.line
            } else {
                skip("property-not-found", None);
                continue;
            };

            applied.push(FieldChange {
                field: key.into(),
                from: current,
                to: new_value.to_string(),
                line,
            });
        }

        if let (false, Some(point)) = (inserts.is_empty(), &trace.insert_at) {
            let text = if point.own_line {
                inserts.iter().map(|item| format!("{}{item}{}", point.indent, point.newline)).collect()
            } else {
                inserts.concat()
            };
            edits.push((point.at, point.at, text));
        }
        if let (false, Some(span)) = (events.is_empty(), &trace.events) {
            let wanted: Vec<&str> = TRACE_EVENTS
                .iter()
                .copied()
                .filter(|event| match events.iter().find(|(name, _)| name == event) {
                    Some((_, on)) => *on,
                    None => span.values.iter().any(|value| value == event),
                })
                .collect();
            let newline = trace.insert_at.as_ref().map(|point| point.newline).unwrap_or("\n");
            edits.push((span.start, span.end, events_block(span, &wanted, newline)));
        }

        if !applied.is_empty() {
            changes.push(AppliedChange {
                bean_id: trace.bean_id.clone(),
                bean_name: trace.bean_name.clone(),
                fields: applied,
            });
        }
    }

    // Замена идёт с конца файла, чтобы не сбивались смещения предыдущих совпадений.
    // Одно место правится один раз: две цели на один bean (одинаковые `id`
    // в файле) давали две правки одного диапазона, и вторая ложилась
    // уже на сдвинутый текст, съедая кавычки и следующую строку.
    edits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    edits.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
    let mut text = xml.to_string();
    for (start, end, replacement) in edits {
        text.replace_range(start..end, &replacement);
    }

    ReplaceOutcome { text, changes, missed }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns:factor="http://factor-ts.ru/schema/esb/camel/spring">
    <camelContext id="domain-42">
        <routeContextRef ref="route-1"/>
    </camelContext>
    <!-- <property name="broker" value="ЛОВУШКА"/> -->
    <bean class="ru.factorts.module.broker.trace.config.TraceQueueConfig"
        factor:type="TRACE" id="TraceToQueue" name="TraceToQueue">
        <property name="expressions">
            <list>
                <bean class="ru.factorts.module.broker.trace.TraceExpression">
                    <property name="fieldName" value="Headers"/>
                    <property name="expression">
                        <value>headers.collect { k, v -&gt; k }</value>
                    </property>
                </bean>
            </list>
        </property>
        <property name="broker" value="QME:EQM_MON"/>
        <property name="queue" value="Mon.Trace"/>
        <property name="traceMode" value="ASYNC"/>
    </bean>
    <bean factor:type="TRACE" id="TraceToMemory" name="TraceToMemory">
        <property name="traceMode" value="SYNC"/>
    </bean>
</beans>
"#;

    fn broker_only(value: &str) -> TraceUpdate {
        TraceUpdate { broker: Some(value.into()), queue: None, trace_mode: None, ..Default::default() }
    }

    /// Две цели на один и тот же bean — так бывает, когда в файле два объекта
    /// с одинаковым `id` и обе строки выбраны. Правка одна, файл цел.
    #[test]
    fn two_targets_on_one_bean_edit_it_once() {
        let targets = vec![target("TraceToQueue"), target("TraceToQueue")];
        let outcome = replace_trace_values(SAMPLE, &targets, &broker_only("QMS"));
        assert_eq!(outcome.text.matches(r#"<property name="broker" value="QMS"/>"#).count(), 1);
        assert!(outcome.text.contains(r#"<property name="queue" value="Mon.Trace"/>"#), "{}", outcome.text);
        // Файл остался разбираемым: второй объект на месте.
        assert_eq!(parse_domain_xml(&outcome.text).traces.len(), 2);
    }

    fn target(bean: &str) -> BeanTarget {
        BeanTarget {
            bean_id: Some(bean.into()),
            bean_name: None,
            expected_broker: None,
            expected_queue: None,
            expected_trace_mode: None,
            expected_options: Default::default(),
        }
    }

    #[test]
    fn finds_trace_beans_with_broker_and_queue() {
        let parsed = parse_domain_xml(SAMPLE);
        assert_eq!(parsed.camel_context_id.as_deref(), Some("domain-42"));
        assert_eq!(parsed.traces.len(), 2);

        let first = &parsed.traces[0];
        assert_eq!(first.bean_id.as_deref(), Some("TraceToQueue"));
        assert_eq!(first.broker.as_deref(), Some("QME:EQM_MON"));
        assert_eq!(first.queue.as_deref(), Some("Mon.Trace"));
        assert!(first.queue_location.is_some());

        let second = &parsed.traces[1];
        assert_eq!(second.bean_id.as_deref(), Some("TraceToMemory"));
        assert!(second.broker.is_none());
        assert!(second.broker_location.is_none());
        assert!(second.queue_location.is_none());
    }

    #[test]
    fn replaces_only_the_broker_value() {
        let targets = vec![BeanTarget { expected_broker: Some("QME:EQM_MON".into()), ..target("TraceToQueue") }];
        let outcome = replace_trace_values(SAMPLE, &targets, &broker_only("QMS:QM.NEW"));

        assert_eq!(outcome.changes.len(), 1);
        assert_eq!(outcome.changes[0].fields.len(), 1);
        assert!(outcome.missed.is_empty());
        assert!(outcome.text.contains(r#"<property name="broker" value="QMS:QM.NEW"/>"#));
        assert!(outcome.text.contains(r#"<property name="queue" value="Mon.Trace"/>"#));
        // Комментарий-ловушка и всё остальное не тронуты.
        assert!(outcome.text.contains(r#"<!-- <property name="broker" value="ЛОВУШКА"/> -->"#));
        assert_eq!(outcome.text.len(), SAMPLE.len() - "QME:EQM_MON".len() + "QMS:QM.NEW".len());
    }

    #[test]
    fn replaces_broker_and_queue_together() {
        let targets = vec![target("TraceToQueue")];
        let update = TraceUpdate {
            broker: Some("QMS:QM".into()),
            queue: Some("Mon.Trace.New".into()),
            trace_mode: Some("SYNC".into()),
            ..Default::default()
        };
        let outcome = replace_trace_values(SAMPLE, &targets, &update);

        assert_eq!(outcome.changes.len(), 1);
        let fields: Vec<&str> = outcome.changes[0].fields.iter().map(|f| f.field.as_str()).collect();
        assert_eq!(fields, vec!["broker", "queue", "traceMode"]);
        assert!(outcome.text.contains(r#"<property name="broker" value="QMS:QM"/>"#));
        assert!(outcome.text.contains(r#"<property name="queue" value="Mon.Trace.New"/>"#));
        assert!(outcome.text.contains(r#"<property name="traceMode" value="SYNC"/>"#));
    }

    #[test]
    fn skips_bean_whose_value_changed_since_scan() {
        let targets = vec![BeanTarget { expected_broker: Some("QME:EQM".into()), ..target("TraceToQueue") }];
        let outcome = replace_trace_values(SAMPLE, &targets, &broker_only("QMS:QM"));
        assert!(outcome.changes.is_empty());
        assert_eq!(outcome.missed[0].reason, "value-changed");
        assert_eq!(outcome.missed[0].field.as_deref(), Some("broker"));
        assert_eq!(outcome.text, SAMPLE);
    }

    /// Свойства нет — оно дописывается перед `</bean>` с отступом соседей.
    #[test]
    fn adds_missing_property_before_the_end_of_the_bean() {
        let targets = vec![target("TraceToMemory")];
        let update = TraceUpdate { broker: Some("QMS:QM".into()), ..Default::default() };
        let outcome = replace_trace_values(SAMPLE, &targets, &update);
        assert!(outcome.missed.is_empty(), "{:?}", outcome.missed);
        assert!(
            outcome.text.contains(concat!(
                "        <property name=\"traceMode\" value=\"SYNC\"/>\n",
                "        <property name=\"broker\" value=\"QMS:QM\"/>\n",
                "    </bean>",
            )),
            "{}",
            outcome.text
        );
        assert_eq!(outcome.changes[0].fields[0].from, None);
        assert_eq!(parse_domain_xml(&outcome.text).traces[1].broker.as_deref(), Some("QMS:QM"));
    }

    fn options(pairs: &[(&str, &str)]) -> TraceUpdate {
        TraceUpdate {
            options: pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    const FULL: &str = "<beans>\r\n    <bean class=\"ru.factorts.module.broker.trace.config.TraceMemoryConfig\"\r\n        factor:type=\"TRACE\" id=\"Mem\">\r\n        <property name=\"expressions\">\r\n            <list/>\r\n        </property>\r\n        <property name=\"addBody\" value=\"true\"/>\r\n        <property name=\"queueSize\" value=\"200\"/>\r\n        <property name=\"events\">\r\n            <list>\r\n                <value>TRACE_BEFORE_ROUTE</value>\r\n                <value>TRACE_ENDPOINT</value>\r\n                <value>TRACE_AFTER_ROUTE</value>\r\n            </list>\r\n        </property>\r\n    </bean>\r\n</beans>\r\n";

    #[test]
    fn reads_options_and_events() {
        let trace = &parse_domain_xml(FULL).traces[0];
        assert_eq!(trace.options.get("addBody").map(String::as_str), Some("true"));
        assert_eq!(trace.options.get("queueSize").map(String::as_str), Some("200"));
        assert_eq!(trace.options.get("events.TRACE_ENDPOINT").map(String::as_str), Some("true"));
        assert!(!trace.options.contains_key("headerPrefix"));
    }

    /// Флаг меняется на месте, префикс дописывается, событие убирается
    /// из списка, а остальные события остаются — и переводы строк файла тоже.
    #[test]
    fn changes_flags_adds_prefixes_and_toggles_one_event() {
        let update = options(&[
            ("addBody", "false"),
            ("headerPrefix", "mch_"),
            ("events.TRACE_ENDPOINT", "false"),
        ]);
        let outcome = replace_trace_values(FULL, &[target("Mem")], &update);
        assert!(outcome.missed.is_empty(), "{:?}", outcome.missed);
        let text = &outcome.text;
        assert!(text.contains(r#"<property name="addBody" value="false"/>"#));
        assert!(text.contains("        <property name=\"headerPrefix\" value=\"mch_\"/>\r\n    </bean>"), "{text}");
        assert!(text.contains("                <value>TRACE_BEFORE_ROUTE</value>\r\n                <value>TRACE_AFTER_ROUTE</value>\r\n            </list>"), "{text}");
        assert!(!text.contains("TRACE_ENDPOINT"));
        assert!(!text.replace("\r\n", "").contains('\n'), "переводы строк смешались");

        let trace = &parse_domain_xml(text).traces[0];
        assert_eq!(trace.options.get("events.TRACE_ENDPOINT").map(String::as_str), Some("false"));
        assert_eq!(trace.options.get("headerPrefix").map(String::as_str), Some("mch_"));

        // Вернуть событие — оно встаёт на своё место в порядке редактора шины.
        let back = replace_trace_values(text, &[target("Mem")], &options(&[("events.TRACE_ENDPOINT", "true")]));
        assert!(back.text.contains("<value>TRACE_BEFORE_ROUTE</value>\r\n                <value>TRACE_ENDPOINT</value>\r\n                <value>TRACE_AFTER_ROUTE</value>"), "{}", back.text);
    }

    /// У объекта, который пишет в память, нет менеджера, очереди и потоков.
    #[test]
    fn queue_options_do_not_apply_to_a_memory_bean() {
        let update = TraceUpdate { broker: Some("QMS:QM".into()), ..options(&[("threads", "2"), ("queueSize", "500")]) };
        let outcome = replace_trace_values(FULL, &[target("Mem")], &update);
        let skipped: Vec<_> = outcome.missed.iter().map(|m| (m.field.as_deref().unwrap(), m.reason.as_str())).collect();
        assert_eq!(skipped, vec![("broker", "not-applicable"), ("threads", "not-applicable")]);
        assert!(outcome.text.contains(r#"<property name="queueSize" value="500"/>"#));
    }

    /// Чем шина считает отсутствие списка событий, по файлу не понять — из ничего он не создаётся.
    #[test]
    fn a_missing_event_list_is_not_invented() {
        let outcome = replace_trace_values(SAMPLE, &[target("TraceToQueue")], &options(&[("events.TRACE_ENDPOINT", "false")]));
        assert_eq!(outcome.missed[0].reason, "property-not-found");
        assert_eq!(outcome.text, SAMPLE);
    }

    #[test]
    fn an_option_changed_since_the_scan_is_left_alone() {
        let mut stale = target("Mem");
        stale.expected_options.insert("addBody".into(), Some("false".into()));
        let outcome = replace_trace_values(FULL, &[stale], &options(&[("addBody", "false")]));
        assert_eq!(outcome.missed[0].reason, "value-changed");
        assert_eq!(outcome.text, FULL);
    }

    #[test]
    fn reports_value_that_is_already_set() {
        let targets = vec![target("TraceToQueue")];
        let outcome = replace_trace_values(SAMPLE, &targets, &broker_only("QME:EQM_MON"));
        assert!(outcome.changes.is_empty());
        assert_eq!(outcome.missed[0].reason, "already-set");
        assert_eq!(outcome.text, SAMPLE);
    }
}


#[cfg(test)]
mod meaningful_tests {
    use super::*;

    #[test]
    fn a_broker_of_whitespace_and_private_use_characters_is_no_broker() {
        // Ровно то, что шина пишет в выгрузку, когда менеджер не задан.
        let xml = concat!(
            r#"<beans><bean class="ru.factorts.module.broker.trace.config.TraceQueueConfig""#,
            r#" factor:type="TRACE" id="Mon.Trace" name="Mon.Trace">"#,
            "<property name=\"broker\" value=\"&#xa;&#x9;&#x9;&#xa;\u{e000}\u{e001}\u{e002}&#xa;\"/>",
            r#"<property name="queue" value="Mon.Trace"/></bean></beans>"#,
        );
        let trace = &parse_domain_xml(xml).traces[0];
        assert_eq!(trace.broker, None, "три квадрата — это не имя менеджера");
        // Свойство в файле есть, и заменить его по-прежнему можно.
        assert!(trace.broker_location.is_some());
        assert_eq!(trace.queue.as_deref(), Some("Mon.Trace"));
    }

    /// У объекта, который пишет в память, на месте очереди стоит её тип.
    #[test]
    fn a_memory_bean_brings_its_queue_type() {
        let xml = concat!(
            r#"<beans><bean class="ru.factorts.module.broker.trace.config.TraceMemoryConfig""#,
            r#" factor:type="TRACE" id="TraceToMemory" name="TraceToMemory">"#,
            r#"<property name="queueType" value="LIMITED"/>"#,
            r#"<property name="blockOnFullQueue" value="true"/></bean></beans>"#,
        );
        let trace = &parse_domain_xml(xml).traces[0];
        assert_eq!(trace.block_on_full_queue, Some(true));
        assert_eq!(trace.queue, None, "имени очереди у него нет");
    }

    #[test]
    fn a_real_value_survives_the_check() {
        assert_eq!(meaningful("QME:EQM").as_deref(), Some("QME:EQM"));
        // Отступы вокруг значения к имени не относятся.
        assert_eq!(meaningful("\n\tQME:EQM\n").as_deref(), Some("QME:EQM"));
        assert_eq!(meaningful("").as_deref(), None);
        assert_eq!(meaningful("   \n\t ").as_deref(), None);
        assert_eq!(meaningful("\u{e000}\u{e001}").as_deref(), None);
    }
}
