//! Кто и что может делать на сервере.
//!
//! Аудит отвечает, кто что **сделал**; здесь — кто что **может**. Вопрос
//! возникает ровно тогда, когда в аудите нашлось лишнее или, наоборот,
//! у кого-то не сработала выгрузка.
//!
//! Собирается из трёх методов:
//!
//! * `/api/security/role` — роли: список прав и области, на которые роль
//!   их распространяет;
//! * `/api/security/perms` — что каждое право означает; описания приходят
//!   от шины и уже по-русски, поэтому переводить их незачем и нечем;
//! * `/api/security/user-session` — кто сейчас в системе, с каких адресов,
//!   плюс время последнего входа из `.../times/login/last`.
//!
//! Область роли — это поля вида `domainsForView` и `qmsForEdit`. Их три
//! десятка, и заводить под каждое строку словаря не нужно: имя разбирается
//! на «над чем» и «что можно», а интерфейс переводит две половины отдельно.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::fesb_api::{get_json, Connection};

/// Право в том виде, в каком его описывает шина.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub name: String,
    /// Раздел, к которому право относится: «Домены брокера», «Безопасность».
    pub group: String,
    pub description: String,
}

/// Область, на которую роль распространяет права: `domainsForView` и подобные.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    /// Над чем: `domains`, `qms`, `logFilePrefixes`.
    pub subject: String,
    /// Что можно: `view`, `edit`, `action`, `export`.
    pub action: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub name: String,
    pub permissions: Vec<String>,
    /// Только непустые области: пустая означает «ограничений нет», и строкой
    /// в таблице она была бы шумом.
    pub scopes: Vec<Scope>,
}

/// Открытый сеанс: адрес и клиент.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub ip: String,
    pub agent: Option<String>,
    /// Сколько одинаковых сеансов с этого адреса: инструмент вроде нашего
    /// открывает их десятками, и списком они ничего не добавляют.
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserAccess {
    pub user: String,
    pub sessions: Vec<Session>,
    /// Время последнего входа, миллисекунды эпохи.
    pub last_login: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccessReport {
    pub roles: Vec<Role>,
    pub permissions: Vec<Permission>,
    pub users: Vec<UserAccess>,
}

/// Читает роли, права и открытые сеансы.
pub async fn access(connection: &Connection) -> Result<AccessReport, String> {
    let client = connection.client()?;

    let roles = get_json(connection, &client, "/api/security/role").await?;
    // Остальное — приятные подробности: без права смотреть сеансы список
    // ролей всё равно остаётся полезным.
    let perms = get_json(connection, &client, "/api/security/perms").await.unwrap_or(serde_json::Value::Null);
    let sessions = get_json(connection, &client, "/api/security/user-session")
        .await
        .unwrap_or(serde_json::Value::Null);
    let logins = get_json(connection, &client, "/api/security/local/user/times/login/last")
        .await
        .unwrap_or(serde_json::Value::Null);

    let mut roles: Vec<Role> = roles.as_array().into_iter().flatten().map(read_role).collect();
    roles.sort_by(|a, b| b.permissions.len().cmp(&a.permissions.len()).then_with(|| a.name.cmp(&b.name)));

    let mut permissions: Vec<Permission> = perms
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let name = text(value, "name")?;
            Some(Permission {
                group: text(value, "group").unwrap_or_default(),
                description: text(value, "description").unwrap_or_else(|| name.clone()),
                name,
            })
        })
        .collect();
    permissions.sort_by(|a, b| a.group.cmp(&b.group).then_with(|| a.description.cmp(&b.description)));

    let mut users: Vec<UserAccess> = sessions
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let user = text(value, "username")?;
            let last_login = logins
                .get(&user)
                .and_then(|item| item.get("lastLogin"))
                .and_then(serde_json::Value::as_i64);
            Some(UserAccess {
                sessions: fold_sessions(value.get("sessions")),
                user,
                last_login,
            })
        })
        .collect();
    users.sort_by(|a, b| a.user.cmp(&b.user));

    Ok(AccessReport { roles, permissions, users })
}

fn read_role(value: &serde_json::Value) -> Role {
    let mut scopes = Vec::new();
    if let Some(map) = value.as_object() {
        for (key, item) in map {
            if key == "permissions" {
                continue;
            }
            let values: Vec<String> = item.as_array().into_iter().flatten().filter_map(as_text).collect();
            if values.is_empty() {
                continue;
            }
            if let Some((subject, action)) = split_scope(key) {
                scopes.push(Scope { subject, action, values });
            }
        }
    }
    scopes.sort_by(|a, b| a.subject.cmp(&b.subject).then_with(|| a.action.cmp(&b.action)));

    let mut permissions: Vec<String> = value
        .get("permissions")
        .and_then(|item| item.as_array())
        .map(|list| list.iter().filter_map(as_text).collect())
        .unwrap_or_default();
    permissions.sort();

    Role { name: text(value, "name").unwrap_or_default(), permissions, scopes }
}

