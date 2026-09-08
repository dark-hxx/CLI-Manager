use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const PLUGIN_MARKER: &str = "__CLI_MANAGER_OPENCODE_HOOK__";
const PLUGIN_FILE_NAME: &str = "cli-manager-hook.js";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeHookStatus {
    config_dir: String,
    plugin_path: String,
    status: &'static str,
}

// 优先读取 HOME、其次 USERPROFILE，并要求所选主目录为绝对路径。
fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "opencode_hook_home_unavailable".to_string())
}

// 优先使用绝对 XDG 配置根，否则在主目录下定位 OpenCode 配置。
fn config_dir() -> Result<PathBuf, String> {
    if let Some(root) = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(root.join("opencode"));
    }
    Ok(home_dir()?.join(".config").join("opencode"))
}

// 拼接 OpenCode 的托管插件文件路径。
fn plugin_path(root: &Path) -> PathBuf {
    root.join("plugins").join(PLUGIN_FILE_NAME)
}

// 区分插件缺失、普通文件与标记归属，读取失败返回稳定错误。
fn read_owned(path: &Path) -> Result<Option<bool>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        return Err("opencode_hook_path_invalid".to_string());
    }
    let content = fs::read_to_string(path).map_err(|_| "opencode_hook_unreadable".to_string())?;
    Ok(Some(content.contains(PLUGIN_MARKER)))
}

// 根据插件存在性和归属标记生成安装状态及路径。
fn status_for(root: &Path) -> Result<OpenCodeHookStatus, String> {
    let path = plugin_path(root);
    let status = match read_owned(&path)? {
        None => "notInstalled",
        Some(true) => "installed",
        Some(false) => "conflict",
    };
    Ok(OpenCodeHookStatus {
        config_dir: root.to_string_lossy().to_string(),
        plugin_path: path.to_string_lossy().to_string(),
        status,
    })
}

// 读取编译时嵌入的 OpenCode 插件源码，不注入运行时凭据。
fn plugin_source() -> String {
    include_str!("../../../resources/opencode/cli-manager-hook.js").to_string()
}

#[tauri::command]
// 检查当前用户 OpenCode 插件的安装或冲突状态。
pub async fn opencode_hook_status() -> Result<OpenCodeHookStatus, String> {
    status_for(&config_dir()?)
}

#[tauri::command]
// 拒绝覆盖无归属标记的插件，再写入托管源码并重新检查状态。
pub async fn opencode_hook_install() -> Result<OpenCodeHookStatus, String> {
    let root = config_dir()?;
    let path = plugin_path(&root);
    if matches!(read_owned(&path)?, Some(false)) {
        return Err("opencode_hook_conflict".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "opencode_hook_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "opencode_hook_create_failed".to_string())?;
    fs::write(&path, plugin_source()).map_err(|_| "opencode_hook_write_failed".to_string())?;
    status_for(&root)
}

#[tauri::command]
// 仅删除含托管标记的插件，再返回当前安装状态。
pub async fn opencode_hook_uninstall() -> Result<OpenCodeHookStatus, String> {
    let root = config_dir()?;
    let path = plugin_path(&root);
    if matches!(read_owned(&path)?, Some(true)) {
        fs::remove_file(&path).map_err(|_| "opencode_hook_remove_failed".to_string())?;
    }
    status_for(&root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 验证嵌入插件含会话生命周期事件且未内嵌令牌赋值。
    fn managed_plugin_reports_session_lifecycle_and_contains_no_credentials() {
        let source = plugin_source();
        assert!(source.contains("session.created"));
        assert!(source.contains("session.status"));
        assert!(source.contains("session.deleted"));
        assert!(source.contains("source: \"opencode\""));
        assert!(!source.contains("CLI_MANAGER_NOTIFY_TOKEN="));
    }
}
