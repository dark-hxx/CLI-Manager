use super::{
    extract_content, extract_cwd, extract_model, extract_simple_tag_block, extract_timestamp,
    is_jsonl, normalize_history_path, normalize_unix_timestamp_millis,
    parse_timestamp_millis_value, project_key_from_cwd, resolve_cursor_global_storage_root,
    timestamp_millis_to_rfc3339, CachedSessionComputation, CursorSessionMetadata,
    READ_BUF_CAPACITY,
};
use log::debug;
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(super) fn looks_like_gemini_session_file(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|raw| {
            raw.contains("\"messages\"")
                && (raw.contains("\"sessionId\"") || raw.contains("\"projectHash\""))
        })
        .unwrap_or(false)
}

pub(super) fn looks_like_copilot_events_file(path: &Path) -> bool {
    if !path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("events.jsonl"))
    {
        return false;
    }
    let Ok(file) = File::open(path) else {
        return false;
    };
    BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .take(16)
        .any(|line| {
            line.contains("\"session.start\"")
                || line.contains("\"user.message\"")
                || line.contains("\"assistant.message\"")
        })
}

pub(super) fn looks_like_antigravity_transcript_file(path: &Path) -> bool {
    antigravity_path_parts(path).is_some()
}

pub(super) fn antigravity_path_parts(path: &Path) -> Option<(PathBuf, String)> {
    if !path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("transcript.jsonl")
    }) {
        return None;
    }
    let logs = path.parent()?;
    let generated = logs.parent()?;
    let conversation = generated.parent()?;
    let brain = conversation.parent()?;
    if !logs
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("logs"))
        || !generated.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .eq_ignore_ascii_case(".system_generated")
        })
        || !brain
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("brain"))
    {
        return None;
    }
    let conversation_id = conversation
        .file_name()?
        .to_string_lossy()
        .trim()
        .to_string();
    let root = brain.parent()?.to_path_buf();
    (!conversation_id.is_empty()).then_some((root, conversation_id))
}

pub(super) fn load_antigravity_workspace_map(root: &Path) -> HashMap<String, String> {
    let Ok(file) = File::open(root.join("history.jsonl")) else {
        return HashMap::new();
    };
    BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .filter_map(|value| {
            let conversation_id = value.get("conversationId")?.as_str()?.trim().to_string();
            let workspace = value.get("workspace")?.as_str()?.trim().to_string();
            (!conversation_id.is_empty() && !workspace.is_empty())
                .then_some((conversation_id, workspace))
        })
        .collect()
}

pub(super) fn antigravity_workspace_from_path(path: &Path) -> Option<String> {
    let (root, conversation_id) = antigravity_path_parts(path)?;
    load_antigravity_workspace_map(&root).remove(&conversation_id)
}

pub(super) fn looks_like_grok_updates_file(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("updates.jsonl"))
        && path
            .parent()
            .map(|parent| parent.join("summary.json").is_file())
            .unwrap_or(false)
}

