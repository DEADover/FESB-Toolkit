//! Журнал изменений, которые инструмент сделал на стендах.
//!
//! Массовые операции через API пишут на стенд сразу: трассировка двухсот СОПС,
//! замена адреса в константах, копирование доменов. Аудит шины потом скажет,
//! что пользователь что-то сохранил, но не скажет, каким оно было до этого,
//! а у `saveRoute` нет даже проверки ревизии. Поэтому всё, что инструмент
//! меняет, сначала запоминается здесь вместе с прежним состоянием — и по нему
//! же операция отменяется целиком (см. `journal_undo`).
//!
//! Устройство на диске:
//!
//! * `index.json` — заголовки записей: когда, на каком стенде, кто, откуда;
//! * `<id>/items.jsonl` — сами изменения, по строке на каждое. Строка
//!   дописывается в конец, а не переписывает файл: операция на две тысячи СОПС
//!   иначе переписала бы его две тысячи раз;
//! * `<id>/*.zip` — копии доменов, снятые перед тем, как их перезаписать.
//!
//! Секреты в журнал не попадают: значение скрытой константы не хранится ни
//! до, ни после — шина и сама отдаёт вместо него звёздочки.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::fesb_ops::PropertyRow;
use crate::route_trace::TraceState;

/// Сколько записей держится по одному серверу. Запись — это несколько
/// килобайт, если в ней нет копий доменов; с копиями — мегабайты, и старше
/// пары сотен операций они уже никому не нужны.
const KEEP_PER_SERVER: usize = 200;

const INDEX_FILE: &str = "index.json";
const ITEMS_FILE: &str = "items.jsonl";

/// Индекс правят и операции, и отмены, иногда одновременно.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryHead {
    pub id: String,
    /// Адрес сервера — по нему записи и разделяются.
    pub server: String,
    pub user: String,
    /// Откуда операция: `routeTrace`, `constants`, `copy`, `undo`… — по нему
    /// интерфейс подписывает запись.
    pub origin: String,
    /// Местное время: `2026-10-05T13:05:04`.
    pub started_at: String,
    /// Эта запись — отмена другой.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_of: Option<String>,
    /// Отмены этой записи; их бывает несколько, если отменяли по частям.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub undone_by: Vec<String>,
}

/// Константа, как её видно в журнале: без значения, если оно скрыто.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConstantValue {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub secured: bool,
    #[serde(default)]
    pub vault: bool,
}

impl ConstantValue {
    pub fn of(row: &PropertyRow) -> Self {
        let hidden = row.secured || row.vault;
        ConstantValue {
            value: if hidden { None } else { Some(row.value.clone().unwrap_or_default()) },
            description: row.description.clone().filter(|text| !text.is_empty()),
            secured: row.secured,
            vault: row.vault,
        }
    }

    pub fn hidden(&self) -> bool {
        self.secured || self.vault
    }

    pub fn to_row(&self, key: &str) -> PropertyRow {
        PropertyRow {
            key: key.to_string(),
            value: self.value.clone(),
            secured: self.secured,
            vault: self.vault,
            empty: self.value.as_deref().unwrap_or_default().is_empty(),
            description: self.description.clone(),
        }
    }
}

/// Что именно поменялось.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Change {
    /// Трассировка СОПС.
    RouteTrace {
        domain_guid: String,
        domain: Option<String>,
        route_id: String,
        route: Option<String>,
        before: TraceState,
        after: TraceState,
    },
    /// Константа. `None` до — её создали, `None` после — удалили.
    Constant {
        /// `application`, `broker` или guid домена — тем же адресуется правка.
        scope: String,
        domain: Option<String>,
        key: String,
        before: Option<ConstantValue>,
        after: Option<ConstantValue>,
    },
    /// Домен перезаписан импортом или удалён.
    Domain {
        guid: String,
        name: String,
        /// Был ли домен на сервере до операции.
        existed: bool,
        /// Копия домена до операции — файл в папке записи.
        backup: Option<String>,
        group: Option<String>,
        mode: Option<String>,
        /// Работал ли домен: после восстановления его нужно поднять так же.
        active_before: bool,
        /// Домен удалён, а не загружен.
        #[serde(default)]
        deleted: bool,
    },
    /// Действие, а не правка: запуск, остановка, сброс счётчиков, разбор
    /// сообщений. Отменять тут нечего, но знать, что оно было, нужно.
    Action {
        /// `domain`, `route`, `module`, `savePoint`, `messages`, `queueObject`…
        target: String,
        domain: Option<String>,
        name: String,
        action: String,
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub at: String,
    #[serde(flatten)]
    pub change: Change,
    /// Что пошло не так; пусто — изменение сделано.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// У отмены: какое изменение исходной записи она откатила.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undoes: Option<usize>,
}

