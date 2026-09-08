use super::{
    empty_session_scan, extract_content, extract_model, extract_timestamp,
    json_session_scan_result, make_tool_event, mark_tool_event_seen, parse_message,
    pi_session_id_from_path, pi_string_by_keys, summarize_json_value, update_tool_event_output,
    HistoryMessage, HistoryToolEvent, SessionStatsScan, SessionSummaryScan, READ_BUF_CAPACITY,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

// 扫描 Pi 会话元数据与消息，结合默认模型汇总用量及去重工具计数。
pub(super) fn scan_pi_jsonl_session(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let Ok(file) = File::open(path) else {
        return empty_session_scan();
    };
    let mut session_id = None;
    let mut title = None;
    let mut model = None;
    let mut messages = Vec::new();
    let mut tool_call_count = 0u64;
    let mut builtin_calls = HashMap::new();
    let mut seen_call_ids = HashSet::new();

    for (line_index, line) in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                if session_id.is_none() {
                    session_id = pi_string_by_keys(&value, &["sessionId", "session_id", "id"]);
                }
                if title.is_none() {
                    title = pi_string_by_keys(&value, &["title", "summary", "name"]);
                }
                if model.is_none() {
                    model = extract_model(&value);
                }
            }
            Some("message") => {
                collect_pi_tool_calls(
                    &value,
                    &mut seen_call_ids,
                    &mut tool_call_count,
                    &mut builtin_calls,
                );
                if let Some(mut message) = parse_message(&value) {
                    if message.model.is_none() && message.role == "assistant" {
                        message.model = model.clone();
                    }
                    message.line_index = Some(line_index);
                    messages.push(message);
                }
            }
            _ => {}
        }
    }

    let fallback_id = pi_session_id_from_path(path);
    let (summary, mut stats, output_messages) = json_session_scan_result(
        session_id.as_deref().or(fallback_id.as_deref()),
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
    (summary, stats, output_messages)
}

// 遍历 Pi 消息的 toolCall 块，按可用调用 ID 去重并累计工具次数。
pub(super) fn collect_pi_tool_calls(
    value: &Value,
    seen_call_ids: &mut HashSet<String>,
    tool_call_count: &mut u64,
    builtin_calls: &mut HashMap<String, u64>,
) {
    let Some(blocks) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("toolCall") {
            continue;
        }
        let Some(name) = pi_tool_name(block) else {
            continue;
        };
        if let Some(id) = pi_tool_call_id(block) {
            if !seen_call_ids.insert(id) {
                continue;
            }
        }
        *tool_call_count += 1;
        *builtin_calls.entry(name).or_insert(0) += 1;
    }
}

// 按 Pi 兼容字段顺序读取工具调用 ID。
pub(super) fn pi_tool_call_id(value: &Value) -> Option<String> {
    pi_string_by_keys(value, &["toolCallId", "tool_call_id", "id"])
}

// 按 Pi 兼容字段顺序读取工具名称。
pub(super) fn pi_tool_name(value: &Value) -> Option<String> {
    pi_string_by_keys(value, &["name", "toolName", "tool_name", "kind"])
}

// 扫描 Pi 工具调用为诊断事件，并按调用 ID 回填工具结果正文与完成状态。
pub(super) fn scan_pi_tool_events(path: &Path) -> Vec<HistoryToolEvent> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    let mut seen_call_ids = HashSet::new();
    for (line_index, line) in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        if let Some(blocks) = value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
        {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("toolCall") {
                    continue;
                }
                let Some(name) = pi_tool_name(block) else {
                    continue;
                };
                let call_id = pi_tool_call_id(block);
                if mark_tool_event_seen(call_id.as_deref(), &mut seen_call_ids) {
                    events.push(make_tool_event(
                        call_id,
                        &name,
                        Some(line_index),
                        extract_timestamp(&value),
                        Some("started"),
                        None,
                        block
                            .get("arguments")
                            .or_else(|| block.get("input"))
                            .and_then(summarize_json_value),
                        None,
                        None,
                    ));
                }
            }
        }
        if value
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            == Some("toolResult")
        {
            let call_id = value
                .get("message")
                .and_then(|message| pi_tool_call_id(message));
            update_tool_event_output(
                &mut events,
                call_id.as_deref(),
                extract_content(&value),
                Some("completed".to_string()),
            );
        }
    }
    events
}
