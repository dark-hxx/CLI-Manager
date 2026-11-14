use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::Manager;

use crate::provider::network_client;

const LITELLM_PRICES_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const MIN_CANDIDATE_SCORE: f64 = 0.70;
const MAX_SYNC_TARGETS: usize = 500;
const MAX_CANDIDATES_PER_TARGET: usize = 5;
const REMOTE_FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const REMOTE_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// 远端快照在该时间内视为新鲜，直接复用不发请求（覆盖连续单行同步）。
const REMOTE_FRESH_MS: i64 = 2 * 60 * 1000;
/// 磁盘快照格式版本；解析逻辑变化时递增，使旧快照失效。
const REMOTE_SNAPSHOT_SCHEMA: u32 = 1;
const REMOTE_CACHE_DIR: &str = "model-prices-cache";
/// OpenRouter 原始条目中价格与上下文解析实际用到的字段，其余（描述、参数列表等）丢弃。
const OPENROUTER_RAW_KEYS: &[&str] = &[
    "id",
    "canonical_slug",
    "name",
    "context_length",
    "pricing",
    "top_provider",
];

static LITELLM_SNAPSHOT: OnceLock<tokio::sync::Mutex<Option<Arc<RemoteSourceSnapshot>>>> =
    OnceLock::new();
static OPENROUTER_SNAPSHOT: OnceLock<tokio::sync::Mutex<Option<Arc<RemoteSourceSnapshot>>>> =
    OnceLock::new();

