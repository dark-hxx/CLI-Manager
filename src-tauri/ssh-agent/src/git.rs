use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_REPOSITORIES: usize = 64;
const MAX_CHANGES: usize = 10_000;
const MAX_PATHS: usize = 512;
const MAX_PATH_BYTES: usize = 256 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub(super) const MAX_DIFF_BYTES: usize = 768 * 1024;
pub(super) const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

// 返回响应生成时的 Unix 毫秒时间；系统时钟早于纪元时使用零。
pub fn as_of_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListRepositoriesRequest {
    pub root_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathsRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub relative_path: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HunkRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub relative_path: String,
    pub diff_text: String,
    pub hunk_index: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedLine {
    pub side: String,
    pub line_number: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinesRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub relative_path: String,
    pub diff_text: String,
    pub selected_lines: Vec<SelectedLine>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitPathsRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub message: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub set_upstream: bool,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckoutRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub branch: String,
    pub remote: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBranchRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub branch: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub strategy: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub operation: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRefCompareRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub base_ref: String,
    #[serde(default)]
    pub target_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitAdvancedOperationRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub operation: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitPatchRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub commit_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub repo_id: String,
    pub relative_path: String,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub added: i32,
    pub deleted: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub has_upstream: bool,
    pub detached: bool,
    pub pending_op: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub branch_type: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub remote: Option<String>,
}

pub(super) struct GitOutput {
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
}

// 检测参数中的 NUL、回车和换行，不承担完整路径或 Git 引用校验。
fn invalid_text(value: &str) -> bool {
    value.contains(['\0', '\r', '\n'])
}

// 校验绝对根路径并规范化为现存目录；拒绝反斜杠与上级段，不验证 Git 仓库身份。
fn resolve_root(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || !Path::new(value).is_absolute()
        || invalid_text(value)
        || value.contains('\\')
        || value.split('/').any(|part| part == "..")
    {
        return Err("remote_git_root_invalid".to_string());
    }
    let root = Path::new(value)
        .canonicalize()
        .map_err(|_| "remote_git_root_unavailable".to_string())?;
    if !root.is_dir() {
        return Err("remote_git_root_not_directory".to_string());
    }
    Ok(root)
}

// 检查相对路径的分隔符与路径段；是否允许空路径由调用方指定，不访问文件系统。
fn validate_relative(value: &str, allow_empty: bool) -> Result<String, String> {
    if (!allow_empty && value.is_empty())
        || invalid_text(value)
        || value.contains('\\')
        || Path::new(value).is_absolute()
        || (!value.is_empty()
            && value
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        return Err("remote_git_path_invalid".to_string());
    }
    Ok(value.to_string())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTagInfo {
    pub name: String,
    pub target: String,
    pub annotated: bool,
    pub message: String,
}

// 按非空相对路径规则校验仓库内路径，供 Diff、历史和工作区工具复用。
pub(super) fn validate_repo_relative_path(value: &str) -> Result<String, String> {
    validate_relative(value, false)
}

// 规范化根目录及其相对仓库目录并检查包含关系；目录是否为 Git 仓库留给 Git 判断。
pub(super) fn resolve_repo(root_path: &str, repo_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = resolve_root(root_path)?;
    let relative = validate_relative(repo_path, true)?;
    let repo = root
        .join(&relative)
        .canonicalize()
        .map_err(|_| "remote_git_repo_not_found".to_string())?;
    if !repo.starts_with(&root) || !repo.is_dir() {
        return Err("remote_git_repo_confined".to_string());
    }
    Ok((root, repo))
}

// 检查非空相对文件路径，并要求规范化后的父目录位于仓库内；不解析目标文件本身。
pub(super) fn validate_file_path(repo: &Path, value: &str) -> Result<String, String> {
    let value = validate_repo_relative_path(value)?;
    let candidate = repo.join(&value);
    let parent = candidate
        .parent()
        .ok_or_else(|| "remote_git_path_invalid".to_string())?
        .canonicalize()
        .map_err(|_| "remote_git_path_invalid".to_string())?;
    let repo = repo
        .canonicalize()
        .map_err(|_| "remote_git_repo_not_found".to_string())?;
    if !parent.starts_with(&repo) {
        return Err("remote_git_path_confined".to_string());
    }
    Ok(value)
}

// 限制路径数量及累计字节数，逐项检查父目录范围并按首次出现顺序去重。
fn validate_paths(repo: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err("remote_git_paths_invalid".to_string());
    }
    if paths.iter().map(String::len).sum::<usize>() > MAX_PATH_BYTES {
        return Err("remote_git_paths_invalid".to_string());
    }
    let mut result = Vec::with_capacity(paths.len());
    let mut seen = HashSet::new();
    for path in paths {
        let value = validate_file_path(repo, path)?;
        if seen.insert(value.clone()) {
            result.push(value);
        }
    }
    Ok(result)
}

// 先排除危险文本与超长分支名，再用 git check-ref-format --branch 验证格式。
fn validate_branch(repo: &Path, branch: &str) -> Result<(), String> {
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.len() > 256
        || invalid_text(branch)
        || branch.chars().any(|ch| ch.is_whitespace())
    {
        return Err("invalid_branch".to_string());
    }
    run_git(
        repo,
        &["check-ref-format", "--branch", branch],
        false,
        READ_TIMEOUT,
    )
    .map(|_| ())
    .map_err(|_| "invalid_branch".to_string())
}

// 构造指定仓库的 Git 参数，关闭 fsmonitor、未跟踪缓存、外部 Diff 与 Diff 分页。
fn command_args(repo: &Path, args: &[&str]) -> Vec<String> {
    let mut result = vec![
        "-C".to_string(),
        repo.to_string_lossy().into_owned(),
        "-c".to_string(),
        "core.fsmonitor=false".to_string(),
        "-c".to_string(),
        "core.untrackedCache=false".to_string(),
        "-c".to_string(),
        "diff.external=".to_string(),
        "-c".to_string(),
        "pager.diff=false".to_string(),
        "-c".to_string(),
        "core.quotepath=false".to_string(),
    ];
    result.extend(args.iter().map(|arg| (*arg).to_string()));
    result
}

// 以无标准输入模式调用共享 Git 执行器，沿用指定的交互策略和等待超时。
pub(super) fn run_git(
    repo: &Path,
    args: &[&str],
    write: bool,
    timeout: Duration,
) -> Result<GitOutput, String> {
    run_git_with_input(repo, args, None, write, timeout)
}

// 启动 Git 并并行收集输出，按轮询超时终止进程；write 仅切换交互环境，不代表授权。
// 输出读取不设容量上限，线程回收仍可能等待管道关闭；输入写入与读取错误未单独上报。
fn run_git_with_input(
    repo: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    write: bool,
    timeout: Duration,
) -> Result<GitOutput, String> {
    let mut command = Command::new("git");
    command.args(command_args(repo, args));
    command.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env("GIT_PAGER", "cat");
    command.env("GIT_EXTERNAL_DIFF", "");
    if write {
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("GCM_INTERACTIVE", "Never");
    } else {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            "remote_git_unavailable".to_string()
        }
    })?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            let data = input.to_vec();
            thread::spawn(move || {
                let _ = stdin.write_all(&data);
            });
        }
    }
    let stdout = child.stdout.take().ok_or("remote_git_stdout_missing")?;
    let stderr = child.stderr.take().ok_or("remote_git_stderr_missing")?;
    let stdout_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::Read::read_to_end(&mut std::io::BufReader::new(stdout), &mut bytes);
        bytes
    });
    let stderr_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::Read::read_to_end(&mut std::io::BufReader::new(stderr), &mut bytes);
        bytes
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err("remote_git_timeout".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => return Err("remote_git_command_failed".to_string()),
        }
    };
    let stdout = stdout_thread
        .join()
        .map_err(|_| "remote_git_output_failed")?;
    let stderr = stderr_thread
        .join()
        .map_err(|_| "remote_git_output_failed")?;
    if !status.success() {
        return Err(map_git_error(&stderr, &stdout));
    }
    Ok(GitOutput { stdout, stderr })
}

