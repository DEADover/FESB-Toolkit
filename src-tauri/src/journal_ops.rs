//! Правки стенда, которые оставляют след в журнале, и отмена по нему.
//!
//! Каждая обёртка здесь делает то же, что и обычная операция, но сначала
//! запоминает, как было: константу читает перед сохранением, домен выгружает
//! перед перезаписью. Отмена потом идёт обратным ходом — и перед каждым шагом
//! сверяется с сервером: если после инструмента объект успел поменять кто-то
//! ещё, его правка не затирается молча, а показывается как расхождение.
//!
//! Сама отмена — такая же операция с записью в журнале: её тоже видно и её
//! тоже можно отменить.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::change_journal::{self, Change, ConstantValue, EntryHead, Item, Sink};
use crate::domain_copy::{self, Packed};
use crate::fesb_api::{self, coded, ApiProgress, Connection, ManifestDomain, PushResult};
use crate::fesb_ops::{self, PropertyRow, PropertyScope};
use crate::route_trace::{self, RouteTraceChange, RouteTraceResult, TraceState};

/// Куда и под каким именем записать изменение.
///
/// Имена приходят из интерфейса: guid домена в журнале читать невозможно,
/// а спрашивать имя у сервера ради каждой строки — лишний ход.
#[derive(Debug, Clone, Default)]
pub struct Note<'a> {
    pub sink: Option<&'a Sink>,
    pub domain: Option<String>,
    pub name: Option<String>,
    /// У отмены — номер изменения в исходной записи.
    pub undoes: Option<usize>,
}

impl Note<'_> {
    fn record(&self, item: Item) {
        if let Some(sink) = self.sink {
            sink.record(item.undoing(self.undoes));
        }
    }

    /// Записывает действие — то, что не отменяется.
    pub fn action<T>(&self, target: &str, action: &str, detail: Option<String>, result: &Result<T, String>) {
        let change = Change::Action {
            target: target.to_string(),
            domain: self.domain.clone(),
            name: self.name.clone().unwrap_or_default(),
            action: action.to_string(),
            detail,
        };
        self.record(match result {
            Ok(_) => Item::now(change),
            Err(err) => Item::failed(change, err),
        });
    }
}

/// Заводит запись журнала под операцию на стенде `connection`.
pub fn open_entry(dir: &Path, connection: &Connection, origin: &str) -> Result<Sink, String> {
    let entry = change_journal::open(dir, &connection.base(), &connection.username, origin, None)?;
    Ok(Sink { dir: dir.to_path_buf(), entry })
}

// ───────────────────────────── правки с записью ─────────────────────────────

/// Трассировка СОПС. В журнал попадает только то, что действительно
/// поменялось: «уже было так» отменять нечего.
pub async fn set_route_trace(
    connection: &Connection,
    domain: &str,
    route: &str,
    change: &RouteTraceChange,
    comment: Option<&str>,
    note: &Note<'_>,
) -> Result<RouteTraceResult, String> {
    let result = route_trace::set_route_trace(connection, domain, route, change, comment).await;
    match &result {
        Ok(done) if done.status == "changed" => note.record(Item::now(Change::RouteTrace {
            domain_guid: domain.to_string(),
            domain: note.domain.clone(),
            route_id: route.to_string(),
            route: note.name.clone(),
            before: done.before.clone(),
            after: done.after.clone(),
        })),
        Ok(_) => {}
        Err(_) => {
            let note = Note { name: note.name.clone().or_else(|| Some(route.to_string())), ..note.clone() };
            note.action("route", "trace", Some(route_trace::comment_for(change)), &result);
        }
    }
    result
}

/// Сохраняет константу, запомнив, какой она была.
///
/// Прежнее значение читается с сервера, а не берётся из таблицы на экране:
/// таблица могла устареть, а отмена должна вернуть то, что было на самом деле.
pub async fn save_constant(
    connection: &Connection,
    scope: PropertyScope,
    property: PropertyRow,
    create: bool,
    comment: Option<String>,
    note: &Note<'_>,
) -> Result<(), String> {
    let before = match note.sink {
        Some(_) => fesb_ops::property(connection, &scope, &property.key).await?,
        None => None,
    };
    let key = property.key.clone();
    let after = ConstantValue::of(&property);
    let result = fesb_ops::save_property(connection, scope.clone(), property, create, comment).await;
    let change = Change::Constant {
        scope: scope.as_key(),
        domain: note.domain.clone(),
        key,
        before: before.as_ref().map(ConstantValue::of),
        after: Some(after),
    };
    note.record(match &result {
        Ok(()) => Item::now(change),
        Err(err) => Item::failed(change, err),
    });
    result
}

