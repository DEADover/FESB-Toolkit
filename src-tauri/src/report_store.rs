//! Хранилище собранных отчётов.
//!
//! Отчёт по точкам входа и выхода собирается полторы минуты: сервер
//! выкачивается целиком. При этом он жил только в памяти экрана — стоило
//! уйти на соседнюю вкладку или сменить стенд, и полторы минуты работы
//! пропадали, как будто отчёта и не было.
//!
//! Поэтому каждый собранный отчёт ложится на диск, в каталог данных
//! приложения, и остаётся там между запусками. Хранилище устроено просто:
//!
//! * `index.json` — список: когда собран, по какому серверу, сколько точек;
//! * `<id>.json` — сам отчёт, читается только когда его открывают.
//!
//! Разделение нужно из-за размера: отчёт со стенда на 256 доменов — это
//! пара мегабайт, и разбирать их ради одной даты в списке незачем.
//!
//! Отчёты хранятся по серверам: у каждого стенда свой список, и переключение
//! стенда показывает его историю, а не чужую.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Сколько отчётов держится по одному серверу.
///
/// Десяти хватает, чтобы посмотреть, что менялось за последние недели,
/// а дальше начинает копиться по паре мегабайт на каждый.
const KEEP_PER_SERVER: usize = 10;

const INDEX_FILE: &str = "index.json";

/// Строка списка: всё, что нужно показать, не читая сам отчёт.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReportEntry {
    pub id: String,
    /// Адрес сервера — по нему отчёты и разделяются.
    pub server: String,
    /// Когда собран, в местном времени: `2026-08-27T21:15:04`.
    pub built_at: String,
    pub points: usize,
    /// Сколько разных узлов в отчёте — вторая цифра, по которой их сравнивают.
    pub hosts: usize,
}

/// Отчёт целиком: строка списка плюс сами точки.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredReport {
    #[serde(flatten)]
    pub entry: ReportEntry,
    pub endpoints: Vec<crate::api_report::Endpoint>,
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join(INDEX_FILE)
}

fn report_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Читает список. Испорченный или отсутствующий индекс — это пустая история,
/// а не ошибка: терять из-за него доступ к разделу незачем.
pub fn list(dir: &Path) -> Vec<ReportEntry> {
    let Ok(text) = fs::read_to_string(index_path(dir)) else { return Vec::new() };
    let entries: Vec<ReportEntry> = serde_json::from_str(&text).unwrap_or_default();
    // Отчёт, файл которого пропал, показывать нельзя: открыть его не выйдет.
    entries.into_iter().filter(|entry| report_path(dir, &entry.id).exists()).collect()
}

/// Кладёт отчёт и возвращает обновлённый список.
///
/// Сначала пишется сам отчёт, потом индекс: если запись оборвётся, в списке
/// не окажется строки, которую нечем открыть.
pub fn save(
    dir: &Path,
    server: &str,
    built_at: &str,
    endpoints: &[crate::api_report::Endpoint],
) -> Result<Vec<ReportEntry>, String> {
    fs::create_dir_all(dir).map_err(|err| format!("Cannot create the report folder: {err}"))?;

    let hosts = {
        let mut all: Vec<&str> =
            endpoints.iter().filter_map(|point| point.host.as_deref()).filter(|host| !host.is_empty()).collect();
        all.sort_unstable();
        all.dedup();
        all.len()
    };
    let entry = ReportEntry {
        id: id_for(built_at, server),
        server: server.to_string(),
        built_at: built_at.to_string(),
        points: endpoints.len(),
        hosts,
    };
    let stored = StoredReport { entry: entry.clone(), endpoints: endpoints.to_vec() };
    let body = serde_json::to_string(&stored).map_err(|err| format!("Cannot pack the report: {err}"))?;
    fs::write(report_path(dir, &entry.id), body).map_err(|err| format!("Cannot write the report: {err}"))?;

    let mut entries = list(dir);
    // Повторная сборка в ту же секунду перезаписывает файл — строку не двоим.
    entries.retain(|item| item.id != entry.id);
    entries.push(entry);
    prune(dir, &mut entries);
    write_index(dir, &entries)?;
    Ok(sorted(entries))
}