// 按 Git 输出中的特征文本映射稳定错误码；未命中时统一返回 git_failed。
fn map_git_error(stderr: &[u8], stdout: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr).to_string() + &String::from_utf8_lossy(stdout);
    let lower = text.to_lowercase();
    let code = if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("permission denied")
        || lower.contains("invalid username or password")
    {
        "auth_failed"
    } else if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("updates were rejected")
        || lower.contains("not possible to fast-forward")
        || lower.contains("divergent")
    {
        "not_fast_forward"
    } else if lower.contains("no upstream") || lower.contains("has no upstream") {
        "no_upstream"
    } else if lower.contains("would be overwritten") || lower.contains("please commit your changes")
    {
        "checkout_conflict"
    } else if lower.contains("conflict")
        || lower.contains("automatic merge failed")
        || lower.contains("could not apply")
        || lower.contains("fix conflicts")
    {
        "pull_conflict"
    } else if lower.contains("could not read from remote")
        || lower.contains("does not appear to be a git repository")
        || lower.contains("no configured push destination")
        || lower.contains("no such remote")
    {
        "no_remote"
    } else if lower.contains("not a git repository")
        || lower.contains("不是一个 git 仓库")
        || lower.contains("不是 git 仓库")
    {
        // 远端目录本身不是 Git 仓库：与 native/WSL 链路共用稳定错误码，前端渲染友好空态。
        "not_git_repository"
    } else {
        "git_failed"
    };
    code.to_string()
}

// 以有损 UTF-8 合并并裁剪 stdout/stderr；此处不进行凭据或路径脱敏。
fn output_text(output: GitOutput) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    text.trim().to_string()
}

// 解析 NUL 分隔的 porcelain v1 状态，合并冲突及暂存状态；重命名跳过源路径记录。
fn parse_status(bytes: &[u8]) -> Result<Vec<GitChange>, String> {
    let records: Vec<&[u8]> = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect();
    let mut result = Vec::new();
    let mut index = 0usize;
    while index < records.len() && result.len() < MAX_CHANGES {
        let record = records[index];
        index += 1;
        if record.len() < 4 {
            continue;
        }
        let x = record[0];
        let y = record[1];
        let path = String::from_utf8(record[3..].to_vec())
            .map_err(|_| "remote_git_status_invalid_utf8")?;
        if x == b'R' || x == b'C' {
            index = index.saturating_add(1);
        }
        let conflict =
            x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D');
        let (status, staged) = if conflict {
            ("C", false)
        } else if x == b'?' && y == b'?' {
            ("U", false)
        } else if x != b' ' {
            (
                match x {
                    b'A' => "A",
                    b'D' => "D",
                    b'R' | b'C' => "R",
                    _ => "M",
                },
                true,
            )
        } else {
            (
                match y {
                    b'D' => "D",
                    b'R' | b'C' => "R",
                    _ => "M",
                },
                false,
            )
        };
        result.push(GitChange {
            path,
            status: status.to_string(),
            staged,
            added: 0,
            deleted: 0,
        });
    }
    Ok(result)
}

// 解析 NUL 分隔的三列增删统计并按路径索引；无法解析的计数归零。
fn parse_numstat(bytes: &[u8]) -> HashMap<String, (i32, i32)> {
    let mut result = HashMap::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let text = String::from_utf8_lossy(record);
        let mut parts = text.splitn(3, '\t');
        let Some(added) = parts.next().and_then(parse_count) else {
            continue;
        };
        let Some(deleted) = parts.next().and_then(parse_count) else {
            continue;
        };
        let Some(path) = parts.next() else { continue };
        let path = path.replace('\\', "/");
        if !path.is_empty() {
            result.insert(path, (added, deleted));
        }
    }
    result
}

// 将 numstat 数字转为整数，二进制标记或无效文本按零处理。
fn parse_count(value: &str) -> Option<i32> {
    if value == "-" {
        Some(0)
    } else {
        value.parse().ok()
    }
}

// 仅将以斜杠结尾且内部存在 .git 标记的条目识别为嵌套仓库。
fn is_nested_repo_entry(repo: &Path, file_path: &str) -> bool {
    file_path.ends_with('/') && repo.join(file_path).join(".git").exists()
}

// 查询完整未跟踪文件状态并过滤嵌套仓库条目；较小结果尝试补充 HEAD Diff 统计，失败不阻断。
fn changes(request: RepoRequest) -> Result<Vec<GitChange>, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    // Match the local panel's recurse_untracked_dirs(true): normal mode collapses `test/c.txt`
    // into `test/`, which the shared file tree would misread as an empty file name.
    let status = run_git(
        &repo,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        false,
        READ_TIMEOUT,
    )?;
    let mut changes = parse_status(&status.stdout)?;
    changes.retain(|change| !is_nested_repo_entry(&repo, &change.path));
    if changes.len() <= 2000 {
        if let Ok(numstat) = run_git(
            &repo,
            &["diff", "--numstat", "-z", "HEAD", "--"],
            false,
            READ_TIMEOUT,
        ) {
            let stats = parse_numstat(&numstat.stdout);
            for change in &mut changes {
                if let Some((added, deleted)) = stats.get(&change.path) {
                    change.added = *added;
                    change.deleted = *deleted;
                }
            }
        }
    }
    Ok(changes)
}

