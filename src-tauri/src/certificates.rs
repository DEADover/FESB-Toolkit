//! Сертификаты из хранилищ шины.
//!
//! Вопрос, ради которого раздел нужен, один: **что и когда протухнет**.
//! Отчёт по точкам входа и выхода говорит, что соединение защищено, но не
//! говорит, чем именно и сколько этому «чем» осталось жить. Ответ лежит
//! в хранилищах: `fesb.jks` с ключами, которыми шина представляется, и
//! доверенные хранилища с чужими сертификатами, которым она верит.
//!
//! Шина отдаёт их двумя методами с одинаковым телом запроса:
//!
//! * `POST /api/certificates/key` — пары «ключ + сертификат» из ключевых
//!   хранилищ, с цепочкой до корня;
//! * `POST /api/certificates/trusted` — отдельные сертификаты из доверенных.
//!
//! Списки самих хранилищ (`GET .../key_store`, `GET .../trusted_store`)
//! читаются отдельно: пустое хранилище тоже стоит показать — это ровно тот
//! случай, когда TLS настроен, а верить некому.
//!
//! Сколько дней осталось, здесь не считается: значение живёт ровно до
//! полуночи, а интерфейс пересчитывает его при каждой отрисовке.

use serde::Serialize;

use crate::fesb_api::Connection;

/// Сертификат в том виде, в каком его показывает раздел.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    /// Имя файла хранилища, например `fesb.jks`.
    pub store: String,
    /// `key` — хранилище ключей, `trusted` — доверенное.
    pub store_kind: String,
    pub alias: String,
    /// Полное имя владельца (DN) и вынутый из него CN — для колонки.
    pub subject: String,
    pub subject_name: String,
    pub issuer: String,
    pub issuer_name: String,
    /// Выдан самому себе: издатель совпадает с владельцем.
    pub self_signed: bool,
    /// Может подписывать чужие сертификаты.
    pub authority: bool,
    pub not_before: String,
    pub not_after: String,
    /// Алгоритм подписи, например `SHA256withRSA`.
    pub algorithm: String,
    /// Алгоритм ключа: `RSA`, `EC`, `DSA`.
    pub key_algorithm: String,
    /// Длина ключа в битах — известна только для RSA.
    pub key_bits: Option<u32>,
    /// Серийный номер в привычном виде `72:0F:C2:F7`.
    pub serial: String,
    /// Назначения ключа: и обычные, и расширенные, уже человеческими словами.
    pub usage: Vec<String>,
    /// Длина цепочки до корня; 0 — цепочки нет.
    pub chain: usize,
    /// Цепочка одной строкой: `CN издателя → CN следующего → …`.
    pub chain_path: Vec<String>,
}

/// Хранилище — даже пустое.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub name: String,
    pub kind: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CertificateReport {
    pub stores: Vec<Store>,
    pub certificates: Vec<Certificate>,
}

/// Собирает сертификаты обоих видов хранилищ в один список.
///
/// Ключевые хранилища читаются как пары «ключ + сертификат»: сертификат там
/// вложен в ключ, а рядом лежит цепочка. Доверенные отдают сертификаты
/// напрямую. Дальше и то и другое — просто строки одной таблицы, поэтому
/// разбираются в один и тот же тип.
pub async fn certificates(connection: &Connection) -> Result<CertificateReport, String> {
    let client = connection.client()?;
    let search = serde_json::json!({ "text": "", "onlyActive": false });

    let keys = post_json(connection, &client, "/api/certificates/key", &search).await?;
    let trusted = post_json(connection, &client, "/api/certificates/trusted", &search).await?;

    let mut certificates = Vec::new();
    for pair in keys.as_array().into_iter().flatten() {
        // У пары сертификат лежит внутри; если его нет, показывать нечего.
        let Some(leaf) = pair.get("certificate").filter(|value| value.is_object()) else {
            continue;
        };
        let chain: Vec<&serde_json::Value> =
            pair.get("certificateChain").and_then(|v| v.as_array()).map(|list| list.iter().collect()).unwrap_or_default();
        let mut item = read_certificate(leaf, "key");
        item.store = text(pair, "store");
        if item.alias.is_empty() {
            item.alias = text(pair, "alias");
        }
        item.chain = chain.len();
        item.chain_path = chain_path(&chain);
        certificates.push(item);
    }
    for value in trusted.as_array().into_iter().flatten() {
        certificates.push(read_certificate(value, "trusted"));
    }

    // Самое срочное — наверху: список открывают, чтобы увидеть, что истекает.
    certificates.sort_by(|a, b| {
        a.not_after.cmp(&b.not_after).then_with(|| a.store.cmp(&b.store)).then_with(|| a.alias.cmp(&b.alias))
    });

    let mut stores = Vec::new();
    for (path, kind) in [("/api/certificates/key_store", "key"), ("/api/certificates/trusted_store", "trusted")] {
        let listed = crate::fesb_api::get_json(connection, &client, path).await.unwrap_or(serde_json::Value::Null);
        for value in listed.as_array().into_iter().flatten() {
            let name = text(value, "name");
            let count = certificates.iter().filter(|item| item.store == name && item.store_kind == kind).count();
            stores.push(Store { name, kind: kind.to_string(), count });
        }
    }

    Ok(CertificateReport { stores, certificates })
}

