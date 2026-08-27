//! Проверка парсера на настоящей выгрузке конфигурации.
//!
//! Тест помечен `#[ignore]`, потому что требует реальной папки:
//! `FESB_CORPUS=/путь/к/config-.../domains cargo test --test corpus -- --ignored --nocapture`

use std::collections::BTreeMap;
use std::path::PathBuf;

use fesb_toolkit_lib::testing::{create_archive, parse_domain_xml, parse_route_graphs, scan_root};

#[test]
#[ignore]
fn parses_real_export() {
    let Ok(root) = std::env::var("FESB_CORPUS") else {
        eprintln!("FESB_CORPUS не задан — пропускаем");
        return;
    };
    let root = PathBuf::from(root);
    let result = scan_root(&root, |_| {});

    let mut brokers: BTreeMap<String, usize> = BTreeMap::new();
    let mut traces = 0usize;
    let mut without_broker = 0usize;

    for domain in &result.domains {
        assert!(!domain.domain_name.is_empty(), "у домена нет имени: {}", domain.dir_path);
        for trace in &domain.traces {
            traces += 1;
            match &trace.broker {
                Some(value) => *brokers.entry(value.clone()).or_default() += 1,
                None => without_broker += 1,
            }
        }
    }

    // Контрольная сверка: количество найденных broker должно совпасть
    // с числом строк `<property name="broker"` в исходных файлах.
    let mut raw = 0usize;
    for domain in &result.domains {
        let xml = std::fs::read_to_string(&domain.domain_xml_path).unwrap();
        raw += xml.matches("<property name=\"broker\"").count();
        // повторный разбор не должен падать
        let _ = parse_domain_xml(&xml);
    }

    // СОПС: сверяем с числом элементов <route в исходных файлах.
    let mut routes = 0usize;
    let mut traced = 0usize;
    let mut inline = 0usize;
    let mut dangling = 0usize;
    let mut no_config = 0usize;
    let mut raw_routes = 0usize;

    for domain in &result.domains {
        let bean_ids: Vec<&str> = domain
            .traces
            .iter()
            .filter_map(|t| t.bean_id.as_deref())
            .collect();
        for route in &domain.routes {
            routes += 1;
            if route.trace_enabled {
                traced += 1;
            }
            if route.inline_trace_config {
                inline += 1;
            }
            if route.trace_enabled && route.trace_configs.is_empty() {
                no_config += 1;
            }
            // Ссылка на объект трассировки, которого нет в domain.xml этого домена
            // (обычно это общий bean из ../../broker/common.xml).
            if route.trace_configs.iter().any(|name| !bean_ids.contains(&name.as_str())) {
                dangling += 1;
            }
        }
        let routes_dir = std::path::Path::new(&domain.dir_path).join("routes");
        if let Ok(entries) = std::fs::read_dir(routes_dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|e| e == "xml") {
                    // Тег может переноситься на следующую строку, поэтому считаем
                    // `<route` с любым пробельным символом после имени.
                    let text = std::fs::read_to_string(entry.path()).unwrap();
                    raw_routes += text
                        .match_indices("<route")
                        .filter(|(index, _)| {
                            text[index + 6..].chars().next().is_some_and(char::is_whitespace)
                        })
                        .count();
                }
            }
        }
    }

    println!("доменов: {}", result.domains.len());
    println!("bean-ов трассировки: {traces} (без broker: {without_broker})");
    println!("значения broker: {brokers:?}");
    println!("СОПС: {routes}, с трассировкой: {traced}, без ссылки на объект: {no_config}, встроенный конфиг: {inline}, внешний bean: {dangling}");
    assert_eq!(raw, brokers.values().sum::<usize>(), "часть property broker не распознана");
    assert_eq!(raw_routes, routes, "часть маршрутов не распознана");
}

