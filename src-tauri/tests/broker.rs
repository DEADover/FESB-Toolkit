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

use fesb_toolkit_lib::testing::{probe_broker, BrokerProfile};

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