pub async fn delete_constant(
    connection: &Connection,
    scope: PropertyScope,
    key: &str,
    note: &Note<'_>,
) -> Result<(), String> {
    let before = match note.sink {
        Some(_) => fesb_ops::property(connection, &scope, key).await?,
        None => None,
    };
    let result = fesb_ops::delete_property(connection, scope.clone(), key).await;
    let change = Change::Constant {
        scope: scope.as_key(),
        domain: note.domain.clone(),
        key: key.to_string(),
        before: before.as_ref().map(ConstantValue::of),
        after: None,
    };
    note.record(match &result {
        Ok(()) => Item::now(change),
        Err(err) => Item::failed(change, err),
    });
    result
}

/// Выгружает текущие копии доменов, которые есть на сервере.
async fn current_copies(connection: &Connection, guids: &[String]) -> Result<HashMap<String, Packed>, String> {
    let mut copies = HashMap::new();
    for batch in guids.chunks(10) {
        for item in domain_copy::export(connection, batch).await? {
            copies.insert(item.domain.guid.clone(), item);
        }
    }
    Ok(copies)
}

/// Загрузка отредактированных доменов обратно в шину.
///
/// Перед ней снимаются копии тех же доменов с сервера: без них отменить
/// загрузку нечем, поэтому, если копию снять не удалось, загрузка не идёт.
pub async fn push<F: FnMut(ApiProgress)>(
    connection: &Connection,
    root: &Path,
    guids: &[String],
    reload: bool,
    sink: Option<&Sink>,
    on_progress: F,
) -> Result<PushResult, String> {
    let Some(sink) = sink else {
        return fesb_api::push(connection, root, guids, reload, on_progress).await;
    };

    let present = fesb_api::domains(connection).await?;
    let on_server: HashMap<&str, bool> = present.iter().map(|item| (item.guid.as_str(), item.active)).collect();
    let existing: Vec<String> = guids.iter().filter(|guid| on_server.contains_key(guid.as_str())).cloned().collect();
    let copies = current_copies(connection, &existing).await?;
    let names: HashMap<String, String> = fesb_api::read_manifest(root)
        .map(|manifest| manifest.domains.into_iter().map(|item| (item.guid, item.name)).collect())
        .unwrap_or_default();

    let mut changes = Vec::with_capacity(guids.len());
    for guid in guids {
        let copy = copies.get(guid);
        let backup = match copy {
            Some(copy) => Some(sink.backup(guid, &copy.archive)?),
            None => None,
        };
        changes.push(Change::Domain {
            guid: guid.clone(),
            name: names.get(guid).cloned().or_else(|| copy.map(|item| item.domain.name.clone())).unwrap_or_else(|| guid.clone()),
            existed: copy.is_some(),
            backup,
            group: copy.and_then(|item| item.domain.group.clone()),
            mode: copy.and_then(|item| item.domain.mode.clone()),
            active_before: on_server.get(guid.as_str()).copied().unwrap_or(false),
            deleted: false,
        });
    }

    let result = fesb_api::push(connection, root, guids, reload, on_progress).await;
    for change in changes {
        sink.record(match &result {
            Ok(_) => Item::now(change),
            Err(err) => Item::failed(change, err),
        });
    }
    result
}

// ───────────────────────────── отмена ─────────────────────────────

/// Строка предпросмотра отмены.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRow {
    pub index: usize,
    pub item: Item,
    /// `ready` — можно вернуть; `done` — уже как было; `conflict` — после
    /// инструмента объект менял кто-то ещё; `impossible` — вернуть нечем.
    pub state: &'static str,
    /// Почему нельзя: `failed`, `action`, `secured`, `noBackup`, `unreadable`.
    pub reason: Option<&'static str>,
    /// Что на сервере сейчас — у расхождений.
    pub current: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoPlan {
    pub entry: EntryHead,
    pub rows: Vec<UndoRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub index: usize,
    pub title: String,
    /// `undone`, `skipped` или `failed`.
    pub status: &'static str,
    /// У пропущенных — состояние, из-за которого пропущено.
    pub reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    /// Запись самой отмены.
    pub entry: String,
    pub outcomes: Vec<UndoOutcome>,
}

/// Что на сервере сейчас — столько, сколько нужно для решения.
struct Live {
    domains: HashMap<String, bool>,
    /// Изменения исходной записи, уже отменённые раньше.
    undone: BTreeSet<usize>,
}

