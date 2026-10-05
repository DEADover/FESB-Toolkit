//! Паспорт стенда: всё, что нужно сопровождению, одним обходом.
//!
//! Описание стенда для передачи на сопровождение собирается из того, что
//! уже есть по разным экранам: домены, СОПС, их связи, точки входа и выхода,
//! очереди, константы, сертификаты. Живые сведения (состояния, счётчики,
//! очереди, константы, сертификаты) интерфейс берёт своими запросами, а здесь
//! — то, для чего нужен сам конфиг: описания доменов и СОПС, адреса и связи.
//! Конфиг выкачивается один раз, и из одних и тех же файлов читается всё.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::api_report::Endpoint;
use crate::fesb_api::{finish_endpoints, walk_domains, ApiProgress, Connection, ManifestDomain};
use crate::properties::parse_properties;
use crate::route_graph::parse_route_graphs;
use crate::route_links::{self, DomainRoutes};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassportDomain {
    pub guid: String,
    pub name: String,
    /// Описание домена из его настроек — обычно номер заявки и назначение.
    pub description: Option<String>,
    pub tags: Option<String>,
    pub group: Option<String>,
    pub routes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassportRoute {
    pub domain_guid: String,
    pub domain: String,
    pub id: Option<String>,
    pub name: Option<String>,
    /// Комментарий автора схемы — ближайшее к «назначению» СОПС, что есть в конфиге.
    pub description: Option<String>,
    pub steps: usize,
    pub transacted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassportLink {
    pub from_domain: String,
    pub from_route: String,
    pub to_domain: String,
    pub to_route: String,
    pub uri: String,
    /// `call` — прямой вызов, `queue` — через очередь.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassportWalk {
    pub domains: Vec<PassportDomain>,
    pub routes: Vec<PassportRoute>,
    pub endpoints: Vec<Endpoint>,
    pub links: Vec<PassportLink>,
}

/// Что читается из одной папки домена.
struct DomainPart {
    domain: PassportDomain,
    routes: Vec<PassportRoute>,
    endpoints: Vec<Endpoint>,
    links: DomainRoutes,
}

fn non_empty(value: Option<&String>) -> Option<String> {
    value.map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

/// `route-1:part-2` → `route-1`: дополнительный маршрут принадлежит СОПС.
pub(crate) fn parent_id(id: &str) -> String {
    id.split(':').next().unwrap_or(id).to_string()
}

fn read_part(dir: &Path, manifest: &ManifestDomain, server_manager: Option<&str>) -> DomainPart {
    let settings = fs::read_to_string(dir.join("settings.properties")).map(|text| parse_properties(&text)).unwrap_or_default();

    let mut routes = Vec::new();
    if let Ok(entries) = fs::read_dir(dir.join("routes")) {
        let mut paths: Vec<_> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("route-") && name.ends_with(".xml"))
            })
            .collect();
        paths.sort();
        for path in paths {
            let Ok(xml) = fs::read_to_string(&path) else { continue };
            // Один СОПС — один файл. Дополнительные маршруты внутри него
            // (`route-…:…`) FESB считает частями того же СОПС, и в паспорте
            // они складываются в его строку, а не идут отдельными.
            let mut graphs = parse_route_graphs(&xml).into_iter();
            let Some(main) = graphs.next() else { continue };
            let mut route = PassportRoute {
                domain_guid: manifest.guid.clone(),
                domain: manifest.name.clone(),
                id: main.id.as_deref().map(parent_id),
                name: main.name,
                description: non_empty(main.description.as_ref()),
                steps: main.steps,
                transacted: main.transaction.is_some(),
            };
            for part in graphs {
                route.steps += part.steps;
                route.transacted |= part.transaction.is_some();
                if route.description.is_none() {
                    route.description = non_empty(part.description.as_ref());
                }
            }
            routes.push(route);
        }
    }

    DomainPart {
        domain: PassportDomain {
            guid: manifest.guid.clone(),
            name: manifest.name.clone(),
            description: non_empty(settings.get("fesb.domain.description")),
            tags: non_empty(settings.get("fesb.domain.tags")),
            group: manifest.group.clone().filter(|group| !group.is_empty()),
            routes: routes.len(),
        },
        routes,
        endpoints: crate::api_report::endpoints_of_domain(dir, &manifest.name, &manifest.guid, server_manager),
        links: route_links::read_domain(dir),
    }
}

