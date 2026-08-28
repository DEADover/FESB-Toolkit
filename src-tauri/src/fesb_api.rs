//! Работа с шиной напрямую через REST API менеджера FESB.
//!
//! Объекты трассировки не имеют собственных методов в API: править их можно
//! только через выгрузку и загрузку конфигурации. Поэтому режим API устроен
//! как цикл «забрать домены → отредактировать файлы → отправить обратно»,
//! а редактирование посередине — то же самое, что и в файловом режиме.
//!
//! Из трёх форматов архивов выбран `/api/domains/export/archive`: он отдаёт
//! только домены (а не всю конфигурацию на 70 мегабайт), умеет выбирать
//! конкретные домены и имеет парный метод импорта, который не спотыкается
//! о разделы модулей.

use std::fs::{self, File};
use std::io::{BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// Разделы выгрузки, без которых архив легче на порядок: журналы запусков
/// СОПС и скомпилированные модели для правки трассировки не нужны.
const EXPORT_EXCLUDE: &str = "history,models";
/// Сколько доменов уходит в один запрос.
///
/// Ограничений тут два. Идентификаторы уходят в строку запроса, а её длину
/// сервер режет на восьми килобайтах — это около полутора сотен guid. И второе,
/// более важное: сервер собирает архив целиком до отправки, у 256 доменов
/// первый байт приходит через две с половиной минуты. Мелкая пачка — это
/// и движущийся счётчик, и возможность вести несколько выгрузок разом.
const GUIDS_PER_REQUEST: usize = 10;
/// Сколько пачек забирается одновременно: сервер спокойно обслуживает
/// параллельные выгрузки, и на 150 доменах это 26 секунд вместо 64.
const BATCH_CONCURRENCY: usize = 4;
const MANIFEST_FILE: &str = "meta.json";
const EXPORT_DIR: &str = "export";
const DOMAINS_DIR: &str = "domains";
const VERSION_FILE: &str = "version";
const JUNK_FILES: [&str; 2] = [".DS_Store", "Thumbs.db"];

// ───────────────────────────── подключение ─────────────────────────────

/// Похоже ли на стенд без TLS: локальный хост или явный порт, кроме 443.
fn plain_http_likely(raw: &str) -> bool {
    let host = raw.split(['/', '?']).next().unwrap_or(raw);
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => (name, Some(port)),
        _ => (host, None),
    };
    if matches!(name, "localhost" | "127.0.0.1" | "0.0.0.0" | "::1") {
        return true;
    }
    matches!(port, Some(port) if port != "443")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub url: String,
    pub username: String,
    pub password: String,
    /// Принимать самоподписанные сертификаты — тестовые стенды обычно с ними.
    #[serde(default)]
    pub insecure: bool,
}

impl Connection {
    /// Адрес, по которому идут запросы.
    ///
    /// Это первый из вариантов `candidates()`: подключение уже прошло проверку
    /// и приложение хранит найденный адрес целиком, так что гадать не нужно.
    pub(crate) fn base(&self) -> String {
        self.candidates().into_iter().next().unwrap_or_else(|| self.url.trim().to_string())
    }

    /// Адреса, которые стоит перебрать при подключении.
    ///
    /// Пользователю незачем помнить ни схему, ни путь до менеджера: достаточно
    /// `esb.corp:8181` или даже `esb.corp`. Схема и путь дописываются сами,
    /// а порядок перебора выбран так, чтобы обычный случай угадывался с первого
    /// раза: локальный стенд и явный порт — это почти всегда http, всё
    /// остальное в корпоративной сети — https.
    pub(crate) fn candidates(&self) -> Vec<String> {
        let raw = self.url.trim().trim_end_matches('/');
        if raw.is_empty() {
            return Vec::new();
        }

        let (schemes, rest) = match raw.split_once("://") {
            // Схему указали явно — уважаем и не подставляем вторую.
            Some((scheme, rest)) => (vec![scheme.to_string()], rest.to_string()),
            None if plain_http_likely(raw) => (vec!["http".into(), "https".into()], raw.to_string()),
            None => (vec!["https".into(), "http".into()], raw.to_string()),
        };

        // Путь указали — значит, знают, куда идут; иначе пробуем и с /manager, и без.
        let paths: Vec<String> = if rest.contains('/') {
            vec![String::new()]
        } else {
            vec!["/manager".into(), String::new()]
        };

        let mut out = Vec::new();
        for path in &paths {
            for scheme in &schemes {
                let candidate = format!("{scheme}://{rest}{path}");
                if !out.contains(&candidate) {
                    out.push(candidate);
                }
            }
        }
        out
    }

    pub(crate) fn client(&self) -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(self.insecure)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|err| format!("Cannot create an HTTP client: {err}"))
    }

    pub(crate) fn get(&self, client: &reqwest::Client, path: &str) -> reqwest::RequestBuilder {
        client
            .get(format!("{}{path}", self.base()))
            .basic_auth(&self.username, Some(&self.password))
    }

    pub(crate) fn post(&self, client: &reqwest::Client, path: &str) -> reqwest::RequestBuilder {
        client
            .post(format!("{}{path}", self.base()))
            .basic_auth(&self.username, Some(&self.password))
    }

    pub(crate) fn put(&self, client: &reqwest::Client, path: &str) -> reqwest::RequestBuilder {
        client
            .put(format!("{}{path}", self.base()))
            .basic_auth(&self.username, Some(&self.password))
    }

    pub(crate) fn delete(&self, client: &reqwest::Client, path: &str) -> reqwest::RequestBuilder {
        client
            .delete(format!("{}{path}", self.base()))
            .basic_auth(&self.username, Some(&self.password))
    }
}

/// Сообщение об ошибке в том виде, в каком его отдаёт FESB.
pub(crate) fn api_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        for key in ["message", "error"] {
            if let Some(text) = value.get(key).and_then(|item| item.as_str()) {
                if !text.is_empty() {
                    return text.to_string();
                }
            }
        }
    }
    let trimmed = strip_markup(body.trim());
    if trimmed.is_empty() {
        "empty response".to_string()
    } else {
        trimmed.chars().take(400).collect()
    }
}

