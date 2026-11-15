//! Additional native transcript shapes share the same observation constructor.
use super::{extract_timestamp, extract_tool_duration_ms, make_tool_event, mark_tool_event_seen,
    summarize_json_value, update_tool_event_output, HistoryToolEvent};
use super::tool_observations::{mcp_server, result_status};
use serde_json::Value;
use std::collections::HashSet;

/// Codex `exec` orchestration runs nested tools inside one custom call; their executions are
/// only recorded as `event_msg.item_completed` tool items. Hosted search additionally appears as
/// `response_item.web_search_call` sharing the item id, so the id deduplicates both records.
pub(super) struct CodexToolItem<'a> {
    pub(super) name: &'a str,
    pub(super) call_id: Option<&'a str>,
    pub(super) mcp_server: Option<&'a str>,
    pub(super) item: &'a Value,
    /// `item_completed` evidence, which supersedes inferred orchestration call sites.
    pub(super) completed: bool,
}

pub(super) fn codex_tool_item(value: &Value) -> Option<CodexToolItem<'_>> {
    let payload = value.get("payload")?;
    let (item, kind, completed) = match payload.get("type").and_then(Value::as_str)? {
        "item_completed" => {
            let item = payload.get("item")?;
            (item, item.get("type").and_then(Value::as_str)?, true)
        }
        "web_search_call" => (payload, "WebSearch", false),
        _ => return None,
    };
    // Message, reasoning, compaction and review items are not tool calls. Names follow the
    // Codex tool each item executes so nested and direct calls aggregate under one entry.
    let (name, server) = match kind {
        "CommandExecution" => ("exec_command", None),
        "FileChange" => ("apply_patch", None),
        "WebSearch" => ("web_search", None),
        "ImageView" => ("view_image", None),
        "Extension" => (item.get("kind").and_then(Value::as_str)?, None),
        kind if kind.ends_with("ToolCall") => {
            let server = mcp_server(item);
            (item.get("tool").and_then(Value::as_str).or(server)?, server)
        }
        _ => return None,
    };
    Some(CodexToolItem { name, call_id: item.get("id").and_then(Value::as_str), mcp_server: server, item, completed })
}

/// Codex has no Skill tool: the model loads a skill by running a command that reads
/// `<skills root>/<name>/SKILL.md` from its skills list. Only concrete paths in Codex command
/// executions count; listings, globs and command output do not, and a command loading the same
/// skill twice counts once.
pub(super) fn codex_command_skills(value: &Value) -> Vec<String> {
    let Some(command) = codex_command_text(value) else { return Vec::new() };
    let command = command.replace('\\', "/");
    let mut skills: Vec<String> = Vec::new();
    for (end, marker) in command.match_indices("/SKILL.md") {
        let after = command[end + marker.len()..].chars().next();
        if after.is_some_and(|c| c.is_alphanumeric() || "._-".contains(c)) { continue; }
        let mut segments = command[..end].rsplit('/');
        let name = segments.next().unwrap_or_default();
        let parent = segments.next();
        let root = if parent == Some(".system") { segments.next() } else { parent };
        // The root segment may carry the preceding argument text, e.g. `Get-Content 'skills`.
        let root = root.and_then(|segment| segment.rsplit(|c: char| c.is_whitespace() || "'\"`=(".contains(c)).next());
        let valid_name = !matches!(name, "" | "." | "..")
            && !name.contains(|c: char| c.is_whitespace() || "*?[]{}$<>|'\"`".contains(c));
        if root == Some("skills") && valid_name && !skills.iter().any(|skill| skill == name) {
            skills.push(name.to_string());
        }
    }
    skills
}

// Code-mode `CommandExecution` items and direct shell function calls carry the executed command.
fn codex_command_text(value: &Value) -> Option<String> {
    let payload = value.get("payload")?;
    let command = match payload.get("type").and_then(Value::as_str)? {
        "item_completed" => {
            let item = payload.get("item")?;
            if item.get("type").and_then(Value::as_str)? != "CommandExecution" { return None; }
            item.get("command")?.clone()
        }
        "function_call" if matches!(payload.get("name").and_then(Value::as_str),
            Some("exec_command" | "shell" | "shell_command")) => {
            let arguments = payload.get("arguments")?;
            let arguments = arguments.as_str().and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or_else(|| arguments.clone());
            arguments.get("cmd").or_else(|| arguments.get("command")).cloned().unwrap_or(arguments)
        }
        _ => return None,
    };
    match command {
        Value::String(text) => Some(text),
        Value::Array(parts) => Some(parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
        _ => None,
    }
}

fn codex_item_input(item: &Value) -> Option<String> {
    if let Some(changes) = item.get("changes").and_then(Value::as_object) {
        // Patch bodies can be whole files; the changed paths identify the call.
        return summarize_json_value(&Value::from(changes.keys().cloned().collect::<Vec<_>>()));
    }
    let command = item.get("command").map(|command| command.as_array().and_then(|parts| parts.last()).unwrap_or(command));
    ["arguments", "query", "path", "action"].iter().find_map(|key| item.get(*key)).or(command)
        .and_then(summarize_json_value)
}

fn record_codex_item(value: &Value, index: Option<usize>, seen: &mut HashSet<String>,
    events: &mut Vec<HistoryToolEvent>) {
    let Some(tool) = codex_tool_item(value) else { return };
    let status = result_status(tool.item);
    let output = ["aggregated_output", "result", "error"].iter()
        .find_map(|key| tool.item.get(*key)).and_then(summarize_json_value);
    if !mark_tool_event_seen(tool.call_id, seen) {
        update_tool_event_output(events, tool.call_id, output, Some(status.to_string()));
        return;
    }
    let payload = value.get("payload");
    let duration = extract_tool_duration_ms(tool.item).or_else(|| {
        let at = |key| payload.and_then(|payload| payload.get(key)).and_then(Value::as_i64);
        u64::try_from(at("completed_at_ms")? - at("started_at_ms")?).ok()
    });
    events.push(make_tool_event(tool.call_id.map(str::to_string), tool.name, index, extract_timestamp(value),
        Some(status), duration, codex_item_input(tool.item), output, tool.mcp_server));
}

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
    record_codex_item(value, index, seen, events);
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
