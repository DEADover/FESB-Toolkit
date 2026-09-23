//! «Хранить в конфигурации» на живых менеджерах очередей.
//!
//! Тест сам заводит объекты с уникальными именами, проверяет на них запись
//! и удаляет за собой. Меняет конфигурацию менеджеров, поэтому запускается
//! вручную и только на тестовой шине:
//!
//! ```sh
//! FESB_URL=http://localhost:8181/manager QME_SERVER=EQM QMS_BROKER=QM \
//!   cargo test --test mq_config -- --ignored --nocapture
//! ```

use fesb_toolkit_lib::testing::{mq_config_audit, mq_store, ConfigKind, Connection, ManagerKind, StoreRequest};
use serde_json::json;

fn block<F: std::future::Future>(task: F) -> F::Output {
    tauri::async_runtime::block_on(task)
}

fn connection() -> Option<Connection> {
    Some(Connection {
        url: std::env::var("FESB_URL").ok()?,
        username: std::env::var("FESB_USER").unwrap_or_else(|_| "root".into()),
        password: std::env::var("FESB_PASSWORD").unwrap_or_else(|_| "root".into()),
        insecure: true,
    })
}

fn request(kind: ConfigKind, id: &str, password: Option<&str>) -> StoreRequest {
    StoreRequest { kind, id: id.into(), stored: true, password: password.map(String::from) }
}

fn release(kind: ConfigKind, id: &str) -> StoreRequest {
    StoreRequest { kind, id: id.into(), stored: false, password: None }
}

