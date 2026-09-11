use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

const APP_HOME_DIR_NAME: &str = ".cli-manager";
const PORTABLE_FLAG_FILE_NAME: &str = "portable.flag";
const PORTABLE_DATA_DIR_NAME: &str = "data";
const DATA_ROOT_BOOTSTRAP_FILE_NAME: &str = "data-root.json";
const DATA_ROOT_BOOTSTRAP_VERSION: u32 = 1;
const WINDOWS_APP_IDENTIFIER: &str = "com.cli-manager.app";
const MACHINE_ID_FILE_NAME: &str = "machine-id";
const DB_FILE_NAME: &str = "cli-manager.db";
const PROVIDERS_DB_FILE_NAME: &str = "providers.db";
const SETTINGS_STORE_FILE_NAME: &str = "settings.json";
const SESSIONS_STORE_FILE_NAME: &str = "sessions.json";
const DEV_SESSIONS_STORE_FILE_NAME: &str = "sessions.dev.json";
const SYNC_STORE_FILE_NAME: &str = "sync-config.json";
const EXTERNAL_SESSION_SYNC_STORE_FILE_NAME: &str = "external-session-sync.json";
const STORE_FILES: [&str; 4] = [
    SETTINGS_STORE_FILE_NAME,
    SESSIONS_STORE_FILE_NAME,
    SYNC_STORE_FILE_NAME,
    EXTERNAL_SESSION_SYNC_STORE_FILE_NAME,
];
const SYNC_STORE_LEGACY_IGNORED_KEYS: &[&str] = &["webdavPassword", "hasPassword"];
static DATA_ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppDistribution {
    Standalone,
    Portable,
    Aur,
}

impl AppDistribution {
    // 返回设置状态与诊断使用的稳定发行方式标签。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standalone => "standalone",
            Self::Portable => "portable",
            Self::Aur => "aur",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataRootBootstrap {
    #[serde(default = "data_root_bootstrap_version")]
    version: u32,
    #[serde(default)]
    custom_data_dir: Option<String>,
    #[serde(default)]
    pending_switch: Option<PendingDataRootSwitch>,
    #[serde(default)]
    last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingDataRootSwitch {
    target_mode: String,
    target_dir: String,
    source_dir: String,
    migrate: bool,
}

impl Default for DataRootBootstrap {
    // 构造当前版本的空引导配置，未选择自定义目录，也没有待执行切换或错误。
    fn default() -> Self {
        Self {
            version: DATA_ROOT_BOOTSTRAP_VERSION,
            custom_data_dir: None,
            pending_switch: None,
            last_error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStorageStatus {
    pub supported: bool,
    pub distribution: String,
    pub mode: String,
    pub current_data_dir: String,
    pub default_data_dir: String,
    pub bootstrap_path: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStorageInspection {
    pub target_dir: String,
    pub exists: bool,
    pub empty: bool,
    pub writable: bool,
    pub same_as_current: bool,
}

// 为反序列化缺失 version 字段提供当前引导格式版本。
fn data_root_bootstrap_version() -> u32 {
    DATA_ROOT_BOOTSTRAP_VERSION
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliManagerDataPaths {
    pub data_dir: String,
    pub db_path: String,
    pub db_url: String,
    pub settings_store_path: String,
    pub sessions_store_path: String,
    pub sync_store_path: String,
    pub external_session_sync_store_path: String,
    pub logs_dir: String,
    pub codex_providers_dir: String,
    pub claude_providers_dir: String,
}

// 优先取非空 USERPROFILE，再取 HOME；仅解析环境路径，不检查目录是否存在。
pub(crate) fn home_dir_from_env() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return Ok(home);
    }
    if let Some(home) = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return Ok(home);
    }
    Err("home_dir_unavailable".to_string())
}

// 纯计算发行方式：显式 AUR 优先，其次 Windows 便携标记，其余为独立安装版。
fn distribution_from_inputs(
    configured_distribution: Option<&str>,
    portable_marker_exists: bool,
    is_windows: bool,
) -> AppDistribution {
    if configured_distribution.is_some_and(|value| value.eq_ignore_ascii_case("aur")) {
        return AppDistribution::Aur;
    }
    if is_windows && portable_marker_exists {
        return AppDistribution::Portable;
    }
    AppDistribution::Standalone
}

// 获取当前可执行文件父目录，无法定位程序或父目录时返回明确错误。
fn executable_dir() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|err| format!("current_exe_unavailable: {err}"))?;
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "current_exe_parent_unavailable".to_string())
}

// 结合发行环境变量与 Windows 程序旁 portable.flag 判断发行方式，不缓存结果。
pub fn app_distribution() -> AppDistribution {
    #[cfg(target_os = "windows")]
    let portable_marker_exists = executable_dir()
        .ok()
        .is_some_and(|dir| dir.join(PORTABLE_FLAG_FILE_NAME).is_file());
    #[cfg(not(target_os = "windows"))]
    let portable_marker_exists = false;

    distribution_from_inputs(
        std::env::var("CLI_MANAGER_DISTRIBUTION").ok().as_deref(),
        portable_marker_exists,
        cfg!(target_os = "windows"),
    )
}

#[cfg(test)]
// 测试用纯路径映射：便携版使用程序旁 data，其他发行方式使用用户目录下 .cli-manager。
fn default_data_dir_for(
    distribution: AppDistribution,
    home_dir: &Path,
    executable_dir: &Path,
) -> PathBuf {
    match distribution {
        AppDistribution::Portable => executable_dir.join(PORTABLE_DATA_DIR_NAME),
        AppDistribution::Standalone | AppDistribution::Aur => home_dir.join(APP_HOME_DIR_NAME),
    }
}

// 返回发行方式对应的默认根，不应用自定义配置，也不创建目录。
pub fn default_data_dir() -> Result<PathBuf, String> {
    let distribution = app_distribution();
    if distribution == AppDistribution::Portable {
        return Ok(executable_dir()?.join(PORTABLE_DATA_DIR_NAME));
    }
    Ok(home_dir_from_env()?.join(APP_HOME_DIR_NAME))
}

// 将 Windows 引导指针放在程序旁或 LOCALAPPDATA，确保它不依赖被重定向的数据根。
// 非 Windows/AUR 无此配置；独立安装版缺失 LOCALAPPDATA 时返回错误。
fn bootstrap_path_for(
    distribution: AppDistribution,
    local_app_data: Option<&Path>,
    executable_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    if !cfg!(target_os = "windows") {
        return Ok(None);
    }
    match distribution {
        AppDistribution::Portable => Ok(Some(executable_dir.join(DATA_ROOT_BOOTSTRAP_FILE_NAME))),
        AppDistribution::Standalone => local_app_data
            .map(|root| {
                root.join(WINDOWS_APP_IDENTIFIER)
                    .join(DATA_ROOT_BOOTSTRAP_FILE_NAME)
            })
            .map(Some)
            .ok_or_else(|| "local_app_data_dir_unavailable".to_string()),
        AppDistribution::Aur => Ok(None),
    }
}

// 读取当前发行与环境信息解析引导文件位置，不支持的平台返回 None，不创建文件。
pub fn data_root_bootstrap_path() -> Result<Option<PathBuf>, String> {
    let distribution = app_distribution();
    if !cfg!(target_os = "windows") || distribution == AppDistribution::Aur {
        return Ok(None);
    }
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    bootstrap_path_for(distribution, local_app_data.as_deref(), &executable_dir()?)
}

// 用不跟随最终链接的元数据识别符号链接和 Windows 重解析点，元数据读取失败向上传播。
fn path_is_symlink_or_reparse(path: &Path) -> Result<bool, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|err| format!("data_storage_metadata_failed: {err}"))?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0);
    }
    #[cfg(not(target_os = "windows"))]
    Ok(false)
}