fn same_constant(a: &Option<ConstantValue>, b: &Option<ConstantValue>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.value == b.value && a.description == b.description,
        _ => false,
    }
}

fn row(index: usize, item: &Item, state: &'static str, reason: Option<&'static str>, current: Option<Value>) -> UndoRow {
    UndoRow { index, item: item.clone(), state, reason, current }
}

/// Состояние объекта, с которым сверяется отмена.
#[derive(Debug, Clone, PartialEq)]
enum Current {
    Trace(TraceState),
    Constant(Option<ConstantValue>),
}

impl Current {
    fn to_value(&self) -> Option<Value> {
        match self {
            Current::Trace(state) => serde_json::to_value(state).ok(),
            Current::Constant(value) => serde_json::to_value(value).ok(),
        }
    }
}

/// Объект, к которому относится правка: по нему правки одной операции над
/// одним и тем же объектом связываются между собой.
fn object_of(item: &Item) -> Option<String> {
    match &item.change {
        Change::RouteTrace { domain_guid, route_id, .. } => Some(format!("route:{domain_guid}:{route_id}")),
        Change::Constant { scope, key, .. } => Some(format!("constant:{scope}:{key}")),
        _ => None,
    }
}

/// Каким объект станет, когда эту правку вернут.
fn state_before(item: &Item) -> Option<Current> {
    match &item.change {
        Change::RouteTrace { before, .. } => Some(Current::Trace(before.clone())),
        Change::Constant { before, .. } => Some(Current::Constant(before.clone())),
        _ => None,
    }
}

async fn fetch(connection: &Connection, item: &Item) -> Result<Current, String> {
    match &item.change {
        Change::RouteTrace { domain_guid, route_id, .. } => {
            route_trace::current_state(connection, domain_guid, route_id).await.map(Current::Trace)
        }
        Change::Constant { scope, key, .. } => fesb_ops::property(connection, &PropertyScope::from_key(scope), key)
            .await
            .map(|found| Current::Constant(found.as_ref().map(ConstantValue::of))),
        _ => Err("Nothing to read".into()),
    }
}

/// Сравнивает правку с тем, что на объекте сейчас.
fn judge(index: usize, item: &Item, now: &Current) -> UndoRow {
    let (is_after, is_before) = match (&item.change, now) {
        (Change::RouteTrace { before, after, .. }, Current::Trace(state)) => (state == after, state == before),
        (Change::Constant { before, after, .. }, Current::Constant(value)) => {
            (same_constant(value, after), same_constant(value, before))
        }
        _ => (false, false),
    };
    if is_after {
        row(index, item, "ready", None, None)
    } else if is_before {
        row(index, item, "done", None, None)
    } else {
        row(index, item, "conflict", None, now.to_value())
    }
}

/// Решение по одной правке. `assumed` — каким объект станет после отмены
/// более поздних правок той же операции: создали константу, а потом поменяли —
/// после возврата второй правки первая снова совпадает с сервером.
async fn assess(
    connection: &Connection,
    dir: &Path,
    entry: &str,
    index: usize,
    item: &Item,
    live: &Live,
    assumed: Option<&Current>,
) -> UndoRow {
    if item.error.is_some() {
        return row(index, item, "impossible", Some("failed"), None);
    }
    match &item.change {
        Change::Action { .. } => row(index, item, "impossible", Some("action"), None),
        Change::RouteTrace { .. } | Change::Constant { .. } => {
            if let Change::Constant { before, after, .. } = &item.change {
                if before.as_ref().is_some_and(ConstantValue::hidden) || after.as_ref().is_some_and(ConstantValue::hidden) {
                    return row(index, item, "impossible", Some("secured"), None);
                }
            }
            if let Some(now) = assumed {
                return judge(index, item, now);
            }
            match fetch(connection, item).await {
                Ok(now) => judge(index, item, &now),
                Err(err) => row(index, item, "impossible", Some("unreadable"), Some(Value::String(err))),
            }
        }
        Change::Domain { guid, existed, backup, .. } => {
            if live.undone.contains(&index) {
                return row(index, item, "done", None, None);
            }
            if !existed {
                // Домена не было: отмена — удалить его, если он ещё есть.
                return if live.domains.contains_key(guid) {
                    row(index, item, "ready", None, None)
                } else {
                    row(index, item, "done", None, None)
                };
            }
            match backup {
                Some(file) if change_journal::has_backup(dir, entry, file) => row(index, item, "ready", None, None),
                _ => row(index, item, "impossible", Some("noBackup"), None),
            }
        }
    }
}

