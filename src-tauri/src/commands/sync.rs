use crate::sync::{
    default_device_name, detect_conflict, download, list_device_snapshots, local_export,
    local_import, test_connection, upload, ConflictInfo, DeviceSnapshotInfo, SyncData,
};
use crate::webdav::WebDavConfig;
use chrono::{DateTime, Utc};
use log::{info, error};

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
) -> Result<Vec<DeviceSnapshotInfo>, String> {
    let webdav_config = WebDavConfig {
        url: config.url,
        username: config.username,
        password: config.password,
    };
    list_device_snapshots(webdav_config, device_names).await
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
) -> Result<SyncUploadResult, String> {
    info!("Starting sync_upload to {}", config.url);

    let webdav_config = WebDavConfig {
        url: config.url,
        username: config.username,
        password: config.password,
    };

    let timestamp = data.last_modified.clone();
    info!("Sync data: {} projects, {} groups, {} templates",
        data.data.projects.len(),
        data.data.groups.len(),
        data.data.command_templates.len()
    );

    if let Err(e) = upload(webdav_config, data).await {
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
) -> Result<SyncDownloadResult, String> {
    let webdav_config = WebDavConfig {
        url: config.url,
        username: config.username,
        password: config.password,
    };

    let remote_data = download(webdav_config, device_name, false).await?;

    // Check for conflict if local data is provided
    if let Some(local) = local_data {
        if !force {
            let local_modified: Option<DateTime<Utc>> = local
                .last_modified
                .parse()
                .ok();
            let remote_modified: Option<DateTime<Utc>> = remote_data
                .last_modified
                .parse()
                .ok();

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
    info!("Starting sync_local_export to {}", dir);
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
    info!("Starting sync_local_import from {}", zip_path);
    let data = tokio::task::spawn_blocking(move || local_import(&zip_path))
        .await
        .map_err(|e| format!("内部错误: {}", e))??;
    Ok(data)
}