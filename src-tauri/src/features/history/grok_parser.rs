use super::{
    calculate_usage_cost, empty_session_scan, extract_text_from_value, extract_timestamp,
    extract_timestamp_millis, extract_u64_by_keys, grok_session_id_from_path, grok_string_by_paths,
    grok_summary_value, json_content_text, json_history_message, json_session_scan_result,
    mark_tool_event_seen, normalize_text, summarize_json_value, timestamp_millis_to_rfc3339,
    usage_total_tokens, usage_trend_point, HistoryMessage, HistoryTokenTrendPoint,
    SessionStatsScan, SessionSummaryScan, SessionUsageEventScan, UsageTokenScan, READ_BUF_CAPACITY,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;

pub(super) fn scan_grok_jsonl_session(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let Ok(file) = File::open(path) else {
        return empty_session_scan();
    };
    let summary = grok_summary_value(path);
    let session_id = summary
        .as_ref()
        .and_then(|value| grok_string_by_paths(value, &[&["info", "id"], &["session_id"]]))
        .or_else(|| grok_session_id_from_path(path));
    let title = summary.as_ref().and_then(|value| {
        grok_string_by_paths(
            value,
            &[&["generated_title"], &["session_summary"], &["title"]],
        )
    });
    let model = summary.as_ref().and_then(|value| {
        grok_string_by_paths(
            value,
            &[&["current_model_id"], &["model"], &["selectedModel"]],
        )
    });

    let mut messages = Vec::new();
    let mut pending_role: Option<&'static str> = None;
    let mut pending_content = String::new();
    let mut pending_timestamp = None;
    let mut pending_line_index = None;
    let mut pending_model = None;
    let mut seen_tool_call_ids = HashSet::new();
    let mut tool_call_count = 0u64;
    let mut builtin_calls = HashMap::new();
    let mut turn_usage_totals = GrokTurnUsageTotals::default();
    let mut token_trend: Vec<HistoryTokenTrendPoint> = Vec::new();
    let mut usage_events: Vec<SessionUsageEventScan> = Vec::new();

    for (line_index, line) in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(update) = grok_update_value(&value) else {
            continue;
        };
        let tag = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match tag {
            "user_message_chunk" => {
                if !grok_is_bash_command(update) {
                    if let Some(text) = update.get("content").and_then(grok_content_text) {
                        grok_append_pending_message_chunk(
                            "user",
                            text,
                            grok_event_timestamp(&value, update),
                            line_index,
                            None,
                            &mut pending_role,
                            &mut pending_content,
                            &mut pending_timestamp,
                            &mut pending_line_index,
                            &mut pending_model,
                            &mut messages,
                        );
                    }
                }
            }
            "agent_message_chunk" => {
                if let Some(text) = update.get("content").and_then(grok_content_text) {
                    grok_append_pending_message_chunk(
                        "assistant",
                        text,
                        grok_event_timestamp(&value, update),
                        line_index,
                        model.clone(),
                        &mut pending_role,
                        &mut pending_content,
                        &mut pending_timestamp,
                        &mut pending_line_index,
                        &mut pending_model,
                        &mut messages,
                    );
                }
            }
            "agent_thought_chunk" => {
                // Thoughts are not primary chat bubbles; keep stream state intact.
            }
            "tool_call" => {
                grok_flush_pending_message(
                    &mut pending_role,
                    &mut pending_content,
                    &mut pending_timestamp,
                    &mut pending_line_index,
                    &mut pending_model,
                    &mut messages,
                );
                if let Some(name) = grok_tool_name(update) {
                    let call_id = grok_tool_call_id(update);
                    if mark_tool_event_seen(call_id.as_deref(), &mut seen_tool_call_ids) {
                        tool_call_count += 1;
                        *builtin_calls.entry(name.clone()).or_insert(0) += 1;
                    }
                    if collect_messages {
                        let content = grok_tool_message_text(update, &name);
                        if !content.is_empty() {
                            let mut message = json_history_message(
                                "tool".to_string(),
                                content,
                                grok_event_timestamp(&value, update),
                                None,
                            );
                            message.line_index = Some(line_index);
                            messages.push(message);
                        }
                    }
                }
            }
            "tool_call_update" => {
                // Tool lifecycle/output is captured via tool events; avoid double-counting calls.
            }
            "turn_completed" => {
                grok_flush_pending_message(
                    &mut pending_role,
                    &mut pending_content,
                    &mut pending_timestamp,
                    &mut pending_line_index,
                    &mut pending_model,
                    &mut messages,
                );
                if let Some(usage) = update.get("usage") {
                    for (model_name, token_scan) in grok_turn_usage_scans(usage, model.as_deref()) {
                        if usage_total_tokens(token_scan) == 0 {
                            continue;
                        }
                        turn_usage_totals.input_tokens = turn_usage_totals
                            .input_tokens
                            .saturating_add(token_scan.input_tokens);
                        turn_usage_totals.output_tokens = turn_usage_totals
                            .output_tokens
                            .saturating_add(token_scan.output_tokens);
                        turn_usage_totals.cache_read_tokens = turn_usage_totals
                            .cache_read_tokens
                            .saturating_add(token_scan.cache_read_tokens);
                        turn_usage_totals.cache_creation_tokens = turn_usage_totals
                            .cache_creation_tokens
                            .saturating_add(token_scan.cache_creation_tokens);
                        if model_name.is_some() {
                            turn_usage_totals.model = model_name.clone();
                        }

                        token_trend.push(usage_trend_point(token_scan, model_name.clone()));
                        let event_index = usage_events.len();
                        let cost = calculate_usage_cost(model_name.as_deref(), token_scan);
                        usage_events.push(SessionUsageEventScan {
                            event_key: grok_usage_event_key(
                                &value,
                                update,
                                line_index,
                                model_name.as_deref(),
                            ),
                            event_index,
                            timestamp_ms: extract_timestamp_millis(update)
                                .or_else(|| extract_timestamp_millis(&value)),
                            model: model_name,
                            usage: cost,
                        });
                    }
                }
            }
            "session_recap"
            | "plan"
            | "current_mode_update"
            | "hook_execution"
            | "retry_state"
            | "task_backgrounded"
            | "task_completed" => {
                // Non-chat control events; flush any open text bubble only.
                grok_flush_pending_message(
                    &mut pending_role,
                    &mut pending_content,
                    &mut pending_timestamp,
                    &mut pending_line_index,
                    &mut pending_model,
                    &mut messages,
                );
            }
            _ => grok_flush_pending_message(
                &mut pending_role,
                &mut pending_content,
                &mut pending_timestamp,
                &mut pending_line_index,
                &mut pending_model,
                &mut messages,
            ),
        }
    }
    grok_flush_pending_message(
        &mut pending_role,
        &mut pending_content,
        &mut pending_timestamp,
        &mut pending_line_index,
        &mut pending_model,
        &mut messages,
    );

    let (summary_scan, mut stats, output_messages) = json_session_scan_result(
        session_id.as_deref(),
        title.as_deref(),
        messages,
        collect_messages,
    );
    if stats.current_model.is_none() {
        stats.current_model = model.clone();
        stats.dominant_model = model;
    }
    stats.tool_call_count = tool_call_count;
    stats.builtin_calls = builtin_calls;
    stats.usage_events = usage_events;
    for event in &stats.usage_events {
        if let Some(model_name) = event.model.as_deref() {
            let entry = stats.model_usage.entry(model_name.to_string()).or_default();
            entry.input_tokens = entry.input_tokens.saturating_add(event.usage.input_tokens);
            entry.output_tokens = entry
                .output_tokens
                .saturating_add(event.usage.output_tokens);
            entry.cache_read_tokens = entry
                .cache_read_tokens
                .saturating_add(event.usage.cache_read_tokens);
            entry.cache_creation_tokens = entry
                .cache_creation_tokens
                .saturating_add(event.usage.cache_creation_tokens);
            entry.total_cost_usd += event.usage.total_cost_usd;
            entry.unpriced_tokens = entry
                .unpriced_tokens
                .saturating_add(event.usage.unpriced_tokens);
        }
        stats.total_cost_usd += event.usage.total_cost_usd;
        stats.unpriced_tokens = stats
            .unpriced_tokens
            .saturating_add(event.usage.unpriced_tokens);
    }
    if turn_usage_totals.input_tokens > 0
        || turn_usage_totals.output_tokens > 0
        || turn_usage_totals.cache_read_tokens > 0
        || turn_usage_totals.cache_creation_tokens > 0
    {
        stats.input_tokens = turn_usage_totals.input_tokens;
        stats.output_tokens = turn_usage_totals.output_tokens;
        stats.cache_read_tokens = turn_usage_totals.cache_read_tokens;
        stats.cache_creation_tokens = turn_usage_totals.cache_creation_tokens;
        if let Some(model_name) = turn_usage_totals.model.clone() {
            stats.current_model = Some(model_name.clone());
            stats.dominant_model = Some(model_name);
        }
    }
    // Token 趋势图需要逐回合点；Grok 消息行本身无 per-message usage，只能靠 turn_completed。
    if !token_trend.is_empty() {
        stats.token_trend = token_trend;
    }
    apply_grok_signals_stats(path, &mut stats);
    (summary_scan, stats, output_messages)
}

