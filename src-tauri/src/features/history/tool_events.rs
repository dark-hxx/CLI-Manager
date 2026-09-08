use super::{
    copilot_tool_id, copilot_tool_name, copilot_tool_result_text, extract_positive_u64,
    extract_timestamp, normalize_text, HistoryToolCount, HistoryToolEvent,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 统计工具调用：Claude content 块的 tool_use（按块 id 去重，流式重复行只计一次）、
/// Codex 的 function_call / custom_tool_call / mcp_tool_call 事件（按 call_id 去重）。
/// MCP 按 server 聚合：Claude 工具名形如 mcp__<server>__<tool>，Codex 可在 namespace
/// 或 invocation.server 里携带 server；Skill 工具取 input.skill。
pub(super) fn collect_tool_calls(
    value: &Value,
    seen_call_ids: &mut HashSet<String>,
    tool_call_count: &mut u64,
    mcp_calls: &mut HashMap<String, u64>,
    skill_calls: &mut HashMap<String, u64>,
    builtin_calls: &mut HashMap<String, u64>,
) {
    let mut record =
        |name: &str, call_id: Option<&str>, input: Option<&Value>, mcp_server: Option<&str>| {
            if let Some(id) = call_id.map(str::trim).filter(|id| !id.is_empty()) {
                if !seen_call_ids.insert(id.to_string()) {
                    return;
                }
            }
            *tool_call_count += 1;
            let mcp_server = mcp_server
                .map(str::trim)
                .filter(|server| !server.is_empty())
                .or_else(|| extract_mcp_server(name));
            if let Some(server) = mcp_server {
                *mcp_calls.entry(server.to_string()).or_insert(0) += 1;
            } else if name == "Skill" {
                if let Some(skill) = input
                    .and_then(|input| input.get("skill"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|skill| !skill.is_empty())
                {
                    *skill_calls.entry(skill.to_string()).or_insert(0) += 1;
                }
            } else {
                // 既非 MCP 也非 Skill 的内置工具（如 Read / Edit / Bash / shell）
                *builtin_calls.entry(name.to_string()).or_insert(0) += 1;
            }
        };

    if let Some(blocks) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            if let Some(name) = block.get("name").and_then(Value::as_str) {
                record(
                    name,
                    block.get("id").and_then(Value::as_str),
                    block.get("input"),
                    None,
                );
            }
        }
    }

    if let Some(payload) = value.get("payload") {
        let payload_type = payload.get("type").and_then(Value::as_str);
        if matches!(
            payload_type,
            Some("function_call") | Some("custom_tool_call")
        ) {
            if let Some(name) = payload.get("name").and_then(Value::as_str) {
                record(
                    name,
                    payload.get("call_id").and_then(Value::as_str),
                    None,
                    payload
                        .get("namespace")
                        .and_then(Value::as_str)
                        .and_then(extract_mcp_server),
                );
            }
        } else if payload_type
            .map(|value| value.starts_with("mcp_tool_call"))
            .unwrap_or(false)
        {
            if let Some(invocation) = payload.get("invocation") {
                if let Some(server) = invocation.get("server").and_then(Value::as_str) {
                    let name = invocation
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or(server);
                    record(
                        name,
                        payload.get("call_id").and_then(Value::as_str),
                        None,
                        Some(server),
                    );
                }
            }
        }
    }
}