// 逐级检查 exists 为真的路径前缀并拒绝链接/重解析点；这是检查时快照，不锁定文件系统。
fn ensure_existing_prefixes_are_not_links(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if current.exists() && path_is_symlink_or_reparse(&current)? {
            return Err(format!(
                "data_storage_path_is_symlink: {}",
                current.to_string_lossy()
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
// 将规范化产生的 Windows verbatim 路径恢复为普通盘符或 UNC，避免问号被 SQLite 当作查询起点。
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy().into_owned();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(not(target_os = "windows"))]
// 非 Windows 不存在此序列化兼容处理，保留原路径。
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

// 拒绝相对路径、父级跳转和根目录，检查已有前缀后规范化最近存在的祖先，再接回缺失部分。
// 不创建目录；Windows 输出移除 verbatim 前缀，供后续比较与存储使用。
fn normalize_absolute_path(path: &Path) -> Result<PathBuf, String> {
    use std::path::Component;

    if !path.is_absolute() {
        return Err("data_storage_path_must_be_absolute".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("data_storage_parent_segment_not_allowed".to_string());
            }
        }
    }
    if normalized.parent().is_none() {
        return Err("data_storage_root_directory_not_allowed".to_string());
    }
    ensure_existing_prefixes_are_not_links(&normalized)?;

    let mut existing = normalized.as_path();
    let mut missing = Vec::<OsString>::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| "data_storage_target_parent_unavailable".to_string())?;
        missing.push(name.to_os_string());
        existing = existing
            .parent()
            .ok_or_else(|| "data_storage_target_parent_unavailable".to_string())?;
    }
    let mut canonical = existing
        .canonicalize()
        .map_err(|err| format!("data_storage_canonicalize_failed: {err}"))?;
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    let canonical = strip_windows_verbatim_prefix(canonical);
    if canonical.parent().is_none() {
        return Err("data_storage_root_directory_not_allowed".to_string());
    }
    Ok(canonical)
}

// 将路径组件转为比较键，Windows 转小写，其他平台保留大小写；非 Unicode 内容有损转换。
fn path_component_key(component: &OsStr) -> String {
    let value = component.to_string_lossy();
    if cfg!(target_os = "windows") {
        value.to_lowercase()
    } else {
        value.into_owned()
    }
}

// 按完整组件判断相等或祖先关系，不把同名字符串前缀误当子目录；调用方负责预先规范化。
fn path_components_equal_or_prefix(parent: &Path, child: &Path) -> bool {
    let parent_components = parent
        .components()
        .map(|component| path_component_key(component.as_os_str()))
        .collect::<Vec<_>>();
    let child_components = child
        .components()
        .map(|component| path_component_key(component.as_os_str()))
        .collect::<Vec<_>>();
    parent_components.len() <= child_components.len()
        && parent_components
            .iter()
            .zip(child_components.iter())
            .all(|(left, right)| left == right)
}

// 双向组件前缀匹配判断路径相等，不额外访问磁盘。
fn same_path(left: &Path, right: &Path) -> bool {
    path_components_equal_or_prefix(left, right) && path_components_equal_or_prefix(right, left)
}

// 判断路径相等或任一方包含另一方，用于拒绝数据根迁移的源目标重叠。
fn paths_overlap(left: &Path, right: &Path) -> bool {
    path_components_equal_or_prefix(left, right) || path_components_equal_or_prefix(right, left)
}

// 打开目录并检查是否有首个条目；打开失败返回错误，首项迭代错误也被视为非空。
fn directory_is_empty(path: &Path) -> Result<bool, String> {
    let mut entries =
        fs::read_dir(path).map_err(|err| format!("data_storage_read_dir_failed: {err}"))?;
    Ok(entries.next().is_none())
}

// 用进程号与时间后缀生成写探测路径，本身不创建或预留文件。
fn writable_probe_path(directory: &Path) -> PathBuf {
    directory.join(format!(
        ".cli-manager-write-test-{}-{}",
        std::process::id(),
        backup_suffix()
    ))
}

// 独占创建并删除探测文件，仅两步都成功才认定可写；删除失败可能留下探测文件。
fn directory_is_writable(directory: &Path) -> bool {
    let probe = writable_probe_path(directory);
    let result = OpenOptions::new().write(true).create_new(true).open(&probe);
    match result {
        Ok(file) => {
            drop(file);
            fs::remove_file(probe).is_ok()
        }
        Err(_) => false,
    }
}