static MODEL_PRICE_CACHE: OnceLock<RwLock<HashMap<String, ModelPriceEntry>>> = OnceLock::new();
static MODEL_PRICE_CACHE_LOADED: OnceLock<RwLock<bool>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceEntry {
    pub model: String,
    pub input_per_1m: f64,
    pub output_per_1m: f64,
    pub cache_read_per_1m: f64,
    pub cache_creation_per_1m: f64,
    pub source: String,
    pub source_model_id: Option<String>,
    pub raw_json: Option<String>,
    pub updated_at_ms: i64,
    pub synced_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelPrice {
    pub model: String,
    pub input_per_1m: f64,
    pub output_per_1m: f64,
    pub cache_read_per_1m: f64,
    pub cache_creation_per_1m: f64,
    pub source: String,
    pub source_model_id: String,
    pub raw_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceSyncCandidate {
    pub target_model: String,
    pub score: f64,
    pub remote: RemoteModelPrice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceSyncMatch {
    pub target_model: String,
    pub score: f64,
    pub remote: RemoteModelPrice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceSyncResult {
    pub matched: Vec<ModelPriceSyncMatch>,
    pub candidates: Vec<ModelPriceSyncCandidate>,
    pub unmatched: Vec<String>,
    pub fetched_count: usize,
    /// 本次拉取失败、改用本地旧快照的价格源。
    pub stale_sources: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CachedModelPricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_creation_per_million: f64,
}

#[derive(Debug, Clone)]
pub enum CachedModelPricingLookup {
    CacheUnavailable,
    Found(CachedModelPricing),
    Missing,
}

#[tauri::command]
// 过滤无效价格并整体替换运行时缓存，标记已加载后失效历史统计缓存。
pub fn model_prices_set_cache(prices: Vec<ModelPriceEntry>) -> Result<(), String> {
    let mut next = HashMap::new();
    for price in prices {
        if !is_valid_price_entry(&price) {
            continue;
        }
        if let Some(normalized) = normalize_model_id(&price.model) {
            next.insert(normalized, price);
        }
    }

    let cache = MODEL_PRICE_CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    let mut guard = cache
        .write()
        .map_err(|_| "model price cache lock poisoned".to_string())?;
    *guard = next;

    let loaded = MODEL_PRICE_CACHE_LOADED.get_or_init(|| RwLock::new(false));
    let mut loaded_guard = loaded
        .write()
        .map_err(|_| "model price cache loaded flag lock poisoned".to_string())?;
    *loaded_guard = true;
    super::history::invalidate_history_stats_caches();
    Ok(())
}

#[tauri::command]
// 获取远端价格并按目标模型分类为确定匹配、候选和未匹配，不写数据库。
pub async fn model_prices_sync(
    app: tauri::AppHandle,
    targets: Vec<String>,
) -> Result<ModelPriceSyncResult, String> {
    if targets.len() > MAX_SYNC_TARGETS {
        return Err(format!(
            "too many model price sync targets: {} (max {MAX_SYNC_TARGETS})",
            targets.len()
        ));
    }

    let cache_dir = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(REMOTE_CACHE_DIR));
    let remote = fetch_remote_prices(cache_dir.as_deref()).await?;

    // 匹配是纯 CPU 计算（数百目标 × 数千远端），放到阻塞线程避免占用异步运行时。
    tauri::async_runtime::spawn_blocking(move || match_targets(targets, remote))
        .await
        .map_err(|err| format!("model price matching task failed: {err}"))
}

// 在合并后的远端价格上为每个目标模型分类：索引直达的确定匹配、候选和未匹配。
fn match_targets(targets: Vec<String>, remote: RemotePriceSet) -> ModelPriceSyncResult {
    let mut remote_prices: Vec<&RemoteModelPrice> = remote
        .snapshots
        .iter()
        .flat_map(|snapshot| snapshot.prices.iter())
        .collect();
    remote_prices.sort_by(|a, b| source_priority(&a.source).cmp(&source_priority(&b.source)));
    let mut seen_remote = HashSet::new();
    remote_prices.retain(|price| seen_remote.insert(normalize_for_compare(&price.model)));
    let index = RemoteIndex::new(remote_prices);

    let mut seen_targets = HashSet::new();
    let mut matched = Vec::new();
    let mut candidates = Vec::new();
    let mut unmatched = Vec::new();

    for target in targets
        .into_iter()
        .map(|target| target.trim().to_string())
        .filter(|target| !target.is_empty())
        .filter(|target| seen_targets.insert(normalize_for_compare(target)))
    {
        let features = ModelFeatures::new(&target);
        if let Some(best) = index.auto_match(&target, &features) {
            matched.push(ModelPriceSyncMatch {
                target_model: target,
                score: best.score,
                remote: best.remote.clone(),
            });
            continue;
        }

        let ranked = index.rank(&target, &features);
        if ranked.is_empty() {
            unmatched.push(target);
            continue;
        }

        let best = &ranked[0];
        if is_auto_match_kind(best.kind) {
            matched.push(ModelPriceSyncMatch {
                target_model: target,
                score: best.score,
                remote: best.remote.clone(),
            });
            continue;
        }

        candidates.extend(
            ranked
                .into_iter()
                .take(MAX_CANDIDATES_PER_TARGET)
                .map(|candidate| ModelPriceSyncCandidate {
                    target_model: target.clone(),
                    score: candidate.score,
                    remote: candidate.remote.clone(),
                }),
        );
    }

    ModelPriceSyncResult {
        matched,
        candidates,
        unmatched,
        fetched_count: index.items.len(),
        stale_sources: remote.stale_sources,
    }
}

// 查询已加载的价格缓存，区分命中、缺失和缓存不可用。
pub fn find_cached_model_pricing(model: &str) -> CachedModelPricingLookup {
    let Some(normalized) = normalize_model_id(model) else {
        return CachedModelPricingLookup::Missing;
    };
    let loaded = MODEL_PRICE_CACHE_LOADED.get_or_init(|| RwLock::new(false));
    let Ok(loaded_guard) = loaded.read() else {
        return CachedModelPricingLookup::CacheUnavailable;
    };
    if !*loaded_guard {
        return CachedModelPricingLookup::CacheUnavailable;
    }
    drop(loaded_guard);

    let cache = MODEL_PRICE_CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    let Ok(guard) = cache.read() else {
        return CachedModelPricingLookup::CacheUnavailable;
    };

    let Some(exact) = find_model_price_entry(&guard, &normalized) else {
        return CachedModelPricingLookup::Missing;
    };

    CachedModelPricingLookup::Found(CachedModelPricing {
        input_per_million: exact.input_per_1m,
        output_per_million: exact.output_per_1m,
        cache_read_per_million: exact.cache_read_per_1m,
        cache_creation_per_million: exact.cache_creation_per_1m,
    })
}

// 优先查找规范键，缺失时选择最长的兼容版本价格键。
fn find_model_price_entry<'a>(
    prices: &'a HashMap<String, ModelPriceEntry>,
    normalized: &str,
) -> Option<&'a ModelPriceEntry> {
    prices.get(normalized).or_else(|| {
        prices
            .iter()
            .filter(|(key, _)| is_pricing_variant_of(normalized, key))
            .max_by_key(|(key, _)| key.len())
            .map(|(_, value)| value)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchKind {
    Exact,
    CaseInsensitive,
    Tail,
    Normalized,
    ReasoningVariant,
    Alnum,
    /// Shorter model id is a continuous dash-token prefix of the longer one
    /// (e.g. `grok-4.5` vs `grok-4.5-build-free`). Candidate only, never auto-apply.
    BasePrefix,
    Fuzzy,
}

#[derive(Debug, Clone)]
struct RankedRemotePrice<'a> {
    score: f64,
    kind: MatchKind,
    remote: &'a RemoteModelPrice,
}

// 仅允许精确、忽略大小写或完整规范化匹配自动应用。
fn is_auto_match_kind(kind: MatchKind) -> bool {
    matches!(
        kind,
        MatchKind::Exact | MatchKind::CaseInsensitive | MatchKind::Normalized
    )
}

/// 某个价格源的已解析快照，内存与磁盘共用同一结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSourceSnapshot {
    schema: u32,
    etag: Option<String>,
    last_modified: Option<String>,
    fetched_at_ms: i64,
    prices: Vec<RemoteModelPrice>,
}

/// 本次同步可用的远端价格快照集合，以及因拉取失败改用旧快照的来源。
struct RemotePriceSet {
    snapshots: Vec<Arc<RemoteSourceSnapshot>>,
    stale_sources: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
enum RemoteSource {
    LiteLlm,
    OpenRouter,
}

impl RemoteSource {
    fn key(self) -> &'static str {
        match self {
            Self::LiteLlm => "litellm",
            Self::OpenRouter => "openrouter",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::LiteLlm => "LiteLLM",
            Self::OpenRouter => "OpenRouter",
        }
    }

    fn url(self) -> &'static str {
        match self {
            Self::LiteLlm => LITELLM_PRICES_URL,
            Self::OpenRouter => OPENROUTER_MODELS_URL,
        }
    }

    // 进程内快照槽；持锁期间完成拉取，并发同步会排队复用同一次结果。
    fn slot(self) -> &'static tokio::sync::Mutex<Option<Arc<RemoteSourceSnapshot>>> {
        let cell = match self {
            Self::LiteLlm => &LITELLM_SNAPSHOT,
            Self::OpenRouter => &OPENROUTER_SNAPSHOT,
        };
        cell.get_or_init(|| tokio::sync::Mutex::new(None))
    }

    fn parse(self, value: Value) -> Vec<RemoteModelPrice> {
        match self {
            Self::LiteLlm => parse_litellm_prices(value),
            Self::OpenRouter => parse_openrouter_prices(value),
        }
    }
}

enum FetchOutcome {
    NotModified,
    Updated(RemoteSourceSnapshot),
}

