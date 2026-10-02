use serde::Serialize;
use std::collections::HashMap;
use tauri::Manager;

#[path = "launch.rs"]
mod launch;
#[path = "preflight.rs"]
mod preflight;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekTuiInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    host_entry_path: Option<String>,
    version: String,
    profile_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manager_patch_path: Option<String>,
}

/// Inspect the selected host and prepared plugin profile without executing user code.
#[tauri::command]
pub async fn deepseek_tui_preflight(
    app: tauri::AppHandle,
    source_root: Option<String>,
    env_vars: Option<HashMap<String, String>>,
) -> Result<DeepSeekTuiInfo, String> {
    // Read-only ownership hint for removing overlays saved by older managers.
    let cache = app.path().app_cache_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let mut info = preflight::inspect(source_root.as_deref(), &env_vars.unwrap_or_default())?;
        info.manager_patch_path = cache.map(|path| {
            path.join("deepseek-tui")
                .join("0".repeat(64))
                .join("bridge.yml")
                .to_string_lossy()
                .into_owned()
        });
        Ok(info)
    })
    .await
    .map_err(|_| "deepseek_tui_profile_unbuilt".to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekTuiLaunchInfo {
    patch_path: String,
    preload_path: String,
    preload_url: String,
    cmd_preload_path: String,
}

/// Stage the manager-owned event bridge only after the existing host/profile pass preflight.
#[tauri::command]
pub async fn deepseek_tui_prepare_launch(
    app: tauri::AppHandle,
    source_root: Option<String>,
    env_vars: Option<HashMap<String, String>>,
) -> Result<DeepSeekTuiLaunchInfo, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "deepseek_tui_patch_failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        preflight::inspect_bridge(source_root.as_deref(), &env_vars.unwrap_or_default())?;
        launch::prepare_patch(&cache)
    })
    .await
    .map_err(|_| "deepseek_tui_patch_failed".to_string())?
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

// Reuse the opt-in ConPTY smoke without rebuilding the running desktop executable.
#[cfg(all(test, target_os = "windows"))]
#[path = "../../../tests/deepseek_tui_smoke.rs"]
mod tui_smoke;
