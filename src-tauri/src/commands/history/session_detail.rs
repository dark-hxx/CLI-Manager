use super::{
    apply_codex_thread_name, codex_thread_name_index, get_or_scan_session_project, is_jsonl,
    is_subagent_transcript_path, list_subagent_transcript_files, parse_timestamp_millis_str,
    resolve_codex_config_root, resolve_codex_state_db_path, scan_file_changes,
    scan_session_computation_with_messages, scan_session_detail_parts_for_roots, scan_tool_events,
    session_file_fingerprint, sorted_tool_counts, stats_usage_events_or_fallback,
    summarize_file_change_operations, summary_from_computation, usage_stats_total_tokens,
    CachedSessionComputation, CodexThreadNameIndex, HistoryFileChangeOperation,
    HistoryIndexV2AdapterSession, HistoryIndexV2MessageRef, HistoryIndexV2RawPointer,
    HistoryIndexV2SessionRef, HistoryMessage, HistoryRoots, HistorySessionDetail,
    HistorySessionUsage, HistoryTokenTrendPoint, HistoryToolEvent, SessionDetailParts,
    SessionFileFingerprint, SessionFileRef, SessionStatsScan, SessionUsageEventScan,
    HISTORY_INDEX_V2_ADAPTER_MODEL_VERSION, HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION,
};
use std::collections::HashMap;
use std::path::Path;

pub(super) fn scan_session_detail_parts_with_thread_names(
    file_ref: &SessionFileRef,
    codex_thread_names: &CodexThreadNameIndex,
) -> SessionDetailParts {
    // detail 必然要读完整消息，单遍同时算出 stats，避免对同一文件二次读取/解析；
    let fingerprint = session_file_fingerprint(&file_ref.path);
    let (mut computed, messages) = scan_session_computation_with_messages(
        &file_ref.path,
        fingerprint.created_at,
        fingerprint.updated_at,
    );
    apply_codex_thread_name(file_ref, codex_thread_names, &mut computed);
    let tool_events = scan_tool_events(&file_ref.path);
    let file_changes = scan_file_changes(&file_ref.path);
    SessionDetailParts {
        computed,
        cwd: get_or_scan_session_project(&file_ref.path).cwd,
        messages,
        tool_events,
        file_changes,
    }
}

pub(super) fn finalize_session_detail(
    file_ref: &SessionFileRef,
    parts: SessionDetailParts,
) -> HistorySessionDetail {
    let is_subagent = is_subagent_transcript_path(&file_ref.path);
    let messages = if is_subagent {
        parts
            .messages
            .into_iter()
            .map(|mut message| {
                message.editable = false;
                message.editable_text = None;
                message
            })
            .collect()
    } else {
        parts.messages
    };
    let usage = HistorySessionUsage {
        input_tokens: parts.computed.stats.input_tokens,
        output_tokens: parts.computed.stats.output_tokens,
        cache_read_tokens: parts.computed.stats.cache_read_tokens,
        cache_creation_tokens: parts.computed.stats.cache_creation_tokens,
        total_cost_usd: parts.computed.stats.total_cost_usd,
        dominant_model: parts.computed.stats.dominant_model.clone(),
        current_model: parts.computed.stats.current_model.clone(),
        context_window: parts.computed.stats.context_window,
        last_context_tokens: parts.computed.stats.last_context_tokens,
        reasoning_effort: parts.computed.stats.reasoning_effort.clone(),
        token_trend: parts.computed.stats.token_trend.clone(),
        tool_call_count: parts.computed.stats.tool_call_count,
        mcp_calls: sorted_tool_counts(&parts.computed.stats.mcp_calls),
        skill_calls: sorted_tool_counts(&parts.computed.stats.skill_calls),
        builtin_calls: sorted_tool_counts(&parts.computed.stats.builtin_calls),
    };
    HistorySessionDetail {
        session_id: parts.computed.session_id,
        source: file_ref.source.clone(),
        project_key: file_ref.project_key.clone(),
        title: parts.computed.title,
        file_path: file_ref.path.to_string_lossy().to_string(),
        cwd: parts.cwd,
        created_at: parts.computed.created_at,
        updated_at: parts.computed.updated_at,
        message_count: messages.len(),
        branch: parts.computed.branch,
        usage,
        tool_events: parts.tool_events,
        file_changes: parts.file_changes,
        messages,
    }
}

