//! Разбор файлов маршрутов (СОПС — схем обработки потоков сообщений).
//!
//! По сути это обычные route Apache Camel. Нас интересует, включена ли в маршруте
//! трассировка (`factor-trace`) и на какой объект трассировки он ссылается
//! (`factor-trace-config`).

use serde::Serialize;

use crate::xml::{attr_value, local_name, parse_attributes, scan_tags};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    pub id: Option<String>,
    /// Человекочитаемое имя СОПС из атрибута `factor-name`.
    pub name: Option<String>,
    pub trace_enabled: bool,
    /// Имена bean-ов трассировки, на которые ссылается маршрут.
    pub trace_configs: Vec<String>,
    /// Конфигурация задана JSON-ом прямо в маршруте, а не ссылкой на bean.
    pub inline_trace_config: bool,
}

/// Извлекает маршруты из одного файла `route-*.xml`.
pub fn parse_routes(xml: &str) -> Vec<RouteInfo> {
    let mut routes = Vec::new();

    for tag in scan_tags(xml) {
        if tag.is_end || local_name(&tag.name) != "route" {
            continue;
        }
        let attrs = parse_attributes(xml, tag.attrs_from, tag.attrs_to);
        let raw_config = attr_value(&attrs, "factor-trace-config").unwrap_or_default();
        // Конфигурация бывает трёх видов: ссылка на bean, несколько ссылок через
        // запятую и встроенный JSON — последний к bean-ам домена не относится.
        let inline = raw_config.trim_start().starts_with('{');

        routes.push(RouteInfo {
            id: attr_value(&attrs, "id"),
            name: attr_value(&attrs, "factor-name"),
            trace_enabled: attr_value(&attrs, "factor-trace").as_deref() == Some("true"),
            trace_configs: if inline {
                Vec::new()
            } else {
                raw_config
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect()
            },
            inline_trace_config: inline,
        });
    }

    routes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_trace_flags_and_config_references() {
        let xml = r#"<beans>
    <routeContext id="route-1">
        <route factor-name="ERP.Get" factor-trace="true"
            factor-trace-config="TraceToQueue,MC.TRACE" id="route-1" streamCache="true">
            <from uri="scheduler://x"/>
        </route>
        <route factor-name="ERP.Put" factor-trace="false" factor-trace-config="" id="route-2"/>
        <route factor-name="ERP.Inline" factor-trace="true"
            factor-trace-config="{&quot;configType&quot;:&quot;COMMON&quot;}" id="route-3"/>
    </routeContext>
</beans>"#;

        let routes = parse_routes(xml);
        assert_eq!(routes.len(), 3);

        assert_eq!(routes[0].name.as_deref(), Some("ERP.Get"));
        assert!(routes[0].trace_enabled);
        assert_eq!(routes[0].trace_configs, vec!["TraceToQueue", "MC.TRACE"]);
        assert!(!routes[0].inline_trace_config);

        assert!(!routes[1].trace_enabled);
        assert!(routes[1].trace_configs.is_empty());

        assert!(routes[2].inline_trace_config);
        assert!(routes[2].trace_configs.is_empty());
    }

    #[test]
    fn ignores_route_context_and_nested_elements() {
        let xml = r#"<routeContext id="ctx"><route id="r" factor-trace="true"><to uri="direct:x"/></route></routeContext>"#;
        assert_eq!(parse_routes(xml).len(), 1);
    }
}
