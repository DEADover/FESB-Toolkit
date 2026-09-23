//! «Хранить в конфигурации» на живом расширенном менеджере очередей.
//!
//! Меняет объекты менеджера, поэтому запускается вручную и только на тестовой
//! шине. Объекты `Audit.*` и `audit_user` заводятся заранее без галочки:
//!
//! ```sh
//! FESB_URL=http://localhost:8181/manager QME_SERVER=EQM \
//!   cargo test --test qme_config -- --ignored --nocapture
//! ```

use fesb_toolkit_lib::testing::{qme_config_audit, qme_store, ConfigKind, Connection, StoreRequest};

fn block<F: std::future::Future>(task: F) -> F::Output {
    tauri::async_runtime::block_on(task)
}

fn request(kind: ConfigKind, id: &str, password: Option<&str>) -> StoreRequest {
    StoreRequest { kind, id: id.into(), password: password.map(String::from) }
}

#[test]
#[ignore]
fn stores_objects_in_the_right_order_and_refuses_unsafe_ones() {
    let (Ok(url), Ok(server)) = (std::env::var("FESB_URL"), std::env::var("QME_SERVER")) else {
        eprintln!("FESB_URL и QME_SERVER не заданы — пропускаю");
        return;
    };
    let connection = Connection {
        url,
        username: std::env::var("FESB_USER").unwrap_or_else(|_| "root".into()),
        password: std::env::var("FESB_PASSWORD").unwrap_or_else(|_| "root".into()),
        insecure: true,
    };

    let audit = block(qme_config_audit(&connection, &server)).expect("чтение менеджера");
    let loose: Vec<String> = audit
        .items
        .iter()
        .filter(|item| !item.stored && !item.system)
        .map(|item| format!("{:?} {}", item.kind, item.id))
        .collect();
    println!("не в конфигурации: {loose:?}");
    assert!(loose.iter().any(|item| item == "Queue Audit.Q"));

    // Очередь без сохранённого адреса шина «сохранила» бы молча и без толку.
    let alone = block(qme_store(&connection, &server, &[request(ConfigKind::Queue, "Audit.Q", None)])).unwrap();
    assert!(alone[0].error.as_deref().is_some_and(|error| error.contains("qme.addressNotStored")), "{alone:?}");

    // Пользователь без пароля не сохраняется.
    let user = block(qme_store(&connection, &server, &[request(ConfigKind::User, "audit_user", None)])).unwrap();
    assert!(user[0].error.as_deref().is_some_and(|error| error.contains("qme.passwordRequired")), "{user:?}");

    // Очередь раньше адреса в запросе — порядок всё равно правильный.
    let outcomes = block(qme_store(
        &connection,
        &server,
        &[
            request(ConfigKind::Queue, "Audit.Q", None),
            request(ConfigKind::Address, "Audit.Addr", None),
            request(ConfigKind::Security, "Audit.#", None),
            request(ConfigKind::User, "audit_user", Some("a1")),
        ],
    ))
    .unwrap();
    println!("{outcomes:?}");
    assert!(outcomes.iter().all(|item| item.error.is_none()), "{outcomes:?}");
    assert_eq!(outcomes[0].kind, ConfigKind::Address, "адрес пишется первым");

    let after = block(qme_config_audit(&connection, &server)).unwrap();
    for (kind, id) in [
        (ConfigKind::Address, "Audit.Addr"),
        (ConfigKind::Queue, "Audit.Q"),
        (ConfigKind::Security, "Audit.#"),
        (ConfigKind::User, "audit_user"),
    ] {
        let item = after.items.iter().find(|item| item.kind == kind && item.id == id).expect(id);
        assert!(item.stored, "{id} в конфигурации");
    }
}