pub(super) fn grok_summary_value(path: &Path) -> Option<Value> {
    let summary_path = path.parent()?.join("summary.json");
    fs::read_to_string(summary_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

pub(super) fn grok_value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

pub(super) fn grok_string_by_paths(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths
        .iter()
        .filter_map(|path| grok_value_at_path(value, path))
        .find_map(|value| {
            value
                .as_str()
                .or_else(|| value.get("id").and_then(Value::as_str))
                .or_else(|| value.get("value").and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
}

pub(super) fn grok_session_id_from_path(path: &Path) -> Option<String> {
    grok_summary_value(path)
        .as_ref()
        .and_then(|summary| grok_string_by_paths(summary, &[&["info", "id"], &["session_id"]]))
        .or_else(|| {
            path.parent()
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().trim().to_string())
                .filter(|id| !id.is_empty())
        })
}

pub(super) fn grok_workspace_from_path(path: &Path) -> Option<String> {
    grok_summary_value(path).as_ref().and_then(|summary| {
        grok_string_by_paths(
            summary,
            &[
                &["source_workspace_dir"],
                &["prompt_display_cwd"],
                &["info", "cwd"],
                &["git_root_dir"],
            ],
        )
    })
}

pub(super) fn grok_project_key_from_path(path: &Path) -> String {
    // Prefer full normalized workspace path so list UI shows the real project path
    // (not only the last segment) and path-based filtering can match exactly.
    grok_workspace_from_path(path)
        .map(|cwd| normalize_history_path(&cwd))
        .filter(|key| !key.is_empty())
        .or_else(|| grok_session_id_from_path(path))
        .unwrap_or_else(|| "grok".to_string())
}

pub(super) fn looks_like_pi_session_file(path: &Path) -> bool {
    if !is_jsonl(path) || !path_is_pi_session_tree(path) {
        return false;
    }
    let Ok(file) = File::open(path) else {
        return false;
    };
    BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .take(8)
        .any(|line| {
            let trimmed = line.trim();
            trimmed.contains(r#""type":"session""#) || trimmed.contains(r#""type":"message""#)
        })
}

pub(super) fn path_is_pi_session_tree(path: &Path) -> bool {
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("sessions"))
        {
            let agent = dir.parent();
            let pi = agent.and_then(Path::parent);
            return agent
                .and_then(Path::file_name)
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("agent"))
                && pi
                    .and_then(Path::file_name)
                    .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(".pi"));
        }
        current = dir.parent();
    }
    false
}

pub(super) fn pi_session_meta(path: &Path) -> Option<Value> {
    let file = File::open(path).ok()?;
    for line in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .take(16)
    {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            return Some(value);
        }
    }
    None
}

pub(super) fn pi_string_by_keys(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|value| {
            value
                .as_str()
                .or_else(|| value.get("id").and_then(Value::as_str))
                .or_else(|| value.get("value").and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
}

pub(super) fn pi_workspace_from_path(path: &Path) -> Option<String> {
    pi_session_meta(path)
        .as_ref()
        .and_then(|meta| extract_cwd(meta))
}

pub(super) fn pi_session_id_from_path(path: &Path) -> Option<String> {
    pi_session_meta(path)
        .as_ref()
        .and_then(|meta| pi_string_by_keys(meta, &["sessionId", "session_id", "id"]))
        .or_else(|| {
            path.file_stem()
                .map(|name| name.to_string_lossy().trim().to_string())
                .filter(|id| !id.is_empty())
        })
}

pub(super) fn pi_project_key_from_path(path: &Path) -> String {
    pi_workspace_from_path(path)
        .as_deref()
        .and_then(project_key_from_cwd)
        .or_else(|| pi_session_id_from_path(path))
        .unwrap_or_else(|| "pi".to_string())
}

pub(super) fn looks_like_kiro_session_file(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|raw| raw.contains("\"history\"") && raw.contains("\"sessionId\""))
        .unwrap_or(false)
}

pub(super) fn looks_like_cline_session_file(path: &Path) -> bool {
    if !path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("api_conversation_history.json")
    }) {
        return false;
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| cline_api_message_count(&value))
        .is_some_and(|count| count > 0)
}

pub(super) fn looks_like_cursor_agent_transcript_file(path: &Path) -> bool {
    if !is_jsonl(path) || cursor_path_parts(path).is_none() {
        return false;
    }
    let Ok(file) = File::open(path) else {
        return false;
    };
    BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .take(8)
        .any(|line| {
            let trimmed = line.trim();
            trimmed.contains(r#""role""#) && trimmed.contains(r#""message""#)
                || trimmed.contains(r#""type":"turn_ended""#)
        })
}

pub(super) fn cursor_path_parts(path: &Path) -> Option<(String, String)> {
    let session_dir = path.parent()?;
    let transcripts = session_dir.parent()?;
    let project_dir = transcripts.parent()?;
    if !transcripts.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("agent-transcripts")
    }) {
        return None;
    }
    let session_id = path
        .file_stem()
        .or_else(|| session_dir.file_name())?
        .to_string_lossy()
        .trim()
        .to_string();
    let project_key = project_dir
        .file_name()?
        .to_string_lossy()
        .trim()
        .to_string();
    (!session_id.is_empty() && !project_key.is_empty()).then_some((project_key, session_id))
}