async fn live_state(connection: &Connection, dir: &Path, head: &EntryHead, items: &[Item]) -> Result<Live, String> {
    let domains = if items.iter().any(|item| matches!(item.change, Change::Domain { .. })) {
        fesb_api::domains(connection).await?.into_iter().map(|item| (item.guid, item.active)).collect()
    } else {
        HashMap::new()
    };
    let mut undone = BTreeSet::new();
    for id in &head.undone_by {
        if let Ok(undo) = change_journal::read(dir, id) {
            undone.extend(undo.items.iter().filter(|item| item.error.is_none()).filter_map(|item| item.undoes));
        }
    }
    Ok(Live { domains, undone })
}

fn ensure_same_server(connection: &Connection, head: &EntryHead) -> Result<(), String> {
    if connection.base() != head.server {
        return Err(coded("journal.otherServer", head.server.clone()));
    }
    Ok(())
}

/// Предпросмотр: что из записи можно вернуть и что на сервере сейчас.
pub async fn plan(connection: &Connection, dir: &Path, id: &str) -> Result<UndoPlan, String> {
    let entry = change_journal::read(dir, id)?;
    ensure_same_server(connection, &entry.head)?;
    let live = live_state(connection, dir, &entry.head, &entry.items).await?;
    // С конца: так отмена и пойдёт, и более поздняя правка объекта решает,
    // с чем сверять более раннюю.
    let mut assumed: HashMap<String, Current> = HashMap::new();
    let mut rows = Vec::with_capacity(entry.items.len());
    for (index, item) in entry.items.iter().enumerate().rev() {
        let object = object_of(item);
        let row = assess(connection, dir, id, index, item, &live, object.as_ref().and_then(|key| assumed.get(key))).await;
        if row.state == "ready" {
            if let (Some(key), Some(state)) = (object, state_before(item)) {
                assumed.insert(key, state);
            }
        }
        rows.push(row);
    }
    rows.reverse();
    Ok(UndoPlan { entry: entry.head, rows })
}

fn undo_comment(head: &EntryHead) -> String {
    let when = chrono::NaiveDateTime::parse_from_str(&head.started_at, "%Y-%m-%dT%H:%M:%S")
        .map(|stamp| stamp.format("%d.%m.%Y %H:%M").to_string())
        .unwrap_or_else(|_| head.started_at.clone());
    format!("FESB Toolkit: отмена правки от {when}")
}

/// Возвращает выбранные изменения — с последнего к первому, как отматывают
/// историю. Каждое перед шагом проверяется заново: между предпросмотром
/// и подтверждением на сервере могло что-то поменяться.
pub async fn run<F: FnMut(ApiProgress)>(
    connection: &Connection,
    dir: &Path,
    id: &str,
    indexes: &[usize],
    mut on_progress: F,
) -> Result<UndoResult, String> {
    let entry = change_journal::read(dir, id)?;
    ensure_same_server(connection, &entry.head)?;
    let live = live_state(connection, dir, &entry.head, &entry.items).await?;
    let comment = undo_comment(&entry.head);

    let undo_id = change_journal::open(dir, &entry.head.server, &connection.username, "undo", Some(id))?;
    let sink = Sink { dir: dir.to_path_buf(), entry: undo_id.clone() };

    let wanted: BTreeSet<usize> = indexes.iter().copied().collect();
    let total = wanted.len() as u64;
    let mut outcomes = Vec::with_capacity(wanted.len());

    for (step, index) in wanted.iter().rev().copied().enumerate() {
        on_progress(ApiProgress { phase: "undo", current: step as u64, total });
        let Some(item) = entry.items.get(index) else { continue };
        let title = item.title();
        let checked = assess(connection, dir, id, index, item, &live, None).await;
        if checked.state != "ready" {
            outcomes.push(UndoOutcome {
                index,
                title,
                status: "skipped",
                reason: Some(checked.reason.unwrap_or(checked.state).to_string()),
                error: None,
            });
            continue;
        }
        let result = revert(connection, dir, id, index, item, &live, &comment, &sink).await;
        outcomes.push(UndoOutcome {
            index,
            title,
            status: if result.is_ok() { "undone" } else { "failed" },
            reason: None,
            error: result.err(),
        });
    }
    on_progress(ApiProgress { phase: "undo", current: total, total });
    outcomes.reverse();

    if outcomes.iter().any(|outcome| outcome.status == "undone") {
        change_journal::mark_undone(dir, id, &undo_id)?;
    }
    Ok(UndoResult { entry: undo_id, outcomes })
}

