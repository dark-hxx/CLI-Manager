//! Shared observation semantics. Adapters supply native fields; consumers never
//! infer successful execution from a request or an orchestration script.
use super::{HistoryToolEvent, SessionStatsScan};
use super::tool_events::extract_mcp_server;
use serde_json::Value;

pub(super) fn mcp_server(value: &Value) -> Option<&str> {
    ["server", "serverName", "server_name", "mcpServer", "mcp_server"]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .or_else(|| value.get("namespace").and_then(Value::as_str).and_then(extract_mcp_server))
        .or_else(|| {
            ["invocation", "mcp", "metadata"]
                .iter()
                .filter_map(|key| value.get(key))
                .find_map(|nested| {
                    ["server", "serverName", "server_name"]
                        .iter()
                        .find_map(|key| nested.get(key).and_then(Value::as_str))
                })
        })
        .map(str::trim)
        .filter(|server| !server.is_empty())
}

pub(super) fn tool_category(name: &str, server: Option<&str>) -> String {
    if let Some(server) = server.or_else(|| extract_mcp_server(name)) {
        format!("mcp:{server}")
    } else if name.eq_ignore_ascii_case("skill") {
        "skill".to_string()
    } else {
        "builtin".to_string()
    }
}

/// Only explicit protocol error flags count as errors. Tool text is arbitrary
/// user data and may contain examples mentioning the word "error".
pub(super) fn result_status(value: &Value) -> &'static str {
    if value.get("Err").is_some_and(|v| !v.is_null()) { return "failed"; }
    if let Some(result) = value.get("Ok") { return result_status(result); }
    if value.get("isError").or_else(|| value.get("is_error")).and_then(Value::as_bool) == Some(true)
        || value.get("success").and_then(Value::as_bool) == Some(false)
        || value.get("error").is_some_and(|v| !v.is_null() && v != &Value::Bool(false))
    {
        return "failed";
    }
    if let Some(status) = value.get("status").and_then(Value::as_str) {
        match status.to_ascii_lowercase().as_str() {
            "failed" | "error" | "errored" => return "failed",
            "cancelled" | "canceled" => return "cancelled",
            "denied" | "rejected" => return "denied",
            "running" | "started" | "pending" | "in_progress" => return "started",
            _ => {}
        }
    }
    for key in ["result", "output"] {
        if let Some(nested) = value.get(key) {
            if nested.is_object() && result_status(nested) == "failed" {
                return "failed";
            }
            if let Some(text) = nested.as_str() {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    if parsed.is_object() && result_status(&parsed) == "failed" {
                        return "failed";
                    }
                }
            }
        }
    }
    "completed"
}

/// Preserve one native call when an adapter yields separate request/result parts.
pub(super) fn merge_tool_events(events: Vec<HistoryToolEvent>) -> Vec<HistoryToolEvent> {
    let mut positions = std::collections::HashMap::<String, usize>::new();
    let mut merged: Vec<HistoryToolEvent> = Vec::with_capacity(events.len());
    for event in events {
        let position = event.call_id.as_ref().and_then(|id| positions.get(id)).copied();
        if let Some(position) = position {
            let previous = &mut merged[position];
            if event.category.starts_with("mcp:") { previous.category = event.category; }
            if event.input_summary.is_some() { previous.input_summary = event.input_summary; }
            if event.output_summary.is_some() { previous.output_summary = event.output_summary; }
            if event.duration_ms.is_some() { previous.duration_ms = event.duration_ms; }
            if event.status.as_deref().is_some_and(|s| !matches!(s, "started" | "running" | "pending")) {
                previous.status = event.status;
            }
        } else {
            if let Some(id) = &event.call_id { positions.insert(id.clone(), merged.len()); }
            merged.push(event);
        }
    }
    merged
}

pub(super) fn is_inferred(event: &HistoryToolEvent) -> bool {
    event.evidence.as_ref().is_some_and(|e| e.kind == "inferred")
}

pub(super) fn reconcile_tool_stats(stats: &mut SessionStatsScan, events: &[HistoryToolEvent]) {
    // A summary-only native source may report a total with no per-call data.
    if events.is_empty() { return; }
    stats.tool_call_count = 0;
    stats.mcp_calls.clear();
    stats.builtin_calls.clear();
    let mut skills = std::collections::HashMap::new();
    for event in events.iter().filter(|event| !is_inferred(event)) {
        stats.tool_call_count += 1;
        if let Some(server) = event.category.strip_prefix("mcp:") {
            *stats.mcp_calls.entry(server.to_string()).or_insert(0) += 1;
        } else if event.category == "mcp" {
            // Compatibility with already materialized legacy observations.
            *stats.mcp_calls.entry(event.name.clone()).or_insert(0) += 1;
        } else if event.category == "skill" {
            let skill = event.input_summary.as_deref()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|value| value.get("skill").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| event.name.clone());
            *skills.entry(skill).or_insert(0) += 1;
        } else {
            *stats.builtin_calls.entry(event.name.clone()).or_insert(0) += 1;
        }
    }
    // Preserve native slash-command counts that have no tool event equivalent.
    for (name, count) in skills {
        let current = stats.skill_calls.entry(name).or_insert(0);
        *current = (*current).max(count);
    }
}
