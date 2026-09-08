use super::super::history_backup::ensure_source_mutation_unlocked;
use super::{
    calculate_usage_cost, detect_home_dir, excerpt, extract_text_from_value,
    extract_tool_duration_ms, extract_u64_by_keys, fallback_message_part_kind,
    invalidate_history_caches, is_injected_prompt_content, normalize_history_path,
    normalize_json_role, normalize_text, normalize_unix_timestamp_millis, positive_usage_token,
    project_key_from_cwd, session_file_fingerprint, summarize_json_value, usage_total_tokens,
    usage_trend_point, CachedSessionComputation, HistoryMessage, HistoryMessagePart,
    HistoryToolEvent, OpenCodeParsedSession, SessionFileFingerprint, SessionFileRef,
    SessionStatsScan, SessionUsageEventScan, UsageTokenScan, OPENCODE_SESSION_LOCATOR_MARKER,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(super) fn resolve_opencode_database_path() -> PathBuf {
    detect_home_dir()
        .map(|home| {
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db")
        })
        .unwrap_or_else(|| {
            PathBuf::from(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db")
        })
}

pub(super) fn opencode_session_locator(db_path: &Path, session_id: &str) -> PathBuf {
    PathBuf::from(format!(
        "{}{}{}",
        db_path.to_string_lossy(),
        OPENCODE_SESSION_LOCATOR_MARKER,
        session_id
    ))
}

pub(super) fn is_valid_opencode_session_id(session_id: &str) -> bool {
    let Some(suffix) = session_id.strip_prefix("ses_") else {
        return false;
    };
    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

pub(super) fn parse_opencode_session_locator(file_path: &str) -> Option<(PathBuf, String)> {
    let (db_path, session_id) = file_path.rsplit_once(OPENCODE_SESSION_LOCATOR_MARKER)?;
    let session_id = session_id.trim();
    if db_path.trim().is_empty() || !is_valid_opencode_session_id(session_id) {
        return None;
    }
    Some((PathBuf::from(db_path), session_id.to_string()))
}

pub(super) fn path_equals_lenient(left: &Path, right: &Path) -> bool {
    let left_canonical = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right_canonical = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    normalize_history_path(&left_canonical.to_string_lossy())
        == normalize_history_path(&right_canonical.to_string_lossy())
}

pub(super) fn opencode_locator_in_default_scope(file_path: &str) -> bool {
    parse_opencode_session_locator(file_path)
        .map(|(db_path, _)| path_equals_lenient(&db_path, &resolve_opencode_database_path()))
        .unwrap_or(false)
}

pub(super) fn opencode_sqlite_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5))
}

pub(super) fn opencode_sqlite_mutation_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(false)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(15))
}

pub(super) async fn open_opencode_database(path: &Path) -> Result<SqliteConnection, String> {
    if !path.is_file() {
        return Err("opencode_database_not_found".to_string());
    }
    let mut conn = SqliteConnection::connect_with(&opencode_sqlite_options(path))
        .await
        .map_err(|err| err.to_string())?;
    validate_opencode_schema(&mut conn).await?;
    Ok(conn)
}

pub(super) async fn open_opencode_database_for_mutation(
    path: &Path,
) -> Result<SqliteConnection, String> {
    if !path.is_file() {
        return Err("opencode_database_not_found".to_string());
    }
    let mut conn = SqliteConnection::connect_with(&opencode_sqlite_mutation_options(path))
        .await
        .map_err(|err| err.to_string())?;
    validate_opencode_schema(&mut conn).await?;
    Ok(conn)
}

pub(super) async fn validate_opencode_schema(conn: &mut SqliteConnection) -> Result<(), String> {
    let table_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM sqlite_master
         WHERE type = 'table' AND name IN ('session', 'message', 'part')",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    if table_count == 3 {
        Ok(())
    } else {
        Err("opencode_schema_unsupported".to_string())
    }
}