// 汇总当前分支、待完成操作及上游差距；部分探测失败按 detached、无上游或零差距处理。
fn branch_status(request: RepoRequest) -> Result<GitBranchStatus, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let branch_output = run_git(
        &repo,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        false,
        READ_TIMEOUT,
    );
    let branch = branch_output.ok().and_then(|output| {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
    });
    let pending_op = git_dir(&repo).ok().and_then(|dir| {
        if dir.join("MERGE_HEAD").exists() {
            Some("merge".to_string())
        } else if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
            Some("rebase".to_string())
        } else if dir.join("CHERRY_PICK_HEAD").exists() {
            Some("cherry-pick".to_string())
        } else if dir.join("REVERT_HEAD").exists() {
            Some("revert".to_string())
        } else {
            None
        }
    });
    let Some(branch_name) = branch.clone() else {
        return Ok(GitBranchStatus {
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            has_upstream: false,
            detached: true,
            pending_op,
        });
    };
    let upstream = run_git(
        &repo,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        false,
        READ_TIMEOUT,
    )
    .ok()
    .and_then(|output| {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
    });
    let (ahead, behind) = upstream
        .as_ref()
        .and_then(|_| {
            run_git(
                &repo,
                &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
                false,
                READ_TIMEOUT,
            )
            .ok()
        })
        .and_then(|output| {
            let values: Vec<_> = String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .map(str::to_string)
                .collect();
            (values.len() == 2).then(|| {
                (
                    values[0].parse().unwrap_or(0),
                    values[1].parse().unwrap_or(0),
                )
            })
        })
        .unwrap_or((0, 0));
    Ok(GitBranchStatus {
        branch: Some(branch_name),
        upstream: upstream.clone(),
        ahead,
        behind,
        has_upstream: upstream.is_some(),
        detached: false,
        pending_op,
    })
}

// 查询 Git 元数据目录并转换为仓库相对或绝对路径；规范化失败时保留解析后的路径。
fn git_dir(repo: &Path) -> Result<PathBuf, String> {
    let output = run_git(repo, &["rev-parse", "--git-dir"], false, READ_TIMEOUT)?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let path = Path::new(&value);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo.join(path)
    };
    Ok(path.canonicalize().unwrap_or(path))
}

// 读取本地及远程分支，排除远程 HEAD 并排序；输出行数先受仓库数量常量限制。
fn branches(request: RepoRequest) -> Result<Vec<GitBranchInfo>, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let current = branch_status(request.clone())?.branch;
    let output = run_git(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname)\t%(HEAD)\t%(upstream:short)",
            "refs/heads",
            "refs/remotes",
        ],
        false,
        READ_TIMEOUT,
    )?;
    let mut result = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout)
        .lines()
        .take(MAX_REPOSITORIES)
    {
        let mut parts = line.split('\t');
        let ref_name = parts.next().unwrap_or_default();
        let (name, branch_type) = if let Some(value) = ref_name.strip_prefix("refs/heads/") {
            (value.to_string(), "local")
        } else if let Some(value) = ref_name.strip_prefix("refs/remotes/") {
            (value.to_string(), "remote")
        } else {
            continue;
        };
        if name.ends_with("/HEAD") {
            continue;
        }
        let _head_marker = parts.next();
        let upstream = parts
            .next()
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let remote = (branch_type == "remote")
            .then(|| name.split('/').next().unwrap_or_default().to_string());
        result.push(GitBranchInfo {
            current: branch_type == "local" && current.as_deref() == Some(name.as_str()),
            name,
            branch_type: branch_type.to_string(),
            upstream,
            remote,
        });
    }
    result.sort_by(|a, b| {
        a.branch_type
            .cmp(&b.branch_type)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(result)
}

// 在根目录内有限深度发现仓库并排序截断，逐个补充分支信息；分支探测失败保留空值。
fn list_repositories(request: ListRepositoriesRequest) -> Result<Vec<GitRepoInfo>, String> {
    let root = resolve_root(&request.root_path)?;
    let mut paths = Vec::new();
    walk_repositories(&root, &root, &mut paths, 0)?;
    paths.sort();
    paths.truncate(MAX_REPOSITORIES);
    Ok(paths
        .into_iter()
        .map(|relative_path| {
            let branch = branch_status(RepoRequest {
                root_path: root.display().to_string(),
                repo_path: relative_path.clone(),
            })
            .ok()
            .and_then(|status| status.branch);
            GitRepoInfo {
                repo_id: relative_path.clone(),
                relative_path,
                branch,
            }
        })
        .collect())
}

// 按深度和数量上限递归查找 .git 标记，跳过符号链接及常见生成目录；嵌套仓库不再深入。
fn walk_repositories(
    root: &Path,
    directory: &Path,
    paths: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > 3 || paths.len() >= MAX_REPOSITORIES {
        return Ok(());
    }
    if directory.join(".git").is_dir() || directory.join(".git").is_file() {
        let relative = directory
            .strip_prefix(root)
            .map_err(|_| "remote_git_path_confined")?
            .to_string_lossy()
            .replace('\\', "/");
        paths.push(relative);
        if depth > 0 {
            return Ok(());
        }
    }
    for entry in fs::read_dir(directory).map_err(|_| "remote_git_list_failed")? {
        let entry = entry.map_err(|_| "remote_git_list_failed")?;
        let file_type = entry.file_type().map_err(|_| "remote_git_list_failed")?;
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir()
            && !file_type.is_symlink()
            && !name.starts_with('.')
            && !["node_modules", "target", "dist", "build", "out", "vendor"]
                .contains(&name.as_str())
        {
            walk_repositories(root, &entry.path(), paths, depth + 1)?;
        }
    }
    Ok(())
}

// 把 Git 命令输出包装为带生成时间的写操作响应。
fn mutation(output: GitOutput) -> Value {
    json!({ "output": output_text(output), "asOf": as_of_ms() })
}

// 校验并去重指定路径后执行 add 或 reset HEAD，仅改变这些路径的暂存状态。
fn stage(request: PathsRequest, unstage: bool) -> Result<(), String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let paths = validate_paths(&repo, &request.paths)?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    let mut args = if unstage {
        vec!["reset", "HEAD", "--"]
    } else {
        vec!["add", "--"]
    };
    args.extend(refs);
    run_git(&repo, &args, true, WRITE_TIMEOUT).map(|_| ())
}

