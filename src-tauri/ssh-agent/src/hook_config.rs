mod json_hooks;
use json_hooks::{
    add_exact_hooks, exact_commands, inspect_json, read_json, remove_exact_hooks, serialize_json,
};

use crate::installer::{read_installation_record, InstallationRecord};
use crate::layout::{resolve_layout, AgentLayout};
use cli_manager_hook_schema::{
    kimi::{self, KimiPlanAction, ALL_MODULES as ALL_KIMI_HOOK_MODULES},
    HookConfigChange, HookConfigFile, HookConfigReport, HookConfigRequest,
    HookHistorySourceCandidate, HookInstallationFile, HookInstallationRecord,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use toml_edit::{value, DocumentMut, Item};
use uuid::Uuid;

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MISSING_FINGERPRINT: &str = "missing";
const ADAPTER_VERSION: u16 = 1;
const CLAUDE_QUESTION_TOOL_NAME: &str = "AskUserQuestion";
const CODEX_QUESTION_TOOL_NAME: &str = "request_user_input";

const CLAUDE_HOOKS: &[(&str, &str, &str)] = &[
    ("SessionStart", "SessionStart", ""),
    ("UserPromptSubmit", "UserPromptSubmit", ""),
    (
        "Notification",
        "Notification",
        "permission_prompt|idle_prompt",
    ),
    ("PreToolUse", "Notification", CLAUDE_QUESTION_TOOL_NAME),
    ("Stop", "Stop", ""),
    ("StopFailure", "StopFailure", ""),
    ("SubagentStart", "SubagentStart", ""),
    ("SubagentStop", "SubagentStop", ""),
    ("PreToolUse", "AgentToolStart", "Agent|Task"),
    ("PostToolUse", "AgentToolStop", "Agent|Task"),
    ("PreToolUse", "ToolStart", ""),
    ("PostToolUse", "ToolStop", ""),
];

const CODEX_HOOKS: &[(&str, &str, &str)] = &[
    ("SessionStart", "SessionStart", ""),
    ("UserPromptSubmit", "UserPromptSubmit", ""),
    ("PermissionRequest", "PermissionRequest", ""),
    ("PreToolUse", "Notification", CODEX_QUESTION_TOOL_NAME),
    ("Stop", "Stop", ""),
    ("SubagentStart", "SubagentStart", ""),
    ("SubagentStop", "SubagentStop", ""),
];

const GROK_HOOKS: &[(&str, &str, &str)] = &[
    ("SessionStart", "SessionStart", ""),
    ("UserPromptSubmit", "UserPromptSubmit", ""),
    (
        "PreToolUse",
        "PermissionRequest",
        "Bash|Edit|Write|MultiEdit",
    ),
    ("Stop", "Stop", ""),
    ("StopFailure", "StopFailure", ""),
    ("SubagentStart", "SubagentStart", ""),
    ("SubagentStop", "SubagentStop", ""),
    ("PreToolUse", "AgentToolStart", "Agent|Task"),
    ("PostToolUse", "AgentToolStop", "Agent|Task"),
    ("PreToolUse", "ToolStart", ""),
    ("PostToolUse", "ToolStop", ""),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Claude,
    Codex,
    Kimi,
    Grok,
}

impl Source {
    // 仅接受四个已支持的 Hook 来源字符串，未知来源返回统一错误。
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "kimi" => Ok(Self::Kimi),
            "grok" => Ok(Self::Grok),
            _ => Err("hook_source_invalid".to_string()),
        }
    }

    // 把来源枚举转换为协议和记录使用的稳定小写标识。
    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Kimi => "kimi",
            Self::Grok => "grok",
        }
    }

    // 返回各来源在 HOME 下的默认配置目录名，不执行路径解析。
    fn default_dir(self) -> &'static str {
        match self {
            Self::Claude => ".claude",
            Self::Codex => ".codex",
            Self::Kimi => ".kimi-code",
            Self::Grok => ".grok",
        }
    }

    // 返回 JSON Hook 来源的事件、桥接事件和 matcher 映射；Kimi 使用独立 TOML 定义而返回空表。
    fn hooks(self) -> &'static [(&'static str, &'static str, &'static str)] {
        match self {
            Self::Claude => CLAUDE_HOOKS,
            Self::Codex => CODEX_HOOKS,
            Self::Kimi => &[],
            Self::Grok => GROK_HOOKS,
        }
    }

    // 返回应托管的条目数，Kimi 从独立定义集计数而非 JSON Hook 映射。
    fn required_entries(self) -> u32 {
        match self {
            Self::Kimi => kimi::DEFINITIONS.len() as u32,
            _ => self.hooks().len() as u32,
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedRoot {
    configured: String,
    requested: PathBuf,
    canonical: PathBuf,
    hash: String,
    existed: bool,
}

#[derive(Debug, Clone)]
struct FileState {
    role: &'static str,
    logical_path: PathBuf,
    canonical_path: PathBuf,
    bytes: Vec<u8>,
    exists: bool,
    mode: Option<u32>,
}

impl FileState {
    // 根据文件是否存在计算内容指纹，明确区分缺失文件与空文件。
    fn fingerprint(&self) -> String {
        fingerprint(self.exists.then_some(self.bytes.as_slice()))
    }

    // 输出当前文件状态的角色、规范路径、存在性和指纹，不包含配置正文。
    fn report(&self) -> HookConfigFile {
        HookConfigFile {
            role: self.role.to_string(),
            canonical_path: path_text(&self.canonical_path),
            fingerprint: self.fingerprint(),
            exists: self.exists,
        }
    }
}

#[derive(Debug, Clone)]
struct PlannedFile {
    before: FileState,
    after: Vec<u8>,
    after_exists: bool,
}

impl PlannedFile {
    // 根据计划的目标存在性和内容计算应用后指纹。
    fn after_fingerprint(&self) -> String {
        fingerprint(self.after_exists.then_some(self.after.as_slice()))
    }

    // 比较前后指纹与存在性生成 unchanged/delete/update/create 摘要，不写入文件。
    fn change(&self) -> HookConfigChange {
        let before = self.before.fingerprint();
        let after = self.after_fingerprint();
        HookConfigChange {
            role: self.before.role.to_string(),
            canonical_path: path_text(&self.before.canonical_path),
            before_fingerprint: before.clone(),
            after_fingerprint: after.clone(),
            action: if before == after {
                "unchanged".to_string()
            } else if !self.after_exists {
                "delete".to_string()
            } else if self.before.exists {
                "update".to_string()
            } else {
                "create".to_string()
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransactionFile {
    role: String,
    canonical_path: String,
    existed: bool,
    before_fingerprint: String,
    after_fingerprint: String,
    mode: Option<u32>,
    backup_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransactionJournal {
    files: Vec<TransactionFile>,
}

struct HookLock(PathBuf);

impl Drop for HookLock {
    // 释放 Hook 配置锁时尽力删除锁文件，清理失败不传播。
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

// 返回 Unix 纪元毫秒数；系统时间早于纪元时回退零。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// 将路径有损转换为字符串供报告使用，不执行路径合法性检查。
fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

// 要求 Unicode 绝对路径且不含 NUL、回车、换行或反斜杠；不在此 canonicalize 或验证归属。
fn validate_canonical_path(path: &Path) -> Result<(), String> {
    let text = path
        .to_str()
        .ok_or_else(|| "hook_config_canonical_path_invalid".to_string())?;
    if !path.is_absolute() || text.contains(['\0', '\r', '\n', '\\']) {
        return Err("hook_config_canonical_path_invalid".to_string());
    }
    Ok(())
}

// 存在字节计算 SHA-256；None 使用 missing 哨兵，不混同于空内容摘要。
fn fingerprint(bytes: Option<&[u8]>) -> String {
    let Some(bytes) = bytes else {
        return MISSING_FINGERPRINT.to_string();
    };
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

// 对路径的操作系统编码字节取 SHA-256，作为已解析配置根的状态隔离键。
fn config_root_hash(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_os_str().as_encoded_bytes());
    format!("{:x}", hasher.finalize())
}

// Unix 检查目标元数据 UID 与有效用户一致；非 Unix 不执行所有者检查。
fn ensure_current_user_owner(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(path).map_err(|_| "hook_config_metadata_failed".to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("hook_config_owner_mismatch".to_string());
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

// 接受 missing 哨兵或 64 位十六进制摘要格式，不验证其对应文件内容。
fn valid_fingerprint(value: &str) -> bool {
    value == MISSING_FINGERPRINT
        || (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

// 允许空默认值、HOME 波浪号形式或绝对路径，拒绝父级段、控制字符及变量或反引号展开。
fn validate_configured_root(value: &str) -> Result<(), String> {
    if value.contains(['\0', '\r', '\n', '\\', '$', '`']) {
        return Err("hook_config_root_invalid".to_string());
    }
    let path = Path::new(value);
    if value.is_empty() {
        return Ok(());
    }
    if value != "~" && !value.starts_with("~/") && !path.is_absolute() {
        return Err("hook_config_root_invalid".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("hook_config_root_parent_forbidden".to_string());
    }
    Ok(())
}

// 把空值映射到来源默认目录并展开 HOME 波浪号前缀；调用方负责先校验配置文本。
fn expand_root(value: &str, source: Source, layout: &AgentLayout) -> PathBuf {
    if value.is_empty() {
        return layout.home.join(source.default_dir());
    }
    if value == "~" {
        return layout.home.clone();
    }
    value
        .strip_prefix("~/")
        .map(|suffix| layout.home.join(suffix))
        .unwrap_or_else(|| PathBuf::from(value))
}

// 解析配置根并校验目录、规范路径及 Unix 所有者；仅缺失的默认根可按参数创建。
// existed 表示调用前是否存在，即使本次已创建目录也保留原状态供报告使用。
fn resolve_root(
    configured: &str,
    source: Source,
    layout: &AgentLayout,
    create_default: bool,
) -> Result<ResolvedRoot, String> {
    let configured = configured.trim();
    validate_configured_root(configured)?;
    let requested = expand_root(configured, source, layout);
    let is_default = configured.is_empty();
    let missing = !requested.exists();
    if missing && !is_default {
        return Err("hook_config_root_missing".to_string());
    }
    if missing && create_default {
        fs::create_dir_all(&requested).map_err(|_| "hook_config_root_create_failed".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&requested, fs::Permissions::from_mode(0o700))
                .map_err(|_| "hook_config_root_permissions_failed".to_string())?;
        }
    }
    let canonical = if requested.exists() {
        if !requested.is_dir() {
            return Err("hook_config_root_not_directory".to_string());
        }
        fs::canonicalize(&requested)
            .map_err(|_| "hook_config_root_canonicalize_failed".to_string())?
    } else {
        fs::canonicalize(&layout.home)
            .map_err(|_| "home_directory_unavailable".to_string())?
            .join(source.default_dir())
    };
    if canonical.exists() {
        ensure_current_user_owner(&canonical)?;
    }
    validate_canonical_path(&canonical)?;
    let hash = config_root_hash(&canonical);
    Ok(ResolvedRoot {
        configured: configured.to_string(),
        requested,
        canonical,
        hash,
        existed: !missing,
    })
}

// 扫描最多 256 个目录项，以来源、配置文本和可选旧规范根匹配卸载记录，并核对候选根信息。
// 只允许唯一匹配；可恢复已删除根，现存根另验目录、规范路径稳定性和 Unix 所有者。
fn resolve_recorded_uninstall_root(
    configured: &str,
    expected_canonical_root: Option<&str>,
    source: Source,
    layout: &AgentLayout,
) -> Result<ResolvedRoot, String> {
    if let Some(expected) = expected_canonical_root {
        let path = Path::new(expected);
        validate_canonical_path(path)?;
        if expected.trim() != expected
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err("hook_config_canonical_path_invalid".to_string());
        }
    }
    let directory = hook_state_dir(layout).join("installations");
    let mut matches = Vec::new();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("hook_config_root_missing".to_string());
        }
        Err(_) => return Err("hook_config_record_read_failed".to_string()),
    };
    for (index, entry) in entries.enumerate() {
        if index >= 256 {
            return Err("hook_config_record_limit".to_string());
        }
        let path = entry
            .map_err(|_| "hook_config_record_read_failed".to_string())?
            .path();
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&format!("{}-", source.as_str())))
        {
            continue;
        }
        let metadata =
            fs::metadata(&path).map_err(|_| "hook_config_record_read_failed".to_string())?;
        if !metadata.is_file() || metadata.len() > 64 * 1024 {
            return Err("hook_config_record_invalid".to_string());
        }
        let record: HookInstallationRecord = serde_json::from_slice(
            &fs::read(path).map_err(|_| "hook_config_record_read_failed".to_string())?,
        )
        .map_err(|_| "hook_config_record_invalid".to_string())?;
        if record.source != source.as_str()
            || record.configured_config_root != configured
            || expected_canonical_root
                .is_some_and(|expected| record.canonical_config_root != expected)
        {
            continue;
        }
        let canonical = PathBuf::from(&record.canonical_config_root);
        validate_canonical_path(&canonical)?;
        let record_hash = match (source, record.history_source_candidate.as_ref()) {
            (Source::Kimi | Source::Grok, None) => config_root_hash(&canonical),
            (Source::Claude | Source::Codex, Some(candidate))
                if candidate.source == source.as_str()
                    && candidate.canonical_config_root == record.canonical_config_root
                    && candidate.config_root_hash == config_root_hash(&canonical) =>
            {
                candidate.config_root_hash.clone()
            }
            _ => return Err("hook_config_record_invalid".to_string()),
        };
        let existed = canonical.exists();
        if existed {
            if !canonical.is_dir() {
                return Err("hook_config_record_invalid".to_string());
            }
            if fs::canonicalize(&canonical)
                .map_err(|_| "hook_config_root_canonicalize_failed".to_string())?
                != canonical
            {
                return Err("hook_config_root_changed".to_string());
            }
            ensure_current_user_owner(&canonical)?;
        }
        matches.push(ResolvedRoot {
            configured: configured.to_string(),
            requested: canonical.clone(),
            hash: record_hash,
            canonical,
            existed,
        });
    }
    match matches.len() {
        0 if expected_canonical_root.is_some() => Err("hook_config_root_changed".to_string()),
        0 => Err("hook_config_root_missing".to_string()),
        1 => Ok(matches.pop().expect("one matching Hook record")),
        _ => Err("hook_config_record_conflict".to_string()),
    }
}

// 优先解析当前根，缺失或与期望旧根不同才转查记录；其他解析错误直接传播。
fn resolve_uninstall_root(
    configured: &str,
    expected_canonical_root: Option<&str>,
    source: Source,
    layout: &AgentLayout,
) -> Result<ResolvedRoot, String> {
    let configured = configured.trim();
    match resolve_root(configured, source, layout, false) {
        Ok(root)
            if expected_canonical_root
                .is_some_and(|expected| path_text(&root.canonical) != expected) =>
        {
            resolve_recorded_uninstall_root(configured, expected_canonical_root, source, layout)
        }
        Err(error) if error == "hook_config_root_missing" => {
            resolve_recorded_uninstall_root(configured, expected_canonical_root, source, layout)
        }
        result => result,
    }
}

// 重解析请求根以确认仍指向已捕获规范路径；仅原本缺失且仍缺失的根可免除存在性要求。
fn root_target_unchanged(root: &ResolvedRoot) -> Result<(), String> {
    match fs::symlink_metadata(&root.requested) {
        Ok(_) => {
            let current = fs::canonicalize(&root.requested)
                .map_err(|_| "hook_config_root_changed".to_string())?;
            if current != root.canonical {
                return Err("hook_config_root_changed".to_string());
            }
            Ok(())
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && !root.existed
                && !root.canonical.exists() =>
        {
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("hook_config_root_changed".to_string())
        }
        Err(_) => Err("hook_config_metadata_failed".to_string()),
    }
}

// 解析配置文件前后复核根目标，捕获真实路径、内容、存在性与 Unix 权限，并检查所有者和大小。
// 已有符号链接可指向根外文件；元数据大小检查与后续读取并非原子快照。
fn resolve_config_file(
    root: &ResolvedRoot,
    role: &'static str,
    name: &str,
) -> Result<FileState, String> {
    root_target_unchanged(root)?;
    let logical = root.requested.join(name);
    let canonical_path = match fs::symlink_metadata(&logical) {
        Ok(_) => {
            fs::canonicalize(&logical).map_err(|_| "hook_config_symlink_invalid".to_string())?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && root.requested.exists() => {
            fs::canonicalize(&root.requested)
                .map_err(|_| "hook_config_root_canonicalize_failed".to_string())?
                .join(name)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => root.canonical.join(name),
        Err(_) => return Err("hook_config_metadata_failed".to_string()),
    };
    root_target_unchanged(root)?;
    if canonical_path.exists() && !canonical_path.is_file() {
        return Err("hook_config_not_file".to_string());
    }
    validate_canonical_path(&canonical_path)?;
    let exists = canonical_path.exists();
    if exists {
        ensure_current_user_owner(&canonical_path)?;
    }
    let bytes = if exists {
        let metadata =
            fs::metadata(&canonical_path).map_err(|_| "hook_config_metadata_failed".to_string())?;
        if metadata.len() > MAX_CONFIG_BYTES {
            return Err("hook_config_too_large".to_string());
        }
        fs::read(&canonical_path).map_err(|_| "hook_config_read_failed".to_string())?
    } else {
        Vec::new()
    };
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        exists
            .then(|| {
                fs::metadata(&canonical_path)
                    .ok()
                    .map(|value| value.permissions().mode())
            })
            .flatten()
    };
    #[cfg(not(unix))]
    let mode = None;
    Ok(FileState {
        role,
        logical_path: logical,
        canonical_path,
        bytes,
        exists,
        mode,
    })
}

// 要求本地 Agent 安装记录存在并检查启动器路径格式，不在此校验所有记录字段或启动器内容。
fn installation(layout: &AgentLayout) -> Result<InstallationRecord, String> {
    let record = read_installation_record(layout)?
        .ok_or_else(|| "agent_installation_record_missing".to_string())?;
    validate_canonical_path(&record.install_path)?;
    Ok(record)
}

// 以空标准输入和丢弃输出执行 Kimi，轮询退出状态，十秒后尝试终止并回收。
// kill/wait 结果被忽略，try_wait 出错直接返回；这里不保证进程树清理或硬性总耗时上限。
fn run_kimi_command(executable: &Path, args: &[&str]) -> Result<bool, String> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "hook_config_doctor_failed".to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("hook_config_doctor_failed".to_string());
            }
            Err(_) => return Err("hook_config_doctor_failed".to_string()),
        }
    }
}

// 按 PATH 候选再 HOME 默认位置依次执行能力探测，返回首个支持 doctor 的 Kimi。
fn discover_kimi_executable(layout: &AgentLayout) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|path| path.join("kimi")));
    }
    candidates.push(layout.home.join(".kimi-code/bin/kimi"));
    for candidate in candidates {
        if supports_current_kimi(&candidate) {
            return Ok(candidate);
        }
    }
    Err("kimi_code_unsupported".to_string())
}

// 要求候选为文件且 doctor --help 成功；探测错误视为不支持。
fn supports_current_kimi(executable: &Path) -> bool {
    executable.is_file() && run_kimi_command(executable, &["doctor", "--help"]).unwrap_or(false)
}

// 仅 Kimi 来源执行可执行文件发现，其他来源返回 None 且不启动 CLI。
fn ensure_kimi_capability(source: Source, layout: &AgentLayout) -> Result<Option<PathBuf>, String> {
    if source == Source::Kimi {
        discover_kimi_executable(layout).map(Some)
    } else {
        Ok(None)
    }
}

// 把候选配置写入同目录临时文件并同步，设置权限后运行 doctor config 校验，最后尽力删除候选。
// 不替换实际配置文件；临时文件清理失败不会改变校验结果。
fn validate_kimi_candidate(
    executable: &Path,
    config_path: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    let parent = config_path
        .parent()
        .ok_or_else(|| "hook_config_path_invalid".to_string())?;
    let candidate = parent.join(format!(
        ".config.toml.cli-manager-{}.tmp",
        Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file =
            File::create(&candidate).map_err(|_| "kimi_candidate_write_failed".to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "kimi_candidate_write_failed".to_string())?;
        set_mode(&candidate, Some(0o600))?;
        let candidate_text = candidate
            .to_str()
            .ok_or_else(|| "kimi_candidate_path_invalid".to_string())?;
        if run_kimi_command(executable, &["doctor", "config", candidate_text])? {
            Ok(())
        } else {
            Err("hook_config_doctor_failed".to_string())
        }
    })();
    let _ = fs::remove_file(candidate);
    result
}

// 用 POSIX 单引号引用字符串，并将内嵌单引号转为闭合、转义、重新打开形式。
fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// 引用安装启动器路径并拼接固定 Hook 参数，Kimi 额外带精确 owner token。
// 事件与安装 ID 直接拼入命令，依赖调用方提供可信定义及安装记录。
fn hook_command(installation: &InstallationRecord, source: Source, event: &str) -> String {
    let owner = (source == Source::Kimi).then(|| {
        format!(
            " --owner {}{}",
            kimi::SSH_OWNER_PREFIX,
            installation.installation_id
        )
    });
    format!(
        "{} hook --source {} --event {}{} --managed-by cli-manager-ssh-agent --installation-id {}",
        posix_quote(&path_text(&installation.install_path)),
        source.as_str(),
        event,
        owner.as_deref().unwrap_or_default(),
        installation.installation_id
    )
}

// 按 Kimi 定义生成桥接事件到托管命令的有序映射。
fn kimi_commands(installation: &InstallationRecord) -> BTreeMap<String, String> {
    kimi::DEFINITIONS
        .iter()
        .map(|definition| {
            (
                definition.bridge_event.to_string(),
                hook_command(installation, Source::Kimi, definition.bridge_event),
            )
        })
        .collect()
}

// 编码安装 ID、原值与是否新建 features 表，作为 Codex 布尔值尾部恢复标记。
fn feature_marker(installation_id: &str, previous: &str, table_created: bool) -> String {
    format!(
        " # cli-manager-ssh-agent installation={} previous={} tableCreated={}",
        installation_id, previous, table_created
    )
}

// 提取 TOML 值的字符串后缀装饰；非值或不可表示的后缀返回空串。
fn marker_suffix(item: &Item) -> String {
    item.as_value()
        .and_then(|value| value.decor().suffix())
        .and_then(|suffix| suffix.as_str())
        .map(str::to_string)
        .unwrap_or_default()
}

// 从最后一个托管标记解析同安装 ID 的恢复信息；缺失 previous/tableCreated 时分别默认 missing/false。
fn parse_owned_marker(suffix: &str, installation_id: &str) -> Option<(String, bool, String)> {
    let marker = "# cli-manager-ssh-agent ";
    let (original_suffix, fields) = suffix.rsplit_once(marker)?;
    let mut installation = None;
    let mut previous = None;
    let mut table_created = None;
    for field in fields.split_whitespace() {
        let (key, value) = field.split_once('=')?;
        match key {
            "installation" => installation = Some(value),
            "previous" => previous = Some(value),
            "tableCreated" => table_created = Some(value == "true"),
            _ => {}
        }
    }
    (installation == Some(installation_id)).then(|| {
        (
            previous.unwrap_or("missing").to_string(),
            table_created.unwrap_or(false),
            original_suffix.to_string(),
        )
    })
}

// 提取 TOML 值的前后装饰文本用于保留格式，非值或缺失装饰按空串处理。
fn item_decor(item: &Item) -> (String, String) {
    let Some(value) = item.as_value() else {
        return (String::new(), String::new());
    };
    let prefix = value
        .decor()
        .prefix()
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let suffix = value
        .decor()
        .suffix()
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    (prefix, suffix)
}

// 先要求 UTF-8，再解析为可保留格式的 TOML 文档，分别映射编码与语法错误。
fn parse_toml(state: &FileState) -> Result<DocumentMut, String> {
    let text = std::str::from_utf8(&state.bytes)
        .map_err(|_| "hook_config_toml_utf8_invalid".to_string())?;
    DocumentMut::from_str(text).map_err(|_| "hook_config_toml_invalid".to_string())
}

// 仅当 features 表形结构中的 hooks 明确为布尔 true 时判为启用。
fn codex_feature_enabled(document: &DocumentMut) -> bool {
    document
        .get("features")
        .and_then(Item::as_table_like)
        .and_then(|features| features.get("hooks"))
        .and_then(Item::as_bool)
        == Some(true)
}

// 用户已启用时不改；否则开启 hooks 并记录缺失或 false 的原值、表归属和原装饰文本。
fn install_codex_feature(document: &mut DocumentMut, installation_id: &str) -> Result<(), String> {
    if codex_feature_enabled(document) {
        return Ok(());
    }
    let table_created = !document.contains_key("features");
    if table_created {
        document["features"] = Item::Table(toml_edit::Table::new());
    }
    let features = document["features"]
        .as_table_like_mut()
        .ok_or_else(|| "hook_config_toml_features_invalid".to_string())?;
    let (previous, prefix, suffix) = match features.get("hooks") {
        None => ("missing", String::new(), String::new()),
        Some(item) if item.as_bool() == Some(false) => {
            let (prefix, suffix) = item_decor(item);
            ("false", prefix, suffix)
        }
        Some(_) => return Err("hook_config_toml_hooks_invalid".to_string()),
    };
    let mut owned = value(true);
    let decor = owned.as_value_mut().expect("toml bool value").decor_mut();
    decor.set_prefix(prefix);
    decor.set_suffix(format!(
        "{suffix}{}",
        feature_marker(installation_id, previous, table_created)
    ));
    features.insert("hooks", owned);
    Ok(())
}

// 仅还原仍为 true 且带本安装标记的 hooks，恢复原 false 或删除新增项，并按标记清理空表。
fn uninstall_codex_feature(
    document: &mut DocumentMut,
    installation_id: &str,
) -> Result<(), String> {
    let Some(features) = document
        .get_mut("features")
        .and_then(Item::as_table_like_mut)
    else {
        return Ok(());
    };
    let Some(item) = features.get("hooks") else {
        return Ok(());
    };
    if item.as_bool() != Some(true) {
        return Ok(());
    }
    let prefix = item_decor(item).0;
    let Some((previous, table_created, original_suffix)) =
        parse_owned_marker(&marker_suffix(item), installation_id)
    else {
        return Ok(());
    };
    match previous.as_str() {
        "false" => {
            let mut restored = value(false);
            let decor = restored
                .as_value_mut()
                .expect("toml bool value")
                .decor_mut();
            decor.set_prefix(prefix);
            decor.set_suffix(original_suffix);
            features.insert("hooks", restored);
        }
        "missing" => {
            features.remove("hooks");
        }
        _ => return Err("hook_config_toml_marker_invalid".to_string()),
    }
    if table_created && features.is_empty() {
        document.remove("features");
    }
    Ok(())
}

// 记录 Grok 兼容开关原值及两层表是否新建，供同安装卸载恢复。
fn grok_compat_marker(
    installation_id: &str,
    previous: &str,
    compat_created: bool,
    vendor_created: bool,
) -> String {
    format!(
        " # cli-manager-ssh-agent installation={installation_id} previous={previous} compatCreated={compat_created} vendorCreated={vendor_created}"
    )
}

// 解析最后一个同安装 Grok 标记，要求原值字段及两个合法布尔表归属字段完整。
fn parse_grok_compat_marker(
    suffix: &str,
    installation_id: &str,
) -> Option<(String, bool, bool, String)> {
    let marker = "# cli-manager-ssh-agent ";
    let (original_suffix, fields) = suffix.rsplit_once(marker)?;
    let mut installation = None;
    let mut previous = None;
    let mut compat_created = None;
    let mut vendor_created = None;
    for field in fields.split_whitespace() {
        let (key, value) = field.split_once('=')?;
        match key {
            "installation" => installation = Some(value),
            "previous" => previous = Some(value),
            "compatCreated" => {
                compat_created = match value {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => return None,
                }
            }
            "vendorCreated" => {
                vendor_created = match value {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => return None,
                }
            }
            _ => {}
        }
    }
    if installation != Some(installation_id) {
        return None;
    }
    Some((
        previous?.to_string(),
        compat_created?,
        vendor_created?,
        original_suffix.to_string(),
    ))
}

// 为指定兼容来源禁用 hooks 并标记原值和新建表；用户原本已禁用时保持不变。
fn install_grok_compat_hooks(
    document: &mut DocumentMut,
    installation_id: &str,
    vendor: &str,
) -> Result<(), String> {
    let compat_created = !document.contains_key("compat");
    if compat_created {
        document["compat"] = Item::Table(toml_edit::Table::new());
    }
    let compat = document["compat"]
        .as_table_like_mut()
        .ok_or_else(|| "hook_config_toml_compat_invalid".to_string())?;
    let vendor_created = !compat.contains_key(vendor);
    if vendor_created {
        compat.insert(vendor, Item::Table(toml_edit::Table::new()));
    }
    let vendor_config = compat
        .get_mut(vendor)
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "hook_config_toml_compat_vendor_invalid".to_string())?;
    let (previous, prefix, suffix) = match vendor_config.get("hooks") {
        None => ("missing", String::new(), String::new()),
        Some(item) if item.as_bool() == Some(true) => {
            let (prefix, suffix) = item_decor(item);
            ("true", prefix, suffix)
        }
        Some(item) if item.as_bool() == Some(false) => return Ok(()),
        Some(_) => return Err("hook_config_toml_compat_hooks_invalid".to_string()),
    };
    let mut owned = value(false);
    let decor = owned.as_value_mut().expect("toml bool value").decor_mut();
    decor.set_prefix(prefix);
    decor.set_suffix(format!(
        "{suffix}{}",
        grok_compat_marker(installation_id, previous, compat_created, vendor_created)
    ));
    vendor_config.insert("hooks", owned);
    Ok(())
}

