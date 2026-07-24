use serde::Deserialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const SSH_DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_HISTORY_IDENTITY_BYTES: usize = 256;
const MAX_HISTORY_ROOT_BYTES: usize = 4096;

static SSH_GROUP_SCHEMA_READY: AtomicBool = AtomicBool::new(false);
static SSH_GROUP_SCHEMA_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn ssh_group_schema_lock() -> &'static AsyncMutex<()> {
    SSH_GROUP_SCHEMA_LOCK.get_or_init(|| AsyncMutex::new(()))
}

async fn open_database() -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(crate::app_paths::db_path()?)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(SSH_DATABASE_BUSY_TIMEOUT);
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("ssh_database_open_failed: {error}"))
}

async fn begin_immediate(conn: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("BEGIN IMMEDIATE")
        .execute(conn)
        .await
        .map(|_| ())
        .map_err(|error| format!("ssh_database_begin_failed: {error}"))
}

async fn finish_transaction(
    conn: &mut SqliteConnection,
    result: Result<(), String>,
) -> Result<(), String> {
    if result.is_ok() {
        sqlx::query("COMMIT")
            .execute(conn)
            .await
            .map_err(|error| format!("ssh_database_commit_failed: {error}"))?;
    } else {
        let _ = sqlx::query("ROLLBACK").execute(conn).await;
    }
    result
}

async fn has_column(
    conn: &mut SqliteConnection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(conn)
        .await
        .map_err(|error| error.to_string())?;
    Ok(rows
        .iter()
        .any(|row| row.try_get::<String, _>("name").ok().as_deref() == Some(column)))
}

async fn ensure_group_schema_with_conn(conn: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS ssh_host_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )",
    )
    .execute(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if !has_column(conn, "ssh_hosts", "group_id").await? {
        sqlx::query(
            "ALTER TABLE ssh_hosts ADD COLUMN group_id TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL",
        )
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
    }
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_ssh_host_groups_parent
         ON ssh_host_groups(parent_id, sort_order, name)",
    )
    .execute(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_ssh_hosts_group_id
         ON ssh_hosts(group_id, sort_order, name)",
    )
    .execute(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(
        "INSERT INTO ssh_host_groups (id, name, parent_id, sort_order, created_at)
         SELECT lower(hex(randomblob(16))), h.group_name, NULL, 0, CAST(strftime('%s', 'now') AS TEXT)
         FROM ssh_hosts AS h
         WHERE trim(h.group_name) <> ''
           AND NOT EXISTS (
             SELECT 1 FROM ssh_host_groups AS g
             WHERE g.parent_id IS NULL AND g.name = h.group_name
           )
         GROUP BY h.group_name",
    )
    .execute(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(
        "UPDATE ssh_hosts
         SET group_id = (
           SELECT id FROM ssh_host_groups
           WHERE parent_id IS NULL AND name = ssh_hosts.group_name
           ORDER BY created_at, id LIMIT 1
         )
         WHERE trim(group_name) <> '' AND (group_id IS NULL OR trim(group_id) = '')",
    )
    .execute(conn)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_db_ensure_group_schema() -> Result<(), String> {
    if SSH_GROUP_SCHEMA_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    let _guard = ssh_group_schema_lock().lock().await;
    if SSH_GROUP_SCHEMA_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    let mut conn = open_database().await?;
    ensure_group_schema_with_conn(&mut conn).await?;
    SSH_GROUP_SCHEMA_READY.store(true, Ordering::Release);
    Ok(())
}

#[derive(Deserialize)]
pub struct SshImportHostInput {
    id: String,
    name: String,
    config_alias: String,
    config_file: String,
    created_at: String,
    updated_at: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportResult {
    imported: usize,
    skipped: usize,
}

#[tauri::command]
pub async fn ssh_db_import_config_hosts(
    hosts: Vec<SshImportHostInput>,
    group_id: Option<String>,
) -> Result<SshImportResult, String> {
    if hosts.is_empty() {
        return Ok(SshImportResult {
            imported: 0,
            skipped: 0,
        });
    }
    if hosts.len() > 10_000 {
        return Err("ssh_config_import_too_many_hosts".to_string());
    }
    let total = hosts.len();
    let mut conn = open_database().await?;
    begin_immediate(&mut conn).await?;
    let result = async {
        let group_name = if let Some(group_id) = group_id.as_deref() {
            sqlx::query_scalar::<_, String>("SELECT name FROM ssh_host_groups WHERE id = ?1")
                .bind(group_id)
                .fetch_optional(&mut conn)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "ssh_group_parent_not_found".to_string())?
        } else {
            String::new()
        };
        let existing_aliases = sqlx::query_scalar::<_, String>(
            "SELECT lower(trim(config_alias)) FROM ssh_hosts WHERE trim(config_alias) <> ''",
        )
        .fetch_all(&mut conn)
        .await
        .map_err(|error| error.to_string())?;
        let mut existing: HashSet<String> = existing_aliases.into_iter().collect();
        let mut imported = 0;
        for host in hosts {
            if host.id.trim().is_empty()
                || host.name.trim().is_empty()
                || host.config_alias.trim().is_empty()
                || host.created_at.trim().is_empty()
                || host.updated_at.trim().is_empty()
            {
                return Err("ssh_host_name_required".to_string());
            }
            let normalized_alias = host.config_alias.trim().to_lowercase();
            if !existing.insert(normalized_alias) {
                continue;
            }
            sqlx::query(
                "INSERT INTO ssh_hosts (
                   id, name, group_name, group_id, host, port, username, config_alias, config_file,
                   auth_mode, identity_file, credential_ref, jump_mode, jump_host_id, proxy_type,
                   proxy_host, proxy_port, proxy_command, connect_timeout_sec,
                   server_alive_interval_sec, server_alive_count_max, terminal_encoding,
                   startup_script, notes, sort_order, created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, '', 22, '', ?5, ?6, 'ssh_config', '', '', 'none', NULL,
                   'none', '', 0, '', 15, 30, 3, 'UTF-8', '', '', 0, ?7, ?8
                 )",
            )
            .bind(host.id)
            .bind(host.name)
            .bind(&group_name)
            .bind(group_id.as_deref())
            .bind(host.config_alias)
            .bind(host.config_file)
            .bind(host.created_at)
            .bind(host.updated_at)
            .execute(&mut conn)
            .await
            .map_err(|error| error.to_string())?;
            imported += 1;
        }
        Ok(imported)
    }
    .await;
    let imported = match result {
        Ok(imported) => {
            finish_transaction(&mut conn, Ok(())).await?;
            imported
        }
        Err(error) => {
            finish_transaction(&mut conn, Err(error)).await?;
            unreachable!()
        }
    };
    Ok(SshImportResult {
        imported,
        skipped: total - imported,
    })
}

#[tauri::command]
pub async fn ssh_db_delete_host(id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("ssh_host_not_found".to_string());
    }
    let mut conn = open_database().await?;
    begin_immediate(&mut conn).await?;
    let result = delete_host_with_conn(&mut conn, id).await;
    finish_transaction(&mut conn, result).await
}

