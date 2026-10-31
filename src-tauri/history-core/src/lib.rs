use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const PARSER_VERSION: u32 = 4;
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
    // 饱和累加输入、输出和两类缓存 Token，避免计数溢出回绕。
    pub fn total(self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
    }

    // 将一条用量逐字段饱和累加到当前统计，不在这里做去重或累计值转增量。
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
pub struct RemoteHistoryMessagePart {
    pub kind: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistoryMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<RemoteHistoryMessagePart>,
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

// 将一条完整 JSONL 记录累积到摘要状态；坏 JSON 跳过，元数据首次命中后保留。
// Codex 累计用量转为饱和差值，其他来源按消息/请求键去重；消息数量不随用量去重撤回。
// 用量明细达到上限后仅按物理行号间隔合并到末项，完整总量仍独立累计。
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
    if let Some((role, content, _)) = parse_message(&value) {
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

// 由已有解析状态生成 SSH 摘要和远程原文定位符，不读写文件，也不把 artifact 当本地路径。
// 标题优先首条用户文本；主模型按出现次数选择，同票时取字典序较小者。
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

// 顺序解析传入记录，保留物理行索引，提取消息、分块和文件变更，并复用摘要累计逻辑。
// 单条消息/分块按字符截断；不限制传入记录总数，也不负责远程身份或文件访问校验。
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
        if let Some((role, content, parts)) = parse_message(&value) {
            messages.push(RemoteHistoryMessage {
                role,
                content: truncate_chars(&content, CONTENT_LIMIT),
                parts: parts
                    .into_iter()
                    .map(|mut part| {
                        part.content = truncate_chars(&part.content, CONTENT_LIMIT);
                        part
                    })
                    .collect(),
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

// 裁剪空白、统一斜杠并去掉非根路径的尾斜杠；不解析 ..、符号链接或文件系统身份。
pub fn normalize_remote_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

// 用 cwd 的路径段前缀或不区分大小写的 Claude 项目键匹配范围；只作筛选，不作访问授权。
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

// 将规范化路径中的斜杠替换为短横线，构造兼容 Claude 目录命名的比较键。
pub fn claude_project_key(path: &str) -> String {
    normalize_remote_path(path).replace('/', "-")
}

// 识别 Claude user/assistant 及 Codex 用户事件/消息记录，统一角色、平铺文本和结构分块。
// 没有可提取文本的记录返回 None；Claude 用户记录若全部是工具结果则归为 tool。
fn parse_message(value: &Value) -> Option<(String, String, Vec<RemoteHistoryMessagePart>)> {
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
        let content_value = message.get("content")?;
        let mut role = normalize_role(role);
        if role == "user" && content_items_are_tool_results(content_value) {
            role = "tool".to_string();
        }
        let content = content_text(content_value)?;
        let parts = content_parts(content_value, &role, &content);
        return Some((role, content, parts));
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
        let role = "user".to_string();
        let parts = vec![fallback_part(&role, &content)];
        return Some((role, content, parts));
    }
    if root_type == "response_item" && payload_type == "message" {
        let role = payload
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("assistant");
        let role = normalize_role(role);
        let content_value = payload.get("content")?;
        let content = content_text(content_value)?;
        let parts = content_parts(content_value, &role, &content);
        return Some((role, content, parts));
    }
    None
}

// 从字符串或常见内容字段提取文本，数组项以换行拼接；不直接序列化任意对象为正文。
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

// 仅当内容是非空数组且每项都标为工具结果时成立，避免把混合用户消息改成工具角色。
fn content_items_are_tool_results(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        !items.is_empty()
            && items.iter().all(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("tool_result" | "toolResult")
                )
            })
    })
}

// 通过已知上下文标题/XML 标记启发式识别注入说明，仅影响显示分类，不执行或信任其内容。
fn injected_prompt(content: &str) -> bool {
    let lower = content.trim_start().to_ascii_lowercase();
    let first_line = lower
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches('#')
        .trim();
    first_line.starts_with("agents.md instructions for ")
        || first_line.starts_with("base directory for this skill:")
        || first_line.starts_with("base directory for this skill ")
        || first_line.starts_with("system prompt")
        || first_line.starts_with("developer instructions")
        || lower.starts_with("<system-reminder")
        || lower.starts_with("<codex_internal_context")
        || lower.starts_with("<session-context")
        || lower.contains("<skills_instructions")
        || lower.contains("<permissions instructions")
        || lower.contains("<environment_context>")
        || lower.contains("<collaboration_mode>")
        || lower.contains("<workflow-state:")
        || lower.contains("### available skills")
}

// 注入上下文优先显示为 system，其余按消息角色映射无明确类型的分块。
fn fallback_part_kind(role: &str, content: &str) -> &'static str {
    if injected_prompt(content) {
        return "system";
    }
    match role {
        "user" | "assistant" => "text",
        "tool" => "tool_result",
        "system" => "system",
        _ => "unknown",
    }
}