// 并发读取两个价格源（各自走缓存/条件请求），只要存在可用价格就返回。
async fn fetch_remote_prices(cache_dir: Option<&Path>) -> Result<RemotePriceSet, String> {
    let client = network_client::configure_builder(reqwest::Client::builder())?
        .user_agent("CLI-Manager model pricing sync")
        .timeout(REMOTE_FETCH_TIMEOUT)
        .connect_timeout(REMOTE_CONNECT_TIMEOUT)
        .build()
        .map_err(|err| format!("failed to create HTTP client: {err}"))?;

    let (litellm_result, openrouter_result) = tokio::join!(
        load_source(&client, RemoteSource::LiteLlm, cache_dir),
        load_source(&client, RemoteSource::OpenRouter, cache_dir)
    );

    let mut errors = Vec::new();
    let mut set = RemotePriceSet {
        snapshots: Vec::new(),
        stale_sources: Vec::new(),
    };
    for (source, result) in [
        (RemoteSource::LiteLlm, litellm_result),
        (RemoteSource::OpenRouter, openrouter_result),
    ] {
        match result {
            Ok((snapshot, stale)) => {
                if stale {
                    set.stale_sources.push(source.key().to_string());
                }
                set.snapshots.push(snapshot);
            }
            Err(err) => errors.push(err),
        }
    }

    if set.snapshots.iter().all(|snapshot| snapshot.prices.is_empty()) {
        let detail = if errors.is_empty() {
            "remote price sources returned no usable models".to_string()
        } else {
            errors.join("; ")
        };
        return Err(detail);
    }
    Ok(set)
}

// 取得单个价格源快照：新鲜则直接复用，否则条件请求；网络失败时回退旧快照并标记 stale。
async fn load_source(
    client: &reqwest::Client,
    source: RemoteSource,
    cache_dir: Option<&Path>,
) -> Result<(Arc<RemoteSourceSnapshot>, bool), String> {
    let mut slot = source.slot().lock().await;
    if slot.is_none() {
        if let Some(path) = snapshot_path(cache_dir, source) {
            *slot = read_snapshot(&path).await.map(Arc::new);
        }
    }

    let now = now_ms();
    if let Some(snapshot) = slot.as_ref() {
        if (0..REMOTE_FRESH_MS).contains(&(now - snapshot.fetched_at_ms)) {
            return Ok((snapshot.clone(), false));
        }
    }

    match fetch_source(client, source, slot.as_deref()).await {
        Ok(outcome) => {
            let next = match (outcome, slot.as_deref()) {
                (FetchOutcome::NotModified, Some(previous)) => RemoteSourceSnapshot {
                    fetched_at_ms: now,
                    ..previous.clone()
                },
                (FetchOutcome::NotModified, None) => {
                    return Err(format!(
                        "{} price source returned 304 without a local snapshot",
                        source.label()
                    ));
                }
                (FetchOutcome::Updated(snapshot), _) => snapshot,
            };
            let next = Arc::new(next);
            if let Some(path) = snapshot_path(cache_dir, source) {
                write_snapshot(&path, &next).await;
            }
            *slot = Some(next.clone());
            Ok((next, false))
        }
        Err(err) => match slot.as_ref() {
            Some(snapshot) => {
                log::warn!("{err}; falling back to cached {} prices", source.label());
                Ok((snapshot.clone(), true))
            }
            None => Err(err),
        },
    }
}

// 携带 ETag / Last-Modified 发起条件请求，304 表示本地快照仍有效。
async fn fetch_source(
    client: &reqwest::Client,
    source: RemoteSource,
    previous: Option<&RemoteSourceSnapshot>,
) -> Result<FetchOutcome, String> {
    let label = source.label();
    let mut request = client.get(source.url());
    if let Some(previous) = previous {
        if let Some(etag) = previous.etag.as_deref() {
            request = request.header(IF_NONE_MATCH, etag);
        }
        if let Some(last_modified) = previous.last_modified.as_deref() {
            request = request.header(IF_MODIFIED_SINCE, last_modified);
        }
    }

    let response = request
        .send()
        .await
        .map_err(|err| format!("failed to fetch {label} prices: {err}"))?;
    if response.status() == StatusCode::NOT_MODIFIED {
        return Ok(FetchOutcome::NotModified);
    }
    if !response.status().is_success() {
        return Err(format!("{label} price source returned {}", response.status()));
    }

    let header_text = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let etag = header_text(ETAG);
    let last_modified = header_text(LAST_MODIFIED);
    let body = response
        .bytes()
        .await
        .map_err(|err| format!("failed to read {label} prices: {err}"))?;

    // 数 MB 的 JSON 解析放到阻塞线程。
    let prices = tauri::async_runtime::spawn_blocking(move || {
        serde_json::from_slice::<Value>(&body)
            .map(|value| source.parse(value))
            .map_err(|err| format!("failed to parse {label} prices: {err}"))
    })
    .await
    .map_err(|err| format!("{label} price parsing task failed: {err}"))??;

    Ok(FetchOutcome::Updated(RemoteSourceSnapshot {
        schema: REMOTE_SNAPSHOT_SCHEMA,
        etag,
        last_modified,
        fetched_at_ms: now_ms(),
        prices,
    }))
}

// 价格源快照在磁盘缓存目录中的文件路径。
fn snapshot_path(cache_dir: Option<&Path>, source: RemoteSource) -> Option<PathBuf> {
    cache_dir.map(|dir| dir.join(format!("{}.json", source.key())))
}

// 读取磁盘快照；文件缺失、损坏或格式版本不符时视为无快照。
async fn read_snapshot(path: &Path) -> Option<RemoteSourceSnapshot> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let snapshot: RemoteSourceSnapshot = serde_json::from_slice(&bytes).ok()?;
    (snapshot.schema == REMOTE_SNAPSHOT_SCHEMA).then_some(snapshot)
}

// 先写临时文件再改名，避免中断留下半截快照；失败只记日志，不影响本次同步。
async fn write_snapshot(path: &Path, snapshot: &RemoteSourceSnapshot) {
    let result = async {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec(snapshot)?;
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, bytes).await?;
        tokio::fs::rename(&tmp, path).await?;
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    }
    .await;
    if let Err(err) = result {
        log::warn!(
            "failed to persist model price snapshot {}: {err}",
            path.display()
        );
    }
}