pub(super) fn v2_fingerprint_value(fingerprint: SessionFileFingerprint) -> String {
    format!(
        "mtime_ms={};ctime_ms={};size={}",
        fingerprint.updated_at, fingerprint.created_at, fingerprint.size
    )
}

pub(super) fn v2_path_pointer(role: &str, kind: &str, path: &Path) -> HistoryIndexV2RawPointer {
    HistoryIndexV2RawPointer {
        role: role.to_string(),
        kind: kind.to_string(),
        path: Some(path.to_string_lossy().to_string()),
        line_index: None,
        raw_key: None,
    }
}

pub(super) fn session_file_kind(source: &str, path: &Path) -> String {
    if is_jsonl(path) {
        format!("{source}-jsonl")
    } else {
        format!("{source}-json")
    }
}

pub(super) fn v2_message_raw_pointers(
    file_ref: &SessionFileRef,
    message: &HistoryMessage,
) -> Vec<HistoryIndexV2RawPointer> {
    message
        .line_index
        .map(|line_index| HistoryIndexV2RawPointer {
            role: "message".to_string(),
            kind: format!(
                "{}-line",
                session_file_kind(&file_ref.source, &file_ref.path)
            ),
            path: Some(file_ref.path.to_string_lossy().to_string()),
            line_index: Some(line_index),
            raw_key: None,
        })
        .into_iter()
        .collect()
}

pub(super) fn v2_session_raw_pointers(
    file_ref: &SessionFileRef,
    roots: &HistoryRoots,
    source_session_id: &str,
) -> (
    Option<String>,
    Option<String>,
    Vec<HistoryIndexV2RawPointer>,
) {
    let primary_path = file_ref.path.to_string_lossy().to_string();
    let mut pointers = vec![v2_path_pointer(
        "primary",
        &session_file_kind(&file_ref.source, &file_ref.path),
        &file_ref.path,
    )];

    let database_path = if file_ref.source == "codex" {
        let history_index_path = resolve_codex_config_root(roots).join("history.jsonl");
        let session_index_path = resolve_codex_config_root(roots).join("session_index.jsonl");
        let state_db_path = resolve_codex_state_db_path(roots);
        pointers.push(HistoryIndexV2RawPointer {
            role: "registry".to_string(),
            kind: "codex-history-jsonl".to_string(),
            path: Some(history_index_path.to_string_lossy().to_string()),
            line_index: None,
            raw_key: Some(source_session_id.to_string()),
        });
        pointers.push(HistoryIndexV2RawPointer {
            role: "registry".to_string(),
            kind: "codex-session-index-jsonl".to_string(),
            path: Some(session_index_path.to_string_lossy().to_string()),
            line_index: None,
            raw_key: Some(source_session_id.to_string()),
        });
        pointers.push(HistoryIndexV2RawPointer {
            role: "database".to_string(),
            kind: "codex-state-thread-row".to_string(),
            path: Some(state_db_path.to_string_lossy().to_string()),
            line_index: None,
            raw_key: Some(source_session_id.to_string()),
        });
        Some(state_db_path.to_string_lossy().to_string())
    } else {
        None
    };

    (Some(primary_path), database_path, pointers)
}

pub(super) fn build_v2_adapter_session(
    file_ref: &SessionFileRef,
    roots: &HistoryRoots,
) -> HistoryIndexV2AdapterSession {
    let fingerprint = session_file_fingerprint(&file_ref.path);
    let codex_thread_names = codex_thread_name_index(roots);
    let parts = scan_session_detail_parts_with_thread_names(file_ref, &codex_thread_names);
    build_v2_adapter_session_from_parts(file_ref, roots, fingerprint, &parts)
}

