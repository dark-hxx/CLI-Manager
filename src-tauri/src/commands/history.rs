use log::debug;
use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct SessionFileRef {
    source: String,
    project_key: String,
    path: PathBuf,
}

#[derive(Clone)]
struct SessionSummaryScan {
    message_count: usize,
    first_user_message: Option<String>,
    first_message: Option<String>,
    branch: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionSummary {
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub title: String,
    pub file_path: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
    pub branch: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionDetail {
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub title: String,
    pub file_path: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
    pub branch: Option<String>,
    pub messages: Vec<HistoryMessage>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchResult {
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub title: String,
    pub file_path: String,
    pub role: String,
    pub snippet: String,
    pub timestamp: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPromptItem {
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub file_path: String,
    pub session_title: String,
    pub updated_at: i64,
    pub message_index: usize,
    pub prompt: String,
    pub timestamp: Option<String>,
}

#[tauri::command]
pub async fn history_list_sessions(
    source: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    let files = collect_session_files(source.as_deref());
    let query_lower = query
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty());
    let mut sessions = Vec::new();

    for file_ref in files {
        let summary = build_session_summary(&file_ref);
        if let Some(q) = &query_lower {
            let title = summary.title.to_lowercase();
            let session_id = summary.session_id.to_lowercase();
            let project = summary.project_key.to_lowercase();
            let source_name = summary.source.to_lowercase();
            let branch = summary
                .branch
                .as_ref()
                .map(|v| v.to_lowercase())
                .unwrap_or_default();
            if !title.contains(q)
                && !session_id.contains(q)
                && !project.contains(q)
                && !source_name.contains(q)
                && !branch.contains(q)
            {
                continue;
            }
        }
        sessions.push(summary);
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    if let Some(max) = limit {
        sessions.truncate(max);
    }
    Ok(sessions)
}

#[tauri::command]
pub async fn history_get_session(
    file_path: String,
    source: String,
    project_key: String,
) -> Result<HistorySessionDetail, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("Session file not found: {file_path}"));
    }
    let file_ref = SessionFileRef {
        source,
        project_key,
        path,
    };
    build_session_detail(&file_ref)
}

#[tauri::command]
pub async fn history_search(
    query: String,
    source: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistorySearchResult>, String> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Ok(Vec::new());
    }

    let max_hits = limit.unwrap_or(100).max(1);
    let files = collect_session_files(source.as_deref());
    let mut hits = Vec::new();

    for file_ref in files {
        let detail = match build_session_detail(&file_ref) {
            Ok(detail) => detail,
            Err(err) => {
                debug!(
                    "history_search skip unreadable file: path={}, err={}",
                    file_ref.path.to_string_lossy(),
                    err
                );
                continue;
            }
        };

        for msg in detail.messages {
            if !msg.content.to_lowercase().contains(&normalized_query) {
                continue;
            }
            hits.push(HistorySearchResult {
                session_id: detail.session_id.clone(),
                source: detail.source.clone(),
                project_key: detail.project_key.clone(),
                title: detail.title.clone(),
                file_path: detail.file_path.clone(),
                role: msg.role,
                snippet: excerpt(&msg.content, 180),
                timestamp: msg.timestamp,
            });
            if hits.len() >= max_hits {
                return Ok(hits);
            }
        }
    }

    Ok(hits)
}