/// Не все ошибки приходят от FESB: сервлет-контейнер отвечает страницей на HTML,
/// и показывать её пользователю вместе с тегами незачем.
fn strip_markup(body: &str) -> String {
    if !body.starts_with('<') {
        return body.to_string();
    }
    let mut text = String::with_capacity(body.len());
    let mut inside = false;
    for symbol in body.chars() {
        match symbol {
            '<' => inside = true,
            '>' => {
                inside = false;
                text.push(' ');
            }
            _ if !inside => text.push(symbol),
            _ => {}
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) async fn ensure_ok(response: reqwest::Response, what: &str) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    if status.as_u16() == 401 {
        return Err("Authentication failed: check the user name and password".into());
    }
    if status.as_u16() == 403 {
        return Err(format!("{what}: not enough permissions for this user"));
    }
    let body = response.text().await.unwrap_or_default();
    Err(format!("{what}: HTTP {} — {}", status.as_u16(), api_message(&body)))
}

pub(crate) fn transport_error(err: reqwest::Error) -> String {
    // Свой текст reqwest начинает с «error sending request for url (…)»,
    // и адрес в нём повторяет тот, который мы называем и сами. Смысл несёт
    // причина, а она лежит в самом конце цепочки источников: «failed to
    // lookup address information», «connection refused».
    let cause = root_cause(&err);
    if err.is_timeout() {
        format!("The server did not answer in time: {cause}")
    } else if err.is_connect() {
        format!("Cannot reach the server: {cause}")
    } else {
        cause
    }
}

/// Самая глубокая причина ошибки — та, что объясняет, что случилось.
fn root_cause(err: &(dyn std::error::Error + 'static)) -> String {
    let mut deepest = err;
    while let Some(source) = deepest.source() {
        deepest = source;
    }
    deepest.to_string()
}

// ───────────────────────────── данные о сервере ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleState {
    pub name: String,
    pub label: String,
    pub active: bool,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// Адрес в том виде, в котором приложение к нему обращается.
    pub base_url: String,
    pub user: String,
    pub roles: Vec<String>,
    pub permissions: usize,
    /// Права, которых не хватает для полного цикла «забрать → отправить».
    pub missing_permissions: Vec<String>,
    pub api_version: Option<String>,
    pub domains: usize,
    pub active_domains: usize,
    pub modules: Vec<ModuleState>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiDomain {
    pub guid: String,
    pub name: String,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub leader: bool,
    #[serde(default)]
    pub clustered: bool,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Права, без которых цикл не заработает.
const REQUIRED_PERMISSIONS: [&str; 3] = ["DOMAIN_VIEW_ALL", "DOMAIN_EXPORT_ALL", "DOMAIN_IMPORT"];

#[derive(Deserialize)]
struct SecurityUser {
    username: Option<String>,
    #[serde(default)]
    role_names: Vec<String>,
    #[serde(default)]
    permissions: Vec<String>,
}

#[derive(Deserialize)]
struct RawModule {
    name: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    running: bool,
}

/// Читает JSON по адресу, не разбираясь в его форме.
///
/// Отчёту по точкам входа нужны ответы четырёх разных методов, и разбирать
/// их в типы незачем: нужные поля он достаёт по именам сам.
pub(crate) async fn get_json(
    connection: &Connection,
    client: &reqwest::Client,
    path: &str,
) -> Result<serde_json::Value, String> {
    let response = connection.get(client, path).send().await.map_err(transport_error)?;
    let body = ensure_ok(response, "Cannot read the answer").await?;
    body.json().await.map_err(|err| format!("Unexpected answer: {err}"))
}

/// Находит рабочий адрес, перебирая варианты из `candidates()`.
///
/// Пробуем по очереди, пока какой-то не ответит на `/api/security/user`.
/// Ответ «нет прав» или «неверный пароль» — тоже находка: сервер там есть,
/// перебирать дальше незачем, ошибку показываем как есть.
async fn resolve(
    connection: &Connection,
    client: &reqwest::Client,
) -> Result<(Connection, reqwest::Response), String> {
    let candidates = connection.candidates();
    if candidates.is_empty() {
        return Err("The server address is empty".into());
    }
    let mut last: Option<String> = None;
    for url in candidates {
        let attempt = Connection { url: url.clone(), ..connection.clone() };
        match attempt.get(client, "/api/security/user").send().await {
            Ok(response) if response.status().is_success() => {
                return Ok((attempt, response));
            }
            Ok(response) => {
                // Сервер отвечает, но отказывает: адрес верный, дело в правах.
                let status = response.status();
                if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                    let body = ensure_ok(response, "Cannot read the current user").await;
                    return Err(body.err().unwrap_or_else(|| "Access denied".into()));
                }
                last = Some(format!("{url} answered {}", status.as_u16()));
            }
            Err(err) => last = Some(format!("{url}: {}", transport_error(err))),
        }
    }
    Err(last.unwrap_or_else(|| "The server did not answer".into()))
}

pub async fn connect(connection: &Connection) -> Result<ServerInfo, String> {
    let client = connection.client()?;
    let (connection, body) = resolve(connection, &client).await?;
    let connection = &connection;
    let raw: serde_json::Value = body.json().await.map_err(|err| format!("Unexpected answer: {err}"))?;
    let user: SecurityUser = SecurityUser {
        username: raw.get("username").and_then(|v| v.as_str()).map(String::from),
        role_names: raw
            .get("roleNames")
            .and_then(|v| v.as_array())
            .map(|list| list.iter().filter_map(|i| i.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        permissions: raw
            .get("permissions")
            .and_then(|v| v.as_array())
            .map(|list| list.iter().filter_map(|i| i.as_str().map(String::from)).collect())
            .unwrap_or_default(),
    };

    let missing: Vec<String> = REQUIRED_PERMISSIONS
        .iter()
        .filter(|needed| !user.permissions.iter().any(|held| held == *needed))
        .map(|needed| needed.to_string())
        .collect();

    let domains = domains(connection).await.unwrap_or_default();
    let modules = read_modules(connection, &client).await.unwrap_or_default();
    let api_version = read_api_version(connection, &client).await;

    Ok(ServerInfo {
        base_url: connection.base(),
        user: user.username.unwrap_or_else(|| connection.username.clone()),
        roles: user.role_names,
        permissions: user.permissions.len(),
        missing_permissions: missing,
        api_version,
        domains: domains.len(),
        active_domains: domains.iter().filter(|item| item.active).count(),
        modules,
        checked_at: chrono::Local::now().to_rfc3339(),
    })
}

async fn read_modules(connection: &Connection, client: &reqwest::Client) -> Result<Vec<ModuleState>, String> {
    let response = connection
        .get(client, "/api/module/info")
        .send()
        .await
        .map_err(transport_error)?;
    let body = ensure_ok(response, "Cannot read modules").await?;
    let raw: Vec<RawModule> = body.json().await.map_err(|err| format!("Unexpected answer: {err}"))?;
    Ok(raw
        .into_iter()
        .map(|item| ModuleState {
            label: item.label.unwrap_or_else(|| item.name.clone()),
            name: item.name,
            active: item.active,
            running: item.running,
        })
        .collect())
}

/// Версия шины лежит в начале описания OpenAPI, поэтому целиком его качать
/// незачем: спецификация весит больше мегабайта, а нужны первые сто байт.
async fn read_api_version(connection: &Connection, client: &reqwest::Client) -> Option<String> {
    let mut response = connection
        .get(client, "/v3/api-docs")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    let chunk = response.chunk().await.ok()??;
    let head = String::from_utf8_lossy(&chunk);
    let info = head.split("\"info\"").nth(1)?;
    let version = info.split("\"version\"").nth(1)?;
    let value = version.split('"').nth(1)?;
    // Дальше в спецификации есть свои "version", поэтому берём только из блока info.
    if value.len() > 40 {
        return None;
    }
    Some(value.to_string())
}

pub async fn domains(connection: &Connection) -> Result<Vec<ApiDomain>, String> {
    let client = connection.client()?;
    let response = connection
        .get(&client, "/api/domain/names")
        .send()
        .await
        .map_err(transport_error)?;
    let body = ensure_ok(response, "Cannot read the domain list").await?;
    body.json().await.map_err(|err| format!("Unexpected answer: {err}"))
}

pub async fn restart_module(connection: &Connection, module: &str) -> Result<(), String> {
    let client = connection.client()?;
    let response = connection
        .post(&client, &format!("/api/module/{module}/restart"))
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(transport_error)?;
    ensure_ok(response, "Cannot restart the module").await?;
    Ok(())
}

// ───────────────────────────── забрать домены ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProgress {
    /// `domains` при выгрузке, `pack` и `upload` при отправке.
    pub phase: &'static str,
    pub current: u64,
    /// Ноль означает «размер заранее неизвестен».
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDomain {
    pub guid: String,
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

/// Опись выгрузки: по ней собирается архив для обратной отправки.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub base_url: String,
    pub pulled_at: String,
    pub domains: Vec<ManifestDomain>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    /// Папка, с которой дальше работает файловый режим.
    pub root: String,
    pub domains: usize,
    pub files: usize,
    pub bytes: u64,
    pub has_version: bool,
}

fn workspace_root() -> PathBuf {
    std::env::temp_dir().join("fesb-toolkit")
}

/// Забирает выбранные домены с сервера и раскладывает их в привычную
/// структуру `domains/<guid>/…`, чтобы дальше работал обычный сканер.
pub async fn pull<F: FnMut(ApiProgress)>(
    connection: &Connection,
    guids: Option<&[String]>,
    mut on_progress: F,
) -> Result<PullResult, String> {
    // Без списка доменов забрать всё можно одним запросом, но тогда сервер молчит
    // две с половиной минуты. Спрашиваем список и идём пачками — так видно движение.
    let wanted: Vec<String> = match guids {
        Some(list) if !list.is_empty() => list.to_vec(),
        Some(_) => return Err("No domains selected".into()),
        None => domains(connection)
            .await?
            .into_iter()
            .map(|item| item.guid)
            .collect(),
    };
    if wanted.is_empty() {
        return Err(format!("{} returned no domains", connection.base()));
    }

    let client = connection.client()?;
    let expected = wanted.len() as u64;

    let workspace = workspace_root();
    let _ = fs::remove_dir_all(&workspace);
    let session = workspace.join(format!("api-{}", stamp()));
    let root = session.join(EXPORT_DIR);
    fs::create_dir_all(root.join(DOMAINS_DIR)).map_err(|err| format!("Cannot create a workspace: {err}"))?;

    let batches: Vec<Vec<String>> = wanted.chunks(GUIDS_PER_REQUEST).map(<[String]>::to_vec).collect();

    let mut domains: Vec<ManifestDomain> = Vec::new();
    let mut files = 0usize;
    let mut downloaded = 0u64;
    let mut has_version = false;

    on_progress(ApiProgress { phase: "domains", current: 0, total: expected });

    for (wave, group) in batches.chunks(BATCH_CONCURRENCY).enumerate() {
        let mut running = Vec::with_capacity(group.len());
        for (offset, batch) in group.iter().enumerate() {
            let index = wave * BATCH_CONCURRENCY + offset;
            let path = session.join(format!("download-{index}.zip"));
            let connection = connection.clone();
            let client = client.clone();
            let batch = batch.clone();
            running.push(tauri::async_runtime::spawn(async move {
                download_batch(&connection, &client, &batch, &path).await.map(|bytes| (path, bytes))
            }));
        }

        for handle in running {
            let (path, bytes) = handle
                .await
                .map_err(|err| format!("Download interrupted: {err}"))??;
            downloaded += bytes;

            let unpacked = unpack_domains(&path, &root)?;
            let _ = fs::remove_file(&path);

            files += unpacked.files;
            has_version = has_version || unpacked.has_version;
            domains.extend(unpacked.domains);
            on_progress(ApiProgress { phase: "domains", current: domains.len() as u64, total: expected });
        }
    }

    if domains.is_empty() {
        return Err(format!("{} returned no domains", connection.base()));
    }
    domains.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let manifest = Manifest {
        base_url: connection.base(),
        pulled_at: chrono::Local::now().to_rfc3339(),
        domains: domains.clone(),
    };
    fs::write(
        session.join(MANIFEST_FILE),
        serde_json::to_vec_pretty(&manifest).map_err(|err| err.to_string())?,
    )
    .map_err(|err| format!("Cannot write the manifest: {err}"))?;

    Ok(PullResult {
        root: root.to_string_lossy().to_string(),
        domains: domains.len(),
        files,
        bytes: downloaded,
        has_version,
    })
}

/// Забирает одну пачку доменов в отдельный файл и возвращает его размер.
async fn download_batch(
    connection: &Connection,
    client: &reqwest::Client,
    guids: &[String],
    path: &Path,
) -> Result<u64, String> {
    let mut request = connection
        .get(client, "/api/domains/export/archive")
        .query(&[("exclude", EXPORT_EXCLUDE)]);
    for guid in guids {
        request = request.query(&[("domains", guid.as_str())]);
    }

    let response = request.send().await.map_err(transport_error)?;
    let mut response = ensure_ok(response, "Cannot export domains").await?;

    let mut file = BufWriter::new(
        File::create(path).map_err(|err| format!("Cannot write the download: {err}"))?,
    );
    let mut bytes = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        file.write_all(&chunk).map_err(|err| format!("Cannot write the download: {err}"))?;
        bytes += chunk.len() as u64;
    }
    file.flush().map_err(|err| format!("Cannot write the download: {err}"))?;
    Ok(bytes)
}

struct Unpacked {
    domains: Vec<ManifestDomain>,
    files: usize,
    has_version: bool,
}

/// Разбирает архив выгрузки: снаружи опись и по вложенному архиву на домен.
fn unpack_domains(archive: &Path, root: &Path) -> Result<Unpacked, String> {
    let file = File::open(archive).map_err(|err| format!("Cannot open the download: {err}"))?;
    let mut outer = ZipArchive::new(file).map_err(|err| format!("The server did not return a zip: {err}"))?;

    let mut names: std::collections::HashMap<String, ManifestDomain> = std::collections::HashMap::new();
    if let Ok(mut entry) = outer.by_name("domains.json") {
        let mut text = String::new();
        if entry.read_to_string(&mut text).is_ok() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(list) = value.get("domains").and_then(|item| item.as_array()) {
                    for item in list {
                        let Some(guid) = item.get("guid").and_then(|v| v.as_str()) else { continue };
                        names.insert(
                            guid.to_string(),
                            ManifestDomain {
                                guid: guid.to_string(),
                                name: item.get("name").and_then(|v| v.as_str()).unwrap_or(guid).to_string(),
                                group: item.get("group").and_then(|v| v.as_str()).map(String::from),
                                mode: item.get("mode").and_then(|v| v.as_str()).map(String::from),
                            },
                        );
                    }
                }
            }
        }
    }

    let mut domains: Vec<ManifestDomain> = Vec::new();
    let mut files = 0usize;
    let mut has_version = false;

    for index in 0..outer.len() {
        let mut entry = outer.by_index(index).map_err(|err| err.to_string())?;
        let Some(path) = entry.enclosed_name() else { continue };
        let name = path.to_string_lossy().replace('\\', "/");
        if !name.ends_with(".zip") {
            continue;
        }
        let guid = name.trim_end_matches(".zip").to_string();

        let mut buffer = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .map_err(|err| format!("{name}: {err}"))?;
        drop(entry);

        let target = root.join(DOMAINS_DIR).join(&guid);
        let (written, version) = extract_into(&buffer, &target)?;
        files += written;

        // Файл version одинаков для всех доменов — достаточно положить его в корень.
        if !has_version {
            if let Some(text) = version {
                let _ = fs::write(root.join(VERSION_FILE), text);
                has_version = true;
            }
        }

        domains.push(names.remove(&guid).unwrap_or(ManifestDomain {
            guid: guid.clone(),
            name: guid,
            group: None,
            mode: None,
        }));
    }

    Ok(Unpacked { domains, files, has_version })
}

/// Распаковывает архив одного домена и попутно читает из него файл `version`.
fn extract_into(bytes: &[u8], target: &Path) -> Result<(usize, Option<Vec<u8>>), String> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|err| format!("not a valid zip: {err}"))?;
    let mut written = 0usize;
    let mut version: Option<Vec<u8>> = None;

    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|err| err.to_string())?;
        // enclosed_name отсекает `..` и абсолютные пути: архив не должен писать мимо папки.
        let Some(relative) = entry.enclosed_name() else { continue };
        let path = target.join(&relative);

        if entry.is_dir() {
            fs::create_dir_all(&path).map_err(|err| format!("{}: {err}", path.display()))?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("{}: {err}", parent.display()))?;
        }
        let mut out = BufWriter::new(File::create(&path).map_err(|err| format!("{}: {err}", path.display()))?);
        std::io::copy(&mut entry, &mut out).map_err(|err| format!("{}: {err}", path.display()))?;
        out.flush().map_err(|err| format!("{}: {err}", path.display()))?;
        written += 1;

        if relative.to_string_lossy() == VERSION_FILE {
            version = fs::read(&path).ok();
        }
    }
    Ok((written, version))
}