// 在选定目录范围执行 add -A 或 reset HEAD；不逐项枚举和校验文件路径。
fn stage_all(request: RepoRequest, unstage: bool) -> Result<(), String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    if unstage {
        run_git(&repo, &["reset", "HEAD", "--", "."], true, WRITE_TIMEOUT).map(|_| ())
    } else {
        run_git(&repo, &["add", "-A", "--", "."], true, WRITE_TIMEOUT).map(|_| ())
    }
}

// 按传入状态撤销单文件改动；未跟踪文件拒绝，新添加文件仅取消暂存，其余尝试 checkout 恢复。
fn discard(request: FileRequest) -> Result<(), String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let path = validate_file_path(&repo, &request.relative_path)?;
    if matches!(request.status.as_str(), "U" | "??") {
        return Err("untracked_not_supported".to_string());
    }
    if request.status == "A" {
        run_git(&repo, &["reset", "HEAD", "--", &path], true, WRITE_TIMEOUT).map(|_| ())
    } else {
        let _ = run_git(&repo, &["reset", "HEAD", "--", &path], true, WRITE_TIMEOUT);
        run_git(&repo, &["checkout", "--", &path], true, WRITE_TIMEOUT).map(|_| ())
    }
}

// 重新查询未跟踪路径后逐项删除非目录条目；中途失败不会恢复此前已经删除的文件。
fn delete_untracked(request: DeleteRequest) -> Result<(), String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let paths = validate_paths(&repo, &request.paths)?;
    let changes = changes(RepoRequest {
        root_path: request.root_path.clone(),
        repo_path: request.repo_path.clone(),
    })?;
    let untracked: HashSet<_> = changes
        .into_iter()
        .filter(|change| change.status == "U")
        .map(|change| change.path)
        .collect();
    for path in paths {
        if !untracked.contains(&path) {
            return Err("path_not_untracked".to_string());
        }
        let target = repo.join(&path);
        let metadata = fs::symlink_metadata(&target).map_err(|_| "path_not_untracked")?;
        if metadata.is_dir() {
            return Err("path_not_untracked".to_string());
        }
        fs::remove_file(target).map_err(|_| "remote_git_delete_failed")?;
    }
    Ok(())
}

// 限制补丁字节数并检查 ---/+++ 文件头与请求路径一致；不是完整补丁语法验证。
fn validate_patch(diff: &str, path: &str) -> Result<(), String> {
    if diff.is_empty() || diff.len() > MAX_DIFF_BYTES {
        return Err("remote_git_patch_invalid".to_string());
    }
    let mut found = false;
    for line in diff.lines() {
        if let Some(value) = line
            .strip_prefix("--- ")
            .or_else(|| line.strip_prefix("+++ "))
        {
            let value = value.split('\t').next().unwrap_or(value);
            if value == "/dev/null" {
                continue;
            }
            let value = value
                .strip_prefix("a/")
                .or_else(|| value.strip_prefix("b/"))
                .unwrap_or(value);
            if value != path {
                return Err("remote_git_patch_path_invalid".to_string());
            }
            found = true;
        }
    }
    if found {
        Ok(())
    } else {
        Err("remote_git_patch_invalid".to_string())
    }
}

// 解析统一 Diff 的旧、新范围与尾部标题；格式或数字无效时返回解析错误。
fn parse_hunk_header(header: &str) -> Result<(u32, u32, u32, u32, String), String> {
    let body = header.strip_prefix("@@ ").ok_or("bad_hunk_header")?;
    let close = body.find(" @@").ok_or("bad_hunk_header")?;
    let mut parts = body[..close].split(' ');
    let old = parse_range(
        parts
            .next()
            .and_then(|v| v.strip_prefix('-'))
            .ok_or("bad_hunk_header")?,
    )?;
    let new = parse_range(
        parts
            .next()
            .and_then(|v| v.strip_prefix('+'))
            .ok_or("bad_hunk_header")?,
    )?;
    Ok((old.0, old.1, new.0, new.1, body[close + 3..].to_string()))
}

// 解析 start,count 范围，省略 count 时按一行处理。
fn parse_range(value: &str) -> Result<(u32, u32), String> {
    if let Some((start, count)) = value.split_once(',') {
        Ok((
            start.parse().map_err(|_| "bad_range")?,
            count.parse().map_err(|_| "bad_range")?,
        ))
    } else {
        Ok((value.parse().map_err(|_| "bad_range")?, 1))
    }
}

// 交换 hunk 的新旧范围并翻转增删行前缀，保留上下文与其他标记。
fn reverse_hunk(hunk: &[&str]) -> Result<Vec<String>, String> {
    let (old_start, old_count, new_start, new_count, heading) =
        parse_hunk_header(hunk.first().ok_or("empty_hunk")?.trim_end_matches('\r'))?;
    let mut result = vec![format!(
        "@@ -{new_start},{new_count} +{old_start},{old_count} @@{heading}"
    )];
    for line in &hunk[1..] {
        if line.is_empty() {
            result.push(String::new());
            continue;
        }
        let rest = &line[1..];
        result.push(match line.as_bytes()[0] {
            b'+' => format!("-{rest}"),
            b'-' => format!("+{rest}"),
            _ => (*line).to_string(),
        });
    }
    Ok(result)
}

// 保留首个 hunk 之前的文件头，只选取指定序号的 hunk 生成反向补丁。
fn build_reverse_hunk_patch(diff: &str, index: usize) -> Result<String, String> {
    let lines: Vec<&str> = diff.split('\n').collect();
    let mut header = Vec::new();
    let mut cursor = 0;
    while cursor < lines.len() && !lines[cursor].starts_with("@@") {
        header.push(lines[cursor]);
        cursor += 1;
    }
    let mut hunks = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    while cursor < lines.len() {
        if lines[cursor].starts_with("@@") {
            if let Some(value) = current.take() {
                hunks.push(value);
            }
            current = Some(vec![lines[cursor]]);
        } else if let Some(value) = current.as_mut() {
            value.push(lines[cursor]);
        }
        cursor += 1;
    }
    if let Some(value) = current {
        hunks.push(value);
    }
    let hunk = hunks.get(index).ok_or("hunk_index_out_of_range")?;
    let mut output: Vec<String> = header.into_iter().map(str::to_string).collect();
    output.extend(reverse_hunk(hunk)?);
    Ok(format!("{}\n", output.join("\n")))
}