/// `domainsForView` → `("domains", "view")`.
///
/// Разделитель — `For` в середине имени; всё до него говорит, над чем право,
/// всё после — что именно можно. Имена без `For` областью не являются.
fn split_scope(key: &str) -> Option<(String, String)> {
    let at = key.find("For")?;
    let subject = &key[..at];
    let action = &key[at + 3..];
    if subject.is_empty() || action.is_empty() {
        return None;
    }
    let mut action = action.to_string();
    // Первая буква действия заглавная — в ключе словаря она не нужна.
    action[..1].make_ascii_lowercase();
    Some((subject.to_string(), action))
}

/// Схлопывает одинаковые сеансы в один со счётчиком.
fn fold_sessions(value: Option<&serde_json::Value>) -> Vec<Session> {
    let mut seen: BTreeMap<(String, Option<String>), usize> = BTreeMap::new();
    for item in value.and_then(|list| list.as_array()).into_iter().flatten() {
        // Отсутствующее значение шина пишет строкой «null» — и для адреса,
        // и для клиента. Это не адрес и не имя.
        let ip = not_null(text(item, "ip")).unwrap_or_default();
        let agent = not_null(text(item, "agent"));
        *seen.entry((ip, agent)).or_insert(0) += 1;
    }
    let mut out: Vec<Session> =
        seen.into_iter().map(|((ip, agent), count)| Session { ip, agent, count }).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.ip.cmp(&b.ip)));
    out
}

fn not_null(value: Option<String>) -> Option<String> {
    value.filter(|item| item != "null")
}

fn text(value: &serde_json::Value, field: &str) -> Option<String> {
    value.get(field).and_then(as_text)
}

fn as_text(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|item| !item.is_empty()).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_scope_name_splits_into_what_and_what_for() {
        assert_eq!(split_scope("domainsForView"), Some(("domains".into(), "view".into())));
        assert_eq!(split_scope("qmeForMessageDownload"), Some(("qme".into(), "messageDownload".into())));
        assert_eq!(
            split_scope("domainGroupsForPropertiesHistoryClear"),
            Some(("domainGroups".into(), "propertiesHistoryClear".into())),
        );
    }

    #[test]
    fn a_name_without_a_separator_is_not_a_scope() {
        assert_eq!(split_scope("name"), None);
        assert_eq!(split_scope("permissions"), None);
        assert_eq!(split_scope("For"), None);
    }

    #[test]
    fn empty_scopes_are_left_out_because_empty_means_no_limit() {
        let role = read_role(&json!({
            "name": "OPERATOR",
            "permissions": ["MAIN_INFO", "JMX_VIEW"],
            "domainsForView": [],
            "logFilePrefixesForView": ["core", "broker"],
        }));
        assert_eq!(role.scopes.len(), 1);
        assert_eq!(role.scopes[0].subject, "logFilePrefixes");
        assert_eq!(role.scopes[0].action, "view");
        assert_eq!(role.permissions, vec!["JMX_VIEW", "MAIN_INFO"]);
    }

    #[test]
    fn identical_sessions_from_one_address_are_counted_not_listed() {
        let sessions = json!([
            { "ip": "172.20.0.1", "agent": "null" },
            { "ip": "172.20.0.1", "agent": "null" },
            { "ip": "10.0.0.5", "agent": "Mozilla/5.0" },
        ]);
        let folded = fold_sessions(Some(&sessions));
        assert_eq!(folded.len(), 2);
        assert_eq!(folded[0].ip, "172.20.0.1");
        assert_eq!(folded[0].count, 2);
        // «null» строкой — это не клиент, а его отсутствие.
        assert_eq!(folded[0].agent, None);
        assert_eq!(folded[1].agent.as_deref(), Some("Mozilla/5.0"));
    }

    #[test]
    fn the_word_null_is_not_an_address_either() {
        let folded = fold_sessions(Some(&json!([{ "ip": "null", "agent": "null" }])));
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].ip, "");
    }

    #[test]
    fn a_user_with_no_sessions_does_not_break_the_fold() {
        assert_eq!(fold_sessions(None), Vec::new());
        assert_eq!(fold_sessions(Some(&json!([]))), Vec::new());
    }
}