// ───────────────────────── указатель имён СОПС ─────────────────────────



/// Отчёт по внешним точкам входа и выхода всех СОПС сервера.
pub async fn endpoint_report<F: FnMut(ApiProgress)>(
    connection: &Connection,
    on_progress: F,
) -> Result<Vec<crate::api_report::Endpoint>, String> {
    let per_domain = walk_domains(connection, on_progress, |dir, domain| {
        crate::api_report::endpoints_of_domain(dir, &domain.name, &domain.guid)
    })
    .await?;

    let mut points: Vec<crate::api_report::Endpoint> = per_domain.into_iter().flatten().collect();
    // REST-домены живут отдельно от СОПС, но слушают свои порты так же.
    points.extend(crate::api_report::rest_endpoints(connection).await);
    let guids: Vec<String> = points.iter().map(|point| point.domain_guid.clone()).collect();
    let mut unique = guids.clone();
    unique.sort();
    unique.dedup();

    let facts = crate::api_report::port_facts(connection, &unique).await;
    crate::api_report::enrich(&mut points, &facts);

    // Слушается ли порт на самом деле — вопрос только ко входу, и спрашивать
    // его нужно один раз на порт: точек на одном порту бывают десятки.
    let mut ports: Vec<u32> = points
        .iter()
        .filter(|point| point.direction == "in")
        .filter_map(|point| point.port)
        .collect();
    ports.sort_unstable();
    ports.dedup();
    let listening = crate::api_report::listening_ports(connection, &ports).await;
    crate::api_report::mark_listening(&mut points, &listening);

    points.sort_by(|a, b| {
        a.domain
            .to_lowercase()
            .cmp(&b.domain.to_lowercase())
            .then_with(|| a.route.to_lowercase().cmp(&b.route.to_lowercase()))
            .then_with(|| a.direction.cmp(&b.direction))
    });
    Ok(points)
}

