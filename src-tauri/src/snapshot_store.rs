//! Снимки стендов.
//!
//! Сравнение двух живых стендов отвечает на вопрос «чем тест отличается от
//! продуктива», но не на вопрос «что поменялось на продуктиве с прошлого
//! релиза». Аудит показывает, кто что трогал, но не итог. Снимок — это
//! слепок стенда из сравнения, положенный на диск: потом его сравнивают
//! с тем же стендом сейчас или с другим снимком.
//!
//! Устроено так же, как история отчётов: `index.json` со строками списка
//! и по файлу на снимок, который читается, только когда его сравнивают.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::compare::Profile;

/// Сколько снимков держится по одному серверу. Снимок — это сотни килобайт
/// констант, и двадцати хватает на полгода релизов раз в неделю.
const KEEP_PER_SERVER: usize = 20;

const INDEX_FILE: &str = "index.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub id: String,
    /// Адрес сервера — по нему снимки и разделяются.
    pub server: String,
    /// Когда снят, в местном времени: `2026-09-25T13:05:04`.
    pub taken_at: String,
    /// Подпись от человека: «перед релизом 4.2». Может быть пустой.
    pub label: String,
    pub domains: usize,
    pub routes: usize,
    pub properties: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSnapshot {
    #[serde(flatten)]
    pub entry: SnapshotEntry,
    pub profile: Profile,
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join(INDEX_FILE)
}

/// Имя складывается из времени и хоста; всё прочее отбрасывается, чтобы
/// из имени нельзя было построить путь за пределы папки.
fn snapshot_path(dir: &Path, id: &str) -> PathBuf {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
    dir.join(format!("{safe}.json"))
}

/// Список. Испорченный индекс — пустая история, а не ошибка.
pub fn list(dir: &Path) -> Vec<SnapshotEntry> {
    let Ok(text) = fs::read_to_string(index_path(dir)) else { return Vec::new() };
    let entries: Vec<SnapshotEntry> = serde_json::from_str(&text).unwrap_or_default();
    sorted(entries.into_iter().filter(|entry| snapshot_path(dir, &entry.id).exists()).collect())
}

/// Кладёт снимок: сначала файл, потом индекс — оборванная запись не
/// оставит в списке строку, которую нечем открыть.
pub fn save(dir: &Path, taken_at: &str, label: &str, profile: Profile) -> Result<Vec<SnapshotEntry>, String> {
    fs::create_dir_all(dir).map_err(|err| format!("Cannot create the snapshot folder: {err}"))?;
    let server = profile.facts.url.clone();
    let entry = SnapshotEntry {
        id: id_for(taken_at, &server),
        server,
        taken_at: taken_at.to_string(),
        label: label.trim().to_string(),
        domains: profile.domains.len(),
        routes: profile.routes.len(),
        properties: profile.properties.len() + profile.secured,
    };
    let stored = StoredSnapshot { entry: entry.clone(), profile };
    let body = serde_json::to_string(&stored).map_err(|err| format!("Cannot pack the snapshot: {err}"))?;
    fs::write(snapshot_path(dir, &entry.id), body).map_err(|err| format!("Cannot write the snapshot: {err}"))?;

    let mut entries = list(dir);
    entries.retain(|item| item.id != entry.id);
    entries.push(entry);
    prune(dir, &mut entries);
    write_index(dir, &entries)?;
    Ok(sorted(entries))
}

pub fn read(dir: &Path, id: &str) -> Result<StoredSnapshot, String> {
    let text = fs::read_to_string(snapshot_path(dir, id)).map_err(|err| format!("Cannot read the snapshot: {err}"))?;
    serde_json::from_str(&text).map_err(|err| format!("The snapshot file is damaged: {err}"))
}

pub fn remove(dir: &Path, id: &str) -> Result<Vec<SnapshotEntry>, String> {
    let _ = fs::remove_file(snapshot_path(dir, id));
    let mut entries = list(dir);
    entries.retain(|item| item.id != id);
    write_index(dir, &entries)?;
    Ok(sorted(entries))
}