// 向上寻找首个存在的路径并要求其为目录，供尚未创建的目标做可写性探测。
fn existing_parent(path: &Path) -> Result<&Path, String> {
    let mut current = path;
    while !current.exists() {
        current = current
            .parent()
            .ok_or_else(|| "data_storage_target_parent_unavailable".to_string())?;
    }
    if !current.is_dir() {
        return Err("data_storage_target_parent_not_directory".to_string());
    }
    Ok(current)
}

// 检查已规范化目标的存在、空目录与可写状态，拒绝非相等的源目标包含关系。
// 可写检查会短暂创建文件；目标尚不存在时检查最近已有父目录。
fn inspect_normalized_data_dir(
    target: PathBuf,
    current: &Path,
) -> Result<DataStorageInspection, String> {
    if same_path(&target, current) {
        return Ok(DataStorageInspection {
            target_dir: target.to_string_lossy().into_owned(),
            exists: target.exists(),
            empty: target.is_dir() && directory_is_empty(&target)?,
            writable: target.is_dir() && directory_is_writable(&target),
            same_as_current: true,
        });
    }
    if paths_overlap(&target, current) {
        return Err("data_storage_source_target_overlap".to_string());
    }

    let exists = target.exists();
    let (empty, writable) = if exists {
        if !target.is_dir() {
            return Err("data_storage_target_not_directory".to_string());
        }
        (directory_is_empty(&target)?, directory_is_writable(&target))
    } else {
        (true, directory_is_writable(existing_parent(&target)?))
    };
    Ok(DataStorageInspection {
        target_dir: target.to_string_lossy().into_owned(),
        exists,
        empty,
        writable,
        same_as_current: false,
    })
}

// 无引导文件时返回默认配置；已有文件则拒绝链接、无效 JSON 和未知版本，不静默丢弃错误。
fn load_data_root_bootstrap() -> Result<DataRootBootstrap, String> {
    let Some(path) = data_root_bootstrap_path()? else {
        return Ok(DataRootBootstrap::default());
    };
    if !path.exists() {
        return Ok(DataRootBootstrap::default());
    }
    if path_is_symlink_or_reparse(&path)? {
        return Err("data_storage_bootstrap_is_symlink".to_string());
    }
    let bytes =
        fs::read(&path).map_err(|err| format!("data_storage_bootstrap_read_failed: {err}"))?;
    let config: DataRootBootstrap = serde_json::from_slice(&bytes)
        .map_err(|err| format!("data_storage_bootstrap_invalid: {err}"))?;
    if config.version != DATA_ROOT_BOOTSTRAP_VERSION {
        return Err(format!(
            "data_storage_bootstrap_version_unsupported: {}",
            config.version
        ));
    }
    Ok(config)
}

// 使用非空自定义根，否则选择默认根，并统一做绝对路径校验；不执行 pending 切换。
fn active_data_dir_from_bootstrap(config: &DataRootBootstrap) -> Result<PathBuf, String> {
    match config
        .custom_data_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(path) => normalize_absolute_path(Path::new(path)),
        None => normalize_absolute_path(&default_data_dir()?),
    }
}

// 读取引导配置并解析当前生效根，供普通 helper 惰性初始化使用，不搬迁数据。
fn resolve_active_data_dir() -> Result<PathBuf, String> {
    active_data_dir_from_bootstrap(&load_data_root_bootstrap()?)
}

#[cfg(target_os = "windows")]
// 通过 Windows 带替换与写穿标志的移动发布文件，系统调用失败转换为错误文本。
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
// 非 Windows 使用文件系统 rename 发布文件，保留其跨文件系统等失败结果。
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|err| err.to_string())
}

// 在引导文件旁写完整临时 JSON，再替换目标；拒绝已检测到的链接，替换失败尽力清理临时文件。
fn save_data_root_bootstrap(config: &DataRootBootstrap) -> Result<(), String> {
    let path =
        data_root_bootstrap_path()?.ok_or_else(|| "data_storage_not_supported".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "data_storage_bootstrap_parent_unavailable".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("data_storage_bootstrap_create_dir_failed: {err}"))?;
    ensure_existing_prefixes_are_not_links(parent)?;
    if path.exists() && path_is_symlink_or_reparse(&path)? {
        return Err("data_storage_bootstrap_is_symlink".to_string());
    }
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|err| format!("data_storage_bootstrap_serialize_failed: {err}"))?;
    let temp = parent.join(format!(
        ".{DATA_ROOT_BOOTSTRAP_FILE_NAME}.{}-{}.tmp",
        std::process::id(),
        backup_suffix()
    ));
    fs::write(&temp, bytes).map_err(|err| format!("data_storage_bootstrap_write_failed: {err}"))?;
    if let Err(err) = replace_file(&temp, &path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("data_storage_bootstrap_replace_failed: {err}"));
    }
    Ok(())
}

// 必要时创建数据根，再要求它是非链接目录且可写；此验证有建目录和写探测副作用。
fn validate_active_data_dir(path: &Path) -> Result<(), String> {
    if path.parent().is_none() {
        return Err("data_storage_root_directory_not_allowed".to_string());
    }
    if !path.exists() {
        fs::create_dir_all(path).map_err(|err| format!("data_storage_create_dir_failed: {err}"))?;
    }
    if path_is_symlink_or_reparse(path)? {
        return Err("data_storage_path_is_symlink".to_string());
    }
    if !path.is_dir() {
        return Err("data_storage_target_not_directory".to_string());
    }
    if !directory_is_writable(path) {
        return Err("data_storage_target_not_writable".to_string());
    }
    Ok(())
}