/// Выкачивает все домены пачками и отдаёт каждый распакованный домен разборщику.
///
/// Забирать сервер целиком дорого, поэтому пачки идут параллельно, а папка
/// домена удаляется сразу после разбора: на диске никогда не лежит больше
/// одной волны. Этим живут и указатель имён СОПС, и отчёт по точкам входа.
async fn walk_domains<T, F, R>(
    connection: &Connection,
    mut on_progress: F,
    mut read: R,
) -> Result<Vec<T>, String>
where
    F: FnMut(ApiProgress),
    R: FnMut(&Path, &ManifestDomain) -> T,
{
    let names = domains(connection).await?;
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let guids: Vec<String> = names.iter().map(|item| item.guid.clone()).collect();

    let client = connection.client()?;
    let scratch = routes_cache().join(format!("walk-{}", stamp()));
    let root = scratch.join(EXPORT_DIR);
    fs::create_dir_all(root.join(DOMAINS_DIR)).map_err(|err| format!("Cannot create a workspace: {err}"))?;

    let expected = guids.len() as u64;
    let batches: Vec<Vec<String>> = guids.chunks(GUIDS_PER_REQUEST).map(<[String]>::to_vec).collect();
    on_progress(ApiProgress { phase: "domains", current: 0, total: expected });

    let outcome = async {
        let mut collected: Vec<T> = Vec::new();

        for (wave, group) in batches.chunks(BATCH_CONCURRENCY).enumerate() {
            let mut running = Vec::with_capacity(group.len());
            for (offset, batch) in group.iter().enumerate() {
                let number = wave * BATCH_CONCURRENCY + offset;
                let path = scratch.join(format!("walk-{number}.zip"));
                let connection = connection.clone();
                let client = client.clone();
                let batch = batch.clone();
                running.push(tauri::async_runtime::spawn(async move {
                    download_batch(&connection, &client, &batch, &path).await.map(|_| path)
                }));
            }

            for handle in running {
                let path = handle.await.map_err(|err| format!("Walk interrupted: {err}"))??;
                let unpacked = unpack_domains(&path, &root)?;
                let _ = fs::remove_file(&path);

                let mut done = 0u64;
                for domain in unpacked.domains {
                    let dir = root.join(DOMAINS_DIR).join(&domain.guid);
                    collected.push(read(&dir, &domain));
                    // Файлы больше не нужны: разборщик взял из них своё.
                    let _ = fs::remove_dir_all(&dir);
                    done += 1;
                }
                let _ = done;
                on_progress(ApiProgress { phase: "domains", current: collected.len() as u64, total: expected });
            }
        }

        Ok(collected)
    }
    .await;

    let _ = fs::remove_dir_all(&scratch);
    outcome
}


