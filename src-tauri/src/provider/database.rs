use crate::app_paths;
use sha2::{Digest, Sha384};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode};
use sqlx::{Connection, Row};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const PROVIDER_SCHEMA_VERSION: i64 = 2;
const PROVIDER_BASE_SCHEMA_VERSION: i64 = 1;
const PROVIDER_DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const PROVIDER_SCHEMA_DESCRIPTION: &str = "create_ccs_provider_domain";
const PROVIDER_ROUTING_SCHEMA_DESCRIPTION: &str = "add_routing_settings_and_request_logs";
const FLUXION_REGISTER_URL: &str =
    "https://fluxionai.space/register?source=github&campaign=climanager";
const FLUXION_CLAUDE_BASE_URL: &str = "https://www.fluxionai.space";
const FLUXION_OPENAI_BASE_URL: &str = "https://www.fluxionai.space/v1";
/// `(app_type, provider_id)` of every built-in provider the initializer seeds.
const BUILTIN_FLUXION_IDENTITIES: [(&str, &str); 3] = [
    ("claude", "builtin-fluxion-claude"),
    ("codex", "builtin-fluxion-codex"),
    ("grokbuild", "builtin-fluxion-grokbuild"),
];
/// Built-in providers the user deleted. Persisted so the seed stops recreating
/// them; see `ensure_builtin_fluxion_providers`.
const BUILTIN_DISMISSAL_SETTING_KEY: &str = "builtin_provider_dismissals.v1";
const BUILTIN_DISMISSAL_SCHEMA_VERSION: i64 = 1;

/// The provider domain is intentionally independent from the historical
/// provider tables in `cli-manager.db`. Keep this schema CCS-shaped for the
/// provider core, then add only the CLI-Manager-owned boundaries needed for
/// manual keys, Home selection, import, repair, and live-apply recovery.
pub(crate) const PROVIDER_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS provider_schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
    id                TEXT NOT NULL,
    app_type          TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    name              TEXT NOT NULL,
    settings_config   TEXT NOT NULL,
    website_url       TEXT,
    category          TEXT,
    created_at        INTEGER NOT NULL,
    sort_index        INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    icon              TEXT,
    icon_color        TEXT,
    meta              TEXT NOT NULL DEFAULT '{}',
    is_current        INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    in_failover_queue INTEGER NOT NULL DEFAULT 0 CHECK (in_failover_queue IN (0, 1)),
    PRIMARY KEY (id, app_type)
);

