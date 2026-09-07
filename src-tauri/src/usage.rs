use bytes::Bytes;
use regex::{Captures, Regex};
use serde_json::Value;
#[cfg(test)]
use sqlx::Connection;
use sqlx::{Row, SqliteConnection};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use uuid::Uuid;

const MAX_SSE_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS: usize = 1_024;
static ROUTE_USAGE_GENERATION: AtomicU64 = AtomicU64::new(0);
static SENSITIVE_ASSIGNMENT_RE: OnceLock<Regex> = OnceLock::new();
static BEARER_TOKEN_RE: OnceLock<Regex> = OnceLock::new();
static SECRET_VALUE_RE: OnceLock<Regex> = OnceLock::new();
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UsageTokens {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

impl UsageTokens {
    pub fn total(self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
    }

    fn max_assign(&mut self, other: Self) {
        self.input_tokens = self.input_tokens.max(other.input_tokens);
        self.output_tokens = self.output_tokens.max(other.output_tokens);
        self.cache_read_tokens = self.cache_read_tokens.max(other.cache_read_tokens);
        self.cache_creation_tokens = self.cache_creation_tokens.max(other.cache_creation_tokens);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsageCapture {
    pub usage: UsageTokens,
    pub response_model: Option<String>,
    pub error_detail: Option<String>,
    pub completed: bool,
    pub failed: bool,
}

#[derive(Debug, Clone)]
pub struct RouteUsageContext {
    pub request_id: String,
    pub logical_request_id: String,
    pub app_type: String,
    pub session_id: Option<String>,
    pub requested_model: Option<String>,
    pub outbound_model: Option<String>,
    pub provider_id: String,
    pub provider_name: String,
    pub started_at_ms: i64,
    pub is_streaming: bool,
    pub attempt_index: u32,
    pub attempt_count: u32,
    pub degraded: bool,
}

#[derive(Debug, Clone)]
pub struct RouteUsageRecord {
    pub source: String,
    pub session_id: Option<String>,
    pub project_key: Option<String>,
    pub file_path: Option<String>,
    pub timestamp_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub model: Option<String>,
    pub usage: UsageTokens,
    pub usage_status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageStatus {
    Complete,
    Partial,
    Missing,
    Invalid,
    NotApplicable,
}

impl UsageStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Partial => "partial",
            Self::Missing => "missing",
            Self::Invalid => "invalid",
            Self::NotApplicable => "not_applicable",
        }
    }
}

pub fn new_request_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn route_usage_generation() -> u64 {
    ROUTE_USAGE_GENERATION.load(Ordering::Acquire)
}

pub fn session_id_from_headers_and_body(
    app_type: &str,
    headers: &[(String, String)],
    body: &Value,
) -> Option<String> {
    let header_candidates: &[&str] = match app_type {
        "claude" => &["x-claude-code-session-id", "x-session-id"],
        "codex" => &["x-session-id", "session-id"],
        "grokbuild" => &["x-grok-conv-id", "x-grok-session-id"],
        _ => &["x-session-id"],
    };
    for name in header_candidates {
        if let Some(value) = headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }
    let body_candidates: &[&str] = match app_type {
        "claude" => &["session_id", "sessionId", "metadata.user_id"],
        "codex" => &["session_id", "sessionId", "previous_response_id"],
        "grokbuild" => &["conversation_id", "conversationId", "session_id"],
        _ => &["session_id", "sessionId"],
    };
    for path in body_candidates {
        let mut current = body;
        for part in path.split('.') {
            let Some(next) = current.get(part) else {
                current = &Value::Null;
                break;
            };
            current = next;
        }
        if let Some(value) = current
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if app_type == "codex" && *path == "previous_response_id" {
                continue;
            }
            return Some(value.to_string());
        }
    }
    None
}

pub fn parse_response_json(value: &Value) -> UsageCapture {
    let mut capture = UsageCapture::default();
    capture.error_detail = extract_error_detail(value);
    scan_json(value, &mut capture);
    capture
}