impl Item {
    pub fn now(change: Change) -> Self {
        Item { at: now(), change, error: None, undoes: None }
    }

    pub fn failed(change: Change, error: &str) -> Self {
        Item { at: now(), change, error: Some(error.to_string()), undoes: None }
    }

    pub fn undoing(mut self, index: Option<usize>) -> Self {
        self.undoes = index;
        self
    }

    /// Как объект называется в списке: «Домен · СОПС», «Ключ».
    pub fn title(&self) -> String {
        match &self.change {
            Change::RouteTrace { domain, route, route_id, .. } => join_title(domain.as_deref(), route.as_deref().unwrap_or(route_id)),
            Change::Constant { domain, key, .. } => join_title(domain.as_deref(), key),
            Change::Domain { name, .. } => name.clone(),
            Change::Action { domain, name, .. } => join_title(domain.as_deref(), name),
        }
    }
}

fn join_title(domain: Option<&str>, name: &str) -> String {
    match domain.filter(|text| !text.is_empty()) {
        Some(domain) => format!("{domain} · {name}"),
        None => name.to_string(),
    }
}

/// Строка списка: заголовок и сводка по изменениям, без них самих.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    #[serde(flatten)]
    pub head: EntryHead,
    /// Сделанные правки — то, что можно отменить.
    pub changes: usize,
    /// Действия: запуск, остановка и прочее, что не отменяется.
    pub actions: usize,
    pub failed: usize,
    /// Первые несколько объектов — чтобы запись узнавалась без раскрытия.
    pub targets: Vec<String>,
    /// Сколько объектов всего.
    pub total: usize,
    /// Виды изменений в записи: `routeTrace`, `constant`, `domain`, `action`.
    pub kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub head: EntryHead,
    pub items: Vec<Item>,
}

/// Куда операция пишет свои изменения: папка журнала и открытая запись.
#[derive(Debug, Clone)]
pub struct Sink {
    pub dir: PathBuf,
    pub entry: String,
}

impl Sink {
    /// Дописывает изменение. Сбой записи журнала операцию не останавливает:
    /// правка на стенде уже сделана, и сообщать об ошибке поверх неё — значит
    /// заставить человека повторить то, что прошло.
    pub fn record(&self, item: Item) {
        if let Err(err) = append(&self.dir, &self.entry, &item) {
            eprintln!("journal: {err}");
        }
    }

    pub fn backup(&self, guid: &str, bytes: &[u8]) -> Result<String, String> {
        save_backup(&self.dir, &self.entry, guid, bytes)
    }
}

pub fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join(INDEX_FILE)
}

/// Имя складывается из времени; всё прочее отбрасывается, чтобы из имени
/// нельзя было построить путь за пределы папки.
fn safe(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect()
}

fn entry_dir(dir: &Path, id: &str) -> PathBuf {
    dir.join(safe(id))
}

fn read_index(dir: &Path) -> Vec<EntryHead> {
    let Ok(text) = fs::read_to_string(index_path(dir)) else { return Vec::new() };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_index(dir: &Path, heads: &[EntryHead]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("Cannot create the journal folder: {err}"))?;
    let body = serde_json::to_string_pretty(heads).map_err(|err| format!("Cannot pack the journal: {err}"))?;
    // Сначала во временный файл, потом подменой: оборванная запись индекса
    // не должна стереть журнал целиком.
    let temp = dir.join(format!("{INDEX_FILE}.tmp"));
    fs::write(&temp, body).map_err(|err| format!("Cannot write the journal: {err}"))?;
    fs::rename(&temp, index_path(dir)).map_err(|err| format!("Cannot write the journal: {err}"))
}

fn read_items(dir: &Path, id: &str) -> Vec<Item> {
    let Ok(text) = fs::read_to_string(entry_dir(dir, id).join(ITEMS_FILE)) else { return Vec::new() };
    // Строка, оборванная на середине, пропускается: остальное — правда.
    text.lines().filter(|line| !line.trim().is_empty()).filter_map(|line| serde_json::from_str(line).ok()).collect()
}

/// Заводит запись. Изменения дописываются в неё потом, по одному.
pub fn open(dir: &Path, server: &str, user: &str, origin: &str, undo_of: Option<&str>) -> Result<String, String> {
    let _guard = LOCK.lock().map_err(|_| "The journal is unavailable".to_string())?;
    let stamp = chrono::Local::now();
    let id = format!(
        "journal-{}-{:09}",
        stamp.format("%Y%m%d%H%M%S"),
        stamp.timestamp_subsec_nanos()
    );
    fs::create_dir_all(entry_dir(dir, &id)).map_err(|err| format!("Cannot create the journal folder: {err}"))?;

    let mut heads = read_index(dir);
    heads.push(EntryHead {
        id: id.clone(),
        server: server.to_string(),
        user: user.to_string(),
        origin: origin.to_string(),
        started_at: stamp.format("%Y-%m-%dT%H:%M:%S").to_string(),
        undo_of: undo_of.map(str::to_string),
        undone_by: Vec::new(),
    });
    prune(dir, &mut heads);
    write_index(dir, &heads)?;
    Ok(id)
}

