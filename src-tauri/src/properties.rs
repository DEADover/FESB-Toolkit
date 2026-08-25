//! Разбор файлов формата Java `.properties` (`settings.properties` шины FESB).
//!
//! Учитывается то, что реально встречается в выгрузках конфигурации:
//! комментарии `#`/`!`, разделители `=`, `:` и пробел, продолжение строки
//! обратным слэшем и экранирование `\:` `\=` `\n` `\uXXXX` (в описаниях доменов
//! оно есть).

use std::collections::HashMap;

/// Снимает экранирование ключа или значения.
fn unescape(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if ch != '\\' {
            out.push(ch);
            i += 1;
            continue;
        }
        i += 1;
        let Some(&next) = chars.get(i) else { break };
        i += 1;
        match next {
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'f' => out.push('\u{000C}'),
            'u' => {
                let hex: String = chars.iter().skip(i).take(4).collect();
                match u32::from_str_radix(&hex, 16).ok().filter(|_| hex.len() == 4).and_then(char::from_u32) {
                    Some(decoded) => {
                        out.push(decoded);
                        i += 4;
                    }
                    None => out.push('u'),
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// Позиция первого неэкранированного разделителя «ключ/значение».
fn find_separator(line: &str) -> Option<(usize, bool)> {
    let mut escaped = false;
    for (index, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '=' | ':' => return Some((index, true)),
            ' ' | '\t' | '\u{000C}' => return Some((index, false)),
            _ => {}
        }
    }
    None
}

/// Признак продолжения логической строки: нечётное число слэшей в конце.
fn continues(line: &str) -> bool {
    line.chars().rev().take_while(|&c| c == '\\').count() % 2 == 1
}

pub fn parse_properties(text: &str) -> HashMap<String, String> {
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut result = HashMap::new();
    let mut i = 0;

    while i < lines.len() {
        let mut line = lines[i].trim_start_matches([' ', '\t', '\u{000C}']).to_string();
        i += 1;

        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }

        while continues(&line) && i < lines.len() {
            line.pop();
            line.push_str(lines[i].trim_start_matches([' ', '\t', '\u{000C}']));
            i += 1;
        }

        let Some((index, explicit)) = find_separator(&line) else {
            result.insert(unescape(&line), String::new());
            continue;
        };

        let key = unescape(&line[..index]);
        // Разделитель всегда ASCII, поэтому смещение на один байт корректно.
        let mut rest = &line[index + 1..];
        rest = rest.trim_start_matches([' ', '\t', '\u{000C}']);
        if !explicit {
            // Форма `key value`: после пробела всё ещё может стоять `=` или `:`.
            if let Some(stripped) = rest.strip_prefix(['=', ':']) {
                rest = stripped.trim_start_matches([' ', '\t', '\u{000C}']);
            }
        }
        result.insert(key, unescape(rest));
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_domain_name_and_unescapes_description() {
        let text = "#Mon Aug 24 21:01:49 MSK 2026\n\
                    fesb.domain.name=ERP.GoodWAN\n\
                    fesb.domain.description=CR 4862634 \\u041F\\u043E\\u043B\\: тест\n\
                    fesb.domain.tags=\n";
        let props = parse_properties(text);
        assert_eq!(props.get("fesb.domain.name").unwrap(), "ERP.GoodWAN");
        assert_eq!(props.get("fesb.domain.description").unwrap(), "CR 4862634 Пол: тест");
        assert_eq!(props.get("fesb.domain.tags").unwrap(), "");
    }

    #[test]
    fn joins_continued_lines() {
        let props = parse_properties("a=one \\\n   two\nb:three\nc four\n");
        assert_eq!(props.get("a").unwrap(), "one two");
        assert_eq!(props.get("b").unwrap(), "three");
        assert_eq!(props.get("c").unwrap(), "four");
    }
}
