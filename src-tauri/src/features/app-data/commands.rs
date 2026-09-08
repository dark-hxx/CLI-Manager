use crate::app_paths::{self, DataStorageInspection, DataStorageStatus};
use crate::daemon::client::DaemonBridge;

#[tauri::command]
// 返回当前数据根与引导配置状态，不在查询时执行待切换或迁移。
pub fn app_get_data_storage_status() -> Result<DataStorageStatus, String> {
    app_paths::data_storage_status()
}

#[tauri::command]
// 将目标交给路径层规范化并检查空目录/可写性；检查可能创建探测文件，但不保存切换请求。
pub fn app_inspect_data_dir(target_dir: String) -> Result<DataStorageInspection, String> {
    app_paths::inspect_data_storage_target(&target_dir)
}

#[tauri::command]
// 先验证目标，再拒绝已连接 daemon 的存活会话并请求空闲退出，最后写入下次启动的切换意图。
// 不直接迁移数据或切换当前根；未取得 daemon 客户端时跳过会话查询，不主动关闭运行任务。
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