#[tauri::command]
pub async fn history_list_prompts(
    scope: Option<String>,
    source: Option<String>,
    project_key: Option<String>,
    file_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistoryPromptItem>, String> {
    let scope = scope
        .as_deref()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "global".to_string());
    let target_project = project_key
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let target_file = file_path
        .map(|v| v.trim().replace('\\', "/").to_lowercase())
        .filter(|v| !v.is_empty());
    let normalized_query = query
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty());
    let max_items = limit.unwrap_or(200).clamp(1, 2000);
    let files = collect_session_files(source.as_deref());
    let mut prompts = Vec::new();

    for file_ref in files {
        if let Some(project) = &target_project {
            if &file_ref.project_key != project {
                continue;
            }
        }

        if scope == "session" {
            let Some(target) = target_file.as_ref() else {
                continue;
            };
            let current = path_to_key(&file_ref.path).to_lowercase();
            if &current != target {
                continue;
            }
        }

        let detail = match build_session_detail(&file_ref) {
            Ok(detail) => detail,
            Err(err) => {
                debug!(
                    "history_list_prompts skip unreadable file: path={}, err={}",
                    file_ref.path.to_string_lossy(),
                    err
                );
                continue;
            }
        };
        let session_id = detail.session_id;
        let source = detail.source;
        let project_key = detail.project_key;
        let file_path = detail.file_path;
        let session_title = detail.title;
        let updated_at = detail.updated_at;

        for (message_index, msg) in detail.messages.into_iter().enumerate() {
            if msg.role != "user" {
                continue;
            }
            let prompt = normalize_text(&msg.content);
            if prompt.is_empty() {
                continue;
            }
            if let Some(q) = &normalized_query {
                let prompt_lower = prompt.to_lowercase();
                let title_lower = session_title.to_lowercase();
                if !prompt_lower.contains(q) && !title_lower.contains(q) {
                    continue;
                }
            }
            prompts.push(HistoryPromptItem {
                session_id: session_id.clone(),
                source: source.clone(),
                project_key: project_key.clone(),
                file_path: file_path.clone(),
                session_title: session_title.clone(),
                updated_at,
                message_index,
                prompt,
                timestamp: msg.timestamp,
            });
            if prompts.len() >= max_items {
                break;
            }
        }

        if prompts.len() >= max_items {
            break;
        }
    }

    prompts.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then(b.message_index.cmp(&a.message_index))
    });
    Ok(prompts)
}

fn build_session_summary(file_ref: &SessionFileRef) -> HistorySessionSummary {
    let (created_at, updated_at) = file_timestamps(&file_ref.path);
    let scan = scan_session_summary(&file_ref.path);
    let session_id = file_ref
        .path
        .file_stem()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown-session".to_string());
    let title = scan
        .first_user_message
        .or(scan.first_message)
        .map(|text| excerpt(&text, 80))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| session_id.clone());

    HistorySessionSummary {
        session_id,
        source: file_ref.source.clone(),
        project_key: file_ref.project_key.clone(),
        title,
        file_path: file_ref.path.to_string_lossy().to_string(),
        created_at,
        updated_at,
        message_count: scan.message_count,
        branch: scan.branch,
    }
}

fn build_session_detail(file_ref: &SessionFileRef) -> Result<HistorySessionDetail, String> {
    let (created_at, updated_at) = file_timestamps(&file_ref.path);
    let messages = read_session_messages(&file_ref.path)?;
    let message_count = messages.len();
    let mut first_user = None;
    let mut first_any = None;

    for msg in &messages {
        if first_any.is_none() && !msg.content.trim().is_empty() {
            first_any = Some(msg.content.clone());
        }
        if first_user.is_none() && msg.role == "user" && !msg.content.trim().is_empty() {
            first_user = Some(msg.content.clone());
        }
        if first_any.is_some() && first_user.is_some() {
            break;
        }
    }

    let branch = read_branch_hint(&file_ref.path);
    let session_id = file_ref
        .path
        .file_stem()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown-session".to_string());
    let title = first_user
        .or(first_any)
        .map(|text| excerpt(&text, 80))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| session_id.clone());

    Ok(HistorySessionDetail {
        session_id,
        source: file_ref.source.clone(),
        project_key: file_ref.project_key.clone(),
        title,
        file_path: file_ref.path.to_string_lossy().to_string(),
        created_at,
        updated_at,
        message_count,
        branch,
        messages,
    })
}

fn collect_session_files(source_filter: Option<&str>) -> Vec<SessionFileRef> {
    let Some(home) = detect_home_dir() else {
        return Vec::new();
    };
    let mut files = Vec::new();
    let source_filter = source_filter.map(|v| v.to_lowercase());

    if source_filter
        .as_ref()
        .map(|v| v == "claude")
        .unwrap_or(true)
    {
        files.extend(collect_claude_session_files(&home));
    }
    if source_filter.as_ref().map(|v| v == "codex").unwrap_or(true) {
        files.extend(collect_codex_session_files(&home));
    }

    files
}

