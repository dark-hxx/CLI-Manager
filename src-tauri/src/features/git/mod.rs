mod status;
use status::{git_get_changes_native, git_get_changes_wsl};
mod wsl;
use wsl::{
    build_wsl_git_command_args, effective_git_project_path, is_not_git_repository_output,
    parse_wsl_git_status,
};
pub(super) use wsl::{resolve_wsl_mnt_git_project_path, run_wsl_git};
mod snapshot;
use snapshot::{
    build_worktree_patch, build_worktree_snapshot, compute_diff_line_stats,
    compute_wsl_diff_line_stats, should_skip_diff_line_stats, truncate_snapshot_patch_for_webview,
};
mod diff_format;
use diff_format::format_diff_to_bounded_text;
pub(super) use diff_format::{format_diff_to_text_allow_empty, validate_repo_relative_path};
mod patches;
use patches::{
    apply_patch_to_repo, apply_patch_to_workdir, build_reverse_hunk_patch, parse_hunk_header,
};
mod partial_patch;
use partial_patch::build_reverse_lines_patch;
mod cli;
pub(super) use cli::{
    git_command_output, run_git_cli, validate_commit_ref, validate_operation_ref,
};
use cli::{
    is_no_stash_created, map_git_cli_error, run_checkout_branch, split_remote_branch,
    validate_branch_name, validate_branch_name_with_git,
};

use git2::{build::CheckoutBuilder, Repository, ResetType, StatusOptions};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, State};

pub use super::git_diff::{GitDiffOptions, GitFileDiffPayload};
use crate::git_watcher::GitWatcherBridge;

const GIT_DIFF_LINE_STATS_STATUS_LIMIT: usize = 500;
const GIT_DIFF_LINE_STATS_LINE_LIMIT: usize = 200_000;
const MAX_WORKTREE_PATCH_BYTES: usize = 4 * 1024 * 1024;
const OOM_PATCH_WARN_BYTES: usize = MAX_WORKTREE_PATCH_BYTES;
const OOM_SNAPSHOT_PATCH_RETURN_MAX_BYTES: usize = MAX_WORKTREE_PATCH_BYTES;
const OOM_SNAPSHOT_FILES_WARN_COUNT: usize = 500;
const WSL_GIT_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// 「目录不是 Git 仓库」的稳定错误码，native/libgit2 与 WSL 链路共用。
/// 前端据此渲染友好空态并缓存非 Git 结果；权限、所有权等失败不得归入该码。
pub(super) const NOT_GIT_REPOSITORY_CODE: &str = "not_git_repository";

static WORKTREE_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
// libgit2 的所有权校验开关是进程级状态。所有仓库打开都经过这把锁，避免
// 某个仓库的兼容重试暂时关闭校验时影响并发的其它 Git 操作。
static GIT_OWNER_VALIDATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

// 获取串行化工作区快照操作的全局锁，锁中毒时返回错误。
fn acquire_worktree_operation_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    WORKTREE_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "worktree_operation_lock_poisoned".to_string())
}

// 按补丁字节数和文件数量阈值记录工作区快照内存诊断。
fn log_worktree_snapshot_oom_diagnostic(
    phase: &str,
    project_path: &str,
    snapshot: &GitWorktreeSnapshot,
    elapsed_ms: u128,
) {
    let patch_bytes = snapshot.patch_bytes;
    let threshold_exceeded = patch_bytes >= OOM_PATCH_WARN_BYTES
        || snapshot.files.len() >= OOM_SNAPSHOT_FILES_WARN_COUNT;
    if threshold_exceeded {
        log::warn!(
            "[oom-diagnostics:backend] area=git phase={phase} project_path={} dirty={} files={} patch_bytes={} elapsed_ms={} threshold_exceeded=true",
            project_path,
            snapshot.dirty,
            snapshot.files.len(),
            patch_bytes,
            elapsed_ms
        );
    } else {
        log::debug!(
            "[oom-diagnostics:backend] area=git phase={phase} project_path={} dirty={} files={} patch_bytes={} elapsed_ms={} threshold_exceeded=false",
            project_path,
            snapshot.dirty,
            snapshot.files.len(),
            patch_bytes,
            elapsed_ms
        );
    }
}

/// libgit2 打开仓库失败的错误映射。
///
/// `NotFound` 表示路径存在但没有 Git 仓库，映射为稳定错误码前缀供上层统一识别；
/// 其余错误（所有权误判、权限不足、仓库损坏等）保留原始描述，避免误判成「不是仓库」
/// 而让面板显示空态、掩盖真实故障。
// 仅将 libgit2 的 NotFound 映射为非仓库错误码，其余保留错误原因。
fn format_open_repo_error(error: &git2::Error) -> String {
    if error.code() == git2::ErrorCode::NotFound {
        return format!("{NOT_GIT_REPOSITORY_CODE}: 打开 Git 仓库失败: {error}");
    }
    format!("打开 Git 仓库失败: {error}")
}

/// 判定错误串是否表示「目录不是 Git 仓库」：稳定错误码或 shell-out Git 的原生文案。
// 识别稳定非仓库错误码或 Git 命令输出中的非仓库提示。
pub(super) fn is_not_git_repository_error(message: &str) -> bool {
    message.contains(NOT_GIT_REPOSITORY_CODE) || is_not_git_repository_output(message)
}