// ───────────────────────── СОПС одного домена ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteFile {
    pub id: Option<String>,
    pub name: Option<String>,
    pub trace_enabled: bool,
    pub trace_configs: Vec<String>,
    pub inline_trace_config: bool,
    /// Путь к файлу маршрута во временной копии — по нему рисуется схема.
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainRoutes {
    pub guid: String,
    pub name: Option<String>,
    /// Корень временной копии — по нему считаются связи между маршрутами.
    pub root: String,
    pub routes: Vec<RouteFile>,
}

/// Отдельная папка под схемы: рабочую выгрузку она не трогает и наоборот.
fn routes_cache() -> PathBuf {
    std::env::temp_dir().join("fesb-toolkit-routes")
}

/// Забирает один домен ради его СОПС.
///
/// Схему рисовать не из чего, пока нет файлов маршрутов, но тащить ради этого
/// всю конфигурацию незачем: один домен приходит за доли секунды. Копия живёт
/// отдельно от рабочей папки, поэтому открытая выгрузка не пострадает.
pub async fn fetch_domain_routes(connection: &Connection, guid: &str) -> Result<DomainRoutes, String> {
    let client = connection.client()?;
    let cache = routes_cache().join(guid);
    let _ = fs::remove_dir_all(&cache);
    fs::create_dir_all(cache.join(DOMAINS_DIR)).map_err(|err| format!("Cannot create a workspace: {err}"))?;

    let archive = cache.join("download.zip");
    download_batch(connection, &client, std::slice::from_ref(&guid.to_string()), &archive).await?;
    let unpacked = unpack_domains(&archive, &cache)?;
    let _ = fs::remove_file(&archive);

    let dir = cache.join(DOMAINS_DIR).join(guid);
    let routes_dir = dir.join("routes");
    let mut routes = Vec::new();
    if let Ok(entries) = fs::read_dir(&routes_dir) {
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().is_some_and(|ext| ext == "xml")
                    && path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("route-"))
            })
            .collect();
        files.sort();

        for file in files {
            let Ok(xml) = fs::read_to_string(&file) else { continue };
            for info in crate::route_xml::parse_routes(&xml) {
                routes.push(RouteFile {
                    id: info.id,
                    name: info.name,
                    trace_enabled: info.trace_enabled,
                    trace_configs: info.trace_configs,
                    inline_trace_config: info.inline_trace_config,
                    path: file.to_string_lossy().to_string(),
                });
            }
        }
    }
    routes.sort_by(|a, b| a.name.as_deref().unwrap_or("").to_lowercase().cmp(&b.name.as_deref().unwrap_or("").to_lowercase()));

    Ok(DomainRoutes {
        guid: guid.to_string(),
        name: unpacked.domains.first().map(|item| item.name.clone()),
        root: cache.to_string_lossy().to_string(),
        routes,
    })
}