// 依次禁用 Claude 与 Cursor 兼容 Hook；出错不撤销已修改的内存文档。
fn install_grok_compat_isolation(
    document: &mut DocumentMut,
    installation_id: &str,
) -> Result<(), String> {
    for vendor in ["claude", "cursor"] {
        install_grok_compat_hooks(document, installation_id, vendor)?;
    }
    Ok(())
}

// 仅恢复仍为 false 且有完整同安装标记的兼容开关，清理本安装新增空 vendor 表并返回 compat 表归属。
fn uninstall_grok_compat_hooks(
    document: &mut DocumentMut,
    installation_id: &str,
    vendor: &str,
) -> Result<bool, String> {
    let Some(compat) = document.get_mut("compat").and_then(Item::as_table_like_mut) else {
        return Ok(false);
    };
    let Some(vendor_config) = compat.get_mut(vendor).and_then(Item::as_table_like_mut) else {
        return Ok(false);
    };
    let Some(item) = vendor_config.get("hooks") else {
        return Ok(false);
    };
    if item.as_bool() != Some(false) {
        return Ok(false);
    }
    let prefix = item_decor(item).0;
    let Some((previous, compat_created, vendor_created, original_suffix)) =
        parse_grok_compat_marker(&marker_suffix(item), installation_id)
    else {
        return Ok(false);
    };
    match previous.as_str() {
        "true" => {
            let mut restored = value(true);
            let decor = restored
                .as_value_mut()
                .expect("toml bool value")
                .decor_mut();
            decor.set_prefix(prefix);
            decor.set_suffix(original_suffix);
            vendor_config.insert("hooks", restored);
        }
        "missing" => {
            vendor_config.remove("hooks");
        }
        _ => return Err("hook_config_toml_marker_invalid".to_string()),
    }
    let remove_vendor = vendor_created && vendor_config.is_empty();
    if remove_vendor {
        compat.remove(vendor);
    }
    Ok(compat_created)
}