// 当前 Unix 毫秒时间戳。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

// 解析 LiteLLM 模型价格并转换为每百万 Token 单位。
fn parse_litellm_prices(value: Value) -> Vec<RemoteModelPrice> {
    let Value::Object(object) = value else {
        return Vec::new();
    };

    let mut prices = Vec::new();
    for (model, raw) in object {
        if !raw.is_object() {
            continue;
        }
        let input = number_field(&raw, &["input_cost_per_token", "prompt_cost_per_token"]);
        let output = number_field(&raw, &["output_cost_per_token", "completion_cost_per_token"]);
        if input.is_none() && output.is_none() {
            continue;
        }
        prices.push(RemoteModelPrice {
            input_per_1m: per_million(input),
            output_per_1m: per_million(output),
            cache_read_per_1m: per_million(number_field(
                &raw,
                &[
                    "cache_read_input_token_cost",
                    "input_cost_per_token_cache_read",
                ],
            )),
            cache_creation_per_1m: per_million(number_field(
                &raw,
                &[
                    "cache_creation_input_token_cost",
                    "input_cost_per_token_cache_creation",
                ],
            )),
            source: RemoteSource::LiteLlm.key().to_string(),
            source_model_id: model.clone(),
            raw_json: raw.to_string(),
            model,
        });
    }
    prices
}

// 解析 OpenRouter 模型目录，原始元数据只保留价格与上下文相关字段。
fn parse_openrouter_prices(mut value: Value) -> Vec<RemoteModelPrice> {
    let Some(Value::Array(models)) = value.get_mut("data").map(Value::take) else {
        return Vec::new();
    };

    let mut prices = Vec::new();
    for item in models {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let pricing = item.get("pricing").unwrap_or(&Value::Null);
        let input = number_field(pricing, &["prompt"]);
        let output = number_field(pricing, &["completion"]);
        if input.is_none() && output.is_none() {
            continue;
        }
        prices.push(RemoteModelPrice {
            model: id.to_string(),
            input_per_1m: per_million(input),
            output_per_1m: per_million(output),
            cache_read_per_1m: openrouter_cache_read_per_million(pricing),
            cache_creation_per_1m: openrouter_cache_creation_per_million(pricing),
            source: RemoteSource::OpenRouter.key().to_string(),
            source_model_id: id.to_string(),
            raw_json: slim_openrouter_raw(&item).to_string(),
        });
    }
    prices
}

// 只保留 OPENROUTER_RAW_KEYS 中的字段，缩小同步结果、数据库与 WebDAV 体积。
fn slim_openrouter_raw(item: &Value) -> Value {
    let Some(object) = item.as_object() else {
        return item.clone();
    };
    let slim: Map<String, Value> = OPENROUTER_RAW_KEYS
        .iter()
        .filter_map(|key| object.get(*key).map(|value| (key.to_string(), value.clone())))
        .collect();
    Value::Object(slim)
}

// 按兼容字段优先级读取 OpenRouter 缓存命中单价。
fn openrouter_cache_read_per_million(pricing: &Value) -> f64 {
    per_million(number_field(
        pricing,
        &["input_cache_read", "cache_read", "cache"],
    ))
}

// 按兼容字段优先级读取 OpenRouter 缓存写入单价。
fn openrouter_cache_creation_per_million(pricing: &Value) -> f64 {
    per_million(number_field(
        pricing,
        &["input_cache_write", "cache_creation", "cache_write"],
    ))
}

/// 模型名的匹配特征；远端只计算一次，目标每个计算一次。
#[derive(Debug)]
struct ModelFeatures {
    norm: String,
    tail: String,
    alnum: String,
    tokens: Vec<String>,
    /// alnum 的 ASCII 字符集合位图，用于 O(1) 计算 Jaccard。
    char_mask: u128,
}

impl ModelFeatures {
    // 一次性计算规范键、末级名称、字母数字串、词元与字符位图。
    fn new(model: &str) -> Self {
        let norm = normalize_for_compare(model);
        // 规范化模型标识的末级名称。
        let tail = norm.rsplit('/').next().unwrap_or_default().to_string();
        let alnum = normalized_alnum(&tail);
        let tokens = model_tokens(&tail);
        let char_mask = alnum
            .bytes()
            .fold(0u128, |mask, byte| mask | (1u128 << (byte & 0x7f)));
        Self {
            norm,
            tail,
            alnum,
            tokens,
            char_mask,
        }
    }
}

struct PreparedRemote<'a> {
    price: &'a RemoteModelPrice,
    features: ModelFeatures,
}

/// 预处理后的远端价格：特征只算一次，并按规范键建立直达索引。
struct RemoteIndex<'a> {
    items: Vec<PreparedRemote<'a>>,
    by_norm: HashMap<String, usize>,
}

impl<'a> RemoteIndex<'a> {
    // 预计算全部远端特征并建立规范键索引（同键保留排序靠前者）。
    fn new(prices: Vec<&'a RemoteModelPrice>) -> Self {
        let items: Vec<PreparedRemote<'a>> = prices
            .into_iter()
            .map(|price| PreparedRemote {
                features: ModelFeatures::new(&price.model),
                price,
            })
            .collect();
        let mut by_norm = HashMap::with_capacity(items.len());
        for (idx, item) in items.iter().enumerate() {
            by_norm.entry(item.features.norm.clone()).or_insert(idx);
        }
        Self { items, by_norm }
    }