pub(super) fn cursor_session_id_from_path(path: &Path) -> Option<String> {
    cursor_path_parts(path).map(|(_, session_id)| session_id)
}

pub(super) fn cursor_project_key_from_path(path: &Path) -> String {
    cursor_path_parts(path)
        .map(|(project_key, _)| project_key)
        .unwrap_or_else(|| "cursor".to_string())
}

pub(super) fn cursor_project_slug_from_path(path: &str) -> String {
    normalize_history_path(path)
        .replace(':', "")
        .replace(['\\', '/'], "-")
        .trim_matches('-')
        .to_string()
}

pub(super) fn cursor_metadata_from_path(path: &Path) -> Option<CursorSessionMetadata> {
    let session_id = cursor_session_id_from_path(path)?;
    match cursor_metadata_from_databases(&resolve_cursor_global_storage_root(), &session_id) {
        Ok(metadata) => metadata,
        Err(err) => {
            debug!(
                "cursor metadata skipped: session_id={}, err={}",
                session_id, err
            );
            None
        }
    }
}

pub(super) fn cursor_metadata_from_databases(
    global_storage: &Path,
    session_id: &str,
) -> Result<Option<CursorSessionMetadata>, String> {
    if session_id.trim().is_empty() || !global_storage.exists() {
        return Ok(None);
    }
    let global_storage = global_storage.to_path_buf();
    let session_id = session_id.trim().to_string();
    let read = move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| err.to_string())?;
        runtime.block_on(cursor_metadata_from_databases_async(
            &global_storage,
            &session_id,
        ))
    };

    if tokio::runtime::Handle::try_current().is_ok() {
        std::thread::spawn(read)
            .join()
            .map_err(|_| "cursor_metadata_thread_panicked".to_string())?
    } else {
        read()
    }
}

pub(super) async fn cursor_metadata_from_databases_async(
    global_storage: &Path,
    session_id: &str,
) -> Result<Option<CursorSessionMetadata>, String> {
    let mut metadata = CursorSessionMetadata::default();
    if let Ok(state) = read_cursor_state_metadata(global_storage, session_id).await {
        merge_cursor_metadata(&mut metadata, state);
    }
    if let Ok(conversation) = read_cursor_conversation_metadata(global_storage, session_id).await {
        if conversation.title.is_some() {
            metadata.title = conversation.title;
        }
        if metadata.updated_at.is_none() {
            metadata.updated_at = conversation.updated_at;
        }
    }
    if cursor_metadata_is_empty(&metadata) {
        Ok(None)
    } else {
        Ok(Some(metadata))
    }
}

pub(super) fn cursor_sqlite_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(1))
}

pub(super) async fn read_cursor_conversation_metadata(
    global_storage: &Path,
    session_id: &str,
) -> Result<CursorSessionMetadata, String> {
    let db_path = global_storage.join("conversation-search.db");
    if !db_path.is_file() {
        return Ok(CursorSessionMetadata::default());
    }
    let mut conn = SqliteConnection::connect_with(&cursor_sqlite_options(&db_path))
        .await
        .map_err(|err| err.to_string())?;
    if !cursor_table_exists(&mut conn, "conversations").await? {
        return Ok(CursorSessionMetadata::default());
    }
    let Some(row) = sqlx::query(
        "SELECT title, CAST(updated_at AS REAL) AS updated_at
         FROM conversations
         WHERE id = ?1
         LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&mut conn)
    .await
    .map_err(|err| err.to_string())?
    else {
        return Ok(CursorSessionMetadata::default());
    };

    Ok(CursorSessionMetadata {
        title: trim_optional_string(row.try_get("title").ok().flatten()),
        updated_at: row
            .try_get::<Option<f64>, _>("updated_at")
            .ok()
            .flatten()
            .and_then(normalize_unix_timestamp_millis),
        ..CursorSessionMetadata::default()
    })
}

