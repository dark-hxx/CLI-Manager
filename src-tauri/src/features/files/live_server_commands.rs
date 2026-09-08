use tauri::State;

use crate::live_server::{LiveServerManager, LiveServerOpenResult, LiveServerSession};

#[tauri::command]
// 委托 Live Server 管理器启动或复用项目静态服务。
pub fn live_server_start(
    manager: State<'_, LiveServerManager>,
    project_path: String,
    relative_path: String,
) -> Result<LiveServerOpenResult, String> {
    manager.start(project_path, relative_path)
}

#[tauri::command]
// 查询指定项目是否具有活动 Live Server 会话。
pub fn live_server_status(
    manager: State<'_, LiveServerManager>,
    project_path: String,
) -> Result<Option<LiveServerSession>, String> {
    manager.status(project_path)
}

#[tauri::command]
// 停止指定项目静态服务并返回是否存在该会话。
pub fn live_server_stop(
    manager: State<'_, LiveServerManager>,
    project_path: String,
) -> Result<bool, String> {
    manager.stop(project_path)
}