/// Merge sibling `signals.json` into session stats for TerminalStatsPanel (context/token cards).
pub(super) fn apply_grok_signals_stats(updates_path: &Path, stats: &mut SessionStatsScan) {
    let signals_path = updates_path
        .parent()
        .map(|parent| parent.join("signals.json"));
    let Some(signals_path) = signals_path else {
        return;
    };
    let Ok(raw) = fs::read_to_string(&signals_path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return;
    };

    if let Some(tokens) = value
        .get("contextTokensUsed")
        .and_then(Value::as_u64)
        .or_else(|| value.get("context_tokens_used").and_then(Value::as_u64))
    {
        stats.last_context_tokens = Some(tokens);
        // Grok signals do not always split input/output; surface context usage as input so
        // TerminalStats token cards are non-zero when only context is available.
        if stats.input_tokens == 0 && stats.output_tokens == 0 {
            stats.input_tokens = tokens;
        }
    }
    if let Some(window) = value
        .get("contextWindowTokens")
        .and_then(Value::as_u64)
        .or_else(|| value.get("context_window_tokens").and_then(Value::as_u64))
    {
        stats.context_window = Some(window);
    }
    if stats.current_model.is_none() {
        if let Some(model) = value
            .get("primaryModelId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                value
                    .get("modelsUsed")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
        {
            stats.current_model = Some(model.clone());
            if stats.dominant_model.is_none() {
                stats.dominant_model = Some(model);
            }
        }
    }
    if stats.tool_call_count == 0 {
        if let Some(count) = value.get("toolCallCount").and_then(Value::as_u64) {
            stats.tool_call_count = count;
        }
    }
}

pub(super) fn grok_update_value(value: &Value) -> Option<&Value> {
    let params = value.get("params").unwrap_or(value);
    params
        .get("update")
        .or_else(|| params.get("sessionUpdate").is_some().then_some(params))
}

pub(super) fn grok_event_timestamp(value: &Value, update: &Value) -> Option<String> {
    extract_timestamp(update)
        .or_else(|| extract_timestamp(value))
        .or_else(|| {
            extract_timestamp_millis(update)
                .or_else(|| extract_timestamp_millis(value))
                .and_then(timestamp_millis_to_rfc3339)
        })
}

pub(super) fn grok_is_bash_command(update: &Value) -> bool {
    update
        .get("content")
        .and_then(|content| content.get("_meta"))
        .and_then(|meta| meta.get("bash_command"))
        .is_some()
}

pub(super) fn grok_content_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Object(map) => map
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| extract_text_from_value(value))?,
        Value::Array(items) => items
            .iter()
            .filter_map(grok_content_text)
            .collect::<Vec<_>>()
            .join(""),
        other => extract_text_from_value(other)?,
    };
    let text = if text.contains('\u{0000}') {
        text.replace('\u{0000}', "")
    } else {
        text
    };
    (!text.trim().is_empty()).then_some(text)
}

