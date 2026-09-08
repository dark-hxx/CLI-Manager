use super::{
    extract_timestamp_millis, CodexCumulativeUsage, HistoryMessage, HistoryStatsModelItem,
    HistoryTokenTrendPoint, UsageStatsScan, UsageTokenScan,
};
use crate::commands::model_pricing::{find_cached_model_pricing, CachedModelPricingLookup};
use serde_json::Value;

/// 相邻高水位差分还原单回合用量；累计值变小是陈旧/交错快照，不产生新增用量。
/// Codex 的 `input_tokens` 包含 `cached_input_tokens`，此处归一化为
/// 非缓存 input + cache_read，与 Claude 口径一致。
// 累计总量上升时计算饱和差分，再转换为非缓存输入与缓存读取用量。
pub(super) fn codex_usage_delta(
    previous: Option<CodexCumulativeUsage>,
    current: CodexCumulativeUsage,
) -> UsageTokenScan {
    let previous = previous.unwrap_or_default();
    let delta = if current.total_tokens <= previous.total_tokens {
        CodexCumulativeUsage::default()
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
    codex_usage_from_counts(delta)
}

// 从 Codex 含缓存输入中扣除缓存读取，生成统一 token 用量结构。
pub(super) fn codex_usage_from_counts(counts: CodexCumulativeUsage) -> UsageTokenScan {
    UsageTokenScan {
        input_tokens: counts
            .input_tokens
            .saturating_sub(counts.cached_input_tokens),
        output_tokens: counts.output_tokens,
        cache_read_tokens: counts.cached_input_tokens,
        cache_creation_tokens: 0,
        explicit_cost_usd: None,
    }
}

/// C2: 提取 usage 去重键（message.id | requestId）
///
/// 边界情况：无 message.id 的带 usage 行不去重。
/// Claude Code / Codex 正常都有 message.id，属边界情况，保持现状。
// 由非空 message.id 与可选 requestId 构造流式用量去重键。
pub(super) fn extract_usage_dedup_key(value: &Value) -> Option<String> {
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

// 优先使用消息身份，其次 Codex 累计快照，否则用物理行号和用量构造事件键。
pub(super) fn build_usage_event_key(
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

// 不区分 ASCII 大小写判断修剪后的模型名是否为合成占位符。
pub(super) fn is_synthetic_model(model: &str) -> bool {
    model.trim().eq_ignore_ascii_case("<synthetic>")
}

// 按兼容字段归一化输入、输出、缓存和显式成本，必要时用总量回退输入。
pub(super) fn extract_usage_tokens_from_value(value: &Value) -> UsageTokenScan {
    let Value::Object(map) = value else {
        return UsageTokenScan::default();
    };

    let mut input = extract_u64_by_keys(
        map,
        &[
            "input_tokens",
            "inputTokens",
            // Pi Agent: message.usage.input / output / cacheRead / cacheWrite
            "input",
            "prompt_tokens",
            "promptTokens",
            "input_token_count",
            "inputTokenCount",
        ],
    )
    .unwrap_or(0);
    let mut output = extract_u64_by_keys(
        map,
        &[
            "output_tokens",
            "outputTokens",
            "output",
            "completion_tokens",
            "completionTokens",
            "output_token_count",
            "outputTokenCount",
        ],
    )
    .unwrap_or(0);
    // Pi 把 reasoning 单独记账；归入 output，避免实时统计少计思考 token。
    let reasoning = extract_u64_by_keys(
        map,
        &[
            "reasoning",
            "reasoning_tokens",
            "reasoningTokens",
            "thinking_tokens",
        ],
    )
    .unwrap_or(0);
    output = output.saturating_add(reasoning);
    let cache_read = extract_u64_by_keys(
        map,
        &[
            "cache_read_tokens",
            "cacheReadTokens",
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cacheRead",
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
            "cacheWrite",
            "cache_write_tokens",
            "cacheWriteTokens",
        ],
    )
    .unwrap_or(0);
    let mut explicit_cost_usd = extract_f64_by_keys(
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
    // Pi usage.cost 是对象：{ input, output, cacheRead, cacheWrite, total }
    if explicit_cost_usd.is_none() {
        if let Some(cost_map) = map.get("cost").and_then(Value::as_object) {
            explicit_cost_usd = extract_f64_by_keys(
                cost_map,
                &[
                    "total",
                    "total_cost_usd",
                    "totalCostUsd",
                    "totalCostUSD",
                    "cost_usd",
                    "costUsd",
                    "costUSD",
                ],
            );
        }
    }

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

// 按字段顺序读取首个可转换的非负整数，包括零。
pub(super) fn extract_u64_by_keys(
    map: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<u64> {
    keys.iter()
        .filter_map(|key| map.get(*key))
        .find_map(extract_positive_u64)
}

// 按字段顺序读取首个有限非负浮点数。
pub(super) fn extract_f64_by_keys(
    map: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<f64> {
    keys.iter()
        .filter_map(|key| map.get(*key))
        .find_map(extract_non_negative_f64)
}

// 将数字或数字字符串转换为有限非负浮点数。
pub(super) fn extract_non_negative_f64(value: &Value) -> Option<f64> {
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

// 饱和累加四类原始 token 用量。
pub(super) fn usage_total_tokens(usage: UsageTokenScan) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.output_tokens)
        .saturating_add(usage.cache_read_tokens)
        .saturating_add(usage.cache_creation_tokens)
}

// 判断消息是否含有任一大于零的 token 用量。
pub(super) fn message_has_token_usage(message: &HistoryMessage) -> bool {
    message.input_tokens.unwrap_or(0) > 0
        || message.output_tokens.unwrap_or(0) > 0
        || message.cache_read_tokens.unwrap_or(0) > 0
        || message.cache_creation_tokens.unwrap_or(0) > 0
}

// 仅将大于零的 token 数转换为可选值。
pub(super) fn positive_usage_token(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

// 把非零用量回填到最近一条无 token 用量的助手消息，必要时补时间。
pub(super) fn backfill_latest_assistant_message_usage(
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

// 饱和累加统计结构中的四类 token 用量。
pub(super) fn usage_stats_total_tokens(usage: UsageStatsScan) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.output_tokens)
        .saturating_add(usage.cache_read_tokens)
        .saturating_add(usage.cache_creation_tokens)
}

// 将原始用量和模型映射为包含总量的趋势点。
pub(super) fn usage_trend_point(
    usage: UsageTokenScan,
    model: Option<String>,
) -> HistoryTokenTrendPoint {
    HistoryTokenTrendPoint {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_creation_tokens: usage.cache_creation_tokens,
        total_tokens: usage_total_tokens(usage),
        model,
    }
}

// 饱和累加模型统计条目的四类 token 用量。
pub(super) fn history_stats_total_tokens(item: &HistoryStatsModelItem) -> u64 {
    item.input_tokens
        .saturating_add(item.output_tokens)
        .saturating_add(item.cache_read_tokens)
        .saturating_add(item.cache_creation_tokens)
}

// 仅按本地模型定价计算四类用量成本，未定价用量记入未计价 token。
pub(super) fn calculate_usage_cost(model: Option<&str>, usage: UsageTokenScan) -> UsageStatsScan {
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
pub(super) struct HistoryModelPricing {
    pub(super) input_per_million: f64,
    pub(super) output_per_million: f64,
    pub(super) cache_read_per_million: f64,
    pub(super) cache_creation_per_million: f64,
}

// 从模型定价缓存读取历史计价所需单价，缓存不可用或缺失时返回空值。
pub(super) fn find_history_model_pricing(model: &str) -> Option<HistoryModelPricing> {
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

// 将布尔、非负数字或整数字符串转换为 u64，允许零及浮点截断。
pub(super) fn extract_positive_u64(value: &Value) -> Option<u64> {
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

// 从兼容模型字段及指定嵌套对象递归提取首个非空模型名。
pub(super) fn extract_model(value: &Value) -> Option<String> {
    let direct_candidates = [
        value.get("model").and_then(Value::as_str),
        value.get("model_name").and_then(Value::as_str),
        value.get("modelName").and_then(Value::as_str),
        value.get("model_slug").and_then(Value::as_str),
        value.get("selectedModel").and_then(Value::as_str),
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

// 读取 Codex turn_context 的思考强度，已知标签规范化，未知值转小写。
pub(super) fn extract_reasoning_effort(value: &Value) -> Option<String> {
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

// 仅为受支持的纯 GPT 版本模型组合规范思考强度后缀。
pub(super) fn qualify_model_with_reasoning_effort(model: String, effort: Option<&str>) -> String {
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

// 拆分可识别的括号或连字符思考强度后缀，无法识别时保留模型名。
pub(super) fn split_model_reasoning_effort(model: &str) -> (&str, Option<&'static str>) {
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

// 仅接受 gpt- 后跟两段数字版本的模型作为思考强度变体。
pub(super) fn supports_reasoning_effort_model_variant(model: &str) -> bool {
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

// 忽略非字母数字符号与大小写，将已知思考强度映射到规范标签。
pub(super) fn normalize_reasoning_effort_label(value: &str) -> Option<&'static str> {
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
