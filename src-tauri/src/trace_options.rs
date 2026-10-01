//! Параметры объекта трассировки, которые приложение правит массово.
//!
//! Список повторяет форму объекта трассировки в редакторе домена FESB —
//! те же свойства и те же допустимые значения. Поля трассировки
//! (`expressions`: Groovy-выражения и заголовки) сюда не входят: их правка
//! — отдельная задача, и массово менять их вслепую опасно.
//!
//! События трассировки (`events`) в файле — один список, а правятся
//! поштучно: «включить событие точки обработки» на ста объектах не должно
//! затирать остальные события, которые у каждого свои. Поэтому каждое
//! событие — отдельный ключ `events.<ИМЯ>` со значением `true` / `false`.

/// Каким бывает значение параметра.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionKind {
    /// Строка: имя менеджера, очереди, префикс.
    Text,
    /// `true` / `false`.
    Flag,
    /// Целое больше нуля — так его проверяет и редактор шины.
    Count,
    /// Одно значение из списка.
    Choice(&'static [&'static str]),
    /// Одно событие из списка `events`.
    Event,
}

#[derive(Debug, Clone, Copy)]
pub struct TraceOption {
    pub key: &'static str,
    pub kind: OptionKind,
    /// Имеет смысл только у объекта, который пишет в очередь. У объекта,
    /// который пишет в память, такого свойства в редакторе шины нет.
    pub queue_only: bool,
}

/// Верхняя граница чисел — та же, что у полей редактора шины.
pub const COUNT_MAX: u32 = 1_073_741_823;

pub const TRACE_MODES: &[&str] = &["ASYNC_NEW", "ASYNC", "SYNC"];
pub const QUEUE_TYPES: &[&str] = &["LIMITED", "UNLIMITED"];
pub const CLIENT_TYPES: &[&str] = &["NATIVE", "TEMPLATE", "ENDPOINT"];

/// События в том порядке, в котором их пишет редактор шины.
pub const TRACE_EVENTS: &[&str] = &["TRACE_BEFORE_ROUTE", "TRACE_ENDPOINT", "TRACE_AFTER_ROUTE"];

pub const EVENT_PREFIX: &str = "events.";

const fn option(key: &'static str, kind: OptionKind, queue_only: bool) -> TraceOption {
    TraceOption { key, kind, queue_only }
}

pub const TRACE_OPTIONS: &[TraceOption] = &[
    option("broker", OptionKind::Text, true),
    option("queue", OptionKind::Text, true),
    option("traceMode", OptionKind::Choice(TRACE_MODES), true),
    option("clientType", OptionKind::Choice(CLIENT_TYPES), true),
    option("events.TRACE_BEFORE_ROUTE", OptionKind::Event, false),
    option("events.TRACE_ENDPOINT", OptionKind::Event, false),
    option("events.TRACE_AFTER_ROUTE", OptionKind::Event, false),
    option("queueType", OptionKind::Choice(QUEUE_TYPES), false),
    option("queueSize", OptionKind::Count, false),
    option("threads", OptionKind::Count, true),
    option("schedulerPeriod", OptionKind::Count, true),
    option("handleErrors", OptionKind::Flag, false),
    option("captureOriginalEvent", OptionKind::Flag, false),
    option("addBody", OptionKind::Flag, false),
    option("convertBodyToString", OptionKind::Flag, false),
    option("convertSteamToString", OptionKind::Flag, false),
    option("addAllHeaders", OptionKind::Flag, false),
    option("addAllProperties", OptionKind::Flag, false),
    option("convertValues", OptionKind::Flag, false),
    option("convertDateToUnix", OptionKind::Flag, false),
    option("saveBreadcrumbToProperties", OptionKind::Flag, false),
    option("generateTraceStepId", OptionKind::Flag, false),
    option("headerPrefix", OptionKind::Text, false),
    option("propertyPrefix", OptionKind::Text, false),
];

pub fn find(key: &str) -> Option<&'static TraceOption> {
    TRACE_OPTIONS.iter().find(|option| option.key == key)
}

/// Свойства, которые лежат в файле отдельным `<property>`, — всё, кроме событий.
pub fn properties() -> impl Iterator<Item = &'static TraceOption> {
    TRACE_OPTIONS.iter().filter(|option| option.kind != OptionKind::Event)
}

/// Приводит значение к виду, в котором оно ляжет в файл, или объясняет, чем оно плохо.
pub fn normalize(key: &str, value: &str) -> Result<String, String> {
    let option = find(key).ok_or_else(|| format!("Unknown trace option: {key}"))?;
    let value = value.trim();
    match option.kind {
        OptionKind::Text => {
            if value.is_empty() {
                Err(format!("{key}: empty value"))
            } else {
                Ok(value.to_string())
            }
        }
        OptionKind::Flag | OptionKind::Event => match value {
            "true" | "false" => Ok(value.to_string()),
            _ => Err(format!("{key}: expected true or false, got {value}")),
        },
        OptionKind::Count => match value.parse::<u32>() {
            Ok(number) if (1..=COUNT_MAX).contains(&number) => Ok(number.to_string()),
            _ => Err(format!("{key}: expected a whole number from 1 to {COUNT_MAX}, got {value}")),
        },
        OptionKind::Choice(choices) => {
            if choices.contains(&value) {
                Ok(value.to_string())
            } else {
                Err(format!("{key}: expected one of {}, got {value}", choices.join(", ")))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_event_has_its_option() {
        for event in TRACE_EVENTS {
            assert!(find(&format!("{EVENT_PREFIX}{event}")).is_some(), "{event}");
        }
    }

    #[test]
    fn values_are_checked_like_the_bus_editor_does() {
        assert_eq!(normalize("addBody", "true").unwrap(), "true");
        assert!(normalize("addBody", "yes").is_err());
        assert_eq!(normalize("queueSize", " 1000 ").unwrap(), "1000");
        assert!(normalize("queueSize", "0").is_err());
        assert!(normalize("queueSize", "1073741824").is_err());
        assert_eq!(normalize("traceMode", "ASYNC_NEW").unwrap(), "ASYNC_NEW");
        assert!(normalize("traceMode", "async").is_err());
        assert!(normalize("headerPrefix", "  ").is_err());
        assert!(normalize("expressions", "x").is_err(), "поля трассировки массово не правятся");
    }
}
