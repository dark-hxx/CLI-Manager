use crate::app_paths;
use crate::{
    MIGRATION_ADD_CLI_ARGS_DESCRIPTION, MIGRATION_ADD_CLI_ARGS_SQL, MIGRATION_ADD_CLI_ARGS_VERSION,
    MIGRATION_ADD_GROUP_BOUND_PATH_DESCRIPTION, MIGRATION_ADD_GROUP_BOUND_PATH_SQL,
    MIGRATION_ADD_GROUP_BOUND_PATH_VERSION, MIGRATION_ADD_PROJECT_PATH_MODE_DESCRIPTION,
    MIGRATION_ADD_PROJECT_PATH_MODE_SQL, MIGRATION_ADD_PROJECT_PATH_MODE_VERSION,
    MIGRATION_ADD_SSH_ATTACHMENT_ROOT_DESCRIPTION, MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL,
    MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION, MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION,
    MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL, MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION,
    MIGRATION_ADD_WORKTREE_ISOLATION_DESCRIPTION, MIGRATION_ADD_WORKTREE_ISOLATION_SQL,
    MIGRATION_ADD_WORKTREE_ISOLATION_VERSION, MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL,
    MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION,
    MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_DESCRIPTION,
    MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_SQL,
    MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_VERSION, MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION,
    MIGRATION_CREATE_SSH_HOSTS_SQL, MIGRATION_CREATE_SSH_HOSTS_VERSION,
    MIGRATION_CREATE_SSH_HOST_GROUPS_DESCRIPTION, MIGRATION_CREATE_SSH_HOST_GROUPS_SQL,
    MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION, NODE_APPEARANCE_MIGRATION_DESCRIPTION,
    NODE_APPEARANCE_MIGRATION_SQL, NODE_APPEARANCE_MIGRATION_VERSION,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha384};
use sqlx::sqlite::{SqliteConnectOptions, SqliteRow};
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const SQLX_MIGRATIONS_TABLE: &str = "_sqlx_migrations";
const KNOWN_DRIFT_START_VERSION: i64 = 13;
const KNOWN_DRIFT_END_VERSION: i64 = 15;
const REPLAY_SNAPSHOT_PATCH_DIR: &str = "replay-snapshots";
const REPLAY_SNAPSHOT_PATCH_STORAGE: &str = "file";
const REPLAY_SNAPSHOT_CLEANUP_MARKER_FILE: &str = "replay-snapshot-patch-cleanup.version";
const LEGACY_MODEL_PRICES_MIGRATION_MARKER_FILE: &str = "legacy-model-prices-migration-v1.version";
const DB_FILE_NAME: &str = "cli-manager.db";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const USER_DATA_TABLES: [&str; 3] = ["projects", "groups", "command_templates"];
const REQUEST_LOG_PROJECT_PATH_BACKFILL_DESCRIPTION: &str = "backfill_request_log_project_path";
const REQUEST_LOG_PROJECT_PATH_BACKFILL_BATCH_SIZE: i64 = 2_000;
const REQUEST_LOG_PROJECT_PATH_BACKFILL_YIELD_MS: u64 = 10;
static REQUEST_LOG_PROJECT_PATH_BACKFILL_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

const FAVORITE_SNAPSHOT_COLUMNS: [&str; 11] = [
    "session_key",
    "session_id",
    "source",
    "project_key",
    "file_path",
    "title",
    "created_at",
    "updated_at",
    "message_count",
    "detail_json",
    "snapshot_at",
];

const WORKTREE_PROJECT_COLUMNS: [&str; 2] = ["worktree_strategy", "worktree_root"];
const WORKTREE_COLUMNS: [&str; 10] = [
    "id",
    "project_id",
    "name",
    "branch",
    "path",
    "base_branch",
    "deps_prompt_dismissed",
    "status",
    "created_at",
    "updated_at",
];
const SSH_PROJECT_COLUMNS: [&str; 3] = ["environment_type", "ssh_host_id", "remote_path"];
const SSH_HOST_COLUMNS: [&str; 25] = [
    "id",
    "name",
    "group_name",
    "host",
    "port",
    "username",
    "config_alias",
    "auth_mode",
    "identity_file",
    "credential_ref",
    "jump_mode",
    "jump_host_id",
    "proxy_type",
    "proxy_host",
    "proxy_port",
    "proxy_command",
    "connect_timeout_sec",
    "server_alive_interval_sec",
    "server_alive_count_max",
    "terminal_encoding",
    "startup_script",
    "notes",
    "sort_order",
    "created_at",
    "updated_at",
];
const SSH_HOST_GROUP_COLUMNS: [&str; 5] = ["id", "name", "parent_id", "sort_order", "created_at"];

#[derive(Debug, Clone, PartialEq, Eq)]
struct MigrationRow {
    version: i64,
    description: String,
    checksum: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExpectedMigration {
    version: i64,
    description: &'static str,
    sql: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchemaState {
    Absent,
    Complete,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SchemaFeatures {
    favorite_snapshots: SchemaState,
    cli_args: SchemaState,
    worktree_isolation: SchemaState,
    ssh_hosts: SchemaState,
    ssh_host_groups: SchemaState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbMigrationRepairResult {
    repaired: bool,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbProjectPathBackfillResult {
    updated_rows: u64,
    mapped_project_keys: usize,
}

#[tauri::command]
pub async fn db_repair_known_migration_drift(
    app: AppHandle,
) -> Result<DbMigrationRepairResult, String> {
    let db_path = app_paths::db_path()?;
    let legacy_db_path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|old_db_dir| old_db_dir.join(DB_FILE_NAME));
    let legacy_db_recovered = match legacy_db_path.as_ref() {
        Some(legacy_db_path) => {
            match recover_legacy_db_file_if_current_empty(legacy_db_path, &db_path).await {
                Ok(recovered) => recovered,
                Err(err) => {
                    log::warn!("Legacy CLI-Manager DB recovery skipped: {err}");
                    false
                }
            }
        }
        None => false,
    };

    if !db_path.is_file() {
        return Ok(DbMigrationRepairResult {
            repaired: legacy_db_recovered,
            status: "db_missing".to_string(),
        });
    }

    let mut conn = open_cli_manager_db(&db_path).await?;
    let mut result = repair_known_migration_drift(&mut conn).await?;
    if reconcile_legacy_node_appearance_v33_migration(&mut conn).await? {
        result.repaired = true;
        result.status = append_repair_status(
            &result.status,
            "reconciled_legacy_node_appearance_v33_migration",
        );
    }
    if ensure_node_appearance_columns(&mut conn).await? {
        result.repaired = true;
        result.status = append_repair_status(&result.status, "repaired_node_appearance_columns");
    }
    if ensure_group_binding_columns(&mut conn).await? {
        result.repaired = true;
        result.status = append_repair_status(&result.status, "repaired_group_binding_columns");
    }
    if ensure_ssh_attachment_root_column(&mut conn).await? {
        result.repaired = true;
        result.status = append_repair_status(&result.status, "repaired_ssh_attachment_root_column");
    }
    if defer_request_log_project_path_backfill(&mut conn).await? {
        result.repaired = true;
        result.status =
            append_repair_status(&result.status, "deferred_request_log_project_path_backfill");
    }
    conn.close()
        .await
        .map_err(|err| format!("db_close_failed: {err}"))?;
    if legacy_db_recovered {
        result.repaired = true;
        result.status = if result.status == "already_consistent" {
            "legacy_db_recovered".to_string()
        } else {
            format!("legacy_db_recovered;{}", result.status)
        };
    }
    if let Some(legacy_db_path) = legacy_db_path.as_ref() {
        match merge_legacy_model_prices_once(
            legacy_db_path,
            &db_path,
            &app_paths::cli_manager_data_dir()?,
        )
        .await
        {
            Ok(merged) if merged > 0 => {
                result.repaired = true;
                result.status = if result.status == "already_consistent" {
                    format!("legacy_model_prices_merged_{merged}")
                } else {
                    format!("{};legacy_model_prices_merged_{merged}", result.status)
                };
            }
            Ok(_) => {}
            Err(err) => log::warn!("Legacy model price migration skipped: {err}"),
        }
    }
    let mut conn = open_cli_manager_db(&db_path).await?;
    match cleanup_replay_snapshot_inline_patches_for_current_version(
        &mut conn,
        &app_paths::cli_manager_data_dir()?,
    )
    .await
    {
        Ok(migrated) if migrated > 0 => {
            result.repaired = true;
            result.status = if result.status == "already_consistent" {
                format!("replay_snapshot_patch_cleanup_migrated_{migrated}")
            } else {
                format!(
                    "{};replay_snapshot_patch_cleanup_migrated_{migrated}",
                    result.status
                )
            };
        }
        Ok(_) => {}
        Err(err) => {
            log::warn!("Replay snapshot patch cleanup skipped: {err}");
        }
    }
    Ok(result)
}

fn append_repair_status(current: &str, next: &str) -> String {
    if current == "already_consistent" {
        next.to_string()
    } else {
        format!("{current};{next}")
    }
}

/// 将本地旧版外观迁移 v33 迁移为远端的用量诊断 v33。
///
/// 两条分支曾独立占用 v33。仅把外观迁移改为 v34 会让已登记旧外观 v33 的数据库在 SQLx
/// 校验 checksum 时启动失败。确认登记项确实是旧外观 SQL 后，先运行用量 schema bootstrap，
/// 再把 v33 的登记项切换为用量诊断 SQL；随后由 v34 外观列修复登记当前外观迁移。
async fn reconcile_legacy_node_appearance_v33_migration(
    conn: &mut SqliteConnection,
) -> Result<bool, String> {
    if !table_exists(conn, SQLX_MIGRATIONS_TABLE).await? {
        return Ok(false);
    }

    let legacy_marker = sqlx::query(
        "SELECT description, checksum
         FROM _sqlx_migrations
         WHERE version = ?1 AND success = 1
         LIMIT 1",
    )
    .bind(MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("legacy_node_appearance_v33_query_failed: {err}"))?;
    let Some(legacy_marker) = legacy_marker else {
        return Ok(false);
    };
    let description: String = legacy_marker
        .try_get("description")
        .map_err(|err| format!("legacy_node_appearance_v33_description_failed: {err}"))?;
    let checksum: Vec<u8> = legacy_marker
        .try_get("checksum")
        .map_err(|err| format!("legacy_node_appearance_v33_checksum_failed: {err}"))?;
    if description != NODE_APPEARANCE_MIGRATION_DESCRIPTION
        || checksum != migration_checksum(NODE_APPEARANCE_MIGRATION_SQL)
    {
        return Ok(false);
    }

    crate::usage_schema::ensure_usage_schema(conn)
        .await
        .map_err(|err| format!("legacy_node_appearance_v33_usage_schema_failed: {err}"))?;
    sqlx::query(
        "UPDATE _sqlx_migrations
         SET description = ?1, checksum = ?2
         WHERE version = ?3 AND success = 1",
    )
    .bind(MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION)
    .bind(migration_checksum(MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL))
    .bind(MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("legacy_node_appearance_v33_update_failed: {err}"))?;
    Ok(true)
}

/// 外观列缺失自愈（issue #213）。
///
/// migration 34 只做四条 `ADD COLUMN`。如果历史库出现"版本已登记但列不存在"或"列存在但版本未登记"
/// 的漂移，前者会让外观读写一直报 `no such column: color`，后者会让 sqlx 重放 ALTER 撞
/// `duplicate column name`。这里在每次打开数据库前主动把两种漂移都补齐：
/// 缺列就补列，版本未登记时按同一 checksum 登记，让 sqlx 跳过重放。
async fn ensure_node_appearance_columns(conn: &mut SqliteConnection) -> Result<bool, String> {
    if !table_exists(conn, SQLX_MIGRATIONS_TABLE).await?
        || !table_exists(conn, "groups").await?
        || !table_exists(conn, "projects").await?
    {
        return Ok(false);
    }

    let group_columns = table_columns(conn, "groups").await?;
    let project_columns = table_columns(conn, "projects").await?;
    let mut missing: Vec<&str> = Vec::new();
    if !group_columns.contains("icon") {
        missing.push("ALTER TABLE groups ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
    }
    if !group_columns.contains("color") {
        missing.push("ALTER TABLE groups ADD COLUMN color TEXT NOT NULL DEFAULT ''");
    }
    if !project_columns.contains("icon") {
        missing.push("ALTER TABLE projects ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
    }
    if !project_columns.contains("color") {
        missing.push("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT ''");
    }

    let already_registered: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM _sqlx_migrations
             WHERE version = ?1 AND success = 1
         )",
    )
    .bind(NODE_APPEARANCE_MIGRATION_VERSION)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("node_appearance_migration_query_failed: {err}"))?;

    // 列齐全且版本已登记：正常状态，什么都不做。
    if missing.is_empty() && already_registered != 0 {
        return Ok(false);
    }

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("node_appearance_repair_begin_failed: {err}"))?;
    let result = async {
        for statement in &missing {
            sqlx::query(statement)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("node_appearance_repair_alter_failed: {err}"))?;
        }
        if already_registered == 0 {
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                     (version, description, installed_on, success, checksum, execution_time)
                 VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
            )
            .bind(NODE_APPEARANCE_MIGRATION_VERSION)
            .bind(NODE_APPEARANCE_MIGRATION_DESCRIPTION)
            .bind(migration_checksum(NODE_APPEARANCE_MIGRATION_SQL))
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("node_appearance_repair_register_failed: {err}"))?;
        }
        Ok::<(), String>(())
    }
    .await;

    match result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("node_appearance_repair_commit_failed: {err}"))?;
            Ok(true)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