// 按旧侧/新侧行号反转选中的增删行并重算范围，未选新增行作为上下文；无命中返回空值。
fn reverse_hunk_lines(
    hunk: &[&str],
    selected: &HashSet<(String, u32)>,
) -> Result<Option<String>, String> {
    let (old_start, _, new_start, _, heading) =
        parse_hunk_header(hunk.first().ok_or("empty_hunk")?.trim_end_matches('\r'))?;
    let mut old_line = old_start;
    let mut new_line = new_start;
    let mut old_count = 0;
    let mut new_count = 0;
    let mut any = false;
    let mut body = Vec::new();
    for line in &hunk[1..] {
        if line.is_empty() {
            continue;
        }
        match line.as_bytes()[0] {
            b' ' => {
                body.push((*line).to_string());
                old_count += 1;
                new_count += 1;
                old_line += 1;
                new_line += 1;
            }
            b'-' => {
                let hit = selected.contains(&("old".to_string(), old_line));
                old_line += 1;
                if hit {
                    body.push(format!("+{}", &line[1..]));
                    new_count += 1;
                    any = true;
                }
            }
            b'+' => {
                let hit = selected.contains(&("new".to_string(), new_line));
                new_line += 1;
                if hit {
                    body.push(format!("-{}", &line[1..]));
                    old_count += 1;
                    any = true;
                } else {
                    body.push(format!(" {}", &line[1..]));
                    old_count += 1;
                    new_count += 1;
                }
            }
            _ => body.push((*line).to_string()),
        }
    }
    if !any {
        return Ok(None);
    }
    let mut output = vec![format!(
        "@@ -{new_start},{old_count} +{new_start},{new_count} @@{heading}"
    )];
    output.extend(body);
    Ok(Some(output.join("\n")))
}

// 按侧别和行号去重选中项，组合各 hunk 的局部反向补丁；没有实际命中时返回错误。
fn build_reverse_lines_patch(diff: &str, selected: &[SelectedLine]) -> Result<String, String> {
    let selected: HashSet<_> = selected
        .iter()
        .map(|line| (line.side.clone(), line.line_number))
        .collect();
    let lines: Vec<&str> = diff.split('\n').collect();
    let mut header = Vec::new();
    let mut cursor = 0;
    while cursor < lines.len() && !lines[cursor].starts_with("@@") {
        header.push(lines[cursor]);
        cursor += 1;
    }
    let mut hunks = Vec::new();
    let mut current = None;
    while cursor < lines.len() {
        if lines[cursor].starts_with("@@") {
            if let Some(value) = current.take() {
                hunks.push(value);
            }
            current = Some(vec![lines[cursor]]);
        } else if let Some(value) = current.as_mut() {
            value.push(lines[cursor]);
        }
        cursor += 1;
    }
    if let Some(value) = current {
        hunks.push(value);
    }
    let mut output: Vec<String> = header.into_iter().map(str::to_string).collect();
    let mut any = false;
    for hunk in &hunks {
        if let Some(value) = reverse_hunk_lines(hunk, &selected)? {
            output.push(value);
            any = true;
        }
    }
    if !any {
        return Err("no_lines_selected".to_string());
    }
    Ok(format!("{}\n", output.join("\n")))
}

// 先执行 git apply --check，再应用到工作区；两次命令之间不加锁，也不更新暂存区。
fn apply_patch(repo: &Path, patch: &str) -> Result<(), String> {
    run_git_with_input(
        repo,
        &["apply", "--check", "-"],
        Some(patch.as_bytes()),
        true,
        WRITE_TIMEOUT,
    )?;
    run_git_with_input(
        repo,
        &["apply", "-"],
        Some(patch.as_bytes()),
        true,
        WRITE_TIMEOUT,
    )
    .map(|_| ())
}

// 校验仓库、文件路径及补丁头后，将指定 hunk 的反向补丁应用到工作区。
fn revert_hunk(request: HunkRequest) -> Result<(), String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let path = validate_file_path(&repo, &request.relative_path)?;
    validate_patch(&request.diff_text, &path)?;
    apply_patch(
        &repo,
        &build_reverse_hunk_patch(&request.diff_text, request.hunk_index)?,
    )
}

// 拒绝空选择并校验路径及补丁头，将实际命中的选中行反向补丁应用到工作区。
fn revert_lines(request: LinesRequest) -> Result<(), String> {
    if request.selected_lines.is_empty() {
        return Err("no_lines_selected".to_string());
    }
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let path = validate_file_path(&repo, &request.relative_path)?;
    validate_patch(&request.diff_text, &path)?;
    apply_patch(
        &repo,
        &build_reverse_lines_patch(&request.diff_text, &request.selected_lines)?,
    )
}

// 校验提交消息和可选路径后执行提交，再查询短提交号；后续查询失败不会撤销已完成提交。
fn commit(request: CommitRequest, paths: Option<Vec<String>>) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let message = request.message.trim();
    if message.is_empty() || message.len() > MAX_MESSAGE_BYTES || message.contains('\0') {
        return Err("empty_message".to_string());
    }
    let paths = paths
        .map(|paths| validate_paths(&repo, &paths))
        .transpose()?;
    let mut args = vec!["commit", "-m", message];
    let path_refs;
    if let Some(paths) = paths.as_ref() {
        args.push("--");
        path_refs = paths.iter().map(String::as_str).collect::<Vec<_>>();
        args.extend(path_refs.iter().copied());
    }
    let output = run_git(&repo, &args, true, WRITE_TIMEOUT)?;
    let id = run_git(
        &repo,
        &["rev-parse", "--short", "HEAD"],
        false,
        READ_TIMEOUT,
    )?;
    let short_id = String::from_utf8_lossy(&id.stdout).trim().to_string();
    Ok(json!({ "output": output_text(output), "shortId": short_id, "asOf": as_of_ms() }))
}

// 在校验后的仓库执行给定参数，使用非交互写模式及网络操作超时；自身不限制命令种类。
fn network(request: RepoRequest, args: &[&str]) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    Ok(mutation(run_git(&repo, args, true, NETWORK_TIMEOUT)?))
}

// 排除空、超长、选项前缀和含空白/控制字符的引用文本；不验证引用存在或完整 Git 语法。
fn validate_ref(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value.starts_with('-')
        || invalid_text(value)
        || value.chars().any(char::is_whitespace)
    {
        return Err("invalid_git_ref".to_string());
    }
    Ok(())
}

// 在基本引用校验后解析为 commit 对象；解析失败统一映射为提交不存在。
fn validate_commit(repo: &Path, value: &str) -> Result<(), String> {
    validate_ref(value)?;
    let revision = format!("{value}^{{commit}}");
    run_git(
        repo,
        &["rev-parse", "--verify", &revision],
        false,
        READ_TIMEOUT,
    )
    .map(|_| ())
    .map_err(|_| "git_history_commit_not_found".to_string())
}

