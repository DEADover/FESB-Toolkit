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

use fesb_settings_editor_lib::testing::{
    apply_trace_change, connect, domains, pull, push, ApplyRequest, ApplyTarget, BeanTarget,
    Connection, TraceUpdate,
};

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
        let scan = fesb_settings_editor_lib::testing::scan_root(&root, |_| {});
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
    let scan = fesb_settings_editor_lib::testing::scan_root(&root_path, |_| {});
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
    let check = fesb_settings_editor_lib::testing::scan_root(&PathBuf::from(&again.root), |_| {});
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
    let final_scan = fesb_settings_editor_lib::testing::scan_root(&PathBuf::from(&final_pull.root), |_| {});
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
    let guids: Vec<String> = list.iter().take(150).map(|item| item.guid.clone()).collect();
    assert!(guids.len() > 100, "на стенде слишком мало доменов для этой проверки");

    let pulled = tauri::async_runtime::block_on(pull(&connection, Some(&guids), |_| {}))
        .expect("выгрузка пачками");
    println!("забрано {} доменов, {} файлов, {} байт", pulled.domains, pulled.files, pulled.bytes);
    assert_eq!(pulled.domains, guids.len(), "часть доменов потерялась между пачками");
    assert!(pulled.has_version);
}