pub fn append(dir: &Path, id: &str, item: &Item) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "The journal is unavailable".to_string())?;
    let folder = entry_dir(dir, id);
    if !folder.is_dir() {
        return Err(format!("Journal entry {id} does not exist"));
    }
    let mut line = serde_json::to_string(item).map_err(|err| format!("Cannot pack the change: {err}"))?;
    line.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(folder.join(ITEMS_FILE))
        .map_err(|err| format!("Cannot write the journal: {err}"))?;
    file.write_all(line.as_bytes()).map_err(|err| format!("Cannot write the journal: {err}"))
}

/// Кладёт копию домена в папку записи и отвечает именем файла.
pub fn save_backup(dir: &Path, id: &str, guid: &str, bytes: &[u8]) -> Result<String, String> {
    let folder = entry_dir(dir, id);
    fs::create_dir_all(&folder).map_err(|err| format!("Cannot create the journal folder: {err}"))?;
    let name = format!("{}.zip", safe(guid));
    fs::write(folder.join(&name), bytes).map_err(|err| format!("Cannot save the domain copy: {err}"))?;
    Ok(name)
}

pub fn read_backup(dir: &Path, id: &str, file: &str) -> Result<Vec<u8>, String> {
    fs::read(entry_dir(dir, id).join(safe(file))).map_err(|err| format!("Cannot read the domain copy: {err}"))
}

pub fn has_backup(dir: &Path, id: &str, file: &str) -> bool {
    entry_dir(dir, id).join(safe(file)).is_file()
}

/// Записи одного сервера, свежие сверху. Пустые — операция, которая так
/// ничего и не сделала, — в список не попадают.
pub fn list(dir: &Path, server: &str) -> Vec<EntrySummary> {
    let mut rows: Vec<EntrySummary> = read_index(dir)
        .into_iter()
        .filter(|head| head.server == server)
        .filter_map(|head| {
            let items = read_items(dir, &head.id);
            (!items.is_empty()).then(|| summarize(head, &items))
        })
        .collect();
    rows.sort_by(|a, b| b.head.id.cmp(&a.head.id));
    rows
}

fn summarize(head: EntryHead, items: &[Item]) -> EntrySummary {
    let failed = items.iter().filter(|item| item.error.is_some()).count();
    let actions = items.iter().filter(|item| item.error.is_none() && matches!(item.change, Change::Action { .. })).count();
    let mut kinds: Vec<String> = items.iter().map(|item| kind_of(&item.change).to_string()).collect();
    kinds.sort();
    kinds.dedup();
    EntrySummary {
        changes: items.len() - failed - actions,
        actions,
        failed,
        targets: items.iter().take(3).map(Item::title).collect(),
        total: items.len(),
        kinds,
        head,
    }
}

pub fn kind_of(change: &Change) -> &'static str {
    match change {
        Change::RouteTrace { .. } => "routeTrace",
        Change::Constant { .. } => "constant",
        Change::Domain { .. } => "domain",
        Change::Action { .. } => "action",
    }
}

pub fn read(dir: &Path, id: &str) -> Result<Entry, String> {
    let head = read_index(dir)
        .into_iter()
        .find(|head| head.id == id)
        .ok_or_else(|| format!("Journal entry {id} does not exist"))?;
    Ok(Entry { items: read_items(dir, id), head })
}

/// Отмечает, что запись отменена (целиком или частью) записью `by`.
pub fn mark_undone(dir: &Path, id: &str, by: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "The journal is unavailable".to_string())?;
    let mut heads = read_index(dir);
    let Some(head) = heads.iter_mut().find(|head| head.id == id) else {
        return Err(format!("Journal entry {id} does not exist"));
    };
    if !head.undone_by.iter().any(|item| item == by) {
        head.undone_by.push(by.to_string());
    }
    write_index(dir, &heads)
}