// 将受支持操作的 continue/abort 映射为固定参数，继续操作时禁用交互编辑器。
fn pending_operation_args(operation: &str, action: &str) -> Result<Vec<&'static str>, String> {
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

// 校验仓库后执行受支持的继续或中止操作，并返回输出及时间。
fn operation(request: OperationRequest, action: &str) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let args = pending_operation_args(&request.operation, action)?;
    Ok(mutation(run_git(&repo, &args, true, WRITE_TIMEOUT)?))
}

// 执行普通或远程跟踪检出；智能模式先 stash，再检出并 apply，失败仅尝试恢复且不删除 stash。
fn checkout(request: CheckoutRequest, smart: bool) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    validate_branch(&repo, &request.branch)?;
    let target: Vec<String> = if request.remote {
        vec![
            "checkout".to_string(),
            "--track".to_string(),
            request.branch.clone(),
        ]
    } else {
        vec!["checkout".to_string(), request.branch.clone()]
    };
    if !smart {
        return Ok(mutation(run_git(
            &repo,
            &target.iter().map(String::as_str).collect::<Vec<_>>(),
            true,
            WRITE_TIMEOUT,
        )?));
    }
    let message = format!("CLI-Manager smart checkout: {}", request.branch);
    let stash = run_git(
        &repo,
        &["stash", "push", "-u", "-m", &message],
        true,
        WRITE_TIMEOUT,
    )?;
    let stash_text = output_text(stash);
    if stash_text.to_lowercase().contains("no local changes") {
        return Err("smart_checkout_stash_empty".to_string());
    }
    if let Err(_error) = run_git(
        &repo,
        &target.iter().map(String::as_str).collect::<Vec<_>>(),
        true,
        WRITE_TIMEOUT,
    ) {
        let restore = run_git(&repo, &["stash", "apply", "stash@{0}"], true, WRITE_TIMEOUT);
        return match restore {
            Ok(_) => Err("smart_checkout_checkout_failed".to_string()),
            Err(_) => Err("smart_checkout_restore_failed".to_string()),
        };
    }
    let restore = run_git(&repo, &["stash", "apply", "stash@{0}"], true, WRITE_TIMEOUT)?;
    Ok(
        json!({ "output": format!("{stash_text}\n{}", output_text(restore)).trim(), "asOf": as_of_ms() }),
    )
}

// 按 merge、rebase 或 ff-only 白名单构造 pull 参数，在网络超时内执行。
fn pull(request: PullRequest) -> Result<Value, String> {
    let args: Vec<&str> = match request.strategy.as_str() {
        "merge" => vec!["pull", "--no-rebase", "--no-edit", "--autostash"],
        "rebase" => vec!["pull", "--rebase", "--autostash"],
        "ff-only" => vec!["pull", "--ff-only"],
        _ => return Err("invalid_strategy".to_string()),
    };
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    match run_git(&repo, &args, true, NETWORK_TIMEOUT) {
        Ok(output) => Ok(mutation(output)),
        Err(error) => Err(error),
    }
}

// 依据 Git 元数据中的 rebase 标记选择 rebase --abort，否则尝试 merge --abort。
fn pull_abort(request: RepoRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let directory = git_dir(&repo)?;
    let args: &[&str] =
        if directory.join("rebase-merge").exists() || directory.join("rebase-apply").exists() {
            &["rebase", "--abort"]
        } else {
            &["merge", "--abort"]
        };
    Ok(mutation(run_git(&repo, args, true, WRITE_TIMEOUT)?))
}

// 尝试按创建时间读取引用并解析标签字段；仅收集符合四列格式的输出，附加响应时间。
fn list_tags(request: RepoRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let separator = '\x1f';
    let format = format!(
        "--format=%(refname:short){separator}%(objectname){separator}%(objecttype){separator}%(subject)"
    );
    let output = run_git(
        &repo,
        &["for-each-ref", "--sort=-creatordate", &format, "refs/tags"],
        false,
        READ_TIMEOUT,
    )?;
    let tags = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let fields = line.splitn(4, separator).collect::<Vec<_>>();
            (fields.len() == 4 && !fields[0].is_empty()).then(|| GitTagInfo {
                name: fields[0].to_string(),
                target: fields[1].to_string(),
                annotated: fields[2] == "tag",
                message: fields[3].to_string(),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "tags": tags, "asOf": as_of_ms() }))
}

// 生成指定引用或三点范围的只读 Diff，读取完成后检查大小；响应不允许按 hunk 回滚。
fn compare_refs(request: GitRefCompareRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    validate_ref(&request.base_ref)?;
    if let Some(target) = request.target_ref.as_deref() {
        validate_ref(target)?;
    }
    let range = request
        .target_ref
        .as_deref()
        .map(|target| format!("{}...{target}", request.base_ref));
    let reference = range.as_deref().unwrap_or(&request.base_ref);
    let output = run_git(
        &repo,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            reference,
        ],
        false,
        READ_TIMEOUT,
    )?;
    if output.stdout.len() > MAX_DIFF_BYTES {
        return Err("git_diff_too_large".to_string());
    }
    let content = String::from_utf8_lossy(&output.stdout).into_owned();
    let line_count = content.lines().count();
    Ok(json!({
        "diff": {
            "content": content,
            "canRevertHunks": false,
            "byteLength": output.stdout.len(),
            "lineCount": line_count
        },
        "asOf": as_of_ms()
    }))
}

// 确认目标可解析为提交后导出含二进制内容的单提交邮件补丁，拒绝空结果或超过 4 MiB 的结果。
fn commit_patch(request: GitCommitPatchRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    validate_commit(&repo, &request.commit_id)?;
    let output = run_git(
        &repo,
        &[
            "format-patch",
            "-1",
            "--stdout",
            "--binary",
            &request.commit_id,
        ],
        false,
        READ_TIMEOUT,
    )?;
    if output.stdout.is_empty() || output.stdout.len() > 4 * 1024 * 1024 {
        return Err("git_patch_content_invalid".to_string());
    }
    Ok(json!({
        "content": String::from_utf8_lossy(&output.stdout).into_owned(),
        "asOf": as_of_ms()
    }))
}

