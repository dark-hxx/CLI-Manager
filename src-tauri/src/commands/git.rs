use git2::{build::CheckoutBuilder, DiffOptions, Repository, ResetType, StatusOptions};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashSet;
use std::path::Path;
use tauri::{AppHandle, State};

use crate::git_watcher::GitWatcherBridge;
use crate::shell_resolver::silent_command;
use crate::text_encoding::{decode_text, decode_text_fragment, is_utf8_encoding, DecodedText};

const GIT_DIFF_LINE_STATS_STATUS_LIMIT: usize = 500;
const GIT_DIFF_LINE_STATS_LINE_LIMIT: usize = 200_000;
const OOM_PATCH_WARN_BYTES: usize = 1024 * 1024;
const OOM_SNAPSHOT_PATCH_RETURN_MAX_BYTES: usize = 1024 * 1024;
const OOM_SNAPSHOT_FILES_WARN_COUNT: usize = 500;

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
        log::info!(
            "[oom-diagnostics:backend] area=git phase={phase} project_path={} dirty={} files={} patch_bytes={} elapsed_ms={} threshold_exceeded=false",
            project_path,
            snapshot.dirty,
            snapshot.files.len(),
            patch_bytes,
            elapsed_ms
        );
    }
}

/// 打开 Git 仓库的统一入口，兼容 WSL UNC 路径。
///
/// libgit2 在 Windows 上会校验仓库路径所有权，WSL UNC 路径（`\\wsl.localhost\...`）
/// 通过 Plan 9 协议暴露，所有权信息无法正确传递，导致 `Repository::open` 失败。
/// 本函数检测到 WSL UNC 路径时，临时关闭所有权验证后重试。
fn open_git_repo<P: AsRef<Path>>(path: P) -> Result<Repository, String> {
    let path = path.as_ref();
    match Repository::open(path) {
        Ok(repo) => return Ok(repo),
        Err(first_err) => {
            let path_str = path.to_string_lossy();
            if !crate::wsl::is_wsl_config_dir(&path_str) {
                return Err(format!("打开 Git 仓库失败: {first_err}"));
            }
            log::info!(
                "[git:wsl] 检测到 WSL UNC 路径, 首次打开失败(Owner -36 预期): path={} error={first_err}",
                path_str
            );
            log::info!("[git:wsl] 临时关闭 libgit2 所有权验证后重试");
        }
    }

    // WSL UNC 路径：关闭所有权验证后重试。
    // SAFETY: WSL 路径是本机文件系统，所有权检查因 Plan 9 协议限制误报，
    // 关闭检查不引入安全风险。
    let result = unsafe {
        git2::opts::set_verify_owner_validation(false)
            .map_err(|e| format!("设置 git2 选项失败: {e}"))
            .and_then(|_| Repository::open(path).map_err(|e| format!("打开 WSL Git 仓库失败: {e}")))
    };
    // 立即恢复所有权验证
    let _ = unsafe { git2::opts::set_verify_owner_validation(true) };

    match &result {
        Ok(_) => log::info!(
            "[git:wsl] 关闭所有权验证后 Git 仓库打开成功: path={}",
            path.to_string_lossy()
        ),
        Err(e) => log::warn!(
            "[git:wsl] 关闭所有权验证后仍失败: path={} error={e}",
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffPayload {
    pub content: String,
    pub can_revert_hunks: bool,
}

/// 获取指定路径的 Git 文件变更列表
///
/// 使用 libgit2 库查询工作区和暂存区的文件状态。
///
/// # Returns
/// * `Ok(Vec<GitFileChange>)` - 变更文件列表
/// * `Err(String)` - 错误信息
#[tauri::command]
pub async fn git_get_changes(project_path: String) -> Result<Vec<GitFileChange>, String> {
    log::info!(
        "[git_get_changes] 开始查询 Git 变更, project_path: {}",
        project_path
    );

    tokio::task::spawn_blocking(move || {
        let started_at = std::time::Instant::now();
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&project_path) {
            if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
                log::info!(
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

fn git_get_changes_native(
    project_path: &str,
    started_at: std::time::Instant,
) -> Result<Vec<GitFileChange>, String> {
    let path = Path::new(project_path);

    if !path.exists() {
        let err_msg = format!("路径不存在: {}", project_path);
        log::error!("[git_get_changes] {}", err_msg);
        return Err(err_msg);
    }

    log::info!("[git_get_changes] 路径存在，尝试打开 Git 仓库");

    let repo = open_git_repo(path).map_err(|e| {
        let err_msg = format!("不是 Git 仓库或无法访问: {}", e);
        log::error!("[git_get_changes] {}", err_msg);
        err_msg
    })?;

    log::info!("[git_get_changes] Git 仓库打开成功");

    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);

    let status_started_at = std::time::Instant::now();
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| {
        let err_msg = format!("获取 Git 状态失败: {}", e);
        log::error!("[git_get_changes] {}", err_msg);
        err_msg
    })?;

    log::info!(
        "[git_get_changes] 获取到 {} 个状态条目 status_elapsed_ms={}",
        statuses.len(),
        status_started_at.elapsed().as_millis()
    );

    let skipped_line_stats = should_skip_diff_line_stats(statuses.len());
    let stats = if skipped_line_stats {
        log::warn!(
            "[git_get_changes] 状态条目过多({}), 跳过行数统计以避免面板长时间 loading",
            statuses.len()
        );
        std::collections::HashMap::new()
    } else {
        compute_diff_line_stats(&repo)
    };

    let mut changes = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let file_path = entry.path().unwrap_or("").to_string();

        if file_path.is_empty() {
            continue;
        }

        if is_nested_repo_entry(&repo, &file_path) {
            continue;
        }

        let (status_char, staged) = parse_git2_status(status);
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

    log::info!(
        "[git_get_changes] 查询完成，返回 {} 个变更文件 line_stats={} elapsed_ms={}",
        changes.len(),
        if skipped_line_stats {
            "skipped"
        } else {
            "computed"
        },
        started_at.elapsed().as_millis()
    );

    Ok(changes)
}

fn git_get_changes_wsl(
    project_path: &str,
    distro: &str,
    linux_path: &str,
    started_at: std::time::Instant,
) -> Result<Vec<GitFileChange>, String> {
    log::info!(
        "[git_get_changes:wsl] 检测到 WSL UNC 路径, 使用 wsl.exe git 热路径: project_path={} distro={} linux_path={}",
        project_path,
        distro,
        linux_path
    );

    let status_started_at = std::time::Instant::now();
    let status_stdout = run_wsl_git(
        distro,
        linux_path,
        &["status", "--porcelain=v1", "-z", "-unormal"],
    )
    .map_err(|e| {
        let err_msg = format!("获取 WSL Git 状态失败: {e}");
        log::error!("[git_get_changes:wsl] {}", err_msg);
        err_msg
    })?;
    let mut changes = parse_wsl_git_status(&status_stdout);

    // 过滤嵌套子仓库目录条目（与 libgit2 链路 is_nested_repo_entry 语义一致）：
    // 尾部 '/' 且 <UNC根>/<路径>/.git 存在（目录或 gitlink 文件均命中）→ 跳过。
    // fs 检查经 UNC 路径进行，保持 parse_wsl_git_status 为纯函数（见 issue #85）。
    let unc_root = Path::new(project_path);
    changes.retain(|change| {
        !change.path.ends_with('/') || !unc_root.join(&change.path).join(".git").exists()
    });

    log::info!(
        "[git_get_changes:wsl] 获取到 {} 个状态条目 status_elapsed_ms={}",
        changes.len(),
        status_started_at.elapsed().as_millis()
    );

    let skipped_line_stats = should_skip_diff_line_stats(changes.len());
    let stats = if skipped_line_stats {
        log::warn!(
            "[git_get_changes:wsl] 状态条目过多({}), 跳过行数统计以避免面板长时间 loading",
            changes.len()
        );
        std::collections::HashMap::new()
    } else {
        match compute_wsl_diff_line_stats(distro, linux_path) {
            Ok(stats) => stats,
            Err(e) => {
                log::warn!("[git_get_changes:wsl] diff 行数统计降级为 0: {e}");
                std::collections::HashMap::new()
            }
        }
    };

    for change in &mut changes {
        if let Some((added, deleted)) = stats.get(&normalize_path(&change.path)).copied() {
            change.added = added;
            change.deleted = deleted;
        }
    }

    log::info!(
        "[git_get_changes:wsl] 查询完成，返回 {} 个变更文件 line_stats={} elapsed_ms={}",
        changes.len(),
        if skipped_line_stats {
            "skipped"
        } else {
            "computed"
        },
        started_at.elapsed().as_millis()
    );
    Ok(changes)
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

fn run_wsl_git(distro: &str, linux_path: &str, git_args: &[&str]) -> Result<Vec<u8>, String> {
    let program = crate::wsl::find_wsl_exe()
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string());

    let mut cmd = silent_command(&program);
    let args = build_wsl_git_command_args(distro, linux_path, git_args);
    cmd.args(&args);

    let output = cmd.output().map_err(|e| format!("spawn_failed: {e}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let snippet = format!("{stderr}{stdout}")
        .trim()
        .chars()
        .take(300)
        .collect::<String>();
    Err(format!(
        "wsl_git_failed(exit={}): {}",
        output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".to_string()),
        snippet
    ))
}

fn resolve_wsl_mnt_git_project_path(distro: &str, linux_path: &str) -> Option<String> {
    let resolved_linux_path =
        resolve_wsl_linux_realpath(distro, linux_path).unwrap_or_else(|| linux_path.to_string());
    let windows_path = crate::wsl::wsl_mnt_path_to_windows(&resolved_linux_path)?;
    if Path::new(&windows_path).exists() {
        Some(windows_path)
    } else {
        log::warn!(
            "[git:wsl] WSL 路径已解析为 /mnt 挂载但 Windows 路径不存在: linux_path={} resolved={} windows_path={}",
            linux_path,
            resolved_linux_path,
            windows_path
        );
        None
    }
}

fn effective_git_project_path(project_path: &str) -> String {
    crate::wsl::parse_wsl_unc_path(project_path)
        .and_then(|(distro, linux_path)| resolve_wsl_mnt_git_project_path(&distro, &linux_path))
        .unwrap_or_else(|| project_path.to_string())
}

fn resolve_wsl_linux_realpath(distro: &str, linux_path: &str) -> Option<String> {
    let program = crate::wsl::find_wsl_exe()
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string());
    let output = silent_command(&program)
        .args(["-d", distro, "--exec", "readlink", "-f", linux_path])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if resolved.is_empty() {
        None
    } else {
        Some(resolved)
    }
}

fn build_wsl_git_command_args(distro: &str, linux_path: &str, git_args: &[&str]) -> Vec<String> {
    let mut args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "git".to_string(),
        "-c".to_string(),
        format!("safe.directory={linux_path}"),
        "-C".to_string(),
        linux_path.to_string(),
    ];
    args.extend(git_args.iter().map(|arg| (*arg).to_string()));
    args
}

fn parse_wsl_git_status(stdout: &[u8]) -> Vec<GitFileChange> {
    let records: Vec<&[u8]> = stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect();
    let mut changes = Vec::new();
    let mut index = 0usize;

    while index < records.len() {
        let record = records[index];
        index += 1;

        if record.len() < 4 {
            continue;
        }

        let x = record[0];
        let y = record[1];
        let path_bytes = if record[2] == b' ' {
            &record[3..]
        } else {
            &record[2..]
        };
        let path = normalize_path(&String::from_utf8_lossy(path_bytes));
        if path.is_empty() {
            continue;
        }

        let (status, staged) = parse_porcelain_status(x, y);
        changes.push(GitFileChange {
            path,
            status: status.to_string(),
            staged,
            added: 0,
            deleted: 0,
        });

        // `git status -z` emits an extra old path record after renamed/copied entries.
        if x == b'R' || x == b'C' {
            index = index.saturating_add(1);
        }
    }

    changes
}

fn parse_porcelain_status(x: u8, y: u8) -> (&'static str, bool) {
    if is_porcelain_conflict(x, y) {
        return ("C", false);
    }
    if x == b'?' && y == b'?' {
        return ("U", false);
    }
    if x != b' ' {
        return (map_porcelain_status_byte(x), true);
    }
    if y != b' ' {
        return (map_porcelain_status_byte(y), false);
    }
    ("M", false)
}

fn is_porcelain_conflict(x: u8, y: u8) -> bool {
    x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D')
}

fn map_porcelain_status_byte(status: u8) -> &'static str {
    match status {
        b'A' => "A",
        b'D' => "D",
        b'R' => "R",
        _ => "M",
    }
}

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
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
}

fn repo_head_oid(repo: &Repository) -> Result<String, String> {
    let head = repo.head().map_err(|e| format!("head_failed: {e}"))?;
    let oid = head.target().ok_or("head_target_missing")?;
    Ok(oid.to_string())
}

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
fn is_nested_repo_entry(repo: &Repository, file_path: &str) -> bool {
    if !file_path.ends_with('/') {
        return false;
    }
    repo.workdir()
        .map(|workdir| workdir.join(file_path).join(".git").exists())
        .unwrap_or(false)
}

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

fn build_worktree_patch(repo: &Repository) -> Result<String, String> {
    let head_tree = repo
        .head()
        .and_then(|head| head.peel_to_tree())
        .map_err(|e| format!("head_tree_failed: {e}"))?;

    let mut diff_opts = DiffOptions::new();
    diff_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .show_binary(true)
        .context_lines(3);

    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut diff_opts))
        .map_err(|e| format!("snapshot_diff_failed: {e}"))?;
    format_diff_to_text_allow_empty(&diff)
}

fn build_worktree_snapshot(
    project_path: &str,
    repo: &Repository,
) -> Result<GitWorktreeSnapshot, String> {
    let patch = build_worktree_patch(repo)?;
    let patch_bytes = patch.len();
    let files = collect_git_changes_from_repo(repo)?;
    Ok(GitWorktreeSnapshot {
        project_path: project_path.to_string(),
        head: repo_head_oid(repo)?,
        branch: repo_branch_name(repo),
        dirty: !patch.trim().is_empty() || !files.is_empty(),
        patch,
        patch_bytes,
        patch_truncated: false,
        files,
    })
}

fn truncate_snapshot_patch_for_webview(snapshot: &mut GitWorktreeSnapshot) {
    if snapshot.patch.len() <= OOM_SNAPSHOT_PATCH_RETURN_MAX_BYTES {
        return;
    }
    snapshot.patch.clear();
    snapshot.patch_truncated = true;
}

fn should_skip_diff_line_stats(status_count: usize) -> bool {
    status_count > GIT_DIFF_LINE_STATS_STATUS_LIMIT
}

/// 一次性计算仓库内所有变更文件的真实增删行数（相对 HEAD，合并暂存区+工作区+未跟踪）。
///
/// 单次 `diff_tree_to_workdir_with_index` + `foreach` 累加，避免逐文件多次 diff 的 N 次扫描。
/// 二进制文件不进入 line callback，自然为 (0, 0)。失败时降级为空表（统计显示 0，不影响列表）。
///
/// # Returns
/// 路径（正斜杠归一化）→ (新增行数, 删除行数)
fn compute_diff_line_stats(repo: &Repository) -> std::collections::HashMap<String, (i32, i32)> {
    use std::collections::HashMap;

    let started_at = std::time::Instant::now();
    let mut map: HashMap<String, (i32, i32)> = HashMap::new();
    let mut seen_lines = 0usize;
    let mut truncated = false;

    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.context_lines(0); // 统计只关心 +/- 行，无需上下文

    // HEAD tree 可能不存在（空仓库 / unborn 分支）：此时与 None tree 比较，全部视为新增。
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let diff = match repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts)) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[git_get_changes] 构造 diff 失败，行数统计降级为 0: {e}");
            return map;
        }
    };

    let mut file_cb = |_delta: git2::DiffDelta, _progress: f32| true;
    let mut line_cb =
        |delta: git2::DiffDelta, _hunk: Option<git2::DiffHunk>, line: git2::DiffLine| {
            seen_lines = seen_lines.saturating_add(1);
            if seen_lines > GIT_DIFF_LINE_STATS_LINE_LIMIT {
                truncated = true;
                return false;
            }
            // 删除文件 new_file 可能无路径，回退到 old_file。
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| normalize_path(&p.to_string_lossy()));
            if let Some(path) = path {
                let entry = map.entry(path).or_insert((0, 0));
                // 仅统计真实增删行；上下文 ' '、EOFNL 标记 '>'/'<'/'='、头部 'F'/'H' 忽略。
                match line.origin() {
                    '+' => entry.0 += 1,
                    '-' => entry.1 += 1,
                    _ => {}
                }
            }
            true
        };

    if let Err(e) = diff.foreach(&mut file_cb, None, None, Some(&mut line_cb)) {
        log::warn!("[git_get_changes] 遍历 diff 失败，部分行数可能缺失: {e}");
    }
    if truncated {
        log::warn!(
            "[git_get_changes] diff 行数超过上限({GIT_DIFF_LINE_STATS_LINE_LIMIT}), 行数统计降级为 0"
        );
        map.clear();
    }
    log::info!(
        "[git_get_changes] diff 行数统计完成 files={} lines_seen={} truncated={} elapsed_ms={}",
        map.len(),
        seen_lines,
        truncated,
        started_at.elapsed().as_millis()
    );

    map
}

