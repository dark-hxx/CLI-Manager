//! 历史会话 mutation 备份服务。
//!
//! 该模块集中管理备份 root、保留清理、恢复 plan 和 manifest。外部历史源仍是真实来源；
//! 备份只用于 mutation 失败回滚或用户手动恢复。

use crate::app_paths;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::System;

pub const HISTORY_BACKUP_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const HISTORY_BACKUP_MAX_BYTES: u64 = 1024 * 1024 * 1024;

const RUNNING_STATES: [&str; 3] = ["running", "restoring", "manualRecoveryRequired"];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBackupManifest {
    pub id: String,
    pub state: String,
    pub source: String,
    pub source_session_id: String,
    pub mutation_kind: String,
    pub created_at: i64,
    pub artifacts: Vec<HistoryBackupArtifact>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBackupArtifact {
    pub kind: String,
    pub original_path: String,
    pub backup_path: String,
    pub fingerprint_value: String,
    pub restore_strategy: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBackupRootStatus {
    pub root: String,
    pub environment_kind: String,
    pub environment_key: String,
    pub max_bytes: u64,
    pub retention_days: u64,
    pub total_bytes: u64,
    pub retained_entries: usize,
    pub protected_entries: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBackupStatus {
    pub has_backup: bool,
    pub backup_path: Option<String>,
    pub backup_at: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBackupRecoveryPlan {
    pub manifest_path: Option<String>,
    pub backup_path: String,
    pub original_path: String,
    pub can_restore: bool,
    pub required_tool_closed: bool,
    pub conflict: Option<String>,
    pub actions: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBackupRestoreCandidate {
    pub original_path: String,
    pub source: String,
    pub source_session_id: String,
    pub mutation_kind: String,
    pub created_at: i64,
    pub state: String,
    pub backup_path: String,
    pub manifest_path: String,
}

struct BackupEntry {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
    protected: bool,
}

struct FileBackupHit {
    manifest_path: PathBuf,
    backup_path: PathBuf,
    fingerprint_value: String,
    created_at: i64,
    state: String,
}

pub fn default_backup_root() -> Result<PathBuf, String> {
    app_paths::history_backups_dir()
}

fn mutation_lock_path(root: &Path, source: &str) -> PathBuf {
    root.join(".locks")
        .join(format!("{}.lock", source.trim().to_lowercase()))
}

pub fn lock_source_mutations(source: &str) -> Result<PathBuf, String> {
    let root = default_backup_root()?;
    let lock = mutation_lock_path(&root, source);
    let parent = lock
        .parent()
        .ok_or_else(|| "history_backup_invalid_lock_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let payload = serde_json::json!({
        "source": source.trim().to_lowercase(),
        "state": "manualRecoveryRequired",
        "createdAt": now_millis()
    });
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|err| err.to_string())?;
    write_atomic(&lock, &bytes)?;
    Ok(lock)
}

pub fn ensure_source_mutation_unlocked(source: &str) -> Result<(), String> {
    let root = default_backup_root()?;
    let lock = mutation_lock_path(&root, source);
    if lock.exists() {
        return Err("history_source_manual_recovery_required".to_string());
    }
    Ok(())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn system_time_to_millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn current_environment_kind() -> String {
    if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else {
        "linux".to_string()
    }
}

fn current_environment_key() -> String {
    if let Ok(distro) = std::env::var("WSL_DISTRO_NAME") {
        let distro = distro.trim();
        if !distro.is_empty() {
            return format!("wsl:{distro}");
        }
    }
    current_environment_kind()
}

pub fn backup_file_path(session_path: &Path, backups_dir: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(session_path.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let stem = session_path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "session".to_string());
    backups_dir.join(format!("{}__{}.jsonl.bak", &digest[..16], stem))
}

fn mutation_backup_dir(backups_dir: &Path, source: &str, source_instance_id: &str, id: &str) -> PathBuf {
    backups_dir.join(source).join(source_instance_id).join(id)
}

fn safe_backup_file_name(original_path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(original_path.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let extension = original_path
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "bak".to_string());
    format!("{}.{}", &digest[..32], extension)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "history_backup_invalid_manifest_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|err| err.to_string())?;
        file.write_all(bytes).map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        err.to_string()
    })
}

fn artifact_fingerprint(path: &Path) -> String {
    let metadata = fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .map(system_time_to_millis)
        .unwrap_or(0);
    let size = metadata.as_ref().map(|metadata| metadata.len()).unwrap_or(0);
    format!("mtime_ms={updated_at};size={size}")
}

fn backup_entry_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::metadata(path) else {
        return 0;
    };
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| backup_entry_size(&entry.path()))
        .sum()
}

