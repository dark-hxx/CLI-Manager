use crate::commands::model_pricing::{find_cached_model_pricing, CachedModelPricingLookup};
use crate::shell_resolver::silent_command;
use chrono::{DateTime, Datelike, SecondsFormat, Utc};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

mod catalog;
pub(crate) mod request_logs;

/// BufReader 容量；默认 8KB 对几 MB 的 jsonl 文件 syscall 次数偏多。
const READ_BUF_CAPACITY: usize = 64 * 1024;
/// collect_session_files 的 TTL：避免分析看板/搜索短时间内反复全树扫盘。
const SESSION_FILES_TTL_MS: i64 = 60_000;
const OOM_HISTORY_DETAIL_WARN_BYTES: usize = 10 * 1024 * 1024;
const OOM_HISTORY_STATS_WARN_BYTES: usize = 5 * 1024 * 1024;
const OOM_HISTORY_MESSAGES_WARN_COUNT: usize = 2_000;
const CODEX_HISTORY_INDEX_TEXT_MAX_CHARS: usize = 4_000;

fn estimate_history_detail_content_bytes(detail: &HistorySessionDetail) -> usize {
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

fn history_detail_operation_count(detail: &HistorySessionDetail) -> usize {
    detail
        .file_changes
        .iter()
        .map(|change| change.operations.len())
        .sum()
}

fn log_history_detail_oom_diagnostic(phase: &str, detail: &HistorySessionDetail, elapsed_ms: u128) {
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
        info!(
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

fn estimate_history_stats_response_bytes(response: &HistoryStatsResponse) -> usize {
    serde_json::to_vec(response).map_or(0, |value| value.len())
}

fn stats_session_ref_count(response: &HistoryStatsResponse) -> usize {
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

fn log_history_stats_oom_diagnostic(
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
        info!(
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

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct HistoryRoots {
    claude_config_dir: Option<PathBuf>,
    codex_config_dir: Option<PathBuf>,
}

impl HistoryRoots {
    fn cache_key(&self) -> String {
        format!(
            "claude={}|codex={}",
            self.claude_config_dir
                .as_deref()
                .map(path_to_key)
                .unwrap_or_else(|| "__default__".to_string()),
            self.codex_config_dir
                .as_deref()
                .map(path_to_key)
                .unwrap_or_else(|| "__default__".to_string())
        )
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SessionFileRef {
    pub(crate) source: String,
    pub(crate) project_key: String,
    pub(crate) path: PathBuf,
}

#[derive(Clone)]
struct SessionSummaryScan {
    session_id: Option<String>,
    message_count: usize,
    first_user_message: Option<String>,
    first_message: Option<String>,
    branch: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct SessionStatsScan {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
    dominant_model: Option<String>,
    current_model: Option<String>,
    model_usage: HashMap<String, UsageStatsScan>,
    /// 模型上下文窗口大小（日志显式字段，如 Codex model_context_window / Claude context_window）。
    context_window: Option<u64>,
    /// 最近一次请求占用的上下文 token 数。
    last_context_tokens: Option<u64>,
    /// Codex turn_context 暴露的模型思考强度（如 high / medium）。
    reasoning_effort: Option<String>,
    token_trend: Vec<HistoryTokenTrendPoint>,
    #[serde(default)]
    usage_events: Vec<SessionUsageEventScan>,
    /// 工具调用总次数（Claude tool_use 块 / Codex function_call）。
    tool_call_count: u64,
    /// MCP 服务器 -> 调用次数（工具名 mcp__<server>__<tool>）。
    mcp_calls: HashMap<String, u64>,
    /// Skill / 斜杠命令 -> 调用次数。
    skill_calls: HashMap<String, u64>,
    /// 内置工具 -> 调用次数（既非 MCP 也非 Skill 的工具，如 Read / Edit / Bash）。
    builtin_calls: HashMap<String, u64>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SessionUsageEventScan {
    #[serde(default)]
    event_key: String,
    #[serde(default)]
    event_index: usize,
    timestamp_ms: Option<i64>,
    model: Option<String>,
    usage: UsageStatsScan,
}

#[derive(Clone, Default)]
struct SessionProjectScan {
    cwd: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CachedSessionComputation {
    created_at: i64,
    updated_at: i64,
    session_id: String,
    title: String,
    message_count: usize,
    branch: Option<String>,
    stats: SessionStatsScan,
}

struct SessionDetailParts {
    computed: CachedSessionComputation,
    cwd: Option<String>,
    messages: Vec<HistoryMessage>,
    tool_events: Vec<HistoryToolEvent>,
    file_changes: Vec<HistoryFileChangeSummary>,
}

#[derive(Default)]
struct SessionProjectCache {
    entries: HashMap<String, CachedSessionProjectCacheEntry>,
}

#[derive(Clone)]
struct CachedSessionProjectCacheEntry {
    fingerprint: SessionFileFingerprint,
    scan: SessionProjectScan,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionFileFingerprint {
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    size: u64,
}

#[derive(Clone)]
struct WslSessionFileHit {
    linux_path: String,
    project_key: String,
    fingerprint: SessionFileFingerprint,
}

#[derive(Clone)]
struct CachedWslSessionFingerprint {
    fingerprint: SessionFileFingerprint,
    cached_at: i64,
}

type WslSessionFingerprintCache = HashMap<String, CachedWslSessionFingerprint>;

#[derive(Clone, Serialize, Deserialize)]
struct HistoryIndexEntry {
    file_ref: SessionFileRef,
    fingerprint: SessionFileFingerprint,
    computed: CachedSessionComputation,
}

#[derive(Clone, Default)]
struct HistorySessionIndex {
    roots: HistoryRoots,
    entries: Vec<HistoryIndexEntry>,
    refreshed_at: i64,
    generation: u64,
}

static HISTORY_SESSION_INDEX: OnceLock<RwLock<HistorySessionIndex>> = OnceLock::new();

const HISTORY_SESSION_INDEX_TTL_MS: i64 = 60_000;

#[derive(Clone)]
struct CachedSessionFiles {
    timestamp_ms: i64,
    files: Vec<SessionFileRef>,
}

#[derive(Default)]
struct SessionFilesCache {
    by_source: HashMap<String, CachedSessionFiles>,
}

#[derive(Clone)]
struct CachedHistoryStatsAggregation {
    response: HistoryStatsResponse,
    cached_at: i64,
}

#[derive(Default)]
struct HistoryStatsAggregationCache {
    entries: HashMap<String, CachedHistoryStatsAggregation>,
}

#[derive(Clone)]
struct HistoryStatsSessionFact {
    summary: HistorySessionSummary,
    occurred_at: i64,
    stats: UsageStatsScan,
    model: Option<String>,
}

#[derive(Clone)]
struct CachedHistoryStatsDailyIndex {
    days: BTreeMap<i64, Vec<HistoryStatsSessionFact>>,
    cached_at: i64,
}

#[derive(Default)]
struct HistoryStatsDailyIndexCache {
    entries: HashMap<String, CachedHistoryStatsDailyIndex>,
}

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
const MAX_STATS_RANGE_DAYS: usize = 366;
const HISTORY_STATS_AGGREGATION_CACHE_MAX: usize = 32;
const HISTORY_STATS_DAILY_INDEX_CACHE_MAX: usize = 16;
static SESSION_PROJECT_CACHE: OnceLock<Mutex<SessionProjectCache>> = OnceLock::new();
static SESSION_FILES_CACHE: OnceLock<Mutex<SessionFilesCache>> = OnceLock::new();
static WSL_SESSION_FINGERPRINT_CACHE: OnceLock<Mutex<WslSessionFingerprintCache>> = OnceLock::new();
static HISTORY_STATS_AGGREGATION_CACHE: OnceLock<Mutex<HistoryStatsAggregationCache>> =
    OnceLock::new();
static HISTORY_STATS_DAILY_INDEX_CACHE: OnceLock<Mutex<HistoryStatsDailyIndexCache>> =
    OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
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
}

struct CodexThreadRegistration {
    state_db_path: PathBuf,
    session_id: String,
    rollout_path: String,
    created_at: i64,
    updated_at: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    cwd: String,
    title: String,
    first_user_message: String,
    preview: String,
    model: String,
    model_provider: String,
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
}

#[derive(Default)]
struct DayStatsAggregate {
    sessions: usize,
    messages: usize,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
    session_refs: Vec<HistorySessionSummary>,
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
struct UsageStatsScan {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
}

#[derive(Clone, Copy, Default)]
struct UsageTokenScan {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    explicit_cost_usd: Option<f64>,
}

#[derive(Clone, Default)]
struct HourStatsAggregate {
    sessions: usize,
    messages: usize,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
    session_refs: Vec<HistorySessionSummary>,
}

#[derive(Clone, Copy)]
struct StatsTimeBounds {
    start_at: i64,
    end_at: i64,
    start_day: i64,
    range_days: usize,
    explicit: bool,
}

#[tauri::command]
pub async fn history_list_sessions(
    app: tauri::AppHandle,
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    let roots = history_roots(claude_config_dir.clone(), codex_config_dir.clone());
    match catalog::list_sessions(
        &roots,
        source.clone(),
        project_path.clone(),
        query.clone(),
        limit,
        offset,
    )
    .await
    {
        Ok(mut sessions) => {
            let targeted_lookup = query
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
                && limit == Some(1)
                && offset.unwrap_or(0) == 0;
            if targeted_lookup {
                if let Some(session) = sessions.first_mut() {
                    let path = PathBuf::from(&session.file_path);
                    let fingerprint =
                        tokio::task::spawn_blocking(move || session_file_fingerprint(&path))
                            .await
                            .map_err(|err| err.to_string())?;
                    session.created_at = fingerprint.created_at;
                    session.updated_at = fingerprint.updated_at;
                }
            }
            let _ = catalog::ensure_refresh(app, roots, false, false).await;
            Ok(sessions)
        }
        Err(err) => {
            warn!("history catalog list fallback: {err}");
            history_list_sessions_legacy(
                source,
                claude_config_dir,
                codex_config_dir,
                project_path,
                query,
                limit,
                offset,
            )
            .await
        }
    }
}

async fn history_list_sessions_legacy(
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir);
        let source_filter = source.map(|v| v.to_lowercase());
        let target_project_path = project_path
            .map(|v| normalize_history_path(&v))
            .filter(|v| !v.is_empty());
        let query_lower = query
            .map(|q| q.trim().to_lowercase())
            .filter(|q| !q.is_empty());
        let max_sessions = limit.unwrap_or(usize::MAX);
        let start_offset = offset.unwrap_or(0);
        let targeted_lookup = target_project_path.is_some() && max_sessions == 1 && start_offset == 0;
        debug!(
            "history_list_sessions request: source={:?}, claude_root={}, codex_root={}, project_path={:?}, query={:?}, limit={}, offset={}",
            source_filter,
            resolve_claude_history_root(&roots).to_string_lossy(),
            resolve_codex_history_root(&roots).to_string_lossy(),
            target_project_path,
            query_lower,
            max_sessions,
            start_offset
        );
        if targeted_lookup {
            info!(
                "history_list_sessions targeted lookup: source={:?}, project_path={:?}, query={:?}, limit={}, offset={}",
                source_filter,
                target_project_path,
                query_lower,
                max_sessions,
                start_offset
            );
        }
        let mut sessions = Vec::new();
        if max_sessions == 0 {
            return Ok(sessions);
        }

        if query_lower.is_none() {
            let indexed_entries = refresh_history_index(&roots);
            let total_files = indexed_entries.len();
            let mut mismatch_samples = Vec::new();
            let mut matched_entries: Vec<HistoryIndexEntry> = indexed_entries
                .into_iter()
                .filter_map(|entry| {
                    let file_ref = &entry.file_ref;
                    if let Some(filter) = &source_filter {
                        if &file_ref.source != filter {
                            return None;
                        }
                    }
                    let matched = target_project_path
                        .as_ref()
                        .map(|project_path| session_matches_project_path(&file_ref, project_path))
                        .unwrap_or(true);
                    if !matched {
                        if targeted_lookup && mismatch_samples.len() < 5 {
                            let scan = get_or_scan_session_project(&file_ref.path);
                            mismatch_samples.push(format!(
                                "source={} project_key={} cwd={:?} file={}",
                                file_ref.source,
                                file_ref.project_key,
                                scan.cwd,
                                file_ref.path.to_string_lossy()
                            ));
                        }
                        return None;
                    }
                    Some(entry)
                })
                .collect();
            debug!(
                "history_list_sessions project candidates: source={:?}, project_path={:?}, total_files={}, matched_files={}, reused_index=true",
                source_filter,
                target_project_path,
                total_files,
                matched_entries.len(),
            );
            if targeted_lookup {
                info!(
                    "history_list_sessions targeted candidates: source={:?}, project_path={:?}, total_files={}, matched_files={}, mismatch_samples={:?}",
                    source_filter,
                    target_project_path,
                    total_files,
                    matched_entries.len(),
                    mismatch_samples
                );
            }
            matched_entries.sort_by(|a, b| {
                b.computed
                    .updated_at
                    .cmp(&a.computed.updated_at)
                    .then_with(|| a.file_ref.path.cmp(&b.file_ref.path))
            });

            let mut matched = 0usize;
            for entry in matched_entries {
                if matched < start_offset {
                    matched += 1;
                    continue;
                }
                if sessions.len() >= max_sessions {
                    break;
                }
                matched += 1;
                let file_ref = entry.file_ref;
                let computed = entry.computed;
                debug!(
                    "history_list_sessions matched file: source={}, project_key={}, session_id={}, path={}",
                    file_ref.source,
                    file_ref.project_key,
                    computed.session_id,
                    file_ref.path.to_string_lossy()
                );
                if targeted_lookup && sessions.is_empty() {
                    info!(
                        "history_list_sessions targeted hit: source={}, project_key={}, session_id={}, path={}",
                        file_ref.source,
                        file_ref.project_key,
                        computed.session_id,
                        file_ref.path.to_string_lossy()
                    );
                }
                sessions.push(summary_from_computation(&file_ref, &computed));
            }
            if sessions.is_empty() {
                debug!(
                    "history_list_sessions no project match: source={:?}, project_path={:?}, total_files={}, matched_files={}",
                    source_filter,
                    target_project_path,
                    total_files,
                    matched
                );
                if targeted_lookup {
                    info!(
                        "history_list_sessions targeted miss: source={:?}, project_path={:?}, total_files={}, matched_files={}",
                        source_filter,
                        target_project_path,
                        total_files,
                        matched
                    );
                }
            }
            return Ok(sessions);
        }

        let mut scanned_entries = 0usize;
        for entry in refresh_history_index(&roots) {
            scanned_entries += 1;
            if let Some(filter) = &source_filter {
                if &entry.file_ref.source != filter {
                    continue;
                }
            }

            if let Some(project_path) = &target_project_path {
                if !session_matches_project_path(&entry.file_ref, project_path) {
                    continue;
                }
            }

            let summary = summary_from_computation(&entry.file_ref, &entry.computed);
            if let Some(q) = &query_lower {
                let title = summary.title.to_lowercase();
                let session_id = summary.session_id.to_lowercase();
                let project = summary.project_key.to_lowercase();
                let source_name = summary.source.to_lowercase();
                let branch = summary
                    .branch
                    .as_ref()
                    .map(|v| v.to_lowercase())
                    .unwrap_or_default();
                if !title.contains(q)
                    && !session_id.contains(q)
                    && !project.contains(q)
                    && !source_name.contains(q)
                    && !branch.contains(q)
                {
                    continue;
                }
            }

            debug!(
                "history_list_sessions indexed match: source={}, project_key={}, session_id={}, path={}",
                entry.file_ref.source,
                entry.file_ref.project_key,
                summary.session_id,
                entry.file_ref.path.to_string_lossy()
            );
            if targeted_lookup && sessions.is_empty() {
                info!(
                    "history_list_sessions targeted indexed hit: source={}, project_key={}, session_id={}, path={}",
                    entry.file_ref.source,
                    entry.file_ref.project_key,
                    summary.session_id,
                    entry.file_ref.path.to_string_lossy()
                );
            }
            sessions.push(summary);
        }

        if sessions.is_empty() {
            debug!(
                "history_list_sessions no indexed match: source={:?}, project_path={:?}, query={:?}, scanned_entries={}",
                source_filter,
                target_project_path,
                query_lower,
                scanned_entries
            );
            if targeted_lookup {
                info!(
                    "history_list_sessions targeted indexed miss: source={:?}, project_path={:?}, query={:?}, scanned_entries={}",
                    source_filter,
                    target_project_path,
                    query_lower,
                    scanned_entries
                );
            }
        }
        Ok(sessions.into_iter().skip(start_offset).take(max_sessions).collect())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn history_get_session(
    file_path: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    source: String,
    project_key: String,
    aggregate_subtasks: Option<bool>,
) -> Result<HistorySessionDetail, String> {
    tokio::task::spawn_blocking(move || {
        let started_at = Instant::now();
        let roots = history_roots(claude_config_dir, codex_config_dir);
        debug!(
            "history_get_session request: source={}, project_key={}, file_path={}, claude_root={}, codex_root={}",
            source,
            project_key,
            file_path,
            resolve_claude_history_root(&roots).to_string_lossy(),
            resolve_codex_history_root(&roots).to_string_lossy()
        );
        let file_ref = validate_session_file_ref(&file_path, &source, &project_key, &roots)?;
        debug!(
            "history_get_session reading file: source={}, project_key={}, path={}, aggregate_subtasks={}",
            file_ref.source,
            file_ref.project_key,
            file_ref.path.to_string_lossy(),
            aggregate_subtasks.unwrap_or(false)
        );
        let detail = build_session_detail(&file_ref, aggregate_subtasks.unwrap_or(false))?;
        log_history_detail_oom_diagnostic(
            "history_get_session",
            &detail,
            started_at.elapsed().as_millis(),
        );
        Ok(detail)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn history_convert_session(
    file_path: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    source: String,
    project_key: String,
    target_source: String,
) -> Result<HistoryConversionResult, String> {
    let (result, codex_registration) = tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir);
        let file_ref =
            validate_session_file_ref_for_conversion(&file_path, &source, &project_key, &roots)?;
        let target_source = target_source.trim().to_lowercase();
        let detail = build_session_detail(&file_ref, false)?;
        let result = convert_history_session(&detail, &target_source, &roots)?;
        let codex_registration = if target_source == "codex" {
            Some(build_codex_thread_registration(&roots, &detail, &result))
        } else {
            None
        };
        Ok::<_, String>((result, codex_registration))
    })
    .await
    .map_err(|err| err.to_string())??;

    if let Some(registration) = codex_registration {
        register_codex_thread(&registration).await?;
    }
    invalidate_history_caches();
    Ok(result)
}

pub(crate) fn validate_session_file_ref(
    file_path: &str,
    source: &str,
    project_key: &str,
    roots: &HistoryRoots,
) -> Result<SessionFileRef, String> {
    let source = source.trim().to_lowercase();
    let project_key = project_key.trim();
    let base = history_source_base(&source, roots)?
        .canonicalize()
        .map_err(|_| "history_source_not_found".to_string())?;
    resolve_session_file_ref(
        file_path,
        &source,
        project_key,
        &base,
        collect_session_files(Some(&source), roots),
    )
}

fn validate_session_file_ref_for_conversion(
    file_path: &str,
    source: &str,
    project_key: &str,
    roots: &HistoryRoots,
) -> Result<SessionFileRef, String> {
    let source = source.trim().to_lowercase();
    let project_key = project_key.trim();
    if project_key.is_empty() {
        return Err("invalid_project_key".to_string());
    }

    let base = history_source_base(&source, roots)?
        .canonicalize()
        .map_err(|_| "history_source_not_found".to_string())?;
    let requested = PathBuf::from(file_path);
    if !is_jsonl(&requested) {
        return Err("invalid_session_file".to_string());
    }
    let requested = requested
        .canonicalize()
        .map_err(|_| format!("Session file not found: {file_path}"))?;
    if !path_within_history_scope(&requested, &base) {
        return Err("session_file_outside_history_scope".to_string());
    }

    Ok(SessionFileRef {
        source,
        project_key: project_key.to_string(),
        path: requested,
    })
}

fn history_source_base(source: &str, roots: &HistoryRoots) -> Result<PathBuf, String> {
    match source {
        "claude" => Ok(resolve_claude_history_root(roots)),
        "codex" => Ok(resolve_codex_history_root(roots)),
        _ => Err("unsupported_history_source".to_string()),
    }
}

fn resolve_session_file_ref(
    file_path: &str,
    source: &str,
    project_key: &str,
    history_base: &Path,
    candidates: Vec<SessionFileRef>,
) -> Result<SessionFileRef, String> {
    if project_key.is_empty() {
        return Err("invalid_project_key".to_string());
    }

    let requested = PathBuf::from(file_path);
    if !is_jsonl(&requested) {
        return Err("invalid_session_file".to_string());
    }

    debug!(
        "history session scope validation start: source={}, project_key={}, requested_raw={}, history_base_raw={}",
        source,
        project_key,
        file_path,
        history_base.to_string_lossy()
    );

    let requested = requested
        .canonicalize()
        .map_err(|_| format!("Session file not found: {file_path}"))?;
    debug!(
        "history session scope canonicalized: source={}, project_key={}, requested={}, history_base={}",
        source,
        project_key,
        requested.to_string_lossy(),
        history_base.to_string_lossy()
    );
    if !path_within_history_scope(&requested, history_base) {
        warn!(
            "history session scope rejected: source={}, project_key={}, requested={}, history_base={}, requested_scope={}, history_scope={}",
            source,
            project_key,
            requested.to_string_lossy(),
            history_base.to_string_lossy(),
            history_scope_debug_string(&requested),
            history_scope_debug_string(history_base)
        );
        return Err("session_file_outside_history_scope".to_string());
    }

    for candidate in candidates {
        if candidate.source != source {
            continue;
        }
        let Ok(candidate_path) = candidate.path.canonicalize() else {
            continue;
        };
        if candidate_path != requested {
            continue;
        }

        let indexed_project_key = candidate.project_key;
        let resolved_project_key = if source == "codex" {
            get_or_scan_session_project(&candidate_path)
                .cwd
                .as_deref()
                .and_then(project_key_from_cwd)
                .unwrap_or_else(|| indexed_project_key.clone())
        } else {
            indexed_project_key.clone()
        };
        if resolved_project_key != project_key {
            continue;
        }

        debug!(
            "history session scope matched indexed candidate: source={}, project_key={}, indexed_project_key={}, requested={}, candidate={}",
            source,
            resolved_project_key,
            indexed_project_key,
            requested.to_string_lossy(),
            candidate_path.to_string_lossy()
        );
        return Ok(SessionFileRef {
            source: candidate.source,
            project_key: resolved_project_key,
            path: requested,
        });
    }

    Err("session_file_not_indexed".to_string())
}

fn path_within_history_scope(requested: &Path, history_base: &Path) -> bool {
    let requested_scope = wsl_scope_path_parts(requested);
    let history_scope = wsl_scope_path_parts(history_base);

    if let (Some((requested_distro, requested_linux)), Some((base_distro, base_linux))) =
        (requested_scope.as_ref(), history_scope.as_ref())
    {
        let accepted = requested_distro.eq_ignore_ascii_case(base_distro)
            && Path::new(requested_linux).starts_with(Path::new(base_linux));
        debug!(
            "history session scope wsl compare: requested_raw={}, history_base_raw={}, requested_scope={}, history_scope={}, accepted={}",
            requested.to_string_lossy(),
            history_base.to_string_lossy(),
            format_wsl_scope_parts(requested_scope.as_ref()),
            format_wsl_scope_parts(history_scope.as_ref()),
            accepted
        );
        return accepted;
    }

    let accepted = requested.starts_with(history_base);
    debug!(
        "history session scope native compare: requested_raw={}, history_base_raw={}, requested_scope={}, history_scope={}, accepted={}",
        requested.to_string_lossy(),
        history_base.to_string_lossy(),
        format_wsl_scope_parts(requested_scope.as_ref()),
        format_wsl_scope_parts(history_scope.as_ref()),
        accepted
    );
    accepted
}

fn wsl_scope_path_parts(path: &Path) -> Option<(String, String)> {
    let raw = path.to_string_lossy();
    let normalized = normalize_wsl_scope_unc(&raw);
    crate::wsl::parse_wsl_unc_path(&normalized)
}

fn history_scope_debug_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let normalized = normalize_wsl_scope_unc(&raw);
    let parsed = crate::wsl::parse_wsl_unc_path(&normalized);
    format!(
        "raw={} | normalized={} | parsed={}",
        raw,
        normalized,
        format_wsl_scope_parts(parsed.as_ref())
    )
}

fn format_wsl_scope_parts(parts: Option<&(String, String)>) -> String {
    parts
        .map(|(distro, linux)| format!("Some(distro={distro}, linux={linux})"))
        .unwrap_or_else(|| "None".to_string())
}

fn normalize_wsl_scope_unc(path: &str) -> String {
    let normalized = path.trim().replace('/', "\\");
    let lower = normalized.to_ascii_lowercase();
    const VERBATIM_WSL_LOCALHOST_PREFIX: &str = "\\\\?\\UNC\\wsl.localhost\\";
    const VERBATIM_WSL_DOLLAR_PREFIX: &str = "\\\\?\\UNC\\wsl$\\";
    const VERBATIM_UNC_PREFIX_LEN: usize = "\\\\?\\UNC\\".len();

    if lower.starts_with(&VERBATIM_WSL_LOCALHOST_PREFIX.to_ascii_lowercase())
        || lower.starts_with(&VERBATIM_WSL_DOLLAR_PREFIX.to_ascii_lowercase())
    {
        return format!("\\\\{}", &normalized[VERBATIM_UNC_PREFIX_LEN..]);
    }

    normalized
}

fn wsl_linux_path(path: &Path) -> Option<String> {
    let raw = path.to_string_lossy();
    let normalized = normalize_wsl_scope_unc(&raw);
    crate::wsl::parse_wsl_unc_path(&normalized).map(|(_, linux_path)| linux_path)
}

fn codex_runtime_path(path: &Path) -> String {
    wsl_linux_path(path).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn should_register_codex_state_db(path: &Path) -> bool {
    wsl_linux_path(path).is_none()
}

#[tauri::command]
pub async fn history_delete_session(
    file_path: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    source: String,
    project_key: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir);
        let file_ref = validate_session_file_ref(&file_path, &source, &project_key, &roots)?;
        fs::remove_file(&file_ref.path).map_err(|err| err.to_string())?;
        invalidate_history_caches();
        Ok(())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn history_search(
    app: tauri::AppHandle,
    query: String,
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    project_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistorySearchResult>, String> {
    if query.trim().chars().count() < 3 {
        return Ok(Vec::new());
    }
    let roots = history_roots(claude_config_dir, codex_config_dir);
    let hits = catalog::search_sessions(&roots, &query, source, project_path, limit).await?;
    let _ = catalog::ensure_refresh(app, roots, false, false).await;
    Ok(hits)
}

#[tauri::command]
pub async fn history_get_index_status(
    app: tauri::AppHandle,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<HistoryIndexStatus, String> {
    let roots = history_roots(claude_config_dir, codex_config_dir);
    catalog::ensure_refresh(app, roots, false, false).await
}

#[tauri::command]
pub async fn history_refresh_index(
    app: tauri::AppHandle,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    wait: Option<bool>,
) -> Result<HistoryIndexStatus, String> {
    let roots = history_roots(claude_config_dir, codex_config_dir);
    catalog::ensure_refresh(app, roots, true, wait.unwrap_or(true)).await
}

#[tauri::command]
pub async fn history_list_prompts(
    scope: Option<String>,
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    project_key: Option<String>,
    file_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistoryPromptItem>, String> {
    tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir);
        let scope = scope
            .as_deref()
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "global".to_string());
        let source_filter = source.map(|v| v.to_lowercase());
        let target_project = project_key
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let target_file = file_path
            .map(|v| normalize_history_path(&v))
            .filter(|v| !v.is_empty());
        let normalized_query = query
            .map(|q| q.trim().to_lowercase())
            .filter(|q| !q.is_empty());
        let max_items = limit.unwrap_or(200).clamp(1, 2000);
        let mut prompts: Vec<HistoryPromptItem> = Vec::new();

        for entry in refresh_history_index(&roots) {
            if let Some(filter) = &source_filter {
                if &entry.file_ref.source != filter {
                    continue;
                }
            }
            let file_ref = entry.file_ref;
            let computed = entry.computed;
            if let Some(project) = &target_project {
                if &file_ref.project_key != project {
                    continue;
                }
            }

            if scope == "session" {
                let Some(target) = target_file.as_ref() else {
                    continue;
                };
                let current = normalize_history_path(&path_to_key(&file_ref.path));
                if &current != target {
                    continue;
                }
            }

            let session_id = computed.session_id.clone();
            let source_name = file_ref.source.clone();
            let project_key_owned = file_ref.project_key.clone();
            let file_path_str = file_ref.path.to_string_lossy().to_string();
            let session_title = computed.title.clone();
            let updated_at = computed.updated_at;
            let title_lower = session_title.to_lowercase();
            let mut local_full = false;

            let scan_result = iter_session_messages(&file_ref.path, |index, msg| {
                if msg.role != "user" {
                    return true;
                }
                let prompt = normalize_text(&msg.content);
                if prompt.is_empty() {
                    return true;
                }
                if let Some(q) = &normalized_query {
                    let prompt_lower = prompt.to_lowercase();
                    if !prompt_lower.contains(q) && !title_lower.contains(q) {
                        return true;
                    }
                }
                prompts.push(HistoryPromptItem {
                    session_id: session_id.clone(),
                    source: source_name.clone(),
                    project_key: project_key_owned.clone(),
                    file_path: file_path_str.clone(),
                    session_title: session_title.clone(),
                    updated_at,
                    message_index: index,
                    prompt,
                    timestamp: msg.timestamp,
                });
                if prompts.len() >= max_items {
                    local_full = true;
                    return false;
                }
                true
            });
            if let Err(err) = scan_result {
                debug!(
                    "history_list_prompts skip unreadable file: path={}, err={}",
                    file_ref.path.to_string_lossy(),
                    err
                );
                continue;
            }
            if local_full {
                break;
            }
        }

        prompts.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then(b.message_index.cmp(&a.message_index))
        });
        Ok(prompts)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn history_list_stats_projects(
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir);
        let source_filter = source.map(|v| v.to_lowercase());
        let mut projects = BTreeSet::new();

        for entry in refresh_history_index(&roots) {
            if let Some(filter) = &source_filter {
                if &entry.file_ref.source != filter {
                    continue;
                }
            }
            if !entry.file_ref.project_key.trim().is_empty() {
                projects.insert(entry.file_ref.project_key);
            }
        }

        Ok(projects.into_iter().collect())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn history_get_stats(
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    project_key: Option<String>,
    project_path: Option<String>,
    range_days: Option<usize>,
    start_at: Option<i64>,
    end_at: Option<i64>,
    force: Option<bool>,
) -> Result<HistoryStatsResponse, String> {
    let started_at = Instant::now();
    let roots = history_roots(claude_config_dir, codex_config_dir);
    let source_filter = source.map(|v| v.to_lowercase());
    let target_project = project_key
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let target_project_path = project_path
        .map(|v| normalize_history_path(&v))
        .filter(|v| !v.is_empty());
    let bounds = resolve_stats_time_bounds(range_days, start_at, end_at)?;
    let force = force.unwrap_or(false);
    let index = refresh_history_index_snapshot(&roots, force);
    let cache_key = make_history_stats_aggregation_cache_key(
        &roots,
        source_filter.as_deref(),
        target_project.as_deref(),
        target_project_path.as_deref(),
        bounds,
        index.generation,
    );

    if !force {
        if let Some(response) = stats_aggregation_cache_get(&cache_key) {
            log_history_stats_oom_diagnostic(
                "history_get_stats_cache_hit",
                &response,
                started_at.elapsed().as_millis(),
            );
            return Ok(response);
        }
    }

    let daily_index_key = make_history_stats_daily_index_cache_key(
        &roots,
        source_filter.as_deref(),
        target_project.as_deref(),
        target_project_path.as_deref(),
        bounds,
        index.generation,
    );
    let daily_index = if !force {
        stats_daily_index_cache_get(&daily_index_key).unwrap_or_else(|| {
            let daily_index = build_history_stats_daily_index(
                index.entries,
                source_filter.as_deref(),
                target_project.as_deref(),
                target_project_path.as_deref(),
                bounds,
            );
            stats_daily_index_cache_set(daily_index_key, daily_index.clone());
            daily_index
        })
    } else {
        let daily_index = build_history_stats_daily_index(
            index.entries,
            source_filter.as_deref(),
            target_project.as_deref(),
            target_project_path.as_deref(),
            bounds,
        );
        stats_daily_index_cache_set(daily_index_key, daily_index.clone());
        daily_index
    };

    let response = build_history_stats_response(&daily_index.days, bounds);
    log_history_stats_oom_diagnostic(
        "history_get_stats",
        &response,
        started_at.elapsed().as_millis(),
    );
    stats_aggregation_cache_set(cache_key, response.clone());
    Ok(response)
}

fn build_history_stats_daily_index(
    entries: Vec<HistoryIndexEntry>,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_path: Option<&str>,
    bounds: StatsTimeBounds,
) -> CachedHistoryStatsDailyIndex {
    let mut days: BTreeMap<i64, Vec<HistoryStatsSessionFact>> = BTreeMap::new();
    let day_offset = stats_day_start_offset(bounds);

    for entry in entries {
        if let Some(filter) = source_filter {
            if entry.file_ref.source != filter {
                continue;
            }
        }
        if let Some(project) = target_project {
            if entry.file_ref.project_key != project {
                continue;
            }
        }
        if let Some(project_path) = target_project_path {
            if !session_matches_project_path(&entry.file_ref, project_path) {
                continue;
            }
        }

        let computed = entry.computed;
        let summary = summary_from_computation(&entry.file_ref, &computed);
        let usage_events = stats_usage_events_or_fallback(&summary, &computed.stats);
        for event in usage_events {
            let occurred_at = event.timestamp_ms.unwrap_or(summary.updated_at);
            let repriced_stats = reprice_usage_stats(event.model.as_deref(), event.usage);
            let day_start = stats_day_start_with_offset(occurred_at, day_offset);
            days.entry(day_start)
                .or_default()
                .push(HistoryStatsSessionFact {
                    summary: summary.clone(),
                    occurred_at,
                    stats: repriced_stats,
                    model: event.model,
                });
        }
    }

    CachedHistoryStatsDailyIndex {
        days,
        cached_at: now_millis(),
    }
}

fn build_history_stats_response(
    daily_index: &BTreeMap<i64, Vec<HistoryStatsSessionFact>>,
    bounds: StatsTimeBounds,
) -> HistoryStatsResponse {
    let mut total_sessions = 0usize;
    let mut total_messages = 0usize;
    let mut total_input_tokens = 0u64;
    let mut total_output_tokens = 0u64;
    let mut total_cache_read_tokens = 0u64;
    let mut total_cache_creation_tokens = 0u64;
    let mut total_cost_usd = 0.0f64;
    let mut total_unpriced_tokens = 0u64;
    let mut project_map: HashMap<String, HistoryStatsProjectItem> = HashMap::new();
    let mut model_map: HashMap<String, HistoryStatsModelItem> = HashMap::new();
    let mut source_map: HashMap<String, HistoryStatsSourceItem> = HashMap::new();
    let mut day_map: BTreeMap<i64, DayStatsAggregate> = BTreeMap::new();
    let mut hourly_map: Vec<HourStatsAggregate> = vec![HourStatsAggregate::default(); 24];
    let mut seen_total_sessions: HashSet<String> = HashSet::new();
    let mut seen_project_sessions: HashSet<String> = HashSet::new();
    let mut seen_source_sessions: HashSet<String> = HashSet::new();
    let mut seen_model_sessions: HashSet<String> = HashSet::new();
    let mut seen_day_sessions: HashSet<String> = HashSet::new();
    let mut seen_hour_sessions: Vec<HashSet<String>> = (0..24).map(|_| HashSet::new()).collect();

    for day_idx in 0..bounds.range_days {
        let day_start = bounds.start_day + day_idx as i64 * DAY_MS;
        let Some(facts) = daily_index.get(&day_start) else {
            continue;
        };

        for fact in facts {
            if fact.occurred_at < bounds.start_at || fact.occurred_at > bounds.end_at {
                continue;
            }

            let summary = &fact.summary;
            let stats = &fact.stats;
            let session_key = history_stats_session_key(summary);

            if seen_total_sessions.insert(session_key.clone()) {
                total_sessions += 1;
                total_messages += summary.message_count;
            }
            total_input_tokens = total_input_tokens.saturating_add(stats.input_tokens);
            total_output_tokens = total_output_tokens.saturating_add(stats.output_tokens);
            total_cache_read_tokens =
                total_cache_read_tokens.saturating_add(stats.cache_read_tokens);
            total_cache_creation_tokens =
                total_cache_creation_tokens.saturating_add(stats.cache_creation_tokens);
            total_cost_usd += stats.total_cost_usd;
            total_unpriced_tokens = total_unpriced_tokens.saturating_add(stats.unpriced_tokens);

            let hour = hour_of_day_for_stats(fact.occurred_at, bounds);
            let hour_session_key = format!("{hour}|{session_key}");
            if seen_hour_sessions[hour].insert(hour_session_key) {
                hourly_map[hour].sessions += 1;
                hourly_map[hour].messages += summary.message_count;
                hourly_map[hour].session_refs.push(summary.clone());
            }
            hourly_map[hour].input_tokens = hourly_map[hour]
                .input_tokens
                .saturating_add(stats.input_tokens);
            hourly_map[hour].output_tokens = hourly_map[hour]
                .output_tokens
                .saturating_add(stats.output_tokens);
            hourly_map[hour].cache_read_tokens = hourly_map[hour]
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            hourly_map[hour].cache_creation_tokens = hourly_map[hour]
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            hourly_map[hour].total_cost_usd += stats.total_cost_usd;
            hourly_map[hour].unpriced_tokens = hourly_map[hour]
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);

            let project_entry =
                project_map
                    .entry(summary.project_key.clone())
                    .or_insert(HistoryStatsProjectItem {
                        project_key: summary.project_key.clone(),
                        sessions: 0,
                        messages: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        total_cost_usd: 0.0,
                        unpriced_tokens: 0,
                    });
            let project_session_key = format!("{}|{}", summary.project_key, session_key);
            if seen_project_sessions.insert(project_session_key) {
                project_entry.sessions += 1;
                project_entry.messages += summary.message_count;
            }
            project_entry.input_tokens = project_entry
                .input_tokens
                .saturating_add(stats.input_tokens);
            project_entry.output_tokens = project_entry
                .output_tokens
                .saturating_add(stats.output_tokens);
            project_entry.cache_read_tokens = project_entry
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            project_entry.cache_creation_tokens = project_entry
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            project_entry.total_cost_usd += stats.total_cost_usd;
            project_entry.unpriced_tokens = project_entry
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);

            let source_entry =
                source_map
                    .entry(summary.source.clone())
                    .or_insert(HistoryStatsSourceItem {
                        source: summary.source.clone(),
                        sessions: 0,
                        messages: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        total_cost_usd: 0.0,
                        unpriced_tokens: 0,
                    });
            let source_session_key = format!("{}|{}", summary.source, session_key);
            if seen_source_sessions.insert(source_session_key) {
                source_entry.sessions += 1;
                source_entry.messages += summary.message_count;
            }
            source_entry.input_tokens =
                source_entry.input_tokens.saturating_add(stats.input_tokens);
            source_entry.output_tokens = source_entry
                .output_tokens
                .saturating_add(stats.output_tokens);
            source_entry.cache_read_tokens = source_entry
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            source_entry.cache_creation_tokens = source_entry
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            source_entry.total_cost_usd += stats.total_cost_usd;
            source_entry.unpriced_tokens = source_entry
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);

            let model_name = fact.model.clone().unwrap_or_else(|| "unknown".to_string());
            let model_entry =
                model_map
                    .entry(model_name.clone())
                    .or_insert(HistoryStatsModelItem {
                        model: model_name,
                        sessions: 0,
                        ratio: 0.0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        total_cost_usd: 0.0,
                        unpriced_tokens: 0,
                    });
            let model_session_key = format!("{}|{}", model_entry.model, session_key);
            if seen_model_sessions.insert(model_session_key) {
                model_entry.sessions += 1;
            }
            model_entry.input_tokens = model_entry.input_tokens.saturating_add(stats.input_tokens);
            model_entry.output_tokens = model_entry
                .output_tokens
                .saturating_add(stats.output_tokens);
            model_entry.cache_read_tokens = model_entry
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            model_entry.cache_creation_tokens = model_entry
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            model_entry.total_cost_usd += stats.total_cost_usd;
            model_entry.unpriced_tokens = model_entry
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);

            let day_entry = day_map.entry(day_start).or_insert(DayStatsAggregate {
                sessions: 0,
                messages: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                total_cost_usd: 0.0,
                unpriced_tokens: 0,
                session_refs: Vec::new(),
            });
            let day_session_key = format!("{day_start}|{session_key}");
            if seen_day_sessions.insert(day_session_key) {
                day_entry.sessions += 1;
                day_entry.messages += summary.message_count;
                day_entry.session_refs.push(summary.clone());
            }
            day_entry.input_tokens = day_entry.input_tokens.saturating_add(stats.input_tokens);
            day_entry.output_tokens = day_entry.output_tokens.saturating_add(stats.output_tokens);
            day_entry.cache_read_tokens = day_entry
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            day_entry.cache_creation_tokens = day_entry
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            day_entry.total_cost_usd += stats.total_cost_usd;
            day_entry.unpriced_tokens = day_entry
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);
        }
    }

    let mut project_ranking: Vec<HistoryStatsProjectItem> = project_map.into_values().collect();
    project_ranking.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then(b.messages.cmp(&a.messages))
            .then(a.project_key.cmp(&b.project_key))
    });

    let mut model_distribution: Vec<HistoryStatsModelItem> = model_map
        .into_values()
        .map(|mut item| {
            item.ratio = if total_sessions == 0 {
                0.0
            } else {
                item.sessions as f64 / total_sessions as f64
            };
            item
        })
        .collect();
    model_distribution.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then_with(|| history_stats_total_tokens(b).cmp(&history_stats_total_tokens(a)))
            .then(a.model.cmp(&b.model))
    });

    let mut source_distribution: Vec<HistoryStatsSourceItem> = source_map.into_values().collect();
    source_distribution.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then(b.messages.cmp(&a.messages))
            .then(a.source.cmp(&b.source))
    });

    let mut project_efficiency: Vec<HistoryStatsProjectEfficiencyItem> = project_ranking
        .iter()
        .map(|item| HistoryStatsProjectEfficiencyItem {
            project_key: item.project_key.clone(),
            sessions: item.sessions,
            messages: item.messages,
            input_tokens: item.input_tokens,
            output_tokens: item.output_tokens,
            cache_read_tokens: item.cache_read_tokens,
            cache_creation_tokens: item.cache_creation_tokens,
            total_cost_usd: item.total_cost_usd,
            unpriced_tokens: item.unpriced_tokens,
            avg_messages_per_session: if item.sessions == 0 {
                0.0
            } else {
                item.messages as f64 / item.sessions as f64
            },
        })
        .collect();
    project_efficiency.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then_with(|| {
                b.avg_messages_per_session
                    .total_cmp(&a.avg_messages_per_session)
            })
            .then(a.project_key.cmp(&b.project_key))
    });

    let max_hour_sessions = hourly_map
        .iter()
        .map(|item| item.sessions)
        .max()
        .unwrap_or(0);
    let hourly_activity: Vec<HistoryStatsHourlyActivityItem> = hourly_map
        .into_iter()
        .enumerate()
        .map(|(hour, mut agg)| {
            agg.session_refs.sort_by(|a, b| {
                b.updated_at
                    .cmp(&a.updated_at)
                    .then(a.session_id.cmp(&b.session_id))
            });
            HistoryStatsHourlyActivityItem {
                hour: hour as u8,
                hour_start_utc: bounds.start_day + hour as i64 * HOUR_MS,
                sessions: agg.sessions,
                messages: agg.messages,
                level: calc_heat_level(agg.sessions, max_hour_sessions),
                input_tokens: agg.input_tokens,
                output_tokens: agg.output_tokens,
                cache_read_tokens: agg.cache_read_tokens,
                cache_creation_tokens: agg.cache_creation_tokens,
                total_cost_usd: agg.total_cost_usd,
                unpriced_tokens: agg.unpriced_tokens,
                session_refs: agg.session_refs,
            }
        })
        .collect();

    let max_day_sessions = day_map
        .values()
        .map(|item| item.sessions)
        .max()
        .unwrap_or(0);
    let mut heatmap = Vec::with_capacity(bounds.range_days);
    let mut daily_series = Vec::with_capacity(bounds.range_days);
    for day_idx in 0..bounds.range_days {
        let day_start = bounds.start_day + day_idx as i64 * DAY_MS;
        if let Some(mut day) = day_map.remove(&day_start) {
            day.session_refs.sort_by(|a, b| {
                b.updated_at
                    .cmp(&a.updated_at)
                    .then(a.session_id.cmp(&b.session_id))
            });
            let level = calc_heat_level(day.sessions, max_day_sessions);
            heatmap.push(HistoryStatsHeatmapDay {
                day_start_utc: day_start,
                sessions: day.sessions,
                messages: day.messages,
                level,
                session_refs: day.session_refs,
            });
            daily_series.push(HistoryStatsDailySeriesItem {
                day_start_utc: day_start,
                sessions: day.sessions,
                messages: day.messages,
                input_tokens: day.input_tokens,
                output_tokens: day.output_tokens,
                cache_read_tokens: day.cache_read_tokens,
                cache_creation_tokens: day.cache_creation_tokens,
                total_cost_usd: day.total_cost_usd,
                unpriced_tokens: day.unpriced_tokens,
            });
        } else {
            heatmap.push(HistoryStatsHeatmapDay {
                day_start_utc: day_start,
                sessions: 0,
                messages: 0,
                level: 0,
                session_refs: Vec::new(),
            });
            daily_series.push(HistoryStatsDailySeriesItem {
                day_start_utc: day_start,
                sessions: 0,
                messages: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                total_cost_usd: 0.0,
                unpriced_tokens: 0,
            });
        }
    }

    HistoryStatsResponse {
        range_days: bounds.range_days,
        total_sessions,
        total_messages,
        total_input_tokens,
        total_output_tokens,
        total_cache_read_tokens,
        total_cache_creation_tokens,
        total_cost_usd,
        total_unpriced_tokens,
        project_ranking,
        model_distribution,
        heatmap,
        daily_series,
        source_distribution,
        project_efficiency,
        hourly_activity,
    }
}

