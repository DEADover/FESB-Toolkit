//! Разбор `domain.xml`: bean-ы трассировки и точные смещения их значений.
//!
//! Задача — не построить полноценное DOM-дерево, а найти bean-ы трассировки
//! (`factor:type="TRACE"`) и точные смещения значений `broker` и `queue`.
//! Работа со смещениями позволяет заменять значение хирургически: остальной файл
//! (форматирование, порядок атрибутов, переводы строк, BOM) остаётся байт-в-байт
//! прежним, а это критично — файл потом заливается обратно в шину.

use serde::{Deserialize, Serialize};

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
        });
    }

    DomainXml { camel_context_id, traces }
}

/// Поля bean-а трассировки, которые умеет править приложение.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceField {
    Broker,
    Queue,
    TraceMode,
}

impl TraceField {
    pub fn key(self) -> &'static str {
        match self {
            TraceField::Broker => "broker",
            TraceField::Queue => "queue",
            TraceField::TraceMode => "traceMode",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
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
}

/// Что именно менять. `None` означает «поле не трогать».
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceUpdate {
    #[serde(default)]
    pub broker: Option<String>,
    #[serde(default)]
    pub queue: Option<String>,
    #[serde(default)]
    pub trace_mode: Option<String>,
}

impl TraceUpdate {
    pub fn fields(&self) -> Vec<(TraceField, &str)> {
        let mut out = Vec::new();
        if let Some(value) = &self.broker {
            out.push((TraceField::Broker, value.as_str()));
        }
        if let Some(value) = &self.queue {
            out.push((TraceField::Queue, value.as_str()));
        }
        if let Some(value) = &self.trace_mode {
            out.push((TraceField::TraceMode, value.as_str()));
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

/// Возвращает новый текст файла с заменёнными значениями `broker` и/или `queue`.
pub fn replace_trace_values(xml: &str, targets: &[BeanTarget], update: &TraceUpdate) -> ReplaceOutcome {
    let parsed = parse_domain_xml(xml);
    let mut changes: Vec<AppliedChange> = Vec::new();
    let mut missed: Vec<SkippedChange> = Vec::new();
    let mut edits: Vec<(ValueLocation, String)> = Vec::new();

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

        let mut applied = Vec::new();
        for (field, new_value) in update.fields() {
            let (current, location, expected) = match field {
                TraceField::Broker => (&trace.broker, &trace.broker_location, &target.expected_broker),
                TraceField::Queue => (&trace.queue, &trace.queue_location, &target.expected_queue),
                TraceField::TraceMode => (&trace.trace_mode, &trace.trace_mode_location, &target.expected_trace_mode),
            };

            let mut skip = |reason: &str, actual: Option<String>| {
                missed.push(SkippedChange {
                    bean_id: trace.bean_id.clone(),
                    bean_name: trace.bean_name.clone(),
                    field: Some(field.key().into()),
                    reason: reason.into(),
                    actual,
                })
            };

            let Some(location) = location else {
                skip("property-not-found", None);
                continue;
            };
            if let Some(expected) = expected {
                if current.as_ref() != Some(expected) {
                    skip("value-changed", current.clone());
                    continue;
                }
            }
            if current.as_deref() == Some(new_value) {
                skip("already-set", current.clone());
                continue;
            }

            applied.push(FieldChange {
                field: field.key().into(),
                from: current.clone(),
                to: new_value.to_string(),
                line: location.line,
            });
            edits.push((location.clone(), new_value.to_string()));
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
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    let mut text = xml.to_string();
    for (location, new_value) in edits {
        let encoded = match location.kind {
            ValueKind::Attr => encode_xml_attr(&new_value),
            ValueKind::Text => encode_xml_text(&new_value),
        };
        text.replace_range(location.start..location.end, &encoded);
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
        TraceUpdate { broker: Some(value.into()), queue: None, trace_mode: None }
    }

    fn target(bean: &str) -> BeanTarget {
        BeanTarget {
            bean_id: Some(bean.into()),
            bean_name: None,
            expected_broker: None,
            expected_queue: None,
            expected_trace_mode: None,
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

    #[test]
    fn reports_missing_property_per_field() {
        let targets = vec![target("TraceToMemory")];
        let update = TraceUpdate { broker: Some("QMS:QM".into()), queue: Some("Mon.Trace".into()), trace_mode: None };
        let outcome = replace_trace_values(SAMPLE, &targets, &update);
        assert!(outcome.changes.is_empty());
        assert_eq!(outcome.missed.len(), 2);
        assert!(outcome.missed.iter().all(|m| m.reason == "property-not-found"));
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