fn backup_entry_is_protected(path: &Path) -> bool {
    let manifest = if path.is_dir() {
        path.join("manifest.json")
    } else {
        path.with_extension("manifest.json")
    };
    let Ok(text) = fs::read_to_string(manifest) else {
        return path.is_dir();
    };
    RUNNING_STATES.iter().any(|state| text.contains(state))
}

fn collect_backup_entries(root: &Path) -> Vec<BackupEntry> {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::metadata(&path).ok()?;
            Some(BackupEntry {
                path: path.clone(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                size: backup_entry_size(&path),
                protected: backup_entry_is_protected(&path),
            })
        })
        .collect()
}

fn remove_backup_entry(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|err| err.to_string())
    } else {
        fs::remove_file(path).map_err(|err| err.to_string())
    }
}

pub fn cleanup_backup_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let now = SystemTime::now();
    let entries = collect_backup_entries(root);
    for entry in entries.iter().filter(|entry| !entry.protected) {
        if now
            .duration_since(entry.modified)
            .map(|age| age > HISTORY_BACKUP_RETENTION)
            .unwrap_or(false)
        {
            remove_backup_entry(&entry.path)?;
        }
    }

    let mut entries = collect_backup_entries(root)
        .into_iter()
        .filter(|entry| !entry.protected)
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.modified.cmp(&right.modified));
    let mut total_size = backup_root_size(root);
    for entry in entries {
        if total_size <= HISTORY_BACKUP_MAX_BYTES {
            break;
        }
        remove_backup_entry(&entry.path)?;
        total_size = total_size.saturating_sub(entry.size);
    }
    Ok(())
}

pub fn backup_root_size(root: &Path) -> u64 {
    collect_backup_entries(root)
        .iter()
        .map(|entry| entry.size)
        .sum()
}

fn parse_manifest(path: &Path) -> Option<HistoryBackupManifest> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn collect_manifest_paths(root: &Path) -> Vec<PathBuf> {
    fn visit(path: &Path, output: &mut Vec<PathBuf>) {
        let Ok(metadata) = fs::metadata(path) else {
            return;
        };
        if metadata.is_file() {
            let file_name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            if file_name == "manifest.json" || file_name.ends_with(".manifest.json") {
                output.push(path.to_path_buf());
            }
            return;
        }
        if !metadata.is_dir() {
            return;
        }
        for entry in fs::read_dir(path)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(Result::ok))
        {
            visit(&entry.path(), output);
        }
    }

    let mut output = Vec::new();
    if root.exists() {
        visit(root, &mut output);
    }
    output
}

fn find_file_backup_hit(session_path: &Path, backups_dir: &Path) -> Option<FileBackupHit> {
    let original = session_path.to_string_lossy().to_string();
    let legacy_backup = backup_file_path(session_path, backups_dir);
    let mut hits = Vec::new();
    if legacy_backup.exists() {
        hits.push(FileBackupHit {
            manifest_path: legacy_backup.with_extension("manifest.json"),
            backup_path: legacy_backup.clone(),
            fingerprint_value: String::new(),
            created_at: fs::metadata(&legacy_backup)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .map(system_time_to_millis)
                .unwrap_or(0),
            state: "ready".to_string(),
        });
    }

    for manifest_path in collect_manifest_paths(backups_dir) {
        let Some(manifest) = parse_manifest(&manifest_path) else {
            continue;
        };
        for artifact in manifest.artifacts {
            if artifact.original_path != original {
                continue;
            }
            let backup_path = PathBuf::from(&artifact.backup_path);
            if !backup_path.exists() {
                continue;
            }
            hits.push(FileBackupHit {
                manifest_path: manifest_path.clone(),
                backup_path,
                fingerprint_value: artifact.fingerprint_value,
                created_at: manifest.created_at,
                state: manifest.state.clone(),
            });
        }
    }
    hits.into_iter()
        .min_by(|left, right| left.created_at.cmp(&right.created_at))
}

