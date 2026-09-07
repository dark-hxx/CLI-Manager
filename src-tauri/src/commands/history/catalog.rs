mod schema;
use schema::ensure_schema;
mod queries;
#[cfg(test)]
use queries::{
    fts_literal, fts_trigram_query, list_sessions_from_legacy_catalog, list_sessions_from_v2,
    merge_search_results, merge_session_summaries, project_candidates,
    search_sessions_from_legacy_catalog, search_sessions_from_v2,
};
pub(super) use queries::{list_sessions, search_sessions};
mod session_detail;
pub(super) use session_detail::get_session_detail_from_v2;
#[cfg(test)]
use session_detail::get_session_detail_from_v2_with_conn;
mod remote_sync;
#[cfg(test)]
use remote_sync::apply_remote_sync_with_conn;
pub(super) use remote_sync::{apply_remote_sync, list_remote_cached, mark_remote_stale};
mod materialization;
use materialization::shadow_build_v2;
#[cfg(test)]
use materialization::{active_v2_source_instances, record_v2_index_failure};

use super::*;
#[cfg(test)]
use cli_manager_history_core::RemoteHistorySyncResult;
use log::{debug, warn};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

const CATALOG_DB_FILE: &str = "history-catalog.db";
const CATALOG_PARSER_VERSION: i64 = 2;
const HISTORY_INDEX_SCHEMA_VERSION: i64 = 6;
const HISTORY_INDEX_MODEL_VERSION: i64 = 1;
const CATALOG_REFRESH_TTL_MS: i64 = 10_000;
const CATALOG_SEARCH_MIN_CHARS: usize = 3;
const CATALOG_PARSE_BATCH_SIZE: usize = 2;
const CATALOG_PROGRESS_BATCH_SIZE: usize = 20;

static CATALOG_REFRESH_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
static CATALOG_SCHEMA_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
static CATALOG_DIRTY: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
struct CatalogFile {
    file_ref: SessionFileRef,
    fingerprint: SessionFileFingerprint,
    codex_thread_name_index: Option<Arc<super::CodexThreadNameIndex>>,
}

struct CatalogScan {
    files: Vec<CatalogFile>,
    codex_thread_name_fingerprint: String,
}

struct CatalogDocument {
    file_ref: SessionFileRef,
    fingerprint: SessionFileFingerprint,
    computed: CachedSessionComputation,
    cwd: Option<String>,
    messages: Vec<HistoryMessage>,
}

struct V2SourceInstance {
    id: String,
    source_id: String,
    settings_hash: String,
}

struct V2LegacySessionRow {
    file_ref: SessionFileRef,
    fingerprint: SessionFileFingerprint,
    session_id: String,
}

fn catalog_refresh_lock() -> &'static AsyncMutex<()> {
    CATALOG_REFRESH_LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn catalog_schema_lock() -> &'static AsyncMutex<()> {
    CATALOG_SCHEMA_LOCK.get_or_init(|| AsyncMutex::new(()))
}

pub(super) fn mark_dirty() {
    CATALOG_DIRTY.store(true, Ordering::Release);
}

pub(super) fn is_dirty() -> bool {
    CATALOG_DIRTY.load(Ordering::Acquire)
}

fn catalog_db_path() -> Result<PathBuf, String> {
    let dir = HISTORY_INDEX_CACHE_DIR
        .get()
        .cloned()
        .or_else(|| crate::app_paths::history_cache_dir().ok())
        .ok_or_else(|| "history_cache_dir_unavailable".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(CATALOG_DB_FILE))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn catalog_connect_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
}

fn map_remote_catalog_error(error: String) -> String {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("database is locked")
        || normalized.contains("database table is locked")
        || normalized.contains("(code: 5)")
        || normalized.contains("(code: 6)")
    {
        "history_catalog_busy".to_string()
    } else {
        error
    }
}

fn map_remote_catalog_sql_error(error: sqlx::Error) -> String {
    map_remote_catalog_error(error.to_string())
}

async fn open_catalog_once(path: &Path) -> Result<SqliteConnection, String> {
    let mut conn = SqliteConnection::connect_with(&catalog_connect_options(path))
        .await
        .map_err(|err| err.to_string())?;
    let _schema_guard = catalog_schema_lock().lock().await;
    ensure_schema(&mut conn).await?;
    Ok(conn)
}

async fn open_catalog() -> Result<SqliteConnection, String> {
    let path = catalog_db_path()?;
    match open_catalog_once(&path).await {
        Ok(conn) => Ok(conn),
        Err(err)
            if err.contains("malformed")
                || err.contains("not a database")
                || err.contains("file is not a database") =>
        {
            warn!(
                "history catalog corrupted, rebuilding: path={}, err={err}",
                path.display()
            );
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("db-wal"));
            let _ = std::fs::remove_file(path.with_extension("db-shm"));
            open_catalog_once(&path).await
        }
        Err(err) => Err(err),
    }
}

fn idle_status(roots: &HistoryRoots) -> HistoryIndexStatus {
    HistoryIndexStatus {
        roots_key: roots.cache_key(),
        phase: "idle".to_string(),
        indexed_files: 0,
        total_files: 0,
        generation: 0,
        partial: true,
        last_completed_at: None,
        error: None,
    }
}

