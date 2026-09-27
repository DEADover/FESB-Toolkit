//! Копия настроек интерфейса на диске.
//!
//! Интерфейс держит настройки — прежде всего профили подключений — в
//! хранилище WebView. Оно живёт отдельно от приложения, и после обновления
//! или сбоя WebView его содержимое может пропасть. Поэтому каждая
//! сохранённая настройка дублируется сюда, в `settings.json` в папке данных
//! приложения, а при запуске пропавшее возвращается из этой копии.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

const FILE: &str = "settings.json";

/// Запись идёт из нескольких команд сразу — файл переписывается по очереди.
static WRITE: Mutex<()> = Mutex::new(());

/// Все сохранённые настройки. Нет файла или он испорчен — пусто, не ошибка.
pub fn read(dir: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Сохраняет одну настройку; `None` — удаляет её.
///
/// Файл пишется рядом и потом переименовывается: оборванная запись не
/// оставит вместо настроек половину файла.
pub fn write(dir: &Path, key: &str, value: Option<&str>) -> Result<(), String> {
    let _guard = WRITE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    fs::create_dir_all(dir).map_err(|err| format!("Cannot create {}: {err}", dir.display()))?;
    let mut all = read(dir);
    match value {
        Some(value) => all.insert(key.to_string(), value.to_string()),
        None => all.remove(key),
    };
    let text = serde_json::to_string_pretty(&all).map_err(|err| err.to_string())?;
    let temp = dir.join(format!("{FILE}.tmp"));
    fs::write(&temp, text).map_err(|err| format!("Cannot write {}: {err}", temp.display()))?;
    restrict(&temp);
    fs::rename(&temp, dir.join(FILE)).map_err(|err| format!("Cannot save {FILE}: {err}"))
}

/// В профилях бывают пароли — файл читает только владелец.
#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_and_forgets_values() {
        let dir = std::env::temp_dir().join(format!("fesb-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(read(&dir).is_empty());

        write(&dir, "fesb.connections", Some(r#"{"profiles":[]}"#)).unwrap();
        write(&dir, "fesb.theme", Some("dark")).unwrap();
        write(&dir, "fesb.theme", Some("light")).unwrap();
        let all = read(&dir);
        assert_eq!(all.get("fesb.connections").map(String::as_str), Some(r#"{"profiles":[]}"#));
        assert_eq!(all.get("fesb.theme").map(String::as_str), Some("light"));

        write(&dir, "fesb.theme", None).unwrap();
        assert!(!read(&dir).contains_key("fesb.theme"));

        fs::write(dir.join(FILE), "{ broken").unwrap();
        assert!(read(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