CREATE INDEX IF NOT EXISTS idx_providers_app_type_sort
    ON providers(app_type, sort_index, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_one_current
    ON providers(app_type)
    WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_api_keys (
    id          TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    app_type    TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    label       TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    notes       TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    sort_index  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (provider_id, app_type)
        REFERENCES providers(id, app_type) ON DELETE CASCADE,
    UNIQUE (provider_id, app_type, label)
);

CREATE INDEX IF NOT EXISTS idx_provider_api_keys_pool
    ON provider_api_keys(provider_id, app_type, sort_index, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_api_keys_one_active
    ON provider_api_keys(provider_id, app_type)
    WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS provider_home_preferences (
    environment_kind TEXT NOT NULL CHECK (environment_kind IN ('local', 'wsl')),
    environment_id   TEXT NOT NULL,
    mode             TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
    home_path        TEXT,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (environment_kind, environment_id)
);

CREATE TABLE IF NOT EXISTS provider_apply_journal (
    id                         TEXT PRIMARY KEY,
    app_type                  TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    provider_id               TEXT NOT NULL,
    home_identity             TEXT NOT NULL,
    operation                 TEXT NOT NULL,
    state                     TEXT NOT NULL,
    target_paths_json         TEXT NOT NULL DEFAULT '[]',
    backup_paths_json         TEXT NOT NULL DEFAULT '[]',
    expected_fingerprints_json TEXT NOT NULL DEFAULT '{}',
    desired_fingerprints_json  TEXT NOT NULL DEFAULT '{}',
    started_at                INTEGER NOT NULL,
    finished_at               INTEGER,
    error_code                TEXT
);

CREATE INDEX IF NOT EXISTS idx_provider_apply_journal_recovery
    ON provider_apply_journal(state, app_type, home_identity);

CREATE TABLE IF NOT EXISTS provider_import_refs (
    source_kind        TEXT NOT NULL,
    source_identity    TEXT NOT NULL,
    source_app_type    TEXT NOT NULL CHECK (source_app_type IN ('claude', 'codex', 'grokbuild')),
    source_provider_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    provider_id        TEXT NOT NULL,
    app_type           TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    imported_at        INTEGER NOT NULL,
    PRIMARY KEY (source_kind, source_identity, source_app_type, source_provider_id),
    FOREIGN KEY (provider_id, app_type)
        REFERENCES providers(id, app_type) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_import_refs_native
    ON provider_import_refs(provider_id, app_type);

CREATE TABLE IF NOT EXISTS provider_migration_issues (
    id            TEXT PRIMARY KEY,
    scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('project', 'worktree')),
    scope_id      TEXT NOT NULL,
    app_type      TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    legacy_payload TEXT NOT NULL,
    reason        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_provider_migration_issues_open
    ON provider_migration_issues(scope_kind, scope_id, app_type)
    WHERE resolved_at IS NULL;
"#;

pub(crate) const PROVIDER_ROUTING_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS routing_request_logs (
    request_id             TEXT PRIMARY KEY,
    app_type               TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    provider_id            TEXT NOT NULL,
    provider_name          TEXT NOT NULL,
    requested_model        TEXT,
    upstream_model         TEXT,
    started_at_ms          INTEGER NOT NULL,
    duration_ms            INTEGER NOT NULL CHECK (duration_ms >= 0),
    status_code            INTEGER,
    outcome                TEXT NOT NULL,
    degraded               INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
    attempt_count          INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
    input_tokens           INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_creation_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
    rectifier_flags        TEXT NOT NULL DEFAULT '[]',
    error_code             TEXT,
    created_at_ms          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_request_logs_created_at
    ON routing_request_logs(created_at_ms);

CREATE INDEX IF NOT EXISTS idx_routing_request_logs_app_started
    ON routing_request_logs(app_type, started_at_ms);
"#;

const COMMON_CONFIG_SETTINGS: &[(&str, &str)] = &[
    ("common_config_claude", "{}"),
    ("common_config_codex", ""),
    ("common_config_grokbuild", ""),
];

const ROUTING_SETTINGS: &[(&str, &str)] = &[
    (
        "routing.service.v1",
        r#"{"schemaVersion":1,"serviceEnabled":false,"listenAddress":"127.0.0.1","preferredPort":15721,"actualPort":null,"showLocalQuickControl":false,"showFailoverQuickControl":false,"usageLoggingEnabled":true}"#,
    ),
    ("routing.takeovers.v1", r#"{"schemaVersion":1,"items":[]}"#),
    (
        "routing.app.claude.v1",
        r#"{"schemaVersion":1,"autoFailoverEnabled":false,"maxRetries":6,"streamingFirstByteTimeout":90,"streamingIdleTimeout":180,"nonStreamingTimeout":600,"circuitFailureThreshold":8,"circuitSuccessThreshold":3,"circuitTimeoutSeconds":90,"circuitErrorRateThreshold":0.7,"circuitMinRequests":15}"#,
    ),
    (
        "routing.app.codex.v1",
        r#"{"schemaVersion":1,"autoFailoverEnabled":false,"maxRetries":3,"streamingFirstByteTimeout":60,"streamingIdleTimeout":120,"nonStreamingTimeout":600,"circuitFailureThreshold":4,"circuitSuccessThreshold":2,"circuitTimeoutSeconds":60,"circuitErrorRateThreshold":0.6,"circuitMinRequests":10}"#,
    ),
    (
        "routing.app.grokbuild.v1",
        r#"{"schemaVersion":1,"autoFailoverEnabled":false,"maxRetries":3,"streamingFirstByteTimeout":60,"streamingIdleTimeout":120,"nonStreamingTimeout":600,"circuitFailureThreshold":4,"circuitSuccessThreshold":2,"circuitTimeoutSeconds":60,"circuitErrorRateThreshold":0.6,"circuitMinRequests":10}"#,
    ),
    (
        "routing.rectifier.v1",
        r#"{"schemaVersion":1,"enabled":true,"requestThinkingSignature":true,"requestThinkingBudget":true,"requestMediaFallback":true,"requestMediaHeuristic":true}"#,
    ),
    (
        "routing.optimizer.v1",
        r#"{"schemaVersion":1,"enabled":false,"thinkingOptimizer":true,"cacheInjection":true}"#,
    ),
    (
        "routing.global_proxy.v1",
        r#"{"schemaVersion":1,"url":null,"username":null,"passwordCredentialAccount":"routing-global-proxy-password"}"#,
    ),
];

pub(crate) async fn initialize() -> Result<(), String> {
    let path = app_paths::providers_db_path()?;
    initialize_at(path).await
}

pub(crate) async fn open_connection() -> Result<SqliteConnection, String> {
    let path = app_paths::providers_db_path()?;
    open_connection_at(path).await
}

pub(crate) async fn open_connection_at(path: PathBuf) -> Result<SqliteConnection, String> {
    initialize_at(path.clone()).await?;
    let mut connection = SqliteConnection::connect_with(&connection_options(&path))
        .await
        .map_err(|err| format!("provider_db_open_failed: {err}"))?;
    configure_connection(&mut connection).await?;
    Ok(connection)
}

async fn initialize_at(path: PathBuf) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "provider_db_parent_unavailable".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("provider_db_directory_failed: {err}"))?;

    let existing_database = path.is_file()
        && fs::metadata(&path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
    let options = connection_options(&path);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("provider_db_open_failed: {err}"))?;

    configure_connection(&mut connection).await?;
    let current_version = read_user_version(&mut connection).await?;
    if current_version > PROVIDER_SCHEMA_VERSION {
        return Err(format!(
            "provider_db_version_unsupported: {current_version}"
        ));
    }

    if current_version < PROVIDER_SCHEMA_VERSION && existing_database {
        checkpoint_before_backup(&mut connection).await?;
        backup_existing_database(&path)?;
    }

    if current_version < PROVIDER_BASE_SCHEMA_VERSION {
        apply_schema_migration(
            &mut connection,
            PROVIDER_BASE_SCHEMA_VERSION,
            PROVIDER_SCHEMA_DESCRIPTION,
            PROVIDER_SCHEMA_SQL,
            COMMON_CONFIG_SETTINGS,
            "provider_db_common_config_seed_failed",
        )
        .await?;
    } else {
        sqlx::raw_sql(PROVIDER_SCHEMA_SQL)
            .execute(&mut connection)
            .await
            .map_err(|err| format!("provider_db_schema_failed: {err}"))?;
        ensure_common_config_settings(&mut connection).await?;
    }

    if current_version < PROVIDER_SCHEMA_VERSION {
        apply_schema_migration(
            &mut connection,
            PROVIDER_SCHEMA_VERSION,
            PROVIDER_ROUTING_SCHEMA_DESCRIPTION,
            PROVIDER_ROUTING_SCHEMA_SQL,
            ROUTING_SETTINGS,
            "provider_db_routing_seed_failed",
        )
        .await?;
    } else {
        sqlx::raw_sql(PROVIDER_ROUTING_SCHEMA_SQL)
            .execute(&mut connection)
            .await
            .map_err(|err| format!("provider_db_routing_schema_failed: {err}"))?;
        ensure_routing_settings(&mut connection).await?;
    }

    ensure_builtin_fluxion_providers(&mut connection).await?;

    verify_required_tables(&mut connection).await
}

/// Add the built-in Fluxion entry for each supported native provider type.
///
/// The IDs are stable and the insert is intentionally `OR IGNORE`: users may
/// rename, reorder, disable, select, or add keys to the provider later, and a
/// subsequent startup must not overwrite any of those choices.
///
/// A deleted built-in must stay deleted too. `initialize_at` runs on every
/// `open_connection`, so without the dismissal list the very next provider
/// query would reseed the row with the default name, URL, order and meta —
/// which is exactly how deleting the built-in provider looked like a no-op
/// that also reset every customization (issue #242).
async fn ensure_builtin_fluxion_providers(connection: &mut SqliteConnection) -> Result<(), String> {
    let dismissed = load_builtin_dismissals(connection).await?;
    let pending: Vec<(&str, &str)> = BUILTIN_FLUXION_IDENTITIES
        .into_iter()
        .filter(|(app_type, id)| !dismissed.contains(&builtin_dismissal_token(app_type, id)))
        .collect();
    if pending.is_empty() {
        return Ok(());
    }

    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| format!("provider_db_builtin_seed_begin_failed: {err}"))?;
    for (app_type, id) in pending {
        let sort_index: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MIN(sort_index), 0) - 1 FROM providers WHERE app_type = ?1",
        )
        .bind(app_type)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|err| format!("provider_db_builtin_seed_failed: {err}"))?;
        let meta = serde_json::json!({
            "enabled": true,
            "commonConfigEnabled": true,
            "builtin": "fluxion"
        })
        .to_string();
        sqlx::query(
            "INSERT OR IGNORE INTO providers
             (id, app_type, name, settings_config, website_url, category, created_at,
              sort_index, notes, icon, icon_color, meta, is_current)
             VALUES (?1, ?2, 'Fluxion AI', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)",
        )
        .bind(id)
        .bind(app_type)
        .bind(builtin_fluxion_settings_config(app_type))
        .bind(FLUXION_REGISTER_URL)
        .bind("AI模型统一接入与管理平台")
        .bind(unix_timestamp_millis())
        .bind(sort_index)
        .bind("")
        .bind("sparkles")
        .bind("#6366f1")
        .bind(meta)
        .execute(&mut *transaction)
        .await
        .map_err(|err| format!("provider_db_builtin_seed_failed: {err}"))?;
    }

    transaction
        .commit()
        .await
        .map_err(|err| format!("provider_db_builtin_seed_commit_failed: {err}"))
}