fn resolve_stats_time_bounds(
    range_days: Option<usize>,
    start_at: Option<i64>,
    end_at: Option<i64>,
) -> Result<StatsTimeBounds, String> {
    if let (Some(start_at), Some(end_at)) = (start_at, end_at) {
        if start_at <= 0 || end_at <= 0 || end_at < start_at {
            return Err("invalid_date_range".to_string());
        }
        let span_ms = end_at.saturating_sub(start_at);
        let range_days = (span_ms / DAY_MS).saturating_add(1) as usize;
        if range_days == 0 || range_days > MAX_STATS_RANGE_DAYS {
            return Err("date_range_too_large".to_string());
        }
        return Ok(StatsTimeBounds {
            start_at,
            end_at,
            start_day: start_at,
            range_days,
            explicit: true,
        });
    }
    if start_at.is_some() || end_at.is_some() {
        return Err("invalid_date_range".to_string());
    }

    let range_days = range_days.unwrap_or(30).clamp(1, MAX_STATS_RANGE_DAYS);
    let end_day = day_start_utc(now_millis());
    let start_day = end_day - (range_days as i64 - 1) * DAY_MS;
    Ok(StatsTimeBounds {
        start_at: start_day,
        end_at: end_day + DAY_MS - 1,
        start_day,
        range_days,
        explicit: false,
    })
}

fn stats_day_start_offset(bounds: StatsTimeBounds) -> i64 {
    if bounds.explicit {
        ((bounds.start_day % DAY_MS) + DAY_MS) % DAY_MS
    } else {
        0
    }
}

fn stats_day_start_with_offset(ts: i64, day_offset: i64) -> i64 {
    if ts <= 0 {
        return day_offset;
    }
    ts - (((ts - day_offset) % DAY_MS) + DAY_MS) % DAY_MS
}

fn stats_usage_events_or_fallback(
    summary: &HistorySessionSummary,
    stats: &SessionStatsScan,
) -> Vec<SessionUsageEventScan> {
    if !stats.usage_events.is_empty() {
        return stats.usage_events.clone();
    }

    let usage = UsageStatsScan {
        input_tokens: stats.input_tokens,
        output_tokens: stats.output_tokens,
        cache_read_tokens: stats.cache_read_tokens,
        cache_creation_tokens: stats.cache_creation_tokens,
        total_cost_usd: stats.total_cost_usd,
        unpriced_tokens: stats.unpriced_tokens,
    };
    if usage_stats_total_tokens(usage) == 0 {
        return Vec::new();
    }

    vec![SessionUsageEventScan {
        event_key: format!("fallback:{}:{}", summary.session_id, summary.updated_at),
        event_index: 0,
        timestamp_ms: Some(summary.updated_at),
        model: stats.dominant_model.clone(),
        usage,
    }]
}

fn reprice_usage_stats(model: Option<&str>, usage: UsageStatsScan) -> UsageStatsScan {
    calculate_usage_cost(
        model,
        UsageTokenScan {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            explicit_cost_usd: None,
        },
    )
}

fn history_stats_session_key(summary: &HistorySessionSummary) -> String {
    format!(
        "{}|{}|{}|{}",
        summary.source, summary.project_key, summary.session_id, summary.file_path
    )
}

fn make_history_stats_daily_index_cache_key(
    roots: &HistoryRoots,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_path: Option<&str>,
    bounds: StatsTimeBounds,
    index_generation: u64,
) -> String {
    format!(
        "{}|source={}|project={}|project_path={}|day_offset={}|gen={}",
        roots.cache_key(),
        source_filter.unwrap_or("__all__"),
        target_project.unwrap_or("__all__"),
        target_project_path.unwrap_or("__all__"),
        stats_day_start_offset(bounds),
        index_generation
    )
}

fn make_history_stats_aggregation_cache_key(
    roots: &HistoryRoots,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_path: Option<&str>,
    bounds: StatsTimeBounds,
    index_generation: u64,
) -> String {
    format!(
        "{}|source={}|project={}|project_path={}|start={}|end={}|gen={}",
        roots.cache_key(),
        source_filter.unwrap_or("__all__"),
        target_project.unwrap_or("__all__"),
        target_project_path.unwrap_or("__all__"),
        bounds.start_at,
        bounds.end_at,
        index_generation
    )
}

fn get_stats_aggregation_cache() -> &'static Mutex<HistoryStatsAggregationCache> {
    HISTORY_STATS_AGGREGATION_CACHE
        .get_or_init(|| Mutex::new(HistoryStatsAggregationCache::default()))
}

fn stats_aggregation_cache_get(key: &str) -> Option<HistoryStatsResponse> {
    let cache = get_stats_aggregation_cache().lock().ok()?;
    cache.entries.get(key).map(|entry| entry.response.clone())
}

fn stats_aggregation_cache_set(key: String, response: HistoryStatsResponse) {
    if let Ok(mut cache) = get_stats_aggregation_cache().lock() {
        if !cache.entries.contains_key(&key)
            && cache.entries.len() >= HISTORY_STATS_AGGREGATION_CACHE_MAX
        {
            if let Some(oldest_key) = cache
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.cached_at)
                .map(|(key, _)| key.clone())
            {
                cache.entries.remove(&oldest_key);
            }
        }
        cache.entries.insert(
            key,
            CachedHistoryStatsAggregation {
                response,
                cached_at: now_millis(),
            },
        );
    }
}

fn get_stats_daily_index_cache() -> &'static Mutex<HistoryStatsDailyIndexCache> {
    HISTORY_STATS_DAILY_INDEX_CACHE
        .get_or_init(|| Mutex::new(HistoryStatsDailyIndexCache::default()))
}

fn stats_daily_index_cache_get(key: &str) -> Option<CachedHistoryStatsDailyIndex> {
    let cache = get_stats_daily_index_cache().lock().ok()?;
    cache.entries.get(key).cloned()
}

fn stats_daily_index_cache_set(key: String, daily_index: CachedHistoryStatsDailyIndex) {
    if let Ok(mut cache) = get_stats_daily_index_cache().lock() {
        if !cache.entries.contains_key(&key)
            && cache.entries.len() >= HISTORY_STATS_DAILY_INDEX_CACHE_MAX
        {
            if let Some(oldest_key) = cache
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.cached_at)
                .map(|(key, _)| key.clone())
            {
                cache.entries.remove(&oldest_key);
            }
        }
        cache.entries.insert(key, daily_index);
    }
}

