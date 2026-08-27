//! Проверка режима API на живом стенде.
//!
//! Тест меняет конфигурацию домена и возвращает исходное значение обратно,
//! поэтому запускается только вручную и только на тестовой шине:
//!
//! ```sh
//! FESB_URL=http://localhost:8181/manager FESB_USER=root FESB_PASSWORD=root \
//!   cargo test --test api -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use fesb_toolkit_lib::testing::{
    access, apply_trace_change, audit, certificates, connect, delete_property, domain_statistics,
    domains, fetch_domain_routes, inflight_exchanges, listening_ports, log_entries, log_files,
    modules, properties, pull, push, queue_managers, queue_message, queue_messages, queue_search,
    queues, route_index, route_state, save_property, server_usage, verify,
    ApplyRequest, ApplyTarget, BeanTarget, Connection, LogRequest, ManagerKind, PropertyRow,
    PropertyScope, TraceUpdate,
};

/// Обёртка над рантаймом: приложение вызывает те же функции из команд Tauri.
fn block<F: std::future::Future>(task: F) -> F::Output {
    tauri::async_runtime::block_on(task)
}

fn connection() -> Option<Connection> {
    let url = std::env::var("FESB_URL").ok()?;
    Some(Connection {
        url,
        username: std::env::var("FESB_USER").unwrap_or_else(|_| "root".into()),
        password: std::env::var("FESB_PASSWORD").unwrap_or_else(|_| "root".into()),
        insecure: true,
    })
}

#[test]
#[ignore]
fn reads_the_server_state() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let info = tauri::async_runtime::block_on(connect(&connection)).expect("подключение");
    println!(
        "{} · пользователь {} · доменов {} (активных {}) · модулей {}",
        info.base_url, info.user, info.domains, info.active_domains, info.modules.len()
    );
    assert!(info.domains > 0, "сервер не отдал ни одного домена");
    assert!(
        info.missing_permissions.is_empty(),
        "не хватает прав: {:?}",
        info.missing_permissions
    );
}

