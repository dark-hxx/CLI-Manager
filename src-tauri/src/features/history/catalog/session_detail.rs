use super::super::*;
use super::open_catalog;
use sqlx::{Row, SqliteConnection};
use std::collections::HashMap;
use std::path::Path;

// 解析原始指针数组并取首个有效行索引。
pub(super) fn v2_raw_pointer_line_index(raw_pointers_json: Option<String>) -> Option<usize> {
    let raw = raw_pointers_json?;
    let pointers = serde_json::from_str::<Vec<Value>>(&raw).ok()?;
    pointers
        .iter()
        .find_map(|pointer| pointer.get("lineIndex").and_then(Value::as_u64))
        .map(|value| value as usize)
}

// 打开历史目录连接并读取第二代缓存会话详情。
pub(crate) async fn get_session_detail_from_v2(
    roots: &HistoryRoots,
    file_path: &str,
    source: &str,
    project_key: &str,
) -> Result<Option<HistorySessionDetail>, String> {
    let mut conn = open_catalog().await?;
    get_session_detail_from_v2_with_conn(&mut conn, roots, file_path, source, project_key).await
}

// 校验源文件指纹后组装第二代详情、消息、用量、工具与文件变更。
pub(super) async fn get_session_detail_from_v2_with_conn(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    file_path: &str,
    source: &str,
    project_key: &str,
) -> Result<Option<HistorySessionDetail>, String> {
    let codex_thread_names = if source.eq_ignore_ascii_case("codex") {
        let roots_for_names = roots.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                super::super::codex_thread_name_index(&roots_for_names)
            })
            .await
            .map_err(|err| err.to_string())?,
        )
    } else {
        None
    };
    let row = sqlx::query(
        "SELECT hs.id, i.source_id AS source, hs.source_session_id AS session_id,
                hs.project_key, hs.title,
                COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                hs.cwd, hs.created_at, hs.updated_at, hs.message_count, hs.branch,
                hs.input_tokens, hs.output_tokens, hs.cache_read_tokens,
                hs.cache_creation_tokens, hs.total_cost_usd, hs.dominant_model,
                hs.current_model, hs.context_window, hs.last_context_tokens,
                hs.reasoning_effort, hs.tool_call_count, hs.fingerprint_value
         FROM history_sessions hs
         JOIN history_source_instances i ON i.id = hs.source_instance_id
         WHERE i.activation_state = 'active'
           AND hs.parse_status = 'ok'
           AND i.source_id = ?1
           AND hs.project_key = ?2
           AND COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) = ?3
         LIMIT 1",
    )
    .bind(source)
    .bind(project_key)
    .bind(file_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let Some(row) = row else {
        return Ok(None);
    };

    let session_row_id: i64 = row.try_get("id").map_err(|err| err.to_string())?;
    let source: String = row.try_get("source").map_err(|err| err.to_string())?;
    let session_id: String = row.try_get("session_id").map_err(|err| err.to_string())?;
    let mut title: String = row.try_get("title").map_err(|err| err.to_string())?;
    if let Some(index) = codex_thread_names.as_ref() {
        if let Some(thread_name) = index.names.get(&session_id) {
            title = thread_name.clone();
        }
    }
    let file_path: String = row.try_get("file_path").map_err(|err| err.to_string())?;
    let source_path = Path::new(&file_path);
    let current_file_updated_at = source_path
        .exists()
        .then(|| session_file_fingerprint(source_path).updated_at);
    let indexed_fingerprint: Option<String> = row
        .try_get("fingerprint_value")
        .map_err(|err| err.to_string())?;
    if source_path.exists()
        && indexed_fingerprint.as_deref().map_or(true, |fingerprint| {
            v2_fingerprint_value(session_file_fingerprint(source_path)) != fingerprint
        })
    {
        // The source file may have been edited outside the catalog writer (or the
        // catalog may still contain a pre-edit snapshot). Fall back to the live
        // parser so callers never see stale message content.
        return Ok(None);
    }
    let input_tokens = row
        .try_get::<i64, _>("input_tokens")
        .map_err(|err| err.to_string())?
        .max(0) as u64;
    let output_tokens = row
        .try_get::<i64, _>("output_tokens")
        .map_err(|err| err.to_string())?
        .max(0) as u64;
    let cache_read_tokens = row
        .try_get::<i64, _>("cache_read_tokens")
        .map_err(|err| err.to_string())?
        .max(0) as u64;
    let cache_creation_tokens = row
        .try_get::<i64, _>("cache_creation_tokens")
        .map_err(|err| err.to_string())?
        .max(0) as u64;
    let dominant_model: Option<String> = row
        .try_get("dominant_model")
        .map_err(|err| err.to_string())?;
    let mut token_trend = Vec::new();
    let usage_rows = sqlx::query(
        "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
         FROM history_usage_events
         WHERE session_id = ?1
         ORDER BY event_index ASC",
    )
    .bind(session_row_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    for usage_row in usage_rows {
        let usage = UsageTokenScan {
            input_tokens: usage_row
                .try_get::<i64, _>("input_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            output_tokens: usage_row
                .try_get::<i64, _>("output_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            cache_read_tokens: usage_row
                .try_get::<i64, _>("cache_read_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            cache_creation_tokens: usage_row
                .try_get::<i64, _>("cache_creation_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            explicit_cost_usd: None,
        };
        if usage_total_tokens(usage) > 0 {
            token_trend.push(usage_trend_point(
                usage,
                usage_row.try_get("model").map_err(|err| err.to_string())?,
            ));
        }
    }
    if token_trend.is_empty()
        && input_tokens
            .saturating_add(output_tokens)
            .saturating_add(cache_read_tokens)
            .saturating_add(cache_creation_tokens)
            > 0
    {
        token_trend.push(usage_trend_point(
            UsageTokenScan {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                explicit_cost_usd: None,
            },
            dominant_model.clone(),
        ));
    }

    let message_rows = sqlx::query(
        "SELECT id, message_index, role, display_content, timestamp_ms, model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                editable, raw_pointers_json
         FROM history_messages
         WHERE session_id = ?1
         ORDER BY message_index ASC",
    )
    .bind(session_row_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let part_rows = sqlx::query(
        "SELECT p.message_id, p.kind, p.text_content, p.tool_name, p.tool_call_id
         FROM history_message_parts p
         INNER JOIN history_messages m ON m.id = p.message_id
         WHERE m.session_id = ?1
         ORDER BY m.message_index ASC, p.part_index ASC",
    )
    .bind(session_row_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let mut parts_by_message_id: HashMap<i64, Vec<HistoryMessagePart>> = HashMap::new();
    for part_row in part_rows {
        let Some(content) = part_row
            .try_get::<Option<String>, _>("text_content")
            .map_err(|err| err.to_string())?
            .filter(|content| !content.trim().is_empty())
        else {
            continue;
        };
        let message_id: i64 = part_row
            .try_get("message_id")
            .map_err(|err| err.to_string())?;
        parts_by_message_id
            .entry(message_id)
            .or_default()
            .push(HistoryMessagePart {
                kind: part_row.try_get("kind").map_err(|err| err.to_string())?,
                content,
                tool_name: part_row
                    .try_get("tool_name")
                    .map_err(|err| err.to_string())?,
                call_id: part_row
                    .try_get("tool_call_id")
                    .map_err(|err| err.to_string())?,
            });
    }
    let mut messages = Vec::with_capacity(message_rows.len());
    for message_row in message_rows {
        let timestamp_ms = message_row
            .try_get::<Option<i64>, _>("timestamp_ms")
            .map_err(|err| err.to_string())?;
        let message_row_id: i64 = message_row.try_get("id").map_err(|err| err.to_string())?;
        let role: String = message_row.try_get("role").map_err(|err| err.to_string())?;
        let content: String = message_row
            .try_get("display_content")
            .map_err(|err| err.to_string())?;
        let mut parts = parts_by_message_id
            .remove(&message_row_id)
            .unwrap_or_default();
        if parts.is_empty() {
            parts.push(fallback_history_message_part(&role, &content));
        }
        messages.push(HistoryMessage {
            parts,
            role,
            content,
            timestamp: timestamp_ms.and_then(timestamp_millis_to_rfc3339),
            model: message_row
                .try_get("model")
                .map_err(|err| err.to_string())?,
            input_tokens: message_row
                .try_get::<Option<i64>, _>("input_tokens")
                .map_err(|err| err.to_string())?
                .map(|value| value.max(0) as u64),
            output_tokens: message_row
                .try_get::<Option<i64>, _>("output_tokens")
                .map_err(|err| err.to_string())?
                .map(|value| value.max(0) as u64),
            cache_read_tokens: message_row
                .try_get::<Option<i64>, _>("cache_read_tokens")
                .map_err(|err| err.to_string())?
                .map(|value| value.max(0) as u64),
            cache_creation_tokens: message_row
                .try_get::<Option<i64>, _>("cache_creation_tokens")
                .map_err(|err| err.to_string())?
                .map(|value| value.max(0) as u64),
            line_index: v2_raw_pointer_line_index(
                message_row
                    .try_get("raw_pointers_json")
                    .map_err(|err| err.to_string())?,
            ),
            editable: message_row
                .try_get::<i64, _>("editable")
                .map_err(|err| err.to_string())?
                != 0,
            editable_text: None,
        });
    }

    let tool_rows = sqlx::query(
        "SELECT te.call_id, te.name, te.category, hm.message_index, te.timestamp_ms,
                te.status, te.duration_ms, te.input_summary, te.output_summary, te.source_extension_json
         FROM history_tool_events te
         LEFT JOIN history_messages hm ON hm.id = te.message_id
         WHERE te.session_id = ?1
         ORDER BY te.event_index ASC",
    )
    .bind(session_row_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let mut mcp_calls = HashMap::new();
    let mut skill_calls = HashMap::new();
    let mut builtin_calls = HashMap::new();
    let mut tool_events = Vec::new();
    for tool_row in tool_rows {
        let name: String = tool_row.try_get("name").map_err(|err| err.to_string())?;
        let category: String = tool_row
            .try_get("category")
            .map_err(|err| err.to_string())?;
        let evidence = tool_row.try_get::<Option<String>, _>("source_extension_json")
            .map_err(|err| err.to_string())?
            .and_then(|raw| serde_json::from_str::<super::super::types::HistoryToolEvidence>(&raw).ok());
        let inferred = evidence.as_ref().is_some_and(|e| e.kind == "inferred");
        match category.as_str() {
            _ if inferred => {},
            category if category.starts_with("mcp:") => {
                *mcp_calls.entry(category[4..].to_string()).or_insert(0) += 1;
            },
            "mcp" => *mcp_calls.entry(name.clone()).or_insert(0) += 1,
            "skill" => {
                let skill = tool_row.try_get::<Option<String>, _>("input_summary").ok().flatten()
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .and_then(|value| value.get("skill").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| name.clone());
                *skill_calls.entry(skill).or_insert(0) += 1;
            },
            _ => *builtin_calls.entry(name.clone()).or_insert(0) += 1,
        }
        let timestamp_ms = tool_row
            .try_get::<Option<i64>, _>("timestamp_ms")
            .map_err(|err| err.to_string())?;
        tool_events.push(HistoryToolEvent {
            evidence,
            call_id: tool_row.try_get("call_id").map_err(|err| err.to_string())?,
            name,
            category,
            message_index: tool_row
                .try_get::<Option<i64>, _>("message_index")
                .map_err(|err| err.to_string())?
                .map(|value| value.max(0) as usize),
            timestamp: timestamp_ms.and_then(timestamp_millis_to_rfc3339),
            status: tool_row.try_get("status").map_err(|err| err.to_string())?,
            duration_ms: tool_row
                .try_get::<Option<i64>, _>("duration_ms")
                .map_err(|err| err.to_string())?
                .map(|value| value.max(0) as u64),
            input_summary: tool_row
                .try_get("input_summary")
                .map_err(|err| err.to_string())?,
            output_summary: tool_row
                .try_get("output_summary")
                .map_err(|err| err.to_string())?,
        });
    }

    let change_rows = sqlx::query(
        "SELECT change_index, source_kind, tool_name, file_path, old_text, new_text,
                patch, additions, deletions, timestamp_ms
         FROM history_file_changes
         WHERE session_id = ?1
         ORDER BY change_index ASC",
    )
    .bind(session_row_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let mut operations = Vec::new();
    for change_row in change_rows {
        let timestamp_ms = change_row
            .try_get::<Option<i64>, _>("timestamp_ms")
            .map_err(|err| err.to_string())?;
        operations.push(HistoryFileChangeOperation {
            source: change_row
                .try_get("source_kind")
                .map_err(|err| err.to_string())?,
            tool_name: change_row
                .try_get("tool_name")
                .map_err(|err| err.to_string())?,
            file_path: change_row
                .try_get("file_path")
                .map_err(|err| err.to_string())?,
            old_text: change_row
                .try_get("old_text")
                .map_err(|err| err.to_string())?,
            new_text: change_row
                .try_get("new_text")
                .map_err(|err| err.to_string())?,
            patch: change_row.try_get("patch").map_err(|err| err.to_string())?,
            additions: change_row
                .try_get::<i64, _>("additions")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            deletions: change_row
                .try_get::<i64, _>("deletions")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            message_index: None,
            operation_group_index: change_row
                .try_get::<i64, _>("change_index")
                .map_err(|err| err.to_string())
                .ok()
                .map(|value| value.max(0) as usize),
            timestamp: timestamp_ms.and_then(timestamp_millis_to_rfc3339),
        });
    }

    Ok(Some(HistorySessionDetail {
        session_id,
        source,
        project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
        title,
        file_path,
        cwd: row.try_get("cwd").map_err(|err| err.to_string())?,
        created_at: row.try_get("created_at").map_err(|err| err.to_string())?,
        updated_at: match current_file_updated_at {
            Some(value) => value,
            None => row.try_get("updated_at").map_err(|err| err.to_string())?,
        },
        message_count: messages.len(),
        branch: row.try_get("branch").map_err(|err| err.to_string())?,
        usage: HistorySessionUsage {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            total_cost_usd: row
                .try_get("total_cost_usd")
                .map_err(|err| err.to_string())?,
            dominant_model,
            current_model: row
                .try_get("current_model")
                .map_err(|err| err.to_string())?,
            context_window: row
                .try_get::<Option<i64>, _>("context_window")
                .map_err(|err| err.to_string())?
                .map(|value| value.max(0) as u64),
            last_context_tokens: row
                .try_get::<Option<i64>, _>("last_context_tokens")
                .map_err(|err| err.to_string())?
                .map(|value| value.max(0) as u64),
            reasoning_effort: row
                .try_get("reasoning_effort")
                .map_err(|err| err.to_string())?,
            token_trend,
            tool_call_count: row
                .try_get::<i64, _>("tool_call_count")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            mcp_calls: sorted_tool_counts(&mcp_calls),
            skill_calls: sorted_tool_counts(&skill_calls),
            builtin_calls: sorted_tool_counts(&builtin_calls),
        },
        tool_events,
        file_changes: summarize_file_change_operations(operations),
        messages,
    }))
}