fn list_file_restore_candidates(backups_dir: &Path) -> Vec<HistoryBackupRestoreCandidate> {
    let mut candidates_by_original = HashMap::<String, HistoryBackupRestoreCandidate>::new();
    for manifest_path in collect_manifest_paths(backups_dir) {
        let Some(manifest) = parse_manifest(&manifest_path) else {
            continue;
        };
        for artifact in &manifest.artifacts {
            if artifact.kind != "file" || artifact.original_path.trim().is_empty() {
                continue;
            }
            let backup_path = PathBuf::from(&artifact.backup_path);
            if !backup_path.is_file() {
                continue;
            }
            let candidate = HistoryBackupRestoreCandidate {
                original_path: artifact.original_path.clone(),
                source: manifest.source.clone(),
                source_session_id: manifest.source_session_id.clone(),
                mutation_kind: manifest.mutation_kind.clone(),
                created_at: manifest.created_at,
                state: manifest.state.clone(),
                backup_path: artifact.backup_path.clone(),
                manifest_path: manifest_path.to_string_lossy().to_string(),
            };
            match candidates_by_original.get(&candidate.original_path) {
                Some(existing) if existing.created_at <= candidate.created_at => {}
                _ => {
                    candidates_by_original.insert(candidate.original_path.clone(), candidate);
                }
            }
        }
    }
    let mut candidates = candidates_by_original.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.original_path.cmp(&right.original_path))
    });
    candidates
}

fn create_file_backup_snapshot_with_limit(
    session_path: &Path,
    backups_dir: &Path,
    source: &str,
    source_session_id: &str,
    mutation_kind: &str,
    max_bytes_override: Option<u64>,
) -> Result<PathBuf, String> {
    fs::create_dir_all(backups_dir).map_err(|err| err.to_string())?;
    let source_size = fs::metadata(session_path)
        .map_err(|err| err.to_string())?
        .len();
    let max_bytes = max_bytes_override.unwrap_or(HISTORY_BACKUP_MAX_BYTES);
    if source_size > max_bytes {
        return Err("history_backup_size_limit_exceeded".to_string());
    }
    cleanup_backup_root(backups_dir)?;
    let id = format!("{}-{mutation_kind}-{source_session_id}", now_millis());
    let mutation_dir = mutation_backup_dir(backups_dir, source, "default", &id);
    let files_dir = mutation_dir.join("files");
    fs::create_dir_all(&files_dir).map_err(|err| err.to_string())?;
    let backup = files_dir.join(safe_backup_file_name(session_path));
    fs::copy(session_path, &backup).map_err(|err| err.to_string())?;
    write_file_manifest(&backup, session_path, source, source_session_id, mutation_kind)?;
    cleanup_backup_root(backups_dir)?;
    Ok(backup)
}

pub fn create_file_backup_snapshot(
    session_path: &Path,
    backups_dir: &Path,
    source: &str,
    source_session_id: &str,
    mutation_kind: &str,
) -> Result<PathBuf, String> {
    create_file_backup_snapshot_with_limit(
        session_path,
        backups_dir,
        source,
        source_session_id,
        mutation_kind,
        None,
    )
}

pub fn ensure_file_backup(session_path: &Path, backups_dir: &Path) -> Result<PathBuf, String> {
    if let Some(hit) = find_file_backup_hit(session_path, backups_dir) {
        return Ok(hit.backup_path);
    }
    let source_session_id = session_path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "session".to_string());
    create_file_backup_snapshot(
        session_path,
        backups_dir,
        "unknown",
        &source_session_id,
        "messageMutation",
    )
}