// 递归复制普通文件和目录到新目标，拒绝检测到的链接/重解析点及特殊节点；不删除源数据。
// 中途失败可能留下部分目标树，统一清理由迁移调用方负责。
fn copy_directory_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if path_is_symlink_or_reparse(source)? {
        return Err(format!(
            "data_storage_migration_symlink_rejected: {}",
            source.to_string_lossy()
        ));
    }
    if !source.is_dir() {
        return Err("data_storage_migration_source_not_directory".to_string());
    }
    fs::create_dir(target)
        .map_err(|err| format!("data_storage_migration_create_temp_failed: {err}"))?;
    for entry in
        fs::read_dir(source).map_err(|err| format!("data_storage_migration_read_failed: {err}"))?
    {
        let entry = entry.map_err(|err| format!("data_storage_migration_read_failed: {err}"))?;
        let source_path = entry.path();
        if path_is_symlink_or_reparse(&source_path)? {
            return Err(format!(
                "data_storage_migration_symlink_rejected: {}",
                source_path.to_string_lossy()
            ));
        }
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|err| format!("data_storage_migration_metadata_failed: {err}"))?;
        if file_type.is_dir() {
            copy_directory_recursive(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|err| format!("data_storage_migration_copy_failed: {err}"))?;
        } else {
            return Err(format!(
                "data_storage_migration_unsupported_entry: {}",
                source_path.to_string_lossy()
            ));
        }
    }
    Ok(())
}

// 最多尝试 100 个目标同级临时目录名，返回当前不存在的候选但不预先创建。
fn migration_temp_dir(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "data_storage_target_parent_unavailable".to_string())?;
    for sequence in 0..100_u32 {
        let candidate = parent.join(format!(
            ".cli-manager-migrate-{}-{}-{sequence}",
            std::process::id(),
            backup_suffix()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("data_storage_migration_temp_unavailable".to_string())
}

// 拒绝源目标重叠或非空目标，先复制完整临时树，再移除空目标并 rename 激活；保留源目录。
// 失败时尽力清理临时树，不合并已有内容；若激活失败，先前移除的空目标不会恢复。
fn migrate_data_root(source: &Path, target: &Path) -> Result<(), String> {
    if paths_overlap(source, target) {
        return Err("data_storage_source_target_overlap".to_string());
    }
    if target.exists() {
        if !target.is_dir() {
            return Err("data_storage_target_not_directory".to_string());
        }
        if !directory_is_empty(target)? {
            return Err("data_storage_target_not_empty".to_string());
        }
    } else if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("data_storage_target_parent_create_failed: {err}"))?;
    }

    let temp = migration_temp_dir(target)?;
    let result = (|| {
        copy_directory_recursive(source, &temp)?;
        if target.exists() {
            if !directory_is_empty(target)? {
                return Err("data_storage_target_not_empty".to_string());
            }
            fs::remove_dir(target)
                .map_err(|err| format!("data_storage_target_remove_failed: {err}"))?;
        }
        fs::rename(&temp, target)
            .map_err(|err| format!("data_storage_migration_activate_failed: {err}"))?;
        Ok(())
    })();
    if result.is_err() && temp.exists() {
        let _ = fs::remove_dir_all(&temp);
    }
    result
}

// 清除待切换请求并持久化错误，保留旧的自定义根；写引导文件失败继续向上传播。
fn record_pending_switch_failure(
    config: &mut DataRootBootstrap,
    error: String,
) -> Result<(), String> {
    clear_pending_switch_with_error(config, error);
    save_data_root_bootstrap(config)
}

// 仅修改内存中的 pending 与错误字段，不改变当前根，也不写磁盘。
fn clear_pending_switch_with_error(config: &mut DataRootBootstrap, error: String) {
    config.pending_switch = None;
    config.last_error = Some(error);
}

// GUI 启动时复核 pending 的源目标并按需迁移，成功后才更新引导指针。
// 切换失败且错误记录成功则继续使用旧根；配置读取或错误记录失败直接返回错误。
fn apply_pending_data_root_switch() -> Result<PathBuf, String> {
    let mut config = load_data_root_bootstrap()?;
    let current = active_data_dir_from_bootstrap(&config)?;
    let Some(pending) = config.pending_switch.clone() else {
        return Ok(current);
    };

    let result = (|| {
        let source = normalize_absolute_path(Path::new(&pending.source_dir))?;
        if !same_path(&source, &current) {
            return Err("data_storage_pending_source_changed".to_string());
        }
        let target = normalize_absolute_path(Path::new(&pending.target_dir))?;
        if same_path(&target, &current) {
            return Err("data_storage_target_is_current".to_string());
        }
        if paths_overlap(&target, &current) {
            return Err("data_storage_source_target_overlap".to_string());
        }
        let next_custom_data_dir = match pending.target_mode.as_str() {
            "custom" => Some(target.to_string_lossy().into_owned()),
            "default" => None,
            _ => return Err("data_storage_target_mode_invalid".to_string()),
        };
        if pending.migrate {
            migrate_data_root(&current, &target)?;
        } else {
            validate_active_data_dir(&target)?;
        }
        let mut next_config = config.clone();
        next_config.custom_data_dir = next_custom_data_dir;
        next_config.pending_switch = None;
        next_config.last_error = None;
        save_data_root_bootstrap(&next_config)?;
        Ok(target)
    })();

    match result {
        Ok(target) => Ok(target),
        Err(error) => {
            record_pending_switch_failure(&mut config, error)?;
            Ok(current)
        }
    }
}

// GUI 启动前执行待切换、验证根并尝试写入进程缓存；应早于日志、数据库和普通路径消费者。
pub fn prepare_gui_startup() -> Result<(), String> {
    let data_dir = apply_pending_data_root_switch()?;
    validate_active_data_dir(&data_dir)?;
    match DATA_ROOT.set(Ok(data_dir.clone())) {
        Ok(()) => Ok(()),
        Err(existing) if existing == Ok(data_dir) => Ok(()),
        Err(_) => Err("data_storage_root_already_initialized".to_string()),
    }
}