// 依次恢复两类兼容 Hook，若标记表明 compat 为本安装创建且已空，再移除顶层表。
fn uninstall_grok_compat_isolation(
    document: &mut DocumentMut,
    installation_id: &str,
) -> Result<(), String> {
    let mut compat_created = false;
    for vendor in ["claude", "cursor"] {
        compat_created |= uninstall_grok_compat_hooks(document, installation_id, vendor)?;
    }
    if compat_created
        && document
            .get("compat")
            .and_then(Item::as_table_like)
            .is_some_and(|compat| compat.is_empty())
    {
        document.remove("compat");
    }
    Ok(())
}

// 按嵌套表、点号表和点号键的优先顺序读取兼容 hooks，只有明确 false 才视为禁用。
fn grok_compat_hooks_disabled(document: &DocumentMut, vendor: &str) -> bool {
    let nested = document
        .get("compat")
        .and_then(Item::as_table_like)
        .and_then(|compat| compat.get(vendor))
        .and_then(Item::as_table_like)
        .and_then(|table| table.get("hooks"))
        .and_then(Item::as_bool);
    let dotted_table = document
        .get(&format!("compat.{vendor}"))
        .and_then(Item::as_table_like)
        .and_then(|table| table.get("hooks"))
        .and_then(Item::as_bool);
    let dotted_key = document
        .get("compat")
        .and_then(Item::as_table_like)
        .and_then(|compat| compat.get(&format!("{vendor}.hooks")))
        .and_then(Item::as_bool);
    nested.or(dotted_table).or(dotted_key) == Some(false)
}

