use std::collections::BTreeSet;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    pub family: String,
}

#[tauri::command]
// 将系统字体扫描放到阻塞任务中，等待完成后返回字体家族列表，任务执行失败转换为上下文错误。
pub async fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    tauri::async_runtime::spawn_blocking(load_system_font_families)
        .await
        .map_err(|err| format!("字体列表读取任务失败: {err}"))?
}

// 每次新建字体数据库并扫描系统字体，裁剪空白、过滤空名称后按字符串排序去重，不按字重返回。
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