fn collect_claude_session_files(home: &Path) -> Vec<SessionFileRef> {
    let root = home.join(".claude").join("projects");
    if !root.exists() {
        return Vec::new();
    }

    let mut results = Vec::new();
    for entry in read_dir_entries(&root) {
        let path = entry.path();
        if path.is_dir() {
            let project_key = entry.file_name().to_string_lossy().to_string();
            let mut files = Vec::new();
            collect_files_recursive(&path, &mut files, &|file_path| is_jsonl(file_path));
            for file_path in files {
                results.push(SessionFileRef {
                    source: "claude".to_string(),
                    project_key: project_key.clone(),
                    path: file_path,
                });
            }
        } else if is_jsonl(&path) {
            results.push(SessionFileRef {
                source: "claude".to_string(),
                project_key: "default".to_string(),
                path,
            });
        }
    }

    results
}

fn collect_codex_session_files(home: &Path) -> Vec<SessionFileRef> {
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_files_recursive(&root, &mut files, &|file_path| {
        if !is_jsonl(file_path) {
            return false;
        }
        let name = file_path
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_default();
        name.starts_with("rollout-")
    });

    files
        .into_iter()
        .map(|path| {
            let project_key = path
                .parent()
                .and_then(|parent| parent.strip_prefix(&root).ok())
                .map(path_to_key)
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "sessions".to_string());
            SessionFileRef {
                source: "codex".to_string(),
                project_key,
                path,
            }
        })
        .collect()
}

fn collect_files_recursive(
    dir: &Path,
    output: &mut Vec<PathBuf>,
    predicate: &dyn Fn(&Path) -> bool,
) {
    for entry in read_dir_entries(dir) {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, output, predicate);
        } else if predicate(&path) {
            output.push(path);
        }
    }
}

fn read_dir_entries(dir: &Path) -> Vec<fs::DirEntry> {
    match fs::read_dir(dir) {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .map(|v| v.to_string_lossy().eq_ignore_ascii_case("jsonl"))
        .unwrap_or(false)
}

fn detect_home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
}

fn path_to_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn scan_session_summary(path: &Path) -> SessionSummaryScan {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            return SessionSummaryScan {
                message_count: 0,
                first_user_message: None,
                first_message: None,
                branch: None,
            }
        }
    };

    let mut message_count = 0usize;
    let mut first_user_message = None;
    let mut first_message = None;
    let mut branch = None;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        if branch.is_none() {
            branch = extract_branch(&value);
        }
        if let Some(msg) = parse_message(&value) {
            message_count += 1;
            if first_message.is_none() {
                first_message = Some(msg.content.clone());
            }
            if first_user_message.is_none() && msg.role == "user" {
                first_user_message = Some(msg.content);
            }
        }
    }

    SessionSummaryScan {
        message_count,
        first_user_message,
        first_message,
        branch,
    }
}

fn read_branch_hint(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(200) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(branch) = extract_branch(&value) {
            return Some(branch);
        }
    }
    None
}

fn read_session_messages(path: &Path) -> Result<Vec<HistoryMessage>, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut messages = Vec::new();

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(msg) = parse_message(&value) {
            messages.push(msg);
        }
    }

    Ok(messages)
}