// 要求 Claude 与 Cursor 两类兼容 Hook 都被明确禁用。
fn grok_compat_isolated(document: &DocumentMut) -> bool {
    ["claude", "cursor"]
        .iter()
        .all(|vendor| grok_compat_hooks_disabled(document, vendor))
}

// 按来源读取当前配置，生成检查、安装或卸载的候选字节与存在性，不在此应用文件变更。
// Kimi 用共享 TOML 规划器，Grok/Codex 各联动 JSON 与 TOML；返回的布尔值合并冲突和过期状态。
fn plan_files(
    root: &ResolvedRoot,
    source: Source,
    installation: &InstallationRecord,
    operation: Option<bool>,
) -> Result<(Vec<PlannedFile>, u32, bool), String> {
    if source == Source::Kimi {
        let state = resolve_config_file(root, "kimiConfig", "config.toml")?;
        let original = std::str::from_utf8(&state.bytes)
            .map_err(|_| "hook_config_toml_utf8_invalid".to_string())?;
        let action = match operation {
            Some(true) => KimiPlanAction::Install,
            Some(false) => KimiPlanAction::Uninstall,
            None => KimiPlanAction::Inspect,
        };
        let plan = kimi::plan(
            original,
            &kimi_commands(installation),
            &ALL_KIMI_HOOK_MODULES,
            action,
        )?;
        let after_exists = state.exists || operation == Some(true);
        return Ok((
            vec![PlannedFile {
                before: state,
                after: if after_exists {
                    plan.content.into_bytes()
                } else {
                    Vec::new()
                },
                after_exists,
            }],
            plan.managed_entries,
            plan.conflict || plan.outdated,
        ));
    }
    if source == Source::Grok {
        let json_state = resolve_config_file(root, "grokHooks", "hooks/cli-manager.json")?;
        let mut json_value = read_json(&json_state)?;
        let original_json = json_value.clone();
        let expected = exact_commands(installation, source);
        let (managed_entries, conflict, outdated) = inspect_json(&json_value, source, &expected)?;
        match operation {
            Some(true) => {
                if conflict {
                    return Err("hook_config_owner_conflict".to_string());
                }
                add_exact_hooks(&mut json_value, source, &expected)?;
            }
            Some(false) => {
                if conflict {
                    return Err("hook_config_owner_conflict".to_string());
                }
                remove_exact_hooks(&mut json_value, source, &expected)?;
            }
            None => {}
        }
        let json_after_exists = json_state.exists || operation == Some(true);
        let json_after = if !json_after_exists {
            Vec::new()
        } else if json_state.exists && json_value == original_json {
            json_state.bytes.clone()
        } else {
            serialize_json(&json_value)?
        };
        let toml_state = resolve_config_file(root, "grokCompat", "config.toml")?;
        let mut document = parse_toml(&toml_state)?;
        let toml_after = match operation {
            Some(true) => {
                install_grok_compat_isolation(&mut document, &installation.installation_id)?;
                document.to_string().into_bytes()
            }
            Some(false) => {
                uninstall_grok_compat_isolation(&mut document, &installation.installation_id)?;
                document.to_string().into_bytes()
            }
            _ if toml_state.exists => toml_state.bytes.clone(),
            _ => Vec::new(),
        };
        let toml_after_exists = toml_state.exists || operation == Some(true);
        return Ok((
            vec![
                PlannedFile {
                    before: json_state,
                    after: json_after,
                    after_exists: json_after_exists,
                },
                PlannedFile {
                    before: toml_state,
                    after: toml_after,
                    after_exists: toml_after_exists,
                },
            ],
            managed_entries,
            conflict || outdated,
        ));
    }
    let json_state = resolve_config_file(
        root,
        if source == Source::Claude {
            "claudeSettings"
        } else {
            "codexHooks"
        },
        if source == Source::Claude {
            "settings.json"
        } else {
            "hooks.json"
        },
    )?;
    let mut json_value = read_json(&json_state)?;
    let original_json = json_value.clone();
    let expected = exact_commands(installation, source);
    let (managed_entries, conflict, outdated) = inspect_json(&json_value, source, &expected)?;
    match operation {
        Some(true) => {
            if conflict {
                return Err("hook_config_owner_conflict".to_string());
            }
            add_exact_hooks(&mut json_value, source, &expected)?;
        }
        Some(false) => {
            if conflict {
                return Err("hook_config_owner_conflict".to_string());
            }
            remove_exact_hooks(&mut json_value, source, &expected)?;
        }
        None => {}
    }
    let json_after_exists = json_state.exists || operation == Some(true);
    let json_after = if !json_after_exists {
        Vec::new()
    } else if json_state.exists && json_value == original_json {
        json_state.bytes.clone()
    } else {
        serialize_json(&json_value)?
    };
    let mut plans = vec![PlannedFile {
        before: json_state,
        after: json_after,
        after_exists: json_after_exists,
    }];
    if source == Source::Codex {
        let toml_state = resolve_config_file(root, "codexFeature", "config.toml")?;
        let mut document = parse_toml(&toml_state)?;
        match operation {
            Some(true) => install_codex_feature(&mut document, &installation.installation_id)?,
            Some(false) => uninstall_codex_feature(&mut document, &installation.installation_id)?,
            None => {}
        }
        let toml_after_exists = toml_state.exists || operation == Some(true);
        plans.push(PlannedFile {
            before: toml_state,
            after: if toml_after_exists {
                document.to_string().into_bytes()
            } else {
                Vec::new()
            },
            after_exists: toml_after_exists,
        });
    }
    Ok((plans, managed_entries, conflict || outdated))
}