fn get_project_cache() -> &'static Mutex<SessionProjectCache> {
    SESSION_PROJECT_CACHE.get_or_init(|| Mutex::new(SessionProjectCache::default()))
}

fn get_files_cache() -> &'static Mutex<SessionFilesCache> {
    SESSION_FILES_CACHE.get_or_init(|| Mutex::new(SessionFilesCache::default()))
}

fn get_wsl_session_fingerprint_cache() -> &'static Mutex<WslSessionFingerprintCache> {
    WSL_SESSION_FINGERPRINT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_history_index() -> &'static RwLock<HistorySessionIndex> {
    HISTORY_SESSION_INDEX.get_or_init(|| RwLock::new(HistorySessionIndex::default()))
}

pub(crate) fn invalidate_history_caches() {
    catalog::mark_dirty();
    if let Ok(mut cache) = get_files_cache().lock() {
        cache.by_source.clear();
    }
    if let Ok(mut cache) = get_project_cache().lock() {
        cache.entries.clear();
    }
    invalidate_history_stats_caches();
    if let Ok(mut cache) = get_wsl_session_fingerprint_cache().lock() {
        cache.clear();
    }
    if let Ok(mut index) = get_history_index().write() {
        *index = HistorySessionIndex::default();
    }
    clear_persisted_history_index();
}

pub(crate) fn invalidate_history_stats_caches() {
    if let Ok(mut cache) = get_stats_aggregation_cache().lock() {
        cache.entries.clear();
    }
    if let Ok(mut cache) = get_stats_daily_index_cache().lock() {
        cache.entries.clear();
    }
}

// ===== 历史索引磁盘持久化 =====
// 内存索引（HISTORY_SESSION_INDEX）每次 App 启动后为空，首个 history_get_stats 必须
// 全量解析所有 JSONL（可能上千个），冷启动耗时不可接受。这里把 per-file 解析结果落盘，
// 重启后载入作为 build_history_index 的 previous，按 fingerprint 仅重解析变更文件。
const HISTORY_INDEX_CACHE_VERSION: u32 = 7;
const HISTORY_INDEX_CACHE_FILE: &str = "history-index-cache.json";

static HISTORY_INDEX_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
static HISTORY_INDEX_DISK_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
// roots_key -> 已落盘的 generation，内容未变时跳过重复写盘。
static HISTORY_INDEX_PERSISTED_GEN: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct PersistedHistoryIndex {
    version: u32,
    roots_key: String,
    generation: u64,
    entries: Vec<HistoryIndexEntry>,
}

/// App 启动时注入 appLocalData 目录（见 lib.rs setup）。未设置时持久化静默关闭。
pub fn set_history_index_cache_dir(dir: PathBuf) {
    let _ = HISTORY_INDEX_CACHE_DIR.set(dir);
}

fn history_index_disk_lock() -> &'static Mutex<()> {
    HISTORY_INDEX_DISK_LOCK.get_or_init(|| Mutex::new(()))
}

fn history_index_persisted_gen() -> &'static Mutex<HashMap<String, u64>> {
    HISTORY_INDEX_PERSISTED_GEN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn history_index_cache_file() -> Option<PathBuf> {
    HISTORY_INDEX_CACHE_DIR
        .get()
        .map(|dir| dir.join(HISTORY_INDEX_CACHE_FILE))
}

fn persisted_generation(roots_key: &str) -> Option<u64> {
    history_index_persisted_gen()
        .lock()
        .ok()
        .and_then(|map| map.get(roots_key).copied())
}

fn set_persisted_generation(roots_key: &str, generation: u64) {
    if let Ok(mut map) = history_index_persisted_gen().lock() {
        map.insert(roots_key.to_string(), generation);
    }
}

fn load_persisted_history_index(roots: &HistoryRoots) -> Option<HistorySessionIndex> {
    let path = history_index_cache_file()?;
    let bytes = {
        let _guard = history_index_disk_lock().lock().ok()?;
        std::fs::read(&path).ok()?
    };
    let persisted: PersistedHistoryIndex = serde_json::from_slice(&bytes).ok()?;
    if persisted.version != HISTORY_INDEX_CACHE_VERSION {
        return None;
    }
    let roots_key = roots.cache_key();
    if persisted.roots_key != roots_key {
        return None;
    }
    let entries = persisted.entries;
    set_persisted_generation(&roots_key, persisted.generation);
    Some(HistorySessionIndex {
        roots: roots.clone(),
        entries,
        // refreshed_at=0 → 刷新逻辑视为已过期，会重建并按 fingerprint 复用磁盘 computed。
        refreshed_at: 0,
        generation: persisted.generation,
    })
}

fn save_persisted_history_index(index: &HistorySessionIndex) {
    let Some(path) = history_index_cache_file() else {
        return;
    };
    let roots_key = index.roots.cache_key();
    // 内容（generation）未变则跳过写盘。
    if persisted_generation(&roots_key) == Some(index.generation) {
        return;
    }
    let persisted = PersistedHistoryIndex {
        version: HISTORY_INDEX_CACHE_VERSION,
        roots_key: roots_key.clone(),
        generation: index.generation,
        entries: index.entries.clone(),
    };
    let Ok(bytes) = serde_json::to_vec(&persisted) else {
        return;
    };
    let Ok(_guard) = history_index_disk_lock().lock() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 临时文件 + rename，避免崩溃时残留半截损坏文件。
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
        set_persisted_generation(&roots_key, index.generation);
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn clear_persisted_history_index() {
    if let Ok(mut map) = history_index_persisted_gen().lock() {
        map.clear();
    }
    if let Some(path) = history_index_cache_file() {
        let _guard = history_index_disk_lock().lock();
        let _ = std::fs::remove_file(&path);
    }
}

fn refresh_history_index(roots: &HistoryRoots) -> Vec<HistoryIndexEntry> {
    refresh_history_index_snapshot(roots, false).entries
}

fn refresh_history_index_snapshot(roots: &HistoryRoots, force: bool) -> HistorySessionIndex {
    let now = now_millis();
    if !force {
        if let Ok(index) = get_history_index().read() {
            if index.roots.eq(roots)
                && index.refreshed_at > 0
                && now - index.refreshed_at < HISTORY_SESSION_INDEX_TTL_MS
            {
                return index.clone();
            }
        }
    }

    let mut previous = get_history_index()
        .read()
        .ok()
        .filter(|index| index.roots.eq(roots) && index.refreshed_at > 0)
        .map(|index| index.clone());
    // 冷启动（内存索引为空）时从磁盘载入，使 build 按 fingerprint 复用已解析结果，
    // 仅重解析变更/新增文件，避免每次重启全量解析全部 JSONL。
    if previous.is_none() {
        previous = load_persisted_history_index(roots);
    }
    let next = build_history_index(now, roots, previous, force);

    if let Ok(mut index) = get_history_index().write() {
        *index = next.clone();
    }
    save_persisted_history_index(&next);

    next
}

fn build_history_index(
    now: i64,
    roots: &HistoryRoots,
    previous: Option<HistorySessionIndex>,
    force_file_scan: bool,
) -> HistorySessionIndex {
    let mut previous_entries: HashMap<String, HistoryIndexEntry> = previous
        .as_ref()
        .map(|index| {
            index
                .entries
                .iter()
                .cloned()
                .map(|entry| (path_to_key(&entry.file_ref.path), entry))
                .collect()
        })
        .unwrap_or_default();
    let previous_generation = previous.as_ref().map(|index| index.generation).unwrap_or(0);
    let files = collect_session_files_with_force(None, roots, force_file_scan);
    let mut entries: Vec<Option<HistoryIndexEntry>> = Vec::with_capacity(files.len());
    let mut pending: Vec<(usize, SessionFileRef, SessionFileFingerprint)> = Vec::new();

    for file_ref in files {
        let path_key = path_to_key(&file_ref.path);
        let fingerprint = session_file_fingerprint(&file_ref.path);
        if let Some(mut existing) = previous_entries.remove(&path_key) {
            if existing.file_ref.source == file_ref.source
                && existing.file_ref.project_key == file_ref.project_key
                && can_reuse_session_scan(existing.fingerprint, fingerprint)
            {
                existing.file_ref = file_ref;
                existing.fingerprint = fingerprint;
                existing.computed.created_at = fingerprint.created_at;
                existing.computed.updated_at = fingerprint.updated_at;
                entries.push(Some(existing));
                continue;
            }
        }

        pending.push((entries.len(), file_ref, fingerprint));
        entries.push(None);
    }

    // 缓存未命中的文件需要全量解析（CPU+IO 密集），按核数并行扫描；
    // 首次构建索引时可能有上千个 jsonl，串行耗时不可接受。
    if !pending.is_empty() {
        let worker_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(pending.len());
        let next_job = AtomicUsize::new(0);
        let scanned: Mutex<Vec<(usize, HistoryIndexEntry)>> =
            Mutex::new(Vec::with_capacity(pending.len()));
        std::thread::scope(|scope| {
            for _ in 0..worker_count {
                scope.spawn(|| loop {
                    let job = next_job.fetch_add(1, Ordering::Relaxed);
                    let Some((slot, file_ref, fingerprint)) = pending.get(job) else {
                        break;
                    };
                    let computed = scan_session_computation(
                        &file_ref.path,
                        fingerprint.created_at,
                        fingerprint.updated_at,
                    );
                    let entry = HistoryIndexEntry {
                        file_ref: file_ref.clone(),
                        fingerprint: *fingerprint,
                        computed,
                    };
                    if let Ok(mut scanned) = scanned.lock() {
                        scanned.push((*slot, entry));
                    }
                });
            }
        });
        for (slot, entry) in scanned.into_inner().unwrap_or_default() {
            entries[slot] = Some(entry);
        }
    }

    let mut entries: Vec<HistoryIndexEntry> = entries.into_iter().flatten().collect();

    entries.sort_by(|a, b| b.computed.updated_at.cmp(&a.computed.updated_at));

    let changed = previous
        .as_ref()
        .map(|previous| !history_index_entries_match(&previous.entries, &entries))
        .unwrap_or(true);
    let generation = if changed {
        previous_generation.saturating_add(1)
    } else {
        previous_generation
    };

    HistorySessionIndex {
        roots: roots.clone(),
        entries,
        refreshed_at: now,
        generation,
    }
}

fn history_index_entries_match(previous: &[HistoryIndexEntry], next: &[HistoryIndexEntry]) -> bool {
    if previous.len() != next.len() {
        return false;
    }

    let previous_by_path: HashMap<String, (&str, &str, SessionFileFingerprint)> = previous
        .iter()
        .map(|entry| {
            (
                path_to_key(&entry.file_ref.path),
                (
                    entry.file_ref.source.as_str(),
                    entry.file_ref.project_key.as_str(),
                    entry.fingerprint,
                ),
            )
        })
        .collect();

    next.iter().all(|entry| {
        let path_key = path_to_key(&entry.file_ref.path);
        previous_by_path
            .get(&path_key)
            .map(|(source, project_key, fingerprint)| {
                *source == entry.file_ref.source.as_str()
                    && *project_key == entry.file_ref.project_key.as_str()
                    && *fingerprint == entry.fingerprint
            })
            .unwrap_or(false)
    })
}

fn can_reuse_session_scan(
    previous: SessionFileFingerprint,
    current: SessionFileFingerprint,
) -> bool {
    previous.updated_at == current.updated_at && previous.size == current.size
}

pub(crate) fn session_file_fingerprint(path: &Path) -> SessionFileFingerprint {
    let path_str = path.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&path_str) {
        if let Ok(cache) = get_wsl_session_fingerprint_cache().lock() {
            if let Some(entry) = cache.get(&path_to_key(path)) {
                if now_millis() - entry.cached_at < SESSION_FILES_TTL_MS {
                    debug!(
                        "[wsl] fingerprint cache hit: path={} age_ms={}",
                        path_str,
                        now_millis().saturating_sub(entry.cached_at)
                    );
                    return entry.fingerprint;
                }
            }
        }
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path_str) {
            debug!("[wsl] fingerprint 使用 wsl stat: distro={distro} path={linux_path}");
            return wsl_session_fingerprint(&linux_path, &distro);
        }
        warn!("[wsl] fingerprint 解析 WSL UNC 失败: {path_str}, 回退 fs::metadata");
    }

    let metadata = fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(system_time_to_millis)
        .unwrap_or(0);
    let created_at = metadata
        .as_ref()
        .and_then(|m| m.created().ok())
        .map(system_time_to_millis)
        .unwrap_or(updated_at);
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

    SessionFileFingerprint {
        created_at,
        updated_at,
        size,
    }
}

fn summary_from_computation(
    file_ref: &SessionFileRef,
    computed: &CachedSessionComputation,
) -> HistorySessionSummary {
    HistorySessionSummary {
        session_id: computed.session_id.clone(),
        source: file_ref.source.clone(),
        project_key: file_ref.project_key.clone(),
        title: computed.title.clone(),
        file_path: file_ref.path.to_string_lossy().to_string(),
        cwd: get_or_scan_session_project(&file_ref.path).cwd,
        created_at: computed.created_at,
        updated_at: computed.updated_at,
        message_count: computed.message_count,
        branch: computed.branch.clone(),
    }
}

fn scan_session_computation(
    path: &Path,
    created_at: i64,
    updated_at: i64,
) -> CachedSessionComputation {
    let (summary_scan, stats) = scan_session_combined(path);
    build_session_computation(path, created_at, updated_at, summary_scan, stats)
}

/// 单遍同时取得 computation 与完整消息列表，供 detail 复用同一次读取与解析。
fn scan_session_computation_with_messages(
    path: &Path,
    created_at: i64,
    updated_at: i64,
) -> (CachedSessionComputation, Vec<HistoryMessage>) {
    let (summary_scan, stats, messages) = scan_session_detail(path);
    (
        build_session_computation(path, created_at, updated_at, summary_scan, stats),
        messages,
    )
}

fn build_session_computation(
    path: &Path,
    created_at: i64,
    updated_at: i64,
    summary_scan: SessionSummaryScan,
    stats: SessionStatsScan,
) -> CachedSessionComputation {
    let fallback_session_id = path
        .file_stem()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown-session".to_string());
    let session_id = if is_codex_rollout_session_path(path) {
        summary_scan
            .session_id
            .clone()
            .unwrap_or_else(|| fallback_session_id.clone())
    } else {
        fallback_session_id
    };
    let title = summary_scan
        .first_user_message
        .or(summary_scan.first_message)
        .map(|text| excerpt(&text, 80))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| session_id.clone());

    CachedSessionComputation {
        created_at,
        updated_at,
        session_id,
        title,
        message_count: summary_scan.message_count,
        branch: summary_scan.branch,
        stats,
    }
}

fn scan_session_detail_parts(file_ref: &SessionFileRef) -> SessionDetailParts {
    // detail 必然要读完整消息，单遍同时算出 stats，避免对同一文件二次读取/解析；
    let fingerprint = session_file_fingerprint(&file_ref.path);
    let (computed, messages) = scan_session_computation_with_messages(
        &file_ref.path,
        fingerprint.created_at,
        fingerprint.updated_at,
    );
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

fn finalize_session_detail(
    file_ref: &SessionFileRef,
    parts: SessionDetailParts,
) -> HistorySessionDetail {
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
        message_count: parts.messages.len(),
        branch: parts.computed.branch,
        usage,
        tool_events: parts.tool_events,
        file_changes: parts.file_changes,
        messages: parts.messages,
    }
}

pub(crate) fn build_session_detail(
    file_ref: &SessionFileRef,
    aggregate_subtasks: bool,
) -> Result<HistorySessionDetail, String> {
    let parent_parts = scan_session_detail_parts(file_ref);
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
        parts.push(scan_session_detail_parts(&subtask_ref));
    }

    Ok(finalize_session_detail(
        file_ref,
        merge_session_detail_parts(file_ref, parts),
    ))
}

fn merge_session_detail_parts(
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

fn collect_subtask_session_file_refs(parent_file_ref: &SessionFileRef) -> Vec<SessionFileRef> {
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

fn convert_history_session(
    detail: &HistorySessionDetail,
    target_source: &str,
    roots: &HistoryRoots,
) -> Result<HistoryConversionResult, String> {
    let source = detail.source.trim().to_lowercase();
    let target_source = target_source.trim().to_lowercase();
    if source != "claude" && source != "codex" {
        return Err("unsupported_history_source".to_string());
    }
    if target_source != "claude" && target_source != "codex" {
        return Err("unsupported_target_history_source".to_string());
    }
    if source == target_source {
        return Err("history_conversion_same_source".to_string());
    }

    let session_id = Uuid::new_v4().to_string();
    let cwd = converted_session_cwd(detail);
    let lines = match target_source.as_str() {
        "claude" => build_claude_conversion_lines(detail, &session_id, cwd.as_deref()),
        "codex" => build_codex_conversion_lines(
            detail,
            &session_id,
            cwd.as_deref(),
            &codex_config_string(roots, "model_provider").unwrap_or_else(|| "custom".to_string()),
        ),
        _ => unreachable!(),
    };
    let message_count = detail
        .messages
        .iter()
        .filter(|message| !converted_message_content(message).trim().is_empty())
        .count();
    if message_count == 0 {
        return Err("history_conversion_no_messages".to_string());
    }

    let target_path = match target_source.as_str() {
        "claude" => converted_claude_session_path(detail, roots, &session_id, cwd.as_deref()),
        "codex" => converted_codex_session_path(roots, &session_id),
        _ => unreachable!(),
    };
    write_jsonl_lines(&target_path, &lines)?;
    if target_source == "codex" {
        append_codex_history_index(roots, detail, &session_id)?;
        append_codex_session_index(roots, detail, &session_id, &target_path, cwd.as_deref())?;
    }

    let file_ref = SessionFileRef {
        source: target_source.clone(),
        project_key: match target_source.as_str() {
            "claude" => cwd
                .as_deref()
                .map(claude_project_key_from_path)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "default".to_string()),
            "codex" => cwd
                .as_deref()
                .and_then(project_key_from_cwd)
                .unwrap_or_else(|| detail.project_key.clone()),
            _ => unreachable!(),
        },
        path: target_path.clone(),
    };
    let fingerprint = session_file_fingerprint(&file_ref.path);
    let title = codex_history_index_text(detail).unwrap_or_else(|| detail.title.clone());
    let summary = HistorySessionSummary {
        session_id: session_id.clone(),
        source: target_source.clone(),
        project_key: file_ref.project_key.clone(),
        title,
        file_path: file_ref.path.to_string_lossy().to_string(),
        cwd: cwd.clone(),
        created_at: fingerprint.created_at,
        updated_at: fingerprint.updated_at,
        message_count,
        branch: detail.branch.clone(),
    };

    Ok(HistoryConversionResult {
        source,
        target_source: target_source.clone(),
        session_id: session_id.clone(),
        project_key: summary.project_key.clone(),
        file_path: summary.file_path.clone(),
        cwd,
        message_count,
        resume_command: match target_source.as_str() {
            "claude" => format!("claude --resume {session_id}"),
            "codex" => format!("codex resume {session_id}"),
            _ => unreachable!(),
        },
        summary,
    })
}

fn converted_session_cwd(detail: &HistorySessionDetail) -> Option<String> {
    detail
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let project_key = detail.project_key.trim();
            if project_key.is_empty() {
                None
            } else {
                Some(project_key.to_string())
            }
        })
}

fn conversion_timestamp(message: &HistoryMessage) -> String {
    message
        .timestamp
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(now_rfc3339)
}

pub(crate) fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn converted_message_role(role: &str) -> &'static str {
    if role.eq_ignore_ascii_case("assistant") {
        "assistant"
    } else {
        "user"
    }
}

fn converted_message_content(message: &HistoryMessage) -> String {
    let content = message.content.trim();
    if message.role.eq_ignore_ascii_case("tool") {
        format!("[Tool]\n{content}")
    } else {
        content.to_string()
    }
}

fn build_claude_conversion_lines(
    detail: &HistorySessionDetail,
    session_id: &str,
    cwd: Option<&str>,
) -> Vec<Value> {
    let mut lines = Vec::new();
    let mut parent_uuid: Option<String> = None;
    for message in &detail.messages {
        let content = converted_message_content(message);
        if content.trim().is_empty() {
            continue;
        }
        let role = converted_message_role(&message.role);
        let uuid = Uuid::new_v4().to_string();
        lines.push(json!({
            "parentUuid": parent_uuid,
            "isSidechain": false,
            "userType": "external",
            "cwd": cwd.unwrap_or_default(),
            "sessionId": session_id,
            "version": "cli-manager-converted",
            "type": role,
            "message": {
                "role": role,
                "content": claude_message_content_value(role, content)
            },
            "uuid": uuid,
            "timestamp": conversion_timestamp(message)
        }));
        parent_uuid = Some(uuid);
    }
    lines
}

fn claude_message_content_value(role: &str, content: String) -> Value {
    if role == "assistant" {
        json!([{ "type": "text", "text": content }])
    } else {
        Value::String(content)
    }
}

fn build_codex_conversion_lines(
    detail: &HistorySessionDetail,
    session_id: &str,
    cwd: Option<&str>,
    model_provider: &str,
) -> Vec<Value> {
    let created_at = detail
        .messages
        .first()
        .map(conversion_timestamp)
        .unwrap_or_else(now_rfc3339);
    let mut lines = vec![
        json!({
            "timestamp": created_at,
            "type": "session_meta",
            "payload": {
                "session_id": session_id,
                "id": session_id,
                "timestamp": created_at,
                "cwd": cwd.unwrap_or_default(),
                "originator": "cli-manager",
                "cli_version": "cli-manager-converted",
                "model_provider": model_provider,
                "source": "cli",
                "thread_source": "user"
            }
        }),
        json!({
            "timestamp": created_at,
            "type": "turn_context",
            "payload": {
                "cwd": cwd.unwrap_or_default(),
                "model": detail
                    .usage
                    .current_model
                    .as_deref()
                    .or(detail.usage.dominant_model.as_deref())
                    .unwrap_or("converted-history")
            }
        }),
    ];

    for message in &detail.messages {
        let content = converted_message_content(message);
        if content.trim().is_empty() {
            continue;
        }
        let role = converted_message_role(&message.role);
        let block_type = if role == "assistant" {
            "output_text"
        } else {
            "input_text"
        };
        let timestamp = conversion_timestamp(message);
        lines.push(json!({
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": role,
                "content": [
                    {
                        "type": block_type,
                        "text": content
                    }
                ]
            }
        }));
        lines.push(codex_ui_event_message(role, &content, &timestamp));
    }
    lines
}

fn codex_ui_event_message(role: &str, content: &str, timestamp: &str) -> Value {
    if role == "assistant" {
        json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": content
            }
        })
    } else {
        json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": content
            }
        })
    }
}

fn converted_claude_session_path(
    detail: &HistorySessionDetail,
    roots: &HistoryRoots,
    session_id: &str,
    cwd: Option<&str>,
) -> PathBuf {
    let project_key = cwd
        .map(claude_project_key_from_path)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            let project_key = detail.project_key.trim();
            if project_key.is_empty() {
                "default".to_string()
            } else {
                project_key.to_string()
            }
        });
    unique_jsonl_path(
        resolve_claude_history_root(roots).join(project_key),
        session_id,
    )
}

fn converted_codex_session_path(roots: &HistoryRoots, session_id: &str) -> PathBuf {
    let now = Utc::now();
    let dir = resolve_codex_history_root(roots)
        .join(format!("{:04}", now.year()))
        .join(format!("{:02}", now.month()))
        .join(format!("{:02}", now.day()));
    let timestamp = now.format("%Y-%m-%dT%H-%M-%S");
    unique_jsonl_path(dir, &format!("rollout-{timestamp}-{session_id}"))
}

fn append_codex_history_index(
    roots: &HistoryRoots,
    detail: &HistorySessionDetail,
    session_id: &str,
) -> Result<(), String> {
    let path = resolve_codex_config_root(roots).join("history.jsonl");
    let parent = path
        .parent()
        .ok_or_else(|| "history_conversion_invalid_codex_history_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;

    let text = codex_history_index_text(detail)
        .unwrap_or_else(|| format!("Converted {} session", detail.source));
    let ts = codex_history_index_timestamp(detail);
    let line = json!({
        "session_id": session_id,
        "ts": ts,
        "text": text
    });
    append_jsonl_line(&path, &line)
}

fn codex_history_index_text(detail: &HistorySessionDetail) -> Option<String> {
    detail
        .messages
        .iter()
        .find(|message| {
            !converted_message_content(message).trim().is_empty()
                && converted_message_role(&message.role) == "user"
        })
        .or_else(|| {
            detail
                .messages
                .iter()
                .find(|message| !converted_message_content(message).trim().is_empty())
        })
        .map(converted_message_content)
        .map(|content| excerpt(&content, CODEX_HISTORY_INDEX_TEXT_MAX_CHARS))
        .filter(|content| !content.trim().is_empty())
}

fn codex_history_index_timestamp(detail: &HistorySessionDetail) -> i64 {
    detail
        .messages
        .first()
        .map(conversion_timestamp)
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.timestamp())
        .unwrap_or_else(|| Utc::now().timestamp())
}