fn compute_wsl_diff_line_stats(
    distro: &str,
    linux_path: &str,
) -> Result<std::collections::HashMap<String, (i32, i32)>, String> {
    let started_at = std::time::Instant::now();
    let stdout = run_wsl_git(
        distro,
        linux_path,
        &["diff", "--numstat", "-z", "HEAD", "--"],
    )?;
    let stats = parse_wsl_numstat(&stdout);
    log::info!(
        "[git_get_changes:wsl] diff numstat 完成 files={} elapsed_ms={}",
        stats.len(),
        started_at.elapsed().as_millis()
    );
    Ok(stats)
}

fn parse_wsl_numstat(stdout: &[u8]) -> std::collections::HashMap<String, (i32, i32)> {
    use std::collections::HashMap;

    let mut map = HashMap::new();
    for record in stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let text = String::from_utf8_lossy(record);
        let mut parts = text.splitn(3, '\t');
        let Some(added) = parts.next().and_then(parse_numstat_count) else {
            continue;
        };
        let Some(deleted) = parts.next().and_then(parse_numstat_count) else {
            continue;
        };
        let Some(path) = parts.next() else {
            continue;
        };
        let path = normalize_path(path);
        if !path.is_empty() {
            map.insert(path, (added, deleted));
        }
    }
    map
}