// 基于计划中的 before 状态判定安装状态和托管数量，并结合 Codex 功能开关或 Grok 兼容隔离状态。
fn current_status(
    plans: &[PlannedFile],
    source: Source,
    installation: &InstallationRecord,
) -> Result<(String, u32), String> {
    if source == Source::Kimi {
        let original = std::str::from_utf8(&plans[0].before.bytes)
            .map_err(|_| "hook_config_toml_utf8_invalid".to_string())?;
        let plan = kimi::plan(
            original,
            &kimi_commands(installation),
            &ALL_KIMI_HOOK_MODULES,
            KimiPlanAction::Inspect,
        )?;
        let status = if plan.conflict {
            "conflict"
        } else if plan.outdated {
            "outdated"
        } else if plan.managed_entries == 0 {
            "notInstalled"
        } else if plan.managed_entries == source.required_entries() {
            "installed"
        } else {
            "partialInstalled"
        };
        return Ok((status.to_string(), plan.managed_entries));
    }
    let json = read_json(&plans[0].before)?;
    let expected = exact_commands(installation, source);
    let (managed, conflict, outdated) = inspect_json(&json, source, &expected)?;
    if conflict {
        return Ok(("conflict".to_string(), managed));
    }
    let feature_ready = match source {
        Source::Codex => {
            let document = parse_toml(&plans[1].before)?;
            codex_feature_enabled(&document)
        }
        Source::Grok => {
            if plans.len() < 2 {
                false
            } else {
                grok_compat_isolated(&parse_toml(&plans[1].before)?)
            }
        }
        _ => true,
    };
    let required = source.required_entries();
    let status = if managed == 0 {
        "notInstalled"
    } else if outdated {
        "outdated"
    } else if managed == required && feature_ready {
        "installed"
    } else {
        "partialInstalled"
    };
    Ok((status.to_string(), managed))
}

