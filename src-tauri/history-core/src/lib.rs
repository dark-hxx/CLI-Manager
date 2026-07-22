use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const PARSER_VERSION: u32 = 1;
pub const INDEX_SCHEMA_VERSION: u32 = 2;
const SEARCH_TEXT_LIMIT: usize = 16 * 1024;
const TITLE_LIMIT: usize = 240;
const CONTENT_LIMIT: usize = 256 * 1024;
const MAX_USAGE_FACTS: usize = 20_000;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistoryRawPointer {
    pub role: String,
    pub kind: String,
    pub raw_key: String,
    #[serde(default)]
    pub line_index: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistorySessionRef {
    pub source_id: String,
    pub source_instance_id: String,
    pub source_session_id: String,
    pub transport_kind: String,
    pub raw_pointers: Vec<RemoteHistoryRawPointer>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistoryUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

impl RemoteHistoryUsage {
    pub fn total(self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
    }

    fn add_assign(&mut self, other: Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(other.cache_creation_tokens);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistoryUsageFact {
    pub event_index: usize,
    pub timestamp_ms: Option<i64>,
    pub model: Option<String>,
    pub usage: RemoteHistoryUsage,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistorySessionSummary {
    pub session_ref: RemoteHistorySessionRef,
    pub project_key: String,
    pub cwd: Option<String>,
    pub title: String,
    pub branch: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
    pub dominant_model: Option<String>,
    pub current_model: Option<String>,
    pub usage: RemoteHistoryUsage,
    pub usage_facts: Vec<RemoteHistoryUsageFact>,
    pub parser_version: u32,
    pub index_generation: u64,
    pub materialization_level: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistoryMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub line_index: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistoryFileChange {
    pub file_path: String,
    pub tool_name: Option<String>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub patch: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub message_index: Option<usize>,
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistorySessionDetail {
    pub summary: RemoteHistorySessionSummary,
    pub messages: Vec<RemoteHistoryMessage>,
    pub file_changes: Vec<RemoteHistoryFileChange>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistorySearchHit {
    pub session_ref: RemoteHistorySessionRef,
    pub project_key: String,
    pub title: String,
    pub role: String,
    pub snippet: String,
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistorySyncResult {
    pub source_instance_id: String,
    pub source: String,
    pub installation_id: String,
    pub remote_machine_id: String,
    pub ssh_user: String,
    pub configured_config_root: String,
    pub canonical_config_root: String,
    pub config_root_hash: String,
    pub generation: u64,
    pub cursor: String,
    pub has_more: bool,
    pub total_sessions: usize,
    pub freshness_state: String,
    pub as_of: i64,
    pub discovery_complete: bool,
    pub partial: bool,
    pub sessions: Vec<RemoteHistorySessionSummary>,
    pub tombstones: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParserState {
    pub source_session_id: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub first_user_message: Option<String>,
    pub first_message: Option<String>,
    pub message_count: usize,
    pub current_model: Option<String>,
    pub model_hits: BTreeMap<String, usize>,
    pub usage: RemoteHistoryUsage,
    pub usage_facts: Vec<RemoteHistoryUsageFact>,
    pub codex_high_water: RemoteHistoryUsage,
    pub seen_usage_keys: BTreeSet<String>,
    pub search_text: String,
}

pub fn apply_jsonl_line(
    state: &mut ParserState,
    source: &str,
    line: &str,
    physical_line_index: usize,
) {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return;
    };
    if state.source_session_id.is_none() {
        state.source_session_id = session_id(&value);
    }
    if state.cwd.is_none() {
        state.cwd = deep_string(&value, &["cwd", "working_directory", "workingDirectory"], 0);
    }
    if state.branch.is_none() {
        state.branch = deep_string(&value, &["gitBranch", "git_branch", "branch"], 0);
    }
    let model = deep_string(
        &value,
        &["model", "model_name", "modelName", "model_id", "modelId"],
        0,
    )
    .filter(|value| !value.starts_with('<'));
    if let Some(model) = model.as_ref() {
        *state.model_hits.entry(model.clone()).or_default() += 1;
        state.current_model = Some(model.clone());
    }
    if let Some((role, content)) = parse_message(&value) {
        state.message_count = state.message_count.saturating_add(1);
        append_search_text(&mut state.search_text, &content);
        let excerpt = excerpt(&content, TITLE_LIMIT);
        if state.first_message.is_none() && !excerpt.is_empty() {
            state.first_message = Some(excerpt.clone());
        }
        if role == "user" && state.first_user_message.is_none() && !excerpt.is_empty() {
            state.first_user_message = Some(excerpt);
        }
    }

    let timestamp_ms = timestamp_ms(&value);
    let usage = if source == "codex" {
        codex_cumulative_usage(&value).map(|current| {
            let delta = RemoteHistoryUsage {
                input_tokens: current
                    .input_tokens
                    .saturating_sub(state.codex_high_water.input_tokens),
                output_tokens: current
                    .output_tokens
                    .saturating_sub(state.codex_high_water.output_tokens),
                cache_read_tokens: current
                    .cache_read_tokens
                    .saturating_sub(state.codex_high_water.cache_read_tokens),
                cache_creation_tokens: current
                    .cache_creation_tokens
                    .saturating_sub(state.codex_high_water.cache_creation_tokens),
            };
            if current.total() >= state.codex_high_water.total() {
                state.codex_high_water = current;
            }
            delta
        })
    } else {
        usage_from_value(&value)
    };
    let Some(usage) = usage.filter(|usage| usage.total() > 0) else {
        return;
    };
    if source != "codex" {
        if let Some(key) = usage_key(&value) {
            if !state.seen_usage_keys.insert(key) {
                return;
            }
        }
    }
    state.usage.add_assign(usage);
    if state.usage_facts.len() < MAX_USAGE_FACTS {
        state.usage_facts.push(RemoteHistoryUsageFact {
            event_index: state.usage_facts.len(),
            timestamp_ms,
            model: model.or_else(|| state.current_model.clone()),
            usage,
        });
    } else if physical_line_index % 100 == 0 {
        if let Some(last) = state.usage_facts.last_mut() {
            last.usage.add_assign(usage);
        }
    }
}

pub fn build_summary(
    state: &ParserState,
    source: &str,
    source_instance_id: &str,
    artifact_id: &str,
    fallback_session_id: &str,
    project_key: &str,
    created_at: i64,
    updated_at: i64,
    index_generation: u64,
) -> RemoteHistorySessionSummary {
    let source_session_id = state
        .source_session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_session_id)
        .to_string();
    let title = state
        .first_user_message
        .clone()
        .or_else(|| state.first_message.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| source_session_id.clone());
    let dominant_model = state
        .model_hits
        .iter()
        .max_by(|left, right| left.1.cmp(right.1).then_with(|| right.0.cmp(left.0)))
        .map(|(model, _)| model.clone());
    RemoteHistorySessionSummary {
        session_ref: RemoteHistorySessionRef {
            source_id: source.to_string(),
            source_instance_id: source_instance_id.to_string(),
            source_session_id,
            transport_kind: "ssh".to_string(),
            raw_pointers: vec![RemoteHistoryRawPointer {
                role: "primaryTranscript".to_string(),
                kind: "remoteJsonl".to_string(),
                raw_key: artifact_id.to_string(),
                line_index: None,
            }],
        },
        project_key: project_key.to_string(),
        cwd: state.cwd.clone(),
        title,
        branch: state.branch.clone(),
        created_at,
        updated_at,
        message_count: state.message_count,
        dominant_model,
        current_model: state.current_model.clone(),
        usage: state.usage,
        usage_facts: state.usage_facts.clone(),
        parser_version: PARSER_VERSION,
        index_generation,
        materialization_level: "summary".to_string(),
    }
}

pub fn parse_detail(
    source: &str,
    source_instance_id: &str,
    artifact_id: &str,
    fallback_session_id: &str,
    project_key: &str,
    created_at: i64,
    updated_at: i64,
    index_generation: u64,
    lines: impl IntoIterator<Item = String>,
) -> RemoteHistorySessionDetail {
    let mut state = ParserState::default();
    let mut messages = Vec::new();
    let mut file_changes = Vec::new();
    for (line_index, line) in lines.into_iter().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let message_index = messages.len();
        if let Some((role, content)) = parse_message(&value) {
            messages.push(RemoteHistoryMessage {
                role,
                content: truncate_chars(&content, CONTENT_LIMIT),
                timestamp: timestamp_text(&value),
                model: deep_string(
                    &value,
                    &["model", "model_name", "modelName", "model_id", "modelId"],
                    0,
                ),
                input_tokens: usage_from_value(&value).map(|usage| usage.input_tokens),
                output_tokens: usage_from_value(&value).map(|usage| usage.output_tokens),
                cache_read_tokens: usage_from_value(&value).map(|usage| usage.cache_read_tokens),
                cache_creation_tokens: usage_from_value(&value)
                    .map(|usage| usage.cache_creation_tokens),
                line_index,
            });
        }
        if let Some(change) = parse_file_change(&value, message_index, timestamp_text(&value)) {
            file_changes.push(change);
        }
        apply_jsonl_line(&mut state, source, &line, line_index);
    }
    RemoteHistorySessionDetail {
        summary: build_summary(
            &state,
            source,
            source_instance_id,
            artifact_id,
            fallback_session_id,
            project_key,
            created_at,
            updated_at,
            index_generation,
        ),
        messages,
        file_changes,
    }
}

pub fn normalize_remote_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

pub fn path_matches_scope(cwd: Option<&str>, project_key: &str, project_paths: &[String]) -> bool {
    let cwd = cwd.map(normalize_remote_path);
    project_paths.iter().any(|project| {
        let project = normalize_remote_path(project);
        cwd.as_ref().is_some_and(|cwd| {
            cwd == &project
                || cwd
                    .strip_prefix(&project)
                    .is_some_and(|rest| rest.starts_with('/'))
        }) || claude_project_key(&project).eq_ignore_ascii_case(project_key)
    })
}

pub fn claude_project_key(path: &str) -> String {
    normalize_remote_path(path).replace('/', "-")
}

fn parse_message(value: &Value) -> Option<(String, String)> {
    let root_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(root_type, "user" | "assistant") {
        let message = value.get("message").unwrap_or(value);
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or(root_type);
        let content = content_text(message.get("content")?)?;
        return Some((normalize_role(role), content));
    }
    let payload = value.get("payload")?;
    let payload_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if root_type == "event_msg" && payload_type == "user_message" {
        let content = payload
            .get("message")
            .or_else(|| payload.get("text"))
            .and_then(content_text)?;
        return Some(("user".to_string(), content));
    }
    if root_type == "response_item" && payload_type == "message" {
        let role = payload
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("assistant");
        let content = content_text(payload.get("content")?)?;
        return Some((normalize_role(role), content));
    }
    None
}

fn content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty(text),
        Value::Array(items) => {
            let joined = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .or_else(|| item.get("input_text"))
                        .or_else(|| item.get("output_text"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("\n");
            non_empty(&joined)
        }
        Value::Object(_) => value
            .get("text")
            .or_else(|| value.get("content"))
            .and_then(content_text),
        _ => None,
    }
}

fn usage_from_value(value: &Value) -> Option<RemoteHistoryUsage> {
    let usage = deep_object(value, "usage", 0)?;
    let input_tokens = number(usage, &["input_tokens", "inputTokens"]);
    let output_tokens = number(usage, &["output_tokens", "outputTokens"]);
    let cache_read_tokens = number(
        usage,
        &[
            "cache_read_input_tokens",
            "cache_read_tokens",
            "cached_input_tokens",
            "cacheReadTokens",
        ],
    );
    let cache_creation_tokens = number(
        usage,
        &[
            "cache_creation_input_tokens",
            "cache_creation_tokens",
            "cacheCreationTokens",
        ],
    );
    Some(RemoteHistoryUsage {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
    })
}

fn codex_cumulative_usage(value: &Value) -> Option<RemoteHistoryUsage> {
    let payload = value.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let usage = payload.get("info")?.get("total_token_usage")?;
    Some(RemoteHistoryUsage {
        input_tokens: number(usage, &["input_tokens", "inputTokens"]),
        output_tokens: number(usage, &["output_tokens", "outputTokens"]),
        cache_read_tokens: number(
            usage,
            &[
                "cached_input_tokens",
                "cache_read_tokens",
                "cacheReadTokens",
            ],
        ),
        cache_creation_tokens: number(usage, &["cache_creation_tokens", "cacheCreationTokens"]),
    })
}

fn usage_key(value: &Value) -> Option<String> {
    let message = value.get("message")?;
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let request = value
        .get("requestId")
        .or_else(|| value.get("request_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    (!id.is_empty() || !request.is_empty()).then(|| format!("{id}:{request}"))
}

fn parse_file_change(
    value: &Value,
    message_index: usize,
    timestamp: Option<String>,
) -> Option<RemoteHistoryFileChange> {
    let mut tool_name = deep_string(value, &["tool_name", "toolName", "name"], 0);
    let mut input = deep_object(value, "input", 0).cloned();
    if value.get("type").and_then(Value::as_str) == Some("response_item") {
        let payload = value.get("payload")?;
        let kind = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(kind, "function_call" | "custom_tool_call") {
            tool_name = payload
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(tool_name);
            input = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .and_then(|value| match value {
                    Value::String(raw) => serde_json::from_str(raw)
                        .ok()
                        .or_else(|| Some(serde_json::json!({ "patch": raw }))),
                    other => Some(other.clone()),
                });
        }
    }
    let input = input?;
    let patch = input
        .get("patch")
        .or_else(|| input.get("diff"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let file_path = input
        .get("file_path")
        .or_else(|| input.get("filePath"))
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| patch.as_deref().and_then(patch_path))?;
    let old_text = input
        .get("old_string")
        .or_else(|| input.get("oldText"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let new_text = input
        .get("new_string")
        .or_else(|| input.get("newText"))
        .or_else(|| input.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let (additions, deletions) = patch.as_deref().map(patch_counts).unwrap_or((
        new_text
            .as_ref()
            .map_or(0, |value| value.lines().count() as u64),
        0,
    ));
    Some(RemoteHistoryFileChange {
        file_path,
        tool_name,
        old_text,
        new_text,
        patch,
        additions,
        deletions,
        message_index: Some(message_index),
        timestamp,
    })
}

fn patch_path(patch: &str) -> Option<String> {
    patch.lines().find_map(|line| {
        line.strip_prefix("*** Update File: ")
            .or_else(|| line.strip_prefix("*** Add File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn patch_counts(patch: &str) -> (u64, u64) {
    patch.lines().fold((0, 0), |(additions, deletions), line| {
        if line.starts_with('+') && !line.starts_with("+++") {
            (additions + 1, deletions)
        } else if line.starts_with('-') && !line.starts_with("---") {
            (additions, deletions + 1)
        } else {
            (additions, deletions)
        }
    })
}

fn deep_string(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    if depth > 5 {
        return None;
    }
    match value {
        Value::Object(map) => keys
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_str).and_then(non_empty))
            .or_else(|| {
                map.values()
                    .find_map(|value| deep_string(value, keys, depth + 1))
            }),
        Value::Array(items) => items
            .iter()
            .find_map(|value| deep_string(value, keys, depth + 1)),
        _ => None,
    }
}

fn deep_object<'a>(value: &'a Value, key: &str, depth: usize) -> Option<&'a Value> {
    if depth > 5 {
        return None;
    }
    match value {
        Value::Object(map) => map.get(key).filter(|value| value.is_object()).or_else(|| {
            map.values()
                .find_map(|value| deep_object(value, key, depth + 1))
        }),
        Value::Array(items) => items
            .iter()
            .find_map(|value| deep_object(value, key, depth + 1)),
        _ => None,
    }
}

fn session_id(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) == Some("session_meta") {
        return value
            .get("payload")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .and_then(non_empty);
    }
    deep_string(value, &["session_id", "sessionId"], 0)
}

fn timestamp_text(value: &Value) -> Option<String> {
    deep_string(value, &["timestamp", "created_at", "createdAt"], 0)
}

fn timestamp_ms(value: &Value) -> Option<i64> {
    for key in ["timestamp", "created_at", "createdAt"] {
        if let Some(raw) = deep_value(value, key, 0) {
            if let Some(number) = raw.as_i64() {
                return Some(if number.abs() < 10_000_000_000 {
                    number.saturating_mul(1_000)
                } else {
                    number
                });
            }
            if let Some(text) = raw.as_str() {
                if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
                    return Some(parsed.timestamp_millis());
                }
            }
        }
    }
    None
}

fn deep_value<'a>(value: &'a Value, key: &str, depth: usize) -> Option<&'a Value> {
    if depth > 5 {
        return None;
    }
    match value {
        Value::Object(map) => map.get(key).or_else(|| {
            map.values()
                .find_map(|value| deep_value(value, key, depth + 1))
        }),
        Value::Array(items) => items
            .iter()
            .find_map(|value| deep_value(value, key, depth + 1)),
        _ => None,
    }
}

fn number(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|value| value.max(0.0) as u64))
        })
        .unwrap_or_default()
}

fn normalize_role(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if lower.contains("user") || lower.contains("human") {
        "user".to_string()
    } else if lower.contains("tool") {
        "tool".to_string()
    } else if lower.contains("system") {
        "system".to_string()
    } else {
        "assistant".to_string()
    }
}

fn append_search_text(target: &mut String, value: &str) {
    if target.len() >= SEARCH_TEXT_LIMIT {
        return;
    }
    if !target.is_empty() {
        target.push('\n');
    }
    let remaining = SEARCH_TEXT_LIMIT.saturating_sub(target.len());
    target.push_str(&truncate_chars(value, remaining));
}

fn excerpt(value: &str, limit: usize) -> String {
    truncate_chars(value.trim(), limit)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::{apply_jsonl_line, parse_detail, path_matches_scope, ParserState};

    #[test]
    fn claude_duplicate_usage_is_counted_once() {
        let line = r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","role":"assistant","content":"ok","usage":{"input_tokens":10,"output_tokens":2}}}"#;
        let mut state = ParserState::default();
        apply_jsonl_line(&mut state, "claude", line, 0);
        apply_jsonl_line(&mut state, "claude", line, 1);
        assert_eq!(state.usage.input_tokens, 10);
        assert_eq!(state.usage.output_tokens, 2);
    }

    #[test]
    fn codex_cumulative_shrink_does_not_reduce_high_water() {
        let mut state = ParserState::default();
        for line in [
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":50,"output_tokens":5}}}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"output_tokens":20}}}}"#,
        ] {
            apply_jsonl_line(&mut state, "codex", line, 0);
        }
        assert_eq!(state.usage.input_tokens, 150);
        assert_eq!(state.usage.output_tokens, 20);
    }

    #[test]
    fn detail_keeps_remote_locator_without_local_path() {
        let detail = parse_detail(
            "codex",
            "instance",
            "artifact",
            "fallback",
            "project",
            1,
            2,
            3,
            vec![
                r#"{"type":"session_meta","payload":{"id":"session-1","cwd":"/srv/app"}}"#
                    .to_string(),
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}"#
                    .to_string(),
            ],
        );
        assert_eq!(detail.summary.session_ref.source_session_id, "session-1");
        assert_eq!(
            detail.summary.session_ref.raw_pointers[0].raw_key,
            "artifact"
        );
        assert_eq!(detail.messages[0].content, "hello");
    }

    #[test]
    fn project_scope_matches_cwd_or_claude_key() {
        let projects = vec!["/srv/app".to_string()];
        assert!(path_matches_scope(
            Some("/srv/app/worktree"),
            "other",
            &projects
        ));
        assert!(path_matches_scope(None, "-srv-app", &projects));
        assert!(!path_matches_scope(Some("/srv/other"), "other", &projects));
    }
}