pub fn backup_status_for_file(session_path: &Path, backups_dir: &Path) -> HistoryBackupStatus {
    let Some(hit) = find_file_backup_hit(session_path, backups_dir) else {
        return HistoryBackupStatus {
            has_backup: false,
            backup_path: None,
            backup_at: None,
        };
    };
    let backup_at = fs::metadata(&hit.backup_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(system_time_to_millis);
    HistoryBackupStatus {
        has_backup: true,
        backup_path: Some(hit.backup_path.to_string_lossy().to_string()),
        backup_at,
    }
}

pub fn is_target_tool_running(source: &str) -> bool {
    let names: &[&str] = match source.trim().to_lowercase().as_str() {
        "claude" => &["claude", "claude-code"],
        "codex" => &["codex"],
        "gemini" => &["gemini"],
        "opencode" => &["opencode"],
        "cursor" => &["cursor"],
        _ => &[],
    };
    if names.is_empty() {
        return false;
    }
    let system = System::new_all();
    system.processes().values().any(|process| {
        let process_name = process.name().to_string_lossy().to_ascii_lowercase();
        let command = process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        names
            .iter()
            .any(|name| process_name == *name || command.contains(name))
    })
}

pub fn build_file_restore_plan(
    session_path: &Path,
    backups_dir: &Path,
    source: Option<&str>,
) -> HistoryBackupRecoveryPlan {
    let hit = find_file_backup_hit(session_path, backups_dir);
    let backup_exists = hit.is_some();
    let original_exists = session_path.exists();
    let tool_running = source.map(is_target_tool_running).unwrap_or(false);
    let fingerprint_conflict = hit
        .as_ref()
        .filter(|hit| {
            matches!(
                hit.state.as_str(),
                "manualRecoveryRequired" | "restoring" | "rollingBack"
            ) && !hit.fingerprint_value.is_empty()
                && original_exists
        })
        .and_then(|hit| {
            let current = artifact_fingerprint(session_path);
            if current == hit.fingerprint_value {
                None
            } else {
                Some("history_backup_fingerprint_conflict".to_string())
            }
        });
    let conflict = if tool_running {
        Some("history_target_tool_running".to_string())
    } else if let Some(conflict) = fingerprint_conflict {
        Some(conflict)
    } else if backup_exists && original_exists {
        None
    } else if !backup_exists {
        Some("backup_not_found".to_string())
    } else {
        Some("original_not_found".to_string())
    };
    HistoryBackupRecoveryPlan {
        manifest_path: hit
            .as_ref()
            .map(|hit| hit.manifest_path.to_string_lossy().to_string()),
        backup_path: hit
            .as_ref()
            .map(|hit| hit.backup_path.to_string_lossy().to_string())
            .unwrap_or_else(|| backup_file_path(session_path, backups_dir).to_string_lossy().to_string()),
        original_path: session_path.to_string_lossy().to_string(),
        can_restore: backup_exists && original_exists && !tool_running && conflict.is_none(),
        required_tool_closed: !tool_running,
        conflict,
        actions: vec![
            "check_target_tool_closed".to_string(),
            "check_current_fingerprint".to_string(),
            "copy_backup_to_original".to_string(),
            "refresh_history_index".to_string(),
        ],
    }
}

pub fn write_file_manifest(
    backup_path: &Path,
    original_path: &Path,
    source: &str,
    source_session_id: &str,
    mutation_kind: &str,
) -> Result<PathBuf, String> {
    let manifest_path = backup_path
        .parent()
        .and_then(|parent| {
            if parent.file_name().map(|name| name == "files").unwrap_or(false) {
                parent.parent().map(|mutation_dir| mutation_dir.join("manifest.json"))
            } else {
                None
            }
        })
        .unwrap_or_else(|| backup_path.with_extension("manifest.json"));
    let manifest = HistoryBackupManifest {
        id: format!("file-{}-{source_session_id}", now_millis()),
        state: "ready".to_string(),
        source: source.to_string(),
        source_session_id: source_session_id.to_string(),
        mutation_kind: mutation_kind.to_string(),
        created_at: now_millis(),
        artifacts: vec![HistoryBackupArtifact {
            kind: "file".to_string(),
            original_path: original_path.to_string_lossy().to_string(),
            backup_path: backup_path.to_string_lossy().to_string(),
            fingerprint_value: artifact_fingerprint(original_path),
            restore_strategy: "fullSnapshot".to_string(),
        }],
    };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|err| err.to_string())?;
    write_atomic(&manifest_path, &bytes)?;
    Ok(manifest_path)
}