// 要求请求提供同数量、合法格式的期望指纹，再按角色和规范路径逐项比对当前计划前态。
fn expected_files_match(plans: &[PlannedFile], request: &HookConfigRequest) -> Result<(), String> {
    if request.expected_files.len() != plans.len() {
        return Err("hook_config_fingerprint_required".to_string());
    }
    let expected: HashMap<(&str, &str), &str> = request
        .expected_files
        .iter()
        .map(|file| {
            if !valid_fingerprint(&file.fingerprint) {
                return Err("hook_config_fingerprint_invalid".to_string());
            }
            Ok((
                (file.role.as_str(), file.canonical_path.as_str()),
                file.fingerprint.as_str(),
            ))
        })
        .collect::<Result<_, String>>()?;
    for plan in plans {
        let key = (plan.before.role, path_text(&plan.before.canonical_path));
        if expected.get(&(key.0, key.1.as_str())).copied()
            != Some(plan.before.fingerprint().as_str())
        {
            return Err("hook_config_changed".to_string());
        }
    }
    Ok(())
}

// 构造 Agent 状态目录下的 hooks 子目录，不创建目录。
fn hook_state_dir(layout: &AgentLayout) -> PathBuf {
    layout.state_dir.join("hooks")
}

// Unix 有有效 PID 且 /proc 可用时按进程存在性判断，否则退回文件修改时间超过五分钟的规则。
fn lock_is_stale(path: &Path) -> bool {
    #[cfg(unix)]
    if let Some(pid) = fs::read_to_string(path)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
    {
        if Path::new("/proc").is_dir() {
            return !Path::new("/proc").join(pid.to_string()).exists();
        }
    }
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > Duration::from_secs(300))
}

// 按根哈希独占新建锁，最多尝试十二次并清理陈旧锁；竞争时短暂等待，PID 写入为尽力操作。
fn acquire_lock(layout: &AgentLayout, root_hash: &str) -> Result<HookLock, String> {
    let directory = hook_state_dir(layout);
    fs::create_dir_all(&directory).map_err(|_| "hook_config_state_create_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "hook_config_state_permissions_failed".to_string())?;
    }
    let path = directory.join(format!("{root_hash}.lock"));
    for _ in 0..12 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                return Ok(HookLock(path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(&path) {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err("hook_config_lock_failed".to_string()),
        }
    }
    Err("hook_config_locked".to_string())
}

// 路径不存在返回缺失空值，否则先检查元数据大小再读取内容；不是并发写入下的原子快照。
fn read_current(path: &Path) -> Result<(bool, Vec<u8>), String> {
    if !path.exists() {
        return Ok((false, Vec::new()));
    }
    let metadata = fs::metadata(path).map_err(|_| "hook_config_metadata_failed".to_string())?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err("hook_config_too_large".to_string());
    }
    Ok((
        true,
        fs::read(path).map_err(|_| "hook_config_read_failed".to_string())?,
    ))
}

// 重新解析逻辑文件或其父目录，确认目标仍等于计划规范路径；允许计划前后均缺失的特定情况。
fn config_target_unchanged(state: &FileState) -> Result<(), String> {
    let current = match fs::symlink_metadata(&state.logical_path) {
        Ok(_) => fs::canonicalize(&state.logical_path)
            .map_err(|_| "hook_config_symlink_invalid".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = state
                .logical_path
                .parent()
                .ok_or_else(|| "hook_config_path_invalid".to_string())?;
            if !state.exists && !parent.exists() && !state.canonical_path.exists() {
                return Ok(());
            }
            let file_name = state
                .logical_path
                .file_name()
                .ok_or_else(|| "hook_config_path_invalid".to_string())?;
            fs::canonicalize(parent)
                .map_err(|_| "hook_config_root_changed".to_string())?
                .join(file_name)
        }
        Err(_) => return Err("hook_config_metadata_failed".to_string()),
    };
    if current != state.canonical_path {
        return Err("hook_config_root_changed".to_string());
    }
    Ok(())
}

// Unix 按可选权限值设置文件模式；None 或非 Unix 平台不修改权限。
fn set_mode(path: &Path, mode: Option<u32>) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|_| "hook_config_permissions_failed".to_string())?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