/// Полный цикл: забрать домен, поменять broker, отправить обратно, вернуть как было.
#[test]
#[ignore]
fn round_trip_changes_the_broker_and_puts_it_back() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };

    let list = tauri::async_runtime::block_on(domains(&connection)).expect("список доменов");
    // Берём первый домен, в котором вообще есть объект трассировки с broker.
    let mut chosen: Option<(String, String, String, String)> = None;

    for candidate in list.iter().take(12) {
        let guids = vec![candidate.guid.clone()];
        let pulled = tauri::async_runtime::block_on(pull(&connection, Some(&guids), |_| {}))
            .expect("выгрузка домена");
        let root = PathBuf::from(&pulled.root);
        let scan = fesb_toolkit_lib::testing::scan_root(&root, |_| {});
        let Some(domain) = scan.domains.first() else { continue };
        let Some(trace) = domain.traces.iter().find(|item| item.broker.is_some()) else { continue };

        chosen = Some((
            candidate.guid.clone(),
            pulled.root.clone(),
            trace.bean_id.clone().unwrap_or_default(),
            trace.broker.clone().unwrap(),
        ));
        break;
    }

    let (guid, root, bean_id, original) = chosen.expect("не нашлось домена с broker");
    println!("домен {guid}: bean {bean_id}, broker {original}");

    let root_path = PathBuf::from(&root);
    let scan = fesb_toolkit_lib::testing::scan_root(&root_path, |_| {});
    let domain = scan.domains.first().unwrap().clone();
    let probe = format!("{original}.ROUNDTRIP");

    let send = |value: &str, expected: &str| {
        let request = ApplyRequest {
            update: TraceUpdate {
                broker: Some(value.to_string()),
                queue: None,
                trace_mode: None,
            },
            targets: vec![ApplyTarget {
                domain_xml_path: domain.domain_xml_path.clone(),
                domain_name: Some(domain.domain_name.clone()),
                beans: vec![BeanTarget {
                    bean_id: Some(bean_id.clone()),
                    bean_name: None,
                    expected_broker: Some(expected.to_string()),
                    expected_queue: None,
                    expected_trace_mode: None,
                }],
            }],
            make_backup: false,
            dry_run: false,
        };
        let report = apply_trace_change(&request, |_| {}).expect("правка файла");
        assert_eq!(report.summary.values_changed, 1, "значение не изменилось");

        let guids = vec![guid.clone()];
        tauri::async_runtime::block_on(push(&connection, &root_path, &guids, true, |_| {}))
            .expect("отправка на сервер");
    };

    send(&probe, &original);

    // Проверяем сервер: новое значение должно вернуться в следующей выгрузке.
    let guids = vec![guid.clone()];
    let again = tauri::async_runtime::block_on(pull(&connection, Some(&guids), |_| {})).unwrap();
    let check = fesb_toolkit_lib::testing::scan_root(&PathBuf::from(&again.root), |_| {});
    let after = check.domains.first().expect("домен пропал с сервера");
    let value = after
        .traces
        .iter()
        .find(|item| item.bean_id.as_deref() == Some(bean_id.as_str()))
        .and_then(|item| item.broker.clone())
        .expect("bean пропал");
    assert_eq!(value, probe, "сервер не принял новое значение");

    // И возвращаем всё как было — стенд должен остаться нетронутым.
    let restore_domain = after.clone();
    let request = ApplyRequest {
        update: TraceUpdate {
            broker: Some(original.clone()),
            queue: None,
            trace_mode: None,
        },
        targets: vec![ApplyTarget {
            domain_xml_path: restore_domain.domain_xml_path.clone(),
            domain_name: Some(restore_domain.domain_name.clone()),
            beans: vec![BeanTarget {
                bean_id: Some(bean_id.clone()),
                bean_name: None,
                expected_broker: Some(probe.clone()),
                expected_queue: None,
                expected_trace_mode: None,
            }],
        }],
        make_backup: false,
        dry_run: false,
    };
    apply_trace_change(&request, |_| {}).expect("возврат значения");
    tauri::async_runtime::block_on(push(&connection, &PathBuf::from(&again.root), &guids, true, |_| {}))
        .expect("возврат на сервер");

    let final_pull = tauri::async_runtime::block_on(pull(&connection, Some(&guids), |_| {})).unwrap();
    let final_scan = fesb_toolkit_lib::testing::scan_root(&PathBuf::from(&final_pull.root), |_| {});
    let restored = final_scan
        .domains
        .first()
        .unwrap()
        .traces
        .iter()
        .find(|item| item.bean_id.as_deref() == Some(bean_id.as_str()))
        .and_then(|item| item.broker.clone())
        .unwrap();
    assert_eq!(restored, original, "исходное значение не восстановлено");
    println!("значение вернулось: {restored}");
}

/// Идентификаторы не помещаются в один запрос — выгрузка должна идти пачками.
#[test]
#[ignore]
fn pulls_more_domains_than_fit_in_one_query() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };

    let list = tauri::async_runtime::block_on(domains(&connection)).expect("список доменов");
    // Одна пачка — сто идентификаторов, поэтому берём заведомо больше.
    let count: usize = std::env::var("FESB_PULL_COUNT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(150);
    let guids: Vec<String> = list.iter().take(count).map(|item| item.guid.clone()).collect();
    assert!(guids.len() > 100, "на стенде слишком мало доменов для этой проверки");

    let started = std::time::Instant::now();
    let mut steps = 0usize;
    let pulled = tauri::async_runtime::block_on(pull(&connection, Some(&guids), |progress| {
        steps += 1;
        println!("  {:>6.1}s  {} {} / {}", started.elapsed().as_secs_f32(), progress.phase, progress.current, progress.total);
    }))
    .expect("выгрузка пачками");
    println!("забрано {} доменов, {} файлов, {} байт", pulled.domains, pulled.files, pulled.bytes);
    assert!(steps > 2, "счётчик должен двигаться по ходу выгрузки, а не один раз в конце");
    assert_eq!(pulled.domains, guids.len(), "часть доменов потерялась между пачками");
    assert!(pulled.has_version);
}

