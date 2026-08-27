//! Запись таблицы в файл Excel.
//!
//! Формат `.xlsx` — это zip с несколькими файлами XML, и для одной плоской
//! таблицы их нужно пять. Своя запись вместо библиотеки взята не из упрямства:
//! zip в проекте уже есть ради выгрузок конфигурации, а любая библиотека для
//! xlsx тянет за собой десятки зависимостей ради возможностей, которых здесь
//! не нужно, — формул, картинок, диаграмм.
//!
//! Строки пишутся встроенными (`inlineStr`), а не через общий словарь: словарь
//! экономит место на повторах, но требует второго прохода по данным, а отчёт
//! и так открывается один раз.

use std::io::Write;
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// Экранирует то, что нельзя класть в XML как есть.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Управляющие символы Excel не принимает и на них ломается.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Имя листа по правилам Excel: не длиннее 31 символа и без `:\\/?*[]`.
///
/// Имя приходит из словаря интерфейса, и там вполне может оказаться
/// «Точки Входа и Выхода» — а Excel на запрещённом символе или лишней
/// длине отказывается открывать книгу целиком.
fn sheet_title(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']') { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return "Sheet1".into();
    }
    trimmed.chars().take(31).collect()
}

/// `0` → `A`, `25` → `Z`, `26` → `AA`.
fn column_name(index: usize) -> String {
    let mut index = index + 1;
    let mut name = String::new();
    while index > 0 {
        let rest = (index - 1) % 26;
        name.insert(0, (b'A' + rest as u8) as char);
        index = (index - 1) / 26;
    }
    name
}