// 写入并同步同目录临时文件，应用原权限或默认 0600 后重命名替换目标。
// Windows 先删除旧目标再重命名，因此不是原子替换；失败不统一清理临时文件。
fn replace_file(path: &Path, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "hook_config_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "hook_config_parent_create_failed".to_string())?;
    let temporary = parent.join(format!(".cli-manager-hook-{}.tmp", Uuid::new_v4().simple()));
    let mut file = File::create(&temporary).map_err(|_| "hook_config_write_failed".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "hook_config_write_failed".to_string())?;
    set_mode(&temporary, mode.or(Some(0o600)))?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "hook_config_replace_failed".to_string())?;
    }
    fs::rename(&temporary, path).map_err(|_| "hook_config_replace_failed".to_string())
}

// 按原存在性恢复字节与权限，或删除本次创建的文件；原本及当前均缺失时直接成功。
fn restore_file(path: &Path, existed: bool, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    if existed {
        replace_file(path, bytes, mode)
    } else if path.exists() {
        fs::remove_file(path).map_err(|_| "hook_config_restore_failed".to_string())
    } else {
        Ok(())
    }
}

// 按配置根哈希构造 Hook 事务日志目录，调用方提供可信哈希。
fn transaction_dir(layout: &AgentLayout, root_hash: &str) -> PathBuf {
    hook_state_dir(layout).join("transactions").join(root_hash)
}

// 把状态序列化为格式化 JSON，再委托状态字节写入流程。
fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| "hook_config_state_serialize_failed".to_string())?;
    write_bytes_atomic(path, &bytes)
}

// 将状态字节写入唯一临时文件并同步、设为 0600 后替换目标。
// Windows 先删除现有目标，失败可能留下临时文件；函数名不代表所有平台都原子替换。
fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "hook_config_state_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "hook_config_state_create_failed".to_string())?;
    let temporary = parent.join(format!(".hook-state-{}.tmp", Uuid::new_v4().simple()));
    let mut file =
        File::create(&temporary).map_err(|_| "hook_config_state_write_failed".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "hook_config_state_write_failed".to_string())?;
    set_mode(&temporary, Some(0o600))?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "hook_config_state_promote_failed".to_string())?;
    }
    fs::rename(temporary, path).map_err(|_| "hook_config_state_promote_failed".to_string())
}

// 有旧记录字节时恢复，否则删除新记录；已不存在视为成功。
fn restore_hook_record(path: &Path, previous: Option<&[u8]>) -> Result<(), String> {
    if let Some(previous) = previous {
        write_bytes_atomic(path, previous)
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("hook_config_record_rollback_failed".to_string()),
        }
    }
}

// 按日志逆序恢复仍匹配事务后态的文件，已为前态则跳过，外部冲突保留并最终报错。
// 无冲突才删除事务目录；中途错误可发生在部分文件已恢复之后，日志内容被作为本地恢复依据。
fn recover_transaction(layout: &AgentLayout, root_hash: &str) -> Result<(), String> {
    let directory = transaction_dir(layout, root_hash);
    let journal_path = directory.join("journal.json");
    if !journal_path.exists() {
        return Ok(());
    }
    let journal: TransactionJournal = serde_json::from_slice(
        &fs::read(&journal_path).map_err(|_| "hook_config_journal_read_failed".to_string())?,
    )
    .map_err(|_| "hook_config_journal_invalid".to_string())?;
    let mut conflict = false;
    for file in journal.files.iter().rev() {
        let path = PathBuf::from(&file.canonical_path);
        if !path.is_absolute() {
            return Err("hook_config_journal_invalid".to_string());
        }
        let (exists, current) = read_current(&path)?;
        let current_fingerprint = fingerprint(exists.then_some(current.as_slice()));
        if current_fingerprint == file.before_fingerprint {
            continue;
        }
        if current_fingerprint != file.after_fingerprint {
            conflict = true;
            continue;
        }
        let backup = fs::read(directory.join(&file.backup_name))
            .map_err(|_| "hook_config_backup_read_failed".to_string())?;
        restore_file(&path, file.existed, &backup, file.mode)?;
    }
    if conflict {
        return Err("hook_config_recovery_conflict".to_string());
    }
    fs::remove_dir_all(directory).map_err(|_| "hook_config_journal_cleanup_failed".to_string())
}

// 尝试恢复事务，成功保留原错误，失败则把恢复错误追加到原错误文本。
fn transaction_error(layout: &AgentLayout, root_hash: &str, error: String) -> String {
    match recover_transaction(layout, root_hash) {
        Ok(()) => error,
        Err(recovery) => format!("{error}:{recovery}"),
    }
}

// 恢复旧事务并预检所有目标后备份、写日志，逐文件复核、应用并验证，再删除日志目录。
// 路径或指纹冲突及替换错误触发恢复；部分读取与日志操作直接早退，不能将任意错误等同于完整回滚。
fn apply_transaction(
    layout: &AgentLayout,
    root_hash: &str,
    plans: &[PlannedFile],
) -> Result<(), String> {
    recover_transaction(layout, root_hash)?;
    for plan in plans {
        config_target_unchanged(&plan.before)?;
        let (current_exists, current_bytes) = read_current(&plan.before.canonical_path)?;
        if fingerprint(current_exists.then_some(current_bytes.as_slice()))
            != plan.before.fingerprint()
        {
            return Err("hook_config_changed".to_string());
        }
    }
    let directory = transaction_dir(layout, root_hash);
    fs::create_dir_all(&directory).map_err(|_| "hook_config_journal_create_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "hook_config_state_permissions_failed".to_string())?;
    }
    let mut files = Vec::new();
    for (index, plan) in plans.iter().enumerate() {
        let backup_name = format!("{index}.before");
        fs::write(directory.join(&backup_name), &plan.before.bytes)
            .map_err(|_| "hook_config_backup_write_failed".to_string())?;
        set_mode(&directory.join(&backup_name), Some(0o600))?;
        files.push(TransactionFile {
            role: plan.before.role.to_string(),
            canonical_path: path_text(&plan.before.canonical_path),
            existed: plan.before.exists,
            before_fingerprint: plan.before.fingerprint(),
            after_fingerprint: plan.after_fingerprint(),
            mode: plan.before.mode,
            backup_name,
        });
    }
    write_json_atomic(
        &directory.join("journal.json"),
        &TransactionJournal { files },
    )?;
    for plan in plans {
        if plan.before.fingerprint() == plan.after_fingerprint() {
            continue;
        }
        if let Err(error) = config_target_unchanged(&plan.before) {
            return Err(transaction_error(layout, root_hash, error));
        }
        let (current_exists, current_bytes) = read_current(&plan.before.canonical_path)?;
        if fingerprint(current_exists.then_some(current_bytes.as_slice()))
            != plan.before.fingerprint()
        {
            return Err(transaction_error(
                layout,
                root_hash,
                "hook_config_changed".to_string(),
            ));
        }
        let result = if plan.after_exists {
            replace_file(&plan.before.canonical_path, &plan.after, plan.before.mode)
        } else if plan.before.canonical_path.exists() {
            fs::remove_file(&plan.before.canonical_path)
                .map_err(|_| "hook_config_delete_failed".to_string())
        } else {
            Ok(())
        };
        if let Err(error) = result {
            return Err(transaction_error(layout, root_hash, error));
        }
    }
    for plan in plans {
        if let Err(error) = config_target_unchanged(&plan.before) {
            return Err(transaction_error(layout, root_hash, error));
        }
        let (exists, bytes) = read_current(&plan.before.canonical_path)?;
        if exists != plan.after_exists
            || fingerprint(exists.then_some(bytes.as_slice())) != plan.after_fingerprint()
        {
            return Err(transaction_error(
                layout,
                root_hash,
                "hook_config_verify_failed".to_string(),
            ));
        }
    }
    fs::remove_dir_all(directory).map_err(|_| "hook_config_journal_cleanup_failed".to_string())
}