/// Разделы, которые читаются напрямую: модули, очереди, константы, журналы.
#[test]
#[ignore]
fn reads_the_side_sections() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let list = block(modules(&connection)).expect("модули");
    println!("модулей {}", list.len());
    for module in list.iter().take(4) {
        println!("  {} · {} · работает {}", module.name, module.label, module.running);
    }
    assert!(list.iter().any(|item| item.name == "factor-broker"), "нет модуля брокера");

    let managers = block(queue_managers(&connection)).expect("менеджеры очередей");
    println!("менеджеров {}", managers.len());
    for manager in &managers {
        println!("  {} · {} · {}", manager.broker, manager.status, manager.id);
    }
    assert!(
        managers.iter().any(|item| item.broker == "QME:EQM"),
        "не нашёлся менеджер, на который ссылается трассировка",
    );

    // Очереди читаются и у остановленного менеджера — просто список пустой.
    let manager = managers.first().unwrap();
    let rows = block(queues(&connection, manager.kind, &manager.id)).expect("очереди");
    println!("очередей в {}: {}", manager.broker, rows.len());

    let app = block(properties(&connection, PropertyScope::Application)).expect("константы приложения");
    println!("констант приложения {}", app.len());
    assert!(!app.is_empty(), "на стенде должны быть константы приложения");

    let guid = block(domains(&connection)).expect("домены")[0].guid.clone();
    let domain_properties =
        block(properties(&connection, PropertyScope::Domain(guid))).expect("константы домена");
    println!("констант первого домена {}", domain_properties.len());

    let files = block(log_files(&connection)).expect("файлы журналов");
    println!("журналов {}, самый большой — {}", files.len(), files[0].name);
    assert!(files.iter().any(|item| item.name == "core.log"));

    let entries = block(log_entries(
        &connection,
        LogRequest {
            logs: vec!["core.log".into()],
            levels: vec!["ERROR".into()],
            search: None,
            limit: Some(3),
        },
    ))
    .expect("записи журнала");
    println!("записей ERROR {}", entries.len());
    for entry in entries.iter().take(2) {
        println!(
            "  {} {} {}",
            entry.timestamp.as_deref().unwrap_or("—"),
            entry.level.as_deref().unwrap_or("—"),
            entry.message.as_deref().unwrap_or("").lines().next().unwrap_or(""),
        );
    }
}

/// Единственная операция записи вне трассировки — константа. Проверяем цикл
/// «создать → изменить → удалить» и убираем за собой.
#[test]
#[ignore]
fn writes_and_removes_a_constant() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let key = "const.settings.editor.probe";
    let scope = || PropertyScope::Broker;

    let property = PropertyRow {
        key: key.into(),
        value: Some("first".into()),
        secured: false,
        vault: false,
        empty: false,
        description: Some("проверка из теста".into()),
    };
    block(save_property(&connection, scope(), property.clone(), true, None)).expect("создание");

    let after_create = block(properties(&connection, scope())).expect("чтение");
    let created = after_create.iter().find(|row| row.key == key).expect("константа не появилась");
    assert_eq!(created.value.as_deref(), Some("first"));

    let updated = PropertyRow { value: Some("second".into()), ..property };
    block(save_property(&connection, scope(), updated, false, None)).expect("изменение");

    let after_update = block(properties(&connection, scope())).expect("чтение");
    let changed = after_update.iter().find(|row| row.key == key).expect("константа пропала");
    assert_eq!(changed.value.as_deref(), Some("second"), "значение не изменилось");

    block(delete_property(&connection, scope(), key)).expect("удаление");
    let after_delete = block(properties(&connection, scope())).expect("чтение");
    assert!(
        !after_delete.iter().any(|row| row.key == key),
        "константа осталась на сервере",
    );
    println!("константа создана, изменена и удалена");
}