fn append_codex_session_index(
    roots: &HistoryRoots,
    detail: &HistorySessionDetail,
    session_id: &str,
    rollout_path: &Path,
    cwd: Option<&str>,
) -> Result<(), String> {
    let path = resolve_codex_config_root(roots).join("session_index.jsonl");
    let parent = path
        .parent()
        .ok_or_else(|| "history_conversion_invalid_codex_session_index_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;

    let thread_name = codex_history_index_text(detail)
        .unwrap_or_else(|| format!("Converted {} session", detail.source));
    let updated_at = detail
        .messages
        .last()
        .map(conversion_timestamp)
        .unwrap_or_else(now_rfc3339);
    let line = json!({
        "id": session_id,
        "thread_name": thread_name,
        "updated_at": updated_at,
        "cwd": cwd.unwrap_or_default(),
        "rollout_path": codex_runtime_path(rollout_path)
    });
    append_jsonl_line(&path, &line)
}

fn append_jsonl_line(path: &Path, line: &Value) -> Result<(), String> {
    let encoded = serde_json::to_string(line).map_err(|err| err.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    file.write_all(encoded.as_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(b"\n").map_err(|err| err.to_string())?;
    file.flush().map_err(|err| err.to_string())
}

fn build_codex_thread_registration(
    roots: &HistoryRoots,
    detail: &HistorySessionDetail,
    result: &HistoryConversionResult,
) -> CodexThreadRegistration {
    let first_timestamp = detail
        .messages
        .first()
        .map(conversion_timestamp)
        .unwrap_or_else(now_rfc3339);
    let last_timestamp = detail
        .messages
        .last()
        .map(conversion_timestamp)
        .unwrap_or_else(|| first_timestamp.clone());
    let created_at_ms =
        rfc3339_millis(&first_timestamp).unwrap_or_else(|| Utc::now().timestamp_millis());
    let updated_at_ms = rfc3339_millis(&last_timestamp).unwrap_or(created_at_ms);
    let first_user_message = codex_history_index_text(detail).unwrap_or_default();
    let model = detail
        .usage
        .current_model
        .as_deref()
        .or(detail.usage.dominant_model.as_deref())
        .map(str::to_string)
        .or_else(|| codex_config_string(roots, "model"))
        .unwrap_or_else(|| "converted-history".to_string());
    let model_provider =
        codex_config_string(roots, "model_provider").unwrap_or_else(|| "custom".to_string());

    CodexThreadRegistration {
        state_db_path: resolve_codex_state_db_path(roots),
        session_id: result.session_id.clone(),
        rollout_path: codex_runtime_path(Path::new(&result.file_path)),
        created_at: created_at_ms / 1000,
        updated_at: updated_at_ms / 1000,
        created_at_ms,
        updated_at_ms,
        cwd: result.cwd.clone().unwrap_or_default(),
        title: first_user_message.clone(),
        first_user_message: first_user_message.clone(),
        preview: first_user_message,
        model,
        model_provider,
    }
}

fn rfc3339_millis(timestamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(timestamp.trim())
        .ok()
        .map(|value| value.timestamp_millis())
}

async fn register_codex_thread(registration: &CodexThreadRegistration) -> Result<(), String> {
    if !should_register_codex_state_db(&registration.state_db_path) {
        info!(
            "skip Windows-side Codex state registration for WSL database: {}",
            registration.state_db_path.to_string_lossy()
        );
        return Ok(());
    }
    if !registration.state_db_path.exists() {
        warn!(
            "skip Codex state registration: state db not found: {}",
            registration.state_db_path.to_string_lossy()
        );
        return Ok(());
    }
    let mut conn = open_sqlite_readwrite(&registration.state_db_path).await?;
    let sandbox_policy = json!({ "type": "disabled" }).to_string();
    sqlx::query(
        "INSERT INTO threads (
            id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
            sandbox_policy, approval_mode, tokens_used, has_user_event, archived, cli_version,
            first_user_message, memory_mode, model, thread_source, preview, recency_at,
            created_at_ms, updated_at_ms, recency_at_ms
        ) VALUES (
            ?1, ?2, ?3, ?4, 'cli', ?5, ?6, ?7,
            ?8, 'never', 0, 1, 0, 'cli-manager-converted',
            ?9, 'enabled', ?10, 'user', ?11, ?12,
            ?13, ?14, ?15
        )
        ON CONFLICT(id) DO UPDATE SET
            rollout_path = excluded.rollout_path,
            updated_at = excluded.updated_at,
            model_provider = excluded.model_provider,
            cwd = excluded.cwd,
            title = excluded.title,
            first_user_message = excluded.first_user_message,
            model = excluded.model,
            preview = excluded.preview,
            recency_at = excluded.recency_at,
            updated_at_ms = excluded.updated_at_ms,
            recency_at_ms = excluded.recency_at_ms",
    )
    .bind(&registration.session_id)
    .bind(&registration.rollout_path)
    .bind(registration.created_at)
    .bind(registration.updated_at)
    .bind(&registration.model_provider)
    .bind(&registration.cwd)
    .bind(&registration.title)
    .bind(sandbox_policy)
    .bind(&registration.first_user_message)
    .bind(&registration.model)
    .bind(&registration.preview)
    .bind(registration.updated_at)
    .bind(registration.created_at_ms)
    .bind(registration.updated_at_ms)
    .bind(registration.updated_at_ms)
    .execute(&mut conn)
    .await
    .map_err(|err| format!("codex_state_register_failed: {err}"))?;
    Ok(())
}

async fn open_sqlite_readwrite(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("db_open_failed: {err}"))
}

fn unique_jsonl_path(dir: PathBuf, stem: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.jsonl"));
    let mut index = 1usize;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{index}.jsonl"));
        index += 1;
    }
    candidate
}

fn write_jsonl_lines(path: &Path, lines: &[Value]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "history_conversion_invalid_target_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let mut file = File::create(path).map_err(|err| err.to_string())?;
    for line in lines {
        let encoded = serde_json::to_string(line).map_err(|err| err.to_string())?;
        file.write_all(encoded.as_bytes())
            .map_err(|err| err.to_string())?;
        file.write_all(b"\n").map_err(|err| err.to_string())?;
    }
    file.flush().map_err(|err| err.to_string())
}

fn list_subagent_transcript_files(subagents_dir: &Path) -> Vec<PathBuf> {
    let dir_str = subagents_dir.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&dir_str) {
        if let Some((distro, linux_dir)) = crate::wsl::parse_wsl_unc_path(&dir_str) {
            return wsl_find_session_files(&linux_dir, &distro, "agent-*.jsonl", &|_| {
                "subagent".to_string()
            })
            .into_iter()
            .map(|hit| {
                let unc = crate::wsl::linux_to_unc_wsl_path(&hit.linux_path, &distro);
                remember_wsl_session_fingerprint(&unc, hit.fingerprint);
                PathBuf::from(unc)
            })
            .collect();
        }
    }
    if !subagents_dir.exists() {
        return Vec::new();
    }
    read_dir_entries(subagents_dir)
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| is_subagent_transcript_path(path))
        .collect()
}

fn is_subagent_transcript_path(path: &Path) -> bool {
    let is_subagents_dir = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("subagents"))
        .unwrap_or(false);
    let is_agent_file = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
        .unwrap_or(false);
    is_subagents_dir && is_agent_file
}

pub(crate) fn history_roots(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> HistoryRoots {
    HistoryRoots {
        claude_config_dir: normalize_config_dir(claude_config_dir),
        codex_config_dir: normalize_config_dir(codex_config_dir),
    }
}

fn normalize_config_dir(value: Option<String>) -> Option<PathBuf> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn resolve_claude_history_root(roots: &HistoryRoots) -> PathBuf {
    roots
        .claude_config_dir
        .clone()
        .or_else(|| detect_home_dir().map(|home| home.join(".claude")))
        .unwrap_or_else(|| PathBuf::from(".claude"))
        .join("projects")
}

fn resolve_codex_config_root(roots: &HistoryRoots) -> PathBuf {
    roots
        .codex_config_dir
        .clone()
        .or_else(|| detect_home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

fn resolve_codex_history_root(roots: &HistoryRoots) -> PathBuf {
    resolve_codex_config_root(roots).join("sessions")
}

fn resolve_codex_state_db_path(roots: &HistoryRoots) -> PathBuf {
    let root = resolve_codex_config_root(roots);
    if let Some(sqlite_home) = codex_config_string(roots, "sqlite_home") {
        return expand_codex_config_path(&root, &sqlite_home).join("state_5.sqlite");
    }

    let default_path = root.join("state_5.sqlite");
    if default_path.exists() {
        return default_path;
    }
    let nested_path = root.join("sqlite").join("state_5.sqlite");
    if nested_path.exists() {
        return nested_path;
    }
    default_path
}

fn codex_config_string(roots: &HistoryRoots, key: &str) -> Option<String> {
    let raw = fs::read_to_string(resolve_codex_config_root(roots).join("config.toml")).ok()?;
    parse_top_level_toml_string(&raw, key)
}

fn parse_top_level_toml_string(raw: &str, key: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            return None;
        }
        let Some((left, right)) = trimmed.split_once('=') else {
            continue;
        };
        if left.trim() != key {
            continue;
        }
        return parse_toml_string_value(right.trim());
    }
    None
}

fn parse_toml_string_value(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let quote = raw.chars().next()?;
    if quote == '"' || quote == '\'' {
        let mut escaped = false;
        let mut out = String::new();
        for ch in raw[quote.len_utf8()..].chars() {
            if quote == '"' && escaped {
                out.push(match ch {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    '"' => '"',
                    '\\' => '\\',
                    other => other,
                });
                escaped = false;
                continue;
            }
            if quote == '"' && ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == quote {
                return Some(out);
            }
            out.push(ch);
        }
        return None;
    }
    raw.split('#')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn expand_codex_config_path(root: &Path, value: &str) -> PathBuf {
    let trimmed = value.trim();
    let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
        detect_home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed.strip_prefix("~\\") {
        detect_home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(trimmed))
    } else {
        PathBuf::from(trimmed)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        root.join(expanded)
    }
}

fn collect_session_files(source_filter: Option<&str>, roots: &HistoryRoots) -> Vec<SessionFileRef> {
    collect_session_files_with_force(source_filter, roots, false)
}

fn collect_session_files_with_force(
    source_filter: Option<&str>,
    roots: &HistoryRoots,
    force: bool,
) -> Vec<SessionFileRef> {
    let cache_key = format!(
        "{}|{}",
        source_filter
            .map(|v| v.to_lowercase())
            .unwrap_or_else(|| "*".to_string()),
        roots.cache_key()
    );
    let now = now_millis();

    if !force {
        if let Ok(cache) = get_files_cache().lock() {
            if let Some(entry) = cache.by_source.get(&cache_key) {
                if now - entry.timestamp_ms < SESSION_FILES_TTL_MS {
                    return entry.files.clone();
                }
            }
        }
    }

    let files = scan_session_files(source_filter, roots);

    if let Ok(mut cache) = get_files_cache().lock() {
        cache.by_source.insert(
            cache_key,
            CachedSessionFiles {
                timestamp_ms: now,
                files: files.clone(),
            },
        );
    }

    files
}

fn scan_session_files(source_filter: Option<&str>, roots: &HistoryRoots) -> Vec<SessionFileRef> {
    let mut files = Vec::new();
    let source_filter = source_filter.map(|v| v.to_lowercase());

    if source_filter
        .as_ref()
        .map(|v| v == "claude")
        .unwrap_or(true)
    {
        files.extend(collect_claude_session_files(&resolve_claude_history_root(
            roots,
        )));
    }
    if source_filter.as_ref().map(|v| v == "codex").unwrap_or(true) {
        files.extend(collect_codex_session_files(&resolve_codex_history_root(
            roots,
        )));
    }

    files
}

// ── WSL 路径感知的会话文件扫描 ───────────────────────────────────────────────
// 当 history root 指向 WSL UNC 路径（\\wsl.localhost\...）时，fs::read_dir 等
// Windows 原生文件 API 在 Plan 9 协议上不可靠。此时改用 wsl.exe 命令在 WSL 内部
// 完成目录枚举与元数据读取，绕过文件系统限制。

fn wsl_command_output(program: &str, args: &[&str]) -> Result<Output, String> {
    let mut cmd = silent_command(program);
    cmd.args(args);
    cmd.output()
        .map_err(|err| format!("wsl command '{program} {}' failed: {err}", args.join(" ")))
}

/// 执行 wsl 命令并返回 stdout + stderr 文本，失败时返回错误信息。
fn wsl_command_text(program: &str, args: &[&str]) -> Result<(String, String), String> {
    let output = wsl_command_output(program, args)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "wsl command failed (exit {}): {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".to_string()),
            stderr.trim()
        ));
    }
    Ok((stdout, stderr))
}

/// 通过 `wsl.exe find` 在 WSL 内递归列出 JSONL 会话文件，
/// 返回路径与 find 一次性带出的基础元数据，避免后续对每个文件再 shell out `stat`。
fn wsl_find_session_files(
    linux_dir: &str,
    distro: &str,
    name_pattern: &str,
    project_key_from_path: &dyn Fn(&str) -> String,
) -> Vec<WslSessionFileHit> {
    let wsl_exe = crate::wsl::find_wsl_exe();
    let wsl_exe_str = wsl_exe
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string());

    let args = [
        "-d",
        distro,
        "--exec",
        "find",
        linux_dir,
        "-name",
        name_pattern,
        "-type",
        "f",
        "-printf",
        "%p\t%s\t%T@\n",
    ];
    info!(
        "[wsl] 枚举会话文件: wsl.exe -d {distro} find {linux_dir} -name '{name_pattern}' -type f"
    );
    let started_at = now_millis();
    let result = wsl_command_text(&wsl_exe_str, &args);

    match result {
        Ok((stdout, stderr)) => {
            let mut total_lines = 0usize;
            let mut skipped_lines = 0usize;
            let mut files = Vec::new();
            for line in stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                total_lines += 1;
                if let Some(hit) = parse_wsl_find_session_file_line(line, project_key_from_path) {
                    files.push(hit);
                } else {
                    skipped_lines += 1;
                }
            }

            info!(
                "[wsl] 枚举完成: distro={distro} dir={linux_dir} pattern={name_pattern} files={} skipped={} raw_lines={} elapsed_ms={}",
                files.len(),
                skipped_lines,
                total_lines,
                now_millis().saturating_sub(started_at)
            );
            if !stderr.trim().is_empty() {
                warn!("[wsl] find stderr: {}", stderr.trim());
            }
            if files.is_empty() {
                warn!(
                    "[wsl] find 返回空: distro={distro} dir={linux_dir} — 可能目录不存在或权限不足"
                );
            }
            files
        }
        Err(err) => {
            warn!(
                "[wsl] find 执行失败: distro={distro} dir={linux_dir} elapsed_ms={} error={}",
                now_millis().saturating_sub(started_at),
                err.trim()
            );
            Vec::new()
        }
    }
}

fn parse_wsl_find_timestamp_millis(raw: &str) -> i64 {
    raw.trim()
        .parse::<f64>()
        .ok()
        .map(|seconds| (seconds * 1000.0).round() as i64)
        .filter(|millis| *millis > 0)
        .unwrap_or(0)
}

fn parse_wsl_find_session_file_line(
    line: &str,
    project_key_from_path: &dyn Fn(&str) -> String,
) -> Option<WslSessionFileHit> {
    let mut parts = line.rsplitn(3, '\t');
    let mtime_raw = parts.next()?;
    let size_raw = parts.next()?;
    let linux_path = parts.next()?.trim();
    if linux_path.is_empty() || !linux_path.ends_with(".jsonl") {
        return None;
    }

    let size = size_raw.trim().parse::<u64>().unwrap_or(0);
    let updated_at = parse_wsl_find_timestamp_millis(mtime_raw);
    let fingerprint = SessionFileFingerprint {
        created_at: updated_at,
        updated_at,
        size,
    };

    Some(WslSessionFileHit {
        linux_path: linux_path.to_string(),
        project_key: project_key_from_path(linux_path),
        fingerprint,
    })
}

fn remember_wsl_session_fingerprint(unc_path: &str, fingerprint: SessionFileFingerprint) {
    if let Ok(mut cache) = get_wsl_session_fingerprint_cache().lock() {
        cache.insert(
            path_to_key(Path::new(unc_path)),
            CachedWslSessionFingerprint {
                fingerprint,
                cached_at: now_millis(),
            },
        );
    }
}

/// 通过 `wsl.exe stat` 获取文件元数据（size / mtime / ctime）。
fn wsl_session_fingerprint(linux_path: &str, distro: &str) -> SessionFileFingerprint {
    let wsl_exe = crate::wsl::find_wsl_exe();
    let wsl_exe_str = wsl_exe
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string());

    let args = ["-d", distro, "--exec", "stat", "-c", "%s %Y %W", linux_path];
    let result = wsl_command_text(&wsl_exe_str, &args);

    match result {
        Ok((stdout, _stderr)) => {
            let parts: Vec<&str> = stdout.trim().split_whitespace().collect();
            if parts.len() < 3 {
                warn!(
                    "[wsl] stat 输出格式异常: distro={distro} path={linux_path} stdout='{}'",
                    stdout.trim()
                );
                return SessionFileFingerprint::default();
            }

            let size: u64 = parts[0].parse().unwrap_or(0);
            let mtime: i64 = parts[1].parse().unwrap_or(0);
            let ctime: i64 = parts[2].parse().unwrap_or(0);
            let created_at = if ctime > 0 {
                ctime * 1000
            } else {
                mtime * 1000
            };

            SessionFileFingerprint {
                created_at,
                updated_at: (mtime * 1000).max(created_at),
                size,
            }
        }
        Err(err) => {
            warn!(
                "[wsl] stat 执行失败: distro={distro} path={linux_path} error={}",
                err.trim()
            );
            SessionFileFingerprint::default()
        }
    }
}

/// Claude: 从 Linux 路径提取 project_key（projects 目录下的第一级子目录名）。
fn claude_project_key_from_wsl_linux_path(linux_path: &str) -> String {
    let normalized = linux_path.trim_end_matches('/').replace('\\', "/");
    // 路径格式: /home/user/.claude/projects/<project_key>/<session>.jsonl
    // 找 "projects/" 之后的第一段
    if let Some(after_projects) = normalized.split("/projects/").nth(1) {
        if let Some(key) = after_projects.split('/').next() {
            if !key.is_empty() {
                return key.to_string();
            }
        }
    }
    // 回退：取父目录名
    std::path::Path::new(&normalized)
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "default".to_string())
}

/// Codex: 从 Linux 路径提取 project_key（sessions 目录下的相对路径）。
fn codex_project_key_from_wsl_linux_path(linux_path: &str, linux_root: &str) -> String {
    let normalized = linux_path.trim_end_matches('/').replace('\\', "/");
    let root_normalized = linux_root.trim_end_matches('/').replace('\\', "/");
    // sessions/<project_key>/ 或 sessions/<project_key>/<sub>/rollout-xxx.jsonl
    if let Some(tail) = normalized.strip_prefix(&format!("{root_normalized}/",)) {
        if let Some(rel) = tail.split('/').next() {
            if !rel.is_empty() {
                return rel.to_string();
            }
        }
    }
    "sessions".to_string()
}

fn collect_wsl_claude_session_files(linux_projects_dir: &str, distro: &str) -> Vec<SessionFileRef> {
    info!("[wsl] 开始扫描 Claude 会话: distro={distro} projects_dir={linux_projects_dir}");
    let results = wsl_find_session_files(linux_projects_dir, distro, "*.jsonl", &|linux_path| {
        claude_project_key_from_wsl_linux_path(linux_path)
    });

    let files: Vec<_> = results
        .into_iter()
        .map(|hit| {
            let linux_path = hit.linux_path;
            let unc = crate::wsl::linux_to_unc_wsl_path(&linux_path, distro);
            remember_wsl_session_fingerprint(&unc, hit.fingerprint);
            debug!(
                "[wsl] Claude session: project_key={} path={unc}",
                hit.project_key
            );
            SessionFileRef {
                source: "claude".to_string(),
                project_key: hit.project_key,
                path: PathBuf::from(unc),
            }
        })
        .collect();
    info!(
        "[wsl] Claude 会话扫描完成: distro={distro} total_files={}",
        files.len()
    );
    files
}

fn collect_wsl_codex_session_files(linux_sessions_dir: &str, distro: &str) -> Vec<SessionFileRef> {
    info!("[wsl] 开始扫描 Codex 会话: distro={distro} sessions_dir={linux_sessions_dir}");
    let results = wsl_find_session_files(
        linux_sessions_dir,
        distro,
        "rollout-*.jsonl",
        &|linux_path| codex_project_key_from_wsl_linux_path(linux_path, linux_sessions_dir),
    );

    let files: Vec<_> = results
        .into_iter()
        .map(|hit| {
            let linux_path = hit.linux_path;
            let unc = crate::wsl::linux_to_unc_wsl_path(&linux_path, distro);
            remember_wsl_session_fingerprint(&unc, hit.fingerprint);
            debug!(
                "[wsl] Codex session: project_key={} path={unc}",
                hit.project_key
            );
            SessionFileRef {
                source: "codex".to_string(),
                project_key: hit.project_key,
                path: PathBuf::from(unc),
            }
        })
        .collect();
    info!(
        "[wsl] Codex 会话扫描完成: distro={distro} total_files={}",
        files.len()
    );
    files
}

fn collect_claude_session_files(root: &Path) -> Vec<SessionFileRef> {
    let root_str = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        info!("[wsl] 检测到 WSL UNC 路径, 切换 wsl.exe 扫描: root={root_str}");
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&root_str) {
            info!("[wsl] 解析成功: distro={distro} linux_path={linux_path}");
            return collect_wsl_claude_session_files(&linux_path, &distro);
        }
        warn!("[wsl] 路径检测为 WSL 但解析失败: {root_str}, 回退到原生 fs API");
    }

    if !root.exists() {
        return Vec::new();
    }

    let mut results = Vec::new();
    for entry in read_dir_entries(&root) {
        let path = entry.path();
        if path.is_dir() {
            let project_key = entry.file_name().to_string_lossy().to_string();
            let mut files = Vec::new();
            collect_files_recursive(&path, &mut files, &|file_path| is_jsonl(file_path));
            for file_path in files {
                results.push(SessionFileRef {
                    source: "claude".to_string(),
                    project_key: project_key.clone(),
                    path: file_path,
                });
            }
        } else if is_jsonl(&path) {
            results.push(SessionFileRef {
                source: "claude".to_string(),
                project_key: "default".to_string(),
                path,
            });
        }
    }

    results
}

fn collect_codex_session_files(root: &Path) -> Vec<SessionFileRef> {
    let root_str = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        info!("[wsl] 检测到 WSL UNC 路径, 切换 wsl.exe 扫描: root={root_str}");
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&root_str) {
            info!("[wsl] 解析成功: distro={distro} linux_path={linux_path}");
            return collect_wsl_codex_session_files(&linux_path, &distro);
        }
        warn!("[wsl] 路径检测为 WSL 但解析失败: {root_str}, 回退到原生 fs API");
    }

    if !root.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_files_recursive(&root, &mut files, &|file_path| {
        if !is_jsonl(file_path) {
            return false;
        }
        let name = file_path
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_default();
        name.starts_with("rollout-")
    });

    files
        .into_iter()
        .map(|path| {
            let project_key = codex_project_key_from_session(&path, root);
            SessionFileRef {
                source: "codex".to_string(),
                project_key,
                path,
            }
        })
        .collect()
}

fn codex_project_key_from_session(path: &Path, root: &Path) -> String {
    get_or_scan_session_project(path)
        .cwd
        .as_deref()
        .and_then(project_key_from_cwd)
        .unwrap_or_else(|| codex_project_key_from_path(path, root))
}

fn project_key_from_cwd(cwd: &str) -> Option<String> {
    let normalized = cwd.trim().replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    trimmed
        .rsplit('/')
        .find(|segment| {
            let segment = segment.trim();
            !segment.is_empty() && segment != "." && segment != ".." && !segment.ends_with(':')
        })
        .map(|segment| segment.trim().to_string())
}

fn codex_project_key_from_path(path: &Path, root: &Path) -> String {
    path.parent()
        .and_then(|parent| parent.strip_prefix(root).ok())
        .map(path_to_key)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "sessions".to_string())
}

fn collect_files_recursive(
    dir: &Path,
    output: &mut Vec<PathBuf>,
    predicate: &dyn Fn(&Path) -> bool,
) {
    for entry in read_dir_entries(dir) {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, output, predicate);
        } else if predicate(&path) {
            output.push(path);
        }
    }
}

fn read_dir_entries(dir: &Path) -> Vec<fs::DirEntry> {
    match fs::read_dir(dir) {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(e) => {
            warn!(
                "[wsl] fs::read_dir 失败: dir={} error={e} — 若路径为 WSL UNC 可能因 Plan 9 协议限制",
                dir.to_string_lossy()
            );
            Vec::new()
        }
    }
}

fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .map(|v| v.to_string_lossy().eq_ignore_ascii_case("jsonl"))
        .unwrap_or(false)
}

fn detect_home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("HOME")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
            })
    }
    #[cfg(not(target_os = "windows"))]
    {
        env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("USERPROFILE")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
            })
    }
}

fn path_to_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_history_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let normalized = normalized.trim_end_matches('/').to_string();
    if cfg!(target_os = "windows") {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn claude_project_key_from_path(path: &str) -> String {
    path.trim()
        .replace(':', "-")
        .replace(['\\', '/'], "-")
        .trim_end_matches('-')
        .to_lowercase()
}

fn session_matches_project_path(file_ref: &SessionFileRef, target_project_path: &str) -> bool {
    // 目标项目路径可能是 Windows 形式（D:\..），而 claude 在 WSL 内按 Linux cwd
    // (/mnt/d/..) 编码会话目录，故同时尝试 Windows 与 WSL 两种形式——二者指向同一物理
    // 目录，任一命中即视为同项目。target_project_path 已被 normalize_history_path 归一化。
    let wsl_target = crate::wsl::windows_path_to_wsl(target_project_path);
    // WSL UNC 路径（\\wsl.localhost\...）也需要转成 Linux 形式做 project_key 匹配。
    let wsl_unc_linux_target =
        crate::wsl::parse_wsl_unc_path(target_project_path).map(|(_distro, linux_path)| linux_path);

    if let Some(ref linux_path) = wsl_unc_linux_target {
        debug!(
            "[wsl] 项目路径匹配: target={target_project_path} wsl_linux={linux_path} source={} key={}",
            file_ref.source,
            file_ref.project_key
        );
    }

    if file_ref.source == "claude" {
        let key = file_ref.project_key.to_lowercase();
        if key == claude_project_key_from_path(target_project_path) {
            debug!(
                "session_matches_project_path matched claude key: target={} source={} project_key={} file={}",
                target_project_path,
                file_ref.source,
                file_ref.project_key,
                file_ref.path.to_string_lossy()
            );
            return true;
        }
        if let Some(wsl_target) = wsl_target.as_deref() {
            if key == claude_project_key_from_path(wsl_target) {
                debug!(
                    "session_matches_project_path matched claude wsl target: target={} wsl_target={} source={} project_key={} file={}",
                    target_project_path,
                    wsl_target,
                    file_ref.source,
                    file_ref.project_key,
                    file_ref.path.to_string_lossy()
                );
                return true;
            }
        }
        if let Some(ref linux_target) = wsl_unc_linux_target {
            if key == claude_project_key_from_path(linux_target) {
                debug!(
                    "session_matches_project_path matched claude unc target: target={} linux_target={} source={} project_key={} file={}",
                    target_project_path,
                    linux_target,
                    file_ref.source,
                    file_ref.project_key,
                    file_ref.path.to_string_lossy()
                );
                return true;
            }
        }
    }

    let scan = get_or_scan_session_project(&file_ref.path);
    let normalized_cwd = scan.cwd.as_deref().map(normalize_history_path);
    let matched = normalized_cwd
        .as_deref()
        .map(|cwd| {
            cwd_matches_target(&cwd, target_project_path)
                || wsl_target
                    .as_deref()
                    .is_some_and(|target| cwd_matches_target(&cwd, target))
                || wsl_unc_linux_target
                    .as_deref()
                    .is_some_and(|target| cwd_matches_target(&cwd, target))
        })
        .unwrap_or(false);
    debug!(
        "session_matches_project_path result: target={} wsl_target={:?} unc_linux_target={:?} source={} project_key={} cwd={:?} file={} matched={}",
        target_project_path,
        wsl_target,
        wsl_unc_linux_target,
        file_ref.source,
        file_ref.project_key,
        normalized_cwd,
        file_ref.path.to_string_lossy(),
        matched
    );
    matched
}

fn cwd_matches_target(cwd: &str, target: &str) -> bool {
    cwd == target || cwd.starts_with(&format!("{target}/"))
}

fn get_or_scan_session_project(path: &Path) -> SessionProjectScan {
    let fingerprint = session_file_fingerprint(path);
    let key = path_to_key(path);

    if let Ok(cache) = get_project_cache().lock() {
        if let Some(existing) = cache.entries.get(&key) {
            if can_reuse_session_scan(existing.fingerprint, fingerprint) {
                return existing.scan.clone();
            }
        }
    }

    let scan = scan_session_project(path);
    if let Ok(mut cache) = get_project_cache().lock() {
        cache.entries.insert(
            key,
            CachedSessionProjectCacheEntry {
                fingerprint,
                scan: scan.clone(),
            },
        );
    }
    scan
}

fn scan_session_project(path: &Path) -> SessionProjectScan {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return SessionProjectScan::default(),
    };

    for line in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
    {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("cwd") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(cwd) = extract_cwd(&value) {
            debug!(
                "scan_session_project extracted cwd: path={} cwd={}",
                path.to_string_lossy(),
                cwd
            );
            return SessionProjectScan { cwd: Some(cwd) };
        }
    }

    debug!(
        "scan_session_project no cwd found: path={}",
        path.to_string_lossy()
    );
    SessionProjectScan::default()
}

