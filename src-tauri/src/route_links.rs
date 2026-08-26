//! Связи СОПС между собой: кто кого вызывает.
//!
//! Маршруты соединяются через адрес: один пишет в `direct://Name` или
//! `localmq://QUEUE`, другой этим же адресом начинается. Совпадение адреса —
//! и есть связь.
//!
//! Одна тонкость решает всё: `direct` живёт в пределах одного CamelContext,
//! то есть одного домена. На настоящей выгрузке десять таких адресов заведены
//! в двух доменах сразу, и без ограничения по домену они дали бы сто двадцать
//! две несуществующие связи. `direct-vm` наоборот ходит между доменами.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::xml::{attr_value, decode_xml, local_name, parse_attributes, scan_tags};

/// Схемы, которые не выходят за пределы домена.
const DOMAIN_SCOPED: [&str; 2] = ["direct", "fesb-direct"];
/// Схемы прямого вызова: сообщение уходит в другой маршрут, а не в транспорт.
const CALL_SCHEMES: [&str; 4] = ["direct", "direct-vm", "fesb-direct", "fesb-direct-vm"];
/// Элементы, которые отправляют сообщение дальше.
const OUTGOING: [&str; 6] = ["to", "toD", "wireTap", "recipientList", "pollEnrich", "enrich"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRoute {
    pub id: Option<String>,
    pub name: Option<String>,
    pub domain: String,
    /// Папка домена — по ней связь отличается от одноимённой в другом домене.
    pub domain_dir: String,
    /// Файл маршрута: по нему открывается схема.
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteLink {
    /// Индексы в `routes`.
    pub from: usize,
    pub to: usize,
    pub uri: String,
    /// `call` — прямой вызов, `queue` — через транспорт.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraph {
    pub routes: Vec<LinkedRoute>,
    pub links: Vec<RouteLink>,
}

/// `direct://Name?x=1` → `direct:Name`. Схема в нижнем регистре, запрос отброшен.
fn normalize(uri: &str) -> Option<String> {
    let head = uri.split('?').next()?.trim();
    let (scheme, rest) = head.split_once(':')?;
    if scheme.is_empty() {
        return None;
    }
    Some(format!("{}:{}", scheme.to_lowercase(), rest.trim_start_matches("//")))
}

fn scheme_of(uri: &str) -> &str {
    uri.split(':').next().unwrap_or("")
}

struct Parsed {
    id: Option<String>,
    name: Option<String>,
    entries: Vec<String>,
    exits: Vec<String>,
}

/// Вытаскивает из файла маршрута его адреса: чем начинается и куда шлёт.
fn parse(xml: &str) -> Vec<Parsed> {
    let tags = scan_tags(xml);
    let mut routes: Vec<Parsed> = Vec::new();

    for tag in &tags {
        if tag.is_end {
            continue;
        }
        let name = local_name(&tag.name);
        if name == "route" {
            let attrs = parse_attributes(xml, tag.attrs_from, tag.attrs_to);
            routes.push(Parsed {
                id: attr_value(&attrs, "id"),
                name: attr_value(&attrs, "factor-name"),
                entries: Vec::new(),
                exits: Vec::new(),
            });
            continue;
        }

        let is_entry = name == "from";
        if !is_entry && !OUTGOING.contains(&name) {
            continue;
        }
        let Some(current) = routes.last_mut() else { continue };
        let attrs = parse_attributes(xml, tag.attrs_from, tag.attrs_to);
        let Some(uri) = attrs
            .iter()
            .find(|attr| local_name(&attr.name) == "uri")
            .map(|attr| decode_xml(&attr.value))
        else {
            continue;
        };
        let Some(normalized) = normalize(&uri) else { continue };
        if is_entry {
            current.entries.push(normalized);
        } else {
            current.exits.push(normalized);
        }
    }

    routes
}

/// Читает все маршруты выгрузки и связывает их по совпадению адресов.
pub fn build_links(root: &Path) -> LinkGraph {
    let domains_dir = if root.join("domains").is_dir() { root.join("domains") } else { root.to_path_buf() };

    let mut routes: Vec<LinkedRoute> = Vec::new();
    let mut entries: Vec<Vec<String>> = Vec::new();
    let mut exits: Vec<Vec<String>> = Vec::new();

    let Ok(domain_dirs) = fs::read_dir(&domains_dir) else {
        return LinkGraph { routes, links: Vec::new() };
    };
    let mut dirs: Vec<PathBuf> = domain_dirs.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
    dirs.sort();

    for dir in dirs {
        let domain_dir = dir.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        // Имя домена лежит в его settings.properties; без него остаётся папка.
        let domain = fs::read_to_string(dir.join("settings.properties"))
            .ok()
            .and_then(|text| crate::properties::parse_properties(&text).get("fesb.domain.name").cloned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| domain_dir.clone());

        let routes_dir = dir.join("routes");
        let Ok(files) = fs::read_dir(&routes_dir) else { continue };
        let mut paths: Vec<PathBuf> = files
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().is_some_and(|ext| ext == "xml")
                    && path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("route-"))
            })
            .collect();
        paths.sort();

        for path in paths {
            let Ok(xml) = fs::read_to_string(&path) else { continue };
            for parsed in parse(&xml) {
                routes.push(LinkedRoute {
                    id: parsed.id,
                    name: parsed.name,
                    domain: domain.clone(),
                    domain_dir: domain_dir.clone(),
                    path: path.to_string_lossy().to_string(),
                });
                entries.push(parsed.entries);
                exits.push(parsed.exits);
            }
        }
    }

    // Кто каким адресом начинается — по нему и ищутся вызывающие.
    let mut listeners: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, list) in entries.iter().enumerate() {
        for uri in list {
            listeners.entry(uri.as_str()).or_default().push(index);
        }
    }

    let mut links = Vec::new();
    for (from, list) in exits.iter().enumerate() {
        for uri in list {
            let Some(targets) = listeners.get(uri.as_str()) else { continue };
            let scheme = scheme_of(uri);
            let scoped = DOMAIN_SCOPED.contains(&scheme);
            for &to in targets {
                if to == from {
                    continue;
                }
                if scoped && routes[to].domain_dir != routes[from].domain_dir {
                    continue;
                }
                links.push(RouteLink {
                    from,
                    to,
                    uri: uri.clone(),
                    kind: if CALL_SCHEMES.contains(&scheme) { "call".into() } else { "queue".into() },
                });
            }
        }
    }

    LinkGraph { routes, links }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses_to_one_shape() {
        assert_eq!(normalize("direct://Name?x=1").as_deref(), Some("direct:Name"));
        assert_eq!(normalize("direct:Name").as_deref(), Some("direct:Name"));
        assert_eq!(normalize("LocalMQ://Q.NAME").as_deref(), Some("localmq:Q.NAME"));
        // схема с полным адресом внутри не должна пострадать
        assert_eq!(normalize("jetty:http://0.0.0.0:8123").as_deref(), Some("jetty:http://0.0.0.0:8123"));
        assert_eq!(normalize("не адрес"), None);
    }

    fn write(dir: &Path, domain: &str, name: &str, from: &str, to: &[&str]) {
        let routes = dir.join(domain).join("routes");
        fs::create_dir_all(&routes).unwrap();
        fs::write(
            dir.join(domain).join("settings.properties"),
            format!("fesb.domain.name={domain}\n"),
        )
        .unwrap();
        let steps: String = to
            .iter()
            .map(|uri| format!("<to uri=\"{uri}\"/>"))
            .collect();
        fs::write(
            routes.join(format!("route-{name}.xml")),
            format!(
                "<beans><route id=\"route-{name}\" factor-name=\"{name}\"><from uri=\"{from}\"/>{steps}</route></beans>"
            ),
        )
        .unwrap();
    }

    fn temp(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("fesb-links-{tag}-{unique}")).join("domains");
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn links_routes_that_share_an_address() {
        let dir = temp("basic");
        write(&dir, "alpha", "A", "jetty:http://0.0.0.0:80", &["direct://Next"]);
        write(&dir, "alpha", "B", "direct://Next", &["localmq://OUT"]);
        write(&dir, "beta", "C", "localmq://OUT", &[]);

        let graph = build_links(dir.parent().unwrap());
        assert_eq!(graph.routes.len(), 3);
        assert_eq!(graph.links.len(), 2);

        let call = graph.links.iter().find(|link| link.kind == "call").unwrap();
        assert_eq!(graph.routes[call.from].name.as_deref(), Some("A"));
        assert_eq!(graph.routes[call.to].name.as_deref(), Some("B"));

        // Очередь ходит между доменами, и это настоящая связь.
        let queue = graph.links.iter().find(|link| link.kind == "queue").unwrap();
        assert_eq!(graph.routes[queue.from].domain, "alpha");
        assert_eq!(graph.routes[queue.to].domain, "beta");

        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn does_not_link_direct_across_domains() {
        let dir = temp("scoped");
        write(&dir, "alpha", "A", "timer://tick", &["direct://Shared"]);
        write(&dir, "beta", "B", "direct://Shared", &[]);

        let graph = build_links(dir.parent().unwrap());
        assert!(
            graph.links.is_empty(),
            "direct живёт внутри домена, одноимённый адрес в другом — не связь",
        );

        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn links_direct_vm_across_domains() {
        let dir = temp("vm");
        write(&dir, "alpha", "A", "timer://tick", &["direct-vm://Shared"]);
        write(&dir, "beta", "B", "direct-vm://Shared", &[]);

        let graph = build_links(dir.parent().unwrap());
        assert_eq!(graph.links.len(), 1, "direct-vm ходит между доменами");
        assert_eq!(graph.links[0].kind, "call");

        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn ignores_a_route_calling_itself() {
        let dir = temp("self");
        write(&dir, "alpha", "A", "direct://Loop", &["direct://Loop"]);

        let graph = build_links(dir.parent().unwrap());
        assert!(graph.links.is_empty());

        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }
}
