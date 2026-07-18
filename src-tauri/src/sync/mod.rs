use crate::webdav::{WebDavClient, WebDavConfig};
use chrono::{Local, Utc};
use log::{debug, error, info};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const DEFAULT_REMOTE_DIR: &str = "cli-manager";
const LOCAL_SYNC_JSON_MAX_BYTES: u64 = 16 * 1024 * 1024;
const BACKUP_RETENTION_PER_DEVICE: usize = 10;

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
    debug!("Creating WebDAV client for {}", config.url);
    let client = WebDavClient::new(config);
    let dir = sanitize_remote_dir(remote_dir.as_deref());
    let devices_dir = format!("{}/devices", dir);
    let remote_path = device_sync_file_path(&dir, &data.device_name)?;

    // ensure_directory 会递归创建所有父目录（backups → backups/cli-mgr → backups/cli-mgr/devices）
    debug!("Ensuring directory exists: {}", devices_dir);
    client.ensure_directory(&devices_dir).await.map_err(|e| {
        error!("Failed to ensure directory: {}", e);
        e.message
    })?;

    debug!("Serializing sync data");
    let json =
        serde_json::to_vec(&data).map_err(|e| format!("Failed to serialize sync data: {}", e))?;

    debug!("Uploading to {}", remote_path);
    client.upload(&remote_path, json).await.map_err(|e| {
        error!("Upload failed: {}", e);
        e.message
    })?;

    debug!("Upload completed successfully");
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub snapshot_id: String,
    pub created_at: String,
    pub app_version: String,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSnapshotV3 {
    pub version: u32,
    pub manifest: BackupManifest,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshotInfo {
    pub remote_path: String,
    pub manifest: BackupManifest,
}

fn validate_snapshot(snapshot: &BackupSnapshotV3) -> Result<(), String> {
    if snapshot.version != 3 {
        return Err("backup_snapshot_unsupported_version".to_string());
    }
    uuid::Uuid::parse_str(&snapshot.manifest.snapshot_id)
        .map_err(|_| "backup_snapshot_invalid_id".to_string())?;
    uuid::Uuid::parse_str(&snapshot.manifest.device_id)
        .map_err(|_| "backup_snapshot_invalid_device_id".to_string())?;
    if snapshot
        .manifest
        .created_at
        .parse::<chrono::DateTime<Utc>>()
        .is_err()
    {
        return Err("backup_snapshot_invalid_created_at".to_string());
    }
    if snapshot.manifest.content_hash.len() != 64
        || !snapshot
            .manifest
            .content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("backup_snapshot_invalid_hash".to_string());
    }
    if !snapshot.data.is_object() {
        return Err("backup_snapshot_invalid_data".to_string());
    }
    Ok(())
}

fn backup_file_name(snapshot: &BackupSnapshotV3) -> Result<String, String> {
    validate_snapshot(snapshot)?;
    let timestamp = snapshot
        .manifest
        .created_at
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .take(17)
        .collect::<String>();
    if timestamp.len() != 17 {
        return Err("backup_snapshot_invalid_created_at".to_string());
    }
    let device_name = sanitize_device_name(&snapshot.manifest.device_name).replace("--", "-");
    let device_name = if device_name.is_empty() {
        "device".to_string()
    } else {
        device_name
    };
    Ok(format!(
        "{}--{}--{}--{}.json",
        timestamp, device_name, snapshot.manifest.device_id, snapshot.manifest.snapshot_id
    ))
}

fn href_file_name(href: &str) -> Option<String> {
    let path = href.split(['?', '#']).next()?;
    let name = path.trim_end_matches('/').rsplit('/').next()?;
    percent_decode(name).filter(|name| name.ends_with(".json"))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            result.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            result.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(result).ok()
}

fn is_backup_file_name(name: &str) -> bool {
    let stem = match name.strip_suffix(".json") {
        Some(stem) => stem,
        None => return false,
    };
    let parts = stem.split("--").collect::<Vec<_>>();
    parts.len() == 4
        && parts[0].len() == 17
        && parts[0].bytes().all(|byte| byte.is_ascii_digit())
        && uuid::Uuid::parse_str(parts[2]).is_ok()
        && uuid::Uuid::parse_str(parts[3]).is_ok()
}

