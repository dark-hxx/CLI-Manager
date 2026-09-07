use super::{
    parse_opencode_database, parse_opencode_session_locator, path_equals_lenient,
    resolve_opencode_database_path, sorted_tool_counts, HistorySessionDetail,
    HistorySessionSummary, HistorySessionUsage, OpenCodeParsedSession,
};

pub(super) async fn build_opencode_session_detail(
    file_path: &str,
    summary: HistorySessionSummary,
) -> Result<HistorySessionDetail, String> {
    let (db_path, session_id) = parse_opencode_session_locator(file_path)
        .ok_or_else(|| "invalid_session_file".to_string())?;
    if !path_equals_lenient(&db_path, &resolve_opencode_database_path()) {
        return Err("session_file_outside_history_scope".to_string());
    }
    let mut sessions = parse_opencode_database(&db_path, Some(&session_id)).await?;
    let parsed = sessions
        .pop()
        .ok_or_else(|| "session_file_not_indexed".to_string())?;
    Ok(finalize_opencode_detail(parsed, summary))
}

pub(super) fn finalize_opencode_detail(
    parsed: OpenCodeParsedSession,
    summary: HistorySessionSummary,
) -> HistorySessionDetail {
    let usage = HistorySessionUsage {
        input_tokens: parsed.computed.stats.input_tokens,
        output_tokens: parsed.computed.stats.output_tokens,
        cache_read_tokens: parsed.computed.stats.cache_read_tokens,
        cache_creation_tokens: parsed.computed.stats.cache_creation_tokens,
        total_cost_usd: parsed.computed.stats.total_cost_usd,
        dominant_model: parsed.computed.stats.dominant_model.clone(),
        current_model: parsed.computed.stats.current_model.clone(),
        context_window: parsed.computed.stats.context_window,
        last_context_tokens: parsed.computed.stats.last_context_tokens,
        reasoning_effort: parsed.computed.stats.reasoning_effort.clone(),
        token_trend: parsed.computed.stats.token_trend.clone(),
        tool_call_count: parsed.computed.stats.tool_call_count,
        mcp_calls: sorted_tool_counts(&parsed.computed.stats.mcp_calls),
        skill_calls: sorted_tool_counts(&parsed.computed.stats.skill_calls),
        builtin_calls: sorted_tool_counts(&parsed.computed.stats.builtin_calls),
    };
    HistorySessionDetail {
        session_id: parsed.computed.session_id,
        source: "opencode".to_string(),
        project_key: summary.project_key,
        title: parsed.computed.title,
        file_path: summary.file_path,
        cwd: parsed.cwd,
        created_at: parsed.computed.created_at,
        updated_at: parsed.computed.updated_at,
        message_count: parsed.messages.len(),
        branch: None,
        usage,
        tool_events: parsed.tool_events,
        file_changes: Vec::new(),
        messages: parsed.messages,
    }
}