fn scan_json(value: &Value, capture: &mut UsageCapture) {
    if let Some(object) = value.as_object() {
        if let Some(usage) = object
            .get("usage")
            .or_else(|| object.get("usageMetadata"))
            .or_else(|| object.get("usage_metadata"))
        {
            capture.usage.max_assign(parse_usage(usage));
        }
        if let Some(model) = object
            .get("model")
            .or_else(|| object.get("model_name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|model| !model.is_empty())
        {
            capture.response_model = Some(model.to_string());
        }
        if object
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "response.completed" || kind == "message_stop")
        {
            capture.completed = true;
        }
        if object
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "error" || kind == "response.failed")
        {
            capture.failed = true;
        }
        for child in object.values() {
            scan_json(child, capture);
        }
    } else if let Some(array) = value.as_array() {
        for child in array {
            scan_json(child, capture);
        }
    }
}

fn extract_error_detail(value: &Value) -> Option<String> {
    let error = value.get("error");
    let candidate = [
        error.and_then(Value::as_str),
        error
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str),
        error
            .and_then(|error| error.get("detail"))
            .and_then(Value::as_str),
        error
            .and_then(|error| error.get("error_description"))
            .and_then(Value::as_str),
        error
            .and_then(|error| error.get("reason"))
            .and_then(Value::as_str),
        value.get("message").and_then(Value::as_str),
        value.get("detail").and_then(Value::as_str),
        value.get("error_description").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|candidate| !candidate.is_empty());
    candidate.and_then(sanitize_error_detail)
}

fn sensitive_assignment_re() -> &'static Regex {
    SENSITIVE_ASSIGNMENT_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)((?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|bearer|token|secret|password|passwd|client[_ -]?secret)\s*[:=]\s*)(?:Bearer\s+)?(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"#,
        )
        .expect("valid usage error detail sensitive assignment regex")
    })
}

fn bearer_token_re() -> &'static Regex {
    BEARER_TOKEN_RE.get_or_init(|| {
        Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
            .expect("valid usage error detail bearer regex")
    })
}

fn secret_value_re() -> &'static Regex {
    SECRET_VALUE_RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b",
        )
        .expect("valid usage error detail secret regex")
    })
}

fn sanitize_error_detail(raw: &str) -> Option<String> {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let assigned = sensitive_assignment_re()
        .replace_all(&normalized, |captures: &Captures<'_>| {
            format!(
                "{}<redacted>",
                captures.get(1).map_or("", |capture| capture.as_str())
            )
        })
        .into_owned();
    let bearer = bearer_token_re().replace_all(&assigned, "<redacted>");
    let redacted = secret_value_re()
        .replace_all(&bearer, "<redacted>")
        .into_owned();
    let mut chars = redacted.chars();
    let limited = chars
        .by_ref()
        .take(MAX_ERROR_DETAIL_CHARS)
        .collect::<String>();
    Some(if chars.next().is_some() {
        format!("{limited}…")
    } else {
        limited
    })
}

fn parse_usage(value: &Value) -> UsageTokens {
    let get = |keys: &[&str]| {
        keys.iter()
            .filter_map(|key| value.get(*key))
            .find_map(as_non_negative_u64)
            .unwrap_or(0)
    };
    UsageTokens {
        input_tokens: get(&[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokenCount",
        ]),
        output_tokens: get(&[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "candidatesTokenCount",
        ]),
        cache_read_tokens: get(&[
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cache_read_tokens",
            "cacheReadTokens",
            "cached_tokens",
            "cachedTokenCount",
        ]),
        cache_creation_tokens: get(&[
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
            "cache_creation_tokens",
            "cacheCreationTokens",
        ]),
    }
}

fn as_non_negative_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(value) => value.as_u64().or_else(|| {
            value
                .as_i64()
                .filter(|value| *value >= 0)
                .map(|value| value as u64)
        }),
        Value::String(value) => value.trim().parse::<u64>().ok(),
        _ => None,
    }
}

