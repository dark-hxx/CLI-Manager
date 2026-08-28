use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use sqlx::Connection;
use sqlx::{QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

const REQUEST_LOG_PARSER_VERSION: i64 = 3;
const DEFAULT_PAGE_SIZE: u32 = 20;
const MAX_PAGE_SIZE: u32 = 100;
const REQUEST_LOG_SOURCES: [&str; 5] = ["claude", "codex", "gemini", "opencode", "grok"];

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RequestLogFilters {
    source: Option<String>,
    project_key: Option<String>,
    project_path: Option<String>,
    project_paths: Option<Vec<String>>,
    model: Option<String>,
    session_query: Option<String>,
    start_at: Option<i64>,
    end_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogSyncResult {
    scanned_files: u64,
    changed_files: u64,
    removed_files: u64,
    written_rows: u64,
    failed_files: u64,
    synced_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogItem {
    request_id: String,
    source: String,
    project_key: String,
    session_id: String,
    file_path: String,
    event_index: u64,
    timestamp_ms: i64,
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
    status: &'static str,
    session_available: bool,
    data_source: String,
    provider_id: Option<String>,
    provider_name: Option<String>,
    requested_model: Option<String>,
    outbound_model: Option<String>,
    response_model: Option<String>,
    usage_status: String,
    status_code: Option<i64>,
    outcome: String,
    error_code: Option<String>,
    error_detail: Option<String>,
    duration_ms: i64,
    attempt_count: u64,
    degraded: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct RequestLogSummary {
    total: u64,
    total_input_tokens: u64,
    total_output_tokens: u64,
    total_cache_read_tokens: u64,
    total_cache_creation_tokens: u64,
    total_tokens: u64,
    cache_hit_rate: f64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogPage {
    data: Vec<RequestLogItem>,
    summary: RequestLogSummary,
    total: u64,
    page: u32,
    page_size: u32,
}

#[derive(Clone)]
struct RequestLogDocument {
    source: String,
    project_key: String,
    project_path: Option<String>,
    session_id: String,
    file_path: String,
    fingerprint: SessionFileFingerprint,
    events: Vec<SessionUsageEventScan>,
}

#[derive(Clone, Copy)]
struct RequestLogSyncState {
    source: &'static str,
    fingerprint: SessionFileFingerprint,
    parser_version: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogStatsTrendItem {
    bucket_start_ms: i64,
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogStatsSourceItem {
    source: String,
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    ratio: f64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogStatsModelItem {
    model: String,
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    ratio: f64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogStatsResponse {
    range_start_at: i64,
    range_end_at: i64,
    granularity: &'static str,
    total_requests: u64,
    total_input_tokens: u64,
    total_output_tokens: u64,
    total_cache_read_tokens: u64,
    total_cache_creation_tokens: u64,
    total_tokens: u64,
    cache_hit_rate: f64,
    total_cost_usd: f64,
    total_unpriced_tokens: u64,
    trend: Vec<RequestLogStatsTrendItem>,
    source_distribution: Vec<RequestLogStatsSourceItem>,
    model_distribution: Vec<RequestLogStatsModelItem>,
}

#[derive(Clone, Copy, Default)]
struct RequestLogUsageAggregate {
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
}

impl RequestLogUsageAggregate {
    fn add(&mut self, usage: UsageTokenScan, cost: UsageStatsScan) {
        self.requests = self.requests.saturating_add(1);
        self.input_tokens = self.input_tokens.saturating_add(usage.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(usage.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(usage.cache_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(usage.cache_creation_tokens);
        self.total_cost_usd += cost.total_cost_usd;
        self.unpriced_tokens = self.unpriced_tokens.saturating_add(cost.unpriced_tokens);
    }

    fn total_tokens(self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
    }
}

fn request_log_sync_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn schedule_legacy_route_attribution_repair() {
    static REPAIR_ATTEMPTED: AtomicBool = AtomicBool::new(false);
    if REPAIR_ATTEMPTED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(err) = crate::usage::reconcile_route_attribution().await {
            REPAIR_ATTEMPTED.store(false, Ordering::Release);
            warn!("request log background route attribution repair failed: {err}");
        }
    });
}

async fn open_cli_manager_db() -> Result<SqliteConnection, String> {
    crate::usage_schema::open_usage_database().await
}

fn fingerprint_matches(state: RequestLogSyncState, current: SessionFileFingerprint) -> bool {
    state.parser_version == REQUEST_LOG_PARSER_VERSION && state.fingerprint == current
}

fn history_root_available(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&path_str) {
        let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path_str) else {
            return false;
        };
        let program = crate::wsl::find_wsl_exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "wsl.exe".to_string());
        return wsl_command_output(
            &program,
            &["-d", &distro, "--exec", "test", "-d", &linux_path],
        )
        .is_ok_and(|output| output.status.success());
    }
    std::fs::read_dir(path).is_ok()
}

fn request_log_source_allowed(source: &str) -> bool {
    REQUEST_LOG_SOURCES.contains(&source)
}

fn available_cleanup_sources(roots: &HistoryRoots) -> HashSet<&'static str> {
    let mut sources = HashSet::new();
    if history_root_available(&resolve_claude_history_root(roots)) {
        sources.insert("claude");
    }
    if history_root_available(&resolve_codex_history_root(roots)) {
        sources.insert("codex");
    }
    if history_root_available(&resolve_gemini_history_root()) {
        sources.insert("gemini");
    }
    if history_root_available(&resolve_grok_history_root(roots)) {
        sources.insert("grok");
    }
    if resolve_opencode_database_path().is_file() {
        sources.insert("opencode");
    }
    sources
}

fn session_file_available(file_path: &str) -> bool {
    if parse_opencode_session_locator(file_path).is_some() {
        return opencode_locator_in_default_scope(file_path);
    }
    crate::wsl::is_wsl_config_dir(file_path) || Path::new(file_path).is_file()
}

fn fallback_event_key(event: &SessionUsageEventScan, index: usize) -> String {
    format!(
        "fallback:{}:{}:{}:{}:{}:{}",
        event.timestamp_ms.unwrap_or(index as i64),
        event.model.as_deref().unwrap_or("unknown"),
        event.usage.input_tokens,
        event.usage.output_tokens,
        event.usage.cache_read_tokens,
        event.usage.cache_creation_tokens
    )
}

fn document_from_entry(entry: HistoryIndexEntry) -> RequestLogDocument {
    let summary = summary_from_computation(&entry.file_ref, &entry.computed);
    let project_path = summary.cwd.as_deref().map(normalize_history_path);
    let mut events = stats_usage_events_or_fallback(&summary, &entry.computed.stats);
    for (index, event) in events.iter_mut().enumerate() {
        if event.event_key.trim().is_empty() {
            event.event_key = fallback_event_key(event, index);
        }
        event.event_index = index;
    }

    RequestLogDocument {
        source: entry.file_ref.source,
        project_key: entry.file_ref.project_key,
        project_path,
        session_id: entry.computed.session_id,
        file_path: path_to_key(&entry.file_ref.path),
        fingerprint: entry.fingerprint,
        events,
    }
}

fn document_from_opencode(parsed: OpenCodeParsedSession) -> RequestLogDocument {
    let summary = opencode_summary_from_parsed(&parsed);
    let project_path = summary.cwd.as_deref().map(normalize_history_path);
    let mut events = stats_usage_events_or_fallback(&summary, &parsed.computed.stats);
    for (index, event) in events.iter_mut().enumerate() {
        if event.event_key.trim().is_empty() {
            event.event_key = fallback_event_key(event, index);
        }
        event.event_index = index;
    }

    RequestLogDocument {
        source: parsed.file_ref.source,
        project_key: parsed.file_ref.project_key,
        project_path,
        session_id: parsed.computed.session_id,
        file_path: path_to_key(&parsed.file_ref.path),
        fingerprint: parsed.fingerprint,
        events,
    }
}

async fn load_sync_state(
    conn: &mut SqliteConnection,
) -> Result<HashMap<String, RequestLogSyncState>, String> {
    let rows = sqlx::query(
        "SELECT file_path, source, file_created_at, file_updated_at, file_size, parser_version FROM request_log_sync",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("request_logs_sync_state_failed: {err}"))?;
    let mut states = HashMap::with_capacity(rows.len());
    for row in rows {
        let file_path: String = row.try_get("file_path").map_err(|err| err.to_string())?;
        states.insert(
            file_path,
            RequestLogSyncState {
                source: match row
                    .try_get::<String, _>("source")
                    .map_err(|err| err.to_string())?
                    .as_str()
                {
                    "claude" => "claude",
                    "codex" => "codex",
                    "gemini" => "gemini",
                    "opencode" => "opencode",
                    "grok" => "grok",
                    _ => "unknown",
                },
                fingerprint: SessionFileFingerprint {
                    created_at: row
                        .try_get("file_created_at")
                        .map_err(|err| err.to_string())?,
                    updated_at: row
                        .try_get("file_updated_at")
                        .map_err(|err| err.to_string())?,
                    size: row
                        .try_get::<i64, _>("file_size")
                        .map_err(|err| err.to_string())?
                        .max(0) as u64,
                },
                parser_version: row
                    .try_get("parser_version")
                    .map_err(|err| err.to_string())?,
            },
        );
    }
    Ok(states)
}

fn request_id(source: &str, file_path: &str, event_key: &str) -> String {
    let digest = Sha256::digest(format!("{source}|{file_path}|{event_key}").as_bytes());
    format!("{digest:x}")
}

async fn replace_document(
    conn: &mut SqliteConnection,
    document: &RequestLogDocument,
    synced_at_ms: i64,
) -> Result<u64, String> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|err| format!("request_logs_transaction_failed: {err}"))?;
    sqlx::query("DELETE FROM request_logs WHERE file_path = ?1")
        .bind(&document.file_path)
        .execute(&mut *tx)
        .await
        .map_err(|err| format!("request_logs_delete_failed: {err}"))?;
    sqlx::query("DELETE FROM usage_records WHERE data_source = 'session_log' AND file_path = ?1")
        .bind(&document.file_path)
        .execute(&mut *tx)
        .await
        .map_err(|err| format!("usage_records_session_cleanup_failed: {err}"))?;

    for event in &document.events {
        let timestamp_ms = event
            .timestamp_ms
            .unwrap_or(document.fingerprint.updated_at);
        sqlx::query(
            "INSERT INTO request_logs(
                request_id, source, project_key, session_id, file_path, event_key, event_index,
                timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )
        .bind(request_id(
            &document.source,
            &document.file_path,
            &event.event_key,
        ))
        .bind(&document.source)
        .bind(&document.project_key)
        .bind(&document.session_id)
        .bind(&document.file_path)
        .bind(&event.event_key)
        .bind(event.event_index as i64)
        .bind(timestamp_ms)
        .bind(&event.model)
        .bind(event.usage.input_tokens as i64)
        .bind(event.usage.output_tokens as i64)
        .bind(event.usage.cache_read_tokens as i64)
        .bind(event.usage.cache_creation_tokens as i64)
        .bind(synced_at_ms)
        .bind(synced_at_ms)
        .execute(&mut *tx)
        .await
        .map_err(|err| format!("request_logs_insert_failed: {err}"))?;
        sqlx::query(
            "INSERT INTO usage_records(
                record_id, logical_request_id, data_source, source, event_key,
                file_path, event_index, session_id, project_key, project_path, attribution_status,
                response_model, pricing_model, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, usage_status, outcome,
                started_at_ms, completed_at_ms, duration_ms, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, 'session_log', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'resolved',
                       ?10, ?10, ?11, ?12, ?13, ?14, 'complete', 'success',
                       ?15, ?15, 0, ?16, ?16)
             ON CONFLICT(record_id) DO UPDATE SET
                project_key = excluded.project_key,
                project_path = excluded.project_path,
                response_model = excluded.response_model,
                pricing_model = excluded.pricing_model,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                cache_read_tokens = excluded.cache_read_tokens,
                cache_creation_tokens = excluded.cache_creation_tokens,
                started_at_ms = excluded.started_at_ms,
                completed_at_ms = excluded.completed_at_ms,
                updated_at_ms = excluded.updated_at_ms",
        )
        .bind(request_id(
            &document.source,
            &document.file_path,
            &event.event_key,
        ))
        .bind(request_id(
            &document.source,
            &document.file_path,
            &event.event_key,
        ))
        .bind(&document.source)
        .bind(&event.event_key)
        .bind(&document.file_path)
        .bind(event.event_index as i64)
        .bind(&document.session_id)
        .bind(&document.project_key)
        .bind(&document.project_path)
        .bind(&event.model)
        .bind(event.usage.input_tokens as i64)
        .bind(event.usage.output_tokens as i64)
        .bind(event.usage.cache_read_tokens as i64)
        .bind(event.usage.cache_creation_tokens as i64)
        .bind(timestamp_ms)
        .bind(synced_at_ms)
        .execute(&mut *tx)
        .await
        .map_err(|err| format!("usage_records_session_insert_failed: {err}"))?;
    }

    sqlx::query(
        "INSERT INTO request_log_sync(
            file_path, source, file_created_at, file_updated_at, file_size, parser_version, last_synced_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(file_path) DO UPDATE SET
            source = excluded.source,
            file_created_at = excluded.file_created_at,
            file_updated_at = excluded.file_updated_at,
            file_size = excluded.file_size,
            parser_version = excluded.parser_version,
            last_synced_at_ms = excluded.last_synced_at_ms",
    )
    .bind(&document.file_path)
    .bind(&document.source)
    .bind(document.fingerprint.created_at)
    .bind(document.fingerprint.updated_at)
    .bind(document.fingerprint.size as i64)
    .bind(REQUEST_LOG_PARSER_VERSION)
    .bind(synced_at_ms)
    .execute(&mut *tx)
    .await
    .map_err(|err| format!("request_logs_sync_state_write_failed: {err}"))?;

    tx.commit()
        .await
        .map_err(|err| format!("request_logs_commit_failed: {err}"))?;
    Ok(document.events.len() as u64)
}

async fn remove_missing_files(
    conn: &mut SqliteConnection,
    stale_paths: &[String],
) -> Result<u64, String> {
    if stale_paths.is_empty() {
        return Ok(0);
    }
    let mut tx = conn
        .begin()
        .await
        .map_err(|err| format!("request_logs_cleanup_transaction_failed: {err}"))?;
    for path in stale_paths {
        sqlx::query("DELETE FROM request_logs WHERE file_path = ?1")
            .bind(path)
            .execute(&mut *tx)
            .await
            .map_err(|err| format!("request_logs_cleanup_failed: {err}"))?;
        sqlx::query(
            "DELETE FROM usage_records WHERE data_source = 'session_log' AND file_path = ?1",
        )
        .bind(path)
        .execute(&mut *tx)
        .await
        .map_err(|err| format!("usage_records_cleanup_failed: {err}"))?;
        sqlx::query("DELETE FROM request_log_sync WHERE file_path = ?1")
            .bind(path)
            .execute(&mut *tx)
            .await
            .map_err(|err| format!("request_logs_cleanup_failed: {err}"))?;
    }
    tx.commit()
        .await
        .map_err(|err| format!("request_logs_cleanup_commit_failed: {err}"))?;
    Ok(stale_paths.len() as u64)
}

async fn sync_request_logs_with_connection(
    conn: &mut SqliteConnection,
    roots: HistoryRoots,
    force: bool,
) -> Result<RequestLogSyncResult, String> {
    let (index, mut cleanup_sources) = tokio::task::spawn_blocking(move || {
        let cleanup_sources = available_cleanup_sources(&roots);
        let index = refresh_history_index_snapshot(&roots, force);
        (index, cleanup_sources)
    })
    .await
    .map_err(|err| format!("request_logs_scan_join_failed: {err}"))?;

    let mut documents: Vec<RequestLogDocument> = index
        .entries
        .into_iter()
        .filter(|entry| request_log_source_allowed(&entry.file_ref.source))
        .map(document_from_entry)
        .collect();
    match opencode_catalog_sessions().await {
        Ok(Some(sessions)) => {
            documents.extend(sessions.into_iter().map(document_from_opencode));
        }
        Ok(None) => {
            cleanup_sources.remove("opencode");
        }
        Err(err) => {
            cleanup_sources.remove("opencode");
            warn!("request log sync skipped OpenCode database: {err}");
        }
    }

    let synced_at_ms = now_millis();
    let sync_state = load_sync_state(conn).await?;
    let current_paths: HashSet<String> = documents
        .iter()
        .map(|document| document.file_path.clone())
        .collect();
    let stale_paths: Vec<String> = sync_state
        .iter()
        .filter(|(path, state)| {
            cleanup_sources.contains(state.source) && !current_paths.contains(*path)
        })
        .map(|(path, _)| path.clone())
        .collect();
    let scanned_files = documents.len() as u64;
    let changed_documents: Vec<RequestLogDocument> = documents
        .into_iter()
        .filter(|entry| {
            let file_path = &entry.file_path;
            force
                || sync_state
                    .get(file_path)
                    .map(|state| !fingerprint_matches(*state, entry.fingerprint))
                    .unwrap_or(true)
        })
        .collect();

    let changed_files = changed_documents.len() as u64;
    let mut written_rows = 0u64;
    let mut failed_files = 0u64;
    for document in &changed_documents {
        match replace_document(conn, document, synced_at_ms).await {
            Ok(count) => {
                written_rows = written_rows.saturating_add(count);
                crate::usage::reconcile_route_attribution_for_session_with_connection(
                    conn,
                    &document.source,
                    &document.session_id,
                    synced_at_ms,
                )
                .await?;
            }
            Err(err) => {
                failed_files = failed_files.saturating_add(1);
                warn!(
                    "request log sync skipped file: source={} path={} error={err}",
                    document.source, document.file_path
                );
            }
        }
    }

    let removed_files = remove_missing_files(conn, &stale_paths).await?;
    Ok(RequestLogSyncResult {
        scanned_files,
        changed_files,
        removed_files,
        written_rows,
        failed_files,
        synced_at_ms,
    })
}

#[tauri::command]
pub async fn history_sync_request_logs(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    force: Option<bool>,
) -> Result<RequestLogSyncResult, String> {
    let _guard = request_log_sync_lock().lock().await;
    let mut conn = open_cli_manager_db().await?;
    let result = sync_request_logs_with_connection(
        &mut conn,
        history_roots(claude_config_dir, codex_config_dir, grok_session_root)
            .with_kimi_config_dir(kimi_config_dir),
        force.unwrap_or(false),
    )
    .await?;
    schedule_legacy_route_attribution_repair();
    Ok(result)
}

fn normalized_filter(value: Option<&String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn like_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn push_filters<'a>(builder: &mut QueryBuilder<'a, Sqlite>, filters: &RequestLogFilters) {
    builder.push(" WHERE 1 = 1");
    if let Some(source) = normalized_filter(filters.source.as_ref()) {
        if request_log_source_allowed(&source) {
            builder.push(" AND source = ").push_bind(source);
        }
    }
    if let Some(project_key) = normalized_filter(filters.project_key.as_ref()) {
        builder
            .push(" AND project_key LIKE ")
            .push_bind(like_pattern(&project_key))
            .push(" ESCAPE '\\'");
    }
    if let Some(model) = normalized_filter(filters.model.as_ref()) {
        builder
            .push(" AND COALESCE(model, '') LIKE ")
            .push_bind(like_pattern(&model))
            .push(" ESCAPE '\\'");
    }
    if let Some(session_query) = normalized_filter(filters.session_query.as_ref()) {
        let pattern = like_pattern(&session_query);
        builder
            .push(" AND (session_id LIKE ")
            .push_bind(pattern.clone())
            .push(" ESCAPE '\\' OR file_path LIKE ")
            .push_bind(pattern)
            .push(" ESCAPE '\\')");
    }
    if let Some(start_at) = filters.start_at {
        builder.push(" AND timestamp_ms >= ").push_bind(start_at);
    }
    if let Some(end_at) = filters.end_at {
        builder.push(" AND timestamp_ms <= ").push_bind(end_at);
    }
    push_project_path_filters(builder, filters);
}

fn normalized_request_log_project_paths(filters: &RequestLogFilters) -> Vec<String> {
    let mut paths = filters.project_paths.clone().unwrap_or_default();
    if let Some(path) = &filters.project_path {
        paths.push(path.clone());
    }
    let mut paths = paths
        .into_iter()
        .map(|path| normalize_history_path(&path))
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    paths.sort_unstable();
    paths.dedup();
    paths
}

fn request_log_project_path_candidates(filters: &RequestLogFilters) -> Vec<String> {
    let mut candidates = Vec::new();
    for path in normalized_request_log_project_paths(filters) {
        candidates.push(path.clone());
        if let Some(wsl_path) = crate::wsl::windows_path_to_wsl(&path) {
            candidates.push(normalize_history_path(&wsl_path));
        }
        if let Some(windows_path) = crate::wsl::wsl_mnt_path_to_windows(&path) {
            candidates.push(normalize_history_path(&windows_path));
        }
        if let Some((_, linux_path)) = crate::wsl::parse_wsl_unc_path(&path) {
            let linux_path = normalize_history_path(&linux_path);
            if let Some(windows_path) = crate::wsl::wsl_mnt_path_to_windows(&linux_path) {
                candidates.push(normalize_history_path(&windows_path));
            }
            candidates.push(linux_path);
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    candidates
}

fn prefix_like_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("{escaped}/%")
}

fn push_project_path_filters<'a>(
    builder: &mut QueryBuilder<'a, Sqlite>,
    filters: &RequestLogFilters,
) {
    let candidates = request_log_project_path_candidates(filters);
    if candidates.is_empty() {
        return;
    }
    let mut claude_keys = candidates
        .iter()
        .map(|path| claude_project_key_from_path(path))
        .collect::<Vec<_>>();
    claude_keys.sort_unstable();
    claude_keys.dedup();
    let mut legacy_project_keys = candidates
        .iter()
        .flat_map(|path| {
            [
                Some(path.to_lowercase()),
                project_key_from_cwd(path).map(|key| key.to_lowercase()),
            ]
        })
        .flatten()
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    legacy_project_keys.sort_unstable();
    legacy_project_keys.dedup();

    builder.push(" AND (");
    let mut needs_or = false;
    for candidate in candidates {
        if needs_or {
            builder.push(" OR ");
        }
        builder
            .push("(project_path = ")
            .push_bind(candidate.clone())
            .push(" OR project_path LIKE ")
            .push_bind(prefix_like_pattern(&candidate))
            .push(" ESCAPE '\\')");
        needs_or = true;
    }
    for project_key in claude_keys {
        if needs_or {
            builder.push(" OR ");
        }
        builder
            .push("(source = 'claude' AND LOWER(project_key) = ")
            .push_bind(project_key)
            .push(")");
        needs_or = true;
    }
    for project_key in legacy_project_keys {
        if needs_or {
            builder.push(" OR ");
        }
        builder
            .push("(source <> 'claude' AND NULLIF(TRIM(project_path), '') IS NULL AND LOWER(project_key) = ")
            .push_bind(project_key)
            .push(")");
        needs_or = true;
    }
    builder.push(")");
}

async fn list_request_logs_with_connection(
    conn: &mut SqliteConnection,
    filters: RequestLogFilters,
    page: u32,
    page_size: u32,
) -> Result<RequestLogPage, String> {
    if normalized_filter(filters.source.as_ref())
        .is_some_and(|source| !request_log_source_allowed(&source))
    {
        return Err("request_logs_invalid_source".to_string());
    }
    if filters
        .start_at
        .zip(filters.end_at)
        .is_some_and(|(start, end)| end < start)
    {
        return Err("request_logs_invalid_range".to_string());
    }
    let page_size = page_size.clamp(1, MAX_PAGE_SIZE);

    let mut summary_builder = QueryBuilder::<Sqlite>::new(
        "SELECT model,
            COUNT(*) AS record_count,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_creation_tokens) AS cache_creation_tokens
         FROM unified_usage_records",
    );
    push_filters(&mut summary_builder, &filters);
    summary_builder.push(" GROUP BY model");
    let summary_rows = summary_builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("request_logs_summary_failed: {err}"))?;
    let mut total = 0_u64;
    let mut summary = RequestLogSummary {
        total: 0,
        ..RequestLogSummary::default()
    };
    for row in summary_rows {
        total = total.saturating_add(
            row.try_get::<i64, _>("record_count")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
        );
        let model: Option<String> = row.try_get("model").map_err(|err| err.to_string())?;
        let usage = UsageTokenScan {
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
            explicit_cost_usd: None,
        };
        let priced = calculate_usage_cost(model.as_deref(), usage);
        summary.total_input_tokens = summary
            .total_input_tokens
            .saturating_add(usage.input_tokens);
        summary.total_output_tokens = summary
            .total_output_tokens
            .saturating_add(usage.output_tokens);
        summary.total_cache_read_tokens = summary
            .total_cache_read_tokens
            .saturating_add(usage.cache_read_tokens);
        summary.total_cache_creation_tokens = summary
            .total_cache_creation_tokens
            .saturating_add(usage.cache_creation_tokens);
        summary.total_tokens = summary
            .total_tokens
            .saturating_add(usage_total_tokens(usage));
        summary.total_cost_usd += priced.total_cost_usd;
        summary.unpriced_tokens = summary
            .unpriced_tokens
            .saturating_add(priced.unpriced_tokens);
    }
    summary.total = total;
    summary.cache_hit_rate = request_log_cache_hit_rate(
        summary.total_input_tokens,
        summary.total_cache_read_tokens,
        summary.total_cache_creation_tokens,
    );

    let mut page_builder = QueryBuilder::<Sqlite>::new(
        "SELECT request_id, source, project_key, session_id, file_path, event_index,
            timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, data_source, provider_id, provider_name,
            requested_model, outbound_model, response_model, usage_status,
            status_code, outcome, error_code, error_detail, duration_ms, attempt_count, degraded
         FROM unified_usage_records",
    );
    push_filters(&mut page_builder, &filters);
    page_builder
        .push(" ORDER BY timestamp_ms DESC, request_id DESC LIMIT ")
        .push_bind(page_size as i64)
        .push(" OFFSET ")
        .push_bind(
            (page as u64)
                .saturating_mul(page_size as u64)
                .min(i64::MAX as u64) as i64,
        );
    let rows = page_builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("request_logs_query_failed: {err}"))?;
    let mut data = Vec::with_capacity(rows.len());
    for row in rows {
        let model: Option<String> = row.try_get("model").map_err(|err| err.to_string())?;
        let usage = UsageTokenScan {
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
            explicit_cost_usd: None,
        };
        let priced = calculate_usage_cost(model.as_deref(), usage);
        let file_path: String = row.try_get("file_path").map_err(|err| err.to_string())?;
        data.push(RequestLogItem {
            request_id: row.try_get("request_id").map_err(|err| err.to_string())?,
            source: row.try_get("source").map_err(|err| err.to_string())?,
            project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
            session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
            session_available: session_file_available(&file_path),
            file_path,
            event_index: row
                .try_get::<i64, _>("event_index")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            timestamp_ms: row.try_get("timestamp_ms").map_err(|err| err.to_string())?,
            model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            total_tokens: usage_total_tokens(usage),
            total_cost_usd: priced.total_cost_usd,
            unpriced_tokens: priced.unpriced_tokens,
            status: "recorded",
            data_source: row
                .try_get("data_source")
                .unwrap_or_else(|_| "session_log".to_string()),
            provider_id: row.try_get("provider_id").unwrap_or(None),
            provider_name: row.try_get("provider_name").unwrap_or(None),
            requested_model: row.try_get("requested_model").unwrap_or(None),
            outbound_model: row.try_get("outbound_model").unwrap_or(None),
            response_model: row.try_get("response_model").unwrap_or(None),
            usage_status: row
                .try_get("usage_status")
                .unwrap_or_else(|_| "complete".to_string()),
            status_code: row.try_get("status_code").unwrap_or(None),
            outcome: row
                .try_get("outcome")
                .unwrap_or_else(|_| "success".to_string()),
            error_code: row.try_get("error_code").unwrap_or(None),
            error_detail: row.try_get("error_detail").unwrap_or(None),
            duration_ms: row.try_get("duration_ms").unwrap_or(0),
            attempt_count: row.try_get::<i64, _>("attempt_count").unwrap_or(1).max(1) as u64,
            degraded: row.try_get::<i64, _>("degraded").unwrap_or(0) != 0,
        });
    }

    Ok(RequestLogPage {
        data,
        summary,
        total,
        page,
        page_size,
    })
}

