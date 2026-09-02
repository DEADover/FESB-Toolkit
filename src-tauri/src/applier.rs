//! Применение новых значений `broker` / `queue` к набору файлов `domain.xml`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain_xml::{replace_trace_values, AppliedChange, BeanTarget, SkippedChange, TraceUpdate};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyTarget {
    pub domain_xml_path: String,
    #[serde(default)]
    pub domain_name: Option<String>,
    pub beans: Vec<BeanTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    /// Пустое поле означает «не трогать».
    pub update: TraceUpdate,
    pub targets: Vec<ApplyTarget>,
    #[serde(default = "default_true")]
    pub make_backup: bool,
    #[serde(default)]
    pub dry_run: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub domain_xml_path: String,
    pub domain_name: Option<String>,
    /// `ok` — файл изменён, `skipped` — менять было нечего, `error` — сбой.
    pub status: &'static str,
    pub changed: Vec<AppliedChange>,
    pub skipped: Vec<SkippedChange>,
    pub backup_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySummary {
    pub broker: Option<String>,
    pub queue: Option<String>,
    pub trace_mode: Option<String>,
    pub dry_run: bool,
    pub total: usize,
    pub ok: usize,
    pub skipped: usize,
    pub failed: usize,
    pub beans_changed: usize,
    pub values_changed: usize,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub summary: ApplySummary,
    pub results: Vec<FileResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProgress {
    pub current: usize,
    pub total: usize,
    pub domain_name: Option<String>,
}

/// Кладёт рядом с файлом резервную копию.
///
/// Первый раз это `domain.xml.bak`; если такой уже есть — `domain.xml.<дата-время>.bak`,
/// чтобы предыдущая копия никогда не затиралась.
pub fn create_backup(file: &Path) -> std::io::Result<PathBuf> {
    let simple = with_suffix(file, ".bak");
    let backup = if simple.exists() {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let mut candidate = with_suffix(file, &format!(".{stamp}.bak"));
        let mut n = 2;
        while candidate.exists() && n < 100 {
            candidate = with_suffix(file, &format!(".{stamp}-{n}.bak"));
            n += 1;
        }
        candidate
    } else {
        simple
    };

    fs::copy(file, &backup)?;
    Ok(backup)
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Запись «через временный файл + переименование», чтобы не оставить обрезанный `domain.xml`.
pub fn write_atomic(file: &Path, text: &str) -> std::io::Result<()> {
    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    let base = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "domain.xml".into());
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{base}.tmp-{}-{unique}", std::process::id()));

    // Не дописали — не оставляем: обрывок иначе уезжал в архив и на сервер,
    // потому что сборщики отсеивают только `.bak`.
    if let Err(err) = fs::write(&tmp, text) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Ok(meta) = fs::metadata(file) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    match fs::rename(&tmp, file) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

/// Убирает лишние пробелы и превращает пустую строку в «не менять».
fn normalize(value: &Option<String>) -> Option<String> {
    value.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub fn apply_trace_change<F: FnMut(ApplyProgress)>(
    request: &ApplyRequest,
    mut on_progress: F,
) -> Result<ApplyReport, String> {
    let update = TraceUpdate {
        broker: normalize(&request.update.broker),
        queue: normalize(&request.update.queue),
        trace_mode: normalize(&request.update.trace_mode),
    };
    if update.is_empty() {
        return Err("No new value was provided".into());
    }
    if request.targets.is_empty() {
        return Err("No domains were selected".into());
    }

    let total = request.targets.len();
    let mut results = Vec::with_capacity(total);

    for (index, target) in request.targets.iter().enumerate() {
        let path = PathBuf::from(&target.domain_xml_path);
        let mut result = FileResult {
            domain_xml_path: target.domain_xml_path.clone(),
            domain_name: target.domain_name.clone(),
            status: "ok",
            changed: Vec::new(),
            skipped: Vec::new(),
            backup_path: None,
            error: None,
        };

        match fs::read_to_string(&path) {
            Err(err) => {
                result.status = "error";
                result.error = Some(format!("cannot read file: {err}"));
            }
            Ok(original) => {
                let outcome = replace_trace_values(&original, &target.beans, &update);
                result.skipped = outcome.missed;
                result.changed = outcome.changes;

                if result.changed.is_empty() {
                    // Менять было нечего. Это ошибка только если ни одно поле
                    // не нашлось вовсе — «значение уже нужное» ошибкой не считаем.
                    let nothing_found = result.skipped.iter().all(|s| s.reason != "already-set");
                    result.status = if nothing_found { "error" } else { "skipped" };
                    if nothing_found {
                        result.error = Some("None of the requested properties were found".into());
                    }
                } else if !request.dry_run {
                    if request.make_backup {
                        match create_backup(&path) {
                            Ok(backup) => result.backup_path = Some(backup.to_string_lossy().to_string()),
                            Err(err) => {
                                result.status = "error";
                                result.error = Some(format!("cannot create .bak: {err}"));
                                result.changed.clear();
                            }
                        }
                    }
                    if result.status == "ok" {
                        if let Err(err) = write_atomic(&path, &outcome.text) {
                            result.status = "error";
                            result.error = Some(format!("cannot write file: {err}"));
                            result.changed.clear();
                        }
                    }
                }
            }
        }

        on_progress(ApplyProgress {
            current: index + 1,
            total,
            domain_name: result.domain_name.clone(),
        });
        results.push(result);
    }

    let summary = ApplySummary {
        broker: update.broker,
        queue: update.queue,
        trace_mode: update.trace_mode,
        dry_run: request.dry_run,
        total: results.len(),
        ok: results.iter().filter(|r| r.status == "ok").count(),
        skipped: results.iter().filter(|r| r.status == "skipped").count(),
        failed: results.iter().filter(|r| r.status == "error").count(),
        beans_changed: results.iter().map(|r| r.changed.len()).sum(),
        values_changed: results.iter().map(|r| r.changed.iter().map(|c| c.fields.len()).sum::<usize>()).sum(),
        finished_at: chrono::Local::now().to_rfc3339(),
    };

    Ok(ApplyReport { summary, results })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain_xml::BeanTarget;

    const XML: &str = r#"<beans>
    <bean factor:type="TRACE" id="TraceToQueue">
        <property name="broker" value="QME:EQM"/>
        <property name="queue" value="Mon.Trace"/>
        <property name="traceMode" value="ASYNC"/>
    </bean>
</beans>
"#;

    /// Изолированная временная папка, которая убирается за собой.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("fesb-test-{tag}-{unique}"));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request(path: &Path, update: TraceUpdate, expected_broker: Option<&str>, dry_run: bool, backup: bool) -> ApplyRequest {
        ApplyRequest {
            update,
            make_backup: backup,
            dry_run,
            targets: vec![ApplyTarget {
                domain_xml_path: path.to_string_lossy().to_string(),
                domain_name: Some("ERP.Test".into()),
                beans: vec![BeanTarget {
                    bean_id: Some("TraceToQueue".into()),
                    bean_name: None,
                    expected_broker: expected_broker.map(str::to_string),
                    expected_queue: None,
                    expected_trace_mode: None,
                }],
            }],
        }
    }

    fn broker(value: &str) -> TraceUpdate {
        TraceUpdate { broker: Some(value.into()), queue: None, trace_mode: None }
    }

    #[test]
    fn writes_file_and_keeps_backup() {
        let dir = TempDir::new("apply");
        let file = dir.0.join("domain.xml");
        fs::write(&file, XML).unwrap();

        let report = apply_trace_change(&request(&file, broker("QMS:QM.NEW"), Some("QME:EQM"), false, true), |_| {}).unwrap();
        assert_eq!(report.summary.ok, 1);
        assert_eq!(report.summary.beans_changed, 1);
        assert_eq!(report.summary.values_changed, 1);

        let updated = fs::read_to_string(&file).unwrap();
        assert!(updated.contains(r#"<property name="broker" value="QMS:QM.NEW"/>"#));
        assert!(updated.contains(r#"<property name="queue" value="Mon.Trace"/>"#));

        let backup_path = report.results[0].backup_path.clone().unwrap();
        assert!(backup_path.ends_with("domain.xml.bak"));
        assert_eq!(fs::read_to_string(&backup_path).unwrap(), XML);

        // Повторный прогон не должен затирать первую копию.
        let second = apply_trace_change(&request(&file, broker("QME:EQM"), None, false, true), |_| {}).unwrap();
        let second_backup = second.results[0].backup_path.clone().unwrap();
        assert!(!second_backup.ends_with("domain.xml.bak"), "первая копия перезаписана: {second_backup}");
        assert_eq!(fs::read_to_string(&backup_path).unwrap(), XML);
    }

    #[test]
    fn changes_broker_and_queue_in_one_pass() {
        let dir = TempDir::new("both");
        let file = dir.0.join("domain.xml");
        fs::write(&file, XML).unwrap();

        let update = TraceUpdate {
            broker: Some("QMS:QM".into()),
            queue: Some("Mon.Trace.V2".into()),
            trace_mode: Some("SYNC".into()),
        };
        let report = apply_trace_change(&request(&file, update, None, false, true), |_| {}).unwrap();
        assert_eq!(report.summary.values_changed, 3);

        let updated = fs::read_to_string(&file).unwrap();
        assert!(updated.contains(r#"<property name="broker" value="QMS:QM"/>"#));
        assert!(updated.contains(r#"<property name="queue" value="Mon.Trace.V2"/>"#));
        assert!(updated.contains(r#"<property name="traceMode" value="SYNC"/>"#));
    }

    #[test]
    fn dry_run_leaves_file_untouched() {
        let dir = TempDir::new("dry");
        let file = dir.0.join("domain.xml");
        fs::write(&file, XML).unwrap();

        let report = apply_trace_change(&request(&file, broker("QMS:QM.NEW"), None, true, true), |_| {}).unwrap();
        assert_eq!(report.summary.beans_changed, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), XML);
        assert!(report.results[0].backup_path.is_none());
        assert!(!dir.0.join("domain.xml.bak").exists());
    }

    #[test]
    fn reports_already_set_value_as_skipped() {
        let dir = TempDir::new("same");
        let file = dir.0.join("domain.xml");
        fs::write(&file, XML).unwrap();

        let report = apply_trace_change(&request(&file, broker("QME:EQM"), None, false, true), |_| {}).unwrap();
        assert_eq!(report.summary.skipped, 1);
        assert_eq!(report.results[0].skipped[0].reason, "already-set");
        assert_eq!(fs::read_to_string(&file).unwrap(), XML);
    }

    #[test]
    fn rejects_empty_update() {
        let dir = TempDir::new("empty");
        let file = dir.0.join("domain.xml");
        fs::write(&file, XML).unwrap();
        let empty = TraceUpdate { broker: Some("  ".into()), queue: None, trace_mode: None };
        assert!(apply_trace_change(&request(&file, empty, None, false, true), |_| {}).is_err());
    }
}