pub(super) async fn read_cursor_state_metadata(
    global_storage: &Path,
    session_id: &str,
) -> Result<CursorSessionMetadata, String> {
    let db_path = global_storage.join("state.vscdb");
    if !db_path.is_file() {
        return Ok(CursorSessionMetadata::default());
    }
    let mut conn = SqliteConnection::connect_with(&cursor_sqlite_options(&db_path))
        .await
        .map_err(|err| err.to_string())?;
    if !cursor_table_exists(&mut conn, "composerHeaders").await? {
        return Ok(CursorSessionMetadata::default());
    }
    let Some(row) = sqlx::query(
        "SELECT CAST(createdAt AS REAL) AS created_at,
                CAST(lastUpdatedAt AS REAL) AS updated_at,
                value
         FROM composerHeaders
         WHERE composerId = ?1
         LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&mut conn)
    .await
    .map_err(|err| err.to_string())?
    else {
        return Ok(CursorSessionMetadata::default());
    };
    let value = row.try_get::<Option<String>, _>("value").ok().flatten();
    let value_json = value
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());

    Ok(CursorSessionMetadata {
        title: value_json.as_ref().and_then(cursor_title_from_state_value),
        created_at: row
            .try_get::<Option<f64>, _>("created_at")
            .ok()
            .flatten()
            .and_then(normalize_unix_timestamp_millis),
        updated_at: row
            .try_get::<Option<f64>, _>("updated_at")
            .ok()
            .flatten()
            .and_then(normalize_unix_timestamp_millis),
        cwd: value_json
            .as_ref()
            .and_then(cursor_workspace_from_state_value),
    })
}

pub(super) async fn cursor_table_exists(
    conn: &mut SqliteConnection,
    table: &str,
) -> Result<bool, String> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM sqlite_master
         WHERE type = 'table' AND name = ?1",
    )
    .bind(table)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

pub(super) fn merge_cursor_metadata(
    target: &mut CursorSessionMetadata,
    source: CursorSessionMetadata,
) {
    if target.title.is_none() {
        target.title = source.title;
    }
    if target.created_at.is_none() {
        target.created_at = source.created_at;
    }
    if target.updated_at.is_none() {
        target.updated_at = source.updated_at;
    }
    if target.cwd.is_none() {
        target.cwd = source.cwd;
    }
}

pub(super) fn cursor_metadata_is_empty(metadata: &CursorSessionMetadata) -> bool {
    metadata.title.is_none()
        && metadata.created_at.is_none()
        && metadata.updated_at.is_none()
        && metadata.cwd.is_none()
}

pub(super) fn apply_cursor_metadata_to_computation(
    computed: &mut CachedSessionComputation,
    metadata: &CursorSessionMetadata,
) {
    if computed.title == computed.session_id {
        if let Some(title) = metadata.title.as_ref().filter(|title| !title.is_empty()) {
            computed.title = title.clone();
        }
    }
    if let Some(created_at) = metadata.created_at {
        computed.created_at = created_at;
    }
    if let Some(updated_at) = metadata.updated_at.or(metadata.created_at) {
        computed.updated_at = updated_at.max(computed.created_at);
    }
}