/// 文件夹绑定路径与项目路径模式的列缺失自愈。
///
/// 绑定路径迁移在 SQLx `Database.load` 前无法依赖插件自动执行：已存在的旧库可能已经
/// 登记了后续迁移，或迁移登记与实际列发生漂移。先补齐列并登记对应 checksum，确保
/// 前端首次写入分组时不会撞到 `no such column: bound_path`。
async fn ensure_group_binding_columns(conn: &mut SqliteConnection) -> Result<bool, String> {
    if !table_exists(conn, SQLX_MIGRATIONS_TABLE).await?
        || !table_exists(conn, "groups").await?
        || !table_exists(conn, "projects").await?
    {
        return Ok(false);
    }

    let group_columns = table_columns(conn, "groups").await?;
    let project_columns = table_columns(conn, "projects").await?;
    let mut missing_statements: Vec<&str> = Vec::new();
    if !group_columns.contains("bound_path") {
        missing_statements.push(MIGRATION_ADD_GROUP_BOUND_PATH_SQL);
    }
    if !project_columns.contains("path_mode") {
        missing_statements.push(MIGRATION_ADD_PROJECT_PATH_MODE_SQL);
    }

    let migrations = [
        (
            MIGRATION_ADD_GROUP_BOUND_PATH_VERSION,
            MIGRATION_ADD_GROUP_BOUND_PATH_DESCRIPTION,
            MIGRATION_ADD_GROUP_BOUND_PATH_SQL,
        ),
        (
            MIGRATION_ADD_PROJECT_PATH_MODE_VERSION,
            MIGRATION_ADD_PROJECT_PATH_MODE_DESCRIPTION,
            MIGRATION_ADD_PROJECT_PATH_MODE_SQL,
        ),
    ];
    let mut unregistered = Vec::new();
    for (version, description, sql) in migrations {
        let registered: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
                 SELECT 1 FROM _sqlx_migrations
                 WHERE version = ?1 AND success = 1
             )",
        )
        .bind(version)
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| format!("group_binding_migration_query_failed: {err}"))?;
        if registered == 0 {
            unregistered.push((version, description, sql));
        }
    }

    if missing_statements.is_empty() && unregistered.is_empty() {
        return Ok(false);
    }

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("group_binding_repair_begin_failed: {err}"))?;
    let result = async {
        for statement in &missing_statements {
            sqlx::query(statement)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("group_binding_repair_alter_failed: {err}"))?;
        }
        for (version, description, sql) in &unregistered {
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                     (version, description, installed_on, success, checksum, execution_time)
                 VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
            )
            .bind(version)
            .bind(description)
            .bind(migration_checksum(sql))
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("group_binding_repair_register_failed: {err}"))?;
        }
        Ok::<(), String>(())
    }
    .await;

    match result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("group_binding_repair_commit_failed: {err}"))?;
            Ok(true)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

/// SSH Host 附件目录列缺失自愈。
///
/// migration 37 只有一条 `ADD COLUMN`。如果旧库在 migration 登记与实际 schema 之间发生漂移，
/// 编辑 SSH Host 时读取 `attachment_root` 会直接失败；这里在 SQLx `Database.load` 前同时修复
/// “列缺失但版本已登记”、“列存在但版本未登记”和“两者都缺失”三种状态。
async fn ensure_ssh_attachment_root_column(conn: &mut SqliteConnection) -> Result<bool, String> {
    if !table_exists(conn, SQLX_MIGRATIONS_TABLE).await? || !table_exists(conn, "ssh_hosts").await?
    {
        return Ok(false);
    }

    let columns = table_columns(conn, "ssh_hosts").await?;
    let has_column = columns.contains("attachment_root");
    let registered: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM _sqlx_migrations
             WHERE version = ?1 AND success = 1
         )",
    )
    .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("ssh_attachment_root_migration_query_failed: {err}"))?;

    if has_column && registered != 0 {
        return Ok(false);
    }

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("ssh_attachment_root_repair_begin_failed: {err}"))?;
    let result = async {
        if !has_column {
            sqlx::query(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("ssh_attachment_root_repair_alter_failed: {err}"))?;
        }
        if registered == 0 {
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                     (version, description, installed_on, success, checksum, execution_time)
                 VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
            )
            .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION)
            .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_DESCRIPTION)
            .bind(migration_checksum(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL))
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("ssh_attachment_root_repair_register_failed: {err}"))?;
        }
        Ok::<(), String>(())
    }
    .await;

    match result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("ssh_attachment_root_repair_commit_failed: {err}"))?;
            Ok(true)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

async fn defer_request_log_project_path_backfill(
    conn: &mut SqliteConnection,
) -> Result<bool, String> {
    if !table_exists(conn, SQLX_MIGRATIONS_TABLE).await?
        || !table_exists(conn, "usage_records").await?
        || !table_columns(conn, "usage_records")
            .await?
            .contains("project_path")
    {
        return Ok(false);
    }

    let already_applied: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM _sqlx_migrations
             WHERE version = ?1 AND success = 1
         )",
    )
    .bind(MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("request_log_backfill_migration_query_failed: {err}"))?;
    if already_applied != 0 {
        return Ok(false);
    }

    let has_legacy_rows: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM usage_records LIMIT 1)")
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("request_log_backfill_legacy_query_failed: {err}"))?;
    if has_legacy_rows == 0 {
        return Ok(false);
    }

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("request_log_backfill_defer_begin_failed: {err}"))?;
    let result = sqlx::query(
        "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
         VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
    )
    .bind(MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION)
    .bind(REQUEST_LOG_PROJECT_PATH_BACKFILL_DESCRIPTION)
    .bind(migration_checksum(
        MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL,
    ))
    .execute(&mut *conn)
    .await;

    match result {
        Ok(_) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("request_log_backfill_defer_commit_failed: {err}"))?;
            Ok(true)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(format!("request_log_backfill_defer_insert_failed: {err}"))
        }
    }
}