/// Запрос к шине в обход приложения: так заводятся объекты без галочки.
fn call(connection: &Connection, method: reqwest::Method, path: &str, body: Option<serde_json::Value>) {
    let url = format!("{}{path}", connection.url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let mut builder = client.request(method, &url).basic_auth(&connection.username, Some(&connection.password));
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let status = block(builder.send()).expect(path).status();
    assert!(status.is_success(), "{path}: {status}");
}

fn stamp() -> String {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string()
}

#[test]
#[ignore]
fn qme_objects_are_stored_in_the_right_order() {
    let (Some(connection), Ok(server)) = (connection(), std::env::var("QME_SERVER")) else {
        eprintln!("FESB_URL и QME_SERVER не заданы — пропускаю");
        return;
    };
    let tag = stamp();
    let (address, queue, matcher, user) =
        (format!("Check{tag}.Addr"), format!("Check{tag}.Q"), format!("Check{tag}.#"), format!("check_{tag}"));
    let base = format!("/api/qme/servers/{server}");
    let post = reqwest::Method::POST;
    call(&connection, post.clone(), &format!("{base}/addresses"),
        Some(json!({ "name": address, "routingTypes": ["ANYCAST"], "configurationManaged": false })));
    call(&connection, post.clone(), &format!("{base}/queues"),
        Some(json!({ "name": queue, "address": address, "type": "ANYCAST", "durable": true, "configurationManaged": false })));
    call(&connection, post.clone(), &format!("{base}/security/addresses"),
        Some(json!({ "match": matcher, "send": ["check_role"], "configurationManaged": false })));
    call(&connection, post, &format!("{base}/users"),
        Some(json!({ "username": user, "password": "c1", "roles": ["check_role"], "configurationManaged": false })));

    let audit = block(mq_config_audit(&connection, ManagerKind::Qme, &server)).expect("чтение менеджера");
    assert!(audit.items.iter().any(|item| item.kind == ConfigKind::Queue && item.id == queue && !item.stored));

    // Очередь без сохранённого адреса шина «сохранила» бы молча и без толку.
    let alone = block(mq_store(&connection, ManagerKind::Qme, &server, &[request(ConfigKind::Queue, &queue, None)])).unwrap();
    assert!(alone[0].error.as_deref().is_some_and(|error| error.contains("qme.addressNotStored")), "{alone:?}");

    // Пользователь без пароля не сохраняется.
    let nameless = block(mq_store(&connection, ManagerKind::Qme, &server, &[request(ConfigKind::User, &user, None)])).unwrap();
    assert!(nameless[0].error.as_deref().is_some_and(|error| error.contains("qme.passwordRequired")), "{nameless:?}");

    // Очередь раньше адреса в запросе — порядок всё равно правильный.
    let outcomes = block(mq_store(&connection, ManagerKind::Qme, &server, &[
        request(ConfigKind::Queue, &queue, None),
        request(ConfigKind::Address, &address, None),
        request(ConfigKind::Security, &matcher, None),
        request(ConfigKind::User, &user, Some("c1")),
    ]))
    .unwrap();
    assert!(outcomes.iter().all(|item| item.error.is_none()), "{outcomes:?}");
    assert_eq!(outcomes[0].kind, ConfigKind::Address, "адрес пишется первым");

    let after = block(mq_config_audit(&connection, ManagerKind::Qme, &server)).unwrap();
    for (kind, id) in [(ConfigKind::Address, &address), (ConfigKind::Queue, &queue), (ConfigKind::Security, &matcher), (ConfigKind::User, &user)] {
        let item = after.items.iter().find(|item| item.kind == kind && &item.id == id).expect(id);
        assert!(item.stored, "{id} в конфигурации");
    }

    // Обратно: адрес уходит из конфигурации вместе с очередью, пользователь —
    // без пароля. Порядок в запросе нарочно «неудобный».
    let back = block(mq_store(&connection, ManagerKind::Qme, &server, &[
        release(ConfigKind::Address, &address),
        release(ConfigKind::Queue, &queue),
        release(ConfigKind::Security, &matcher),
        release(ConfigKind::User, &user),
    ]))
    .unwrap();
    assert!(back.iter().all(|item| item.error.is_none()), "{back:?}");
    assert_eq!(back[0].kind, ConfigKind::User, "снимается от конца порядка записи");
    let released = block(mq_config_audit(&connection, ManagerKind::Qme, &server)).unwrap();
    for (kind, id) in [(ConfigKind::Address, &address), (ConfigKind::Queue, &queue), (ConfigKind::Security, &matcher), (ConfigKind::User, &user)] {
        let item = released.items.iter().find(|item| item.kind == kind && &item.id == id).expect(id);
        assert!(!item.stored, "{id} вне конфигурации, но на месте");
    }

    let delete = reqwest::Method::DELETE;
    let encoded = matcher.replace('#', "%23");
    call(&connection, delete.clone(), &format!("{base}/users/{user}"), None);
    call(&connection, delete.clone(), &format!("{base}/security/addresses/{encoded}"), None);
    call(&connection, delete.clone(), &format!("{base}/queues/{queue}"), None);
    call(&connection, delete, &format!("{base}/addresses/{address}"), None);
}

#[test]
#[ignore]
fn qms_queues_and_topics_are_stored() {
    let (Some(connection), Ok(broker)) = (connection(), std::env::var("QMS_BROKER")) else {
        eprintln!("FESB_URL и QMS_BROKER не заданы — пропускаю");
        return;
    };
    let tag = stamp();
    let (queue, topic) = (format!("Check{tag}.Q"), format!("Check{tag}.T"));
    let base = format!("/api/qms/brokers/{broker}");
    call(&connection, reqwest::Method::POST, &format!("{base}/queues"), Some(json!({ "name": queue, "configurationManaged": false })));
    call(&connection, reqwest::Method::POST, &format!("{base}/topics"), Some(json!({ "name": topic, "configurationManaged": false })));

    let audit = block(mq_config_audit(&connection, ManagerKind::Qms, &broker)).expect("чтение менеджера");
    assert!(audit.items.iter().any(|item| item.kind == ConfigKind::Queue && item.id == queue && !item.stored));

    let outcomes = block(mq_store(&connection, ManagerKind::Qms, &broker, &[
        request(ConfigKind::Queue, &queue, None),
        request(ConfigKind::Topic, &topic, None),
    ]))
    .unwrap();
    assert!(outcomes.iter().all(|item| item.error.is_none()), "{outcomes:?}");

    let after = block(mq_config_audit(&connection, ManagerKind::Qms, &broker)).unwrap();
    for (kind, id) in [(ConfigKind::Queue, &queue), (ConfigKind::Topic, &topic)] {
        let item = after.items.iter().find(|item| item.kind == kind && &item.id == id).expect(id);
        assert!(item.stored, "{id} в конфигурации");
    }

    let back = block(mq_store(&connection, ManagerKind::Qms, &broker, &[
        release(ConfigKind::Queue, &queue),
        release(ConfigKind::Topic, &topic),
    ]))
    .unwrap();
    assert!(back.iter().all(|item| item.error.is_none()), "{back:?}");
    let released = block(mq_config_audit(&connection, ManagerKind::Qms, &broker)).unwrap();
    for (kind, id) in [(ConfigKind::Queue, &queue), (ConfigKind::Topic, &topic)] {
        let item = released.items.iter().find(|item| item.kind == kind && &item.id == id).expect(id);
        assert!(!item.stored, "{id} вне конфигурации, но на месте");
    }

    call(&connection, reqwest::Method::DELETE, &format!("{base}/queues/{queue}"), None);
    call(&connection, reqwest::Method::DELETE, &format!("{base}/topics/{topic}"), None);
}