#[derive(Debug, Default)]
pub struct SseUsageCollector {
    buffer: String,
    capture: UsageCapture,
}

impl SseUsageCollector {
    pub fn observe(&mut self, bytes: &Bytes) {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        if self.buffer.len() > MAX_SSE_BUFFER_BYTES {
            let keep_from = self.buffer.len().saturating_sub(MAX_SSE_BUFFER_BYTES);
            self.buffer.drain(..keep_from);
        }
        while let Some((end, delimiter_len)) = sse_event_boundary(&self.buffer) {
            let event = self.buffer[..end].to_string();
            self.buffer.drain(..end + delimiter_len);
            self.observe_event(&event);
        }
    }

    fn observe_event(&mut self, event: &str) {
        let mut data = String::new();
        for line in event.lines() {
            let line = line.trim_end_matches('\r');
            if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim_start());
            }
        }
        let payload = if data.is_empty() {
            event.trim()
        } else {
            data.as_str()
        };
        if payload.is_empty() {
            return;
        }
        if payload == "[DONE]" {
            self.capture.completed = true;
            return;
        }
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            let next = parse_response_json(&value);
            self.capture.usage.max_assign(next.usage);
            if next.response_model.is_some() {
                self.capture.response_model = next.response_model;
            }
            if next.error_detail.is_some() {
                self.capture.error_detail = next.error_detail;
            }
            self.capture.completed |= next.completed;
            self.capture.failed |= next.failed;
        }
    }

    pub fn finish(mut self) -> UsageCapture {
        if !self.buffer.trim().is_empty() {
            let event = std::mem::take(&mut self.buffer);
            self.observe_event(&event);
        }
        self.capture
    }
}

fn sse_event_boundary(buffer: &str) -> Option<(usize, usize)> {
    let lf = buffer.find("\n\n").map(|index| (index, 2));
    let crlf = buffer.find("\r\n\r\n").map(|index| (index, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
    }
}

pub async fn record_route_usage(
    context: RouteUsageContext,
    capture: UsageCapture,
    status_code: Option<u16>,
    outcome: &str,
    error_code: Option<&str>,
    duration_ms: i64,
) -> Result<(), String> {
    let usage_status = usage_status_for(&capture, context.is_streaming, outcome, error_code);
    let error_detail = if capture.failed || outcome != "success" || error_code.is_some() {
        capture.error_detail.as_deref()
    } else {
        None
    };
    let mut connection = crate::usage_schema::open_usage_database().await?;
    let now_ms = crate::provider::routing::now_millis();
    let source = if context.app_type == "grokbuild" {
        "grok"
    } else {
        context.app_type.as_str()
    };
    sqlx::query(
        "INSERT INTO usage_records(
            record_id, logical_request_id, data_source, source, event_key,
            session_id, attribution_status, provider_id, provider_name,
            requested_model, outbound_model, response_model, pricing_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            usage_status, status_code, outcome, error_code, error_detail, is_streaming,
            started_at_ms, completed_at_ms, duration_ms, attempt_index, attempt_count,
            degraded, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, 'route', ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10,
                   COALESCE(?10, ?9, ?8), ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                   ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?27)
         ON CONFLICT(record_id) DO UPDATE SET
            response_model = excluded.response_model,
            pricing_model = excluded.pricing_model,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            cache_creation_tokens = excluded.cache_creation_tokens,
            usage_status = excluded.usage_status,
            status_code = excluded.status_code,
            outcome = excluded.outcome,
            error_code = excluded.error_code,
            error_detail = excluded.error_detail,
            completed_at_ms = excluded.completed_at_ms,
            duration_ms = excluded.duration_ms,
            updated_at_ms = excluded.updated_at_ms",
    )
    .bind(format!("route:{}", context.request_id))
    .bind(&context.logical_request_id)
    .bind(source)
    .bind(&context.request_id)
    .bind(&context.session_id)
    .bind(&context.provider_id)
    .bind(&context.provider_name)
    .bind(&context.requested_model)
    .bind(&context.outbound_model)
    .bind(&capture.response_model)
    .bind(capture.usage.input_tokens as i64)
    .bind(capture.usage.output_tokens as i64)
    .bind(capture.usage.cache_read_tokens as i64)
    .bind(capture.usage.cache_creation_tokens as i64)
    .bind(usage_status.as_str())
    .bind(status_code.map(i64::from))
    .bind(outcome)
    .bind(error_code)
    .bind(error_detail)
    .bind(if context.is_streaming { 1_i64 } else { 0_i64 })
    .bind(context.started_at_ms)
    .bind(now_ms)
    .bind(duration_ms.max(0))
    .bind(context.attempt_index as i64)
    .bind(context.attempt_count as i64)
    .bind(if context.degraded { 1_i64 } else { 0_i64 })
    .bind(now_ms)
    .execute(&mut connection)
    .await
    .map_err(|err| format!("usage_record_insert_failed: {err}"))?;
    ROUTE_USAGE_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Some(session_id) = context
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|session_id| !session_id.is_empty())
    {
        reconcile_route_attribution_for_session_with_connection(
            &mut connection,
            source,
            session_id,
            now_ms,
        )
        .await?;
    }
    Ok(())
}