#[tauri::command]
pub async fn db_backfill_request_log_project_paths() -> Result<DbProjectPathBackfillResult, String>
{
    let _guard = REQUEST_LOG_PROJECT_PATH_BACKFILL_LOCK.lock().await;
    let db_path = app_paths::db_path()?;
    if !db_path.is_file() {
        return Ok(DbProjectPathBackfillResult {
            updated_rows: 0,
            mapped_project_keys: 0,
        });
    }

    let mut conn = open_cli_manager_db(&db_path).await?;
    let result = backfill_request_log_project_paths(&mut conn).await;
    conn.close()
        .await
        .map_err(|err| format!("db_close_failed: {err}"))?;
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackfillProject {
    name: String,
    path: String,
}

fn normalize_backfill_path(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn is_absolute_backfill_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with('/') || (bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/')
}

fn resolve_backfill_project_path(key: &str, projects: &[BackfillProject]) -> Option<String> {
    let normalized_key = normalize_backfill_path(key);
    if normalized_key.is_empty() {
        return None;
    }
    if is_absolute_backfill_path(&normalized_key) {
        return Some(normalized_key);
    }

    let project_name = key.trim().to_lowercase();
    let suffix = format!("/{normalized_key}");
    let candidates = projects
        .iter()
        .filter(|project| {
            project.name == project_name
                || project.path == normalized_key
                || project.path.ends_with(&suffix)
        })
        .map(|project| project.path.clone())
        .collect::<BTreeSet<_>>();
    (candidates.len() == 1).then(|| candidates.into_iter().next().unwrap())
}

async fn backfill_request_log_project_paths(
    conn: &mut SqliteConnection,
) -> Result<DbProjectPathBackfillResult, String> {
    if !table_exists(conn, "usage_records").await?
        || !table_exists(conn, "projects").await?
        || !table_columns(conn, "usage_records")
            .await?
            .contains("project_path")
    {
        return Ok(DbProjectPathBackfillResult {
            updated_rows: 0,
            mapped_project_keys: 0,
        });
    }

    let project_rows = sqlx::query(
        "SELECT name, path
         FROM projects
         WHERE COALESCE(environment_type, 'local') <> 'ssh'
           AND NULLIF(TRIM(path), '') IS NOT NULL",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("request_log_backfill_projects_failed: {err}"))?;
    let projects = project_rows
        .into_iter()
        .filter_map(|row| {
            let name = row.try_get::<String, _>("name").ok()?.trim().to_lowercase();
            let path = normalize_backfill_path(&row.try_get::<String, _>("path").ok()?);
            (!path.is_empty()).then_some(BackfillProject { name, path })
        })
        .collect::<Vec<_>>();

    let key_rows = sqlx::query(
        "SELECT DISTINCT project_key
         FROM usage_records
         WHERE NULLIF(TRIM(project_path), '') IS NULL
           AND NULLIF(TRIM(project_key), '') IS NOT NULL",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("request_log_backfill_keys_failed: {err}"))?;

    let mappings = key_rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("project_key").ok())
        .filter_map(|key| resolve_backfill_project_path(&key, &projects).map(|path| (key, path)))
        .collect::<Vec<_>>();

    sqlx::query(
        "CREATE TEMP TABLE IF NOT EXISTS request_log_project_path_backfill_queue (
             record_rowid INTEGER PRIMARY KEY,
             project_path TEXT NOT NULL
         ) WITHOUT ROWID",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("request_log_backfill_queue_create_failed: {err}"))?;
    sqlx::query("DELETE FROM request_log_project_path_backfill_queue")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("request_log_backfill_queue_reset_failed: {err}"))?;
    for (project_key, project_path) in &mappings {
        sqlx::query(
            "INSERT OR IGNORE INTO request_log_project_path_backfill_queue
                 (record_rowid, project_path)
             SELECT rowid, ?1
             FROM usage_records
             WHERE project_key = ?2
               AND NULLIF(TRIM(project_path), '') IS NULL",
        )
        .bind(project_path)
        .bind(project_key)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("request_log_backfill_queue_fill_failed: {err}"))?;
    }

    let mut updated_rows = 0_u64;
    loop {
        let rowids = sqlx::query_scalar::<_, i64>(
            "SELECT record_rowid
             FROM request_log_project_path_backfill_queue
             ORDER BY record_rowid
             LIMIT ?1",
        )
        .bind(REQUEST_LOG_PROJECT_PATH_BACKFILL_BATCH_SIZE)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("request_log_backfill_batch_query_failed: {err}"))?;
        let Some(last_rowid) = rowids.last().copied() else {
            break;
        };
        let affected = sqlx::query(
            "UPDATE usage_records AS target
             SET project_path = (
                 SELECT queued.project_path
                 FROM request_log_project_path_backfill_queue AS queued
                 WHERE queued.record_rowid = target.rowid
             )
             WHERE target.rowid IN (
                 SELECT record_rowid
                 FROM request_log_project_path_backfill_queue
                 ORDER BY record_rowid
                 LIMIT ?1
             )
               AND NULLIF(TRIM(target.project_path), '') IS NULL",
        )
        .bind(REQUEST_LOG_PROJECT_PATH_BACKFILL_BATCH_SIZE)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("request_log_backfill_batch_update_failed: {err}"))?
        .rows_affected();
        updated_rows += affected;
        sqlx::query("DELETE FROM request_log_project_path_backfill_queue WHERE record_rowid <= ?1")
            .bind(last_rowid)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("request_log_backfill_queue_advance_failed: {err}"))?;
        tokio::time::sleep(Duration::from_millis(
            REQUEST_LOG_PROJECT_PATH_BACKFILL_YIELD_MS,
        ))
        .await;
    }
    sqlx::query("DROP TABLE request_log_project_path_backfill_queue")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("request_log_backfill_queue_drop_failed: {err}"))?;

    updated_rows += backfill_route_project_paths(conn).await?;
    log::info!(
        "Request-log project-path background backfill completed: updated_rows={updated_rows}, mapped_project_keys={}",
        mappings.len()
    );
    Ok(DbProjectPathBackfillResult {
        updated_rows,
        mapped_project_keys: mappings.len(),
    })
}

async fn backfill_route_project_paths(conn: &mut SqliteConnection) -> Result<u64, String> {
    let mut after_rowid = 0_i64;
    let mut updated_rows = 0_u64;
    loop {
        let rowids = sqlx::query_scalar::<_, i64>(
            "SELECT rowid
             FROM usage_records
             WHERE rowid > ?1
               AND data_source = 'route'
               AND NULLIF(TRIM(project_path), '') IS NULL
               AND NULLIF(TRIM(session_id), '') IS NOT NULL
             ORDER BY rowid
             LIMIT ?2",
        )
        .bind(after_rowid)
        .bind(REQUEST_LOG_PROJECT_PATH_BACKFILL_BATCH_SIZE)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("request_log_route_backfill_query_failed: {err}"))?;
        let Some(last_rowid) = rowids.last().copied() else {
            break;
        };
        let first_rowid = rowids[0];
        let affected = sqlx::query(
            "UPDATE usage_records AS target
             SET project_path = (
                 SELECT session.project_path
                 FROM usage_records AS session
                 WHERE session.data_source = 'session_log'
                   AND session.source = target.source
                   AND session.session_id = target.session_id
                   AND NULLIF(TRIM(session.project_path), '') IS NOT NULL
                 ORDER BY session.updated_at_ms DESC
                 LIMIT 1
             )
             WHERE target.rowid BETWEEN ?1 AND ?2
               AND target.data_source = 'route'
               AND NULLIF(TRIM(target.project_path), '') IS NULL
               AND EXISTS (
                   SELECT 1
                   FROM usage_records AS session
                   WHERE session.data_source = 'session_log'
                     AND session.source = target.source
                     AND session.session_id = target.session_id
                     AND NULLIF(TRIM(session.project_path), '') IS NOT NULL
               )",
        )
        .bind(first_rowid)
        .bind(last_rowid)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("request_log_route_backfill_update_failed: {err}"))?
        .rows_affected();
        updated_rows += affected;
        after_rowid = last_rowid;
        tokio::time::sleep(Duration::from_millis(
            REQUEST_LOG_PROJECT_PATH_BACKFILL_YIELD_MS,
        ))
        .await;
    }
    Ok(updated_rows)
}

async fn open_cli_manager_db(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("db_open_failed: {err}"))
}

fn backup_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("backup-{millis}")
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut raw = path.as_os_str().to_os_string();
    raw.push(suffix);
    PathBuf::from(raw)
}

fn backup_db_file_family(path: &Path) -> Result<(), String> {
    for candidate in [
        path.to_path_buf(),
        sqlite_sidecar_path(path, "-wal"),
        sqlite_sidecar_path(path, "-shm"),
    ] {
        if !candidate.is_file() {
            continue;
        }
        let file_name = candidate
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "legacy_db_backup_invalid_path".to_string())?;
        let backup_path = candidate.with_file_name(format!("{file_name}.{}", backup_suffix()));
        fs::copy(&candidate, backup_path)
            .map_err(|err| format!("legacy_db_backup_failed: {err}"))?;
    }
    Ok(())
}

fn copy_db_file_family(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("legacy_db_parent_create_failed: {err}"))?;
    }
    backup_db_file_family(target)?;
    fs::copy(source, target).map_err(|err| format!("legacy_db_copy_failed: {err}"))?;

    for suffix in ["-wal", "-shm"] {
        let source_sidecar = sqlite_sidecar_path(source, suffix);
        let target_sidecar = sqlite_sidecar_path(target, suffix);
        if source_sidecar.is_file() {
            fs::copy(&source_sidecar, &target_sidecar)
                .map_err(|err| format!("legacy_db_sidecar_copy_failed: {err}"))?;
        } else if target_sidecar.exists() {
            fs::remove_file(&target_sidecar)
                .map_err(|err| format!("legacy_db_sidecar_remove_failed: {err}"))?;
        }
    }
    Ok(())
}

async fn user_data_row_count(path: &Path) -> Result<i64, String> {
    if !path.is_file() {
        return Ok(0);
    }
    let mut conn = open_cli_manager_db(path).await?;
    let mut total = 0_i64;
    for table in USER_DATA_TABLES {
        if !table_exists(&mut conn, table).await? {
            continue;
        }
        let sql = format!("SELECT COUNT(*) AS count FROM {table}");
        let row = sqlx::query(&sql)
            .fetch_one(&mut conn)
            .await
            .map_err(|err| format!("legacy_db_count_failed: {err}"))?;
        let count: i64 = row
            .try_get("count")
            .map_err(|err| format!("legacy_db_count_row_failed: {err}"))?;
        total += count;
    }
    Ok(total)
}

async fn recover_legacy_db_file_if_current_empty(
    legacy_db_path: &Path,
    current_db_path: &Path,
) -> Result<bool, String> {
    if !legacy_db_path.is_file() {
        return Ok(false);
    }

    let legacy_rows = user_data_row_count(legacy_db_path).await?;
    if legacy_rows == 0 {
        return Ok(false);
    }

    let current_rows = user_data_row_count(current_db_path).await?;
    if current_rows > 0 {
        return Ok(false);
    }

    copy_db_file_family(legacy_db_path, current_db_path)?;
    Ok(true)
}

fn legacy_model_prices_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LEGACY_MODEL_PRICES_MIGRATION_MARKER_FILE)
}

