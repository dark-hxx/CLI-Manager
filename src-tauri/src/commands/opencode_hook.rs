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

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "opencode_hook_home_unavailable".to_string())
}

fn config_dir() -> Result<PathBuf, String> {
    if let Some(root) = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(root.join("opencode"));
    }
    Ok(home_dir()?.join(".config").join("opencode"))
}

fn plugin_path(root: &Path) -> PathBuf {
    root.join("plugins").join(PLUGIN_FILE_NAME)
}

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

fn plugin_source() -> String {
    include_str!("../../resources/opencode/cli-manager-hook.js").to_string()
}

#[tauri::command]
pub async fn opencode_hook_status() -> Result<OpenCodeHookStatus, String> {
    status_for(&config_dir()?)
}

#[tauri::command]
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
    fn managed_plugin_reports_session_lifecycle_and_contains_no_credentials() {
        let source = plugin_source();
        assert!(source.contains("session.created"));
        assert!(source.contains("session.status"));
        assert!(source.contains("session.deleted"));
        assert!(source.contains("source: \"opencode\""));
        assert!(!source.contains("CLI_MANAGER_NOTIFY_TOKEN="));
    }
}
