use super::{
    empty_session_scan, extract_model, extract_timestamp, json_content_text, json_history_message,
    json_session_scan_result, summarize_json_value, HistoryMessage, SessionStatsScan,
    SessionSummaryScan, READ_BUF_CAPACITY,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

// 扫描 Copilot 事件，提取会话消息并按调用 ID 去重统计工具次数。
pub(super) fn scan_copilot_jsonl_session(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let Ok(file) = File::open(path) else {
        return empty_session_scan();
    };
    let mut session_id = None;
    let mut messages = Vec::new();
    let mut seen_tool_call_ids = HashSet::new();
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
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let data = value.get("data");

        if event_type == "session.start" {
            session_id = data
                .and_then(|data| data.get("sessionId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
        }
        if event_type == "assistant.message" {
            for request in data
                .and_then(|data| data.get("toolRequests"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                count_copilot_tool_call(
                    request,
                    &mut seen_tool_call_ids,
                    &mut tool_call_count,
                    &mut builtin_calls,
                );
            }
        } else if event_type == "tool.execution_start" {
            if let Some(data) = data {
                count_copilot_tool_call(
                    data,
                    &mut seen_tool_call_ids,
                    &mut tool_call_count,
                    &mut builtin_calls,
                );
            }
        }
        if let Some(message) = copilot_message_from_event(&value, line_index) {
            messages.push(message);
        }
    }

    let fallback_id = path
        .parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().to_string());
    let (summary, mut stats, output_messages) = json_session_scan_result(
        session_id.or(fallback_id).as_deref(),
        None,
        messages,
        collect_messages,
    );
    stats.tool_call_count = tool_call_count;
    stats.builtin_calls = builtin_calls;
    (summary, stats, output_messages)
}

// 对有名称且调用 ID 未重复的 Copilot 工具增加总数与名称计数。
pub(super) fn count_copilot_tool_call(
    value: &Value,
    seen_call_ids: &mut HashSet<String>,
    tool_call_count: &mut u64,
    builtin_calls: &mut HashMap<String, u64>,
) {
    let Some(name) = copilot_tool_name(value) else {
        return;
    };
    if copilot_tool_id(value).is_some_and(|id| !seen_call_ids.insert(id.to_string())) {
        return;
    }
    *tool_call_count += 1;
    *builtin_calls.entry(name.to_string()).or_insert(0) += 1;
}

// 把支持的用户、助手及工具完成事件转换为带原始行号的历史消息。
pub(super) fn copilot_message_from_event(
    value: &Value,
    line_index: usize,
) -> Option<HistoryMessage> {
    let data = value.get("data")?;
    let (role, content, model) = match value.get("type").and_then(Value::as_str)? {
        "user.message" => (
            "user",
            data.get("content").and_then(json_content_text)?,
            None,
        ),
        "assistant.message" => (
            "assistant",
            copilot_assistant_content(data)?,
            extract_model(data),
        ),
        "tool.execution_complete" => ("tool", copilot_tool_result_text(data)?, None),
        _ => return None,
    };
    let mut message =
        json_history_message(role.to_string(), content, extract_timestamp(value), model);
    message.line_index = Some(line_index);
    Some(message)
}

// 合并助手正文与工具请求名称和参数摘要，空结果返回空值。
pub(super) fn copilot_assistant_content(data: &Value) -> Option<String> {
    let mut parts = data
        .get("content")
        .and_then(json_content_text)
        .into_iter()
        .collect::<Vec<_>>();
    for request in data
        .get("toolRequests")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = copilot_tool_name(request).unwrap_or("tool");
        let arguments = request
            .get("arguments")
            .or_else(|| request.get("input"))
            .and_then(summarize_json_value);
        parts.push(match arguments {
            Some(arguments) => format!("[{name}] {arguments}"),
            None => format!("[{name}]"),
        });
    }
    (!parts.is_empty()).then(|| parts.join("\n"))
}

// 优先读取工具结果详细正文，回退到正文或 JSON 摘要。
pub(super) fn copilot_tool_result_text(data: &Value) -> Option<String> {
    let result = data.get("result")?;
    result
        .get("detailedContent")
        .and_then(json_content_text)
        .or_else(|| result.get("content").and_then(json_content_text))
        .or_else(|| summarize_json_value(result))
}

// 按兼容字段读取并修剪 Copilot 工具调用 ID，忽略空值。
pub(super) fn copilot_tool_id(value: &Value) -> Option<&str> {
    value
        .get("toolCallId")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

// 按兼容字段读取并修剪 Copilot 工具名称，忽略空值。
pub(super) fn copilot_tool_name(value: &Value) -> Option<&str> {
    value
        .get("toolName")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
}