#[tauri::command]
pub async fn history_list_request_logs(
    filters: Option<RequestLogFilters>,
    page: Option<u32>,
    page_size: Option<u32>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
) -> Result<RequestLogPage, String> {
    let filters = filters.unwrap_or_default();
    let _ = (
        claude_config_dir,
        codex_config_dir,
        grok_session_root,
        kimi_config_dir,
    );
    let mut conn = open_cli_manager_db().await?;
    list_request_logs_with_connection(
        &mut conn,
        filters,
        page.unwrap_or(0),
        page_size.unwrap_or(DEFAULT_PAGE_SIZE),
    )
    .await
}

fn request_log_cache_hit_rate(
    input_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
) -> f64 {
    let denominator = input_tokens
        .saturating_add(cache_read_tokens)
        .saturating_add(cache_creation_tokens);
    if denominator == 0 {
        0.0
    } else {
        cache_read_tokens as f64 / denominator as f64
    }
}

fn request_log_bucket_start(timestamp_ms: i64, granularity: &'static str) -> i64 {
    let bucket_ms = if granularity == "hour" {
        60 * 60 * 1000
    } else {
        24 * 60 * 60 * 1000
    };
    timestamp_ms.div_euclid(bucket_ms) * bucket_ms
}

fn request_log_stats_source_item(
    source: String,
    aggregate: RequestLogUsageAggregate,
    total_tokens: u64,
) -> RequestLogStatsSourceItem {
    RequestLogStatsSourceItem {
        source,
        requests: aggregate.requests,
        input_tokens: aggregate.input_tokens,
        output_tokens: aggregate.output_tokens,
        cache_read_tokens: aggregate.cache_read_tokens,
        cache_creation_tokens: aggregate.cache_creation_tokens,
        total_tokens: aggregate.total_tokens(),
        ratio: if total_tokens == 0 {
            0.0
        } else {
            aggregate.total_tokens() as f64 / total_tokens as f64
        },
        total_cost_usd: aggregate.total_cost_usd,
        unpriced_tokens: aggregate.unpriced_tokens,
    }
}

