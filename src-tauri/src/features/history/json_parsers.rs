use super::{
    calculate_usage_cost, cline_api_message_values, cline_model_from_path,
    cline_session_id_from_path, cline_title_from_path, cline_ui_timestamps, collect_tool_calls,
    empty_session_scan, extract_model, extract_text_from_value, extract_timestamp,
    extract_timestamp_millis, extract_u64_by_keys, fallback_history_message_part,
    is_synthetic_model, looks_like_cline_session_file, message_title_candidate, normalize_text,
    parse_message, parse_timestamp_millis_str, positive_usage_token, usage_total_tokens,
    usage_trend_point, HistoryMessage, SessionStatsScan, SessionSummaryScan, SessionUsageEventScan,
    UsageTokenScan,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

// 读取完整 JSON 文件并按 Cline、Kiro 或 Gemini 结构选择解析器，失败返回空扫描。
pub(super) fn scan_json_session(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let Ok(raw) = fs::read_to_string(path) else {
        return empty_session_scan();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return empty_session_scan();
    };

    if looks_like_cline_session_file(path) {
        return scan_cline_json_session(path, &value, collect_messages);
    }
    if value.get("history").and_then(Value::as_array).is_some() && value.get("sessionId").is_some()
    {
        return scan_kiro_json_session(&value, collect_messages);
    }
    if value.get("messages").and_then(Value::as_array).is_some()
        && (value.get("sessionId").is_some() || value.get("projectHash").is_some())
    {
        return scan_gemini_json_session(&value, collect_messages);
    }

    empty_session_scan()
}

// 转换 Gemini 消息及 token 字段，构造带事件时间和模型的用量事实。
pub(super) fn scan_gemini_json_session(
    value: &Value,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let mut messages = Vec::new();
    let mut usage_events = Vec::new();
    for (index, message) in value
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let Some(content) = message.get("content").and_then(json_content_text) else {
            continue;
        };
        let is_gemini = message.get("type").and_then(Value::as_str) == Some("gemini");
        let model = extract_model(message);
        let token_scan = if is_gemini {
            gemini_usage_token_scan(message)
        } else {
            UsageTokenScan::default()
        };
        let mut history_message = json_history_message(
            normalize_json_role(message.get("type")),
            content,
            extract_timestamp(message),
            model.clone(),
        );
        history_message.input_tokens = positive_usage_token(token_scan.input_tokens);
        history_message.output_tokens = positive_usage_token(token_scan.output_tokens);
        history_message.cache_read_tokens = positive_usage_token(token_scan.cache_read_tokens);
        history_message.cache_creation_tokens =
            positive_usage_token(token_scan.cache_creation_tokens);
        messages.push(history_message);

        if is_gemini && usage_total_tokens(token_scan) > 0 {
            let event_index = usage_events.len();
            usage_events.push(SessionUsageEventScan {
                event_key: gemini_usage_event_key(message, index),
                event_index,
                timestamp_ms: extract_timestamp_millis(message),
                model,
                usage: calculate_usage_cost(extract_model(message).as_deref(), token_scan),
            });
        }
    }

    let (summary, mut stats, output_messages) = json_session_scan_result(
        value.get("sessionId").and_then(Value::as_str),
        None,
        messages,
        collect_messages,
    );
    stats.usage_events = usage_events;
    (summary, stats, output_messages)
}

// 规范化 Gemini token 用量，从输入扣除缓存并将思考用量计入输出。
pub(super) fn gemini_usage_token_scan(value: &Value) -> UsageTokenScan {
    let Some(tokens) = value.get("tokens").and_then(Value::as_object) else {
        return UsageTokenScan::default();
    };
    let cache_read_tokens = extract_u64_by_keys(
        tokens,
        &["cached", "cacheRead", "cache_read_tokens", "cachedTokens"],
    )
    .unwrap_or(0);
    UsageTokenScan {
        input_tokens: extract_u64_by_keys(tokens, &["input", "inputTokens", "input_tokens"])
            .unwrap_or(0)
            .saturating_sub(cache_read_tokens),
        output_tokens: extract_u64_by_keys(tokens, &["output", "outputTokens", "output_tokens"])
            .unwrap_or(0)
            .saturating_add(extract_u64_by_keys(tokens, &["thoughts", "thinking"]).unwrap_or(0)),
        cache_read_tokens,
        cache_creation_tokens: extract_u64_by_keys(
            tokens,
            &["cacheCreation", "cache_creation_tokens", "cacheWrite"],
        )
        .unwrap_or(0),
        explicit_cost_usd: None,
    }
}