pub(super) fn collect_tool_events_from_value(
    value: &Value,
    message_index: Option<usize>,
    seen_call_ids: &mut HashSet<String>,
    events: &mut Vec<HistoryToolEvent>,
) {
    super::native_tool_records::collect_native_records(value, message_index, seen_call_ids, events);
    if let Some(payload) = value.get("payload").filter(|p| p.get("type").and_then(Value::as_str) == Some("message")) {
        let wrapped = serde_json::json!({"message": payload, "timestamp": extract_timestamp(value)});
        collect_tool_events_from_value(&wrapped, message_index, seen_call_ids, events);
    }
    if let Some(event_type) = value.get("type").and_then(Value::as_str) {
        if let Some(data) = value.get("data") {
            if event_type == "assistant.message" {
                for request in data
                    .get("toolRequests")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(name) = copilot_tool_name(request) else {
                        continue;
                    };
                    let call_id = copilot_tool_id(request).map(str::to_string);
                    if mark_tool_event_seen(call_id.as_deref(), seen_call_ids) {
                        events.push(make_tool_event(
                            call_id,
                            name,
                            message_index,
                            extract_timestamp(value),
                            Some("started"),
                            None,
                            request
                                .get("arguments")
                                .or_else(|| request.get("input"))
                                .and_then(summarize_json_value),
                            None,
                            super::tool_observations::mcp_server(request),
                        ));
                    }
                }
                return;
            }
            if event_type == "tool.execution_start" {
                if let Some(name) = copilot_tool_name(data) {
                    let call_id = copilot_tool_id(data).map(str::to_string);
                    if mark_tool_event_seen(call_id.as_deref(), seen_call_ids) {
                        events.push(make_tool_event(
                            call_id,
                            name,
                            message_index,
                            extract_timestamp(value),
                            Some("started"),
                            None,
                            data.get("arguments")
                                .or_else(|| data.get("input"))
                                .and_then(summarize_json_value),
                            None,
                            None,
                        ));
                    }
                }
                return;
            }
            if event_type == "tool.execution_complete" {
                let call_id = copilot_tool_id(data).map(str::to_string);
                let status = if data.get("success").and_then(Value::as_bool) == Some(false) {
                    "failed"
                } else {
                    "completed"
                };
                let output = copilot_tool_result_text(data);
                if let Some(name) = copilot_tool_name(data) {
                    if mark_tool_event_seen(call_id.as_deref(), seen_call_ids) {
                        events.push(make_tool_event(
                            call_id,
                            name,
                            message_index,
                            extract_timestamp(value),
                            Some(status),
                            extract_tool_duration_ms(data),
                            None,
                            output,
                            super::tool_observations::mcp_server(data),
                        ));
                    } else {
                        update_tool_event_output(
                            events,
                            call_id.as_deref(),
                            output,
                            Some(status.to_string()),
                        );
                    }
                }
                return;
            }
        }
    }

    if let Some(blocks) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(name) = block.get("name").and_then(Value::as_str) else {
                continue;
            };
            let call_id = block.get("id").and_then(Value::as_str).map(str::to_string);
            if !mark_tool_event_seen(call_id.as_deref(), seen_call_ids) {
                continue;
            }
            events.push(make_tool_event(
                call_id,
                name,
                message_index,
                extract_timestamp(value),
                Some("started"),
                None,
                block.get("input").and_then(summarize_json_value),
                None,
                super::tool_observations::mcp_server(block),
            ));
        }
    }

    if let Some(payload) = value.get("payload") {
        let payload_type = payload.get("type").and_then(Value::as_str);
        if matches!(
            payload_type,
            Some("function_call") | Some("custom_tool_call")
        ) {
            let Some(name) = payload.get("name").and_then(Value::as_str) else {
                return;
            };
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if !mark_tool_event_seen(call_id.as_deref(), seen_call_ids) {
                return;
            }
            let mcp_server = super::tool_observations::mcp_server(payload);
            events.push(make_tool_event(
                call_id,
                name,
                message_index,
                extract_timestamp(value),
                Some("started"),
                None,
                payload.get("arguments").or_else(|| payload.get("input")).and_then(summarize_json_value),
                None,
                mcp_server,
            ));
            if name == "exec" {
                if let Some(script) = payload.get("input").and_then(Value::as_str) {
                    let parent = events.last().unwrap().clone();
                    super::nested_tools::append_nested_tools(script, &parent, events);
                }
            }
            return;
        }

        if matches!(payload_type, Some("function_call_output" | "custom_tool_call_output")) {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let output_summary = payload.get("output").and_then(summarize_json_value);
            update_tool_event_output(events, call_id.as_deref(), output_summary,
                Some(super::tool_observations::result_status(payload).to_string()));
            return;
        }

        if payload_type
            .map(|kind| kind.starts_with("mcp_tool_call"))
            .unwrap_or(false)
        {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let duration_ms = extract_tool_duration_ms(payload);
            let status = if payload_type == Some("mcp_tool_call_end") {
                Some(super::tool_observations::result_status(payload))
            } else if payload_type == Some("mcp_tool_call_error") {
                Some("failed")
            } else {
                None
            };

            if let Some(invocation) = payload.get("invocation") {
                if let Some(server) = invocation.get("server").and_then(Value::as_str) {
                    let name = invocation
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or(server);
                    if mark_tool_event_seen(call_id.as_deref(), seen_call_ids) {
                        events.push(make_tool_event(
                            call_id.clone(),
                            name,
                            message_index,
                            extract_timestamp(value),
                            status,
                            duration_ms,
                            invocation.get("arguments").and_then(summarize_json_value),
                            payload.get("result").and_then(summarize_json_value),
                            Some(server),
                        ));
                    } else {
                        update_tool_event_output(
                            events,
                            call_id.as_deref(),
                            payload.get("result").and_then(summarize_json_value),
                            status.map(str::to_string),
                        );
                    }
                }
            }
        }
    }
}

