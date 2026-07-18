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
        tokio::task::spawn_blocking(|| {
            crate::credential_store::get("webdav")
        })
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