// 以消息标识或数组索引生成 Gemini 用量事件键。
pub(super) fn gemini_usage_event_key(value: &Value, index: usize) -> String {
    let identity = value
        .get("id")
        .or_else(|| value.get("messageId"))
        .or_else(|| value.get("uuid"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("index:{index}"));
    format!("gemini:{identity}")
}

// 转换 Kiro 历史消息，缺失模型时使用选定模型并汇总扫描结果。
pub(super) fn scan_kiro_json_session(
    value: &Value,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let selected_model = value
        .get("selectedModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let messages = value
        .get("history")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let message = entry.get("message").unwrap_or(entry);
            let content = message
                .get("content")
                .or_else(|| entry.get("content"))
                .and_then(json_content_text)?;
            Some(json_history_message(
                normalize_json_role(message.get("role").or_else(|| entry.get("role"))),
                content,
                extract_timestamp(message).or_else(|| extract_timestamp(entry)),
                extract_model(message).or_else(|| selected_model.clone()),
            ))
        })
        .collect::<Vec<_>>();
    json_session_scan_result(
        value.get("sessionId").and_then(Value::as_str),
        value.get("title").and_then(Value::as_str),
        messages,
        collect_messages,
    )
}

// 解析 Cline API 消息并补充 UI 时间与模型，汇总去重后的工具调用。
pub(super) fn scan_cline_json_session(
    path: &Path,
    value: &Value,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let session_id = cline_session_id_from_path(path);
    let title = cline_title_from_path(path);
    let model = cline_model_from_path(path);
    let timestamps = cline_ui_timestamps(path);
    let mut messages = Vec::new();
    let mut seen_call_ids = HashSet::new();
    let mut tool_call_count = 0u64;
    let mut mcp_calls = HashMap::new();
    let mut skill_calls = HashMap::new();
    let mut builtin_calls = HashMap::new();

    for (index, entry) in cline_api_message_values(value).into_iter().enumerate() {
        let wrapped = json!({ "message": entry });
        collect_tool_calls(
            &wrapped,
            &mut seen_call_ids,
            &mut tool_call_count,
            &mut mcp_calls,
            &mut skill_calls,
            &mut builtin_calls,
        );
        let Some(mut message) = parse_message(entry) else {
            continue;
        };
        if message.timestamp.is_none() {
            message.timestamp = timestamps.get(index).cloned().flatten();
        }
        if message.model.is_none() && message.role == "assistant" {
            message.model = model.clone();
        }
        message.line_index = Some(index);
        messages.push(message);
    }

    let (summary, mut stats, output_messages) = json_session_scan_result(
        session_id.as_deref(),
        title.as_deref(),
        messages,
        collect_messages,
    );
    if stats.current_model.is_none() {
        stats.current_model = model.clone();
        stats.dominant_model = model;
    }
    stats.tool_call_count = tool_call_count;
    stats.mcp_calls = mcp_calls;
    stats.skill_calls = skill_calls;
    stats.builtin_calls = builtin_calls;
    (summary, stats, output_messages)
}

// 根据消息计算时间范围、标题候选及用量，按需保留消息列表。
pub(super) fn json_session_scan_result(
    session_id: Option<&str>,
    fallback_title: Option<&str>,
    messages: Vec<HistoryMessage>,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let (first_timestamp_ms, last_timestamp_ms) = messages
        .iter()
        .filter_map(|message| {
            message
                .timestamp
                .as_deref()
                .and_then(parse_timestamp_millis_str)
        })
        .fold((None::<i64>, None::<i64>), |(first, last), timestamp_ms| {
            (
                Some(
                    first
                        .map(|current| current.min(timestamp_ms))
                        .unwrap_or(timestamp_ms),
                ),
                Some(
                    last.map(|current| current.max(timestamp_ms))
                        .unwrap_or(timestamp_ms),
                ),
            )
        });
    let first_message = messages
        .iter()
        .find_map(message_title_candidate)
        .or_else(|| {
            fallback_title
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string)
        });
    let first_user_message = messages
        .iter()
        .filter(|message| message.role == "user")
        .find_map(message_title_candidate);
    let model = messages
        .iter()
        .rev()
        .filter_map(|message| message.model.clone())
        .find(|model| !is_synthetic_model(model));
    // Pi/Grok 等 JSON 会话路径只解析消息行，会话级 usage 必须从消息 token 汇总。
    let stats = session_stats_from_messages(&messages, model);
    (
        SessionSummaryScan {
            session_id: session_id
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
            parent_session_id: None,
            message_count: messages.len(),
            first_user_message,
            first_message,
            branch: None,
            first_timestamp_ms,
            last_timestamp_ms,
        },
        stats,
        if collect_messages {
            messages
        } else {
            Vec::new()
        },
    )
}