pub fn restore_file_backup(
    original_path: &Path,
    backups_dir: &Path,
    source: Option<&str>,
) -> Result<PathBuf, String> {
    let plan = build_file_restore_plan(original_path, backups_dir, source);
    if !plan.can_restore {
        return Err(plan
            .conflict
            .unwrap_or_else(|| "history_backup_restore_not_allowed".to_string()));
    }
    let backup = PathBuf::from(&plan.backup_path);
    let content = fs::read(&backup).map_err(|err| err.to_string())?;
    let tmp = original_path.with_extension("jsonl.cli-manager-tmp");
    fs::write(&tmp, &content).map_err(|err| err.to_string())?;
    fs::rename(&tmp, original_path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        err.to_string()
    })?;
    Ok(backup)
}

#[tauri::command]
pub async fn history_backup_get_root_status() -> Result<HistoryBackupRootStatus, String> {
    let root = default_backup_root()?;
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    cleanup_backup_root(&root)?;
    let entries = collect_backup_entries(&root);
    Ok(HistoryBackupRootStatus {
        root: root.to_string_lossy().to_string(),
        environment_kind: current_environment_kind(),
        environment_key: current_environment_key(),
        max_bytes: HISTORY_BACKUP_MAX_BYTES,
        retention_days: 7,
        total_bytes: entries.iter().map(|entry| entry.size).sum(),
        retained_entries: entries.iter().filter(|entry| !entry.protected).count(),
        protected_entries: entries.iter().filter(|entry| entry.protected).count(),
    })
}

#[tauri::command]
pub async fn history_backup_cleanup() -> Result<HistoryBackupRootStatus, String> {
    let root = default_backup_root()?;
    cleanup_backup_root(&root)?;
    history_backup_get_root_status().await
}

#[tauri::command]
pub async fn history_backup_list_restore_candidates(
) -> Result<Vec<HistoryBackupRestoreCandidate>, String> {
    let root = default_backup_root()?;
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(list_file_restore_candidates(&root)
        .into_iter()
        .filter(|candidate| {
            matches!(
                candidate.source.as_str(),
                "claude"
                    | "codex"
                    | "gemini"
                    | "copilot"
                    | "antigravity"
                    | "grok"
                    | "pi"
                    | "opencode"
                    | "kiro"
                    | "cursor"
                    | "cline"
            )
        })
        .collect())
}

#[tauri::command]
pub async fn history_backup_build_restore_plan(
    original_path: String,
    source: Option<String>,
) -> Result<HistoryBackupRecoveryPlan, String> {
    let root = default_backup_root()?;
    Ok(build_file_restore_plan(
        Path::new(&original_path),
        &root,
        source.as_deref(),
    ))
}

#[tauri::command]
pub async fn history_backup_execute_restore(
    original_path: String,
    source: Option<String>,
) -> Result<HistoryBackupRecoveryPlan, String> {
    let root = default_backup_root()?;
    let original = PathBuf::from(original_path);
    restore_file_backup(&original, &root, source.as_deref())?;
    Ok(build_file_restore_plan(&original, &root, source.as_deref()))
}

#[tauri::command]
pub async fn history_backup_preflight_file(
    original_path: String,
    temporary_max_bytes: Option<u64>,
) -> Result<HistoryBackupRecoveryPlan, String> {
    let root = default_backup_root()?;
    let original = PathBuf::from(original_path);
    let size = fs::metadata(&original)
        .map_err(|err| err.to_string())?
        .len();
    let max_bytes = temporary_max_bytes.unwrap_or(HISTORY_BACKUP_MAX_BYTES);
    if size > max_bytes {
        return Err("history_backup_size_limit_exceeded".to_string());
    }
    Ok(build_file_restore_plan(&original, &root, None))
}

