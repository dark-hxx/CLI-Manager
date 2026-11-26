use super::{
    antigravity_path_parts, calculate_usage_cost, collect_tool_calls, cursor_session_id_from_path,
    extract_context_window, extract_model, extract_timestamp, extract_timestamp_millis,
    extract_u64_by_keys, fallback_history_message_part, is_synthetic_model, json_history_message,
    json_session_scan_result, parse_message, positive_usage_token, update_timestamp_bounds,
    usage_total_tokens, usage_trend_point, HistoryMessage, SessionStatsScan, SessionSummaryScan,
    SessionUsageEventScan, UsageTokenScan, READ_BUF_CAPACITY,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

// 读取 Cursor JSONL 消息并去重统计工具调用，再生成摘要与用量结果。
pub(super) fn scan_cursor_jsonl_session(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let Ok(file) = File::open(path) else {
        return empty_session_scan();
    };
    let session_id = cursor_session_id_from_path(path);
    let mut messages = Vec::new();
    let mut seen_tool_call_ids = HashSet::new();
    let mut tool_call_count = 0u64;
    let mut mcp_calls = HashMap::new();
    let mut skill_calls = HashMap::new();
    let mut builtin_calls = HashMap::new();

    for (line_index, line) in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        collect_tool_calls(
            &value,
            &mut seen_tool_call_ids,
            &mut tool_call_count,
            &mut mcp_calls,
            &mut skill_calls,
            &mut builtin_calls,
        );
        let Some(mut message) = parse_message(&value) else {
            continue;
        };
        message.line_index = Some(line_index);
        messages.push(message);
    }

    let (summary, mut stats, output_messages) =
        json_session_scan_result(session_id.as_deref(), None, messages, collect_messages);
    stats.tool_call_count = tool_call_count;
    stats.mcp_calls = mcp_calls;
    stats.skill_calls = skill_calls;
    stats.builtin_calls = builtin_calls;
    (summary, stats, output_messages)
}

struct TruncatedAntigravityMessage {
    message_idx: usize,
    line_index: usize,
    step_index: Option<i64>,
    source: String,
    event_type: String,
    is_user_input: bool,
}

fn has_truncated_content(value: &Value, raw_content: &str) -> bool {
    value
        .get("truncated_fields")
        .and_then(Value::as_array)
        .is_some_and(|fields| fields.iter().any(|field| field.as_str() == Some("content")))
        || raw_content.contains("<truncated ")
}

fn hydrate_antigravity_full_messages(
    path: &Path,
    messages: &mut [HistoryMessage],
    targets: &[TruncatedAntigravityMessage],
) {
    let Some(full_path) = super::antigravity::full_transcript_path(path) else {
        return;
    };
    let Ok(file) = File::open(full_path) else {
        return;
    };
    let mut targets_by_line: HashMap<usize, &TruncatedAntigravityMessage> =
        HashMap::with_capacity(targets.len());
    let mut max_line = 0usize;
    for target in targets {
        targets_by_line.insert(target.line_index, target);
        max_line = max_line.max(target.line_index);
    }

    for (line_index, line) in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        if line_index > max_line {
            break;
        }
        let Some(target) = targets_by_line.get(&line_index) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("status").and_then(Value::as_str) != Some("DONE") {
            continue;
        }
        if value.get("source").and_then(Value::as_str) != Some(target.source.as_str())
            || value.get("type").and_then(Value::as_str) != Some(target.event_type.as_str())
        {
            continue;
        }
        if let Some(expected_step) = target.step_index {
            if value.get("step_index").and_then(Value::as_i64) != Some(expected_step) {
                continue;
            }
        }
        let raw_full = value
            .get("content")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let full_content = if target.is_user_input {
            extract_antigravity_user_request(raw_full)
        } else {
            raw_full.to_string()
        };
        if !full_content.is_empty() {
            if let Some(msg) = messages.get_mut(target.message_idx) {
                msg.content = full_content;
                msg.parts = vec![fallback_history_message_part(&msg.role, &msg.content)];
            }
        }
    }
}