fn parse_numstat_count(value: &str) -> Option<i32> {
    if value == "-" {
        return Some(0);
    }
    value.parse::<i32>().ok()
}

/// 获取指定文件的 Git diff 内容
///
/// # Returns
/// * `Ok(String)` - unified diff 格式的文本
/// * `Err(String)` - 错误信息
#[tauri::command]
pub async fn git_get_file_diff(
    project_path: String,
    file_path: String,
    status: String,
) -> Result<GitFileDiffPayload, String> {
    log::info!(
        "[git_get_file_diff] project_path: {}, file_path: {}, status: {}",
        project_path,
        file_path,
        status
    );

    tokio::task::spawn_blocking(move || {
        validate_repo_relative_path(&file_path)?;
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);

        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err(format!("路径不存在: {}", project_path));
        }

        let repo = open_git_repo(path).map_err(|e| format!("打开仓库失败: {}", e))?;

        // 针对不同状态使用不同策略
        match status.as_str() {
            "U" | "??" => {
                // 未跟踪文件：直接读取内容作为全新增
                let file_full_path = path.join(&file_path);
                // 兜底守卫：目录条目（如嵌套 Git 仓库）无法按文件读取，返回友好提示而非原始 OS 错误
                if file_full_path.is_dir() {
                    return Err(
                        "该条目是目录（可能为嵌套 Git 仓库），无法显示文件 diff".to_string()
                    );
                }
                let bytes =
                    std::fs::read(&file_full_path).map_err(|e| format!("读取文件失败: {}", e))?;
                let content = decode_text(&bytes)?.content;

                let lines = content.lines().collect::<Vec<_>>();
                let mut diff_text = format!("diff --git a/{} b/{}\n", file_path, file_path);
                diff_text.push_str("new file mode 100644\n");
                diff_text.push_str("--- /dev/null\n");
                diff_text.push_str(&format!("+++ b/{}\n", file_path));
                diff_text.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));

                for line in lines {
                    diff_text.push('+');
                    diff_text.push_str(line);
                    diff_text.push('\n');
                }

                Ok(GitFileDiffPayload {
                    content: diff_text,
                    can_revert_hunks: false,
                })
            }
            "A" => {
                // 新增文件（已暂存）：对比 index vs worktree
                let encoding = detect_file_diff_encoding(&repo, path, &file_path)?;
                let mut diff_opts = git2::DiffOptions::new();
                diff_opts.pathspec(&file_path);
                diff_opts.context_lines(3);
                diff_opts.force_text(encoding.is_some());

                let diff = repo
                    .diff_index_to_workdir(None, Some(&mut diff_opts))
                    .map_err(|e| format!("生成 diff 失败: {}", e))?;

                format_diff_for_display(diff, &file_path, encoding.as_ref())
            }
            "D" => {
                // 删除文件：对比 HEAD vs worktree（文件已不存在）
                let encoding = detect_file_diff_encoding(&repo, path, &file_path)?;
                let head = repo.head().map_err(|e| format!("获取 HEAD 失败: {}", e))?;
                let head_tree = head
                    .peel_to_tree()
                    .map_err(|e| format!("获取 HEAD tree 失败: {}", e))?;

                let mut diff_opts = git2::DiffOptions::new();
                diff_opts.pathspec(&file_path);
                diff_opts.context_lines(3);
                diff_opts.force_text(encoding.is_some());

                let diff = repo
                    .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut diff_opts))
                    .map_err(|e| format!("生成 diff 失败: {}", e))?;

                format_diff_for_display(diff, &file_path, encoding.as_ref())
            }
            _ => {
                // 修改文件（M）、重命名（R）：对比 HEAD vs worktree
                let encoding = detect_file_diff_encoding(&repo, path, &file_path)?;
                let head = repo.head().map_err(|e| format!("获取 HEAD 失败: {}", e))?;
                let head_tree = head
                    .peel_to_tree()
                    .map_err(|e| format!("获取 HEAD tree 失败: {}", e))?;

                let mut diff_opts = git2::DiffOptions::new();
                diff_opts.pathspec(&file_path);
                diff_opts.context_lines(3);
                diff_opts.force_text(encoding.is_some());

                let diff = repo
                    .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut diff_opts))
                    .map_err(|e| format!("生成 diff 失败: {}", e))?;

                format_diff_for_display(diff, &file_path, encoding.as_ref())
            }
        }
    })
    .await
    .map_err(|e| format!("任务失败: {}", e))?
}

#[tauri::command]
pub async fn git_get_worktree_snapshot(
    project_path: String,
) -> Result<GitWorktreeSnapshot, String> {
    log::info!("[git_get_worktree_snapshot] project_path: {}", project_path);

    tokio::task::spawn_blocking(move || {
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
        if current_patch != expected_current_patch {
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
        if current_patch != expected_current_patch {
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

fn detect_file_diff_encoding(
    repo: &Repository,
    workdir: &Path,
    file_path: &str,
) -> Result<Option<DecodedText>, String> {
    let worktree_path = workdir.join(file_path);
    let bytes = if worktree_path.is_file() {
        Some(std::fs::read(&worktree_path).map_err(|e| format!("读取文件失败: {e}"))?)
    } else {
        let head_tree = match repo.head().and_then(|head| head.peel_to_tree()) {
            Ok(tree) => tree,
            Err(_) => return Ok(None),
        };
        let entry = match head_tree.get_path(Path::new(file_path)) {
            Ok(entry) => entry,
            Err(_) => return Ok(None),
        };
        let blob = match repo.find_blob(entry.id()) {
            Ok(blob) => blob,
            Err(_) => return Ok(None),
        };
        Some(blob.content().to_vec())
    };

    match bytes.as_deref().map(decode_text) {
        Some(Ok(decoded)) => Ok(Some(decoded)),
        Some(Err("binary_file")) | None => Ok(None),
        Some(Err(error)) => Err(error.to_string()),
    }
}

fn format_diff_for_display(
    diff: git2::Diff,
    file_path: &str,
    encoding_hint: Option<&DecodedText>,
) -> Result<GitFileDiffPayload, String> {
    let detected_from_diff;
    let encoding = if let Some(hint) = encoding_hint {
        Some(hint)
    } else {
        let body = collect_diff_body_bytes(&diff)?;
        if body.is_empty() {
            None
        } else {
            detected_from_diff = decode_text(&body)?;
            Some(&detected_from_diff)
        }
    };

    let (content, can_revert_hunks) = match encoding {
        None => (format_diff_to_text_allow_empty(&diff)?, true),
        Some(detected) if is_utf8_encoding(&detected.encoding) => {
            (format_diff_to_text_allow_empty(&diff)?, true)
        }
        Some(detected) => (
            format_diff_to_display_text(&diff, &detected.encoding, detected.has_bom)?,
            false,
        ),
    };

    if content.is_empty() {
        return Err(format!("文件 {} 无变更", file_path));
    }

    log::info!("[git_get_file_diff] diff 生成成功，长度: {}", content.len());
    Ok(GitFileDiffPayload {
        content,
        can_revert_hunks,
    })
}

fn collect_diff_body_bytes(diff: &git2::Diff) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            body.extend_from_slice(line.content());
        }
        true
    })
    .map_err(|e| format!("打印 diff 失败: {e}"))?;
    Ok(body)
}

fn format_diff_to_display_text(
    diff: &git2::Diff,
    encoding: &str,
    has_bom: bool,
) -> Result<String, String> {
    let mut display_text = String::new();
    let mut decode_error = None;
    let mut pending_utf16le_newline_byte = false;

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if decode_error.is_some() {
            return true;
        }
        if matches!(line.origin(), '+' | '-' | ' ') {
            let Some(fragment) = normalize_diff_body_fragment(
                line.content(),
                encoding,
                &mut pending_utf16le_newline_byte,
            ) else {
                return true;
            };
            display_text.push(line.origin());
            match decode_text_fragment(fragment.as_ref(), encoding, has_bom) {
                Ok(content) => display_text.push_str(&content),
                Err(error) => {
                    decode_error = Some(error);
                }
            }
        } else {
            match std::str::from_utf8(line.content()) {
                Ok(content) => display_text.push_str(content),
                Err(_) => {
                    decode_error = Some("text_decode_failed");
                }
            }
        }
        true
    })
    .map_err(|e| format!("打印 diff 失败: {e}"))?;

    if let Some(error) = decode_error {
        return Err(error.to_string());
    }
    Ok(display_text)
}

