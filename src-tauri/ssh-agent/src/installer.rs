#[cfg(unix)]
use crate::layout::resolve_layout;
use crate::layout::AgentLayout;
#[cfg(unix)]
use crate::{target_supported, version_report, AGENT_VERSION};
#[cfg(any(unix, test))]
use semver::Version;
use serde::{Deserialize, Serialize};
#[cfg(any(unix, test))]
use sha2::{Digest, Sha256};
use std::fs;
#[cfg(any(unix, test))]
use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(any(unix, test))]
use std::io::Read;
#[cfg(unix)]
use std::io::Write;
use std::path::PathBuf;
#[cfg(any(unix, test))]
use std::path::{Component, Path};
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(unix)]
use uuid::Uuid;

#[cfg(unix)]
const AGENT_FILE_NAME: &str = "cli-manager-ssh-agent";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationRecord {
    pub schema_version: u16,
    pub installation_id: String,
    pub remote_machine_id: String,
    pub agent_version: String,
    pub protocol_version: String,
    pub target: String,
    pub install_root: PathBuf,
    pub install_path: PathBuf,
    pub source: String,
    pub manifest_url: String,
    pub artifact_sha256: String,
    pub installed_at: u64,
    pub previous_version: String,
}

#[derive(Debug, Clone)]
pub struct InstallOptions {
    pub install_dir: Option<PathBuf>,
    pub source: String,
    pub manifest_url: String,
    pub artifact_sha256: String,
    pub allow_downgrade: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub action: &'static str,
    pub installation: Option<InstallationRecord>,
}

#[cfg(unix)]
struct InstallLock {
    path: PathBuf,
    remove_state_dir: bool,
}

#[cfg(unix)]
impl Drop for InstallLock {
    // 释放安装锁，并在标记要求清理时尝试删除空状态目录；两项清理失败均被忽略。
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        if self.remove_state_dir {
            let _ = fs::remove_dir(self.path.parent().unwrap_or(Path::new("/")));
        }
    }
}

#[cfg(unix)]
// 返回 Unix 纪元秒数；系统时间早于纪元时回退为零。
fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(any(unix, test))]
// 展开独立波浪号或波浪号路径前缀，要求绝对路径且无父级段；不解析符号链接或限制到 HOME 内。
fn normalized_absolute(path: &Path, home: &Path) -> Result<PathBuf, String> {
    let expanded = if path == Path::new("~") {
        home.to_path_buf()
    } else if let Ok(suffix) = path.strip_prefix("~") {
        home.join(suffix)
    } else {
        path.to_path_buf()
    };
    if !expanded.is_absolute()
        || expanded
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("agent_install_dir_invalid".to_string());
    }
    Ok(expanded)
}

#[cfg(unix)]
// 构造用户 HOME 下固定 .local/bin 启动器路径，与自定义版本安装根目录分离。
fn launcher_path(layout: &AgentLayout) -> PathBuf {
    layout.home.join(".local/bin").join(AGENT_FILE_NAME)
}