async fn merge_legacy_model_prices_once(
    legacy_db_path: &Path,
    current_db_path: &Path,
    data_dir: &Path,
) -> Result<u64, String> {
    let marker_path = legacy_model_prices_marker_path(data_dir);
    if marker_path.is_file() || !legacy_db_path.is_file() || !current_db_path.is_file() {
        return Ok(0);
    }

    let mut legacy = open_cli_manager_db(legacy_db_path).await?;
    if !table_exists(&mut legacy, "model_prices").await? {
        fs::create_dir_all(data_dir)
            .map_err(|err| format!("legacy_model_prices_marker_dir_failed: {err}"))?;
        fs::write(&marker_path, APP_VERSION)
            .map_err(|err| format!("legacy_model_prices_marker_write_failed: {err}"))?;
        return Ok(0);
    }
    let rows = sqlx::query(
        "SELECT model, input_per_1m, output_per_1m, cache_read_per_1m,
                cache_creation_per_1m, source, source_model_id, raw_json,
                updated_at_ms, synced_at_ms
         FROM model_prices",
    )
    .fetch_all(&mut legacy)
    .await
    .map_err(|err| format!("legacy_model_prices_read_failed: {err}"))?;
    legacy
        .close()
        .await
        .map_err(|err| format!("legacy_model_prices_close_failed: {err}"))?;

    if rows.is_empty() {
        fs::create_dir_all(data_dir)
            .map_err(|err| format!("legacy_model_prices_marker_dir_failed: {err}"))?;
        fs::write(&marker_path, APP_VERSION)
            .map_err(|err| format!("legacy_model_prices_marker_write_failed: {err}"))?;
        return Ok(0);
    }

    backup_db_file_family(current_db_path)?;
    let mut current = open_cli_manager_db(current_db_path).await?;
    if !table_exists(&mut current, "model_prices").await? {
        return Err("current_model_prices_table_missing".to_string());
    }
    let mut transaction = current
        .begin()
        .await
        .map_err(|err| format!("legacy_model_prices_transaction_failed: {err}"))?;
    let mut merged = 0_u64;
    for row in rows {
        let result = sqlx::query(
            "INSERT INTO model_prices (
                model, input_per_1m, output_per_1m, cache_read_per_1m,
                cache_creation_per_1m, source, source_model_id, raw_json,
                updated_at_ms, synced_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(model) DO UPDATE SET
                input_per_1m = excluded.input_per_1m,
                output_per_1m = excluded.output_per_1m,
                cache_read_per_1m = excluded.cache_read_per_1m,
                cache_creation_per_1m = excluded.cache_creation_per_1m,
                source = excluded.source,
                source_model_id = excluded.source_model_id,
                raw_json = excluded.raw_json,
                updated_at_ms = excluded.updated_at_ms,
                synced_at_ms = excluded.synced_at_ms
             WHERE model_prices.source = 'builtin' AND excluded.source <> 'builtin'",
        )
        .bind(
            row.try_get::<String, _>("model")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<f64, _>("input_per_1m")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<f64, _>("output_per_1m")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<f64, _>("cache_read_per_1m")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<f64, _>("cache_creation_per_1m")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<String, _>("source")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<Option<String>, _>("source_model_id")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<Option<String>, _>("raw_json")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<i64, _>("updated_at_ms")
                .map_err(|err| err.to_string())?,
        )
        .bind(
            row.try_get::<Option<i64>, _>("synced_at_ms")
                .map_err(|err| err.to_string())?,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|err| format!("legacy_model_prices_merge_failed: {err}"))?;
        merged += result.rows_affected();
    }
    transaction
        .commit()
        .await
        .map_err(|err| format!("legacy_model_prices_commit_failed: {err}"))?;
    current
        .close()
        .await
        .map_err(|err| format!("legacy_model_prices_current_close_failed: {err}"))?;

    fs::create_dir_all(data_dir)
        .map_err(|err| format!("legacy_model_prices_marker_dir_failed: {err}"))?;
    fs::write(&marker_path, APP_VERSION)
        .map_err(|err| format!("legacy_model_prices_marker_write_failed: {err}"))?;
    Ok(merged)
}

async fn repair_known_migration_drift(
    conn: &mut SqliteConnection,
) -> Result<DbMigrationRepairResult, String> {
    if !table_exists(conn, SQLX_MIGRATIONS_TABLE).await? {
        return Ok(DbMigrationRepairResult {
            repaired: false,
            status: "migration_table_missing".to_string(),
        });
    }

    let features = detect_schema_features(conn).await?;
    let expected = expected_migrations_for_features(&features)?;
    let existing = read_known_migration_rows(conn).await?;

    if existing == expected_rows(&expected) {
        return Ok(DbMigrationRepairResult {
            repaired: false,
            status: "already_consistent".to_string(),
        });
    }

    rewrite_known_migration_rows(conn, &expected).await?;
    Ok(DbMigrationRepairResult {
        repaired: true,
        status: "repaired_known_migration_drift".to_string(),
    })
}

async fn cleanup_replay_snapshot_inline_patches(
    conn: &mut SqliteConnection,
    data_dir: &Path,
) -> Result<usize, String> {
    if !table_exists(conn, "ai_replay_events").await? {
        return Ok(0);
    }

    let rows = sqlx::query(
        "SELECT id, session_key, event_index, payload_json
         FROM ai_replay_events
         WHERE kind = 'snapshot' AND payload_json LIKE ?1
         ORDER BY id",
    )
    .bind("%\"patch\"%")
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("replay_snapshot_cleanup_query_failed: {err}"))?;

    if rows.is_empty() {
        return Ok(0);
    }

    fs::create_dir_all(data_dir.join(REPLAY_SNAPSHOT_PATCH_DIR))
        .map_err(|err| format!("replay_snapshot_cleanup_dir_failed: {err}"))?;

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("replay_snapshot_cleanup_begin_failed: {err}"))?;

    let result = cleanup_replay_snapshot_inline_patches_in_transaction(conn, data_dir, &rows).await;
    if result.is_ok() {
        sqlx::query("COMMIT")
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("replay_snapshot_cleanup_commit_failed: {err}"))?;
    } else {
        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
    }

    let migrated = result?;
    if migrated > 0 {
        let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&mut *conn)
            .await;
        if let Err(err) = sqlx::query("VACUUM").execute(&mut *conn).await {
            log::warn!("Replay snapshot DB vacuum skipped: {err}");
        }
        let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&mut *conn)
            .await;
    }

    Ok(migrated)
}

async fn cleanup_replay_snapshot_inline_patches_for_current_version(
    conn: &mut SqliteConnection,
    data_dir: &Path,
) -> Result<usize, String> {
    if replay_snapshot_cleanup_marker_path(data_dir).is_file()
        && fs::read_to_string(replay_snapshot_cleanup_marker_path(data_dir))
            .map(|value| value.trim() == APP_VERSION)
            .unwrap_or(false)
    {
        return Ok(0);
    }

    let migrated = cleanup_replay_snapshot_inline_patches(conn, data_dir).await?;
    fs::create_dir_all(data_dir)
        .map_err(|err| format!("replay_snapshot_cleanup_marker_dir_failed: {err}"))?;
    fs::write(replay_snapshot_cleanup_marker_path(data_dir), APP_VERSION)
        .map_err(|err| format!("replay_snapshot_cleanup_marker_write_failed: {err}"))?;
    Ok(migrated)
}

fn replay_snapshot_cleanup_marker_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(REPLAY_SNAPSHOT_CLEANUP_MARKER_FILE)
}

async fn cleanup_replay_snapshot_inline_patches_in_transaction(
    conn: &mut SqliteConnection,
    data_dir: &Path,
    rows: &[SqliteRow],
) -> Result<usize, String> {
    let mut migrated = 0usize;

    for row in rows {
        let id: i64 = row
            .try_get("id")
            .map_err(|err| format!("replay_snapshot_cleanup_row_failed: {err}"))?;
        let session_key: String = row
            .try_get("session_key")
            .map_err(|err| format!("replay_snapshot_cleanup_row_failed: {err}"))?;
        let event_index: i64 = row
            .try_get("event_index")
            .map_err(|err| format!("replay_snapshot_cleanup_row_failed: {err}"))?;
        let payload_json: String = row
            .try_get("payload_json")
            .map_err(|err| format!("replay_snapshot_cleanup_row_failed: {err}"))?;

        let Ok(mut payload) = serde_json::from_str::<Value>(&payload_json) else {
            log::warn!("Replay snapshot cleanup skipped malformed payload row id={id}");
            continue;
        };
        let Some(object) = payload.as_object_mut() else {
            continue;
        };
        let Some(patch) = object
            .get("patch")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
        else {
            continue;
        };

        let checkpoint_id = object
            .get("checkpointId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("event-{event_index}"));
        let relative_path = replay_snapshot_patch_relative_path(&session_key, &checkpoint_id);
        let target_path = data_dir.join(&relative_path);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("replay_snapshot_cleanup_dir_failed: {err}"))?;
        }
        fs::write(&target_path, patch.as_bytes())
            .map_err(|err| format!("replay_snapshot_cleanup_write_failed: {err}"))?;

        let patch_bytes = patch.len() as u64;
        object.remove("patch");
        object.insert("patchPath".to_string(), Value::String(relative_path));
        object.insert(
            "patchStorage".to_string(),
            Value::String(REPLAY_SNAPSHOT_PATCH_STORAGE.to_string()),
        );
        if object.get("patchBytes").and_then(Value::as_u64).is_none() {
            object.insert(
                "patchBytes".to_string(),
                Value::Number(serde_json::Number::from(patch_bytes)),
            );
        }
        object.insert(
            "patchStoredAt".to_string(),
            Value::String(chrono::Utc::now().to_rfc3339()),
        );

        let updated_payload_json = serde_json::to_string(&payload)
            .map_err(|err| format!("replay_snapshot_cleanup_serialize_failed: {err}"))?;
        sqlx::query("UPDATE ai_replay_events SET payload_json = ?1 WHERE id = ?2")
            .bind(updated_payload_json)
            .bind(id)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("replay_snapshot_cleanup_update_failed: {err}"))?;
        migrated += 1;
    }

    Ok(migrated)
}

fn replay_snapshot_patch_relative_path(session_key: &str, checkpoint_id: &str) -> String {
    format!(
        "{}/{}/{}.patch",
        REPLAY_SNAPSHOT_PATCH_DIR,
        sanitize_snapshot_path_segment(session_key, "session"),
        sanitize_snapshot_path_segment(checkpoint_id, "snapshot")
    )
}

