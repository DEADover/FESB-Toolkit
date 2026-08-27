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
</Types>"#,
    )?;

    put(
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
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
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'{}'!$A$1:${last_column}${last_row}</definedName></definedNames>
</workbook>"#,
            escape(sheet_name),
            escape(sheet_name),
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
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>"#,
    )?;

    let mut sheet = String::with_capacity(rows.len() * 256);
    sheet.push_str(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
    );
    // Ширины на глаз: имя домена и адрес длинные, остальное короткое.
    sheet.push_str("<cols>");
    for (index, header) in headers.iter().enumerate() {
        let width = (header.chars().count() + 6).clamp(12, 46);
        sheet.push_str(&format!(
            r#"<col min="{0}" max="{0}" width="{width}" customWidth="1"/>"#,
            index + 1
        ));
    }
    sheet.push_str("</cols>");
    sheet.push_str(r#"<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>"#);
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
        let dir = std::env::temp_dir().join(format!("fesb-xlsx-{}", std::process::id()));
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
        let _ = std::fs::remove_dir_all(&dir);
    }
}
