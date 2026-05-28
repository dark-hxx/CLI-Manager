use crate::webdav::{WebDavClient, WebDavConfig};
use chrono::Local;
use serde::{Deserialize, Serialize};
use log::{info, error};
use std::fs::{self, File};
use std::path::Path;

const SYNC_DEVICES_DIR_PATH: &str = "cli-manager/devices";
const LEGACY_SYNC_FILE_PATH: &str = "cli-manager/sync.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncData {
    pub version: u32,
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    pub last_modified: String,
    pub data: SyncPayload,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceSnapshotInfo {
    pub device_name: String,
    pub last_modified: String,
    pub projects: usize,
    pub groups: usize,
    pub command_templates: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncPayload {
    pub projects: Vec<serde_json::Value>,
    pub groups: Vec<serde_json::Value>,
    pub command_templates: Vec<serde_json::Value>,
    pub settings: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictInfo {
    pub local_modified: String,
    pub remote_modified: String,
    pub local_projects: usize,
    pub remote_projects: usize,
    pub local_groups: usize,
    pub remote_groups: usize,
    pub local_templates: usize,
    pub remote_templates: usize,
}

pub fn detect_conflict(local: &SyncData, remote: &SyncData) -> ConflictInfo {
    ConflictInfo {
        local_modified: local.last_modified.clone(),
        remote_modified: remote.last_modified.clone(),
        local_projects: local.data.projects.len(),
        remote_projects: remote.data.projects.len(),
        local_groups: local.data.groups.len(),
        remote_groups: remote.data.groups.len(),
        local_templates: local.data.command_templates.len(),
        remote_templates: remote.data.command_templates.len(),
    }
}

pub async fn test_connection(config: WebDavConfig) -> Result<bool, String> {
    let client = WebDavClient::new(config);
    client.test_connection().await.map_err(|e| e.message)
}

pub async fn upload(config: WebDavConfig, data: SyncData) -> Result<(), String> {
    info!("Creating WebDAV client for {}", config.url);
    let client = WebDavClient::new(config);
    let remote_path = device_sync_file_path(&data.device_name)?;

    info!("Ensuring directory exists: {}", SYNC_DEVICES_DIR_PATH);
    client
        .ensure_directory(SYNC_DEVICES_DIR_PATH)
        .await
        .map_err(|e| {
            error!("Failed to ensure directory: {}", e);
            e.message
        })?;

    info!("Serializing sync data");
    let json = serde_json::to_vec(&data)
        .map_err(|e| format!("Failed to serialize sync data: {}", e))?;

    info!("Uploading to {}", remote_path);
    client
        .upload(&remote_path, json)
        .await
        .map_err(|e| {
            error!("Upload failed: {}", e);
            e.message
        })?;

    info!("Upload completed successfully");
    Ok(())
}

pub async fn download(
    config: WebDavConfig,
    device_name: Option<String>,
    allow_legacy_fallback: bool,
) -> Result<SyncData, String> {
    let client = WebDavClient::new(config);
    let remote_path = match device_name.as_deref() {
        Some(name) if !name.trim().is_empty() => device_sync_file_path(name)?,
        _ => LEGACY_SYNC_FILE_PATH.to_string(),
    };

    let data = match client.download(&remote_path).await {
        Ok(data) => data,
        Err(e)
            if allow_legacy_fallback
                && remote_path != LEGACY_SYNC_FILE_PATH
                && e.status_code == Some(404) =>
        {
            client
                .download(LEGACY_SYNC_FILE_PATH)
                .await
                .map_err(|legacy_error| legacy_error.message)?
        }
        Err(e) => return Err(e.message),
    };

    let sync_data: SyncData = serde_json::from_slice(&data)
        .map_err(|e| format!("Failed to parse sync data: {}", e))?;

    Ok(sync_data)
}

pub async fn list_device_snapshots(config: WebDavConfig, device_names: Vec<String>) -> Result<Vec<DeviceSnapshotInfo>, String> {
    let client = WebDavClient::new(config);
    let mut snapshots = Vec::new();

    for device_name in device_names {
        let name = device_name.trim();
        if name.is_empty() {
            continue;
        }
        let remote_path = device_sync_file_path(name)?;
        let data = match client.download(&remote_path).await {
            Ok(data) => data,
            Err(e) if e.status_code == Some(404) => continue,
            Err(e) => return Err(e.message),
        };
        let sync_data: SyncData = serde_json::from_slice(&data)
            .map_err(|e| format!("Failed to parse sync data: {}", e))?;
        snapshots.push(DeviceSnapshotInfo {
            device_name: if sync_data.device_name.trim().is_empty() {
                name.to_string()
            } else {
                sync_data.device_name
            },
            last_modified: sync_data.last_modified,
            projects: sync_data.data.projects.len(),
            groups: sync_data.data.groups.len(),
            command_templates: sync_data.data.command_templates.len(),
        });
    }

    Ok(snapshots)
}

pub fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .map(|name| sanitize_device_name(&name))
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "当前设备".to_string())
}

fn device_sync_file_path(device_name: &str) -> Result<String, String> {
    let safe_name = sanitize_device_name(device_name);
    if safe_name.is_empty() {
        return Err("设备名称不能为空".to_string());
    }
    Ok(format!("{}/{}.json", SYNC_DEVICES_DIR_PATH, safe_name))
}

fn sanitize_device_name(device_name: &str) -> String {
    device_name
        .trim()
        .chars()
        .filter_map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => Some(ch),
            '\u{4e00}'..='\u{9fff}' => Some(ch),
            ' ' | '.' => Some('-'),
            _ => None,
        })
        .take(64)
        .collect::<String>()
}

pub fn local_export(dir: &str, data: &SyncData) -> Result<String, String> {
    let dir_path = Path::new(dir);
    if !dir_path.exists() {
        fs::create_dir_all(dir_path).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    if !dir_path.is_dir() {
        return Err("提供的路径不是目录".to_string());
    }

    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let filename = format!("cli-manager-sync-{}.zip", timestamp);
    let zip_path = dir_path.join(&filename);

    let file = File::create(&zip_path).map_err(|e| format!("创建 zip 文件失败: {}", e))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    writer
        .start_file("sync.json", options)
        .map_err(|e| format!("写入 zip 失败: {}", e))?;
    // 直接序列化到 zip writer，避免先 to_string_pretty 再 write_all 的中间 String 分配。
    serde_json::to_writer(&mut writer, data)
        .map_err(|e| format!("序列化失败: {}", e))?;
    writer
        .finish()
        .map_err(|e| format!("完成 zip 失败: {}", e))?;

    info!("Local sync exported to {}", zip_path.display());
    Ok(zip_path.to_string_lossy().into_owned())
}

pub fn local_import(zip_path: &str) -> Result<SyncData, String> {
    let path = Path::new(zip_path);
    if !path.exists() || !path.is_file() {
        return Err("zip 文件不存在".to_string());
    }

    let file = File::open(path).map_err(|e| format!("打开 zip 失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("读取 zip 失败: {}", e))?;
    let mut entry = archive
        .by_name("sync.json")
        .map_err(|e| {
            error!("zip 中找不到 sync.json: {}", e);
            format!("无效的同步文件: {}", e)
        })?;

    let data: SyncData = serde_json::from_reader(&mut entry)
        .map_err(|e| format!("解析数据失败: {}", e))?;
    Ok(data)
}