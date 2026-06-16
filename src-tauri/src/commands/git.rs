use git2::Repository;
use std::path::Path;

/// 查询指定路径的当前 git 分支
///
/// 使用 libgit2 库直接查询仓库状态，避免文件 I/O 触发安全软件弹窗。
/// libgit2 是 Git 官方认证的库，被安全软件白名单信任，且比直接读文件更快（内部有缓存）。
/// 整段查询包在 `spawn_blocking` 内，不阻塞 tokio runtime 工作线程。
///
/// # Returns
/// * `Ok(Some(branch))` - 普通分支
/// * `Ok(None)` - 非 git 仓库、detached HEAD、路径无效，或查询失败
#[tauri::command]
pub async fn get_current_git_branch(path: String) -> Result<Option<String>, String> {
    // 前置检查：路径为空或不存在时快速返回
    if path.is_empty() || !Path::new(&path).exists() {
        return Ok(None);
    }

    tokio::task::spawn_blocking(move || {
        // 尝试打开 git 仓库
        let repo = match Repository::open(&path) {
            Ok(r) => r,
            Err(_) => return Ok(None), // 非 git 仓库或无权限
        };

        // 获取 HEAD 引用
        let head = match repo.head() {
            Ok(h) => h,
            Err(_) => return Ok(None), // detached HEAD 或其他异常
        };

        // 提取短分支名（如 "main"、"feature/foo"）
        // shorthand() 对于 refs/heads/main 返回 "main"，对于 detached HEAD 返回 None
        Ok(head.shorthand().map(|s| s.to_string()))
    })
    .await
    .map_err(|e| format!("git 分支查询任务失败: {e}"))?
}