/// Сверка с сервером: на нетронутой выгрузке расхождений быть не должно,
/// а локальная правка без отправки обязана всплыть.
#[test]
#[ignore]
fn verification_notices_what_was_not_sent() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };

    let list = block(domains(&connection)).expect("список доменов");
    let mut chosen: Option<(String, String, String, String)> = None;
    for candidate in list.iter().take(12) {
        let guids = vec![candidate.guid.clone()];
        let pulled = block(pull(&connection, Some(&guids), |_| {})).expect("выгрузка");
        let root = PathBuf::from(&pulled.root);
        let scan = fesb_toolkit_lib::testing::scan_root(&root, |_| {});
        let Some(domain) = scan.domains.first() else { continue };
        let Some(trace) = domain.traces.iter().find(|item| item.broker.is_some()) else { continue };
        chosen = Some((
            candidate.guid.clone(),
            pulled.root.clone(),
            trace.bean_id.clone().unwrap_or_default(),
            trace.broker.clone().unwrap(),
        ));
        break;
    }
    let (guid, root, bean_id, original) = chosen.expect("не нашлось домена с broker");
    let root_path = PathBuf::from(&root);
    let guids = vec![guid.clone()];

    let clean = block(verify(&connection, &root_path, &guids, |_| {})).expect("сверка");
    println!("сверено доменов {}, значений {}", clean.domains, clean.values);
    assert!(clean.values > 0, "нечего было сверять");
    assert!(clean.mismatches.is_empty(), "расхождения на нетронутой выгрузке: {:?}", clean.mismatches);

    // Правим локально и НЕ отправляем: сверка должна это заметить.
    let scan = fesb_toolkit_lib::testing::scan_root(&root_path, |_| {});
    let domain = scan.domains.first().unwrap().clone();
    let request = ApplyRequest {
        update: TraceUpdate {
            broker: Some(format!("{original}.NOTSENT")),
            queue: None,
            trace_mode: None,
        },
        targets: vec![ApplyTarget {
            domain_xml_path: domain.domain_xml_path.clone(),
            domain_name: Some(domain.domain_name.clone()),
            beans: vec![BeanTarget {
                bean_id: Some(bean_id.clone()),
                bean_name: None,
                expected_broker: Some(original.clone()),
                expected_queue: None,
                expected_trace_mode: None,
            }],
        }],
        make_backup: false,
        dry_run: false,
    };
    apply_trace_change(&request, |_| {}).expect("правка файла");

    let dirty = block(verify(&connection, &root_path, &guids, |_| {})).expect("сверка после правки");
    let found = dirty
        .mismatches
        .iter()
        .find(|item| item.field == "broker")
        .expect("сверка не заметила неотправленную правку");
    assert_eq!(found.expected.as_deref(), Some(format!("{original}.NOTSENT").as_str()));
    assert_eq!(found.actual.as_deref(), Some(original.as_str()));
    println!("расхождение поймано: {} → {:?} вместо {:?}", found.domain, found.actual, found.expected);
}

/// Карта доменов и СОПС одного домена с живым состоянием.
#[test]
#[ignore]
fn reads_the_domain_map_and_live_routes() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };

    let stats = block(domain_statistics(&connection)).expect("статистика");
    let with_routes: Vec<_> = stats.iter().filter(|item| item.routes > 0).collect();
    println!(
        "доменов {}, из них с СОПС {}, всего СОПС {}",
        stats.len(),
        with_routes.len(),
        stats.iter().map(|item| item.routes).sum::<i64>(),
    );
    assert!(!stats.is_empty(), "статистика пуста");
    assert!(
        stats.iter().any(|item| item.name != item.guid),
        "имена доменов не подставились — остались одни guid",
    );

    // Берём домен, у которого точно есть маршруты.
    let target = with_routes.first().expect("ни у одного домена нет СОПС");
    let domain = block(fetch_domain_routes(&connection, &target.guid)).expect("СОПС домена");
    println!("{}: маршрутов {}", target.name, domain.routes.len());
    assert!(!domain.routes.is_empty(), "домен со счётчиком СОПС отдал пустой список");
    assert!(
        std::path::Path::new(&domain.routes[0].path).is_file(),
        "файл схемы не сохранён: {}",
        domain.routes[0].path,
    );

    // Состояние читается и у остановленного маршрута — списком так не получится.
    let route = domain.routes[0].id.clone().expect("у маршрута нет id");
    let state = block(route_state(&connection, &target.guid, &route)).expect("состояние СОПС");
    println!(
        "  {} · {} · обработано {} · ошибок {} · в работе {}",
        state.name.as_deref().unwrap_or("—"),
        state.state.as_deref().unwrap_or("—"),
        state.processed,
        state.failed,
        state.inflight,
    );
    assert_eq!(state.id, route);
}

