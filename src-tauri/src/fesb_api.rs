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
    /// Приводит адрес к виду `http://host:port/manager`.
    ///
    /// Пользователю достаточно ввести `localhost:8181` — путь до менеджера
    /// подставится сам, но явно указанный путь мы не трогаем.
    pub(crate) fn base(&self) -> String {
        let raw = self.url.trim().trim_end_matches('/');
        let full = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
        let after_scheme = full.splitn(2, "://").nth(1).unwrap_or("");
        if after_scheme.contains('/') {
            full
        } else {
            format!("{full}/manager")
        }
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
    if err.is_connect() || err.is_timeout() {
        format!("Cannot reach the server: {err}")
    } else {
        err.to_string()
    }
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

pub async fn connect(connection: &Connection) -> Result<ServerInfo, String> {
    let client = connection.client()?;

    let response = connection
        .get(&client, "/api/security/user")
        .send()
        .await
        .map_err(transport_error)?;
    let body = ensure_ok(response, "Cannot read the current user").await?;
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
    std::env::temp_dir().join("fesb-settings-editor")
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
