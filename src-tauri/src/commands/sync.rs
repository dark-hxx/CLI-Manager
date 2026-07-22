use crate::sync::{
    backup_local_export as export_backup_zip, backup_local_import as import_backup_zip,
    clear_restore_safety, default_device_name, delete_backup, detect_conflict, download,
    download_backup, list_backups, list_device_snapshots, list_outbox, load_restore_safety,
    local_export, local_import, remove_outbox, save_outbox, save_restore_safety, test_connection,
    upload, upload_backup, BackupSnapshotInfo, BackupSnapshotV3, ConflictInfo, DeviceSnapshotInfo,
    SyncData,
};
use crate::webdav::WebDavConfig;
use chrono::{DateTime, Utc};
use log::{debug, error, info};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Connection, SqliteConnection};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

const BACKUP_RESTORE_MAX_STATEMENTS: usize = 1_000;
const BACKUP_RESTORE_MAX_PARAMS_PER_STATEMENT: usize = 30_000;
const BACKUP_RESTORE_DELETE_STATEMENTS: [&str; 5] = [
    "DELETE FROM command_templates",
    "DELETE FROM worktrees",
    "DELETE FROM projects",
    "DELETE FROM groups",
    "DELETE FROM model_prices",
];
const BACKUP_RESTORE_INSERT_COLUMNS: [(&str, &str); 5] = [
    ("groups", "id,name,parent_id,sort_order,created_at"),
    (
        "projects",
        "id,name,path,group_id,sort_order,cli_tool,cli_args,startup_cmd,env_vars,shell,provider_overrides,worktree_strategy,worktree_root,worktree_deps_prompt_enabled,environment_type,ssh_host_id,remote_path,cli_config_root,created_at,updated_at",
    ),
    (
        "worktrees",
        "id,project_id,name,branch,path,base_branch,deps_prompt_dismissed,provider_overrides,status,created_at,updated_at",
    ),
    (
        "command_templates",
        "id,project_id,name,command,description,sort_order",
    ),
    (
        "model_prices",
        "model,input_per_1m,output_per_1m,cache_read_per_1m,cache_creation_per_1m,source,source_model_id,raw_json,updated_at_ms,synced_at_ms",
    ),
];

static BACKUP_DATABASE_RESTORE_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDatabaseStatement {
    sql: String,
    #[serde(default)]
    values: Vec<Value>,
}

fn backup_database_restore_lock() -> &'static AsyncMutex<()> {
    BACKUP_DATABASE_RESTORE_LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn validate_backup_database_statement(statement: &BackupDatabaseStatement) -> Result<(), String> {
    let sql = statement.sql.trim();
    if sql.is_empty()
        || sql.contains(';')
        || statement.values.len() > BACKUP_RESTORE_MAX_PARAMS_PER_STATEMENT
    {
        return Err("backup_restore_database_statement_invalid".to_string());
    }
    if BACKUP_RESTORE_DELETE_STATEMENTS.contains(&sql) {
        return if statement.values.is_empty() {
            Ok(())
        } else {
            Err("backup_restore_database_statement_invalid".to_string())
        };
    }
    let allowed = BACKUP_RESTORE_INSERT_COLUMNS
        .iter()
        .any(|(table, columns)| {
            let prefix = format!("INSERT INTO {table} ({columns}) VALUES ");
            sql.strip_prefix(&prefix).is_some_and(|values_clause| {
                !values_clause.is_empty()
                    && values_clause
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || b"$(),".contains(&byte))
            })
        });
    if !allowed || statement.values.is_empty() {
        return Err("backup_restore_database_statement_invalid".to_string());
    }
    Ok(())
}

async fn execute_backup_database_restore(
    conn: &mut SqliteConnection,
    statements: &[BackupDatabaseStatement],
) -> Result<(), String> {
    if statements.is_empty() || statements.len() > BACKUP_RESTORE_MAX_STATEMENTS {
        return Err("backup_restore_database_statement_invalid".to_string());
    }
    for statement in statements {
        validate_backup_database_statement(statement)?;
    }

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|error| format!("backup_restore_database_begin_failed: {error}"))?;
    let result = async {
        for statement in statements {
            let mut query = sqlx::query(statement.sql.trim());
            for value in &statement.values {
                query =
                    match value {
                        Value::Null => query.bind(None::<String>),
                        Value::Bool(value) => query.bind(*value),
                        Value::Number(value) => {
                            if let Some(value) = value.as_i64() {
                                query.bind(value)
                            } else if let Some(value) = value.as_u64() {
                                query.bind(i64::try_from(value).map_err(|_| {
                                    "backup_restore_database_value_invalid".to_string()
                                })?)
                            } else {
                                query.bind(value.as_f64().ok_or_else(|| {
                                    "backup_restore_database_value_invalid".to_string()
                                })?)
                            }
                        }
                        Value::String(value) => query.bind(value),
                        Value::Array(_) | Value::Object(_) => {
                            return Err("backup_restore_database_value_invalid".to_string())
                        }
                    };
            }
            query
                .execute(&mut *conn)
                .await
                .map_err(|error| format!("backup_restore_database_execute_failed: {error}"))?;
        }
        Ok(())
    }
    .await;

    if result.is_ok() {
        sqlx::query("COMMIT")
            .execute(&mut *conn)
            .await
            .map_err(|error| format!("backup_restore_database_commit_failed: {error}"))?;
    } else {
        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
    }
    result
}