fn sanitize_snapshot_path_segment(value: &str, fallback: &str) -> String {
    let mut safe = String::with_capacity(value.len().min(120));
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            safe.push(ch);
        } else {
            safe.push('-');
        }
        if safe.len() >= 120 {
            break;
        }
    }
    let trimmed = safe.trim_matches(['.', '-']);
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn expected_migrations_for_features(
    features: &SchemaFeatures,
) -> Result<Vec<ExpectedMigration>, String> {
    let mut expected = Vec::new();

    match features.favorite_snapshots {
        SchemaState::Complete => expected.push(ExpectedMigration {
            version: MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_VERSION,
            description: MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_DESCRIPTION,
            sql: MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_SQL,
        }),
        SchemaState::Absent => {}
        SchemaState::Partial => return Err("migration_repair_partial_favorite_schema".to_string()),
    }

    match features.cli_args {
        SchemaState::Complete => expected.push(ExpectedMigration {
            version: MIGRATION_ADD_CLI_ARGS_VERSION,
            description: MIGRATION_ADD_CLI_ARGS_DESCRIPTION,
            sql: MIGRATION_ADD_CLI_ARGS_SQL,
        }),
        SchemaState::Absent => {}
        SchemaState::Partial => return Err("migration_repair_partial_cli_args_schema".to_string()),
    }

    match features.worktree_isolation {
        SchemaState::Complete => expected.push(ExpectedMigration {
            version: MIGRATION_ADD_WORKTREE_ISOLATION_VERSION,
            description: MIGRATION_ADD_WORKTREE_ISOLATION_DESCRIPTION,
            sql: MIGRATION_ADD_WORKTREE_ISOLATION_SQL,
        }),
        SchemaState::Absent => {}
        SchemaState::Partial => return Err("migration_repair_partial_worktree_schema".to_string()),
    }

    match features.ssh_hosts {
        SchemaState::Complete => expected.push(ExpectedMigration {
            version: MIGRATION_CREATE_SSH_HOSTS_VERSION,
            description: MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION,
            sql: MIGRATION_CREATE_SSH_HOSTS_SQL,
        }),
        SchemaState::Absent => {}
        SchemaState::Partial => return Err("migration_repair_partial_ssh_host_schema".to_string()),
    }

    match features.ssh_host_groups {
        SchemaState::Complete => expected.push(ExpectedMigration {
            version: MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION,
            description: MIGRATION_CREATE_SSH_HOST_GROUPS_DESCRIPTION,
            sql: MIGRATION_CREATE_SSH_HOST_GROUPS_SQL,
        }),
        SchemaState::Absent => {}
        SchemaState::Partial => return Err("migration_repair_partial_ssh_group_schema".to_string()),
    }

    expected.sort_by_key(|migration| migration.version);
    Ok(expected)
}

fn expected_rows(expected: &[ExpectedMigration]) -> Vec<MigrationRow> {
    expected
        .iter()
        .map(|migration| MigrationRow {
            version: migration.version,
            description: migration.description.to_string(),
            checksum: migration_checksum(migration.sql),
        })
        .collect()
}

fn migration_checksum(sql: &str) -> Vec<u8> {
    Sha384::digest(sql.as_bytes()).to_vec()
}

async fn read_known_migration_rows(
    conn: &mut SqliteConnection,
) -> Result<Vec<MigrationRow>, String> {
    let rows = sqlx::query(
        "SELECT version, description, checksum FROM _sqlx_migrations
         WHERE version BETWEEN ?1 AND ?2 OR version IN (?3, ?4)
         ORDER BY version",
    )
    .bind(KNOWN_DRIFT_START_VERSION)
    .bind(KNOWN_DRIFT_END_VERSION)
    .bind(MIGRATION_CREATE_SSH_HOSTS_VERSION)
    .bind(MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("migration_repair_query_failed: {err}"))?;

    rows.iter().map(migration_row_from_sqlite).collect()
}

fn migration_row_from_sqlite(row: &SqliteRow) -> Result<MigrationRow, String> {
    Ok(MigrationRow {
        version: row
            .try_get("version")
            .map_err(|err| format!("migration_repair_row_failed: {err}"))?,
        description: row
            .try_get("description")
            .map_err(|err| format!("migration_repair_row_failed: {err}"))?,
        checksum: row
            .try_get("checksum")
            .map_err(|err| format!("migration_repair_row_failed: {err}"))?,
    })
}

async fn rewrite_known_migration_rows(
    conn: &mut SqliteConnection,
    expected: &[ExpectedMigration],
) -> Result<(), String> {
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("migration_repair_begin_failed: {err}"))?;

    let result = rewrite_known_migration_rows_in_transaction(conn, expected).await;
    if result.is_ok() {
        sqlx::query("COMMIT")
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("migration_repair_commit_failed: {err}"))?;
    } else {
        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
    }
    result
}

async fn rewrite_known_migration_rows_in_transaction(
    conn: &mut SqliteConnection,
    expected: &[ExpectedMigration],
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM _sqlx_migrations
         WHERE version BETWEEN ?1 AND ?2 OR version IN (?3, ?4)",
    )
    .bind(KNOWN_DRIFT_START_VERSION)
    .bind(KNOWN_DRIFT_END_VERSION)
    .bind(MIGRATION_CREATE_SSH_HOSTS_VERSION)
    .bind(MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("migration_repair_delete_failed: {err}"))?;

    for migration in expected {
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (?1, ?2, TRUE, ?3, 0)",
        )
        .bind(migration.version)
        .bind(migration.description)
        .bind(migration_checksum(migration.sql))
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("migration_repair_insert_failed: {err}"))?;
    }

    Ok(())
}

async fn detect_schema_features(conn: &mut SqliteConnection) -> Result<SchemaFeatures, String> {
    let projects_columns = table_columns(conn, "projects").await?;
    let favorite_columns = table_columns(conn, "session_favorite_snapshots").await?;
    let worktree_columns = table_columns(conn, "worktrees").await?;
    let ssh_host_columns = table_columns(conn, "ssh_hosts").await?;
    let ssh_group_columns = table_columns(conn, "ssh_host_groups").await?;

    Ok(SchemaFeatures {
        favorite_snapshots: classify_table_schema(&favorite_columns, &FAVORITE_SNAPSHOT_COLUMNS),
        cli_args: if projects_columns.contains("cli_args") {
            SchemaState::Complete
        } else {
            SchemaState::Absent
        },
        worktree_isolation: classify_worktree_schema(&projects_columns, &worktree_columns),
        ssh_hosts: classify_ssh_host_schema(&projects_columns, &ssh_host_columns),
        ssh_host_groups: classify_ssh_group_schema(&ssh_host_columns, &ssh_group_columns),
    })
}

fn classify_table_schema(columns: &HashSet<String>, required: &[&str]) -> SchemaState {
    if columns.is_empty() {
        return SchemaState::Absent;
    }
    if has_columns(columns, required) {
        SchemaState::Complete
    } else {
        SchemaState::Partial
    }
}

fn classify_worktree_schema(
    projects_columns: &HashSet<String>,
    worktree_columns: &HashSet<String>,
) -> SchemaState {
    let has_project_columns = has_columns(projects_columns, &WORKTREE_PROJECT_COLUMNS);
    let has_worktree_table = !worktree_columns.is_empty();
    let has_worktree_columns = has_columns(worktree_columns, &WORKTREE_COLUMNS);

    if !has_project_columns && !has_worktree_table {
        return SchemaState::Absent;
    }
    if has_project_columns && has_worktree_columns {
        SchemaState::Complete
    } else {
        SchemaState::Partial
    }
}

fn classify_ssh_group_schema(
    ssh_host_columns: &HashSet<String>,
    ssh_group_columns: &HashSet<String>,
) -> SchemaState {
    let has_group_id = ssh_host_columns.contains("group_id");
    let has_group_table = !ssh_group_columns.is_empty();

    if !has_group_id && !has_group_table {
        return SchemaState::Absent;
    }
    if has_group_id && has_columns(ssh_group_columns, &SSH_HOST_GROUP_COLUMNS) {
        SchemaState::Complete
    } else {
        SchemaState::Partial
    }
}

fn classify_ssh_host_schema(
    projects_columns: &HashSet<String>,
    ssh_host_columns: &HashSet<String>,
) -> SchemaState {
    let has_project_columns = has_columns(projects_columns, &SSH_PROJECT_COLUMNS);
    let has_ssh_host_table = !ssh_host_columns.is_empty();

    if !has_project_columns && !has_ssh_host_table {
        return SchemaState::Absent;
    }
    if has_project_columns && has_columns(ssh_host_columns, &SSH_HOST_COLUMNS) {
        SchemaState::Complete
    } else {
        SchemaState::Partial
    }
}

fn has_columns(columns: &HashSet<String>, required: &[&str]) -> bool {
    required.iter().all(|column| columns.contains(*column))
}

async fn table_exists(conn: &mut SqliteConnection, table: &str) -> Result<bool, String> {
    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1")
            .bind(table)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("migration_repair_schema_query_failed: {err}"))?;
    Ok(exists.is_some())
}

