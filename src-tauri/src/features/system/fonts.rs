use std::collections::BTreeSet;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    pub family: String,
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    tauri::async_runtime::spawn_blocking(load_system_font_families)
        .await
        .map_err(|err| format!("字体列表读取任务失败: {err}"))?
}

fn load_system_font_families() -> Result<Vec<SystemFontFamily>, String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let families = db
        .faces()
        .flat_map(|face| face.families.iter().map(|(family, _)| family.trim()))
        .filter(|family| !family.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|family| SystemFontFamily { family })
        .collect();

    Ok(families)
}