#[derive(serde::Deserialize)]
pub struct SyncConfigInput {
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(serde::Serialize)]
pub struct SyncTestResult {
    pub success: bool,
    pub message: String,
}

#[derive(serde::Serialize)]
pub struct SyncUploadResult {
    pub success: bool,
    pub message: String,
    pub timestamp: String,
}

#[derive(serde::Serialize)]
pub struct SyncDownloadResult {
    pub success: bool,
    pub message: String,
    pub has_conflict: bool,
    pub conflict_info: Option<ConflictInfo>,
    pub data: Option<SyncData>,
}

#[derive(serde::Serialize)]
pub struct DeviceNameResult {
    pub device_name: String,
}

#[tauri::command]
pub async fn sync_get_default_device_name() -> Result<DeviceNameResult, String> {
    Ok(DeviceNameResult {
        device_name: default_device_name(),
    })
}

#[tauri::command]
pub async fn sync_list_device_snapshots(
    config: SyncConfigInput,
    device_names: Vec<String>,
    remote_dir: Option<String>,
) -> Result<Vec<DeviceSnapshotInfo>, String> {
    let webdav_config = WebDavConfig {
        url: config.url,
        username: config.username,
        password: config.password,
    };
    list_device_snapshots(webdav_config, device_names, remote_dir).await
}

#[tauri::command]
pub async fn sync_test_connection(config: SyncConfigInput) -> Result<SyncTestResult, String> {
    let webdav_config = WebDavConfig {
        url: config.url,
        username: config.username,
        password: config.password,
    };

    match test_connection(webdav_config).await {
        Ok(true) => Ok(SyncTestResult {
            success: true,
            message: "Connection successful".to_string(),
        }),
        Ok(false) => Ok(SyncTestResult {
            success: false,
            message: "Authentication failed".to_string(),
        }),
        Err(e) => Ok(SyncTestResult {
            success: false,
            message: e,
        }),
    }
}

#[tauri::command]
pub async fn sync_upload(
    config: SyncConfigInput,
    data: SyncData,
    remote_dir: Option<String>,
) -> Result<SyncUploadResult, String> {
    debug!("Starting sync_upload to {}", config.url);

    let webdav_config = WebDavConfig {
        url: config.url,
        username: config.username,
        password: config.password,
    };

    let timestamp = data.last_modified.clone();
    debug!(
        "Sync data: {} projects, {} groups, {} templates",
        data.data.projects.len(),
        data.data.groups.len(),
        data.data.command_templates.len()
    );

    if let Err(e) = upload(webdav_config, data, remote_dir).await {
        error!("Upload failed: {}", e);
        return Err(e);
    }

    info!("Upload successful");
    Ok(SyncUploadResult {
        success: true,
        message: "Upload successful".to_string(),
        timestamp,
    })
}

#[tauri::command]
pub async fn sync_download(
    config: SyncConfigInput,
    local_data: Option<SyncData>,
    force: bool,
    device_name: Option<String>,
    remote_dir: Option<String>,
) -> Result<SyncDownloadResult, String> {
    let webdav_config = WebDavConfig {
        url: config.url,
        username: config.username,
        password: config.password,
    };

    let remote_data = download(webdav_config, device_name, false, remote_dir).await?;

    // Check for conflict if local data is provided
    if let Some(local) = local_data {
        if !force {
            let local_modified: Option<DateTime<Utc>> = local.last_modified.parse().ok();
            let remote_modified: Option<DateTime<Utc>> = remote_data.last_modified.parse().ok();

            if let (Some(local_t), Some(remote_t)) = (local_modified, remote_modified) {
                if local_t > remote_t {
                    let conflict = detect_conflict(&local, &remote_data);
                    return Ok(SyncDownloadResult {
                        success: false,
                        message: "Conflict detected".to_string(),
                        has_conflict: true,
                        conflict_info: Some(conflict),
                        data: Some(remote_data),
                    });
                }
            }
        }
    }

    Ok(SyncDownloadResult {
        success: true,
        message: "Download successful".to_string(),
        has_conflict: false,
        conflict_info: None,
        data: Some(remote_data),
    })
}