// 按消息累计 token、模型计数与本地定价成本，并记录最近模型及上下文用量。
pub(super) fn session_stats_from_messages(
    messages: &[HistoryMessage],
    fallback_model: Option<String>,
) -> SessionStatsScan {
    let mut stats = SessionStatsScan {
        dominant_model: fallback_model.clone(),
        current_model: fallback_model.clone(),
        ..SessionStatsScan::default()
    };
    let mut model_hits: HashMap<String, usize> = HashMap::new();
    let mut last_model = fallback_model;

    for message in messages {
        if let Some(model) = message
            .model
            .as_ref()
            .filter(|model| !is_synthetic_model(model))
        {
            *model_hits.entry(model.clone()).or_insert(0) += 1;
            last_model = Some(model.clone());
        }

        let usage = UsageTokenScan {
            input_tokens: message.input_tokens.unwrap_or(0),
            output_tokens: message.output_tokens.unwrap_or(0),
            cache_read_tokens: message.cache_read_tokens.unwrap_or(0),
            cache_creation_tokens: message.cache_creation_tokens.unwrap_or(0),
            explicit_cost_usd: None,
        };
        if usage_total_tokens(usage) == 0 {
            continue;
        }

        let attributed_model = message
            .model
            .clone()
            .filter(|model| !is_synthetic_model(model))
            .or_else(|| last_model.clone());
        stats
            .token_trend
            .push(usage_trend_point(usage, attributed_model.clone()));

        stats.input_tokens = stats.input_tokens.saturating_add(usage.input_tokens);
        stats.output_tokens = stats.output_tokens.saturating_add(usage.output_tokens);
        stats.cache_read_tokens = stats
            .cache_read_tokens
            .saturating_add(usage.cache_read_tokens);
        stats.cache_creation_tokens = stats
            .cache_creation_tokens
            .saturating_add(usage.cache_creation_tokens);

        let prompt_tokens = usage
            .input_tokens
            .saturating_add(usage.cache_read_tokens)
            .saturating_add(usage.cache_creation_tokens);
        if prompt_tokens > 0 {
            stats.last_context_tokens = Some(prompt_tokens);
        }

        let cost = calculate_usage_cost(attributed_model.as_deref(), usage);
        stats.total_cost_usd += cost.total_cost_usd;
        stats.unpriced_tokens = stats.unpriced_tokens.saturating_add(cost.unpriced_tokens);

        if let Some(model) = attributed_model {
            let entry = stats.model_usage.entry(model).or_default();
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

    if let Some(model) = model_hits
        .into_iter()
        .max_by(|(left_model, left_hits), (right_model, right_hits)| {
            left_hits
                .cmp(right_hits)
                .then_with(|| right_model.cmp(left_model))
        })
        .map(|(model, _)| model)
    {
        stats.dominant_model = Some(model);
    }
    stats.current_model = last_model.or(stats.current_model);
    stats
}

// 构造默认不可编辑的历史消息及内容分块，过滤合成模型占位符。
pub(super) fn json_history_message(
    role: String,
    content: String,
    timestamp: Option<String>,
    model: Option<String>,
) -> HistoryMessage {
    let parts = vec![fallback_history_message_part(&role, &content)];
    HistoryMessage {
        role,
        content,
        parts,
        timestamp,
        model: model.filter(|model| !is_synthetic_model(model)),
        input_tokens: None,
        output_tokens: None,
        cache_creation_tokens: None,
        cache_read_tokens: None,
        line_index: None,
        editable: false,
        editable_text: None,
    }
}

// 提取 JSON 中的文本并规范空白，空文本返回空值。
pub(super) fn json_content_text(value: &Value) -> Option<String> {
    extract_text_from_value(value)
        .map(|text| normalize_text(&text))
        .filter(|text| !text.is_empty())
}

// 按角色名包含的关键词映射用户、系统或工具，其他值归为助手。
pub(super) fn normalize_json_role(value: Option<&Value>) -> String {
    let role = value.and_then(Value::as_str).unwrap_or_default();
    let lower = role.to_lowercase();
    if lower.contains("user") || lower.contains("human") {
        "user".to_string()
    } else if lower.contains("system") {
        "system".to_string()
    } else if lower.contains("tool") {
        "tool".to_string()
    } else {
        "assistant".to_string()
    }
}
use std::fs;