pub(super) fn mark_tool_event_seen(
    call_id: Option<&str>,
    seen_call_ids: &mut HashSet<String>,
) -> bool {
    let Some(id) = call_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return true;
    };
    seen_call_ids.insert(id.to_string())
}

pub(super) fn make_tool_event(
    call_id: Option<String>,
    name: &str,
    message_index: Option<usize>,
    timestamp: Option<String>,
    status: Option<&str>,
    duration_ms: Option<u64>,
    input_summary: Option<String>,
    output_summary: Option<String>,
    mcp_server: Option<&str>,
) -> HistoryToolEvent {
    let category = super::tool_observations::tool_category(name, mcp_server);
    HistoryToolEvent {
        evidence: None,
        call_id,
        name: name.to_string(),
        category,
        message_index,
        timestamp,
        status: status.map(str::to_string),
        duration_ms,
        input_summary,
        output_summary,
    }
}

pub(super) fn update_tool_event_output(
    events: &mut [HistoryToolEvent],
    call_id: Option<&str>,
    output_summary: Option<String>,
    status: Option<String>,
) {
    let Some(call_id) = call_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return;
    };
    if let Some(event) = events
        .iter_mut()
        .rev()
        .find(|event| event.call_id.as_deref() == Some(call_id))
    {
        if output_summary.is_some() {
            event.output_summary = output_summary;
        }
        if status.is_some() {
            event.status = status;
        }
    }
}

pub(super) fn summarize_json_value(value: &Value) -> Option<String> {
    let text = match value {
        Value::Null => return None,
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).ok()?,
    };
    let normalized = normalize_text(&text);
    if normalized.is_empty() {
        None
    } else if normalized.len() > 500 {
        let truncated: String = normalized.chars().take(500).collect();
        Some(format!("{truncated}…"))
    } else {
        Some(normalized)
    }
}

pub(super) fn extract_tool_duration_ms(value: &Value) -> Option<u64> {
    value
        .get("duration_ms")
        .or_else(|| value.get("durationMs"))
        .or_else(|| value.get("elapsed_ms"))
        .or_else(|| value.get("elapsedMs"))
        .and_then(extract_positive_u64)
}

pub(super) fn extract_mcp_server(value: &str) -> Option<&str> {
    let value = value.strip_prefix("functions.").unwrap_or(value);
    let rest = value.strip_prefix("mcp__")?;
    let server = rest.split("__").next().unwrap_or(rest).trim();
    (!server.is_empty()).then_some(server)
}

/// 提取斜杠命令标记 `<command-name>/foo</command-name>` 中的命令名（去掉前导 "/"）。
pub(super) fn extract_command_name(line: &str) -> Option<String> {
    let start = line.find("<command-name>")? + "<command-name>".len();
    let end = line[start..].find("</command-name>")? + start;
    let name = line[start..end].trim().trim_start_matches('/').trim();
    (!name.is_empty()).then(|| name.to_string())
}

pub(super) fn sorted_tool_counts(map: &HashMap<String, u64>) -> Vec<HistoryToolCount> {
    let mut items: Vec<HistoryToolCount> = map
        .iter()
        .map(|(name, count)| HistoryToolCount {
            name: name.clone(),
            count: *count,
        })
        .collect();
    items.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    items
}