// 组合引导配置、进程缓存根和默认根形成设置状态，不执行 pending 切换。
pub fn data_storage_status() -> Result<DataStorageStatus, String> {
    let config = load_data_root_bootstrap()?;
    let current_data_dir = cli_manager_data_dir()?;
    let default_data_dir = normalize_absolute_path(&default_data_dir()?)?;
    Ok(DataStorageStatus {
        supported: cfg!(target_os = "windows"),
        distribution: app_distribution().as_str().to_string(),
        mode: if config
            .custom_data_dir
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty())
        {
            "custom".to_string()
        } else {
            "default".to_string()
        },
        current_data_dir: current_data_dir.to_string_lossy().into_owned(),
        default_data_dir: default_data_dir.to_string_lossy().into_owned(),
        bootstrap_path: data_root_bootstrap_path()?.map(|path| path.to_string_lossy().into_owned()),
        last_error: config.last_error,
    })
}

// Windows 设置预检入口：裁剪并规范化输入后探测目标状态，不保存切换，但可能写探测文件。
pub fn inspect_data_storage_target(target_dir: &str) -> Result<DataStorageInspection, String> {
    if !cfg!(target_os = "windows") {
        return Err("data_storage_not_supported".to_string());
    }
    let target = normalize_absolute_path(Path::new(target_dir.trim()))?;
    inspect_normalized_data_dir(target, &cli_manager_data_dir()?)
}

// 校验目标后仅把切换意图写入引导配置并清除旧错误，当前进程数据根保持不变。
pub fn prepare_data_storage_switch(
    target_mode: &str,
    target_dir: Option<&str>,
    migrate: bool,
) -> Result<PathBuf, String> {
    if !cfg!(target_os = "windows") {
        return Err("data_storage_not_supported".to_string());
    }
    let target = validate_data_storage_switch(target_mode, target_dir, migrate)?;
    let current = cli_manager_data_dir()?;
    let mut config = load_data_root_bootstrap()?;
    config.pending_switch = Some(PendingDataRootSwitch {
        target_mode: target_mode.to_string(),
        target_dir: target.to_string_lossy().into_owned(),
        source_dir: current.to_string_lossy().into_owned(),
        migrate,
    });
    config.last_error = None;
    save_data_root_bootstrap(&config)?;
    Ok(target)
}

// Windows 切换校验：解析模式和目标，拒绝当前根、不可写路径及迁移到非空目录。
// 可写性探测有临时文件副作用；活动任务等业务限制由上层命令负责。
pub fn validate_data_storage_switch(
    target_mode: &str,
    target_dir: Option<&str>,
    migrate: bool,
) -> Result<PathBuf, String> {
    if !cfg!(target_os = "windows") {
        return Err("data_storage_not_supported".to_string());
    }
    let current = cli_manager_data_dir()?;
    let target = match target_mode {
        "custom" => {
            let target = target_dir
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "data_storage_target_required".to_string())?;
            normalize_absolute_path(Path::new(target))?
        }
        "default" => normalize_absolute_path(&default_data_dir()?)?,
        _ => return Err("data_storage_target_mode_invalid".to_string()),
    };
    let inspection = inspect_normalized_data_dir(target.clone(), &current)?;
    if inspection.same_as_current {
        return Err("data_storage_target_is_current".to_string());
    }
    if !inspection.writable {
        return Err("data_storage_target_not_writable".to_string());
    }
    if migrate && !inspection.empty {
        return Err("data_storage_target_not_empty".to_string());
    }
    Ok(target)
}

// 返回进程固定数据根；未初始化时只解析 active 配置并缓存结果（包括错误），不处理 pending。
pub fn cli_manager_data_dir() -> Result<PathBuf, String> {
    DATA_ROOT.get_or_init(resolve_active_data_dir).clone()
}

// 返回当前数据根的日志子目录，不负责创建目录。
pub fn machine_id() -> Result<String, String> {
    let data_dir = cli_manager_data_dir()?;
    fs::create_dir_all(&data_dir).map_err(|err| format!("create data directory failed: {err}"))?;
    let path = data_dir.join(MACHINE_ID_FILE_NAME);
    if let Ok(value) = fs::read_to_string(&path) {
        return validate_machine_id(&value);
    }

    let value = Uuid::new_v4().to_string();
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(value.as_bytes())
                .map_err(|err| format!("write machine id failed: {err}"))?;
            Ok(value)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_machine_id(&fs::read_to_string(path).map_err(|read_err| {
                format!("read concurrently created machine id failed: {read_err}")
            })?)
        }
        Err(err) => Err(format!("create machine id failed: {err}")),
    }
}

fn validate_machine_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    Uuid::parse_str(value).map_err(|_| "invalid machine id".to_string())?;
    Ok(value.to_string())
}

pub fn logs_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("logs"))
}

// 返回当前数据根下供应商配置目录，随数据根选择统一迁移。
pub fn providers_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("providers"))
}

/// Downloaded desktop pet packages are durable user data. Keep them beside
/// settings, sessions and the SQLite database so repair installs and app
/// reinstalls do not remove them.
// 返回应用管理的持久化桌宠目录，不使用安装资源目录。
pub fn pets_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("pets"))
}

/// Codex-compatible pets installed by commands such as
/// `npx codex-pets add <id>` live in the user's Codex data directory.
// 返回用户 .codex/pets 外部目录，不随 CLI-Manager 自定义数据根重定向。
pub fn codex_pets_dir() -> Result<PathBuf, String> {
    Ok(home_dir_from_env()?.join(".codex").join("pets"))
}

// 在公共供应商目录下定位 Codex 配置子目录，不创建文件。
pub fn codex_providers_dir() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("codex"))
}

// 在公共供应商目录下定位 Claude 配置子目录，不创建文件。
pub fn claude_providers_dir() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("claude"))
}

// 定位当前数据根的主 SQLite 文件，不打开或初始化数据库。
pub fn db_path() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join(DB_FILE_NAME))
}

// 为原生路径添加 sqlite: 前缀，不做 URL 转义；Windows verbatim 前缀由上游规范化移除。
fn sqlite_url_for_path(path: &Path) -> String {
    format!("sqlite:{}", path.to_string_lossy())
}

// 定位当前数据根的独立供应商数据库文件，不建立连接。
pub fn providers_db_path() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join(PROVIDERS_DB_FILE_NAME))
}

// 将供应商数据库路径转换为 SQLx 连接字符串，数据根解析错误直接传播。
pub fn providers_db_url() -> Result<String, String> {
    Ok(sqlite_url_for_path(&providers_db_path()?))
}

