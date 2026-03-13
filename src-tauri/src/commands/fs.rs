use std::path::Path;

#[tauri::command]
pub async fn check_paths_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(paths.iter().map(|p| Path::new(p).exists()).collect())
}
