use super::{
    antigravity_path_parts, collect_tool_calls, cursor_session_id_from_path, extract_timestamp,
    json_history_message, json_session_scan_result, parse_message, HistoryMessage,
    SessionStatsScan, SessionSummaryScan, READ_BUF_CAPACITY,
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

// 从 Antigravity 已完成事件提取用户和模型消息及工具调用计数。
pub(super) fn scan_antigravity_jsonl_session(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let Ok(file) = File::open(path) else {
        return empty_session_scan();
    };
    let session_id = antigravity_path_parts(path).map(|(_, id)| id);
    let mut messages = Vec::new();
    let mut tool_call_count = 0u64;
    let mut builtin_calls = HashMap::new();

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
                tool_call_count += 1;
                *builtin_calls.entry(name.to_string()).or_insert(0) += 1;
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
            ("MODEL", "PLANNER_RESPONSE") if !content.is_empty() => Some(json_history_message(
                "assistant".to_string(),
                content.to_string(),
                extract_timestamp(&value),
                None,
            )),
            _ => None,
        };
        if let Some(mut message) = message {
            message.line_index = Some(line_index);
            messages.push(message);
        }
    }

    let (summary, mut stats, output_messages) =
        json_session_scan_result(session_id.as_deref(), None, messages, collect_messages);
    stats.tool_call_count = tool_call_count;
    stats.builtin_calls = builtin_calls;
    (summary, stats, output_messages)
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