// 将主数据库路径转换为 SQLite 连接字符串，不触发数据库读写。
pub fn db_url() -> Result<String, String> {
    Ok(sqlite_url_for_path(&db_path()?))
}

// 按开发标志隔离会话恢复 Store 文件名，防止开发版读取安装版会话状态。
fn sessions_store_file_name(is_dev: bool) -> &'static str {
    if is_dev {
        DEV_SESSIONS_STORE_FILE_NAME
    } else {
        SESSIONS_STORE_FILE_NAME
    }
}

// 按开发标志隔离历史缓存目录，避免开发版与安装版共用索引状态。
fn history_cache_dir_name(is_dev: bool) -> &'static str {
    if is_dev {
        "history-cache-dev"
    } else {
        "history-cache"
    }
}

// 汇总前端使用的原生路径和数据库 URL；会话文件仅按 Tauri cfg(dev) 隔离，其余 Store 共用根。
pub fn data_paths() -> Result<CliManagerDataPaths, String> {
    let data_dir = cli_manager_data_dir()?;
    let db_path = db_path()?;
    let logs_dir = logs_dir()?;
    let codex_providers_dir = codex_providers_dir()?;
    let claude_providers_dir = claude_providers_dir()?;
    Ok(CliManagerDataPaths {
        data_dir: data_dir.to_string_lossy().into_owned(),
        db_path: db_path.to_string_lossy().into_owned(),
        db_url: sqlite_url_for_path(&db_path),
        settings_store_path: data_dir
            .join(SETTINGS_STORE_FILE_NAME)
            .to_string_lossy()
            .into_owned(),
        sessions_store_path: data_dir
            .join(sessions_store_file_name(cfg!(dev)))
            .to_string_lossy()
            .into_owned(),
        sync_store_path: data_dir
            .join(SYNC_STORE_FILE_NAME)
            .to_string_lossy()
            .into_owned(),
        external_session_sync_store_path: data_dir
            .join(EXTERNAL_SESSION_SYNC_STORE_FILE_NAME)
            .to_string_lossy()
            .into_owned(),
        logs_dir: logs_dir.to_string_lossy().into_owned(),
        codex_providers_dir: codex_providers_dir.to_string_lossy().into_owned(),
        claude_providers_dir: claude_providers_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
// IPC 只返回统一路径快照，不接受渲染端覆盖路径，也不创建数据文件。
pub fn app_get_data_paths() -> Result<CliManagerDataPaths, String> {
    data_paths()
}

// 仅源为文件且目标不存在时创建父目录并复制；已有目标保持不动，检查与复制并非原子操作。
fn copy_if_missing(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_file() || target.exists() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("data_migration_failed: {err}"))?;
    }
    fs::copy(source, target).map_err(|err| format!("data_migration_failed: {err}"))?;
    Ok(())
}

// 生成毫秒时间戳备份后缀，系统时间早于 epoch 时使用 0；同毫秒调用不保证唯一。
fn backup_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("backup-{millis}")
}

// 为已有普通文件复制同级时间戳备份，非文件跳过；不删除或移动原文件。
fn backup_existing_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "data_migration_invalid_backup_path".to_string())?;
    let backup_path = path.with_file_name(format!("{file_name}.{}", backup_suffix()));
    fs::copy(path, backup_path).map_err(|err| format!("data_migration_backup_failed: {err}"))?;
    Ok(())
}

// 将空文件视为空对象，无效 JSON/非对象/非文件返回 None；真正的读取失败返回错误。
fn parse_json_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text =
        fs::read_to_string(path).map_err(|err| format!("data_migration_read_failed: {err}"))?;
    if text.trim().is_empty() {
        return Ok(Some(Map::new()));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Ok(Some(object)),
        Ok(_) | Err(_) => Ok(None),
    }
}

// 普通 Store 迁移入口，缺失时复制，已有对象仅补缺失顶层键，不指定忽略键。
fn migrate_store_file(source: &Path, target: &Path) -> Result<(), String> {
    migrate_store_file_with_ignored_keys(source, target, &[])
}

// 同步 Store 迁移排除已废弃的密码字段，不从旧明文配置重新引入系统密钥库负责的数据。
fn migrate_sync_store_file(source: &Path, target: &Path) -> Result<(), String> {
    migrate_store_file_with_ignored_keys(source, target, SYNC_STORE_LEGACY_IGNORED_KEYS)
}

// 目标缺失时复制或过滤后写入，目标已有对象时只补未忽略的缺失顶层键，实际合并前备份目标。
// 无新增键不写盘；不递归合并、不覆盖已有值，也不移除目标本来已有的忽略键。
fn migrate_store_file_with_ignored_keys(
    source: &Path,
    target: &Path,
    ignored_keys: &[&str],
) -> Result<(), String> {
    if !source.is_file() {
        return Ok(());
    }
    if !target.exists() {
        if !ignored_keys.is_empty() {
            let Some(mut source_object) = parse_json_object(source)? else {
                return Ok(());
            };
            source_object.retain(|key, _| !ignored_keys.contains(&key.as_str()));
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("data_migration_failed: {err}"))?;
            }
            let bytes = serde_json::to_vec_pretty(&Value::Object(source_object))
                .map_err(|err| format!("data_migration_serialize_failed: {err}"))?;
            fs::write(target, bytes)
                .map_err(|err| format!("data_migration_write_failed: {err}"))?;
            return Ok(());
        }
        return copy_if_missing(source, target);
    }
    if !target.is_file() {
        return Ok(());
    }

    let Some(source_object) = parse_json_object(source)? else {
        return Ok(());
    };
    let Some(mut target_object) = parse_json_object(target)? else {
        return Ok(());
    };

    let mut changed = false;
    for (key, value) in source_object {
        if ignored_keys.contains(&key.as_str()) {
            continue;
        }
        if !target_object.contains_key(&key) {
            target_object.insert(key, value);
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }

    backup_existing_file(target)?;
    let bytes = serde_json::to_vec_pretty(&Value::Object(target_object))
        .map_err(|err| format!("data_migration_serialize_failed: {err}"))?;
    fs::write(target, bytes).map_err(|err| format!("data_migration_write_failed: {err}"))?;
    Ok(())
}