fn extract_cwd(value: &Value) -> Option<String> {
    let candidates = [
        value.get("cwd"),
        value.get("current_dir"),
        value.get("currentDir"),
        value.get("workdir"),
        value.get("working_dir"),
        value.get("workingDirectory"),
    ];
    for candidate in candidates.into_iter().flatten() {
        let Some(path) = candidate.as_str().map(str::trim).filter(|v| !v.is_empty()) else {
            continue;
        };
        return Some(path.to_string());
    }

    for key in ["payload", "metadata", "environment_context"] {
        if let Some(cwd) = value.get(key).and_then(extract_cwd) {
            return Some(cwd);
        }
    }

    None
}

fn is_codex_rollout_session_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

fn extract_session_meta_id(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    value
        .get("payload")
        .and_then(|payload| payload.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// 单遍扫描会话文件，产出 summary 与 stats；`collect_messages` 为 true 时同时收集完整消息列表
/// （供 detail 复用同一次 IO/解析，避免二次读取）。消息的 model 回填与重复 usage 行清空语义
/// 与 `iter_session_messages` 保持一致。
fn scan_session_inner(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            return (
                SessionSummaryScan {
                    session_id: None,
                    message_count: 0,
                    first_user_message: None,
                    first_message: None,
                    branch: None,
                },
                SessionStatsScan::default(),
                Vec::new(),
            );
        }
    };

    let mut session_id: Option<String> = None;
    let mut message_count = 0usize;
    let mut first_user_message: Option<String> = None;
    let mut first_message: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cache_read_tokens = 0u64;
    let mut cache_creation_tokens = 0u64;
    let mut total_cost_usd = 0.0f64;
    let mut unpriced_tokens = 0u64;
    let mut model_hits: HashMap<String, usize> = HashMap::new();
    let mut model_usage: HashMap<String, UsageStatsScan> = HashMap::new();
    // Claude Code 流式写入会把同一条 assistant 消息写成多行（相同 message.id + requestId），
    // 每行携带相同 usage；不去重会导致 token 统计虚高数倍。
    let mut seen_usage_keys: HashSet<String> = HashSet::new();
    // usage 行（如 Codex token_count 事件）可能不带 model，回退到最近一次出现的模型。
    let mut current_model: Option<String> = None;
    // Codex total_token_usage 是会话累计值，需相邻差分还原每回合用量。
    let mut codex_prev_totals: Option<CodexCumulativeUsage> = None;
    let mut context_window: Option<u64> = None;
    let mut last_context_tokens: Option<u64> = None;
    let mut reasoning_effort: Option<String> = None;
    let mut token_trend: Vec<HistoryTokenTrendPoint> = Vec::new();
    let mut usage_events: Vec<SessionUsageEventScan> = Vec::new();
    let mut tool_call_count = 0u64;
    let mut mcp_calls: HashMap<String, u64> = HashMap::new();
    let mut skill_calls: HashMap<String, u64> = HashMap::new();
    let mut builtin_calls: HashMap<String, u64> = HashMap::new();
    // tool_use 块按块 id 去重：流式重复行携带相同块，避免重复计数。
    let mut seen_tool_call_ids: HashSet<String> = HashSet::new();
    // collect_messages 时收集的消息列表；其去重用独立的 msg_seen_usage_keys，
    // 与 stats 的 seen_usage_keys 分开，避免消息侧先插入 key 污染 stats 的去重判断。
    let mut messages: Vec<HistoryMessage> = Vec::new();
    let mut msg_seen_usage_keys: HashSet<String> = HashSet::new();

    for (physical_line_index, line) in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        if branch.is_none() {
            branch = extract_branch(&value);
        }
        if session_id.is_none() {
            session_id = extract_session_meta_id(&value);
        }

        let line_reasoning_effort = extract_reasoning_effort(&value);
        // model 先于消息解析更新：既供 stats 归因，也供消息 model 回填（assistant 行常不带 model）。
        let line_model = extract_model(&value)
            .filter(|model| !is_synthetic_model(model))
            .map(|model| {
                qualify_model_with_reasoning_effort(model, line_reasoning_effort.as_deref())
            });
        if let Some(model) = &line_model {
            *model_hits.entry(model.clone()).or_insert(0) += 1;
            current_model = Some(model.clone());
        }
        if let Some(effort) = line_reasoning_effort {
            reasoning_effort = Some(effort);
        }
        if let Some(window) = extract_context_window(&value) {
            context_window = Some(window);
        }

        if let Some(mut msg) = parse_message(&value) {
            message_count += 1;
            let title_candidate = message_title_candidate(&msg);
            if first_message.is_none() {
                first_message = title_candidate
                    .clone()
                    .or_else(|| Some(msg.content.clone()));
            }
            if first_user_message.is_none() && msg.role == "user" {
                first_user_message = title_candidate;
            }
            if collect_messages {
                if msg.model.is_none() && msg.role == "assistant" {
                    msg.model = current_model.clone();
                }
                // 重复 usage 行（同 message.id|requestId）保留消息但清空 token，避免前端逐消息求和虚高。
                if let Some(key) = extract_usage_dedup_key(&value) {
                    if !msg_seen_usage_keys.insert(key) {
                        msg.input_tokens = None;
                        msg.output_tokens = None;
                        msg.cache_creation_tokens = None;
                        msg.cache_read_tokens = None;
                    }
                }
                msg.line_index = Some(physical_line_index);
                msg.editable_text = extract_editable_text(&value);
                msg.editable = msg.editable_text.is_some();
                // 规范文本与展示 content 一致时省略，避免 detail payload 体积翻倍。
                if msg.editable_text.as_deref() == Some(msg.content.as_str()) {
                    msg.editable_text = None;
                }
                messages.push(msg);
            }
        }

        collect_tool_calls(
            &value,
            &mut seen_tool_call_ids,
            &mut tool_call_count,
            &mut mcp_calls,
            &mut skill_calls,
            &mut builtin_calls,
        );
        if trimmed.contains("<command-name>") {
            if let Some(command) = extract_command_name(trimmed) {
                *skill_calls.entry(command).or_insert(0) += 1;
            }
        }

        let mut codex_message_usage = None;
        let codex_cumulative = extract_codex_token_count(&value);
        let usage = if let Some(current) = codex_cumulative {
            let (window, last_context) = extract_codex_context_info(&value);
            if window.is_some() {
                context_window = window;
            }
            if last_context.is_some() {
                last_context_tokens = last_context;
            }
            let usage = codex_usage_delta(codex_prev_totals, current);
            codex_prev_totals = Some(current);
            codex_message_usage = Some(usage);
            usage
        } else {
            let usage = extract_usage_tokens(&value);
            // Claude 行的 prompt 部分（input + 缓存读写）即该请求的上下文占用。
            let prompt_tokens = usage
                .input_tokens
                .saturating_add(usage.cache_read_tokens)
                .saturating_add(usage.cache_creation_tokens);
            if prompt_tokens > 0 {
                last_context_tokens = Some(prompt_tokens);
            }
            usage
        };
        if usage_total_tokens(usage) == 0 {
            continue;
        }
        if let Some(key) = extract_usage_dedup_key(&value) {
            if !seen_usage_keys.insert(key) {
                continue;
            }
        }
        if collect_messages {
            if let Some(message_usage) = codex_message_usage {
                backfill_latest_assistant_message_usage(
                    &mut messages,
                    message_usage,
                    extract_timestamp(&value),
                );
            }
        }
        let attributed_model = line_model.or_else(|| current_model.clone());
        token_trend.push(usage_trend_point(usage, attributed_model.clone()));

        input_tokens = input_tokens.saturating_add(usage.input_tokens);
        output_tokens = output_tokens.saturating_add(usage.output_tokens);
        cache_read_tokens = cache_read_tokens.saturating_add(usage.cache_read_tokens);
        cache_creation_tokens = cache_creation_tokens.saturating_add(usage.cache_creation_tokens);

        let cost = calculate_usage_cost(attributed_model.as_deref(), usage);
        total_cost_usd += cost.total_cost_usd;
        unpriced_tokens = unpriced_tokens.saturating_add(cost.unpriced_tokens);
        let event_index = usage_events.len();
        usage_events.push(SessionUsageEventScan {
            event_key: build_usage_event_key(
                &value,
                physical_line_index,
                event_index,
                usage,
                codex_cumulative,
            ),
            event_index,
            timestamp_ms: extract_timestamp_millis(&value),
            model: attributed_model.clone(),
            usage: cost,
        });

        if let Some(model) = attributed_model {
            let entry = model_usage.entry(model).or_default();
            entry.input_tokens = entry.input_tokens.saturating_add(usage.input_tokens);
            entry.output_tokens = entry.output_tokens.saturating_add(usage.output_tokens);
            entry.cache_read_tokens = entry
                .cache_read_tokens
                .saturating_add(usage.cache_read_tokens);
            entry.cache_creation_tokens = entry
                .cache_creation_tokens
                .saturating_add(usage.cache_creation_tokens);
            entry.total_cost_usd += cost.total_cost_usd;
            entry.unpriced_tokens = entry.unpriced_tokens.saturating_add(cost.unpriced_tokens);
        }
    }

    let dominant_model = model_hits
        .into_iter()
        .max_by(|(left_model, left_hits), (right_model, right_hits)| {
            left_hits
                .cmp(right_hits)
                .then_with(|| right_model.cmp(left_model))
        })
        .map(|(model, _)| model);

    (
        SessionSummaryScan {
            session_id,
            message_count,
            first_user_message,
            first_message,
            branch,
        },
        SessionStatsScan {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            total_cost_usd,
            unpriced_tokens,
            dominant_model,
            current_model,
            model_usage,
            context_window,
            last_context_tokens,
            reasoning_effort,
            token_trend,
            usage_events,
            tool_call_count,
            mcp_calls,
            skill_calls,
            builtin_calls,
        },
        messages,
    )
}

/// 仅需 summary + stats 的调用方（list / stats 聚合）使用，不收集消息体。
fn scan_session_combined(path: &Path) -> (SessionSummaryScan, SessionStatsScan) {
    let (summary, stats, _) = scan_session_inner(path, false);
    (summary, stats)
}

/// detail 路径使用：单遍同时取得 summary、stats 与完整消息列表，避免二次读取与解析。
fn scan_session_detail(path: &Path) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    scan_session_inner(path, true)
}

fn scan_tool_events(path: &Path) -> Vec<HistoryToolEvent> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    let mut message_index = 0usize;
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

        collect_tool_events_from_value(
            &value,
            current_message_index,
            &mut seen_call_ids,
            &mut events,
        );
    }
    events
}

