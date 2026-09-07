use super::{
    cline_api_message_values, cline_ui_timestamps, collect_tool_events_from_value,
    copilot_message_from_event, extract_content, extract_timestamp, grok_event_timestamp,
    grok_tool_call_id, grok_tool_input, grok_tool_name, grok_tool_output, grok_tool_status,
    grok_update_value, json_content_text, kimi, looks_like_cline_session_file,
    looks_like_copilot_events_file, looks_like_grok_updates_file, looks_like_patch,
    looks_like_pi_session_file, make_tool_event, mark_tool_event_seen, parse_message,
    scan_pi_tool_events, scan_session_inner, update_tool_event_output, HistoryFileChangeOperation,
    HistoryFileChangeSummary, HistoryMessage, HistoryToolEvent, SessionStatsScan,
    SessionSummaryScan, READ_BUF_CAPACITY,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;

/// 仅需 summary + stats 的调用方（list / stats 聚合）使用，不收集消息体。
pub(super) fn scan_session_combined(path: &Path) -> (SessionSummaryScan, SessionStatsScan) {
    let (summary, stats, _) = scan_session_inner(path, false);
    (summary, stats)
}

/// detail 路径使用：单遍同时取得 summary、stats 与完整消息列表，避免二次读取与解析。
pub(super) fn scan_session_detail(
    path: &Path,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    scan_session_inner(path, true)
}

pub(super) fn scan_tool_events(path: &Path) -> Vec<HistoryToolEvent> {
    if looks_like_grok_updates_file(path) {
        return scan_grok_tool_events(path);
    }
    if kimi::looks_like_kimi_main_wire(path) {
        return kimi::scan_kimi_tool_events(path);
    }
    if looks_like_pi_session_file(path) {
        return scan_pi_tool_events(path);
    }
    if looks_like_cline_session_file(path) {
        return scan_cline_tool_events(path);
    }
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    let mut message_index = 0usize;
    let mut seen_call_ids: HashSet<String> = HashSet::new();
    let copilot_events = looks_like_copilot_events_file(path);

    for line in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let current_message_index = if (copilot_events
            && copilot_message_from_event(&value, message_index).is_some())
            || (!copilot_events && parse_message(&value).is_some())
        {
            let index = Some(message_index);
            message_index += 1;
            index
        } else {
            None
        };

        collect_tool_events_from_value(
            &value,
            current_message_index,
            &mut seen_call_ids,
            &mut events,
        );
    }
    events
}

pub(super) fn scan_grok_tool_events(path: &Path) -> Vec<HistoryToolEvent> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    let mut seen_call_ids = HashSet::new();
    for line in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
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
            "tool_call" => {
                let Some(name) = grok_tool_name(update) else {
                    continue;
                };
                let call_id = grok_tool_call_id(update);
                if mark_tool_event_seen(call_id.as_deref(), &mut seen_call_ids) {
                    events.push(make_tool_event(
                        call_id,
                        &name,
                        None,
                        grok_event_timestamp(&value, update),
                        Some("started"),
                        None,
                        grok_tool_input(update),
                        None,
                        None,
                    ));
                }
            }
            "tool_call_update" => {
                let call_id = grok_tool_call_id(update);
                let output = grok_tool_output(update);
                let status = grok_tool_status(update);
                if let Some(name) = grok_tool_name(update) {
                    if mark_tool_event_seen(call_id.as_deref(), &mut seen_call_ids) {
                        events.push(make_tool_event(
                            call_id,
                            &name,
                            None,
                            grok_event_timestamp(&value, update),
                            status.as_deref(),
                            None,
                            grok_tool_input(update),
                            output,
                            None,
                        ));
                    } else {
                        update_tool_event_output(&mut events, call_id.as_deref(), output, status);
                    }
                } else {
                    update_tool_event_output(&mut events, call_id.as_deref(), output, status);
                }
            }
            _ => {}
        }
    }
    events
}

pub(super) fn scan_cline_tool_events(path: &Path) -> Vec<HistoryToolEvent> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };

    let timestamps = cline_ui_timestamps(path);
    let mut events = Vec::new();
    let mut seen_call_ids = HashSet::new();
    let mut message_index = 0usize;

    for (index, entry) in cline_api_message_values(&value).into_iter().enumerate() {
        let current_message_index = if parse_message(entry).is_some() {
            let current = Some(message_index);
            message_index += 1;
            current
        } else {
            None
        };
        let mut wrapped = json!({ "message": entry });
        if wrapped.get("timestamp").is_none() {
            if let Some(timestamp) = timestamps.get(index).cloned().flatten() {
                wrapped["timestamp"] = Value::String(timestamp);
            }
        }
        collect_tool_events_from_value(
            &wrapped,
            current_message_index,
            &mut seen_call_ids,
            &mut events,
        );
        update_cline_tool_results(entry, &mut events);
    }

    events
}

