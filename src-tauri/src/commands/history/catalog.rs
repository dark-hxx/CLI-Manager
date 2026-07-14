use super::*;
use log::{info, warn};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Connection, QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CATALOG_DB_FILE: &str = "history-catalog.db";
const CATALOG_PARSER_VERSION: i64 = 1;
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
    info!("history catalog seeded from legacy cache: roots={roots_key}");
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
        .fetch_all(&mut conn)
        .await
        .map_err(|err| err.to_string())?;
    let sessions = rows
        .into_iter()
        .map(|row| {
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
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(sessions
        .into_iter()
        .filter(|session| catalog_path_within_roots(&session.source, &session.file_path, roots))
        .collect())
}

fn fts_literal(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
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
    let roots_key = roots.cache_key();
    let max_hits = limit.unwrap_or(100).max(1).min(i64::MAX as usize);
    let source_filter = source
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let project_filter = project_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

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
    if let Some(source) = &source_filter {
        session_builder.push(" AND s.source = ");
        session_builder.push_bind(source);
    }
    if let Some(project_path) = &project_filter {
        push_project_filter(&mut session_builder, project_path);
    }
    session_builder.push(" ORDER BY s.updated_at DESC LIMIT ");
    session_builder.push_bind(max_hits as i64);
    let mut hits: Vec<HistorySearchResult> = session_builder
        .build()
        .fetch_all(&mut conn)
        .await
        .map_err(|err| err.to_string())?
        .into_iter()
        .map(|row| {
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
        })
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
    if let Some(source) = &source_filter {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = &project_filter {
        push_project_filter(&mut builder, project_path);
    }
    builder.push(" ORDER BY s.updated_at DESC, m.message_index ASC LIMIT ");
    builder.push_bind((max_hits - hits.len()) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut conn)
        .await
        .map_err(|err| err.to_string())?;
    let message_hits = rows
        .into_iter()
        .map(|row| {
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
        })
        .collect::<Result<Vec<_>, String>>()?;
    hits.extend(
        message_hits
            .into_iter()
            .filter(|hit| catalog_path_within_roots(&hit.source, &hit.file_path, roots)),
    );
    Ok(hits)
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
    if file_ref.source == "codex" {
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
    let files = tokio::task::spawn_blocking(move || collect_catalog_files(&roots_for_scan))
        .await
        .map_err(|err| err.to_string())?;
    let total_files = files.len();
    let rows = sqlx::query(
        "SELECT file_path, file_created_at, file_updated_at, file_size, parser_version
         FROM history_catalog_sessions WHERE roots_key = ?1",
    )
    .bind(&roots_key)
    .fetch_all(&mut conn)
    .await
    .map_err(|err| err.to_string())?;
    let mut existing: HashMap<String, (i64, i64, u64, i64)> = HashMap::new();
    for row in rows {
        existing.insert(
            row.try_get("file_path").map_err(|err| err.to_string())?,
            (
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
        .collect();
    for stale in existing
        .keys()
        .filter(|path| !current_paths.contains(*path))
        .cloned()
        .collect::<Vec<_>>()
    {
        delete_document(&mut conn, &roots_key, &stale).await?;
    }

    let mut pending = Vec::new();
    for file in files {
        let path = file.file_ref.path.to_string_lossy().to_string();
        let reusable = existing
            .get(&path)
            .is_some_and(|(created, updated, size, version)| {
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

    status.phase = "indexing".to_string();
    status.total_files = total_files;
    status.indexed_files = total_files.saturating_sub(pending.len());
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

    status.phase = "ready".to_string();
    status.partial = false;
    status.indexed_files = total_files;
    status.total_files = total_files;
    status.generation = status.generation.saturating_add(1);
    status.last_completed_at = Some(now_millis());
    status.error = None;
    persist_status(&mut conn, &status).await?;
    emit_status(app, &status);
    CATALOG_DIRTY.store(false, Ordering::Release);
    info!("history catalog refresh completed: roots={roots_key}, files={total_files}");
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
}