fn usage_status_for(
    capture: &UsageCapture,
    is_streaming: bool,
    outcome: &str,
    error_code: Option<&str>,
) -> UsageStatus {
    if capture.usage.total() > 0 {
        if capture.completed || !is_streaming {
            UsageStatus::Complete
        } else {
            UsageStatus::Partial
        }
    } else if capture.failed || outcome != "success" || error_code.is_some() {
        UsageStatus::NotApplicable
    } else {
        UsageStatus::Missing
    }
}

pub async fn record_route_usage_best_effort(
    context: RouteUsageContext,
    capture: UsageCapture,
    status_code: Option<u16>,
    outcome: &str,
    error_code: Option<&str>,
    duration_ms: i64,
) {
    if let Err(error) = record_route_usage(
        context.clone(),
        capture,
        status_code,
        outcome,
        error_code,
        duration_ms,
    )
    .await
    {
        log::warn!(
            "routing usage log failed: request_id={} error={error}",
            context.request_id
        );
    }
}

pub async fn load_route_usage_records(
    start_at: i64,
    end_at: i64,
) -> Result<Vec<RouteUsageRecord>, String> {
    let mut connection = crate::usage_schema::open_usage_database().await?;
    let rows = sqlx::query(
        "SELECT source, session_id, project_key, file_path, started_at_ms, completed_at_ms,
                COALESCE(outbound_model, response_model, requested_model) AS model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                usage_status
         FROM usage_records
         WHERE data_source = 'route' AND started_at_ms BETWEEN ?1 AND ?2
         ORDER BY started_at_ms ASC, record_id ASC",
    )
    .bind(start_at)
    .bind(end_at)
    .fetch_all(&mut connection)
    .await
    .map_err(|err| format!("usage_records_query_failed: {err}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(RouteUsageRecord {
                source: row.try_get("source").map_err(|err| err.to_string())?,
                session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
                project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
                file_path: row.try_get("file_path").map_err(|err| err.to_string())?,
                timestamp_ms: row
                    .try_get("started_at_ms")
                    .map_err(|err| err.to_string())?,
                completed_at_ms: row
                    .try_get("completed_at_ms")
                    .map_err(|err| err.to_string())?,
                model: row.try_get("model").map_err(|err| err.to_string())?,
                usage: UsageTokens {
                    input_tokens: row
                        .try_get::<i64, _>("input_tokens")
                        .map_err(|err| err.to_string())?
                        .max(0) as u64,
                    output_tokens: row
                        .try_get::<i64, _>("output_tokens")
                        .map_err(|err| err.to_string())?
                        .max(0) as u64,
                    cache_read_tokens: row
                        .try_get::<i64, _>("cache_read_tokens")
                        .map_err(|err| err.to_string())?
                        .max(0) as u64,
                    cache_creation_tokens: row
                        .try_get::<i64, _>("cache_creation_tokens")
                        .map_err(|err| err.to_string())?
                        .max(0) as u64,
                },
                usage_status: row.try_get("usage_status").map_err(|err| err.to_string())?,
            })
        })
        .collect()
}

