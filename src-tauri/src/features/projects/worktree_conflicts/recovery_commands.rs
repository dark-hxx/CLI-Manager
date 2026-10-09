//! 主检出恢复的薄 IPC 适配；阻塞 Git/文件操作离开 UI 线程。
use super::{main_recovery::{self, RecoveryStatus}, types::{Error, Result}};

/// 恢复只针对主检出，不可用其他 linked Worktree 冒充主仓库。
fn open(project_path: &str) -> Result<git2::Repository> {
    let repo = super::super::open_main_repo(project_path).map_err(|e| Error::new("identity", e))?;
    if repo.is_worktree() { return Err(Error::new("identity", "expected primary checkout")); }
    Ok(repo)
}

/// 弹窗每次打开都探测持久化日志，不依赖上一次 IPC 是否收到结果。
#[tauri::command]
pub async fn git_worktree_recovery_probe(project_path: String) -> Result<RecoveryStatus> {
    tokio::task::spawn_blocking(move || {
        let repo = open(&project_path)?;
        let _lock = crate::repo_operation::lock(repo.path()).map_err(|e| Error::new("busy", e))?;
        main_recovery::probe(&repo)
    }).await.map_err(|e| Error::new("task_failed", e))?
}

/// confirm=false 只允许基线证明，confirm=true 仍必须核对所展示状态指纹。
#[tauri::command]
pub async fn git_worktree_recovery_recheck(
    project_path: String, state_token: Option<String>, confirm: bool,
) -> Result<RecoveryStatus> {
    tokio::task::spawn_blocking(move || {
        let repo = open(&project_path)?;
        main_recovery::recheck(&repo, state_token.as_deref(), confirm)
    }).await.map_err(|e| Error::new("task_failed", e))?
}
