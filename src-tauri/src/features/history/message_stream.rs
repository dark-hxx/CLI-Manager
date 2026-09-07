use super::{
    extract_model, extract_u64_by_keys, extract_usage_dedup_key, extract_usage_tokens_from_value,
    is_jsonl, is_synthetic_model, kimi, looks_like_antigravity_transcript_file,
    looks_like_copilot_events_file, looks_like_grok_updates_file, looks_like_pi_session_file,
    parse_message, scan_antigravity_jsonl_session, scan_copilot_jsonl_session,
    scan_grok_jsonl_session, scan_json_session, scan_pi_jsonl_session, usage_total_tokens,
    HistoryMessage, UsageTokenScan, READ_BUF_CAPACITY,
};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Stream parsed messages from a session file. Callback returns `false` to break early.
/// 同一条消息的多个流式行携带相同 usage，去重后仅首行保留 token 字段，避免前端求和虚高。
pub(super) fn iter_session_messages<F>(path: &Path, mut callback: F) -> Result<(), String>
where
    F: FnMut(usize, HistoryMessage) -> bool,
{
    if !is_jsonl(path) {
        let (_, _, messages) = scan_json_session(path, true);
        for (index, message) in messages.into_iter().enumerate() {
            if !callback(index, message) {
                break;
            }
        }
        return Ok(());
    }
    if looks_like_copilot_events_file(path) {
        let (_, _, messages) = scan_copilot_jsonl_session(path, true);
        for (index, message) in messages.into_iter().enumerate() {
            if !callback(index, message) {
                break;
            }
        }
        return Ok(());
    }
    if looks_like_antigravity_transcript_file(path) {
        let (_, _, messages) = scan_antigravity_jsonl_session(path, true);
        for (index, message) in messages.into_iter().enumerate() {
            if !callback(index, message) {
                break;
            }
        }
        return Ok(());
    }
    if looks_like_grok_updates_file(path) {
        let (_, _, messages) = scan_grok_jsonl_session(path, true);
        for (index, message) in messages.into_iter().enumerate() {
            if !callback(index, message) {
                break;
            }
        }
        return Ok(());
    }
    if kimi::looks_like_kimi_main_wire(path) {
        let (_, _, messages) = kimi::scan_kimi_jsonl_session(path, true);
        for (index, message) in messages.into_iter().enumerate() {
            if !callback(index, message) {
                break;
            }
        }
        return Ok(());
    }
    if looks_like_pi_session_file(path) {
        let (_, _, messages) = scan_pi_jsonl_session(path, true);
        for (index, message) in messages.into_iter().enumerate() {
            if !callback(index, message) {
                break;
            }
        }
        return Ok(());
    }

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

pub(super) fn extract_usage_tokens(value: &Value) -> UsageTokenScan {
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
pub(super) struct CodexCumulativeUsage {
    pub(super) input_tokens: u64,
    pub(super) cached_input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) total_tokens: u64,
}

pub(super) fn extract_codex_token_count(value: &Value) -> Option<CodexCumulativeUsage> {
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
pub(super) fn extract_codex_context_info(value: &Value) -> (Option<u64>, Option<u64>) {
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

pub(super) fn extract_context_window(value: &Value) -> Option<u64> {
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

pub(super) fn extract_context_window_from_value(value: &Value) -> Option<u64> {
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