pub async fn upload_backup(
    config: WebDavConfig,
    snapshot: BackupSnapshotV3,
    remote_dir: Option<String>,
) -> Result<String, String> {
    let client = WebDavClient::new(config);
    let base_dir = sanitize_remote_dir(remote_dir.as_deref());
    let backups_dir = format!("{}/backups", base_dir);
    client
        .ensure_directory(&backups_dir)
        .await
        .map_err(|error| error.message)?;
    let remote_path = format!("{}/{}", backups_dir, backup_file_name(&snapshot)?);
    let bytes = serde_json::to_vec_pretty(&snapshot)
        .map_err(|error| format!("backup_snapshot_serialize_failed: {error}"))?;
    client
        .upload(&remote_path, bytes)
        .await
        .map_err(|error| error.message)?;
    if let Err(error) = prune_backups(
        &client,
        &backups_dir,
        &snapshot.manifest.device_id,
        BACKUP_RETENTION_PER_DEVICE,
    )
    .await
    {
        log::warn!("Failed to prune old WebDAV backups: {}", error);
    }
    Ok(remote_path)
}

async fn backup_paths(client: &WebDavClient, backups_dir: &str) -> Result<Vec<String>, String> {
    let hrefs = match client.list(backups_dir).await {
        Ok(hrefs) => hrefs,
        Err(error) if error.status_code == Some(404) || error.status_code == Some(409) => {
            return Ok(Vec::new())
        }
        Err(error) => return Err(error.message),
    };
    let mut paths = hrefs
        .into_iter()
        .filter_map(|href| href_file_name(&href))
        .filter(|name| is_backup_file_name(name))
        .map(|name| format!("{}/{}", backups_dir, name))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub async fn list_backups(
    config: WebDavConfig,
    remote_dir: Option<String>,
) -> Result<Vec<BackupSnapshotInfo>, String> {
    let client = WebDavClient::new(config);
    let backups_dir = format!("{}/backups", sanitize_remote_dir(remote_dir.as_deref()));
    let mut snapshots = Vec::new();
    for remote_path in backup_paths(&client, &backups_dir).await? {
        let bytes = client
            .download(&remote_path)
            .await
            .map_err(|error| error.message)?;
        let snapshot: BackupSnapshotV3 = serde_json::from_slice(&bytes)
            .map_err(|error| format!("backup_snapshot_parse_failed: {error}"))?;
        validate_snapshot(&snapshot)?;
        snapshots.push(BackupSnapshotInfo {
            remote_path,
            manifest: snapshot.manifest,
        });
    }
    snapshots.sort_by(|left, right| right.manifest.created_at.cmp(&left.manifest.created_at));
    Ok(snapshots)
}

pub async fn download_backup(
    config: WebDavConfig,
    remote_path: String,
    remote_dir: Option<String>,
) -> Result<BackupSnapshotV3, String> {
    let base_dir = sanitize_remote_dir(remote_dir.as_deref());
    let backups_dir = format!("{}/backups/", base_dir);
    if !valid_backup_remote_path(&remote_path, &backups_dir) {
        return Err("backup_snapshot_invalid_remote_path".to_string());
    }
    let client = WebDavClient::new(config);
    let bytes = client
        .download(&remote_path)
        .await
        .map_err(|error| error.message)?;
    let snapshot: BackupSnapshotV3 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("backup_snapshot_parse_failed: {error}"))?;
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

pub async fn delete_backup(
    config: WebDavConfig,
    remote_path: String,
    remote_dir: Option<String>,
) -> Result<(), String> {
    let base_dir = sanitize_remote_dir(remote_dir.as_deref());
    let backups_dir = format!("{}/backups/", base_dir);
    if !valid_backup_remote_path(&remote_path, &backups_dir) {
        return Err("backup_snapshot_invalid_remote_path".to_string());
    }
    WebDavClient::new(config)
        .delete(&remote_path)
        .await
        .map_err(|error| error.message)
}

fn valid_backup_remote_path(remote_path: &str, backups_dir: &str) -> bool {
    let Some(file_name) = remote_path.strip_prefix(backups_dir) else {
        return false;
    };
    !file_name.contains('/') && !file_name.contains('\\') && is_backup_file_name(file_name)
}

async fn prune_backups(
    client: &WebDavClient,
    backups_dir: &str,
    device_id: &str,
    keep: usize,
) -> Result<(), String> {
    let marker = format!("--{}--", device_id);
    let mut paths = backup_paths(client, backups_dir)
        .await?
        .into_iter()
        .filter(|path| path.contains(&marker))
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| right.cmp(left));
    for path in paths.into_iter().skip(keep) {
        client.delete(&path).await.map_err(|error| error.message)?;
    }
    Ok(())
}