#[allow(clippy::too_many_arguments)]
async fn revert(
    connection: &Connection,
    dir: &Path,
    id: &str,
    index: usize,
    item: &Item,
    live: &Live,
    comment: &str,
    sink: &Sink,
) -> Result<(), String> {
    match &item.change {
        Change::RouteTrace { domain_guid, domain, route_id, route, before, .. } => {
            let note = Note { sink: Some(sink), domain: domain.clone(), name: route.clone(), undoes: Some(index) };
            let change = back_to(before);
            set_route_trace(connection, domain_guid, route_id, &change, Some(comment), &note).await.map(|_| ())
        }
        Change::Constant { scope, domain, key, before, after } => {
            let note = Note { sink: Some(sink), domain: domain.clone(), name: Some(key.clone()), undoes: Some(index) };
            let scope = PropertyScope::from_key(scope);
            match (before, after) {
                (None, _) => delete_constant(connection, scope, key, &note).await,
                (Some(old), None) => save_constant(connection, scope, old.to_row(key), true, Some(comment.to_string()), &note).await,
                (Some(old), Some(_)) => save_constant(connection, scope, old.to_row(key), false, Some(comment.to_string()), &note).await,
            }
        }
        Change::Domain { guid, name, existed, backup, group, mode, active_before, .. } => {
            // Сначала — копия того, что на сервере сейчас: отмена тоже должна
            // отменяться, а без копии вернуть стёртое будет нечем.
            let present = live.domains.get(guid).copied();
            let current = match present {
                Some(_) => current_copies(connection, std::slice::from_ref(guid)).await?.remove(guid),
                None => None,
            };
            let current_backup = match &current {
                Some(copy) => Some(sink.backup(guid, &copy.archive)?),
                None => None,
            };
            let change = Change::Domain {
                guid: guid.clone(),
                name: name.clone(),
                existed: current.is_some(),
                backup: current_backup,
                group: current.as_ref().and_then(|copy| copy.domain.group.clone()),
                mode: current.as_ref().and_then(|copy| copy.domain.mode.clone()),
                active_before: present.unwrap_or(false),
                deleted: !existed,
            };

            let result = if *existed {
                let file = backup.as_deref().ok_or("The domain copy is missing")?;
                let archive = change_journal::read_backup(dir, id, file)?;
                let packed = Packed {
                    domain: ManifestDomain { guid: guid.clone(), name: name.clone(), group: group.clone(), mode: mode.clone() },
                    archive,
                };
                let client = connection.client()?;
                // Точная копия прежнего: СОПС, добавленные загрузкой, убираются.
                domain_copy::upload(connection, &client, std::slice::from_ref(&packed), *active_before, true).await.map(|_| ())
            } else {
                fesb_ops::delete_domain(connection, guid).await
            };
            sink.record(
                match &result {
                    Ok(()) => Item::now(change),
                    Err(err) => Item::failed(change, err),
                }
                .undoing(Some(index)),
            );
            result
        }
        Change::Action { .. } => Err("Actions cannot be undone".into()),
    }
}

/// Правка, которая возвращает трассировку к прежнему состоянию.
fn back_to(before: &TraceState) -> RouteTraceChange {
    RouteTraceChange { enabled: Some(before.trace), config: Some(before.config.clone().unwrap_or_default()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn going_back_restores_the_domain_default() {
        let change = back_to(&TraceState { trace: false, config: None });
        assert_eq!(change.enabled, Some(false));
        assert_eq!(change.config.as_deref(), Some(""), "пустая строка — объект по умолчанию домена");
        let state = route_trace::apply(&TraceState { trace: true, config: Some("MC.TRACE".into()) }, &change);
        assert_eq!(state, TraceState { trace: false, config: None });
    }

    #[test]
    fn constants_compare_by_value_and_description() {
        let value = |text: &str| Some(ConstantValue { value: Some(text.into()), description: None, secured: false, vault: false });
        assert!(same_constant(&value("a"), &value("a")));
        assert!(!same_constant(&value("a"), &value("b")));
        assert!(!same_constant(&value("a"), &None));
        assert!(same_constant(&None, &None));
    }

    #[test]
    fn the_comment_names_the_original_date() {
        let head = EntryHead {
            id: "journal-1".into(),
            server: "http://esb/manager".into(),
            user: "root".into(),
            origin: "routeTrace".into(),
            started_at: "2026-10-05T13:05:04".into(),
            undo_of: None,
            undone_by: Vec::new(),
        };
        assert_eq!(undo_comment(&head), "FESB Toolkit: отмена правки от 05.10.2026 13:05");
    }
}
