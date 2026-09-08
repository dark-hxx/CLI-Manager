use git2::Repository;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

const WORKTREE_BRANCH_PREFIX: &str = "wt/";
const MAX_TASK_NAME_LEN: usize = 64;
const WORKTREE_REMOVE_RETRY_ATTEMPTS: usize = 5;
const WORKTREE_REMOVE_RETRY_DELAY_MS: u64 = 250;
const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateRequest {
    pub project_path: String,
    pub task_name: String,
    pub worktree_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateResult {
    pub name: String,
    pub branch: String,
    pub path: String,
    pub base_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeMergeResult {
    pub merged: bool,
    pub output: String,
    pub conflict_files: Vec<String>,
    pub skipped: bool,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeDepsCheckResult {
    pub needs_install: bool,
    pub command: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug)]
struct GitCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl GitCommandOutput {
    // 合并标准输出和错误输出，并去除首尾空白。
    fn combined(&self) -> String {
        format!("{}{}", self.stdout, self.stderr).trim().to_string()
    }
}

const GIT_CREATE_ERROR_SNIPPET_LEN: usize = 300;

// 归一化 Git 进度换行并保留末尾 300 字符，避免遗漏最终错误。
fn git_create_error_snippet(output: &str) -> String {
    let normalized = output.replace('\r', "\n");
    let lines = normalized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let chars = lines.chars().collect::<Vec<_>>();
    if chars.len() <= GIT_CREATE_ERROR_SNIPPET_LEN {
        return lines;
    }
    let start = chars.len() - GIT_CREATE_ERROR_SNIPPET_LEN;
    format!("...{}", chars[start..].iter().collect::<String>())
}

// 移除 Windows 扩展路径前缀，并将扩展 UNC 路径还原为普通 UNC。
fn strip_windows_extended_path_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        if let Some(unc_tail) = rest.strip_prefix("UNC\\") {
            return format!("\\\\{unc_tail}");
        }
        return rest.to_string();
    }
    if let Some(rest) = path.strip_prefix("//?/") {
        if let Some(unc_tail) = rest.strip_prefix("UNC/") {
            return format!("//{unc_tail}");
        }
        return rest.to_string();
    }
    path.to_string()
}

// 修剪输入并移除 Windows 扩展前缀，构造本地路径。
fn local_path_from_input(path: &str) -> PathBuf {
    PathBuf::from(strip_windows_extended_path_prefix(path.trim()))
}

// 将路径转换为不带 Windows 扩展前缀的 Git 参数。
fn path_to_git_arg(path: &Path) -> String {
    strip_windows_extended_path_prefix(&path.to_string_lossy())
}

// 归一化分隔符与大小写，识别两种 WSL UNC 路径。
fn is_wsl_path(path: &str) -> bool {
    let plain = strip_windows_extended_path_prefix(path);
    let normalized = plain.replace('/', "\\").to_lowercase();
    normalized.starts_with("\\\\wsl$\\") || normalized.starts_with("\\\\wsl.localhost\\")
}

// 识别 UNC、URL 和 git@ 形式的远程路径。
fn is_unc_or_remote_path(path: &str) -> bool {
    let plain = strip_windows_extended_path_prefix(path.trim());
    let normalized = plain.replace('/', "\\").to_lowercase();
    normalized.starts_with("\\\\") || normalized.contains("://") || normalized.starts_with("git@")
}

// 拒绝 WSL 和远程路径，仅允许继续处理本地路径。
fn ensure_supported_local_path(path: &str) -> Result<(), String> {
    if is_wsl_path(path) {
        return Err("unsupported_wsl".to_string());
    }
    if is_unc_or_remote_path(path) {
        return Err("unsupported_remote_path".to_string());
    }
    Ok(())
}

// 打开本地非裸仓库，并要求项目路径等于仓库工作区根目录。
fn open_main_repo(project_path: &str) -> Result<Repository, String> {
    ensure_supported_local_path(project_path)?;
    let path = local_path_from_input(project_path);
    if !path.exists() {
        return Err("path_not_found".to_string());
    }
    if !path.is_dir() {
        return Err("path_not_directory".to_string());
    }
    let repo = super::git::open_git_repo(&path).map_err(|_| "not_git_repository".to_string())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare_repository_unsupported".to_string())?;
    if normalize_path_for_compare(workdir) != normalize_path_for_compare(&path) {
        return Err("project_path_not_repo_root".to_string());
    }
    Ok(repo)
}

// 修剪任务名并限制长度、ASCII 字符和 Windows 保留名称。
fn validate_task_name(task_name: &str) -> Result<String, String> {
    let trimmed = task_name.trim();
    if trimmed.is_empty() {
        return Err("task_name_empty".to_string());
    }
    if trimmed.len() > MAX_TASK_NAME_LEN {
        return Err("task_name_too_long".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("task_name_invalid".to_string());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("task_name_invalid".to_string());
    }
    if RESERVED_WINDOWS_NAMES
        .iter()
        .any(|reserved| trimmed.eq_ignore_ascii_case(reserved))
    {
        return Err("task_name_reserved".to_string());
    }
    Ok(trimmed.to_string())
}

// 要求分支以 wt/ 开头且后缀为有效任务名。
fn validate_worktree_branch(branch: &str) -> Result<(), String> {
    let task_name = branch
        .strip_prefix(WORKTREE_BRANCH_PREFIX)
        .ok_or_else(|| "branch_not_worktree".to_string())?;
    validate_task_name(task_name)?;
    Ok(())
}

// 拒绝空值、首尾空白及不允许的基础分支字符或片段。
fn validate_plain_branch_name(branch: &str) -> Result<(), String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err("base_branch_empty".to_string());
    }
    if trimmed != branch
        || trimmed.starts_with('-')
        || trimmed.starts_with('/')
        || trimmed.ends_with('/')
    {
        return Err("base_branch_invalid".to_string());
    }
    if trimmed.contains("..") || trimmed.ends_with(".lock") {
        return Err("base_branch_invalid".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err("base_branch_invalid".to_string());
    }
    Ok(())
}