// ───────────────────────────── сверить с сервером ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyMismatch {
    pub domain: String,
    pub bean: Option<String>,
    /// `broker`, `queue`, `traceMode` или `bean` — последнее означает,
    /// что объекта трассировки на сервере вовсе нет.
    pub field: String,
    pub expected: Option<String>,
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub domains: usize,
    pub beans: usize,
    /// Сколько значений совпало с тем, что лежит в локальных файлах.
    pub values: usize,
    pub mismatches: Vec<VerifyMismatch>,
    pub checked_at: String,
}

/// Забирает домены заново и сверяет трассировку с локальными файлами.
///
/// Отправка возвращает `200` даже тогда, когда шина сохранила не всё, что мы
/// послали, поэтому единственный честный ответ на вопрос «легло ли» — прочитать
/// конфигурацию обратно. Рабочая папка при этом не трогается: сверка живёт
/// в отдельном каталоге и убирается за собой.
pub async fn verify<F: FnMut(ApiProgress)>(
    connection: &Connection,
    root: &Path,
    guids: &[String],
    mut on_progress: F,
) -> Result<VerifyResult, String> {
    if guids.is_empty() {
        return Err("No domains selected".into());
    }
    let manifest = read_manifest(root)?;
    let names: std::collections::HashMap<&str, &str> = manifest
        .domains
        .iter()
        .map(|item| (item.guid.as_str(), item.name.as_str()))
        .collect();

    let client = connection.client()?;
    let scratch = root
        .parent()
        .ok_or_else(|| "Cannot locate the workspace".to_string())?
        .join(format!("verify-{}", stamp()));
    let fresh = scratch.join(EXPORT_DIR);
    fs::create_dir_all(fresh.join(DOMAINS_DIR)).map_err(|err| format!("Cannot create a workspace: {err}"))?;

    let expected = guids.len() as u64;
    let batches: Vec<Vec<String>> = guids.chunks(GUIDS_PER_REQUEST).map(<[String]>::to_vec).collect();
    let mut done = 0u64;
    on_progress(ApiProgress { phase: "verify", current: 0, total: expected });

    let outcome = async {
        for (wave, group) in batches.chunks(BATCH_CONCURRENCY).enumerate() {
            let mut running = Vec::with_capacity(group.len());
            for (offset, batch) in group.iter().enumerate() {
                let index = wave * BATCH_CONCURRENCY + offset;
                let path = scratch.join(format!("check-{index}.zip"));
                let connection = connection.clone();
                let client = client.clone();
                let batch = batch.clone();
                running.push(tauri::async_runtime::spawn(async move {
                    download_batch(&connection, &client, &batch, &path).await.map(|_| path)
                }));
            }
            for handle in running {
                let path = handle
                    .await
                    .map_err(|err| format!("Verification interrupted: {err}"))??;
                let unpacked = unpack_domains(&path, &fresh)?;
                let _ = fs::remove_file(&path);
                done += unpacked.domains.len() as u64;
                on_progress(ApiProgress { phase: "verify", current: done, total: expected });
            }
        }

        let mut mismatches = Vec::new();
        let mut beans = 0usize;
        let mut values = 0usize;

        for guid in guids {
            let domain = names.get(guid.as_str()).copied().unwrap_or(guid.as_str()).to_string();
            let local = read_traces(&root.join(DOMAINS_DIR).join(guid))?;
            let remote = read_traces(&fresh.join(DOMAINS_DIR).join(guid))?;

            for bean in &local {
                beans += 1;
                let key = bean.bean_id.clone().or_else(|| bean.bean_name.clone());
                let found = remote.iter().find(|item| {
                    item.bean_id.clone().or_else(|| item.bean_name.clone()) == key
                });
                let Some(found) = found else {
                    mismatches.push(VerifyMismatch {
                        domain: domain.clone(),
                        bean: key,
                        field: "bean".into(),
                        expected: None,
                        actual: None,
                    });
                    continue;
                };

                for (field, expected, actual) in [
                    ("broker", &bean.broker, &found.broker),
                    ("queue", &bean.queue, &found.queue),
                    ("traceMode", &bean.trace_mode, &found.trace_mode),
                ] {
                    if expected.is_none() {
                        continue;
                    }
                    if expected == actual {
                        values += 1;
                    } else {
                        mismatches.push(VerifyMismatch {
                            domain: domain.clone(),
                            bean: key.clone(),
                            field: field.into(),
                            expected: expected.clone(),
                            actual: actual.clone(),
                        });
                    }
                }
            }
        }

        Ok(VerifyResult {
            domains: guids.len(),
            beans,
            values,
            mismatches,
            checked_at: chrono::Local::now().to_rfc3339(),
        })
    }
    .await;

    let _ = fs::remove_dir_all(&scratch);
    outcome
}

/// Объекты трассировки одного домена из его `domain.xml`.
fn read_traces(dir: &Path) -> Result<Vec<crate::domain_xml::TraceBean>, String> {
    let path = dir.join("domain.xml");
    let xml = fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
    Ok(crate::domain_xml::parse_domain_xml(&xml).traces)
}