pub(super) async fn delete_opencode_session_from_locator(file_path: &str) -> Result<(), String> {
    let (db_path, session_id) = parse_opencode_session_locator(file_path)
        .ok_or_else(|| "invalid_session_file".to_string())?;
    if !path_equals_lenient(&db_path, &resolve_opencode_database_path()) {
        return Err("session_file_outside_history_scope".to_string());
    }
    ensure_source_mutation_unlocked("opencode")?;
    delete_opencode_session_from_database(&db_path, &session_id).await?;
    invalidate_history_caches();
    Ok(())
}

pub(super) async fn delete_opencode_session_from_database(
    db_path: &Path,
    session_id: &str,
) -> Result<(), String> {
    let mut conn = open_opencode_database_for_mutation(db_path).await?;
    let mut transaction = conn.begin().await.map_err(|err| err.to_string())?;

    sqlx::query("DELETE FROM part WHERE session_id = ?1")
        .bind(session_id)
        .execute(&mut *transaction)
        .await
        .map_err(|err| err.to_string())?;
    sqlx::query("DELETE FROM message WHERE session_id = ?1")
        .bind(session_id)
        .execute(&mut *transaction)
        .await
        .map_err(|err| err.to_string())?;
    let deleted_session = sqlx::query("DELETE FROM session WHERE id = ?1")
        .bind(session_id)
        .execute(&mut *transaction)
        .await
        .map_err(|err| err.to_string())?;
    if deleted_session.rows_affected() != 1 {
        transaction
            .rollback()
            .await
            .map_err(|err| err.to_string())?;
        return Err("session_file_not_indexed".to_string());
    }
    transaction.commit().await.map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) async fn opencode_catalog_sessions() -> Result<Option<Vec<OpenCodeParsedSession>>, String>
{
    let db_path = resolve_opencode_database_path();
    if !db_path.is_file() {
        return Ok(None);
    }
    parse_opencode_database(&db_path, None).await.map(Some)
}

pub(super) async fn parse_opencode_database(
    db_path: &Path,
    only_session_id: Option<&str>,
) -> Result<Vec<OpenCodeParsedSession>, String> {
    let mut conn = open_opencode_database(db_path).await?;
    let rows = if let Some(session_id) = only_session_id {
        sqlx::query(
            "SELECT id, directory, title, slug,
                    CAST(time_created AS REAL) AS time_created,
                    CAST(time_updated AS REAL) AS time_updated
             FROM session
             WHERE id = ?1
             ORDER BY time_updated DESC, id ASC",
        )
        .bind(session_id)
        .fetch_all(&mut conn)
        .await
        .map_err(|err| err.to_string())?
    } else {
        sqlx::query(
            "SELECT id, directory, title, slug,
                    CAST(time_created AS REAL) AS time_created,
                    CAST(time_updated AS REAL) AS time_updated
             FROM session
             ORDER BY time_updated DESC, id ASC",
        )
        .fetch_all(&mut conn)
        .await
        .map_err(|err| err.to_string())?
    };

    let db_fingerprint = session_file_fingerprint(db_path);
    let mut sessions = Vec::with_capacity(rows.len());
    for row in rows {
        let session_id: String = row.try_get("id").map_err(|err| err.to_string())?;
        let cwd: Option<String> = row
            .try_get::<Option<String>, _>("directory")
            .map_err(|err| err.to_string())?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let title = row
            .try_get::<Option<String>, _>("title")
            .map_err(|err| err.to_string())?
            .or_else(|| row.try_get::<Option<String>, _>("slug").ok().flatten())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let created_at = opencode_time_millis(row.try_get("time_created").ok().flatten())
            .unwrap_or(db_fingerprint.created_at);
        let updated_at = opencode_time_millis(row.try_get("time_updated").ok().flatten())
            .unwrap_or(db_fingerprint.updated_at.max(created_at));
        sessions.push(
            parse_opencode_session_row(
                &mut conn,
                db_path,
                db_fingerprint,
                session_id,
                cwd,
                title,
                created_at,
                updated_at,
            )
            .await?,
        );
    }
    Ok(sessions)
}