// 创建根、日志、供应商、备份与当前开发模式的历史缓存目录，任一创建失败即返回错误。
fn ensure_dirs() -> Result<(), String> {
    for dir in [
        cli_manager_data_dir()?,
        logs_dir()?,
        codex_providers_dir()?,
        claude_providers_dir()?,
        cli_manager_data_dir()?.join("backups"),
        cli_manager_data_dir()?.join(history_cache_dir_name(cfg!(dev))),
    ] {
        fs::create_dir_all(dir).map_err(|err| format!("data_dir_create_failed: {err}"))?;
    }
    Ok(())
}

// 启动时建立目录，再从旧 Tauri 位置迁移缺失主 DB 和四类 Store，保留目标已有键。
// 此入口只复制主 DB 文件，不执行数据库家族恢复；生产 sessions 不复制到开发专用文件。
pub fn migrate_legacy_app_files<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    ensure_dirs()?;

    if let Ok(old_db_dir) = app.path().app_config_dir() {
        copy_if_missing(&old_db_dir.join(DB_FILE_NAME), &db_path()?)?;
    }

    if let Ok(old_store_dir) = app.path().app_data_dir() {
        let data_dir = cli_manager_data_dir()?;
        for file_name in STORE_FILES {
            let source = old_store_dir.join(file_name);
            let target = data_dir.join(file_name);
            if file_name == SYNC_STORE_FILE_NAME {
                migrate_sync_store_file(&source, &target)?;
            } else {
                migrate_store_file(&source, &target)?;
            }
        }
    }

    Ok(())
}

// 返回按 Tauri cfg(dev) 隔离的历史缓存路径，不创建缓存或触发索引。
pub fn history_cache_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join(history_cache_dir_name(cfg!(dev))))
}