// 将平铺正文包装成一个兜底分块，不伪造工具名称或调用 ID。
fn fallback_part(role: &str, content: &str) -> RemoteHistoryMessagePart {
    RemoteHistoryMessagePart {
        kind: fallback_part_kind(role, content).to_string(),
        content: content.to_string(),
        tool_name: None,
        call_id: None,
    }
}

// 统一不同来源的推理/工具/系统类型别名；缺失类型按角色回退，未知显式类型保留为 unknown。
fn part_kind(value: &Value, role: &str, content: &str) -> &'static str {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .replace('-', "_");
    match kind.as_str() {
        "text" | "input_text" | "output_text" => fallback_part_kind(role, content),
        "thinking" | "reasoning" | "reasoning_summary" | "analysis" => "reasoning",
        "tool_use" | "tool_call" | "toolcall" | "function_call" | "custom_tool_call"
        | "mcp_tool_call" => "tool_call",
        "tool_result"
        | "toolresult"
        | "function_call_output"
        | "custom_tool_call_output"
        | "mcp_tool_call_output" => "tool_result",
        "system" | "developer" => "system",
        "metadata" | "session_meta" | "turn_context" => "metadata",
        "" => fallback_part_kind(role, content),
        _ => "unknown",
    }
}

// 按别名优先级取首个字符串并裁剪；首个字符串为空时返回 None，不继续改取后续别名。
fn part_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

// 优先提取普通文本，再尝试推理/工具参数和结果；非字符串工具载荷转为 JSON 文本展示。
fn part_content(value: &Value) -> Option<String> {
    content_text(value).or_else(|| {
        [
            "thinking",
            "reasoning",
            "input",
            "arguments",
            "output",
            "result",
        ]
        .into_iter()
        .filter_map(|key| value.get(key))
        .find_map(|payload| match payload {
            Value::String(text) => non_empty(text),
            other => serde_json::to_string(other)
                .ok()
                .and_then(|text| non_empty(&text)),
        })
    })
}

// 保持内容项顺序构建有正文的分块，提取工具名/调用 ID；全无可用项时包装平铺正文。
fn content_parts(value: &Value, role: &str, flat_content: &str) -> Vec<RemoteHistoryMessagePart> {
    let values: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let parts: Vec<RemoteHistoryMessagePart> = values
        .into_iter()
        .filter_map(|part| {
            let content = part_content(part)?;
            Some(RemoteHistoryMessagePart {
                kind: part_kind(part, role, &content).to_string(),
                content,
                tool_name: part_string(part, &["name", "tool_name", "toolName"]),
                call_id: part_string(
                    part,
                    &["call_id", "callId", "tool_use_id", "toolUseId", "id"],
                ),
            })
        })
        .collect();
    if parts.is_empty() {
        vec![fallback_part(role, flat_content)]
    } else {
        parts
    }
}

// 在有深度上限的 JSON 搜索中找到 usage 对象，再按兼容字段名读取四类用量，缺值记零。
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

// 只读取 Codex token_count 的 total_token_usage 累计字段，差值计算交给摘要状态处理。
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

// 由 message.id 与请求 ID 组成去重键；两者都为空或没有 message 时不提供去重身份。
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

// 从工具输入提取路径、替换文本或 patch；Codex 非 JSON 参数按原始 patch 文本处理。
// 每条记录最多返回一项变更，路径不做文件访问校验，传入的消息索引/时间戳原样关联。
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

// 从 Codex Update/Add/Delete File 标记取首个非空路径；不解析 Unified Diff 的路径头。
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

// 按行首 +/- 粗略统计增删，排除 +++/--- 文件头；不验证 patch 是否完整或可应用。
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

// 先查本层候选键，再深度遍历子对象/数组，返回首个非空字符串；depth 大于 5 时停止。
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

// 在深度上限内找指定键对应的首个对象，借用原 JSON；同名非对象值不作为结果。
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

// session_meta 专用记录取 payload.id；其他记录在有限深度内寻找 session_id/sessionId。
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

// 取已知时间字段的首个非空字符串，保留原格式，不把数字时间转换为文本。
fn timestamp_text(value: &Value) -> Option<String> {
    deep_string(value, &["timestamp", "created_at", "createdAt"], 0)
}

// 按字段优先级解析整数或 RFC3339 时间；整数绝对值小于阈值时按秒换算，否则按毫秒。
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

// 在 depth 不超过 5 的范围内返回首个同名字段，不筛选值类型，后续解析由调用方决定。
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

// 选首个存在的别名字段转为非负整数；浮点先截负再转换，类型不支持或无字段时记零。
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