#[cfg(any(unix, test))]
// 以 64 KiB 缓冲流式计算文件 SHA-256，返回小写十六进制摘要并传播读取错误。
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("agent_artifact_read_failed:{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("agent_artifact_read_failed:{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(unix)]
// 创建父目录，将格式化 JSON 写入唯一临时文件并同步，再重命名替换；失败不统一清理临时文件。
fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "agent_state_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("agent_state_create_failed:{error}"))?;
    let temporary = parent.join(format!(".installation-{}.tmp", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("agent_state_serialize_failed:{error}"))?;
    let mut file =
        File::create(&temporary).map_err(|error| format!("agent_state_write_failed:{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("agent_state_write_failed:{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("agent_state_promote_failed:{error}"))
}

// 记录路径不存在时返回 None，否则读取并反序列化；结构解析不等于路径、身份或内容可信验证。
pub fn read_installation_record(
    layout: &AgentLayout,
) -> Result<Option<InstallationRecord>, String> {
    if !layout.installation_record.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&layout.installation_record)
        .map_err(|error| format!("agent_installation_record_read_failed:{error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("agent_installation_record_invalid:{error}"))
}

#[cfg(unix)]
// 仅对反序列化失败的安装记录改名归档后返回 None，读取及归档错误继续传播。
fn recover_installation_record(layout: &AgentLayout) -> Result<Option<InstallationRecord>, String> {
    match read_installation_record(layout) {
        Ok(record) => Ok(record),
        Err(error) if error.starts_with("agent_installation_record_invalid:") => {
            let archive = layout.state_dir.join(format!(
                "installation.corrupt-{}.json",
                Uuid::new_v4().simple()
            ));
            fs::rename(&layout.installation_record, archive).map_err(|rename_error| {
                format!("agent_installation_record_recovery_failed:{rename_error}")
            })?;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
// 依次读取两个 Linux machine-id 文件，返回首个非空值；均不可用时返回 unknown。
fn machine_id() -> String {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(value) = fs::read_to_string(path) {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    "unknown".to_string()
}

#[cfg(unix)]
// 以独占新建文件取得安装锁，首次冲突时依据锁内 PID 和 /proc 尝试清理陈旧锁。
// 最多两次尝试，不等待存活持有者；PID 写入失败会返回错误，但已创建的锁文件不会在此删除。
fn acquire_lock(layout: &AgentLayout) -> Result<InstallLock, String> {
    fs::create_dir_all(&layout.state_dir)
        .map_err(|error| format!("agent_state_create_failed:{error}"))?;
    let path = layout.state_dir.join("install.lock");
    for attempt in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                writeln!(file, "{}", std::process::id())
                    .map_err(|error| format!("agent_install_lock_failed:{error}"))?;
                return Ok(InstallLock {
                    path,
                    remove_state_dir: false,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                let stale = fs::read_to_string(&path)
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok())
                    .is_none_or(|pid| !Path::new("/proc").join(pid.to_string()).exists());
                if stale {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                return Err("agent_install_locked".to_string());
            }
            Err(error) => return Err(format!("agent_install_lock_failed:{error}")),
        }
    }
    Err("agent_install_locked".to_string())
}

#[cfg(unix)]
// 只接受符号链接并读取原始目标；缺失返回 None，普通文件或目录视为冲突。
fn read_link(path: &Path) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::read_link(path)
            .map(Some)
            .map_err(|error| format!("agent_link_read_failed:{error}")),
        Ok(_) => Err("agent_link_conflict".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("agent_link_read_failed:{error}")),
    }
}

#[cfg(unix)]
// 在目标目录创建临时符号链接后重命名替换，拒绝已存在的非链接目标；不负责安装归属校验。
fn replace_symlink(path: &Path, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let parent = path
        .parent()
        .ok_or_else(|| "agent_link_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("agent_link_create_failed:{error}"))?;
    if path.exists()
        && !fs::symlink_metadata(path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("agent_link_conflict".to_string());
    }
    let temporary = parent.join(format!(
        ".{}-{}.tmp",
        AGENT_FILE_NAME,
        Uuid::new_v4().simple()
    ));
    symlink(target, &temporary).map_err(|error| format!("agent_link_create_failed:{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("agent_link_promote_failed:{error}"))
}

#[cfg(unix)]
// 按旧目标尽力恢复链接，无旧目标则尽力删除；恢复失败不覆盖原操作错误。
fn restore_symlink(path: &Path, target: Option<&Path>) {
    match target {
        Some(target) => {
            let _ = replace_symlink(path, target);
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(unix)]
// 依次执行 version 和 doctor --self，核对名称、平台、可选版本及健康报告。
// 使用同步 output 等待子进程并收集输出，此处未设置超时或输出大小上限。
fn validate_installed_binary(path: &Path, expected_version: Option<&str>) -> Result<(), String> {
    let output = Command::new(path)
        .arg("version")
        .output()
        .map_err(|error| format!("agent_self_check_failed:{error}"))?;
    if !output.status.success() {
        return Err("agent_self_check_failed".to_string());
    }
    let report: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("agent_self_check_invalid:{error}"))?;
    if report["agentName"] != "cli-manager-ssh-agent"
        || report["targetOs"] != std::env::consts::OS
        || report["targetArch"] != std::env::consts::ARCH
    {
        return Err("agent_self_check_mismatch".to_string());
    }
    if expected_version.is_some_and(|version| report["agentVersion"] != version) {
        return Err("agent_self_check_version_mismatch".to_string());
    }
    let doctor_output = Command::new(path)
        .args(["doctor", "--self"])
        .output()
        .map_err(|error| format!("agent_doctor_failed:{error}"))?;
    if !doctor_output.status.success() {
        return Err("agent_doctor_failed".to_string());
    }
    let doctor: serde_json::Value = serde_json::from_slice(&doctor_output.stdout)
        .map_err(|error| format!("agent_doctor_invalid:{error}"))?;
    if doctor["version"]["agentName"] != "cli-manager-ssh-agent"
        || doctor["version"]["agentVersion"] != report["agentVersion"]
        || doctor["supported"] != true
        || doctor["code"] != "ok"
    {
        return Err("agent_doctor_unhealthy".to_string());
    }
    Ok(())
}

#[cfg(unix)]
// 执行现有二进制的 version，校验名称与平台后取非空版本字符串；不执行 doctor 或语义版本解析。
fn installed_binary_version(path: &Path) -> Result<String, String> {
    let output = Command::new(path)
        .arg("version")
        .output()
        .map_err(|error| format!("agent_current_self_check_failed:{error}"))?;
    if !output.status.success() {
        return Err("agent_current_self_check_failed".to_string());
    }
    let report: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("agent_current_self_check_invalid:{error}"))?;
    if report["agentName"] != "cli-manager-ssh-agent"
        || report["targetOs"] != std::env::consts::OS
        || report["targetArch"] != std::env::consts::ARCH
    {
        return Err("agent_current_self_check_mismatch".to_string());
    }
    report["agentVersion"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "agent_current_version_missing".to_string())
}

#[cfg(any(unix, test))]
// 去除开头连续的 v 字符后解析语义版本，失败统一返回版本错误码。
fn parse_version(value: &str) -> Result<Version, String> {
    Version::parse(value.trim_start_matches('v')).map_err(|_| "agent_version_invalid".to_string())
}

#[cfg(unix)]
// 定位当前进程二进制并委托 Unix 安装流程，不在此下载或验证发布清单签名。
pub fn install_current_exe(options: InstallOptions) -> Result<InstallResult, String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("agent_current_exe_unavailable:{error}"))?;
    install_from_exe(options, &current_exe)
}

#[cfg(unix)]
// 持锁恢复记录、校验根目录和降级策略，核对摘要后暂存自检，再切换链接并保存安装记录。
// 仅 promote 阶段错误进入链接恢复与新版本清理；恢复为尽力操作，其他阶段可能遗留已创建资源。
fn install_from_exe(options: InstallOptions, current_exe: &Path) -> Result<InstallResult, String> {
    use std::os::unix::fs::PermissionsExt;

    if !target_supported() {
        return Err("unsupported_target".to_string());
    }
    let layout = resolve_layout().map_err(str::to_string)?;
    let mut lock = acquire_lock(&layout)?;
    let existing = recover_installation_record(&layout)?;
    let default_root = existing
        .as_ref()
        .map(|record| record.install_root.as_path())
        .unwrap_or(&layout.data_dir);
    let install_root = normalized_absolute(
        options.install_dir.as_deref().unwrap_or(default_root),
        &layout.home,
    )?;
    if let Some(record) = &existing {
        if record.install_root != install_root {
            return Err("agent_install_root_mismatch".to_string());
        }
    }
    let current_link = install_root.join("current");
    let current_binary = current_link.join(AGENT_FILE_NAME);
    let verified_current_version = current_binary
        .exists()
        .then(|| installed_binary_version(&current_binary).ok())
        .flatten();
    let downgrade_baseline = verified_current_version
        .as_ref()
        .cloned()
        .or_else(|| existing.as_ref().map(|record| record.agent_version.clone()));
    if let Some(current_version) = downgrade_baseline {
        let current = parse_version(&current_version)?;
        let incoming = parse_version(AGENT_VERSION)?;
        if incoming < current && !options.allow_downgrade {
            return Err("agent_downgrade_forbidden".to_string());
        }
    }

    let actual_sha256 = sha256_file(current_exe)?;
    if !options.artifact_sha256.is_empty()
        && !actual_sha256.eq_ignore_ascii_case(&options.artifact_sha256)
    {
        return Err("agent_artifact_sha256_mismatch".to_string());
    }

    let versions_dir = install_root.join("versions");
    let version_dir = versions_dir.join(AGENT_VERSION);
    let installed_binary = version_dir.join(AGENT_FILE_NAME);
    fs::create_dir_all(&versions_dir)
        .map_err(|error| format!("agent_install_dir_create_failed:{error}"))?;
    let version_created = !installed_binary.exists();
    if !version_created {
        if sha256_file(&installed_binary)? != actual_sha256 {
            return Err("agent_version_artifact_conflict".to_string());
        }
    } else {
        let staging = versions_dir.join(format!(
            ".{}-{}.staging",
            AGENT_VERSION,
            Uuid::new_v4().simple()
        ));
        fs::create_dir(&staging).map_err(|error| format!("agent_staging_create_failed:{error}"))?;
        let staged_binary = staging.join(AGENT_FILE_NAME);
        let copy_result = (|| {
            fs::copy(current_exe, &staged_binary)
                .map_err(|error| format!("agent_artifact_copy_failed:{error}"))?;
            fs::set_permissions(&staged_binary, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("agent_artifact_permission_failed:{error}"))?;
            File::open(&staged_binary)
                .and_then(|file| file.sync_all())
                .map_err(|error| format!("agent_artifact_sync_failed:{error}"))?;
            validate_installed_binary(&staged_binary, Some(AGENT_VERSION))?;
            fs::rename(&staging, &version_dir)
                .map_err(|error| format!("agent_version_promote_failed:{error}"))
        })();
        if copy_result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        copy_result?;
    }

    let previous_link = install_root.join("previous");
    let launcher = launcher_path(&layout);
    let old_current = read_link(&current_link)?;
    let old_previous = read_link(&previous_link)?;
    let old_launcher = read_link(&launcher)?;
    if let Some(target) = &old_launcher {
        let owned = existing
            .as_ref()
            .is_some_and(|record| record.install_path == launcher)
            || target == &current_link.join(AGENT_FILE_NAME);
        if !owned {
            return Err("agent_launcher_conflict".to_string());
        }
    }

    let promote = (|| {
        if old_current
            .as_ref()
            .is_some_and(|target| target != &version_dir)
        {
            let target = old_current.as_ref().expect("checked above");
            replace_symlink(&previous_link, target)?;
        }
        replace_symlink(&current_link, &version_dir)?;
        replace_symlink(&launcher, &current_link.join(AGENT_FILE_NAME))?;
        validate_installed_binary(&current_link.join(AGENT_FILE_NAME), Some(AGENT_VERSION))?;
        let report = version_report();
        let record = InstallationRecord {
            schema_version: 1,
            installation_id: existing
                .as_ref()
                .map(|value| value.installation_id.clone())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            remote_machine_id: machine_id(),
            agent_version: report.agent_version.to_string(),
            protocol_version: format!("{}.{}", report.protocol_major, report.protocol_minor),
            target: format!("{}/{}", report.target_os, report.target_arch),
            install_root: install_root.clone(),
            install_path: launcher.clone(),
            source: options.source,
            manifest_url: options.manifest_url,
            artifact_sha256: actual_sha256,
            installed_at: timestamp(),
            previous_version: if old_current
                .as_ref()
                .is_some_and(|target| target != &version_dir)
            {
                verified_current_version.clone().unwrap_or_default()
            } else {
                existing
                    .as_ref()
                    .map(|value| value.previous_version.clone())
                    .unwrap_or_default()
            },
        };
        write_json_atomic(&layout.installation_record, &record)?;
        Ok::<_, String>(record)
    })();
    let record = match promote {
        Ok(record) => record,
        Err(error) => {
            restore_symlink(&current_link, old_current.as_deref());
            restore_symlink(&previous_link, old_previous.as_deref());
            restore_symlink(&launcher, old_launcher.as_deref());
            if version_created
                && old_current.as_ref() != Some(&version_dir)
                && old_previous.as_ref() != Some(&version_dir)
            {
                let _ = fs::remove_dir_all(&version_dir);
            }
            return Err(error);
        }
    };
    lock.remove_state_dir = false;
    Ok(InstallResult {
        action: if existing.is_some() {
            "updated"
        } else {
            "installed"
        },
        installation: Some(record),
    })
}

#[cfg(not(unix))]
// 非 Unix 平台拒绝安装并返回 unsupported_target，不修改文件系统。
pub fn install_current_exe(_options: InstallOptions) -> Result<InstallResult, String> {
    Err("unsupported_target".to_string())
}

#[cfg(unix)]
// 持锁核对安装根目录并交换 current/previous，自检后更新记录中的当前及上一版本。
// 自检或记录写入失败会尽力恢复链接；第二次链接替换和后续版本读取的早退不走该恢复分支。
pub fn rollback(install_dir: Option<PathBuf>) -> Result<InstallResult, String> {
    let layout = resolve_layout().map_err(str::to_string)?;
    let _lock = acquire_lock(&layout)?;
    let mut record = read_installation_record(&layout)?
        .ok_or_else(|| "agent_installation_record_missing".to_string())?;
    let install_root = normalized_absolute(
        install_dir.as_deref().unwrap_or(&record.install_root),
        &layout.home,
    )?;
    if install_root != record.install_root {
        return Err("agent_install_root_mismatch".to_string());
    }
    let current_link = install_root.join("current");
    let previous_link = install_root.join("previous");
    let current = read_link(&current_link)?.ok_or_else(|| "agent_current_missing".to_string())?;
    let previous =
        read_link(&previous_link)?.ok_or_else(|| "agent_previous_missing".to_string())?;
    if current == previous {
        return Err("agent_previous_same_as_current".to_string());
    }
    let swapped = (|| {
        replace_symlink(&current_link, &previous)?;
        replace_symlink(&previous_link, &current)?;
        validate_installed_binary(&current_link.join(AGENT_FILE_NAME), None)?;
        let output = Command::new(current_link.join(AGENT_FILE_NAME))
            .arg("version")
            .output()
            .map_err(|error| format!("agent_self_check_failed:{error}"))?;
        let version: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("agent_self_check_invalid:{error}"))?;
        let old_version = record.agent_version.clone();
        record.agent_version = version["agentVersion"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        record.previous_version = old_version;
        record.installed_at = timestamp();
        write_json_atomic(&layout.installation_record, &record)?;
        Ok::<_, String>(record)
    })();
    let record = match swapped {
        Ok(record) => record,
        Err(error) => {
            restore_symlink(&current_link, Some(&current));
            restore_symlink(&previous_link, Some(&previous));
            return Err(error);
        }
    };
    Ok(InstallResult {
        action: "rolledBack",
        installation: Some(record),
    })
}

#[cfg(not(unix))]
// 非 Unix 平台不支持版本回滚，直接返回错误。
pub fn rollback(_install_dir: Option<PathBuf>) -> Result<InstallResult, String> {
    Err("unsupported_target".to_string())
}

#[cfg(unix)]
// 拒绝仍有托管 Hook 记录的卸载，隔离版本目录后删除链接与记录；普通卸载保留一份记录副本。
// 删除主步骤失败时尽力恢复；隔离目录清理错误被忽略，purge 后续错误不整体回滚已完成卸载。
pub fn uninstall(install_dir: Option<PathBuf>, purge: bool) -> Result<InstallResult, String> {
    let layout = resolve_layout().map_err(str::to_string)?;
    let mut lock = acquire_lock(&layout)?;
    let record = read_installation_record(&layout)?
        .ok_or_else(|| "agent_installation_record_missing".to_string())?;
    let hook_records = layout.state_dir.join("hooks").join("installations");
    if fs::read_dir(&hook_records)
        .ok()
        .is_some_and(|mut entries| entries.any(|entry| entry.is_ok()))
    {
        return Err("agent_managed_hooks_present".to_string());
    }
    let install_root = normalized_absolute(
        install_dir.as_deref().unwrap_or(&record.install_root),
        &layout.home,
    )?;
    if install_root != record.install_root {
        return Err("agent_install_root_mismatch".to_string());
    }
    let current_link = install_root.join("current");
    let previous_link = install_root.join("previous");
    let launcher_target = read_link(&record.install_path)?;
    let current_target = read_link(&current_link)?;
    let previous_target = read_link(&previous_link)?;
    let versions = install_root.join("versions");
    let quarantined_versions =
        install_root.join(format!(".versions-uninstall-{}", Uuid::new_v4().simple()));
    if !purge {
        write_json_atomic(
            &layout.state_dir.join("installation.uninstalled.json"),
            &record,
        )?;
    }
    if versions.exists() {
        fs::rename(&versions, &quarantined_versions)
            .map_err(|error| format!("agent_versions_quarantine_failed:{error}"))?;
    }
    let remove = (|| {
        for path in [&record.install_path, &current_link, &previous_link] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("agent_link_remove_failed:{error}")),
            }
        }
        fs::remove_file(&layout.installation_record)
            .map_err(|error| format!("agent_state_remove_failed:{error}"))
    })();
    if let Err(error) = remove {
        restore_symlink(&record.install_path, launcher_target.as_deref());
        restore_symlink(&current_link, current_target.as_deref());
        restore_symlink(&previous_link, previous_target.as_deref());
        if quarantined_versions.exists() {
            let _ = fs::rename(&quarantined_versions, &versions);
        }
        return Err(error);
    }
    if quarantined_versions.exists() {
        let _ = fs::remove_dir_all(&quarantined_versions);
    }
    if purge {
        for entry in fs::read_dir(&layout.state_dir)
            .map_err(|error| format!("agent_state_read_failed:{error}"))?
        {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path != lock.path {
                if path.is_dir() {
                    fs::remove_dir_all(path).map_err(|error| error.to_string())?;
                } else {
                    fs::remove_file(path).map_err(|error| error.to_string())?;
                }
            }
        }
        let _ = fs::remove_dir(&install_root);
        lock.remove_state_dir = true;
    }
    Ok(InstallResult {
        action: if purge { "purged" } else { "uninstalled" },
        installation: None,
    })
}

#[cfg(not(unix))]
// 非 Unix 平台拒绝卸载或清理请求，不修改文件系统。
pub fn uninstall(_install_dir: Option<PathBuf>, _purge: bool) -> Result<InstallResult, String> {
    Err("unsupported_target".to_string())
}

#[cfg(test)]
mod tests {
    use super::{normalized_absolute, parse_version, sha256_file};
    use std::fs;

    #[test]
    // 验证相对路径及父级穿越被拒绝，波浪号前缀按给定临时 HOME 展开。
    fn install_dir_rejects_relative_and_parent_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        assert!(normalized_absolute(std::path::Path::new("relative"), home).is_err());
        assert!(normalized_absolute(&home.join("agent/../secret"), home).is_err());
        assert_eq!(
            normalized_absolute(std::path::Path::new("~/agent"), home).unwrap(),
            home.join("agent")
        );
    }

    #[test]
    // 验证版本比较遵循语义版本大小，并拒绝无效版本文本。
    fn semantic_versions_drive_downgrade_checks() {
        assert!(parse_version("1.10.0").unwrap() > parse_version("1.9.9").unwrap());
        assert!(parse_version("not-a-version").is_err());
    }

    #[test]
    // 把固定字节写入临时文件，验证流式 SHA-256 与预期摘要一致。
    fn artifact_hash_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent");
        fs::write(&path, b"agent").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "d4f0bc5a29de06b510f9aa428f1eedba926012b591fef7a518e776a7c9bd1824"
        );
    }

    #[cfg(unix)]
    mod unix {
        use super::super::{
            install_from_exe, read_installation_record, uninstall, InstallOptions, AGENT_FILE_NAME,
            AGENT_VERSION,
        };
        use crate::layout::resolve_layout;
        use std::ffi::OsString;
        use std::fs;
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::path::{Path, PathBuf};
        use std::sync::Mutex;

        static ENV_LOCK: Mutex<()> = Mutex::new(());

        struct EnvGuard(Vec<(&'static str, Option<OsString>)>);

        impl EnvGuard {
            // 暂存并替换 HOME/XDG 环境以隔离 Unix 安装测试；调用方需持有测试环境锁。
            fn set(root: &Path) -> Self {
                let values = [
                    ("HOME", root.join("home")),
                    ("XDG_DATA_HOME", root.join("data")),
                    ("XDG_STATE_HOME", root.join("state")),
                    ("XDG_RUNTIME_DIR", root.join("run")),
                ];
                let previous = values
                    .iter()
                    .map(|(key, _)| (*key, std::env::var_os(key)))
                    .collect();
                for (key, value) in values {
                    std::env::set_var(key, value);
                }
                Self(previous)
            }
        }

        impl Drop for EnvGuard {
            // 恢复测试前的 HOME/XDG 环境值，对原先不存在的变量执行移除。
            fn drop(&mut self) {
                for (key, value) in self.0.drain(..) {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }

        // 在测试目录生成仅响应 version/doctor 的可执行 shell 脚本，模拟 Linux Agent 自检。
        fn fake_agent(root: &Path, version: &str) -> PathBuf {
            let path = root.join(format!("agent-{version}"));
            let report = format!(
                "{{\"agentName\":\"cli-manager-ssh-agent\",\"agentVersion\":\"{version}\",\"protocolMajor\":1,\"protocolMinor\":1,\"targetOs\":\"linux\",\"targetArch\":\"{}\"}}",
                std::env::consts::ARCH
            );
            fs::write(
                &path,
                format!(
                    "#!/bin/sh\ncase \"${{1:-}}\" in\n  version) printf '%s\\n' '{report}' ;;\n  doctor) printf '%s\\n' '{{\"version\":{report},\"supported\":true,\"code\":\"ok\"}}' ;;\n  *) exit 2 ;;\nesac\n"
                ),
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        // 构造不允许降级的手动安装测试选项，不要求外部清单地址或预期摘要。
        fn options(install_dir: Option<PathBuf>) -> InstallOptions {
            InstallOptions {
                install_dir,
                source: "manual".into(),
                manifest_url: String::new(),
                artifact_sha256: String::new(),
                allow_downgrade: false,
            }
        }

        #[test]
        // 在隔离 Unix 环境安装两次，验证记录中的自定义根目录被复用，同版本重装不虚构上一版本。
        fn custom_root_is_discovered_and_reused_for_upgrade() {
            let _lock = ENV_LOCK.lock().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let _env = EnvGuard::set(temp.path());
            let source = fake_agent(temp.path(), AGENT_VERSION);
            let custom = temp.path().join("custom agent");
            let first = install_from_exe(options(Some(custom.clone())), &source).unwrap();
            assert_eq!(first.installation.unwrap().install_root, custom);
            let second = install_from_exe(options(None), &source).unwrap();
            assert_eq!(second.action, "updated");
            let second_record = second.installation.unwrap();
            assert_eq!(second_record.install_root, custom);
            assert!(second_record.previous_version.is_empty());
            let layout = resolve_layout().unwrap();
            assert!(layout.installation_record.is_file());
            assert_eq!(
                fs::read_link(custom.join("current")).unwrap(),
                custom.join("versions").join(AGENT_VERSION)
            );
        }

        #[test]
        // 验证非法 JSON 安装记录被归档，随后可通过测试二进制重新建立记录。
        fn corrupt_record_is_archived_and_rebuilt() {
            let _lock = ENV_LOCK.lock().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let _env = EnvGuard::set(temp.path());
            let layout = resolve_layout().unwrap();
            fs::create_dir_all(&layout.state_dir).unwrap();
            fs::write(&layout.installation_record, b"not-json").unwrap();
            let source = fake_agent(temp.path(), AGENT_VERSION);
            install_from_exe(options(None), &source).unwrap();
            assert!(read_installation_record(&layout).unwrap().is_some());
            assert!(fs::read_dir(&layout.state_dir).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("installation.corrupt-")));
        }

        #[test]
        // 在无记录的临时安装布局放置高版本 current，验证现有二进制仍能阻止降级。
        fn current_binary_enforces_downgrade_without_a_record() {
            let _lock = ENV_LOCK.lock().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let _env = EnvGuard::set(temp.path());
            let layout = resolve_layout().unwrap();
            let newer_dir = layout.data_dir.join("versions/99.0.0");
            fs::create_dir_all(&newer_dir).unwrap();
            let newer = fake_agent(temp.path(), "99.0.0");
            fs::copy(newer, newer_dir.join(AGENT_FILE_NAME)).unwrap();
            symlink(&newer_dir, layout.data_dir.join("current")).unwrap();
            let source = fake_agent(temp.path(), AGENT_VERSION);
            assert_eq!(
                install_from_exe(options(None), &source).unwrap_err(),
                "agent_downgrade_forbidden"
            );
        }

        #[test]
        // 用当前 PID 建立测试锁，验证安装流程拒绝第二个写入者。
        fn active_install_lock_rejects_a_second_writer() {
            let _lock = ENV_LOCK.lock().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let _env = EnvGuard::set(temp.path());
            let layout = resolve_layout().unwrap();
            fs::create_dir_all(&layout.state_dir).unwrap();
            fs::write(
                layout.state_dir.join("install.lock"),
                std::process::id().to_string(),
            )
            .unwrap();
            let source = fake_agent(temp.path(), AGENT_VERSION);
            assert_eq!(
                install_from_exe(options(None), &source).unwrap_err(),
                "agent_install_locked"
            );
        }

        #[test]
        // 在隔离 Unix 布局安装再普通卸载，验证启动链接与版本目录删除、卸载记录副本保留。
        fn normal_uninstall_removes_links_and_keeps_one_record() {
            let _lock = ENV_LOCK.lock().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let _env = EnvGuard::set(temp.path());
            let source = fake_agent(temp.path(), AGENT_VERSION);
            let installed = install_from_exe(options(None), &source)
                .unwrap()
                .installation
                .unwrap();
            let result = uninstall(None, false).unwrap();
            assert_eq!(result.action, "uninstalled");
            assert!(!installed.install_path.exists());
            assert!(!installed.install_root.join("current").exists());
            assert!(!installed.install_root.join("versions").exists());
            let layout = resolve_layout().unwrap();
            assert!(!layout.installation_record.exists());
            assert!(layout
                .state_dir
                .join("installation.uninstalled.json")
                .is_file());
        }

        #[test]
        // 在测试安装状态中加入 Hook 记录，验证卸载被拒绝且安装记录保留。
        fn uninstall_refuses_to_leave_managed_hooks_broken() {
            let _lock = ENV_LOCK.lock().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let _env = EnvGuard::set(temp.path());
            let source = fake_agent(temp.path(), AGENT_VERSION);
            install_from_exe(options(None), &source).unwrap();
            let layout = resolve_layout().unwrap();
            let hooks = layout.state_dir.join("hooks/installations");
            fs::create_dir_all(&hooks).unwrap();
            fs::write(hooks.join("claude-record.json"), b"{}").unwrap();
            assert_eq!(
                uninstall(None, false).unwrap_err(),
                "agent_managed_hooks_present"
            );
            assert!(layout.installation_record.exists());
        }
    }
}