fn write_snapshot_zip(path: &Path, snapshot: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    let file = File::create(path).map_err(|error| format!("创建 zip 文件失败: {error}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    writer
        .start_file("snapshot.json", options)
        .map_err(|error| format!("写入 zip 失败: {error}"))?;
    serde_json::to_writer_pretty(&mut writer, snapshot)
        .map_err(|error| format!("序列化失败: {error}"))?;
    writer
        .finish()
        .map_err(|error| format!("完成 zip 失败: {error}"))?;
    Ok(())
}

pub fn backup_local_export(dir: &str, snapshot: serde_json::Value) -> Result<String, String> {
    let typed: BackupSnapshotV3 = serde_json::from_value(snapshot.clone())
        .map_err(|error| format!("backup_snapshot_parse_failed: {error}"))?;
    validate_snapshot(&typed)?;
    let snapshot_id = snapshot
        .pointer("/manifest/snapshotId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "backup_snapshot_invalid_id".to_string())?;
    uuid::Uuid::parse_str(snapshot_id).map_err(|_| "backup_snapshot_invalid_id".to_string())?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S");
    let path = Path::new(dir).join(format!(
        "cli-manager-backup-{}-{}.zip",
        timestamp, snapshot_id
    ));
    write_snapshot_zip(&path, &snapshot)?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn backup_local_import(zip_path: &str) -> Result<serde_json::Value, String> {
    let file = File::open(zip_path).map_err(|error| format!("打开 zip 失败: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("读取 zip 失败: {error}"))?;
    let entry_name = if archive.by_name("snapshot.json").is_ok() {
        "snapshot.json"
    } else {
        "sync.json"
    };
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|error| format!("无效的备份文件: {error}"))?;
    if entry.size() > LOCAL_SYNC_JSON_MAX_BYTES {
        return Err("备份文件过大".to_string());
    }
    serde_json::from_reader(&mut entry).map_err(|error| format!("解析数据失败: {error}"))
}

fn backup_data_dir() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?.join("backups"))
}

pub fn save_outbox(target_hash: &str, snapshot: &serde_json::Value) -> Result<String, String> {
    validate_target_hash(target_hash)?;
    let typed: BackupSnapshotV3 = serde_json::from_value(snapshot.clone())
        .map_err(|error| format!("backup_snapshot_parse_failed: {error}"))?;
    validate_snapshot(&typed)?;
    let snapshot_id = snapshot
        .pointer("/manifest/snapshotId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "backup_snapshot_invalid_id".to_string())?;
    uuid::Uuid::parse_str(snapshot_id).map_err(|_| "backup_snapshot_invalid_id".to_string())?;
    let path = backup_data_dir()?
        .join("outbox")
        .join(target_hash)
        .join(format!("{}.json", snapshot_id));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("backup_outbox_create_failed: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(snapshot)
        .map_err(|error| format!("backup_snapshot_serialize_failed: {error}"))?;
    fs::write(&path, bytes).map_err(|error| format!("backup_outbox_write_failed: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn list_outbox(target_hash: &str) -> Result<Vec<serde_json::Value>, String> {
    validate_target_hash(target_hash)?;
    let dir = backup_data_dir()?.join("outbox").join(target_hash);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| format!("backup_outbox_read_failed: {error}"))? {
        let path = entry
            .map_err(|error| format!("backup_outbox_read_failed: {error}"))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let file =
            File::open(&path).map_err(|error| format!("backup_outbox_read_failed: {error}"))?;
        let mut bytes = Vec::new();
        file.take(LOCAL_SYNC_JSON_MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("backup_outbox_read_failed: {error}"))?;
        if bytes.len() > LOCAL_SYNC_JSON_MAX_BYTES as usize {
            return Err("备份文件过大".to_string());
        }
        snapshots.push(
            serde_json::from_slice(&bytes)
                .map_err(|error| format!("backup_snapshot_parse_failed: {error}"))?,
        );
    }
    Ok(snapshots)
}

pub fn remove_outbox(target_hash: &str, snapshot_id: &str) -> Result<(), String> {
    validate_target_hash(target_hash)?;
    uuid::Uuid::parse_str(snapshot_id).map_err(|_| "backup_snapshot_invalid_id".to_string())?;
    let path = backup_data_dir()?
        .join("outbox")
        .join(target_hash)
        .join(format!("{}.json", snapshot_id));
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("backup_outbox_remove_failed: {error}"))?;
    }
    Ok(())
}

pub fn save_restore_safety(snapshot: &serde_json::Value) -> Result<String, String> {
    let typed: BackupSnapshotV3 = serde_json::from_value(snapshot.clone())
        .map_err(|error| format!("backup_snapshot_parse_failed: {error}"))?;
    validate_snapshot(&typed)?;
    let path = backup_data_dir()?.join("restore-safety").join("latest.zip");
    write_snapshot_zip(&path, snapshot)?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn load_restore_safety() -> Result<Option<serde_json::Value>, String> {
    let path = backup_data_dir()?.join("restore-safety").join("latest.zip");
    if !path.exists() {
        return Ok(None);
    }
    backup_local_import(path.to_string_lossy().as_ref()).map(Some)
}

pub fn clear_restore_safety() -> Result<(), String> {
    let path = backup_data_dir()?.join("restore-safety").join("latest.zip");
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("backup_safety_remove_failed: {error}"))?;
    }
    Ok(())
}

fn validate_target_hash(target_hash: &str) -> Result<(), String> {
    if target_hash.len() == 64 && target_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("backup_outbox_invalid_target".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_backup() -> BackupSnapshotV3 {
        BackupSnapshotV3 {
            version: 3,
            manifest: BackupManifest {
                snapshot_id: "11111111-1111-4111-8111-111111111111".to_string(),
                created_at: "2026-07-18T12:34:56.123Z".to_string(),
                app_version: "1.2.9".to_string(),
                device_id: "22222222-2222-4222-8222-222222222222".to_string(),
                device_name: "work--laptop".to_string(),
                platform: "windows".to_string(),
                content_hash: "a".repeat(64),
            },
            data: serde_json::json!({
                "workspace": {},
                "preferences": {},
                "modelPrices": [],
                "notifications": {},
                "statusline": {}
            }),
        }
    }

    #[test]
    fn backup_file_name_is_strict_and_removes_separator_from_device_name() {
        let name = backup_file_name(&sample_backup()).unwrap();
        assert_eq!(
            name,
            "20260718123456123--work-laptop--22222222-2222-4222-8222-222222222222--11111111-1111-4111-8111-111111111111.json"
        );
        assert!(is_backup_file_name(&name));
        assert!(!is_backup_file_name("../snapshot.json"));
    }

    #[test]
    fn backup_remote_path_must_be_direct_child() {
        let name = backup_file_name(&sample_backup()).unwrap();
        assert!(valid_backup_remote_path(
            &format!("cli-manager/backups/{name}"),
            "cli-manager/backups/"
        ));
        assert!(!valid_backup_remote_path(
            &format!("cli-manager/backups/nested/{name}"),
            "cli-manager/backups/"
        ));
    }

    #[test]
    fn percent_decode_handles_webdav_href_file_names() {
        assert_eq!(
            percent_decode("work%20laptop.json").as_deref(),
            Some("work laptop.json")
        );
        assert!(percent_decode("bad%2").is_none());
    }

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