pub(super) fn update_cline_tool_results(entry: &Value, events: &mut [HistoryToolEvent]) {
    let Some(blocks) = entry.get("content").and_then(Value::as_array) else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let call_id = block
            .get("tool_use_id")
            .or_else(|| block.get("toolUseId"))
            .or_else(|| block.get("id"))
            .and_then(Value::as_str);
        update_tool_event_output(
            events,
            call_id,
            block.get("content").and_then(json_content_text),
            Some("completed".to_string()),
        );
    }
}

pub(super) fn scan_file_changes(path: &Path) -> Vec<HistoryFileChangeSummary> {
    if looks_like_cline_session_file(path) {
        return scan_cline_file_changes(path);
    }
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut operations = Vec::new();
    let mut message_index = 0usize;
    let mut operation_group_index = 0usize;
    let mut seen_call_ids: HashSet<String> = HashSet::new();

    for line in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let current_message_index = if parse_message(&value).is_some() {
            let index = Some(message_index);
            message_index += 1;
            index
        } else {
            None
        };

        let timestamp = extract_timestamp(&value);
        let extracted = collect_file_changes_from_value(
            &value,
            current_message_index,
            Some(operation_group_index),
            timestamp,
            &mut seen_call_ids,
        );
        if extracted.is_empty() {
            continue;
        }
        operations.extend(extracted);
        operation_group_index += 1;
    }

    summarize_file_change_operations(operations)
}

pub(super) fn scan_cline_file_changes(path: &Path) -> Vec<HistoryFileChangeSummary> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let mut operations = Vec::new();
    let mut seen_call_ids = HashSet::new();
    let mut operation_group_index = 0usize;

    for (message_index, entry) in cline_api_message_values(&value).into_iter().enumerate() {
        let wrapped = json!({ "message": entry });
        let extracted = collect_file_changes_from_value(
            &wrapped,
            Some(message_index),
            Some(operation_group_index),
            extract_timestamp(entry),
            &mut seen_call_ids,
        );
        if extracted.is_empty() {
            continue;
        }
        operations.extend(extracted);
        operation_group_index += 1;
    }

    summarize_file_change_operations(operations)
}

pub(super) fn collect_file_changes_from_value(
    value: &Value,
    message_index: Option<usize>,
    operation_group_index: Option<usize>,
    timestamp: Option<String>,
    seen_call_ids: &mut HashSet<String>,
) -> Vec<HistoryFileChangeOperation> {
    let mut operations = Vec::new();

    if let Some(blocks) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let tool_name = block
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if let Some(call_id) = block
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|call_id| !call_id.is_empty())
            {
                if !seen_call_ids.insert(call_id.to_string()) {
                    continue;
                }
            }
            if let Some(input) = block.get("input") {
                operations.extend(extract_file_changes_from_input_value(
                    tool_name,
                    input,
                    "tool_input",
                    message_index,
                    operation_group_index,
                    timestamp.clone(),
                ));
            }
        }
    }

    if let Some(payload) = value.get("payload") {
        let payload_type = payload.get("type").and_then(Value::as_str);
        if matches!(
            payload_type,
            Some("function_call") | Some("custom_tool_call")
        ) {
            let tool_name = payload
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if let Some(call_id) = payload
                .get("call_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|call_id| !call_id.is_empty())
            {
                if !seen_call_ids.insert(call_id.to_string()) {
                    return operations;
                }
            }
            if let Some(input) = payload.get("input") {
                operations.extend(extract_file_changes_from_input_value(
                    tool_name,
                    input,
                    "tool_input",
                    message_index,
                    operation_group_index,
                    timestamp.clone(),
                ));
            }
            if let Some(arguments) = payload.get("arguments").and_then(Value::as_str) {
                operations.extend(extract_file_changes_from_arguments(
                    tool_name,
                    arguments,
                    message_index,
                    operation_group_index,
                    timestamp.clone(),
                ));
            }
        }
    }

    if value.get("type").and_then(Value::as_str) == Some("file-history-snapshot") {
        if let Some(content) = extract_content(value) {
            operations.extend(build_patch_file_change_operations(
                &content,
                None,
                message_index,
                operation_group_index,
                timestamp,
                "patch",
            ));
        }
    }

    operations
}