/// Просмотр сообщений очереди. Нужен работающий менеджер и хотя бы одно
/// сообщение: `FESB_QUEUE=QMS:QM/SettingsEditor.Probe`.
#[test]
#[ignore]
fn reads_messages_of_a_queue() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let Ok(target) = std::env::var("FESB_QUEUE") else {
        eprintln!("FESB_QUEUE не задан — пропускаем");
        return;
    };
    let (broker, queue) = target.split_once('/').expect("ожидается вид QMS:QM/Имя.Очереди");
    let (prefix, id) = broker.split_once(':').expect("ожидается вид QMS:QM");
    let kind = match prefix {
        "QMS" => ManagerKind::Qms,
        "QME" => ManagerKind::Qme,
        _ => ManagerKind::Rqms,
    };

    let list = block(queue_messages(&connection, kind, id, queue, 50)).expect("список сообщений");
    println!("сообщений в {queue}: {}", list.len());
    assert!(!list.is_empty(), "очередь пуста — положите в неё сообщение");

    let first = &list[0];
    println!("  {} · {} байт · {:?}", first.id, first.size, first.timestamp);
    assert!(first.body.is_none(), "в списке шина тело не отдаёт");

    let full = block(queue_message(&connection, kind, id, queue, &first.id)).expect("сообщение");
    assert_eq!(full.id, first.id);
    let body = full.body.expect("тело не пришло или не декодировалось");
    println!("  тело: {body}");
    assert!(!body.is_empty());
    assert!(
        full.properties.iter().any(|item| !item.name.is_empty()),
        "свойства сообщения потерялись",
    );
}

/// Журнал аудита на живом стенде: он должен разбираться, а не оставаться текстом.
#[test]
#[ignore]
fn reads_the_audit_trail() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let entries = block(audit(
        &connection,
        LogRequest { logs: Vec::new(), levels: Vec::new(), search: None, limit: Some(500) },
    ))
    .expect("аудит");

    let actions: Vec<_> = entries.iter().filter(|item| item.kind == "action").collect();
    let sessions = entries.iter().filter(|item| item.kind == "session").count();
    let unknown = entries.iter().filter(|item| item.kind == "other").count();

    println!("записей {}, действий {}, сессий {sessions}, неразобранных {unknown}", entries.len(), actions.len());
    let mut kinds: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for item in &actions {
        *kinds.entry(item.action.as_deref().unwrap_or("—")).or_default() += 1;
    }
    for (name, count) in kinds.iter().take(8) {
        println!("  {name:38} {count}");
    }

    assert!(!entries.is_empty(), "аудит пуст");
    assert!(!actions.is_empty(), "ни одного действия не разобралось");
    assert!(
        actions.iter().all(|item| item.user.is_some()),
        "у действия должен быть пользователь",
    );
    assert!(
        actions.iter().any(|item| item.status == Some(200)),
        "ни у одного действия не разобрался код ответа",
    );
    // Инструмент сам ходит в шину, и его выгрузки обязаны быть в аудите.
    assert!(
        kinds.contains_key("BROKER_DOMAINS_EXPORT"),
        "не видно выгрузок доменов, которые делает само приложение",
    );
}