async fn delete_host_with_conn(conn: &mut SqliteConnection, id: &str) -> Result<(), String> {
    let references: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM ssh_hosts WHERE jump_host_id = ?1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(|error| error.to_string())?;
    if references > 0 {
        return Err("ssh_host_jump_in_use".to_string());
    }
    sqlx::query("UPDATE projects SET ssh_host_id = NULL WHERE ssh_host_id = ?1")
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query(
        "UPDATE ssh_agent_tool_integrations
         SET host_id = NULL, validation_state = 'unbound', cleanup_state = 'retained'
         WHERE host_id = ?1",
    )
    .bind(id)
    .execute(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query("DELETE FROM ssh_hosts WHERE id = ?1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_db_delete_group(id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let mut conn = open_database().await?;
    begin_immediate(&mut conn).await?;
    let result = delete_group_with_conn(&mut conn, id).await;
    finish_transaction(&mut conn, result).await
}

async fn delete_group_with_conn(conn: &mut SqliteConnection, id: &str) -> Result<(), String> {
    let Some(group) = sqlx::query("SELECT parent_id FROM ssh_host_groups WHERE id = ?1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let parent_id = group
        .try_get::<Option<String>, _>("parent_id")
        .map_err(|error| error.to_string())?;
    let parent_name = if let Some(parent_id) = parent_id.as_deref() {
        sqlx::query_scalar::<_, String>("SELECT name FROM ssh_host_groups WHERE id = ?1")
            .bind(parent_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or_default()
    } else {
        String::new()
    };
    sqlx::query("UPDATE ssh_host_groups SET parent_id = ?1 WHERE parent_id = ?2")
        .bind(parent_id.as_deref())
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("UPDATE ssh_hosts SET group_id = ?1, group_name = ?2 WHERE group_id = ?3")
        .bind(parent_id.as_deref())
        .bind(parent_name)
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("DELETE FROM ssh_host_groups WHERE id = ?1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_db_save_host_preferences(
    host_id: String,
    claude_root: String,
    codex_root: String,
    updated_at: String,
) -> Result<(), String> {
    if host_id.trim().is_empty() {
        return Err("ssh_host_not_found".to_string());
    }
    let mut conn = open_database().await?;
    begin_immediate(&mut conn).await?;
    let result =
        save_host_preferences_with_conn(&mut conn, &host_id, claude_root, codex_root, &updated_at)
            .await;
    finish_transaction(&mut conn, result).await
}

async fn save_host_preferences_with_conn(
    conn: &mut SqliteConnection,
    host_id: &str,
    claude_root: String,
    codex_root: String,
    updated_at: &str,
) -> Result<(), String> {
    for (source, root) in [("claude", claude_root), ("codex", codex_root)] {
        if root.is_empty() {
            sqlx::query("DELETE FROM ssh_host_tool_preferences WHERE host_id = ?1 AND source = ?2")
                .bind(host_id)
                .bind(source)
                .execute(&mut *conn)
                .await
                .map_err(|error| error.to_string())?;
        } else {
            sqlx::query(
                    "INSERT INTO ssh_host_tool_preferences (host_id, source, configured_root, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(host_id, source) DO UPDATE SET
                       configured_root = excluded.configured_root,
                       updated_at = excluded.updated_at",
                )
                .bind(host_id)
                .bind(source)
                .bind(root)
                .bind(updated_at)
                .execute(&mut *conn)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHookReportInput {
    host_id: String,
    ssh_user: String,
    configured_root: String,
    source: String,
    installation_id: String,
    remote_machine_id: String,
    canonical_config_root: String,
    config_root_hash: String,
    action: String,
    status: String,
    report: Value,
    integration_id: Option<String>,
    scope_kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHistorySourceInput {
    host_id: String,
    configured_root: String,
    source: String,
    scope_kind: String,
    source_instance_id: String,
    installation_id: String,
    remote_machine_id: String,
    ssh_user: String,
    canonical_config_root: String,
    config_root_hash: String,
}

fn current_time_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn is_sqlite_busy_error(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|database_error| database_error.code())
        .is_some_and(|code| {
            matches!(code.as_ref(), "SQLITE_BUSY" | "SQLITE_LOCKED")
                || code
                    .parse::<i32>()
                    .is_ok_and(|value| matches!(value & 0xff, 5 | 6))
        })
}

fn map_history_metadata_error(stage: &str, error: sqlx::Error) -> String {
    if is_sqlite_busy_error(&error) {
        "ssh_agent_history_metadata_busy".to_string()
    } else {
        format!("ssh_agent_history_metadata_{stage}_failed:{error}")
    }
}

fn validate_history_source_input(input: &SshHistorySourceInput) -> Result<(), String> {
    Uuid::parse_str(input.host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    Uuid::parse_str(input.installation_id.trim())
        .map_err(|_| "ssh_agent_identity_required".to_string())?;
    if !matches!(input.source.as_str(), "claude" | "codex") {
        return Err("history_source_invalid".to_string());
    }
    if !matches!(input.scope_kind.as_str(), "hostPrimary" | "projectOverride") {
        return Err("ssh_history_scope_invalid".to_string());
    }
    let source_hash = input
        .source_instance_id
        .strip_prefix("ssh-")
        .unwrap_or_default();
    if source_hash.len() != 64 || !source_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("history_remote_identity_invalid".to_string());
    }
    for value in [&input.remote_machine_id, &input.ssh_user] {
        if value.trim().is_empty()
            || value.len() > MAX_HISTORY_IDENTITY_BYTES
            || value.contains(['\0', '\r', '\n'])
        {
            return Err("history_remote_identity_invalid".to_string());
        }
    }
    let configured_root = input.configured_root.trim();
    if configured_root.len() > MAX_HISTORY_ROOT_BYTES
        || configured_root.contains(['\0', '\r', '\n'])
        || (!configured_root.is_empty()
            && crate::ssh_transport::validate_remote_home_path(configured_root).is_err())
    {
        return Err("ssh_tool_config_root_invalid".to_string());
    }
    let canonical_root = input.canonical_config_root.trim();
    if !canonical_root.starts_with('/')
        || canonical_root.len() > MAX_HISTORY_ROOT_BYTES
        || crate::ssh_transport::validate_remote_home_path(canonical_root).is_err()
    {
        return Err("history_remote_identity_invalid".to_string());
    }
    if input.config_root_hash.len() != 64
        || !input
            .config_root_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("history_remote_identity_invalid".to_string());
    }
    Ok(())
}

async fn record_history_source_with_conn(
    conn: &mut SqliteConnection,
    input: &SshHistorySourceInput,
) -> Result<(), String> {
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT integration_id FROM ssh_agent_tool_integrations
         WHERE host_id = ?1 AND source = ?2 AND configured_root = ?3
           AND scope_kind IN ('hostPrimary', 'projectOverride')
         ORDER BY CASE WHEN scope_kind = ?4 THEN 0 ELSE 1 END
         LIMIT 1",
    )
    .bind(input.host_id.trim())
    .bind(&input.source)
    .bind(input.configured_root.trim())
    .bind(&input.scope_kind)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| map_history_metadata_error("read", error))?;
    let checked_at = current_time_millis();
    if let Some(integration_id) = existing {
        sqlx::query(
            "UPDATE ssh_agent_tool_integrations SET
               installation_id = ?1, remote_machine_id = ?2, ssh_user = ?3,
               canonical_root = ?4, config_root_hash = ?5,
               history_source_instance_id = ?6, validation_state = 'valid',
               cleanup_state = 'active', checked_at = ?7
             WHERE integration_id = ?8",
        )
        .bind(&input.installation_id)
        .bind(&input.remote_machine_id)
        .bind(&input.ssh_user)
        .bind(&input.canonical_config_root)
        .bind(&input.config_root_hash)
        .bind(&input.source_instance_id)
        .bind(&checked_at)
        .bind(integration_id)
        .execute(&mut *conn)
        .await
        .map_err(|error| map_history_metadata_error("write", error))?;
    } else {
        sqlx::query(
            "INSERT INTO ssh_agent_tool_integrations (
               integration_id, host_id, installation_id, remote_machine_id, ssh_user,
               source, scope_kind, configured_root, canonical_root, config_root_hash,
               hook_record_json, history_source_instance_id, validation_state,
               cleanup_state, checked_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '{}', ?11, 'valid', 'active', ?12)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(input.host_id.trim())
        .bind(&input.installation_id)
        .bind(&input.remote_machine_id)
        .bind(&input.ssh_user)
        .bind(&input.source)
        .bind(&input.scope_kind)
        .bind(input.configured_root.trim())
        .bind(&input.canonical_config_root)
        .bind(&input.config_root_hash)
        .bind(&input.source_instance_id)
        .bind(&checked_at)
        .execute(&mut *conn)
        .await
        .map_err(|error| map_history_metadata_error("write", error))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_db_record_history_source(input: SshHistorySourceInput) -> Result<(), String> {
    validate_history_source_input(&input)?;
    let options = SqliteConnectOptions::new()
        .filename(crate::app_paths::db_path()?)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(SSH_DATABASE_BUSY_TIMEOUT);
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| map_history_metadata_error("open", error))?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut conn)
        .await
        .map_err(|error| map_history_metadata_error("begin", error))?;
    let result = record_history_source_with_conn(&mut conn, &input).await;
    if result.is_ok() {
        sqlx::query("COMMIT")
            .execute(&mut conn)
            .await
            .map_err(|error| map_history_metadata_error("commit", error))?;
    } else {
        let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
    }
    result
}

fn managed_entries(report: &str) -> u64 {
    serde_json::from_str::<Value>(report)
        .ok()
        .and_then(|value| value.get("managedEntries").and_then(Value::as_u64))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn ssh_db_record_hook_report(input: SshHookReportInput) -> Result<(), String> {
    if input.host_id.trim().is_empty() {
        return Err("ssh_host_not_found".to_string());
    }
    if input.ssh_user.trim().is_empty() {
        return Err("ssh_user_required".to_string());
    }
    if !matches!(input.source.as_str(), "claude" | "codex") {
        return Err("hook_source_invalid".to_string());
    }
    if !matches!(input.scope_kind.as_str(), "hostPrimary" | "projectOverride") {
        return Err("ssh_hook_scope_invalid".to_string());
    }
    if !input.report.is_object()
        || input.installation_id.trim().is_empty()
        || input.remote_machine_id.trim().is_empty()
        || input.canonical_config_root.trim().is_empty()
        || input.config_root_hash.trim().is_empty()
        || ![
            ("source", input.source.as_str()),
            ("installationId", input.installation_id.as_str()),
            ("remoteMachineId", input.remote_machine_id.as_str()),
            ("canonicalConfigRoot", input.canonical_config_root.as_str()),
            ("configRootHash", input.config_root_hash.as_str()),
            ("action", input.action.as_str()),
            ("status", input.status.as_str()),
        ]
        .into_iter()
        .all(|(key, expected)| input.report.get(key).and_then(Value::as_str) == Some(expected))
    {
        return Err("ssh_hook_report_invalid".to_string());
    }
    let mut conn = open_database().await?;
    begin_immediate(&mut conn).await?;
    let result = record_hook_report_with_conn(&mut conn, input).await;
    finish_transaction(&mut conn, result).await
}

async fn record_hook_report_with_conn(
    conn: &mut SqliteConnection,
    input: SshHookReportInput,
) -> Result<(), String> {
    let existing = if let Some(integration_id) = input.integration_id.as_deref() {
        sqlx::query(
            "SELECT integration_id, source, canonical_root, hook_record_json, history_source_instance_id
             FROM ssh_agent_tool_integrations WHERE integration_id = ?1 AND host_id = ?2 LIMIT 1",
        )
        .bind(integration_id)
        .bind(&input.host_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|error| error.to_string())?
    } else if input.scope_kind == "projectOverride" {
        sqlx::query(
            "SELECT integration_id, source, canonical_root, hook_record_json, history_source_instance_id
             FROM ssh_agent_tool_integrations
             WHERE host_id = ?1 AND source = ?2 AND scope_kind = 'projectOverride'
               AND configured_root = ?3 LIMIT 1",
        )
        .bind(&input.host_id)
        .bind(&input.source)
        .bind(input.configured_root.trim())
        .fetch_optional(&mut *conn)
        .await
        .map_err(|error| error.to_string())?
    } else {
        sqlx::query(
            "SELECT integration_id, source, canonical_root, hook_record_json, history_source_instance_id
             FROM ssh_agent_tool_integrations
             WHERE host_id = ?1 AND source = ?2 AND scope_kind = 'hostPrimary' LIMIT 1",
        )
        .bind(&input.host_id)
        .bind(&input.source)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|error| error.to_string())?
    };
    if input.integration_id.is_some() && existing.is_none() {
        return Err("ssh_hook_integration_not_found".to_string());
    }
    if existing.as_ref().is_some_and(|row| {
        row.try_get::<String, _>("source").ok().as_deref() != Some(input.source.as_str())
    }) {
        return Err("ssh_hook_integration_identity_changed".to_string());
    }
    let mut report = input.report.clone();
    if input.action == "inspect" && report.get("installation").is_some_and(Value::is_null) {
        let previous_json = if let Some(row) = existing.as_ref().filter(|row| {
            row.try_get::<String, _>("canonical_root").ok().as_deref()
                == Some(input.canonical_config_root.as_str())
        }) {
            row.try_get::<String, _>("hook_record_json")
                .unwrap_or_default()
        } else {
            sqlx::query_scalar::<_, String>(
                "SELECT hook_record_json FROM ssh_agent_tool_integrations
                 WHERE host_id = ?1 AND source = ?2 AND canonical_root = ?3 LIMIT 1",
            )
            .bind(&input.host_id)
            .bind(&input.source)
            .bind(&input.canonical_config_root)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or_default()
        };
        if let Ok(previous) = serde_json::from_str::<Value>(&previous_json) {
            if previous.get("canonicalConfigRoot")
                == Some(&Value::String(input.canonical_config_root.clone()))
                && previous
                    .get("installation")
                    .is_some_and(|value| !value.is_null())
            {
                report["installation"] = previous["installation"].clone();
            }
        }
    }
    let report_json = serde_json::to_string(&report).map_err(|error| error.to_string())?;
    let checked_at = chrono::Utc::now().timestamp_millis().to_string();
    if let Some(requested_id) = input.integration_id.as_deref() {
        update_integration(conn, requested_id, &input, &report_json, &checked_at, true).await?;
    } else if let Some(row) = existing {
        let existing_id = row
            .try_get::<String, _>("integration_id")
            .map_err(|error| error.to_string())?;
        let old_root = row
            .try_get::<String, _>("canonical_root")
            .unwrap_or_default();
        let old_report = row
            .try_get::<String, _>("hook_record_json")
            .unwrap_or_default();
        let history_id = row
            .try_get::<String, _>("history_source_instance_id")
            .unwrap_or_default();
        if !old_root.is_empty()
            && old_root != input.canonical_config_root
            && (managed_entries(&old_report) > 0 || !history_id.is_empty())
        {
            sqlx::query(
                "UPDATE ssh_agent_tool_integrations
                 SET scope_kind = 'retainedRoot', cleanup_state = 'cleanupAvailable', checked_at = ?1
                 WHERE integration_id = ?2",
            )
            .bind(&checked_at)
            .bind(existing_id)
            .execute(&mut *conn)
            .await
            .map_err(|error| error.to_string())?;
            let new_id = Uuid::new_v4().to_string();
            insert_integration(conn, &new_id, &input, &report_json, &checked_at).await?;
        } else {
            update_integration(conn, &existing_id, &input, &report_json, &checked_at, false)
                .await?;
        }
    } else {
        let new_id = Uuid::new_v4().to_string();
        insert_integration(conn, &new_id, &input, &report_json, &checked_at).await?;
    }

    let mirrors = sqlx::query(
        "SELECT integration_id, configured_root FROM ssh_agent_tool_integrations
         WHERE host_id = ?1 AND source = ?2 AND canonical_root = ?3",
    )
    .bind(&input.host_id)
    .bind(&input.source)
    .bind(&input.canonical_config_root)
    .fetch_all(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    for mirror in mirrors {
        let mirror_id = mirror
            .try_get::<String, _>("integration_id")
            .map_err(|e| e.to_string())?;
        let configured_root = mirror
            .try_get::<String, _>("configured_root")
            .map_err(|e| e.to_string())?;
        let mut mirror_report = report.clone();
        mirror_report["configuredConfigRoot"] = Value::String(configured_root);
        sqlx::query(
            "UPDATE ssh_agent_tool_integrations SET
               installation_id = ?1, remote_machine_id = ?2, ssh_user = ?3,
               config_root_hash = ?4, hook_record_json = ?5,
               validation_state = 'valid', checked_at = ?6
             WHERE integration_id = ?7",
        )
        .bind(&input.installation_id)
        .bind(&input.remote_machine_id)
        .bind(&input.ssh_user)
        .bind(&input.config_root_hash)
        .bind(serde_json::to_string(&mirror_report).map_err(|error| error.to_string())?)
        .bind(&checked_at)
        .bind(mirror_id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn insert_integration(
    conn: &mut SqliteConnection,
    id: &str,
    input: &SshHookReportInput,
    report_json: &str,
    checked_at: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO ssh_agent_tool_integrations (
           integration_id, host_id, installation_id, remote_machine_id, ssh_user,
           source, scope_kind, configured_root, canonical_root, config_root_hash,
           hook_record_json, validation_state, cleanup_state, checked_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'valid', 'active', ?12)",
    )
    .bind(id)
    .bind(&input.host_id)
    .bind(&input.installation_id)
    .bind(&input.remote_machine_id)
    .bind(&input.ssh_user)
    .bind(&input.source)
    .bind(&input.scope_kind)
    .bind(input.configured_root.trim())
    .bind(&input.canonical_config_root)
    .bind(&input.config_root_hash)
    .bind(report_json)
    .bind(checked_at)
    .execute(conn)
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

async fn update_integration(
    conn: &mut SqliteConnection,
    id: &str,
    input: &SshHookReportInput,
    report_json: &str,
    checked_at: &str,
    explicit: bool,
) -> Result<(), String> {
    let cleanup_state = if explicit {
        if input.status == "notInstalled" {
            "retained"
        } else {
            "cleanupAvailable"
        }
    } else {
        "active"
    };
    sqlx::query(
        "UPDATE ssh_agent_tool_integrations SET
           installation_id = ?1, remote_machine_id = ?2, ssh_user = ?3,
           configured_root = ?4, canonical_root = ?5, config_root_hash = ?6,
           hook_record_json = ?7, validation_state = 'valid', cleanup_state = ?8, checked_at = ?9
         WHERE integration_id = ?10",
    )
    .bind(&input.installation_id)
    .bind(&input.remote_machine_id)
    .bind(&input.ssh_user)
    .bind(input.configured_root.trim())
    .bind(&input.canonical_config_root)
    .bind(&input.config_root_hash)
    .bind(report_json)
    .bind(cleanup_state)
    .bind(checked_at)
    .bind(id)
    .execute(conn)
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HISTORY_HOST_ID: &str = "00000000-0000-4000-8000-000000000001";
    const HISTORY_INSTALLATION_ID: &str = "00000000-0000-4000-8000-000000000002";

    async fn history_database() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE ssh_agent_tool_integrations (
               integration_id TEXT PRIMARY KEY,
               host_id TEXT,
               installation_id TEXT NOT NULL DEFAULT '',
               remote_machine_id TEXT NOT NULL DEFAULT '',
               ssh_user TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL,
               scope_kind TEXT NOT NULL DEFAULT 'hostPrimary',
               configured_root TEXT NOT NULL DEFAULT '',
               canonical_root TEXT NOT NULL DEFAULT '',
               config_root_hash TEXT NOT NULL DEFAULT '',
               hook_record_json TEXT NOT NULL DEFAULT '{}',
               history_source_instance_id TEXT NOT NULL DEFAULT '',
               validation_state TEXT NOT NULL DEFAULT 'unvalidated',
               cleanup_state TEXT NOT NULL DEFAULT 'active',
               checked_at TEXT NOT NULL DEFAULT ''
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    fn history_source_input(source_hash: char) -> SshHistorySourceInput {
        SshHistorySourceInput {
            host_id: HISTORY_HOST_ID.to_string(),
            configured_root: "~/.claude".to_string(),
            source: "claude".to_string(),
            scope_kind: "hostPrimary".to_string(),
            source_instance_id: format!("ssh-{}", source_hash.to_string().repeat(64)),
            installation_id: HISTORY_INSTALLATION_ID.to_string(),
            remote_machine_id: "machine-1".to_string(),
            ssh_user: "dev".to_string(),
            canonical_config_root: "/home/dev/.claude".to_string(),
            config_root_hash: "b".repeat(64),
        }
    }

    #[test]
    fn validates_remote_history_identity_before_database_access() {
        let valid = history_source_input('a');
        assert!(validate_history_source_input(&valid).is_ok());

        let mut invalid = history_source_input('a');
        invalid.source_instance_id = "session-1".to_string();
        assert_eq!(
            validate_history_source_input(&invalid).unwrap_err(),
            "history_remote_identity_invalid"
        );
    }

    #[tokio::test]
    async fn records_remote_history_source_idempotently() {
        let mut conn = history_database().await;
        let first = history_source_input('a');
        begin_immediate(&mut conn).await.unwrap();
        let result = record_history_source_with_conn(&mut conn, &first).await;
        finish_transaction(&mut conn, result).await.unwrap();

        let second = history_source_input('c');
        begin_immediate(&mut conn).await.unwrap();
        let result = record_history_source_with_conn(&mut conn, &second).await;
        finish_transaction(&mut conn, result).await.unwrap();

        let rows = sqlx::query(
            "SELECT history_source_instance_id, hook_record_json
             FROM ssh_agent_tool_integrations",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].get::<String, _>("history_source_instance_id"),
            second.source_instance_id
        );
        assert_eq!(rows[0].get::<String, _>("hook_record_json"), "{}");
    }

    #[tokio::test]
    async fn history_source_failure_rolls_back_existing_identity() {
        let mut conn = history_database().await;
        let first = history_source_input('a');
        begin_immediate(&mut conn).await.unwrap();
        let result = record_history_source_with_conn(&mut conn, &first).await;
        finish_transaction(&mut conn, result).await.unwrap();
        sqlx::raw_sql(
            "CREATE TRIGGER reject_history_identity
             BEFORE UPDATE ON ssh_agent_tool_integrations
             BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        begin_immediate(&mut conn).await.unwrap();
        let result = record_history_source_with_conn(&mut conn, &history_source_input('c')).await;
        assert!(finish_transaction(&mut conn, result).await.is_err());

        let stored: String = sqlx::query_scalar(
            "SELECT history_source_instance_id FROM ssh_agent_tool_integrations",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(stored, first.source_instance_id);
    }

    #[tokio::test]
    async fn group_schema_upgrade_is_idempotent() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE ssh_hosts (
               id TEXT PRIMARY KEY, group_name TEXT NOT NULL DEFAULT '',
               sort_order INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ssh_hosts (id, group_name, sort_order, name)
             VALUES ('host-1', 'Production', 0, 'Server')",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        ensure_group_schema_with_conn(&mut conn).await.unwrap();
        ensure_group_schema_with_conn(&mut conn).await.unwrap();

        let group_id: Option<String> =
            sqlx::query_scalar("SELECT group_id FROM ssh_hosts WHERE id = 'host-1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let groups: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM ssh_host_groups WHERE name = 'Production'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert!(group_id.is_some());
        assert_eq!(groups, 1);
    }

    #[tokio::test]
    async fn preference_failure_rolls_back_both_sources() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE ssh_hosts (id TEXT PRIMARY KEY)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO ssh_hosts (id) VALUES ('host-1')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE ssh_host_tool_preferences (
               host_id TEXT NOT NULL REFERENCES ssh_hosts(id),
               source TEXT NOT NULL CHECK(source = 'claude'),
               configured_root TEXT NOT NULL, updated_at TEXT NOT NULL,
               PRIMARY KEY(host_id, source)
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        begin_immediate(&mut conn).await.unwrap();
        let result = save_host_preferences_with_conn(
            &mut conn,
            "host-1",
            "/home/dev/.claude".to_string(),
            "/home/dev/.codex".to_string(),
            "1",
        )
        .await;
        assert!(finish_transaction(&mut conn, result).await.is_err());

        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ssh_host_tool_preferences")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[tokio::test]
    async fn delete_group_moves_children_and_hosts_atomically() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE ssh_host_groups (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
               sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE ssh_hosts (
               id TEXT PRIMARY KEY, group_id TEXT, group_name TEXT NOT NULL DEFAULT ''
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        for statement in [
            "INSERT INTO ssh_host_groups VALUES ('root', 'Root', NULL, 0, '1')",
            "INSERT INTO ssh_host_groups VALUES ('group', 'Group', 'root', 0, '1')",
            "INSERT INTO ssh_host_groups VALUES ('child', 'Child', 'group', 0, '1')",
            "INSERT INTO ssh_hosts VALUES ('host-1', 'group', 'Group')",
        ] {
            sqlx::query(statement).execute(&mut conn).await.unwrap();
        }

        begin_immediate(&mut conn).await.unwrap();
        let result = delete_group_with_conn(&mut conn, "group").await;
        finish_transaction(&mut conn, result).await.unwrap();

        let child_parent: Option<String> =
            sqlx::query_scalar("SELECT parent_id FROM ssh_host_groups WHERE id = 'child'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let host: (Option<String>, String) =
            sqlx::query_as("SELECT group_id, group_name FROM ssh_hosts WHERE id = 'host-1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let deleted: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM ssh_host_groups WHERE id = 'group'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(child_parent.as_deref(), Some("root"));
        assert_eq!(host, (Some("root".to_string()), "Root".to_string()));
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn delete_host_failure_rolls_back_related_tables() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for statement in [
            "CREATE TABLE ssh_hosts (id TEXT PRIMARY KEY, jump_host_id TEXT)",
            "CREATE TABLE projects (id TEXT PRIMARY KEY, ssh_host_id TEXT)",
            "CREATE TABLE ssh_agent_tool_integrations (
               integration_id TEXT PRIMARY KEY, host_id TEXT,
               validation_state TEXT NOT NULL, cleanup_state TEXT NOT NULL
             )",
            "INSERT INTO ssh_hosts VALUES ('host-1', NULL)",
            "INSERT INTO projects VALUES ('project-1', 'host-1')",
            "INSERT INTO ssh_agent_tool_integrations VALUES ('integration-1', 'host-1', 'valid', 'active')",
            "CREATE TRIGGER fail_host_delete BEFORE DELETE ON ssh_hosts
             BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
        ] {
            sqlx::query(statement).execute(&mut conn).await.unwrap();
        }

        begin_immediate(&mut conn).await.unwrap();
        let result = delete_host_with_conn(&mut conn, "host-1").await;
        assert!(finish_transaction(&mut conn, result).await.is_err());

        let project_host: Option<String> =
            sqlx::query_scalar("SELECT ssh_host_id FROM projects WHERE id = 'project-1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let integration: (Option<String>, String, String) = sqlx::query_as(
            "SELECT host_id, validation_state, cleanup_state
             FROM ssh_agent_tool_integrations WHERE integration_id = 'integration-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(project_host.as_deref(), Some("host-1"));
        assert_eq!(
            integration,
            (
                Some("host-1".to_string()),
                "valid".to_string(),
                "active".to_string(),
            )
        );
    }

    #[tokio::test]
    async fn hook_report_failure_rolls_back_retained_root_update() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE ssh_agent_tool_integrations (
               integration_id TEXT PRIMARY KEY, host_id TEXT, installation_id TEXT NOT NULL DEFAULT '',
               remote_machine_id TEXT NOT NULL DEFAULT '', ssh_user TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL, scope_kind TEXT NOT NULL, configured_root TEXT NOT NULL DEFAULT '',
               canonical_root TEXT NOT NULL DEFAULT '', config_root_hash TEXT NOT NULL DEFAULT '',
               hook_record_json TEXT NOT NULL DEFAULT '{}', history_source_instance_id TEXT NOT NULL DEFAULT '',
               validation_state TEXT NOT NULL DEFAULT 'unvalidated', cleanup_state TEXT NOT NULL DEFAULT 'active',
               checked_at TEXT NOT NULL DEFAULT ''
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ssh_agent_tool_integrations (
               integration_id, host_id, source, scope_kind, configured_root, canonical_root,
               hook_record_json, validation_state, cleanup_state
             ) VALUES (
               'old', 'host-1', 'claude', 'hostPrimary', '~/.claude', '/old',
               '{\"managedEntries\":1}', 'valid', 'active'
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_new_root BEFORE INSERT ON ssh_agent_tool_integrations
             WHEN NEW.canonical_root = '/new'
             BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let input = SshHookReportInput {
            host_id: "host-1".to_string(),
            ssh_user: "dev".to_string(),
            configured_root: "~/.claude-new".to_string(),
            source: "claude".to_string(),
            installation_id: "installation-1".to_string(),
            remote_machine_id: "machine-1".to_string(),
            canonical_config_root: "/new".to_string(),
            config_root_hash: "hash-new".to_string(),
            action: "installed".to_string(),
            status: "installed".to_string(),
            report: serde_json::json!({
                "action": "installed",
                "status": "installed",
                "canonicalConfigRoot": "/new",
                "configuredConfigRoot": "~/.claude-new",
                "managedEntries": 1,
                "installation": null
            }),
            integration_id: None,
            scope_kind: "hostPrimary".to_string(),
        };

        begin_immediate(&mut conn).await.unwrap();
        let result = record_hook_report_with_conn(&mut conn, input).await;
        assert!(finish_transaction(&mut conn, result).await.is_err());

        let old: (String, String) = sqlx::query_as(
            "SELECT scope_kind, cleanup_state
             FROM ssh_agent_tool_integrations WHERE integration_id = 'old'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ssh_agent_tool_integrations")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(old, ("hostPrimary".to_string(), "active".to_string()));
        assert_eq!(rows, 1);
    }
}