pub(super) fn extract_file_changes_from_arguments(
    tool_name: Option<&str>,
    arguments: &str,
    message_index: Option<usize>,
    operation_group_index: Option<usize>,
    timestamp: Option<String>,
) -> Vec<HistoryFileChangeOperation> {
    let mut operations = Vec::new();
    if let Ok(parsed) = serde_json::from_str::<Value>(arguments) {
        operations.extend(extract_file_changes_from_input_value(
            tool_name,
            &parsed,
            "tool_input",
            message_index,
            operation_group_index,
            timestamp.clone(),
        ));
    }
    if operations.is_empty() && looks_like_patch(arguments) {
        operations.extend(build_patch_file_change_operations(
            arguments,
            tool_name,
            message_index,
            operation_group_index,
            timestamp,
            "patch",
        ));
    }
    operations
}

pub(super) fn extract_file_changes_from_input_value(
    tool_name: Option<&str>,
    input: &Value,
    source: &str,
    message_index: Option<usize>,
    operation_group_index: Option<usize>,
    timestamp: Option<String>,
) -> Vec<HistoryFileChangeOperation> {
    let mut operations = Vec::new();

    if let Some(file_path) = extract_file_path_from_value(input) {
        if let Some(edits) = input.get("edits").and_then(Value::as_array) {
            for edit in edits {
                let old_text = extract_string_field(edit, &["old_string", "oldString"]);
                let new_text = extract_string_field(edit, &["new_string", "newString"]);
                if let Some(operation) = build_text_file_change_operation(
                    file_path.clone(),
                    tool_name.map(str::to_string),
                    old_text,
                    new_text,
                    message_index,
                    operation_group_index,
                    timestamp.clone(),
                    source,
                ) {
                    operations.push(operation);
                }
            }
        }

        let old_text = extract_string_field(input, &["old_string", "oldString"]);
        let new_text = extract_string_field(input, &["new_string", "newString"])
            .or_else(|| extract_string_field(input, &["content"]));
        if let Some(operation) = build_text_file_change_operation(
            file_path,
            tool_name.map(str::to_string),
            old_text,
            new_text,
            message_index,
            operation_group_index,
            timestamp.clone(),
            source,
        ) {
            operations.push(operation);
        }
    }

    if operations.is_empty() {
        if let Some(text) = input.as_str() {
            if looks_like_patch(text) {
                operations.extend(build_patch_file_change_operations(
                    text,
                    tool_name,
                    message_index,
                    operation_group_index,
                    timestamp,
                    "patch",
                ));
            }
        } else if let Some(command) = extract_string_field(input, &["command"]) {
            if looks_like_patch(&command) {
                operations.extend(build_patch_file_change_operations(
                    &command,
                    tool_name,
                    message_index,
                    operation_group_index,
                    timestamp,
                    "patch",
                ));
            }
        } else if let Some(patch) = extract_string_field(input, &["patch", "diff"]) {
            if looks_like_patch(&patch) {
                operations.extend(build_patch_file_change_operations(
                    &patch,
                    tool_name,
                    message_index,
                    operation_group_index,
                    timestamp,
                    "patch",
                ));
            }
        }
    }

    operations
}

pub(super) fn build_text_file_change_operation(
    file_path: String,
    tool_name: Option<String>,
    old_text: Option<String>,
    new_text: Option<String>,
    message_index: Option<usize>,
    operation_group_index: Option<usize>,
    timestamp: Option<String>,
    source: &str,
) -> Option<HistoryFileChangeOperation> {
    if old_text.is_none() && new_text.is_none() {
        return None;
    }
    let (additions, deletions) = count_text_changes(old_text.as_deref(), new_text.as_deref());
    Some(HistoryFileChangeOperation {
        source: source.to_string(),
        tool_name,
        file_path,
        old_text,
        new_text,
        patch: None,
        additions,
        deletions,
        message_index,
        operation_group_index,
        timestamp,
    })
}

pub(super) fn build_patch_file_change_operations(
    patch_text: &str,
    tool_name: Option<&str>,
    message_index: Option<usize>,
    operation_group_index: Option<usize>,
    timestamp: Option<String>,
    source: &str,
) -> Vec<HistoryFileChangeOperation> {
    split_patch_blocks(patch_text)
        .into_iter()
        .map(|patch| {
            let (additions, deletions) = count_patch_changes(&patch);
            HistoryFileChangeOperation {
                source: source.to_string(),
                tool_name: tool_name.map(str::to_string),
                file_path: extract_patch_file_path(&patch),
                old_text: None,
                new_text: None,
                patch: Some(patch),
                additions,
                deletions,
                message_index,
                operation_group_index,
                timestamp: timestamp.clone(),
            }
        })
        .collect()
}