pub(super) fn grok_append_pending_message_chunk(
    role: &'static str,
    text: String,
    timestamp: Option<String>,
    line_index: usize,
    model: Option<String>,
    pending_role: &mut Option<&'static str>,
    pending_content: &mut String,
    pending_timestamp: &mut Option<String>,
    pending_line_index: &mut Option<usize>,
    pending_model: &mut Option<String>,
    messages: &mut Vec<HistoryMessage>,
) {
    if pending_role.is_some_and(|current| current != role) {
        grok_flush_pending_message(
            pending_role,
            pending_content,
            pending_timestamp,
            pending_line_index,
            pending_model,
            messages,
        );
    }
    if pending_role.is_none() {
        *pending_role = Some(role);
        *pending_timestamp = timestamp;
        *pending_line_index = Some(line_index);
        *pending_model = model;
    }
    pending_content.push_str(&text);
}

pub(super) fn grok_flush_pending_message(
    pending_role: &mut Option<&'static str>,
    pending_content: &mut String,
    pending_timestamp: &mut Option<String>,
    pending_line_index: &mut Option<usize>,
    pending_model: &mut Option<String>,
    messages: &mut Vec<HistoryMessage>,
) {
    let Some(role) = pending_role.take() else {
        return;
    };
    let content = normalize_text(pending_content);
    pending_content.clear();
    if content.is_empty() {
        *pending_timestamp = None;
        *pending_line_index = None;
        *pending_model = None;
        return;
    }
    let mut message = json_history_message(
        role.to_string(),
        content,
        pending_timestamp.take(),
        pending_model.take(),
    );
    message.line_index = pending_line_index.take();
    messages.push(message);
}