fn normalize_diff_body_fragment<'a>(
    bytes: &'a [u8],
    encoding: &str,
    pending_utf16le_newline_byte: &mut bool,
) -> Option<Cow<'a, [u8]>> {
    if !encoding.eq_ignore_ascii_case("utf-16le") {
        return Some(Cow::Borrowed(bytes));
    }

    let mut input = bytes;
    if *pending_utf16le_newline_byte && input.first() == Some(&0) {
        input = &input[1..];
    }
    *pending_utf16le_newline_byte = false;
    if input.is_empty() {
        return None;
    }

    if input.last() == Some(&b'\n') {
        *pending_utf16le_newline_byte = true;
    }
    if input.len() % 2 == 1 && input.last() == Some(&b'\n') {
        let mut normalized = Vec::with_capacity(input.len() + 1);
        normalized.extend_from_slice(input);
        normalized.push(0);
        return Some(Cow::Owned(normalized));
    }
    Some(Cow::Borrowed(input))
}

fn format_diff_to_text_allow_empty(diff: &git2::Diff) -> Result<String, String> {
    let mut patch_text = String::new();

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        // git2 的 Patch 输出中，文件头（F）、hunk 头（H）等行内容已是完整文本，
        // 只有正文行（+/-/空格）需要补回起始字符，其余原样输出。
        match line.origin() {
            '+' | '-' | ' ' => patch_text.push(line.origin()),
            _ => {}
        }
        patch_text.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| format!("打印 diff 失败: {}", e))?;

    Ok(patch_text)
}

/// 校验前端传入的 repo 相对路径（前端不可信，防越界）。
///
/// 纯函数，便于单测。返回稳定错误字符串供前端分支。
fn validate_repo_relative_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("empty_path".into());
    }
    if p.contains("..") {
        return Err("path_escape".into());
    }
    // 绝对路径：前导分隔符或 Windows 盘符（如 C:）
    if p.starts_with('/') || p.starts_with('\\') {
        return Err("absolute_path".into());
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return Err("absolute_path".into());
    }
    Ok(())
}

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

/// 解析 unified diff 的 hunk 头 `@@ -a,b +c,d @@ heading`。
/// 返回 (old_start, old_count, new_start, new_count, heading)。count 省略时为 1。
fn parse_hunk_header(header: &str) -> Result<(u32, u32, u32, u32, String), String> {
    let body = header.strip_prefix("@@ ").ok_or("bad_hunk_header")?;
    let close = body.find(" @@").ok_or("bad_hunk_header")?;
    let ranges = &body[..close];
    let heading = body[close + 3..].to_string();
    let mut parts = ranges.split(' ');
    let old_part = parts.next().ok_or("bad_hunk_header")?;
    let new_part = parts.next().ok_or("bad_hunk_header")?;
    let (old_start, old_count) = parse_range(old_part.strip_prefix('-').ok_or("bad_hunk_header")?)?;
    let (new_start, new_count) = parse_range(new_part.strip_prefix('+').ok_or("bad_hunk_header")?)?;
    Ok((old_start, old_count, new_start, new_count, heading))
}

fn parse_range(s: &str) -> Result<(u32, u32), String> {
    if let Some((start, count)) = s.split_once(',') {
        Ok((
            start.parse().map_err(|_| "bad_range")?,
            count.parse().map_err(|_| "bad_range")?,
        ))
    } else {
        Ok((s.parse().map_err(|_| "bad_range")?, 1))
    }
}

/// 反向单个 hunk：交换 old/new 行号区间，交换 +/- 行；上下文与 `\ No newline` 行原样保留。
fn reverse_hunk(hunk: &[&str]) -> Result<Vec<String>, String> {
    let header = *hunk.first().ok_or("empty_hunk")?;
    let cr = header.ends_with('\r');
    let header_clean = header.trim_end_matches('\r');
    let (old_start, old_count, new_start, new_count, heading) = parse_hunk_header(header_clean)?;
    let mut new_header = format!(
        "@@ -{},{} +{},{} @@{}",
        new_start, new_count, old_start, old_count, heading
    );
    if cr {
        new_header.push('\r');
    }

    let mut out = vec![new_header];
    for &line in &hunk[1..] {
        if line.is_empty() {
            out.push(String::new());
            continue;
        }
        let first = line.as_bytes()[0];
        let rest = &line[1..];
        let reversed = match first {
            b'+' => format!("-{}", rest),
            b'-' => format!("+{}", rest),
            // 上下文 ' '、无尾换行标记 '\' 等原样保留
            _ => line.to_string(),
        };
        out.push(reversed);
    }
    Ok(out)
}

/// 从完整 unified diff 文本中提取第 `hunk_index` 个 hunk，构造"反向 patch"。
/// 正向 apply 该反向 patch 即等于撤销这个 hunk 的改动。纯函数，便于单测。
fn build_reverse_hunk_patch(diff_text: &str, hunk_index: usize) -> Result<String, String> {
    let lines: Vec<&str> = diff_text.split('\n').collect();

    // 1. 文件头：首个 @@ 之前的所有行（diff --git / index / --- / +++）。
    let mut header: Vec<&str> = Vec::new();
    let mut idx = 0;
    while idx < lines.len() && !lines[idx].starts_with("@@") {
        header.push(lines[idx]);
        idx += 1;
    }

    // 2. 按 @@ 切分各 hunk。
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    while idx < lines.len() {
        let line = lines[idx];
        if line.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            current = Some(vec![line]);
        } else if let Some(h) = current.as_mut() {
            h.push(line);
        }
        idx += 1;
    }
    if let Some(h) = current.take() {
        hunks.push(h);
    }

    if hunk_index >= hunks.len() {
        return Err(format!(
            "hunk_index_out_of_range:{}:{}",
            hunk_index,
            hunks.len()
        ));
    }

    let reversed = reverse_hunk(&hunks[hunk_index])?;

    let mut out: Vec<String> = header.iter().map(|s| s.to_string()).collect();
    out.extend(reversed);
    let mut result = out.join("\n");
    // patch 末行需以换行结尾，避免 libgit2 解析报 corrupt patch。
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

/// 把反向 patch 应用到工作区：解析 → dry-run 校验 → 正式 apply。
/// dry-run 防止 stale diff 错位应用损坏工作区；失败返回稳定错误串。
fn apply_patch_to_repo(repo: &Repository, reverse_patch: &str) -> Result<(), String> {
    let diff = git2::Diff::from_buffer(reverse_patch.as_bytes())
        .map_err(|e| format!("parse_patch_failed: {e}"))?;

    // dry-run：先验证 patch 能否干净应用，避免 stale diff 损坏工作区。
    let mut check_opts = git2::ApplyOptions::new();
    check_opts.check(true);
    repo.apply(&diff, git2::ApplyLocation::WorkDir, Some(&mut check_opts))
        .map_err(|_| "patch_conflict_refresh_needed".to_string())?;

    // 正式应用到工作区。
    repo.apply(&diff, git2::ApplyLocation::WorkDir, None)
        .map_err(|e| format!("apply_failed: {e}"))?;

    Ok(())
}