async fn post_json(
    connection: &Connection,
    client: &reqwest::Client,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let response = connection
        .post(client, path)
        .json(body)
        .send()
        .await
        .map_err(|err| format!("Cannot reach the server: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("The server answered {}", response.status()));
    }
    response.json().await.map_err(|err| format!("Unexpected answer: {err}"))
}

/// Разбирает `X509CertificateInfo` в строку таблицы.
pub fn read_certificate(value: &serde_json::Value, kind: &str) -> Certificate {
    let subject = text(value, "subject");
    let issuer = text(value, "issuer");
    let public_key = value.get("publicKey");

    Certificate {
        store: text(value, "store"),
        store_kind: kind.to_string(),
        alias: text(value, "alias"),
        subject_name: common_name(&subject),
        issuer_name: common_name(&issuer),
        self_signed: !subject.is_empty() && subject == issuer,
        // basicConstraints: −1 у обычного сертификата, ≥ 0 — у удостоверяющего.
        authority: value.get("basicConstraints").and_then(|v| v.as_i64()).is_some_and(|depth| depth >= 0),
        subject,
        issuer,
        not_before: text(value, "notBefore"),
        not_after: text(value, "notAfter"),
        algorithm: text(value, "signatureAlgorithm"),
        key_algorithm: public_key.map(|key| text(key, "algorithm")).unwrap_or_default(),
        key_bits: public_key.and_then(rsa_bits),
        serial: serial_number(&text(value, "serialNumber")),
        usage: usage(value),
        chain: 0,
        chain_path: Vec::new(),
    }
}

fn text(value: &serde_json::Value, field: &str) -> String {
    value.get(field).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

/// Достаёт CN из различающегося имени.
///
/// В таблице нужно короткое «кому выдан», а DN — это строка на полторы сотни
/// символов. Если CN нет, берём первое поле: оно всё равно опознаваемее целого
/// DN. Экранированные запятые (`\,`) внутри значения разделителем не считаются.
pub fn common_name(dn: &str) -> String {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for symbol in dn.chars() {
        match symbol {
            _ if escaped => {
                current.push(symbol);
                escaped = false;
            }
            '\\' => escaped = true,
            ',' => parts.push(std::mem::take(&mut current)),
            _ => current.push(symbol),
        }
    }
    parts.push(current);

    for part in &parts {
        let part = part.trim();
        if let Some(name) = part.strip_prefix("CN=").or_else(|| part.strip_prefix("cn=")) {
            return name.trim().to_string();
        }
    }
    parts
        .first()
        .map(|part| part.trim().split_once('=').map(|(_, value)| value).unwrap_or(part).trim().to_string())
        .unwrap_or_default()
}

/// Длина RSA-ключа по модулю.
///
/// Java отдаёт модуль как `BigInteger.toByteArray()`, то есть со знаковым
/// нулевым байтом впереди: у 2048-битного ключа приходит 257 байт. Считаем
/// биты по старшему значащему байту, иначе каждый ключ окажется на восемь
/// бит длиннее, чем он есть.
fn rsa_bits(key: &serde_json::Value) -> Option<u32> {
    let bytes = base64(key.get("modulus")?.as_str()?)?;
    let first = bytes.iter().position(|byte| *byte != 0)?;
    let significant = &bytes[first..];
    Some((significant.len() as u32 - 1) * 8 + (8 - significant[0].leading_zeros()))
}

/// Серийный номер в том виде, в каком его показывают браузеры и keytool.
fn serial_number(encoded: &str) -> String {
    let Some(bytes) = base64(encoded) else { return String::new() };
    bytes.iter().map(|byte| format!("{byte:02X}")).collect::<Vec<_>>().join(":")
}

/// Девять флагов `keyUsage` в порядке X.509 плюс расширенные назначения.
const KEY_USAGE: [&str; 9] = [
    "digitalSignature",
    "nonRepudiation",
    "keyEncipherment",
    "dataEncipherment",
    "keyAgreement",
    "keyCertSign",
    "cRLSign",
    "encipherOnly",
    "decipherOnly",
];

/// Расширенные назначения приходят идентификаторами объектов — переводим
/// известные в имена, остальные оставляем как есть.
fn extended_usage(oid: &str) -> String {
    match oid {
        "1.3.6.1.5.5.7.3.1" => "serverAuth",
        "1.3.6.1.5.5.7.3.2" => "clientAuth",
        "1.3.6.1.5.5.7.3.3" => "codeSigning",
        "1.3.6.1.5.5.7.3.4" => "emailProtection",
        "1.3.6.1.5.5.7.3.8" => "timeStamping",
        "1.3.6.1.5.5.7.3.9" => "OCSPSigning",
        other => other,
    }
    .to_string()
}

fn usage(value: &serde_json::Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(flags) = value.get("keyUsage").and_then(|v| v.as_array()) {
        for (index, flag) in flags.iter().enumerate() {
            if flag.as_bool() == Some(true) {
                if let Some(name) = KEY_USAGE.get(index) {
                    names.push((*name).to_string());
                }
            }
        }
    }
    if let Some(extended) = value.get("extendedKeyUsage").and_then(|v| v.as_array()) {
        for oid in extended.iter().filter_map(|v| v.as_str()) {
            let name = extended_usage(oid);
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// Путь по цепочке именами: `сам → промежуточный → корень`.
fn chain_path(chain: &[&serde_json::Value]) -> Vec<String> {
    chain.iter().map(|value| common_name(&text(value, "subject"))).collect()
}

/// Декодирует base64 — ровно столько, сколько нужно на модуль и серийник.
///
/// Отдельная зависимость ради двух полей не нужна, а разбор здесь короткий:
/// пробелы и `=` пропускаем, всё непонятное считаем поводом отказаться.
fn base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for symbol in text.bytes() {
        let value = match symbol {
            b'A'..=b'Z' => symbol - b'A',
            b'a'..=b'z' => symbol - b'a' + 26,
            b'0'..=b'9' => symbol - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_common_name_is_taken_out_of_the_whole_dn() {
        assert_eq!(common_name("CN=fesb-platform.ru,OU=fesb,O=fesb-platform,C=RU"), "fesb-platform.ru");
        assert_eq!(common_name("OU=fesb, CN=esb.corp"), "esb.corp");
    }

    #[test]
    fn a_comma_inside_a_value_does_not_split_the_dn() {
        assert_eq!(common_name(r"O=Acme\, Inc.,CN=api.acme.test"), "api.acme.test");
    }

    #[test]
    fn a_dn_without_a_common_name_falls_back_to_its_first_field() {
        assert_eq!(common_name("OU=integration,O=acme"), "integration");
        assert_eq!(common_name(""), "");
    }

    #[test]
    fn the_key_length_ignores_the_sign_byte_java_adds() {
        // BigInteger.toByteArray() у 2048-битного модуля даёт 257 байт.
        let mut modulus = vec![0u8];
        modulus.push(0x80);
        modulus.extend(std::iter::repeat_n(0xFFu8, 255));
        let encoded = to_base64(&modulus);
        let key = json!({ "algorithm": "RSA", "modulus": encoded });
        assert_eq!(rsa_bits(&key), Some(2048));
    }

    #[test]
    fn a_key_without_a_modulus_has_no_known_length() {
        assert_eq!(rsa_bits(&json!({ "algorithm": "EC" })), None);
    }

    #[test]
    fn the_serial_number_reads_the_way_browsers_show_it() {
        assert_eq!(serial_number("cg/C98wVfwY="), "72:0F:C2:F7:CC:15:7F:06");
        assert_eq!(serial_number(""), "");
    }

    #[test]
    fn the_usage_flags_keep_their_x509_order() {
        let value = json!({
            "keyUsage": [true, false, true, false, false, true, false, false, false],
            "extendedKeyUsage": ["1.3.6.1.5.5.7.3.1", "1.2.3.4"],
        });
        assert_eq!(
            usage(&value),
            vec!["digitalSignature", "keyEncipherment", "keyCertSign", "serverAuth", "1.2.3.4"]
        );
    }

    #[test]
    fn a_certificate_issued_to_itself_is_marked_self_signed() {
        let value = json!({
            "alias": "fesb",
            "subject": "CN=fesb-platform.ru,C=RU",
            "issuer": "CN=fesb-platform.ru,C=RU",
            "notBefore": "2025-03-25T09:02:55",
            "notAfter": "2035-03-23T09:02:55",
            "signatureAlgorithm": "SHA256withRSA",
            "basicConstraints": -1,
            "publicKey": { "algorithm": "RSA" },
        });
        let item = read_certificate(&value, "key");
        assert!(item.self_signed);
        assert!(!item.authority);
        assert_eq!(item.subject_name, "fesb-platform.ru");
        assert_eq!(item.not_after, "2035-03-23T09:02:55");
    }

    #[test]
    fn a_certificate_that_can_sign_others_is_marked_an_authority() {
        let value = json!({ "subject": "CN=root", "issuer": "CN=root", "basicConstraints": 0 });
        assert!(read_certificate(&value, "trusted").authority);
    }

    fn to_base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let block = chunk.iter().fold(0u32, |acc, byte| (acc << 8) | u32::from(*byte)) << (8 * (3 - chunk.len()));
            for index in 0..=chunk.len() {
                out.push(ALPHABET[((block >> (18 - 6 * index)) & 0x3F) as usize] as char);
            }
            for _ in chunk.len()..3 {
                out.push('=');
            }
        }
        out
    }

    #[test]
    fn the_test_encoder_round_trips_through_the_decoder() {
        for sample in [vec![], vec![0x00], vec![0x72, 0x0F], vec![0x01, 0x02, 0x03, 0x04, 0x05]] {
            assert_eq!(base64(&to_base64(&sample)), Some(sample));
        }
    }
}