pub(super) fn grok_tool_call_id(update: &Value) -> Option<String> {
    update
        .get("toolCallId")
        .or_else(|| update.get("tool_call_id"))
        .or_else(|| update.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

pub(super) fn grok_tool_name(update: &Value) -> Option<String> {
    grok_string_by_paths(update, &[&["title"], &["name"], &["kind"]])
}

pub(super) fn grok_tool_input(update: &Value) -> Option<String> {
    update
        .get("rawInput")
        .or_else(|| update.get("raw_input"))
        .or_else(|| update.get("input"))
        .or_else(|| update.get("locations"))
        .and_then(summarize_json_value)
}

pub(super) fn grok_tool_output(update: &Value) -> Option<String> {
    update
        .get("content")
        .and_then(grok_nested_content_text)
        .or_else(|| update.get("content").and_then(json_content_text))
        .or_else(|| update.get("output").and_then(summarize_json_value))
        .or_else(|| update.get("result").and_then(summarize_json_value))
}

/// Grok tool_call_update often wraps output as:
/// `content: [{ "type": "content", "content": { "type": "text", "text": "..." } }]`
pub(super) fn grok_nested_content_text(value: &Value) -> Option<String> {
    match value {
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(grok_nested_content_text)
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        Value::Object(map) => {
            if map
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("content"))
            {
                return map.get("content").and_then(grok_content_text);
            }
            grok_content_text(value)
        }
        _ => grok_content_text(value),
    }
}

pub(super) fn grok_tool_status(update: &Value) -> Option<String> {
    let status = update.get("status").and_then(Value::as_str)?.to_lowercase();
    if status.contains("fail") || status.contains("error") {
        Some("failed".to_string())
    } else if status.contains("complete") || status.contains("success") {
        Some("completed".to_string())
    } else if status.contains("progress") || status.contains("running") {
        Some("started".to_string())
    } else {
        Some(status)
    }
}

#[derive(Default)]
pub(super) struct GrokTurnUsageTotals {
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) cache_creation_tokens: u64,
    pub(super) model: Option<String>,
}