/// Указатель имён СОПС по всему серверу: по нему ищут домен.
#[test]
#[ignore]
fn builds_an_index_of_route_names() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };

    let started = std::time::Instant::now();
    let index = block(route_index(&connection, |_| {})).expect("указатель");
    let routes: usize = index.iter().map(|item| item.routes.len()).sum();
    println!(
        "доменов {}, имён СОПС {routes}, за {:.0} с",
        index.len(),
        started.elapsed().as_secs_f32(),
    );

    assert!(index.len() > 200, "доменов подозрительно мало: {}", index.len());
    assert!(routes > 2000, "имён СОПС подозрительно мало: {routes}");
    assert!(
        index.iter().any(|item| item.name != item.guid),
        "имена доменов не подставились",
    );
    // На диске после указателя ничего оставаться не должно.
    let leftovers = std::fs::read_dir(std::env::temp_dir().join("fesb-toolkit-routes"))
        .map(|entries| entries.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("index-")).count())
        .unwrap_or(0);
    assert_eq!(leftovers, 0, "временная папка указателя не убрана");
}

/// Отчёт по точкам входа и выхода: собирается со всего сервера.
#[test]
#[ignore]
fn builds_the_endpoint_report() {
    let Some(connection) = connection() else { return };
    let started = std::time::Instant::now();
    let points = block(fesb_toolkit_lib::testing::endpoint_report(&connection, |_| {})).unwrap();
    println!(
        "точек {}, за {:?}; входов {}, выходов {}",
        points.len(),
        started.elapsed(),
        points.iter().filter(|p| p.direction == "in").count(),
        points.iter().filter(|p| p.direction == "out").count(),
    );

    let mut schemes: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for point in &points {
        *schemes.entry(point.scheme.as_str()).or_default() += 1;
    }
    println!("схемы: {schemes:?}");
    println!("с портом: {}", points.iter().filter(|p| p.port.is_some()).count());
    println!("с TLS: {}", points.iter().filter(|p| p.ssl == Some(true)).count());
    for point in points.iter().take(4) {
        println!("  {} · {} · {} · {}", point.domain, point.route, point.direction, point.uri);
    }

    // Внутренних адресов в отчёте быть не должно — он про внешний мир.
    assert!(points.iter().all(|p| p.scheme != "direct" && p.scheme != "localmq"));
}

/// Настоящий отчёт настоящим файлом: битый xlsx ловится только на объёме.
#[test]
#[ignore]
fn writes_the_real_report_to_excel() {
    let Some(connection) = connection() else { return };
    let Ok(out) = std::env::var("XLSX_REPORT") else { return };
    let points = block(fesb_toolkit_lib::testing::endpoint_report(&connection, |_| {})).unwrap();

    let headers: Vec<String> = ["Домен", "guid Домена", "СОПС", "id СОПС", "Название точки",
        "Тип точки", "Endpoint (URL)", "Порт", "Протокол", "SSL", "Cipher suites", "Авторизация",
        "Состояние", "Uptime", "Занятые потоки", "Используемые потоки", "Свободные потоки",
        "Минимум потоков", "Максимум потоков", "Размер очереди", "Таймаут простоя", "Запас свободных"]
        .iter().map(|s| s.to_string()).collect();
    let number = |value: Option<i64>| value.map(|v| v.to_string()).unwrap_or_default();
    let rows: Vec<Vec<String>> = points.iter().map(|p| vec![
        p.domain.clone(), p.domain_guid.clone(), p.route.clone(), p.route_id.clone(),
        p.kind.clone(),
        if p.direction == "in" { "Вход".into() } else { "Выход".into() },
        p.uri.clone(), p.port.map(|v| v.to_string()).unwrap_or_default(),
        p.protocol.clone().unwrap_or_default(),
        p.ssl.map(|v| if v { "Да".to_string() } else { "Нет".to_string() }).unwrap_or_default(),
        p.ciphers.clone().unwrap_or_default(), p.auth.clone().unwrap_or_default(),
        p.state.clone().unwrap_or_default(), p.uptime.clone().unwrap_or_default(),
        number(p.busy_threads), number(p.utilized_threads), number(p.ready_threads),
        number(p.min_threads), number(p.max_threads), number(p.queue_size),
        number(p.idle_timeout), number(p.idle_threads),
    ]).collect();

    println!("строк {}, самая длинная ячейка {}", rows.len(),
        rows.iter().flatten().map(|c| c.chars().count()).max().unwrap_or(0));
    fesb_toolkit_lib::testing::write_xlsx(std::path::Path::new(&out), "Точки Входа и Выхода", &headers, &rows).unwrap();
}

