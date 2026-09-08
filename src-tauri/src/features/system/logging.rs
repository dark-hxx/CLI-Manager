use log::LevelFilter;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDiagnosticInput {
    level: String,
    source: String,
    event: String,
    payload: Value,
}

#[tauri::command]
// 同时调整 Rust 最大日志级别与进程周期采样开关，只改变运行状态，不持久化用户设置。
pub async fn set_debug_logging(enabled: bool) -> Result<(), String> {
    let level = if enabled {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    log::set_max_level(level);
    crate::runtime_diagnostics::set_enabled(enabled);
    log::info!(
        "debug logging {}",
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

#[tauri::command]
// 将前端诊断条目交给专用路由/大小校验和写入器，不经过普通日志与崩溃 breadcrumbs 链路。
pub async fn resource_diagnostics_write(entry: ResourceDiagnosticInput) -> Result<(), String> {
    crate::runtime_diagnostics::write_frontend_entry(
        &entry.level,
        &entry.source,
        &entry.event,
        &entry.payload,
    )
}
