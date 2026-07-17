use crate::webdav::{WebDavClient, WebDavConfig};
use chrono::Local;
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::path::Path;

const DEFAULT_REMOTE_DIR: &str = "cli-manager";
const LOCAL_SYNC_JSON_MAX_BYTES: u64 = 16 * 1024 * 1024;

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
    #[serde(default)]
    pub worktrees: Vec<serde_json::Value>,
    #[serde(default)]
    pub model_prices: Vec<serde_json::Value>,
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

pub async fn upload(
    config: WebDavConfig,
    data: SyncData,
    remote_dir: Option<String>,
) -> Result<(), String> {
    info!("Creating WebDAV client for {}", config.url);
    let client = WebDavClient::new(config);
    let dir = sanitize_remote_dir(remote_dir.as_deref());
    let devices_dir = format!("{}/devices", dir);
    let remote_path = device_sync_file_path(&dir, &data.device_name)?;

    // ensure_directory 会递归创建所有父目录（backups → backups/cli-mgr → backups/cli-mgr/devices）
    info!("Ensuring directory exists: {}", devices_dir);
    client.ensure_directory(&devices_dir).await.map_err(|e| {
        error!("Failed to ensure directory: {}", e);
        e.message
    })?;

    info!("Serializing sync data");
    let json =
        serde_json::to_vec(&data).map_err(|e| format!("Failed to serialize sync data: {}", e))?;

    info!("Uploading to {}", remote_path);
    client.upload(&remote_path, json).await.map_err(|e| {
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
    remote_dir: Option<String>,
) -> Result<SyncData, String> {
    let client = WebDavClient::new(config);
    let base_dir = sanitize_remote_dir(remote_dir.as_deref());
    let legacy_path = legacy_sync_file_path(&base_dir);
    let remote_path = match device_name.as_deref() {
        Some(name) if !name.trim().is_empty() => device_sync_file_path(&base_dir, name)?,
        _ => legacy_path.clone(),
    };

    let data = match client.download(&remote_path).await {
        Ok(data) => data,
        Err(e)
            if allow_legacy_fallback
                && remote_path != legacy_path
                && (e.status_code == Some(404) || e.status_code == Some(409)) =>
        {
            client
                .download(&legacy_path)
                .await
                .map_err(|legacy_error| legacy_error.message)?
        }
        Err(e) => return Err(e.message),
    };

    let sync_data: SyncData =
        serde_json::from_slice(&data).map_err(|e| format!("Failed to parse sync data: {}", e))?;

    Ok(sync_data)
}

pub async fn list_device_snapshots(
    config: WebDavConfig,
    device_names: Vec<String>,
    remote_dir: Option<String>,
) -> Result<Vec<DeviceSnapshotInfo>, String> {
    let client = WebDavClient::new(config);
    let base_dir = sanitize_remote_dir(remote_dir.as_deref());
    let mut snapshots = Vec::new();

    for device_name in device_names {
        let name = device_name.trim();
        if name.is_empty() {
            continue;
        }
        let remote_path = device_sync_file_path(&base_dir, name)?;
        let data = match client.download(&remote_path).await {
            Ok(data) => data,
            Err(e) if e.status_code == Some(404) || e.status_code == Some(409) => continue,
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

fn device_sync_file_path(base_dir: &str, device_name: &str) -> Result<String, String> {
    let safe_name = sanitize_device_name(device_name);
    if safe_name.is_empty() {
        return Err("设备名称不能为空".to_string());
    }
    Ok(format!("{}/devices/{}.json", base_dir, safe_name))
}

fn legacy_sync_file_path(base_dir: &str) -> String {
    format!("{}/sync.json", base_dir)
}

/// 规整用户自定义的远程目录片段。用户输入，按安全清单做字符串层校验：
/// 拒绝父目录跳出 (`..`)、反斜杠分隔符，去除前后 `/`，空值回退默认 `cli-manager`。
fn sanitize_remote_dir(remote_dir: Option<&str>) -> String {
    let raw = remote_dir.unwrap_or("").trim();
    if raw.is_empty() {
        return DEFAULT_REMOTE_DIR.to_string();
    }
    // 统一分隔符，去除前后斜杠与空段。
    let normalized = raw.replace('\\', "/");
    let cleaned: Vec<&str> = normalized
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty() && *segment != "." && *segment != "..")
        .collect();
    if cleaned.is_empty() {
        return DEFAULT_REMOTE_DIR.to_string();
    }
    cleaned.join("/")
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
    serde_json::to_writer(&mut writer, data).map_err(|e| format!("序列化失败: {}", e))?;
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
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取 zip 失败: {}", e))?;
    let mut entry = archive.by_name("sync.json").map_err(|e| {
        error!("zip 中找不到 sync.json: {}", e);
        format!("无效的同步文件: {}", e)
    })?;
    if entry.size() > LOCAL_SYNC_JSON_MAX_BYTES {
        return Err("同步文件过大".to_string());
    }

    let data: SyncData =
        serde_json::from_reader(&mut entry).map_err(|e| format!("解析数据失败: {}", e))?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_remote_dir_defaults_when_empty() {
        assert_eq!(sanitize_remote_dir(None), DEFAULT_REMOTE_DIR);
        assert_eq!(sanitize_remote_dir(Some("")), DEFAULT_REMOTE_DIR);
        assert_eq!(sanitize_remote_dir(Some("   ")), DEFAULT_REMOTE_DIR);
    }

    #[test]
    fn sanitize_remote_dir_keeps_valid_paths() {
        assert_eq!(sanitize_remote_dir(Some("cli-manager")), "cli-manager");
        assert_eq!(
            sanitize_remote_dir(Some("backups/cli-mgr")),
            "backups/cli-mgr"
        );
    }

    #[test]
    fn sanitize_remote_dir_strips_surrounding_slashes() {
        assert_eq!(
            sanitize_remote_dir(Some("/backups/cli-mgr/")),
            "backups/cli-mgr"
        );
    }

    #[test]
    fn sanitize_remote_dir_normalizes_backslashes() {
        assert_eq!(sanitize_remote_dir(Some("back\\slash")), "back/slash");
    }

    #[test]
    fn sanitize_remote_dir_rejects_parent_escape() {
        // `..` 段被剥离，剩余安全段保留。
        assert_eq!(sanitize_remote_dir(Some("../etc")), "etc");
        assert_eq!(sanitize_remote_dir(Some("a/../b")), "a/b");
        // 仅由跳出/空段组成时回退默认。
        assert_eq!(sanitize_remote_dir(Some("..")), DEFAULT_REMOTE_DIR);
        assert_eq!(sanitize_remote_dir(Some("./.")), DEFAULT_REMOTE_DIR);
    }

    #[test]
    fn device_sync_file_path_uses_base_dir() {
        assert_eq!(
            device_sync_file_path("cli-manager", "laptop").unwrap(),
            "cli-manager/devices/laptop.json"
        );
        assert_eq!(
            device_sync_file_path("backups/cli-mgr", "laptop").unwrap(),
            "backups/cli-mgr/devices/laptop.json"
        );
    }

    #[test]
    fn legacy_sync_file_path_uses_base_dir() {
        assert_eq!(
            legacy_sync_file_path("cli-manager"),
            "cli-manager/sync.json"
        );
    }

    #[test]
    fn sync_payload_defaults_missing_worktrees() {
        let json = r#"{
            "version": 1,
            "device_id": "device-1",
            "device_name": "laptop",
            "last_modified": "2026-07-14T00:00:00Z",
            "data": {
                "projects": [],
                "groups": [],
                "command_templates": [],
                "settings": {}
            }
        }"#;

        let data: SyncData = serde_json::from_str(json).unwrap();

        assert!(data.data.worktrees.is_empty());
        assert!(data.data.model_prices.is_empty());
    }
}
