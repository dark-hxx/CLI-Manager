use super::*;
use log::{debug, warn};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteRow, SqliteSynchronous};
use sqlx::{Connection, QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CATALOG_DB_FILE: &str = "history-catalog.db";
const CATALOG_PARSER_VERSION: i64 = 1;
const HISTORY_INDEX_SCHEMA_VERSION: i64 = 2;
const HISTORY_INDEX_MODEL_VERSION: i64 = 1;
const CATALOG_REFRESH_TTL_MS: i64 = 10_000;
const CATALOG_SEARCH_MIN_CHARS: usize = 3;
const CATALOG_PARSE_BATCH_SIZE: usize = 2;
const CATALOG_PROGRESS_BATCH_SIZE: usize = 20;

static RUNNING_REFRESHES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static CATALOG_DIRTY: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
struct CatalogFile {
    file_ref: SessionFileRef,
    fingerprint: SessionFileFingerprint,
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

fn running_refreshes() -> &'static Mutex<HashSet<String>> {
    RUNNING_REFRESHES.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(super) fn mark_dirty() {
    CATALOG_DIRTY.store(true, Ordering::Release);
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

async fn open_catalog_once(path: &Path) -> Result<SqliteConnection, String> {
    let mut conn = SqliteConnection::connect_with(&catalog_connect_options(path))
        .await
        .map_err(|err| err.to_string())?;
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

async fn ensure_schema(conn: &mut SqliteConnection) -> Result<(), String> {
    let current_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    if current_version >= HISTORY_INDEX_SCHEMA_VERSION {
        return Ok(());
    }
    let statements = [
        "CREATE TABLE IF NOT EXISTS history_catalog_sessions (
            roots_key TEXT NOT NULL,
            file_path TEXT NOT NULL,
            source TEXT NOT NULL,
            project_key TEXT NOT NULL,
            cwd TEXT,
            cwd_normalized TEXT,
            session_id TEXT NOT NULL,
            title TEXT NOT NULL,
            branch TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL,
            file_created_at INTEGER NOT NULL,
            file_updated_at INTEGER NOT NULL,
            file_size INTEGER NOT NULL,
            parser_version INTEGER NOT NULL,
            indexed_at INTEGER NOT NULL,
            PRIMARY KEY (roots_key, file_path)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_catalog_sessions_scope
            ON history_catalog_sessions(roots_key, source, updated_at DESC, file_path)",
        "CREATE INDEX IF NOT EXISTS idx_history_catalog_sessions_project
            ON history_catalog_sessions(roots_key, cwd_normalized, source, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_history_catalog_sessions_identity
            ON history_catalog_sessions(roots_key, source, session_id)",
        "CREATE TABLE IF NOT EXISTS history_catalog_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            roots_key TEXT NOT NULL,
            file_path TEXT NOT NULL,
            message_index INTEGER NOT NULL,
            role TEXT NOT NULL,
            timestamp TEXT,
            content TEXT NOT NULL,
            UNIQUE (roots_key, file_path, message_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_catalog_messages_file
            ON history_catalog_messages(roots_key, file_path, message_index)",
        "CREATE VIRTUAL TABLE IF NOT EXISTS history_catalog_messages_fts USING fts5(
            content,
            content='history_catalog_messages',
            content_rowid='id',
            tokenize='trigram case_sensitive 0'
        )",
        "CREATE TRIGGER IF NOT EXISTS history_catalog_messages_ai AFTER INSERT ON history_catalog_messages BEGIN
            INSERT INTO history_catalog_messages_fts(rowid, content) VALUES (new.id, new.content);
        END",
        "CREATE TRIGGER IF NOT EXISTS history_catalog_messages_ad AFTER DELETE ON history_catalog_messages BEGIN
            INSERT INTO history_catalog_messages_fts(history_catalog_messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
        END",
        "CREATE TRIGGER IF NOT EXISTS history_catalog_messages_au AFTER UPDATE ON history_catalog_messages BEGIN
            INSERT INTO history_catalog_messages_fts(history_catalog_messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
            INSERT INTO history_catalog_messages_fts(rowid, content) VALUES (new.id, new.content);
        END",
        "CREATE TABLE IF NOT EXISTS history_catalog_state (
            roots_key TEXT PRIMARY KEY,
            phase TEXT NOT NULL,
            indexed_files INTEGER NOT NULL DEFAULT 0,
            total_files INTEGER NOT NULL DEFAULT 0,
            generation INTEGER NOT NULL DEFAULT 0,
            last_completed_at INTEGER,
            error TEXT,
            updated_at INTEGER NOT NULL
        )",
    ];
    for statement in statements {
        sqlx::query(statement)
            .execute(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
    }
    ensure_v2_schema(conn).await?;
    Ok(())
}

async fn ensure_v2_schema(conn: &mut SqliteConnection) -> Result<(), String> {
    let statements = [
        "CREATE TABLE IF NOT EXISTS history_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        "CREATE TABLE IF NOT EXISTS history_source_instances (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            environment_kind TEXT NOT NULL,
            environment_key TEXT NOT NULL,
            storage_kind TEXT NOT NULL,
            display_name TEXT,
            locations_json TEXT NOT NULL,
            settings_hash TEXT NOT NULL,
            activation_state TEXT NOT NULL DEFAULT 'pending',
            discovered INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_source_instances_source
            ON history_source_instances(source_id, activation_state)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_history_source_instances_one_active
            ON history_source_instances(source_id)
            WHERE activation_state = 'active'",
        "CREATE TABLE IF NOT EXISTS history_sessions (
            id INTEGER PRIMARY KEY,
            source_instance_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            storage_kind TEXT NOT NULL,
            primary_path TEXT,
            database_path TEXT,
            raw_key TEXT,
            source_version TEXT,
            project_key TEXT,
            cwd TEXT,
            cwd_normalized TEXT,
            title TEXT NOT NULL,
            branch TEXT,
            lifecycle_state TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            timestamp_quality TEXT NOT NULL DEFAULT 'reported',
            message_count INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd REAL NOT NULL DEFAULT 0,
            usage_quality TEXT NOT NULL DEFAULT 'unknown',
            cost_kind TEXT NOT NULL DEFAULT 'unknown',
            pricing_version TEXT,
            dominant_model TEXT,
            current_model TEXT,
            context_window INTEGER,
            last_context_tokens INTEGER,
            reasoning_effort TEXT,
            tool_call_count INTEGER NOT NULL DEFAULT 0,
            fingerprint_kind TEXT NOT NULL,
            fingerprint_value TEXT NOT NULL,
            parser_version INTEGER NOT NULL,
            model_version INTEGER NOT NULL,
            parse_status TEXT NOT NULL,
            completeness_json TEXT,
            raw_pointers_json TEXT,
            source_extension_json TEXT,
            last_seen_generation INTEGER NOT NULL,
            indexed_at INTEGER NOT NULL,
            FOREIGN KEY(source_instance_id)
                REFERENCES history_source_instances(id) ON DELETE CASCADE,
            UNIQUE(source_instance_id, source_session_id)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_sessions_updated
            ON history_sessions(source_instance_id, updated_at DESC, id)",
        "CREATE INDEX IF NOT EXISTS idx_history_sessions_project
            ON history_sessions(cwd_normalized, updated_at DESC, id)",
        "CREATE INDEX IF NOT EXISTS idx_history_sessions_created
            ON history_sessions(created_at DESC, id)",
        "CREATE TABLE IF NOT EXISTS history_session_artifacts (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            artifact_index INTEGER NOT NULL,
            role TEXT NOT NULL,
            kind TEXT NOT NULL,
            ownership TEXT NOT NULL,
            locator_json TEXT NOT NULL,
            fingerprint_kind TEXT,
            fingerprint_value TEXT,
            writable INTEGER NOT NULL DEFAULT 0,
            source_schema_version TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, artifact_index)
        )",
        "CREATE TABLE IF NOT EXISTS history_session_relations (
            parent_session_id INTEGER NOT NULL,
            child_session_id INTEGER NOT NULL,
            relation_kind TEXT NOT NULL,
            relation_index INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(parent_session_id, child_session_id, relation_kind),
            FOREIGN KEY(parent_session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(child_session_id) REFERENCES history_sessions(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS history_messages (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            message_index INTEGER NOT NULL,
            source_message_id TEXT,
            role TEXT NOT NULL,
            display_content TEXT NOT NULL,
            timestamp_ms INTEGER,
            model TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cache_read_tokens INTEGER,
            cache_creation_tokens INTEGER,
            editable INTEGER NOT NULL DEFAULT 0,
            raw_pointers_json TEXT,
            source_extension_json TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, message_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_messages_session
            ON history_messages(session_id, message_index)",
        "CREATE TABLE IF NOT EXISTS history_message_parts (
            id INTEGER PRIMARY KEY,
            message_id INTEGER NOT NULL,
            part_index INTEGER NOT NULL,
            kind TEXT NOT NULL,
            text_content TEXT,
            mime_type TEXT,
            tool_call_id TEXT,
            tool_name TEXT,
            content_storage TEXT NOT NULL DEFAULT 'inline',
            payload_json TEXT,
            raw_pointers_json TEXT,
            source_extension_json TEXT,
            FOREIGN KEY(message_id) REFERENCES history_messages(id) ON DELETE CASCADE,
            UNIQUE(message_id, part_index)
        )",
        "CREATE VIRTUAL TABLE IF NOT EXISTS history_messages_fts USING fts5(
            display_content,
            content='history_messages',
            content_rowid='id',
            tokenize='trigram case_sensitive 0'
        )",
        "CREATE TRIGGER IF NOT EXISTS history_messages_ai AFTER INSERT ON history_messages BEGIN
            INSERT INTO history_messages_fts(rowid, display_content) VALUES (new.id, new.display_content);
        END",
        "CREATE TRIGGER IF NOT EXISTS history_messages_ad AFTER DELETE ON history_messages BEGIN
            INSERT INTO history_messages_fts(history_messages_fts, rowid, display_content)
            VALUES ('delete', old.id, old.display_content);
        END",
        "CREATE TRIGGER IF NOT EXISTS history_messages_au AFTER UPDATE ON history_messages BEGIN
            INSERT INTO history_messages_fts(history_messages_fts, rowid, display_content)
            VALUES ('delete', old.id, old.display_content);
            INSERT INTO history_messages_fts(rowid, display_content) VALUES (new.id, new.display_content);
        END",
        "CREATE TABLE IF NOT EXISTS history_tool_events (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            message_id INTEGER,
            event_index INTEGER NOT NULL,
            call_id TEXT,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            status TEXT,
            timestamp_ms INTEGER,
            duration_ms INTEGER,
            input_summary TEXT,
            output_summary TEXT,
            input_json TEXT,
            output_json TEXT,
            raw_pointers_json TEXT,
            source_extension_json TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(message_id) REFERENCES history_messages(id) ON DELETE SET NULL,
            UNIQUE(session_id, event_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_tool_events_session
            ON history_tool_events(session_id, event_index)",
        "CREATE TABLE IF NOT EXISTS history_usage_events (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            event_index INTEGER NOT NULL,
            timestamp_ms INTEGER,
            model TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            raw_pointers_json TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, event_index)
        )",
        "CREATE TABLE IF NOT EXISTS history_session_model_usage (
            session_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            PRIMARY KEY(session_id, model),
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS history_file_changes (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            change_index INTEGER NOT NULL,
            message_id INTEGER,
            source_kind TEXT NOT NULL,
            tool_name TEXT,
            file_path TEXT NOT NULL,
            old_text TEXT,
            new_text TEXT,
            patch TEXT,
            additions INTEGER NOT NULL DEFAULT 0,
            deletions INTEGER NOT NULL DEFAULT 0,
            timestamp_ms INTEGER,
            raw_pointers_json TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(message_id) REFERENCES history_messages(id) ON DELETE SET NULL,
            UNIQUE(session_id, change_index)
        )",
        "CREATE TABLE IF NOT EXISTS history_source_state (
            source_instance_id TEXT PRIMARY KEY,
            phase TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 0,
            parser_version INTEGER NOT NULL,
            settings_hash TEXT NOT NULL,
            discovered_sessions INTEGER NOT NULL DEFAULT 0,
            indexed_sessions INTEGER NOT NULL DEFAULT 0,
            failed_sessions INTEGER NOT NULL DEFAULT 0,
            last_started_at INTEGER,
            last_completed_at INTEGER,
            last_success_at INTEGER,
            error_code TEXT,
            error_detail TEXT,
            FOREIGN KEY(source_instance_id)
                REFERENCES history_source_instances(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS history_sync_runs (
            id TEXT PRIMARY KEY,
            source_instance_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            trigger_kind TEXT NOT NULL,
            phase TEXT NOT NULL,
            discovery_complete INTEGER NOT NULL DEFAULT 0,
            discovered_sessions INTEGER NOT NULL DEFAULT 0,
            changed_sessions INTEGER NOT NULL DEFAULT 0,
            indexed_sessions INTEGER NOT NULL DEFAULT 0,
            failed_sessions INTEGER NOT NULL DEFAULT 0,
            warnings_json TEXT,
            error_code TEXT,
            error_detail TEXT,
            started_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY(source_instance_id)
                REFERENCES history_source_instances(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS history_index_failures (
            source_instance_id TEXT NOT NULL,
            discovery_key TEXT NOT NULL,
            session_ref_json TEXT NOT NULL,
            fingerprint_value TEXT,
            parser_version INTEGER NOT NULL,
            error_code TEXT NOT NULL,
            error_detail TEXT,
            first_failed_at INTEGER NOT NULL,
            last_failed_at INTEGER NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(source_instance_id, discovery_key),
            FOREIGN KEY(source_instance_id)
                REFERENCES history_source_instances(id) ON DELETE CASCADE
        )",
    ];
    for statement in statements {
        sqlx::query(statement)
            .execute(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
    }
    sqlx::query(&format!(
        "PRAGMA user_version = {HISTORY_INDEX_SCHEMA_VERSION}"
    ))
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let now = now_millis();
    for (key, value) in [
        ("schema_version", HISTORY_INDEX_SCHEMA_VERSION.to_string()),
        ("model_version", HISTORY_INDEX_MODEL_VERSION.to_string()),
    ] {
        sqlx::query(
            "INSERT INTO history_meta(key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(now)
        .execute(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    }
    Ok(())
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
         WHERE source_id = ?2 AND activation_state = 'active' AND id <> ?3",
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
            discovered, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?10
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
             WHERE source_id = ?2 AND id = ?3",
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
             WHERE source_id = ?2 AND activation_state = 'active'",
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
                created_at, updated_at, message_count, branch
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

fn project_candidates(project_path: &str) -> (Vec<String>, Vec<String>, Option<String>) {
    let target = normalize_history_path(project_path);
    let mut cwd_candidates = vec![target.clone()];
    if let Some(wsl) = crate::wsl::windows_path_to_wsl(&target) {
        cwd_candidates.push(normalize_history_path(&wsl));
    }
    if let Some((_distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&target) {
        cwd_candidates.push(normalize_history_path(&linux_path));
    }
    cwd_candidates.sort();
    cwd_candidates.dedup();

    let mut claude_keys: Vec<String> = cwd_candidates
        .iter()
        .map(|candidate| claude_project_key_from_path(candidate))
        .collect();
    claude_keys.sort();
    claude_keys.dedup();
    let basename = target
        .trim_end_matches('/')
        .rsplit('/')
        .find(|part| !part.is_empty())
        .map(str::to_lowercase);
    (cwd_candidates, claude_keys, basename)
}

fn push_project_filter(builder: &mut QueryBuilder<'_, Sqlite>, project_path: &str) {
    let (cwd_candidates, claude_keys, basename) = project_candidates(project_path);
    builder.push(" AND (");
    if !claude_keys.is_empty() {
        builder.push("(s.source = 'claude' AND lower(s.project_key) IN (");
        let mut separated = builder.separated(", ");
        for key in claude_keys {
            separated.push_bind(key);
        }
        separated.push_unseparated("))");
    } else {
        builder.push("0");
    }
    for candidate in cwd_candidates {
        builder.push(" OR s.cwd_normalized = ");
        builder.push_bind(candidate.clone());
        builder.push(" OR s.cwd_normalized LIKE ");
        builder.push_bind(format!("{candidate}/%"));
    }
    if let Some(basename) = basename {
        builder.push(
            " OR (s.source = 'codex' AND s.cwd_normalized IS NULL AND lower(s.project_key) = ",
        );
        builder.push_bind(basename);
        builder.push(")");
    }
    builder.push(")");
}

fn merge_fetch_limit(limit: Option<usize>, offset: Option<usize>) -> Option<usize> {
    limit.map(|value| value.saturating_add(offset.unwrap_or(0)))
}

fn session_summary_from_row(row: SqliteRow) -> Result<HistorySessionSummary, String> {
    Ok(HistorySessionSummary {
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
    })
}

fn merge_session_summaries(
    primary: Vec<HistorySessionSummary>,
    fallback: Vec<HistorySessionSummary>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Vec<HistorySessionSummary> {
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    for session in primary.into_iter().chain(fallback) {
        if seen.insert((session.source.clone(), session.file_path.clone())) {
            sessions.push(session);
        }
    }
    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.file_path.cmp(&right.file_path))
    });
    let offset = offset.unwrap_or(0);
    let iter = sessions.into_iter().skip(offset);
    if let Some(limit) = limit {
        iter.take(limit).collect()
    } else {
        iter.collect()
    }
}

async fn list_sessions_from_v2(
    conn: &mut SqliteConnection,
    _roots: &HistoryRoots,
    source: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path, s.cwd,
                s.created_at, s.updated_at, s.message_count, s.branch
         FROM (
            SELECT hs.source_session_id AS session_id, i.source_id AS source,
                   hs.project_key, hs.title,
                   COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                   hs.cwd, hs.cwd_normalized, hs.created_at, hs.updated_at,
                   hs.message_count, hs.branch
            FROM history_sessions hs
            JOIN history_source_instances i ON i.id = hs.source_instance_id
            WHERE i.activation_state = 'active' AND hs.parse_status = 'ok'
         ) s WHERE 1 = 1",
    );
    if let Some(source) = source
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = project_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        push_project_filter(&mut builder, &project_path);
    }
    if let Some(query) = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND (instr(lower(s.title), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.session_id), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.project_key), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.source), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(COALESCE(s.branch, '')), ");
        builder.push_bind(query);
        builder.push(") > 0)");
    }
    builder.push(" ORDER BY s.updated_at DESC, s.file_path ASC LIMIT ");
    builder.push_bind(limit.unwrap_or(usize::MAX).min(i64::MAX as usize) as i64);
    builder.push(" OFFSET ");
    builder.push_bind(offset.unwrap_or(0).min(i64::MAX as usize) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    rows.into_iter()
        .map(session_summary_from_row)
        .collect::<Result<Vec<_>, String>>()
}

async fn list_sessions_from_legacy_catalog(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    source: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    let roots_key = roots.cache_key();
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path, s.cwd,
                s.created_at, s.updated_at, s.message_count, s.branch
         FROM history_catalog_sessions s WHERE s.roots_key = ",
    );
    builder.push_bind(&roots_key);
    if let Some(source) = source
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = project_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        push_project_filter(&mut builder, &project_path);
    }
    if let Some(query) = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND (instr(lower(s.title), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.session_id), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.project_key), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.source), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(COALESCE(s.branch, '')), ");
        builder.push_bind(query);
        builder.push(") > 0)");
    }
    builder.push(" ORDER BY s.updated_at DESC, s.file_path ASC LIMIT ");
    builder.push_bind(limit.unwrap_or(usize::MAX).min(i64::MAX as usize) as i64);
    builder.push(" OFFSET ");
    builder.push_bind(offset.unwrap_or(0).min(i64::MAX as usize) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    let sessions = rows
        .into_iter()
        .map(session_summary_from_row)
        .collect::<Result<Vec<_>, String>>()?;
    Ok(sessions
        .into_iter()
        .filter(|session| catalog_path_within_roots(&session.source, &session.file_path, roots))
        .collect())
}

pub(super) async fn list_sessions(
    roots: &HistoryRoots,
    source: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    let mut conn = open_catalog().await?;
    seed_from_legacy_if_empty(&mut conn, roots).await?;
    let fetch_limit = merge_fetch_limit(limit, offset);
    let v2 = list_sessions_from_v2(
        &mut conn,
        roots,
        source.clone(),
        project_path.clone(),
        query.clone(),
        fetch_limit,
        Some(0),
    )
    .await
    .map_err(|err| {
        warn!("history v2 list fallback: {err}");
        err
    })
    .unwrap_or_default();
    let legacy = list_sessions_from_legacy_catalog(
        &mut conn,
        roots,
        source,
        project_path,
        query,
        fetch_limit,
        Some(0),
    )
    .await?;
    Ok(merge_session_summaries(v2, legacy, limit, offset))
}

fn fts_literal(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

fn merge_search_results(
    primary: Vec<HistorySearchResult>,
    fallback: Vec<HistorySearchResult>,
    max_hits: usize,
) -> Vec<HistorySearchResult> {
    let mut seen = HashSet::new();
    let mut hits = Vec::new();
    for hit in primary.into_iter().chain(fallback) {
        let key = (
            hit.source.clone(),
            hit.file_path.clone(),
            hit.role.clone(),
            hit.snippet.clone(),
            hit.timestamp.clone(),
        );
        if seen.insert(key) {
            hits.push(hit);
        }
        if hits.len() >= max_hits {
            break;
        }
    }
    hits
}

fn search_result_from_legacy_row(row: SqliteRow) -> Result<HistorySearchResult, String> {
    Ok(HistorySearchResult {
        session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
        source: row.try_get("source").map_err(|err| err.to_string())?,
        project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
        title: row.try_get("title").map_err(|err| err.to_string())?,
        file_path: row.try_get("file_path").map_err(|err| err.to_string())?,
        role: row.try_get("role").map_err(|err| err.to_string())?,
        snippet: row.try_get("snippet").map_err(|err| err.to_string())?,
        timestamp: row.try_get("timestamp").map_err(|err| err.to_string())?,
    })
}

fn search_result_from_v2_row(row: SqliteRow) -> Result<HistorySearchResult, String> {
    let timestamp_ms = row
        .try_get::<Option<i64>, _>("timestamp_ms")
        .map_err(|err| err.to_string())?;
    Ok(HistorySearchResult {
        session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
        source: row.try_get("source").map_err(|err| err.to_string())?,
        project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
        title: row.try_get("title").map_err(|err| err.to_string())?,
        file_path: row.try_get("file_path").map_err(|err| err.to_string())?,
        role: row.try_get("role").map_err(|err| err.to_string())?,
        snippet: row.try_get("snippet").map_err(|err| err.to_string())?,
        timestamp: timestamp_ms.and_then(timestamp_millis_to_rfc3339),
    })
}

async fn search_sessions_from_legacy_catalog(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    normalized: &str,
    source_filter: Option<&str>,
    project_filter: Option<&str>,
    max_hits: usize,
) -> Result<Vec<HistorySearchResult>, String> {
    let roots_key = roots.cache_key();

    let mut session_builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path,
                'sessionId' AS role, s.session_id AS snippet, NULL AS timestamp
         FROM history_catalog_sessions s
         WHERE s.roots_key = ",
    );
    session_builder.push_bind(&roots_key);
    session_builder.push(" AND instr(lower(s.session_id), ");
    session_builder.push_bind(normalized.to_lowercase());
    session_builder.push(") > 0");
    if let Some(source) = source_filter {
        session_builder.push(" AND s.source = ");
        session_builder.push_bind(source);
    }
    if let Some(project_path) = project_filter {
        push_project_filter(&mut session_builder, project_path);
    }
    session_builder.push(" ORDER BY s.updated_at DESC LIMIT ");
    session_builder.push_bind(max_hits as i64);
    let mut hits: Vec<HistorySearchResult> = session_builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?
        .into_iter()
        .map(search_result_from_legacy_row)
        .collect::<Result<Vec<_>, String>>()?;
    hits.retain(|hit| catalog_path_within_roots(&hit.source, &hit.file_path, roots));
    if hits.len() >= max_hits {
        return Ok(hits);
    }

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path,
                m.role, snippet(history_catalog_messages_fts, 0, '', '', '…', 24) AS snippet,
                m.timestamp
         FROM history_catalog_messages_fts
         JOIN history_catalog_messages m ON m.id = history_catalog_messages_fts.rowid
         JOIN history_catalog_sessions s
           ON s.roots_key = m.roots_key AND s.file_path = m.file_path
         WHERE history_catalog_messages_fts MATCH ",
    );
    builder.push_bind(fts_literal(normalized));
    builder.push(" AND s.roots_key = ");
    builder.push_bind(&roots_key);
    if let Some(source) = source_filter {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = project_filter {
        push_project_filter(&mut builder, project_path);
    }
    builder.push(" ORDER BY s.updated_at DESC, m.message_index ASC LIMIT ");
    builder.push_bind((max_hits - hits.len()) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    let message_hits = rows
        .into_iter()
        .map(search_result_from_legacy_row)
        .collect::<Result<Vec<_>, String>>()?;
    hits.extend(
        message_hits
            .into_iter()
            .filter(|hit| catalog_path_within_roots(&hit.source, &hit.file_path, roots)),
    );
    Ok(hits)
}

async fn search_sessions_from_v2(
    conn: &mut SqliteConnection,
    _roots: &HistoryRoots,
    normalized: &str,
    source_filter: Option<&str>,
    project_filter: Option<&str>,
    max_hits: usize,
) -> Result<Vec<HistorySearchResult>, String> {
    let mut session_builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path,
                'sessionId' AS role, s.session_id AS snippet, NULL AS timestamp_ms
         FROM (
            SELECT hs.id, hs.source_session_id AS session_id, i.source_id AS source,
                   hs.project_key, hs.title,
                   COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                   hs.cwd_normalized, hs.updated_at
            FROM history_sessions hs
            JOIN history_source_instances i ON i.id = hs.source_instance_id
            WHERE i.activation_state = 'active' AND hs.parse_status = 'ok'
         ) s
         WHERE instr(lower(s.session_id), ",
    );
    session_builder.push_bind(normalized.to_lowercase());
    session_builder.push(") > 0");
    if let Some(source) = source_filter {
        session_builder.push(" AND s.source = ");
        session_builder.push_bind(source);
    }
    if let Some(project_path) = project_filter {
        push_project_filter(&mut session_builder, project_path);
    }
    session_builder.push(" ORDER BY s.updated_at DESC LIMIT ");
    session_builder.push_bind(max_hits as i64);

    let mut hits: Vec<HistorySearchResult> = session_builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?
        .into_iter()
        .map(search_result_from_v2_row)
        .collect::<Result<Vec<_>, String>>()?;
    if hits.len() >= max_hits {
        return Ok(hits);
    }

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path,
                m.role, snippet(history_messages_fts, 0, '', '', '…', 24) AS snippet,
                m.timestamp_ms
         FROM history_messages_fts
         JOIN history_messages m ON m.id = history_messages_fts.rowid
         JOIN (
            SELECT hs.id, hs.source_session_id AS session_id, i.source_id AS source,
                   hs.project_key, hs.title,
                   COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                   hs.cwd_normalized, hs.updated_at
            FROM history_sessions hs
            JOIN history_source_instances i ON i.id = hs.source_instance_id
            WHERE i.activation_state = 'active' AND hs.parse_status = 'ok'
         ) s ON s.id = m.session_id
         WHERE history_messages_fts MATCH ",
    );
    builder.push_bind(fts_literal(normalized));
    if let Some(source) = source_filter {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = project_filter {
        push_project_filter(&mut builder, project_path);
    }
    builder.push(" ORDER BY s.updated_at DESC, m.message_index ASC LIMIT ");
    builder.push_bind((max_hits - hits.len()) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    let message_hits = rows
        .into_iter()
        .map(search_result_from_v2_row)
        .collect::<Result<Vec<_>, String>>()?;
    hits.extend(message_hits);
    Ok(hits)
}

pub(super) async fn search_sessions(
    roots: &HistoryRoots,
    query: &str,
    source: Option<String>,
    project_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistorySearchResult>, String> {
    let normalized = query.trim();
    if normalized.chars().count() < CATALOG_SEARCH_MIN_CHARS {
        return Ok(Vec::new());
    }
    let mut conn = open_catalog().await?;
    seed_from_legacy_if_empty(&mut conn, roots).await?;
    let max_hits = limit.unwrap_or(100).max(1).min(i64::MAX as usize);
    let source_filter = source
        .as_deref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let project_filter = project_path
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let v2 = search_sessions_from_v2(
        &mut conn,
        roots,
        normalized,
        source_filter.as_deref(),
        project_filter.as_deref(),
        max_hits,
    )
    .await
    .map_err(|err| {
        warn!("history v2 search fallback: {err}");
        err
    })
    .unwrap_or_default();
    let legacy = search_sessions_from_legacy_catalog(
        &mut conn,
        roots,
        normalized,
        source_filter.as_deref(),
        project_filter.as_deref(),
        max_hits,
    )
    .await?;
    Ok(merge_search_results(v2, legacy, max_hits))
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
) -> Result<Vec<HistoryStatsSessionFact>, String> {
    let mut conn = open_catalog().await?;
    stats_session_facts_from_v2(
        &mut conn,
        roots,
        source_filter,
        target_project,
        target_project_paths,
    )
    .await
}

async fn stats_session_facts_from_v2(
    conn: &mut SqliteConnection,
    _roots: &HistoryRoots,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_paths: &[String],
) -> Result<Vec<HistoryStatsSessionFact>, String> {
    let rows = sqlx::query(
        "SELECT hs.id, i.source_id AS source, hs.source_session_id AS session_id,
                hs.project_key, hs.title,
                COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                hs.cwd, hs.created_at, hs.updated_at, hs.message_count, hs.branch,
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
         ORDER BY hs.updated_at DESC, hs.id ASC, ue.event_index ASC",
    )
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
        };
        if let Some(filter) = source_filter {
            if summary.source != filter {
                continue;
            }
        }
        if let Some(project) = target_project {
            if summary.project_key != project {
                continue;
            }
        }
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

fn v2_raw_pointer_line_index(raw_pointers_json: Option<String>) -> Option<usize> {
    let raw = raw_pointers_json?;
    let pointers = serde_json::from_str::<Vec<Value>>(&raw).ok()?;
    pointers
        .iter()
        .find_map(|pointer| pointer.get("lineIndex").and_then(Value::as_u64))
        .map(|value| value as usize)
}

pub(super) async fn get_session_detail_from_v2(
    roots: &HistoryRoots,
    file_path: &str,
    source: &str,
    project_key: &str,
) -> Result<Option<HistorySessionDetail>, String> {
    let mut conn = open_catalog().await?;
    get_session_detail_from_v2_with_conn(&mut conn, roots, file_path, source, project_key).await
}

async fn get_session_detail_from_v2_with_conn(
    conn: &mut SqliteConnection,
    _roots: &HistoryRoots,
    file_path: &str,
    source: &str,
    project_key: &str,
) -> Result<Option<HistorySessionDetail>, String> {
    let row = sqlx::query(
        "SELECT hs.id, i.source_id AS source, hs.source_session_id AS session_id,
                hs.project_key, hs.title,
                COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                hs.cwd, hs.created_at, hs.updated_at, hs.message_count, hs.branch,
                hs.input_tokens, hs.output_tokens, hs.cache_read_tokens,
                hs.cache_creation_tokens, hs.total_cost_usd, hs.dominant_model,
                hs.current_model, hs.context_window, hs.last_context_tokens,
                hs.reasoning_effort, hs.tool_call_count
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
    let file_path: String = row.try_get("file_path").map_err(|err| err.to_string())?;
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
        "SELECT message_index, role, display_content, timestamp_ms, model,
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
    let messages = message_rows
        .into_iter()
        .map(|message_row| {
            let timestamp_ms = message_row
                .try_get::<Option<i64>, _>("timestamp_ms")
                .map_err(|err| err.to_string())?;
            Ok(HistoryMessage {
                role: message_row.try_get("role").map_err(|err| err.to_string())?,
                content: message_row
                    .try_get("display_content")
                    .map_err(|err| err.to_string())?,
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
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let tool_rows = sqlx::query(
        "SELECT te.call_id, te.name, te.category, hm.message_index, te.timestamp_ms,
                te.status, te.duration_ms, te.input_summary, te.output_summary
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
        match category.as_str() {
            "mcp" => *mcp_calls.entry(name.clone()).or_insert(0) += 1,
            "skill" => *skill_calls.entry(name.clone()).or_insert(0) += 1,
            _ => *builtin_calls.entry(name.clone()).or_insert(0) += 1,
        }
        let timestamp_ms = tool_row
            .try_get::<Option<i64>, _>("timestamp_ms")
            .map_err(|err| err.to_string())?;
        tool_events.push(HistoryToolEvent {
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
        session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
        source,
        project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
        title: row.try_get("title").map_err(|err| err.to_string())?,
        file_path,
        cwd: row.try_get("cwd").map_err(|err| err.to_string())?,
        created_at: row.try_get("created_at").map_err(|err| err.to_string())?,
        updated_at: row.try_get("updated_at").map_err(|err| err.to_string())?,
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

fn collect_catalog_files(roots: &HistoryRoots) -> Vec<CatalogFile> {
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
    files.extend(collect_grok_session_files(&resolve_grok_history_root()));
    files.extend(collect_pi_session_files(&resolve_pi_history_root()));
    files.extend(collect_kiro_session_files(&resolve_kiro_history_root()));
    for root in resolve_cline_history_roots() {
        files.extend(collect_cline_session_files(&root));
    }
    files.extend(collect_cursor_session_files(&resolve_cursor_history_root()));
    files
        .into_iter()
        .map(|file_ref| CatalogFile {
            fingerprint: session_file_fingerprint(&file_ref.path),
            file_ref,
        })
        .collect()
}

fn parse_catalog_file(file: CatalogFile) -> CatalogDocument {
    let (computed, messages) = scan_session_computation_with_messages(
        &file.file_ref.path,
        file.fingerprint.created_at,
        file.fingerprint.updated_at,
    );
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

async fn active_v2_source_instances(
    conn: &mut SqliteConnection,
) -> Result<Vec<V2SourceInstance>, String> {
    let rows = sqlx::query(
        "SELECT id, source_id, settings_hash
         FROM history_source_instances
         WHERE activation_state = 'active'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    rows.into_iter()
        .map(|row| {
            Ok(V2SourceInstance {
                id: row.try_get("id").map_err(|err| err.to_string())?,
                source_id: row.try_get("source_id").map_err(|err| err.to_string())?,
                settings_hash: row
                    .try_get("settings_hash")
                    .map_err(|err| err.to_string())?,
            })
        })
        .collect()
}

async fn legacy_sessions_for_v2(
    conn: &mut SqliteConnection,
    roots_key: &str,
    source_id: &str,
) -> Result<Vec<V2LegacySessionRow>, String> {
    let rows = sqlx::query(
        "SELECT file_path, source, project_key, session_id,
                file_created_at, file_updated_at, file_size
         FROM history_catalog_sessions
         WHERE roots_key = ?1 AND source = ?2
         ORDER BY updated_at DESC, file_path ASC",
    )
    .bind(roots_key)
    .bind(source_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    rows.into_iter()
        .map(|row| {
            let file_path: String = row.try_get("file_path").map_err(|err| err.to_string())?;
            Ok(V2LegacySessionRow {
                file_ref: SessionFileRef {
                    source: row.try_get("source").map_err(|err| err.to_string())?,
                    project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
                    path: PathBuf::from(file_path),
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
                session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
            })
        })
        .collect()
}

async fn existing_v2_session_fingerprints(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query(
        "SELECT source_session_id, fingerprint_value
         FROM history_sessions
         WHERE source_instance_id = ?1
           AND parser_version = ?2
           AND model_version = ?3",
    )
    .bind(source_instance_id)
    .bind(HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION)
    .bind(HISTORY_INDEX_V2_ADAPTER_MODEL_VERSION)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get("source_session_id")
                    .map_err(|err| err.to_string())?,
                row.try_get("fingerprint_value")
                    .map_err(|err| err.to_string())?,
            ))
        })
        .collect()
}

async fn replace_v2_session(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    source_instance_id: &str,
    generation: u64,
    row: &V2LegacySessionRow,
) -> Result<(), String> {
    let parts = scan_session_detail_parts(&row.file_ref);
    let adapted =
        build_v2_adapter_session_from_parts(&row.file_ref, roots, row.fingerprint, &parts);
    let session_ref = adapted.session_ref;
    let stats = &parts.computed.stats;
    let raw_pointers_json =
        serde_json::to_string(&session_ref.raw_pointers).map_err(|err| err.to_string())?;
    let cwd_normalized = session_ref.cwd.as_deref().map(normalize_history_path);
    let now = now_millis();
    let mut tx = conn.begin().await.map_err(|err| err.to_string())?;
    sqlx::query(
        "DELETE FROM history_sessions
         WHERE source_instance_id = ?1 AND source_session_id = ?2",
    )
    .bind(source_instance_id)
    .bind(&session_ref.source_session_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    let result = sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            database_path, raw_key, project_key, cwd, cwd_normalized, title, branch,
            lifecycle_state, created_at, updated_at, timestamp_quality, message_count,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            total_cost_usd, usage_quality, cost_kind, fingerprint_kind, fingerprint_value,
            dominant_model, current_model, context_window, last_context_tokens, reasoning_effort,
            tool_call_count, parser_version, model_version, parse_status, raw_pointers_json,
            last_seen_generation, indexed_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            'active', ?12, ?13, 'reported', ?14,
            ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, 'file-stat', ?22,
            ?23, ?24, ?25, ?26, ?27,
            ?28, ?29, ?30, 'ok', ?31, ?32, ?33
         )",
    )
    .bind(source_instance_id)
    .bind(&session_ref.source_session_id)
    .bind(&session_ref.storage_kind)
    .bind(&session_ref.primary_path)
    .bind(&session_ref.database_path)
    .bind(&session_ref.raw_key)
    .bind(&session_ref.project_key)
    .bind(&session_ref.cwd)
    .bind(&cwd_normalized)
    .bind(&session_ref.title)
    .bind(&session_ref.branch)
    .bind(session_ref.created_at)
    .bind(session_ref.updated_at)
    .bind(adapted.messages.len() as i64)
    .bind(stats.input_tokens as i64)
    .bind(stats.output_tokens as i64)
    .bind(stats.cache_read_tokens as i64)
    .bind(stats.cache_creation_tokens as i64)
    .bind(stats.total_cost_usd)
    .bind(
        if stats.input_tokens > 0
            || stats.output_tokens > 0
            || stats.cache_read_tokens > 0
            || stats.cache_creation_tokens > 0
        {
            "parsed"
        } else {
            "unknown"
        },
    )
    .bind(if stats.total_cost_usd > 0.0 {
        "reported"
    } else {
        "unknown"
    })
    .bind(&session_ref.fingerprint_value)
    .bind(&stats.dominant_model)
    .bind(&stats.current_model)
    .bind(stats.context_window.map(|value| value as i64))
    .bind(stats.last_context_tokens.map(|value| value as i64))
    .bind(&stats.reasoning_effort)
    .bind(stats.tool_call_count as i64)
    .bind(HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION)
    .bind(HISTORY_INDEX_V2_ADAPTER_MODEL_VERSION)
    .bind(raw_pointers_json)
    .bind(generation as i64)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    let session_row_id = result.last_insert_rowid();
    for message in adapted.messages {
        sqlx::query(
            "INSERT INTO history_messages(
                session_id, message_index, role, display_content, timestamp_ms,
                model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, editable, raw_pointers_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )
        .bind(session_row_id)
        .bind(message.message_index as i64)
        .bind(message.role)
        .bind(message.display_content)
        .bind(message.timestamp_ms)
        .bind(message.model)
        .bind(message.input_tokens.map(|value| value as i64))
        .bind(message.output_tokens.map(|value| value as i64))
        .bind(message.cache_read_tokens.map(|value| value as i64))
        .bind(message.cache_creation_tokens.map(|value| value as i64))
        .bind(if message.editable { 1_i64 } else { 0_i64 })
        .bind(serde_json::to_string(&message.raw_pointers).map_err(|err| err.to_string())?)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    for event in &stats.usage_events {
        sqlx::query(
            "INSERT INTO history_usage_events(
                session_id, event_index, timestamp_ms, model, input_tokens,
                output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                raw_pointers_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
        )
        .bind(session_row_id)
        .bind(event.event_index as i64)
        .bind(event.timestamp_ms)
        .bind(&event.model)
        .bind(event.usage.input_tokens as i64)
        .bind(event.usage.output_tokens as i64)
        .bind(event.usage.cache_read_tokens as i64)
        .bind(event.usage.cache_creation_tokens as i64)
        .bind(event.usage.total_cost_usd)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    for (model, usage) in &stats.model_usage {
        sqlx::query(
            "INSERT INTO history_session_model_usage(
                session_id, model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, cost_usd
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(session_row_id)
        .bind(model)
        .bind(usage.input_tokens as i64)
        .bind(usage.output_tokens as i64)
        .bind(usage.cache_read_tokens as i64)
        .bind(usage.cache_creation_tokens as i64)
        .bind(usage.total_cost_usd)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    for (event_index, event) in parts.tool_events.iter().enumerate() {
        sqlx::query(
            "INSERT INTO history_tool_events(
                session_id, message_id, event_index, call_id, name, category, status,
                timestamp_ms, duration_ms, input_summary, output_summary,
                input_json, output_json, raw_pointers_json, source_extension_json
             ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, NULL, NULL)",
        )
        .bind(session_row_id)
        .bind(event_index as i64)
        .bind(&event.call_id)
        .bind(&event.name)
        .bind(&event.category)
        .bind(&event.status)
        .bind(
            event
                .timestamp
                .as_deref()
                .and_then(parse_timestamp_millis_str),
        )
        .bind(event.duration_ms.map(|value| value as i64))
        .bind(&event.input_summary)
        .bind(&event.output_summary)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    let mut change_index = 0_i64;
    for change in &parts.file_changes {
        for operation in &change.operations {
            sqlx::query(
                "INSERT INTO history_file_changes(
                    session_id, change_index, message_id, source_kind, tool_name, file_path,
                    old_text, new_text, patch, additions, deletions, timestamp_ms, raw_pointers_json
                 ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
            )
            .bind(session_row_id)
            .bind(change_index)
            .bind(&operation.source)
            .bind(&operation.tool_name)
            .bind(&operation.file_path)
            .bind(&operation.old_text)
            .bind(&operation.new_text)
            .bind(&operation.patch)
            .bind(operation.additions as i64)
            .bind(operation.deletions as i64)
            .bind(
                operation
                    .timestamp
                    .as_deref()
                    .and_then(parse_timestamp_millis_str),
            )
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
            change_index += 1;
        }
    }
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(())
}

async fn clear_v2_index_failure(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
    discovery_key: &str,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM history_index_failures
         WHERE source_instance_id = ?1 AND discovery_key = ?2",
    )
    .bind(source_instance_id)
    .bind(discovery_key)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

async fn record_v2_index_failure(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
    row: &V2LegacySessionRow,
    error_code: &str,
    error_detail: &str,
) -> Result<(), String> {
    let now = now_millis();
    let session_ref_json = serde_json::to_string(&json!({
        "sourceId": row.file_ref.source.as_str(),
        "sourceSessionId": row.session_id.as_str(),
        "projectKey": row.file_ref.project_key.as_str(),
        "primaryPath": row.file_ref.path.to_string_lossy(),
    }))
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO history_index_failures(
            source_instance_id, discovery_key, session_ref_json, fingerprint_value,
            parser_version, error_code, error_detail, first_failed_at, last_failed_at,
            retry_count
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 0)
         ON CONFLICT(source_instance_id, discovery_key) DO UPDATE SET
            session_ref_json = excluded.session_ref_json,
            fingerprint_value = excluded.fingerprint_value,
            parser_version = excluded.parser_version,
            error_code = excluded.error_code,
            error_detail = excluded.error_detail,
            last_failed_at = excluded.last_failed_at,
            retry_count = history_index_failures.retry_count + 1",
    )
    .bind(source_instance_id)
    .bind(&row.session_id)
    .bind(session_ref_json)
    .bind(v2_fingerprint_value(row.fingerprint))
    .bind(HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION)
    .bind(error_code)
    .bind(error_detail)
    .bind(now)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

async fn delete_stale_v2_sessions(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
    existing_ids: &HashSet<String>,
    current_ids: &HashSet<String>,
) -> Result<usize, String> {
    let stale: Vec<&String> = existing_ids
        .iter()
        .filter(|id| !current_ids.contains(*id))
        .collect();
    for session_id in &stale {
        sqlx::query(
            "DELETE FROM history_sessions
             WHERE source_instance_id = ?1 AND source_session_id = ?2",
        )
        .bind(source_instance_id)
        .bind(*session_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    }
    Ok(stale.len())
}

async fn v2_count_sessions_messages(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
) -> Result<(i64, i64), String> {
    let sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM history_sessions WHERE source_instance_id = ?1")
            .bind(source_instance_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
    let messages: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM history_messages m
         JOIN history_sessions s ON s.id = m.session_id
         WHERE s.source_instance_id = ?1",
    )
    .bind(source_instance_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok((sessions, messages))
}

async fn legacy_count_messages(
    conn: &mut SqliteConnection,
    roots_key: &str,
    source_id: &str,
) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(message_count), 0)
         FROM history_catalog_sessions s
         WHERE s.roots_key = ?1 AND s.source = ?2",
    )
    .bind(roots_key)
    .bind(source_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| err.to_string())
}

async fn shadow_build_v2_for_instance(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    roots_key: &str,
    generation: u64,
    instance: &V2SourceInstance,
) -> Result<(), String> {
    let started_at = now_millis();
    let run_id = format!("shadow-{}-{}-{}", instance.id, generation, started_at);
    let sessions = legacy_sessions_for_v2(conn, roots_key, &instance.source_id).await?;
    let discovered_sessions = sessions.len();
    sqlx::query(
        "INSERT INTO history_sync_runs(
            id, source_instance_id, generation, trigger_kind, phase, discovery_complete,
            discovered_sessions, changed_sessions, indexed_sessions, failed_sessions,
            started_at
         ) VALUES (?1, ?2, ?3, 'shadow', 'indexing', 1, ?4, 0, 0, 0, ?5)",
    )
    .bind(&run_id)
    .bind(&instance.id)
    .bind(generation as i64)
    .bind(discovered_sessions as i64)
    .bind(started_at)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    let existing = existing_v2_session_fingerprints(conn, &instance.id).await?;
    let existing_ids: HashSet<String> = existing.keys().cloned().collect();
    let current_ids: HashSet<String> = sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    let stale_count =
        delete_stale_v2_sessions(conn, &instance.id, &existing_ids, &current_ids).await?;
    let mut changed_sessions = stale_count;
    let mut indexed_sessions = 0usize;
    let mut failed_sessions = 0usize;
    for session in &sessions {
        let fingerprint_value = v2_fingerprint_value(session.fingerprint);
        if existing
            .get(&session.session_id)
            .is_some_and(|existing| existing == &fingerprint_value)
        {
            continue;
        }
        match replace_v2_session(conn, roots, &instance.id, generation, session).await {
            Ok(()) => {
                let _ = clear_v2_index_failure(conn, &instance.id, &session.session_id).await;
                changed_sessions = changed_sessions.saturating_add(1);
                indexed_sessions = indexed_sessions.saturating_add(1);
            }
            Err(err) => {
                failed_sessions = failed_sessions.saturating_add(1);
                let _ = record_v2_index_failure(
                    conn,
                    &instance.id,
                    session,
                    "v2_shadow_session_failed",
                    &err,
                )
                .await;
                warn!(
                    "history v2 shadow session failed: instance={} source={} session={} err={}",
                    instance.id, instance.source_id, session.session_id, err
                );
            }
        }
    }

    let (v2_sessions, v2_messages) = v2_count_sessions_messages(conn, &instance.id).await?;
    let legacy_messages = legacy_count_messages(conn, roots_key, &instance.source_id).await?;
    let mut warnings = Vec::new();
    if v2_sessions != discovered_sessions as i64 {
        warnings.push(json!({
            "code": "session_count_mismatch",
            "legacy": discovered_sessions,
            "v2": v2_sessions,
        }));
    }
    if v2_messages != legacy_messages {
        warnings.push(json!({
            "code": "message_count_mismatch",
            "legacy": legacy_messages,
            "v2": v2_messages,
        }));
    }
    let warnings_json = if warnings.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&warnings).map_err(|err| err.to_string())?)
    };
    let phase = if failed_sessions > 0 {
        "completed_with_failures"
    } else if warnings_json.is_some() {
        "completed_with_warnings"
    } else {
        "ready"
    };
    let completed_at = now_millis();
    sqlx::query(
        "UPDATE history_sync_runs
         SET phase = ?1, changed_sessions = ?2, indexed_sessions = ?3,
             failed_sessions = ?4, warnings_json = ?5, completed_at = ?6
         WHERE id = ?7",
    )
    .bind(phase)
    .bind(changed_sessions as i64)
    .bind(indexed_sessions as i64)
    .bind(failed_sessions as i64)
    .bind(warnings_json.as_deref())
    .bind(completed_at)
    .bind(&run_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO history_source_state(
            source_instance_id, phase, generation, parser_version, settings_hash,
            discovered_sessions, indexed_sessions, failed_sessions,
            last_started_at, last_completed_at, last_success_at, error_code, error_detail
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(source_instance_id) DO UPDATE SET
            phase = excluded.phase,
            generation = excluded.generation,
            parser_version = excluded.parser_version,
            settings_hash = excluded.settings_hash,
            discovered_sessions = excluded.discovered_sessions,
            indexed_sessions = excluded.indexed_sessions,
            failed_sessions = excluded.failed_sessions,
            last_started_at = excluded.last_started_at,
            last_completed_at = excluded.last_completed_at,
            last_success_at = excluded.last_success_at,
            error_code = excluded.error_code,
            error_detail = excluded.error_detail",
    )
    .bind(&instance.id)
    .bind(phase)
    .bind(generation as i64)
    .bind(HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION)
    .bind(&instance.settings_hash)
    .bind(discovered_sessions as i64)
    .bind(v2_sessions)
    .bind(failed_sessions as i64)
    .bind(started_at)
    .bind(completed_at)
    .bind(if failed_sessions > 0 {
        None
    } else {
        Some(completed_at)
    })
    .bind(if failed_sessions > 0 {
        Some("v2_shadow_session_failed")
    } else {
        None
    })
    .bind(if failed_sessions > 0 {
        Some(format!("{failed_sessions} session(s) failed"))
    } else {
        None
    })
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

async fn shadow_build_v2(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    roots_key: &str,
    generation: u64,
) -> Result<(), String> {
    for instance in active_v2_source_instances(conn).await? {
        shadow_build_v2_for_instance(conn, roots, roots_key, generation, &instance).await?;
    }
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
    let files = tokio::task::spawn_blocking(move || collect_catalog_files(&roots_for_scan))
        .await
        .map_err(|err| err.to_string())?;
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
        let reusable = existing
            .get(&path)
            .is_some_and(|(_, created, updated, size, version)| {
                *created == file.fingerprint.created_at
                    && *updated == file.fingerprint.updated_at
                    && *size == file.fingerprint.size
                    && *version == CATALOG_PARSER_VERSION
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
    if let Err(err) = shadow_build_v2(&mut conn, roots, &roots_key, status.generation).await {
        warn!("history v2 shadow build failed: roots={roots_key}, err={err}");
    }
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

fn finish_running(roots_key: &str) {
    if let Ok(mut running) = running_refreshes().lock() {
        running.remove(roots_key);
    }
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
    if !force
        && !CATALOG_DIRTY.load(Ordering::Acquire)
        && status.phase == "ready"
        && status
            .last_completed_at
            .is_some_and(|completed| now_millis() - completed < CATALOG_REFRESH_TTL_MS)
    {
        return Ok(status);
    }

    let acquired = running_refreshes()
        .lock()
        .map(|mut running| running.insert(roots_key.clone()))
        .unwrap_or(false);
    if acquired {
        if wait {
            let result = refresh_catalog(&app, &roots).await;
            finish_running(&roots_key);
            if let Err(error) = &result {
                mark_refresh_error(&app, &roots, error.clone()).await;
            }
            return result;
        }
        tauri::async_runtime::spawn(async move {
            if let Err(error) = refresh_catalog(&app, &roots).await {
                warn!("history catalog refresh failed: roots={roots_key}, err={error}");
                mark_refresh_error(&app, &roots, error).await;
            }
            finish_running(&roots_key);
        });
        return Ok(status);
    }

    if wait {
        for _ in 0..1200 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let running = running_refreshes()
                .lock()
                .map(|running| running.contains(&roots_key))
                .unwrap_or(false);
            if !running {
                return get_status(&roots).await;
            }
        }
        return Err("history_index_refresh_timeout".to_string());
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_literal_escapes_quotes() {
        assert_eq!(fts_literal("foo \"bar\""), "\"foo \"\"bar\"\"\"");
    }

    #[test]
    fn project_candidates_include_claude_key_and_basename() {
        let (_cwd, keys, basename) = project_candidates(r"D:\work\pythonProject\CLI-Manager");
        assert!(keys.iter().any(|key| key.contains("cli-manager")));
        assert_eq!(basename.as_deref(), Some("cli-manager"));
    }

    #[test]
    fn catalog_scope_rejects_native_codex_entry_for_wsl_roots() {
        let roots = HistoryRoots {
            claude_config_dir: None,
            codex_config_dir: Some(PathBuf::from(
                r"\\wsl.localhost\Ubuntu-22.04\home\dministrator\.codex",
            )),
        };
        let wsl_file = r"\\wsl.localhost\Ubuntu-22.04\home\dministrator\.codex\sessions\2026\07\14\rollout.jsonl";
        let native_file = r"\\?\C:\Users\Administrator\.codex\sessions\2026\07\02\rollout.jsonl";

        assert!(catalog_path_within_roots("codex", wsl_file, &roots));
        assert!(!catalog_path_within_roots("codex", native_file, &roots));
    }

    #[test]
    fn catalog_scope_accepts_canonical_native_entry() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let codex_dir = temp_dir.path().join(".codex");
        let file = codex_dir.join("sessions").join("rollout.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"{}\n").unwrap();
        let roots = HistoryRoots {
            claude_config_dir: None,
            codex_config_dir: Some(codex_dir),
        };

        assert!(catalog_path_within_roots(
            "codex",
            &file.canonicalize().unwrap().to_string_lossy(),
            &roots,
        ));
    }

    #[tokio::test]
    async fn schema_triggers_populate_trigram_search() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        sqlx::query(
            "INSERT INTO history_catalog_messages(
                roots_key, file_path, message_index, role, timestamp, content
             ) VALUES ('roots', 'session.jsonl', 0, 'user', NULL, '历史会话 searchCatalog')",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let chinese: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM history_catalog_messages_fts
             WHERE history_catalog_messages_fts MATCH '\"历史会话\"'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let code: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM history_catalog_messages_fts
             WHERE history_catalog_messages_fts MATCH '\"Catalog\"'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();

        assert_eq!(chinese, 1);
        assert_eq!(code, 1);
    }

    #[tokio::test]
    async fn schema_creates_v2_history_index_tables() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();

        let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(user_version, HISTORY_INDEX_SCHEMA_VERSION);

        let schema_version: String =
            sqlx::query_scalar("SELECT value FROM history_meta WHERE key = 'schema_version'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(schema_version, HISTORY_INDEX_SCHEMA_VERSION.to_string());

        let session_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'history_sessions'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(session_table, 1);

        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'claude-default', 'claude', 'windows', 'windows', 'file',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_sessions(
                source_instance_id, source_session_id, storage_kind, title,
                created_at, updated_at, fingerprint_kind, fingerprint_value,
                parser_version, model_version, parse_status, last_seen_generation, indexed_at
             ) VALUES (
                'claude-default', 'session-1', 'file', 'Session',
                1, 1, 'mtime-size', 'fp', 1, 1, 'ok', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_messages(session_id, message_index, role, display_content)
             VALUES (1, 0, 'user', 'v2 历史索引 schema')",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let fts_hits: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM history_messages_fts
             WHERE history_messages_fts MATCH '\"历史索引\"'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(fts_hits, 1);
    }

    #[tokio::test]
    async fn schema_initialization_uses_user_version_fast_path() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        sqlx::query("UPDATE history_meta SET updated_at = 7 WHERE key = 'schema_version'")
            .execute(&mut conn)
            .await
            .unwrap();

        ensure_schema(&mut conn).await.unwrap();

        let updated_at: i64 =
            sqlx::query_scalar("SELECT updated_at FROM history_meta WHERE key = 'schema_version'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(updated_at, 7);
    }

    #[tokio::test]
    async fn list_sessions_merges_v2_first_and_legacy_gaps() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        let temp_dir = tempfile::TempDir::new().unwrap();
        let claude_root = temp_dir.path().join(".claude");
        let roots = HistoryRoots {
            claude_config_dir: Some(claude_root.clone()),
            codex_config_dir: None,
        };
        let roots_key = roots.cache_key();
        let v2_file = claude_root
            .join("projects")
            .join("proj")
            .join("session-v2.jsonl");
        let legacy_file = claude_root
            .join("projects")
            .join("proj")
            .join("session-legacy.jsonl");

        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'claude-default', 'claude', 'windows', 'windows', 'file',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_sessions(
                source_instance_id, source_session_id, storage_kind, primary_path,
                project_key, cwd, cwd_normalized, title, created_at, updated_at,
                message_count, fingerprint_kind, fingerprint_value, parser_version,
                model_version, parse_status, last_seen_generation, indexed_at
             ) VALUES (
                'claude-default', 'session-v2', 'file', ?1,
                'proj', 'C:/work/proj', 'c:/work/proj', 'v2 title', 10, 30,
                2, 'file-stat', 'fp', 1, 1, 'ok', 1, 1
             )",
        )
        .bind(v2_file.to_string_lossy().to_string())
        .execute(&mut conn)
        .await
        .unwrap();
        for (file, session_id, title, updated_at) in [
            (&v2_file, "session-v2", "legacy duplicate", 20_i64),
            (&legacy_file, "session-legacy", "legacy only", 25_i64),
        ] {
            sqlx::query(
                "INSERT INTO history_catalog_sessions(
                    roots_key, file_path, source, project_key, cwd, cwd_normalized,
                    session_id, title, branch, created_at, updated_at, message_count,
                    file_created_at, file_updated_at, file_size, parser_version, indexed_at
                 ) VALUES (?1, ?2, 'claude', 'proj', 'C:/work/proj', 'c:/work/proj',
                    ?3, ?4, NULL, 10, ?5, 1, 10, ?5, 1, ?6, 30)",
            )
            .bind(&roots_key)
            .bind(file.to_string_lossy().to_string())
            .bind(session_id)
            .bind(title)
            .bind(updated_at)
            .bind(CATALOG_PARSER_VERSION)
            .execute(&mut conn)
            .await
            .unwrap();
        }

        let v2 = list_sessions_from_v2(&mut conn, &roots, None, None, None, Some(10), Some(0))
            .await
            .unwrap();
        let legacy = list_sessions_from_legacy_catalog(
            &mut conn,
            &roots,
            None,
            None,
            None,
            Some(10),
            Some(0),
        )
        .await
        .unwrap();
        let sessions = merge_session_summaries(v2, legacy, Some(10), Some(0));

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].title, "v2 title");
        assert_eq!(sessions[1].title, "legacy only");
    }

    #[tokio::test]
    async fn search_sessions_merges_v2_first_and_legacy_gaps() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        let temp_dir = tempfile::TempDir::new().unwrap();
        let claude_root = temp_dir.path().join(".claude");
        let roots = HistoryRoots {
            claude_config_dir: Some(claude_root.clone()),
            codex_config_dir: None,
        };
        let roots_key = roots.cache_key();
        let v2_file = claude_root
            .join("projects")
            .join("proj")
            .join("search-v2.jsonl");
        let legacy_file = claude_root
            .join("projects")
            .join("proj")
            .join("search-legacy.jsonl");

        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'claude-default', 'claude', 'windows', 'windows', 'file',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let result = sqlx::query(
            "INSERT INTO history_sessions(
                source_instance_id, source_session_id, storage_kind, primary_path,
                project_key, title, created_at, updated_at, message_count,
                fingerprint_kind, fingerprint_value, parser_version, model_version,
                parse_status, last_seen_generation, indexed_at
             ) VALUES (
                'claude-default', 'search-v2', 'file', ?1,
                'proj', 'v2 search', 10, 30, 1,
                'file-stat', 'fp', 1, 1, 'ok', 1, 1
             )",
        )
        .bind(v2_file.to_string_lossy().to_string())
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_messages(
                session_id, message_index, role, display_content, timestamp_ms
             ) VALUES (?1, 0, 'user', 'needle from v2', 1000)",
        )
        .bind(result.last_insert_rowid())
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_catalog_sessions(
                roots_key, file_path, source, project_key, cwd, cwd_normalized,
                session_id, title, branch, created_at, updated_at, message_count,
                file_created_at, file_updated_at, file_size, parser_version, indexed_at
             ) VALUES (?1, ?2, 'claude', 'proj', NULL, NULL,
                'search-legacy', 'legacy search', NULL, 10, 20, 1,
                10, 20, 1, ?3, 30)",
        )
        .bind(&roots_key)
        .bind(legacy_file.to_string_lossy().to_string())
        .bind(CATALOG_PARSER_VERSION)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_catalog_messages(
                roots_key, file_path, message_index, role, timestamp, content
             ) VALUES (?1, ?2, 0, 'user', NULL, 'needle from legacy')",
        )
        .bind(&roots_key)
        .bind(legacy_file.to_string_lossy().to_string())
        .execute(&mut conn)
        .await
        .unwrap();

        let v2 = search_sessions_from_v2(&mut conn, &roots, "needle", None, None, 10)
            .await
            .unwrap();
        let legacy =
            search_sessions_from_legacy_catalog(&mut conn, &roots, "needle", None, None, 10)
                .await
                .unwrap();
        let hits = merge_search_results(v2, legacy, 10);

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].session_id, "search-v2");
        assert_eq!(hits[1].session_id, "search-legacy");
    }

    #[tokio::test]
    async fn stats_session_facts_reads_all_active_v2_sources() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        let temp_dir = tempfile::TempDir::new().unwrap();
        let claude_root = temp_dir.path().join(".claude");
        let roots = HistoryRoots {
            claude_config_dir: Some(claude_root.clone()),
            codex_config_dir: None,
        };
        let file = claude_root
            .join("projects")
            .join("proj")
            .join("stats-v2.jsonl");

        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'claude-default', 'claude', 'windows', 'windows', 'file',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'gemini-custom', 'gemini', 'windows', 'windows', 'file',
                '{\"configRoot\":\"D:/custom-gemini\"}', 'gemini-settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let gemini_result = sqlx::query(
            "INSERT INTO history_sessions(
                source_instance_id, source_session_id, storage_kind, primary_path,
                project_key, cwd, cwd_normalized, title, created_at, updated_at,
                message_count, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, fingerprint_kind, fingerprint_value, parser_version,
                model_version, parse_status, last_seen_generation, indexed_at
             ) VALUES (
                'gemini-custom', 'gemini-v2', 'file', 'D:/custom-gemini/session.json',
                'gemini-proj', 'D:/work/gemini', 'd:/work/gemini', 'Gemini stats', 10, 30,
                1, 7, 4, 0, 0, 'file-stat', 'gemini-fp', 1, 1, 'ok', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_usage_events(
                session_id, event_index, timestamp_ms, model, input_tokens,
                output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
             ) VALUES (?1, 0, 2000, 'gemini-2.5-pro', 7, 4, 0, 0, 0)",
        )
        .bind(gemini_result.last_insert_rowid())
        .execute(&mut conn)
        .await
        .unwrap();
        let result = sqlx::query(
            "INSERT INTO history_sessions(
                source_instance_id, source_session_id, storage_kind, primary_path,
                project_key, cwd, cwd_normalized, title, created_at, updated_at,
                message_count, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, fingerprint_kind, fingerprint_value, parser_version,
                model_version, parse_status, last_seen_generation, indexed_at
             ) VALUES (
                'claude-default', 'stats-v2', 'file', ?1,
                'proj', 'C:/work/proj', 'c:/work/proj', 'v2 stats', 10, 30,
                2, 10, 5, 3, 2, 'file-stat', 'fp', 1, 1, 'ok', 1, 1
             )",
        )
        .bind(file.to_string_lossy().to_string())
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_usage_events(
                session_id, event_index, timestamp_ms, model, input_tokens,
                output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
             ) VALUES (?1, 0, 1000, 'claude-sonnet-4-5', 10, 5, 3, 2, 0)",
        )
        .bind(result.last_insert_rowid())
        .execute(&mut conn)
        .await
        .unwrap();

        let facts = stats_session_facts_from_v2(&mut conn, &roots, None, None, &[])
            .await
            .unwrap();

        assert_eq!(facts.len(), 2);
        let claude = facts
            .iter()
            .find(|fact| fact.summary.session_id == "stats-v2")
            .unwrap();
        assert_eq!(claude.occurred_at, 1000);
        assert_eq!(claude.stats.input_tokens, 10);
        assert_eq!(claude.stats.output_tokens, 5);
        assert_eq!(claude.stats.cache_read_tokens, 3);
        assert_eq!(claude.stats.cache_creation_tokens, 2);
        let gemini = facts
            .iter()
            .find(|fact| fact.summary.session_id == "gemini-v2")
            .unwrap();
        assert_eq!(gemini.summary.source, "gemini");
        assert_eq!(gemini.stats.input_tokens, 7);
    }

    #[tokio::test]
    async fn get_session_detail_from_v2_rehydrates_messages_tools_and_changes() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        let temp_dir = tempfile::TempDir::new().unwrap();
        let claude_root = temp_dir.path().join(".claude");
        let roots = HistoryRoots {
            claude_config_dir: Some(claude_root.clone()),
            codex_config_dir: None,
        };
        let file = claude_root
            .join("projects")
            .join("proj")
            .join("detail-v2.jsonl");
        let file_path = file.to_string_lossy().to_string();

        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'claude-default', 'claude', 'windows', 'windows', 'file',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let session_result = sqlx::query(
            "INSERT INTO history_sessions(
                source_instance_id, source_session_id, storage_kind, primary_path,
                project_key, cwd, cwd_normalized, title, created_at, updated_at,
                message_count, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, total_cost_usd, dominant_model, current_model,
                tool_call_count, fingerprint_kind, fingerprint_value, parser_version,
                model_version, parse_status, last_seen_generation, indexed_at
             ) VALUES (
                'claude-default', 'detail-v2', 'file', ?1,
                'proj', 'C:/work/proj', 'c:/work/proj', 'v2 detail', 10, 30,
                1, 10, 5, 3, 2, 0, 'claude-sonnet-4-5', 'claude-sonnet-4-5',
                1, 'file-stat', 'fp', 1, 1, 'ok', 1, 1
             )",
        )
        .bind(&file_path)
        .execute(&mut conn)
        .await
        .unwrap();
        let session_id = session_result.last_insert_rowid();
        let message_result = sqlx::query(
            "INSERT INTO history_messages(
                session_id, message_index, role, display_content, timestamp_ms,
                model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, editable, raw_pointers_json
             ) VALUES (
                ?1, 0, 'assistant', 'hello detail', 1000,
                'claude-sonnet-4-5', 10, 5, 3, 2, 1,
                '[{\"lineIndex\":7}]'
             )",
        )
        .bind(session_id)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_usage_events(
                session_id, event_index, timestamp_ms, model, input_tokens,
                output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
             ) VALUES (?1, 0, 1000, 'claude-sonnet-4-5', 10, 5, 3, 2, 0)",
        )
        .bind(session_id)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_tool_events(
                session_id, message_id, event_index, call_id, name, category, status,
                timestamp_ms, duration_ms, input_summary, output_summary
             ) VALUES (?1, ?2, 0, 'tool-1', 'Edit', 'builtin', 'completed',
                1000, 12, 'in', 'out')",
        )
        .bind(session_id)
        .bind(message_result.last_insert_rowid())
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_file_changes(
                session_id, change_index, source_kind, tool_name, file_path,
                old_text, new_text, patch, additions, deletions, timestamp_ms
             ) VALUES (?1, 0, 'tool', 'Edit', 'src/main.rs',
                'old', 'new', NULL, 1, 1, 1000)",
        )
        .bind(session_id)
        .execute(&mut conn)
        .await
        .unwrap();

        let detail =
            get_session_detail_from_v2_with_conn(&mut conn, &roots, &file_path, "claude", "proj")
                .await
                .unwrap()
                .unwrap();

        assert_eq!(detail.session_id, "detail-v2");
        assert_eq!(detail.messages.len(), 1);
        assert_eq!(detail.messages[0].line_index, Some(7));
        assert_eq!(detail.usage.token_trend.len(), 1);
        assert_eq!(detail.tool_events[0].message_index, Some(0));
        assert_eq!(detail.usage.builtin_calls[0].name, "Edit");
        assert_eq!(detail.file_changes[0].file_path, "src/main.rs");
        assert_eq!(detail.file_changes[0].additions, 1);
    }

    #[tokio::test]
    async fn shadow_build_v2_populates_sessions_messages_and_sync_run() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        let temp_dir = tempfile::TempDir::new().unwrap();
        let roots = HistoryRoots {
            claude_config_dir: Some(temp_dir.path().join(".claude")),
            codex_config_dir: Some(temp_dir.path().join(".codex")),
        };
        let roots_key = roots.cache_key();
        let file = resolve_claude_history_root(&roots)
            .join("proj")
            .join("session-1.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            concat!(
                r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","requestId":"req-1","message":{"id":"msg-1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"world"},{"type":"tool_use","id":"tool-1","name":"Edit","input":{"file_path":"src/main.rs","old_string":"old","new_string":"new"}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}"#,
                "\n",
            ),
        )
        .unwrap();
        let fingerprint = session_file_fingerprint(&file);
        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'claude-default', 'claude', 'windows', 'windows', 'file',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_catalog_sessions(
                roots_key, file_path, source, project_key, cwd, cwd_normalized,
                session_id, title, branch, created_at, updated_at, message_count,
                file_created_at, file_updated_at, file_size, parser_version, indexed_at
             ) VALUES (?1, ?2, 'claude', 'proj', 'C:/work/proj', 'c:/work/proj',
                'session-1', 'hello', NULL, 10, 20, 2, ?3, ?4, ?5, ?6, 30)",
        )
        .bind(&roots_key)
        .bind(file.to_string_lossy().to_string())
        .bind(fingerprint.created_at)
        .bind(fingerprint.updated_at)
        .bind(fingerprint.size as i64)
        .bind(CATALOG_PARSER_VERSION)
        .execute(&mut conn)
        .await
        .unwrap();

        shadow_build_v2(&mut conn, &roots, &roots_key, 7)
            .await
            .unwrap();

        let session_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM history_sessions WHERE source_instance_id = 'claude-default'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(session_count, 1);
        let message_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
             FROM history_messages m
             JOIN history_sessions s ON s.id = m.session_id
             WHERE s.source_instance_id = 'claude-default'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(message_count, 2);
        let tokens: (i64, i64, i64, i64, String, String, i64) = sqlx::query_as(
            "SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    dominant_model, usage_quality, tool_call_count
             FROM history_sessions LIMIT 1",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            tokens,
            (
                10,
                20,
                3,
                2,
                "claude-sonnet-4-5".to_string(),
                "parsed".to_string(),
                1
            )
        );
        let message_model: Option<String> = sqlx::query_scalar(
            "SELECT model FROM history_messages WHERE role = 'assistant' LIMIT 1",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(message_model.as_deref(), Some("claude-sonnet-4-5"));
        let usage_events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_usage_events")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(usage_events, 1);
        let tool_events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_tool_events")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(tool_events, 1);
        let file_changes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_file_changes")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(file_changes, 1);
        let raw_pointers_json: String =
            sqlx::query_scalar("SELECT raw_pointers_json FROM history_sessions LIMIT 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert!(raw_pointers_json.contains("claude-jsonl"));
        let phase: String = sqlx::query_scalar("SELECT phase FROM history_sync_runs LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(phase, "ready");
        let state_generation: i64 =
            sqlx::query_scalar("SELECT generation FROM history_source_state LIMIT 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(state_generation, 7);

        sqlx::query("UPDATE history_sessions SET parser_version = 0")
            .execute(&mut conn)
            .await
            .unwrap();
        shadow_build_v2(&mut conn, &roots, &roots_key, 8)
            .await
            .unwrap();
        let parser_version: i64 =
            sqlx::query_scalar("SELECT parser_version FROM history_sessions LIMIT 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(parser_version, HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION);

        sqlx::query("DELETE FROM history_catalog_messages")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("DELETE FROM history_catalog_sessions")
            .execute(&mut conn)
            .await
            .unwrap();
        shadow_build_v2(&mut conn, &roots, &roots_key, 9)
            .await
            .unwrap();
        let session_count_after_delete: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM history_sessions WHERE source_instance_id = 'claude-default'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(session_count_after_delete, 0);
    }

    #[tokio::test]
    async fn shadow_build_v2_uses_codex_adapter_stats_and_raw_pointers() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        let temp_dir = tempfile::TempDir::new().unwrap();
        let roots = HistoryRoots {
            claude_config_dir: Some(temp_dir.path().join(".claude")),
            codex_config_dir: Some(temp_dir.path().join(".codex")),
        };
        let roots_key = roots.cache_key();
        let file = resolve_codex_history_root(&roots)
            .join("2026")
            .join("01")
            .join("rollout-2026-01-01T00-00-00-codex-session.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            concat!(
                r#"{"type":"session_meta","payload":{"id":"codex-session","cwd":"F:\\work\\proj"}}"#,
                "\n",
                r#"{"type":"turn_context","payload":{"model":"gpt-5.4"}}"#,
                "\n",
                r#"{"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello codex"}]}}"#,
                "\n",
                r#"{"type":"response_item","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}"#,
                "\n",
                r#"{"type":"event_msg","timestamp":"2026-01-01T00:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":20,"total_tokens":120},"last_token_usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":20,"total_tokens":120}}}}"#,
                "\n",
            ),
        )
        .unwrap();
        let fingerprint = session_file_fingerprint(&file);
        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'codex-default', 'codex', 'windows', 'windows', 'mixed',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_catalog_sessions(
                roots_key, file_path, source, project_key, cwd, cwd_normalized,
                session_id, title, branch, created_at, updated_at, message_count,
                file_created_at, file_updated_at, file_size, parser_version, indexed_at
             ) VALUES (?1, ?2, 'codex', 'proj', 'F:\\work\\proj', 'f:/work/proj',
                'codex-session', 'hello codex', NULL, 10, 20, 2, ?3, ?4, ?5, ?6, 30)",
        )
        .bind(&roots_key)
        .bind(file.to_string_lossy().to_string())
        .bind(fingerprint.created_at)
        .bind(fingerprint.updated_at)
        .bind(fingerprint.size as i64)
        .bind(CATALOG_PARSER_VERSION)
        .execute(&mut conn)
        .await
        .unwrap();

        shadow_build_v2(&mut conn, &roots, &roots_key, 7)
            .await
            .unwrap();

        let session: (String, Option<String>, Option<String>, i64, i64, i64) = sqlx::query_as(
            "SELECT storage_kind, raw_key, database_path, input_tokens, cache_read_tokens, output_tokens
             FROM history_sessions
             WHERE source_instance_id = 'codex-default'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(session.0, "mixed");
        assert_eq!(session.1.as_deref(), Some("codex-session"));
        assert_eq!(
            session.2.as_deref(),
            Some(
                resolve_codex_state_db_path(&roots)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!((session.3, session.4, session.5), (70, 30, 20));
        let assistant_usage: (Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT input_tokens, cache_read_tokens, output_tokens
             FROM history_messages WHERE role = 'assistant' LIMIT 1",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(assistant_usage, (Some(70), Some(30), Some(20)));
        let raw_pointers_json: String =
            sqlx::query_scalar("SELECT raw_pointers_json FROM history_sessions LIMIT 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert!(raw_pointers_json.contains("codex-state-thread-row"));
    }

    #[tokio::test]
    async fn shadow_build_v2_includes_active_non_core_sources() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        let temp_dir = tempfile::TempDir::new().unwrap();
        let roots = HistoryRoots {
            claude_config_dir: Some(temp_dir.path().join(".claude")),
            codex_config_dir: Some(temp_dir.path().join(".codex")),
        };
        let roots_key = roots.cache_key();
        let file = temp_dir.path().join("gemini-session.json");
        std::fs::write(
            &file,
            r#"{
                "sessionId": "gemini-session",
                "projectHash": "hash-a",
                "messages": [
                    { "role": "user", "content": "hello gemini", "timestamp": "2026-01-01T00:00:00Z" },
                    { "role": "model", "content": "hi", "timestamp": "2026-01-01T00:00:01Z" }
                ]
            }"#,
        )
        .unwrap();
        let fingerprint = session_file_fingerprint(&file);
        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'gemini-default', 'gemini', 'windows', 'windows', 'file',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_catalog_sessions(
                roots_key, file_path, source, project_key, cwd, cwd_normalized,
                session_id, title, branch, created_at, updated_at, message_count,
                file_created_at, file_updated_at, file_size, parser_version, indexed_at
             ) VALUES (?1, ?2, 'gemini', 'hash-a', NULL, NULL,
                'gemini-session', 'hello gemini', NULL, 10, 20, 2,
                ?3, ?4, ?5, ?6, 30)",
        )
        .bind(&roots_key)
        .bind(file.to_string_lossy().to_string())
        .bind(fingerprint.created_at)
        .bind(fingerprint.updated_at)
        .bind(fingerprint.size as i64)
        .bind(CATALOG_PARSER_VERSION)
        .execute(&mut conn)
        .await
        .unwrap();

        shadow_build_v2(&mut conn, &roots, &roots_key, 7)
            .await
            .unwrap();

        let source: String = sqlx::query_scalar(
            "SELECT i.source_id
             FROM history_sessions s
             JOIN history_source_instances i ON i.id = s.source_instance_id
             WHERE s.source_session_id = 'gemini-session'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(source, "gemini");
    }

    #[tokio::test]
    async fn record_v2_index_failure_upserts_retry_count() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut conn).await.unwrap();
        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state, created_at, updated_at
             ) VALUES (
                'claude-default', 'claude', 'windows', 'windows', 'file',
                '{}', 'settings', 'active', 1, 1
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let row = V2LegacySessionRow {
            file_ref: SessionFileRef {
                source: "claude".to_string(),
                project_key: "proj".to_string(),
                path: PathBuf::from("session-1.jsonl"),
            },
            fingerprint: SessionFileFingerprint {
                created_at: 1,
                updated_at: 2,
                size: 3,
            },
            session_id: "session-1".to_string(),
        };

        record_v2_index_failure(
            &mut conn,
            "claude-default",
            &row,
            "parse_failed",
            "bad json",
        )
        .await
        .unwrap();
        record_v2_index_failure(
            &mut conn,
            "claude-default",
            &row,
            "parse_failed",
            "bad json again",
        )
        .await
        .unwrap();

        let retry_count: i64 =
            sqlx::query_scalar("SELECT retry_count FROM history_index_failures LIMIT 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(retry_count, 1);
    }

    #[test]
    fn validate_source_instance_rejects_invalid_storage_and_locations() {
        let mut input = HistoryIndexV2SourceInstanceInput {
            source_id: "claude".to_string(),
            instance_id: "claude-12345678".to_string(),
            environment_kind: "windows".to_string(),
            environment_key: "windows".to_string(),
            storage_kind: "file".to_string(),
            display_name: None,
            locations_json: r#"{"configRoot":"C:\\Users\\me\\.claude"}"#.to_string(),
            settings_hash: "hash".to_string(),
            discovered: false,
        };
        assert!(validate_source_instance_input(&input).is_ok());

        input.storage_kind = "unknown".to_string();
        assert_eq!(
            validate_source_instance_input(&input).unwrap_err(),
            "history_source_storage_kind_invalid"
        );

        input.storage_kind = "file".to_string();
        input.locations_json = "{broken".to_string();
        assert_eq!(
            validate_source_instance_input(&input).unwrap_err(),
            "history_source_locations_json_invalid"
        );
    }
}