pub(super) fn grok_turn_usage_scans(
    usage: &Value,
    fallback_model: Option<&str>,
) -> Vec<(Option<String>, UsageTokenScan)> {
    let mut scans = Vec::new();
    if let Some(model_usage) = usage.get("modelUsage").and_then(Value::as_object) {
        for (name, value) in model_usage {
            let model_name = name.trim();
            if model_name.is_empty() {
                continue;
            }
            let scan = grok_usage_token_scan(value);
            if usage_total_tokens(scan) > 0 {
                scans.push((Some(model_name.to_string()), scan));
            }
        }
    }
    if !scans.is_empty() {
        let top_level = grok_usage_token_scan(usage);
        let scanned = scans
            .iter()
            .fold(UsageTokenScan::default(), |mut total, (_, scan)| {
                total.input_tokens = total.input_tokens.saturating_add(scan.input_tokens);
                total.output_tokens = total.output_tokens.saturating_add(scan.output_tokens);
                total.cache_read_tokens = total
                    .cache_read_tokens
                    .saturating_add(scan.cache_read_tokens);
                total.cache_creation_tokens = total
                    .cache_creation_tokens
                    .saturating_add(scan.cache_creation_tokens);
                total
            });
        if let Some((_, first)) = scans.first_mut() {
            let missing_cache_read = top_level
                .cache_read_tokens
                .saturating_sub(scanned.cache_read_tokens);
            first.input_tokens = first.input_tokens.saturating_sub(missing_cache_read);
            first.input_tokens = first
                .input_tokens
                .saturating_add(top_level.input_tokens.saturating_sub(scanned.input_tokens));
            first.output_tokens = first.output_tokens.saturating_add(
                top_level
                    .output_tokens
                    .saturating_sub(scanned.output_tokens),
            );
            first.cache_read_tokens = first.cache_read_tokens.saturating_add(
                top_level
                    .cache_read_tokens
                    .saturating_sub(scanned.cache_read_tokens),
            );
            first.cache_creation_tokens = first.cache_creation_tokens.saturating_add(
                top_level
                    .cache_creation_tokens
                    .saturating_sub(scanned.cache_creation_tokens),
            );
        }
    }
    if scans.is_empty() {
        let scan = grok_usage_token_scan(usage);
        if usage_total_tokens(scan) > 0 {
            scans.push((
                fallback_model
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .map(str::to_string),
                scan,
            ));
        }
    }
    scans
}

pub(super) fn grok_usage_token_scan(value: &Value) -> UsageTokenScan {
    let Some(map) = value.as_object() else {
        return UsageTokenScan::default();
    };
    let cache_read_tokens =
        extract_u64_by_keys(map, &["cachedReadTokens", "cache_read_tokens", "cacheRead"])
            .unwrap_or(0);
    UsageTokenScan {
        // Grok's inputTokens includes cached reads. Store fresh input so the
        // request-log and history-stat totals use the same cache-normalized
        // semantics as CC Switch.
        input_tokens: extract_u64_by_keys(map, &["inputTokens", "input_tokens", "input"])
            .unwrap_or(0)
            .saturating_sub(cache_read_tokens),
        output_tokens: extract_u64_by_keys(map, &["outputTokens", "output_tokens", "output"])
            .unwrap_or(0),
        cache_read_tokens,
        cache_creation_tokens: extract_u64_by_keys(
            map,
            &[
                "cachedWriteTokens",
                "cache_creation_tokens",
                "cacheCreationTokens",
                "cacheWrite",
            ],
        )
        .unwrap_or(0),
        explicit_cost_usd: None,
    }
}

pub(super) fn grok_usage_event_key(
    value: &Value,
    update: &Value,
    line_index: usize,
    model: Option<&str>,
) -> String {
    let identity = update
        .get("promptId")
        .or_else(|| update.get("prompt_id"))
        .or_else(|| update.get("id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("line:{line_index}"));
    format!("grok:turn:{identity}:{}", model.unwrap_or("unknown"))
}

pub(super) fn grok_tool_message_text(update: &Value, name: &str) -> String {
    let input = grok_tool_input(update).unwrap_or_default();
    if input.is_empty() {
        format!("[{name}]")
    } else {
        format!("[{name}] {input}")
    }
}
