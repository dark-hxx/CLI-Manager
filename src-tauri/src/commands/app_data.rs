use crate::app_paths::{self, DataStorageInspection, DataStorageStatus};
use crate::daemon::client::DaemonBridge;

#[tauri::command]
pub fn app_get_data_storage_status() -> Result<DataStorageStatus, String> {
    app_paths::data_storage_status()
}

#[tauri::command]
pub fn app_inspect_data_dir(target_dir: String) -> Result<DataStorageInspection, String> {
    app_paths::inspect_data_storage_target(&target_dir)
}

#[tauri::command]
pub async fn app_prepare_data_dir_switch(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    target_mode: String,
    target_dir: Option<String>,
    migrate: bool,
) -> Result<String, String> {
    app_paths::validate_data_storage_switch(target_mode.trim(), target_dir.as_deref(), migrate)?;
    if let Some(client) = daemon_bridge.get() {
        let sessions = client.list()?;
        if sessions.iter().any(|session| session.alive) {
            return Err("data_storage_tasks_active".to_string());
        }
        client.shutdown_if_idle()?;
    }

    app_paths::prepare_data_storage_switch(target_mode.trim(), target_dir.as_deref(), migrate)
        .map(|path| path.to_string_lossy().into_owned())
}
