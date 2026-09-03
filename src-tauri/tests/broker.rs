//! Проверка брокера на живом стенде.
//!
//! Тест только читает: подключается, спрашивает у брокера имя и отключается —
//! ни очередей, ни сообщений он не трогает. Живой брокер нужен обязательно,
//! поэтому запускается вручную:
//!
//! ```sh
//! AMQP_HOST=localhost AMQP_PORT=61617 \
//!   cargo test --test broker -- --ignored --nocapture
//! ```
//!
//! Порт по умолчанию — 61617: это приёмник Artemis (модуль QME), который
//! отдаёт AMQP 1.0. У ActiveMQ Classic (модуль QMS) на 61616 живёт OpenWire,
//! и клиент AMQP там получает отказ на рукопожатии.

use fesb_toolkit_lib::testing::{broker_endpoints, grant_broker_access, probe_broker, BrokerProfile, Connection};

fn profile() -> Option<BrokerProfile> {
    let host = std::env::var("AMQP_HOST").ok()?;
    Some(BrokerProfile {
        name: "живой стенд".into(),
        host,
        port: std::env::var("AMQP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(61617),
        username: std::env::var("AMQP_USER").unwrap_or_default(),
        password: std::env::var("AMQP_PASSWORD").unwrap_or_default(),
        sasl_anonymous: std::env::var("AMQP_USER").is_err(),
        connect_timeout_secs: 10,
        ..BrokerProfile::default()
    })
}

#[test]
#[ignore]
fn the_stand_broker_answers() {
    let Some(profile) = profile() else {
        eprintln!("AMQP_HOST не задан — проверять нечего");
        return;
    };

    let answer = tauri::async_runtime::block_on(probe_broker(profile))
        .expect("брокер должен ответить на подключение");

    println!(
        "брокер: {} за {} мс, имя: {}",
        answer.endpoint,
        answer.connect_ms,
        answer.broker_name.as_deref().unwrap_or("— не ответил на управляющий запрос"),
    );
    if let Some(note) = &answer.note {
        println!("управляющий канал: {note}");
    }

    assert!(!answer.endpoint.is_empty(), "адрес подключения не должен быть пустым");
}

/// Подключение к шине того же стенда — из тех же переменных, что и у остальных
/// ручных тестов.
fn bus() -> Option<Connection> {
    Some(Connection {
        url: std::env::var("FESB_URL").ok()?,
        username: std::env::var("FESB_USER").unwrap_or_default(),
        password: std::env::var("FESB_PASSWORD").unwrap_or_default(),
        insecure: true,
    })
}

/// Шина знает свои менеджеры очередей и порты их приёмников — на этом стоит
/// выбор брокера в настройках стенда.
#[test]
#[ignore]
fn the_bus_lists_its_brokers() {
    let Some(connection) = bus() else {
        eprintln!("FESB_URL не задан — проверять нечего");
        return;
    };

    let list = tauri::async_runtime::block_on(broker_endpoints(&connection))
        .expect("шина должна отдать список менеджеров");

    for item in &list {
        println!(
            "{} · {}:{} · приёмник {} · {}",
            item.server,
            item.host,
            item.port,
            item.acceptor,
            if item.running { "запущен" } else { "остановлен" },
        );
    }
    assert!(!list.is_empty(), "на стенде должен быть хотя бы один менеджер QME");
}

/// Выдача доступа не переписывает то, что уже настроено: второй запуск
/// обязан ничего не менять, иначе кнопка «Настроить доступ» тихо меняла бы
/// пароль работающему пользователю.
#[test]
#[ignore]
fn granting_access_twice_changes_nothing() {
    let (Some(connection), Ok(server), Ok(user)) = (
        bus(),
        std::env::var("AMQP_SERVER"),
        std::env::var("AMQP_USER"),
    ) else {
        eprintln!("нужны FESB_URL, AMQP_SERVER и AMQP_USER — проверять нечего");
        return;
    };
    let password = std::env::var("AMQP_PASSWORD").unwrap_or_default();

    let first = tauri::async_runtime::block_on(
        grant_broker_access(&connection, &server, &user, &password),
    ).expect("доступ должен выдаваться");
    let again = tauri::async_runtime::block_on(
        grant_broker_access(&connection, &server, &user, &password),
    ).expect("повторный вызов должен проходить");

    println!("первый вызов: {first:?}");
    println!("второй вызов: {again:?}");
    assert!(!again.user_created, "пользователь не должен заводиться дважды");
    assert!(!again.rights_granted, "права не должны выдаваться повторно");
}