pub(super) async fn parse_opencode_session_row(
    conn: &mut SqliteConnection,
    db_path: &Path,
    db_fingerprint: SessionFileFingerprint,
    session_id: String,
    cwd: Option<String>,
    title: Option<String>,
    created_at: i64,
    updated_at: i64,
) -> Result<OpenCodeParsedSession, String> {
    let rows = sqlx::query(
        "SELECT id,
                CAST(time_created AS REAL) AS time_created,
                CAST(time_updated AS REAL) AS time_updated,
                data
         FROM message
         WHERE session_id = ?1
         ORDER BY time_created ASC, id ASC",
    )
    .bind(&session_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    let mut messages = Vec::new();
    let mut tool_events = Vec::new();
    let mut stats = SessionStatsScan::default();
    let mut first_message = None;
    let mut first_user_message = None;
    let mut model_hits: HashMap<String, usize> = HashMap::new();

    for (message_index, row) in rows.into_iter().enumerate() {
        let message_id: String = row.try_get("id").map_err(|err| err.to_string())?;
        let data = row
            .try_get::<String, _>("data")
            .map_err(|err| err.to_string())
            .and_then(|raw| serde_json::from_str::<Value>(&raw).map_err(|err| err.to_string()))?;
        let role = normalize_json_role(data.get("role"));
        let timestamp_ms = opencode_time_millis(row.try_get("time_created").ok().flatten())
            .or_else(|| opencode_time_millis(row.try_get("time_updated").ok().flatten()));
        let timestamp = timestamp_ms.and_then(timestamp_millis_to_rfc3339);
        let model = opencode_model(&data);
        if let Some(model) = &model {
            *model_hits.entry(model.clone()).or_insert(0) += 1;
            stats.current_model = Some(model.clone());
        }

        let parts = opencode_message_parts(conn, &session_id, &message_id).await?;
        let mut content_parts = Vec::new();
        let mut message_parts = Vec::new();
        for part in &parts {
            if let Some(text) = opencode_part_text(part) {
                content_parts.push(text.clone());
                message_parts.push(opencode_history_message_part(part, &role, text));
            }
            if let Some(event) = opencode_tool_event(part, message_index, timestamp.clone()) {
                tool_events.push(event);
                stats.tool_call_count = stats.tool_call_count.saturating_add(1);
                *stats
                    .builtin_calls
                    .entry(tool_events.last().unwrap().name.clone())
                    .or_insert(0) += 1;
            }
        }
        let content = normalize_text(&content_parts.join("\n\n"));
        if content.is_empty() {
            continue;
        }

        if first_message.is_none() {
            first_message = Some(excerpt(&content, 80));
        }
        if first_user_message.is_none() && role == "user" {
            first_user_message = Some(excerpt(&content, 80));
        }

        let usage = opencode_usage_tokens(&data);
        let cost = calculate_usage_cost(model.as_deref(), usage);
        if usage_total_tokens(usage) > 0 {
            stats.input_tokens = stats.input_tokens.saturating_add(usage.input_tokens);
            stats.output_tokens = stats.output_tokens.saturating_add(usage.output_tokens);
            stats.cache_read_tokens = stats
                .cache_read_tokens
                .saturating_add(usage.cache_read_tokens);
            stats.cache_creation_tokens = stats
                .cache_creation_tokens
                .saturating_add(usage.cache_creation_tokens);
            stats.total_cost_usd += cost.total_cost_usd;
            stats.unpriced_tokens = stats.unpriced_tokens.saturating_add(cost.unpriced_tokens);
            stats
                .token_trend
                .push(usage_trend_point(usage, model.clone()));
            let event_index = stats.usage_events.len();
            stats.usage_events.push(SessionUsageEventScan {
                event_key: format!("opencode:{session_id}:{message_id}"),
                event_index,
                timestamp_ms,
                model: model.clone(),
                usage: cost,
            });
            if let Some(model) = &model {
                let entry = stats.model_usage.entry(model.clone()).or_default();
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

        messages.push(HistoryMessage {
            role,
            content,
            parts: message_parts,
            timestamp,
            model,
            input_tokens: positive_usage_token(usage.input_tokens),
            output_tokens: positive_usage_token(usage.output_tokens),
            cache_read_tokens: positive_usage_token(usage.cache_read_tokens),
            cache_creation_tokens: positive_usage_token(usage.cache_creation_tokens),
            line_index: None,
            editable: false,
            editable_text: None,
        });
    }

    stats.dominant_model = model_hits
        .into_iter()
        .max_by(|(left_model, left_hits), (right_model, right_hits)| {
            left_hits
                .cmp(right_hits)
                .then_with(|| right_model.cmp(left_model))
        })
        .map(|(model, _)| model);

    let project_key = cwd
        .as_deref()
        .and_then(project_key_from_cwd)
        .unwrap_or_else(|| "opencode".to_string());
    let title = title
        .or_else(|| first_user_message.clone())
        .or_else(|| first_message.clone())
        .unwrap_or_else(|| session_id.clone());
    let file_ref = SessionFileRef {
        source: "opencode".to_string(),
        project_key,
        path: opencode_session_locator(db_path, &session_id),
    };
    let tool_events = super::tool_observations::merge_tool_events(tool_events);
    super::tool_observations::reconcile_tool_stats(&mut stats, &tool_events);
    let computed = CachedSessionComputation {
        created_at,
        updated_at,
        session_id,
        parent_session_id: None,
        title,
        message_count: messages.len(),
        branch: None,
        stats,
    };
    Ok(OpenCodeParsedSession {
        file_ref,
        fingerprint: SessionFileFingerprint {
            created_at: db_fingerprint.created_at,
            updated_at: updated_at.max(db_fingerprint.updated_at),
            size: db_fingerprint.size,
        },
        computed,
        cwd,
        messages,
        tool_events,
    })
}

pub(super) async fn opencode_message_parts(
    conn: &mut SqliteConnection,
    session_id: &str,
    message_id: &str,
) -> Result<Vec<Value>, String> {
    let rows = sqlx::query(
        "SELECT data
         FROM part
         WHERE session_id = ?1 AND message_id = ?2
         ORDER BY time_created ASC, id ASC",
    )
    .bind(session_id)
    .bind(message_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.try_get("data").map_err(|err| err.to_string())?;
            serde_json::from_str::<Value>(&raw).map_err(|err| err.to_string())
        })
        .collect()
}

pub(super) fn opencode_time_millis(value: Option<f64>) -> Option<i64> {
    value.and_then(normalize_unix_timestamp_millis)
}

pub(super) fn timestamp_millis_to_rfc3339(value: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value)
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub(super) fn opencode_model(data: &Value) -> Option<String> {
    let model = data
        .get("modelID")
        .or_else(|| data.get("model_id"))
        .or_else(|| data.get("model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let provider = data
        .get("providerID")
        .or_else(|| data.get("provider_id"))
        .or_else(|| data.get("provider"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Some(match provider {
        Some(provider) if !model.contains('/') => format!("{provider}/{model}"),
        _ => model.to_string(),
    })
}

pub(super) fn opencode_usage_tokens(data: &Value) -> UsageTokenScan {
    let Some(tokens) = data.get("tokens").and_then(Value::as_object) else {
        return UsageTokenScan::default();
    };
    let cache = tokens.get("cache").and_then(Value::as_object);
    UsageTokenScan {
        input_tokens: extract_u64_by_keys(tokens, &["input"]).unwrap_or(0),
        output_tokens: extract_u64_by_keys(tokens, &["output"])
            .unwrap_or(0)
            .saturating_add(extract_u64_by_keys(tokens, &["reasoning"]).unwrap_or(0)),
        cache_read_tokens: cache
            .and_then(|cache| extract_u64_by_keys(cache, &["read"]))
            .unwrap_or(0),
        cache_creation_tokens: cache
            .and_then(|cache| extract_u64_by_keys(cache, &["write"]))
            .unwrap_or(0),
        explicit_cost_usd: None,
    }
}

pub(super) fn opencode_part_text(part: &Value) -> Option<String> {
    let part_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
    let text = match part_type {
        "text" | "reasoning" | "patch" => part
            .get("text")
            .or_else(|| part.get("content"))
            .or_else(|| part.get("patch"))
            .and_then(extract_text_from_value),
        "tool" | "tool-invocation" | "tool-result" => opencode_tool_summary(part),
        "step-start" | "step-finish" => None,
        _ => extract_text_from_value(part),
    }?;
    let text = normalize_text(&text);
    (!text.is_empty()).then_some(text)
}

pub(super) fn opencode_history_message_part(
    part: &Value,
    role: &str,
    content: String,
) -> HistoryMessagePart {
    let part_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
    let kind = match part_type {
        "reasoning" => "reasoning",
        "tool-result" => "tool_result",
        "tool" | "tool-invocation" | "patch" => "tool_call",
        "text" if is_injected_prompt_content(&content) => "system",
        "text" => "text",
        _ => fallback_message_part_kind(role, &content),
    };
    HistoryMessagePart {
        kind: kind.to_string(),
        content,
        tool_name: opencode_tool_name(part),
        call_id: part
            .get("callID")
            .or_else(|| part.get("call_id"))
            .or_else(|| part.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

pub(super) fn opencode_tool_name(part: &Value) -> Option<String> {
    [
        part.get("tool"),
        part.get("name"),
        part.get("call").and_then(|value| value.get("name")),
        part.get("state").and_then(|value| value.get("title")),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

pub(super) fn opencode_tool_summary(part: &Value) -> Option<String> {
    let name = opencode_tool_name(part).unwrap_or_else(|| "tool".to_string());
    let payload = part
        .get("input")
        .or_else(|| part.get("arguments"))
        .or_else(|| part.get("output"))
        .or_else(|| part.get("result"))
        .or_else(|| part.get("state"));
    let summary = payload.and_then(summarize_json_value);
    Some(match summary {
        Some(summary) => format!("[Tool: {name}]\n{summary}"),
        None => format!("[Tool: {name}]"),
    })
}

pub(super) fn opencode_tool_event(
    part: &Value,
    message_index: usize,
    timestamp: Option<String>,
) -> Option<HistoryToolEvent> {
    let part_type = part.get("type").and_then(Value::as_str)?;
    if !matches!(part_type, "tool" | "tool-invocation" | "tool-result") {
        return None;
    }
    let name = opencode_tool_name(part).unwrap_or_else(|| "tool".to_string());
    Some(HistoryToolEvent {
        evidence: None,
        call_id: part
            .get("callID")
            .or_else(|| part.get("id"))
            .or_else(|| part.get("call_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        category: super::tool_observations::tool_category(&name, super::tool_observations::mcp_server(part)),
        name,
        message_index: Some(message_index),
        timestamp,
        status: part
            .get("status")
            .or_else(|| part.get("state").and_then(|value| value.get("status")))
            .and_then(Value::as_str)
            .map(str::to_string),
        duration_ms: extract_tool_duration_ms(part),
        input_summary: part
            .get("input")
            .or_else(|| part.get("arguments"))
            .or_else(|| part.get("state").and_then(|state| state.get("input")))
            .and_then(summarize_json_value),
        output_summary: part
            .get("output")
            .or_else(|| part.get("result"))
            .or_else(|| part.get("state").and_then(|state| state.get("output").or_else(|| state.get("error"))))
            .and_then(summarize_json_value),
    })
}
