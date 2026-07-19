use super::*;
use serde_json::{json, Map, Value};

pub(super) const HANDOFF_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectHandoffStartRequest {
    pub local_session_id: String,
    pub cli_session_id: String,
    pub platform: CcConnectPlatform,
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub work_dir: String,
    pub session_title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectHandoffPlatformTarget {
    pub platform: CcConnectPlatform,
    pub enabled: bool,
    pub credentials_ready: bool,
    pub session_ready: bool,
    pub ready: bool,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectHandoffInfo {
    pub local_session_id: String,
    pub cli_session_id: String,
    pub project_id: String,
    pub project_name: String,
    pub worktree_id: Option<String>,
    pub worktree_name: Option<String>,
    pub work_dir: String,
    pub provider_id: Option<String>,
    pub provider_name: String,
    pub platform: CcConnectPlatform,
    pub started_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectHandoffStatus {
    pub active: bool,
    pub running: bool,
    pub info: Option<CcConnectHandoffInfo>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PersistedHandoffRecord {
    pub(super) schema_version: u32,
    pub(super) local_session_id: String,
    pub(super) cli_session_id: String,
    pub(super) project_id: String,
    pub(super) project_name: String,
    pub(super) worktree_id: Option<String>,
    pub(super) worktree_name: Option<String>,
    pub(super) work_dir: String,
    pub(super) provider_id: Option<String>,
    pub(super) provider_name: String,
    pub(super) provider_is_global: bool,
    pub(super) platform: CcConnectPlatform,
    pub(super) platform_session_key: String,
    pub(super) cc_session_id: String,
    pub(super) session_file_path: String,
    pub(super) previous_active_session_id: Option<String>,
    pub(super) source_project_id: String,
    pub(super) source_project_name: String,
    pub(super) source_project_path: String,
    pub(super) started_at_ms: i64,
}

impl From<&PersistedHandoffRecord> for CcConnectHandoffInfo {
    fn from(record: &PersistedHandoffRecord) -> Self {
        Self {
            local_session_id: record.local_session_id.clone(),
            cli_session_id: record.cli_session_id.clone(),
            project_id: record.project_id.clone(),
            project_name: record.project_name.clone(),
            worktree_id: record.worktree_id.clone(),
            worktree_name: record.worktree_name.clone(),
            work_dir: record.work_dir.clone(),
            provider_id: record.provider_id.clone(),
            provider_name: record.provider_name.clone(),
            platform: record.platform,
            started_at_ms: record.started_at_ms,
        }
    }
}

pub(super) fn handoff_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join("handoff.json"))
}

pub(super) fn load_handoff_record() -> Result<Option<PersistedHandoffRecord>, String> {
    let path = handoff_path()?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("read cc-connect handoff record failed: {err}")),
    };
    let record: PersistedHandoffRecord = serde_json::from_str(&raw)
        .map_err(|err| format!("parse cc-connect handoff record failed: {err}"))?;
    if record.schema_version != HANDOFF_SCHEMA_VERSION {
        return Err(format!(
            "unsupported cc-connect handoff record version: {}",
            record.schema_version
        ));
    }
    Ok(Some(record))
}

pub(super) fn persist_handoff_record(record: &PersistedHandoffRecord) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(record)
        .map_err(|err| format!("serialize cc-connect handoff record failed: {err}"))?;
    write_file_atomically(&handoff_path()?, &payload, "cc-connect handoff record")
}

pub(super) fn remove_handoff_record() -> Result<(), String> {
    remove_file_if_exists(&handoff_path()?)
}

pub(super) fn cc_session_store_candidates(
    root: &Path,
    project_name: &str,
    work_dir: &str,
) -> Result<Vec<PathBuf>, String> {
    if project_name.trim().is_empty()
        || project_name
            .chars()
            .any(|character| matches!(character, '/' | '\\' | '\0'))
    {
        return Err("handoff_project_name_invalid".to_string());
    }
    let absolute_work_dir = PathBuf::from(work_dir);
    if !absolute_work_dir.is_absolute() {
        return Err("handoff_work_dir_not_absolute".to_string());
    }
    let digest = Sha256::digest(user_path_string(&absolute_work_dir).as_bytes());
    let short_hash = format!("{digest:x}")[..8].to_string();
    let filename = format!("{project_name}_{short_hash}.json");
    let legacy = root.join(&filename);
    let legacy_sessions = root.join(format!(
        "{}.sessions.json",
        filename.trim_end_matches(".json")
    ));
    Ok(vec![
        legacy,
        legacy_sessions,
        root.join("sessions").join(filename),
    ])
}

