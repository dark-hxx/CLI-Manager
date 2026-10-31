//! 跨宿主共享的数据目录规则与只读路径校验。
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Distribution {
    Standalone,
    Portable,
    Aur,
}

pub fn distribution(configured: Option<&str>, portable: bool, windows: bool) -> Distribution {
    if configured.is_some_and(|value| value.eq_ignore_ascii_case("aur")) {
        Distribution::Aur
    } else if windows && portable {
        Distribution::Portable
    } else {
        Distribution::Standalone
    }
}

pub fn default_root(distribution: Distribution, home: &Path, executable: &Path) -> PathBuf {
    match distribution {
        Distribution::Portable => executable.join("data"),
        Distribution::Standalone | Distribution::Aur => home.join(".cli-manager"),
    }
}

pub fn bootstrap_path(
    distribution: Distribution,
    local: Option<&Path>,
    executable: &Path,
    windows: bool,
) -> Result<Option<PathBuf>, String> {
    if !windows {
        return Ok(None);
    }
    match distribution {
        Distribution::Portable => Ok(Some(executable.join("data-root.json"))),
        Distribution::Standalone => local
            .map(|local| Some(local.join("com.cli-manager.app").join("data-root.json")))
            .ok_or_else(|| "local_app_data_dir_unavailable".into()),
        Distribution::Aur => Ok(None),
    }
}

/// 只读引导指针，不执行 pendingSwitch、不创建文件、不搬迁数据。
pub fn active_root(default: &Path, bootstrap: Option<&Path>) -> Result<PathBuf, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Pointer {
        #[serde(default = "pointer_version")]
        version: u32,
        #[serde(default)]
        custom_data_dir: Option<String>,
    }
    fn pointer_version() -> u32 {
        1
    }
    let pointer = match bootstrap {
        Some(path) if path.exists() => {
            if path_is_symlink_or_reparse(path)? {
                return Err("data_storage_bootstrap_is_symlink".into());
            }
            let bytes = fs::read(path)
                .map_err(|error| format!("data_storage_bootstrap_read_failed: {error}"))?;
            Some(
                serde_json::from_slice::<Pointer>(&bytes)
                    .map_err(|error| format!("data_storage_bootstrap_invalid: {error}"))?,
            )
        }
        _ => None,
    };
    if let Some(pointer) = &pointer {
        if pointer.version != 1 {
            return Err(format!(
                "data_storage_bootstrap_version_unsupported: {}",
                pointer.version
            ));
        }
    }
    let custom = pointer
        .as_ref()
        .and_then(|p| p.custom_data_dir.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    normalize_absolute_path(custom.map(Path::new).unwrap_or(default))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distribution_and_default_roots_match_host_layouts() {
        let home = Path::new(r"C:\Users\test");
        let executable = Path::new(r"D:\CLI-Manager");
        assert_eq!(distribution(Some("AUR"), true, true), Distribution::Aur);
        assert_eq!(distribution(None, true, true), Distribution::Portable);
        assert_eq!(distribution(None, true, false), Distribution::Standalone);
        assert_eq!(
            default_root(Distribution::Portable, home, executable),
            executable.join("data")
        );
        assert_eq!(
            default_root(Distribution::Standalone, home, executable),
            home.join(".cli-manager")
        );
    }

    #[test]
    fn bootstrap_path_and_active_root_are_read_only_and_validated() {
        let directory = tempfile::tempdir().unwrap();
        let default = directory.path().join("data");
        let pointer = directory.path().join("data-root.json");
        std::fs::write(&pointer, r#"{"version":1,"customDataDir":""}"#).unwrap();
        assert_eq!(active_root(&default, Some(&pointer)).unwrap(), default);
        std::fs::write(&pointer, r#"{"version":1,"customDataDir":"relative"}"#).unwrap();
        assert_eq!(
            active_root(&default, Some(&pointer)).unwrap_err(),
            "data_storage_path_must_be_absolute"
        );
        std::fs::write(&pointer, r#"{"version":2}"#).unwrap();
        assert!(active_root(&default, Some(&pointer))
            .unwrap_err()
            .contains("version_unsupported"));
        assert_eq!(
            bootstrap_path(Distribution::Portable, None, Path::new(r"D:\App"), true).unwrap(),
            Some(Path::new(r"D:\App").join("data-root.json"))
        );
        assert_eq!(
            bootstrap_path(Distribution::Aur, None, Path::new(r"D:\App"), true).unwrap(),
            None
        );
        assert!(
            bootstrap_path(Distribution::Standalone, None, Path::new(r"D:\App"), true).is_err()
        );
    }
}

// 用不跟随最终链接的元数据识别符号链接和 Windows 重解析点，元数据读取失败向上传播。
pub fn path_is_symlink_or_reparse(path: &Path) -> Result<bool, String> {
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
pub fn ensure_existing_prefixes_are_not_links(path: &Path) -> Result<(), String> {
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
pub fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
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
pub fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

// 拒绝相对路径、父级跳转和根目录，检查已有前缀后规范化最近存在的祖先，再接回缺失部分。
// 不创建目录；Windows 输出移除 verbatim 前缀，供后续比较与存储使用。
pub fn normalize_absolute_path(path: &Path) -> Result<PathBuf, String> {
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