/// Несколько строк отчёта для фикстуры dev-preview.
#[test]
#[ignore]
fn dump_endpoint_sample() {
    let Some(connection) = connection() else { return };
    if std::env::var("ENDPOINT_SAMPLE").is_err() { return }
    let points = block(fesb_toolkit_lib::testing::endpoint_report(&connection, |_| {})).unwrap();
    let mut sample: Vec<_> = points.iter().filter(|p| p.direction == "in").take(3).collect();
    sample.extend(points.iter().filter(|p| p.port.is_some()).take(3));
    sample.extend(points.iter().filter(|p| p.scheme == "https").take(3));
    println!("{}", serde_json::to_string(&sample).unwrap());
}

/// Сертификаты хранилищ: что лежит в `fesb.jks` и в доверенных хранилищах.
#[test]
#[ignore]
fn reads_the_certificates() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let report = block(certificates(&connection)).expect("сертификаты");
    println!("хранилищ {} · сертификатов {}", report.stores.len(), report.certificates.len());
    for store in &report.stores {
        println!("  {} · {} · сертификатов {}", store.name, store.kind, store.count);
    }
    for item in &report.certificates {
        println!(
            "  {}/{} · {} · выдан {} · до {} · {} {:?} бит · цепочка {}",
            item.store, item.alias, item.subject_name, item.issuer_name, item.not_after,
            item.key_algorithm, item.key_bits, item.chain,
        );
    }
    assert!(!report.stores.is_empty(), "шина не отдала ни одного хранилища");

    // Дата окончания нужна для главного вопроса раздела — «когда протухнет».
    for item in &report.certificates {
        assert!(!item.not_after.is_empty(), "у {} нет даты окончания", item.alias);
        assert!(!item.subject_name.is_empty(), "у {} не разобрано имя владельца", item.alias);
    }
}

/// Поиск текста в телах сообщений очереди.
#[test]
#[ignore]
fn searches_inside_message_bodies() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let managers = block(queue_managers(&connection)).expect("менеджеры очередей");
    let Some(manager) = managers.iter().find(|item| item.running) else {
        eprintln!("нет запущенного менеджера — пропускаем");
        return;
    };
    let rows = block(queues(&connection, manager.kind, &manager.id)).expect("очереди");
    let Some(queue) = rows.iter().find(|row| row.messages > 0) else {
        eprintln!("непустой очереди нет — пропускаем");
        return;
    };
    let listed = block(queue_messages(&connection, manager.kind, &manager.id, &queue.name, 40))
        .expect("сообщения");
    println!("{} · {} · сообщений {}", manager.broker, queue.name, listed.len());

    // Ищем то, что заведомо есть: кусок тела первого сообщения.
    let first = block(queue_message(&connection, manager.kind, &manager.id, &queue.name, &listed[0].id))
        .expect("сообщение целиком");
    let body = first.body.clone().unwrap_or_default();
    let needle: String = body.chars().filter(|c| !c.is_whitespace()).take(12).collect();
    if needle.is_empty() {
        eprintln!("тело пустое — пропускаем");
        return;
    }

    let ids: Vec<String> = listed.iter().map(|item| item.id.clone()).collect();
    let found = block(queue_search(&connection, manager.kind, &manager.id, &queue.name, ids, &needle, |_| {}))
        .expect("поиск");
    println!("искали «{needle}» — нашлось {}", found.len());
    for item in found.iter().take(3) {
        println!("  {} · {}", item.id, item.excerpt);
    }
    assert!(!found.is_empty(), "не нашлось даже то, что взято из тела");
    assert!(found.iter().all(|item| !item.excerpt.is_empty()), "вырезка пустая");

    // Заведомо отсутствующий текст не должен находиться.
    let ids: Vec<String> = listed.iter().map(|item| item.id.clone()).collect();
    let none = block(queue_search(
        &connection, manager.kind, &manager.id, &queue.name, ids,
        "нетакогослованигдевообще", |_| {},
    ))
    .expect("поиск");
    assert!(none.is_empty(), "нашлось то, чего нет: {none:?}");
}