pub async fn reconcile_route_attribution() -> Result<u64, String> {
    let mut connection = crate::usage_schema::open_usage_database().await?;
    reconcile_route_attribution_with_connection(
        &mut connection,
        crate::provider::routing::now_millis(),
    )
    .await
}

async fn reconcile_route_attribution_with_connection(
    connection: &mut SqliteConnection,
    updated_at_ms: i64,
) -> Result<u64, String> {
    let resolved = sqlx::query(
        "UPDATE usage_records AS target
         SET project_key = (
                 SELECT rl.project_key FROM request_logs rl
                 WHERE rl.source = target.source AND rl.session_id = target.session_id
                 ORDER BY rl.updated_at_ms DESC
                 LIMIT 1
             ),
             file_path = (
                 SELECT rl.file_path FROM request_logs rl
                 WHERE rl.source = target.source AND rl.session_id = target.session_id
                 ORDER BY rl.updated_at_ms DESC
                 LIMIT 1
             ),
             project_path = (
                 SELECT session.project_path FROM usage_records session
                 WHERE session.data_source = 'session_log'
                   AND session.source = target.source
                   AND session.session_id = target.session_id
                   AND NULLIF(trim(session.project_path), '') IS NOT NULL
                 ORDER BY session.updated_at_ms DESC
                 LIMIT 1
             ),
             attribution_status = 'resolved',
             updated_at_ms = ?1
         WHERE target.data_source = 'route'
           AND (
                target.attribution_status <> 'resolved'
                OR target.project_key IS NULL
                OR NULLIF(trim(target.project_path), '') IS NULL
                OR NULLIF(trim(target.file_path), '') IS NULL
           )
           AND target.session_id IS NOT NULL
           AND trim(target.session_id) <> ''
           AND EXISTS (
                SELECT 1 FROM request_logs rl
                WHERE rl.source = target.source AND rl.session_id = target.session_id
           )",
    )
    .bind(updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|err| format!("usage_attribution_update_failed: {err}"))?;
    let unattributed = sqlx::query(
        "UPDATE usage_records AS target
         SET attribution_status = 'unattributed', updated_at_ms = ?1
         WHERE target.data_source = 'route'
           AND target.attribution_status NOT IN ('resolved', 'unattributed')
           AND target.session_id IS NOT NULL
           AND trim(target.session_id) <> ''
           AND NOT EXISTS (
                SELECT 1 FROM request_logs rl
                WHERE rl.source = target.source AND rl.session_id = target.session_id
           )",
    )
    .bind(updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|err| format!("usage_attribution_update_failed: {err}"))?;
    Ok(resolved
        .rows_affected()
        .saturating_add(unattributed.rows_affected()))
}