/// Убирает записи сверх предела по каждому серверу вместе с их папками.
fn prune(dir: &Path, heads: &mut Vec<EntryHead>) {
    let mut servers: Vec<String> = heads.iter().map(|head| head.server.clone()).collect();
    servers.sort();
    servers.dedup();
    let mut doomed: Vec<String> = Vec::new();
    for server in servers {
        let mut mine: Vec<&EntryHead> = heads.iter().filter(|head| head.server == server).collect();
        mine.sort_by(|a, b| b.id.cmp(&a.id));
        doomed.extend(mine.into_iter().skip(KEEP_PER_SERVER).map(|head| head.id.clone()));
    }
    for id in &doomed {
        let _ = fs::remove_dir_all(entry_dir(dir, id));
    }
    heads.retain(|head| !doomed.contains(&head.id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("fesb-journal-{tag}-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn trace(domain: &str, on: bool) -> Item {
        Item::now(Change::RouteTrace {
            domain_guid: "domain-1".into(),
            domain: Some(domain.into()),
            route_id: "route-1".into(),
            route: Some("Orders.In".into()),
            before: TraceState { trace: !on, config: None },
            after: TraceState { trace: on, config: Some("TraceToQueue".into()) },
        })
    }

    #[test]
    fn changes_are_appended_and_read_back() {
        let dir = scratch("roundtrip");
        let id = open(&dir, "http://esb/manager", "root", "routeTrace", None).unwrap();
        append(&dir, &id, &trace("ERP", true)).unwrap();
        append(&dir, &id, &Item::failed(trace("WMS", true).change, "timeout")).unwrap();

        let entry = read(&dir, &id).unwrap();
        assert_eq!(entry.items.len(), 2);
        assert_eq!(entry.items[0], trace("ERP", true).clone_with_at(&entry.items[0].at));

        let listed = list(&dir, "http://esb/manager");
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].changes, listed[0].failed, listed[0].total), (1, 1, 2));
        assert_eq!(listed[0].targets[0], "ERP · Orders.In");
        assert_eq!(listed[0].kinds, vec!["routeTrace"]);
    }

    #[test]
    fn empty_entries_and_other_servers_stay_out_of_the_list() {
        let dir = scratch("filter");
        open(&dir, "http://esb/manager", "root", "constants", None).unwrap();
        let other = open(&dir, "http://other/manager", "root", "routeTrace", None).unwrap();
        append(&dir, &other, &trace("ERP", false)).unwrap();
        assert!(list(&dir, "http://esb/manager").is_empty());
        assert_eq!(list(&dir, "http://other/manager").len(), 1);
    }

    #[test]
    fn hidden_constants_keep_no_value() {
        let row = PropertyRow {
            key: "password".into(),
            value: Some("s3cret".into()),
            secured: true,
            vault: false,
            empty: false,
            description: Some(String::new()),
        };
        let value = ConstantValue::of(&row);
        assert_eq!(value.value, None);
        assert_eq!(value.description, None, "пустое описание — то же, что никакого");
        assert!(value.hidden());
    }

    #[test]
    fn a_damaged_line_does_not_hide_the_rest() {
        let dir = scratch("damaged");
        let id = open(&dir, "http://esb/manager", "root", "routeTrace", None).unwrap();
        append(&dir, &id, &trace("ERP", true)).unwrap();
        let path = entry_dir(&dir, &id).join(ITEMS_FILE);
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("{\"at\":\"2026-10-05T10:00:00\",\"type\":\"rou");
        fs::write(&path, text).unwrap();
        assert_eq!(read(&dir, &id).unwrap().items.len(), 1);
    }

    #[test]
    fn undo_marks_the_original_entry() {
        let dir = scratch("undo");
        let id = open(&dir, "http://esb/manager", "root", "routeTrace", None).unwrap();
        append(&dir, &id, &trace("ERP", true)).unwrap();
        let undo = open(&dir, "http://esb/manager", "root", "undo", Some(&id)).unwrap();
        mark_undone(&dir, &id, &undo).unwrap();
        mark_undone(&dir, &id, &undo).unwrap();
        let entry = read(&dir, &id).unwrap();
        assert_eq!(entry.head.undone_by, vec![undo.clone()]);
        assert_eq!(read(&dir, &undo).unwrap().head.undo_of.as_deref(), Some(id.as_str()));
    }

    #[test]
    fn backups_live_in_the_entry_folder() {
        let dir = scratch("backup");
        let id = open(&dir, "http://esb/manager", "root", "copy", None).unwrap();
        let file = save_backup(&dir, &id, "domain-../../x", b"zip").unwrap();
        assert!(!file.contains('/'));
        assert!(has_backup(&dir, &id, &file));
        assert_eq!(read_backup(&dir, &id, &file).unwrap(), b"zip");
    }

    #[test]
    fn old_entries_of_one_server_are_pruned_with_their_files() {
        let dir = scratch("prune");
        let first = open(&dir, "http://a/manager", "root", "routeTrace", None).unwrap();
        append(&dir, &first, &trace("ERP", true)).unwrap();
        for _ in 0..KEEP_PER_SERVER {
            open(&dir, "http://a/manager", "root", "routeTrace", None).unwrap();
        }
        assert!(!entry_dir(&dir, &first).exists());
        assert_eq!(read_index(&dir).len(), KEEP_PER_SERVER);
    }

    impl Item {
        fn clone_with_at(&self, at: &str) -> Item {
            Item { at: at.to_string(), ..self.clone() }
        }
    }
}