/// Одна ячейка: числа пишутся числами, чтобы Excel их складывал.
fn cell(column: usize, row: usize, value: &str) -> String {
    let reference = format!("{}{}", column_name(column), row);
    if value.is_empty() {
        return String::new();
    }
    let numeric = value.parse::<f64>().is_ok() && !value.starts_with('+');
    if numeric {
        format!(r#"<c r="{reference}"><v>{}</v></c>"#, escape(value))
    } else {
        format!(
            r#"<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
            escape(value)
        )
    }
}

/// Пишет одну таблицу в файл Excel: первая строка — шапка, дальше данные.
///
/// Шапка закреплена и снабжена автофильтром: отчёт на несколько тысяч строк
/// без этого нечитаем.
pub fn write_sheet(
    path: &Path,
    sheet_name: &str,
    headers: &[String],
    rows: &[Vec<String>],
) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|err| format!("Cannot create the file: {err}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut put = |name: &str, body: &str| -> Result<(), String> {
        zip.start_file(name, options).map_err(|err| format!("Cannot write {name}: {err}"))?;
        zip.write_all(body.as_bytes()).map_err(|err| format!("Cannot write {name}: {err}"))
    };

    put(
        "[Content_Types].xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"#,
    )?;

    put(
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"#,
    )?;

    let last_column = column_name(headers.len().saturating_sub(1));
    let last_row = rows.len() + 1;
    put(
        "xl/workbook.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="{}" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
            escape(&sheet_title(sheet_name)),
        ),
    )?;

    put(
        "xl/_rels/workbook.xml.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#,
    )?;

    // Один стиль сверх обычного: жирная шапка.
    put(
        "xl/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"#,
    )?;

    put(
        "docProps/core.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>FESB Toolkit</dc:creator><cp:lastModifiedBy>FESB Toolkit</cp:lastModifiedBy>
</cp:coreProperties>"#,
    )?;

    put(
        "docProps/app.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>FESB Toolkit</Application>
</Properties>"#,
    )?;

    let mut sheet = String::with_capacity(rows.len() * 256);
    sheet.push_str(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
    );
    // Порядок элементов задан схемой, и Excel относится к нему строго:
    // dimension, sheetViews, sheetFormatPr, cols, sheetData, autoFilter.
    // Перепутанные местами cols и sheetViews он считает книгу испорченной,
    // хотя другие читатели такой файл открывают без единого слова.
    sheet.push_str(&format!(r#"<dimension ref="A1:{last_column}{last_row}"/>"#));
    sheet.push_str(r#"<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>"#);
    sheet.push_str(r#"<sheetFormatPr defaultRowHeight="15"/>"#);

    // Ширина колонки — по её содержимому, а не по заголовку.
    //
    // Раньше считалось по длине шапки: у колонки «Адрес» заголовок из шести
    // букв, а внутри адреса на триста символов — они лезли на соседей и лист
    // выглядел кашей. Берём типичную длину (девять из десяти строк короче),
    // а не самую большую: один запредельный адрес не должен растягивать
    // колонку на весь экран.
    sheet.push_str("<cols>");
    for (index, header) in headers.iter().enumerate() {
        let mut lengths: Vec<usize> = rows
            .iter()
            .filter_map(|row| row.get(index))
            .map(|value| value.chars().count())
            .collect();
        lengths.sort_unstable();
        let typical = lengths.get(lengths.len().saturating_mul(9) / 10).copied().unwrap_or(0);
        let width = header.chars().count().max(typical) + 3;
        sheet.push_str(&format!(
            r#"<col min="{0}" max="{0}" width="{1}" customWidth="1"/>"#,
            index + 1,
            width.clamp(10, 60),
        ));
    }
    sheet.push_str("</cols>");
    sheet.push_str("<sheetData>");

    sheet.push_str(r#"<row r="1">"#);
    for (index, header) in headers.iter().enumerate() {
        sheet.push_str(&format!(
            r#"<c r="{}1" t="inlineStr" s="1"><is><t xml:space="preserve">{}</t></is></c>"#,
            column_name(index),
            escape(header)
        ));
    }
    sheet.push_str("</row>");

    for (offset, row) in rows.iter().enumerate() {
        let number = offset + 2;
        sheet.push_str(&format!(r#"<row r="{number}">"#));
        for (index, value) in row.iter().enumerate() {
            sheet.push_str(&cell(index, number, value));
        }
        sheet.push_str("</row>");
    }

    sheet.push_str("</sheetData>");
    sheet.push_str(&format!(r#"<autoFilter ref="A1:{last_column}{last_row}"/>"#));
    sheet.push_str("</worksheet>");
    put("xl/worksheets/sheet1.xml", &sheet)?;

    zip.finish().map_err(|err| format!("Cannot finish the file: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn numbers_the_columns_like_excel() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(27), "AB");
    }

    #[test]
    fn escapes_what_would_break_the_xml() {
        assert_eq!(escape("a & b < c"), "a &amp; b &lt; c");
        assert_eq!(escape("\u{1}x"), " x");
    }

    #[test]
    fn numbers_stay_numbers_and_text_stays_text() {
        assert!(cell(0, 2, "8443").contains("<v>8443</v>"));
        assert!(cell(0, 2, "https").contains("inlineStr"));
        assert!(cell(0, 2, "").is_empty());
    }

    #[test]
    fn writes_a_file_excel_can_open() {
        let dir = std::path::PathBuf::from(std::env::var("XLSX_OUT").unwrap_or_else(|_| std::env::temp_dir().join("fesb-xlsx").to_string_lossy().into()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("report.xlsx");
        write_sheet(
            &path,
            "Отчёт",
            &["Домен".into(), "Порт".into()],
            &[vec!["POA.Kontur".into(), "8443".into()], vec!["EDI & Co".into(), String::new()]],
        )
        .unwrap();

        let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        for needed in ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml"] {
            assert!(names.contains(&needed.to_string()), "нет {needed} среди {names:?}");
        }
        let mut sheet = String::new();
        zip.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet).unwrap();
        assert!(sheet.contains("POA.Kontur"));
        assert!(sheet.contains("EDI &amp; Co"));
        assert!(sheet.contains("<v>8443</v>"));
        assert!(sheet.contains("autoFilter"));
        if std::env::var("XLSX_OUT").is_err() { let _ = std::fs::remove_dir_all(&dir); }
    }
}

#[cfg(test)]
mod order_tests {
    use super::*;

    /// Excel строг к порядку элементов внутри листа, другие читатели — нет.
    /// Этот тест — единственное, что отделяет нас от «файл повреждён».
    #[test]
    fn the_sheet_follows_the_schema_order() {
        let dir = std::env::temp_dir().join("fesb-xlsx-order");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("order.xlsx");
        write_sheet(&path, "Лист", &["A".into(), "B".into()], &[vec!["1".into(), "x".into()]]).unwrap();

        let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let mut sheet = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("xl/worksheets/sheet1.xml").unwrap(), &mut sheet).unwrap();

        let order = ["<dimension", "<sheetViews", "<sheetFormatPr", "<cols", "<sheetData", "<autoFilter"];
        let mut previous = 0;
        for element in order {
            let at = sheet.find(element).unwrap_or_else(|| panic!("нет {element}"));
            assert!(at > previous, "{element} стоит не на своём месте");
            previous = at;
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Ссылка на часть, которой в файле нет, — ровно то, что Excel зовёт
    /// «файл повреждён». Тема сюда однажды уже пробралась.
    #[test]
    fn nothing_points_at_a_part_we_do_not_write() {
        let dir = std::env::temp_dir().join("fesb-xlsx-refs");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("refs.xlsx");
        write_sheet(&path, "Лист", &["A".into()], &[vec!["x".into()]]).unwrap();

        let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        let mut styles = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("xl/styles.xml").unwrap(), &mut styles).unwrap();
        assert!(!styles.contains("theme="), "стили ссылаются на тему, а темы в файле нет");

        // Всё, что объявлено в описи, должно лежать в архиве.
        let mut types = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("[Content_Types].xml").unwrap(), &mut types).unwrap();
        for part in types.split("PartName=\"").skip(1) {
            let declared = part.split('"').next().unwrap().trim_start_matches('/');
            assert!(names.iter().any(|n| n == declared), "объявлен {declared}, но его нет");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sheet_names_are_trimmed_to_what_excel_accepts() {
        assert_eq!(sheet_title("Точки Входа и Выхода"), "Точки Входа и Выхода");
        assert_eq!(sheet_title("отчёт: [2026]/итог"), "отчёт   2026  итог");
        assert_eq!(sheet_title("").as_str(), "Sheet1");
        assert_eq!(sheet_title(&"я".repeat(40)).chars().count(), 31);
    }
}