/// Читает отчёт целиком.
pub fn read(dir: &Path, id: &str) -> Result<StoredReport, String> {
    let text = fs::read_to_string(report_path(dir, id))
        .map_err(|err| format!("Cannot read the report: {err}"))?;
    serde_json::from_str(&text).map_err(|err| format!("The report file is damaged: {err}"))
}

/// Убирает отчёт и возвращает то, что осталось.
pub fn remove(dir: &Path, id: &str) -> Result<Vec<ReportEntry>, String> {
    let _ = fs::remove_file(report_path(dir, id));
    let mut entries = list(dir);
    entries.retain(|item| item.id != id);
    write_index(dir, &entries)?;
    Ok(sorted(entries))
}

/// Оставляет по `KEEP_PER_SERVER` свежих отчётов на сервер, старые удаляет.
fn prune(dir: &Path, entries: &mut Vec<ReportEntry>) {
    let mut servers: Vec<String> = entries.iter().map(|entry| entry.server.clone()).collect();
    servers.sort();
    servers.dedup();

    let mut doomed: Vec<String> = Vec::new();
    for server in servers {
        let mut mine: Vec<&ReportEntry> = entries.iter().filter(|entry| entry.server == server).collect();
        mine.sort_by(|a, b| b.built_at.cmp(&a.built_at));
        for extra in mine.into_iter().skip(KEEP_PER_SERVER) {
            doomed.push(extra.id.clone());
        }
    }
    for id in &doomed {
        let _ = fs::remove_file(report_path(dir, id));
    }
    entries.retain(|entry| !doomed.contains(&entry.id));
}

fn write_index(dir: &Path, entries: &[ReportEntry]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("Cannot create the report folder: {err}"))?;
    let body = serde_json::to_string_pretty(&sorted(entries.to_vec()))
        .map_err(|err| format!("Cannot pack the list: {err}"))?;
    fs::write(index_path(dir), body).map_err(|err| format!("Cannot write the list: {err}"))
}

/// Свежие сверху: список открывают, чтобы взять последний отчёт.
fn sorted(mut entries: Vec<ReportEntry>) -> Vec<ReportEntry> {
    entries.sort_by(|a, b| b.built_at.cmp(&a.built_at));
    entries
}