// ───────────────────────────── отправить обратно ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub domains: Vec<String>,
    pub files: usize,
    pub bytes: u64,
    pub reloaded: bool,
    /// Что ответила шина — обычно пусто при успехе.
    pub message: Option<String>,
    pub finished_at: String,
}

/// Отправляет выбранные домены обратно в шину.
///
/// Архив собирается ровно в том формате, в котором его отдал сервер:
/// опись `domains.json` и по вложенному архиву на каждый домен.
pub async fn push<F: FnMut(ApiProgress)>(
    connection: &Connection,
    root: &Path,
    guids: &[String],
    reload: bool,
    mut on_progress: F,
) -> Result<PushResult, String> {
    if guids.is_empty() {
        return Err("No domains selected".into());
    }

    let manifest = read_manifest(root)?;
    let known: std::collections::HashMap<&str, &ManifestDomain> =
        manifest.domains.iter().map(|item| (item.guid.as_str(), item)).collect();

    let mut selected: Vec<ManifestDomain> = Vec::new();
    for guid in guids {
        match known.get(guid.as_str()) {
            Some(found) => selected.push((*found).clone()),
            None => return Err(format!("Domain {guid} is not part of this download")),
        }
    }

    let mut buffer: Vec<u8> = Vec::new();
    let mut files = 0usize;
    {
        let mut outer = ZipWriter::new(Cursor::new(&mut buffer));
        // Вложенные архивы уже сжаты, сжимать их второй раз незачем.
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let total = selected.len() as u64;

        for (index, domain) in selected.iter().enumerate() {
            on_progress(ApiProgress { phase: "pack", current: index as u64 + 1, total });
            let dir = root.join(DOMAINS_DIR).join(&domain.guid);
            if !dir.is_dir() {
                return Err(format!("Folder is missing for domain {}: {}", domain.name, dir.display()));
            }
            let (inner, packed) = pack_domain(&dir)?;
            files += packed;
            outer
                .start_file(format!("{}.zip", domain.guid), stored)
                .map_err(|err| err.to_string())?;
            outer.write_all(&inner).map_err(|err| err.to_string())?;
        }

        let listing = serde_json::json!({
            "domains": selected.iter().map(|item| serde_json::json!({
                "guid": item.guid,
                "name": item.name,
                "group": item.group,
                "mode": item.mode.clone().unwrap_or_else(|| "DEFAULT".into()),
            })).collect::<Vec<_>>(),
            "rootDomain": serde_json::Value::Null,
        });
        outer
            .start_file("domains.json", SimpleFileOptions::default())
            .map_err(|err| err.to_string())?;
        outer
            .write_all(&serde_json::to_vec(&listing).map_err(|err| err.to_string())?)
            .map_err(|err| err.to_string())?;
        outer.finish().map_err(|err| format!("Cannot build the upload: {err}"))?;
    }

    let bytes = buffer.len() as u64;
    on_progress(ApiProgress { phase: "upload", current: 0, total: bytes });

    let client = connection.client()?;
    let part = reqwest::multipart::Part::bytes(buffer)
        .file_name("import.zip")
        .mime_str("application/zip")
        .map_err(|err| err.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let mut request = connection
        .post(&client, "/api/domains/import/archive")
        .query(&[("reload", if reload { "true" } else { "false" })]);
    for domain in &selected {
        request = request.query(&[("domains", domain.guid.as_str())]);
    }

    let response = request
        .multipart(form)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(transport_error)?;
    let ok = ensure_ok(response, "Import failed").await?;
    let text = ok.text().await.unwrap_or_default();

    on_progress(ApiProgress { phase: "upload", current: bytes, total: bytes });

    Ok(PushResult {
        domains: selected.iter().map(|item| item.name.clone()).collect(),
        files,
        bytes,
        reloaded: reload,
        message: {
            let trimmed = text.trim();
            if trimmed.is_empty() { None } else { Some(api_message(trimmed)) }
        },
        finished_at: chrono::Local::now().to_rfc3339(),
    })
}

/// Опись лежит рядом с папкой выгрузки — так она не попадает в собранные архивы.
fn read_manifest(root: &Path) -> Result<Manifest, String> {
    let path = root
        .parent()
        .map(|parent| parent.join(MANIFEST_FILE))
        .ok_or_else(|| "Cannot locate the download manifest".to_string())?;
    let text = fs::read_to_string(&path)
        .map_err(|_| "This configuration was not downloaded from a server".to_string())?;
    serde_json::from_str(&text).map_err(|err| format!("Cannot read the manifest: {err}"))
}

/// Собирает архив одного домена: то же содержимое, что прислал сервер,
/// за вычетом наших резервных копий.
fn pack_domain(dir: &Path) -> Result<(Vec<u8>, usize), String> {
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    collect(dir, "", &mut files);
    files.sort_by(|a, b| a.1.cmp(&b.1));

    let mut buffer: Vec<u8> = Vec::new();
    let mut written = 0usize;
    {
        let mut zip = ZipWriter::new(Cursor::new(&mut buffer));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (path, name) in &files {
            let Ok(mut source) = File::open(path) else { continue };
            zip.start_file(name, options).map_err(|err| format!("{name}: {err}"))?;
            std::io::copy(&mut source, &mut zip).map_err(|err| format!("{name}: {err}"))?;
            written += 1;
        }
        zip.finish().map_err(|err| format!("{}: {err}", dir.display()))?;
    }
    Ok((buffer, written))
}

fn collect(dir: &Path, prefix: &str, files: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let entry_name = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };

        if path.is_dir() {
            collect(&path, &entry_name, files);
            continue;
        }
        if JUNK_FILES.contains(&name.as_str()) || name.ends_with(".bak") || name.contains(".bak.") {
            continue;
        }
        files.push((path, entry_name));
    }
}

fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(url: &str) -> Connection {
        Connection { url: url.into(), username: "root".into(), password: "root".into(), insecure: false }
    }

    #[test]
    fn adds_the_manager_context_when_only_a_host_is_given() {
        assert_eq!(connection("localhost:8181").base(), "http://localhost:8181/manager");
        assert_eq!(connection("http://esb:8181").base(), "http://esb:8181/manager");
        assert_eq!(connection("https://esb/fesb/").base(), "https://esb/fesb");
        assert_eq!(connection("http://esb:8181/manager").base(), "http://esb:8181/manager");
    }

    #[test]
    fn the_transport_error_keeps_the_cause_and_drops_the_repeated_address() {
        // Своя ошибка reqwest недоступна для сборки вручную, поэтому проверяем
        // разбор цепочки на обычных ошибках: берётся самая глубокая причина.
        #[derive(Debug)]
        struct Layer(&'static str, Option<Box<Layer>>);
        impl std::fmt::Display for Layer {
            fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                out.write_str(self.0)
            }
        }
        impl std::error::Error for Layer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.1.as_deref().map(|item| item as &(dyn std::error::Error + 'static))
            }
        }

        let deep = Layer(
            "error sending request for url (https://esb.corp/manager/api/security/user)",
            Some(Box::new(Layer(
                "client error",
                Some(Box::new(Layer("failed to lookup address information", None))),
            ))),
        );
        assert_eq!(root_cause(&deep), "failed to lookup address information");
        // Единственный слой — он же и причина.
        assert_eq!(root_cause(&Layer("connection refused", None)), "connection refused");
    }

    #[test]
    fn reads_the_error_message_the_bus_returns() {
        assert_eq!(api_message(r#"{"code":100,"message":"Ошибка анализа"}"#), "Ошибка анализа");
        assert_eq!(api_message(r#"{"status":404,"error":"Not Found"}"#), "Not Found");
        assert_eq!(api_message("   "), "empty response");
        // так отвечает сам сервлет-контейнер, а не шина
        assert_eq!(
            api_message("<h1>Bad Message 414</h1><pre>reason: URI Too Long</pre>"),
            "Bad Message 414 reason: URI Too Long",
        );
    }

    #[test]
    fn packs_a_domain_without_our_backups() {
        let dir = std::env::temp_dir().join(format!("fesb-api-pack-{}", stamp()));
        fs::create_dir_all(dir.join("routes")).unwrap();
        fs::write(dir.join("domain.xml"), "<beans/>").unwrap();
        fs::write(dir.join("domain.xml.bak"), "<beans/>").unwrap();
        fs::write(dir.join("settings.properties"), "fesb.domain.name=A\n").unwrap();
        fs::write(dir.join("routes/route-1.xml"), "<beans/>").unwrap();

        let (bytes, written) = pack_domain(&dir).unwrap();
        assert_eq!(written, 3);

        let mut zip = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.contains(&"domain.xml".to_string()));
        assert!(names.contains(&"routes/route-1.xml".to_string()));
        assert!(!names.iter().any(|name| name.ends_with(".bak")));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unpacks_the_server_answer_into_the_usual_layout() {
        let dir = std::env::temp_dir().join(format!("fesb-api-unpack-{}", stamp()));
        fs::create_dir_all(&dir).unwrap();

        // так выглядит ответ /api/domains/export/archive
        let mut inner: Vec<u8> = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut inner));
            let options = SimpleFileOptions::default();
            zip.start_file("domain.xml", options).unwrap();
            zip.write_all(b"<beans/>").unwrap();
            zip.start_file("settings.properties", options).unwrap();
            zip.write_all(b"fesb.domain.name=Alpha\n").unwrap();
            zip.start_file("version", options).unwrap();
            zip.write_all(b"V8.6.524").unwrap();
            zip.finish().unwrap();
        }
        let archive = dir.join("outer.zip");
        {
            let mut zip = ZipWriter::new(File::create(&archive).unwrap());
            let options = SimpleFileOptions::default();
            zip.start_file("domain-1.zip", options).unwrap();
            zip.write_all(&inner).unwrap();
            zip.start_file("domains.json", options).unwrap();
            zip.write_all(br#"{"domains":[{"guid":"domain-1","name":"Alpha","group":null,"mode":"DEFAULT"}]}"#).unwrap();
            zip.finish().unwrap();
        }

        let root = dir.join("export");
        fs::create_dir_all(root.join(DOMAINS_DIR)).unwrap();
        let result = unpack_domains(&archive, &root).unwrap();

        assert_eq!(result.domains.len(), 1);
        assert_eq!(result.domains[0].name, "Alpha");
        assert!(result.has_version);
        assert!(root.join("domains/domain-1/domain.xml").is_file());
        assert_eq!(fs::read_to_string(root.join("version")).unwrap(), "V8.6.524");

        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod address_tests {
    use super::*;

    fn at(url: &str) -> Connection {
        Connection { url: url.into(), username: "root".into(), password: "root".into(), insecure: true }
    }

    #[test]
    fn local_stand_tries_plain_http_first() {
        assert_eq!(
            at("localhost:8181").candidates(),
            [
                "http://localhost:8181/manager",
                "https://localhost:8181/manager",
                "http://localhost:8181",
                "https://localhost:8181",
            ]
        );
    }

    #[test]
    fn corporate_host_tries_tls_first() {
        assert_eq!(
            at("esb.corp").candidates(),
            [
                "https://esb.corp/manager",
                "http://esb.corp/manager",
                "https://esb.corp",
                "http://esb.corp",
            ]
        );
    }

    #[test]
    fn explicit_scheme_and_path_are_left_alone() {
        assert_eq!(at("https://esb.corp/console").candidates(), ["https://esb.corp/console"]);
        assert_eq!(
            at("http://esb.corp:8181").candidates(),
            ["http://esb.corp:8181/manager", "http://esb.corp:8181"]
        );
    }

    #[test]
    fn port_443_is_read_as_tls() {
        assert_eq!(at("esb.corp:443").candidates()[0], "https://esb.corp:443/manager");
    }

    #[test]
    fn trailing_slash_and_spaces_do_not_matter() {
        assert_eq!(at("  localhost:8181/  ").candidates()[0], "http://localhost:8181/manager");
    }

    #[test]
    fn empty_address_has_nothing_to_try() {
        assert!(at("   ").candidates().is_empty());
    }
}
