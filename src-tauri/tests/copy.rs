//! Копирование домена между двумя живыми стендами.
//!
//! Перезаписывает домен на целевом стенде, поэтому запускается вручную и только
//! на тестовых шинах:
//!
//! ```sh
//! FESB_URL=http://localhost:8181/manager FESB_TARGET_URL=http://localhost:8281/manager \
//! FESB_COPY_DOMAIN=domain-<guid> cargo test --test copy -- --ignored --nocapture
//! ```

use fesb_toolkit_lib::testing::{copy_plan, copy_run, Connection, RouteChange};

fn block<F: std::future::Future>(task: F) -> F::Output {
    tauri::async_runtime::block_on(task)
}

fn stand(variable: &str) -> Option<Connection> {
    Some(Connection {
        url: std::env::var(variable).ok()?,
        username: std::env::var("FESB_USER").unwrap_or_else(|_| "root".into()),
        password: std::env::var("FESB_PASSWORD").unwrap_or_else(|_| "root".into()),
        insecure: true,
    })
}

#[test]
#[ignore]
fn a_copied_domain_matches_its_source() {
    let (Some(source), Some(target), Ok(guid)) =
        (stand("FESB_URL"), stand("FESB_TARGET_URL"), std::env::var("FESB_COPY_DOMAIN"))
    else {
        eprintln!("FESB_URL, FESB_TARGET_URL и FESB_COPY_DOMAIN не заданы — пропускаю");
        return;
    };
    let guids = vec![guid.clone()];

    let before = block(copy_plan(&source, &target, &guids, |_| {})).expect("предпросмотр");
    for domain in &before.domains {
        println!("{} exists={} settings_changed={}", domain.name, domain.exists, domain.settings_changed);
        for route in &domain.routes {
            println!("  {:?} {}", route.change, route.name.as_deref().unwrap_or(&route.id));
        }
    }

    let result = block(copy_run(&target, &before.id, true, true, |_| {})).expect("загрузка");
    assert!(result.domains.iter().all(|item| item.error.is_none()), "{:?}", result.domains);

    // Повторный предпросмотр — проверка сразу двух вещей: домен дошёл целиком,
    // а одинаковые СОПС на двух серверах сравниваются как одинаковые.
    let after = block(copy_plan(&source, &target, &guids, |_| {})).expect("повторный предпросмотр");
    let domain = &after.domains[0];
    assert!(domain.exists);
    assert!(!domain.settings_changed, "настройки домена совпадают после копирования");
    for route in &domain.routes {
        assert_eq!(route.change, RouteChange::Same, "{}", route.name.as_deref().unwrap_or(&route.id));
    }

    // Второй предпросмотр занял место первого: старый id больше не действует.
    let stale = block(copy_run(&target, &before.id, true, true, |_| {}));
    assert!(stale.is_err(), "загрузка по устаревшему предпросмотру не проходит");
}