    // 规范键直接命中即为可自动应用的最佳匹配（精确/忽略大小写/规范化），无需全量打分。
    // 远端已按规范键去重，且其余匹配类型分数均低于 Normalized，结果与全量排序一致。
    fn auto_match(&self, target: &str, features: &ModelFeatures) -> Option<RankedRemotePrice<'a>> {
        let item = &self.items[*self.by_norm.get(&features.norm)?];
        let (score, kind) = if target.trim() == item.price.model.trim() {
            (1.0, MatchKind::Exact)
        } else if target.trim().eq_ignore_ascii_case(item.price.model.trim()) {
            (0.995, MatchKind::CaseInsensitive)
        } else {
            (0.99, MatchKind::Normalized)
        };
        Some(RankedRemotePrice {
            score,
            kind,
            remote: item.price,
        })
    }

    // 按模型身份、推理变体和相似度排序达到阈值的远端候选。
    fn rank(&self, target: &str, t: &ModelFeatures) -> Vec<RankedRemotePrice<'a>> {
        let target_base_norm = strip_reasoning_effort_suffix(&t.norm);
        let mut ranked = Vec::new();

        for item in &self.items {
            let remote = item.price;
            let r = &item.features;

            let (score, kind) = if target.trim() == remote.model.trim() {
                (1.0, MatchKind::Exact)
            } else if target.trim().eq_ignore_ascii_case(remote.model.trim()) {
                (0.995, MatchKind::CaseInsensitive)
            } else if t.norm == r.norm {
                (0.99, MatchKind::Normalized)
            } else if target_base_norm == Some(r.norm.as_str()) {
                (0.975, MatchKind::ReasoningVariant)
            } else if t.tail == r.tail {
                (0.98, MatchKind::Tail)
            } else if !t.alnum.is_empty() && t.alnum == r.alnum {
                (0.96, MatchKind::Alnum)
            } else if let Some(prefix_score) = token_prefix_base_score(&t.tokens, &r.tokens) {
                (prefix_score, MatchKind::BasePrefix)
            } else {
                let Some(score) = fuzzy_score(t, r) else {
                    continue;
                };
                (score, MatchKind::Fuzzy)
            };

            if score >= MIN_CANDIDATE_SCORE {
                ranked.push(RankedRemotePrice {
                    score,
                    kind,
                    remote,
                });
            }
        }

        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    source_priority(&a.remote.source).cmp(&source_priority(&b.remote.source))
                })
                .then_with(|| a.remote.model.cmp(&b.remote.model))
        });
        ranked
    }
}

// 模糊相似度；先用编辑距离上界剪枝，确定达不到阈值时跳过 O(n·m) 的 Levenshtein。
fn fuzzy_score(t: &ModelFeatures, r: &ModelFeatures) -> Option<f64> {
    let jaccard_score = jaccard_mask(&t.alnum, t.char_mask, &r.alnum, r.char_mask);
    let token_score = token_containment(&t.tokens, &r.tokens);
    let partial = (token_score * 0.55) + (jaccard_score * 0.20);
    if partial + levenshtein_upper_bound(&t.alnum, &r.alnum) * 0.25 + 1e-9 < MIN_CANDIDATE_SCORE {
        return None;
    }
    let levenshtein_score = levenshtein_similarity(&t.alnum, &r.alnum);
    Some((token_score * 0.55) + (levenshtein_score * 0.25) + (jaccard_score * 0.20))
}

#[cfg(test)]
// 测试辅助：对原始远端列表建索引后排序。
fn rank_candidates<'a>(
    target: &str,
    remotes: &'a [RemoteModelPrice],
) -> Vec<RankedRemotePrice<'a>> {
    let index = RemoteIndex::new(remotes.iter().collect());
    let ranked = index.rank(target, &ModelFeatures::new(target));
    ranked
}

// 规范化模型名称、来源前缀及版本后缀，保留推理强度差异。
pub fn normalize_model_id(model: &str) -> Option<String> {
    let mut value = model.trim().to_lowercase();
    if let Some(idx) = value.find('[') {
        value.truncate(idx);
    }
    value = normalize_reasoning_effort_parenthetical_suffix(&value);
    value = value.trim().to_string();
    if value.is_empty() || value == "unknown" {
        return None;
    }
    value = value
        .strip_prefix("us.anthropic.com/")
        .unwrap_or(&value)
        .to_string();
    if let Some((_, tail)) = value.rsplit_once('/') {
        value = tail.to_string();
    }
    if let Some((head, _)) = value.split_once(':') {
        value = head.to_string();
    }
    value = value.replace('@', "-").replace('.', "-");
    while let Some(stripped) = value.strip_prefix("global-anthropic-") {
        value = stripped.to_string();
    }
    while let Some(stripped) = value.strip_prefix("anthropic-") {
        value = stripped.to_string();
    }
    if let Some(stripped) = value.strip_prefix("claude-gpt-") {
        value = format!("gpt-{stripped}");
    }
    value = strip_model_date_suffix(&value).unwrap_or(value);
    if let Some(stripped) = value.strip_suffix("-v1") {
        value = stripped.to_string();
    }
    (!value.is_empty()).then_some(value)
}

// 将括号中的已知推理强度转为后缀，否则去掉括号部分。
fn normalize_reasoning_effort_parenthetical_suffix(value: &str) -> String {
    let trimmed = value.trim();
    let Some(open) = trimmed.rfind('(') else {
        return trimmed.to_string();
    };

    if trimmed.ends_with(')') {
        let base = trimmed[..open].trim_end();
        let inner = &trimmed[open + 1..trimmed.len() - 1];
        if let Some(effort) = normalize_reasoning_effort_key(inner) {
            return if base.is_empty() {
                trimmed.to_string()
            } else {
                format!("{base}-{effort}")
            };
        }
        return base.to_string();
    }

    trimmed[..open].trim_end().to_string()
}

// 提取已支持推理强度的规范键。
fn normalize_reasoning_effort_key(value: &str) -> Option<&'static str> {
    let key: String = value
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
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

// 判断模型是否为给定价格键的受支持版本后缀变体。
fn is_pricing_variant_of(normalized_model: &str, normalized_pricing_key: &str) -> bool {
    if !normalized_model.starts_with(normalized_pricing_key)
        || normalized_model
            .as_bytes()
            .get(normalized_pricing_key.len())
            != Some(&b'-')
    {
        return false;
    }
    is_version_like_suffix(&normalized_model[normalized_pricing_key.len() + 1..])
}