fn scan_file_changes(path: &Path) -> Vec<HistoryFileChangeSummary> {
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

fn collect_file_changes_from_value(
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

fn extract_file_changes_from_arguments(
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

fn extract_file_changes_from_input_value(
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

fn build_text_file_change_operation(
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

fn build_patch_file_change_operations(
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

fn summarize_file_change_operations(
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

fn is_newer_file_change(
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

fn derive_file_change_status(operation: &HistoryFileChangeOperation) -> String {
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

fn extract_file_path_from_value(value: &Value) -> Option<String> {
    extract_string_field(
        value,
        &["file_path", "filePath", "path", "target_file", "targetFile"],
    )
    .map(|path| path.trim().to_string())
    .filter(|path| !path.is_empty())
}

fn extract_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    keys.iter()
        .find_map(|key| object.get(*key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn count_patch_changes(patch: &str) -> (u64, u64) {
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

fn count_text_changes(old_text: Option<&str>, new_text: Option<&str>) -> (u64, u64) {
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

fn count_text_lines(text: &str) -> u64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as u64
    }
}

fn split_patch_blocks(content: &str) -> Vec<String> {
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

fn decode_embedded_apply_patch(content: &str) -> Option<String> {
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

fn split_apply_patch_blocks(content: &str) -> Vec<String> {
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

fn split_unified_diff_blocks(content: &str) -> Vec<String> {
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

fn extract_patch_file_path(patch: &str) -> String {
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

/// Stream parsed messages from a session file. Callback returns `false` to break early.
/// 同一条消息的多个流式行携带相同 usage，去重后仅首行保留 token 字段，避免前端求和虚高。
fn iter_session_messages<F>(path: &Path, mut callback: F) -> Result<(), String>
where
    F: FnMut(usize, HistoryMessage) -> bool,
{
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut index = 0usize;
    let mut seen_usage_keys: HashSet<String> = HashSet::new();
    // Codex 的 model 在 turn_context 行而非消息行，跟踪最近出现的模型用于回退（同 stats 扫描的 A3 口径）。
    let mut current_model: Option<String> = None;
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
        if let Some(model) = extract_model(&value).filter(|model| !is_synthetic_model(model)) {
            current_model = Some(model);
        }
        if let Some(mut msg) = parse_message(&value) {
            if msg.model.is_none() && msg.role == "assistant" {
                msg.model = current_model.clone();
            }
            if let Some(key) = extract_usage_dedup_key(&value) {
                if !seen_usage_keys.insert(key) {
                    msg.input_tokens = None;
                    msg.output_tokens = None;
                    msg.cache_creation_tokens = None;
                    msg.cache_read_tokens = None;
                }
            }
            if !callback(index, msg) {
                return Ok(());
            }
            index += 1;
        }
    }
    Ok(())
}

fn extract_usage_tokens(value: &Value) -> UsageTokenScan {
    let candidates = [
        Some(value),
        value.get("usage"),
        value.get("token_usage"),
        value.get("payload").and_then(|v| v.get("usage")),
        value.get("message").and_then(|v| v.get("usage")),
        value.get("response").and_then(|v| v.get("usage")),
    ];

    // token 数与显式成本可能分布在不同层级（如顶层 costUSD + message.usage），
    // 取首个带 token 的候选，同时保留任意候选上的显式成本，避免互相覆盖丢数据。
    let mut explicit_cost_usd: Option<f64> = None;
    for candidate in candidates.into_iter().flatten() {
        let mut usage = extract_usage_tokens_from_value(candidate);
        if explicit_cost_usd.is_none() {
            explicit_cost_usd = usage.explicit_cost_usd;
        }
        if usage_total_tokens(usage) > 0 {
            usage.explicit_cost_usd = usage.explicit_cost_usd.or(explicit_cost_usd);
            return usage;
        }
    }
    UsageTokenScan {
        explicit_cost_usd,
        ..UsageTokenScan::default()
    }
}

/// Codex rollout 的 `token_count` 事件：`payload.info.total_token_usage` 为会话累计值。
#[derive(Clone, Copy, Default)]
struct CodexCumulativeUsage {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
}

fn extract_codex_token_count(value: &Value) -> Option<CodexCumulativeUsage> {
    let payload = value.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let totals = payload.get("info")?.get("total_token_usage")?.as_object()?;
    Some(CodexCumulativeUsage {
        input_tokens: extract_u64_by_keys(totals, &["input_tokens"]).unwrap_or(0),
        cached_input_tokens: extract_u64_by_keys(totals, &["cached_input_tokens"]).unwrap_or(0),
        output_tokens: extract_u64_by_keys(totals, &["output_tokens"]).unwrap_or(0),
        total_tokens: extract_u64_by_keys(totals, &["total_tokens"]).unwrap_or(0),
    })
}

/// Codex token_count 事件附带的上下文信息：模型窗口大小与最近一次请求的上下文占用。
fn extract_codex_context_info(value: &Value) -> (Option<u64>, Option<u64>) {
    let Some(info) = value.get("payload").and_then(|payload| payload.get("info")) else {
        return (None, None);
    };
    let window = extract_context_window_from_value(info);
    let last_context = info
        .get("last_token_usage")
        .and_then(Value::as_object)
        .map(|last| {
            let total = extract_u64_by_keys(last, &["total_tokens"]).unwrap_or(0);
            if total > 0 {
                total
            } else {
                extract_u64_by_keys(last, &["input_tokens"])
                    .unwrap_or(0)
                    .saturating_add(extract_u64_by_keys(last, &["output_tokens"]).unwrap_or(0))
            }
        })
        .filter(|tokens| *tokens > 0);
    (window, last_context)
}

fn extract_context_window(value: &Value) -> Option<u64> {
    let candidates = [
        Some(value),
        value.get("usage"),
        value.get("message"),
        value.get("message").and_then(|v| v.get("usage")),
        value.get("payload"),
        value.get("payload").and_then(|v| v.get("info")),
        value.get("payload").and_then(|v| v.get("usage")),
        value.get("response"),
        value.get("response").and_then(|v| v.get("usage")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(extract_context_window_from_value)
}

fn extract_context_window_from_value(value: &Value) -> Option<u64> {
    let map = value.as_object()?;
    extract_u64_by_keys(
        map,
        &[
            "context_window",
            "contextWindow",
            "max_input_tokens",
            "maxInputTokens",
            "max_context_tokens",
            "maxContextTokens",
            "model_context_window",
            "modelContextWindow",
        ],
    )
    .filter(|window| *window > 0)
}

/// 统计工具调用：Claude content 块的 tool_use（按块 id 去重，流式重复行只计一次）、
/// Codex 的 function_call / custom_tool_call / mcp_tool_call 事件（按 call_id 去重）。
/// MCP 按 server 聚合：Claude 工具名形如 mcp__<server>__<tool>，Codex 可在 namespace
/// 或 invocation.server 里携带 server；Skill 工具取 input.skill。
fn collect_tool_calls(
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

fn collect_tool_events_from_value(
    value: &Value,
    message_index: Option<usize>,
    seen_call_ids: &mut HashSet<String>,
    events: &mut Vec<HistoryToolEvent>,
) {
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
                None,
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
            let mcp_server = payload
                .get("namespace")
                .and_then(Value::as_str)
                .and_then(extract_mcp_server);
            events.push(make_tool_event(
                call_id,
                name,
                message_index,
                extract_timestamp(value),
                Some("started"),
                None,
                payload.get("arguments").and_then(summarize_json_value),
                None,
                mcp_server,
            ));
            return;
        }

        if payload_type == Some("function_call_output") {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let output_summary = payload.get("output").and_then(summarize_json_value);
            update_tool_event_output(events, call_id.as_deref(), output_summary, None);
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
                Some("completed")
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

fn mark_tool_event_seen(call_id: Option<&str>, seen_call_ids: &mut HashSet<String>) -> bool {
    let Some(id) = call_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return true;
    };
    seen_call_ids.insert(id.to_string())
}

fn make_tool_event(
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
    let category = if let Some(server) = mcp_server.or_else(|| extract_mcp_server(name)) {
        format!("mcp:{server}")
    } else if name == "Skill" {
        "skill".to_string()
    } else {
        "builtin".to_string()
    };
    HistoryToolEvent {
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

fn update_tool_event_output(
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

fn summarize_json_value(value: &Value) -> Option<String> {
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

fn extract_tool_duration_ms(value: &Value) -> Option<u64> {
    value
        .get("duration_ms")
        .or_else(|| value.get("durationMs"))
        .or_else(|| value.get("elapsed_ms"))
        .or_else(|| value.get("elapsedMs"))
        .and_then(extract_positive_u64)
}

fn extract_mcp_server(value: &str) -> Option<&str> {
    let rest = value.strip_prefix("mcp__")?;
    let server = rest.split("__").next().unwrap_or(rest).trim();
    (!server.is_empty()).then_some(server)
}

/// 提取斜杠命令标记 `<command-name>/foo</command-name>` 中的命令名（去掉前导 "/"）。
fn extract_command_name(line: &str) -> Option<String> {
    let start = line.find("<command-name>")? + "<command-name>".len();
    let end = line[start..].find("</command-name>")? + start;
    let name = line[start..end].trim().trim_start_matches('/').trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn sorted_tool_counts(map: &HashMap<String, u64>) -> Vec<HistoryToolCount> {
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

/// 相邻差分还原单回合用量；累计值变小视为会话重置，直接取当前值。
/// Codex 的 `input_tokens` 包含 `cached_input_tokens`，此处归一化为
/// 非缓存 input + cache_read，与 Claude 口径一致。
fn codex_usage_delta(
    previous: Option<CodexCumulativeUsage>,
    current: CodexCumulativeUsage,
) -> UsageTokenScan {
    let previous = previous.unwrap_or_default();
    let delta = if current.total_tokens < previous.total_tokens {
        current
    } else {
        CodexCumulativeUsage {
            input_tokens: current.input_tokens.saturating_sub(previous.input_tokens),
            cached_input_tokens: current
                .cached_input_tokens
                .saturating_sub(previous.cached_input_tokens),
            output_tokens: current.output_tokens.saturating_sub(previous.output_tokens),
            total_tokens: current.total_tokens.saturating_sub(previous.total_tokens),
        }
    };
    UsageTokenScan {
        input_tokens: delta.input_tokens.saturating_sub(delta.cached_input_tokens),
        output_tokens: delta.output_tokens,
        cache_read_tokens: delta.cached_input_tokens,
        cache_creation_tokens: 0,
        explicit_cost_usd: None,
    }
}

/// C2: 提取 usage 去重键（message.id | requestId）
///
/// 边界情况：无 message.id 的带 usage 行不去重。
/// Claude Code / Codex 正常都有 message.id，属边界情况，保持现状。
fn extract_usage_dedup_key(value: &Value) -> Option<String> {
    let message_id = value
        .get("message")
        .and_then(|m| m.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    let request_id = value
        .get("requestId")
        .or_else(|| value.get("request_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Some(format!("{message_id}|{request_id}"))
}

fn build_usage_event_key(
    value: &Value,
    physical_line_index: usize,
    event_index: usize,
    usage: UsageTokenScan,
    codex_cumulative: Option<CodexCumulativeUsage>,
) -> String {
    if let Some(key) = extract_usage_dedup_key(value) {
        return format!("message:{key}");
    }

    if let Some(total) = codex_cumulative {
        let timestamp = extract_timestamp_millis(value)
            .map(|value| value.to_string())
            .unwrap_or_else(|| format!("index-{event_index}"));
        return format!(
            "codex:{timestamp}:{}:{}:{}:{}",
            total.input_tokens, total.cached_input_tokens, total.output_tokens, total.total_tokens
        );
    }

    format!(
        "line:{physical_line_index}:{}:{}:{}:{}",
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens
    )
}

fn is_synthetic_model(model: &str) -> bool {
    model.trim().eq_ignore_ascii_case("<synthetic>")
}

fn extract_usage_tokens_from_value(value: &Value) -> UsageTokenScan {
    let Value::Object(map) = value else {
        return UsageTokenScan::default();
    };

    let mut input = extract_u64_by_keys(
        map,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
            "input_token_count",
            "inputTokenCount",
        ],
    )
    .unwrap_or(0);
    let output = extract_u64_by_keys(
        map,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
            "output_token_count",
            "outputTokenCount",
        ],
    )
    .unwrap_or(0);
    let cache_read = extract_u64_by_keys(
        map,
        &[
            "cache_read_tokens",
            "cacheReadTokens",
            "cache_read_input_tokens",
            "cacheReadInputTokens",
        ],
    )
    .unwrap_or(0);
    // OpenAI 风格的 cached_tokens 包含在 prompt/input 内（与 Anthropic 的
    // cache_read_input_tokens 不同），归一化时需从 input 中扣除，避免双计。
    let openai_cached = extract_u64_by_keys(map, &["cached_tokens", "cachedTokens"])
        .or_else(|| {
            map.get("input_tokens_details")
                .or_else(|| map.get("inputTokensDetails"))
                .and_then(Value::as_object)
                .and_then(|details| {
                    extract_u64_by_keys(details, &["cached_tokens", "cachedTokens"])
                })
        })
        .unwrap_or(0);
    let cache_read = if cache_read == 0 && openai_cached > 0 {
        input = input.saturating_sub(openai_cached);
        openai_cached
    } else {
        cache_read
    };
    let cache_creation = extract_u64_by_keys(
        map,
        &[
            "cache_creation_tokens",
            "cacheCreationTokens",
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
        ],
    )
    .unwrap_or(0);
    let explicit_cost_usd = extract_f64_by_keys(
        map,
        &[
            "total_cost_usd",
            "totalCostUsd",
            "totalCostUSD",
            "cost_usd",
            "costUsd",
            "costUSD",
            "total_cost",
            "totalCost",
            "cost",
        ],
    );

    if input == 0 && output == 0 && cache_read == 0 && cache_creation == 0 {
        if let Some(total) =
            extract_u64_by_keys(map, &["total_tokens", "totalTokens", "token_count"])
        {
            input = total;
        }
    }

    UsageTokenScan {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_creation,
        explicit_cost_usd,
    }
}

fn extract_u64_by_keys(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .filter_map(|key| map.get(*key))
        .find_map(extract_positive_u64)
}

fn extract_f64_by_keys(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .filter_map(|key| map.get(*key))
        .find_map(extract_non_negative_f64)
}

fn extract_non_negative_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(v) => v.as_f64().filter(|n| n.is_finite() && *n >= 0.0),
        Value::String(v) => v
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n >= 0.0),
        _ => None,
    }
}

fn usage_total_tokens(usage: UsageTokenScan) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.output_tokens)
        .saturating_add(usage.cache_read_tokens)
        .saturating_add(usage.cache_creation_tokens)
}

fn message_has_token_usage(message: &HistoryMessage) -> bool {
    message.input_tokens.unwrap_or(0) > 0
        || message.output_tokens.unwrap_or(0) > 0
        || message.cache_read_tokens.unwrap_or(0) > 0
        || message.cache_creation_tokens.unwrap_or(0) > 0
}

fn positive_usage_token(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

fn backfill_latest_assistant_message_usage(
    messages: &mut [HistoryMessage],
    usage: UsageTokenScan,
    timestamp: Option<String>,
) {
    if usage_total_tokens(usage) == 0 {
        return;
    }
    let Some(message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.role == "assistant" && !message_has_token_usage(message))
    else {
        return;
    };

    if message.timestamp.is_none() {
        message.timestamp = timestamp;
    }
    message.input_tokens = positive_usage_token(usage.input_tokens);
    message.output_tokens = positive_usage_token(usage.output_tokens);
    message.cache_read_tokens = positive_usage_token(usage.cache_read_tokens);
    message.cache_creation_tokens = positive_usage_token(usage.cache_creation_tokens);
}

fn usage_stats_total_tokens(usage: UsageStatsScan) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.output_tokens)
        .saturating_add(usage.cache_read_tokens)
        .saturating_add(usage.cache_creation_tokens)
}

fn usage_trend_point(usage: UsageTokenScan, model: Option<String>) -> HistoryTokenTrendPoint {
    HistoryTokenTrendPoint {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_creation_tokens: usage.cache_creation_tokens,
        total_tokens: usage_total_tokens(usage),
        model,
    }
}

fn history_stats_total_tokens(item: &HistoryStatsModelItem) -> u64 {
    item.input_tokens
        .saturating_add(item.output_tokens)
        .saturating_add(item.cache_read_tokens)
        .saturating_add(item.cache_creation_tokens)
}

fn calculate_usage_cost(model: Option<&str>, usage: UsageTokenScan) -> UsageStatsScan {
    let total_tokens = usage_total_tokens(usage);
    if total_tokens == 0 {
        return UsageStatsScan::default();
    }

    let Some(pricing) = model.and_then(find_history_model_pricing) else {
        return UsageStatsScan {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            total_cost_usd: 0.0,
            unpriced_tokens: total_tokens,
        };
    };

    // 所有提取路径已归一化：input_tokens 不含缓存命中部分，无需再按来源扣减。
    let million = 1_000_000.0;
    let total_cost_usd = (usage.input_tokens as f64 * pricing.input_per_million
        + usage.output_tokens as f64 * pricing.output_per_million
        + usage.cache_read_tokens as f64 * pricing.cache_read_per_million
        + usage.cache_creation_tokens as f64 * pricing.cache_creation_per_million)
        / million;

    UsageStatsScan {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_creation_tokens: usage.cache_creation_tokens,
        total_cost_usd,
        unpriced_tokens: 0,
    }
}

#[derive(Clone)]
struct HistoryModelPricing {
    input_per_million: f64,
    output_per_million: f64,
    cache_read_per_million: f64,
    cache_creation_per_million: f64,
}

fn find_history_model_pricing(model: &str) -> Option<HistoryModelPricing> {
    match find_cached_model_pricing(model) {
        CachedModelPricingLookup::Found(cached) => {
            return Some(HistoryModelPricing {
                input_per_million: cached.input_per_million,
                output_per_million: cached.output_per_million,
                cache_read_per_million: cached.cache_read_per_million,
                cache_creation_per_million: cached.cache_creation_per_million,
            });
        }
        CachedModelPricingLookup::Missing | CachedModelPricingLookup::CacheUnavailable => None,
    }
}

fn extract_positive_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(u64::from(*v)),
        Value::Number(v) => {
            if let Some(n) = v.as_u64() {
                return Some(n);
            }
            if let Some(n) = v.as_i64() {
                return (n >= 0).then_some(n as u64);
            }
            v.as_f64()
                .and_then(|n| (n.is_finite() && n >= 0.0).then_some(n as u64))
        }
        Value::String(v) => v.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn extract_model(value: &Value) -> Option<String> {
    let direct_candidates = [
        value.get("model").and_then(Value::as_str),
        value.get("model_name").and_then(Value::as_str),
        value.get("modelName").and_then(Value::as_str),
        value.get("model_slug").and_then(Value::as_str),
    ];
    for model in direct_candidates.into_iter().flatten() {
        let normalized = model.trim();
        if !normalized.is_empty() {
            return Some(normalized.to_string());
        }
    }

    let nested_candidates = [
        value.get("payload"),
        value.get("message"),
        value.get("response"),
        value.get("metadata"),
    ];
    for candidate in nested_candidates.into_iter().flatten() {
        let Some(model) = extract_model(candidate) else {
            continue;
        };
        if !model.trim().is_empty() {
            return Some(model);
        }
    }

    None
}

fn extract_reasoning_effort(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("turn_context") {
        return None;
    }
    let payload = value.get("payload")?;
    let candidates = [
        payload.get("effort").and_then(Value::as_str),
        payload.get("reasoning_effort").and_then(Value::as_str),
        payload
            .get("collaboration_mode")
            .and_then(|v| v.get("settings"))
            .and_then(|v| v.get("reasoning_effort"))
            .and_then(Value::as_str),
    ];
    candidates.into_iter().flatten().find_map(|effort| {
        let normalized = effort.trim();
        if normalized.is_empty() {
            return None;
        }
        normalize_reasoning_effort_label(normalized)
            .map(str::to_string)
            .or_else(|| Some(normalized.to_ascii_lowercase()))
    })
}

fn qualify_model_with_reasoning_effort(model: String, effort: Option<&str>) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return model;
    }
    let (base_model, embedded_effort) = split_model_reasoning_effort(trimmed);
    if let Some(effort) = embedded_effort {
        return if supports_reasoning_effort_model_variant(base_model) {
            format!("{base_model}({effort})")
        } else {
            base_model.to_string()
        };
    }
    if trimmed.contains('(') {
        return trimmed.to_string();
    }
    let Some(effort) = effort.and_then(normalize_reasoning_effort_label) else {
        return base_model.to_string();
    };
    if !supports_reasoning_effort_model_variant(base_model) {
        return base_model.to_string();
    }
    format!("{base_model}({effort})")
}

fn split_model_reasoning_effort(model: &str) -> (&str, Option<&'static str>) {
    let trimmed = model.trim();
    if let Some(open) = trimmed.rfind('(') {
        if trimmed.ends_with(')') {
            let base = trimmed[..open].trim_end();
            let inner = &trimmed[open + 1..trimmed.len() - 1];
            if let Some(effort) = normalize_reasoning_effort_label(inner) {
                if !base.is_empty() {
                    return (base, Some(effort));
                }
            }
        }
        return (trimmed, None);
    }
    if let Some((base, suffix)) = trimmed.rsplit_once('-') {
        if let Some(effort) = normalize_reasoning_effort_label(suffix) {
            let base = base.trim_end();
            if !base.is_empty() {
                return (base, Some(effort));
            }
        }
    }
    (trimmed, None)
}

fn supports_reasoning_effort_model_variant(model: &str) -> bool {
    let Some(version) = model.trim().strip_prefix("gpt-") else {
        return false;
    };
    let mut parts = version.split('.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && !major.is_empty()
        && major.chars().all(|ch| ch.is_ascii_digit())
        && !minor.is_empty()
        && minor.chars().all(|ch| ch.is_ascii_digit())
}

fn normalize_reasoning_effort_label(value: &str) -> Option<&'static str> {
    let key: String = value
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    match key.as_str() {
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        _ => None,
    }
}

fn now_millis() -> i64 {
    system_time_to_millis(SystemTime::now())
}

fn day_start_utc(ts: i64) -> i64 {
    if ts <= 0 {
        return 0;
    }
    ts - (ts % DAY_MS)
}

fn hour_of_day_utc(ts: i64) -> usize {
    if ts <= 0 {
        return 0;
    }
    let normalized = ((ts % DAY_MS) + DAY_MS) % DAY_MS;
    (normalized / HOUR_MS) as usize
}

fn hour_of_day_for_stats(ts: i64, bounds: StatsTimeBounds) -> usize {
    if !bounds.explicit {
        return hour_of_day_utc(ts);
    }
    let normalized = (((ts - bounds.start_day) % DAY_MS) + DAY_MS) % DAY_MS;
    (normalized / HOUR_MS) as usize
}

fn calc_heat_level(value: usize, max_value: usize) -> u8 {
    if value == 0 || max_value == 0 {
        return 0;
    }
    let ratio = value as f64 / max_value as f64;
    if ratio < 0.25 {
        1
    } else if ratio < 0.5 {
        2
    } else if ratio < 0.75 {
        3
    } else {
        4
    }
}

/// content 块全部为 tool_result 时视为工具结果行。
fn is_tool_result_message(value: &Value) -> bool {
    let blocks = value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))
        .and_then(Value::as_array);
    match blocks {
        Some(blocks) if !blocks.is_empty() => blocks
            .iter()
            .all(|block| block.get("type").and_then(Value::as_str) == Some("tool_result")),
        _ => false,
    }
}

pub(crate) fn parse_message(value: &Value) -> Option<HistoryMessage> {
    if let Some(root_type) = value.get("type").and_then(Value::as_str) {
        if root_type == "response_item" {
            let payload = value.get("payload");
            let payload_type = payload
                .and_then(|v| v.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if payload_type == "message" {
                if let Some(payload_value) = payload {
                    let mut message = parse_message(payload_value)?;
                    if message.timestamp.is_none() {
                        message.timestamp = extract_timestamp(value);
                    }
                    return Some(message);
                }
                return None;
            }

            if matches!(
                payload_type,
                "custom_tool_call" | "tool_call" | "function_call"
            ) {
                if let Some(payload_value) = payload {
                    if let Some(message) = parse_message(payload_value) {
                        if looks_like_patch(&message.content) {
                            return Some(message);
                        }
                    }
                }
            }
            return None;
        } else if root_type == "file-history-snapshot" {
            let content = extract_content(value)?;
            if !looks_like_patch(&content) {
                return None;
            }
            return Some(HistoryMessage {
                role: "tool".to_string(),
                content,
                timestamp: extract_timestamp(value),
                model: None,
                input_tokens: None,
                output_tokens: None,
                cache_creation_tokens: None,
                cache_read_tokens: None,
                line_index: None,
                editable: false,
                editable_text: None,
            });
        } else if matches!(
            root_type,
            "event_msg" | "turn_context" | "session_meta" | "system" | "summary"
        ) {
            return None;
        }
    }

    if let Some(payload) = value.get("payload") {
        if let Some(message) = parse_message(payload) {
            let mut message = message;
            if message.timestamp.is_none() {
                message.timestamp = extract_timestamp(value);
            }
            return Some(message);
        }
    }

    let mut role = extract_role(value).unwrap_or_else(|| "assistant".to_string());
    // Claude 把工具结果写成 user 角色的行（content 全为 tool_result 块），归类为 tool，
    // 避免"用户"消息数被工具往返虚高。
    if role == "user" && is_tool_result_message(value) {
        role = "tool".to_string();
    }
    let content = extract_content(value)?;
    if content.trim().is_empty() {
        return None;
    }
    let timestamp = extract_timestamp(value);

    // Extract token usage from the message
    let usage = value
        .get("usage")
        .or_else(|| value.get("tokenCounts"))
        .or_else(|| value.get("message").and_then(|m| m.get("usage")));
    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(Value::as_u64)
        .or_else(|| {
            usage
                .and_then(|u| u.get("inputTokens"))
                .and_then(Value::as_u64)
        });
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(Value::as_u64)
        .or_else(|| {
            usage
                .and_then(|u| u.get("outputTokens"))
                .and_then(Value::as_u64)
        });
    let cache_creation_tokens = usage
        .and_then(|u| u.get("cache_creation_tokens"))
        .and_then(Value::as_u64)
        .or_else(|| {
            usage
                .and_then(|u| u.get("cacheCreationTokens"))
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            usage
                .and_then(|u| u.get("cache_creation_input_tokens"))
                .and_then(Value::as_u64)
        });
    let cache_read_tokens = usage
        .and_then(|u| u.get("cache_read_tokens"))
        .and_then(Value::as_u64)
        .or_else(|| {
            usage
                .and_then(|u| u.get("cacheReadTokens"))
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            usage
                .and_then(|u| u.get("cache_read_input_tokens"))
                .and_then(Value::as_u64)
        });

    Some(HistoryMessage {
        role,
        content,
        timestamp,
        model: extract_model(value).filter(|model| !is_synthetic_model(model)),
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        line_index: None,
        editable: false,
        editable_text: None,
    })
}

/// 提取"消息级编辑"允许替换的规范文本：
/// - Claude 根行（type=user/assistant）：message.content 为字符串时取整串；为块数组时取全部 `text` 块。
/// - Codex response_item 消息行：payload.content 中的 `input_text` / `output_text` 块。
/// 返回 None 表示该行没有可安全编辑的文本载体（tool_use / function_call / thinking / tool_result 等），
/// 前端据此禁用编辑与删除入口。与展示用 extract_content 的有损提取口径刻意分离。
pub(crate) fn extract_editable_text(value: &Value) -> Option<String> {
    let root_type = value.get("type").and_then(Value::as_str)?;
    if root_type == "user" || root_type == "assistant" {
        let content = value
            .get("message")
            .and_then(|message| message.get("content"))?;
        return editable_text_from_content(content, &["text"]);
    }
    if root_type == "response_item" {
        let payload = value.get("payload")?;
        if payload.get("type").and_then(Value::as_str) != Some("message") {
            return None;
        }
        return editable_text_from_content(payload.get("content")?, &["input_text", "output_text"]);
    }
    None
}

fn editable_text_from_content(content: &Value, text_block_types: &[&str]) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter_map(|block| {
                    let block_type = block.get("type").and_then(Value::as_str)?;
                    if text_block_types.contains(&block_type) {
                        block.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        _ => None,
    }
}

fn message_title_candidate(message: &HistoryMessage) -> Option<String> {
    title_candidate_from_text(&message.content)
}

fn title_candidate_from_text(text: &str) -> Option<String> {
    if let Some(objective) = extract_simple_tag_block(text, "objective") {
        if let Some(candidate) = title_candidate_from_lines(objective) {
            return Some(candidate);
        }
    }
    title_candidate_from_lines(text)
}

fn extract_simple_tag_block<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

fn title_candidate_from_lines(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut index = 0usize;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("</image>")
            || is_title_noise_line(trimmed)
        {
            index += 1;
            continue;
        }

        if is_injected_prompt_title_line(trimmed) {
            return None;
        }

        if is_workflow_state_start_line(trimmed) {
            index += 1;
            while index < lines.len() && !is_workflow_state_end_line(lines[index].trim()) {
                index += 1;
            }
            if index < lines.len() {
                index += 1;
            }
            continue;
        }

        if let Some(tag) = title_xml_tag_name(trimmed) {
            if is_title_noise_block_tag(&tag) {
                index += 1;
                if !title_line_closes_tag(trimmed, &tag) {
                    while index < lines.len() && !title_line_closes_tag(lines[index].trim(), &tag) {
                        index += 1;
                    }
                    if index < lines.len() {
                        index += 1;
                    }
                }
                continue;
            }
        }

        if let Some(candidate) = image_title_candidate_from_lines(&lines, index) {
            return Some(candidate);
        }

        return Some(trimmed.to_string());
    }

    None
}

fn image_title_candidate_from_lines(lines: &[&str], start_index: usize) -> Option<String> {
    let mut image_tokens: Vec<String> = Vec::new();
    let mut text_suffix: Option<String> = None;
    let mut index = start_index;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("</image>")
            || is_title_noise_line(trimmed)
        {
            index += 1;
            continue;
        }

        let (line_images, remaining_text) = extract_image_title_parts(trimmed);
        if line_images.is_empty() {
            if image_tokens.is_empty() {
                return None;
            }
            text_suffix = Some(trimmed.to_string());
            break;
        }

        for image in line_images {
            if !image_tokens
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&image))
            {
                image_tokens.push(image);
            }
        }
        if !remaining_text.is_empty() {
            text_suffix = Some(remaining_text);
            break;
        }
        index += 1;
    }

    if image_tokens.is_empty() {
        return None;
    }

    let mut title = image_tokens.join("");
    if let Some(text) = text_suffix {
        if !text.is_empty() {
            title.push(' ');
            title.push_str(&text);
        }
    }
    Some(title)
}

fn extract_image_title_parts(line: &str) -> (Vec<String>, String) {
    let mut rest = line;
    let mut image_tokens = Vec::new();
    let mut remaining_text = String::new();

    while !rest.is_empty() {
        let tag_pos = find_ascii_ci(rest, "<image");
        let label_pos = find_ascii_ci(rest, "[image #");
        let close_pos = find_ascii_ci(rest, "</image>");
        let next_pos = [tag_pos, label_pos, close_pos].into_iter().flatten().min();

        let Some(pos) = next_pos else {
            remaining_text.push_str(rest);
            break;
        };

        remaining_text.push_str(&rest[..pos]);
        rest = &rest[pos..];

        if starts_with_ascii_ci(rest, "</image>") {
            rest = &rest["</image>".len()..];
            continue;
        }

        if starts_with_ascii_ci(rest, "<image") {
            let end = rest.find('>').map(|idx| idx + 1).unwrap_or(rest.len());
            let token = &rest[..end];
            image_tokens.push(extract_image_label(token).unwrap_or_else(|| "[Image]".to_string()));
            rest = &rest[end..];
            continue;
        }

        if starts_with_ascii_ci(rest, "[image #") {
            let end = rest.find(']').map(|idx| idx + 1).unwrap_or(rest.len());
            image_tokens.push(rest[..end].to_string());
            rest = &rest[end..];
            continue;
        }
    }

    (image_tokens, remaining_text.trim().to_string())
}

fn extract_image_label(token: &str) -> Option<String> {
    let start = find_ascii_ci(token, "[image #")?;
    let end = token[start..].find(']')? + start + 1;
    Some(token[start..end].to_string())
}

fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_ascii_lowercase().find(needle)
}

fn starts_with_ascii_ci(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .map(|start| start.eq_ignore_ascii_case(prefix))
        .unwrap_or(false)
}

fn title_xml_tag_name(line: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix('<')?;
    if rest.starts_with('/') || rest.starts_with('!') || rest.starts_with('?') {
        return None;
    }
    let name: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    (!name.is_empty()).then(|| name.to_lowercase())
}

fn is_title_noise_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "codex_internal_context"
            | "current-state"
            | "instructions"
            | "session-context"
            | "system-reminder"
            | "workflow"
    )
}

fn title_line_closes_tag(line: &str, tag: &str) -> bool {
    line.to_lowercase().contains(&format!("</{tag}>"))
}

fn is_workflow_state_start_line(line: &str) -> bool {
    line.starts_with("[workflow-state:")
}

fn is_workflow_state_end_line(line: &str) -> bool {
    line.starts_with("[/workflow-state")
}

fn is_title_noise_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower == "<objective>"
        || lower == "</objective>"
        || lower.starts_with("knowledge cutoff:")
        || lower.starts_with("current date:")
        || lower.starts_with("continuation behavior:")
        || lower.starts_with("budget:")
}

fn is_injected_prompt_title_line(line: &str) -> bool {
    let normalized = line.trim_start_matches('#').trim().to_lowercase();
    normalized.starts_with("agents.md instructions for ")
        || normalized.starts_with("system prompt")
        || normalized.starts_with("developer instructions")
}

fn extract_role(value: &Value) -> Option<String> {
    let candidates = [
        value.get("role").and_then(Value::as_str),
        value.get("type").and_then(Value::as_str),
        value
            .get("message")
            .and_then(|v| v.get("role"))
            .and_then(Value::as_str),
        value
            .get("author")
            .and_then(|v| v.get("role"))
            .and_then(Value::as_str),
    ];

    for role in candidates.into_iter().flatten() {
        let lower = role.to_lowercase();
        if lower.contains("user") {
            return Some("user".to_string());
        }
        if lower.contains("assistant") || lower == "model" {
            return Some("assistant".to_string());
        }
        if lower.contains("system") {
            return Some("system".to_string());
        }
        if lower.contains("tool") {
            return Some("tool".to_string());
        }
    }
    None
}

fn extract_content(value: &Value) -> Option<String> {
    let candidates = [
        value.get("content"),
        value.get("text"),
        value.get("prompt"),
        value.get("input"),
        value.get("output"),
        value.get("arguments"),
        value.get("message"),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(text) = extract_text_from_value(candidate) {
            let normalized = normalize_text(&text);
            if !normalized.is_empty() {
                return Some(normalized);
            }
        }
    }
    None
}

fn extract_text_from_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(v.to_string()),
        Value::Number(v) => Some(v.to_string()),
        Value::String(v) => Some(v.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(extract_text_from_value)
                .map(|v| normalize_text(&v))
                .filter(|v| !v.is_empty())
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            let preferred_keys = [
                "text",
                "content",
                "prompt",
                "input_text",
                "output_text",
                "input",
                "output",
                "message",
                "arguments",
                "reasoning",
            ];
            for key in preferred_keys {
                if let Some(v) = map.get(key) {
                    if let Some(text) = extract_text_from_value(v) {
                        let normalized = normalize_text(&text);
                        if !normalized.is_empty() {
                            return Some(normalized);
                        }
                    }
                }
            }
            None
        }
    }
}

pub(crate) fn extract_timestamp(value: &Value) -> Option<String> {
    let candidates = [
        value.get("timestamp").and_then(Value::as_str),
        value.get("time").and_then(Value::as_str),
        value.get("created_at").and_then(Value::as_str),
        value.get("createdAt").and_then(Value::as_str),
        value
            .get("message")
            .and_then(|v| v.get("timestamp"))
            .and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .next()
        .map(ToString::to_string)
}

fn extract_timestamp_millis(value: &Value) -> Option<i64> {
    let candidates = [
        value.get("timestamp"),
        value.get("time"),
        value.get("created_at"),
        value.get("createdAt"),
        value.get("message").and_then(|v| v.get("timestamp")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(parse_timestamp_millis_value)
}

fn parse_timestamp_millis_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_f64().and_then(normalize_unix_timestamp_millis),
        Value::String(text) => parse_timestamp_millis_str(text),
        _ => None,
    }
}

fn parse_timestamp_millis_str(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(number) = trimmed.parse::<f64>() {
        return normalize_unix_timestamp_millis(number);
    }
    chrono::DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn normalize_unix_timestamp_millis(value: f64) -> Option<i64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let millis = if value >= 10_000_000_000.0 {
        value
    } else {
        value * 1000.0
    };
    (millis <= i64::MAX as f64).then_some(millis as i64)
}

fn extract_branch(value: &Value) -> Option<String> {
    let candidates = [
        value.get("branch").and_then(Value::as_str),
        value.get("git_branch").and_then(Value::as_str),
        value.get("gitBranch").and_then(Value::as_str),
        value
            .get("context")
            .and_then(|v| v.get("branch"))
            .and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|v| !v.trim().is_empty())
        .map(ToString::to_string)
}

fn normalize_text(text: &str) -> String {
    // 多数文本不含 \0，避免无意义的 replace 分配。
    if text.contains('\u{0000}') {
        text.replace('\u{0000}', "").trim().to_owned()
    } else {
        text.trim().to_owned()
    }
}

fn looks_like_patch(text: &str) -> bool {
    text.contains("*** Begin Patch")
        || text.contains("diff --git ")
        || (text.contains("@@") && (text.contains("+++ ") || text.contains("--- ")))
}

fn excerpt(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    // 每字符最多 4 字节（UTF-8）；预留稍微宽松一些避免临界 realloc。
    let mut out = String::with_capacity(max_chars.saturating_mul(4).saturating_add(4));
    for (idx, ch) in trimmed.chars().enumerate() {
        if idx >= max_chars {
            out.push_str("...");
            return out;
        }
        out.push(ch);
    }
    out
}

fn system_time_to_millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(path: &Path) {
        write_text(path, "{}\n");
    }

    fn write_text(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn expect_string_err<T>(result: Result<T, String>) -> String {
        match result {
            Ok(_) => panic!("expected error"),
            Err(err) => err,
        }
    }

    fn empty_usage() -> HistorySessionUsage {
        HistorySessionUsage {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            total_cost_usd: 0.0,
            dominant_model: None,
            current_model: None,
            context_window: None,
            last_context_tokens: None,
            reasoning_effort: None,
            token_trend: Vec::new(),
            tool_call_count: 0,
            mcp_calls: Vec::new(),
            skill_calls: Vec::new(),
            builtin_calls: Vec::new(),
        }
    }

    fn sample_detail(source: &str) -> HistorySessionDetail {
        HistorySessionDetail {
            session_id: "source-session".to_string(),
            source: source.to_string(),
            project_key: "CLI-Manager".to_string(),
            title: "implement conversion".to_string(),
            file_path: "source.jsonl".to_string(),
            cwd: Some(r"D:\work\CLI-Manager".to_string()),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_001_000,
            message_count: 2,
            branch: None,
            usage: empty_usage(),
            tool_events: Vec::new(),
            file_changes: Vec::new(),
            messages: vec![
                HistoryMessage {
                    role: "user".to_string(),
                    content: "hello".to_string(),
                    timestamp: Some("2026-01-01T00:00:00Z".to_string()),
                    model: None,
                    input_tokens: None,
                    output_tokens: None,
                    cache_creation_tokens: None,
                    cache_read_tokens: None,
                    line_index: None,
                    editable: false,
                    editable_text: None,
                },
                HistoryMessage {
                    role: "assistant".to_string(),
                    content: "world".to_string(),
                    timestamp: Some("2026-01-01T00:00:01Z".to_string()),
                    model: None,
                    input_tokens: None,
                    output_tokens: None,
                    cache_creation_tokens: None,
                    cache_read_tokens: None,
                    line_index: None,
                    editable: false,
                    editable_text: None,
                },
            ],
        }
    }

    #[test]
    fn scan_file_changes_reads_claude_and_codex_jsonl_operations_in_time_order() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("session.jsonl");
        let claude_edit = json!({
            "type": "assistant",
            "timestamp": "2026-07-11T10:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "claude-edit-1",
                    "name": "Edit",
                    "input": {
                        "file_path": "src/claude.ts",
                        "old_string": "old",
                        "new_string": "new"
                    }
                }]
            }
        });
        let codex_patch = json!({
            "type": "response_item",
            "timestamp": "2026-07-11T10:01:00Z",
            "payload": {
                "type": "custom_tool_call",
                "call_id": "codex-patch-1",
                "name": "exec",
                "input": r#"const patch = \"*** Begin Patch\n*** Update File: src/codex.ts\n@@\n-old\n+new\n*** End Patch\";"#
            }
        });
        write_text(
            &path,
            &format!(
                "{}\n{}\n",
                serde_json::to_string(&claude_edit).unwrap(),
                serde_json::to_string(&codex_patch).unwrap()
            ),
        );

        let changes = scan_file_changes(&path);
        assert_eq!(changes.len(), 2);

        let claude_change = changes
            .iter()
            .find(|change| change.file_path == "src/claude.ts")
            .unwrap();
        assert_eq!(claude_change.operations.len(), 1);
        assert_eq!(claude_change.operations[0].operation_group_index, Some(0));
        assert_eq!(
            claude_change.operations[0].timestamp.as_deref(),
            Some("2026-07-11T10:00:00Z")
        );

        let codex_change = changes
            .iter()
            .find(|change| change.file_path == "src/codex.ts")
            .unwrap();
        assert_eq!(codex_change.operations.len(), 1);
        assert_eq!(codex_change.operations[0].operation_group_index, Some(1));
        assert_eq!(codex_change.additions, 1);
        assert_eq!(codex_change.deletions, 1);
        assert!(codex_change.operations[0]
            .patch
            .as_deref()
            .unwrap()
            .contains("*** Update File: src/codex.ts"));
    }

    #[test]
    fn convert_codex_history_to_claude_jsonl_readable_by_history_parser() {
        let temp_dir = TempDir::new().unwrap();
        let roots = HistoryRoots {
            claude_config_dir: Some(temp_dir.path().join(".claude")),
            codex_config_dir: Some(temp_dir.path().join(".codex")),
        };

        let result = convert_history_session(&sample_detail("codex"), "claude", &roots).unwrap();
        assert_eq!(result.target_source, "claude");
        assert_eq!(result.message_count, 2);
        assert!(result.resume_command.starts_with("claude --resume "));
        assert_eq!(result.summary.source, "claude");
        assert_eq!(result.summary.session_id, result.session_id);
        assert_eq!(result.summary.message_count, 2);

        let files = collect_claude_session_files(&resolve_claude_history_root(&roots));
        assert_eq!(files.len(), 1);
        let detail = build_session_detail(&files[0], false).unwrap();
        assert_eq!(detail.source, "claude");
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].role, "user");
        assert_eq!(detail.messages[0].content, "hello");
        assert_eq!(detail.messages[1].role, "assistant");

        let raw_lines = std::fs::read_to_string(&files[0].path).unwrap();
        let assistant_line = raw_lines.lines().nth(1).unwrap();
        let assistant_value: Value = serde_json::from_str(assistant_line).unwrap();
        assert!(assistant_value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .is_some());
    }

    #[test]
    fn convert_claude_history_to_codex_jsonl_readable_by_history_parser() {
        let temp_dir = TempDir::new().unwrap();
        let roots = HistoryRoots {
            claude_config_dir: Some(temp_dir.path().join(".claude")),
            codex_config_dir: Some(temp_dir.path().join(".codex")),
        };
        write_text(
            &resolve_codex_config_root(&roots).join("config.toml"),
            "model_provider = \"test-provider\"\nmodel = \"gpt-test\"\nsqlite_home = \"sqlite\"\n",
        );

        let result = convert_history_session(&sample_detail("claude"), "codex", &roots).unwrap();
        assert_eq!(result.target_source, "codex");
        assert_eq!(result.message_count, 2);
        assert!(result.resume_command.starts_with("codex resume "));
        assert_eq!(result.summary.source, "codex");
        assert_eq!(result.summary.session_id, result.session_id);
        assert_eq!(result.summary.message_count, 2);

        let files = collect_codex_session_files(&resolve_codex_history_root(&roots));
        assert_eq!(files.len(), 1);
        let file_name = files[0]
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap();
        assert!(file_name.starts_with("rollout-20"));
        assert!(file_name.contains(&result.session_id));

        let raw_lines = std::fs::read_to_string(&files[0].path).unwrap();
        let session_meta: Value = serde_json::from_str(raw_lines.lines().next().unwrap()).unwrap();
        assert_eq!(
            session_meta
                .get("payload")
                .and_then(|payload| payload.get("session_id"))
                .and_then(Value::as_str),
            Some(result.session_id.as_str())
        );
        assert_eq!(
            session_meta
                .get("payload")
                .and_then(|payload| payload.get("model_provider"))
                .and_then(Value::as_str),
            Some("test-provider")
        );
        assert_eq!(
            session_meta
                .get("payload")
                .and_then(|payload| payload.get("cli_version"))
                .and_then(Value::as_str),
            Some("cli-manager-converted")
        );
        let codex_lines: Vec<Value> = raw_lines
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(codex_lines.iter().any(|line| {
            line.get("type").and_then(Value::as_str) == Some("event_msg")
                && line
                    .get("payload")
                    .and_then(|payload| payload.get("type"))
                    .and_then(Value::as_str)
                    == Some("user_message")
        }));
        assert!(codex_lines.iter().any(|line| {
            line.get("type").and_then(Value::as_str) == Some("event_msg")
                && line
                    .get("payload")
                    .and_then(|payload| payload.get("type"))
                    .and_then(Value::as_str)
                    == Some("agent_message")
        }));

        let history_index =
            std::fs::read_to_string(resolve_codex_config_root(&roots).join("history.jsonl"))
                .unwrap();
        let history_entry: Value =
            serde_json::from_str(history_index.lines().next().unwrap()).unwrap();
        assert_eq!(
            history_entry.get("session_id").and_then(Value::as_str),
            Some(result.session_id.as_str())
        );
        assert_eq!(
            history_entry.get("text").and_then(Value::as_str),
            Some("hello")
        );
        let session_index =
            std::fs::read_to_string(resolve_codex_config_root(&roots).join("session_index.jsonl"))
                .unwrap();
        let session_entry: Value =
            serde_json::from_str(session_index.lines().next().unwrap()).unwrap();
        assert_eq!(
            session_entry.get("id").and_then(Value::as_str),
            Some(result.session_id.as_str())
        );
        assert_eq!(
            resolve_codex_state_db_path(&roots),
            resolve_codex_config_root(&roots)
                .join("sqlite")
                .join("state_5.sqlite")
        );

        let detail = build_session_detail(&files[0], false).unwrap();
        assert_eq!(detail.source, "codex");
        assert_eq!(detail.session_id, result.session_id);
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].role, "user");
        assert_eq!(detail.messages[1].content, "world");
    }

    #[test]
    fn parse_wsl_find_session_file_line_extracts_path_metadata_and_project() {
        let hit = parse_wsl_find_session_file_line(
            "/home/me/.claude/projects/proj/session.jsonl\t42\t1719234567.2500000000",
            &|path| claude_project_key_from_wsl_linux_path(path),
        )
        .unwrap();

        assert_eq!(
            hit.linux_path,
            "/home/me/.claude/projects/proj/session.jsonl"
        );
        assert_eq!(hit.project_key, "proj");
        assert_eq!(hit.fingerprint.size, 42);
        assert_eq!(hit.fingerprint.updated_at, 1_719_234_567_250);
        assert_eq!(hit.fingerprint.created_at, 1_719_234_567_250);
    }

    #[test]
    fn session_matches_project_path_matches_wsl_encoded_claude_key() {
        // CLI-Manager 项目为 Windows 路径，claude 在 WSL 内按 /mnt/d 编码出此目录名（现场真实值）
        let file_ref = SessionFileRef {
            source: "claude".to_string(),
            project_key: "-mnt-d-work-pythonProject-CLI-Manager".to_string(),
            path: PathBuf::from("dummy.jsonl"),
        };
        let target = normalize_history_path(r"D:\work\pythonProject\CLI-Manager");
        assert!(session_matches_project_path(&file_ref, &target));
    }

    #[test]
    fn session_matches_project_path_rejects_unrelated_claude_key() {
        let file_ref = SessionFileRef {
            source: "claude".to_string(),
            project_key: "-mnt-d-some-other-project".to_string(),
            path: PathBuf::from("nonexistent-xyz-key.jsonl"),
        };
        let target = normalize_history_path(r"D:\work\pythonProject\CLI-Manager");
        assert!(!session_matches_project_path(&file_ref, &target));
    }

    #[test]
    fn resolve_session_file_ref_accepts_indexed_jsonl() {
        let temp_dir = TempDir::new().unwrap();
        let base = temp_dir.path().join("history");
        let file = base.join("project-a").join("session.jsonl");
        write_file(&file);

        let result = resolve_session_file_ref(
            file.to_str().unwrap(),
            "claude",
            "project-a",
            &base.canonicalize().unwrap(),
            vec![SessionFileRef {
                source: "claude".to_string(),
                project_key: "project-a".to_string(),
                path: file.clone(),
            }],
        )
        .unwrap();

        assert_eq!(result.source, "claude");
        assert_eq!(result.project_key, "project-a");
        assert_eq!(result.path, file.canonicalize().unwrap());
    }

    #[test]
    fn resolve_session_file_ref_reconciles_codex_project_key_from_cwd() {
        let temp_dir = TempDir::new().unwrap();
        let base = temp_dir.path().join("sessions");
        let file = base.join("2026").join("07").join("rollout-session.jsonl");
        write_text(
            &file,
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/data/tabGo\"}}\n",
        );

        let candidate = SessionFileRef {
            source: "codex".to_string(),
            project_key: "2026".to_string(),
            path: file.clone(),
        };
        let result = resolve_session_file_ref(
            file.to_str().unwrap(),
            "codex",
            "tabGo",
            &base.canonicalize().unwrap(),
            vec![candidate.clone()],
        )
        .unwrap();
        let wrong_project = expect_string_err(resolve_session_file_ref(
            file.to_str().unwrap(),
            "codex",
            "other-project",
            &base.canonicalize().unwrap(),
            vec![candidate],
        ));

        assert_eq!(result.source, "codex");
        assert_eq!(result.project_key, "tabGo");
        assert_eq!(result.path, file.canonicalize().unwrap());
        assert_eq!(wrong_project, "session_file_not_indexed");
    }

    #[test]
    fn resolve_session_file_ref_rejects_non_jsonl() {
        let temp_dir = TempDir::new().unwrap();
        let base = temp_dir.path().join("history");
        let file = base.join("project-a").join("session.txt");
        write_file(&file);

        let err = expect_string_err(resolve_session_file_ref(
            file.to_str().unwrap(),
            "claude",
            "project-a",
            &base.canonicalize().unwrap(),
            Vec::new(),
        ));

        assert_eq!(err, "invalid_session_file");
    }

    #[test]
    fn resolve_session_file_ref_rejects_path_outside_history_scope() {
        let temp_dir = TempDir::new().unwrap();
        let base = temp_dir.path().join("history");
        let file = temp_dir.path().join("outside").join("session.jsonl");
        write_file(&base.join("project-a").join("known.jsonl"));
        write_file(&file);

        let err = expect_string_err(resolve_session_file_ref(
            file.to_str().unwrap(),
            "claude",
            "project-a",
            &base.canonicalize().unwrap(),
            Vec::new(),
        ));

        assert_eq!(err, "session_file_outside_history_scope");
    }

    #[test]
    fn path_within_history_scope_accepts_equivalent_wsl_unc_prefixes() {
        let requested = PathBuf::from(
            r"\\wsl.localhost\Ubuntu\home\silver\.codex\sessions\2026\06\29\rollout.jsonl",
        );
        let history_base = PathBuf::from(r"\\wsl$\Ubuntu\home\silver\.codex\sessions");

        assert!(path_within_history_scope(&requested, &history_base));
    }

    #[test]
    fn path_within_history_scope_accepts_verbatim_wsl_unc_prefixes() {
        let requested = PathBuf::from(
            r"\\?\UNC\wsl.localhost\Ubuntu\home\silver\.codex\sessions\2026\06\29\rollout.jsonl",
        );
        let history_base = PathBuf::from(r"\\?\UNC\wsl$\Ubuntu\home\silver\.codex\sessions");

        assert!(path_within_history_scope(&requested, &history_base));
    }

    #[test]
    fn codex_runtime_path_uses_linux_path_for_wsl_unc() {
        let standard = PathBuf::from(
            r"\\wsl.localhost\Ubuntu-22.04\home\dministrator\.codex\sessions\2026\07\rollout.jsonl",
        );
        let verbatim = PathBuf::from(
            r"\\?\UNC\wsl$\Ubuntu-22.04\home\dministrator\.codex\sessions\2026\07\rollout.jsonl",
        );
        let native = PathBuf::from(r"C:\Users\Administrator\.codex\sessions\rollout.jsonl");

        assert_eq!(
            codex_runtime_path(&standard),
            "/home/dministrator/.codex/sessions/2026/07/rollout.jsonl"
        );
        assert_eq!(
            codex_runtime_path(&verbatim),
            "/home/dministrator/.codex/sessions/2026/07/rollout.jsonl"
        );
        assert_eq!(codex_runtime_path(&native), native.to_string_lossy());
    }

    #[test]
    fn codex_state_registration_is_disabled_for_wsl_database() {
        let wsl_db =
            PathBuf::from(r"\\wsl.localhost\Ubuntu-22.04\home\dministrator\.codex\state_5.sqlite");
        let native_db = PathBuf::from(r"C:\Users\Administrator\.codex\state_5.sqlite");

        assert!(!should_register_codex_state_db(&wsl_db));
        assert!(should_register_codex_state_db(&native_db));
    }

    #[test]
    fn path_within_history_scope_rejects_wsl_paths_outside_base() {
        let requested =
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\silver\.codex\other\rollout.jsonl");
        let history_base = PathBuf::from(r"\\wsl$\Ubuntu\home\silver\.codex\sessions");

        assert!(!path_within_history_scope(&requested, &history_base));
    }

    #[test]
    fn resolve_session_file_ref_rejects_source_or_project_mismatch() {
        let temp_dir = TempDir::new().unwrap();
        let base = temp_dir.path().join("history");
        let file = base.join("project-a").join("session.jsonl");
        write_file(&file);

        let wrong_project = expect_string_err(resolve_session_file_ref(
            file.to_str().unwrap(),
            "claude",
            "project-a",
            &base.canonicalize().unwrap(),
            vec![SessionFileRef {
                source: "claude".to_string(),
                project_key: "project-b".to_string(),
                path: file.clone(),
            }],
        ));
        let wrong_source = expect_string_err(resolve_session_file_ref(
            file.to_str().unwrap(),
            "claude",
            "project-a",
            &base.canonicalize().unwrap(),
            vec![SessionFileRef {
                source: "codex".to_string(),
                project_key: "project-a".to_string(),
                path: file.clone(),
            }],
        ));

        assert_eq!(wrong_project, "session_file_not_indexed");
        assert_eq!(wrong_source, "session_file_not_indexed");
    }

    #[test]
    fn resolve_stats_time_bounds_accepts_full_year_range() {
        let start_at = DAY_MS;
        let full_year_end_at = start_at + 366 * DAY_MS - 1;
        let too_large_end_at = start_at + 367 * DAY_MS - 1;

        let bounds =
            resolve_stats_time_bounds(None, Some(start_at), Some(full_year_end_at)).unwrap();
        let err = expect_string_err(resolve_stats_time_bounds(
            None,
            Some(start_at),
            Some(too_large_end_at),
        ));

        assert_eq!(bounds.range_days, 366);
        assert_eq!(err, "date_range_too_large");
    }

    #[test]
    fn hour_of_day_for_stats_uses_explicit_range_anchor() {
        let local_day_start_at_utc_plus_8 = 16 * HOUR_MS;
        let local_10_am = local_day_start_at_utc_plus_8 + 10 * HOUR_MS;
        let bounds = StatsTimeBounds {
            start_at: local_day_start_at_utc_plus_8,
            end_at: local_day_start_at_utc_plus_8 + DAY_MS - 1,
            start_day: local_day_start_at_utc_plus_8,
            range_days: 1,
            explicit: true,
        };

        assert_eq!(hour_of_day_utc(local_10_am), 2);
        assert_eq!(hour_of_day_for_stats(local_10_am, bounds), 10);
    }

    #[test]
    fn history_stats_buckets_usage_by_event_timestamp() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        let line_a = r#"{"type":"assistant","timestamp":"1970-01-02T01:00:00Z","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":10}}}"#;
        let line_b = r#"{"type":"assistant","timestamp":"1970-01-03T02:00:00Z","requestId":"req_2","message":{"id":"msg_2","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"world"}],"usage":{"input_tokens":200,"output_tokens":20}}}"#;
        write_text(&file, &format!("{line_a}\n{line_b}\n"));

        let computed = scan_session_computation(&file, DAY_MS, 4 * DAY_MS);
        let entry = HistoryIndexEntry {
            file_ref: SessionFileRef {
                source: "claude".to_string(),
                project_key: "project-a".to_string(),
                path: file.clone(),
            },
            fingerprint: SessionFileFingerprint {
                created_at: DAY_MS,
                updated_at: 4 * DAY_MS,
                size: 1,
            },
            computed,
        };
        let bounds = StatsTimeBounds {
            start_at: DAY_MS,
            end_at: 3 * DAY_MS - 1,
            start_day: DAY_MS,
            range_days: 2,
            explicit: true,
        };

        let daily_index = build_history_stats_daily_index(vec![entry], None, None, None, bounds);
        let response = build_history_stats_response(&daily_index.days, bounds);

        assert_eq!(response.total_sessions, 1);
        assert_eq!(response.total_messages, 2);
        assert_eq!(response.total_input_tokens, 300);
        assert_eq!(response.total_output_tokens, 30);
        assert_eq!(response.daily_series.len(), 2);
        assert_eq!(response.daily_series[0].input_tokens, 100);
        assert_eq!(response.daily_series[1].input_tokens, 200);
        assert_eq!(response.project_ranking[0].sessions, 1);
        assert_eq!(response.source_distribution[0].sessions, 1);
        assert_eq!(response.model_distribution[0].sessions, 1);
    }

    #[test]
    fn history_stats_model_distribution_preserves_codex_reasoning_effort() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}"#,
                "\n",
                r#"{"type":"event_msg","timestamp":"1970-01-02T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":100,"output_tokens":100,"total_tokens":1100}}}}"#,
                "\n",
            ),
        );
        let computed = scan_session_computation(&file, DAY_MS, 2 * DAY_MS);
        let entry = HistoryIndexEntry {
            file_ref: SessionFileRef {
                source: "codex".to_string(),
                project_key: "project-a".to_string(),
                path: file,
            },
            fingerprint: SessionFileFingerprint {
                created_at: DAY_MS,
                updated_at: 2 * DAY_MS,
                size: 1,
            },
            computed,
        };
        let bounds = StatsTimeBounds {
            start_at: DAY_MS,
            end_at: 2 * DAY_MS - 1,
            start_day: DAY_MS,
            range_days: 1,
            explicit: true,
        };

        let daily_index = build_history_stats_daily_index(vec![entry], None, None, None, bounds);
        let response = build_history_stats_response(&daily_index.days, bounds);

        assert_eq!(response.model_distribution.len(), 1);
        assert_eq!(response.model_distribution[0].model, "gpt-5.4(high)");
    }

    #[test]
    fn history_stats_reprices_cached_usage_events_with_current_model_prices() {
        crate::commands::model_pricing::model_prices_set_cache(vec![
            crate::commands::model_pricing::ModelPriceEntry {
                model: "priced-model".to_string(),
                input_per_1m: 2.5,
                output_per_1m: 15.0,
                cache_read_per_1m: 0.25,
                cache_creation_per_1m: 0.0,
                source: "manual".to_string(),
                source_model_id: Some("priced-model".to_string()),
                raw_json: None,
                updated_at_ms: 1,
                synced_at_ms: None,
            },
        ])
        .unwrap();

        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        write_text(&file, "{}");

        let usage = UsageStatsScan {
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            cache_read_tokens: 10_000_000,
            cache_creation_tokens: 0,
            total_cost_usd: 1.23,
            unpriced_tokens: 11_100_000,
        };
        let entry = HistoryIndexEntry {
            file_ref: SessionFileRef {
                source: "codex".to_string(),
                project_key: "CLI-Manager".to_string(),
                path: file,
            },
            fingerprint: SessionFileFingerprint {
                created_at: DAY_MS,
                updated_at: DAY_MS,
                size: 2,
            },
            computed: CachedSessionComputation {
                created_at: DAY_MS,
                updated_at: DAY_MS,
                session_id: "session-1".to_string(),
                title: "priced session".to_string(),
                message_count: 1,
                branch: None,
                stats: SessionStatsScan {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_read_tokens: usage.cache_read_tokens,
                    cache_creation_tokens: usage.cache_creation_tokens,
                    total_cost_usd: usage.total_cost_usd,
                    unpriced_tokens: usage.unpriced_tokens,
                    dominant_model: Some("priced-model".to_string()),
                    current_model: Some("priced-model".to_string()),
                    model_usage: HashMap::new(),
                    context_window: None,
                    last_context_tokens: None,
                    reasoning_effort: None,
                    token_trend: vec![usage_trend_point(
                        UsageTokenScan {
                            input_tokens: usage.input_tokens,
                            output_tokens: usage.output_tokens,
                            cache_read_tokens: usage.cache_read_tokens,
                            cache_creation_tokens: usage.cache_creation_tokens,
                            explicit_cost_usd: None,
                        },
                        Some("priced-model".to_string()),
                    )],
                    usage_events: vec![SessionUsageEventScan {
                        event_key: "test:event".to_string(),
                        event_index: 0,
                        timestamp_ms: Some(DAY_MS),
                        model: Some("priced-model".to_string()),
                        usage,
                    }],
                    tool_call_count: 0,
                    mcp_calls: HashMap::new(),
                    skill_calls: HashMap::new(),
                    builtin_calls: HashMap::new(),
                },
            },
        };
        let bounds = StatsTimeBounds {
            start_at: DAY_MS,
            end_at: 2 * DAY_MS - 1,
            start_day: DAY_MS,
            range_days: 1,
            explicit: true,
        };

        let daily_index = build_history_stats_daily_index(vec![entry], None, None, None, bounds);
        let response = build_history_stats_response(&daily_index.days, bounds);

        assert_eq!(response.total_input_tokens, 1_000_000);
        assert_eq!(response.total_output_tokens, 100_000);
        assert_eq!(response.total_cache_read_tokens, 10_000_000);
        assert!((response.total_cost_usd - 6.5).abs() < 1e-9);
        assert_eq!(response.total_unpriced_tokens, 0);
        assert!((response.daily_series[0].total_cost_usd - 6.5).abs() < 1e-9);
        assert_eq!(response.model_distribution[0].unpriced_tokens, 0);
    }

    #[test]
    fn collect_codex_session_files_uses_cwd_project_name() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().join(".codex");
        let file = root
            .join("sessions")
            .join("2026")
            .join("06")
            .join("12")
            .join("rollout-session.jsonl");
        write_text(
            &file,
            r#"{"type":"session_meta","payload":{"cwd":"D:\\work\\pythonProject\\CLI-Manager"}}"#,
        );

        let files = collect_codex_session_files(&root);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].source, "codex");
        assert_eq!(files[0].project_key, "CLI-Manager");
        assert_eq!(files[0].path, file);
    }

    #[test]
    fn build_session_computation_uses_codex_session_meta_id() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir
            .path()
            .join("rollout-2026-06-17T16-10-35-019ed4a1-d197-75d0-950c-28cb3bbed404.jsonl");
        write_text(
            &file,
            r#"{"type":"session_meta","payload":{"id":"019ed4a1-d197-75d0-950c-28cb3bbed404","cwd":"D:\\work\\pythonProject\\CLI-Manager"}}"#,
        );

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(computed.session_id, "019ed4a1-d197-75d0-950c-28cb3bbed404");
    }

    #[test]
    fn build_session_detail_exposes_cwd() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            r#"{"type":"session_meta","payload":{"id":"session-1","cwd":"D:\\work\\CLI-Manager"}}"#,
        );
        let file_ref = SessionFileRef {
            source: "codex".to_string(),
            project_key: "CLI-Manager".to_string(),
            path: file,
        };

        let detail = build_session_detail(&file_ref, false).unwrap();

        assert_eq!(detail.cwd.as_deref(), Some("D:\\work\\CLI-Manager"));
    }

    #[test]
    fn build_session_detail_aggregates_subtasks_for_realtime_stats() {
        let temp_dir = TempDir::new().unwrap();
        let parent_file = temp_dir.path().join("rollout-session.jsonl");
        let child_file = temp_dir.path().join("subagents").join("agent-child.jsonl");
        write_text(
            &parent_file,
            concat!(
                r#"{"type":"session_meta","payload":{"id":"session-1","cwd":"D:\\work\\CLI-Manager"}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-06-26T10:00:00Z","requestId":"req-parent","message":{"id":"msg-parent","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"parent"}],"usage":{"input_tokens":100,"output_tokens":50}}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-06-26T10:00:00Z","message":{"id":"tools-parent","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}"#,
                "\n",
            ),
        );
        write_text(
            &child_file,
            concat!(
                r#"{"type":"assistant","timestamp":"2026-06-26T10:01:00Z","requestId":"req-child","message":{"id":"msg-child","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"child"}],"usage":{"input_tokens":40,"output_tokens":10,"cache_read_input_tokens":20}}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-06-26T10:01:00Z","message":{"id":"tools-child","content":[{"type":"tool_use","id":"t2","name":"mcp__exa__web_search_exa","input":{}}]}}"#,
                "\n",
            ),
        );
        let file_ref = SessionFileRef {
            source: "claude".to_string(),
            project_key: "CLI-Manager".to_string(),
            path: parent_file,
        };

        let detail = build_session_detail(&file_ref, true).unwrap();

        assert_eq!(detail.session_id, "session-1");
        assert_eq!(detail.cwd.as_deref(), Some("D:\\work\\CLI-Manager"));
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.message_count, 2);
        assert_eq!(detail.usage.input_tokens, 140);
        assert_eq!(detail.usage.output_tokens, 60);
        assert_eq!(detail.usage.cache_read_tokens, 20);
        assert_eq!(detail.usage.tool_call_count, 2);
        assert_eq!(detail.usage.builtin_calls[0].name, "Read");
        assert_eq!(detail.usage.builtin_calls[0].count, 1);
        assert_eq!(detail.usage.mcp_calls[0].name, "exa");
        assert_eq!(detail.usage.mcp_calls[0].count, 1);
        assert_eq!(detail.usage.token_trend.len(), 2);
        assert_eq!(detail.usage.token_trend[0].total_tokens, 150);
        assert_eq!(detail.usage.token_trend[1].total_tokens, 70);
    }

    #[test]
    fn build_session_computation_falls_back_for_codex_without_session_meta_id() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            r#"{"type":"session_meta","payload":{"cwd":"D:\\work\\pythonProject\\CLI-Manager"}}"#,
        );

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(computed.session_id, "rollout-session");
    }

    #[test]
    fn build_session_computation_keeps_claude_file_stem_session_id() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("claude-session.jsonl");
        write_text(
            &file,
            r#"{"type":"session_meta","payload":{"id":"019ed4a1-d197-75d0-950c-28cb3bbed404"}}"#,
        );

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(computed.session_id, "claude-session");
    }

    #[test]
    fn build_session_computation_title_uses_objective_from_internal_context() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        let content = concat!(
            "<codex_internal_context source=\"goal\">\n",
            "Continue working toward the active thread goal.\n",
            "<objective>\n",
            "历史会话列表加载的太久\n",
            "</objective>\n",
            "</codex_internal_context>"
        );
        let line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        })
        .to_string();
        write_text(&file, &line);

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(computed.title, "历史会话列表加载的太久");
    }

    #[test]
    fn build_session_computation_title_skips_system_like_user_blocks() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        let system_line = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "<system-reminder>\nDo not show this as title.\n</system-reminder>"
            }
        })
        .to_string();
        let user_line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": "真实用户第一句话" }
        })
        .to_string();
        write_text(&file, &format!("{system_line}\n{user_line}\n"));

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(computed.title, "真实用户第一句话");
    }

    #[test]
    fn build_session_computation_title_skips_agents_instructions() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        let system_line = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "# AGENTS.md instructions for D:\\work\\pythonProject\\CLI-Manager\n\n## 角色定位\n..."
            }
        })
        .to_string();
        let user_line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": "历史会话还是加载太慢了，重新优化" }
        })
        .to_string();
        write_text(&file, &format!("{system_line}\n{user_line}\n"));

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(computed.title, "历史会话还是加载太慢了，重新优化");
    }

    #[test]
    fn build_session_computation_title_uses_image_placeholders_with_remaining_text() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("image-session.jsonl");
        let content = concat!(
            "<image name=[Image #1] path=\"C:\\\\Users\\\\Administrator\\\\image-a.png\">\n",
            "<image name=[Image #2] path=\"C:\\\\Users\\\\Administrator\\\\image-b.png\">\n",
            "请分析这两张截图的问题"
        );
        let line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        })
        .to_string();
        write_text(&file, &line);

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(
            computed.title,
            "[Image #1][Image #2] 请分析这两张截图的问题"
        );
    }

    #[test]
    fn build_session_computation_title_skips_image_close_and_repeated_placeholder() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("image-with-text-session.jsonl");
        let content = concat!(
            "<image name=[Image #1] path=\"C:\\\\Users\\\\Administrator\\\\image.png\">\n",
            "</image>\n",
            "[Image #1] 重新设计历史会话中会话列表的这三个图标，关闭展开和 subagent 。需要实现简约干净的风格"
        );
        let line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        })
        .to_string();
        write_text(&file, &line);

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(
            computed.title,
            "[Image #1] 重新设计历史会话中会话列表的这三个图标，关闭展开和 subagent 。需要实现简约干净的风格"
        );
    }

    #[test]
    fn build_session_computation_title_skips_inline_image_close_before_text() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("image-inline-close-session.jsonl");
        let content = concat!(
            "<image name=[Image #1] path=\"C:\\\\Users\\\\Administrator\\\\image.png\">\n",
            "</image>[Image #1]还是没有实现"
        );
        let line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        })
        .to_string();
        write_text(&file, &line);

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(computed.title, "[Image #1] 还是没有实现");
    }

    #[test]
    fn build_session_computation_title_uses_single_image_placeholder() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("image-only-session.jsonl");
        let line = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "<image name=[Image #1] path=\"C:\\\\Users\\\\Administrator\\\\image.png\">"
            }
        })
        .to_string();
        write_text(&file, &line);

        let computed = scan_session_computation(&file, 1, 2);

        assert_eq!(computed.title, "[Image #1]");
    }

    #[test]
    fn get_or_scan_session_project_reuses_matching_fingerprint_cache() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            r#"{"type":"session_meta","payload":{"cwd":"D:\\work\\ActualProject"}}"#,
        );
        let key = path_to_key(&file);
        let fingerprint = session_file_fingerprint(&file);

        get_project_cache().lock().unwrap().entries.insert(
            key.clone(),
            CachedSessionProjectCacheEntry {
                fingerprint,
                scan: SessionProjectScan {
                    cwd: Some("D:\\work\\CachedProject".to_string()),
                },
            },
        );

        let scan = get_or_scan_session_project(&file);

        get_project_cache().lock().unwrap().entries.remove(&key);
        assert_eq!(scan.cwd.as_deref(), Some("D:\\work\\CachedProject"));
    }

    #[test]
    fn scan_session_combined_dedups_streamed_usage_lines() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        let line_a = r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}"#;
        let line_b = r#"{"type":"assistant","requestId":"req_2","message":{"id":"msg_2","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"world"}],"usage":{"input_tokens":200,"output_tokens":80,"cache_read_input_tokens":20,"cache_creation_input_tokens":0}}}"#;
        // line_a 重复两次，模拟 Claude Code 同一条消息的多个流式行
        write_text(&file, &format!("{line_a}\n{line_a}\n{line_b}\n"));

        let (_, stats) = scan_session_combined(&file);

        assert_eq!(stats.input_tokens, 300);
        assert_eq!(stats.output_tokens, 130);
        assert_eq!(stats.cache_read_tokens, 30);
        assert_eq!(stats.cache_creation_tokens, 5);
        assert_eq!(stats.unpriced_tokens, 465);
        assert_eq!(stats.dominant_model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(stats.token_trend.len(), 2);
        assert_eq!(stats.token_trend[0].total_tokens, 165);
        assert_eq!(stats.token_trend[1].total_tokens, 300);
    }

    #[test]
    fn scan_session_combined_diffs_codex_cumulative_token_count() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"turn_context","payload":{"model":"gpt-5.4"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100}}}}"#,
                "\n",
                // 重复累计事件：差分为 0，不应重复计数
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100}}}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":1600,"output_tokens":300,"total_tokens":3300}}}}"#,
                "\n",
            ),
        );

        let (_, stats) = scan_session_combined(&file);

        // input 不含缓存命中：(1000-400) + (2000-1200) = 1400
        assert_eq!(stats.input_tokens, 1400);
        assert_eq!(stats.cache_read_tokens, 1600);
        assert_eq!(stats.output_tokens, 300);
        // token_count 事件不带 model，应回退归因到 turn_context 的模型；未加载模型价格缓存时只记未定价。
        assert_eq!(stats.unpriced_tokens, 3300);
        assert!(stats.model_usage.contains_key("gpt-5.4"));
        assert_eq!(stats.total_cost_usd, 0.0);
        assert_eq!(stats.token_trend.len(), 2);
        assert_eq!(stats.token_trend[0].input_tokens, 600);
        assert_eq!(stats.token_trend[0].cache_read_tokens, 400);
        assert_eq!(stats.token_trend[0].output_tokens, 100);
        assert_eq!(stats.token_trend[0].total_tokens, 1100);
        assert_eq!(stats.token_trend[1].input_tokens, 800);
        assert_eq!(stats.token_trend[1].cache_read_tokens, 1200);
        assert_eq!(stats.token_trend[1].output_tokens, 200);
        assert_eq!(stats.token_trend[1].total_tokens, 2200);
    }

    #[test]
    fn scan_session_combined_extracts_codex_context_window() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100},"model_context_window":272000}}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":1600,"output_tokens":300,"total_tokens":3300},"last_token_usage":{"input_tokens":2000,"cached_input_tokens":1200,"output_tokens":200,"total_tokens":2200},"model_context_window":272000}}}"#,
                "\n",
            ),
        );

        let (_, stats) = scan_session_combined(&file);

        assert_eq!(stats.context_window, Some(272000));
        // 取最后一次 last_token_usage 的 total_tokens
        assert_eq!(stats.last_context_tokens, Some(2200));
    }

    #[test]
    fn scan_session_combined_extracts_claude_explicit_context_window() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("claude-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"cache_read_input_tokens":90000,"cache_creation_input_tokens":5000,"output_tokens":200,"context_window":200000}}}"#,
                "\n",
                r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","model":"claude-sonnet-4-5","usage":{"input_tokens":20,"cache_read_input_tokens":95000,"cache_creation_input_tokens":1000,"output_tokens":300,"max_context_tokens":1000000}}}"#,
                "\n",
            ),
        );

        let (_, stats) = scan_session_combined(&file);

        assert_eq!(stats.context_window, Some(1_000_000));
        assert_eq!(stats.last_context_tokens, Some(96_020));
    }

    #[test]
    fn scan_session_combined_tracks_current_model_separately_from_dominant_model() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("claude-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-old","usage":{"input_tokens":10,"output_tokens":20}}}"#,
                "\n",
                r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","model":"claude-old","usage":{"input_tokens":11,"output_tokens":21}}}"#,
                "\n",
                r#"{"type":"assistant","requestId":"r3","message":{"id":"m3","model":"claude-new","usage":{"input_tokens":12,"output_tokens":22,"context_window":300000}}}"#,
                "\n",
            ),
        );

        let (_, stats) = scan_session_combined(&file);

        assert_eq!(stats.dominant_model.as_deref(), Some("claude-old"));
        assert_eq!(stats.current_model.as_deref(), Some("claude-new"));
        assert_eq!(stats.context_window, Some(300_000));
        assert_eq!(stats.last_context_tokens, Some(12));
        assert_eq!(stats.token_trend.len(), 3);
        assert_eq!(stats.token_trend[0].model.as_deref(), Some("claude-old"));
        assert_eq!(stats.token_trend[1].model.as_deref(), Some("claude-old"));
        assert_eq!(stats.token_trend[2].model.as_deref(), Some("claude-new"));
    }

    #[test]
    fn scan_session_combined_extracts_codex_reasoning_effort() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"medium"}}"#,
                "\n",
                r#"{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}"#,
                "\n",
            ),
        );

        let (_, stats) = scan_session_combined(&file);

        assert_eq!(stats.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn scan_session_combined_qualifies_codex_model_with_reasoning_effort() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}"#,
                "\n",
                r#"{"type":"event_msg","timestamp":"2026-07-06T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":100,"output_tokens":100,"total_tokens":1100}}}}"#,
                "\n",
                r#"{"type":"turn_context","payload":{"model":"gpt-5.6","effort":"xhigh"}}"#,
                "\n",
                r#"{"type":"event_msg","timestamp":"2026-07-06T01:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":500,"output_tokens":400,"total_tokens":3400}}}}"#,
                "\n",
                r#"{"type":"turn_context","payload":{"model":"gpt-5.3-codex-spark","effort":"high"}}"#,
                "\n",
                r#"{"type":"event_msg","timestamp":"2026-07-06T01:02:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3600,"cached_input_tokens":600,"output_tokens":500,"total_tokens":4100}}}}"#,
                "\n",
            ),
        );

        let (_, stats) = scan_session_combined(&file);

        assert_eq!(stats.current_model.as_deref(), Some("gpt-5.3-codex-spark"));
        assert_eq!(stats.token_trend.len(), 3);
        assert_eq!(stats.token_trend[0].model.as_deref(), Some("gpt-5.4(high)"));
        assert_eq!(
            stats.token_trend[1].model.as_deref(),
            Some("gpt-5.6(xhigh)")
        );
        assert_eq!(
            stats.token_trend[2].model.as_deref(),
            Some("gpt-5.3-codex-spark")
        );
        assert!(stats.model_usage.contains_key("gpt-5.4(high)"));
        assert!(stats.model_usage.contains_key("gpt-5.6(xhigh)"));
        assert!(stats.model_usage.contains_key("gpt-5.3-codex-spark"));
        assert!(!stats.model_usage.contains_key("gpt-5.3-codex-spark(high)"));
    }

    #[test]
    fn qualify_model_normalizes_embedded_reasoning_effort_suffix() {
        assert_eq!(
            qualify_model_with_reasoning_effort("gpt-5.6-xhigh".to_string(), None),
            "gpt-5.6(xhigh)"
        );
        assert_eq!(
            qualify_model_with_reasoning_effort("gpt-5.4(high)".to_string(), Some("medium")),
            "gpt-5.4(high)"
        );
        assert_eq!(
            qualify_model_with_reasoning_effort("gpt-5.6".to_string(), Some("High")),
            "gpt-5.6(high)"
        );
        assert_eq!(
            qualify_model_with_reasoning_effort("gpt-5.3-codex-spark".to_string(), Some("high")),
            "gpt-5.3-codex-spark"
        );
        assert_eq!(
            qualify_model_with_reasoning_effort("gpt-5.3-codex-spark(high)".to_string(), None),
            "gpt-5.3-codex-spark"
        );
        assert_eq!(
            qualify_model_with_reasoning_effort("gpt-5.3-codex-spark-high".to_string(), None),
            "gpt-5.3-codex-spark"
        );
    }

    #[test]
    fn scan_session_combined_tracks_claude_last_context_tokens() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("claude-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"cache_read_input_tokens":90000,"cache_creation_input_tokens":5000,"output_tokens":200}}}"#,
                "\n",
                r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","model":"claude-sonnet-4-5","usage":{"input_tokens":20,"cache_read_input_tokens":95000,"cache_creation_input_tokens":1000,"output_tokens":300}}}"#,
                "\n",
            ),
        );

        let (_, stats) = scan_session_combined(&file);

        // 最近一条请求的上下文占用 = input + 缓存读 + 缓存写
        assert_eq!(stats.last_context_tokens, Some(96020));
        // Claude 行不带 model_context_window
        assert_eq!(stats.context_window, None);
    }

    #[test]
    fn scan_session_combined_counts_tool_mcp_and_skill_calls() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("claude-session.jsonl");
        write_text(
            &file,
            concat!(
                // 普通工具 + MCP 工具
                r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}},{"type":"tool_use","id":"t2","name":"mcp__exa__web_search_exa","input":{}}]}}"#,
                "\n",
                // 流式重复行：相同块 id，不应重复计数
                r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t2","name":"mcp__exa__web_search_exa","input":{}}]}}"#,
                "\n",
                // Skill 工具调用
                r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t3","name":"Skill","input":{"skill":"goal"}}]}}"#,
                "\n",
                // 斜杠命令标记
                r#"{"type":"user","message":{"role":"user","content":"<command-name>/compact</command-name>"}}"#,
                "\n",
                // Codex function_call
                r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1"}}"#,
                "\n",
                // Codex MCP function_call：MCP server 在 namespace，不在 name
                r#"{"type":"response_item","payload":{"type":"function_call","name":"impact","namespace":"mcp__gitnexus","call_id":"c2"}}"#,
                "\n",
                // Codex MCP 结束事件：同 call_id 已在开始事件计数，不应重复
                r#"{"type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"c2","invocation":{"server":"gitnexus","tool":"impact","arguments":{}}}}"#,
                "\n",
                // Codex MCP 结束事件也可能单独出现，应能按 invocation.server 计数
                r#"{"type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"c3","invocation":{"server":"context7","tool":"query_docs","arguments":{}}}}"#,
                "\n",
            ),
        );

        let (_, stats) = scan_session_combined(&file);

        assert_eq!(stats.tool_call_count, 6);
        assert_eq!(stats.mcp_calls.get("exa"), Some(&1));
        assert_eq!(stats.mcp_calls.get("gitnexus"), Some(&1));
        assert_eq!(stats.mcp_calls.get("context7"), Some(&1));
        assert_eq!(stats.skill_calls.get("goal"), Some(&1));
        assert_eq!(stats.skill_calls.get("compact"), Some(&1));
        // 内置工具：Read (t1) + shell (c1)；Skill 工具本身不计入 builtin
        assert_eq!(stats.builtin_calls.get("Read"), Some(&1));
        assert_eq!(stats.builtin_calls.get("shell"), Some(&1));
        assert_eq!(stats.builtin_calls.len(), 2);
    }

    #[test]
    fn extract_command_name_strips_slash() {
        assert_eq!(
            extract_command_name(r#"text <command-name>/goal</command-name> rest"#),
            Some("goal".to_string())
        );
        assert_eq!(extract_command_name("no marker"), None);
    }

    #[test]
    fn parse_message_classifies_tool_result_lines_as_tool() {
        // Claude 的工具结果行：user 角色 + content 全为 tool_result 块 → 归类为 tool
        let tool_result_line: Value = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
        )
        .unwrap();
        assert_eq!(parse_message(&tool_result_line).unwrap().role, "tool");

        // 真实用户输入保持 user
        let user_line: Value = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
        )
        .unwrap();
        assert_eq!(parse_message(&user_line).unwrap().role, "user");
    }

    #[test]
    fn codex_usage_delta_resets_when_cumulative_shrinks() {
        let previous = CodexCumulativeUsage {
            input_tokens: 5000,
            cached_input_tokens: 2000,
            output_tokens: 500,
            total_tokens: 5500,
        };
        let current = CodexCumulativeUsage {
            input_tokens: 300,
            cached_input_tokens: 100,
            output_tokens: 30,
            total_tokens: 330,
        };

        let usage = codex_usage_delta(Some(previous), current);

        assert_eq!(usage.input_tokens, 200);
        assert_eq!(usage.cache_read_tokens, 100);
        assert_eq!(usage.output_tokens, 30);
    }

    #[test]
    fn scan_session_combined_ignores_synthetic_model() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        write_text(
            &file,
            r#"{"type":"assistant","message":{"id":"e1","role":"assistant","model":"<synthetic>","content":"Prompt is too long","usage":{"input_tokens":1,"output_tokens":0}}}"#,
        );

        let (_, stats) = scan_session_combined(&file);

        assert_eq!(stats.dominant_model, None);
        assert!(stats.model_usage.is_empty());
    }

    #[test]
    fn extract_usage_tokens_merges_top_level_cost_with_nested_tokens() {
        let value: Value = serde_json::from_str(
            r#"{"costUSD":0.5,"message":{"usage":{"input_tokens":100,"output_tokens":50}}}"#,
        )
        .unwrap();

        let usage = extract_usage_tokens(&value);

        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.explicit_cost_usd, Some(0.5));
    }

    #[test]
    fn iter_session_messages_blanks_duplicate_usage_lines() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        let line = r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":50}}}"#;
        write_text(&file, &format!("{line}\n{line}\n"));
        let mut messages = Vec::new();

        iter_session_messages(&file, |_, msg| {
            messages.push(msg);
            true
        })
        .unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].input_tokens, Some(100));
        assert_eq!(messages[0].output_tokens, Some(50));
        assert_eq!(messages[1].input_tokens, None);
        assert_eq!(messages[1].output_tokens, None);
    }

    #[test]
    fn iter_session_messages_extracts_model_with_fallback() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        let claude_line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let codex_turn_context = r#"{"type":"turn_context","payload":{"model":"gpt-5-codex"}}"#;
        let codex_message = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#;
        write_text(
            &file,
            &format!("{claude_line}\n{codex_turn_context}\n{codex_message}\n"),
        );
        let mut messages = Vec::new();

        iter_session_messages(&file, |_, msg| {
            messages.push(msg);
            true
        })
        .unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(messages[1].model.as_deref(), Some("gpt-5-codex"));
    }

    #[test]
    fn scan_session_detail_collects_messages_and_stats_in_one_pass() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        let line = r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":50}}}"#;
        // 同一条流式消息重复两次：messages 都保留但重复行 token 清空；stats 只计一次。
        write_text(&file, &format!("{line}\n{line}\n"));

        let (summary, stats, messages) = scan_session_detail(&file);

        // 消息侧：两条都在，重复行 token 被清空（与 iter_session_messages 口径一致）
        assert_eq!(messages.len(), 2);
        assert_eq!(summary.message_count, 2);
        assert_eq!(messages[0].input_tokens, Some(100));
        assert_eq!(messages[0].output_tokens, Some(50));
        assert_eq!(messages[0].model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(messages[1].input_tokens, None);
        assert_eq!(messages[1].output_tokens, None);

        // stats 侧：去重后只计一次，不随重复行虚高（与 scan_session_combined 同一口径）
        assert_eq!(stats.input_tokens, 100);
        assert_eq!(stats.output_tokens, 50);
        assert_eq!(stats.token_trend.len(), 1);
    }

    #[test]
    fn scan_session_detail_maps_claude_messages_to_physical_lines() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"summary","summary":"noise"}"#,
                "\n",
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"hello world"}}"#,
                "\n\n",
                r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"part one"},{"type":"text","text":"part two"}]}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"content":"file body"}}]}}"#,
                "\n",
            ),
        );

        let (_, _, messages) = scan_session_detail(&file);

        assert_eq!(messages.len(), 3);
        // 物理行号包含被跳过的 summary 行与空行
        assert_eq!(messages[0].line_index, Some(1));
        assert!(messages[0].editable);
        // 规范文本与展示 content 一致时省略 editable_text
        assert_eq!(messages[0].editable_text, None);
        assert_eq!(messages[1].line_index, Some(3));
        assert!(messages[1].editable);
        // 多 text 块：展示 content 以 \n 连接，规范文本以 \n\n 连接，不一致时必须显式返回
        assert_eq!(
            messages[1].editable_text.as_deref(),
            Some("part one\n\npart two")
        );
        // tool_use 行没有规范文本块，禁止编辑但保留行号（供只读定位）
        assert_eq!(messages[2].line_index, Some(4));
        assert!(!messages[2].editable);
        assert_eq!(messages[2].editable_text, None);
    }

    #[test]
    fn scan_session_detail_maps_codex_messages_to_physical_lines() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        write_text(
            &file,
            concat!(
                r#"{"type":"session_meta","payload":{"id":"s1","cwd":"D:\\work"}}"#,
                "\n",
                r#"{"type":"response_item","timestamp":"2026-03-08T06:31:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"question"}]}}"#,
                "\n",
                r#"{"type":"event_msg","timestamp":"2026-03-08T06:31:00Z","payload":{"type":"user_message","message":"question"}}"#,
                "\n",
                r#"{"type":"response_item","timestamp":"2026-03-08T06:32:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}}"#,
                "\n",
            ),
        );

        let (_, _, messages) = scan_session_detail(&file);

        // event_msg 行不产生消息，但仍占物理行号
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].line_index, Some(1));
        assert!(messages[0].editable);
        assert_eq!(messages[0].editable_text, None);
        assert_eq!(messages[1].line_index, Some(3));
        assert!(messages[1].editable);
    }

    #[test]
    fn build_session_detail_blanks_line_mapping_for_aggregated_subtask_messages() {
        let temp_dir = TempDir::new().unwrap();
        let parent_file = temp_dir.path().join("rollout-session.jsonl");
        let child_file = temp_dir.path().join("subagents").join("agent-child.jsonl");
        write_text(
            &parent_file,
            concat!(
                r#"{"type":"user","uuid":"u1","timestamp":"2026-06-26T10:00:00Z","message":{"role":"user","content":"parent"}}"#,
                "\n",
            ),
        );
        write_text(
            &child_file,
            concat!(
                r#"{"type":"user","uuid":"c1","timestamp":"2026-06-26T10:01:00Z","message":{"role":"user","content":"child"}}"#,
                "\n",
            ),
        );
        let file_ref = SessionFileRef {
            source: "claude".to_string(),
            project_key: "CLI-Manager".to_string(),
            path: parent_file,
        };

        let detail = build_session_detail(&file_ref, true).unwrap();

        assert_eq!(detail.messages.len(), 2);
        let parent = detail
            .messages
            .iter()
            .find(|m| m.content == "parent")
            .unwrap();
        let child = detail
            .messages
            .iter()
            .find(|m| m.content == "child")
            .unwrap();
        // 父会话消息保留行映射；子任务消息属于其他文件，必须清空行映射并禁用编辑
        assert_eq!(parent.line_index, Some(0));
        assert!(parent.editable);
        assert_eq!(child.line_index, None);
        assert!(!child.editable);
        assert_eq!(child.editable_text, None);
    }

    #[test]
    fn scan_session_detail_backfills_assistant_model_from_turn_context() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        let turn_context = r#"{"type":"turn_context","payload":{"model":"gpt-5-codex"}}"#;
        let message = r#"{"type":"response_item","timestamp":"2026-03-08T06:32:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#;
        write_text(&file, &format!("{turn_context}\n{message}\n"));

        let (_, _, messages) = scan_session_detail(&file);

        // 消息行不带 model，回填最近 turn_context 的模型（detail 单遍路径与 iter_session_messages 一致）
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(
            messages[0].timestamp.as_deref(),
            Some("2026-03-08T06:32:00Z")
        );
    }

    #[test]
    fn scan_session_detail_backfills_codex_token_count_to_latest_assistant_message() {
        let temp_dir = TempDir::new().unwrap();
        let file = temp_dir.path().join("rollout-session.jsonl");
        let message = r#"{"type":"response_item","timestamp":"2026-03-08T06:32:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#;
        let token_count = r#"{"type":"event_msg","timestamp":"2026-03-08T06:32:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":50,"total_tokens":150}}}}"#;
        write_text(&file, &format!("{message}\n{token_count}\n"));

        let (_, stats, messages) = scan_session_detail(&file);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].input_tokens, Some(90));
        assert_eq!(messages[0].output_tokens, Some(50));
        assert_eq!(messages[0].cache_read_tokens, Some(10));
        assert_eq!(messages[0].cache_creation_tokens, None);
        assert_eq!(stats.input_tokens, 90);
        assert_eq!(stats.output_tokens, 50);
        assert_eq!(stats.cache_read_tokens, 10);
    }
}
