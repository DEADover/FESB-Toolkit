//! Разбор СОПС в дерево шагов — то, что рисуется схемой.
//!
//! Файл маршрута — это Camel DSL на XML, но с добавками FESB: у каждого шага
//! есть `factor-name` (как он подписан в редакторе схем) и `factor-component`
//! (каким блоком он был поставлен). Именно их видит пользователь в шине,
//! поэтому подписи на схеме берутся оттуда, а не из имён элементов Camel.
//!
//! Разбор намеренно не знает полного списка процессоров Camel: элементы,
//! которые не опознаны как выражение или формат, становятся обычными узлами.
//! Незнакомый шаг лучше показать «как есть», чем потерять.

use serde::Serialize;

use crate::xml::{decode_xml, line_at, local_name, parse_attributes, scan_tags};

/// Языки выражений: их текст — это условие или скрипт шага, а не отдельный шаг.
const EXPRESSIONS: [&str; 16] = [
    "simple", "groovy", "xpath", "spel", "constant", "header", "exchangeProperty", "jsonpath",
    "language", "method", "tokenize", "xtokenize", "xquery", "ognl", "javaScript", "mvel",
];

/// Форматы для marshal/unmarshal — они описывают шаг, а не следуют за ним.
const FORMATS: [&str; 14] = [
    "jaxb", "json", "csv", "string", "base64", "zipFile", "gzipDeflater", "protobuf", "avro",
    "yaml", "bindy", "soapjaxb", "mimeMultipart", "custom",
];

/// Элементы, чей текст — пояснение к шагу, а не самостоятельный шаг.
const FOLDED: [&str; 6] = [
    "handled", "continued", "correlationExpression", "completionSizeExpression",
    "completionTimeoutExpression", "onWhen",
];