/// 打开 Git 仓库的统一入口，兼容 WSL UNC 路径。
///
/// libgit2 在 Windows 上会校验仓库路径所有权，WSL UNC 路径（`\\wsl.localhost\...`）
/// 通过 Plan 9 协议暴露，所有权信息无法正确传递，导致 `Repository::open` 失败。
/// 本函数检测到 WSL UNC 路径或本地仓库所有权误判时，临时关闭所有权验证后重试。
// 持锁打开仓库，遇到所有权或 WSL 兼容问题时临时关闭校验重试并恢复开关。
pub(super) fn open_git_repo<P: AsRef<Path>>(path: P) -> Result<Repository, String> {
    let path = path.as_ref();
    let _owner_lock = GIT_OWNER_VALIDATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "git_owner_validation_lock_poisoned".to_string())?;

    match Repository::open(path) {
        Ok(repo) => return Ok(repo),
        Err(first_err) => {
            let path_str = path.to_string_lossy();
            let is_wsl_path = crate::wsl::is_wsl_config_dir(&path_str);
            let is_owner_error = first_err.code() == git2::ErrorCode::Owner;
            if !is_wsl_path && !is_owner_error {
                return Err(format_open_repo_error(&first_err));
            }
            log::debug!(
                "[git] 首次打开失败，临时关闭所有权验证后重试: path={} wsl={} owner_error={} error={first_err}",
                path_str,
                is_wsl_path,
                is_owner_error,
            );
            log::debug!("[git] 临时关闭 libgit2 所有权验证后重试");
        }
    }

    // WSL UNC 或用户明确选择的本地仓库：关闭所有权验证后重试。
    // SAFETY: 开关是进程级状态，调用方持有 GIT_OWNER_VALIDATION_LOCK，且在返回前恢复。
    let result = unsafe {
        git2::opts::set_verify_owner_validation(false)
            .map_err(|e| format!("设置 git2 选项失败: {e}"))
            .and_then(|_| Repository::open(path).map_err(|e| format_open_repo_error(&e)))
    };
    // 立即恢复所有权验证
    if let Err(e) = unsafe { git2::opts::set_verify_owner_validation(true) } {
        log::error!("[git] 恢复 libgit2 所有权验证失败: {e}");
        return Err(format!("恢复 Git 所有权验证失败: {e}"));
    }

    match &result {
        Ok(_) => log::debug!(
            "[git] 关闭所有权验证后 Git 仓库打开成功: path={}",
            path.to_string_lossy()
        ),
        Err(e) => log::warn!(
            "[git] 关闭所有权验证后仍失败: path={} error={e}",
            path.to_string_lossy()
        ),
    }
    result
}

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
// 在线程池读取当前 HEAD 的短引用名，WSL 路径改用 Git 命令查询。
pub async fn get_current_git_branch(path: String) -> Result<Option<String>, String> {
    if path.is_empty() {
        return Ok(None);
    }

    tokio::task::spawn_blocking(move || {
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path) {
            return Ok(current_wsl_git_branch(&distro, &linux_path));
        }

        if !Path::new(&path).exists() {
            return Ok(None);
        }

        // 尝试打开 git 仓库
        let repo = match open_git_repo(&path) {
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

// 读取 WSL 当前分支，将空输出或查询失败降级为无分支。
fn current_wsl_git_branch(distro: &str, linux_path: &str) -> Option<String> {
    match run_wsl_git(distro, linux_path, &["branch", "--show-current"]) {
        Ok(stdout) => {
            let branch = String::from_utf8_lossy(&stdout).trim().to_string();
            (!branch.is_empty()).then_some(branch)
        }
        Err(e) => {
            log::warn!("[git:wsl] 当前分支查询降级为空: {e}");
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub added: i32,
    pub deleted: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeSnapshot {
    pub project_path: String,
    pub head: String,
    pub branch: Option<String>,
    pub dirty: bool,
    pub patch: String,
    pub patch_bytes: usize,
    pub patch_truncated: bool,
    pub files: Vec<GitFileChange>,
}

/// 获取指定路径的 Git 文件变更列表
///
/// 使用 libgit2 库查询工作区和暂存区的文件状态。
///
/// # Returns
/// * `Ok(Vec<GitFileChange>)` - 变更文件列表
/// * `Err(String)` - 错误信息
#[tauri::command]
// 在线程池按原生或 WSL 路径查询文件变更，挂载盘路径优先原生处理。
pub async fn git_get_changes(project_path: String) -> Result<Vec<GitFileChange>, String> {
    log::debug!(
        "[git_get_changes] 开始查询 Git 变更, project_path: {}",
        project_path
    );

    tokio::task::spawn_blocking(move || {
        let started_at = std::time::Instant::now();
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&project_path) {
            if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
                log::debug!(
                    "[git_get_changes:wsl] WSL UNC 解析到 Windows 挂载路径，改用 native git 状态: project_path={} resolved={}",
                    project_path,
                    windows_path
                );
                return git_get_changes_native(&windows_path, started_at);
            }
            return git_get_changes_wsl(&project_path, &distro, &linux_path, started_at);
        }

        git_get_changes_native(&project_path, started_at)
    })
    .await
    .map_err(|e| {
        let err_msg = format!("Git 变更查询任务失败: {}", e);
        log::error!("[git_get_changes] {}", err_msg);
        err_msg
    })?
}

/// 子仓库扫描时跳过的目录名（常见大目录 / 构建产物，防止面板首开被拖慢）。
const REPO_SCAN_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".venv",
    "vendor",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    /// 相对项目根路径：根仓库为空串，子仓库如 "sub-repo-a"、"tools/sub-repo-c"（'/' 分隔）。
    relative_path: String,
    absolute_path: String,
    branch: Option<String>,
}

/// 纯 fs 扫描：枚举 root 下含 `.git`（目录或 gitlink 文件）的仓库路径。
///
/// 根自身是仓库时为首条（相对路径空串）；子仓库按相对路径排序。
/// 找到 `.git` 的目录不再向其内部递归；深度按相对根计（一级子目录为 1）。
// 收集根仓库及限深子仓库路径，保持根优先并对子仓库排序。
fn scan_git_repository_paths(root: &Path, max_depth: usize) -> Vec<(String, std::path::PathBuf)> {
    let mut repos = Vec::new();
    if root.join(".git").exists() {
        repos.push((String::new(), root.to_path_buf()));
    }

    let mut sub_repos = Vec::new();
    scan_sub_repositories(root, "", 1, max_depth, &mut sub_repos);
    sub_repos.sort_by(|a, b| a.0.cmp(&b.0));
    repos.extend(sub_repos);
    repos
}

// 限深扫描非排除目录，跳过符号链接并在发现子仓库后停止向内递归。
fn scan_sub_repositories(
    dir: &Path,
    rel_prefix: &str,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<(String, std::path::PathBuf)>,
) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 跳过符号链接目录，避免循环与越界扫描；file_type() 不跟随符号链接。
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if REPO_SCAN_EXCLUDED_DIRS
            .iter()
            .any(|excluded| excluded.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        let child = entry.path();
        let rel = if rel_prefix.is_empty() {
            name
        } else {
            format!("{rel_prefix}/{name}")
        };
        if child.join(".git").exists() {
            // 子仓库：收录后不再向其内部递归。
            out.push((rel, child));
        } else {
            scan_sub_repositories(&child, &rel, depth + 1, max_depth, out);
        }
    }
}

/// 枚举项目根目录下的 Git 仓库（根仓库 + 限深子仓库），供 Git 面板切换监控目标。
///
/// 分支查询失败不报错（返回 None）；WSL UNC 路径经 Plan 9 访问较慢，限深 2 防卡顿。
#[tauri::command]
// 验证项目目录后扫描根仓库与子仓库，并尽力读取各仓库分支。
pub async fn git_list_repositories(project_path: String) -> Result<Vec<GitRepoInfo>, String> {
    tokio::task::spawn_blocking(move || {
        if project_path.is_empty() {
            return Err("路径不存在: (空)".to_string());
        }
        let root = Path::new(&project_path);
        if !root.exists() {
            return Err(format!("路径不存在: {project_path}"));
        }
        if !root.is_dir() {
            return Err(format!("路径不是目录: {project_path}"));
        }

        let max_depth = if crate::wsl::parse_wsl_unc_path(&project_path).is_some() {
            2
        } else {
            3
        };
        let repos = scan_git_repository_paths(root, max_depth)
            .into_iter()
            .map(|(relative_path, absolute_path)| {
                let branch = open_git_repo(&absolute_path)
                    .ok()
                    .and_then(|repo| repo_branch_name(&repo));
                GitRepoInfo {
                    relative_path,
                    absolute_path: absolute_path.to_string_lossy().to_string(),
                    branch,
                }
            })
            .collect();
        Ok(repos)
    })
    .await
    .map_err(|e| format!("Git 仓库扫描任务失败: {e}"))?
}

// 将 libgit2 状态映射为状态字母和暂存标记，冲突优先于暂存状态。
fn parse_git2_status(status: git2::Status) -> (&'static str, bool) {
    // 冲突优先：合并/变基产生的冲突文件，独立标识 "C"，避免被当成普通修改而误提交。
    if status.is_conflicted() {
        return ("C", false);
    }
    // 优先级：INDEX (staged) > WT (worktree)
    if status.is_index_new() {
        return ("A", true);
    }
    if status.is_index_modified() {
        return ("M", true);
    }
    if status.is_index_deleted() {
        return ("D", true);
    }
    if status.is_index_renamed() {
        return ("R", true);
    }

    if status.is_wt_modified() {
        return ("M", false);
    }
    if status.is_wt_deleted() {
        return ("D", false);
    }
    if status.is_wt_renamed() {
        return ("R", false);
    }
    if status.is_wt_new() {
        return ("U", false); // Untracked
    }

    ("M", false) // 默认
}

/// 把 git 路径归一化为正斜杠分隔，统一统计表 key 与 status 条目路径（Windows 兼容）。
// 将路径反斜杠转换为正斜杠以统一统计键。
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
}

// 读取 HEAD 目标对象 ID，缺少 HEAD 或目标时返回错误。
fn repo_head_oid(repo: &Repository) -> Result<String, String> {
    let head = repo.head().map_err(|e| format!("head_failed: {e}"))?;
    let oid = head.target().ok_or("head_target_missing")?;
    Ok(oid.to_string())
}

// 尽力读取 HEAD 的短引用名，查询失败时返回空值。
fn repo_branch_name(repo: &Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|head| head.shorthand().map(|value| value.to_string()))
}

