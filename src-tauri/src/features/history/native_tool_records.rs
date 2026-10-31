//! Additional native transcript shapes share the same observation constructor.
use super::{extract_timestamp, make_tool_event, mark_tool_event_seen, summarize_json_value,
    update_tool_event_output, HistoryToolEvent};
use super::tool_observations::{mcp_server, result_status};
use serde_json::Value;
use std::collections::HashSet;

fn record(call: &Value, index: Option<usize>, timestamp: Option<String>,
    seen: &mut HashSet<String>, events: &mut Vec<HistoryToolEvent>) {
    let function = call.get("function").unwrap_or(call);
    let Some(name) = function.get("name").and_then(Value::as_str) else { return };
    let id = call.get("id").or_else(|| call.get("call_id")).or_else(|| call.get("toolUseId"))
        .and_then(Value::as_str).map(str::to_string);
    let result = call.get("result").or_else(|| call.get("output"));
    let status = result.map(|_| result_status(call));
    if mark_tool_event_seen(id.as_deref(), seen) {
        events.push(make_tool_event(id, name, index, timestamp, status.or(Some("started")), None,
            function.get("arguments").or_else(|| function.get("args")).or_else(|| function.get("input"))
                .and_then(summarize_json_value), result.and_then(summarize_json_value), mcp_server(call)));
    } else if result.is_some() {
        update_tool_event_output(events, id.as_deref(), result.and_then(summarize_json_value), status.map(str::to_string));
    }
}

pub(super) fn collect_native_records(value: &Value, index: Option<usize>,
    seen: &mut HashSet<String>, events: &mut Vec<HistoryToolEvent>) {
    let message = value.get("message").unwrap_or(value);
    for key in ["tool_calls", "toolCalls"] {
        for call in message.get(key).and_then(Value::as_array).into_iter().flatten() {
            record(call, index, extract_timestamp(value), seen, events);
        }
    }
    if message.get("role").and_then(Value::as_str) == Some("tool") {
        let id = message.get("tool_call_id").and_then(Value::as_str);
        update_tool_event_output(events, id, message.get("content").and_then(summarize_json_value),
            Some(result_status(message).to_string()));
    }
    for block in message.get("content").and_then(Value::as_array).into_iter().flatten() {
        if let Some(call) = block.get("toolUse") {
            record(call, index, extract_timestamp(value), seen, events);
        }
        if let Some(result) = block.get("toolResult") {
            update_tool_event_output(events, result.get("toolUseId").and_then(Value::as_str),
                result.get("content").and_then(summarize_json_value), Some(result_status(result).to_string()));
        }
        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
            update_tool_event_output(events, block.get("tool_use_id").or_else(|| block.get("toolUseId")).and_then(Value::as_str),
                block.get("content").and_then(summarize_json_value), Some(result_status(block).to_string()));
        }
    }
}

pub(super) fn scan_json_tool_records(path: &std::path::Path) -> Vec<HistoryToolEvent> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else { return Vec::new() };
    let mut events = Vec::new();
    let mut seen = HashSet::new();
    let mut message_index = 0;
    for entry in value.get("messages").or_else(|| value.get("history")).and_then(Value::as_array).into_iter().flatten() {
        let message = entry.get("message").unwrap_or(entry);
        let visible = message.get("content").and_then(super::json_content_text).is_some();
        let index = visible.then_some(message_index);
        if visible { message_index += 1; }
        let wrapped = serde_json::json!({"message": message, "timestamp": extract_timestamp(message)});
        super::collect_tool_events_from_value(&wrapped, index, &mut seen, &mut events);
    }
    events
}