/// Seed `settings_config` for one built-in provider type.
fn builtin_fluxion_settings_config(app_type: &str) -> String {
    match app_type {
        "claude" => serde_json::json!({
            "env": {"ANTHROPIC_BASE_URL": FLUXION_CLAUDE_BASE_URL},
            "api_format": "anthropic"
        })
        .to_string(),
        "codex" => serde_json::json!({
            "base_url": FLUXION_OPENAI_BASE_URL,
            "config": format!(
                r#"model_provider = "custom"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "{FLUXION_OPENAI_BASE_URL}"
"#
            )
        })
        .to_string(),
        // Grok Build ships an empty document; the user fills it in.
        _ => "{}".to_string(),
    }
}

/// True when the identity belongs to a provider the initializer seeds.
pub(crate) fn is_builtin_provider(app_type: &str, provider_id: &str) -> bool {
    BUILTIN_FLUXION_IDENTITIES
        .iter()
        .any(|(seed_app_type, seed_id)| *seed_app_type == app_type && *seed_id == provider_id)
}

/// Record that the user deleted a built-in provider. Callers must run this in
/// the same transaction as the `DELETE`, so a failed dismissal rolls the
/// deletion back instead of leaving a row the seed will resurrect.
pub(crate) async fn dismiss_builtin_provider(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    app_type: &str,
    provider_id: &str,
) -> Result<(), String> {
    let mut items: Vec<String> = load_builtin_dismissals(&mut **transaction)
        .await?
        .into_iter()
        .collect();
    let token = builtin_dismissal_token(app_type, provider_id);
    if !items.contains(&token) {
        items.push(token);
    }
    items.sort();
    let value = serde_json::json!({
        "schemaVersion": BUILTIN_DISMISSAL_SCHEMA_VERSION,
        "items": items
    })
    .to_string();
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")
        .bind(BUILTIN_DISMISSAL_SETTING_KEY)
        .bind(value)
        .execute(&mut **transaction)
        .await
        .map(|_| ())
        .map_err(|err| format!("provider_db_builtin_dismissal_write_failed: {err}"))
}

fn builtin_dismissal_token(app_type: &str, provider_id: &str) -> String {
    format!("{app_type}:{provider_id}")
}

async fn load_builtin_dismissals(
    connection: &mut SqliteConnection,
) -> Result<HashSet<String>, String> {
    let raw = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(BUILTIN_DISMISSAL_SETTING_KEY)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_builtin_dismissal_read_failed: {err}"))?;
    Ok(parse_builtin_dismissals(raw.as_deref()))
}