// 从 Antigravity 已完成事件提取用户和模型消息、用量与工具调用计数。
pub(super) fn scan_antigravity_jsonl_session(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let Ok(file) = File::open(path) else {
        return empty_session_scan();
    };
    let session_id = antigravity_path_parts(path).map(|(_, id)| id);
    let mut messages = Vec::new();
    let mut truncated_messages = Vec::new();
    let mut stats = SessionStatsScan::default();
    let mut seen_usage_steps = HashSet::new();
    let mut model_hits: HashMap<String, usize> = HashMap::new();
    let mut current_model: Option<String> = None;
    let mut first_timestamp_ms: Option<i64> = None;
    let mut last_timestamp_ms: Option<i64> = None;

    for (line_index, line) in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("status").and_then(Value::as_str) != Some("DONE") {
            continue;
        }
        update_timestamp_bounds(&value, &mut first_timestamp_ms, &mut last_timestamp_ms);

        for tool in value
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(name) = tool
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                stats.tool_call_count += 1;
                *stats.builtin_calls.entry(name.to_string()).or_insert(0) += 1;
            }
        }

        let source = value
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let content = value
            .get("content")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();

        let mut step_line_model: Option<String> = None;
        let mut step_message_usage: Option<UsageTokenScan> = None;
        if source == "MODEL" && event_type == "PLANNER_RESPONSE" {
            step_line_model = extract_model(&value).filter(|model| !is_synthetic_model(model));
            if let Some(model) = &step_line_model {
                *model_hits.entry(model.clone()).or_insert(0) += 1;
                current_model = Some(model.clone());
            }
            if let Some(window) = extract_context_window(&value) {
                stats.context_window = Some(window);
            }
            let usage = extract_antigravity_step_usage(&value);
            if usage_total_tokens(usage) > 0 {
                let step_index = value.get("step_index").and_then(Value::as_i64);
                let is_new_step = step_index
                    .map(|step| seen_usage_steps.insert(step))
                    .unwrap_or(true);
                if is_new_step {
                    let attributed_model =
                        step_line_model.clone().or_else(|| current_model.clone());
                    stats.input_tokens = stats.input_tokens.saturating_add(usage.input_tokens);
                    stats.output_tokens = stats.output_tokens.saturating_add(usage.output_tokens);
                    stats.cache_read_tokens = stats
                        .cache_read_tokens
                        .saturating_add(usage.cache_read_tokens);
                    stats.cache_creation_tokens = stats
                        .cache_creation_tokens
                        .saturating_add(usage.cache_creation_tokens);

                    let prompt_tokens = usage
                        .input_tokens
                        .saturating_add(usage.cache_read_tokens)
                        .saturating_add(usage.cache_creation_tokens);
                    if prompt_tokens > 0 {
                        stats.last_context_tokens = Some(prompt_tokens);
                    }
                    stats
                        .token_trend
                        .push(usage_trend_point(usage, attributed_model.clone()));

                    let cost = calculate_usage_cost(attributed_model.as_deref(), usage);
                    stats.total_cost_usd += cost.total_cost_usd;
                    stats.unpriced_tokens = stats.unpriced_tokens.saturating_add(cost.unpriced_tokens);

                    let event_index = stats.usage_events.len();
                    let event_key = step_index
                        .map(|step| format!("agy-step:{step}"))
                        .unwrap_or_else(|| {
                            format!(
                                "agy-line:{line_index}:{}:{}:{}:{}",
                                usage.input_tokens,
                                usage.output_tokens,
                                usage.cache_read_tokens,
                                usage.cache_creation_tokens
                            )
                        });
                    stats.usage_events.push(SessionUsageEventScan {
                        event_key,
                        event_index,
                        timestamp_ms: extract_timestamp_millis(&value),
                        model: attributed_model.clone(),
                        usage: cost,
                    });

                    if let Some(model) = attributed_model {
                        let entry = stats.model_usage.entry(model).or_default();
                        entry.input_tokens = entry.input_tokens.saturating_add(usage.input_tokens);
                        entry.output_tokens = entry.output_tokens.saturating_add(usage.output_tokens);
                        entry.cache_read_tokens = entry
                            .cache_read_tokens
                            .saturating_add(usage.cache_read_tokens);
                        entry.cache_creation_tokens = entry
                            .cache_creation_tokens
                            .saturating_add(usage.cache_creation_tokens);
                        entry.total_cost_usd += cost.total_cost_usd;
                        entry.unpriced_tokens =
                            entry.unpriced_tokens.saturating_add(cost.unpriced_tokens);
                    }
                    step_message_usage = Some(usage);
                }
            }
        }

        let is_user_input = event_type == "USER_INPUT";
        let message = match (source, event_type) {
            (_, "USER_INPUT") => {
                let content = extract_antigravity_user_request(content);
                (!content.is_empty()).then(|| {
                    json_history_message(
                        "user".to_string(),
                        content,
                        extract_timestamp(&value),
                        None,
                    )
                })
            }
            ("MODEL", "PLANNER_RESPONSE") if !content.is_empty() => {
                let mut msg = json_history_message(
                    "assistant".to_string(),
                    content.to_string(),
                    extract_timestamp(&value),
                    step_line_model.or_else(|| current_model.clone()),
                );
                if let Some(usage) = step_message_usage {
                    msg.input_tokens = positive_usage_token(usage.input_tokens);
                    msg.output_tokens = positive_usage_token(usage.output_tokens);
                    msg.cache_read_tokens = positive_usage_token(usage.cache_read_tokens);
                    msg.cache_creation_tokens = positive_usage_token(usage.cache_creation_tokens);
                }
                Some(msg)
            }
            _ => None,
        };
        if let Some(mut message) = message {
            message.line_index = Some(line_index);
            if collect_messages && has_truncated_content(&value, content) {
                truncated_messages.push(TruncatedAntigravityMessage {
                    message_idx: messages.len(),
                    line_index,
                    step_index: value.get("step_index").and_then(Value::as_i64),
                    source: source.to_string(),
                    event_type: event_type.to_string(),
                    is_user_input,
                });
            }
            messages.push(message);
        }
    }

    if collect_messages && !truncated_messages.is_empty() {
        hydrate_antigravity_full_messages(path, &mut messages, &truncated_messages);
    }

    let (mut summary, _, output_messages) =
        json_session_scan_result(session_id.as_deref(), None, messages, collect_messages);
    summary.first_timestamp_ms = match (summary.first_timestamp_ms, first_timestamp_ms) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    summary.last_timestamp_ms = match (summary.last_timestamp_ms, last_timestamp_ms) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    stats.dominant_model = model_hits
        .into_iter()
        .max_by(|(left_model, left_hits), (right_model, right_hits)| {
            left_hits
                .cmp(right_hits)
                .then_with(|| right_model.cmp(left_model))
        })
        .map(|(model, _)| model)
        .or_else(|| current_model.clone());
    stats.current_model = current_model;
    (summary, stats, output_messages)
}

