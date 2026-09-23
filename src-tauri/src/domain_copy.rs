//! Копирование доменов с одного сервера на другой без промежуточных файлов.
//!
//! Идёт в два шага. Предпросмотр забирает домены с исходного сервера в память,
//! тем же способом читает их копии на целевом и сравнивает: какие домены
//! появятся, какие будут перезаписаны, какие СОПС добавятся, изменятся или
//! пропадут. Загрузка отправляет на целевой сервер ровно то, что было показано
//! в предпросмотре, — архивы хранятся в памяти до неё, а не выгружаются
//! второй раз.
//!
//! Импорт доменов в FESB по умолчанию сливает содержимое: СОПС, которых нет
//! в архиве, на целевом сервере остаются. Точную копию даёт параметр
//! `delete=routes` — «удалить отсутствующие в импорте СОПС».

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::fesb_api::{
    api_message, coded, connect, domains, ensure_ok, transport_error, ApiProgress, Connection, ManifestDomain,
    ServerInfo,
};

/// Сколько доменов в одном запросе: guid уходят в строку запроса, а её длину
/// сервер ограничивает. Столько же берёт и выгрузка в папку.
const GUIDS_PER_REQUEST: usize = 10;
/// Выгрузка и загрузка пачки: шина собирает и разбирает архив минутами.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);
/// Журналы запусков СОПС принадлежат серверу, на котором они шли. Модели
/// данных копируются: без них СОПС на новом сервере может не подняться.
const EXPORT_EXCLUDE: &str = "history";
/// Файлы с настройками домена. Прочее в архиве — СОПС, модели и служебное.
const SETTINGS_FILES: [&str; 3] = ["domain.xml", "settings.properties", "domain.properties"];
/// Право, без которого целевой сервер архив не примет.
const IMPORT_PERMISSION: &str = "DOMAIN_IMPORT";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteChange {
    Added,
    Changed,
    /// Есть только на целевом сервере. Удаляется, если так решил пользователь.
    Removed,
    Same,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyRoute {
    pub id: String,
    pub name: Option<String>,
    pub change: RouteChange,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyDomain {
    pub guid: String,
    pub name: String,
    /// Домен с тем же guid уже есть на целевом сервере и будет перезаписан.
    pub exists: bool,
    /// Имя, под которым домен сейчас живёт на целевом сервере, если оно другое.
    pub target_name: Option<String>,
    /// На целевом сервере под тем же именем живёт другой домен: после
    /// копирования там окажутся два домена с одним именем.
    pub name_taken_by: Option<String>,
    pub active_on_target: bool,
    /// Изменятся настройки самого домена: `domain.xml` или свойства.
    pub settings_changed: bool,
    pub routes: Vec<CopyRoute>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPlan {
    /// По нему загрузка находит архивы, показанные в предпросмотре.
    pub id: String,
    pub target: ServerInfo,
    pub domains: Vec<CopyDomain>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutcome {
    pub guid: String,
    pub name: String,
    /// Что пошло не так; пусто — домен загружен.
    pub error: Option<String>,
    /// Что ответила шина — обычно пусто при успехе.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub domains: Vec<CopyOutcome>,
    pub reloaded: bool,
    pub removed_missing: bool,
    pub finished_at: String,
}

/// Домен, выгруженный с исходного сервера: опись и его вложенный архив.
struct Packed {
    domain: ManifestDomain,
    archive: Vec<u8>,
}

struct Pending {
    id: String,
    /// Адрес целевого сервера: загрузить архив в другой было бы подменой.
    target: String,
    packed: Vec<Packed>,
}

/// Последний предпросмотр. Хранится один: новый вытесняет старый, и память
/// не копит архивы брошенных попыток.
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

/// Предпросмотр: что изменится на целевом сервере.
pub async fn plan<F: FnMut(ApiProgress)>(
    source: &Connection,
    target: &Connection,
    guids: &[String],
    mut on_progress: F,
) -> Result<CopyPlan, String> {
    if guids.is_empty() {
        return Err("No domains selected".into());
    }
    if source.base() == target.base() {
        return Err(coded("copy.sameServer", target.base()));
    }

    // Подключение заодно проверяет пароль и права: узнать об их нехватке
    // лучше до того, как домены выгружены.
    let server = connect(target).await?;
    if server.missing_permissions.iter().any(|item| item == IMPORT_PERMISSION) {
        return Err(coded("copy.noImportRight", format!("{} · {}", server.user, IMPORT_PERMISSION)));
    }

    let total = guids.len() as u64;
    let mut packed: Vec<Packed> = Vec::with_capacity(guids.len());
    for batch in guids.chunks(GUIDS_PER_REQUEST) {
        on_progress(ApiProgress { phase: "domains", current: packed.len() as u64, total });
        packed.extend(export(source, batch).await?);
    }
    on_progress(ApiProgress { phase: "domains", current: total, total });
    for guid in guids {
        if !packed.iter().any(|item| &item.domain.guid == guid) {
            return Err(format!("The source server did not export domain {guid}"));
        }
    }

    let present = domains(target).await?;
    let by_guid: HashMap<&str, &crate::fesb_api::ApiDomain> =
        present.iter().map(|item| (item.guid.as_str(), item)).collect();

    // Копии на целевом сервере нужны только для тех доменов, что там уже есть.
    let existing: Vec<String> = guids.iter().filter(|guid| by_guid.contains_key(guid.as_str())).cloned().collect();
    let mut theirs: HashMap<String, Vec<u8>> = HashMap::new();
    for batch in existing.chunks(GUIDS_PER_REQUEST) {
        on_progress(ApiProgress { phase: "verify", current: theirs.len() as u64, total: existing.len() as u64 });
        for item in export(target, batch).await? {
            theirs.insert(item.domain.guid, item.archive);
        }
    }

    let mut rows = Vec::with_capacity(packed.len());
    for item in &packed {
        let ours = read_domain(&item.archive)?;
        let on_target = by_guid.get(item.domain.guid.as_str());
        let before = match theirs.get(&item.domain.guid) {
            Some(bytes) => Some(read_domain(bytes)?),
            None => None,
        };
        let name_taken_by = present
            .iter()
            .find(|other| other.guid != item.domain.guid && other.name == item.domain.name)
            .map(|other| other.guid.clone());

        rows.push(CopyDomain {
            guid: item.domain.guid.clone(),
            name: item.domain.name.clone(),
            exists: on_target.is_some(),
            target_name: on_target.filter(|found| found.name != item.domain.name).map(|found| found.name.clone()),
            name_taken_by,
            active_on_target: on_target.is_some_and(|found| found.active),
            settings_changed: before.as_ref().is_some_and(|old| old.settings != ours.settings),
            routes: compare_routes(&ours, before.as_ref()),
        });
    }

    let bytes = packed.iter().map(|item| item.archive.len() as u64).sum();
    let id = format!("copy-{}", chrono::Local::now().timestamp_nanos_opt().unwrap_or_default());
    *PENDING.lock().map_err(|_| "Copy state is unavailable".to_string())? = Some(Pending {
        id: id.clone(),
        target: target.base(),
        packed,
    });

    Ok(CopyPlan { id, target: server, domains: rows, bytes })
}

/// Загружает на целевой сервер домены из предпросмотра `plan_id`.
///
/// Пачками, как и выгрузка. Ошибка одной пачки не останавливает остальные:
/// каждый домен получает свой исход, и сводка показывает, что дошло.
pub async fn run<F: FnMut(ApiProgress)>(
    target: &Connection,
    plan_id: &str,
    reload: bool,
    remove_missing: bool,
    mut on_progress: F,
) -> Result<CopyResult, String> {
    let pending = {
        let mut slot = PENDING.lock().map_err(|_| "Copy state is unavailable".to_string())?;
        match slot.take() {
            Some(found) if found.id == plan_id => found,
            other => {
                *slot = other;
                return Err(coded("copy.planExpired", plan_id));
            }
        }
    };
    if pending.target != target.base() {
        return Err(coded("copy.otherTarget", target.base()));
    }

    let client = target.client()?;
    let total = pending.packed.len() as u64;
    let mut outcomes = Vec::with_capacity(pending.packed.len());

    for batch in pending.packed.chunks(GUIDS_PER_REQUEST) {
        on_progress(ApiProgress { phase: "upload", current: outcomes.len() as u64, total });
        let answer = upload(target, &client, batch, reload, remove_missing).await;
        for item in batch {
            outcomes.push(CopyOutcome {
                guid: item.domain.guid.clone(),
                name: item.domain.name.clone(),
                error: answer.as_ref().err().cloned(),
                message: answer.as_ref().ok().cloned().flatten(),
            });
        }
    }
    on_progress(ApiProgress { phase: "upload", current: total, total });

    Ok(CopyResult {
        domains: outcomes,
        reloaded: reload,
        removed_missing: remove_missing,
        finished_at: chrono::Local::now().to_rfc3339(),
    })
}

/// Выгружает пачку доменов в память и раскладывает архив по доменам.
async fn export(connection: &Connection, guids: &[String]) -> Result<Vec<Packed>, String> {
    let client = connection.client()?;
    let mut request = connection
        .get(&client, "/api/domains/export/archive")
        .timeout(TRANSFER_TIMEOUT)
        .query(&[("exclude", EXPORT_EXCLUDE)]);
    for guid in guids {
        request = request.query(&[("domains", guid.as_str())]);
    }
    let response = request.send().await.map_err(transport_error)?;
    let bytes = ensure_ok(response, "Cannot export domains")
        .await?
        .bytes()
        .await
        .map_err(transport_error)?;
    split_export(&bytes)
}

/// Архив выгрузки: опись `domains.json` и по вложенному архиву на домен.
fn split_export(bytes: &[u8]) -> Result<Vec<Packed>, String> {
    let mut outer =
        ZipArchive::new(Cursor::new(bytes)).map_err(|err| format!("The server did not return a zip: {err}"))?;

    let mut listed: HashMap<String, ManifestDomain> = HashMap::new();
    if let Ok(mut entry) = outer.by_name("domains.json") {
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|err| format!("domains.json: {err}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|err| format!("domains.json: {err}"))?;
        let items = value.get("domains").and_then(|item| item.as_array()).cloned().unwrap_or_default();
        for item in items {
            if let Ok(domain) = serde_json::from_value::<ManifestDomain>(item) {
                listed.insert(domain.guid.clone(), domain);
            }
        }
    }

    let mut packed = Vec::new();
    for index in 0..outer.len() {
        let mut entry = outer.by_index(index).map_err(|err| err.to_string())?;
        let name = entry.name().to_string();
        let Some(guid) = name.strip_suffix(".zip") else { continue };
        if guid.contains('/') {
            continue;
        }
        let mut archive = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut archive).map_err(|err| format!("{name}: {err}"))?;
        let domain = listed.remove(guid).unwrap_or_else(|| ManifestDomain {
            guid: guid.to_string(),
            name: guid.to_string(),
            group: None,
            mode: None,
        });
        packed.push(Packed { domain, archive });
    }
    Ok(packed)
}

/// Отправляет пачку доменов в формате, в котором их отдаёт выгрузка.
async fn upload(
    target: &Connection,
    client: &reqwest::Client,
    batch: &[Packed],
    reload: bool,
    remove_missing: bool,
) -> Result<Option<String>, String> {
    let body = pack_import(batch)?;
    let part = reqwest::multipart::Part::bytes(body)
        .file_name("import.zip")
        .mime_str("application/zip")
        .map_err(|err| err.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let mut request = target
        .post(client, "/api/domains/import/archive")
        .query(&[("reload", if reload { "true" } else { "false" })]);
    if remove_missing {
        request = request.query(&[("delete", "routes")]);
    }
    for item in batch {
        request = request.query(&[("domains", item.domain.guid.as_str())]);
    }

    let response = request
        .multipart(form)
        .timeout(TRANSFER_TIMEOUT)
        .send()
        .await
        .map_err(transport_error)?;
    let text = ensure_ok(response, "Import failed").await?.text().await.unwrap_or_default();
    let trimmed = text.trim();
    Ok(if trimmed.is_empty() { None } else { Some(api_message(trimmed)) })
}

fn pack_import(batch: &[Packed]) -> Result<Vec<u8>, String> {
    let mut buffer: Vec<u8> = Vec::new();
    {
        let mut outer = ZipWriter::new(Cursor::new(&mut buffer));
        // Вложенные архивы уже сжаты, сжимать их второй раз незачем.
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for item in batch {
            outer
                .start_file(format!("{}.zip", item.domain.guid), stored)
                .map_err(|err| err.to_string())?;
            outer.write_all(&item.archive).map_err(|err| err.to_string())?;
        }
        let listing = serde_json::json!({
            "domains": batch.iter().map(|item| serde_json::json!({
                "guid": item.domain.guid,
                "name": item.domain.name,
                "group": item.domain.group,
                "mode": item.domain.mode.clone().unwrap_or_else(|| "DEFAULT".into()),
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
    Ok(buffer)
}

/// Содержимое одного домена, из которого строится сравнение.
struct DomainFiles {
    /// Настройки домена без строк-комментариев: в них шина пишет время выгрузки.
    settings: Vec<(String, String)>,
    /// Файл СОПС → (id, имя, содержимое).
    routes: Vec<(String, Option<String>, Vec<u8>)>,
}

fn read_domain(archive: &[u8]) -> Result<DomainFiles, String> {
    let mut zip = ZipArchive::new(Cursor::new(archive)).map_err(|err| format!("not a valid zip: {err}"))?;
    let mut settings = Vec::new();
    let mut routes = Vec::new();

    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|err| err.to_string())?;
        let name = entry.name().replace('\\', "/");
        let is_route = name.starts_with("routes/route-") && name.ends_with(".xml");
        if !is_route && !SETTINGS_FILES.contains(&name.as_str()) {
            continue;
        }
        let mut content = Vec::new();
        entry.read_to_end(&mut content).map_err(|err| format!("{name}: {err}"))?;

        if is_route {
            let text = String::from_utf8_lossy(&content);
            let info = crate::route_xml::parse_routes(&text).into_iter().next();
            let file_id = name.trim_start_matches("routes/").trim_end_matches(".xml").to_string();
            let id = info.as_ref().and_then(|item| item.id.clone()).unwrap_or(file_id);
            routes.push((id, info.and_then(|item| item.name), content));
        } else {
            let text = String::from_utf8_lossy(&content);
            let mut lines: Vec<&str> =
                text.lines().filter(|line| !line.trim_start().starts_with('#')).collect();
            // Порядок свойств в файле ничего не значит, а шина его не держит.
            if name.ends_with(".properties") {
                lines.sort_unstable();
            }
            settings.push((name, lines.join("\n")));
        }
    }
    settings.sort();
    Ok(DomainFiles { settings, routes })
}

fn compare_routes(ours: &DomainFiles, before: Option<&DomainFiles>) -> Vec<CopyRoute> {
    let old: HashMap<&str, &(String, Option<String>, Vec<u8>)> = before
        .map(|files| files.routes.iter().map(|item| (item.0.as_str(), item)).collect())
        .unwrap_or_default();

    let mut rows: Vec<CopyRoute> = ours
        .routes
        .iter()
        .map(|(id, name, content)| CopyRoute {
            id: id.clone(),
            name: name.clone(),
            change: match old.get(id.as_str()) {
                None => RouteChange::Added,
                Some(previous) if previous.2 == *content => RouteChange::Same,
                Some(_) => RouteChange::Changed,
            },
        })
        .collect();

    if let Some(files) = before {
        for (id, name, _) in &files.routes {
            if !ours.routes.iter().any(|item| &item.0 == id) {
                rows.push(CopyRoute { id: id.clone(), name: name.clone(), change: RouteChange::Removed });
            }
        }
    }
    rows.sort_by(|a, b| {
        a.name.as_deref().unwrap_or(&a.id).to_lowercase().cmp(&b.name.as_deref().unwrap_or(&b.id).to_lowercase())
    });
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn domain_zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buffer));
            for (name, content) in files {
                zip.start_file(*name, SimpleFileOptions::default()).unwrap();
                zip.write_all(content.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buffer
    }

    fn route(id: &str, name: &str, body: &str) -> String {
        format!(r#"<beans><routeContext id="{id}"><route factor-name="{name}" id="{id}"><from uri="{body}"/></route></routeContext></beans>"#)
    }

    #[test]
    fn sorts_routes_into_added_changed_removed_and_same() {
        let a = route("route-a", "A", "direct://a");
        let b = route("route-b", "B", "direct://b");
        let b2 = route("route-b", "B", "direct://b2");
        let c = route("route-c", "C", "direct://c");
        let d = route("route-d", "D", "direct://d");

        let ours = read_domain(&domain_zip(&[
            ("domain.xml", "<beans/>"),
            ("settings.properties", "#Mon Sep 22\nx=1"),
            ("routes/route-a.xml", &a),
            ("routes/route-b.xml", &b2),
            ("routes/route-d.xml", &d),
        ]))
        .unwrap();
        let theirs = read_domain(&domain_zip(&[
            ("domain.xml", "<beans/>"),
            ("settings.properties", "#Tue Sep 23\nx=1"),
            ("routes/route-b.xml", &b),
            ("routes/route-c.xml", &c),
            ("routes/route-d.xml", &d),
        ]))
        .unwrap();

        let changes: Vec<(String, RouteChange)> =
            compare_routes(&ours, Some(&theirs)).into_iter().map(|item| (item.id, item.change)).collect();
        assert_eq!(
            changes,
            vec![
                ("route-a".into(), RouteChange::Added),
                ("route-b".into(), RouteChange::Changed),
                ("route-c".into(), RouteChange::Removed),
                ("route-d".into(), RouteChange::Same),
            ]
        );
        assert_eq!(ours.settings, theirs.settings, "время выгрузки в комментарии — не изменение настроек");
    }

    #[test]
    fn a_new_domain_brings_only_added_routes() {
        let ours = read_domain(&domain_zip(&[("routes/route-a.xml", &route("route-a", "A", "direct://a"))])).unwrap();
        let rows = compare_routes(&ours, None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].change, RouteChange::Added);
    }

    #[test]
    fn import_archive_has_the_export_layout() {
        let packed = vec![Packed {
            domain: ManifestDomain { guid: "domain-1".into(), name: "One".into(), group: None, mode: None },
            archive: domain_zip(&[("domain.xml", "<beans/>")]),
        }];
        let body = pack_import(&packed).unwrap();
        let back = split_export(&body).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].domain.name, "One");
        assert_eq!(back[0].archive, packed[0].archive);
    }
}
