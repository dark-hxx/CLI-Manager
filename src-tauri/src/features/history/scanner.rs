use super::{
    backfill_latest_assistant_message_usage, build_usage_event_key, calculate_usage_cost,
    codex_usage_delta, collect_tool_calls, extract_branch, extract_codex_context_info,
    extract_codex_token_count, extract_command_name, extract_context_window, extract_editable_text,
    extract_model, extract_reasoning_effort, extract_session_meta_id, extract_timestamp,
    extract_timestamp_millis, extract_usage_dedup_key, extract_usage_tokens, is_jsonl,
    is_synthetic_model, kimi, looks_like_antigravity_transcript_file,
    looks_like_copilot_events_file, looks_like_cursor_agent_transcript_file,
    looks_like_grok_updates_file, looks_like_pi_session_file, message_title_candidate,
    parse_message, qualify_model_with_reasoning_effort, scan_antigravity_jsonl_session,
    scan_copilot_jsonl_session, scan_cursor_jsonl_session, scan_grok_jsonl_session,
    scan_json_session, scan_pi_jsonl_session, update_timestamp_bounds, usage_total_tokens,
    usage_trend_point, CodexCumulativeUsage, HistoryMessage, HistoryTokenTrendPoint,
    SessionStatsScan, SessionSummaryScan, SessionUsageEventScan, UsageStatsScan, READ_BUF_CAPACITY,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

// 从 session_meta 的兼容父线程字段或子代理来源中提取首个非空父会话 ID。
pub(super) fn extract_session_meta_parent_id(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let source_parent = payload
        .get("source")
        .and_then(|source| source.get("subagent"))
        .and_then(|subagent| subagent.get("thread_spawn"))
        .and_then(|spawn| {
            spawn
                .get("parent_thread_id")
                .or_else(|| spawn.get("parentThreadId"))
        })
        .and_then(Value::as_str);
    [
        payload.get("parent_thread_id"),
        payload.get("parentThreadId"),
        payload.get("forked_from_id"),
        payload.get("forkedFromId"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .chain(source_parent)
    .map(str::trim)
    .find(|id| !id.is_empty())
    .map(str::to_string)
}

/// 单遍扫描会话文件，产出 summary 与 stats；`collect_messages` 为 true 时同时收集完整消息列表
/// （供 detail 复用同一次 IO/解析，避免二次读取）。消息的 model 回填与重复 usage 行清空语义
/// 与 `iter_session_messages` 保持一致。
// 按来源扫描摘要与用量，普通 JSONL 去重流式用量并按累计高水位还原 Codex 增量。
pub(super) fn scan_session_inner(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    let (summary, mut stats, messages) = scan_native_session(path, collect_messages);
    let events = super::scan_tool_events(path);
    super::tool_observations::reconcile_tool_stats(&mut stats, &events);
    (summary, stats, messages)
}

fn scan_native_session(
    path: &Path,
    collect_messages: bool,
) -> (SessionSummaryScan, SessionStatsScan, Vec<HistoryMessage>) {
    if !is_jsonl(path) {
        return scan_json_session(path, collect_messages);
    }
    if looks_like_copilot_events_file(path) {
        return scan_copilot_jsonl_session(path, collect_messages);
    }
    if looks_like_antigravity_transcript_file(path) {
        return scan_antigravity_jsonl_session(path, collect_messages);
    }
    if looks_like_grok_updates_file(path) {
        return scan_grok_jsonl_session(path, collect_messages);
    }
    if kimi::looks_like_kimi_main_wire(path) {
        return kimi::scan_kimi_jsonl_session(path, collect_messages);
    }
    if looks_like_pi_session_file(path) {
        return scan_pi_jsonl_session(path, collect_messages);
    }
    if looks_like_cursor_agent_transcript_file(path) {
        return scan_cursor_jsonl_session(path, collect_messages);
    }

    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            return (
                SessionSummaryScan {
                    session_id: None,
                    parent_session_id: None,
                    message_count: 0,
                    first_user_message: None,
                    first_message: None,
                    branch: None,
                    first_timestamp_ms: None,
                    last_timestamp_ms: None,
                },
                SessionStatsScan::default(),
                Vec::new(),
            );
        }
    };

    let mut session_id: Option<String> = None;
    let mut parent_session_id: Option<String> = None;
    let mut message_count = 0usize;
    let mut first_user_message: Option<String> = None;
    let mut first_message: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut first_timestamp_ms: Option<i64> = None;
    let mut last_timestamp_ms: Option<i64> = None;
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
    // Codex total_token_usage 是会话累计值；回退值是陈旧/交错快照，保持高水位后再差分。
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

        update_timestamp_bounds(&value, &mut first_timestamp_ms, &mut last_timestamp_ms);

        if branch.is_none() {
            branch = extract_branch(&value);
        }
        if session_id.is_none() {
            session_id = extract_session_meta_id(&value);
        }
        if parent_session_id.is_none() {
            parent_session_id = extract_session_meta_parent_id(&value);
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
            if codex_prev_totals
                .map(|previous| current.total_tokens > previous.total_tokens)
                .unwrap_or(true)
            {
                codex_prev_totals = Some(current);
            }
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
            parent_session_id,
            message_count,
            first_user_message,
            first_message,
            branch,
            first_timestamp_ms,
            last_timestamp_ms,
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