fn prune(dir: &Path, entries: &mut Vec<SnapshotEntry>) {
    let mut servers: Vec<String> = entries.iter().map(|entry| entry.server.clone()).collect();
    servers.sort();
    servers.dedup();
    let mut doomed: Vec<String> = Vec::new();
    for server in servers {
        let mut mine: Vec<&SnapshotEntry> = entries.iter().filter(|entry| entry.server == server).collect();
        mine.sort_by(|a, b| b.taken_at.cmp(&a.taken_at));
        doomed.extend(mine.into_iter().skip(KEEP_PER_SERVER).map(|entry| entry.id.clone()));
    }
    for id in &doomed {
        let _ = fs::remove_file(snapshot_path(dir, id));
    }
    entries.retain(|entry| !doomed.contains(&entry.id));
}

fn write_index(dir: &Path, entries: &[SnapshotEntry]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("Cannot create the snapshot folder: {err}"))?;
    let body = serde_json::to_string_pretty(&sorted(entries.to_vec())).map_err(|err| format!("Cannot pack the list: {err}"))?;
    fs::write(index_path(dir), body).map_err(|err| format!("Cannot write the list: {err}"))
}

/// Свежие сверху.
fn sorted(mut entries: Vec<SnapshotEntry>) -> Vec<SnapshotEntry> {
    entries.sort_by(|a, b| b.taken_at.cmp(&a.taken_at));
    entries
}

fn id_for(taken_at: &str, server: &str) -> String {
    let stamp: String = taken_at.chars().filter(|c| c.is_ascii_digit()).collect();
    let host: String = server
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let host: String = host.trim_matches('-').chars().take(40).collect();
    format!("snapshot-{stamp}-{host}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compare::{diff, Fact, StandFacts};

    fn scratch(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("fesb-snapshots-{tag}-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(server: &str, value: &str) -> Profile {
        Profile {
            facts: StandFacts { url: server.into(), version: Some("8.6".into()), domains: 1, routes: 0, properties: 1 },
            domains: vec!["Orders".into()],
            routes: Vec::new(),
            properties: vec![Fact { scope: "application".into(), name: "url".into(), value: value.into() }],
            secured: 1,
        }
    }

    #[test]
    fn a_snapshot_comes_back_and_compares_like_a_stand() {
        let dir = scratch("roundtrip");
        let listed = save(&dir, "2026-09-25T13:05:04", "  перед релизом ", profile("http://esb/manager", "a")).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "перед релизом");
        assert_eq!(listed[0].properties, 2, "скрытые константы тоже считаются");

        let back = read(&dir, &listed[0].id).unwrap();
        let rows = diff(&back.profile, &profile("http://esb/manager", "b"));
        assert_eq!(rows.properties.len(), 1);
    }

    #[test]
    fn old_snapshots_of_one_server_are_pruned_others_stay() {
        let dir = scratch("prune");
        for n in 0..KEEP_PER_SERVER + 2 {
            save(&dir, &format!("2026-09-{:02}T10:00:00", n + 1), "", profile("http://a/manager", "x")).unwrap();
        }
        let listed = save(&dir, "2026-01-01T10:00:00", "", profile("http://b/manager", "x")).unwrap();
        assert_eq!(listed.iter().filter(|entry| entry.server == "http://a/manager").count(), KEEP_PER_SERVER);
        assert_eq!(listed.iter().filter(|entry| entry.server == "http://b/manager").count(), 1);
        assert_eq!(listed[0].taken_at, "2026-09-22T10:00:00", "свежие сверху");
    }

    #[test]
    fn a_removed_snapshot_leaves_the_list() {
        let dir = scratch("remove");
        let listed = save(&dir, "2026-09-25T13:05:04", "", profile("http://a/manager", "x")).unwrap();
        assert!(remove(&dir, &listed[0].id).unwrap().is_empty());
        assert!(list(&dir).is_empty());
    }
}
