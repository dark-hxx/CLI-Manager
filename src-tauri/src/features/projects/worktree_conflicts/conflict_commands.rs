//! 冲突工作区薄 IPC；阻塞 Git/IO 离开 UI 线程，核心方法负责 CAS 与证据核验。
use std::collections::BTreeMap;
use serde::Serialize;
use super::{session_abort, session_commit, session_files, session_lifecycle, session_service::{self, Probe},
    session_store::{self, Open, Stored}, session_write::{self, Action}, types::*};

async fn blocking<T, F>(work: F) -> Result<T>
where T: Send + 'static, F: FnOnce() -> Result<T> + Send + 'static {
    tokio::task::spawn_blocking(work).await.map_err(|e| Error::new("task_failed", e))?
}

async fn with_session<T, F>(context: Context, session: String, work: F) -> Result<T>
where T: Send + 'static, F: FnOnce(&Open, &Stored) -> Result<T> + Send + 'static {
    blocking(move || { let open = Open::new(&context)?; let stored = session_service::active(&open, &session)?; work(&open, &stored) }).await
}

#[tauri::command]
pub async fn git_worktree_probe_conflicts(context: Context) -> Result<Probe> {
    blocking(move || session_service::probe(&context)).await
}

#[tauri::command]
pub async fn git_worktree_prepare_conflicts(context: Context, expected_head_oid: String, expected_base_oid: String, operation_id: String) -> Result<Snapshot> {
    blocking(move || session_store::prepare(&context, &expected_head_oid, &expected_base_oid, &operation_id)).await
}

#[tauri::command]
pub async fn git_worktree_conflict_status(context: Context, session_id: String, list_snapshot_id: String, cursor: usize, limit: usize) -> Result<Page> {
    with_session(context, session_id, move |open, stored| session_store::page(open, stored, &list_snapshot_id, cursor, limit)).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResponse { pub request_epoch: u64, pub detail: Detail }

#[tauri::command]
pub async fn git_worktree_conflict_file(context: Context, session_id: String, file_id: String, request_epoch: u64) -> Result<FileResponse> {
    with_session(context, session_id, move |open, stored| Ok(FileResponse { request_epoch, detail: session_files::detail(open, stored, &file_id)? })).await
}

#[tauri::command]
pub async fn git_worktree_save_conflict_draft(context: Context, session_id: String, file_id: String, version: String,
    draft_revision: u64, choices: BTreeMap<String, Selection>, operation_id: String) -> Result<Draft> {
    with_session(context, session_id, move |open, stored| session_files::save_draft(open, stored, &file_id, &version, draft_revision, choices, &operation_id)).await
}

#[tauri::command]
pub async fn git_worktree_take_conflict_side(context: Context, session_id: String, file_id: String, version: String,
    revision: u64, side: Side, operation_id: String) -> Result<Snapshot> {
    with_session(context, session_id, move |open, stored| session_write::resolve(open, stored, &file_id, &version, revision, Action::Side(side), &operation_id)).await
}

#[tauri::command]
pub async fn git_worktree_resolve_conflict_file(context: Context, session_id: String, file_id: String, version: String,
    revision: u64, draft_revision: u64, operation_id: String) -> Result<Snapshot> {
    with_session(context, session_id, move |open, stored| session_write::resolve(open, stored, &file_id, &version, revision, Action::Draft { revision: draft_revision }, &operation_id)).await
}

#[tauri::command]
pub async fn git_worktree_continue_conflicts(context: Context, session_id: String, revision: u64, message: String, operation_id: String) -> Result<Snapshot> {
    with_session(context, session_id, move |open, stored| session_commit::continue_merge(open, stored, revision, &message, &operation_id)).await
}

#[tauri::command]
pub async fn git_worktree_abort_conflicts(context: Context, session_id: String, revision: u64, operation_id: String) -> Result<Snapshot> {
    with_session(context, session_id, move |open, stored| session_abort::abort(open, stored, revision, &operation_id)).await
}

#[tauri::command]
pub async fn git_worktree_recheck_conflicts(context: Context, session_id: String) -> Result<Snapshot> {
    blocking(move || session_service::recheck(&Open::new(&context)?, &session_id)).await
}

#[tauri::command]
pub async fn git_worktree_release_conflicts(context: Context, session_id: String, revision: u64, operation_id: String) -> Result<Snapshot> {
    blocking(move || session_lifecycle::release(&Open::new(&context)?, &session_id, revision, &operation_id)).await
}