// 按 user/human、tool、developer/system 子串的优先级统一角色，其余回退为 assistant。
fn normalize_role(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if lower.contains("user") || lower.contains("human") {
        "user".to_string()
    } else if lower.contains("tool") {
        "tool".to_string()
    } else if lower.contains("developer") || lower.contains("system") {
        "system".to_string()
    } else {
        "assistant".to_string()
    }
}

// 当现有文本未达阈值时追加换行和截取内容；现有长度按字节算，新增截取按字符算。
// 因此 SEARCH_TEXT_LIMIT 不是多字节文本的严格字节上限。
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

// 去掉首尾空白后按 Unicode 字符数截取标题摘要，不追加省略号。
fn excerpt(value: &str, limit: usize) -> String {
    truncate_chars(value.trim(), limit)
}

// 按 Unicode 标量值取前 limit 项，保持 UTF-8 合法；不保证字素簇或显示宽度完整。
fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

// 裁剪首尾空白并返回拥有所有权的非空字符串，空内容转为 None。
fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_jsonl_line, parse_detail, path_matches_scope, ParserState, RemoteHistoryMessage,
    };

    #[test]
    // 验证重复 Claude 消息/请求身份不会重复累计用量。
    fn claude_duplicate_usage_is_counted_once() {
        let line = r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","role":"assistant","content":"ok","usage":{"input_tokens":10,"output_tokens":2}}}"#;
        let mut state = ParserState::default();
        apply_jsonl_line(&mut state, "claude", line, 0);
        apply_jsonl_line(&mut state, "claude", line, 1);
        assert_eq!(state.usage.input_tokens, 10);
        assert_eq!(state.usage.output_tokens, 2);
    }

    #[test]
    // 验证 Codex 累计值先缩小再增长时，不回退高水位或重复统计已计部分。
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
    // 验证详情采用真实会话 ID，并保留远程 artifact 定位键而非伪造本地路径。
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
    // 验证远程推理、正文及工具调用分块保持顺序和类型，并保留工具名。
    fn detail_preserves_remote_message_part_kinds() {
        let detail = parse_detail(
            "claude",
            "instance",
            "artifact",
            "fallback",
            "project",
            1,
            2,
            3,
            vec![r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"inspect"},{"type":"text","text":"done"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"README.md"}}]}}"#.to_string()],
        );

        assert_eq!(detail.messages[0].parts.len(), 3);
        assert_eq!(detail.messages[0].parts[0].kind, "reasoning");
        assert_eq!(detail.messages[0].parts[1].kind, "text");
        assert_eq!(detail.messages[0].parts[2].kind, "tool_call");
        assert_eq!(
            detail.messages[0].parts[2].tool_name.as_deref(),
            Some("Read")
        );
    }

    #[test]
    // 验证旧载荷缺少 parts 字段时仍可反序列化，默认使用空分块列表。
    fn old_remote_message_payload_defaults_parts_to_empty() {
        let message: RemoteHistoryMessage = serde_json::from_str(
            r#"{"role":"user","content":"hello","timestamp":null,"model":null,"inputTokens":null,"outputTokens":null,"cacheReadTokens":null,"cacheCreationTokens":null,"lineIndex":0}"#,
        )
        .unwrap();

        assert!(message.parts.is_empty());
    }

    #[test]
    // 验证 Codex developer 消息的角色及分块均按 system 展示。
    fn developer_messages_are_normalized_as_system() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>internal context</skills_instructions>"}]}}"#;
        let detail = parse_detail(
            "codex",
            "instance",
            "artifact",
            "fallback",
            "project",
            1,
            2,
            3,
            vec![line.to_string()],
        );

        assert_eq!(detail.messages[0].role, "system");
        assert_eq!(detail.messages[0].parts[0].kind, "system");
    }

    #[test]
    // 验证用户角色携带的 Codex 权限/技能上下文可识别为系统分块。
    fn embedded_codex_context_is_classified_as_system_part() {
        let detail = parse_detail(
            "codex",
            "instance",
            "artifact",
            "fallback",
            "project",
            1,
            2,
            3,
            vec![r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<permissions instructions>internal context</permissions instructions>\n### Available skills\n- browser"}]}}"#.to_string()],
        );

        assert_eq!(detail.messages[0].parts[0].kind, "system");
    }

    #[test]
    // 验证 Claude 技能目录提示不会被当作普通用户正文分块。
    fn skill_directory_context_is_classified_as_system_part() {
        let detail = parse_detail(
            "claude",
            "instance",
            "artifact",
            "fallback",
            "project",
            1,
            2,
            3,
            vec![r#"{"type":"user","message":{"role":"user","content":"Base directory for this skill: F:\\github\\CLI-Manager\\.claude\\skills\\trellis-update-spec\n\n# Update Code-Spec"}}"#.to_string()],
        );

        assert_eq!(detail.messages[0].parts[0].kind, "system");
    }

    #[test]
    // 验证工作树 cwd 或 Claude 编码项目键可匹配项目，其他项目路径不匹配。
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