pub(super) fn cc_session_store_path(
    root: &Path,
    project_name: &str,
    work_dir: &str,
) -> Result<PathBuf, String> {
    let candidates = cc_session_store_candidates(root, project_name, work_dir)?;
    Ok(candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
        .unwrap_or_else(|| candidates[2].clone()))
}

pub(super) fn read_session_document(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let value: Value = serde_json::from_str(&raw)
                .map_err(|err| format!("parse cc-connect session file failed: {err}"))?;
            if !value.is_object() {
                return Err("cc-connect session file root must be an object".to_string());
            }
            Ok(value)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({
            "sessions": {},
            "active_session": {},
            "user_sessions": {},
            "counter": 0,
            "past_id_tracking": true,
            "legacy_data": false,
            "version": 1
        })),
        Err(err) => Err(format!("read cc-connect session file failed: {err}")),
    }
}

pub(super) fn read_existing_session_document(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let value: Value = serde_json::from_str(&raw)
                .map_err(|err| format!("parse cc-connect session file failed: {err}"))?;
            if !value.is_object() {
                return Err("cc-connect session file root must be an object".to_string());
            }
            Ok(Some(value))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("read cc-connect session file failed: {err}")),
    }
}

pub(super) fn write_session_document(path: &Path, document: &Value) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(document)
        .map_err(|err| format!("serialize cc-connect session file failed: {err}"))?;
    write_file_atomically(path, &payload, "cc-connect handoff session")
}

fn object_field_mut<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    root.entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| format!("cc-connect session field {key} must be an object"))
}