/// 判断 status 条目是否为嵌套 Git 仓库目录（尾部 '/' 且目录内存在 .git）。
///
/// 嵌套 git 仓库（非 submodule）会以带尾部斜杠的目录条目出现；
/// recurse_untracked_dirs(true) 已展开普通未跟踪目录，只有嵌套仓库才保留目录形式。
/// submodule/worktree 的 .git 是文件，目录/文件均算命中。
/// 跳过此类条目可避免前端把目录当普通文件请求 diff 导致原始 OS 错误（见 issue #85）。
// 检查尾部带斜杠的状态路径是否为含 .git 的嵌套仓库目录。
fn is_nested_repo_entry(repo: &Repository, file_path: &str) -> bool {
    if !file_path.ends_with('/') {
        return false;
    }
    repo.workdir()
        .map(|workdir| workdir.join(file_path).join(".git").exists())
        .unwrap_or(false)
}

// 收集工作区和暂存区变更，跳过嵌套仓库并按规模决定是否计算行数。
fn collect_git_changes_from_repo(repo: &Repository) -> Result<Vec<GitFileChange>, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("status_failed: {e}"))?;
    let skipped_line_stats = should_skip_diff_line_stats(statuses.len());
    let stats = if skipped_line_stats {
        std::collections::HashMap::new()
    } else {
        compute_diff_line_stats(repo)
    };

    let mut changes = Vec::new();
    for entry in statuses.iter() {
        let file_path = entry.path().unwrap_or("").to_string();
        if file_path.is_empty() {
            continue;
        }
        if is_nested_repo_entry(repo, &file_path) {
            continue;
        }
        let (status_char, staged) = parse_git2_status(entry.status());
        let (added, deleted) = stats
            .get(&normalize_path(&file_path))
            .copied()
            .unwrap_or((0, 0));
        changes.push(GitFileChange {
            path: file_path,
            status: status_char.to_string(),
            staged,
            added,
            deleted,
        });
    }
    Ok(changes)
}

#[derive(Debug)]
struct BoundedPatch {
    text: String,
    bytes: usize,
    truncated: bool,
}

/// 获取指定文件的 Git diff 内容
///
/// # Returns
/// * `Ok(String)` - unified diff 格式的文本
/// * `Err(String)` - 错误信息
#[tauri::command]
// 校验差异选项后在线程池读取指定文件的差异载荷。
pub async fn git_get_file_diff(
    project_path: String,
    file_path: String,
    status: String,
    options: Option<GitDiffOptions>,
) -> Result<GitFileDiffPayload, String> {
    log::debug!(
        "[git_get_file_diff] project_path: {}, file_path: {}, status: {}",
        project_path,
        file_path,
        status
    );

    let options = options.unwrap_or_default().validate()?;
    tokio::task::spawn_blocking(move || {
        super::git_diff::get_file_diff(&project_path, &file_path, &status, options)
    })
    .await
    .map_err(|e| format!("任务失败: {}", e))?
}