pub(crate) async fn reconcile_route_attribution_for_session_with_connection(
    connection: &mut SqliteConnection,
    source: &str,
    session_id: &str,
    updated_at_ms: i64,
) -> Result<u64, String> {
    let result = sqlx::query(
        "UPDATE usage_records AS target
         SET project_key = (
                 SELECT rl.project_key FROM request_logs rl
                 WHERE rl.source = ?1 AND rl.session_id = ?2
                 ORDER BY rl.updated_at_ms DESC
                 LIMIT 1
             ),
             file_path = (
                 SELECT rl.file_path FROM request_logs rl
                 WHERE rl.source = ?1 AND rl.session_id = ?2
                 ORDER BY rl.updated_at_ms DESC
                 LIMIT 1
             ),
             project_path = (
                 SELECT session.project_path FROM usage_records session
                 WHERE session.data_source = 'session_log'
                   AND session.source = ?1
                   AND session.session_id = ?2
                   AND NULLIF(trim(session.project_path), '') IS NOT NULL
                 ORDER BY session.updated_at_ms DESC
                 LIMIT 1
             ),
             attribution_status = CASE WHEN EXISTS (
                 SELECT 1 FROM request_logs rl
                 WHERE rl.source = ?1 AND rl.session_id = ?2
             ) THEN 'resolved' ELSE 'unattributed' END,
             updated_at_ms = ?3
         WHERE target.data_source = 'route'
           AND target.source = ?1
           AND target.session_id = ?2",
    )
    .bind(source)
    .bind(session_id)
    .bind(updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|err| format!("usage_attribution_update_failed: {err}"))?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_usage_shapes() {
        let capture = parse_response_json(&serde_json::json!({
            "model": "actual-model",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "cache_read_input_tokens": 3,
                "cache_creation_input_tokens": 4
            }
        }));
        assert_eq!(capture.response_model.as_deref(), Some("actual-model"));
        assert_eq!(capture.usage.total(), 37);
    }

    #[test]
    fn sse_collector_preserves_max_cumulative_usage() {
        let mut collector = SseUsageCollector::default();
        collector.observe(&Bytes::from_static(
            b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n\n",
        ));
        collector.observe(&Bytes::from_static(
            b"data: {\"type\":\"message_stop\",\"usage\":{\"output_tokens\":8}}\n\n",
        ));
        assert_eq!(collector.finish().usage.output_tokens, 8);
    }

    #[test]
    fn sse_collector_accepts_crlf_delimiters() {
        let mut collector = SseUsageCollector::default();
        collector.observe(&Bytes::from_static(
            b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":6}}\r\n\r\n",
        ));
        collector.observe(&Bytes::from_static(b"data: [DONE]\r\n\r\n"));
        let capture = collector.finish();
        assert_eq!(capture.usage.output_tokens, 6);
        assert!(capture.completed);
    }

    #[test]
    fn error_detail_uses_allowed_fields_and_redacts_sensitive_values() {
        let capture = parse_response_json(&serde_json::json!({
            "type": "error",
            "error": {
                "message": "upstream rejected Authorization: Bearer sk-secret-value and api_key=private-key"
            },
            "request_body": "this field must never be persisted"
        }));
        let detail = capture
            .error_detail
            .expect("structured error message is captured");

        assert!(capture.failed);
        assert!(detail.contains("upstream rejected"));
        assert!(detail.contains("<redacted>"));
        assert!(!detail.contains("sk-secret-value"));
        assert!(!detail.contains("private-key"));
        assert!(!detail.contains("this field must never be persisted"));
    }

    #[test]
    fn error_detail_is_length_limited() {
        let long_detail = "x".repeat(MAX_ERROR_DETAIL_CHARS + 32);
        let capture = parse_response_json(&serde_json::json!({
            "error": { "detail": long_detail }
        }));
        let detail = capture.error_detail.expect("error detail is captured");

        assert_eq!(detail.chars().count(), MAX_ERROR_DETAIL_CHARS + 1);
        assert!(detail.ends_with('…'));
    }

    #[test]
    fn sse_collector_captures_terminal_raw_json_error_detail() {
        let mut collector = SseUsageCollector::default();
        collector.observe(&Bytes::from_static(
            b"{\"type\":\"error\",\"error\":{\"message\":\"stream failed: token=private-token\"}}",
        ));
        let capture = collector.finish();

        assert!(capture.failed);
        assert_eq!(
            capture.error_detail.as_deref(),
            Some("stream failed: token=<redacted>")
        );
    }

    #[test]
    fn failed_empty_capture_is_not_applicable_but_successful_empty_capture_is_missing() {
        let capture = UsageCapture::default();
        assert_eq!(
            usage_status_for(&capture, false, "error", Some("routing_upstream_timeout")),
            UsageStatus::NotApplicable
        );
        assert_eq!(
            usage_status_for(
                &capture,
                false,
                "skipped",
                Some("routing_provider_circuit_open")
            ),
            UsageStatus::NotApplicable
        );
        assert_eq!(
            usage_status_for(&capture, false, "success", None),
            UsageStatus::Missing
        );
    }

    #[test]
    fn semantic_error_payload_without_tokens_is_not_applicable() {
        let capture = UsageCapture {
            failed: true,
            ..UsageCapture::default()
        };
        assert_eq!(
            usage_status_for(&capture, false, "success", None),
            UsageStatus::NotApplicable
        );
    }

    #[tokio::test]
    async fn route_attribution_resolves_project_and_session_file() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE usage_records(
                record_id TEXT PRIMARY KEY, data_source TEXT NOT NULL, source TEXT NOT NULL,
                session_id TEXT, project_key TEXT, project_path TEXT, file_path TEXT,
                attribution_status TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
             )",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE request_logs(
                request_id TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL,
                project_key TEXT NOT NULL, file_path TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
             )",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO usage_records VALUES
                ('route:matched', 'route', 'codex', 'session-a', NULL, NULL, NULL, 'pending', 1),
                ('route:missing', 'route', 'codex', 'session-missing', NULL, NULL, NULL, 'pending', 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO request_logs VALUES
                ('local:matched', 'codex', 'session-a', 'project-a', 'session-a.jsonl', 10)",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let changed = reconcile_route_attribution_with_connection(&mut connection, 20)
            .await
            .unwrap();
        let matched = sqlx::query(
            "SELECT project_key, file_path, attribution_status FROM usage_records
             WHERE record_id = 'route:matched'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let missing: String = sqlx::query_scalar(
            "SELECT attribution_status FROM usage_records WHERE record_id = 'route:missing'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();

        assert_eq!(changed, 2);
        assert_eq!(
            matched.try_get::<String, _>("project_key").unwrap(),
            "project-a"
        );
        assert_eq!(
            matched.try_get::<String, _>("file_path").unwrap(),
            "session-a.jsonl"
        );
        assert_eq!(
            matched.try_get::<String, _>("attribution_status").unwrap(),
            "resolved"
        );
        assert_eq!(missing, "unattributed");
    }

    #[tokio::test]
    async fn targeted_route_attribution_copies_materialized_project_path() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE usage_records(
                record_id TEXT PRIMARY KEY, data_source TEXT NOT NULL, source TEXT NOT NULL,
                session_id TEXT, project_key TEXT, project_path TEXT, file_path TEXT,
                attribution_status TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
             )",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE request_logs(
                request_id TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL,
                project_key TEXT NOT NULL, file_path TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
             )",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO usage_records VALUES
                ('route:a', 'route', 'codex', 'session-a', NULL, NULL, NULL, 'pending', 1),
                ('session:a', 'session_log', 'codex', 'session-a', 'project-a',
                 'd:/work/project-a', 'session-a.jsonl', 'resolved', 10)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO request_logs VALUES
                ('local:a', 'codex', 'session-a', 'project-a', 'session-a.jsonl', 10)",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let changed = reconcile_route_attribution_for_session_with_connection(
            &mut connection,
            "codex",
            "session-a",
            20,
        )
        .await
        .unwrap();
        let row = sqlx::query(
            "SELECT project_key, project_path, file_path, attribution_status
             FROM usage_records WHERE record_id = 'route:a'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();

        assert_eq!(changed, 1);
        assert_eq!(row.get::<String, _>("project_key"), "project-a");
        assert_eq!(row.get::<String, _>("project_path"), "d:/work/project-a");
        assert_eq!(row.get::<String, _>("file_path"), "session-a.jsonl");
        assert_eq!(row.get::<String, _>("attribution_status"), "resolved");
    }
}