pub(super) async fn get_status(roots: &HistoryRoots) -> Result<HistoryIndexStatus, String> {
    let mut conn = open_catalog().await?;
    get_status_with_conn(&mut conn, roots).await
}

pub(super) async fn get_v2_status() -> Result<HistoryIndexV2Status, String> {
    let path = catalog_db_path()?;
    let mut conn = open_catalog_once(&path).await?;
    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut conn)
        .await
        .map_err(|err| err.to_string())?;
    let schema_version = history_meta_value(&mut conn, "schema_version").await?;
    let model_version = history_meta_value(&mut conn, "model_version").await?;
    let tables = v2_table_counts(&mut conn).await?;
    let rows_for = |name: &str| {
        tables
            .iter()
            .find(|table| table.table == name)
            .map(|table| table.rows)
            .unwrap_or(0)
    };

    Ok(HistoryIndexV2Status {
        db_path: path_to_string(&path),
        initialized: user_version >= HISTORY_INDEX_SCHEMA_VERSION && schema_version.is_some(),
        user_version,
        schema_version,
        model_version,
        source_instances: rows_for("history_source_instances"),
        sessions: rows_for("history_sessions"),
        messages: rows_for("history_messages"),
        sync_runs: rows_for("history_sync_runs"),
        failures: rows_for("history_index_failures"),
        tables,
    })
}

async fn history_meta_value(
    conn: &mut SqliteConnection,
    key: &str,
) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM history_meta WHERE key = ?1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| err.to_string())
}

async fn v2_table_counts(
    conn: &mut SqliteConnection,
) -> Result<Vec<HistoryIndexV2TableStatus>, String> {
    let table_names = [
        "history_meta",
        "history_source_instances",
        "history_sessions",
        "history_session_artifacts",
        "history_session_relations",
        "history_messages",
        "history_message_parts",
        "history_tool_events",
        "history_usage_events",
        "history_session_model_usage",
        "history_file_changes",
        "history_source_state",
        "history_sync_runs",
        "history_index_failures",
    ];
    let mut tables = Vec::with_capacity(table_names.len());
    for table in table_names {
        let rows = sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
        tables.push(HistoryIndexV2TableStatus {
            table: table.to_string(),
            rows,
        });
    }
    Ok(tables)
}

pub(super) async fn upsert_v2_source_instance(
    input: HistoryIndexV2SourceInstanceInput,
) -> Result<HistoryIndexV2Status, String> {
    validate_source_instance_input(&input)?;
    let path = catalog_db_path()?;
    let mut conn = open_catalog_once(&path).await?;
    let now = now_millis();
    let mut tx = conn.begin().await.map_err(|err| err.to_string())?;
    sqlx::query(
        "UPDATE history_source_instances
         SET activation_state = 'inactive', updated_at = ?1
         WHERE source_id = ?2 AND scope_kind = 'configured' AND scope_key = 'desktop'
           AND activation_state = 'active' AND id <> ?3",
    )
    .bind(now)
    .bind(&input.source_id)
    .bind(&input.instance_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            display_name, locations_json, settings_hash, activation_state,
            scope_kind, scope_key, transport_kind, materialization_level,
            freshness_state, discovered, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active',
            'configured', 'desktop',
            CASE WHEN ?3 = 'wsl' THEN 'wsl' ELSE 'local' END,
            'full', 'fresh', ?9, ?10, ?10
         )
         ON CONFLICT(id) DO UPDATE SET
            source_id = excluded.source_id,
            environment_kind = excluded.environment_kind,
            environment_key = excluded.environment_key,
            storage_kind = excluded.storage_kind,
            display_name = excluded.display_name,
            locations_json = excluded.locations_json,
            settings_hash = excluded.settings_hash,
            activation_state = 'active',
            scope_kind = 'configured',
            scope_key = 'desktop',
            transport_kind = CASE
                WHEN excluded.environment_kind = 'wsl' THEN 'wsl'
                ELSE 'local'
            END,
            materialization_level = 'full',
            freshness_state = 'fresh',
            discovered = excluded.discovered,
            updated_at = excluded.updated_at",
    )
    .bind(&input.instance_id)
    .bind(&input.source_id)
    .bind(&input.environment_kind)
    .bind(&input.environment_key)
    .bind(&input.storage_kind)
    .bind(input.display_name.as_deref())
    .bind(&input.locations_json)
    .bind(&input.settings_hash)
    .bind(if input.discovered { 1_i64 } else { 0_i64 })
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    get_v2_status().await
}

pub(super) async fn deactivate_v2_source_instance(
    source_id: String,
    instance_id: Option<String>,
) -> Result<HistoryIndexV2Status, String> {
    let source_id = source_id.trim().to_string();
    if source_id.is_empty() {
        return Err("history_source_id_required".to_string());
    }
    let instance_id = instance_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let path = catalog_db_path()?;
    let mut conn = open_catalog_once(&path).await?;
    let now = now_millis();
    if let Some(instance_id) = instance_id {
        sqlx::query(
            "UPDATE history_source_instances
             SET activation_state = 'inactive', updated_at = ?1
             WHERE source_id = ?2 AND id = ?3 AND scope_kind = 'configured'",
        )
        .bind(now)
        .bind(source_id)
        .bind(instance_id)
        .execute(&mut conn)
        .await
        .map_err(|err| err.to_string())?;
    } else {
        sqlx::query(
            "UPDATE history_source_instances
             SET activation_state = 'inactive', updated_at = ?1
             WHERE source_id = ?2 AND scope_kind = 'configured'
               AND scope_key = 'desktop' AND activation_state = 'active'",
        )
        .bind(now)
        .bind(source_id)
        .execute(&mut conn)
        .await
        .map_err(|err| err.to_string())?;
    }
    get_v2_status().await
}