#[derive(serde::Serialize)]
pub struct LocalExportResult {
    pub success: bool,
    pub path: String,
    pub message: String,
}

#[tauri::command]
pub async fn sync_local_export(dir: String, data: SyncData) -> Result<LocalExportResult, String> {
    debug!("Starting sync_local_export to {}", dir);
    let path = tokio::task::spawn_blocking(move || local_export(&dir, &data))
        .await
        .map_err(|e| format!("内部错误: {}", e))??;
    Ok(LocalExportResult {
        success: true,
        path,
        message: "本地同步导出成功".to_string(),
    })
}

#[tauri::command]
pub async fn sync_local_import(zip_path: String) -> Result<SyncData, String> {
    debug!("Starting sync_local_import from {}", zip_path);
    let data = tokio::task::spawn_blocking(move || local_import(&zip_path))
        .await
        .map_err(|e| format!("内部错误: {}", e))??;
    Ok(data)
}

fn webdav_config(config: SyncConfigInput) -> WebDavConfig {
    WebDavConfig {
        url: config.url,
        username: config.username,
        password: config.password,
    }
}

#[tauri::command]
pub async fn backup_upload(
    config: SyncConfigInput,
    snapshot: BackupSnapshotV3,
    remote_dir: Option<String>,
) -> Result<String, String> {
    upload_backup(webdav_config(config), snapshot, remote_dir).await
}

#[tauri::command]
pub async fn backup_list(
    config: SyncConfigInput,
    remote_dir: Option<String>,
) -> Result<Vec<BackupSnapshotInfo>, String> {
    list_backups(webdav_config(config), remote_dir).await
}

#[tauri::command]
pub async fn backup_download(
    config: SyncConfigInput,
    remote_path: String,
    remote_dir: Option<String>,
) -> Result<BackupSnapshotV3, String> {
    download_backup(webdav_config(config), remote_path, remote_dir).await
}

#[tauri::command]
pub async fn backup_delete(
    config: SyncConfigInput,
    remote_path: String,
    remote_dir: Option<String>,
) -> Result<(), String> {
    delete_backup(webdav_config(config), remote_path, remote_dir).await
}

#[tauri::command]
pub async fn backup_import_legacy_cloud(
    config: SyncConfigInput,
    device_name: Option<String>,
    remote_dir: Option<String>,
) -> Result<SyncData, String> {
    download(webdav_config(config), device_name, true, remote_dir).await
}

#[tauri::command]
pub async fn backup_local_export(
    dir: String,
    snapshot: serde_json::Value,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || export_backup_zip(&dir, snapshot))
        .await
        .map_err(|error| format!("内部错误: {error}"))?
}

#[tauri::command]
pub async fn backup_local_import(zip_path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || import_backup_zip(&zip_path))
        .await
        .map_err(|error| format!("内部错误: {error}"))?
}

#[tauri::command]
pub async fn backup_outbox_save(
    target_hash: String,
    snapshot: serde_json::Value,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || save_outbox(&target_hash, &snapshot))
        .await
        .map_err(|error| format!("内部错误: {error}"))?
}

#[tauri::command]
pub async fn backup_outbox_list(target_hash: String) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || list_outbox(&target_hash))
        .await
        .map_err(|error| format!("内部错误: {error}"))?
}

#[tauri::command]
pub async fn backup_outbox_remove(target_hash: String, snapshot_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || remove_outbox(&target_hash, &snapshot_id))
        .await
        .map_err(|error| format!("内部错误: {error}"))?
}

#[tauri::command]
pub async fn backup_restore_safety_save(snapshot: serde_json::Value) -> Result<String, String> {
    tokio::task::spawn_blocking(move || save_restore_safety(&snapshot))
        .await
        .map_err(|error| format!("内部错误: {error}"))?
}

#[tauri::command]
pub async fn backup_restore_safety_load() -> Result<Option<serde_json::Value>, String> {
    tokio::task::spawn_blocking(load_restore_safety)
        .await
        .map_err(|error| format!("内部错误: {error}"))?
}