pub(super) fn summarize_file_change_operations(
    mut operations: Vec<HistoryFileChangeOperation>,
) -> Vec<HistoryFileChangeSummary> {
    operations.sort_by(|left, right| {
        left.operation_group_index
            .cmp(&right.operation_group_index)
            .then(left.message_index.cmp(&right.message_index))
            .then(left.timestamp.cmp(&right.timestamp))
            .then(left.file_path.cmp(&right.file_path))
    });

    let mut grouped: BTreeMap<String, HistoryFileChangeSummary> = BTreeMap::new();
    for operation in operations {
        let file_path = operation.file_path.clone();
        let entry = grouped
            .entry(file_path.clone())
            .or_insert_with(|| HistoryFileChangeSummary {
                file_path: file_path.clone(),
                status: derive_file_change_status(&operation),
                additions: 0,
                deletions: 0,
                latest_message_index: operation.message_index,
                latest_operation_group_index: operation.operation_group_index,
                latest_timestamp: operation.timestamp.clone(),
                operations: Vec::new(),
            });
        entry.additions = entry.additions.saturating_add(operation.additions);
        entry.deletions = entry.deletions.saturating_add(operation.deletions);
        if is_newer_file_change(
            operation.operation_group_index,
            operation.message_index,
            operation.timestamp.as_deref(),
            entry.latest_operation_group_index,
            entry.latest_message_index,
            entry.latest_timestamp.as_deref(),
        ) {
            entry.status = derive_file_change_status(&operation);
            entry.latest_message_index = operation.message_index;
            entry.latest_operation_group_index = operation.operation_group_index;
            entry.latest_timestamp = operation.timestamp.clone();
        }
        entry.operations.push(operation);
    }

    let mut summaries = grouped.into_values().collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        right
            .latest_operation_group_index
            .cmp(&left.latest_operation_group_index)
            .then(right.latest_message_index.cmp(&left.latest_message_index))
            .then(right.latest_timestamp.cmp(&left.latest_timestamp))
            .then(left.file_path.cmp(&right.file_path))
    });
    summaries
}

pub(super) fn is_newer_file_change(
    candidate_group_index: Option<usize>,
    candidate_message_index: Option<usize>,
    candidate_timestamp: Option<&str>,
    current_group_index: Option<usize>,
    current_message_index: Option<usize>,
    current_timestamp: Option<&str>,
) -> bool {
    candidate_group_index
        .cmp(&current_group_index)
        .then(candidate_message_index.cmp(&current_message_index))
        .then(candidate_timestamp.cmp(&current_timestamp))
        .is_gt()
}

pub(super) fn derive_file_change_status(operation: &HistoryFileChangeOperation) -> String {
    if let Some(patch) = &operation.patch {
        for line in patch.lines() {
            if line.starts_with("*** Add File: ") || line.starts_with("new file mode ") {
                return "A".to_string();
            }
            if line.starts_with("*** Delete File: ") || line.starts_with("deleted file mode ") {
                return "D".to_string();
            }
            if let Some(path) = line.strip_prefix("--- ") {
                if path.trim() == "/dev/null" {
                    return "A".to_string();
                }
            }
            if let Some(path) = line.strip_prefix("+++ ") {
                if path.trim() == "/dev/null" {
                    return "D".to_string();
                }
            }
        }
    }

    match (
        operation.old_text.as_deref().map(|text| !text.is_empty()),
        operation.new_text.as_deref().map(|text| !text.is_empty()),
    ) {
        (Some(false), Some(true)) | (None, Some(true)) => "A".to_string(),
        (Some(true), Some(false)) | (Some(true), None) => "D".to_string(),
        _ => "M".to_string(),
    }
}

pub(super) fn extract_file_path_from_value(value: &Value) -> Option<String> {
    extract_string_field(
        value,
        &["file_path", "filePath", "path", "target_file", "targetFile"],
    )
    .map(|path| path.trim().to_string())
    .filter(|path| !path.is_empty())
}

