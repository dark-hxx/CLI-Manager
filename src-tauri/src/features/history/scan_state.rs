use super::{
    normalize_config_dir, path_to_key, HistoryFileChangeSummary, HistoryMessage,
    HistorySessionSummary, HistoryStatsResponse, HistoryTokenTrendPoint, HistoryToolEvent,
    UsageStatsScan,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock};

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct HistoryRoots {
    pub(super) claude_config_dir: Option<PathBuf>,
    pub(super) codex_config_dir: Option<PathBuf>,
    pub(super) grok_session_root: Option<PathBuf>,
    pub(super) kimi_config_dir: Option<PathBuf>,
}

impl HistoryRoots {
    // 将各显式历史根目录及默认标记组合成缓存键。
    pub(super) fn cache_key(&self) -> String {
        format!(
            "claude={}|codex={}|grok={}|kimi={}",
            self.claude_config_dir
                .as_deref()
                .map(path_to_key)
                .unwrap_or_else(|| "__default__".to_string()),
            self.codex_config_dir
                .as_deref()
                .map(path_to_key)
                .unwrap_or_else(|| "__default__".to_string()),
            self.grok_session_root
                .as_deref()
                .map(path_to_key)
                .unwrap_or_else(|| "__default__".to_string()),
            self.kimi_config_dir
                .as_deref()
                .map(path_to_key)
                .unwrap_or_else(|| "__default__".to_string())
        )
    }

