use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const LITELLM_PRICES_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const MIN_CANDIDATE_SCORE: f64 = 0.70;
const MAX_SYNC_TARGETS: usize = 500;
const REMOTE_FETCH_TIMEOUT: Duration = Duration::from_secs(20);

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
pub async fn model_prices_sync(targets: Vec<String>) -> Result<ModelPriceSyncResult, String> {
    if targets.len() > MAX_SYNC_TARGETS {
        return Err(format!(
            "too many model price sync targets: {} (max {MAX_SYNC_TARGETS})",
            targets.len()
        ));
    }

    let mut remote_prices = fetch_remote_prices().await?;
    remote_prices.sort_by(|a, b| source_priority(&a.source).cmp(&source_priority(&b.source)));

    let mut seen_remote = HashSet::new();
    remote_prices.retain(|price| seen_remote.insert(normalize_for_compare(&price.model)));

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
        let ranked = rank_candidates(&target, &remote_prices);
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
                .take(5)
                .map(|candidate| ModelPriceSyncCandidate {
                    target_model: target.clone(),
                    score: candidate.score,
                    remote: candidate.remote,
                }),
        );
    }

    Ok(ModelPriceSyncResult {
        matched,
        candidates,
        unmatched,
        fetched_count: remote_prices.len(),
    })
}

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
struct RankedRemotePrice {
    score: f64,
    kind: MatchKind,
    remote: RemoteModelPrice,
}

fn is_auto_match_kind(kind: MatchKind) -> bool {
    matches!(
        kind,
        MatchKind::Exact | MatchKind::CaseInsensitive | MatchKind::Normalized
    )
}

async fn fetch_remote_prices() -> Result<Vec<RemoteModelPrice>, String> {
    let client = reqwest::Client::builder()
        .user_agent("CLI-Manager model pricing sync")
        .timeout(REMOTE_FETCH_TIMEOUT)
        .build()
        .map_err(|err| format!("failed to create HTTP client: {err}"))?;

    let (litellm_result, openrouter_result) = tokio::join!(
        fetch_litellm_prices(&client),
        fetch_openrouter_prices(&client)
    );
    let mut errors = Vec::new();
    let mut prices = Vec::new();

    match litellm_result {
        Ok(mut items) => prices.append(&mut items),
        Err(err) => errors.push(err),
    }
    match openrouter_result {
        Ok(mut items) => prices.append(&mut items),
        Err(err) => errors.push(err),
    }

    if prices.is_empty() {
        let detail = if errors.is_empty() {
            "remote price sources returned no usable models".to_string()
        } else {
            errors.join("; ")
        };
        return Err(detail);
    }
    Ok(prices)
}

async fn fetch_litellm_prices(client: &reqwest::Client) -> Result<Vec<RemoteModelPrice>, String> {
    let response = client
        .get(LITELLM_PRICES_URL)
        .send()
        .await
        .map_err(|err| format!("failed to fetch LiteLLM prices: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "LiteLLM price source returned {}",
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|err| format!("failed to parse LiteLLM prices: {err}"))?;
    let Some(object) = value.as_object() else {
        return Ok(Vec::new());
    };

    let mut prices = Vec::new();
    for (model, raw) in object {
        if !raw.is_object() {
            continue;
        }
        let input = number_field(raw, &["input_cost_per_token", "prompt_cost_per_token"]);
        let output = number_field(raw, &["output_cost_per_token", "completion_cost_per_token"]);
        if input.is_none() && output.is_none() {
            continue;
        }
        prices.push(RemoteModelPrice {
            model: model.clone(),
            input_per_1m: per_million(input),
            output_per_1m: per_million(output),
            cache_read_per_1m: per_million(number_field(
                raw,
                &[
                    "cache_read_input_token_cost",
                    "input_cost_per_token_cache_read",
                ],
            )),
            cache_creation_per_1m: per_million(number_field(
                raw,
                &[
                    "cache_creation_input_token_cost",
                    "input_cost_per_token_cache_creation",
                ],
            )),
            source: "litellm".to_string(),
            source_model_id: model.clone(),
            raw_json: raw.to_string(),
        });
    }
    Ok(prices)
}

async fn fetch_openrouter_prices(
    client: &reqwest::Client,
) -> Result<Vec<RemoteModelPrice>, String> {
    let response = client
        .get(OPENROUTER_MODELS_URL)
        .send()
        .await
        .map_err(|err| format!("failed to fetch OpenRouter prices: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "OpenRouter price source returned {}",
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|err| format!("failed to parse OpenRouter prices: {err}"))?;
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

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
            source: "openrouter".to_string(),
            source_model_id: id.to_string(),
            raw_json: item.to_string(),
        });
    }
    Ok(prices)
}

fn openrouter_cache_read_per_million(pricing: &Value) -> f64 {
    per_million(number_field(
        pricing,
        &["input_cache_read", "cache_read", "cache"],
    ))
}

fn openrouter_cache_creation_per_million(pricing: &Value) -> f64 {
    per_million(number_field(
        pricing,
        &["input_cache_write", "cache_creation", "cache_write"],
    ))
}