pub(super) fn inject_handoff_session(
    document: &mut Value,
    platform_session_key: &str,
    cli_session_id: &str,
    session_title: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let root = document
        .as_object_mut()
        .ok_or_else(|| "cc-connect session file root must be an object".to_string())?;
    let mut counter = root
        .get("counter")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let cc_session_id = {
        let sessions = object_field_mut(root, "sessions")?;
        loop {
            counter += 1;
            let candidate = format!("s{counter}");
            if !sessions.contains_key(&candidate) {
                break candidate;
            }
        }
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let name = session_title
        .map(single_line)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "CLI-Manager remote handoff".to_string());
    object_field_mut(root, "sessions")?.insert(
        cc_session_id.clone(),
        json!({
            "id": cc_session_id,
            "name": name,
            "agent_session_id": cli_session_id,
            "agent_type": "codex",
            "history": [],
            "created_at": now,
            "updated_at": now
        }),
    );
    let previous_active_session_id = object_field_mut(root, "active_session")?
        .insert(
            platform_session_key.to_string(),
            Value::String(cc_session_id.clone()),
        )
        .and_then(|value| value.as_str().map(str::to_string));
    let user_sessions = object_field_mut(root, "user_sessions")?
        .entry(platform_session_key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let user_sessions = user_sessions
        .as_array_mut()
        .ok_or_else(|| "cc-connect user_sessions entry must be an array".to_string())?;
    user_sessions.retain(|value| value.as_str() != Some(cc_session_id.as_str()));
    user_sessions.push(Value::String(cc_session_id.clone()));
    root.insert("counter".to_string(), Value::Number(counter.into()));
    root.insert("past_id_tracking".to_string(), Value::Bool(true));
    let version = root
        .get("version")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(1);
    root.insert("version".to_string(), Value::Number(version.into()));
    Ok((cc_session_id, previous_active_session_id))
}

pub(super) fn cleanup_handoff_session(
    document: &mut Value,
    platform_session_key: &str,
    cc_session_id: &str,
    cli_session_id: &str,
    previous_active_session_id: Option<&str>,
) -> Result<bool, String> {
    let root = document
        .as_object_mut()
        .ok_or_else(|| "cc-connect session file root must be an object".to_string())?;
    let mut changed = false;
    let previous_exists = root
        .get("sessions")
        .and_then(Value::as_object)
        .is_some_and(|sessions| {
            previous_active_session_id.is_some_and(|previous| sessions.contains_key(previous))
        });
    if let Some(sessions) = root.get_mut("sessions").and_then(Value::as_object_mut) {
        if let Some(existing) = sessions.get(cc_session_id) {
            let recorded_cli_session_id = existing
                .get("agent_session_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if recorded_cli_session_id != cli_session_id {
                return Err("handoff_session_identity_mismatch".to_string());
            }
        }
        changed |= sessions.remove(cc_session_id).is_some();
    }
    if let Some(user_sessions) = root
        .get_mut("user_sessions")
        .and_then(Value::as_object_mut)
        .and_then(|sessions| sessions.get_mut(platform_session_key))
    {
        let values = user_sessions
            .as_array_mut()
            .ok_or_else(|| "cc-connect user_sessions entry must be an array".to_string())?;
        let original_len = values.len();
        values.retain(|value| value.as_str() != Some(cc_session_id));
        changed |= values.len() != original_len;
    }
    if let Some(active_sessions) = root
        .get_mut("active_session")
        .and_then(Value::as_object_mut)
    {
        let owns_active = active_sessions
            .get(platform_session_key)
            .and_then(Value::as_str)
            == Some(cc_session_id);
        if owns_active {
            if previous_exists {
                active_sessions.insert(
                    platform_session_key.to_string(),
                    Value::String(previous_active_session_id.unwrap_or_default().to_string()),
                );
            } else {
                active_sessions.remove(platform_session_key);
            }
            changed = true;
        }
    }
    Ok(changed)
}

fn platform_key_prefix_matches(platform: CcConnectPlatform, key: &str) -> bool {
    match platform {
        CcConnectPlatform::Telegram => key.starts_with("telegram:"),
        CcConnectPlatform::Feishu => key.starts_with("feishu:") || key.starts_with("lark:"),
        CcConnectPlatform::Weixin => key.starts_with("weixin:dm:"),
        CcConnectPlatform::Wecom => key.starts_with("wecom:"),
    }
}

fn key_matches_allowed_user(
    platform: CcConnectPlatform,
    key: &str,
    allowed_users: &[&str],
) -> bool {
    if !platform_key_prefix_matches(platform, key) {
        return false;
    }
    match platform {
        CcConnectPlatform::Weixin => allowed_users
            .iter()
            .any(|user| key == format!("weixin:dm:{user}")),
        _ => key
            .rsplit(':')
            .next()
            .is_some_and(|tail| allowed_users.contains(&tail)),
    }
}

fn session_updated_at(root: &Map<String, Value>, session_id: &str) -> i64 {
    root.get("sessions")
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|session| session.get("updated_at"))
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0)
}