fn parse_message(value: &Value) -> Option<HistoryMessage> {
    if let Some(root_type) = value.get("type").and_then(Value::as_str) {
        if root_type == "response_item" {
            let payload = value.get("payload");
            let payload_type = payload
                .and_then(|v| v.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if payload_type == "message" {
                if let Some(payload_value) = payload {
                    return parse_message(payload_value);
                }
                return None;
            }

            if matches!(payload_type, "custom_tool_call" | "tool_call" | "function_call") {
                if let Some(payload_value) = payload {
                    if let Some(message) = parse_message(payload_value) {
                        if looks_like_patch(&message.content) {
                            return Some(message);
                        }
                    }
                }
            }
            return None;
        } else if root_type == "file-history-snapshot" {
            let content = extract_content(value)?;
            if !looks_like_patch(&content) {
                return None;
            }
            return Some(HistoryMessage {
                role: "tool".to_string(),
                content,
                timestamp: extract_timestamp(value),
            });
        } else if matches!(
            root_type,
            "event_msg"
                | "turn_context"
                | "session_meta"
                | "system"
                | "summary"
        ) {
            return None;
        }
    }

    if let Some(payload) = value.get("payload") {
        if let Some(message) = parse_message(payload) {
            return Some(message);
        }
    }

    let role = extract_role(value).unwrap_or_else(|| "assistant".to_string());
    let content = extract_content(value)?;
    if content.trim().is_empty() {
        return None;
    }
    let timestamp = extract_timestamp(value);

    Some(HistoryMessage {
        role,
        content,
        timestamp,
    })
}

fn extract_role(value: &Value) -> Option<String> {
    let candidates = [
        value.get("role").and_then(Value::as_str),
        value.get("type").and_then(Value::as_str),
        value
            .get("message")
            .and_then(|v| v.get("role"))
            .and_then(Value::as_str),
        value
            .get("author")
            .and_then(|v| v.get("role"))
            .and_then(Value::as_str),
    ];

    for role in candidates.into_iter().flatten() {
        let lower = role.to_lowercase();
        if lower.contains("user") {
            return Some("user".to_string());
        }
        if lower.contains("assistant") || lower == "model" {
            return Some("assistant".to_string());
        }
        if lower.contains("system") {
            return Some("system".to_string());
        }
        if lower.contains("tool") {
            return Some("tool".to_string());
        }
    }
    None
}

fn extract_content(value: &Value) -> Option<String> {
    let candidates = [
        value.get("content"),
        value.get("text"),
        value.get("prompt"),
        value.get("input"),
        value.get("output"),
        value.get("arguments"),
        value.get("message"),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(text) = extract_text_from_value(candidate) {
            let normalized = normalize_text(&text);
            if !normalized.is_empty() {
                return Some(normalized);
            }
        }
    }
    None
}

fn extract_text_from_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(v.to_string()),
        Value::Number(v) => Some(v.to_string()),
        Value::String(v) => Some(v.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(extract_text_from_value)
                .map(|v| normalize_text(&v))
                .filter(|v| !v.is_empty())
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            let preferred_keys = [
                "text",
                "content",
                "prompt",
                "input_text",
                "output_text",
                "input",
                "output",
                "message",
                "arguments",
                "reasoning",
            ];
            for key in preferred_keys {
                if let Some(v) = map.get(key) {
                    if let Some(text) = extract_text_from_value(v) {
                        let normalized = normalize_text(&text);
                        if !normalized.is_empty() {
                            return Some(normalized);
                        }
                    }
                }
            }
            None
        }
    }
}

fn extract_timestamp(value: &Value) -> Option<String> {
    let candidates = [
        value.get("timestamp").and_then(Value::as_str),
        value.get("time").and_then(Value::as_str),
        value.get("created_at").and_then(Value::as_str),
        value.get("createdAt").and_then(Value::as_str),
        value
            .get("message")
            .and_then(|v| v.get("timestamp"))
            .and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .next()
        .map(ToString::to_string)
}

fn extract_branch(value: &Value) -> Option<String> {
    let candidates = [
        value.get("branch").and_then(Value::as_str),
        value.get("git_branch").and_then(Value::as_str),
        value.get("gitBranch").and_then(Value::as_str),
        value
            .get("context")
            .and_then(|v| v.get("branch"))
            .and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|v| !v.trim().is_empty())
        .map(ToString::to_string)
}

fn normalize_text(text: &str) -> String {
    text.replace('\u{0000}', "").trim().to_string()
}

fn looks_like_patch(text: &str) -> bool {
    text.contains("*** Begin Patch")
        || text.contains("diff --git ")
        || (text.contains("@@") && (text.contains("+++ ") || text.contains("--- ")))
}

fn excerpt(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let mut out = String::new();
    for (idx, ch) in trimmed.chars().enumerate() {
        if idx >= max_chars {
            out.push_str("...");
            return out;
        }
        out.push(ch);
    }
    out
}

fn file_timestamps(path: &Path) -> (i64, i64) {
    let metadata = fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(system_time_to_millis)
        .unwrap_or(0);
    let created_at = metadata
        .as_ref()
        .and_then(|m| m.created().ok())
        .map(system_time_to_millis)
        .unwrap_or(updated_at);
    (created_at, updated_at)
}

fn system_time_to_millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
