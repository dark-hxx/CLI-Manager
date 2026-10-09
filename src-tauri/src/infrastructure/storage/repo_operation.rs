//! Git 与 Worktree 共用的短锁和未完成操作检查，不依赖业务功能域。
use git2::{Repository, RepositoryState};
use std::fs::{File, OpenOptions};
use std::path::Path;

/// 持有描述符直到写操作结束；OS 锁随进程退出释放，不按文件年龄抢锁。
pub struct OperationLock {
    _file: File,
}

/// 使用独立锁文件，不创建、删除或强占 Git 的 index.lock。
pub fn lock(git_dir: &Path) -> Result<OperationLock, String> {
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(git_dir.join("cli-manager-operation.lock"))
        .map_err(|e| format!("repository_lock_failed: {e}"))?;
    file.try_lock().map_err(|e| format!("repository_busy: {e}"))?;
    Ok(OperationLock { _file: file })
}

/// 普通写命令不能完成 merge/rebase，也不能越过持久化恢复闸门。
pub fn ensure_idle(repo: &Repository) -> Result<(), String> {
    if repo.state() != RepositoryState::Clean {
        return Err("repository_operation_in_progress".into());
    }
    ensure_git_dir_idle(repo.path())
}

/// 工作目录缺失时仍检查私有 Git 目录，避免 prune 顺手删除恢复凭据。
pub fn ensure_git_dir_idle(git_dir: &Path) -> Result<(), String> {
    if ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge",
        "rebase-apply", "sequencer", "index.lock", "HEAD.lock"]
        .iter().any(|name| git_dir.join(name).symlink_metadata().is_ok()) {
        return Err("repository_operation_in_progress".into());
    }
    if git_dir.join("cli-manager-main-recovery.json").symlink_metadata().is_ok()
        || git_dir.join("cli-manager-conflict-active.json").symlink_metadata().is_ok() {
        return Err("repository_recovery_required".into());
    }
    let path = git_dir.join("index");
    if path.exists() {
        let index = git2::Index::open(&path).map_err(|e| format!("index_failed: {e}"))?;
        if index.has_conflicts() { return Err("repository_operation_in_progress".into()); }
    }
    Ok(())
}

/// 加锁后再次检查，调用者须将返回值保留至 Git 写入结束。
pub fn begin_ordinary_write(repo: &Repository) -> Result<OperationLock, String> {
    let guard = lock(repo.path())?;
    ensure_idle(repo)?;
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        /// 仅清理由本测试创建的 UUID 临时目录。
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    /// 即使 index 已全部暂存，未完成操作仍必须阻止单父提交。
    #[test]
    fn blocks_unfinished_operations_and_recovery() {
        let fixture = Fixture(std::env::temp_dir().join(format!("cli-manager-guard-{}", uuid::Uuid::new_v4())));
        let repo = Repository::init(&fixture.0).unwrap();
        assert!(ensure_idle(&repo).is_ok());
        for name in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "index.lock", "HEAD.lock", "cli-manager-main-recovery.json", "cli-manager-conflict-active.json"] {
            let path = repo.path().join(name);
            std::fs::write(&path, b"intent").unwrap();
            assert!(ensure_idle(&repo).is_err(), "{name}");
            std::fs::remove_file(path).unwrap();
        }
        let guard = begin_ordinary_write(&repo).unwrap();
        assert!(lock(repo.path()).is_err());
        drop(guard);
        assert!(begin_ordinary_write(&repo).is_ok());
        assert!(!repo.path().join("index.lock").exists());
    }
}