// 识别 latest、数字版本或日期形状的后缀。
fn is_version_like_suffix(suffix: &str) -> bool {
    suffix == "latest"
        || suffix
            .strip_prefix('v')
            .is_some_and(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()))
        || (suffix.len() == 8 && suffix.chars().all(|ch| ch.is_ascii_digit()))
        || is_dash_date_suffix(suffix)
}

// 检查后缀是否具有 YYYY-MM-DD 数字分隔形状。
fn is_dash_date_suffix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(idx, byte)| matches!(idx, 4 | 7) || byte.is_ascii_digit())
}

// 使用模型规范键比较，无法生成时回退小写原值。
fn normalize_for_compare(model: &str) -> String {
    normalize_model_id(model).unwrap_or_else(|| model.trim().to_lowercase())
}

// 仅保留 ASCII 字母数字用于宽松相似度比较。
fn normalized_alnum(model: &str) -> String {
    model
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

/// Split a normalized model tail into dash tokens, dropping empties.
// 按连字符拆分模型词元并丢弃空项。
fn model_tokens(model: &str) -> Vec<String> {
    model
        .split('-')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect()
}

/// When one side is a continuous dash-token prefix of the other (e.g. `grok-4-5`
/// vs `grok-4-5-build-free`), score as a base-model candidate. Requires at least
/// 2 shared tokens to avoid over-broad single-token hits like `gpt` vs anything.
// 对至少两个词元的连续基础前缀生成仅供候选的评分。
fn token_prefix_base_score(a: &[String], b: &[String]) -> Option<f64> {
    if a.is_empty() || b.is_empty() || a == b {
        return None;
    }
    let (shorter, longer) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if shorter.len() < 2 {
        return None;
    }
    if longer.len() <= shorter.len() {
        return None;
    }
    if longer[..shorter.len()] != *shorter {
        return None;
    }
    let ratio = shorter.len() as f64 / longer.len() as f64;
    Some(0.90 + 0.05 * ratio)
}

/// Fraction of the shorter token sequence that also appears in the longer one.
// 计算较短词元序列在较长序列中的包含比例。
fn token_containment(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (shorter, longer) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    // 词元很少，线性查找比构建 HashSet 更快。
    let hits = shorter
        .iter()
        .filter(|token| longer.contains(token))
        .count();
    hits as f64 / shorter.len() as f64
}

// 移除已支持的推理强度后缀并返回基础模型。
fn strip_reasoning_effort_suffix(model: &str) -> Option<&str> {
    for suffix in ["-minimal", "-medium", "-xhigh", "-high", "-low"] {
        if let Some(base) = model.strip_suffix(suffix) {
            if !base.is_empty() {
                return Some(base);
            }
        }
    }
    None
}

// 移除模型尾部具有连字符日期形状的后缀。
fn strip_model_date_suffix(model: &str) -> Option<String> {
    let bytes = model.as_bytes();
    if bytes.len() < 11 {
        return None;
    }
    let date_start = bytes.len() - 10;
    if bytes.get(date_start - 1) != Some(&b'-') {
        return None;
    }
    let date = &bytes[date_start..];
    let is_date = date.iter().enumerate().all(|(idx, byte)| {
        (matches!(idx, 4 | 7) && *byte == b'-') || (!matches!(idx, 4 | 7) && byte.is_ascii_digit())
    });
    if !is_date {
        return None;
    }
    Some(model[..date_start - 1].to_string())
}

// 按字段优先级提取非负有限数值，兼容数字字符串。
fn number_field(value: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        let Some(raw) = value.get(*key) else {
            continue;
        };
        let parsed = match raw {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.trim().parse::<f64>().ok(),
            _ => None,
        };
        if let Some(number) = parsed.filter(|number| number.is_finite() && *number >= 0.0) {
            return Some(number);
        }
    }
    None
}

// 将每 Token 价格换算为每百万价格，缺失值按零处理。
fn per_million(value: Option<f64>) -> f64 {
    value.unwrap_or(0.0) * 1_000_000.0
}

// 检查模型名称非空且四种单价均为非负有限数。
fn is_valid_price_entry(price: &ModelPriceEntry) -> bool {
    !price.model.trim().is_empty()
        && [
            price.input_per_1m,
            price.output_per_1m,
            price.cache_read_per_1m,
            price.cache_creation_per_1m,
        ]
        .into_iter()
        .all(|value| value.is_finite() && value >= 0.0)
}

// 为远端来源排序，优先 LiteLLM 再 OpenRouter。
fn source_priority(source: &str) -> u8 {
    match source {
        "litellm" => 0,
        "openrouter" => 1,
        _ => 2,
    }
}

// 按字符集合计算 Jaccard 相似度；入参为 ASCII 字母数字串及其预计算位图。
fn jaccard_mask(a: &str, a_mask: u128, b: &str, b_mask: u128) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let union = (a_mask | b_mask).count_ones() as f64;
    if union == 0.0 {
        0.0
    } else {
        (a_mask & b_mask).count_ones() as f64 / union
    }
}

// 编辑距离至少为长度差，据此给出 levenshtein_similarity 的上界。
fn levenshtein_upper_bound(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (a_len, b_len) = (a.chars().count(), b.chars().count());
    1.0 - a_len.abs_diff(b_len) as f64 / a_len.max(b_len) as f64
}

// 将字符编辑距离归一化为非负相似度。
fn levenshtein_similarity(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let distance = levenshtein(a, b) as f64;
    let max_len = a.chars().count().max(b.chars().count()) as f64;
    if max_len == 0.0 {
        1.0
    } else {
        (1.0 - distance / max_len).max(0.0)
    }
}

