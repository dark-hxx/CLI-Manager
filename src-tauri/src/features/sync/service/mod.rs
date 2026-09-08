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

// 汇总两份旧版同步数据的修改时间及项目等数量，仅构造冲突信息，不判断是否存在冲突。
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

// 委派 WebDAV OPTIONS 探测，将结构化错误转换为消息文本。
pub async fn test_connection(config: WebDavConfig) -> Result<bool, String> {
    let client = WebDavClient::new(config);
    client.test_connection().await.map_err(|e| e.message)
}

// 按规整后的设备名确保 devices 目录并上传旧版 JSON；同名设备路径会被再次写入。
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

// 下载设备文件或旧共享文件，显式允许且设备请求返回 404/409 时回退 sync.json，再反序列化旧数据。
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

// 按输入设备名逐个下载并统计旧快照，跳过空名称及 404/409，其他错误中止整个查询。
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

// 优先读取 COMPUTERNAME，再尝试 HOSTNAME 并清理名称；不可用或清理为空时使用默认名称。
pub fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .map(|name| sanitize_device_name(&name))
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "当前设备".to_string())
}

// 清理设备名后拼接 devices 下 JSON 路径，名称为空则拒绝；基础目录由调用方提供。
fn device_sync_file_path(base_dir: &str, device_name: &str) -> Result<String, String> {
    let safe_name = sanitize_device_name(device_name);
    if safe_name.is_empty() {
        return Err("设备名称不能为空".to_string());
    }
    Ok(format!("{}/devices/{}.json", base_dir, safe_name))
}

// 在给定基础目录下拼接旧版共享 sync.json 路径。
fn legacy_sync_file_path(base_dir: &str) -> String {
    format!("{}/sync.json", base_dir)
}

/// 规整用户自定义的远程目录片段。用户输入，按安全清单做字符串层校验：
/// 拒绝父目录跳出 (`..`)、反斜杠分隔符，去除前后 `/`，空值回退默认 `cli-manager`。
// 实际将反斜杠转为斜杠并移除空、点和双点段，不返回拒绝错误；无剩余段时使用默认目录。
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

// 保留字母、数字、常见汉字及连字符下划线，将空格和点转为连字符，最多取 64 个字符。
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

// 创建目标目录并以本地秒级时间命名 ZIP，写入 sync.json；同名文件会截断，失败不清理残留。
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

// 读取指定 ZIP 的 sync.json，先检查条目声明大小再反序列化；不解压到磁盘或恢复数据库。
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

// 校验 V3、UUID、可解析时间、十六进制哈希格式及对象数据；不重算哈希或验证各数据域。
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

// 先校验快照，再提取创建时间前 17 个数字构造文件名；清理设备名，不将时间重新格式化为 UTC。
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

// 去除查询和片段后提取末尾路径段，百分号解码并保留 .json 名称；不验证完整 URL 来源。
fn href_file_name(href: &str) -> Option<String> {
    let path = href.split(['?', '#']).next()?;
    let name = path.trim_end_matches('/').rsplit('/').next()?;
    percent_decode(name).filter(|name| name.ends_with(".json"))
}

// 逐字节解析百分号十六进制编码并要求结果为 UTF-8，错误或不完整转义返回空值。
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

// 检查 .json、四段分隔、17 位数字及两个 UUID；不验证日期有效性或设备名段的内容。
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

// 先确保远端备份目录，再校验命名并上传快照；上传后清理失败只记录警告，不改变上传成功结果。
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

// 枚举 href 并从匹配的文件名重建备份路径后排序去重，404/409 按空目录处理。
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

// 逐个下载并校验备份元信息，任一失败中止列表；按 createdAt 字符串降序排序而非解析时间比较。
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

// 校验路径为备份目录的直接文件名后下载并检查快照结构，不核对文件名与 manifest 是否一致。
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

// 校验备份目录前缀及直接子文件名后发送 DELETE，不下载快照内容确认身份。
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

// 按字符串前缀及无斜杠文件名检查直接子路径，再调用文件名格式检查；不做 URL 解码。
fn valid_backup_remote_path(remote_path: &str, backups_dir: &str) -> bool {
    let Some(file_name) = remote_path.strip_prefix(backups_dir) else {
        return false;
    };
    !file_name.contains('/') && !file_name.contains('\\') && is_backup_file_name(file_name)
}

// 按路径中设备标记字符串筛选并字典序倒排，删除保留数量之外的条目；失败中止且不恢复已删文件。
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

// 创建父目录并直接创建或截断目标 ZIP，写入 snapshot.json；不是临时文件替换，也不校验快照。
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

// 校验 V3 快照后以本地时间及快照 ID 命名 ZIP，保留原 JSON 内容并返回路径。
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

// 优先读取 snapshot.json，否则读取 sync.json；检查条目声明大小后返回 JSON，不验证版本或哈希。
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

// 在当前应用数据目录下派生 backups 路径，不在此创建目录。
fn backup_data_dir() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?.join("backups"))
}