#[tauri::command]
pub async fn history_backup_export_manifest(backup_path: String) -> Result<String, String> {
    let backup = PathBuf::from(backup_path);
    let manifest = backup.with_extension("manifest.json");
    if !manifest.exists() {
        return Err("history_backup_manifest_not_found".to_string());
    }
    Ok(manifest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    #[test]
    fn file_backup_uses_default_limit_and_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("session.jsonl");
        let backups = temp.path().join("backups");
        write_text(&session, "{}\n");

        let backup = ensure_file_backup(&session, &backups).unwrap();
        assert!(backup.exists());
        let manifest =
            write_file_manifest(&backup, &session, "claude", "session", "messageEdit").unwrap();
        assert!(manifest.exists());
        let status = backup_status_for_file(&session, &backups);
        assert!(status.has_backup);
    }

    #[test]
    fn cleanup_skips_protected_manifest_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        let protected = root.join("mutation-1");
        write_text(
            &protected.join("manifest.json"),
            r#"{"state":"manualRecoveryRequired"}"#,
        );
        write_text(&root.join("old.bak"), "old");

        cleanup_backup_root(&root).unwrap();

        assert!(protected.exists());
    }

    #[test]
    fn file_backup_uses_mutation_directory_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("session.jsonl");
        let backups = temp.path().join("backups");
        write_text(&session, "{}\n");

        let backup =
            create_file_backup_snapshot(&session, &backups, "claude", "session", "delete")
                .unwrap();
        assert!(backup.exists());
        assert!(backup.to_string_lossy().contains("\\files\\") || backup.to_string_lossy().contains("/files/"));
        let manifest = backup.parent().unwrap().parent().unwrap().join("manifest.json");
        assert!(manifest.exists());
    }

    #[test]
    fn restore_candidates_expose_original_session_without_manual_path_entry() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("session.jsonl");
        let backups = temp.path().join("backups");
        write_text(&session, "{}\n");

        let backup =
            create_file_backup_snapshot(&session, &backups, "claude", "session-1", "edit")
                .unwrap();
        let candidates = list_file_restore_candidates(&backups);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source, "claude");
        assert_eq!(candidates[0].source_session_id, "session-1");
        assert_eq!(candidates[0].original_path, session.to_string_lossy());
        assert_eq!(candidates[0].backup_path, backup.to_string_lossy());
    }

    #[test]
    fn temporary_limit_applies_only_to_single_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("large.jsonl");
        let backups = temp.path().join("backups");
        write_text(&session, "1234567890");

        let denied = create_file_backup_snapshot_with_limit(
            &session,
            &backups,
            "claude",
            "large",
            "edit",
            Some(5),
        )
        .unwrap_err();
        assert_eq!(denied, "history_backup_size_limit_exceeded");

        let allowed = create_file_backup_snapshot_with_limit(
            &session,
            &backups,
            "claude",
            "large",
            "edit",
            Some(16),
        )
        .unwrap();
        assert!(allowed.exists());
    }

    #[test]
    fn manual_recovery_restore_plan_detects_fingerprint_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("session.jsonl");
        let backups = temp.path().join("backups");
        write_text(&session, "before");
        let backup =
            create_file_backup_snapshot(&session, &backups, "claude", "session", "delete")
                .unwrap();
        let manifest = backup.parent().unwrap().parent().unwrap().join("manifest.json");
        let mut manifest_json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest).unwrap()).unwrap();
        manifest_json["state"] = serde_json::json!("manualRecoveryRequired");
        fs::write(&manifest, serde_json::to_vec_pretty(&manifest_json).unwrap()).unwrap();
        write_text(&session, "changed-after-failure");

        let plan = build_file_restore_plan(&session, &backups, None);
        assert_eq!(
            plan.conflict.as_deref(),
            Some("history_backup_fingerprint_conflict")
        );
        assert!(!plan.can_restore);
    }

    #[test]
    fn restore_file_backup_restores_original_content() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("session.jsonl");
        let backups = temp.path().join("backups");
        write_text(&session, "before");
        ensure_file_backup(&session, &backups).unwrap();
        write_text(&session, "after");

        let restored = restore_file_backup(&session, &backups, None).unwrap();
        assert!(restored.exists());
        assert_eq!(fs::read_to_string(&session).unwrap(), "before");
    }
}