fn validate_source_instance_input(input: &HistoryIndexV2SourceInstanceInput) -> Result<(), String> {
    if input.source_id.trim().is_empty() {
        return Err("history_source_id_required".to_string());
    }
    if input.instance_id.trim().is_empty() {
        return Err("history_source_instance_id_required".to_string());
    }
    if input.environment_kind.trim().is_empty() {
        return Err("history_source_environment_required".to_string());
    }
    if input.environment_key.trim().is_empty() {
        return Err("history_source_environment_required".to_string());
    }
    if !matches!(input.storage_kind.as_str(), "file" | "database" | "mixed") {
        return Err("history_source_storage_kind_invalid".to_string());
    }
    if serde_json::from_str::<serde_json::Value>(&input.locations_json).is_err() {
        return Err("history_source_locations_json_invalid".to_string());
    }
    if input.settings_hash.trim().is_empty() {
        return Err("history_source_settings_hash_required".to_string());
    }
    Ok(())
}

async fn get_status_with_conn(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
) -> Result<HistoryIndexStatus, String> {
    let roots_key = roots.cache_key();
    let row = sqlx::query(
        "SELECT phase, indexed_files, total_files, generation, last_completed_at, error
         FROM history_catalog_state WHERE roots_key = ?1",
    )
    .bind(&roots_key)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let Some(row) = row else {
        return Ok(idle_status(roots));
    };
    let phase: String = row.try_get("phase").map_err(|err| err.to_string())?;
    Ok(HistoryIndexStatus {
        roots_key,
        partial: phase != "ready",
        phase,
        indexed_files: row
            .try_get::<i64, _>("indexed_files")
            .map_err(|err| err.to_string())?
            .max(0) as usize,
        total_files: row
            .try_get::<i64, _>("total_files")
            .map_err(|err| err.to_string())?
            .max(0) as usize,
        generation: row
            .try_get::<i64, _>("generation")
            .map_err(|err| err.to_string())?
            .max(0) as u64,
        last_completed_at: row
            .try_get::<Option<i64>, _>("last_completed_at")
            .map_err(|err| err.to_string())?,
        error: row
            .try_get::<Option<String>, _>("error")
            .map_err(|err| err.to_string())?,
    })
}