fn rank_candidates(target: &str, remotes: &[RemoteModelPrice]) -> Vec<RankedRemotePrice> {
    let target_norm = normalize_for_compare(target);
    let target_base_norm = strip_reasoning_effort_suffix(&target_norm);
    let target_tail = canonical_tail(target);
    let target_alnum = normalized_alnum(&target_tail);
    let target_tokens = model_tokens(&target_tail);
    let mut ranked = Vec::new();

    for remote in remotes {
        let remote_norm = normalize_for_compare(&remote.model);
        let remote_tail = canonical_tail(&remote.model);
        let remote_alnum = normalized_alnum(&remote_tail);
        let remote_tokens = model_tokens(&remote_tail);

        let (score, kind) = if target.trim() == remote.model.trim() {
            (1.0, MatchKind::Exact)
        } else if target.trim().eq_ignore_ascii_case(remote.model.trim()) {
            (0.995, MatchKind::CaseInsensitive)
        } else if target_norm == remote_norm {
            (0.99, MatchKind::Normalized)
        } else if target_base_norm == Some(remote_norm.as_str()) {
            (0.975, MatchKind::ReasoningVariant)
        } else if target_tail == remote_tail {
            (0.98, MatchKind::Tail)
        } else if !target_alnum.is_empty() && target_alnum == remote_alnum {
            (0.96, MatchKind::Alnum)
        } else if let Some(prefix_score) = token_prefix_base_score(&target_tokens, &remote_tokens) {
            (prefix_score, MatchKind::BasePrefix)
        } else {
            let jaccard_score = jaccard(&target_alnum, &remote_alnum);
            let levenshtein_score = levenshtein_similarity(&target_alnum, &remote_alnum);
            let token_score = token_containment(&target_tokens, &remote_tokens);
            (
                (token_score * 0.55) + (levenshtein_score * 0.25) + (jaccard_score * 0.20),
                MatchKind::Fuzzy,
            )
        };

        if score >= MIN_CANDIDATE_SCORE {
            ranked.push(RankedRemotePrice {
                score,
                kind,
                remote: remote.clone(),
            });
        }
    }

    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| source_priority(&a.remote.source).cmp(&source_priority(&b.remote.source)))
            .then_with(|| a.remote.model.cmp(&b.remote.model))
    });
    ranked
}

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

fn is_version_like_suffix(suffix: &str) -> bool {
    suffix == "latest"
        || suffix
            .strip_prefix('v')
            .is_some_and(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()))
        || (suffix.len() == 8 && suffix.chars().all(|ch| ch.is_ascii_digit()))
        || is_dash_date_suffix(suffix)
}

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

fn normalize_for_compare(model: &str) -> String {
    normalize_model_id(model).unwrap_or_else(|| model.trim().to_lowercase())
}

fn canonical_tail(model: &str) -> String {
    normalize_for_compare(model)
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn normalized_alnum(model: &str) -> String {
    model
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

/// Split a normalized model tail into dash tokens, dropping empties.
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
fn token_containment(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (shorter, longer) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let longer_set: HashSet<&str> = longer.iter().map(String::as_str).collect();
    let hits = shorter
        .iter()
        .filter(|token| longer_set.contains(token.as_str()))
        .count();
    hits as f64 / shorter.len() as f64
}

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

fn per_million(value: Option<f64>) -> f64 {
    value.unwrap_or(0.0) * 1_000_000.0
}

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

fn source_priority(source: &str) -> u8 {
    match source {
        "litellm" => 0,
        "openrouter" => 1,
        _ => 2,
    }
}

fn jaccard(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let a_set: HashSet<char> = a.chars().collect();
    let b_set: HashSet<char> = b.chars().collect();
    let intersection = a_set.intersection(&b_set).count() as f64;
    let union = a_set.union(&b_set).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        intersection / union
    }
}

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
    fn normalized_provider_prefix_match_can_auto_apply() {
        let remotes = vec![remote_price("chatgpt/gpt-5.3-codex-spark", "litellm")];
        let ranked = rank_candidates("gpt-5.3-codex-spark", &remotes);

        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].kind, MatchKind::Normalized);
        assert!(is_auto_match_kind(ranked[0].kind));
    }

    #[test]
    fn reasoning_effort_variant_uses_base_model_as_candidate_only() {
        let remotes = vec![remote_price("openai/gpt-5.6", "openrouter")];
        let ranked = rank_candidates("gpt-5.6(xhigh)", &remotes);

        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].kind, MatchKind::ReasoningVariant);
        assert!(!is_auto_match_kind(ranked[0].kind));
    }

    #[test]
    fn alnum_match_remains_candidate_only() {
        let remotes = vec![remote_price("provider/model-a", "litellm")];
        let ranked = rank_candidates("model_a", &remotes);

        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].kind, MatchKind::Alnum);
        assert!(!is_auto_match_kind(ranked[0].kind));
    }

    #[test]
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
    fn base_prefix_requires_at_least_two_tokens() {
        let remotes = vec![remote_price("provider/gpt-extra-suffix", "litellm")];
        // single shared token "gpt" must not become a base-prefix hit
        let ranked = rank_candidates("gpt", &remotes);
        assert!(ranked.iter().all(|item| item.kind != MatchKind::BasePrefix));
    }

    #[test]
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
    fn openrouter_cache_prices_keep_legacy_field_fallbacks() {
        let pricing = json!({
            "cache_read": "0.000001",
            "cache_creation": "0.000002"
        });

        assert!((openrouter_cache_read_per_million(&pricing) - 1.0).abs() < 1e-9);
        assert!((openrouter_cache_creation_per_million(&pricing) - 2.0).abs() < 1e-9);
    }
}