// 按操作白名单校验参数并执行分支、标签或历史修改；force/hard 等模式会实际改变仓库，不提供事务回滚。
fn advanced_operation(request: GitAdvancedOperationRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let branch = request.branch.as_deref();
    let target = request.target.as_deref();
    let require_branch = || branch.ok_or_else(|| "branch_required".to_string());
    let require_target = || target.ok_or_else(|| "target_required".to_string());
    let output = match request.operation.as_str() {
        "create-branch" => {
            let name = require_branch()?;
            validate_branch(&repo, name)?;
            if let Some(base) = target {
                validate_ref(base)?;
                run_git(&repo, &["checkout", "-b", name, base], true, WRITE_TIMEOUT)?
            } else {
                run_git(&repo, &["checkout", "-b", name], true, WRITE_TIMEOUT)?
            }
        }
        "rename-branch" => {
            let old = require_branch()?;
            let new = require_target()?;
            validate_branch(&repo, old)?;
            validate_branch(&repo, new)?;
            run_git(&repo, &["branch", "-m", old, new], true, WRITE_TIMEOUT)?
        }
        "delete-branch" => {
            let name = require_branch()?;
            validate_branch(&repo, name)?;
            let flag = if request.mode.as_deref() == Some("force") {
                "-D"
            } else {
                "-d"
            };
            run_git(&repo, &["branch", flag, name], true, WRITE_TIMEOUT)?
        }
        "set-upstream" => {
            let name = require_branch()?;
            let upstream = require_target()?;
            validate_branch(&repo, name)?;
            validate_ref(upstream)?;
            run_git(
                &repo,
                &["branch", "--set-upstream-to", upstream, name],
                true,
                WRITE_TIMEOUT,
            )?
        }
        "merge" => {
            let name = require_branch()?;
            validate_ref(name)?;
            run_git(&repo, &["merge", "--no-edit", name], true, WRITE_TIMEOUT)?
        }
        "rebase" => {
            let name = require_branch()?;
            validate_ref(name)?;
            run_git(&repo, &["rebase", name], true, WRITE_TIMEOUT)?
        }
        "cherry-pick" => {
            let commit = require_target()?;
            validate_commit(&repo, commit)?;
            run_git(&repo, &["cherry-pick", commit], true, WRITE_TIMEOUT)?
        }
        "revert" => {
            let commit = require_target()?;
            validate_commit(&repo, commit)?;
            run_git(&repo, &["revert", "--no-edit", commit], true, WRITE_TIMEOUT)?
        }
        "reset" => {
            let commit = require_target()?;
            validate_commit(&repo, commit)?;
            let mode = match request.mode.as_deref() {
                Some("soft") => "--soft",
                Some("mixed") | None => "--mixed",
                Some("hard") => "--hard",
                _ => return Err("invalid_reset_mode".to_string()),
            };
            run_git(&repo, &["reset", mode, commit], true, WRITE_TIMEOUT)?
        }
        "create-tag" => {
            let tag = require_branch()?;
            let commit = require_target()?;
            validate_ref(tag)?;
            validate_commit(&repo, commit)?;
            run_git(&repo, &["tag", tag, commit], true, WRITE_TIMEOUT)?
        }
        "delete-tag" => {
            let tag = require_branch()?;
            validate_ref(tag)?;
            run_git(&repo, &["tag", "-d", tag], true, WRITE_TIMEOUT)?
        }
        _ => return Err("git_operation_invalid".to_string()),
    };
    Ok(mutation(output))
}