fn apply_patch_to_workdir(project_path: &str, reverse_patch: &str) -> Result<(), String> {
    let path = Path::new(project_path);
    if !crate::wsl::is_wsl_config_dir(project_path) && !path.exists() {
        return Err("path_not_found".to_string());
    }
    let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
    apply_patch_to_repo(&repo, reverse_patch)
}

/// 回滚 diff 中的单个 hunk（Hunk 级回滚入口）。
///
/// 破坏性操作。前端传入打开时的完整 diff 文本与 hunk 序号；后端构造反向 patch，
/// dry-run 校验后 apply 到工作区。
#[tauri::command]
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

/// 行级反向单个 hunk：仅回滚选中的行。返回 None 表示该 hunk 无选中行（应跳过）。
///
/// 规则（撤销选中改动）：
/// * 上下文行：保留为上下文。
/// * 选中的 `-` 行（HEAD 有 / workdir 无）：反向为 `+`（恢复）。
/// * 未选中的 `-` 行：从反向 patch 省略（workdir 本就没有）。
/// * 选中的 `+` 行（workdir 有 / HEAD 无）：反向为 `-`（删除）。
/// * 未选中的 `+` 行：降为上下文（workdir 仍有，需用于对齐）。
/// 行号区间按反向后的实际行数重算（反向 old 侧起点 = 原 new_start）。
fn reverse_hunk_lines(
    hunk: &[&str],
    selected: &std::collections::HashSet<(String, u32)>,
) -> Result<Option<String>, String> {
    let header = *hunk.first().ok_or("empty_hunk")?;
    let cr = header.ends_with('\r');
    let (old_start, _oc, new_start, _nc, heading) =
        parse_hunk_header(header.trim_end_matches('\r'))?;

    let mut cur_old = old_start;
    let mut cur_new = new_start;
    let mut body: Vec<String> = Vec::new();
    let mut rev_old_count = 0u32; // 反向后 old 侧行数（context + '-'）
    let mut rev_new_count = 0u32; // 反向后 new 侧行数（context + '+'）
    let mut any_selected = false;

    for &line in &hunk[1..] {
        if line.is_empty() {
            continue;
        }
        let first = line.as_bytes()[0];
        let content = &line[1..];
        match first {
            b' ' => {
                body.push(format!(" {content}"));
                rev_old_count += 1;
                rev_new_count += 1;
                cur_old += 1;
                cur_new += 1;
            }
            b'-' => {
                let hit = selected.contains(&("old".to_string(), cur_old));
                cur_old += 1;
                if hit {
                    body.push(format!("+{content}"));
                    rev_new_count += 1;
                    any_selected = true;
                }
                // 未选中：省略
            }
            b'+' => {
                let hit = selected.contains(&("new".to_string(), cur_new));
                cur_new += 1;
                if hit {
                    body.push(format!("-{content}"));
                    rev_old_count += 1;
                    any_selected = true;
                } else {
                    body.push(format!(" {content}"));
                    rev_old_count += 1;
                    rev_new_count += 1;
                }
            }
            b'\\' => {
                // 无尾换行标记：原样保留（关联前一行）。
                body.push(line.to_string());
            }
            _ => body.push(line.to_string()),
        }
    }

    if !any_selected {
        return Ok(None);
    }

    let mut new_header = format!(
        "@@ -{},{} +{},{} @@{}",
        new_start, rev_old_count, new_start, rev_new_count, heading
    );
    if cr {
        new_header.push('\r');
    }

    let mut out = vec![new_header];
    out.extend(body);
    Ok(Some(out.join("\n")))
}

/// 从完整 unified diff 文本构造行级反向 patch：仅回滚 `selected` 中的行。
/// 跨多个 hunk 的选择逐 hunk 处理并合并；无选中行的 hunk 跳过。纯函数，便于单测。
fn build_reverse_lines_patch(
    diff_text: &str,
    selected: &[(String, u32)],
) -> Result<String, String> {
    let sel: std::collections::HashSet<(String, u32)> = selected.iter().cloned().collect();

    let lines: Vec<&str> = diff_text.split('\n').collect();
    let mut header: Vec<&str> = Vec::new();
    let mut idx = 0;
    while idx < lines.len() && !lines[idx].starts_with("@@") {
        header.push(lines[idx]);
        idx += 1;
    }

    let mut hunks: Vec<Vec<&str>> = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    while idx < lines.len() {
        let line = lines[idx];
        if line.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            current = Some(vec![line]);
        } else if let Some(h) = current.as_mut() {
            h.push(line);
        }
        idx += 1;
    }
    if let Some(h) = current.take() {
        hunks.push(h);
    }

    let mut rev_hunks: Vec<String> = Vec::new();
    for hunk in &hunks {
        if let Some(rev) = reverse_hunk_lines(hunk, &sel)? {
            rev_hunks.push(rev);
        }
    }

    if rev_hunks.is_empty() {
        return Err("no_lines_selected".to_string());
    }

    let mut out: Vec<String> = header.iter().map(|s| s.to_string()).collect();
    out.extend(rev_hunks);
    let mut result = out.join("\n");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

/// 回滚 diff 中选中的若干行（行级回滚入口）。破坏性操作，dry-run 兜底。
#[tauri::command]
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
pub async fn git_branch_status(project_path: String) -> Result<GitBranchStatus, String> {
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;

        // 进行中的合并/变基（git2 仓库状态）。变基期间 HEAD 通常 detached，
        // 需在 detached 早返回前计算，避免漏报。
        let pending_op = match repo.state() {
            git2::RepositoryState::Merge => Some("merge".to_string()),
            git2::RepositoryState::Rebase
            | git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge => Some("rebase".to_string()),
            _ => None,
        };

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

/// 把 git stderr 映射为稳定错误码 + 原始片段，供前端 toast 展示。
/// 形如 "not_fast_forward: <git 原文>"。
fn map_git_cli_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    let code = if s.contains("authentication failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("permission denied")
        || s.contains("invalid username or password")
    {
        "auth_failed"
    } else if s.contains("non-fast-forward")
        || s.contains("fetch first")
        || s.contains("updates were rejected")
        || s.contains("[rejected]")
        || s.contains("not possible to fast-forward")
        || s.contains("diverging")
        || s.contains("divergent")
    {
        "not_fast_forward"
    } else if s.contains("no upstream") || s.contains("has no upstream") {
        "no_upstream"
    } else if s.contains("would be overwritten by checkout")
        || s.contains("would be overwritten by merge")
        || s.contains("please commit your changes or stash them")
    {
        "checkout_conflict"
    } else if s.contains("could not read from remote")
        || s.contains("does not appear to be a git repository")
        || s.contains("no configured push destination")
        || s.contains("no such remote")
        || s.contains("'origin' does not appear")
    {
        "no_remote"
    } else {
        "git_failed"
    };
    let snippet: String = stderr.trim().chars().take(300).collect();
    format!("{code}: {snippet}")
}

fn git_command_output(project_path: &str, args: &[&str]) -> Result<std::process::Output, String> {
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(project_path) {
        if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
            let path = Path::new(&windows_path);
            if !path.exists() {
                return Err("path_not_found".to_string());
            }
            let mut cmd = silent_command("git");
            cmd.current_dir(path).args(args);
            return cmd.output().map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "git_not_found".to_string()
                } else {
                    format!("spawn_failed: {e}")
                }
            });
        }

        let program = crate::wsl::find_wsl_exe()
            .as_deref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "wsl.exe".to_string());
        let mut cmd = silent_command(&program);
        let wsl_args = build_wsl_git_command_args(&distro, &linux_path, args);
        cmd.args(&wsl_args);
        return cmd.output().map_err(|e| format!("spawn_failed: {e}"));
    }

    let path = Path::new(project_path);
    if !path.exists() {
        return Err("path_not_found".to_string());
    }

    let mut cmd = silent_command("git");
    cmd.current_dir(path).args(args);

    cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("spawn_failed: {e}")
        }
    })
}