// 使用单行动态规划计算 Unicode 字符编辑距离。
fn levenshtein(a: &str, b: &str) -> usize {
    let b_chars: Vec<char> = b.chars().collect();
    let mut costs: Vec<usize> = (0..=b_chars.len()).collect();
    for (i, a_char) in a.chars().enumerate() {
        let mut previous = costs[0];
        costs[0] = i + 1;
        for (j, b_char) in b_chars.iter().enumerate() {
            let temp = costs[j + 1];
            let substitution = previous + usize::from(a_char != *b_char);
            costs[j + 1] = (costs[j + 1] + 1).min(costs[j] + 1).min(substitution);
            previous = temp;
        }
    }
    costs[b_chars.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 构造指定输入价格的本地测试条目。
    fn test_price(model: &str, input_per_1m: f64) -> ModelPriceEntry {
        ModelPriceEntry {
            model: model.to_string(),
            input_per_1m,
            output_per_1m: 0.0,
            cache_read_per_1m: 0.0,
            cache_creation_per_1m: 0.0,
            source: "manual".to_string(),
            source_model_id: None,
            raw_json: None,
            updated_at_ms: 0,
            synced_at_ms: None,
        }
    }

    // 构造指定模型和来源的远端测试价格。
    fn remote_price(model: &str, source: &str) -> RemoteModelPrice {
        RemoteModelPrice {
            model: model.to_string(),
            input_per_1m: 1.0,
            output_per_1m: 2.0,
            cache_read_per_1m: 0.5,
            cache_creation_per_1m: 1.5,
            source: source.to_string(),
            source_model_id: model.to_string(),
            raw_json: "{}".to_string(),
        }
    }

    #[test]
    // 验证推理强度模型保持独立价格键而不复用基础价格。
    fn reasoning_effort_suffix_keeps_model_price_distinct() {
        assert_eq!(
            normalize_model_id("gpt-5.4(xhigh)").as_deref(),
            Some("gpt-5-4-xhigh")
        );
        assert_eq!(
            normalize_model_id("gpt-5.6(high)").as_deref(),
            Some("gpt-5-6-high")
        );

        let mut prices = HashMap::new();
        prices.insert("gpt-5-4".to_string(), test_price("gpt-5.4", 5.0));
        assert!(find_model_price_entry(&prices, "gpt-5-4-xhigh").is_none());

        prices.insert(
            "gpt-5-4-xhigh".to_string(),
            test_price("gpt-5.4(xhigh)", 15.0),
        );
        let exact = find_model_price_entry(&prices, "gpt-5-4-xhigh").unwrap();
        assert_eq!(exact.input_per_1m, 15.0);
    }

    #[test]
    // 验证规范化后的来源前缀匹配允许自动应用。
    fn normalized_provider_prefix_match_can_auto_apply() {
        let remotes = vec![remote_price("chatgpt/gpt-5.3-codex-spark", "litellm")];
        let ranked = rank_candidates("gpt-5.3-codex-spark", &remotes);

        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].kind, MatchKind::Normalized);
        assert!(is_auto_match_kind(ranked[0].kind));
    }

    #[test]
    // 验证推理强度变体仅将基础模型作为候选。
    fn reasoning_effort_variant_uses_base_model_as_candidate_only() {
        let remotes = vec![remote_price("openai/gpt-5.6", "openrouter")];
        let ranked = rank_candidates("gpt-5.6(xhigh)", &remotes);

        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].kind, MatchKind::ReasoningVariant);
        assert!(!is_auto_match_kind(ranked[0].kind));
    }

    #[test]
    // 验证仅字母数字等价的匹配不能自动应用。
    fn alnum_match_remains_candidate_only() {
        let remotes = vec![remote_price("provider/model-a", "litellm")];
        let ranked = rank_candidates("model_a", &remotes);

        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].kind, MatchKind::Alnum);
        assert!(!is_auto_match_kind(ranked[0].kind));
    }

    #[test]
    // 验证基础前缀匹配保留 Grok 后缀模型候选并排除无关模型。
    fn base_prefix_match_surfaces_grok_build_free_candidate() {
        let remotes = vec![
            remote_price("xai/grok-4.5", "litellm"),
            remote_price("unrelated/other-model", "openrouter"),
        ];
        let ranked = rank_candidates("grok-4.5-build-free", &remotes);

        assert!(!ranked.is_empty());
        assert_eq!(ranked[0].kind, MatchKind::BasePrefix);
        assert!(ranked[0].score >= MIN_CANDIDATE_SCORE);
        assert!(!is_auto_match_kind(ranked[0].kind));
        assert_eq!(ranked[0].remote.source_model_id, "xai/grok-4.5");
        assert!(ranked
            .iter()
            .all(|item| item.remote.model != "unrelated/other-model"));
    }

    #[test]
    // 验证单个共享词元不能触发基础前缀匹配。
    fn base_prefix_requires_at_least_two_tokens() {
        let remotes = vec![remote_price("provider/gpt-extra-suffix", "litellm")];
        // single shared token "gpt" must not become a base-prefix hit
        let ranked = rank_candidates("gpt", &remotes);
        assert!(ranked.iter().all(|item| item.kind != MatchKind::BasePrefix));
    }

    #[test]
    // 验证词元包含率以较短序列为分母且区别于连续前缀。
    fn token_containment_scores_shared_tokens_against_shorter_side() {
        let a = model_tokens("grok-4-5-build-free");
        let b = model_tokens("grok-4-5");
        assert!((token_containment(&a, &b) - 1.0).abs() < 1e-9);

        // Shared tokens exist but not as a continuous prefix of either side.
        let c = model_tokens("claude-4-sonnet");
        let d = model_tokens("claude-sonnet-4-5");
        assert!((token_containment(&c, &d) - 1.0).abs() < 1e-9);
        assert!(token_prefix_base_score(&c, &d).is_none());
    }

    #[test]
    // 验证 OpenRouter 新缓存读写字段的单位换算。
    fn openrouter_cache_prices_support_input_cache_fields() {
        let pricing = json!({
            "prompt": "0.000003",
            "completion": "0.000015",
            "input_cache_read": "0.0000003",
            "input_cache_write": "0.00000375"
        });

        assert!((openrouter_cache_read_per_million(&pricing) - 0.3).abs() < 1e-9);
        assert!((openrouter_cache_creation_per_million(&pricing) - 3.75).abs() < 1e-9);
    }

    #[test]
    // 验证 OpenRouter 旧缓存字段仍作为兼容回退。
    fn openrouter_cache_prices_keep_legacy_field_fallbacks() {
        let pricing = json!({
            "cache_read": "0.000001",
            "cache_creation": "0.000002"
        });

        assert!((openrouter_cache_read_per_million(&pricing) - 1.0).abs() < 1e-9);
        assert!((openrouter_cache_creation_per_million(&pricing) - 2.0).abs() < 1e-9);
    }

    // 未剪枝的原始模糊评分，用于校验剪枝不改变结果。
    fn unpruned_fuzzy(t: &ModelFeatures, r: &ModelFeatures) -> f64 {
        let jaccard_score = jaccard_mask(&t.alnum, t.char_mask, &r.alnum, r.char_mask);
        (token_containment(&t.tokens, &r.tokens) * 0.55)
            + (levenshtein_similarity(&t.alnum, &r.alnum) * 0.25)
            + (jaccard_score * 0.20)
    }

    const SAMPLE_MODELS: &[&str] = &[
        "claude-sonnet-4-5-20250929",
        "anthropic/claude-sonnet-4.5",
        "Claude-Opus-4-1",
        "openai/gpt-5.4",
        "gpt-5.4(xhigh)",
        "gpt-4o-mini",
        "gemini/gemini-2.5-pro",
        "google/gemini-2.5-flash",
        "deepseek-chat",
        "deepseek/deepseek-v3.1",
        "xai/grok-4.5",
        "grok-4.5-build-free",
        "qwen3-coder-plus",
        "moonshotai/kimi-k2",
        "model_a",
        "provider/model-a",
    ];

    #[test]
    // 验证规范键直达的自动匹配与全量排序首位完全一致。
    fn auto_match_fast_path_agrees_with_full_rank() {
        let remotes: Vec<RemoteModelPrice> = SAMPLE_MODELS
            .iter()
            .map(|model| remote_price(model, "litellm"))
            .collect();
        let mut seen = HashSet::new();
        let deduped: Vec<&RemoteModelPrice> = remotes
            .iter()
            .filter(|price| seen.insert(normalize_for_compare(&price.model)))
            .collect();
        let index = RemoteIndex::new(deduped);

        let targets = SAMPLE_MODELS
            .iter()
            .copied()
            .chain(["CLAUDE-SONNET-4-5", "gpt-5-4", "unknown-model-x"]);
        for target in targets {
            let features = ModelFeatures::new(target);
            let ranked = index.rank(target, &features);
            match index.auto_match(target, &features) {
                Some(fast) => {
                    let best = &ranked[0];
                    assert_eq!(fast.remote.model, best.remote.model, "target {target}");
                    assert_eq!(fast.kind, best.kind, "target {target}");
                    assert!((fast.score - best.score).abs() < 1e-12, "target {target}");
                }
                None => assert!(
                    ranked.first().map_or(true, |best| !is_auto_match_kind(best.kind)),
                    "target {target} missed an auto match"
                ),
            }
        }
    }

    #[test]
    // 验证编辑距离上界剪枝只跳过确实低于阈值的组合。
    fn fuzzy_pruning_never_drops_candidates() {
        for a in SAMPLE_MODELS {
            for b in SAMPLE_MODELS {
                let t = ModelFeatures::new(a);
                let r = ModelFeatures::new(b);
                let full = unpruned_fuzzy(&t, &r);
                match fuzzy_score(&t, &r) {
                    Some(score) => assert!((score - full).abs() < 1e-12),
                    None => assert!(full < MIN_CANDIDATE_SCORE, "{a} vs {b} pruned at {full}"),
                }
            }
        }
    }

    #[test]
    // 验证 OpenRouter 原始数据只保留价格与上下文字段，且价格解析不受影响。
    fn openrouter_raw_json_is_slimmed() {
        let value = json!({
            "data": [{
                "id": "anthropic/claude-sonnet-4.5",
                "name": "Claude Sonnet 4.5",
                "description": "very long description",
                "context_length": 1000000,
                "supported_parameters": ["tools"],
                "pricing": { "prompt": "0.000003", "completion": "0.000015" },
                "top_provider": { "context_length": 1000000 }
            }]
        });
        let prices = parse_openrouter_prices(value);
        assert_eq!(prices.len(), 1);
        assert!((prices[0].input_per_1m - 3.0).abs() < 1e-9);
        let raw: Value = serde_json::from_str(&prices[0].raw_json).unwrap();
        assert_eq!(raw["context_length"], json!(1000000));
        assert_eq!(raw["pricing"]["completion"], json!("0.000015"));
        assert!(raw.get("description").is_none());
        assert!(raw.get("supported_parameters").is_none());
    }

    #[test]
    // 验证 LiteLLM 解析保留完整原始条目并换算单价。
    fn litellm_prices_parse_and_keep_raw_entry() {
        let value = json!({
            "sample_spec": "ignored",
            "claude-sonnet-4-5": {
                "input_cost_per_token": 0.000003,
                "output_cost_per_token": 0.000015,
                "cache_read_input_token_cost": 0.0000003,
                "max_input_tokens": 200000
            },
            "no-price": { "max_input_tokens": 1 }
        });
        let prices = parse_litellm_prices(value);
        assert_eq!(prices.len(), 1);
        assert_eq!(prices[0].model, "claude-sonnet-4-5");
        assert!((prices[0].cache_read_per_1m - 0.3).abs() < 1e-9);
        assert!(prices[0].raw_json.contains("max_input_tokens"));
    }
}