fn request_log_stats_model_item(
    model: String,
    aggregate: RequestLogUsageAggregate,
    total_tokens: u64,
) -> RequestLogStatsModelItem {
    RequestLogStatsModelItem {
        model,
        requests: aggregate.requests,
        input_tokens: aggregate.input_tokens,
        output_tokens: aggregate.output_tokens,
        cache_read_tokens: aggregate.cache_read_tokens,
        cache_creation_tokens: aggregate.cache_creation_tokens,
        total_tokens: aggregate.total_tokens(),
        ratio: if total_tokens == 0 {
            0.0
        } else {
            aggregate.total_tokens() as f64 / total_tokens as f64
        },
        total_cost_usd: aggregate.total_cost_usd,
        unpriced_tokens: aggregate.unpriced_tokens,
    }
}

#[tauri::command]
pub async fn history_get_request_log_stats(
    filters: Option<RequestLogFilters>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
) -> Result<RequestLogStatsResponse, String> {
    let mut filters = filters.unwrap_or_default();
    if normalized_filter(filters.source.as_ref())
        .is_some_and(|source| !request_log_source_allowed(&source))
    {
        return Err("request_logs_invalid_source".to_string());
    }

    let range_end_at = filters.end_at.unwrap_or_else(now_millis);
    let range_start_at = filters
        .start_at
        .unwrap_or_else(|| range_end_at.saturating_sub(30 * 24 * 60 * 60 * 1000));
    if range_end_at < range_start_at {
        return Err("request_logs_invalid_range".to_string());
    }
    filters.start_at = Some(range_start_at);
    filters.end_at = Some(range_end_at);
    let granularity = if range_end_at.saturating_sub(range_start_at) <= 24 * 60 * 60 * 1000 {
        "hour"
    } else {
        "day"
    };
    let _ = (
        claude_config_dir,
        codex_config_dir,
        grok_session_root,
        kimi_config_dir,
    );
    let mut conn = open_cli_manager_db().await?;
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT source, model, timestamp_ms, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens
         FROM unified_usage_records",
    );
    push_filters(&mut builder, &filters);
    builder.push(" ORDER BY timestamp_ms ASC, request_id ASC");
    let rows = builder
        .build()
        .fetch_all(&mut conn)
        .await
        .map_err(|err| format!("request_logs_stats_query_failed: {err}"))?;

    let mut total = RequestLogUsageAggregate::default();
    let mut trend: BTreeMap<i64, RequestLogUsageAggregate> = BTreeMap::new();
    let mut sources: HashMap<String, RequestLogUsageAggregate> = HashMap::new();
    let mut models: HashMap<String, RequestLogUsageAggregate> = HashMap::new();
    for row in rows {
        let model: Option<String> = row.try_get("model").map_err(|err| err.to_string())?;
        let usage = UsageTokenScan {
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
            explicit_cost_usd: None,
        };
        let cost = calculate_usage_cost(model.as_deref(), usage);
        total.add(usage, cost);

        let source: String = row.try_get("source").map_err(|err| err.to_string())?;
        sources.entry(source).or_default().add(usage, cost);
        models
            .entry(model.unwrap_or_else(|| "unknown".to_string()))
            .or_default()
            .add(usage, cost);
        let timestamp_ms: i64 = row.try_get("timestamp_ms").map_err(|err| err.to_string())?;
        trend
            .entry(request_log_bucket_start(timestamp_ms, granularity))
            .or_default()
            .add(usage, cost);
    }

    let total_tokens = total.total_tokens();
    let mut source_distribution = sources
        .into_iter()
        .map(|(source, aggregate)| request_log_stats_source_item(source, aggregate, total_tokens))
        .collect::<Vec<_>>();
    source_distribution.sort_by(|left, right| {
        right
            .total_tokens
            .cmp(&left.total_tokens)
            .then_with(|| left.source.cmp(&right.source))
    });
    let mut model_distribution = models
        .into_iter()
        .map(|(model, aggregate)| request_log_stats_model_item(model, aggregate, total_tokens))
        .collect::<Vec<_>>();
    model_distribution.sort_by(|left, right| {
        right
            .total_tokens
            .cmp(&left.total_tokens)
            .then_with(|| left.model.cmp(&right.model))
    });
    let trend = trend
        .into_iter()
        .map(|(bucket_start_ms, aggregate)| RequestLogStatsTrendItem {
            bucket_start_ms,
            requests: aggregate.requests,
            input_tokens: aggregate.input_tokens,
            output_tokens: aggregate.output_tokens,
            cache_read_tokens: aggregate.cache_read_tokens,
            cache_creation_tokens: aggregate.cache_creation_tokens,
            total_tokens: aggregate.total_tokens(),
            total_cost_usd: aggregate.total_cost_usd,
            unpriced_tokens: aggregate.unpriced_tokens,
        })
        .collect();

    Ok(RequestLogStatsResponse {
        range_start_at,
        range_end_at,
        granularity,
        total_requests: total.requests,
        total_input_tokens: total.input_tokens,
        total_output_tokens: total.output_tokens,
        total_cache_read_tokens: total.cache_read_tokens,
        total_cache_creation_tokens: total.cache_creation_tokens,
        total_tokens,
        cache_hit_rate: request_log_cache_hit_rate(
            total.input_tokens,
            total.cache_read_tokens,
            total.cache_creation_tokens,
        ),
        total_cost_usd: total.total_cost_usd,
        total_unpriced_tokens: total.unpriced_tokens,
        trend,
        source_distribution,
        model_distribution,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    async fn test_connection() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for statement in crate::MIGRATION_CREATE_REQUEST_LOGS_SQL.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&mut conn).await.unwrap();
            }
        }
        for statement in crate::MIGRATION_CREATE_USAGE_RECORDS_SQL.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&mut conn).await.unwrap();
            }
        }
        for statement in crate::MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_SQL.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&mut conn).await.unwrap();
            }
        }
        for statement in crate::MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_SQL.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&mut conn).await.unwrap();
            }
        }
        for statement in crate::MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_SQL.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&mut conn).await.unwrap();
            }
        }
        for statement in crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&mut conn).await.unwrap();
            }
        }
        conn
    }

    fn write_claude_session(config: &Path, content: &str) -> std::path::PathBuf {
        let path = config
            .join("projects")
            .join("project-a")
            .join("session-a.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }

    #[tokio::test]
    async fn sync_is_idempotent_and_replaces_changed_files() {
        let temp = TempDir::new().unwrap();
        let claude = temp.path().join("claude");
        let codex = temp.path().join("codex");
        fs::create_dir_all(&codex).unwrap();
        let file = write_claude_session(
            &claude,
            concat!(
                r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-test","usage":{"input_tokens":10,"output_tokens":5}}}"#,
                "\n",
                r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-test","usage":{"input_tokens":10,"output_tokens":5}}}"#,
                "\n",
            ),
        );
        let roots = history_roots(
            Some(claude.to_string_lossy().to_string()),
            Some(codex.to_string_lossy().to_string()),
            None,
        );
        let mut conn = test_connection().await;

        let first = sync_request_logs_with_connection(&mut conn, roots.clone(), true)
            .await
            .unwrap();
        assert!(first.written_rows >= 1);
        let file_key = path_to_key(&file);
        let custom_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM request_logs WHERE file_path = ?1")
                .bind(&file_key)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(custom_count, 1);
        let second = sync_request_logs_with_connection(&mut conn, roots.clone(), false)
            .await
            .unwrap();
        assert_eq!(second.changed_files, 0);

        fs::write(
            &file,
            r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","model":"claude-test","usage":{"input_tokens":20,"output_tokens":8}}}"#,
        )
        .unwrap();
        let replaced = sync_request_logs_with_connection(&mut conn, roots.clone(), true)
            .await
            .unwrap();
        assert!(replaced.written_rows >= 1);
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM request_logs WHERE file_path = ?1")
                .bind(&file_key)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(count, 1);

        fs::remove_file(file).unwrap();
        let removed = sync_request_logs_with_connection(&mut conn, roots, true)
            .await
            .unwrap();
        assert_eq!(removed.removed_files, 1);
    }

    #[tokio::test]
    async fn list_filters_and_caps_page_size() {
        let mut conn = test_connection().await;
        sqlx::query(
            "INSERT INTO request_logs(
                request_id, source, project_key, session_id, file_path, event_key, event_index,
                timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, created_at_ms, updated_at_ms
             ) VALUES ('r1', 'claude', 'project-a', 'session-a', 'missing.jsonl', 'e1', 0,
                1000, 'claude-test', 10, 5, 2, 1, 1000, 1000)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO usage_records(
                record_id, logical_request_id, data_source, source, event_key, file_path,
                event_index, session_id, project_key, attribution_status, response_model,
                pricing_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, usage_status, outcome, started_at_ms, completed_at_ms,
                duration_ms, created_at_ms, updated_at_ms
             ) VALUES ('r1', 'r1', 'session_log', 'claude', 'e1', 'missing.jsonl', 0,
                'session-a', 'project-a', 'resolved', 'claude-test', 'claude-test', 10, 5,
                2, 1, 'complete', 'success', 1000, 1000, 0, 1000, 1000)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let page = list_request_logs_with_connection(
            &mut conn,
            RequestLogFilters {
                source: Some("claude".to_string()),
                project_key: Some("project".to_string()),
                ..RequestLogFilters::default()
            },
            0,
            500,
        )
        .await
        .unwrap();

        assert_eq!(page.total, 1);
        assert_eq!(page.page_size, MAX_PAGE_SIZE);
        assert_eq!(page.data[0].total_tokens, 18);
        assert_eq!(page.summary.total_input_tokens, 10);
        assert_eq!(page.summary.total_output_tokens, 5);
        assert_eq!(page.summary.total_cache_read_tokens, 2);
        assert_eq!(page.summary.total_cache_creation_tokens, 1);
        assert!((page.summary.cache_hit_rate - (2.0 / 13.0)).abs() < f64::EPSILON);
        assert!(!page.data[0].session_available);
    }

    #[tokio::test]
    async fn list_preserves_route_error_code_and_safe_detail_for_legacy_compatibility() {
        let mut conn = test_connection().await;
        sqlx::query(
            "INSERT INTO usage_records(
                record_id, logical_request_id, data_source, source, provider_name,
                usage_status, status_code, outcome, error_code, error_detail,
                started_at_ms, created_at_ms, updated_at_ms
             ) VALUES
                ('route-error', 'route-error', 'route', 'codex', 'Provider A',
                 'not_applicable', 502, 'error', 'routing_upstream_http_error',
                 'upstream rejected the request', 2000, 2000, 2000),
                ('route-legacy', 'route-legacy', 'route', 'codex', 'Provider B',
                 'not_applicable', 504, 'error', NULL, NULL, 1000, 1000, 1000)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let page =
            list_request_logs_with_connection(&mut conn, RequestLogFilters::default(), 0, 20)
                .await
                .unwrap();
        let modern = page
            .data
            .iter()
            .find(|item| item.request_id == "route-error")
            .expect("new route error row is listed");
        let legacy = page
            .data
            .iter()
            .find(|item| item.request_id == "route-legacy")
            .expect("legacy route error row is listed");

        assert_eq!(
            modern.error_code.as_deref(),
            Some("routing_upstream_http_error")
        );
        assert_eq!(
            modern.error_detail.as_deref(),
            Some("upstream rejected the request")
        );
        assert_eq!(legacy.error_code, None);
        assert_eq!(legacy.error_detail, None);
    }

    #[tokio::test]
    async fn route_usage_replaces_cache_split_session_record() {
        let mut conn = test_connection().await;
        sqlx::query(
            "INSERT INTO usage_records(
                record_id, logical_request_id, data_source, source, event_key, file_path,
                event_index, session_id, project_key, attribution_status, response_model,
                pricing_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, usage_status, outcome, started_at_ms, completed_at_ms,
                duration_ms, created_at_ms, updated_at_ms
             ) VALUES ('session-row', 'session-row', 'session_log', 'codex', 'event-1',
                'missing.jsonl', 0, 'session-a', 'project-a', 'resolved', 'gpt-test',
                'gpt-test', 100, 20, 900, 0, 'complete', 'success', 30100, 30100,
                0, 30100, 30100)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO usage_records(
                record_id, logical_request_id, data_source, source, event_key, file_path,
                event_index, session_id, project_key, attribution_status, provider_id,
                provider_name, requested_model, outbound_model, response_model, pricing_model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                usage_status, status_code, outcome, started_at_ms, completed_at_ms, duration_ms,
                created_at_ms, updated_at_ms
             ) VALUES ('route-row', 'route-row', 'route', 'codex', '', 'missing.jsonl',
                0, 'session-a', 'project-a', 'resolved', 'provider-a', 'Provider A',
                'gpt-test', 'gpt-test', 'gpt-test', 'gpt-test', 1000, 20, 0, 0,
                'complete', 200, 'success', 10000, 30000, 20000, 10000, 30000)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let page =
            list_request_logs_with_connection(&mut conn, RequestLogFilters::default(), 0, 20)
                .await
                .unwrap();

        assert_eq!(page.total, 1);
        assert_eq!(page.data[0].request_id, "route-row");
        assert_eq!(page.data[0].data_source, "route");
        assert_eq!(page.summary.total_input_tokens, 1000);
        assert_eq!(page.summary.total_output_tokens, 20);
    }

    #[tokio::test]
    async fn project_path_filter_uses_materialized_windows_wsl_and_claude_keys() {
        let mut conn = test_connection().await;
        sqlx::query(
            "INSERT INTO usage_records(
                record_id, logical_request_id, data_source, source, event_key, file_path,
                event_index, session_id, project_key, project_path, attribution_status,
                response_model, pricing_model, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, usage_status, outcome,
                started_at_ms, completed_at_ms, duration_ms, created_at_ms, updated_at_ms
             ) VALUES
                ('windows-row', 'windows-row', 'session_log', 'codex', 'e1', 'windows.jsonl',
                 0, 'session-windows', 'project-windows', 'd:/work/project/subdir', 'resolved',
                 'gpt-test', 'gpt-test', 10, 1, 0, 0, 'complete', 'success', 1000, 1000, 0, 1000, 1000),
                ('wsl-row', 'wsl-row', 'session_log', 'codex', 'e2', 'wsl.jsonl',
                 0, 'session-wsl', 'project-wsl', '/mnt/d/work/project/worktree', 'resolved',
                 'gpt-test', 'gpt-test', 20, 2, 0, 0, 'complete', 'success', 2000, 2000, 0, 2000, 2000),
                ('claude-row', 'claude-row', 'session_log', 'claude', 'e3', 'claude.jsonl',
                 0, 'session-claude', 'd--work-project', NULL, 'resolved',
                 'claude-test', 'claude-test', 30, 3, 0, 0, 'complete', 'success', 3000, 3000, 0, 3000, 3000),
                ('legacy-codex-row', 'legacy-codex-row', 'session_log', 'codex', 'e4', 'legacy-codex.jsonl',
                 0, 'session-legacy-codex', 'project', NULL, 'resolved',
                 'gpt-test', 'gpt-test', 35, 3, 0, 0, 'complete', 'success', 3500, 3500, 0, 3500, 3500),
                ('other-row', 'other-row', 'session_log', 'codex', 'e4', 'other.jsonl',
                 0, 'session-other', 'project-other', 'd:/work/other', 'resolved',
                 'gpt-test', 'gpt-test', 40, 4, 0, 0, 'complete', 'success', 4000, 4000, 0, 4000, 4000)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let page = list_request_logs_with_connection(
            &mut conn,
            RequestLogFilters {
                project_path: Some(r"D:\work\project".to_string()),
                ..RequestLogFilters::default()
            },
            0,
            20,
        )
        .await
        .unwrap();

        let ids = page
            .data
            .iter()
            .map(|item| item.request_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(page.total, 4);
        assert!(ids.contains("windows-row"));
        assert!(ids.contains("wsl-row"));
        assert!(ids.contains("claude-row"));
        assert!(ids.contains("legacy-codex-row"));
        assert!(!ids.contains("other-row"));

        for project_path in [
            "/mnt/d/work/project",
            r"\\wsl.localhost\Ubuntu\mnt\d\work\project",
        ] {
            let equivalent_page = list_request_logs_with_connection(
                &mut conn,
                RequestLogFilters {
                    project_path: Some(project_path.to_string()),
                    ..RequestLogFilters::default()
                },
                0,
                20,
            )
            .await
            .unwrap();
            assert_eq!(equivalent_page.total, 4, "project path: {project_path}");
        }
    }

    #[test]
    fn cache_hit_rate_uses_input_and_cache_context_tokens() {
        assert!((request_log_cache_hit_rate(100, 25, 5) - (25.0 / 130.0)).abs() < f64::EPSILON);
        assert_eq!(request_log_cache_hit_rate(0, 0, 0), 0.0);
    }

    #[tokio::test]
    async fn unavailable_root_does_not_purge_existing_logs() {
        let temp = TempDir::new().unwrap();
        let claude = temp.path().join("claude");
        let codex = temp.path().join("codex");
        write_claude_session(
            &claude,
            r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-test","usage":{"input_tokens":10,"output_tokens":5}}}"#,
        );
        let roots = history_roots(
            Some(claude.to_string_lossy().to_string()),
            Some(codex.to_string_lossy().to_string()),
            None,
        );
        let mut conn = test_connection().await;

        sync_request_logs_with_connection(&mut conn, roots.clone(), true)
            .await
            .unwrap();
        fs::remove_dir_all(&claude).unwrap();

        let result = sync_request_logs_with_connection(&mut conn, roots, true)
            .await
            .unwrap();
        let file = claude
            .join("projects")
            .join("project-a")
            .join("session-a.jsonl");
        let file_key = path_to_key(&file);
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM request_logs WHERE file_path = ?1")
                .bind(&file_key)
                .fetch_one(&mut conn)
                .await
                .unwrap();

        assert_eq!(result.removed_files, 0);
        assert_eq!(count, 1);
    }

    #[test]
    fn wsl_session_path_remains_openable_without_native_metadata_check() {
        assert!(session_file_available(
            r"\\wsl.localhost\Ubuntu\home\me\.claude\projects\p\session.jsonl"
        ));
    }
}