pub(super) fn extract_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    keys.iter()
        .find_map(|key| object.get(*key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(super) fn count_patch_changes(patch: &str) -> (u64, u64) {
    let mut additions = 0u64;
    let mut deletions = 0u64;
    for line in patch.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        }
        if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (additions, deletions)
}

pub(super) fn count_text_changes(old_text: Option<&str>, new_text: Option<&str>) -> (u64, u64) {
    let old_text = old_text.unwrap_or_default();
    let new_text = new_text.unwrap_or_default();
    if old_text == new_text {
        return (0, 0);
    }
    if old_text.is_empty() {
        return (count_text_lines(new_text), 0);
    }
    if new_text.is_empty() {
        return (0, count_text_lines(old_text));
    }

    let old_lines = old_text.lines().collect::<Vec<_>>();
    let new_lines = new_text.lines().collect::<Vec<_>>();
    if old_lines.len().saturating_mul(new_lines.len()) > 40_000 {
        return (new_lines.len() as u64, old_lines.len() as u64);
    }

    let mut previous = vec![0usize; new_lines.len() + 1];
    let mut current = vec![0usize; new_lines.len() + 1];
    for old_line in &old_lines {
        for (index, new_line) in new_lines.iter().enumerate() {
            current[index + 1] = if old_line == new_line {
                previous[index] + 1
            } else {
                previous[index + 1].max(current[index])
            };
        }
        std::mem::swap(&mut previous, &mut current);
        current.fill(0);
    }

    let lcs = previous[new_lines.len()];
    (
        new_lines.len().saturating_sub(lcs) as u64,
        old_lines.len().saturating_sub(lcs) as u64,
    )
}

pub(super) fn count_text_lines(text: &str) -> u64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as u64
    }
}

pub(super) fn split_patch_blocks(content: &str) -> Vec<String> {
    let decoded = decode_embedded_apply_patch(content);
    let content = decoded.as_deref().unwrap_or(content);

    if content.contains("*** Begin Patch") || content.contains("*** Update File: ") {
        let apply_blocks = split_apply_patch_blocks(content);
        if !apply_blocks.is_empty() {
            return apply_blocks;
        }
    }

    if content.contains("diff --git ") {
        let unified_blocks = split_unified_diff_blocks(content);
        if !unified_blocks.is_empty() {
            return unified_blocks;
        }
    }

    if looks_like_patch(content) {
        return vec![content.trim().to_string()];
    }

    Vec::new()
}

pub(super) fn decode_embedded_apply_patch(content: &str) -> Option<String> {
    let start = content.find("*** Begin Patch")?;
    let patch = &content[start..];
    let end = patch.find("*** End Patch")? + "*** End Patch".len();
    let encoded = &patch[..end];
    if !encoded.contains("\\n") && !encoded.contains("\\r") {
        return None;
    }

    let mut decoded = String::with_capacity(encoded.len());
    let mut chars = encoded.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            decoded.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => decoded.push('\n'),
            Some('r') => decoded.push('\r'),
            Some('t') => decoded.push('\t'),
            Some('\\') => decoded.push('\\'),
            Some('"') => decoded.push('"'),
            Some(other) => {
                decoded.push('\\');
                decoded.push(other);
            }
            None => decoded.push('\\'),
        }
    }
    Some(decoded)
}

pub(super) fn split_apply_patch_blocks(content: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = Vec::new();

    for line in content.lines() {
        let is_file_header = line.starts_with("*** Update File: ")
            || line.starts_with("*** Add File: ")
            || line.starts_with("*** Delete File: ");
        if is_file_header && !current.is_empty() {
            let block = current.join("\n").trim().to_string();
            if !block.is_empty() {
                blocks.push(block);
            }
            current.clear();
        }
        if line.starts_with("*** Begin Patch") || line.starts_with("*** End Patch") {
            continue;
        }
        if is_file_header || !current.is_empty() {
            current.push(line.to_string());
        }
    }

    if !current.is_empty() {
        let block = current.join("\n").trim().to_string();
        if !block.is_empty() {
            blocks.push(block);
        }
    }

    blocks
}

pub(super) fn split_unified_diff_blocks(content: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = Vec::new();

    for line in content.lines() {
        if line.starts_with("diff --git ") && !current.is_empty() {
            let block = current.join("\n").trim().to_string();
            if !block.is_empty() {
                blocks.push(block);
            }
            current.clear();
        }
        if line.starts_with("diff --git ") || !current.is_empty() {
            current.push(line.to_string());
        }
    }

    if !current.is_empty() {
        let block = current.join("\n").trim().to_string();
        if !block.is_empty() {
            blocks.push(block);
        }
    }

    blocks
}

pub(super) fn extract_patch_file_path(patch: &str) -> String {
    for line in patch.lines() {
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            return path.trim().to_string();
        }
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            return path.trim().to_string();
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            return path.trim().to_string();
        }
        if let Some(path) = line.strip_prefix("diff --git a/") {
            if let Some((_, right)) = path.split_once(" b/") {
                return right.trim().to_string();
            }
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            let normalized = path.trim().trim_start_matches("b/").trim();
            if !normalized.is_empty() && normalized != "/dev/null" {
                return normalized.to_string();
            }
        }
    }
    "unknown-file".to_string()
}