async fn persist_status(
    conn: &mut SqliteConnection,
    status: &HistoryIndexStatus,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO history_catalog_state(
            roots_key, phase, indexed_files, total_files, generation,
            last_completed_at, error, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(roots_key) DO UPDATE SET
            phase = excluded.phase,
            indexed_files = excluded.indexed_files,
            total_files = excluded.total_files,
            generation = excluded.generation,
            last_completed_at = excluded.last_completed_at,
            error = excluded.error,
            updated_at = excluded.updated_at",
    )
    .bind(&status.roots_key)
    .bind(&status.phase)
    .bind(status.indexed_files as i64)
    .bind(status.total_files as i64)
    .bind(status.generation as i64)
    .bind(status.last_completed_at)
    .bind(&status.error)
    .bind(now_millis())
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn emit_status(app: &AppHandle, status: &HistoryIndexStatus) {
    let _ = app.emit("history-index-status", status.clone());
}

fn catalog_path_within_roots(source: &str, file_path: &str, roots: &HistoryRoots) -> bool {
    if source == "opencode" {
        return opencode_locator_in_default_scope(file_path);
    }
    if source == "cline" {
        let requested = Path::new(file_path);
        return resolve_cline_history_roots()
            .into_iter()
            .any(|base| path_within_history_scope(requested, &base));
    }
    let Ok(base) = history_source_base(source, roots) else {
        return false;
    };
    let requested = Path::new(file_path);
    if path_within_history_scope(requested, &base) {
        return true;
    }

    let Ok(requested) = requested.canonicalize() else {
        return false;
    };
    let Ok(base) = base.canonicalize() else {
        return false;
    };
    path_within_history_scope(&requested, &base)
}

pub(super) async fn get_session_by_file_path(
    roots: &HistoryRoots,
    file_path: &str,
    source: &str,
    project_key: &str,
) -> Result<Option<HistorySessionSummary>, String> {
    let mut conn = open_catalog().await?;
    seed_from_legacy_if_empty(&mut conn, roots).await?;
    let roots_key = roots.cache_key();
    let row = sqlx::query(
        "SELECT session_id, source, project_key, title, file_path, cwd,
                created_at, updated_at, message_count, branch,
                NULL AS parent_session_id
         FROM history_catalog_sessions
         WHERE roots_key = ?1 AND file_path = ?2 AND source = ?3 AND project_key = ?4",
    )
    .bind(&roots_key)
    .bind(file_path)
    .bind(source)
    .bind(project_key)
    .fetch_optional(&mut conn)
    .await
    .map_err(|err| err.to_string())?;
    let Some(row) = row else {
        return Ok(None);
    };
    let summary = HistorySessionSummary {
        session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
        source: row.try_get("source").map_err(|err| err.to_string())?,
        project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
        title: row.try_get("title").map_err(|err| err.to_string())?,
        file_path: row.try_get("file_path").map_err(|err| err.to_string())?,
        cwd: row.try_get("cwd").map_err(|err| err.to_string())?,
        created_at: row.try_get("created_at").map_err(|err| err.to_string())?,
        updated_at: row.try_get("updated_at").map_err(|err| err.to_string())?,
        message_count: row
            .try_get::<i64, _>("message_count")
            .map_err(|err| err.to_string())?
            .max(0) as usize,
        branch: row.try_get("branch").map_err(|err| err.to_string())?,
        parent_session_id: row
            .try_get("parent_session_id")
            .map_err(|err| err.to_string())?,
    };
    if catalog_path_within_roots(&summary.source, &summary.file_path, roots) {
        Ok(Some(summary))
    } else {
        Ok(None)
    }
}

async fn seed_from_legacy_if_empty(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
) -> Result<(), String> {
    let roots_key = roots.cache_key();
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM history_catalog_sessions WHERE roots_key = ?1")
            .bind(&roots_key)
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
    if count > 0 {
        return Ok(());
    }

    let roots_for_load = roots.clone();
    let legacy = tokio::task::spawn_blocking(move || load_persisted_history_index(&roots_for_load))
        .await
        .map_err(|err| err.to_string())?;
    let Some(index) = legacy else {
        return Ok(());
    };

    let mut tx = conn.begin().await.map_err(|err| err.to_string())?;
    for entry in index.entries {
        if !catalog_path_within_roots(
            &entry.file_ref.source,
            &entry.file_ref.path.to_string_lossy(),
            roots,
        ) {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO history_catalog_sessions(
                roots_key, file_path, source, project_key, cwd, cwd_normalized,
                session_id, title, branch, created_at, updated_at, message_count,
                file_created_at, file_updated_at, file_size, parser_version, indexed_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14)",
        )
        .bind(&roots_key)
        .bind(entry.file_ref.path.to_string_lossy().to_string())
        .bind(entry.file_ref.source)
        .bind(entry.file_ref.project_key)
        .bind(entry.computed.session_id)
        .bind(entry.computed.title)
        .bind(entry.computed.branch)
        .bind(entry.computed.created_at)
        .bind(entry.computed.updated_at)
        .bind(entry.computed.message_count as i64)
        .bind(entry.fingerprint.created_at)
        .bind(entry.fingerprint.updated_at)
        .bind(entry.fingerprint.size as i64)
        .bind(now_millis())
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    tx.commit().await.map_err(|err| err.to_string())?;
    debug!("history catalog seeded from legacy cache: roots={roots_key}");
    Ok(())
}

fn stats_summary_matches_project_path(
    summary: &HistorySessionSummary,
    target_project_path: &str,
) -> bool {
    let file_ref = SessionFileRef {
        source: summary.source.clone(),
        project_key: summary.project_key.clone(),
        path: PathBuf::from(&summary.file_path),
    };
    session_matches_project_path(&file_ref, target_project_path)
        || summary
            .cwd
            .as_deref()
            .is_some_and(|cwd| opencode_cwd_matches_project_path(cwd, target_project_path))
}

pub(super) async fn stats_session_facts(
    roots: &HistoryRoots,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_paths: &[String],
    target_source_instance: Option<&str>,
) -> Result<Vec<HistoryStatsSessionFact>, String> {
    let mut conn = open_catalog().await?;
    stats_session_facts_from_v2(
        &mut conn,
        roots,
        source_filter,
        target_project,
        target_project_paths,
        target_source_instance,
    )
    .await
}

async fn stats_session_facts_from_v2(
    conn: &mut SqliteConnection,
    _roots: &HistoryRoots,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_paths: &[String],
    target_source_instance: Option<&str>,
) -> Result<Vec<HistoryStatsSessionFact>, String> {
    let source_filter = source_filter
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"));
    let target_project = target_project
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_source_instance = target_source_instance
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut sql = String::from(
        "SELECT hs.id, i.id AS source_instance_id, i.source_id AS source, hs.source_session_id AS session_id,
                hs.project_key, hs.title,
                COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                hs.cwd, hs.created_at, hs.updated_at, hs.message_count, hs.branch,
                hs.parent_session_id,
                hs.input_tokens AS session_input_tokens,
                hs.output_tokens AS session_output_tokens,
                hs.cache_read_tokens AS session_cache_read_tokens,
                hs.cache_creation_tokens AS session_cache_creation_tokens,
                hs.total_cost_usd AS session_total_cost_usd,
                hs.dominant_model AS session_model,
                ue.event_index, ue.timestamp_ms, ue.model AS event_model,
                ue.input_tokens AS event_input_tokens,
                ue.output_tokens AS event_output_tokens,
                ue.cache_read_tokens AS event_cache_read_tokens,
                ue.cache_creation_tokens AS event_cache_creation_tokens,
                ue.cost_usd AS event_cost_usd
         FROM history_sessions hs
         JOIN history_source_instances i ON i.id = hs.source_instance_id
         LEFT JOIN history_usage_events ue ON ue.session_id = hs.id
         WHERE i.activation_state = 'active' AND hs.parse_status = 'ok'
           AND (i.transport_kind <> 'ssh' OR hs.storage_kind = 'remote')",
    );
    if target_source_instance.is_some() {
        sql.push_str(" AND hs.source_instance_id = ?");
    }
    if source_filter.is_some() {
        sql.push_str(" AND i.source_id = ?");
    }
    if target_project.is_some() {
        sql.push_str(" AND hs.project_key = ?");
    }
    sql.push_str(" ORDER BY hs.updated_at DESC, hs.id ASC, ue.event_index ASC");

    let mut query = sqlx::query(&sql);
    if let Some(source_instance_id) = target_source_instance {
        query = query.bind(source_instance_id);
    }
    if let Some(source) = source_filter {
        query = query.bind(source);
    }
    if let Some(project) = target_project {
        query = query.bind(project);
    }
    let rows = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;

    let mut facts = Vec::new();
    for row in rows {
        let summary = HistorySessionSummary {
            session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
            source: row.try_get("source").map_err(|err| err.to_string())?,
            project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
            title: row.try_get("title").map_err(|err| err.to_string())?,
            file_path: row.try_get("file_path").map_err(|err| err.to_string())?,
            cwd: row.try_get("cwd").map_err(|err| err.to_string())?,
            created_at: row.try_get("created_at").map_err(|err| err.to_string())?,
            updated_at: row.try_get("updated_at").map_err(|err| err.to_string())?,
            message_count: row
                .try_get::<i64, _>("message_count")
                .map_err(|err| err.to_string())?
                .max(0) as usize,
            branch: row.try_get("branch").map_err(|err| err.to_string())?,
            parent_session_id: row
                .try_get("parent_session_id")
                .map_err(|err| err.to_string())?,
        };
        if !target_project_paths.is_empty()
            && !target_project_paths
                .iter()
                .any(|project_path| stats_summary_matches_project_path(&summary, project_path))
        {
            continue;
        }
        let event_index = row
            .try_get::<Option<i64>, _>("event_index")
            .map_err(|err| err.to_string())?;
        let (occurred_at, model, usage) = if event_index.is_some() {
            let timestamp_ms = row
                .try_get::<Option<i64>, _>("timestamp_ms")
                .map_err(|err| err.to_string())?;
            let model = row
                .try_get::<Option<String>, _>("event_model")
                .map_err(|err| err.to_string())?;
            let usage = UsageStatsScan {
                input_tokens: row
                    .try_get::<Option<i64>, _>("event_input_tokens")
                    .map_err(|err| err.to_string())?
                    .unwrap_or(0)
                    .max(0) as u64,
                output_tokens: row
                    .try_get::<Option<i64>, _>("event_output_tokens")
                    .map_err(|err| err.to_string())?
                    .unwrap_or(0)
                    .max(0) as u64,
                cache_read_tokens: row
                    .try_get::<Option<i64>, _>("event_cache_read_tokens")
                    .map_err(|err| err.to_string())?
                    .unwrap_or(0)
                    .max(0) as u64,
                cache_creation_tokens: row
                    .try_get::<Option<i64>, _>("event_cache_creation_tokens")
                    .map_err(|err| err.to_string())?
                    .unwrap_or(0)
                    .max(0) as u64,
                total_cost_usd: row
                    .try_get::<Option<f64>, _>("event_cost_usd")
                    .map_err(|err| err.to_string())?
                    .unwrap_or(0.0),
                unpriced_tokens: 0,
            };
            (timestamp_ms.unwrap_or(summary.updated_at), model, usage)
        } else {
            let model = row
                .try_get::<Option<String>, _>("session_model")
                .map_err(|err| err.to_string())?;
            let usage = UsageStatsScan {
                input_tokens: row
                    .try_get::<i64, _>("session_input_tokens")
                    .map_err(|err| err.to_string())?
                    .max(0) as u64,
                output_tokens: row
                    .try_get::<i64, _>("session_output_tokens")
                    .map_err(|err| err.to_string())?
                    .max(0) as u64,
                cache_read_tokens: row
                    .try_get::<i64, _>("session_cache_read_tokens")
                    .map_err(|err| err.to_string())?
                    .max(0) as u64,
                cache_creation_tokens: row
                    .try_get::<i64, _>("session_cache_creation_tokens")
                    .map_err(|err| err.to_string())?
                    .max(0) as u64,
                total_cost_usd: row
                    .try_get::<f64, _>("session_total_cost_usd")
                    .map_err(|err| err.to_string())?,
                unpriced_tokens: 0,
            };
            (summary.updated_at, model, usage)
        };
        if usage_stats_total_tokens(usage) == 0 {
            continue;
        }
        facts.push(HistoryStatsSessionFact {
            summary,
            occurred_at,
            stats: reprice_usage_stats(model.as_deref(), usage),
            model,
        });
    }
    Ok(facts)
}

fn collect_codex_catalog_files(root: &Path) -> Vec<SessionFileRef> {
    let root_str = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&root_str) {
            return collect_wsl_codex_session_files(&linux_path, &distro);
        }
    }
    if !root.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_files_recursive(root, &mut files, &|file_path| {
        is_jsonl(file_path)
            && file_path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("rollout-"))
    });
    files
        .into_iter()
        .map(|path| SessionFileRef {
            source: "codex".to_string(),
            project_key: codex_project_key_from_path(&path, root),
            path,
        })
        .collect()
}

