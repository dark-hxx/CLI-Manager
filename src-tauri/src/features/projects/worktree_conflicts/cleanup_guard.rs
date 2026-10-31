use git2::Repository;
use std::path::Path;
use crate::repo_operation::{self, OperationLock};
use super::file_io;

/// 从 Git 的登记反向定位私有目录；工作目录或 .git 被外部移动后仍保护现场。
pub fn lock_registered(repo: &Repository, target: &Path) -> Result<Option<OperationLock>, String> {
    let directory = repo.path().join("worktrees");
    if !directory.exists() { return Ok(None); }
    let target = super::super::normalize_path_for_compare(target);
    for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().into_string().map_err(|_| "invalid_worktree_gitdir")?;
        let private = file_io::safe_path(repo.path(), &format!("worktrees/{name}"))
            .map_err(super::main_recovery::message)?;
        let backlink = file_io::safe_path(&private, "gitdir").map_err(super::main_recovery::message)?;
        let bytes = file_io::bounded(&backlink, 64 * 1024).map_err(super::main_recovery::message)?;
        let value = std::str::from_utf8(&bytes).map_err(|_| "invalid_worktree_gitdir")?.trim();
        let link = private.join(value);
        let root = link.parent().ok_or("invalid_worktree_gitdir")?;
        if super::super::normalize_path_for_compare(root) != target { continue; }
        let guard = repo_operation::lock(&private)?;
        repo_operation::ensure_git_dir_idle(&private)?;
        return Ok(Some(guard));
    }
    Ok(None)
}
