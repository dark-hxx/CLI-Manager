use super::{
    HistorySessionDetail, HistoryStatsResponse, OOM_HISTORY_DETAIL_WARN_BYTES,
    OOM_HISTORY_MESSAGES_WARN_COUNT, OOM_HISTORY_STATS_WARN_BYTES,
};
use log::{debug, warn};

// 累计消息正文、工具摘要及文件变更文本的字节数，不计结构开销。
pub(super) fn estimate_history_detail_content_bytes(detail: &HistorySessionDetail) -> usize {
    let message_bytes: usize = detail
        .messages
        .iter()
        .map(|message| message.content.len())
        .sum();
    let tool_bytes: usize = detail
        .tool_events
        .iter()
        .map(|event| {
            event.input_summary.as_ref().map_or(0, |value| value.len())
                + event.output_summary.as_ref().map_or(0, |value| value.len())
        })
        .sum();
    let file_change_bytes: usize = detail
        .file_changes
        .iter()
        .flat_map(|change| change.operations.iter())
        .map(|operation| {
            operation.old_text.as_ref().map_or(0, |value| value.len())
                + operation.new_text.as_ref().map_or(0, |value| value.len())
                + operation.patch.as_ref().map_or(0, |value| value.len())
        })
        .sum();
    message_bytes + tool_bytes + file_change_bytes
}

// 累计详情中各文件包含的变更操作数量。
pub(super) fn history_detail_operation_count(detail: &HistorySessionDetail) -> usize {
    detail
        .file_changes
        .iter()
        .map(|change| change.operations.len())
        .sum()
}

// 按内容大小或消息数阈值选择日志级别，记录详情规模与耗时。
pub(super) fn log_history_detail_oom_diagnostic(
    phase: &str,
    detail: &HistorySessionDetail,
    elapsed_ms: u128,
) {
    let content_bytes = estimate_history_detail_content_bytes(detail);
    let operation_count = history_detail_operation_count(detail);
    let threshold_exceeded = content_bytes >= OOM_HISTORY_DETAIL_WARN_BYTES
        || detail.messages.len() >= OOM_HISTORY_MESSAGES_WARN_COUNT;
    if threshold_exceeded {
        warn!(
            "[oom-diagnostics:backend] area=history phase={phase} source={} project_key={} session_id={} messages={} content_bytes={} token_trend={} tool_events={} file_changes={} file_change_operations={} elapsed_ms={} threshold_exceeded=true",
            detail.source,
            detail.project_key,
            detail.session_id,
            detail.messages.len(),
            content_bytes,
            detail.usage.token_trend.len(),
            detail.tool_events.len(),
            detail.file_changes.len(),
            operation_count,
            elapsed_ms
        );
    } else {
        debug!(
            "[oom-diagnostics:backend] area=history phase={phase} source={} project_key={} session_id={} messages={} content_bytes={} token_trend={} tool_events={} file_changes={} file_change_operations={} elapsed_ms={} threshold_exceeded=false",
            detail.source,
            detail.project_key,
            detail.session_id,
            detail.messages.len(),
            content_bytes,
            detail.usage.token_trend.len(),
            detail.tool_events.len(),
            detail.file_changes.len(),
            operation_count,
            elapsed_ms
        );
    }
}

// 序列化统计响应估算传输字节数，序列化失败返回零。
pub(super) fn estimate_history_stats_response_bytes(response: &HistoryStatsResponse) -> usize {
    serde_json::to_vec(response).map_or(0, |value| value.len())
}

// 累计热力图与小时桶持有的会话引用数量，保留重复引用。
pub(super) fn stats_session_ref_count(response: &HistoryStatsResponse) -> usize {
    response
        .heatmap
        .iter()
        .map(|item| item.session_refs.len())
        .sum::<usize>()
        + response
            .hourly_activity
            .iter()
            .map(|item| item.session_refs.len())
            .sum::<usize>()
}

// 按响应序列化大小选择日志级别，记录统计规模与耗时。
pub(super) fn log_history_stats_oom_diagnostic(
    phase: &str,
    response: &HistoryStatsResponse,
    elapsed_ms: u128,
) {
    let response_bytes = estimate_history_stats_response_bytes(response);
    let session_ref_count = stats_session_ref_count(response);
    let threshold_exceeded = response_bytes >= OOM_HISTORY_STATS_WARN_BYTES;
    if threshold_exceeded {
        warn!(
            "[oom-diagnostics:backend] area=history phase={phase} range_days={} total_sessions={} total_messages={} response_bytes={} project_ranking={} model_distribution={} heatmap_days={} daily_series={} hourly_activity={} session_refs={} elapsed_ms={} threshold_exceeded=true",
            response.range_days,
            response.total_sessions,
            response.total_messages,
            response_bytes,
            response.project_ranking.len(),
            response.model_distribution.len(),
            response.heatmap.len(),
            response.daily_series.len(),
            response.hourly_activity.len(),
            session_ref_count,
            elapsed_ms
        );
    } else {
        debug!(
            "[oom-diagnostics:backend] area=history phase={phase} range_days={} total_sessions={} total_messages={} response_bytes={} project_ranking={} model_distribution={} heatmap_days={} daily_series={} hourly_activity={} session_refs={} elapsed_ms={} threshold_exceeded=false",
            response.range_days,
            response.total_sessions,
            response.total_messages,
            response_bytes,
            response.project_ranking.len(),
            response.model_distribution.len(),
            response.heatmap.len(),
            response.daily_series.len(),
            response.hourly_activity.len(),
            session_ref_count,
            elapsed_ms
        );
    }
}