pub(super) fn resolve_platform_session_key(
    document: &Value,
    platform: CcConnectPlatform,
    allow_from: &str,
) -> Result<String, String> {
    let allowed_users = allow_from
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if allowed_users.is_empty() {
        return Err("handoff_platform_user_missing".to_string());
    }
    let root = document
        .as_object()
        .ok_or_else(|| "cc-connect session file root must be an object".to_string())?;
    let mut candidates = HashSet::new();
    if let Some(active_sessions) = root.get("active_session").and_then(Value::as_object) {
        candidates.extend(active_sessions.keys().cloned());
    }
    if let Some(user_sessions) = root.get("user_sessions").and_then(Value::as_object) {
        candidates.extend(user_sessions.keys().cloned());
    }
    let active_sessions = root.get("active_session").and_then(Value::as_object);
    let mut ranked = candidates
        .into_iter()
        .filter(|key| key_matches_allowed_user(platform, key, &allowed_users))
        .map(|key| {
            let rank = active_sessions
                .and_then(|sessions| sessions.get(&key))
                .and_then(Value::as_str)
                .map(|session_id| session_updated_at(root, session_id))
                .unwrap_or(0);
            (key, rank)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    if let Some((key, _)) = ranked.into_iter().next() {
        return Ok(key);
    }
    let user = allowed_users[0];
    match platform {
        CcConnectPlatform::Telegram => Ok(format!("telegram:{user}:{user}")),
        CcConnectPlatform::Weixin => Ok(format!("weixin:dm:{user}")),
        CcConnectPlatform::Wecom => Ok(format!("wecom:{user}:{user}")),
        CcConnectPlatform::Feishu => Err("handoff_platform_session_missing".to_string()),
    }
}

pub(super) fn merge_context_token(
    document: &mut Value,
    user_id: &str,
    token: &str,
) -> Result<(), String> {
    if !document.is_object() {
        return Err("Weixin context token file root must be an object".to_string());
    }
    document
        .as_object_mut()
        .unwrap()
        .insert(user_id.to_string(), Value::String(token.to_string()));
    Ok(())
}

pub(super) fn context_token(document: &Value, user_id: &str) -> Option<String> {
    document
        .as_object()
        .and_then(|tokens| tokens.get(user_id))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|token| !token.trim().is_empty())
}

pub(super) fn empty_json_object() -> Value {
    Value::Object(Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_and_cleanup_handoff_session_preserves_existing_state() {
        let mut document = json!({
            "sessions": {
                "s2": {
                    "id": "s2",
                    "agent_session_id": "old-thread",
                    "updated_at": "2026-07-18T12:00:00Z"
                }
            },
            "active_session": {"telegram:10:10": "s2"},
            "user_sessions": {"telegram:10:10": ["s2"]},
            "counter": 2,
            "custom_field": {"keep": true}
        });
        let (session_id, previous) = inject_handoff_session(
            &mut document,
            "telegram:10:10",
            "thread-123",
            Some("Dinner task"),
        )
        .unwrap();
        assert_eq!(session_id, "s3");
        assert_eq!(previous.as_deref(), Some("s2"));
        assert_eq!(
            document["sessions"]["s3"]["agent_session_id"],
            Value::String("thread-123".to_string())
        );
        assert_eq!(document["active_session"]["telegram:10:10"], "s3");

        assert!(cleanup_handoff_session(
            &mut document,
            "telegram:10:10",
            "s3",
            "thread-123",
            previous.as_deref(),
        )
        .unwrap());
        assert!(document["sessions"].get("s3").is_none());
        assert_eq!(document["active_session"]["telegram:10:10"], "s2");
        assert_eq!(document["user_sessions"]["telegram:10:10"], json!(["s2"]));
        assert_eq!(document["custom_field"]["keep"], true);
    }

    #[test]
    fn cleanup_refuses_to_remove_a_reused_session_id() {
        let mut document = json!({
            "sessions": {"s1": {"agent_session_id": "other-thread"}},
            "active_session": {"weixin:dm:user@im.wechat": "s1"},
            "user_sessions": {"weixin:dm:user@im.wechat": ["s1"]}
        });
        assert_eq!(
            cleanup_handoff_session(
                &mut document,
                "weixin:dm:user@im.wechat",
                "s1",
                "expected-thread",
                None,
            ),
            Err("handoff_session_identity_mismatch".to_string())
        );
    }

    #[test]
    fn platform_session_resolution_prefers_latest_matching_chat() {
        let document = json!({
            "sessions": {
                "s1": {"updated_at": "2026-07-18T10:00:00Z"},
                "s2": {"updated_at": "2026-07-18T12:00:00Z"}
            },
            "active_session": {
                "telegram:-100:42": "s1",
                "telegram:42:42": "s2",
                "telegram:99:99": "s1"
            },
            "user_sessions": {}
        });
        assert_eq!(
            resolve_platform_session_key(&document, CcConnectPlatform::Telegram, "42").unwrap(),
            "telegram:42:42"
        );
        assert_eq!(
            resolve_platform_session_key(
                &empty_json_object(),
                CcConnectPlatform::Weixin,
                "abc@im.wechat",
            )
            .unwrap(),
            "weixin:dm:abc@im.wechat"
        );
        assert_eq!(
            resolve_platform_session_key(
                &empty_json_object(),
                CcConnectPlatform::Feishu,
                "ou_user",
            ),
            Err("handoff_platform_session_missing".to_string())
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn session_store_path_matches_cc_connect_windows_hashing() {
        let root = Path::new(r"C:\cc-connect-data");
        let path = cc_session_store_path(root, "CLIProxyAPI", r"F:\codex\CLIProxyAPI").unwrap();
        assert_eq!(
            path,
            root.join("sessions").join("CLIProxyAPI_0b0ad4c3.json")
        );
    }
}