fn collect_catalog_files_with_context(roots: &HistoryRoots) -> CatalogScan {
    let codex_thread_name_index = Arc::new(super::codex_thread_name_index(roots));
    let codex_thread_name_fingerprint = codex_thread_name_index.fingerprint.clone();
    let mut files = collect_claude_session_files(&resolve_claude_history_root(roots));
    files.extend(collect_codex_catalog_files(&resolve_codex_history_root(
        roots,
    )));
    files.extend(collect_gemini_session_files(&resolve_gemini_history_root()));
    files.extend(collect_copilot_session_files(
        &resolve_copilot_history_root(),
    ));
    files.extend(collect_antigravity_session_files(
        &resolve_antigravity_history_root(),
    ));
    files.extend(collect_grok_session_files(&resolve_grok_history_root(
        roots,
    )));
    files.extend(super::kimi::collect_kimi_session_files(
        &super::kimi::resolve_kimi_history_root(roots),
    ));
    files.extend(collect_pi_session_files(&resolve_pi_history_root()));
    files.extend(collect_kiro_session_files(&resolve_kiro_history_root()));
    for root in resolve_cline_history_roots() {
        files.extend(collect_cline_session_files(&root));
    }
    files.extend(collect_cursor_session_files(&resolve_cursor_history_root()));
    let files = files
        .into_iter()
        .map(|file_ref| CatalogFile {
            fingerprint: session_file_fingerprint(&file_ref.path),
            codex_thread_name_index: (file_ref.source == "codex")
                .then(|| codex_thread_name_index.clone()),
            file_ref,
        })
        .collect();
    CatalogScan {
        files,
        codex_thread_name_fingerprint,
    }
}