#[tauri::command]
pub async fn backup_restore_safety_clear() -> Result<(), String> {
    tokio::task::spawn_blocking(clear_restore_safety)
        .await
        .map_err(|error| format!("内部错误: {error}"))?
}

#[tauri::command]
pub async fn backup_restore_database(
    statements: Vec<BackupDatabaseStatement>,
) -> Result<(), String> {
    let _restore_guard = backup_database_restore_lock().lock().await;
    let path = crate::app_paths::db_path()?;
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(15));
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("backup_restore_database_open_failed: {error}"))?;
    let restore_result = execute_backup_database_restore(&mut conn, &statements).await;
    let close_result = conn
        .close()
        .await
        .map_err(|error| format!("backup_restore_database_close_failed: {error}"));
    match (restore_result, close_result) {
        (Err(error), _) => Err(error),
        (Ok(()), result) => result,
    }
}

#[tauri::command]
pub async fn sync_save_password(password: String) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        tokio::task::spawn_blocking(move || {
            if password.is_empty() {
                return crate::credential_store::delete("webdav");
            }
            crate::credential_store::set("webdav", &password)
        })
        .await
        .map_err(|e| format!("内部错误: {}", e))?
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = password;
        Err("webdav_secure_storage_unsupported".to_string())
    }
}

#[tauri::command]
pub async fn sync_load_password() -> Result<Option<String>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        tokio::task::spawn_blocking(|| crate::credential_store::get("webdav"))
            .await
            .map_err(|e| format!("内部错误: {}", e))?
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Ok(None)
}

#[tauri::command]
pub async fn sync_delete_password() -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        tokio::task::spawn_blocking(|| crate::credential_store::delete("webdav"))
            .await
            .map_err(|e| format!("内部错误: {}", e))?
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn restore_test_connection() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT,
                sort_order INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO groups(id, name, parent_id, sort_order, created_at)
             VALUES ('old', 'Old', NULL, 0, '1')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    fn delete_groups_statement() -> BackupDatabaseStatement {
        BackupDatabaseStatement {
            sql: "DELETE FROM groups".to_string(),
            values: Vec::new(),
        }
    }

    #[tokio::test]
    async fn database_restore_executes_statements_in_one_transaction() {
        let mut conn = restore_test_connection().await;
        let statements = [
            delete_groups_statement(),
            BackupDatabaseStatement {
                sql: "INSERT INTO groups (id,name,parent_id,sort_order,created_at) VALUES ($1,$2,$3,$4,$5)"
                    .to_string(),
                values: vec![
                    Value::String("new".to_string()),
                    Value::String("New".to_string()),
                    Value::Null,
                    Value::Number(1.into()),
                    Value::String("2".to_string()),
                ],
            },
        ];

        execute_backup_database_restore(&mut conn, &statements)
            .await
            .unwrap();

        let rows: Vec<(String, String, i64, String)> = sqlx::query_as(
            "SELECT id, name, sort_order, typeof(sort_order) FROM groups ORDER BY id",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![(
                "new".to_string(),
                "New".to_string(),
                1,
                "integer".to_string(),
            )]
        );
    }

    #[tokio::test]
    async fn database_restore_rolls_back_all_statements_on_failure() {
        let mut conn = restore_test_connection().await;
        let statements = [
            delete_groups_statement(),
            BackupDatabaseStatement {
                sql: "INSERT INTO groups (id,name,parent_id,sort_order,created_at) VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)"
                    .to_string(),
                values: vec![
                    Value::String("duplicate".to_string()),
                    Value::String("First".to_string()),
                    Value::Null,
                    Value::Number(1.into()),
                    Value::String("2".to_string()),
                    Value::String("duplicate".to_string()),
                    Value::String("Second".to_string()),
                    Value::Null,
                    Value::Number(2.into()),
                    Value::String("3".to_string()),
                ],
            },
        ];

        let error = execute_backup_database_restore(&mut conn, &statements)
            .await
            .unwrap_err();
        assert!(error.starts_with("backup_restore_database_execute_failed:"));
        let name: String = sqlx::query_scalar("SELECT name FROM groups WHERE id = 'old'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(name, "Old");
    }

    #[tokio::test]
    async fn database_restore_rejects_statements_outside_owned_tables() {
        let mut conn = restore_test_connection().await;
        let statements = [BackupDatabaseStatement {
            sql: "DELETE FROM projects; DELETE FROM ssh_hosts".to_string(),
            values: Vec::new(),
        }];

        let error = execute_backup_database_restore(&mut conn, &statements)
            .await
            .unwrap_err();
        assert_eq!(error, "backup_restore_database_statement_invalid");
    }
}