// 按预览或已应用动作选择前后文件指纹，汇总根目录、变更和可选安装记录；不重新读取文件。
fn report(
    outcome: (&str, String),
    source: Source,
    root: &ResolvedRoot,
    installation: &InstallationRecord,
    plans: &[PlannedFile],
    managed_entries: u32,
    record: Option<HookInstallationRecord>,
) -> HookConfigReport {
    let (action, status) = outcome;
    let applied = matches!(action, "installed" | "uninstalled");
    HookConfigReport {
        action: action.to_string(),
        status,
        source: source.as_str().to_string(),
        installation_id: installation.installation_id.clone(),
        remote_machine_id: installation.remote_machine_id.clone(),
        configured_config_root: root.configured.clone(),
        canonical_config_root: path_text(&root.canonical),
        config_root_hash: root.hash.clone(),
        config_root_exists: action == "installed" || root.existed,
        will_create_config_root: action == "previewInstall" && !root.existed,
        config_files: plans
            .iter()
            .map(|plan| {
                if applied {
                    HookConfigFile {
                        role: plan.before.role.to_string(),
                        canonical_path: path_text(&plan.before.canonical_path),
                        fingerprint: plan.after_fingerprint(),
                        exists: plan.after_exists,
                    }
                } else {
                    plan.before.report()
                }
            })
            .collect(),
        managed_entries,
        required_entries: source.required_entries(),
        changes: plans.iter().map(PlannedFile::change).collect(),
        installation: record,
    }
}

// 由成功候选计划构造 Hook 安装记录，保存前后指纹与归属；仅 Claude/Codex 附历史源候选。
fn installation_record(
    source: Source,
    root: &ResolvedRoot,
    installation: &InstallationRecord,
    plans: &[PlannedFile],
) -> HookInstallationRecord {
    HookInstallationRecord {
        source: source.as_str().to_string(),
        installation_id: installation.installation_id.clone(),
        owner_id: format!("cli-manager-ssh-agent:{}", installation.installation_id),
        configured_config_root: root.configured.clone(),
        canonical_config_root: path_text(&root.canonical),
        config_files: plans
            .iter()
            .map(|plan| HookInstallationFile {
                role: plan.before.role.to_string(),
                canonical_path: path_text(&plan.before.canonical_path),
                before_fingerprint: plan.before.fingerprint(),
                after_fingerprint: plan.after_fingerprint(),
            })
            .collect(),
        managed_entries: source.required_entries(),
        adapter_version: ADAPTER_VERSION,
        installed_at: now_ms(),
        history_source_candidate: matches!(source, Source::Claude | Source::Codex).then(|| {
            HookHistorySourceCandidate {
                source: source.as_str().to_string(),
                canonical_config_root: path_text(&root.canonical),
                config_root_hash: root.hash.clone(),
            }
        }),
    }
}

// 以来源和根哈希构造安装记录路径，不访问文件系统。
fn record_path(layout: &AgentLayout, source: Source, root_hash: &str) -> PathBuf {
    hook_state_dir(layout)
        .join("installations")
        .join(format!("{}-{root_hash}.json", source.as_str()))
}

// 读取来源、根和安装状态并生成检查报告，不写配置；Kimi 检查会实际执行能力探测。
pub fn inspect(request: HookConfigRequest) -> Result<HookConfigReport, String> {
    let source = Source::parse(&request.source)?;
    let layout = resolve_layout().map_err(str::to_string)?;
    ensure_kimi_capability(source, &layout)?;
    let installation = installation(&layout)?;
    let root = resolve_root(&request.configured_config_root, source, &layout, false)?;
    let (plans, _, _) = plan_files(&root, source, &installation, None)?;
    let (status, managed) = current_status(&plans, source, &installation)?;
    Ok(report(
        ("inspect", status),
        source,
        &root,
        &installation,
        &plans,
        managed,
        None,
    ))
}

// 为安装或卸载生成候选变更与当前状态，不写配置；Kimi 安装预览会探测 CLI，卸载可沿旧记录解析根。
pub fn preview(request: HookConfigRequest, install: bool) -> Result<HookConfigReport, String> {
    if install && request.expected_canonical_root.is_some() {
        return Err("hook_config_action_invalid".to_string());
    }
    let source = Source::parse(&request.source)?;
    let layout = resolve_layout().map_err(str::to_string)?;
    if install {
        ensure_kimi_capability(source, &layout)?;
    }
    let installation = installation(&layout)?;
    let root = if install {
        resolve_root(&request.configured_config_root, source, &layout, false)?
    } else {
        resolve_uninstall_root(
            &request.configured_config_root,
            request.expected_canonical_root.as_deref(),
            source,
            &layout,
        )?
    };
    let (plans, _, _) = plan_files(&root, source, &installation, Some(install))?;
    let (status, managed) = current_status(&plans, source, &installation)?;
    Ok(report(
        (
            if install {
                "previewInstall"
            } else {
                "previewUninstall"
            },
            status,
        ),
        source,
        &root,
        &installation,
        &plans,
        managed,
        None,
    ))
}

// 解析根后持锁恢复事务、复核预览指纹，Kimi 安装先检查候选，再保存安装记录并应用配置计划。
// 安装失败尝试恢复旧记录；配置、记录及默认根创建不是一个联合事务，卸载记录删除失败不回滚配置。
pub fn apply(request: HookConfigRequest, install: bool) -> Result<HookConfigReport, String> {
    if install && request.expected_canonical_root.is_some() {
        return Err("hook_config_action_invalid".to_string());
    }
    let source = Source::parse(&request.source)?;
    let layout = resolve_layout().map_err(str::to_string)?;
    let kimi_executable = if install {
        ensure_kimi_capability(source, &layout)?
    } else {
        None
    };
    let installation = installation(&layout)?;
    let root = if install {
        resolve_root(&request.configured_config_root, source, &layout, true)?
    } else {
        resolve_uninstall_root(
            &request.configured_config_root,
            request.expected_canonical_root.as_deref(),
            source,
            &layout,
        )?
    };
    let _lock = acquire_lock(&layout, &root.hash)?;
    recover_transaction(&layout, &root.hash)?;
    let (plans, _, _) = plan_files(&root, source, &installation, Some(install))?;
    expected_files_match(&plans, &request)?;
    if install {
        if let Some(executable) = kimi_executable.as_deref() {
            validate_kimi_candidate(executable, &plans[0].before.canonical_path, &plans[0].after)?;
        }
    }
    let record = install.then(|| installation_record(source, &root, &installation, &plans));
    let hook_record_path = record_path(&layout, source, &root.hash);
    let previous_record = fs::read(&hook_record_path).ok();
    if let Some(record) = &record {
        write_json_atomic(&hook_record_path, record)?;
    }
    if let Err(error) = apply_transaction(&layout, &root.hash, &plans) {
        if record.is_some() {
            if let Err(rollback) =
                restore_hook_record(&hook_record_path, previous_record.as_deref())
            {
                return Err(format!("{error}:{rollback}"));
            }
        }
        return Err(error);
    }
    if record.is_none() && hook_record_path.exists() {
        fs::remove_file(hook_record_path)
            .map_err(|_| "hook_config_record_remove_failed".to_string())?;
    }
    Ok(report(
        (
            if install { "installed" } else { "uninstalled" },
            if install { "installed" } else { "notInstalled" }.to_string(),
        ),
        source,
        &root,
        &installation,
        &plans,
        if install {
            source.required_entries()
        } else {
            0
        },
        record,
    ))
}

#[cfg(test)]
mod tests;