pub(super) fn build_v2_adapter_session_from_parts(
    file_ref: &SessionFileRef,
    roots: &HistoryRoots,
    fingerprint: SessionFileFingerprint,
    parts: &SessionDetailParts,
) -> HistoryIndexV2AdapterSession {
    let source_session_id = parts.computed.session_id.clone();
    let raw_key = if file_ref.source == "codex" {
        Some(source_session_id.clone())
    } else {
        None
    };
    let (primary_path, database_path, raw_pointers) =
        v2_session_raw_pointers(file_ref, roots, &source_session_id);
    let messages = parts
        .messages
        .iter()
        .enumerate()
        .map(|(message_index, message)| HistoryIndexV2MessageRef {
            message_index,
            role: message.role.clone(),
            display_content: message.content.clone(),
            timestamp_ms: message
                .timestamp
                .as_deref()
                .and_then(parse_timestamp_millis_str),
            model: message.model.clone(),
            input_tokens: message.input_tokens,
            output_tokens: message.output_tokens,
            cache_read_tokens: message.cache_read_tokens,
            cache_creation_tokens: message.cache_creation_tokens,
            editable: message.editable,
            raw_pointers: v2_message_raw_pointers(file_ref, message),
            parts: message.parts.clone(),
        })
        .collect();

    HistoryIndexV2AdapterSession {
        parser_version: HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION,
        model_version: HISTORY_INDEX_V2_ADAPTER_MODEL_VERSION,
        session_ref: HistoryIndexV2SessionRef {
            source_id: file_ref.source.clone(),
            source_session_id,
            storage_kind: if file_ref.source == "codex" {
                "mixed".to_string()
            } else {
                "file".to_string()
            },
            project_key: file_ref.project_key.clone(),
            cwd: parts.cwd.clone(),
            title: parts.computed.title.clone(),
            branch: parts.computed.branch.clone(),
            primary_path,
            database_path,
            raw_key,
            created_at: parts.computed.created_at,
            updated_at: parts.computed.updated_at,
            fingerprint_kind: "file-stat".to_string(),
            fingerprint_value: v2_fingerprint_value(fingerprint),
            raw_pointers,
        },
        messages,
    }
}

pub(crate) fn build_session_detail(
    file_ref: &SessionFileRef,
    aggregate_subtasks: bool,
) -> Result<HistorySessionDetail, String> {
    build_session_detail_with_roots(file_ref, aggregate_subtasks, &HistoryRoots::default())
}

pub(super) fn build_session_detail_with_roots(
    file_ref: &SessionFileRef,
    aggregate_subtasks: bool,
    roots: &HistoryRoots,
) -> Result<HistorySessionDetail, String> {
    let codex_thread_names = codex_thread_name_index(roots);
    let parent_parts = scan_session_detail_parts_for_roots(file_ref, &codex_thread_names);
    if !aggregate_subtasks {
        return Ok(finalize_session_detail(file_ref, parent_parts));
    }

    let subtask_refs = collect_subtask_session_file_refs(file_ref);
    if subtask_refs.is_empty() {
        return Ok(finalize_session_detail(file_ref, parent_parts));
    }

    let mut parts = Vec::with_capacity(subtask_refs.len() + 1);
    parts.push(parent_parts);
    for subtask_ref in subtask_refs {
        parts.push(scan_session_detail_parts_for_roots(
            &subtask_ref,
            &codex_thread_names,
        ));
    }

    Ok(finalize_session_detail(
        file_ref,
        merge_session_detail_parts(file_ref, parts),
    ))
}