/// Обходит весь стенд и собирает конфигурационную часть паспорта.
pub async fn walk<F: FnMut(ApiProgress)>(connection: &Connection, on_progress: F) -> Result<PassportWalk, String> {
    let server_manager = crate::api_report::server_queue_manager(connection).await;
    let parts = walk_domains(connection, on_progress, |dir, domain| read_part(dir, domain, server_manager.as_deref())).await?;

    let mut domains = Vec::with_capacity(parts.len());
    let mut routes = Vec::new();
    let mut endpoints = Vec::new();
    let mut link_parts = Vec::with_capacity(parts.len());
    for part in parts {
        domains.push(part.domain);
        routes.extend(part.routes);
        endpoints.extend(part.endpoints);
        link_parts.push(part.links);
    }

    let graph = route_links::connect(link_parts);
    let label = |index: usize| {
        let route = &graph.routes[index];
        (route.domain.clone(), route.name.clone().or_else(|| route.id.clone()).unwrap_or_default())
    };
    let mut links: Vec<PassportLink> = graph
        .links
        .iter()
        .map(|link| {
            let (from_domain, from_route) = label(link.from);
            let (to_domain, to_route) = label(link.to);
            PassportLink { from_domain, from_route, to_domain, to_route, uri: link.uri.clone(), kind: link.kind.clone() }
        })
        .collect();
    links.sort_by(|a, b| {
        (a.from_domain.to_lowercase(), a.from_route.to_lowercase(), a.to_domain.to_lowercase())
            .cmp(&(b.from_domain.to_lowercase(), b.from_route.to_lowercase(), b.to_domain.to_lowercase()))
    });
    links.dedup_by(|a, b| a.from_domain == b.from_domain && a.from_route == b.from_route && a.to_domain == b.to_domain && a.to_route == b.to_route && a.uri == b.uri);

    domains.sort_by_key(|domain| domain.name.to_lowercase());
    routes.sort_by_key(|route| (route.domain.to_lowercase(), route.name.clone().unwrap_or_default().to_lowercase()));
    let endpoints = finish_endpoints(connection, endpoints).await;

    Ok(PassportWalk { domains, routes, endpoints, links })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_domain_folder_gives_its_description_routes_and_points() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("fesb-passport-{unique}")).join("domain-1");
        fs::create_dir_all(dir.join("routes")).unwrap();
        fs::write(
            dir.join("settings.properties"),
            "fesb.domain.name=Orders\nfesb.domain.description=CR 101 \\u0417\\u0430\\u043A\\u0430\\u0437\\u044B\nfesb.domain.tags=\n",
        )
        .unwrap();
        fs::write(
            dir.join("routes/route-1.xml"),
            r#"<routes><route id="route-1" factor-name="Orders.In"><description>Приём заказов</description>
                <from uri="jetty:http://0.0.0.0:8080/orders"/><to uri="direct:Orders.Save"/></route>
                <route id="route-1:extra" factor-name="Orders.In"><from uri="direct:Orders.Retry"/><to uri="log:y"/></route></routes>"#,
        )
        .unwrap();
        fs::write(
            dir.join("routes/route-2.xml"),
            r#"<routes><route id="route-2" factor-name="Orders.Save"><from uri="direct:Orders.Save"/><to uri="log:x"/></route></routes>"#,
        )
        .unwrap();

        let manifest = ManifestDomain { guid: "domain-1".into(), name: "Orders".into(), group: None, mode: None };
        let part = read_part(&dir, &manifest, None);
        assert_eq!(part.domain.description.as_deref(), Some("CR 101 Заказы"));
        assert_eq!(part.domain.tags, None, "пустые теги — то же, что никаких");
        assert_eq!(part.domain.routes, 2, "дополнительный маршрут — часть своего СОПС");
        assert_eq!(part.routes[0].description.as_deref(), Some("Приём заказов"));
        assert_eq!(part.routes[0].id.as_deref(), Some("route-1"));
        assert_eq!(part.routes[0].steps, 4, "шаги дополнительного маршрута складываются");
        assert_eq!(part.endpoints.len(), 1, "внутренний direct точкой не считается");

        let graph = route_links::connect(vec![part.links]);
        assert_eq!(graph.links.len(), 1);
        assert_eq!(graph.links[0].kind, "call");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }
}
