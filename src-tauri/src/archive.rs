//! Сборка zip-архива конфигурации для обратной загрузки в шину.
//!
//! Структура повторяет оригинальную выгрузку: в корне архива папка `domains`
//! и файл `version`, никакой обёртывающей папки. Служебные файлы —
//! резервные копии `.bak`, которые создаёт само приложение, и `.DS_Store` —
//! в архив не попадают: в шине им делать нечего.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const DOMAINS_DIR: &str = "domains";
const VERSION_FILE: &str = "version";
const JUNK_FILES: [&str; 2] = [".DS_Store", "Thumbs.db"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveResult {
    pub path: String,
    /// Сколько папок доменов вошло в архив.
    pub domains: usize,
    pub files: usize,
    pub bytes: u64,
    /// Сколько файлов `.bak` намеренно не попало в архив.
    pub skipped_backups: usize,
    pub has_version: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProgress {
    pub current: usize,
    pub total: usize,
}

/// Определяет корень выгрузки: пользователь мог выбрать и `config-…`, и `domains`.
fn layout(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let nested = root.join(DOMAINS_DIR);
    if nested.is_dir() {
        return Ok((root.to_path_buf(), nested));
    }
    match root.parent() {
        Some(parent) => Ok((parent.to_path_buf(), root.to_path_buf())),
        None => Err("Cannot determine the configuration root".into()),
    }
}

fn is_junk(name: &str) -> bool {
    JUNK_FILES.contains(&name)
}

/// Рекурсивно собирает файлы домена в порядке обхода каталога.
fn collect(dir: &Path, prefix: &str, output: &Path, files: &mut Vec<(PathBuf, String)>, skipped: &mut usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut items: Vec<fs::DirEntry> = entries.flatten().collect();
    items.sort_by_key(|entry| entry.file_name());

    for entry in items {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let entry_name = format!("{prefix}/{name}");

        if path.is_dir() {
            collect(&path, &entry_name, output, files, skipped);
            continue;
        }
        if is_junk(&name) {
            continue;
        }
        // Архив могли сохранить внутрь самой выгрузки — себя в себя не кладём.
        if path == output {
            continue;
        }
        // Резервные копии — наши собственные, шине они не нужны.
        if name.ends_with(".bak") || name.contains(".bak.") {
            *skipped += 1;
            continue;
        }
        files.push((path, entry_name));
    }
}

/// Пишет архив `output` из выгрузки, найденной по `root`.
///
/// `domains` — пути к папкам доменов, которые нужно включить; `None` или пустой
/// список означают «весь экспорт целиком». Файл `version` попадает в архив всегда.
pub fn create_archive<F: FnMut(ArchiveProgress)>(
    root: &Path,
    output: &Path,
    domains: Option<&[String]>,
    mut on_progress: F,
) -> Result<ArchiveResult, String> {
    let (config_root, domains_dir) = layout(root)?;
    if !domains_dir.is_dir() {
        return Err(format!("Folder is not accessible: {}", domains_dir.display()));
    }

    // Пустой список доменов означает «весь экспорт целиком».
    let only: Option<HashSet<PathBuf>> = match domains {
        Some(list) if !list.is_empty() => Some(list.iter().map(PathBuf::from).collect()),
        _ => None,
    };

    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut skipped_backups = 0usize;
    let mut packed_domains = 0usize;

    let mut top: Vec<fs::DirEntry> = fs::read_dir(&domains_dir)
        .map_err(|err| format!("cannot read {}: {err}", domains_dir.display()))?
        .flatten()
        .collect();
    top.sort_by_key(|entry| entry.file_name());

    for entry in top {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_name = format!("{DOMAINS_DIR}/{name}");

        if path.is_dir() {
            if only.as_ref().is_some_and(|set| !set.contains(&path)) {
                continue;
            }
            packed_domains += 1;
            collect(&path, &entry_name, output, &mut files, &mut skipped_backups);
        } else if !is_junk(&name) && path != output {
            files.push((path, entry_name));
        }
    }

    let version_path = config_root.join(VERSION_FILE);
    let has_version = version_path.is_file();
    if has_version {
        files.push((version_path, VERSION_FILE.to_string()));
    }
    if files.is_empty() {
        return Err("Nothing to archive".into());
    }

    let target = File::create(output).map_err(|err| format!("cannot create archive: {err}"))?;
    let mut zip = ZipWriter::new(BufWriter::new(target));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(false);

    let total = files.len();
    let mut written = 0usize;

    for (index, (path, name)) in files.iter().enumerate() {
        let mut source = match File::open(path) {
            Ok(file) => BufReader::new(file),
            // Файл мог исчезнуть между обходом и записью — пропускаем, не роняя сборку.
            Err(_) => continue,
        };
        zip.start_file(name, options).map_err(|err| format!("{name}: {err}"))?;
        std::io::copy(&mut source, &mut zip).map_err(|err| format!("{name}: {err}"))?;
        written += 1;

        if index % 200 == 0 || index + 1 == total {
            on_progress(ArchiveProgress { current: index + 1, total });
        }
    }

    let mut buffered = zip.finish().map_err(|err| format!("cannot finish archive: {err}"))?;
    buffered.flush().map_err(|err| format!("cannot flush archive: {err}"))?;

    let bytes = fs::metadata(output).map(|meta| meta.len()).unwrap_or(0);
    Ok(ArchiveResult {
        path: output.to_string_lossy().to_string(),
        domains: packed_domains,
        files: written,
        bytes,
        skipped_backups,
        has_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("fesb-zip-{tag}-{unique}"));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample(root: &Path) {
        let domain = root.join("domains/domain-1");
        fs::create_dir_all(domain.join("routes")).unwrap();
        fs::create_dir_all(domain.join(".history/routes/route-1")).unwrap();
        fs::write(domain.join("domain.xml"), "<beans/>").unwrap();
        fs::write(domain.join("domain.xml.bak"), "<beans/>").unwrap();
        fs::write(domain.join("domain.xml.20260825-010203.bak"), "<beans/>").unwrap();
        fs::write(domain.join("settings.properties"), "fesb.domain.name=A\n").unwrap();
        fs::write(domain.join("routes/route-1.xml"), "<beans/>").unwrap();
        fs::write(domain.join(".history/routes/route-1/log.json"), "{}").unwrap();
        fs::write(domain.join(".DS_Store"), "junk").unwrap();
        fs::write(root.join("version"), "V8.6.461").unwrap();
    }

    #[test]
    fn does_not_pack_itself_when_saved_inside_the_export() {
        let dir = TempDir::new("self");
        sample(&dir.0);
        let output = dir.0.join("domains/domain-1/out.zip");

        let result = create_archive(&dir.0, &output, None, |_| {}).unwrap();
        let names = entries(&output);
        assert!(!names.iter().any(|name| name.ends_with("out.zip")));
        assert_eq!(result.files, 5);
    }

    #[test]
    fn packs_only_the_requested_domains() {
        let dir = TempDir::new("subset");
        sample(&dir.0);
        let second = dir.0.join("domains/domain-2");
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("domain.xml"), "<beans/>").unwrap();

        let output = dir.0.join("out.zip");
        let only = vec![second.to_string_lossy().to_string()];
        let result = create_archive(&dir.0, &output, Some(&only), |_| {}).unwrap();

        assert_eq!(result.domains, 1);
        let names = entries(&output);
        assert!(names.iter().any(|name| name == "domains/domain-2/domain.xml"));
        assert!(!names.iter().any(|name| name.starts_with("domains/domain-1/")));
        // version в архиве нужен всегда, независимо от выбора доменов.
        assert!(names.iter().any(|name| name == "version"));
    }

    fn entries(path: &Path) -> Vec<String> {
        let file = File::open(path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        names
    }

    #[test]
    fn packs_domains_and_version_without_service_files() {
        let dir = TempDir::new("root");
        sample(&dir.0);
        let output = dir.0.join("out.zip");

        let result = create_archive(&dir.0, &output, None, |_| {}).unwrap();
        assert!(result.has_version);
        assert_eq!(result.domains, 1);
        assert_eq!(result.skipped_backups, 2);

        let names = entries(&output);
        assert_eq!(names, vec![
            "domains/domain-1/.history/routes/route-1/log.json".to_string(),
            "domains/domain-1/domain.xml".to_string(),
            "domains/domain-1/routes/route-1.xml".to_string(),
            "domains/domain-1/settings.properties".to_string(),
            "version".to_string(),
        ]);
    }

    #[test]
    fn works_when_the_domains_folder_itself_is_selected() {
        let dir = TempDir::new("domains");
        sample(&dir.0);
        let output = dir.0.join("out.zip");

        let result = create_archive(&dir.0.join("domains"), &output, None, |_| {}).unwrap();
        assert!(result.has_version, "файл version лежит уровнем выше и должен попасть в архив");
        assert!(entries(&output).contains(&"domains/domain-1/domain.xml".to_string()));
    }

    #[test]
    fn keeps_file_contents_intact() {
        let dir = TempDir::new("content");
        sample(&dir.0);
        let output = dir.0.join("out.zip");
        create_archive(&dir.0, &output, None, |_| {}).unwrap();

        let file = File::open(&output).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut text = String::new();
        use std::io::Read;
        zip.by_name("version").unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "V8.6.461");
    }
}