fn extract_antigravity_step_usage(value: &Value) -> UsageTokenScan {
    let Some(map) = value.as_object() else {
        return UsageTokenScan::default();
    };
    UsageTokenScan {
        input_tokens: extract_u64_by_keys(map, &["input_tokens", "inputTokens"]).unwrap_or(0),
        output_tokens: extract_u64_by_keys(map, &["output_tokens", "outputTokens"]).unwrap_or(0),
        cache_read_tokens: extract_u64_by_keys(
            map,
            &[
                "cache_read_tokens",
                "cacheReadTokens",
                "cache_read_input_tokens",
            ],
        )
        .unwrap_or(0),
        cache_creation_tokens: extract_u64_by_keys(
            map,
            &[
                "cache_creation_tokens",
                "cacheCreationTokens",
                "cache_creation_input_tokens",
            ],
        )
        .unwrap_or(0),
        explicit_cost_usd: None,
    }
}

// 提取完整 USER_REQUEST 标签内容；标签不完整时保留修剪后的原文。
pub(super) fn extract_antigravity_user_request(content: &str) -> String {
    let Some(start) = content.find("<USER_REQUEST>") else {
        return content.trim().to_string();
    };
    let request_start = start + "<USER_REQUEST>".len();
    let Some(end) = content[request_start..].find("</USER_REQUEST>") else {
        return content.trim().to_string();
    };
    content[request_start..request_start + end]
        .trim()
        .to_string()
}

// 构造无消息、无身份与默认统计值的扫描结果。
pub(super) fn empty_session_scan() -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    (
        SessionSummaryScan {
            session_id: None,
            parent_session_id: None,
            message_count: 0,
            first_user_message: None,
            first_message: None,
            branch: None,
            first_timestamp_ms: None,
            last_timestamp_ms: None,
        },
        SessionStatsScan::default(),
        Vec::new(),
    )
}