pub(super) fn merge_session_detail_parts(
    file_ref: &SessionFileRef,
    parts: Vec<SessionDetailParts>,
) -> SessionDetailParts {
    let parent_session_id = parts
        .first()
        .map(|part| part.computed.session_id.clone())
        .unwrap_or_else(|| {
            file_ref
                .path
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown-session".to_string())
        });
    let parent_title = parts
        .first()
        .map(|part| part.computed.title.clone())
        .unwrap_or_else(|| parent_session_id.clone());
    let mut created_at = i64::MAX;
    let mut updated_at = 0i64;
    let mut branch = None;
    let mut cwd = None;
    let mut latest_context_updated_at = i64::MIN;
    let mut context_window = None;
    let mut last_context_tokens = None;
    let mut current_model = None;
    let mut reasoning_effort = None;
    let mut tool_call_count = 0u64;
    let mut mcp_calls: HashMap<String, u64> = HashMap::new();
    let mut skill_calls: HashMap<String, u64> = HashMap::new();
    let mut builtin_calls: HashMap<String, u64> = HashMap::new();
    let mut usage_events: Vec<(i64, usize, SessionUsageEventScan)> = Vec::new();
    let mut message_rows: Vec<(bool, i64, usize, HistoryMessage)> = Vec::new();
    let mut tool_event_rows: Vec<(bool, i64, usize, HistoryToolEvent)> = Vec::new();
    let mut file_change_rows: Vec<(bool, i64, usize, HistoryFileChangeOperation)> = Vec::new();

    for (part_index, part) in parts.into_iter().enumerate() {
        created_at = created_at.min(part.computed.created_at);
        updated_at = updated_at.max(part.computed.updated_at);
        if branch.is_none() {
            branch = part.computed.branch.clone();
        }
        if cwd.is_none() {
            cwd = part.cwd.clone();
        }
        if part.computed.updated_at >= latest_context_updated_at {
            if part.computed.stats.current_model.is_some() {
                current_model = part.computed.stats.current_model.clone();
            }
            if part.computed.stats.context_window.is_some() {
                context_window = part.computed.stats.context_window;
            }
            if part.computed.stats.last_context_tokens.is_some() {
                last_context_tokens = part.computed.stats.last_context_tokens;
            }
            if part.computed.stats.reasoning_effort.is_some() {
                reasoning_effort = part.computed.stats.reasoning_effort.clone();
            }
            latest_context_updated_at = part.computed.updated_at;
        }
        tool_call_count = tool_call_count.saturating_add(part.computed.stats.tool_call_count);
        for (name, count) in &part.computed.stats.mcp_calls {
            *mcp_calls.entry(name.clone()).or_insert(0) += count;
        }
        for (name, count) in &part.computed.stats.skill_calls {
            *skill_calls.entry(name.clone()).or_insert(0) += count;
        }
        for (name, count) in &part.computed.stats.builtin_calls {
            *builtin_calls.entry(name.clone()).or_insert(0) += count;
        }

        let summary = summary_from_computation(
            &SessionFileRef {
                source: file_ref.source.clone(),
                project_key: file_ref.project_key.clone(),
                path: file_ref.path.clone(),
            },
            &part.computed,
        );
        for (event_index, event) in stats_usage_events_or_fallback(&summary, &part.computed.stats)
            .into_iter()
            .enumerate()
        {
            let sort_ts = event.timestamp_ms.unwrap_or(part.computed.updated_at);
            usage_events.push((sort_ts, part_index * 10_000 + event_index, event));
        }
        for (message_index, mut message) in part.messages.into_iter().enumerate() {
            // 子任务聚合消息来自兄弟 transcript 文件，行号对父会话文件无意义；
            // 清空行映射与编辑标记，聚合视图（实时统计）不提供消息编辑。
            if part_index > 0 {
                message.line_index = None;
                message.editable = false;
                message.editable_text = None;
            }
            let ts = message
                .timestamp
                .as_deref()
                .and_then(parse_timestamp_millis_str)
                .unwrap_or(part.computed.updated_at);
            message_rows.push((
                message.timestamp.is_none(),
                ts,
                part_index * 10_000 + message_index,
                message,
            ));
        }
        for (event_index, tool_event) in part.tool_events.into_iter().enumerate() {
            let ts = tool_event
                .timestamp
                .as_deref()
                .and_then(parse_timestamp_millis_str)
                .unwrap_or(part.computed.updated_at);
            tool_event_rows.push((
                tool_event.timestamp.is_none(),
                ts,
                part_index * 10_000 + event_index,
                tool_event,
            ));
        }
        for (summary_index, summary) in part.file_changes.into_iter().enumerate() {
            for (op_index, mut operation) in summary.operations.into_iter().enumerate() {
                if let Some(group_index) = operation.operation_group_index {
                    operation.operation_group_index = Some(part_index * 10_000 + group_index);
                }
                let ts = operation
                    .timestamp
                    .as_deref()
                    .and_then(parse_timestamp_millis_str)
                    .unwrap_or(part.computed.updated_at);
                file_change_rows.push((
                    operation.timestamp.is_none(),
                    ts,
                    part_index * 100_000 + summary_index * 1_000 + op_index,
                    operation,
                ));
            }
        }
    }

    usage_events.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    message_rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    tool_event_rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    file_change_rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));

    let mut merged_stats = SessionStatsScan {
        context_window,
        last_context_tokens,
        current_model,
        reasoning_effort,
        tool_call_count,
        mcp_calls,
        skill_calls,
        builtin_calls,
        ..SessionStatsScan::default()
    };
    for (_, _, event) in &usage_events {
        merged_stats.input_tokens = merged_stats
            .input_tokens
            .saturating_add(event.usage.input_tokens);
        merged_stats.output_tokens = merged_stats
            .output_tokens
            .saturating_add(event.usage.output_tokens);
        merged_stats.cache_read_tokens = merged_stats
            .cache_read_tokens
            .saturating_add(event.usage.cache_read_tokens);
        merged_stats.cache_creation_tokens = merged_stats
            .cache_creation_tokens
            .saturating_add(event.usage.cache_creation_tokens);
        merged_stats.total_cost_usd += event.usage.total_cost_usd;
        merged_stats.unpriced_tokens = merged_stats
            .unpriced_tokens
            .saturating_add(event.usage.unpriced_tokens);
        merged_stats.usage_events.push(event.clone());

        if let Some(model) = event.model.clone() {
            let entry = merged_stats.model_usage.entry(model).or_default();
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
    }

    merged_stats.token_trend = usage_events
        .iter()
        .map(|(_, _, event)| HistoryTokenTrendPoint {
            input_tokens: event.usage.input_tokens,
            output_tokens: event.usage.output_tokens,
            cache_read_tokens: event.usage.cache_read_tokens,
            cache_creation_tokens: event.usage.cache_creation_tokens,
            total_tokens: usage_stats_total_tokens(event.usage),
            model: event.model.clone(),
        })
        .filter(|point| point.total_tokens > 0)
        .collect();

    merged_stats.dominant_model = merged_stats
        .model_usage
        .iter()
        .max_by(|(left_model, left_usage), (right_model, right_usage)| {
            usage_stats_total_tokens(**left_usage)
                .cmp(&usage_stats_total_tokens(**right_usage))
                .then_with(|| right_model.cmp(left_model))
        })
        .map(|(model, _)| model.clone());
    merged_stats.current_model = usage_events
        .iter()
        .rev()
        .find_map(|(_, _, event)| event.model.clone())
        .or(merged_stats.current_model);

    let messages = message_rows
        .into_iter()
        .map(|(_, _, _, message)| message)
        .collect::<Vec<_>>();
    let tool_events = tool_event_rows
        .into_iter()
        .map(|(_, _, _, tool_event)| tool_event)
        .collect::<Vec<_>>();
    let file_changes = summarize_file_change_operations(
        file_change_rows
            .into_iter()
            .map(|(_, _, _, operation)| operation)
            .collect(),
    );

    SessionDetailParts {
        computed: CachedSessionComputation {
            created_at: if created_at == i64::MAX {
                0
            } else {
                created_at
            },
            updated_at,
            session_id: parent_session_id,
            parent_session_id: None,
            title: parent_title,
            message_count: messages.len(),
            branch,
            stats: merged_stats,
        },
        cwd,
        messages,
        tool_events,
        file_changes,
    }
}

pub(super) fn collect_subtask_session_file_refs(
    parent_file_ref: &SessionFileRef,
) -> Vec<SessionFileRef> {
    if is_subagent_transcript_path(&parent_file_ref.path) {
        return Vec::new();
    }
    let Some(parent_dir) = parent_file_ref.path.parent() else {
        return Vec::new();
    };
    let subagents_dir = parent_dir.join("subagents");
    let mut paths = list_subagent_transcript_files(&subagents_dir);
    paths.sort();
    paths
        .into_iter()
        .map(|path| SessionFileRef {
            source: parent_file_ref.source.clone(),
            project_key: parent_file_ref.project_key.clone(),
            path,
        })
        .collect()
}