/// An unreadable dismissal row is treated as "nothing dismissed": one corrupt
/// setting must not permanently block the built-in provider seed.
fn parse_builtin_dismissals(raw: Option<&str>) -> HashSet<String> {
    raw.and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| {
            value
                .get("items")
                .and_then(|items| items.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str())
                        .map(str::to_string)
                        .collect()
                })
        })
        .unwrap_or_default()
}

fn connection_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path.to_path_buf())
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(PROVIDER_DB_BUSY_TIMEOUT)
        .foreign_keys(true)
}

async fn configure_connection(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_foreign_keys_failed: {err}"))?;
    sqlx::query("PRAGMA synchronous = NORMAL")
        .execute(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_synchronous_failed: {err}"))?;
    Ok(())
}

async fn checkpoint_before_backup(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|err| format!("provider_db_checkpoint_failed: {err}"))
}

async fn read_user_version(connection: &mut SqliteConnection) -> Result<i64, String> {
    sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_version_read_failed: {err}"))
}

async fn set_user_version(connection: &mut SqliteConnection, version: i64) -> Result<(), String> {
    sqlx::query(&format!("PRAGMA user_version = {version}"))
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|err| format!("provider_db_version_write_failed: {err}"))
}

async fn apply_schema_migration(
    connection: &mut SqliteConnection,
    version: i64,
    description: &str,
    schema_sql: &str,
    settings: &[(&str, &str)],
    seed_error_code: &str,
) -> Result<(), String> {
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| format!("provider_db_migration_begin_failed: {err}"))?;
    sqlx::raw_sql(schema_sql)
        .execute(&mut *transaction)
        .await
        .map_err(|err| format!("provider_db_schema_failed: {err}"))?;
    ensure_settings(&mut *transaction, settings, seed_error_code).await?;
    if version == PROVIDER_SCHEMA_VERSION {
        verify_routing_schema(&mut *transaction).await?;
    }
    record_schema_migration(&mut *transaction, version, description, schema_sql).await?;
    set_user_version(&mut *transaction, version).await?;
    transaction
        .commit()
        .await
        .map_err(|err| format!("provider_db_migration_commit_failed: {err}"))
}