// 校验目标哈希和快照后，按原快照 ID 写入目标 outbox；直接写文件，非原子替换且无写入大小上限。
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

// 枚举目标目录的 JSON 文件并限量读取、解析，缺目录返回空列表；不排序或验证快照 schema。
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

// 校验目标哈希及快照 UUID 后删除对应 JSON，文件不存在按成功处理。
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

// 校验快照后直接写入固定 latest.zip，覆盖此前安全快照，不执行恢复。
pub fn save_restore_safety(snapshot: &serde_json::Value) -> Result<String, String> {
    let typed: BackupSnapshotV3 = serde_json::from_value(snapshot.clone())
        .map_err(|error| format!("backup_snapshot_parse_failed: {error}"))?;
    validate_snapshot(&typed)?;
    let path = backup_data_dir()?.join("restore-safety").join("latest.zip");
    write_snapshot_zip(&path, snapshot)?;
    Ok(path.to_string_lossy().into_owned())
}

// 读取固定安全 ZIP 并返回 JSON，缺文件返回空值，不自动应用恢复。
pub fn load_restore_safety() -> Result<Option<serde_json::Value>, String> {
    let path = backup_data_dir()?.join("restore-safety").join("latest.zip");
    if !path.exists() {
        return Ok(None);
    }
    backup_local_import(path.to_string_lossy().as_ref()).map(Some)
}

// 仅删除固定 latest.zip，文件不存在时不执行操作。
pub fn clear_restore_safety() -> Result<(), String> {
    let path = backup_data_dir()?.join("restore-safety").join("latest.zip");
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("backup_safety_remove_failed: {error}"))?;
    }
    Ok(())
}

// 只接受 64 字节 ASCII 十六进制目标标识，不验证它是否由实际 WebDAV 配置计算得到。
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

    // 构造固定 UUID、毫秒时间及五域对象的 V3 测试快照，哈希为格式合法的占位文本。
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
    // 验证固定快照生成预期文件名并清理设备名双连字符，同时拒绝简单穿越名称。
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
    // 验证生成的备份文件可作为直接子项，而多一级目录的路径被拒绝。
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
    // 验证 href 文件名中的空格转义可解码，不完整百分号转义被拒绝。
    fn percent_decode_handles_webdav_href_file_names() {
        assert_eq!(
            percent_decode("work%20laptop.json").as_deref(),
            Some("work laptop.json")
        );
        assert!(percent_decode("bad%2").is_none());
    }

    #[test]
    // 验证缺省、空串及纯空白远端目录都回退默认值。
    fn sanitize_remote_dir_defaults_when_empty() {
        assert_eq!(sanitize_remote_dir(None), DEFAULT_REMOTE_DIR);
        assert_eq!(sanitize_remote_dir(Some("")), DEFAULT_REMOTE_DIR);
        assert_eq!(sanitize_remote_dir(Some("   ")), DEFAULT_REMOTE_DIR);
    }

    #[test]
    // 验证普通单级及多级目录经过规整后保持不变。
    fn sanitize_remote_dir_keeps_valid_paths() {
        assert_eq!(sanitize_remote_dir(Some("cli-manager")), "cli-manager");
        assert_eq!(
            sanitize_remote_dir(Some("backups/cli-mgr")),
            "backups/cli-mgr"
        );
    }

    #[test]
    // 验证远端目录首尾斜杠被移除。
    fn sanitize_remote_dir_strips_surrounding_slashes() {
        assert_eq!(
            sanitize_remote_dir(Some("/backups/cli-mgr/")),
            "backups/cli-mgr"
        );
    }

    #[test]
    // 验证反斜杠实际被转换为斜杠，而不是返回错误。
    fn sanitize_remote_dir_normalizes_backslashes() {
        assert_eq!(sanitize_remote_dir(Some("back\\slash")), "back/slash");
    }

    #[test]
    // 验证双点段被剥离、剩余段保留；仅有点段时回退默认，不执行文件系统路径解析。
    fn sanitize_remote_dir_rejects_parent_escape() {
        // `..` 段被剥离，剩余安全段保留。
        assert_eq!(sanitize_remote_dir(Some("../etc")), "etc");
        assert_eq!(sanitize_remote_dir(Some("a/../b")), "a/b");
        // 仅由跳出/空段组成时回退默认。
        assert_eq!(sanitize_remote_dir(Some("..")), DEFAULT_REMOTE_DIR);
        assert_eq!(sanitize_remote_dir(Some("./.")), DEFAULT_REMOTE_DIR);
    }

    #[test]
    // 验证旧版设备文件路径沿用传入的单级或多级基础目录。
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
    // 验证旧版共享 sync.json 路径位于给定基础目录下。
    fn legacy_sync_file_path_uses_base_dir() {
        assert_eq!(
            legacy_sync_file_path("cli-manager"),
            "cli-manager/sync.json"
        );
    }

    #[test]
    // 验证旧 JSON 缺少 worktrees 和 model_prices 时两字段反序列化为空数组。
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
