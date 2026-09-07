use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessagePart {
    pub kind: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<HistoryMessagePart>,
    pub timestamp: Option<String>,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    /// 该消息对应源 JSONL 文件的物理行号（0-based，含被解析跳过的行）。
    /// 仅单文件 detail 路径填充；子任务聚合合并的消息为 None（跨文件行号无意义）。
    pub line_index: Option<usize>,
    /// 是否允许消息级编辑/删除：仅当该行存在规范文本块（Claude text / Codex input_text|output_text）。
    /// tool_use、function_call、thinking 等结构行为 false，避免写坏协议配对。
    pub editable: bool,
    /// 编辑时应预填/替换的规范文本。与展示用 content 一致时省略以控制 payload 体积。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editable_text: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionSummary {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    pub source: String,
    pub project_key: String,
    pub title: String,
    pub file_path: String,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
    pub branch: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryToolCount {
    pub name: String,
    pub count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryToolEvent {
    pub call_id: Option<String>,
    pub name: String,
    pub category: String,
    pub message_index: Option<usize>,
    pub timestamp: Option<String>,
    pub status: Option<String>,
    pub duration_ms: Option<u64>,
    pub input_summary: Option<String>,
    pub output_summary: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFileChangeOperation {
    pub source: String,
    pub tool_name: Option<String>,
    pub file_path: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub patch: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub message_index: Option<usize>,
    pub operation_group_index: Option<usize>,
    pub timestamp: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFileChangeSummary {
    pub file_path: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub latest_message_index: Option<usize>,
    pub latest_operation_group_index: Option<usize>,
    pub latest_timestamp: Option<String>,
    pub operations: Vec<HistoryFileChangeOperation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTokenTrendPoint {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_tokens: u64,
    pub model: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub dominant_model: Option<String>,
    pub current_model: Option<String>,
    pub context_window: Option<u64>,
    pub last_context_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub token_trend: Vec<HistoryTokenTrendPoint>,
    pub tool_call_count: u64,
    pub mcp_calls: Vec<HistoryToolCount>,
    pub skill_calls: Vec<HistoryToolCount>,
    pub builtin_calls: Vec<HistoryToolCount>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionDetail {
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub title: String,
    pub file_path: String,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
    pub branch: Option<String>,
    pub usage: HistorySessionUsage,
    pub tool_events: Vec<HistoryToolEvent>,
    pub file_changes: Vec<HistoryFileChangeSummary>,
    pub messages: Vec<HistoryMessage>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryConversionResult {
    pub source: String,
    pub target_source: String,
    pub session_id: String,
    pub project_key: String,
    pub file_path: String,
    pub cwd: Option<String>,
    pub message_count: usize,
    pub resume_command: String,
    pub summary: HistorySessionSummary,
    pub detail: HistorySessionDetail,
}

pub(super) struct CodexThreadRegistration {
    pub(super) state_db_path: PathBuf,
    pub(super) session_id: String,
    pub(super) rollout_path: String,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
    pub(super) cwd: String,
    pub(super) title: String,
    pub(super) first_user_message: String,
    pub(super) preview: String,
    pub(super) model: String,
    pub(super) model_provider: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchResult {
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub title: String,
    pub file_path: String,
    pub role: String,
    pub snippet: String,
    pub timestamp: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndexStatus {
    pub roots_key: String,
    pub phase: String,
    pub indexed_files: usize,
    pub total_files: usize,
    pub generation: u64,
    pub partial: bool,
    pub last_completed_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndexV2TableStatus {
    pub table: String,
    pub rows: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndexV2Status {
    pub db_path: String,
    pub initialized: bool,
    pub user_version: i64,
    pub schema_version: Option<String>,
    pub model_version: Option<String>,
    pub source_instances: i64,
    pub sessions: i64,
    pub messages: i64,
    pub sync_runs: i64,
    pub failures: i64,
    pub tables: Vec<HistoryIndexV2TableStatus>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndexV2SourceInstanceInput {
    pub source_id: String,
    pub instance_id: String,
    pub environment_kind: String,
    pub environment_key: String,
    pub storage_kind: String,
    pub display_name: Option<String>,
    pub locations_json: String,
    pub settings_hash: String,
    pub discovered: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndexV2RawPointer {
    pub role: String,
    pub kind: String,
    pub path: Option<String>,
    pub line_index: Option<usize>,
    pub raw_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndexV2SessionRef {
    pub source_id: String,
    pub source_session_id: String,
    pub storage_kind: String,
    pub project_key: String,
    pub cwd: Option<String>,
    pub title: String,
    pub branch: Option<String>,
    pub primary_path: Option<String>,
    pub database_path: Option<String>,
    pub raw_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub fingerprint_kind: String,
    pub fingerprint_value: String,
    pub raw_pointers: Vec<HistoryIndexV2RawPointer>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndexV2MessageRef {
    pub message_index: usize,
    pub role: String,
    pub display_content: String,
    pub timestamp_ms: Option<i64>,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub editable: bool,
    pub raw_pointers: Vec<HistoryIndexV2RawPointer>,
    pub parts: Vec<HistoryMessagePart>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIndexV2AdapterSession {
    pub parser_version: i64,
    pub model_version: i64,
    pub session_ref: HistoryIndexV2SessionRef,
    pub messages: Vec<HistoryIndexV2MessageRef>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryConversionMatrixItem {
    pub source_id: String,
    pub target_id: String,
    pub state: String,
    pub loss_kind: String,
    pub writer_state: String,
    pub note: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPromptItem {
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub file_path: String,
    pub session_title: String,
    pub updated_at: i64,
    pub message_index: usize,
    pub prompt: String,
    pub timestamp: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsProjectItem {
    pub project_key: String,
    pub sessions: usize,
    pub messages: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub unpriced_tokens: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsModelItem {
    pub model: String,
    pub sessions: usize,
    pub ratio: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub unpriced_tokens: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsHeatmapDay {
    pub day_start_utc: i64,
    pub sessions: usize,
    pub messages: usize,
    pub level: u8,
    pub session_refs: Vec<HistorySessionSummary>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsDailySeriesItem {
    pub day_start_utc: i64,
    pub sessions: usize,
    pub messages: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub unpriced_tokens: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsSourceItem {
    pub source: String,
    pub sessions: usize,
    pub messages: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub unpriced_tokens: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsProjectEfficiencyItem {
    pub project_key: String,
    pub sessions: usize,
    pub messages: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub unpriced_tokens: u64,
    pub avg_messages_per_session: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsHourlyActivityItem {
    pub hour: u8,
    pub hour_start_utc: i64,
    pub sessions: usize,
    pub messages: usize,
    pub level: u8,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub unpriced_tokens: u64,
    pub session_refs: Vec<HistorySessionSummary>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsResponse {
    pub range_days: usize,
    pub total_sessions: usize,
    pub total_messages: usize,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub total_unpriced_tokens: u64,
    pub project_ranking: Vec<HistoryStatsProjectItem>,
    pub model_distribution: Vec<HistoryStatsModelItem>,
    pub heatmap: Vec<HistoryStatsHeatmapDay>,
    pub daily_series: Vec<HistoryStatsDailySeriesItem>,
    pub source_distribution: Vec<HistoryStatsSourceItem>,
    pub project_efficiency: Vec<HistoryStatsProjectEfficiencyItem>,
    pub hourly_activity: Vec<HistoryStatsHourlyActivityItem>,
    pub data_quality: HistoryStatsDataQuality,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatsDataQuality {
    pub route_records: usize,
    pub session_fallback_records: usize,
    pub unattributed_records: usize,
    pub missing_usage_records: usize,
}

#[derive(Default)]
pub(super) struct DayStatsAggregate {
    pub(super) sessions: usize,
    pub(super) messages: usize,
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) cache_creation_tokens: u64,
    pub(super) total_cost_usd: f64,
    pub(super) unpriced_tokens: u64,
    pub(super) session_refs: Vec<HistorySessionSummary>,
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub(super) struct UsageStatsScan {
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) cache_creation_tokens: u64,
    pub(super) total_cost_usd: f64,
    pub(super) unpriced_tokens: u64,
}

#[derive(Clone, Copy, Default)]
pub(super) struct UsageTokenScan {
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) cache_creation_tokens: u64,
    pub(super) explicit_cost_usd: Option<f64>,
}

#[derive(Clone, Default)]
pub(super) struct HourStatsAggregate {
    pub(super) sessions: usize,
    pub(super) messages: usize,
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) cache_creation_tokens: u64,
    pub(super) total_cost_usd: f64,
    pub(super) unpriced_tokens: u64,
    pub(super) session_refs: Vec<HistorySessionSummary>,
}

#[derive(Clone, Copy)]
pub(super) struct StatsTimeBounds {
    pub(super) start_at: i64,
    pub(super) end_at: i64,
    pub(super) start_day: i64,
    pub(super) range_days: usize,
    pub(super) explicit: bool,
}
