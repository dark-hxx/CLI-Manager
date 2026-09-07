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
pub async fn resource_diagnostics_write(entry: ResourceDiagnosticInput) -> Result<(), String> {
    crate::runtime_diagnostics::write_frontend_entry(
        &entry.level,
        &entry.source,
        &entry.event,
        &entry.payload,
    )
}