/// shell out 系统 `git` 执行网络操作，继承用户凭据管理器 / SSH / git config 代理。
/// WSL UNC 路径改由 wsl.exe 内部执行 git，避免 Windows git 在 UNC/Plan 9 上失败。
/// 用 args 数组（非 shell）避免注入；成功返回合并输出，失败返回映射错误码。
fn run_git_cli(project_path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command_output(project_path, args)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(map_git_cli_error(&format!("{stderr}{stdout}")))
    }
}

/// 校验分支名安全：非空、不以 '-' 开头（防被当作 git flag）、无空白/控制字符。
fn validate_branch_name(branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Err("empty_branch".into());
    }
    if branch.starts_with('-') {
        return Err("invalid_branch".into());
    }
    if branch.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("invalid_branch".into());
    }
    if branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch
            .chars()
            .any(|c| matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err("invalid_branch".into());
    }
    Ok(())
}

fn validate_branch_name_with_git(project_path: &str, branch: &str) -> Result<(), String> {
    validate_branch_name(branch)?;
    run_git_cli(project_path, &["check-ref-format", "--branch", branch])
        .map(|_| ())
        .map_err(|_| "invalid_branch".to_string())
}

fn split_remote_branch(branch: &str) -> Option<(&str, &str)> {
    let (remote, name) = branch.split_once('/')?;
    (!remote.is_empty() && !name.is_empty()).then_some((remote, name))
}

fn run_checkout_branch(project_path: &str, branch: &str, remote: bool) -> Result<String, String> {
    if remote {
        if split_remote_branch(branch).is_none() {
            return Err("invalid_branch".to_string());
        }
        run_git_cli(project_path, &["checkout", "--track", branch])
    } else {
        run_git_cli(project_path, &["checkout", branch])
    }
}

fn is_no_stash_created(output: &str) -> bool {
    let s = output.to_lowercase();
    s.contains("no local changes to save") || s.contains("no local changes")
}

