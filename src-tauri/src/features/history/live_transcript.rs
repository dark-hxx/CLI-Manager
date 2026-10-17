//! Web 對話頁的即時轉錄：依位元組游標增量讀取 CLI 自己的對話紀錄，交給 transcript-core 解析成事件。
//!
//! 只接受歷史索引裡、位於歷史根目錄內的會話檔（與 `history_get_session` 相同的驗證），
//! 檔名還必須帶有綁定的 CLI 會話 ID；不會因為前端傳來的路徑去讀其他檔案。

use super::history::{
    history_roots, validate_session_file_ref, validate_session_file_ref_rescanned,
};
use cli_manager_transcript_core::{read_window, Transcript};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptRequest {
    file_path: String,
    source: String,
    project_key: String,
    agent_session_id: String,
    cwd: Option<String>,
    cursor: Option<u64>,
    before: Option<u64>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
}

#[tauri::command]
// 驗證會話檔屬於歷史根目錄且檔名帶有綁定的會話 ID，再依游標讀取一段並解析成對話事件。
pub async fn history_live_transcript_read(
    request: LiveTranscriptRequest,
) -> Result<Transcript, String> {
    tokio::task::spawn_blocking(move || {
        let roots = history_roots(
            request.claude_config_dir,
            request.codex_config_dir,
            request.grok_session_root,
        )
        .with_kimi_config_dir(request.kimi_config_dir);
        let validate = |rescan: bool| {
            let validate = if rescan {
                validate_session_file_ref_rescanned
            } else {
                validate_session_file_ref
            };
            validate(
                &request.file_path,
                &request.source,
                &request.project_key,
                &roots,
            )
        };
        // 新會話（含 /clear 之後）的紀錄檔可能還不在目錄快取裡，未命中時強制重掃一次。
        let file_ref = match validate(false) {
            Err(error) if error == "session_file_not_indexed" => validate(true)?,
            result => result?,
        };
        let agent_session_id = request.agent_session_id.trim();
        let named_after_session = !agent_session_id.is_empty()
            && file_ref
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(agent_session_id));
        if !named_after_session {
            return Err("transcript_session_mismatch".to_string());
        }
        read_window(
            &file_ref.source,
            &file_ref.path,
            request.cursor,
            request.before,
            request.cwd.as_deref(),
            Some(agent_session_id.to_string()),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}