// 读取当前本地分支名，拒绝缺失 HEAD 和游离 HEAD。
fn current_branch_name(repo: &Repository) -> Result<String, String> {
    let head = repo.head().map_err(|_| "head_not_found".to_string())?;
    if !head.is_branch() {
        return Err("detached_head".to_string());
    }
    head.shorthand()
        .map(|value| value.to_string())
        .ok_or_else(|| "branch_name_unknown".to_string())
}

/// Trellis 把开发者身份写在 `.trellis/.developer`，该文件被 gitignore（仅本地），
/// 所以 `git worktree add` 不会把它带进新 worktree —— 结果新 worktree 里 Trellis
/// 认不出开发者、任务流程走不下去。这里在 worktree 创建后，best-effort 地把主仓库的
/// 身份文件复制过去。文件不存在（主仓库自己也没初始化）或复制失败都安全忽略，
/// 不影响 worktree 本身的创建结果。
// 尽力复制主仓库的 Trellis 身份文件，但不覆盖工作树已有身份。
fn seed_trellis_developer_identity(main_repo: &Path, worktree_path: &Path) {
    let source = main_repo.join(".trellis").join(".developer");
    if !source.is_file() {
        return;
    }
    let dest_dir = worktree_path.join(".trellis");
    if !dest_dir.is_dir() {
        return;
    }
    let dest = dest_dir.join(".developer");
    if dest.exists() {
        return;
    }
    let _ = fs::copy(&source, &dest);
}

// 在项目同级生成带 -worktrees 后缀的默认根目录。
fn default_worktree_root(project_path: &Path) -> Result<PathBuf, String> {
    let project_name = project_path
        .file_name()
        .and_then(OsStr::to_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "project_name_unknown".to_string())?;
    let parent = project_path
        .parent()
        .ok_or_else(|| "project_parent_unknown".to_string())?;
    Ok(parent.join(format!("{project_name}-worktrees")))
}

// 创建并规范化工作树根目录，要求目标不存在且位于根目录下。
fn resolve_worktree_target_path(
    project_path: &Path,
    task_name: &str,
    worktree_root: Option<&str>,
) -> Result<PathBuf, String> {
    let raw_root = match worktree_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(root) => {
            ensure_supported_local_path(root)?;
            let path = local_path_from_input(root);
            if !path.is_absolute() {
                return Err("worktree_root_not_absolute".to_string());
            }
            path
        }
        None => default_worktree_root(project_path)?,
    };

    fs::create_dir_all(&raw_root).map_err(|e| format!("create_worktree_root_failed: {e}"))?;
    let root = raw_root
        .canonicalize()
        .map_err(|e| format!("canonicalize_worktree_root_failed: {e}"))?;
    let target = root.join(task_name);
    if target.exists() {
        return Err("worktree_path_exists".to_string());
    }
    if !target.starts_with(&root) {
        return Err("worktree_path_escape".to_string());
    }
    Ok(target)
}

// 在指定目录执行真实 Git，隐藏 Windows 窗口并收集输出与退出状态。
fn run_git_raw<I, S>(cwd: &Path, args: I) -> Result<GitCommandOutput, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    if !cwd.exists() {
        return Err("path_not_found".to_string());
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).args(args);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("spawn_failed: {e}")
        }
    })?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

// 执行 Git 并检查退出状态，失败时返回截断的错误内容。
fn run_git_checked<I, S>(cwd: &Path, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_raw(cwd, args)?;
    if output.success {
        Ok(output.combined())
    } else {
        let combined = output.combined();
        let snippet: String = combined.chars().take(300).collect();
        Err(format!("git_failed: {snippet}"))
    }
}

// 识别权限、文件占用和资源忙等可重试的删除错误。
fn is_retryable_worktree_remove_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("permission denied")
        || normalized.contains("failed to delete")
        || normalized.contains("unable to unlink")
        || normalized.contains("being used by another process")
        || normalized.contains("os error 32")
        || normalized.contains("device or resource busy")
}

// 识别工作树注册或 .git 指针失效导致的删除错误。
fn is_stale_worktree_remove_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("is not a working tree")
        || normalized.contains("validation failed, cannot remove working tree")
        || (normalized.contains(".git") && normalized.contains("does not exist"))
        || normalized.contains("gitdir file points to non-existent location")
}

