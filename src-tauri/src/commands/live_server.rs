use tauri::State;

use crate::live_server::{LiveServerManager, LiveServerOpenResult, LiveServerSession};

#[tauri::command]
pub fn live_server_start(
    manager: State<'_, LiveServerManager>,
    project_path: String,
    relative_path: String,
) -> Result<LiveServerOpenResult, String> {
    manager.start(project_path, relative_path)
}

#[tauri::command]
pub fn live_server_status(
    manager: State<'_, LiveServerManager>,
    project_path: String,
) -> Result<Option<LiveServerSession>, String> {
    manager.status(project_path)
}

#[tauri::command]
pub fn live_server_stop(
    manager: State<'_, LiveServerManager>,
    project_path: String,
) -> Result<bool, String> {
    manager.stop(project_path)
}