async fn table_columns(
    conn: &mut SqliteConnection,
    table: &'static str,
) -> Result<HashSet<String>, String> {
    if !table_exists(conn, table).await? {
        return Ok(HashSet::new());
    }

    let query = match table {
        "groups" => "PRAGMA table_info(groups)",
        "projects" => "PRAGMA table_info(projects)",
        "session_favorite_snapshots" => "PRAGMA table_info(session_favorite_snapshots)",
        "worktrees" => "PRAGMA table_info(worktrees)",
        "ssh_hosts" => "PRAGMA table_info(ssh_hosts)",
        "ssh_host_groups" => "PRAGMA table_info(ssh_host_groups)",
        "usage_records" => "PRAGMA table_info(usage_records)",
        _ => return Err("migration_repair_unsupported_table".to_string()),
    };
    let rows = sqlx::query(query)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("migration_repair_schema_query_failed: {err}"))?;

    let mut columns = HashSet::new();
    for row in rows {
        let name: String = row
            .try_get("name")
            .map_err(|err| format!("migration_repair_schema_row_failed: {err}"))?;
        columns.insert(name);
    }
    Ok(columns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;

    #[test]
    fn maps_complete_feature_schema_to_current_migration_versions() {
        let features = SchemaFeatures {
            favorite_snapshots: SchemaState::Complete,
            cli_args: SchemaState::Complete,
            worktree_isolation: SchemaState::Complete,
            ssh_hosts: SchemaState::Complete,
            ssh_host_groups: SchemaState::Complete,
        };

        let expected = expected_migrations_for_features(&features).unwrap();
        let versions: Vec<i64> = expected.iter().map(|migration| migration.version).collect();

        assert_eq!(
            versions,
            vec![
                MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_VERSION,
                MIGRATION_ADD_CLI_ARGS_VERSION,
                MIGRATION_ADD_WORKTREE_ISOLATION_VERSION,
                MIGRATION_CREATE_SSH_HOSTS_VERSION,
                MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION,
            ]
        );
    }

    #[test]
    fn rejects_partial_worktree_schema() {
        let features = SchemaFeatures {
            favorite_snapshots: SchemaState::Absent,
            cli_args: SchemaState::Complete,
            worktree_isolation: SchemaState::Partial,
            ssh_hosts: SchemaState::Absent,
            ssh_host_groups: SchemaState::Absent,
        };

        assert_eq!(
            expected_migrations_for_features(&features).unwrap_err(),
            "migration_repair_partial_worktree_schema"
        );
    }

    #[tokio::test]
    async fn rewrites_old_worktree_lineage_rows_to_current_versions() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_complete_feature_schema(&mut conn).await;

        insert_migration_row(
            &mut conn,
            13,
            MIGRATION_ADD_CLI_ARGS_DESCRIPTION,
            MIGRATION_ADD_CLI_ARGS_SQL,
        )
        .await;
        insert_migration_row(
            &mut conn,
            14,
            MIGRATION_ADD_WORKTREE_ISOLATION_DESCRIPTION,
            MIGRATION_ADD_WORKTREE_ISOLATION_SQL,
        )
        .await;
        insert_migration_row(
            &mut conn,
            15,
            MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_DESCRIPTION,
            MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_SQL,
        )
        .await;

        let result = repair_known_migration_drift(&mut conn).await.unwrap();
        let rows = read_known_migration_rows(&mut conn).await.unwrap();

        assert!(result.repaired);
        assert_eq!(
            rows,
            expected_rows(
                &expected_migrations_for_features(&SchemaFeatures {
                    favorite_snapshots: SchemaState::Complete,
                    cli_args: SchemaState::Complete,
                    worktree_isolation: SchemaState::Complete,
                    ssh_hosts: SchemaState::Absent,
                    ssh_host_groups: SchemaState::Absent,
                })
                .unwrap()
            )
        );
    }

    #[tokio::test]
    async fn moves_cli_args_only_lineage_forward_and_leaves_missing_features_to_sqlx() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        conn.execute(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                cli_args TEXT NOT NULL DEFAULT ''
            )",
        )
        .await
        .unwrap();
        insert_migration_row(
            &mut conn,
            13,
            MIGRATION_ADD_CLI_ARGS_DESCRIPTION,
            MIGRATION_ADD_CLI_ARGS_SQL,
        )
        .await;

        let result = repair_known_migration_drift(&mut conn).await.unwrap();
        let rows = read_known_migration_rows(&mut conn).await.unwrap();

        assert!(result.repaired);
        assert_eq!(
            rows,
            vec![MigrationRow {
                version: MIGRATION_ADD_CLI_ARGS_VERSION,
                description: MIGRATION_ADD_CLI_ARGS_DESCRIPTION.to_string(),
                checksum: migration_checksum(MIGRATION_ADD_CLI_ARGS_SQL),
            }]
        );
    }

    #[tokio::test]
    async fn marks_frontend_created_ssh_group_schema_as_migrated() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        conn.execute(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL
            )",
        )
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_SSH_HOSTS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        conn.execute(
            "CREATE TABLE ssh_host_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )",
        )
        .await
        .unwrap();
        conn.execute(
            "ALTER TABLE ssh_hosts
             ADD COLUMN group_id TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL",
        )
        .await
        .unwrap();
        insert_migration_row(
            &mut conn,
            MIGRATION_CREATE_SSH_HOSTS_VERSION,
            MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION,
            "legacy migration 20 sql",
        )
        .await;

        let result = repair_known_migration_drift(&mut conn).await.unwrap();
        let rows = read_known_migration_rows(&mut conn).await.unwrap();

        assert!(result.repaired);
        assert_eq!(
            rows,
            vec![
                MigrationRow {
                    version: MIGRATION_CREATE_SSH_HOSTS_VERSION,
                    description: MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION.to_string(),
                    checksum: migration_checksum(MIGRATION_CREATE_SSH_HOSTS_SQL),
                },
                MigrationRow {
                    version: MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION,
                    description: MIGRATION_CREATE_SSH_HOST_GROUPS_DESCRIPTION.to_string(),
                    checksum: migration_checksum(MIGRATION_CREATE_SSH_HOST_GROUPS_SQL),
                },
            ]
        );

        sqlx::raw_sql(crate::MIGRATION_ADD_SSH_CONFIG_FILE_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        let columns = table_columns(&mut conn, "ssh_hosts").await.unwrap();
        assert!(columns.contains("config_file"));
    }

    #[tokio::test]
    async fn migrates_replay_snapshot_inline_patch_to_file_metadata() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        conn.execute(
            "CREATE TABLE ai_replay_events (
                id INTEGER PRIMARY KEY,
                session_key TEXT NOT NULL,
                event_index INTEGER NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )",
        )
        .await
        .unwrap();

        let patch = "diff --git a/a.txt b/a.txt\n+hello\n";
        let payload = serde_json::json!({
            "checkpointId": "checkpoint/one",
            "label": "snapshot",
            "patch": patch
        });
        sqlx::query(
            "INSERT INTO ai_replay_events (session_key, event_index, kind, payload_json)
             VALUES (?1, ?2, 'snapshot', ?3)",
        )
        .bind("session:one")
        .bind(7_i64)
        .bind(payload.to_string())
        .execute(&mut conn)
        .await
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let migrated = cleanup_replay_snapshot_inline_patches(&mut conn, data_dir.path())
            .await
            .unwrap();

        assert_eq!(migrated, 1);

        let (stored_payload_json,): (String,) =
            sqlx::query_as("SELECT payload_json FROM ai_replay_events WHERE id = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let stored_payload: Value = serde_json::from_str(&stored_payload_json).unwrap();
        let object = stored_payload.as_object().unwrap();
        assert!(object.get("patch").is_none());
        assert_eq!(
            object.get("patchStorage").and_then(Value::as_str),
            Some(REPLAY_SNAPSHOT_PATCH_STORAGE)
        );
        assert_eq!(
            object.get("patchBytes").and_then(Value::as_u64),
            Some(patch.len() as u64)
        );

        let patch_path = object.get("patchPath").and_then(Value::as_str).unwrap();
        assert_eq!(
            patch_path,
            "replay-snapshots/session-one/checkpoint-one.patch"
        );
        let written_patch = std::fs::read_to_string(data_dir.path().join(patch_path)).unwrap();
        assert_eq!(written_patch, patch);
    }

    #[tokio::test]
    async fn skips_replay_snapshot_cleanup_when_current_version_marker_exists() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        conn.execute(
            "CREATE TABLE ai_replay_events (
                id INTEGER PRIMARY KEY,
                session_key TEXT NOT NULL,
                event_index INTEGER NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )",
        )
        .await
        .unwrap();
        let payload = serde_json::json!({
            "checkpointId": "checkpoint-one",
            "patch": "diff --git a/a.txt b/a.txt\n+hello\n"
        });
        sqlx::query(
            "INSERT INTO ai_replay_events (session_key, event_index, kind, payload_json)
             VALUES (?1, ?2, 'snapshot', ?3)",
        )
        .bind("session-one")
        .bind(1_i64)
        .bind(payload.to_string())
        .execute(&mut conn)
        .await
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        fs::write(
            replay_snapshot_cleanup_marker_path(data_dir.path()),
            APP_VERSION,
        )
        .unwrap();

        let migrated =
            cleanup_replay_snapshot_inline_patches_for_current_version(&mut conn, data_dir.path())
                .await
                .unwrap();

        assert_eq!(migrated, 0);
        let (stored_payload_json,): (String,) =
            sqlx::query_as("SELECT payload_json FROM ai_replay_events WHERE id = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let stored_payload: Value = serde_json::from_str(&stored_payload_json).unwrap();
        assert!(stored_payload.get("patch").is_some());
        assert!(!data_dir.path().join(REPLAY_SNAPSHOT_PATCH_DIR).exists());
    }

    #[tokio::test]
    async fn writes_replay_snapshot_cleanup_marker_after_version_check() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        let data_dir = tempfile::tempdir().unwrap();

        let migrated =
            cleanup_replay_snapshot_inline_patches_for_current_version(&mut conn, data_dir.path())
                .await
                .unwrap();

        assert_eq!(migrated, 0);
        assert_eq!(
            std::fs::read_to_string(replay_snapshot_cleanup_marker_path(data_dir.path())).unwrap(),
            APP_VERSION
        );
    }

    #[tokio::test]
    async fn recovers_legacy_db_when_current_db_has_no_user_rows() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy.db");
        let current = temp.path().join("current.db");
        create_user_data_db(&legacy, &[("project-1", "Legacy Project")]).await;
        create_user_data_db(&current, &[]).await;

        let recovered = recover_legacy_db_file_if_current_empty(&legacy, &current)
            .await
            .unwrap();

        assert!(recovered);
        let mut conn = open_cli_manager_db(&current).await.unwrap();
        let row = sqlx::query("SELECT name FROM projects WHERE id = 'project-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let name: String = row.try_get("name").unwrap();
        assert_eq!(name, "Legacy Project");
        let backup_count = fs::read_dir(temp.path())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("current.db.backup-")
            })
            .count();
        assert_eq!(backup_count, 1);
    }

    #[tokio::test]
    async fn does_not_overwrite_current_db_when_it_has_user_rows() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy.db");
        let current = temp.path().join("current.db");
        create_user_data_db(&legacy, &[("project-legacy", "Legacy Project")]).await;
        create_user_data_db(&current, &[("project-current", "Current Project")]).await;

        let recovered = recover_legacy_db_file_if_current_empty(&legacy, &current)
            .await
            .unwrap();

        assert!(!recovered);
        let mut conn = open_cli_manager_db(&current).await.unwrap();
        let current_rows: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM projects WHERE id = 'project-current'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let legacy_rows: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM projects WHERE id = 'project-legacy'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(current_rows.0, 1);
        assert_eq!(legacy_rows.0, 0);
    }

    #[tokio::test]
    async fn merges_legacy_custom_model_prices_without_overwriting_current_custom_prices() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy.db");
        let current = temp.path().join("current.db");
        let data_dir = temp.path().join("data");
        create_user_data_db(&legacy, &[]).await;
        create_user_data_db(&current, &[("project-current", "Current Project")]).await;
        create_model_prices_table(&legacy).await;
        create_model_prices_table(&current).await;

        insert_model_price(&legacy, "gpt-5", 123.0, "manual").await;
        insert_model_price(&legacy, "legacy-only", 7.0, "manual").await;
        insert_model_price(&legacy, "current-custom", 999.0, "manual").await;
        insert_model_price(&current, "gpt-5", 1.25, "builtin").await;
        insert_model_price(&current, "current-custom", 42.0, "manual").await;

        let merged = merge_legacy_model_prices_once(&legacy, &current, &data_dir)
            .await
            .unwrap();

        assert_eq!(merged, 2);
        assert_eq!(
            read_model_price(&current, "gpt-5").await,
            (123.0, "manual".to_string())
        );
        assert_eq!(
            read_model_price(&current, "legacy-only").await,
            (7.0, "manual".to_string())
        );
        assert_eq!(
            read_model_price(&current, "current-custom").await,
            (42.0, "manual".to_string())
        );

        let mut conn = open_cli_manager_db(&current).await.unwrap();
        sqlx::query("DELETE FROM model_prices WHERE model = 'legacy-only'")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();

        assert_eq!(
            merge_legacy_model_prices_once(&legacy, &current, &data_dir)
                .await
                .unwrap(),
            0
        );
        let mut conn = open_cli_manager_db(&current).await.unwrap();
        let count: i64 =
            sqlx::query("SELECT COUNT(*) AS count FROM model_prices WHERE model = 'legacy-only'")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .try_get("count")
                .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn defers_large_project_path_migration_with_original_checksum() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_project_path_backfill_schema(&mut conn).await;
        insert_usage_row(
            &mut conn,
            "legacy-1",
            "session_log",
            "codex",
            Some("session-1"),
            Some("demo"),
            None,
            1,
        )
        .await;

        assert!(defer_request_log_project_path_backfill(&mut conn)
            .await
            .unwrap());
        assert!(!defer_request_log_project_path_backfill(&mut conn)
            .await
            .unwrap());

        let row =
            sqlx::query("SELECT description, checksum FROM _sqlx_migrations WHERE version = ?1")
                .bind(MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(
            row.try_get::<String, _>("description").unwrap(),
            REQUEST_LOG_PROJECT_PATH_BACKFILL_DESCRIPTION
        );
        assert_eq!(
            row.try_get::<Vec<u8>, _>("checksum").unwrap(),
            migration_checksum(MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL)
        );
        let project_path: Option<String> =
            sqlx::query_scalar("SELECT project_path FROM usage_records WHERE record_id='legacy-1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(
            project_path, None,
            "startup compatibility must not backfill rows"
        );
    }

    #[tokio::test]
    async fn leaves_empty_or_incompatible_databases_to_standard_migrations() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_project_path_backfill_schema(&mut conn).await;
        assert!(!defer_request_log_project_path_backfill(&mut conn)
            .await
            .unwrap());

        let mut missing_schema = SqliteConnection::connect(":memory:").await.unwrap();
        create_migration_table(&mut missing_schema).await;
        assert!(
            !defer_request_log_project_path_backfill(&mut missing_schema)
                .await
                .unwrap()
        );
    }

    #[test]
    fn resolves_only_unambiguous_local_project_paths() {
        let projects = vec![
            BackfillProject {
                name: "demo".to_string(),
                path: "d:/work/demo".to_string(),
            },
            BackfillProject {
                name: "duplicate".to_string(),
                path: "d:/one/duplicate".to_string(),
            },
            BackfillProject {
                name: "duplicate".to_string(),
                path: "d:/two/duplicate".to_string(),
            },
        ];

        assert_eq!(
            resolve_backfill_project_path("demo", &projects).as_deref(),
            Some("d:/work/demo")
        );
        assert_eq!(resolve_backfill_project_path("duplicate", &projects), None);
        assert_eq!(
            resolve_backfill_project_path(r"C:\Work\Repo\", &projects).as_deref(),
            Some("c:/work/repo")
        );
    }

    #[tokio::test]
    async fn backfills_large_legacy_sets_in_batches_and_inherits_route_paths() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        create_project_path_backfill_schema(&mut conn).await;
        sqlx::query(
            "INSERT INTO projects (id, name, path, environment_type) VALUES
             ('demo', 'demo', 'D:\\work\\demo', 'local'),
             ('dup-1', 'duplicate', 'D:\\one\\duplicate', 'local'),
             ('dup-2', 'duplicate', 'D:\\two\\duplicate', 'local'),
             ('remote', 'remote-only', '', 'ssh')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "WITH RECURSIVE seq(value) AS (
                 SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 50005
             )
             INSERT INTO usage_records (
                 record_id, data_source, source, session_id, project_key,
                 project_path, updated_at_ms, started_at_ms
             )
             SELECT 'demo-' || value, 'session_log', 'codex',
                    CASE WHEN value = 1 THEN 'shared-session' ELSE 'session-' || value END,
                    'demo', NULL, value, value
             FROM seq",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        insert_usage_row(
            &mut conn,
            "absolute",
            "session_log",
            "codex",
            Some("absolute-session"),
            Some(r"C:\Work\Repo"),
            None,
            5_000,
        )
        .await;
        insert_usage_row(
            &mut conn,
            "ambiguous",
            "session_log",
            "codex",
            Some("ambiguous-session"),
            Some("duplicate"),
            None,
            5_001,
        )
        .await;
        insert_usage_row(
            &mut conn,
            "route",
            "route",
            "codex",
            Some("shared-session"),
            None,
            None,
            5_002,
        )
        .await;
        insert_usage_row(
            &mut conn,
            "preexisting",
            "session_log",
            "codex",
            Some("preexisting-session"),
            Some("demo"),
            Some("keep/me"),
            5_003,
        )
        .await;

        let result = backfill_request_log_project_paths(&mut conn).await.unwrap();
        assert_eq!(result.mapped_project_keys, 2);
        assert_eq!(result.updated_rows, 50_007);
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT project_path FROM usage_records WHERE record_id='demo-50005'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            "d:/work/demo"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT project_path FROM usage_records WHERE record_id='absolute'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            "c:/work/repo"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT project_path FROM usage_records WHERE record_id='route'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            "d:/work/demo"
        );
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT project_path FROM usage_records WHERE record_id='ambiguous'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            None
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT project_path FROM usage_records WHERE record_id='preexisting'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            "keep/me"
        );

        let rerun = backfill_request_log_project_paths(&mut conn).await.unwrap();
        assert_eq!(rerun.updated_rows, 0);
    }

    async fn create_migration_table(conn: &mut SqliteConnection) {
        conn.execute(
            "CREATE TABLE _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            )",
        )
        .await
        .unwrap();
    }

    async fn create_appearance_drift_schema(conn: &mut SqliteConnection, with_columns: bool) {
        let group_extra = if with_columns {
            ", icon TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT ''"
        } else {
            ""
        };
        conn.execute(
            format!("CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL{group_extra})")
                .as_str(),
        )
        .await
        .unwrap();
        conn.execute(
            format!("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL{group_extra})")
                .as_str(),
        )
        .await
        .unwrap();
    }

    async fn register_appearance_migration(conn: &mut SqliteConnection) {
        sqlx::query(
            "INSERT INTO _sqlx_migrations
                 (version, description, installed_on, success, checksum, execution_time)
             VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
        )
        .bind(NODE_APPEARANCE_MIGRATION_VERSION)
        .bind(NODE_APPEARANCE_MIGRATION_DESCRIPTION)
        .bind(migration_checksum(NODE_APPEARANCE_MIGRATION_SQL))
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    async fn create_group_binding_drift_schema(conn: &mut SqliteConnection, with_columns: bool) {
        let group_extra = if with_columns {
            ", bound_path TEXT NOT NULL DEFAULT ''"
        } else {
            ""
        };
        let project_extra = if with_columns {
            ", path_mode TEXT NOT NULL DEFAULT 'custom'"
        } else {
            ""
        };
        conn.execute(
            format!("CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL{group_extra})")
                .as_str(),
        )
        .await
        .unwrap();
        conn.execute(
            format!(
                "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL{project_extra})"
            )
            .as_str(),
        )
        .await
        .unwrap();
    }

    async fn create_ssh_attachment_drift_schema(conn: &mut SqliteConnection, with_column: bool) {
        let attachment_extra = if with_column {
            ", attachment_root TEXT NOT NULL DEFAULT ''"
        } else {
            ""
        };
        conn.execute(
            format!(
                "CREATE TABLE ssh_hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL{attachment_extra})"
            )
            .as_str(),
        )
        .await
        .unwrap();
    }

    async fn binding_migration_registered(conn: &mut SqliteConnection, version: i64) -> bool {
        sqlx::query_scalar::<_, i64>(
            "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version = ?1 AND success = 1)",
        )
        .bind(version)
        .fetch_one(conn)
        .await
        .unwrap()
            != 0
    }

    async fn register_legacy_node_appearance_v33_migration(conn: &mut SqliteConnection) {
        sqlx::query(
            "INSERT INTO _sqlx_migrations
                 (version, description, installed_on, success, checksum, execution_time)
             VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
        )
        .bind(MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
        .bind(NODE_APPEARANCE_MIGRATION_DESCRIPTION)
        .bind(migration_checksum(NODE_APPEARANCE_MIGRATION_SQL))
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    async fn appearance_columns(conn: &mut SqliteConnection) -> (HashSet<String>, HashSet<String>) {
        (
            table_columns(conn, "groups").await.unwrap(),
            table_columns(conn, "projects").await.unwrap(),
        )
    }

    #[tokio::test]
    async fn appearance_repair_adds_columns_when_migration_registered_but_columns_missing() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_appearance_drift_schema(&mut conn, false).await;
        register_appearance_migration(&mut conn).await;

        assert!(ensure_node_appearance_columns(&mut conn).await.unwrap());
        let (groups, projects) = appearance_columns(&mut conn).await;
        assert!(groups.contains("icon") && groups.contains("color"));
        assert!(projects.contains("icon") && projects.contains("color"));

        // 幂等：第二次不再改动。
        assert!(!ensure_node_appearance_columns(&mut conn).await.unwrap());
    }

    #[tokio::test]
    async fn group_binding_repair_adds_columns_and_registers_migrations() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_group_binding_drift_schema(&mut conn, false).await;

        assert!(ensure_group_binding_columns(&mut conn).await.unwrap());
        assert!(table_columns(&mut conn, "groups")
            .await
            .unwrap()
            .contains("bound_path"));
        assert!(table_columns(&mut conn, "projects")
            .await
            .unwrap()
            .contains("path_mode"));
        assert!(
            binding_migration_registered(&mut conn, MIGRATION_ADD_GROUP_BOUND_PATH_VERSION).await
        );
        assert!(
            binding_migration_registered(&mut conn, MIGRATION_ADD_PROJECT_PATH_MODE_VERSION).await
        );
        assert!(!ensure_group_binding_columns(&mut conn).await.unwrap());
    }

    #[tokio::test]
    async fn group_binding_repair_registers_migrations_when_columns_exist() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_group_binding_drift_schema(&mut conn, true).await;

        assert!(ensure_group_binding_columns(&mut conn).await.unwrap());
        assert!(
            binding_migration_registered(&mut conn, MIGRATION_ADD_GROUP_BOUND_PATH_VERSION).await
        );
        assert!(
            binding_migration_registered(&mut conn, MIGRATION_ADD_PROJECT_PATH_MODE_VERSION).await
        );
        assert!(!ensure_group_binding_columns(&mut conn).await.unwrap());
    }

    #[tokio::test]
    async fn ssh_attachment_root_repair_adds_column_and_registers_migration() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_ssh_attachment_drift_schema(&mut conn, false).await;

        assert!(ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
        assert!(table_columns(&mut conn, "ssh_hosts")
            .await
            .unwrap()
            .contains("attachment_root"));
        assert!(
            binding_migration_registered(&mut conn, MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION,)
                .await
        );
        assert!(!ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
    }

    #[tokio::test]
    async fn ssh_attachment_root_repair_handles_registered_and_preexisting_states() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_ssh_attachment_drift_schema(&mut conn, false).await;
        sqlx::query(
            "INSERT INTO _sqlx_migrations
                 (version, description, installed_on, success, checksum, execution_time)
             VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
        )
        .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION)
        .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_DESCRIPTION)
        .bind(migration_checksum(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL))
        .execute(&mut conn)
        .await
        .unwrap();

        // 版本已登记但列缺失时，只补列，不重复插入 migration 记录。
        assert!(ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
        assert!(table_columns(&mut conn, "ssh_hosts")
            .await
            .unwrap()
            .contains("attachment_root"));
        let registered_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ?1 AND success = 1",
        )
        .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(registered_count, 1);

        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_ssh_attachment_drift_schema(&mut conn, true).await;
        assert!(ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
        assert!(
            binding_migration_registered(&mut conn, MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION,)
                .await
        );
        assert!(!ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
    }

    #[tokio::test]
    async fn appearance_repair_registers_migration_when_columns_exist_but_version_missing() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_appearance_drift_schema(&mut conn, true).await;

        assert!(ensure_node_appearance_columns(&mut conn).await.unwrap());
        let registered: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version = ?1 AND success = 1)",
        )
        .bind(NODE_APPEARANCE_MIGRATION_VERSION)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(registered, 1);
        assert!(!ensure_node_appearance_columns(&mut conn).await.unwrap());
    }

    #[tokio::test]
    async fn appearance_repair_applies_missing_columns_before_sqlx() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_appearance_drift_schema(&mut conn, false).await;

        // 列缺失且版本未登记 —— 先在数据库打开前补齐，避免首次外观写入撞缺列。
        assert!(ensure_node_appearance_columns(&mut conn).await.unwrap());
        let (groups, projects) = appearance_columns(&mut conn).await;
        assert!(groups.contains("icon") && groups.contains("color"));
        assert!(projects.contains("icon") && projects.contains("color"));
        let registered: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version = ?1 AND success = 1)",
        )
        .bind(NODE_APPEARANCE_MIGRATION_VERSION)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(registered, 1);
        assert!(!ensure_node_appearance_columns(&mut conn).await.unwrap());
    }

    #[tokio::test]
    async fn legacy_node_appearance_v33_migration_is_reconciled_before_sqlx_runs() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_migration_table(&mut conn).await;
        create_appearance_drift_schema(&mut conn, true).await;
        register_legacy_node_appearance_v33_migration(&mut conn).await;

        assert!(reconcile_legacy_node_appearance_v33_migration(&mut conn)
            .await
            .unwrap());
        assert!(ensure_node_appearance_columns(&mut conn).await.unwrap());

        let usage_marker =
            sqlx::query("SELECT description, checksum FROM _sqlx_migrations WHERE version = ?1")
                .bind(MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(
            usage_marker.try_get::<String, _>("description").unwrap(),
            MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION
        );
        assert_eq!(
            usage_marker.try_get::<Vec<u8>, _>("checksum").unwrap(),
            migration_checksum(MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL)
        );

        let appearance_marker =
            sqlx::query("SELECT description, checksum FROM _sqlx_migrations WHERE version = ?1")
                .bind(NODE_APPEARANCE_MIGRATION_VERSION)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(
            appearance_marker
                .try_get::<String, _>("description")
                .unwrap(),
            NODE_APPEARANCE_MIGRATION_DESCRIPTION
        );
        assert_eq!(
            appearance_marker.try_get::<Vec<u8>, _>("checksum").unwrap(),
            migration_checksum(NODE_APPEARANCE_MIGRATION_SQL)
        );

        let error_detail_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('usage_records') WHERE name = 'error_detail'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(error_detail_columns, 1);
    }

    async fn create_project_path_backfill_schema(conn: &mut SqliteConnection) {
        conn.execute(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                environment_type TEXT NOT NULL DEFAULT 'local'
            )",
        )
        .await
        .unwrap();
        conn.execute(
            "CREATE TABLE usage_records (
                record_id TEXT PRIMARY KEY,
                data_source TEXT NOT NULL,
                source TEXT NOT NULL,
                session_id TEXT,
                project_key TEXT,
                project_path TEXT,
                updated_at_ms INTEGER NOT NULL,
                started_at_ms INTEGER NOT NULL
            )",
        )
        .await
        .unwrap();
        conn.execute(
            "CREATE INDEX idx_usage_records_project
             ON usage_records(project_key, started_at_ms DESC)",
        )
        .await
        .unwrap();
        conn.execute(
            "CREATE INDEX idx_usage_records_route_dedup
             ON usage_records(source, data_source, session_id, started_at_ms)",
        )
        .await
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_usage_row(
        conn: &mut SqliteConnection,
        record_id: &str,
        data_source: &str,
        source: &str,
        session_id: Option<&str>,
        project_key: Option<&str>,
        project_path: Option<&str>,
        timestamp: i64,
    ) {
        sqlx::query(
            "INSERT INTO usage_records (
                record_id, data_source, source, session_id, project_key,
                project_path, updated_at_ms, started_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        )
        .bind(record_id)
        .bind(data_source)
        .bind(source)
        .bind(session_id)
        .bind(project_key)
        .bind(project_path)
        .bind(timestamp)
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    async fn create_user_data_db(path: &Path, projects: &[(&str, &str)]) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        conn.execute(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            )",
        )
        .await
        .unwrap();
        conn.execute(
            "CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            )",
        )
        .await
        .unwrap();
        conn.execute(
            "CREATE TABLE command_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            )",
        )
        .await
        .unwrap();
        for (id, name) in projects {
            sqlx::query("INSERT INTO projects (id, name) VALUES (?1, ?2)")
                .bind(id)
                .bind(name)
                .execute(&mut conn)
                .await
                .unwrap();
        }
        conn.close().await.unwrap();
    }

    async fn create_model_prices_table(path: &Path) {
        let mut conn = open_cli_manager_db(path).await.unwrap();
        conn.execute(
            "CREATE TABLE model_prices (
                model TEXT PRIMARY KEY,
                input_per_1m REAL NOT NULL DEFAULT 0,
                output_per_1m REAL NOT NULL DEFAULT 0,
                cache_read_per_1m REAL NOT NULL DEFAULT 0,
                cache_creation_per_1m REAL NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'manual',
                source_model_id TEXT,
                raw_json TEXT,
                updated_at_ms INTEGER NOT NULL DEFAULT 0,
                synced_at_ms INTEGER
            )",
        )
        .await
        .unwrap();
        conn.close().await.unwrap();
    }

    async fn insert_model_price(path: &Path, model: &str, input: f64, source: &str) {
        let mut conn = open_cli_manager_db(path).await.unwrap();
        sqlx::query(
            "INSERT INTO model_prices (
                model, input_per_1m, output_per_1m, cache_read_per_1m,
                cache_creation_per_1m, source, updated_at_ms
             ) VALUES (?1, ?2, 10, 0, 0, ?3, 1)",
        )
        .bind(model)
        .bind(input)
        .bind(source)
        .execute(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
    }

    async fn read_model_price(path: &Path, model: &str) -> (f64, String) {
        let mut conn = open_cli_manager_db(path).await.unwrap();
        let row = sqlx::query("SELECT input_per_1m, source FROM model_prices WHERE model = ?1")
            .bind(model)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        (
            row.try_get("input_per_1m").unwrap(),
            row.try_get("source").unwrap(),
        )
    }

    async fn create_complete_feature_schema(conn: &mut SqliteConnection) {
        conn.execute(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                cli_args TEXT NOT NULL DEFAULT '',
                worktree_strategy TEXT NOT NULL DEFAULT 'disabled',
                worktree_root TEXT NOT NULL DEFAULT ''
            )",
        )
        .await
        .unwrap();
        conn.execute(
            "CREATE TABLE session_favorite_snapshots (
                session_key TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                source TEXT NOT NULL,
                project_key TEXT NOT NULL,
                file_path TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                message_count INTEGER NOT NULL,
                branch TEXT,
                detail_json TEXT NOT NULL,
                snapshot_at TEXT NOT NULL
            )",
        )
        .await
        .unwrap();
        conn.execute(
            "CREATE TABLE worktrees (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                branch TEXT NOT NULL,
                path TEXT NOT NULL,
                base_branch TEXT NOT NULL DEFAULT '',
                deps_prompt_dismissed INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
        )
        .await
        .unwrap();
    }

    async fn insert_migration_row(
        conn: &mut SqliteConnection,
        version: i64,
        description: &str,
        sql: &str,
    ) {
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (?1, ?2, TRUE, ?3, 0)",
        )
        .bind(version)
        .bind(description)
        .bind(migration_checksum(sql))
        .execute(conn)
        .await
        .unwrap();
    }
}