/// Служебные атрибуты: они ничего не говорят пользователю о работе схемы.
const NOISE: [&str; 6] = [
    "id", "factor-guid", "factor-name", "factor-component", "factor-version-minor",
    "factor-auto-increment-version",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Expression {
    pub language: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribute {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteNode {
    /// Имя элемента Camel: `to`, `choice`, `doTry`, `setHeader`…
    pub kind: String,
    /// Подпись из редактора схем FESB.
    pub label: Option<String>,
    /// Блок редактора, которым поставлен шаг: `ChoiceEndpoint`, `LogEndpoint`…
    pub component: Option<String>,
    pub uri: Option<String>,
    pub expression: Option<Expression>,
    /// Пояснение из `<description>` — обычно текст запроса или комментарий.
    pub description: Option<String>,
    /// Формат для marshal/unmarshal.
    pub format: Option<String>,
    /// Классы исключений у `doCatch`.
    pub exceptions: Vec<String>,
    pub attributes: Vec<Attribute>,
    pub children: Vec<RouteNode>,
    pub line: usize,
    /// Собственный текст элемента: нужен, только чтобы свернуть его в родителя.
    #[serde(skip)]
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteGraph {
    pub id: Option<String>,
    pub name: Option<String>,
    /// Комментарий автора схемы из `<description>` в самом маршруте.
    pub description: Option<String>,
    pub trace_enabled: bool,
    /// Объект трассировки, на который ссылается маршрут.
    pub trace_config: Option<String>,
    /// Сколько шагов в схеме, включая вложенные ветки.
    pub steps: usize,
    pub nodes: Vec<RouteNode>,
    pub line: usize,
}

fn is_expression(kind: &str) -> bool {
    EXPRESSIONS.contains(&kind)
}

fn is_format(kind: &str) -> bool {
    FORMATS.contains(&kind)
}

/// Текст элемента вместе с вложенными: CDATA разворачивается, теги отбрасываются.
///
/// Порядок важен: содержимое CDATA копируется дословно, иначе скрипт вида
/// `if (a < b)` был бы принят за открывающий тег и съел бы остаток текста.
fn inner_text(xml: &str, from: usize, to: usize) -> String {
    let slice = &xml[from.min(xml.len())..to.min(xml.len())];
    let mut out = String::with_capacity(slice.len());
    let mut rest = slice;

    while !rest.is_empty() {
        if let Some(tail) = rest.strip_prefix("<![CDATA[") {
            match tail.find("]]>") {
                Some(end) => {
                    out.push_str(&tail[..end]);
                    rest = &tail[end + 3..];
                }
                None => {
                    out.push_str(tail);
                    break;
                }
            }
            continue;
        }
        if let Some(tail) = rest.strip_prefix('<') {
            rest = match tail.find('>') {
                Some(end) => &tail[end + 1..],
                None => "",
            };
            continue;
        }
        let next = rest.find('<').unwrap_or(rest.len());
        out.push_str(&rest[..next]);
        rest = &rest[next..];
    }

    decode_xml(out.trim())
}

/// Разбирает файл маршрута в дерево шагов.
///
/// В одном файле может лежать несколько `<route>`, поэтому возвращается список.
pub fn parse_route_graphs(xml: &str) -> Vec<RouteGraph> {
    let tags = scan_tags(xml);
    let mut graphs = Vec::new();
    let mut index = 0usize;

    while index < tags.len() {
        let tag = &tags[index];
        if tag.is_end || tag.is_self_close || local_name(&tag.name) != "route" {
            index += 1;
            continue;
        }

        let attrs = parse_attributes(xml, tag.attrs_from, tag.attrs_to);
        let value = |name: &str| {
            attrs
                .iter()
                .find(|attr| local_name(&attr.name) == name)
                .map(|attr| decode_xml(&attr.value))
        };

        let (children, after) = parse_children(xml, &tags, index + 1, &tag.name);
        // У самого маршрута тоже бывает `<description>` — комментарий автора схемы.
        // Без сворачивания он оказался бы первым «шагом» вместо точки входа.
        let mut holder = blank("route", line_at(xml, tag.start));
        let nodes = fold(&mut holder, children);
        let steps = nodes.iter().map(count_steps).sum();

        graphs.push(RouteGraph {
            id: value("id"),
            name: value("factor-name"),
            description: holder.description,
            trace_enabled: value("factor-trace").as_deref() == Some("true"),
            trace_config: value("factor-trace-config"),
            steps,
            nodes,
            line: line_at(xml, tag.start),
        });
        index = after;
    }

    graphs
}

/// Пустой узел: нужен как «родитель», в который сворачиваются служебные дети.
fn blank(kind: &str, line: usize) -> RouteNode {
    RouteNode {
        kind: kind.to_string(),
        label: None,
        component: None,
        uri: None,
        expression: None,
        description: None,
        format: None,
        exceptions: Vec::new(),
        attributes: Vec::new(),
        children: Vec::new(),
        line,
        text: String::new(),
    }
}

fn count_steps(node: &RouteNode) -> usize {
    1 + node.children.iter().map(count_steps).sum::<usize>()
}

/// Собирает детей элемента, пока не встретит его закрывающий тег.
///
/// Возвращает узлы и индекс тега сразу за закрывающим — так вызывающий
/// продолжает разбор с нужного места, не перечитывая уже разобранное.
fn parse_children(
    xml: &str,
    tags: &[crate::xml::Tag],
    mut index: usize,
    parent: &str,
) -> (Vec<RouteNode>, usize) {
    let mut nodes: Vec<RouteNode> = Vec::new();

    while index < tags.len() {
        let tag = &tags[index];
        let kind = local_name(&tag.name).to_string();

        if tag.is_end {
            index += 1;
            if local_name(parent) == kind {
                break;
            }
            // Лишний закрывающий тег — файл битый, но разбор продолжаем.
            continue;
        }

        let attrs = parse_attributes(xml, tag.attrs_from, tag.attrs_to);
        let text_from = tag.end;
        let (children, after) = if tag.is_self_close {
            (Vec::new(), index + 1)
        } else {
            parse_children(xml, tags, index + 1, &tag.name)
        };
        // Текст элемента лежит между его открывающим и закрывающим тегами.
        let text_to = if after > 0 && after <= tags.len() && !tag.is_self_close {
            tags[after - 1].start
        } else {
            text_from
        };

        nodes.push(build_node(xml, &kind, &attrs, children, text_from, text_to, tag.start));
        index = after;
    }

    (nodes, index)
}

fn build_node(
    xml: &str,
    kind: &str,
    attrs: &[crate::xml::Attr],
    children: Vec<RouteNode>,
    text_from: usize,
    text_to: usize,
    start: usize,
) -> RouteNode {
    let value = |name: &str| {
        attrs
            .iter()
            .find(|attr| local_name(&attr.name) == name)
            .map(|attr| decode_xml(&attr.value))
    };

    let kept: Vec<Attribute> = attrs
        .iter()
        .filter(|attr| {
            let name = local_name(&attr.name);
            !NOISE.contains(&name) && name != "uri" && !name.starts_with("xmlns")
        })
        .map(|attr| Attribute {
            name: local_name(&attr.name).to_string(),
            value: decode_xml(&attr.value),
        })
        .collect();

    let mut node = RouteNode {
        kind: kind.to_string(),
        label: value("factor-name"),
        component: value("factor-component"),
        uri: value("uri"),
        expression: None,
        description: None,
        format: None,
        exceptions: Vec::new(),
        attributes: kept,
        children: Vec::new(),
        line: line_at(xml, start),
        text: inner_text(xml, text_from, text_to),
    };
    node.children = fold(&mut node, children);
    node
}

/// Раскладывает детей элемента: выражения, форматы и пояснения описывают сам
/// элемент, поэтому переезжают в его поля, а шагами остаются только шаги.
fn fold(parent: &mut RouteNode, children: Vec<RouteNode>) -> Vec<RouteNode> {
    let mut kept = Vec::with_capacity(children.len());

    for child in children {
        let kind = child.kind.as_str();

        if is_expression(kind) && parent.expression.is_none() {
            parent.expression = Some(Expression {
                language: child.kind.clone(),
                text: child.text.clone(),
            });
            continue;
        }
        if kind == "description" && parent.description.is_none() {
            parent.description = Some(child.text.clone());
            continue;
        }
        if kind == "exception" {
            parent.exceptions.push(child.text.clone());
            continue;
        }
        if is_format(kind) && parent.format.is_none() {
            parent.format = Some(child.kind.clone());
            parent.attributes.extend(child.attributes);
            continue;
        }
        if FOLDED.contains(&kind) {
            let value = child
                .expression
                .as_ref()
                .map(|expression| expression.text.clone())
                .unwrap_or_else(|| child.text.clone());
            parent.attributes.push(Attribute { name: child.kind.clone(), value });
            continue;
        }
        kept.push(child);
    }

    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = r#"<beans>
  <routeContext id="route-1">
    <route factor-name="HTTP.TO.MQ" factor-trace="true" id="route-1">
      <from factor-name="HTTP" uri="jetty:http://0.0.0.0:8123"/>
      <to factor-name="Локальная очередь" uri="localmq://REQUEST.QUEUE?replyTo=REPLY.QUEUE"/>
    </route>
  </routeContext>
</beans>"#;

    #[test]
    fn reads_a_straight_route() {
        let graphs = parse_route_graphs(SIMPLE);
        assert_eq!(graphs.len(), 1);
        let graph = &graphs[0];
        assert_eq!(graph.name.as_deref(), Some("HTTP.TO.MQ"));
        assert!(graph.trace_enabled);
        assert_eq!(graph.steps, 2);
        assert_eq!(graph.nodes[0].kind, "from");
        assert_eq!(graph.nodes[0].label.as_deref(), Some("HTTP"));
        assert_eq!(graph.nodes[1].uri.as_deref(), Some("localmq://REQUEST.QUEUE?replyTo=REPLY.QUEUE"));
    }

    const BRANCHED: &str = r#"<beans>
  <route factor-name="WMS" id="route-2">
    <from factor-name="EIK XI" uri="eik-xi://https://0.0.0.0:50101/xi"/>
    <choice factor-component="ChoiceEndpoint" factor-name="Фильтр">
      <when>
        <simple>${headers.Interface} == 'SI_Out'</simple>
        <to factor-name="Ссылка на СОПС" uri="direct://Next"/>
      </when>
      <otherwise/>
    </choice>
  </route>
</beans>"#;

    #[test]
    fn keeps_branches_and_their_conditions() {
        let graph = &parse_route_graphs(BRANCHED)[0];
        let choice = &graph.nodes[1];
        assert_eq!(choice.kind, "choice");
        assert_eq!(choice.label.as_deref(), Some("Фильтр"));
        assert_eq!(choice.children.len(), 2, "ветки when и otherwise");

        let when = &choice.children[0];
        assert_eq!(when.kind, "when");
        assert_eq!(
            when.expression.as_ref().map(|e| e.text.as_str()),
            Some("${headers.Interface} == 'SI_Out'"),
            "условие ветки должно попасть в саму ветку, а не стать шагом",
        );
        assert_eq!(when.children.len(), 1);
        assert_eq!(when.children[0].kind, "to");
        assert_eq!(choice.children[1].kind, "otherwise");
    }

    const TRY: &str = r#"<beans>
  <route factor-name="BW" id="route-3">
    <from uri="direct://BW"/>
    <unmarshal factor-name="Преобразование форматов">
      <jaxb contextPath="gen.p15f7"/>
    </unmarshal>
    <transform factor-name="Трансформация">
      <groovy>return body.take(3)</groovy>
    </transform>
    <doTry factor-name="Попытка">
      <toD factor-name="SQL" uri="sql://DELETE FROM t;?dataSource=%23ds">
        <description lang="sql">DELETE FROM t;</description>
      </toD>
      <doCatch>
        <exception>java.lang.Exception</exception>
        <handled><constant>true</constant></handled>
        <log factor-name="Логирование" loggingLevel="INFO" message="monitoring"/>
      </doCatch>
    </doTry>
  </route>
</beans>"#;

    #[test]
    fn folds_formats_scripts_and_catch_details_into_their_step() {
        let graph = &parse_route_graphs(TRY)[0];
        assert_eq!(graph.nodes.len(), 4, "from, unmarshal, transform, doTry");

        let unmarshal = &graph.nodes[1];
        assert_eq!(unmarshal.format.as_deref(), Some("jaxb"));
        assert!(unmarshal.children.is_empty(), "формат не должен становиться шагом");
        assert!(unmarshal.attributes.iter().any(|a| a.name == "contextPath"));

        let transform = &graph.nodes[2];
        assert_eq!(transform.expression.as_ref().map(|e| e.language.as_str()), Some("groovy"));
        assert_eq!(transform.expression.as_ref().map(|e| e.text.as_str()), Some("return body.take(3)"));

        let try_node = &graph.nodes[3];
        let to_d = &try_node.children[0];
        assert_eq!(to_d.description.as_deref(), Some("DELETE FROM t;"));

        let catch = &try_node.children[1];
        assert_eq!(catch.kind, "doCatch");
        assert_eq!(catch.exceptions, vec!["java.lang.Exception".to_string()]);
        assert!(catch.attributes.iter().any(|a| a.name == "handled" && a.value == "true"));
        assert_eq!(catch.children.len(), 1, "в ветке остаётся только сам шаг лога");
        assert_eq!(catch.children[0].kind, "log");
    }

    #[test]
    fn takes_the_route_comment_out_of_the_steps() {
        let xml = r#"<route factor-name="Sched" factor-trace-config="TraceToQueue" id="r">
  <description lang="fesb:description">KITL ЧМПЗ</description>
  <from factor-name="Планировщик" uri="scheduler://every5m"/>
</route>"#;
        let graph = &parse_route_graphs(xml)[0];
        assert_eq!(graph.description.as_deref(), Some("KITL ЧМПЗ"));
        assert_eq!(graph.trace_config.as_deref(), Some("TraceToQueue"));
        assert_eq!(graph.steps, 1, "комментарий маршрута не шаг");
        assert_eq!(graph.nodes[0].kind, "from", "схема начинается с точки входа");
    }

    #[test]
    fn survives_a_broken_file() {
        let graphs = parse_route_graphs("<route><from uri=\"direct://a\"/>");
        assert_eq!(graphs.len(), 1);
        assert_eq!(graphs[0].nodes.len(), 1);
    }

    #[test]
    fn unwraps_cdata_in_scripts() {
        let xml = r#"<route id="r"><transform><groovy><![CDATA[if (a < b) return 1]]></groovy></transform></route>"#;
        let graph = &parse_route_graphs(xml)[0];
        assert_eq!(
            graph.nodes[0].expression.as_ref().map(|e| e.text.as_str()),
            Some("if (a < b) return 1"),
        );
    }
}