// 强制移除工作树，对可重试的文件占用错误最多追加五次重试。
fn run_git_worktree_remove_with_retry(
    project_path: &Path,
    target_arg: &str,
) -> Result<String, String> {
    let mut last_error = String::new();
    for attempt in 0..=WORKTREE_REMOVE_RETRY_ATTEMPTS {
        match run_git_checked(project_path, ["worktree", "remove", "--force", target_arg]) {
            Ok(output) => return Ok(output),
            Err(err)
                if attempt < WORKTREE_REMOVE_RETRY_ATTEMPTS
                    && is_retryable_worktree_remove_error(&err) =>
            {
                last_error = err;
                thread::sleep(Duration::from_millis(WORKTREE_REMOVE_RETRY_DELAY_MS));
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_error)
}

// 将非空输出修剪后按行追加到已有结果。
fn append_output_line(output: &mut String, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(trimmed);
}

// 调用删除函数并重试可恢复错误，将目标已不存在视为成功。
fn remove_worktree_path_with_retry<F>(target_path: &Path, mut remove: F) -> Result<(), String>
where
    F: FnMut(&Path) -> io::Result<()>,
{
    let mut last_error = String::new();
    for attempt in 0..=WORKTREE_REMOVE_RETRY_ATTEMPTS {
        match remove(target_path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err)
                if attempt < WORKTREE_REMOVE_RETRY_ATTEMPTS
                    && is_retryable_worktree_remove_error(&err.to_string()) =>
            {
                last_error = err.to_string();
                thread::sleep(Duration::from_millis(WORKTREE_REMOVE_RETRY_DELAY_MS));
            }
            Err(err) => return Err(format!("remove_stale_worktree_dir_failed: {err}")),
        }
    }
    Err(format!("remove_stale_worktree_dir_failed: {last_error}"))
}

// 递归清理已登记的失效工作树目录，将目录缺失视为已完成。
fn remove_registered_stale_worktree_dir(target_path: &Path) -> Result<String, String> {
    if !target_path.exists() {
        return Ok("stale_registered_worktree_path_missing".to_string());
    }
    if !target_path.is_dir() {
        return Err("worktree_path_not_directory".to_string());
    }
    remove_worktree_path_with_retry(target_path, |path| fs::remove_dir_all(path))?;
    Ok("removed_stale_registered_worktree_dir".to_string())
}

// 清理已登记的失效工作树目录后执行 Git 注册信息清理。
fn cleanup_registered_stale_worktree_path(
    project_path: &Path,
    target_path: &Path,
) -> Result<String, String> {
    let mut output = remove_registered_stale_worktree_dir(target_path)?;
    append_output_line(
        &mut output,
        &run_git_checked(project_path, ["worktree", "prune"])?,
    );
    Ok(output)
}

// 通过完整本地分支引用判断分支是否存在。
fn branch_exists(project_path: &Path, branch: &str) -> Result<bool, String> {
    let branch_ref = format!("refs/heads/{branch}");
    let output = run_git_raw(project_path, ["rev-parse", "--verify", branch_ref.as_str()])?;
    Ok(output.success)
}

// 比较两个分支的文件名差异，判断是否存在内容差异。
fn has_branch_content_diff(
    project_path: &Path,
    base_branch: &str,
    worktree_branch: &str,
) -> Result<bool, String> {
    let output = run_git_checked(
        project_path,
        ["diff", "--name-only", base_branch, worktree_branch],
    )?;
    Ok(output.lines().any(|line| !line.trim().is_empty()))
}

// 仅允许清理本次添加前不存在且符合 wt/ 规则的分支。
fn should_cleanup_worktree_branch_after_failed_add(
    branch: &str,
    branch_existed_before_add: bool,
) -> bool {
    !branch_existed_before_add && validate_worktree_branch(branch).is_ok()
}

// 工作树添加失败后尽力删除本次新建的合法工作树分支。
fn cleanup_worktree_branch_after_failed_add(
    project_path: &Path,
    branch: &str,
    branch_existed_before_add: bool,
) {
    if !should_cleanup_worktree_branch_after_failed_add(branch, branch_existed_before_add) {
        return;
    }
    let _ = run_git_raw(project_path, ["branch", "-D", branch]);
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorktreeListEntry {
    path: PathBuf,
    branch: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorktreeRegistration {
    Matched,
    Mismatched,
    Missing,
}

// 解析 porcelain 工作树列表中的路径与本地分支对应关系。
fn parse_worktree_list_entries(output: &str) -> Vec<WorktreeListEntry> {
    let mut entries = Vec::new();
    let mut current_path: Option<PathBuf> = None;
    let mut current_branch: Option<String> = None;

    let flush = |entries: &mut Vec<WorktreeListEntry>,
                 path: &mut Option<PathBuf>,
                 branch: &mut Option<String>| {
        if let Some(path) = path.take() {
            entries.push(WorktreeListEntry {
                path,
                branch: branch.take(),
            });
        } else {
            let _ = branch.take();
        }
    };

    for line in output.lines() {
        if line.trim().is_empty() {
            flush(&mut entries, &mut current_path, &mut current_branch);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut entries, &mut current_path, &mut current_branch);
            current_path = Some(PathBuf::from(path));
            continue;
        }
        if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(branch.to_string());
        }
    }
    flush(&mut entries, &mut current_path, &mut current_branch);
    entries
}

// 尽力规范化路径并统一分隔符，在 Windows 下忽略大小写。
fn normalize_path_for_compare(path: &Path) -> String {
    let normalized_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut value = normalized_path.to_string_lossy().replace('\\', "/");
    while value.ends_with('/') && value.len() > 1 {
        value.pop();
    }
    if cfg!(target_os = "windows") {
        value.to_lowercase()
    } else {
        value
    }
}

// 按路径和分支的联合匹配区分登记吻合、错配与缺失。
fn classify_worktree_registration(
    entries: &[WorktreeListEntry],
    worktree_path: &Path,
    branch: &str,
) -> WorktreeRegistration {
    let target = normalize_path_for_compare(worktree_path);
    let mut path_found = false;
    let mut branch_found = false;

    for registered in entries {
        let same_path = normalize_path_for_compare(&registered.path) == target;
        let same_branch = registered.branch.as_deref() == Some(branch);
        if same_path && same_branch {
            return WorktreeRegistration::Matched;
        }
        path_found |= same_path;
        branch_found |= same_branch;
    }

    if path_found || branch_found {
        WorktreeRegistration::Mismatched
    } else {
        WorktreeRegistration::Missing
    }
}

// 读取 Git 工作树登记列表并分类指定路径与分支的对应关系。
fn worktree_registration(
    project_path: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<WorktreeRegistration, String> {
    let output = run_git_checked(project_path, ["worktree", "list", "--porcelain"])?;
    Ok(classify_worktree_registration(
        &parse_worktree_list_entries(&output),
        worktree_path,
        branch,
    ))
}

// 读取目录首个条目，判断失效工作树目录是否为空。
fn is_empty_dir(path: &Path) -> Result<bool, String> {
    let mut entries =
        fs::read_dir(path).map_err(|e| format!("read_stale_worktree_dir_failed: {e}"))?;
    Ok(entries.next().is_none())
}

/// worktree 移除后，若其所在的根目录（如 `<project>-worktrees`）已空，顺手清掉，
/// 避免（尤其是批量）删除后残留一个空文件夹。`fs::remove_dir` 仅能删空目录，
/// 非空/出错都安全忽略；git 下次 `worktree add` 会通过 create_dir_all 自动重建根目录。
// 工作树移除后尽力删除已空的父目录，保留非空父目录。
fn cleanup_empty_worktree_parent(worktree_path: &Path) {
    if let Some(parent) = worktree_path.parent() {
        if is_empty_dir(parent).unwrap_or(false) {
            let _ = fs::remove_dir(parent);
        }
    }
}

// 仅清理未登记的空目录或缺失登记，并按请求删除残留分支。
fn cleanup_stale_unregistered_worktree(
    project_path: &Path,
    target_path: &Path,
    branch: &str,
    delete_branch: bool,
) -> Result<String, String> {
    let mut output = String::new();
    if target_path.exists() {
        if !target_path.is_dir() || !is_empty_dir(target_path)? {
            return Err("worktree_not_registered".to_string());
        }
        remove_worktree_path_with_retry(target_path, |path| fs::remove_dir(path))?;
        output.push_str("removed_stale_empty_worktree_dir");
    } else {
        output.push_str(&run_git_checked(project_path, ["worktree", "prune"])?);
    }

    if delete_branch && branch_exists(project_path, branch)? {
        append_output_line(
            &mut output,
            &run_git_checked(project_path, ["branch", "-D", branch])?,
        );
    }

    Ok(output.trim().to_string())
}

// 按锁文件及依赖目录判断是否建议安装 Node 或 Rust 依赖。
fn check_dependency_need(path: &Path) -> GitWorktreeDepsCheckResult {
    let node_modules_missing = !path.join("node_modules").exists();
    if path.join("pnpm-lock.yaml").exists() && node_modules_missing {
        return GitWorktreeDepsCheckResult {
            needs_install: true,
            command: Some("pnpm install".to_string()),
            reason: Some("pnpm-lock.yaml exists but node_modules is missing".to_string()),
        };
    }
    if path.join("yarn.lock").exists() && node_modules_missing {
        return GitWorktreeDepsCheckResult {
            needs_install: true,
            command: Some("yarn install".to_string()),
            reason: Some("yarn.lock exists but node_modules is missing".to_string()),
        };
    }
    if (path.join("package-lock.json").exists() || path.join("package.json").exists())
        && node_modules_missing
    {
        return GitWorktreeDepsCheckResult {
            needs_install: true,
            command: Some("npm install".to_string()),
            reason: Some("package.json exists but node_modules is missing".to_string()),
        };
    }
    if path.join("Cargo.toml").exists() && !path.join("target").exists() {
        return GitWorktreeDepsCheckResult {
            needs_install: true,
            command: Some("cargo fetch".to_string()),
            reason: Some("Cargo.toml exists but target is missing".to_string()),
        };
    }

    GitWorktreeDepsCheckResult {
        needs_install: false,
        command: None,
        reason: None,
    }
}

// 读取未合并文件名列表，命令启动失败时返回空列表。
fn conflict_files(project_path: &Path) -> Vec<String> {
    match run_git_raw(project_path, ["diff", "--name-only", "--diff-filter=U"]) {
        Ok(output) => output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToString::to_string)
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
// 在线程池检查路径是否为支持的本地主仓库根目录。
pub async fn git_worktree_validate(project_path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        if is_wsl_path(&project_path) {
            return Ok(false);
        }
        let path = local_path_from_input(&project_path);
        if !path.exists() || !path.is_dir() {
            return Ok(false);
        }
        Ok(open_main_repo(&project_path).is_ok())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 基于当前 HEAD 创建 wt/ 分支工作树，并尽力同步 Trellis 身份。
pub async fn git_worktree_create(
    req: GitWorktreeCreateRequest,
) -> Result<GitWorktreeCreateResult, String> {
    let task_name = validate_task_name(&req.task_name)?;
    tokio::task::spawn_blocking(move || {
        let repo = open_main_repo(&req.project_path)?;
        let base_branch = current_branch_name(&repo)?;
        let project_path = local_path_from_input(&req.project_path)
            .canonicalize()
            .map_err(|e| format!("canonicalize_project_path_failed: {e}"))?;
        let target_path =
            resolve_worktree_target_path(&project_path, &task_name, req.worktree_root.as_deref())?;
        let branch = format!("{WORKTREE_BRANCH_PREFIX}{task_name}");
        validate_worktree_branch(&branch)?;
        let branch_existed_before_add = branch_exists(&project_path, &branch)?;

        let target_arg = path_to_git_arg(&target_path);
        let add_output = run_git_raw(
            &project_path,
            [
                "worktree",
                "add",
                "-b",
                branch.as_str(),
                target_arg.as_str(),
                "HEAD",
            ],
        )?;
        if !add_output.success {
            cleanup_worktree_branch_after_failed_add(
                &project_path,
                &branch,
                branch_existed_before_add,
            );
            let snippet = git_create_error_snippet(&add_output.combined());
            return Err(format!("git_failed: {snippet}"));
        }

        seed_trellis_developer_identity(&project_path, &target_path);

        Ok(GitWorktreeCreateResult {
            name: task_name,
            branch,
            path: path_to_git_arg(&target_path),
            base_branch,
        })
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 校验工作树为受支持的本地目录后返回依赖安装建议。
pub async fn git_worktree_check_deps(
    worktree_path: String,
) -> Result<GitWorktreeDepsCheckResult, String> {
    ensure_supported_local_path(&worktree_path)?;
    tokio::task::spawn_blocking(move || {
        let path = local_path_from_input(&worktree_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        if !path.is_dir() {
            return Err("path_not_directory".to_string());
        }
        Ok(check_dependency_need(&path))
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 检查主工作区清洁和分支差异后合并工作树分支，冲突时尝试中止。
pub async fn git_worktree_merge(
    project_path: String,
    worktree_branch: String,
    base_branch: String,
) -> Result<GitWorktreeMergeResult, String> {
    validate_worktree_branch(&worktree_branch)?;
    validate_plain_branch_name(&base_branch)?;
    tokio::task::spawn_blocking(move || {
        let repo = open_main_repo(&project_path)?;
        let current_branch = current_branch_name(&repo)?;
        let project_path = local_path_from_input(&project_path)
            .canonicalize()
            .map_err(|e| format!("canonicalize_project_path_failed: {e}"))?;

        let status = run_git_checked(&project_path, ["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            return Err("dirty_main_worktree".to_string());
        }
        if !branch_exists(&project_path, &base_branch)? {
            return Err("branch_not_found".to_string());
        }
        if !branch_exists(&project_path, &worktree_branch)? {
            return Err("worktree_branch_not_found".to_string());
        }
        if !has_branch_content_diff(&project_path, &base_branch, &worktree_branch)? {
            return Ok(GitWorktreeMergeResult {
                merged: false,
                output: format!(
                    "merge_skipped: no_diff_between {} and {}",
                    base_branch, worktree_branch
                ),
                conflict_files: Vec::new(),
                skipped: true,
                skip_reason: Some("no_diff".to_string()),
            });
        }
        if current_branch != base_branch {
            run_git_checked(&project_path, ["checkout", base_branch.as_str()])?;
        }

        let merge_output = run_git_raw(
            &project_path,
            ["merge", "--no-ff", "--no-edit", worktree_branch.as_str()],
        )?;
        if merge_output.success {
            return Ok(GitWorktreeMergeResult {
                merged: true,
                output: merge_output.combined(),
                conflict_files: Vec::new(),
                skipped: false,
                skip_reason: None,
            });
        }

        let files = conflict_files(&project_path);
        if !files.is_empty() {
            let _ = run_git_raw(&project_path, ["merge", "--abort"]);
            return Ok(GitWorktreeMergeResult {
                merged: false,
                output: format!("merge_conflict: {}", merge_output.combined()),
                conflict_files: files,
                skipped: false,
                skip_reason: None,
            });
        }

        let _ = run_git_raw(&project_path, ["merge", "--abort"]);
        let snippet: String = merge_output.combined().chars().take(300).collect();
        Err(format!("merge_failed: {snippet}"))
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
// 核对工作树路径与分支登记后删除工作树，并按请求清理分支和空父目录。
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    branch: String,
    delete_branch: bool,
) -> Result<String, String> {
    validate_worktree_branch(&branch)?;
    ensure_supported_local_path(&worktree_path)?;
    tokio::task::spawn_blocking(move || {
        open_main_repo(&project_path)?;
        let project_path = local_path_from_input(&project_path)
            .canonicalize()
            .map_err(|e| format!("canonicalize_project_path_failed: {e}"))?;
        let target_path = local_path_from_input(&worktree_path);
        if !target_path.is_absolute() {
            return Err("worktree_path_not_absolute".to_string());
        }
        match worktree_registration(&project_path, &target_path, &branch)? {
            WorktreeRegistration::Matched => {}
            WorktreeRegistration::Mismatched => {
                return Err("worktree_branch_mismatch".to_string());
            }
            WorktreeRegistration::Missing => {
                let output = cleanup_stale_unregistered_worktree(
                    &project_path,
                    &target_path,
                    &branch,
                    delete_branch,
                )?;
                cleanup_empty_worktree_parent(&target_path);
                return Ok(output);
            }
        }

        let target_arg = path_to_git_arg(&target_path);
        let mut output = String::new();
        if target_path.exists() {
            match run_git_worktree_remove_with_retry(&project_path, target_arg.as_str()) {
                Ok(remove_output) => output.push_str(&remove_output),
                Err(err) if is_stale_worktree_remove_error(&err) => {
                    output.push_str(&cleanup_registered_stale_worktree_path(
                        &project_path,
                        &target_path,
                    )?);
                }
                Err(err) => return Err(err),
            }
        } else {
            output.push_str(&run_git_checked(&project_path, ["worktree", "prune"])?);
        }

        if delete_branch {
            append_output_line(
                &mut output,
                &run_git_checked(&project_path, ["branch", "-D", branch.as_str()])?,
            );
        }

        cleanup_empty_worktree_parent(&target_path);

        Ok(output.trim().to_string())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        check_dependency_need, classify_worktree_registration, cleanup_empty_worktree_parent,
        cleanup_stale_unregistered_worktree, default_worktree_root, git_create_error_snippet,
        is_retryable_worktree_remove_error, is_stale_worktree_remove_error,
        parse_worktree_list_entries, path_to_git_arg, remove_registered_stale_worktree_dir,
        remove_worktree_path_with_retry, resolve_worktree_target_path,
        seed_trellis_developer_identity, should_cleanup_worktree_branch_after_failed_add,
        validate_plain_branch_name, validate_task_name, validate_worktree_branch,
        WorktreeRegistration,
    };
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    #[test]
    // 验证任务名的空值、长度、字符和 Windows 保留名称限制。
    fn validates_task_names() {
        assert_eq!(
            validate_task_name("task-0705_1200").unwrap(),
            "task-0705_1200"
        );
        assert_eq!(validate_task_name("").unwrap_err(), "task_name_empty");
        assert_eq!(validate_task_name("-bad").unwrap_err(), "task_name_invalid");
        assert_eq!(
            validate_task_name("bad/name").unwrap_err(),
            "task_name_invalid"
        );
        assert_eq!(
            validate_task_name("bad name").unwrap_err(),
            "task_name_invalid"
        );
        assert_eq!(validate_task_name("con").unwrap_err(), "task_name_reserved");
        assert_eq!(
            validate_task_name(&"a".repeat(65)).unwrap_err(),
            "task_name_too_long"
        );
    }

    #[test]
    // 验证工作树分支必须具有 wt/ 前缀和合法任务后缀。
    fn validates_worktree_branch_prefix() {
        assert!(validate_worktree_branch("wt/task-1").is_ok());
        assert_eq!(
            validate_worktree_branch("feature/task-1").unwrap_err(),
            "branch_not_worktree"
        );
        assert_eq!(
            validate_worktree_branch("wt/bad/name").unwrap_err(),
            "task_name_invalid"
        );
    }

    #[test]
    // 验证大量检出进度不会挤掉末尾的 Git 致命错误。
    fn keeps_final_git_error_after_checkout_progress() {
        let output = format!(
            "Preparing worktree\r{}fatal: unable to checkout files",
            "Checking out files: 30%\r".repeat(30)
        );
        let snippet = git_create_error_snippet(&output);
        assert!(snippet.contains("fatal: unable to checkout files"));
    }

    #[test]
    // 验证常见权限与文件占用错误可重试，而无关错误不可重试。
    fn detects_retryable_worktree_remove_errors() {
        assert!(is_retryable_worktree_remove_error(
            "git_failed: error: failed to delete 'task-1': Permission denied"
        ));
        assert!(is_retryable_worktree_remove_error(
            "fatal: unable to unlink old-file: Device or resource busy"
        ));
        assert!(is_retryable_worktree_remove_error(
            "The process cannot access the file because it is being used by another process"
        ));
        assert!(is_retryable_worktree_remove_error(
            "remove_stale_worktree_dir_failed: 另一个程序正在使用此文件，进程无法访问。 (os error 32)"
        ));
        assert!(!is_retryable_worktree_remove_error(
            "git_failed: branch not found"
        ));
    }

    #[test]
    // 验证失效工作树登记错误与普通权限错误的区别。
    fn detects_stale_worktree_remove_errors() {
        assert!(is_stale_worktree_remove_error(
            "git_failed: fatal: 'F:\\repo\\worktrees\\task-1' is not a working tree"
        ));
        assert!(is_stale_worktree_remove_error(
            "git_failed: fatal: validation failed, cannot remove working tree: 'C:/repo/wt/.git' does not exist"
        ));
        assert!(is_stale_worktree_remove_error(
            "prunable gitdir file points to non-existent location"
        ));
        assert!(!is_stale_worktree_remove_error(
            "git_failed: error: failed to delete 'task-1': Permission denied"
        ));
    }

    #[test]
    // 验证默认工作树根目录位于项目同级并带固定后缀。
    fn computes_default_worktree_root_next_to_project() {
        let project_path = Path::new("/repo/demo-app");
        let root = default_worktree_root(project_path).unwrap();
        assert_eq!(root, PathBuf::from("/repo/demo-app-worktrees"));
    }

    #[test]
    // 验证自定义工作树根目录被创建且目标位于规范化根目录下。
    fn resolves_target_path_under_custom_root() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let root = temp.path().join("custom-root");
        fs::create_dir_all(&project).unwrap();
        let target =
            resolve_worktree_target_path(&project, "task-1", Some(root.to_str().unwrap())).unwrap();
        assert_eq!(target, root.canonicalize().unwrap().join("task-1"));
    }

    #[test]
    // 验证 Git 路径参数移除两种 Windows 扩展路径前缀。
    fn git_path_args_do_not_keep_windows_extended_prefix() {
        assert_eq!(
            path_to_git_arg(Path::new("\\\\?\\D:\\repo\\worktrees\\task-1")),
            "D:\\repo\\worktrees\\task-1"
        );
        assert_eq!(
            path_to_git_arg(Path::new("//?/D:/repo/worktrees/task-1")),
            "D:/repo/worktrees/task-1"
        );
    }

    #[test]
    // 验证添加失败时只允许清理新建的合法工作树分支。
    fn cleanup_after_failed_add_is_limited_to_new_wt_branches() {
        assert!(should_cleanup_worktree_branch_after_failed_add(
            "wt/task-1",
            false
        ));
        assert!(!should_cleanup_worktree_branch_after_failed_add(
            "wt/task-1",
            true
        ));
        assert!(!should_cleanup_worktree_branch_after_failed_add(
            "main", false
        ));
        assert!(!should_cleanup_worktree_branch_after_failed_add(
            "feature/task-1",
            false
        ));
    }

    #[test]
    // 验证基础分支名允许普通层级名称并拒绝危险片段。
    fn validates_base_branch_names() {
        assert!(validate_plain_branch_name("main").is_ok());
        assert!(validate_plain_branch_name("release/1.0").is_ok());
        assert_eq!(
            validate_plain_branch_name("-bad").unwrap_err(),
            "base_branch_invalid"
        );
        assert_eq!(
            validate_plain_branch_name("bad branch").unwrap_err(),
            "base_branch_invalid"
        );
        assert_eq!(
            validate_plain_branch_name("bad..branch").unwrap_err(),
            "base_branch_invalid"
        );
    }

    #[test]
    // 验证 porcelain 工作树列表解析路径和分支。
    fn parses_porcelain_worktree_entries() {
        let output = "worktree C:/repo/main\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo/wt/task\nHEAD def\nbranch refs/heads/wt/task\n";
        let entries = parse_worktree_list_entries(output);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].path, PathBuf::from("C:/repo/wt/task"));
        assert_eq!(entries[1].branch.as_deref(), Some("wt/task"));
    }

    #[test]
    // 验证路径与分支联合匹配、单项错配及双项缺失的分类。
    fn classifies_worktree_registration() {
        let entries = parse_worktree_list_entries(
            "worktree C:/repo/main\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo/wt/task\nHEAD def\nbranch refs/heads/wt/task\n",
        );
        assert_eq!(
            classify_worktree_registration(&entries, Path::new("C:/repo/wt/task"), "wt/task"),
            WorktreeRegistration::Matched
        );
        assert_eq!(
            classify_worktree_registration(&entries, Path::new("C:/repo/wt/task"), "wt/other"),
            WorktreeRegistration::Mismatched
        );
        assert_eq!(
            classify_worktree_registration(&entries, Path::new("C:/repo/wt/other"), "wt/task"),
            WorktreeRegistration::Mismatched
        );
        assert_eq!(
            classify_worktree_registration(&entries, Path::new("C:/repo/wt/missing"), "wt/missing"),
            WorktreeRegistration::Missing
        );
    }

    #[test]
    // 验证工作树父目录清理只删除空目录并保留兄弟工作树。
    fn cleanup_empty_worktree_parent_removes_only_empty_root() {
        let temp = tempfile::tempdir().unwrap();

        // 空根目录：删掉最后一个 worktree 后，根目录应被清理
        let root = temp.path().join("proj-worktrees");
        let wt = root.join("task-1");
        fs::create_dir_all(&wt).unwrap();
        fs::remove_dir(&wt).unwrap(); // 模拟 git 已移除该 worktree 目录
        cleanup_empty_worktree_parent(&wt);
        assert!(!root.exists());

        // 非空根目录（还有其它 worktree）：保持不动
        let root2 = temp.path().join("proj2-worktrees");
        let wt_a = root2.join("task-a");
        let wt_b = root2.join("task-b");
        fs::create_dir_all(&wt_a).unwrap();
        fs::create_dir_all(&wt_b).unwrap();
        fs::remove_dir(&wt_a).unwrap();
        cleanup_empty_worktree_parent(&wt_a);
        assert!(root2.exists());
        assert!(wt_b.exists());
    }

    #[test]
    // 验证主仓库的 Trellis 身份被复制到已有工作树配置目录。
    fn seeds_trellis_developer_identity_into_worktree() {
        let temp = tempfile::tempdir().unwrap();
        let main_repo = temp.path().join("main");
        let worktree = temp.path().join("wt");

        // 主仓库有 .trellis/.developer，worktree 也已存在 .trellis 目录
        fs::create_dir_all(main_repo.join(".trellis")).unwrap();
        fs::write(main_repo.join(".trellis").join(".developer"), "name=hxx").unwrap();
        fs::create_dir_all(worktree.join(".trellis")).unwrap();

        seed_trellis_developer_identity(&main_repo, &worktree);

        let dest = worktree.join(".trellis").join(".developer");
        assert!(dest.is_file());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "name=hxx");
    }

    #[test]
    // 验证主仓库缺少 Trellis 身份时不创建目标身份文件。
    fn seed_trellis_developer_identity_is_noop_when_source_missing() {
        let temp = tempfile::tempdir().unwrap();
        let main_repo = temp.path().join("main");
        let worktree = temp.path().join("wt");
        fs::create_dir_all(main_repo.join(".trellis")).unwrap();
        fs::create_dir_all(worktree.join(".trellis")).unwrap();

        // 主仓库自己都没初始化身份：不应创建目标文件
        seed_trellis_developer_identity(&main_repo, &worktree);
        assert!(!worktree.join(".trellis").join(".developer").exists());
    }

    #[test]
    // 验证同步 Trellis 身份不会覆盖工作树已有身份。
    fn seed_trellis_developer_identity_does_not_overwrite_existing() {
        let temp = tempfile::tempdir().unwrap();
        let main_repo = temp.path().join("main");
        let worktree = temp.path().join("wt");
        fs::create_dir_all(main_repo.join(".trellis")).unwrap();
        fs::write(main_repo.join(".trellis").join(".developer"), "name=main").unwrap();
        fs::create_dir_all(worktree.join(".trellis")).unwrap();
        fs::write(
            worktree.join(".trellis").join(".developer"),
            "name=existing",
        )
        .unwrap();

        // worktree 已有身份：保持不动
        seed_trellis_developer_identity(&main_repo, &worktree);
        assert_eq!(
            fs::read_to_string(worktree.join(".trellis").join(".developer")).unwrap(),
            "name=existing"
        );
    }

    #[test]
    // 验证未登记工作树只能清理空目录并保留非空目录。
    fn cleanup_stale_unregistered_worktree_removes_empty_dir_only() {
        let temp = tempfile::tempdir().unwrap();
        let empty = temp.path().join("empty");
        fs::create_dir(&empty).unwrap();
        let output =
            cleanup_stale_unregistered_worktree(temp.path(), &empty, "wt/task", false).unwrap();
        assert_eq!(output, "removed_stale_empty_worktree_dir");
        assert!(!empty.exists());

        let non_empty = temp.path().join("non-empty");
        fs::create_dir(&non_empty).unwrap();
        fs::write(non_empty.join("keep.txt"), "data").unwrap();
        assert_eq!(
            cleanup_stale_unregistered_worktree(temp.path(), &non_empty, "wt/task", false)
                .unwrap_err(),
            "worktree_not_registered"
        );
        assert!(non_empty.exists());
    }

    #[test]
    // 验证已登记失效工作树的清理函数可以删除非空临时目录。
    fn registered_stale_worktree_cleanup_can_remove_non_empty_dir() {
        let temp = tempfile::tempdir().unwrap();
        let stale = temp.path().join("stale");
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join("leftover.txt"), "data").unwrap();

        let output = remove_registered_stale_worktree_dir(&stale).unwrap();
        assert_eq!(output, "removed_stale_registered_worktree_dir");
        assert!(!stale.exists());
    }

    #[test]
    // 验证目录删除遇到模拟文件锁时重试，并在第三次成功。
    fn stale_worktree_path_remove_retries_windows_file_lock_errors() {
        let temp = tempfile::tempdir().unwrap();
        let stale = temp.path().join("stale");
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join("leftover.txt"), "data").unwrap();

        let mut attempts = 0;
        remove_worktree_path_with_retry(&stale, |path| {
            attempts += 1;
            if attempts < 3 {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "os error 32",
                ))
            } else {
                fs::remove_dir_all(path)
            }
        })
        .unwrap();

        assert_eq!(attempts, 3);
        assert!(!stale.exists());
    }

    #[test]
    // 验证缺少 Node 与 Rust 依赖目录时返回对应安装建议。
    fn detects_dependency_install_matrix() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), "{}").unwrap();
        let npm = check_dependency_need(temp.path());
        assert!(npm.needs_install);
        assert_eq!(npm.command.as_deref(), Some("npm install"));

        fs::create_dir(temp.path().join("node_modules")).unwrap();
        let none = check_dependency_need(temp.path());
        assert!(!none.needs_install);

        let cargo_dir = tempfile::tempdir().unwrap();
        fs::write(cargo_dir.path().join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        let cargo = check_dependency_need(cargo_dir.path());
        assert!(cargo.needs_install);
        assert_eq!(cargo.command.as_deref(), Some("cargo fetch"));
    }
}