/// 会话历史 mutation 备份目录。
///
/// 使用当前进程启动期固定的数据根目录下的 `backups` 子目录。
/// 外部 WSL/SSH 环境的数据仍按各自运行环境独立管理。
// 返回当前本机数据根下的历史变更备份目录，不改写外部 WSL/SSH 的备份位置。
pub fn history_backups_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("backups"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 锁定开发/安装版会话 Store 与历史缓存名称的双重隔离。
    fn separates_development_and_installed_session_store_files() {
        assert_eq!(sessions_store_file_name(false), "sessions.json");
        assert_eq!(sessions_store_file_name(true), "sessions.dev.json");
        assert_eq!(history_cache_dir_name(false), "history-cache");
        assert_eq!(history_cache_dir_name(true), "history-cache-dev");
    }

    #[test]
    // 验证 AUR 覆盖便携标记，便携只在 Windows 生效，未知配置回退独立安装版。
    fn distribution_prefers_explicit_aur_and_detects_windows_portable_marker() {
        assert_eq!(
            distribution_from_inputs(Some("AUR"), true, true),
            AppDistribution::Aur
        );
        assert_eq!(
            distribution_from_inputs(None, true, true),
            AppDistribution::Portable
        );
        assert_eq!(
            distribution_from_inputs(None, true, false),
            AppDistribution::Standalone
        );
        assert_eq!(
            distribution_from_inputs(Some("unknown"), false, true),
            AppDistribution::Standalone
        );
    }

    #[test]
    // 验证安装版以用户目录为根、便携版以程序目录为根的默认布局。
    fn portable_and_installed_defaults_are_distinct() {
        let home = Path::new(r"C:\Users\test");
        let executable = Path::new(r"D:\CLI-Manager");
        assert_eq!(
            default_data_dir_for(AppDistribution::Standalone, home, executable),
            home.join(".cli-manager")
        );
        assert_eq!(
            default_data_dir_for(AppDistribution::Portable, home, executable),
            executable.join("data")
        );
    }

    #[test]
    // 验证 Windows 两类发行方式的引导指针位置，以及非 Windows 不提供引导路径。
    fn bootstrap_paths_keep_portable_configuration_beside_the_executable() {
        let local = Path::new(r"C:\Users\test\AppData\Local");
        let executable = Path::new(r"D:\CLI-Manager");
        if !cfg!(target_os = "windows") {
            assert!(
                bootstrap_path_for(AppDistribution::Portable, Some(local), executable)
                    .unwrap()
                    .is_none()
            );
            return;
        }
        let portable = bootstrap_path_for(AppDistribution::Portable, Some(local), executable)
            .unwrap()
            .unwrap();
        let standalone = bootstrap_path_for(AppDistribution::Standalone, Some(local), executable)
            .unwrap()
            .unwrap();
        assert_eq!(portable, executable.join("data-root.json"));
        assert_eq!(
            standalone,
            local.join("com.cli-manager.app").join("data-root.json")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    // 验证 verbatim 盘符与 UNC 路径都转换为对应的普通 Windows 路径。
    fn strips_windows_verbatim_prefixes_before_serializing_paths() {
        assert_eq!(
            strip_windows_verbatim_prefix(PathBuf::from(
                r"\\?\C:\Users\test\.cli-manager\cli-manager.db"
            )),
            PathBuf::from(r"C:\Users\test\.cli-manager\cli-manager.db")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(PathBuf::from(
                r"\\?\UNC\server\share\cli-manager\cli-manager.db"
            )),
            PathBuf::from(r"\\server\share\cli-manager\cli-manager.db")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    // 用真实临时目录验证规范化结果可被 SQLx 解析，且数据库文件路径不被问号截断。
    fn normalized_windows_paths_produce_parseable_sqlite_urls() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = normalize_absolute_path(temp.path()).unwrap();
        assert!(!data_dir.to_string_lossy().starts_with(r"\\?\"));

        let db_path = data_dir.join(DB_FILE_NAME);
        let url = sqlite_url_for_path(&db_path);
        let options = url.parse::<sqlx::sqlite::SqliteConnectOptions>().unwrap();
        assert_eq!(options.get_filename(), db_path);
    }

    #[test]
    // 验证迁移复制根文件与嵌套文件、替换空目标，并保留源数据库文件。
    fn data_root_migration_copies_the_complete_tree_without_deleting_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("cli-manager.db"), b"database").unwrap();
        fs::write(source.join("nested").join("settings.json"), b"settings").unwrap();

        migrate_data_root(&source, &target).unwrap();

        assert_eq!(
            fs::read(target.join("cli-manager.db")).unwrap(),
            b"database"
        );
        assert_eq!(
            fs::read(target.join("nested").join("settings.json")).unwrap(),
            b"settings"
        );
        assert!(source.join("cli-manager.db").is_file());
    }

    #[test]
    // 验证非空目标被拒绝且原有文件内容不受影响。
    fn data_root_migration_rejects_non_empty_target() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("existing.txt"), b"keep").unwrap();

        let error = migrate_data_root(&source, &target).unwrap_err();

        assert_eq!(error, "data_storage_target_not_empty");
        assert_eq!(fs::read(target.join("existing.txt")).unwrap(), b"keep");
    }

    #[test]
    // 验证失败状态变更只清除 pending 并保存错误，不改内存中的旧活动根字段。
    fn failed_pending_switch_keeps_the_previous_active_root() {
        let mut config = DataRootBootstrap {
            custom_data_dir: Some(r"D:\active".to_string()),
            pending_switch: Some(PendingDataRootSwitch {
                target_mode: "custom".to_string(),
                target_dir: r"E:\next".to_string(),
                source_dir: r"D:\active".to_string(),
                migrate: true,
            }),
            ..DataRootBootstrap::default()
        };

        clear_pending_switch_with_error(&mut config, "copy_failed".to_string());

        assert_eq!(config.custom_data_dir.as_deref(), Some(r"D:\active"));
        assert!(config.pending_switch.is_none());
        assert_eq!(config.last_error.as_deref(), Some("copy_failed"));
    }

    #[test]
    // 验证双向父子目录关系均算重叠，独立路径不算重叠。
    fn source_and_target_cannot_contain_each_other() {
        let root = Path::new(r"C:\data");
        assert!(paths_overlap(root, &root.join("nested")));
        assert!(paths_overlap(&root.join("nested"), root));
        assert!(!paths_overlap(root, Path::new(r"C:\other")));
    }

    #[test]
    // 验证目标 Store 缺失时按原始文本复制旧文件。
    fn validates_stable_machine_id() {
        let id = Uuid::new_v4().to_string();
        assert_eq!(validate_machine_id(&format!(" {id}\n")).unwrap(), id);
        assert!(validate_machine_id("not-a-uuid").is_err());
    }

    #[test]
    fn migrates_missing_store_file_by_copying_legacy_file() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy.json");
        let target = temp.path().join("target.json");
        fs::write(&source, r#"{"theme":"dark"}"#).unwrap();

        migrate_store_file(&source, &target).unwrap();

        assert_eq!(fs::read_to_string(target).unwrap(), r#"{"theme":"dark"}"#);
    }

    #[test]
    // 验证合并只补缺失顶层键，保留目标值，并为实际改写创建一个备份。
    fn merges_legacy_store_keys_without_overwriting_target_values() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy.json");
        let target = temp.path().join("target.json");
        fs::write(&source, r#"{"theme":"dark","fontSize":18}"#).unwrap();
        fs::write(&target, r#"{"theme":"light"}"#).unwrap();

        migrate_store_file(&source, &target).unwrap();

        let merged: Value = serde_json::from_str(&fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(merged.get("theme").and_then(Value::as_str), Some("light"));
        assert_eq!(merged.get("fontSize").and_then(Value::as_i64), Some(18));
        let backup_count = fs::read_dir(temp.path())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("target.json.backup-")
            })
            .count();
        assert_eq!(backup_count, 1);
    }

    #[test]
    // 验证旧 Store 没有新增键时，目标文本保持原样。
    fn leaves_target_store_unchanged_when_legacy_has_no_new_keys() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy.json");
        let target = temp.path().join("target.json");
        fs::write(&source, r#"{"theme":"dark"}"#).unwrap();
        fs::write(&target, r#"{"theme":"light"}"#).unwrap();

        migrate_store_file(&source, &target).unwrap();

        assert_eq!(fs::read_to_string(target).unwrap(), r#"{"theme":"light"}"#);
    }

    #[test]
    // 验证旧同步密码字段不会触发合并写入或产生无意义备份。
    fn sync_store_migration_ignores_removed_password_keys() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy-sync.json");
        let target = temp.path().join("sync-config.json");
        fs::write(
            &source,
            r#"{"webdavUrl":"https://example.test","webdavPassword":"secret","hasPassword":true}"#,
        )
        .unwrap();
        fs::write(&target, r#"{"webdavUrl":"https://example.test"}"#).unwrap();

        migrate_sync_store_file(&source, &target).unwrap();

        assert_eq!(
            fs::read_to_string(target).unwrap(),
            r#"{"webdavUrl":"https://example.test"}"#
        );
        let backup_count = fs::read_dir(temp.path())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("sync-config.json.backup-")
            })
            .count();
        assert_eq!(backup_count, 0);
    }

    #[test]
    // 验证首次迁移同步 Store 时保留 URL，但过滤明文密码及旧密码存在标记。
    fn sync_store_copy_filters_removed_password_keys() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy-sync.json");
        let target = temp.path().join("sync-config.json");
        fs::write(
            &source,
            r#"{"webdavUrl":"https://example.test","webdavPassword":"secret","hasPassword":true}"#,
        )
        .unwrap();

        migrate_sync_store_file(&source, &target).unwrap();

        let migrated: Value = serde_json::from_str(&fs::read_to_string(target).unwrap()).unwrap();
        assert_eq!(
            migrated.get("webdavUrl").and_then(Value::as_str),
            Some("https://example.test")
        );
        assert!(migrated.get("webdavPassword").is_none());
        assert!(migrated.get("hasPassword").is_none());
    }
}