#[cfg(test)]
fn collect_catalog_files(roots: &HistoryRoots) -> Vec<CatalogFile> {
    collect_catalog_files_with_context(roots).files
}

fn parse_catalog_file(file: CatalogFile) -> CatalogDocument {
    let (mut computed, messages) = scan_session_computation_with_messages(
        &file.file_ref.path,
        file.fingerprint.created_at,
        file.fingerprint.updated_at,
    );
    if let Some(index) = file.codex_thread_name_index.as_ref() {
        super::apply_codex_thread_name(&file.file_ref, index, &mut computed);
    }
    let cwd = get_or_scan_session_project(&file.file_ref.path).cwd;
    let mut file_ref = file.file_ref;
    if file_ref.source != "claude" {
        if let Some(project_key) = cwd.as_deref().and_then(project_key_from_cwd) {
            file_ref.project_key = project_key;
        }
    }
    CatalogDocument {
        file_ref,
        fingerprint: file.fingerprint,
        computed,
        cwd,
        messages,
    }
}

fn parse_catalog_batch(batch: Vec<CatalogFile>) -> Vec<CatalogDocument> {
    let results = Mutex::new(Vec::with_capacity(batch.len()));
    std::thread::scope(|scope| {
        for file in batch {
            let results = &results;
            scope.spawn(move || {
                let document = parse_catalog_file(file);
                if let Ok(mut results) = results.lock() {
                    results.push(document);
                }
            });
        }
    });
    results.into_inner().unwrap_or_default()
}

fn opencode_catalog_document(parsed: OpenCodeParsedSession) -> CatalogDocument {
    CatalogDocument {
        file_ref: parsed.file_ref,
        fingerprint: parsed.fingerprint,
        computed: parsed.computed,
        cwd: parsed.cwd,
        messages: parsed.messages,
    }
}