/// Полный цикл на копии настоящих файлов: замена + резервная копия + повторное сканирование.
#[test]
#[ignore]
fn applies_change_to_real_files() {
    use fesb_toolkit_lib::testing::{apply_trace_change, ApplyRequest, ApplyTarget, BeanTarget, TraceUpdate};

    let Ok(corpus) = std::env::var("FESB_CORPUS") else {
        eprintln!("FESB_CORPUS не задан — пропускаем");
        return;
    };

    // Работаем на копии, оригинальную выгрузку не трогаем.
    let sandbox = std::env::temp_dir().join(format!(
        "fesb-corpus-{}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&sandbox).unwrap();

    let mut copied = 0;
    for entry in std::fs::read_dir(&corpus).unwrap().flatten() {
        let src = entry.path().join("domain.xml");
        if !src.is_file() || copied >= 5 {
            continue;
        }
        let dst_dir = sandbox.join(entry.file_name());
        std::fs::create_dir_all(&dst_dir).unwrap();
        std::fs::copy(&src, dst_dir.join("domain.xml")).unwrap();
        let settings = entry.path().join("settings.properties");
        if settings.is_file() {
            std::fs::copy(&settings, dst_dir.join("settings.properties")).unwrap();
        }
        copied += 1;
    }

    let before = scan_root(&sandbox, |_| {});
    let targets: Vec<ApplyTarget> = before
        .domains
        .iter()
        .filter(|d| d.traces.iter().any(|t| t.broker_editable))
        .map(|d| ApplyTarget {
            domain_xml_path: d.domain_xml_path.clone(),
            domain_name: Some(d.domain_name.clone()),
            beans: d
                .traces
                .iter()
                .filter(|t| t.broker_editable)
                .map(|t| BeanTarget {
                    bean_id: t.bean_id.clone(),
                    bean_name: t.bean_name.clone(),
                    expected_broker: t.broker.clone(),
                    expected_queue: None,
                    expected_trace_mode: None,
                })
                .collect(),
        })
        .collect();
    assert!(!targets.is_empty(), "в копии нет ни одного изменяемого bean-а");

    let originals: Vec<(String, String)> = targets
        .iter()
        .map(|t| (t.domain_xml_path.clone(), std::fs::read_to_string(&t.domain_xml_path).unwrap()))
        .collect();

    let request = ApplyRequest {
        update: TraceUpdate { broker: Some("QMS:QM.SANDBOX".into()), queue: None, trace_mode: None },
        targets,
        make_backup: true,
        dry_run: false,
    };
    let report = apply_trace_change(&request, |_| {}).unwrap();
    assert_eq!(report.summary.failed, 0, "{:?}", report.results);
    assert!(report.summary.beans_changed > 0);

    // Изменились ровно значения broker и ничего больше.
    for (path, original) in &originals {
        let updated = std::fs::read_to_string(path).unwrap();
        assert!(!updated.contains("value=\"QME:EQM\""), "старое значение осталось в {path}");
        assert_eq!(
            original.replace("QME:EQM_MON", "§").replace("QME:EQM", "§").replace("QMS:QM.MONITORING", "§").replace("QMS:QM", "§"),
            updated.replace("QMS:QM.SANDBOX", "§"),
            "файл изменился где-то ещё: {path}"
        );
        assert!(std::path::Path::new(&format!("{path}.bak")).exists(), "нет .bak рядом с {path}");
        assert_eq!(&std::fs::read_to_string(format!("{path}.bak")).unwrap(), original);
    }

    // Повторное сканирование видит новые значения.
    let after = scan_root(&sandbox, |_| {});
    for domain in &after.domains {
        for trace in domain.traces.iter().filter(|t| t.broker_editable) {
            assert_eq!(trace.broker.as_deref(), Some("QMS:QM.SANDBOX"));
        }
    }

    println!("проверено файлов: {}", originals.len());
    std::fs::remove_dir_all(&sandbox).unwrap();
}

/// Сборка архива на настоящей выгрузке: структура и полнота содержимого.
#[test]
#[ignore]
fn builds_archive_from_real_export() {
    let Ok(corpus) = std::env::var("FESB_CORPUS") else {
        eprintln!("FESB_CORPUS не задан — пропускаем");
        return;
    };
    let root = PathBuf::from(corpus);
    let output = std::env::temp_dir().join(format!(
        "fesb-archive-{}.zip",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));

    let started = std::time::Instant::now();
    let result = create_archive(&root, &output, None, |_| {}).unwrap();
    let elapsed = started.elapsed();

    // Считаем файлы на диске тем же правилом, что и упаковщик.
    fn count(dir: &std::path::Path, backups: &mut usize) -> usize {
        let mut total = 0;
        let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                total += count(&path, backups);
            } else if name == ".DS_Store" || name == "Thumbs.db" {
                continue;
            } else if name.ends_with(".bak") || name.contains(".bak.") {
                *backups += 1;
            } else {
                total += 1;
            }
        }
        total
    }

    let mut backups = 0;
    let expected = count(&root, &mut backups) + usize::from(result.has_version);

    println!(
        "архив: {} файлов, {:.1} МБ, .bak исключено {}, за {:.1} с",
        result.files,
        result.bytes as f64 / 1024.0 / 1024.0,
        result.skipped_backups,
        elapsed.as_secs_f64(),
    );

    assert!(result.has_version, "файл version не попал в архив");
    assert_eq!(result.files, expected, "в архив попали не все файлы");
    assert_eq!(result.skipped_backups, backups);

    // Архив читается, и в корне лежит то, что ждёт шина.
    let file = std::fs::File::open(&output).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    assert_eq!(zip.len(), result.files);
    let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
    assert!(names.iter().any(|n| n == "version"));
    assert!(names.iter().all(|n| n == "version" || n.starts_with("domains/")));
    assert!(names.iter().any(|n| n.contains("/.history/")), ".history должен сохраняться как в оригинале");
    assert!(!names.iter().any(|n| n.ends_with(".bak")));

    std::fs::remove_file(&output).unwrap();
}