#[tauri::command]
// 持工作区操作锁生成快照，限制返回补丁大小并记录内存诊断。
pub async fn git_get_worktree_snapshot(
    project_path: String,
) -> Result<GitWorktreeSnapshot, String> {
    log::debug!("[git_get_worktree_snapshot] project_path: {}", project_path);

    tokio::task::spawn_blocking(move || {
        let _worktree_lock = acquire_worktree_operation_lock()?;
        let started_at = std::time::Instant::now();
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut snapshot = build_worktree_snapshot(&project_path, &repo)?;
        truncate_snapshot_patch_for_webview(&mut snapshot);
        log_worktree_snapshot_oom_diagnostic(
            "git_get_worktree_snapshot",
            &project_path,
            &snapshot,
            started_at.elapsed().as_millis(),
        );
        Ok(snapshot)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

// 校验路径规范化后仍在仓库内，仅删除文件并清理沿途空父目录。
fn remove_untracked_snapshot_file(workdir: &Path, relative_path: &str) -> Result<(), String> {
    validate_repo_relative_path(relative_path)?;
    let full_path = workdir.join(relative_path);
    if !full_path.exists() {
        return Ok(());
    }

    let canon_root = workdir
        .canonicalize()
        .map_err(|e| format!("root_canonicalize_failed: {e}"))?;
    let canon_target = full_path
        .canonicalize()
        .map_err(|e| format!("target_canonicalize_failed: {e}"))?;
    if !canon_target.starts_with(&canon_root) {
        return Err("path_outside_root".to_string());
    }

    let metadata =
        std::fs::symlink_metadata(&full_path).map_err(|e| format!("metadata_failed: {e}"))?;
    if metadata.is_dir() {
        return Err("untracked_directory_not_supported".to_string());
    }
    std::fs::remove_file(&full_path).map_err(|e| format!("remove_untracked_failed: {e}"))?;

    let mut parent = full_path.parent();
    while let Some(dir) = parent {
        if dir == workdir {
            break;
        }
        match std::fs::remove_dir(dir) {
            Ok(()) => parent = dir.parent(),
            Err(_) => break,
        }
    }
    Ok(())
}

// 校验快照分支名的空白、路径片段和非法字符。
fn validate_snapshot_branch_name(branch_name: &str) -> Result<(), String> {
    let trimmed = branch_name.trim();
    if trimmed.is_empty() {
        return Err("branch_name_empty".to_string());
    }
    if trimmed != branch_name || trimmed.contains("..") || trimmed.starts_with('/') {
        return Err("branch_name_invalid".to_string());
    }
    if trimmed.ends_with('/') || trimmed.ends_with(".lock") {
        return Err("branch_name_invalid".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err("branch_name_invalid".to_string());
    }
    Ok(())
}

#[tauri::command]
// 核对 HEAD 与当前补丁后硬重置工作区，清理未跟踪文件并应用目标快照。
pub async fn git_restore_worktree_snapshot(
    project_path: String,
    target_patch: String,
    expected_current_patch: String,
    target_head: String,
) -> Result<GitWorktreeSnapshot, String> {
    log::info!(
        "[git_restore_worktree_snapshot] project_path: {}, target_patch_bytes: {}, expected_patch_bytes: {}",
        project_path,
        target_patch.len(),
        expected_current_patch.len()
    );

    tokio::task::spawn_blocking(move || {
        let _worktree_lock = acquire_worktree_operation_lock()?;
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let current_head = repo_head_oid(&repo)?;
        if !target_head.trim().is_empty() && current_head != target_head {
            return Err("head_mismatch".to_string());
        }

        let current_patch = build_worktree_patch(&repo)?;
        if current_patch.truncated {
            return Err("worktree_snapshot_too_large".to_string());
        }
        if current_patch.text != expected_current_patch {
            return Err("worktree_changed_since_snapshot".to_string());
        }

        let current_changes = collect_git_changes_from_repo(&repo)?;
        let head = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(|e| format!("head_failed: {e}"))?;
        repo.reset(head.as_object(), ResetType::Hard, None)
            .map_err(|e| format!("reset_failed: {e}"))?;

        if let Some(workdir) = repo.workdir() {
            for change in current_changes
                .iter()
                .filter(|item| item.status == "U" || item.status == "??")
            {
                remove_untracked_snapshot_file(workdir, &change.path)?;
            }
        }

        if !target_patch.trim().is_empty() {
            apply_patch_to_repo(&repo, &target_patch)?;
        }

        build_worktree_snapshot(&project_path, &repo)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 核对快照后创建并切换新分支，重置工作区并应用目标补丁。
pub async fn git_fork_worktree_snapshot(
    project_path: String,
    target_patch: String,
    expected_current_patch: String,
    target_head: String,
    branch_name: String,
) -> Result<GitWorktreeSnapshot, String> {
    log::info!(
        "[git_fork_worktree_snapshot] project_path: {}, branch: {}, target_patch_bytes: {}, expected_patch_bytes: {}",
        project_path,
        branch_name,
        target_patch.len(),
        expected_current_patch.len()
    );

    validate_snapshot_branch_name(&branch_name)?;

    tokio::task::spawn_blocking(move || {
        let _worktree_lock = acquire_worktree_operation_lock()?;
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let current_head = repo_head_oid(&repo)?;
        if !target_head.trim().is_empty() && current_head != target_head {
            return Err("head_mismatch".to_string());
        }

        let current_patch = build_worktree_patch(&repo)?;
        if current_patch.truncated {
            return Err("worktree_snapshot_too_large".to_string());
        }
        if current_patch.text != expected_current_patch {
            return Err("worktree_changed_since_snapshot".to_string());
        }

        let current_changes = collect_git_changes_from_repo(&repo)?;
        let head = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(|e| format!("head_failed: {e}"))?;
        repo.branch(&branch_name, &head, false)
            .map_err(|e| format!("branch_create_failed: {e}"))?;
        repo.set_head(&format!("refs/heads/{branch_name}"))
            .map_err(|e| format!("set_head_failed: {e}"))?;
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .map_err(|e| format!("checkout_failed: {e}"))?;
        repo.reset(head.as_object(), ResetType::Hard, None)
            .map_err(|e| format!("reset_failed: {e}"))?;

        if let Some(workdir) = repo.workdir() {
            for change in current_changes
                .iter()
                .filter(|item| item.status == "U" || item.status == "??")
            {
                remove_untracked_snapshot_file(workdir, &change.path)?;
            }
        }

        if !target_patch.trim().is_empty() {
            apply_patch_to_repo(&repo, &target_patch)?;
        }

        build_worktree_snapshot(&project_path, &repo)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

// 识别 U 和 ?? 两种未跟踪状态标记。
fn is_untracked_status(status: &str) -> bool {
    matches!(status, "U" | "??")
}

/// 回滚（丢弃）单个**已跟踪**文件的未提交改动，恢复到 HEAD。
///
/// 破坏性、不可逆操作（未提交改动无法通过 git 找回），调用方须二次确认。
/// 全程使用 libgit2，不触碰 std::fs、不调命令行 git。
///
/// 策略：
/// * `M`/`D`/`R`：`reset_default` 取消暂存 → `checkout_head(force, path)` 还原工作区。
/// * `A`（已暂存新增）：仅 `reset_default` 取消暂存（变为未跟踪），**不删物理文件**。
/// * `U`/`??`（未跟踪）：拒绝（产品决策：不回滚未跟踪文件，避免误删新代码）。
#[tauri::command]
// 校验相对路径后丢弃已跟踪文件改动，暂存新增仅取消暂存且拒绝未跟踪状态。
pub async fn git_discard_file(
    project_path: String,
    file_path: String,
    status: String,
) -> Result<(), String> {
    log::info!(
        "[git_discard_file] project_path: {}, file_path: {}, status: {}",
        project_path,
        file_path,
        status
    );

    // Layer A：路径字符串校验（前端不可信）。git2 pathspec 本身限定 repo 内，
    // 但仍做基础越界防御，符合用户文件安全清单。
    validate_repo_relative_path(&file_path)?;

    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }

        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;

        match status.as_str() {
            "U" | "??" => Err("untracked_not_supported".to_string()),
            "A" => {
                // 已暂存新增：仅取消暂存，保留工作区文件（变为未跟踪）。
                let head_commit = repo
                    .head()
                    .and_then(|h| h.peel_to_commit())
                    .map_err(|e| format!("head_failed: {e}"))?;
                repo.reset_default(Some(head_commit.as_object()), [file_path.as_str()])
                    .map_err(|e| format!("unstage_failed: {e}"))?;
                log::info!("[git_discard_file] 已取消暂存新增文件: {}", file_path);
                Ok(())
            }
            _ => {
                // M / D / R：先取消暂存（若有），再强制 checkout HEAD 还原工作区。
                if let Ok(commit) = repo.head().and_then(|h| h.peel_to_commit()) {
                    // reset_default 失败不致命（文件可能本就未暂存），仅记录。
                    if let Err(e) =
                        repo.reset_default(Some(commit.as_object()), [file_path.as_str()])
                    {
                        log::warn!("[git_discard_file] reset_default 跳过: {e}");
                    }
                }

                let mut cb = git2::build::CheckoutBuilder::new();
                cb.force();
                cb.path(file_path.as_str());
                repo.checkout_head(Some(&mut cb))
                    .map_err(|e| format!("checkout_failed: {e}"))?;
                log::info!("[git_discard_file] 已还原文件到 HEAD: {}", file_path);
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 删除未跟踪文件。只允许删除当前 Git 状态仍为未跟踪的 repo 内文件。
///
/// 破坏性、不可逆操作。调用方必须二次确认。
#[tauri::command]
// 核对当前未跟踪状态后逐项删除仓库内文件，已缺失目标直接跳过。
pub async fn git_delete_untracked_paths(
    project_path: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    for path in &paths {
        validate_repo_relative_path(path)?;
    }

    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }

        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let workdir = repo.workdir().ok_or("bare_repo_not_supported")?;
        let current_changes = collect_git_changes_from_repo(&repo)?;
        let current_untracked: HashSet<&str> = current_changes
            .iter()
            .filter(|change| is_untracked_status(&change.status))
            .map(|change| change.path.as_str())
            .collect();

        for target in &paths {
            if current_untracked.contains(target.as_str()) {
                remove_untracked_snapshot_file(workdir, target)?;
                continue;
            }

            if !workdir.join(target).exists() {
                continue;
            }

            return Err("path_not_untracked".to_string());
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 回滚 diff 中的单个 hunk（Hunk 级回滚入口）。
///
/// 破坏性操作。前端传入打开时的完整 diff 文本与 hunk 序号；后端构造反向 patch，
/// dry-run 校验后 apply 到工作区。
#[tauri::command]
// 生成指定 hunk 的反向补丁，在线程池校验并应用到工作区。
pub async fn git_revert_hunk(
    project_path: String,
    diff_text: String,
    hunk_index: usize,
) -> Result<(), String> {
    log::info!(
        "[git_revert_hunk] project_path: {}, hunk_index: {}",
        project_path,
        hunk_index
    );

    let reverse_patch = build_reverse_hunk_patch(&diff_text, hunk_index)?;

    tokio::task::spawn_blocking(move || apply_patch_to_workdir(&project_path, &reverse_patch))
        .await
        .map_err(|e| format!("task_failed: {e}"))?
}

/// 前端选中的变更行：side="old" 对应被删除行（按 old 行号），side="new" 对应新增行（按 new 行号）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedLine {
    pub side: String,
    pub line_number: u32,
}

/// 回滚 diff 中选中的若干行（行级回滚入口）。破坏性操作，dry-run 兜底。
#[tauri::command]
// 要求选择非空变更行，生成反向行补丁后在线程池应用。
pub async fn git_revert_lines(
    project_path: String,
    diff_text: String,
    selected_lines: Vec<SelectedLine>,
) -> Result<(), String> {
    log::info!(
        "[git_revert_lines] project_path: {}, lines: {}",
        project_path,
        selected_lines.len()
    );

    if selected_lines.is_empty() {
        return Err("no_lines_selected".to_string());
    }

    let sel: Vec<(String, u32)> = selected_lines
        .into_iter()
        .map(|s| (s.side, s.line_number))
        .collect();
    let reverse_patch = build_reverse_lines_patch(&diff_text, &sel)?;

    tokio::task::spawn_blocking(move || apply_patch_to_workdir(&project_path, &reverse_patch))
        .await
        .map_err(|e| format!("task_failed: {e}"))?
}

/// 暂存单个文件：worktree 存在 → add_path（新增/修改/未跟踪）；已删除 → remove_path。
#[tauri::command]
// 校验路径后将现存文件加入索引，缺失文件从索引移除并持久化。
pub async fn git_stage_file(project_path: String, file_path: String) -> Result<(), String> {
    validate_repo_relative_path(&file_path)?;
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        let rel = Path::new(&file_path);
        if path.join(&file_path).exists() {
            index
                .add_path(rel)
                .map_err(|e| format!("stage_failed: {e}"))?;
        } else {
            index
                .remove_path(rel)
                .map_err(|e| format!("stage_remove_failed: {e}"))?;
        }
        index
            .write()
            .map_err(|e| format!("index_write_failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 取消暂存单个文件：有 HEAD → reset 到 HEAD；unborn 分支 → 从 index 移除。
#[tauri::command]
// 校验路径后按 HEAD 取消暂存；无可用提交时直接移除索引条目。
pub async fn git_unstage_file(project_path: String, file_path: String) -> Result<(), String> {
    validate_repo_relative_path(&file_path)?;
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        match repo.head().and_then(|h| h.peel_to_commit()) {
            Ok(commit) => {
                repo.reset_default(Some(commit.as_object()), [file_path.as_str()])
                    .map_err(|e| format!("unstage_failed: {e}"))?;
            }
            Err(_) => {
                // 尚无提交：直接从 index 移除该路径。
                let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
                index
                    .remove_path(Path::new(&file_path))
                    .map_err(|e| format!("unstage_remove_failed: {e}"))?;
                index
                    .write()
                    .map_err(|e| format!("index_write_failed: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 全部暂存：add_all 收新增/修改/未跟踪，update_all 补已跟踪文件的删除。
#[tauri::command]
// 将新增、修改与删除批量同步到索引并一次写入。
pub async fn git_stage_all(project_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("stage_all_failed: {e}"))?;
        index
            .update_all(["*"], None)
            .map_err(|e| format!("stage_all_update_failed: {e}"))?;
        index
            .write()
            .map_err(|e| format!("index_write_failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 全部取消暂存：有 HEAD → index 重置为 HEAD tree；unborn → 清空 index。工作区不受影响。
#[tauri::command]
// 将索引还原为 HEAD 树；无可用 HEAD 时清空索引，保留工作区。
pub async fn git_unstage_all(project_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        match repo.head().and_then(|h| h.peel_to_tree()) {
            Ok(tree) => {
                index
                    .read_tree(&tree)
                    .map_err(|e| format!("unstage_all_failed: {e}"))?;
            }
            Err(_) => {
                index
                    .clear()
                    .map_err(|e| format!("index_clear_failed: {e}"))?;
            }
        }
        index
            .write()
            .map_err(|e| format!("index_write_failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 批量暂存多个文件（目录批量勾选用）：单次 index 写入，避免逐文件往返刷新。
#[tauri::command]
// 校验全部路径后批量加入或移除索引条目，并一次写入。
pub async fn git_stage_paths(project_path: String, paths: Vec<String>) -> Result<(), String> {
    for p in &paths {
        validate_repo_relative_path(p)?;
    }
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        for p in &paths {
            let rel = Path::new(p);
            if path.join(p).exists() {
                index
                    .add_path(rel)
                    .map_err(|e| format!("stage_failed: {e}"))?;
            } else {
                index
                    .remove_path(rel)
                    .map_err(|e| format!("stage_remove_failed: {e}"))?;
            }
        }
        index
            .write()
            .map_err(|e| format!("index_write_failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 批量取消暂存多个文件：有 HEAD → 一次 reset_default；unborn → 逐个从 index 移除。
#[tauri::command]
// 校验全部路径后批量取消暂存，无可用 HEAD 时移除对应索引条目。
pub async fn git_unstage_paths(project_path: String, paths: Vec<String>) -> Result<(), String> {
    for p in &paths {
        validate_repo_relative_path(p)?;
    }
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        match repo.head().and_then(|h| h.peel_to_commit()) {
            Ok(commit) => {
                repo.reset_default(Some(commit.as_object()), paths.iter().map(|s| s.as_str()))
                    .map_err(|e| format!("unstage_failed: {e}"))?;
            }
            Err(_) => {
                let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
                for p in &paths {
                    index
                        .remove_path(Path::new(p))
                        .map_err(|e| format!("unstage_remove_failed: {e}"))?;
                }
                index
                    .write()
                    .map_err(|e| format!("index_write_failed: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 提交已暂存内容。空信息 / 无暂存 / 无 git 身份返回稳定错误。成功返回短 commit id。
#[tauri::command]
// 验证说明与暂存内容，使用仓库身份创建提交并返回七位提交 ID。
pub async fn git_commit(project_path: String, message: String) -> Result<String, String> {
    let msg = message.trim().to_string();
    if msg.is_empty() {
        return Err("empty_message".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;

        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        let tree_oid = index
            .write_tree()
            .map_err(|e| format!("write_tree_failed: {e}"))?;

        // HEAD 当前 commit（unborn 时为 None）。
        let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

        // 无暂存内容检测：暂存树与 HEAD 树一致（或 unborn 下 index 为空）→ 拒绝空提交。
        match &head_commit {
            Some(c) => {
                let head_tree_oid = c.tree().map_err(|e| format!("head_tree_failed: {e}"))?.id();
                if head_tree_oid == tree_oid {
                    return Err("nothing_staged".to_string());
                }
            }
            None => {
                if index.is_empty() {
                    return Err("nothing_staged".to_string());
                }
            }
        }

        let tree = repo
            .find_tree(tree_oid)
            .map_err(|e| format!("find_tree_failed: {e}"))?;
        // 读取 user.name / user.email；缺失给出明确错误供前端引导配置。
        let sig = repo
            .signature()
            .map_err(|_| "no_git_identity".to_string())?;
        let parents: Vec<&git2::Commit> = head_commit.as_ref().map(|c| vec![c]).unwrap_or_default();

        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, &msg, &tree, &parents)
            .map_err(|e| format!("commit_failed: {e}"))?;

        Ok(oid.to_string().chars().take(7).collect::<String>())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 仅提交指定路径（pathspec / `git commit --only -- <paths>`）。
///
/// 用于「选中部分文件提交」：未列入的已暂存文件（如取消勾选但保持跟踪的新增文件）
/// 不会被提交，且保持其暂存状态不变。shell out 系统 git 以获得 --only 语义。
#[tauri::command]
// 通过 Git 提交指定路径并返回短提交 ID，将身份和空提交错误归一化。
pub async fn git_commit_paths(
    project_path: String,
    message: String,
    paths: Vec<String>,
) -> Result<String, String> {
    let msg = message.trim().to_string();
    if msg.is_empty() {
        return Err("empty_message".to_string());
    }
    if paths.is_empty() {
        return Err("nothing_staged".to_string());
    }
    for p in &paths {
        validate_repo_relative_path(p)?;
    }
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["commit", "-m", &msg, "--"];
        for p in &paths {
            args.push(p.as_str());
        }
        match run_git_cli(&project_path, &args) {
            Ok(_) => run_git_cli(&project_path, &["rev-parse", "--short", "HEAD"]),
            Err(e) => {
                let low = e.to_lowercase();
                if low.contains("who you are")
                    || low.contains("identity")
                    || low.contains("user.email")
                {
                    Err("no_git_identity".to_string())
                } else if low.contains("nothing to commit") || low.contains("no changes added") {
                    Err("nothing_staged".to_string())
                } else {
                    Err(e)
                }
            }
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 当前分支与远端跟踪状态（只读，git2）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchStatus {
    /// 分支短名（如 "main"）；detached HEAD 或 unborn 时为 None。
    pub branch: Option<String>,
    /// upstream 全名（如 "origin/main"）；无跟踪时为 None。
    pub upstream: Option<String>,
    /// 本地领先 upstream 的提交数（待推送）。
    pub ahead: usize,
    /// 本地落后 upstream 的提交数（待拉取）。
    pub behind: usize,
    /// 是否已配置 upstream 跟踪分支。
    pub has_upstream: bool,
    /// 是否处于 detached HEAD。
    pub detached: bool,
    /// 进行中的操作："merge" / "rebase"；无则 None。驱动前端冲突横幅与「中止/继续」入口。
    pub pending_op: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub branch_type: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub remote: Option<String>,
}

/// 查询当前分支名、upstream 及 ahead/behind。全只读，不触网。
///
/// 边界：非仓库 → 错误；unborn（无提交）→ branch=None 全 0；
/// detached HEAD → detached=true、branch=None；无 upstream → has_upstream=false、ahead/behind=0。
#[tauri::command]
// 只读查询当前分支、上游、领先落后数量及进行中的 Git 操作。
pub async fn git_branch_status(project_path: String) -> Result<GitBranchStatus, String> {
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;

        // 进行中的操作需要在 detached 早返回前计算。git2 对 cherry-pick/revert
        // 没有单独的 RepositoryState，按 git-dir 标记补齐这两种状态。
        let pending_op = pending_git_operation(&repo);

        let empty = GitBranchStatus {
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            has_upstream: false,
            detached: false,
            pending_op: pending_op.clone(),
        };

        // HEAD 不存在 → unborn 分支（尚无提交）。
        let head = match repo.head() {
            Ok(h) => h,
            Err(_) => return Ok(empty),
        };

        let detached = repo.head_detached().unwrap_or(false);
        let branch = head.shorthand().map(|s| s.to_string());
        let local_oid = head.target();

        if detached {
            return Ok(GitBranchStatus {
                branch: None,
                detached: true,
                ..empty
            });
        }

        // 查 upstream 与 ahead/behind。
        let mut upstream = None;
        let mut ahead = 0usize;
        let mut behind = 0usize;
        let mut has_upstream = false;

        if let Some(shorthand) = head.shorthand() {
            if let Ok(local_branch) = repo.find_branch(shorthand, git2::BranchType::Local) {
                if let Ok(up) = local_branch.upstream() {
                    has_upstream = true;
                    if let Ok(Some(name)) = up.name() {
                        upstream = Some(name.to_string());
                    }
                    if let (Some(local), Some(up_oid)) = (local_oid, up.get().target()) {
                        if let Ok((a, b)) = repo.graph_ahead_behind(local, up_oid) {
                            ahead = a;
                            behind = b;
                        }
                    }
                }
            }
        }

        Ok(GitBranchStatus {
            branch,
            upstream,
            ahead,
            behind,
            has_upstream,
            detached: false,
            pending_op,
        })
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 列出本地与远程分支及跟踪信息，跳过远程 HEAD 并排序。
pub async fn git_list_branches(project_path: String) -> Result<Vec<GitBranchInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let current = repo_branch_name(&repo);
        let mut branches = Vec::new();

        let locals = repo
            .branches(Some(git2::BranchType::Local))
            .map_err(|e| format!("branch_list_failed: {e}"))?;
        for item in locals {
            let (branch, _) = item.map_err(|e| format!("branch_list_failed: {e}"))?;
            let Some(name) = branch
                .name()
                .map_err(|e| format!("branch_name_failed: {e}"))?
                .map(|value| value.to_string())
            else {
                continue;
            };
            let upstream = branch
                .upstream()
                .ok()
                .and_then(|up| up.name().ok().flatten().map(|value| value.to_string()));
            branches.push(GitBranchInfo {
                current: current.as_deref() == Some(name.as_str()),
                name,
                branch_type: "local".to_string(),
                upstream,
                remote: None,
            });
        }

        let remotes = repo
            .branches(Some(git2::BranchType::Remote))
            .map_err(|e| format!("branch_list_failed: {e}"))?;
        for item in remotes {
            let (branch, _) = item.map_err(|e| format!("branch_list_failed: {e}"))?;
            let Some(name) = branch
                .name()
                .map_err(|e| format!("branch_name_failed: {e}"))?
                .map(|value| value.to_string())
            else {
                continue;
            };
            if name.ends_with("/HEAD") {
                continue;
            }
            let remote = split_remote_branch(&name).map(|(remote, _)| remote.to_string());
            branches.push(GitBranchInfo {
                name,
                branch_type: "remote".to_string(),
                current: false,
                upstream: None,
                remote,
            });
        }

        branches.sort_by(|a, b| {
            a.branch_type
                .cmp(&b.branch_type)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(branches)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 在线程池获取远程引用并清理失效的远程跟踪分支。
pub async fn git_fetch(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git_cli(&project_path, &["fetch", "--prune"]))
        .await
        .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 通过 Git 验证分支名后切换本地或远程跟踪分支。
pub async fn git_checkout_branch(
    project_path: String,
    branch: String,
    remote: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_branch_name_with_git(&project_path, &branch)?;
        run_checkout_branch(&project_path, &branch, remote)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 先保存包含未跟踪文件的 stash，再切换分支并尝试应用最新 stash。
pub async fn git_smart_checkout_branch(
    project_path: String,
    branch: String,
    remote: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_branch_name_with_git(&project_path, &branch)?;

        let stash_message = format!("CLI-Manager smart checkout: {branch}");
        let stash_output = run_git_cli(
            &project_path,
            &["stash", "push", "-u", "-m", &stash_message],
        )
        .map_err(|e| format!("smart_checkout_stash_failed: {e}"))?;
        if is_no_stash_created(&stash_output) {
            return Err("smart_checkout_stash_empty".to_string());
        }

        if let Err(checkout_err) = run_checkout_branch(&project_path, &branch, remote) {
            let restore_result = run_git_cli(&project_path, &["stash", "apply", "stash@{0}"]);
            return match restore_result {
                Ok(_) => Err(format!("smart_checkout_checkout_failed: {checkout_err}")),
                Err(restore_err) => Err(format!(
                    "smart_checkout_restore_failed: {checkout_err}; restore: {restore_err}"
                )),
            };
        }

        run_git_cli(&project_path, &["stash", "apply", "stash@{0}"])
            .map(|out| format!("{stash_output}\n{out}").trim().to_string())
            .map_err(|e| format!("smart_checkout_apply_conflict: {e}"))
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 验证分支名后创建并切换到新分支。
pub async fn git_create_branch(project_path: String, branch: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_branch_name_with_git(&project_path, &branch)?;
        run_git_cli(&project_path, &["checkout", "-b", &branch])
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 比较两个 Git 引用；target_ref 为空时比较 base_ref 与当前工作区（含暂存区）。
/// 结果复用只读 Diff 的大小限制，避免把无限制的命令输出送入 WebView。
#[tauri::command]
// 校验引用后比较合并基点与目标，或比较基础引用与当前工作区。
pub async fn git_compare_refs(
    project_path: String,
    base_ref: String,
    target_ref: Option<String>,
) -> Result<GitFileDiffPayload, String> {
    validate_operation_ref(&base_ref)?;
    if let Some(target) = target_ref.as_deref() {
        validate_operation_ref(target)?;
    }
    tokio::task::spawn_blocking(move || {
        let base = base_ref.as_str();
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            base,
        ];
        let range = target_ref
            .as_deref()
            .map(|target| format!("{base}...{target}"));
        if let Some(range) = range.as_deref() {
            args.pop();
            args.push(range);
        }
        let output = git_command_output(&project_path, &args)?;
        if !output.status.success() {
            return Err(map_git_cli_error(&format!(
                "{}{}",
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(&output.stdout)
            )));
        }
        let content = String::from_utf8_lossy(&output.stdout).into_owned();
        super::git_diff::build_diff_payload(content, false)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 执行分支/提交相关的显式 Git 操作。高风险操作由前端确认后调用，后端仍负责校验引用。
#[tauri::command]
// 按操作白名单校验分支、提交和模式，再执行对应 Git 变更命令。
pub async fn git_execute_operation(
    project_path: String,
    operation: String,
    branch: Option<String>,
    target: Option<String>,
    mode: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let branch_value = branch.as_deref();
        let target_value = target.as_deref();
        let require_branch = || branch_value.ok_or_else(|| "branch_required".to_string());
        let require_target = || target_value.ok_or_else(|| "target_required".to_string());
        match operation.as_str() {
            "create-branch" => {
                let name = require_branch()?;
                validate_branch_name_with_git(&project_path, name)?;
                if let Some(base) = target_value {
                    validate_operation_ref(base)?;
                    run_git_cli(&project_path, &["checkout", "-b", name, base])
                } else {
                    run_git_cli(&project_path, &["checkout", "-b", name])
                }
            }
            "rename-branch" => {
                let old = require_branch()?;
                let new = require_target()?;
                validate_branch_name_with_git(&project_path, old)?;
                validate_branch_name_with_git(&project_path, new)?;
                run_git_cli(&project_path, &["branch", "-m", old, new])
            }
            "delete-branch" => {
                let name = require_branch()?;
                validate_branch_name_with_git(&project_path, name)?;
                let flag = if mode.as_deref() == Some("force") {
                    "-D"
                } else {
                    "-d"
                };
                run_git_cli(&project_path, &["branch", flag, name])
            }
            "set-upstream" => {
                let name = require_branch()?;
                let upstream = require_target()?;
                validate_branch_name_with_git(&project_path, name)?;
                validate_operation_ref(upstream)?;
                run_git_cli(
                    &project_path,
                    &["branch", "--set-upstream-to", upstream, name],
                )
            }
            "merge" => {
                let name = require_branch()?;
                validate_operation_ref(name)?;
                run_git_conflict_aware_with_code(
                    &project_path,
                    &["merge", "--no-edit", name],
                    "merge_conflict",
                )
            }
            "rebase" => {
                let name = require_branch()?;
                validate_operation_ref(name)?;
                run_git_conflict_aware_with_code(
                    &project_path,
                    &["rebase", name],
                    "rebase_conflict",
                )
            }
            "cherry-pick" => {
                let commit = require_target()?;
                validate_commit_ref(&project_path, commit)?;
                run_git_conflict_aware_with_code(
                    &project_path,
                    &["cherry-pick", commit],
                    "cherry_pick_conflict",
                )
            }
            "revert" => {
                let commit = require_target()?;
                validate_commit_ref(&project_path, commit)?;
                run_git_conflict_aware_with_code(
                    &project_path,
                    &["revert", "--no-edit", commit],
                    "revert_conflict",
                )
            }
            "reset" => {
                let commit = require_target()?;
                validate_commit_ref(&project_path, commit)?;
                let reset_mode = match mode.as_deref() {
                    Some("soft") => "--soft",
                    Some("mixed") | None => "--mixed",
                    Some("hard") => "--hard",
                    _ => return Err("invalid_reset_mode".to_string()),
                };
                run_git_cli(&project_path, &["reset", reset_mode, commit])
            }
            "create-tag" => {
                let tag = require_branch()?;
                let commit = require_target()?;
                validate_operation_ref(tag)?;
                validate_commit_ref(&project_path, commit)?;
                run_git_cli(&project_path, &["tag", tag, commit])
            }
            "delete-tag" => {
                let tag = require_branch()?;
                validate_operation_ref(tag)?;
                run_git_cli(&project_path, &["tag", "-d", tag])
            }
            _ => Err("git_operation_invalid".to_string()),
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

// 优先检查 Git 状态标记文件，再用仓库状态识别进行中的操作。
fn pending_git_operation(repo: &Repository) -> Option<String> {
    let git_dir = repo.path();
    if git_dir.join("MERGE_HEAD").exists() {
        return Some("merge".to_string());
    }
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return Some("rebase".to_string());
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some("cherry-pick".to_string());
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some("revert".to_string());
    }
    match repo.state() {
        git2::RepositoryState::Merge => Some("merge".to_string()),
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => Some("rebase".to_string()),
        _ => None,
    }
}

// 仅接受 merge、rebase、cherry-pick 和 revert 操作名称。
fn validate_pending_operation(operation: &str) -> Result<(), String> {
    match operation {
        "merge" | "rebase" | "cherry-pick" | "revert" => Ok(()),
        _ => Err("git_operation_invalid".to_string()),
    }
}

// 为支持的继续或中止动作构造固定参数，继续时禁用交互式编辑器。
fn pending_operation_args(operation: &str, action: &str) -> Result<Vec<&'static str>, String> {
    validate_pending_operation(operation)?;
    let args = match (operation, action) {
        ("merge", "continue") => vec!["-c", "core.editor=true", "merge", "--continue"],
        ("rebase", "continue") => vec!["-c", "core.editor=true", "rebase", "--continue"],
        ("cherry-pick", "continue") => vec!["-c", "core.editor=true", "cherry-pick", "--continue"],
        ("revert", "continue") => vec!["-c", "core.editor=true", "revert", "--continue"],
        ("merge", "abort") => vec!["merge", "--abort"],
        ("rebase", "abort") => vec!["rebase", "--abort"],
        ("cherry-pick", "abort") => vec!["cherry-pick", "--abort"],
        ("revert", "abort") => vec!["revert", "--abort"],
        _ => return Err("git_operation_invalid".to_string()),
    };
    Ok(args)
}

/// 继续已解决的 Merge/Rebase/Cherry-pick/Revert 操作。
#[tauri::command]
// 构造继续操作参数并执行 Git，将冲突归一化为冲突错误。
pub async fn git_operation_continue(
    project_path: String,
    operation: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let args = pending_operation_args(&operation, "continue")?;
        run_git_conflict_aware(&project_path, &args)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 中止进行中的 Merge/Rebase/Cherry-pick/Revert 操作，恢复操作前状态。
#[tauri::command]
// 构造中止操作参数并在线程池调用 Git。
pub async fn git_operation_abort(
    project_path: String,
    operation: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let args = pending_operation_args(&operation, "abort")?;
        run_git_cli(&project_path, &args)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 推送当前分支。set_upstream=true 时 `push -u origin <branch>` 建立跟踪。
/// shell out 系统 git；失败错误码见 map_git_cli_error。
#[tauri::command]
// 推送当前分支，按请求向 origin 建立指定分支的上游跟踪。
pub async fn git_push(
    project_path: String,
    set_upstream: bool,
    branch: Option<String>,
) -> Result<String, String> {
    if set_upstream {
        let b = branch.clone().ok_or_else(|| "empty_branch".to_string())?;
        validate_branch_name(&b)?;
    }
    tokio::task::spawn_blocking(move || {
        if set_upstream {
            let b = branch.unwrap();
            run_git_cli(&project_path, &["push", "-u", "origin", &b])
        } else {
            run_git_cli(&project_path, &["push"])
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 把拉取策略映射为 git 参数。
/// - merge：`--no-rebase`，可快进时自动快进，分叉时生成合并提交（`--no-edit` 用默认信息免编辑器挂起）。
/// - rebase：`--rebase`，把本地提交变基到远端之上，保持线性历史。
/// - ff-only：仅快进，分叉则失败（保留旧行为）。
/// merge/rebase 均加 `--autostash`：拉取前自动暂存脏工作区、完成后恢复；冲突中止时一并恢复，绝不静默丢改动。
// 将拉取策略映射为固定参数，merge 与 rebase 启用 autostash。
fn pull_args(strategy: &str) -> Result<Vec<&'static str>, String> {
    match strategy {
        "merge" => Ok(vec!["pull", "--no-rebase", "--no-edit", "--autostash"]),
        "rebase" => Ok(vec!["pull", "--rebase", "--autostash"]),
        "ff-only" => Ok(vec!["pull", "--ff-only"]),
        _ => Err("invalid_strategy".to_string()),
    }
}

/// 执行 git 子命令并区分「冲突」与普通失败。合并/变基的冲突提示多写到 stdout，
/// 故合并 stdout+stderr 检测；命中 → 稳定错误码 `pull_conflict`（前端引导解决/继续/中止），
/// 否则回退通用错误映射。成功返回合并输出。
// 执行 Git 并检查合并输出中的冲突提示，命中时返回 pull_conflict。
fn run_git_conflict_aware(project_path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command_output(project_path, args)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        return Ok(format!("{stdout}{stderr}").trim().to_string());
    }
    let combined = format!("{stdout}\n{stderr}").to_lowercase();
    if combined.contains("conflict")
        || combined.contains("automatic merge failed")
        || combined.contains("could not apply")
        || combined.contains("needs merge")
        || combined.contains("fix conflicts")
    {
        let snippet: String = format!("{stdout}{stderr}")
            .trim()
            .chars()
            .take(300)
            .collect();
        return Err(format!("pull_conflict: {snippet}"));
    }
    Err(map_git_cli_error(&format!("{stderr}{stdout}")))
}

// 执行 Git 并将输出中的冲突提示映射为调用方指定的错误码。
fn run_git_conflict_aware_with_code(
    project_path: &str,
    args: &[&str],
    conflict_code: &str,
) -> Result<String, String> {
    let output = git_command_output(project_path, args)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        return Ok(format!("{stdout}{stderr}").trim().to_string());
    }
    let combined = format!("{stdout}\n{stderr}").to_lowercase();
    if combined.contains("conflict")
        || combined.contains("automatic merge failed")
        || combined.contains("could not apply")
        || combined.contains("needs merge")
        || combined.contains("fix conflicts")
    {
        let snippet: String = format!("{stdout}{stderr}")
            .trim()
            .chars()
            .take(300)
            .collect();
        return Err(format!("{conflict_code}: {snippet}"));
    }
    Err(map_git_cli_error(&format!("{stderr}{stdout}")))
}

/// 按策略拉取当前分支（merge / rebase / ff-only）。shell out 系统 git，继承凭据/代理/SSH。
/// 分叉时 merge/rebase 可直接拉取，无需切终端；冲突返回 `pull_conflict`，可经 git_pull_abort 安全回退。
#[tauri::command]
// 按校验后的策略拉取分支，并区分冲突与普通 Git 错误。
pub async fn git_pull(project_path: String, strategy: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let args = pull_args(&strategy)?;
        run_git_conflict_aware(&project_path, &args)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 中止进行中的合并/变基，回到拉取前状态（`--autostash` 暂存的改动会一并恢复）。
/// 依据 git2 仓库状态自动选择 `rebase --abort` 或 `merge --abort`。
#[tauri::command]
// 识别仓库进行中的操作，构造对应中止命令并执行。
pub async fn git_pull_abort(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let pending_op = {
            let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
            pending_git_operation(&repo)
        };
        let operation = pending_op.ok_or_else(|| "git_operation_not_in_progress".to_string())?;
        let args = pending_operation_args(&operation, "abort")?;
        run_git_cli(&project_path, &args)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 变基冲突解决并暂存后继续变基。`-c core.editor=true` 跳过提交信息编辑器避免挂起；
/// 仍有未解决冲突 → `pull_conflict`，前端维持冲突态。
#[tauri::command]
// 禁用交互式编辑器继续变基，将未解决冲突返回给调用方。
pub async fn git_rebase_continue(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_git_conflict_aware(
            &project_path,
            &["-c", "core.editor=true", "rebase", "--continue"],
        )
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 开始监听项目目录文件变化（fs-watcher）。失败返回错误，前端据此降级为慢轮询。
#[tauri::command]
// 启动项目文件监听，将失败交给调用方决定是否降级轮询。
pub async fn git_watch_start(
    app_handle: AppHandle,
    bridge: State<'_, GitWatcherBridge>,
    project_path: String,
) -> Result<(), String> {
    bridge.start(app_handle, project_path)
}

/// 停止文件监听并释放 watcher。
#[tauri::command]
// 停止 Git 文件监听并释放监听资源。
pub async fn git_watch_stop(bridge: State<'_, GitWatcherBridge>) -> Result<(), String> {
    bridge.stop()
}

#[cfg(test)]
mod tests;