#[tauri::command]
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
pub async fn git_fetch(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git_cli(&project_path, &["fetch", "--prune"]))
        .await
        .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
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
pub async fn git_create_branch(project_path: String, branch: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_branch_name_with_git(&project_path, &branch)?;
        run_git_cli(&project_path, &["checkout", "-b", &branch])
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 推送当前分支。set_upstream=true 时 `push -u origin <branch>` 建立跟踪。
/// shell out 系统 git；失败错误码见 map_git_cli_error。
#[tauri::command]
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

/// 按策略拉取当前分支（merge / rebase / ff-only）。shell out 系统 git，继承凭据/代理/SSH。
/// 分叉时 merge/rebase 可直接拉取，无需切终端；冲突返回 `pull_conflict`，可经 git_pull_abort 安全回退。
#[tauri::command]
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
pub async fn git_pull_abort(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let effective_project_path = effective_git_project_path(&project_path);
        let path = Path::new(&effective_project_path);
        if !crate::wsl::is_wsl_config_dir(&project_path) && !path.exists() {
            return Err("path_not_found".to_string());
        }
        let rebasing = {
            let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
            matches!(
                repo.state(),
                git2::RepositoryState::Rebase
                    | git2::RepositoryState::RebaseInteractive
                    | git2::RepositoryState::RebaseMerge
            )
        };
        let args: &[&str] = if rebasing {
            &["rebase", "--abort"]
        } else {
            &["merge", "--abort"]
        };
        run_git_cli(&project_path, args)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 变基冲突解决并暂存后继续变基。`-c core.editor=true` 跳过提交信息编辑器避免挂起；
/// 仍有未解决冲突 → `pull_conflict`，前端维持冲突态。
#[tauri::command]
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
pub async fn git_watch_start(
    app_handle: AppHandle,
    bridge: State<'_, GitWatcherBridge>,
    project_path: String,
) -> Result<(), String> {
    bridge.start(app_handle, project_path)
}

/// 停止文件监听并释放 watcher。
#[tauri::command]
pub async fn git_watch_stop(bridge: State<'_, GitWatcherBridge>) -> Result<(), String> {
    bridge.stop()
}

#[cfg(test)]
mod tests {
    use super::{
        build_reverse_hunk_patch, build_reverse_lines_patch, build_worktree_snapshot,
        build_wsl_git_command_args, collect_git_changes_from_repo, git_delete_untracked_paths,
        git_fork_worktree_snapshot, git_get_file_diff, git_restore_worktree_snapshot,
        is_nested_repo_entry, is_no_stash_created, parse_wsl_git_status, parse_wsl_numstat,
        remove_untracked_snapshot_file, scan_git_repository_paths, should_skip_diff_line_stats,
        validate_branch_name, validate_repo_relative_path, validate_snapshot_branch_name,
        GIT_DIFF_LINE_STATS_STATUS_LIMIT,
    };
    use git2::{IndexAddOption, Repository, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn init_temp_repo() -> (TempDir, String) {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        fs::write(temp.path().join("tracked.txt"), "base\n").unwrap();

        let mut index = repo.index().unwrap();
        index
            .add_all(["tracked.txt"], IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::now("CLI Manager", "cli-manager@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
            .unwrap();

        let path = temp.path().to_string_lossy().to_string();
        (temp, path)
    }

    fn snapshot_patch(repo_path: &str) -> (String, String) {
        let repo = Repository::open(repo_path).unwrap();
        let snapshot = build_worktree_snapshot(repo_path, &repo).unwrap();
        (snapshot.head, snapshot.patch)
    }

    fn commit_all(repo: &Repository, message: &str) {
        let mut index = repo.index().unwrap();
        index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let sig = Signature::now("CLI Manager", "cli-manager@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
            .unwrap();
    }

    fn tracked_file(repo_path: &str) -> String {
        fs::read_to_string(Path::new(repo_path).join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n")
    }

    fn current_branch(repo_path: &str) -> String {
        let repo = Repository::open(repo_path).unwrap();
        let head = repo.head().unwrap();
        head.shorthand().unwrap().to_string()
    }

    #[tokio::test]
    async fn file_diff_decodes_gbk_and_disables_partial_revert() {
        let (_temp, repo_path) = init_temp_repo();
        let repo = Repository::open(&repo_path).unwrap();
        let file = Path::new(&repo_path).join("legacy.cs");
        let old_text = "旧版本中文内容，用于验证传统编码差异。\n";
        let new_text = "新版本中文内容，用于验证传统编码差异。\n";
        let (old_bytes, _, old_errors) = encoding_rs::GBK.encode(old_text);
        assert!(!old_errors);
        fs::write(&file, old_bytes.as_ref()).unwrap();
        commit_all(&repo, "add legacy file");
        let (new_bytes, _, new_errors) = encoding_rs::GBK.encode(new_text);
        assert!(!new_errors);
        fs::write(&file, new_bytes.as_ref()).unwrap();
        drop(repo);

        let payload = git_get_file_diff(repo_path, "legacy.cs".to_string(), "M".to_string())
            .await
            .unwrap();

        assert!(payload.content.contains(old_text.trim()));
        assert!(payload.content.contains(new_text.trim()));
        assert!(!payload.can_revert_hunks);
    }

    #[tokio::test]
    async fn file_diff_decodes_utf16_text_instead_of_treating_it_as_binary() {
        let (_temp, repo_path) = init_temp_repo();
        let repo = Repository::open(&repo_path).unwrap();
        let file = Path::new(&repo_path).join("legacy-utf16.cs");
        let old_text = "共同第一行。\nUTF16 旧版本中文内容。\n共同第三行。\n";
        let new_text = "共同第一行。\nUTF16 新版本中文内容。\n共同第三行。\n";
        fs::write(
            &file,
            crate::text_encoding::encode_text(old_text, "utf-16le", true).unwrap(),
        )
        .unwrap();
        commit_all(&repo, "add utf16 file");
        fs::write(
            &file,
            crate::text_encoding::encode_text(new_text, "utf-16le", true).unwrap(),
        )
        .unwrap();
        drop(repo);

        let payload = git_get_file_diff(repo_path, "legacy-utf16.cs".to_string(), "M".to_string())
            .await
            .unwrap();

        assert!(payload.content.contains("共同第一行。"));
        assert!(payload.content.contains("UTF16 旧版本中文内容。"));
        assert!(payload.content.contains("UTF16 新版本中文内容。"));
        assert!(payload.content.contains("共同第三行。"));
        assert!(!payload.content.contains("Binary files"));
        assert!(!payload.can_revert_hunks);
    }

    #[tokio::test]
    async fn utf8_file_diff_keeps_partial_revert_enabled() {
        let (_temp, repo_path) = init_temp_repo();
        fs::write(Path::new(&repo_path).join("tracked.txt"), "changed\n").unwrap();

        let payload = git_get_file_diff(repo_path, "tracked.txt".to_string(), "M".to_string())
            .await
            .unwrap();

        assert!(payload.content.contains("-base"));
        assert!(payload.content.contains("+changed"));
        assert!(payload.can_revert_hunks);
    }

    #[test]
    fn scan_git_repository_paths_respects_depth_and_exclusions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        // 根仓库（扫描只检查 .git 存在性，直接建目录即可）
        fs::create_dir_all(root.join(".git")).unwrap();
        // 一级子仓库
        fs::create_dir_all(root.join("sub-repo-a").join(".git")).unwrap();
        // 二级子仓库
        fs::create_dir_all(root.join("tools").join("sub-repo-c").join(".git")).unwrap();
        // node_modules 内的假仓库：命中排除表，不收录
        fs::create_dir_all(root.join("node_modules").join("fake").join(".git")).unwrap();
        // 深度 4 的仓库：超出限深，不收录
        fs::create_dir_all(
            root.join("a")
                .join("b")
                .join("c")
                .join("deep4")
                .join(".git"),
        )
        .unwrap();

        let repos = scan_git_repository_paths(root, 3);
        let rels: Vec<&str> = repos.iter().map(|(rel, _)| rel.as_str()).collect();

        assert_eq!(rels.first(), Some(&""), "根仓库应为首条（相对路径空串）");
        assert!(rels.contains(&"sub-repo-a"));
        assert!(rels.contains(&"tools/sub-repo-c"));
        assert!(!rels.iter().any(|r| r.contains("node_modules")));
        assert!(!rels.iter().any(|r| r.contains("deep4")));
        assert_eq!(rels.len(), 3);
    }

    #[test]
    fn collect_git_changes_skips_nested_repo_dir() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();

        // 普通未跟踪文件：应出现在变更列表中
        fs::write(temp.path().join("untracked.txt"), "hello\n").unwrap();

        // 嵌套子仓库（非 submodule）：目录条目应被跳过
        let nested = temp.path().join("sub-repo-a");
        fs::create_dir_all(&nested).unwrap();
        Repository::init(&nested).unwrap();
        fs::write(nested.join("inner.txt"), "inner\n").unwrap();

        let changes = collect_git_changes_from_repo(&repo).unwrap();
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();

        assert!(paths.contains(&"untracked.txt"));
        assert!(!paths.iter().any(|p| p.starts_with("sub-repo-a")));
    }

    #[test]
    fn is_nested_repo_entry_detects_nested_repo_dir_only() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();

        // 嵌套子仓库目录（尾部 '/' 且含 .git）→ true
        let nested = temp.path().join("sub-repo-a");
        fs::create_dir_all(&nested).unwrap();
        Repository::init(&nested).unwrap();
        assert!(is_nested_repo_entry(&repo, "sub-repo-a/"));

        // 普通文件路径 → false
        fs::write(temp.path().join("untracked.txt"), "hello\n").unwrap();
        assert!(!is_nested_repo_entry(&repo, "untracked.txt"));

        // 无 .git 的普通目录路径 → false
        fs::create_dir_all(temp.path().join("plain-dir")).unwrap();
        assert!(!is_nested_repo_entry(&repo, "plain-dir/"));
    }

    #[test]
    fn accepts_normal_relative_path() {
        assert!(validate_repo_relative_path("src/main.rs").is_ok());
        assert!(validate_repo_relative_path("a/b/c.txt").is_ok());
    }

    #[test]
    fn accepts_valid_branch_names() {
        assert!(validate_branch_name("feature/git-panel").is_ok());
        assert!(validate_branch_name("origin/main").is_ok());
    }

    #[test]
    fn rejects_invalid_branch_names() {
        assert_eq!(validate_branch_name("").unwrap_err(), "empty_branch");
        assert_eq!(validate_branch_name("-bad").unwrap_err(), "invalid_branch");
        assert_eq!(
            validate_branch_name("bad branch").unwrap_err(),
            "invalid_branch"
        );
        assert_eq!(
            validate_branch_name("bad..branch").unwrap_err(),
            "invalid_branch"
        );
        assert_eq!(
            validate_branch_name("bad:branch").unwrap_err(),
            "invalid_branch"
        );
        assert_eq!(
            validate_branch_name("bad\\branch").unwrap_err(),
            "invalid_branch"
        );
        assert_eq!(validate_branch_name("bad/").unwrap_err(), "invalid_branch");
    }

    #[test]
    fn detects_no_stash_created_output() {
        assert!(is_no_stash_created("No local changes to save"));
        assert!(is_no_stash_created("no local changes"));
        assert!(!is_no_stash_created(
            "Saved working directory and index state"
        ));
    }

    #[test]
    fn skips_diff_line_stats_only_after_status_limit() {
        assert!(!should_skip_diff_line_stats(
            GIT_DIFF_LINE_STATS_STATUS_LIMIT
        ));
        assert!(should_skip_diff_line_stats(
            GIT_DIFF_LINE_STATS_STATUS_LIMIT + 1
        ));
    }

    #[test]
    fn wsl_git_args_include_repo_safe_directory() {
        let args = build_wsl_git_command_args(
            "Ubuntu-22.04",
            "/data/tabGo",
            &["status", "--porcelain=v1"],
        );

        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu-22.04",
                "--exec",
                "git",
                "-c",
                "safe.directory=/data/tabGo",
                "-C",
                "/data/tabGo",
                "status",
                "--porcelain=v1",
            ]
        );
    }

    #[test]
    fn parses_wsl_git_status_basic_entries() {
        let input = b" M src/main.rs\0M  src/lib.rs\0A  added.txt\0 D deleted.txt\0?? notes/new.md\0?? generated/\0";
        let changes = parse_wsl_git_status(input);

        assert_eq!(changes.len(), 6);
        assert_eq!(changes[0].path, "src/main.rs");
        assert_eq!(changes[0].status, "M");
        assert!(!changes[0].staged);
        assert_eq!(changes[1].path, "src/lib.rs");
        assert_eq!(changes[1].status, "M");
        assert!(changes[1].staged);
        assert_eq!(changes[2].status, "A");
        assert!(changes[2].staged);
        assert_eq!(changes[3].status, "D");
        assert!(!changes[3].staged);
        assert_eq!(changes[4].status, "U");
        assert!(!changes[4].staged);
        assert_eq!(changes[5].path, "generated/");
        assert_eq!(changes[5].status, "U");
        assert!(!changes[5].staged);
    }

    #[test]
    fn parses_wsl_git_status_rename_and_conflict() {
        let input = b"R  new/name.rs\0old/name.rs\0UU conflicted.txt\0";
        let changes = parse_wsl_git_status(input);

        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "new/name.rs");
        assert_eq!(changes[0].status, "R");
        assert!(changes[0].staged);
        assert_eq!(changes[1].path, "conflicted.txt");
        assert_eq!(changes[1].status, "C");
        assert!(!changes[1].staged);
    }

    #[test]
    fn parses_wsl_numstat_records() {
        let stats = parse_wsl_numstat(b"12\t3\tsrc/main.rs\0-\t-\tassets/logo.png\0");

        assert_eq!(stats.get("src/main.rs"), Some(&(12, 3)));
        assert_eq!(stats.get("assets/logo.png"), Some(&(0, 0)));
    }

    #[test]
    fn rejects_parent_escape() {
        assert_eq!(
            validate_repo_relative_path("../etc/passwd").unwrap_err(),
            "path_escape"
        );
        assert_eq!(
            validate_repo_relative_path("src/../../x").unwrap_err(),
            "path_escape"
        );
    }

    #[test]
    fn rejects_absolute_path() {
        assert_eq!(
            validate_repo_relative_path("/etc/passwd").unwrap_err(),
            "absolute_path"
        );
        assert_eq!(
            validate_repo_relative_path("C:/Windows").unwrap_err(),
            "absolute_path"
        );
        assert_eq!(
            validate_repo_relative_path("\\server\\share").unwrap_err(),
            "absolute_path"
        );
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(validate_repo_relative_path("").unwrap_err(), "empty_path");
    }

    #[test]
    fn remove_untracked_snapshot_file_rejects_path_escape() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            remove_untracked_snapshot_file(temp.path(), "../outside.txt").unwrap_err(),
            "path_escape"
        );
    }

    #[test]
    fn remove_untracked_snapshot_file_removes_file_inside_workdir() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("tmp").join("note.txt");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, "draft").unwrap();

        remove_untracked_snapshot_file(temp.path(), "tmp/note.txt").unwrap();

        assert!(!nested.exists());
        assert!(!temp.path().join("tmp").exists());
    }

    #[tokio::test]
    async fn git_delete_untracked_paths_removes_untracked_file() {
        let (temp, repo_path) = init_temp_repo();
        let untracked = temp.path().join("note.txt");
        fs::write(&untracked, "draft").unwrap();

        git_delete_untracked_paths(repo_path, vec!["note.txt".to_string()])
            .await
            .unwrap();

        assert!(!untracked.exists());
    }

    #[tokio::test]
    async fn git_delete_untracked_paths_rejects_tracked_file() {
        let (_temp, repo_path) = init_temp_repo();

        let err = git_delete_untracked_paths(repo_path, vec!["tracked.txt".to_string()])
            .await
            .unwrap_err();

        assert_eq!(err, "path_not_untracked");
    }

    #[test]
    fn validate_snapshot_branch_name_rejects_invalid_names() {
        assert!(validate_snapshot_branch_name("replay/test").is_ok());
        assert_eq!(
            validate_snapshot_branch_name("../main").unwrap_err(),
            "branch_name_invalid"
        );
        assert_eq!(
            validate_snapshot_branch_name("bad branch").unwrap_err(),
            "branch_name_invalid"
        );
        assert_eq!(
            validate_snapshot_branch_name("").unwrap_err(),
            "branch_name_empty"
        );
    }

    #[tokio::test]
    async fn restore_worktree_snapshot_rejects_head_mismatch() {
        let (_temp, repo_path) = init_temp_repo();
        fs::write(Path::new(&repo_path).join("tracked.txt"), "target\n").unwrap();
        let (_head, patch) = snapshot_patch(&repo_path);

        let err = git_restore_worktree_snapshot(
            repo_path,
            patch.clone(),
            patch,
            "0000000000000000000000000000000000000000".to_string(),
        )
        .await
        .unwrap_err();

        assert_eq!(err, "head_mismatch");
    }

    #[tokio::test]
    async fn restore_worktree_snapshot_rejects_changed_worktree() {
        let (_temp, repo_path) = init_temp_repo();
        let file = Path::new(&repo_path).join("tracked.txt");
        fs::write(&file, "target\n").unwrap();
        let (head, target_patch) = snapshot_patch(&repo_path);
        fs::write(&file, "current\n").unwrap();

        let err =
            git_restore_worktree_snapshot(repo_path, target_patch.clone(), target_patch, head)
                .await
                .unwrap_err();

        assert_eq!(err, "worktree_changed_since_snapshot");
    }

    #[tokio::test]
    async fn restore_worktree_snapshot_restores_target_patch() {
        let (_temp, repo_path) = init_temp_repo();
        let file = Path::new(&repo_path).join("tracked.txt");
        fs::write(&file, "target\n").unwrap();
        let (head, target_patch) = snapshot_patch(&repo_path);
        fs::write(&file, "current\n").unwrap();
        let (_current_head, current_patch) = snapshot_patch(&repo_path);

        git_restore_worktree_snapshot(repo_path.clone(), target_patch, current_patch, head)
            .await
            .unwrap();

        assert_eq!(tracked_file(&repo_path), "target\n");
    }

    #[tokio::test]
    async fn fork_worktree_snapshot_creates_branch_and_restores_target_patch() {
        let (_temp, repo_path) = init_temp_repo();
        let file = Path::new(&repo_path).join("tracked.txt");
        fs::write(&file, "target\n").unwrap();
        let (head, target_patch) = snapshot_patch(&repo_path);
        fs::write(&file, "current\n").unwrap();
        let (_current_head, current_patch) = snapshot_patch(&repo_path);

        git_fork_worktree_snapshot(
            repo_path.clone(),
            target_patch,
            current_patch,
            head,
            "replay/test-fork".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(current_branch(&repo_path), "replay/test-fork");
        assert_eq!(tracked_file(&repo_path), "target\n");
    }

    const SAMPLE_DIFF: &str = "\
diff --git a/foo.txt b/foo.txt
index 1111111..2222222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@
 line1
-old2
+new2
 line3
@@ -10,2 +10,3 @@
 line10
+inserted
 line11
";

    #[test]
    fn reverses_first_hunk_only() {
        let patch = build_reverse_hunk_patch(SAMPLE_DIFF, 0).unwrap();
        // 文件头保留
        assert!(patch.contains("--- a/foo.txt"));
        assert!(patch.contains("+++ b/foo.txt"));
        // 对称 hunk，行号区间不变
        assert!(patch.contains("@@ -1,3 +1,3 @@"));
        // +/- 互换：原 -old2 → +old2，原 +new2 → -new2
        assert!(patch.contains("+old2"));
        assert!(patch.contains("-new2"));
        // 上下文保留
        assert!(patch.contains(" line1"));
        // 仅含第 0 个 hunk，不含第 1 个 hunk
        assert!(!patch.contains("inserted"));
        assert!(patch.ends_with('\n'));
    }

    #[test]
    fn reverses_second_hunk_and_swaps_counts() {
        let patch = build_reverse_hunk_patch(SAMPLE_DIFF, 1).unwrap();
        // 原 @@ -10,2 +10,3 @@ 反向为 @@ -10,3 +10,2 @@
        assert!(patch.contains("@@ -10,3 +10,2 @@"));
        // 原 +inserted → -inserted
        assert!(patch.contains("-inserted"));
        // 不含第 0 个 hunk 的内容
        assert!(!patch.contains("new2"));
    }

    #[test]
    fn rejects_out_of_range_hunk() {
        let err = build_reverse_hunk_patch(SAMPLE_DIFF, 5).unwrap_err();
        assert!(err.starts_with("hunk_index_out_of_range"));
    }

    #[test]
    fn handles_omitted_count_in_header() {
        // 单行变更，count 省略：@@ -5 +5 @@
        let diff = "--- a/x\n+++ b/x\n@@ -5 +5 @@\n-a\n+b\n";
        let patch = build_reverse_hunk_patch(diff, 0).unwrap();
        // 省略 count 视为 1，反向后为 @@ -5,1 +5,1 @@
        assert!(patch.contains("@@ -5,1 +5,1 @@"));
        assert!(patch.contains("+a"));
        assert!(patch.contains("-b"));
    }

    #[test]
    fn line_revert_removes_selected_insert_only() {
        // 仅选中新增行 new2（new 行号 2）：删除 new2，但不恢复未选中的 old2。
        let sel = vec![("new".to_string(), 2u32)];
        let patch = build_reverse_lines_patch(SAMPLE_DIFF, &sel).unwrap();
        assert!(patch.contains("@@ -1,3 +1,2 @@"));
        assert!(patch.contains("-new2"));
        assert!(patch.contains(" line1"));
        assert!(patch.contains(" line3"));
        // old2 未选中 → 省略
        assert!(!patch.contains("old2"));
    }

    #[test]
    fn line_revert_restores_selected_delete_only() {
        // 仅选中删除行 old2（old 行号 2）：恢复 old2，未选中的 new2 降为上下文保留。
        let sel = vec![("old".to_string(), 2u32)];
        let patch = build_reverse_lines_patch(SAMPLE_DIFF, &sel).unwrap();
        assert!(patch.contains("@@ -1,3 +1,4 @@"));
        assert!(patch.contains("+old2"));
        assert!(patch.contains(" new2"));
    }

    #[test]
    fn line_revert_skips_hunks_without_selection() {
        // 仅选中第二个 hunk 的 inserted（new 行号 11）：只反向第二个 hunk。
        let sel = vec![("new".to_string(), 11u32)];
        let patch = build_reverse_lines_patch(SAMPLE_DIFF, &sel).unwrap();
        assert!(patch.contains("@@ -10,3 +10,2 @@"));
        assert!(patch.contains("-inserted"));
        // 第一个 hunk 无选中 → 跳过
        assert!(!patch.contains("@@ -1,"));
        assert!(!patch.contains("new2"));
    }

    #[test]
    fn line_revert_no_match_errors() {
        let sel = vec![("new".to_string(), 999u32)];
        assert_eq!(
            build_reverse_lines_patch(SAMPLE_DIFF, &sel).unwrap_err(),
            "no_lines_selected"
        );
    }
}
