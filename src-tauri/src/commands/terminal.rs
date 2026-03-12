use crate::pty::manager::PtyManager;
use std::collections::HashMap;
use tauri::AppHandle;
use uuid::Uuid;

#[tauri::command]
pub async fn pty_create(
    app_handle: AppHandle,
    pty_manager: tauri::State<'_, PtyManager>,
    cwd: Option<String>,
    env_vars: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    pty_manager.create(&session_id, cwd.as_deref(), env_vars, app_handle)?;
    Ok(session_id)
}

#[tauri::command]
pub async fn pty_write(
    pty_manager: tauri::State<'_, PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    pty_manager.write(&session_id, &data)
}

#[tauri::command]
pub async fn pty_resize(
    pty_manager: tauri::State<'_, PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty_manager.resize(&session_id, cols, rows)
}

#[tauri::command]
pub async fn pty_close(
    pty_manager: tauri::State<'_, PtyManager>,
    session_id: String,
) -> Result<(), String> {
    pty_manager.close(&session_id)
}
