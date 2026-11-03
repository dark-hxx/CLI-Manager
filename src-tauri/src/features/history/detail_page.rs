use super::*;
use catalog::{HistoryDetailWindow, HistorySessionPage};

#[tauri::command]
pub async fn history_get_session_page(
    app: tauri::AppHandle,
    file_path: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    source: String,
    project_key: String,
    offset: Option<usize>,
    revision: Option<String>,
) -> Result<HistorySessionPage, String> {
    let offset = offset.unwrap_or(0);
    if offset > i32::MAX as usize {
        return Err("history_page_offset_invalid".into());
    }
    let roots = history_roots(
        claude_config_dir.clone(),
        codex_config_dir.clone(),
        grok_session_root.clone(),
    )
    .with_kimi_config_dir(kimi_config_dir.clone());
    if !catalog::is_dirty() || source.eq_ignore_ascii_case("opencode") {
        if let Some(page) = catalog::get_session_page_from_v2(
            &roots,
            &file_path,
            &source.trim().to_lowercase(),
            &project_key,
            HistoryDetailWindow {
                offset,
                limit: 160,
                revision: revision.clone(),
            },
        )
        .await?
        {
            return Ok(page);
        }
    }
    // Never splice a fresh live parse into old indexed pages. The caller must
    // restart selection so original message/line anchors remain trustworthy.
    if offset != 0 || revision.is_some() {
        return Err("history_page_changed".into());
    }
    let detail = history_get_session(
        app,
        file_path,
        claude_config_dir,
        codex_config_dir,
        grok_session_root,
        kimi_config_dir,
        source,
        project_key,
        None,
        None,
    )
    .await?;
    Ok(HistorySessionPage {
        detail,
        offset: 0,
        revision: String::new(),
        complete: true,
    })
}