async fn record_schema_migration(
    connection: &mut SqliteConnection,
    version: i64,
    description: &str,
    schema_sql: &str,
) -> Result<(), String> {
    let checksum = format!("{:x}", Sha384::digest(schema_sql.as_bytes()));
    sqlx::query(
        "INSERT OR REPLACE INTO provider_schema_migrations
         (version, description, checksum, applied_at)
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(version)
    .bind(description)
    .bind(checksum)
    .bind(unix_timestamp_millis())
    .execute(&mut *connection)
    .await
    .map(|_| ())
    .map_err(|err| format!("provider_db_migration_record_failed: {err}"))
}

async fn ensure_common_config_settings(connection: &mut SqliteConnection) -> Result<(), String> {
    ensure_settings(
        connection,
        COMMON_CONFIG_SETTINGS,
        "provider_db_common_config_seed_failed",
    )
    .await
}

async fn ensure_routing_settings(connection: &mut SqliteConnection) -> Result<(), String> {
    ensure_settings(
        connection,
        ROUTING_SETTINGS,
        "provider_db_routing_seed_failed",
    )
    .await
}

async fn ensure_settings(
    connection: &mut SqliteConnection,
    settings: &[(&str, &str)],
    error_code: &str,
) -> Result<(), String> {
    for (key, value) in settings {
        sqlx::query("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)")
            .bind(key)
            .bind(value)
            .execute(&mut *connection)
            .await
            .map_err(|err| format!("{error_code}: {err}"))?;
    }
    Ok(())
}

async fn verify_required_tables(connection: &mut SqliteConnection) -> Result<(), String> {
    for table in [
        "providers",
        "settings",
        "provider_api_keys",
        "provider_home_preferences",
        "provider_apply_journal",
        "provider_import_refs",
        "provider_migration_issues",
        "routing_request_logs",
    ] {
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        )
        .bind(table)
        .fetch_one(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_schema_check_failed: {err}"))?;
        if exists != 1 {
            return Err(format!("provider_db_table_missing: {table}"));
        }
    }
    verify_routing_schema(connection).await?;
    Ok(())
}

async fn verify_routing_schema(connection: &mut SqliteConnection) -> Result<(), String> {
    let columns = sqlx::query("PRAGMA table_info(routing_request_logs)")
        .fetch_all(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_schema_check_failed: {err}"))?;
    for column in [
        "request_id",
        "app_type",
        "provider_id",
        "provider_name",
        "requested_model",
        "upstream_model",
        "started_at_ms",
        "duration_ms",
        "status_code",
        "outcome",
        "degraded",
        "attempt_count",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
        "rectifier_flags",
        "error_code",
        "created_at_ms",
    ] {
        let present = columns
            .iter()
            .any(|row| row.get::<String, _>("name") == column);
        if !present {
            return Err(format!(
                "provider_db_column_missing: routing_request_logs.{column}"
            ));
        }
    }

    for (index, expected_columns) in [
        (
            "idx_routing_request_logs_created_at",
            ["created_at_ms"].as_slice(),
        ),
        (
            "idx_routing_request_logs_app_started",
            ["app_type", "started_at_ms"].as_slice(),
        ),
    ] {
        let table: Option<String> = sqlx::query_scalar(
            "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?1",
        )
        .bind(index)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_schema_check_failed: {err}"))?;
        if table.as_deref() != Some("routing_request_logs") {
            return Err(format!("provider_db_index_missing: {index}"));
        }
        let pragma = format!("PRAGMA index_info('{index}')");
        let index_columns = sqlx::query(&pragma)
            .fetch_all(&mut *connection)
            .await
            .map_err(|err| format!("provider_db_schema_check_failed: {err}"))?;
        let actual_columns: Vec<String> = index_columns
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect();
        if actual_columns
            != expected_columns
                .iter()
                .map(|column| (*column).to_string())
                .collect::<Vec<_>>()
        {
            return Err(format!("provider_db_index_invalid: {index}"));
        }
    }
    Ok(())
}

fn backup_existing_database(path: &Path) -> Result<PathBuf, String> {
    let data_dir = path
        .parent()
        .ok_or_else(|| "provider_db_backup_parent_unavailable".to_string())?;
    let backup_dir = data_dir.join("backups").join("providers");
    fs::create_dir_all(&backup_dir)
        .map_err(|err| format!("provider_db_backup_directory_failed: {err}"))?;

    let backup_name = format!(
        "providers.db.backup-{}-{}.db",
        unix_timestamp_millis(),
        std::process::id()
    );
    let backup_path = backup_dir.join(backup_name);
    fs::copy(path, &backup_path).map_err(|err| format!("provider_db_backup_failed: {err}"))?;
    Ok(backup_path)
}

fn unix_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;
    use tempfile::tempdir;

    async fn open_test_connection(path: &Path) -> SqliteConnection {
        SqliteConnection::connect_with(&connection_options(path))
            .await
            .unwrap()
    }

    async fn create_v1_database(path: &Path) -> SqliteConnection {
        let mut connection = open_test_connection(path).await;
        configure_connection(&mut connection).await.unwrap();
        sqlx::raw_sql(PROVIDER_SCHEMA_SQL)
            .execute(&mut connection)
            .await
            .unwrap();
        ensure_common_config_settings(&mut connection)
            .await
            .unwrap();
        record_schema_migration(
            &mut connection,
            PROVIDER_BASE_SCHEMA_VERSION,
            PROVIDER_SCHEMA_DESCRIPTION,
            PROVIDER_SCHEMA_SQL,
        )
        .await
        .unwrap();
        set_user_version(&mut connection, PROVIDER_BASE_SCHEMA_VERSION)
            .await
            .unwrap();
        connection
    }

    async fn insert_provider(
        connection: &mut SqliteConnection,
        id: &str,
        app_type: &str,
        is_current: i64,
    ) {
        sqlx::query(
            "INSERT INTO providers
             (id, app_type, name, settings_config, created_at, is_current)
             VALUES (?1, ?2, ?3, '{}', 1, ?4)",
        )
        .bind(id)
        .bind(app_type)
        .bind(format!("{app_type} provider"))
        .bind(is_current)
        .execute(&mut *connection)
        .await
        .unwrap();
    }

    #[test]
    fn schema_and_routing_defaults_match_the_contract() {
        assert_eq!(
            format!("{:x}", Sha384::digest(PROVIDER_SCHEMA_SQL.as_bytes())),
            "7498ab64cd42b302f283a6d6bb916337e50801a69ded965d147e9597dcc30e1bf51b8bd1778af79214aa66816149daa8"
        );
        let setting = |key: &str| {
            let (_, value) = ROUTING_SETTINGS
                .iter()
                .find(|(setting_key, _)| *setting_key == key)
                .unwrap();
            serde_json::from_str::<serde_json::Value>(value).unwrap()
        };
        assert_eq!(
            setting("routing.service.v1"),
            serde_json::json!({
                "schemaVersion": 1,
                "serviceEnabled": false,
                "listenAddress": "127.0.0.1",
                "preferredPort": 15721,
                "actualPort": null,
                "showLocalQuickControl": false,
                "showFailoverQuickControl": false,
                "usageLoggingEnabled": true
            })
        );
        assert_eq!(
            setting("routing.takeovers.v1"),
            serde_json::json!({"schemaVersion": 1, "items": []})
        );
        assert_eq!(
            setting("routing.app.claude.v1"),
            serde_json::json!({
                "schemaVersion": 1,
                "autoFailoverEnabled": false,
                "maxRetries": 6,
                "streamingFirstByteTimeout": 90,
                "streamingIdleTimeout": 180,
                "nonStreamingTimeout": 600,
                "circuitFailureThreshold": 8,
                "circuitSuccessThreshold": 3,
                "circuitTimeoutSeconds": 90,
                "circuitErrorRateThreshold": 0.7,
                "circuitMinRequests": 15
            })
        );
        for app in ["codex", "grokbuild"] {
            assert_eq!(
                setting(&format!("routing.app.{app}.v1")),
                serde_json::json!({
                    "schemaVersion": 1,
                    "autoFailoverEnabled": false,
                    "maxRetries": 3,
                    "streamingFirstByteTimeout": 60,
                    "streamingIdleTimeout": 120,
                    "nonStreamingTimeout": 600,
                    "circuitFailureThreshold": 4,
                    "circuitSuccessThreshold": 2,
                    "circuitTimeoutSeconds": 60,
                    "circuitErrorRateThreshold": 0.6,
                    "circuitMinRequests": 10
                })
            );
        }
        assert_eq!(
            setting("routing.rectifier.v1"),
            serde_json::json!({
                "schemaVersion": 1,
                "enabled": true,
                "requestThinkingSignature": true,
                "requestThinkingBudget": true,
                "requestMediaFallback": true,
                "requestMediaHeuristic": true
            })
        );
        assert_eq!(
            setting("routing.optimizer.v1"),
            serde_json::json!({
                "schemaVersion": 1,
                "enabled": false,
                "thinkingOptimizer": true,
                "cacheInjection": true
            })
        );
        assert_eq!(
            setting("routing.global_proxy.v1"),
            serde_json::json!({
                "schemaVersion": 1,
                "url": null,
                "username": null,
                "passwordCredentialAccount": "routing-global-proxy-password"
            })
        );
    }

    #[tokio::test]
    async fn initializes_fresh_database_with_pragmas_and_domain_tables() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");

        initialize_at(path.clone()).await.unwrap();

        let mut connection = open_test_connection(&path).await;
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(foreign_keys, 1);

        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(version, PROVIDER_SCHEMA_VERSION);

        let migrations = sqlx::query(
            "SELECT version, description, checksum
             FROM provider_schema_migrations ORDER BY version",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(migrations.len(), 2);
        assert_eq!(
            migrations[0].get::<i64, _>("version"),
            PROVIDER_BASE_SCHEMA_VERSION
        );
        assert_eq!(
            migrations[0].get::<String, _>("description"),
            PROVIDER_SCHEMA_DESCRIPTION
        );
        assert_eq!(
            migrations[1].get::<i64, _>("version"),
            PROVIDER_SCHEMA_VERSION
        );
        assert_eq!(
            migrations[1].get::<String, _>("description"),
            PROVIDER_ROUTING_SCHEMA_DESCRIPTION
        );
        assert_eq!(migrations[0].get::<String, _>("checksum").len(), 96);
        assert_eq!(migrations[1].get::<String, _>("checksum").len(), 96);
        let common_config_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key LIKE 'common_config_%'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(common_config_count, 3);
        let routing_config_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key LIKE 'routing.%'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(routing_config_count, ROUTING_SETTINGS.len() as i64);
        let routing_indexes: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_routing_request_logs_%'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(routing_indexes, 2);
        let service_config: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'routing.service.v1'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert!(service_config.contains("\"preferredPort\":15721"));
        let builtin_rows = sqlx::query(
            "SELECT id, app_type, name, website_url, category, sort_index, is_current, meta
             FROM providers ORDER BY app_type",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(builtin_rows.len(), 3);
        for (row, expected_type) in builtin_rows.iter().zip(["claude", "codex", "grokbuild"]) {
            assert_eq!(
                row.get::<String, _>("id"),
                format!("builtin-fluxion-{expected_type}")
            );
            assert_eq!(row.get::<String, _>("app_type"), expected_type);
            assert_eq!(row.get::<String, _>("name"), "Fluxion AI");
            assert_eq!(row.get::<String, _>("website_url"), FLUXION_REGISTER_URL);
            assert_eq!(row.get::<String, _>("category"), "AI模型统一接入与管理平台");
            assert_eq!(row.get::<i64, _>("sort_index"), -1);
            assert_eq!(row.get::<i64, _>("is_current"), 0);
            let meta: serde_json::Value =
                serde_json::from_str(&row.get::<String, _>("meta")).unwrap();
            assert_eq!(
                meta.get("builtin").and_then(serde_json::Value::as_str),
                Some("fluxion")
            );
        }
        let key_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_api_keys")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(key_count, 0);
        let claude_settings: String = sqlx::query_scalar(
            "SELECT settings_config FROM providers WHERE id = 'builtin-fluxion-claude'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert!(claude_settings.contains(FLUXION_CLAUDE_BASE_URL));
        let codex_settings: serde_json::Value = serde_json::from_str(
            &sqlx::query_scalar::<_, String>(
                "SELECT settings_config FROM providers WHERE id = 'builtin-fluxion-codex'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(codex_settings["base_url"], FLUXION_OPENAI_BASE_URL);
        assert!(codex_settings["config"]
            .as_str()
            .unwrap()
            .contains("wire_api = \"responses\""));
        assert!(!temp.path().join("backups").exists());
    }

    #[tokio::test]
    async fn builtin_fluxion_seed_is_idempotent_and_preserves_existing_data() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        initialize_at(path.clone()).await.unwrap();

        let mut connection = open_test_connection(&path).await;
        sqlx::query(
            "UPDATE providers
             SET name = 'My Fluxion', sort_index = 27, is_current = 1
             WHERE id = 'builtin-fluxion-claude' AND app_type = 'claude'",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, created_at, updated_at)
             VALUES ('fluxion-test-key', 'builtin-fluxion-claude', 'claude', 'test', 'secret', 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();

        initialize_at(path.clone()).await.unwrap();
        let mut connection = open_test_connection(&path).await;
        let row = sqlx::query(
            "SELECT name, sort_index, is_current FROM providers
             WHERE id = 'builtin-fluxion-claude' AND app_type = 'claude'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("name"), "My Fluxion");
        assert_eq!(row.get::<i64, _>("sort_index"), 27);
        assert_eq!(row.get::<i64, _>("is_current"), 1);
        let key_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM provider_api_keys
             WHERE provider_id = 'builtin-fluxion-claude' AND app_type = 'claude'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(key_count, 1);
        let provider_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM providers")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(provider_count, 3);
    }

    #[test]
    fn builtin_identity_matches_only_seeded_pairs() {
        assert!(is_builtin_provider("codex", "builtin-fluxion-codex"));
        assert!(is_builtin_provider("claude", "builtin-fluxion-claude"));
        assert!(is_builtin_provider("grokbuild", "builtin-fluxion-grokbuild"));
        // 跨类型或用户自建的 ID 都不是内置项，不能被登记退订。
        assert!(!is_builtin_provider("claude", "builtin-fluxion-codex"));
        assert!(!is_builtin_provider("codex", "my-provider"));
    }

    #[test]
    fn corrupt_dismissal_setting_is_treated_as_no_dismissal() {
        assert!(parse_builtin_dismissals(None).is_empty());
        assert!(parse_builtin_dismissals(Some("not-json")).is_empty());
        assert!(parse_builtin_dismissals(Some(r#"{"schemaVersion":1}"#)).is_empty());
        assert_eq!(
            parse_builtin_dismissals(Some(
                r#"{"schemaVersion":1,"items":["codex:builtin-fluxion-codex",7]}"#
            )),
            HashSet::from(["codex:builtin-fluxion-codex".to_string()])
        );
    }

    #[tokio::test]
    async fn deleted_builtin_fluxion_provider_is_not_reseeded() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        initialize_at(path.clone()).await.unwrap();

        let mut connection = open_test_connection(&path).await;
        let mut transaction = connection.begin().await.unwrap();
        sqlx::query(
            "DELETE FROM providers WHERE id = 'builtin-fluxion-codex' AND app_type = 'codex'",
        )
        .execute(&mut *transaction)
        .await
        .unwrap();
        dismiss_builtin_provider(&mut transaction, "codex", "builtin-fluxion-codex")
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        connection.close().await.unwrap();

        // 每次打开连接都会重跑种子，所以这里连开两次以覆盖启动与后续查询两条路径。
        initialize_at(path.clone()).await.unwrap();
        initialize_at(path.clone()).await.unwrap();

        let mut connection = open_test_connection(&path).await;
        let remaining: Vec<String> =
            sqlx::query_scalar("SELECT app_type FROM providers ORDER BY app_type")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(remaining, vec!["claude", "grokbuild"]);
        let dismissed = load_builtin_dismissals(&mut connection).await.unwrap();
        assert_eq!(
            dismissed,
            HashSet::from(["codex:builtin-fluxion-codex".to_string()])
        );
    }

    #[tokio::test]
    async fn dismissing_one_builtin_keeps_the_other_types_seeded() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        initialize_at(path.clone()).await.unwrap();

        let mut connection = open_test_connection(&path).await;
        for (app_type, id) in [
            ("codex", "builtin-fluxion-codex"),
            ("grokbuild", "builtin-fluxion-grokbuild"),
        ] {
            let mut transaction = connection.begin().await.unwrap();
            sqlx::query("DELETE FROM providers WHERE id = ?1 AND app_type = ?2")
                .bind(id)
                .bind(app_type)
                .execute(&mut *transaction)
                .await
                .unwrap();
            dismiss_builtin_provider(&mut transaction, app_type, id)
                .await
                .unwrap();
            transaction.commit().await.unwrap();
        }
        // 用户自建的 Claude 供应商删除后不写退订，重开连接不受影响。
        insert_provider(&mut connection, "user-claude", "claude", 0).await;
        sqlx::query("DELETE FROM providers WHERE id = 'user-claude' AND app_type = 'claude'")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();

        initialize_at(path.clone()).await.unwrap();
        let mut connection = open_test_connection(&path).await;
        let remaining: Vec<String> = sqlx::query_scalar("SELECT id FROM providers ORDER BY id")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert_eq!(remaining, vec!["builtin-fluxion-claude"]);
    }

    #[tokio::test]
    async fn composite_identity_and_active_key_index_are_enforced() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        initialize_at(path.clone()).await.unwrap();
        let mut connection = open_test_connection(&path).await;

        insert_provider(&mut connection, "same-id", "claude", 1).await;
        insert_provider(&mut connection, "same-id", "codex", 1).await;

        let duplicate = sqlx::query(
            "INSERT INTO providers
             (id, app_type, name, settings_config, created_at)
             VALUES ('same-id', 'claude', 'duplicate', '{}', 1)",
        )
        .execute(&mut connection)
        .await;
        assert!(duplicate.is_err());

        sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, is_active, created_at, updated_at)
             VALUES ('claude-key-1', 'same-id', 'claude', 'Primary', 'secret-1', 1, 1, 1),
                    ('codex-key-1', 'same-id', 'codex', 'Primary', 'secret-2', 1, 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let second_active = sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, is_active, created_at, updated_at)
             VALUES ('claude-key-2', 'same-id', 'claude', 'Backup', 'secret-3', 1, 1, 1)",
        )
        .execute(&mut connection)
        .await;
        assert!(second_active.is_err());

        let wrong_owner = sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, created_at, updated_at)
             VALUES ('wrong-key', 'same-id', 'grokbuild', 'Wrong', 'secret-4', 1, 1)",
        )
        .execute(&mut connection)
        .await;
        assert!(wrong_owner.is_err());

        sqlx::query("DELETE FROM providers WHERE id = 'same-id' AND app_type = 'claude'")
            .execute(&mut connection)
            .await
            .unwrap();
        let remaining_keys: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM provider_api_keys WHERE app_type = 'claude'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(remaining_keys, 0);

        let remaining_codex: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM providers WHERE id = 'same-id' AND app_type = 'codex'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(remaining_codex, 1);
    }

    #[tokio::test]
    async fn existing_database_is_backed_up_before_schema_initialization() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        let mut old_connection = open_test_connection(&path).await;
        sqlx::query("CREATE TABLE legacy_marker (value TEXT NOT NULL)")
            .execute(&mut old_connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO legacy_marker (value) VALUES ('keep')")
            .execute(&mut old_connection)
            .await
            .unwrap();
        old_connection.close().await.unwrap();

        initialize_at(path.clone()).await.unwrap();

        let backup_dir = temp.path().join("backups").join("providers");
        let backups: Vec<PathBuf> = fs::read_dir(&backup_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        assert!(backups[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("providers.db.backup-"));

        let mut backup_connection = open_test_connection(&backups[0]).await;
        let marker: String = sqlx::query_scalar("SELECT value FROM legacy_marker")
            .fetch_one(&mut backup_connection)
            .await
            .unwrap();
        assert_eq!(marker, "keep");
    }

    #[tokio::test]
    async fn upgrades_v1_database_additively_and_preserves_provider_data() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        let mut connection = create_v1_database(&path).await;
        insert_provider(&mut connection, "provider-1", "codex", 1).await;
        sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, created_at, updated_at)
             VALUES ('key-1', 'provider-1', 'codex', 'Primary', 'secret', 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO settings (key, value)
             VALUES ('routing.service.v1', '{\"schemaVersion\":1,\"serviceEnabled\":true}')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();

        initialize_at(path.clone()).await.unwrap();

        let mut connection = open_test_connection(&path).await;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(version, PROVIDER_SCHEMA_VERSION);
        let provider_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM providers WHERE id = 'provider-1' AND app_type = 'codex'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(provider_count, 1);
        let key_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM provider_api_keys WHERE id = 'key-1'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(key_count, 1);
        let service_config: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'routing.service.v1'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            service_config,
            r#"{"schemaVersion":1,"serviceEnabled":true}"#
        );
        let routing_migration_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM provider_schema_migrations
             WHERE version = ?1 AND description = ?2",
        )
        .bind(PROVIDER_SCHEMA_VERSION)
        .bind(PROVIDER_ROUTING_SCHEMA_DESCRIPTION)
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(routing_migration_count, 1);
        connection.close().await.unwrap();

        let backup_dir = temp.path().join("backups").join("providers");
        let backups: Vec<PathBuf> = fs::read_dir(&backup_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        let mut backup_connection = open_test_connection(&backups[0]).await;
        let backup_version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut backup_connection)
            .await
            .unwrap();
        assert_eq!(backup_version, PROVIDER_BASE_SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn rejects_future_provider_schema_without_backup_or_mutation() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        let mut connection = open_test_connection(&path).await;
        configure_connection(&mut connection).await.unwrap();
        sqlx::query("CREATE TABLE future_marker (value TEXT NOT NULL)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO future_marker (value) VALUES ('keep')")
            .execute(&mut connection)
            .await
            .unwrap();
        set_user_version(&mut connection, PROVIDER_SCHEMA_VERSION + 1)
            .await
            .unwrap();
        connection.close().await.unwrap();

        let error = initialize_at(path.clone()).await.unwrap_err();
        assert_eq!(
            error,
            format!(
                "provider_db_version_unsupported: {}",
                PROVIDER_SCHEMA_VERSION + 1
            )
        );
        let mut connection = open_test_connection(&path).await;
        let marker: String = sqlx::query_scalar("SELECT value FROM future_marker")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(marker, "keep");
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(version, PROVIDER_SCHEMA_VERSION + 1);
        assert!(!temp.path().join("backups").exists());
    }

    #[tokio::test]
    async fn preserves_v1_database_when_upgrade_backup_fails() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        let mut connection = create_v1_database(&path).await;
        insert_provider(&mut connection, "provider-1", "grokbuild", 1).await;
        connection.close().await.unwrap();
        fs::write(temp.path().join("backups"), b"block backup directory").unwrap();

        let error = initialize_at(path.clone()).await.unwrap_err();
        assert!(error.starts_with("provider_db_backup_directory_failed:"));

        let mut connection = open_test_connection(&path).await;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(version, PROVIDER_BASE_SCHEMA_VERSION);
        let provider_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM providers
             WHERE id = 'provider-1' AND app_type = 'grokbuild'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(provider_count, 1);
        let routing_table_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'routing_request_logs'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(routing_table_count, 0);
    }

    #[tokio::test]
    async fn rolls_back_failed_routing_migration_and_can_retry() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        let mut connection = create_v1_database(&path).await;
        insert_provider(&mut connection, "provider-1", "claude", 1).await;
        sqlx::query("CREATE TABLE routing_request_logs (request_id TEXT PRIMARY KEY)")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();

        let error = initialize_at(path.clone()).await.unwrap_err();
        assert!(error.starts_with("provider_db_schema_failed:"));

        let mut connection = open_test_connection(&path).await;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(version, PROVIDER_BASE_SCHEMA_VERSION);
        let provider_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM providers")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(provider_count, 1);
        let routing_migration_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM provider_schema_migrations WHERE version = ?1",
        )
        .bind(PROVIDER_SCHEMA_VERSION)
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(routing_migration_count, 0);
        connection.close().await.unwrap();

        let mut connection = open_test_connection(&path).await;
        sqlx::query("DROP TABLE routing_request_logs")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        initialize_at(path).await.unwrap();
    }

    #[tokio::test]
    async fn initialization_is_idempotent_after_schema_version_is_set() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");

        initialize_at(path.clone()).await.unwrap();
        initialize_at(path.clone()).await.unwrap();

        let backup_dir = temp.path().join("backups").join("providers");
        assert!(!backup_dir.exists());
        let mut connection = open_test_connection(&path).await;
        let table_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'provider_api_keys'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(table_count, 1);
    }
}