    // 规范化 Kimi 配置目录并返回更新后的根目录配置。
    pub(crate) fn with_kimi_config_dir(mut self, kimi_config_dir: Option<String>) -> Self {
        self.kimi_config_dir = normalize_config_dir(kimi_config_dir);
        self
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SessionFileRef {
    pub(crate) source: String,
    pub(crate) project_key: String,
    pub(crate) path: PathBuf,
}

#[derive(Clone)]
pub(super) struct SessionSummaryScan {
    pub(super) session_id: Option<String>,
    pub(super) parent_session_id: Option<String>,
    pub(super) message_count: usize,
    pub(super) first_user_message: Option<String>,
    pub(super) first_message: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) first_timestamp_ms: Option<i64>,
    pub(super) last_timestamp_ms: Option<i64>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct SessionStatsScan {
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) cache_creation_tokens: u64,
    pub(super) total_cost_usd: f64,
    pub(super) unpriced_tokens: u64,
    pub(super) dominant_model: Option<String>,
    pub(super) current_model: Option<String>,
    pub(super) model_usage: HashMap<String, UsageStatsScan>,
    /// 模型上下文窗口大小（日志显式字段，如 Codex model_context_window / Claude context_window）。
    pub(super) context_window: Option<u64>,
    /// 最近一次请求占用的上下文 token 数。
    pub(super) last_context_tokens: Option<u64>,
    /// Codex turn_context 暴露的模型思考强度（如 high / medium）。
    pub(super) reasoning_effort: Option<String>,
    pub(super) token_trend: Vec<HistoryTokenTrendPoint>,
    #[serde(default)]
    pub(super) usage_events: Vec<SessionUsageEventScan>,
    /// 工具调用总次数（Claude tool_use 块 / Codex function_call）。
    pub(super) tool_call_count: u64,
    /// MCP 服务器 -> 调用次数（工具名 mcp__<server>__<tool>）。
    pub(super) mcp_calls: HashMap<String, u64>,
    /// Skill / 斜杠命令 -> 调用次数。
    pub(super) skill_calls: HashMap<String, u64>,
    /// 内置工具 -> 调用次数（既非 MCP 也非 Skill 的工具，如 Read / Edit / Bash）。
    pub(super) builtin_calls: HashMap<String, u64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct SessionUsageEventScan {
    #[serde(default)]
    pub(super) event_key: String,
    #[serde(default)]
    pub(super) event_index: usize,
    pub(super) timestamp_ms: Option<i64>,
    pub(super) model: Option<String>,
    pub(super) usage: UsageStatsScan,
}

#[derive(Clone, Default)]
pub(super) struct SessionProjectScan {
    pub(super) cwd: Option<String>,
}

#[derive(Clone, Default)]
pub(super) struct CursorSessionMetadata {
    pub(super) title: Option<String>,
    pub(super) created_at: Option<i64>,
    pub(super) updated_at: Option<i64>,
    pub(super) cwd: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct CachedSessionComputation {
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) parent_session_id: Option<String>,
    pub(super) title: String,
    pub(super) message_count: usize,
    pub(super) branch: Option<String>,
    pub(super) stats: SessionStatsScan,
}

pub(super) struct SessionDetailParts {
    pub(super) computed: CachedSessionComputation,
    pub(super) cwd: Option<String>,
    pub(super) messages: Vec<HistoryMessage>,
    pub(super) tool_events: Vec<HistoryToolEvent>,
    pub(super) file_changes: Vec<HistoryFileChangeSummary>,
}

#[derive(Default)]
pub(super) struct SessionProjectCache {
    pub(super) entries: HashMap<String, CachedSessionProjectCacheEntry>,
}

#[derive(Clone)]
pub(super) struct CachedSessionProjectCacheEntry {
    pub(super) fingerprint: SessionFileFingerprint,
    pub(super) scan: SessionProjectScan,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionFileFingerprint {
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(super) size: u64,
}

#[derive(Clone)]
pub(super) struct WslSessionFileHit {
    pub(super) linux_path: String,
    pub(super) project_key: String,
    pub(super) fingerprint: SessionFileFingerprint,
}

#[derive(Clone)]
pub(super) struct CachedWslSessionFingerprint {
    pub(super) fingerprint: SessionFileFingerprint,
    pub(super) cached_at: i64,
}

pub(super) const CODEX_THREAD_NAME_INDEX_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct CodexThreadNameIndex {
    pub(super) names: HashMap<String, String>,
    pub(super) fingerprint: String,
}

pub(super) type WslSessionFingerprintCache = HashMap<String, CachedWslSessionFingerprint>;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct HistoryIndexEntry {
    pub(super) file_ref: SessionFileRef,
    pub(super) fingerprint: SessionFileFingerprint,
    pub(super) computed: CachedSessionComputation,
}

#[derive(Clone, Default)]
pub(super) struct HistorySessionIndex {
    pub(super) roots: HistoryRoots,
    pub(super) entries: Vec<HistoryIndexEntry>,
    pub(super) refreshed_at: i64,
    pub(super) generation: u64,
}

pub(super) static HISTORY_SESSION_INDEX: OnceLock<RwLock<HistorySessionIndex>> = OnceLock::new();

pub(super) const HISTORY_SESSION_INDEX_TTL_MS: i64 = 60_000;

#[derive(Clone)]
pub(super) struct CachedSessionFiles {
    pub(super) timestamp_ms: i64,
    pub(super) files: Vec<SessionFileRef>,
}

#[derive(Default)]
pub(super) struct SessionFilesCache {
    pub(super) by_source: HashMap<String, CachedSessionFiles>,
}

#[derive(Clone)]
pub(super) struct CachedHistoryStatsAggregation {
    pub(super) response: HistoryStatsResponse,
    pub(super) cached_at: i64,
}

#[derive(Default)]
pub(super) struct HistoryStatsAggregationCache {
    pub(super) entries: HashMap<String, CachedHistoryStatsAggregation>,
}

#[derive(Clone)]
pub(super) struct HistoryStatsSessionFact {
    pub(super) summary: HistorySessionSummary,
    pub(super) occurred_at: i64,
    pub(super) stats: UsageStatsScan,
    pub(super) model: Option<String>,
}

pub(super) struct OpenCodeParsedSession {
    pub(super) file_ref: SessionFileRef,
    pub(super) fingerprint: SessionFileFingerprint,
    pub(super) computed: CachedSessionComputation,
    pub(super) cwd: Option<String>,
    pub(super) messages: Vec<HistoryMessage>,
    pub(super) tool_events: Vec<HistoryToolEvent>,
}

#[derive(Clone)]
pub(super) struct CachedHistoryStatsDailyIndex {
    pub(super) days: BTreeMap<i64, Vec<HistoryStatsSessionFact>>,
    pub(super) cached_at: i64,
}

#[derive(Default)]
pub(super) struct HistoryStatsDailyIndexCache {
    pub(super) entries: HashMap<String, CachedHistoryStatsDailyIndex>,
}

pub(super) const HOUR_MS: i64 = 60 * 60 * 1000;
pub(super) const DAY_MS: i64 = 24 * HOUR_MS;
pub(super) const MAX_STATS_RANGE_DAYS: usize = 366;
pub(super) const HISTORY_STATS_AGGREGATION_CACHE_MAX: usize = 32;
pub(super) const HISTORY_STATS_DAILY_INDEX_CACHE_MAX: usize = 16;
pub(super) static SESSION_PROJECT_CACHE: OnceLock<Mutex<SessionProjectCache>> = OnceLock::new();
pub(super) static SESSION_FILES_CACHE: OnceLock<Mutex<SessionFilesCache>> = OnceLock::new();
pub(super) static WSL_SESSION_FINGERPRINT_CACHE: OnceLock<Mutex<WslSessionFingerprintCache>> =
    OnceLock::new();
pub(super) static HISTORY_STATS_AGGREGATION_CACHE: OnceLock<Mutex<HistoryStatsAggregationCache>> =
    OnceLock::new();
pub(super) static HISTORY_STATS_DAILY_INDEX_CACHE: OnceLock<Mutex<HistoryStatsDailyIndexCache>> =
    OnceLock::new();
pub(super) static REMOTE_HISTORY_DETAIL_CACHE: OnceLock<Mutex<RemoteHistoryDetailCache>> =
    OnceLock::new();

pub(super) const REMOTE_HISTORY_DETAIL_CACHE_MAX: usize = 20;
pub(super) const REMOTE_HISTORY_DETAIL_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub(super) struct RemoteHistoryDetailCache {
    pub(super) entries: VecDeque<(String, Value, usize)>,
    pub(super) bytes: usize,
}

impl RemoteHistoryDetailCache {
    // 克隆命中的远程详情，并将该条目移动到最近使用端。
    pub(super) fn get(&mut self, key: &str) -> Option<Value> {
        let index = self.entries.iter().position(|entry| entry.0 == key)?;
        let entry = self.entries.remove(index)?;
        let value = entry.1.clone();
        self.entries.push_back(entry);
        Some(value)
    }

    // 按序列化字节数和条目上限淘汰旧详情，拒绝单条超限值。
    pub(super) fn insert(&mut self, key: String, value: Value) {
        let size = serde_json::to_vec(&value).map_or(0, |bytes| bytes.len());
        if size > REMOTE_HISTORY_DETAIL_CACHE_BYTES {
            return;
        }
        if let Some(index) = self.entries.iter().position(|entry| entry.0 == key) {
            if let Some(removed) = self.entries.remove(index) {
                self.bytes = self.bytes.saturating_sub(removed.2);
            }
        }
        while self.entries.len() >= REMOTE_HISTORY_DETAIL_CACHE_MAX
            || self.bytes.saturating_add(size) > REMOTE_HISTORY_DETAIL_CACHE_BYTES
        {
            let Some(removed) = self.entries.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.2);
        }
        self.bytes = self.bytes.saturating_add(size);
        self.entries.push_back((key, value, size));
    }

    // 移除指定来源实例前缀的详情条目，并扣减缓存字节计数。
    pub(super) fn invalidate_instance(&mut self, source_instance_id: &str) {
        let prefix = format!("{source_instance_id}:");
        self.entries.retain(|(key, _, size)| {
            if key.starts_with(&prefix) {
                self.bytes = self.bytes.saturating_sub(*size);
                false
            } else {
                true
            }
        });
    }
}

// 惰性初始化并返回全局远程详情缓存互斥锁。
pub(super) fn remote_history_detail_cache() -> &'static Mutex<RemoteHistoryDetailCache> {
    REMOTE_HISTORY_DETAIL_CACHE.get_or_init(|| Mutex::new(RemoteHistoryDetailCache::default()))
}