// 先委派工作区工具，再严格解码各 Git RPC 并路由到查询或写操作；未知类型返回稳定错误码。
pub fn dispatch(kind: &str, payload: Value) -> Result<Value, String> {
    if crate::git_tools::handles(kind) {
        return crate::git_tools::dispatch(kind, payload);
    }
    match kind {
        "gitListRepositories" => Ok(
            json!({ "repositories": list_repositories(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitChanges" => Ok(
            json!({ "changes": changes(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitDiff" => Ok(
            json!({ "diff": crate::git_diff::legacy_diff(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitDiffWithOptions" => Ok(
            json!({ "diff": crate::git_diff::diff_with_options(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitListCommits" | "gitListCommitsFiltered" => Ok(
            json!({ "page": crate::git_history::list_commits(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitCommitDetail" => Ok(
            json!({ "detail": crate::git_history::commit_detail(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitCommitFileDiff" => Ok(
            json!({ "diff": crate::git_history::commit_file_diff(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitBranchStatus" => Ok(
            json!({ "status": branch_status(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitBranches" => Ok(
            json!({ "branches": branches(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?, "asOf": as_of_ms() }),
        ),
        "gitTags" => {
            list_tags(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)
        }
        "gitCompareRefs" => {
            compare_refs(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)
        }
        "gitCommitPatch" => {
            commit_patch(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)
        }
        "gitExecuteOperation" => advanced_operation(
            serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
        ),
        "gitStage" => {
            stage(
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
                false,
            )?;
            Ok(json!({ "asOf": as_of_ms() }))
        }
        "gitUnstage" => {
            stage(
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
                true,
            )?;
            Ok(json!({ "asOf": as_of_ms() }))
        }
        "gitStageAll" => {
            stage_all(
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
                false,
            )?;
            Ok(json!({ "asOf": as_of_ms() }))
        }
        "gitUnstageAll" => {
            stage_all(
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
                true,
            )?;
            Ok(json!({ "asOf": as_of_ms() }))
        }
        "gitDiscardFile" => {
            discard(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)?;
            Ok(json!({ "asOf": as_of_ms() }))
        }
        "gitDeleteUntracked" => {
            delete_untracked(
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            )?;
            Ok(json!({ "asOf": as_of_ms() }))
        }
        "gitRevertHunk" => {
            revert_hunk(
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            )?;
            Ok(json!({ "asOf": as_of_ms() }))
        }
        "gitRevertLines" => {
            revert_lines(
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            )?;
            Ok(json!({ "asOf": as_of_ms() }))
        }
        "gitCommit" => commit(
            serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            None,
        ),
        "gitCommitPaths" => {
            let request: CommitPathsRequest =
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?;
            commit(
                CommitRequest {
                    root_path: request.root_path,
                    repo_path: request.repo_path,
                    message: request.message,
                },
                Some(request.paths),
            )
        }
        "gitFetch" => network(
            serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            &["fetch", "--prune"],
        ),
        "gitPush" => {
            let request: PushRequest =
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?;
            let repo_request = RepoRequest {
                root_path: request.root_path,
                repo_path: request.repo_path,
            };
            if request.set_upstream {
                let branch = request.branch.ok_or("empty_branch")?;
                let (_, repo) = resolve_repo(&repo_request.root_path, &repo_request.repo_path)?;
                validate_branch(&repo, &branch)?;
                network(repo_request, &["push", "-u", "origin", &branch])
            } else {
                network(repo_request, &["push"])
            }
        }
        "gitCheckout" => checkout(
            serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            false,
        ),
        "gitSmartCheckout" => checkout(
            serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            true,
        ),
        "gitCreateBranch" => {
            let request: CreateBranchRequest =
                serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?;
            let repo_request = RepoRequest {
                root_path: request.root_path,
                repo_path: request.repo_path,
            };
            let (_, repo) = resolve_repo(&repo_request.root_path, &repo_request.repo_path)?;
            validate_branch(&repo, &request.branch)?;
            network(repo_request, &["checkout", "-b", &request.branch])
        }
        "gitPull" => {
            pull(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)
        }
        "gitPullAbort" => {
            pull_abort(serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?)
        }
        "gitRebaseContinue" => network(
            serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            &["-c", "core.editor=true", "rebase", "--continue"],
        ),
        "gitOperationContinue" => operation(
            serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            "continue",
        ),
        "gitOperationAbort" => operation(
            serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid")?,
            "abort",
        ),
        _ => Err("remote_git_kind_invalid".to_string()),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::{changes, RepoRequest};
    use super::{
        dispatch, is_nested_repo_entry, map_git_error, parse_status, validate_patch,
        validate_relative,
    };
    use serde_json::json;
    #[test]
    // 验证非仓库错误与远端不可达错误分别映射，避免文本匹配顺序混淆。
    fn non_git_repository_stderr_maps_to_stable_code() {
        assert_eq!(
            map_git_error(
                b"fatal: not a git repository (or any of the parent directories): .git",
                b""
            ),
            "not_git_repository"
        );
        // 远端 URL 不可达仍是 no_remote，不得被非仓库分支抢走。
        assert_eq!(
            map_git_error(
                b"fatal: 'origin' does not appear to be a git repository",
                b""
            ),
            "no_remote"
        );
    }
    #[test]
    // 验证相对路径正常值、空值策略及穿越、反斜杠和 NUL 的拒绝规则。
    fn paths_reject_traversal_and_windows_separators() {
        assert!(validate_relative("src/lib.rs", false).is_ok());
        assert!(validate_relative("", true).is_ok());
        assert!(validate_relative("", false).is_err());
        assert!(validate_relative("../secret", false).is_err());
        assert!(validate_relative("C:\\secret", false).is_err());
        assert!(validate_relative("bad\0path", false).is_err());
    }
    #[test]
    // 验证 porcelain 状态对暂存、未跟踪及冲突条目的映射。
    fn porcelain_status_maps_untracked_staged_and_conflict() {
        let changes =
            parse_status(b"M  staged.txt\0 M work.txt\0?? new.txt\0UU conflict.txt\0").unwrap();
        assert_eq!(changes.len(), 4);
        assert_eq!((changes[0].status.as_str(), changes[0].staged), ("M", true));
        assert_eq!(
            (changes[2].status.as_str(), changes[2].staged),
            ("U", false)
        );
        assert_eq!(changes[3].status, "C");
    }

    #[test]
    // 在隔离临时目录验证普通目录与 .git 文件/目录标记的嵌套仓库识别。
    fn nested_repo_entries_are_distinguished_from_regular_directories() {
        let root = tempfile::tempdir().unwrap();
        let regular = root.path().join("test");
        let nested = root.path().join("nested");
        let worktree = root.path().join("worktree");
        std::fs::create_dir(&regular).unwrap();
        std::fs::create_dir(&nested).unwrap();
        std::fs::create_dir(&worktree).unwrap();
        std::fs::create_dir(nested.join(".git")).unwrap();
        std::fs::write(worktree.join(".git"), b"gitdir: /tmp/worktree").unwrap();

        assert!(!is_nested_repo_entry(root.path(), "test/"));
        assert!(is_nested_repo_entry(root.path(), "nested/"));
        assert!(is_nested_repo_entry(root.path(), "worktree/"));
        assert!(!is_nested_repo_entry(root.path(), "nested/file.txt"));
    }

    #[cfg(unix)]
    #[test]
    // 在 Unix 隔离临时仓库验证未跟踪目录展开到文件，并过滤嵌套仓库条目。
    fn changes_expands_untracked_directories_and_skips_nested_repositories() {
        let root = tempfile::tempdir().unwrap();
        let regular = root.path().join("test");
        let nested = root.path().join("nested");
        std::fs::create_dir(&regular).unwrap();
        std::fs::write(regular.join("c.txt"), b"content").unwrap();
        std::fs::create_dir(&nested).unwrap();

        for directory in [root.path(), nested.as_path()] {
            let status = std::process::Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(directory)
                .status()
                .unwrap();
            assert!(status.success());
        }

        let changes = changes(RepoRequest {
            root_path: root.path().to_string_lossy().to_string(),
            repo_path: String::new(),
        })
        .unwrap();
        let paths = changes
            .into_iter()
            .map(|change| change.path)
            .collect::<Vec<_>>();

        assert!(paths.iter().any(|path| path == "test/c.txt"));
        assert!(!paths.iter().any(|path| path == "test/"));
        assert!(!paths.iter().any(|path| path == "nested/"));
    }

    #[test]
    // 验证补丁文件头必须与请求文件路径一致。
    fn patches_are_confined_to_the_requested_file() {
        let patch = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(validate_patch(patch, "src/lib.rs").is_ok());
        assert!(validate_patch(patch, "src/other.rs").is_err());
    }

    #[test]
    // 验证若干 Git RPC 拒绝额外字段，并在执行仓库命令前返回请求格式错误。
    fn each_rpc_rejects_unknown_payload_fields_before_execution() {
        assert_eq!(
            dispatch(
                "gitListRepositories",
                json!({ "rootPath": "/tmp", "repoPath": "nested" })
            )
            .unwrap_err(),
            "remote_git_request_invalid"
        );
        assert_eq!(
            dispatch(
                "gitCommit",
                json!({ "rootPath": "/tmp", "repoPath": "", "message": "x", "paths": [] })
            )
            .unwrap_err(),
            "remote_git_request_invalid"
        );
        for (kind, payload) in [
            (
                "gitListCommits",
                json!({ "rootPath": "/tmp", "repoPath": "", "cursor": null, "search": null, "extra": true }),
            ),
            (
                "gitCommitDetail",
                json!({ "rootPath": "/tmp", "repoPath": "", "commitId": "0123456789012345678901234567890123456789", "extra": true }),
            ),
            (
                "gitCommitFileDiff",
                json!({ "rootPath": "/tmp", "repoPath": "", "commitId": "0123456789012345678901234567890123456789", "relativePath": "file.txt", "oldRelativePath": null, "extra": true }),
            ),
        ] {
            assert_eq!(
                dispatch(kind, payload).unwrap_err(),
                "remote_git_request_invalid"
            );
        }
    }
}