async fn replace_document(
    conn: &mut SqliteConnection,
    roots_key: &str,
    document: CatalogDocument,
) -> Result<(), String> {
    let file_path = document.file_ref.path.to_string_lossy().to_string();
    let cwd_normalized = document.cwd.as_deref().map(normalize_history_path);
    let mut tx = conn.begin().await.map_err(|err| err.to_string())?;
    sqlx::query("DELETE FROM history_catalog_messages WHERE roots_key = ?1 AND file_path = ?2")
        .bind(roots_key)
        .bind(&file_path)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    sqlx::query("DELETE FROM history_catalog_sessions WHERE roots_key = ?1 AND file_path = ?2")
        .bind(roots_key)
        .bind(&file_path)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO history_catalog_sessions(
            roots_key, file_path, source, project_key, cwd, cwd_normalized,
            session_id, title, branch, created_at, updated_at, message_count,
            file_created_at, file_updated_at, file_size, parser_version, indexed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )
    .bind(roots_key)
    .bind(&file_path)
    .bind(&document.file_ref.source)
    .bind(&document.file_ref.project_key)
    .bind(&document.cwd)
    .bind(cwd_normalized)
    .bind(&document.computed.session_id)
    .bind(&document.computed.title)
    .bind(&document.computed.branch)
    .bind(document.computed.created_at)
    .bind(document.computed.updated_at)
    .bind(document.computed.message_count as i64)
    .bind(document.fingerprint.created_at)
    .bind(document.fingerprint.updated_at)
    .bind(document.fingerprint.size as i64)
    .bind(CATALOG_PARSER_VERSION)
    .bind(now_millis())
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    for (message_index, message) in document.messages.into_iter().enumerate() {
        sqlx::query(
            "INSERT INTO history_catalog_messages(
                roots_key, file_path, message_index, role, timestamp, content
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(roots_key)
        .bind(&file_path)
        .bind(message_index as i64)
        .bind(message.role)
        .bind(message.timestamp)
        .bind(message.content)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(())
}

async fn delete_document(
    conn: &mut SqliteConnection,
    roots_key: &str,
    file_path: &str,
) -> Result<(), String> {
    let mut tx = conn.begin().await.map_err(|err| err.to_string())?;
    sqlx::query("DELETE FROM history_catalog_messages WHERE roots_key = ?1 AND file_path = ?2")
        .bind(roots_key)
        .bind(file_path)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    sqlx::query("DELETE FROM history_catalog_sessions WHERE roots_key = ?1 AND file_path = ?2")
        .bind(roots_key)
        .bind(file_path)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(())
}

async fn refresh_catalog(
    app: &AppHandle,
    roots: &HistoryRoots,
) -> Result<HistoryIndexStatus, String> {
    let roots_key = roots.cache_key();
    let mut conn = open_catalog().await?;
    seed_from_legacy_if_empty(&mut conn, roots).await?;
    let mut status = get_status_with_conn(&mut conn, roots).await?;
    status.phase = "scanning".to_string();
    status.partial = true;
    status.error = None;
    persist_status(&mut conn, &status).await?;
    emit_status(app, &status);

    let roots_for_scan = roots.clone();
    let catalog_scan =
        tokio::task::spawn_blocking(move || collect_catalog_files_with_context(&roots_for_scan))
            .await
            .map_err(|err| err.to_string())?;
    let files = catalog_scan.files;
    let codex_thread_name_fingerprint = catalog_scan.codex_thread_name_fingerprint;
    let codex_thread_name_meta_key = format!("codex_thread_name_fingerprint:{roots_key}");
    let previous_codex_thread_name_fingerprint =
        history_meta_value(&mut conn, &codex_thread_name_meta_key).await?;
    let codex_thread_name_changed = previous_codex_thread_name_fingerprint.as_deref()
        != Some(codex_thread_name_fingerprint.as_str());
    let (opencode_documents, preserve_opencode_rows) = match opencode_catalog_sessions().await {
        Ok(Some(sessions)) => (
            sessions
                .into_iter()
                .map(opencode_catalog_document)
                .collect::<Vec<_>>(),
            false,
        ),
        Ok(None) => (Vec::new(), true),
        Err(err) => {
            warn!("opencode catalog discovery failed: err={err}");
            (Vec::new(), true)
        }
    };
    let total_files = files.len() + opencode_documents.len();
    let rows = sqlx::query(
        "SELECT file_path, source, file_created_at, file_updated_at, file_size, parser_version
         FROM history_catalog_sessions WHERE roots_key = ?1",
    )
    .bind(&roots_key)
    .fetch_all(&mut conn)
    .await
    .map_err(|err| err.to_string())?;
    let mut existing: HashMap<String, (String, i64, i64, u64, i64)> = HashMap::new();
    for row in rows {
        existing.insert(
            row.try_get("file_path").map_err(|err| err.to_string())?,
            (
                row.try_get("source").map_err(|err| err.to_string())?,
                row.try_get("file_created_at")
                    .map_err(|err| err.to_string())?,
                row.try_get("file_updated_at")
                    .map_err(|err| err.to_string())?,
                row.try_get::<i64, _>("file_size")
                    .map_err(|err| err.to_string())?
                    .max(0) as u64,
                row.try_get("parser_version")
                    .map_err(|err| err.to_string())?,
            ),
        );
    }

    let current_paths: HashSet<String> = files
        .iter()
        .map(|file| file.file_ref.path.to_string_lossy().to_string())
        .chain(
            opencode_documents
                .iter()
                .map(|document| document.file_ref.path.to_string_lossy().to_string()),
        )
        .collect();
    for stale in existing
        .iter()
        .filter(|(path, (source, _, _, _, _))| {
            !current_paths.contains(*path) && !(preserve_opencode_rows && source == "opencode")
        })
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>()
    {
        delete_document(&mut conn, &roots_key, &stale).await?;
    }

    let mut pending = Vec::new();
    for file in files {
        let path = file.file_ref.path.to_string_lossy().to_string();
        let reusable =
            existing
                .get(&path)
                .is_some_and(|(source, created, updated, size, version)| {
                    *created == file.fingerprint.created_at
                        && *updated == file.fingerprint.updated_at
                        && *size == file.fingerprint.size
                        && *version == CATALOG_PARSER_VERSION
                        && !(codex_thread_name_changed && source == "codex")
                });
        if !reusable {
            pending.push(file);
        }
    }
    pending.sort_by(|a, b| b.fingerprint.updated_at.cmp(&a.fingerprint.updated_at));
    let mut pending_documents = Vec::new();
    for document in opencode_documents {
        let path = document.file_ref.path.to_string_lossy().to_string();
        let reusable = existing
            .get(&path)
            .is_some_and(|(_, created, updated, size, version)| {
                *created == document.fingerprint.created_at
                    && *updated == document.fingerprint.updated_at
                    && *size == document.fingerprint.size
                    && *version == CATALOG_PARSER_VERSION
            });
        if !reusable {
            pending_documents.push(document);
        }
    }

    status.phase = "indexing".to_string();
    status.total_files = total_files;
    status.indexed_files = total_files
        .saturating_sub(pending.len())
        .saturating_sub(pending_documents.len());
    persist_status(&mut conn, &status).await?;
    emit_status(app, &status);

    let mut progress_since_emit = 0usize;
    for batch in pending.chunks(CATALOG_PARSE_BATCH_SIZE) {
        let batch = batch.to_vec();
        let documents = tokio::task::spawn_blocking(move || parse_catalog_batch(batch))
            .await
            .map_err(|err| err.to_string())?;
        for document in documents {
            replace_document(&mut conn, &roots_key, document).await?;
            status.indexed_files = status.indexed_files.saturating_add(1);
            progress_since_emit = progress_since_emit.saturating_add(1);
        }
        if progress_since_emit >= CATALOG_PROGRESS_BATCH_SIZE {
            progress_since_emit = 0;
            status.generation = status.generation.saturating_add(1);
            persist_status(&mut conn, &status).await?;
            emit_status(app, &status);
        }
    }
    for document in pending_documents {
        replace_document(&mut conn, &roots_key, document).await?;
        status.indexed_files = status.indexed_files.saturating_add(1);
    }

    status.phase = "ready".to_string();
    status.partial = false;
    status.indexed_files = total_files;
    status.total_files = total_files;
    status.generation = status.generation.saturating_add(1);
    status.last_completed_at = Some(now_millis());
    status.error = None;
    if let Err(err) = shadow_build_v2(
        &mut conn,
        roots,
        &roots_key,
        status.generation,
        codex_thread_name_changed,
    )
    .await
    {
        warn!("history v2 shadow build failed: roots={roots_key}, err={err}");
    }
    sqlx::query(
        "INSERT INTO history_meta(key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at",
    )
    .bind(&codex_thread_name_meta_key)
    .bind(&codex_thread_name_fingerprint)
    .bind(now_millis())
    .execute(&mut conn)
    .await
    .map_err(|err| err.to_string())?;
    persist_status(&mut conn, &status).await?;
    emit_status(app, &status);
    CATALOG_DIRTY.store(false, Ordering::Release);
    debug!("history catalog refresh completed: roots={roots_key}, files={total_files}");
    Ok(status)
}

async fn mark_refresh_error(app: &AppHandle, roots: &HistoryRoots, error: String) {
    let Ok(mut conn) = open_catalog().await else {
        return;
    };
    let mut status = get_status_with_conn(&mut conn, roots)
        .await
        .unwrap_or_else(|_| idle_status(roots));
    status.phase = "error".to_string();
    status.partial = true;
    status.error = Some(error);
    let _ = persist_status(&mut conn, &status).await;
    emit_status(app, &status);
}

pub(super) async fn ensure_refresh(
    app: AppHandle,
    roots: HistoryRoots,
    force: bool,
    wait: bool,
) -> Result<HistoryIndexStatus, String> {
    let roots_key = roots.cache_key();
    let status = get_status(&roots)
        .await
        .unwrap_or_else(|_| idle_status(&roots));
    let codex_thread_name_changed = if !force
        && !CATALOG_DIRTY.load(Ordering::Acquire)
        && status.phase == "ready"
        && status
            .last_completed_at
            .is_some_and(|completed| now_millis() - completed < CATALOG_REFRESH_TTL_MS)
    {
        let roots_for_scan = roots.clone();
        let current_fingerprint = tokio::task::spawn_blocking(move || {
            super::codex_thread_name_index(&roots_for_scan).fingerprint
        })
        .await
        .ok();
        if let Some(current_fingerprint) = current_fingerprint {
            if let Ok(mut conn) = open_catalog().await {
                let key = format!("codex_thread_name_fingerprint:{roots_key}");
                let previous_fingerprint = history_meta_value(&mut conn, &key).await.ok().flatten();
                previous_fingerprint.as_deref() != Some(current_fingerprint.as_str())
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };
    if !force
        && !CATALOG_DIRTY.load(Ordering::Acquire)
        && status.phase == "ready"
        && status
            .last_completed_at
            .is_some_and(|completed| now_millis() - completed < CATALOG_REFRESH_TTL_MS)
        && !codex_thread_name_changed
    {
        return Ok(status);
    }

    if wait {
        let _refresh_guard = catalog_refresh_lock().lock().await;
        let result = refresh_catalog(&app, &roots).await;
        if let Err(error) = &result {
            mark_refresh_error(&app, &roots, error.clone()).await;
        }
        return result;
    }

    let Ok(refresh_guard) = catalog_refresh_lock().try_lock() else {
        return Ok(status);
    };
    tauri::async_runtime::spawn(async move {
        let _refresh_guard = refresh_guard;
        if let Err(error) = refresh_catalog(&app, &roots).await {
            warn!("history catalog refresh failed: roots={roots_key}, err={error}");
            mark_refresh_error(&app, &roots, error).await;
        }
    });
    Ok(status)
}

#[cfg(test)]
mod tests;