/// Схемы СОПС на всём корпусе: разбор не должен ни падать, ни терять шаги.
#[test]
#[ignore]
fn parses_every_route_into_a_graph() {
    let Ok(root) = std::env::var("FESB_CORPUS") else {
        eprintln!("FESB_CORPUS не задан — пропускаем");
        return;
    };

    let mut files = Vec::new();
    collect_routes(&PathBuf::from(root), &mut files);
    assert!(files.len() > 2000, "в корпусе должно быть больше двух тысяч СОПС, найдено {}", files.len());

    let mut graphs = 0usize;
    let mut steps = 0usize;
    let mut without_from = Vec::new();
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();

    for file in &files {
        let xml = std::fs::read_to_string(file).unwrap();
        let parsed = parse_route_graphs(&xml);
        assert!(!parsed.is_empty(), "маршрут не разобрался: {}", file.display());

        for graph in parsed {
            graphs += 1;
            steps += graph.steps;
            // Любая схема начинается с точки входа — иначе разбор потерял начало.
            match graph.nodes.first() {
                Some(node) if node.kind == "from" => {}
                _ => without_from.push(file.clone()),
            }
            walk(&graph.nodes, &mut kinds);
        }
    }

    println!("схем {graphs}, шагов {steps}");
    println!("частые шаги:");
    let mut top: Vec<_> = kinds.iter().collect();
    top.sort_by(|a, b| b.1.cmp(a.1));
    for (kind, count) in top.iter().take(15) {
        println!("  {kind:20} {count}");
    }

    assert!(without_from.is_empty(), "схемы без точки входа: {:?}", &without_from[..without_from.len().min(3)]);
    // Ни один язык выражений не должен остаться отдельным шагом.
    for language in ["simple", "groovy", "xpath", "spel", "constant", "jaxb", "json", "description", "exception"] {
        assert_eq!(kinds.get(language), None, "{language} должен сворачиваться в шаг, а не быть шагом");
    }
    assert!(steps > 10_000, "шагов подозрительно мало: {steps}");
}