/// Имя файла из времени и адреса — читаемое и годное для любой файловой системы.
fn id_for(built_at: &str, server: &str) -> String {
    let stamp: String = built_at.chars().filter(|c| c.is_ascii_digit()).collect();
    let host: String = server
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let host = host.trim_matches('-');
    let host: String = host.chars().take(40).collect();
    format!("endpoints-{stamp}-{host}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_report::Endpoint;

    fn point(host: Option<&str>) -> Endpoint {
        Endpoint {
            domain: "d".into(), domain_guid: "g".into(), route: "r".into(), route_id: "id".into(),
            component: "c".into(), direction: "in".into(), kind: "HTTP".into(), scheme: "https".into(),
            uri: "https://x/y".into(), host: host.map(String::from), port: Some(443), ssl: None,
            protocol: None, ciphers: None, auth: None, state: None, listening: None, uptime: None,
            busy_threads: None, utilized_threads: None, ready_threads: None, min_threads: None,
            max_threads: None, queue_size: None, idle_timeout: None, idle_threads: None,
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("fesb-reports-{tag}-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_saved_report_comes_back_whole() {
        let dir = scratch("roundtrip");
        let points = vec![point(Some("sap.corp")), point(Some("esb.corp"))];
        let listed = save(&dir, "http://localhost:8181/manager", "2026-08-27T21:15:04", &points).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].points, 2);
        assert_eq!(listed[0].hosts, 2);

        let back = read(&dir, &listed[0].id).unwrap();
        assert_eq!(back.endpoints.len(), 2);
        assert_eq!(back.entry.built_at, "2026-08-27T21:15:04");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn addresses_without_a_host_are_not_counted_as_systems() {
        let dir = scratch("hosts");
        let points = vec![point(Some("sap.corp")), point(Some("sap.corp")), point(None), point(Some(""))];
        let listed = save(&dir, "srv", "2026-08-27T10:00:00", &points).unwrap();
        assert_eq!(listed[0].points, 4);
        assert_eq!(listed[0].hosts, 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_newest_report_is_first() {
        let dir = scratch("order");
        save(&dir, "srv", "2026-08-25T10:00:00", &[point(None)]).unwrap();
        save(&dir, "srv", "2026-08-27T10:00:00", &[point(None)]).unwrap();
        let listed = save(&dir, "srv", "2026-08-26T10:00:00", &[point(None)]).unwrap();
        let dates: Vec<&str> = listed.iter().map(|entry| entry.built_at.as_str()).collect();
        assert_eq!(dates, ["2026-08-27T10:00:00", "2026-08-26T10:00:00", "2026-08-25T10:00:00"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn every_server_keeps_its_own_history() {
        let dir = scratch("servers");
        save(&dir, "http://dev:8181/manager", "2026-08-25T10:00:00", &[point(None)]).unwrap();
        let listed = save(&dir, "https://prod/manager", "2026-08-26T10:00:00", &[point(None)]).unwrap();
        assert_eq!(listed.len(), 2);
        let dev: Vec<&ReportEntry> =
            listed.iter().filter(|entry| entry.server == "http://dev:8181/manager").collect();
        assert_eq!(dev.len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn old_reports_of_one_server_make_way_for_new_ones() {
        let dir = scratch("prune");
        for day in 1..=KEEP_PER_SERVER + 3 {
            save(&dir, "srv", &format!("2026-08-{day:02}T10:00:00"), &[point(None)]).unwrap();
        }
        let listed = list(&dir);
        assert_eq!(listed.len(), KEEP_PER_SERVER);
        // Ушли самые старые, а не самые свежие.
        assert!(listed.iter().all(|entry| entry.built_at > "2026-08-03".to_string()));
        // Файлы удалены вместе со строками, а не остались лежать.
        let files = fs::read_dir(&dir).unwrap().count();
        assert_eq!(files, KEEP_PER_SERVER + 1, "лишние файлы отчётов остались на диске");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_report_whose_file_is_gone_drops_out_of_the_list() {
        let dir = scratch("orphan");
        let listed = save(&dir, "srv", "2026-08-27T10:00:00", &[point(None)]).unwrap();
        fs::remove_file(report_path(&dir, &listed[0].id)).unwrap();
        assert!(list(&dir).is_empty(), "строка без файла осталась в списке");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removing_a_report_takes_its_file_too() {
        let dir = scratch("remove");
        let listed = save(&dir, "srv", "2026-08-27T10:00:00", &[point(None)]).unwrap();
        let id = listed[0].id.clone();
        assert!(remove(&dir, &id).unwrap().is_empty());
        assert!(!report_path(&dir, &id).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_or_broken_index_reads_as_an_empty_history() {
        let dir = scratch("broken");
        assert!(list(&dir).is_empty());
        fs::write(index_path(&dir), "{ это не json").unwrap();
        assert!(list(&dir).is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_file_name_holds_no_surprises_for_the_file_system() {
        let id = id_for("2026-08-27T21:15:04", "https://pu01.pkg01.ig-pkg.d8s.lab-sp.corp/manager");
        assert!(id.starts_with("endpoints-20260827211504-"));
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "{id}");
        // Один и тот же отчёт получает одно и то же имя.
        assert_eq!(id, id_for("2026-08-27T21:15:04", "https://pu01.pkg01.ig-pkg.d8s.lab-sp.corp/manager"));
        // Разные серверы в ту же секунду не сталкиваются.
        assert_ne!(id, id_for("2026-08-27T21:15:04", "http://localhost:8181/manager"));
    }
}