/// Состояние сервера и незавершённые обмены.
#[test]
#[ignore]
fn reads_what_the_server_is_doing_right_now() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let usage = block(server_usage(&connection)).expect("состояние сервера");
    println!(
        "работает {:?} мс · FESB {:?} · {:?}",
        usage.uptime, usage.version, usage.os,
    );
    println!(
        "память {:?} из {:?} · процессоров {:?} · загрузка {:?}",
        usage.memory_used, usage.memory_max, usage.processors, usage.processor_usage,
    );
    for disk in &usage.disks {
        println!("  {} {:?} · занято {} из {}", disk.name, disk.path, disk.used, disk.total);
    }
    assert!(usage.uptime.unwrap_or(0) > 0, "шина не сказала, сколько работает");
    assert!(usage.version.is_some(), "нет версии");
    assert!(!usage.disks.is_empty(), "ни одного диска или каталога");
    assert!(usage.memory_max.unwrap_or(0) > 0, "нет размера памяти");

    let inflight = block(inflight_exchanges(&connection)).expect("незавершённые обмены");
    println!("незавершённых обменов {}", inflight.len());
    for item in inflight.iter().take(5) {
        println!(
            "  {} · {} / {} · шаг {:?} · {:?} мс",
            item.id, item.domain, item.route, item.node, item.duration,
        );
    }
    // Пустой список — нормальный ответ: значит, ничего не застряло.
    assert!(inflight.iter().all(|item| item.duration.unwrap_or(0) >= item.elapsed.unwrap_or(0)));
}

/// Роли, права и открытые сеансы.
#[test]
#[ignore]
fn reads_who_can_do_what() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    let report = block(access(&connection)).expect("роли и доступ");
    println!("ролей {} · прав {} · пользователей {}", report.roles.len(), report.permissions.len(), report.users.len());
    for role in &report.roles {
        println!("  {} · прав {} · областей {}", role.name, role.permissions.len(), role.scopes.len());
        for scope in &role.scopes {
            println!("      {}/{} → {}", scope.subject, scope.action, scope.values.join(", "));
        }
    }
    for user in &report.users {
        println!("  {} · сеансов {} · вход {:?}", user.user, user.sessions.len(), user.last_login);
        for session in &user.sessions {
            println!("      {} × {} · {:?}", session.ip, session.count, session.agent);
        }
    }
    assert!(!report.roles.is_empty(), "шина не отдала ни одной роли");
    assert!(!report.permissions.is_empty(), "нет справочника прав");
    // Каждое право роли должно находиться в справочнике — иначе описание
    // показать нечем, и колонка будет пустой.
    let known: std::collections::HashSet<&str> =
        report.permissions.iter().map(|item| item.name.as_str()).collect();
    for role in &report.roles {
        for permission in &role.permissions {
            assert!(known.contains(permission.as_str()), "право {permission} не описано в справочнике");
        }
    }
}

/// Проверка портов: шина отвечает, свободен ли порт на её хосте.
#[test]
#[ignore]
fn tells_which_ports_are_actually_taken() {
    let Some(connection) = connection() else {
        eprintln!("FESB_URL не задан — пропускаем");
        return;
    };
    // 8181 занят самой шиной; 9999 на тестовом стенде никем не занят.
    let known = block(listening_ports(&connection, &[8181, 9999]));
    println!("{known:?}");
    assert_eq!(known.get(&8181), Some(&true), "порт менеджера должен быть занят");
    assert_eq!(known.get(&9999), Some(&false), "9999 никем не слушается");
}