fn walk(nodes: &[fesb_toolkit_lib::testing::RouteNode], kinds: &mut BTreeMap<String, usize>) {
    for node in nodes {
        *kinds.entry(node.kind.clone()).or_default() += 1;
        walk(&node.children, kinds);
    }
}

fn collect_routes(dir: &PathBuf, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_routes(&path, files);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("route-") && name.ends_with(".xml"))
        {
            files.push(path);
        }
    }
}

/// Служебный прогон: печатает разбор одного файла в JSON.
/// `FESB_ROUTE=/путь/route-….xml cargo test --test corpus dump_route -- --ignored --nocapture`
#[test]
#[ignore]
fn dump_route() {
    let Ok(file) = std::env::var("FESB_ROUTE") else { return };
    let xml = std::fs::read_to_string(file).unwrap();
    println!("{}", serde_json::to_string(&parse_route_graphs(&xml)).unwrap());
}

/// Связи СОПС на всём корпусе: граф должен быть настоящим и без выдумок.
#[test]
#[ignore]
fn links_routes_across_the_real_export() {
    let Ok(root) = std::env::var("FESB_CORPUS") else {
        eprintln!("FESB_CORPUS не задан — пропускаем");
        return;
    };
    let graph = fesb_toolkit_lib::testing::build_links(&PathBuf::from(root));

    let mut by_kind: BTreeMap<&str, usize> = BTreeMap::new();
    let mut cross = 0usize;
    for link in &graph.links {
        *by_kind.entry(link.kind.as_str()).or_default() += 1;
        if graph.routes[link.from].domain_dir != graph.routes[link.to].domain_dir {
            cross += 1;
        }
    }
    let linked: std::collections::BTreeSet<usize> =
        graph.links.iter().flat_map(|link| [link.from, link.to]).collect();

    println!("маршрутов {}, связей {}", graph.routes.len(), graph.links.len());
    println!("  по видам: {by_kind:?}");
    println!("  между доменами: {cross}");
    println!("  участвуют в связях: {} маршрутов", linked.len());

    assert!(graph.routes.len() > 2000, "маршрутов подозрительно мало");
    assert!(graph.links.len() > 1000, "связей подозрительно мало: {}", graph.links.len());
    assert!(cross > 0, "связей между доменами не нашлось вовсе");

    // Ни один маршрут не должен ссылаться сам на себя.
    assert!(graph.links.iter().all(|link| link.from != link.to));

    // `direct` не выходит за пределы домена — на этом корпусе такие адреса есть.
    for link in &graph.links {
        if link.uri.starts_with("direct:") && !link.uri.starts_with("direct-vm:") {
            assert_eq!(
                graph.routes[link.from].domain_dir, graph.routes[link.to].domain_dir,
                "direct связал разные домены: {}", link.uri,
            );
        }
    }
}

/// Служебный прогон: печатает связи одного маршрута в JSON для просмотра вёрстки.
#[test]
#[ignore]
fn dump_links() {
    let (Ok(root), Ok(file)) = (std::env::var("FESB_CORPUS"), std::env::var("FESB_ROUTE")) else { return };
    let graph = fesb_toolkit_lib::testing::build_links(&PathBuf::from(root));
    let mine: Vec<usize> = graph
        .routes
        .iter()
        .enumerate()
        .filter(|(_, route)| route.path == file)
        .map(|(index, _)| index)
        .collect();
    let payload: Vec<_> = graph
        .links
        .iter()
        .filter(|link| mine.contains(&link.from) || mine.contains(&link.to))
        .collect();
    println!("LINKS {}", serde_json::to_string(&payload).unwrap());
    println!("ROUTES {}", serde_json::to_string(&graph.routes).unwrap());
}