pub(super) fn cursor_title_from_state_value(value: &Value) -> Option<String> {
    ["name", "title", "conversationTitle"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .and_then(|title| trim_optional_string(Some(title.to_string())))
}

pub(super) fn cursor_workspace_from_state_value(value: &Value) -> Option<String> {
    [
        "/workspaceIdentifier/uri/fsPath",
        "/workspaceIdentifier/fsPath",
        "/workspaceFolder/uri/fsPath",
        "/workspaceFolder/fsPath",
        "/workspace/uri/fsPath",
        "/workspacePath",
        "/cwd",
    ]
    .into_iter()
    .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
    .and_then(|path| trim_optional_string(Some(path.to_string())))
}

pub(super) fn trim_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn cline_task_dir(path: &Path) -> Option<&Path> {
    path.parent()
}

pub(super) fn cline_task_id_from_path(path: &Path) -> Option<String> {
    cline_task_dir(path)?
        .file_name()
        .map(|name| name.to_string_lossy().trim().to_string())
        .filter(|id| !id.is_empty())
}

pub(super) fn cline_sibling_json(path: &Path, names: &[&str]) -> Option<Value> {
    let task_dir = cline_task_dir(path)?;
    names.iter().find_map(|name| {
        fs::read_to_string(task_dir.join(name))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    })
}

pub(super) fn cline_metadata_value(path: &Path) -> Option<Value> {
    cline_sibling_json(path, &["task_metadata.json", "metadata.json"])
}

pub(super) fn cline_string_by_keys(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|value| {
            value
                .as_str()
                .or_else(|| value.get("id").and_then(Value::as_str))
                .or_else(|| value.get("value").and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
}

pub(super) fn cline_workspace_from_path(path: &Path) -> Option<String> {
    cline_metadata_value(path)
        .as_ref()
        .and_then(extract_cwd)
        .or_else(|| cline_workspace_from_api_history(path))
}

pub(super) fn cline_workspace_from_api_history(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    cline_api_message_values(&value)
        .into_iter()
        .find_map(|message| {
            let text = extract_content(message)?;
            extract_simple_tag_block(&text, "current_working_directory")
                .map(str::trim)
                .filter(|cwd| !cwd.is_empty())
                .map(str::to_string)
        })
}

pub(super) fn cline_session_id_from_path(path: &Path) -> Option<String> {
    cline_metadata_value(path)
        .as_ref()
        .and_then(|meta| cline_string_by_keys(meta, &["taskId", "task_id", "id"]))
        .or_else(|| cline_task_id_from_path(path))
}

pub(super) fn cline_title_from_path(path: &Path) -> Option<String> {
    cline_metadata_value(path)
        .as_ref()
        .and_then(|meta| cline_string_by_keys(meta, &["task", "title", "summary", "name"]))
}

pub(super) fn cline_model_from_path(path: &Path) -> Option<String> {
    cline_metadata_value(path).as_ref().and_then(|meta| {
        extract_model(meta).or_else(|| {
            cline_string_by_keys(
                meta,
                &["modelId", "model_id", "apiModelId", "api_model_id", "model"],
            )
        })
    })
}

pub(super) fn cline_project_key_from_path(path: &Path) -> String {
    cline_workspace_from_path(path)
        .as_deref()
        .and_then(project_key_from_cwd)
        .or_else(|| cline_task_id_from_path(path))
        .unwrap_or_else(|| "cline".to_string())
}

pub(super) fn cline_api_message_values(value: &Value) -> Vec<&Value> {
    value
        .as_array()
        .or_else(|| value.get("messages").and_then(Value::as_array))
        .map(|messages| messages.iter().collect())
        .unwrap_or_default()
}

pub(super) fn cline_api_message_count(value: &Value) -> Option<usize> {
    value
        .as_array()
        .or_else(|| value.get("messages").and_then(Value::as_array))
        .map(Vec::len)
}

pub(super) fn cline_ui_timestamps(path: &Path) -> Vec<Option<String>> {
    cline_sibling_json(path, &["ui_messages.json"])
        .and_then(|value| {
            value.as_array().map(|items| {
                items
                    .iter()
                    .map(|item| {
                        extract_timestamp(item).or_else(|| {
                            item.get("ts")
                                .and_then(parse_timestamp_millis_value)
                                .and_then(timestamp_millis_to_rfc3339)
                        })
                    })
                    .collect()
            })
        })
        .unwrap_or_default()
}
