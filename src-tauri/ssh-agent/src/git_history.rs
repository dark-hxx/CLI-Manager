use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::git::{resolve_repo, run_git, validate_repo_relative_path, READ_TIMEOUT};

const PAGE_SIZE: usize = 50;
const SCAN_BATCH: usize = 500;
const MAX_DIFF_BYTES: usize = 768 * 1024;
const MAX_DIFF_LINES: usize = 20_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListCommitsRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub cursor: Option<String>,
    pub search: Option<String>,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub filters: Option<GitHistoryFilters>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHistoryFilters {
    #[serde(default)]
    pub all_refs: bool,
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub author: String,
    pub since: Option<i64>,
    pub until: Option<i64>,
    #[serde(default)]
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub commit_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitFileRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub commit_id: String,
    pub relative_path: String,
    #[serde(default)]
    pub old_relative_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    id: String,
    short_id: String,
    parents: Vec<String>,
    title: String,
    author_name: String,
    author_email: Option<String>,
    authored_at: i64,
    refs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPage {
    commits: Vec<GitCommitSummary>,
    next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitFile {
    path: String,
    old_path: Option<String>,
    status: String,
    added: usize,
    deleted: usize,
    binary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    commit: GitCommitSummary,
    files: Vec<GitCommitFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDiff {
    content: String,
    can_revert_hunks: bool,
    byte_length: usize,
    line_count: usize,
}

// 仅接受 40/64 字节的十六进制完整对象 ID；不查询对象是否存在或是否为提交。
fn validate_oid(value: &str) -> Result<(), String> {
    if matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("git_history_oid_invalid".to_string())
    }
}

// 容错解码分隔符格式的提交记录，跳过字段数或 ID 非法项；时间解析失败取零，再转为毫秒。
fn parse_commits(bytes: &[u8]) -> Vec<GitCommitSummary> {
    String::from_utf8_lossy(bytes)
        .split('\x1e')
        .filter_map(|record| {
            let fields = record
                .trim_matches(['\r', '\n'])
                .split('\x1f')
                .collect::<Vec<_>>();
            if fields.len() != 7 || validate_oid(fields[0]).is_err() {
                return None;
            }
            Some(GitCommitSummary {
                id: fields[0].to_string(),
                short_id: fields[0].chars().take(8).collect(),
                parents: fields[1].split_whitespace().map(str::to_string).collect(),
                author_name: fields[2].to_string(),
                author_email: (!fields[3].is_empty()).then(|| fields[3].to_string()),
                authored_at: fields[4]
                    .parse::<i64>()
                    .unwrap_or_default()
                    .saturating_mul(1000),
                refs: fields[5]
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect(),
                title: fields[6].to_string(),
            })
        })
        .collect()
}

// 在标题、作者、邮箱和完整 ID 的小写文本中查找关键词；调用方需先把关键词转为小写。
fn matches(commit: &GitCommitSummary, search: Option<&str>) -> bool {
    let Some(search) = search else { return true };
    commit.title.to_lowercase().contains(search)
        || commit.author_name.to_lowercase().contains(search)
        || commit
            .author_email
            .as_deref()
            .is_some_and(|value| value.to_lowercase().contains(search))
        || commit.id.to_lowercase().contains(search)
}

// 拒绝空值、超长、选项前缀及空白/控制字符；不限制为现存分支，也不排除合法 revision 表达式。
fn validate_reference(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value.starts_with('-')
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("git_history_reference_invalid".to_string());
    }
    Ok(())
}

// 校验引用数量和形态、作者长度、非负有序时间范围及相对路径；作者内容仍按 Git 的匹配语义处理。
fn validate_filters(filters: &GitHistoryFilters) -> Result<(), String> {
    if filters.references.len() > 64 {
        return Err("git_history_too_many_references".to_string());
    }
    for reference in &filters.references {
        validate_reference(reference)?;
    }
    if filters.author.len() > 256 || filters.author.chars().any(char::is_control) {
        return Err("git_history_author_invalid".to_string());
    }
    if filters.since.is_some_and(|value| value < 0)
        || filters.until.is_some_and(|value| value < 0)
        || matches!((filters.since, filters.until), (Some(since), Some(until)) if since > until)
    {
        return Err("git_history_date_invalid".to_string());
    }
    if !filters.path.is_empty() {
        validate_repo_relative_path(&filters.path)?;
    }
    Ok(())
}

// 按每批 500 条扫描历史，找到游标后再做文本筛选，最多返回 50 条并用额外一条判断是否有下一页。
// all_refs 优先于引用列表和单引用；缺少 HEAD 的有效仓库返回空页，扫描中找不到游标则报错。
// 每次 Git 调用各自限时，但总扫描批次数不设上限，游标也不冻结仓库快照。
pub fn list_commits(request: ListCommitsRequest) -> Result<GitCommitPage, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    if let Some(cursor) = request.cursor.as_deref() {
        validate_oid(cursor)?;
    }
    let search = request
        .search
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let reference = request.reference.filter(|value| !value.trim().is_empty());
    if let Some(value) = reference.as_deref() {
        validate_reference(value)?;
    }
    if let Some(filters) = request.filters.as_ref() {
        validate_filters(filters)?;
    }
    if let Err(error) = run_git(
        &repo,
        &["rev-parse", "--verify", "HEAD"],
        false,
        READ_TIMEOUT,
    ) {
        if error != "git_failed" {
            return Err(error);
        }
        run_git(&repo, &["rev-parse", "--git-dir"], false, READ_TIMEOUT)?;
        return Ok(GitCommitPage {
            commits: Vec::new(),
            next_cursor: None,
        });
    }
    let mut skip = 0usize;
    let mut cursor_seen = request.cursor.is_none();
    let mut commits = Vec::with_capacity(PAGE_SIZE + 1);
    loop {
        let mut args = vec![
            "log".to_string(),
            "--date-order".to_string(),
            "--decorate=short".to_string(),
            format!("--max-count={SCAN_BATCH}"),
            format!("--skip={skip}"),
            "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s".to_string(),
        ];
        if request.filters.as_ref().is_some_and(|value| value.all_refs) {
            args.push("--all".to_string());
        } else if let Some(references) = request
            .filters
            .as_ref()
            .filter(|value| !value.references.is_empty())
            .map(|value| value.references.as_slice())
        {
            args.extend(references.iter().cloned());
        } else if let Some(reference) = reference.as_deref() {
            args.push(reference.to_string());
        }
        if let Some(filters) = request.filters.as_ref() {
            let author = filters.author.trim();
            if !author.is_empty() {
                args.push(format!("--author={author}"));
            }
            if let Some(since) = filters.since {
                args.push(format!("--since=@{}", since / 1000));
            }
            if let Some(until) = filters.until {
                args.push(format!("--until=@{}", until / 1000));
            }
            if !filters.path.is_empty() {
                args.push("--".to_string());
                args.push(filters.path.clone());
            }
        }
        let output = run_git(
            &repo,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            false,
            READ_TIMEOUT,
        )?;
        let batch = parse_commits(&output.stdout);
        if batch.is_empty() {
            break;
        }
        skip += batch.len();
        let start = if cursor_seen {
            0
        } else if let Some(index) = batch
            .iter()
            .position(|commit| Some(commit.id.as_str()) == request.cursor.as_deref())
        {
            cursor_seen = true;
            index + 1
        } else {
            if batch.len() < SCAN_BATCH {
                break;
            }
            continue;
        };
        for commit in &batch[start..] {
            if matches(commit, search.as_deref()) {
                commits.push(commit.clone());
                if commits.len() > PAGE_SIZE {
                    break;
                }
            }
        }
        if commits.len() > PAGE_SIZE || batch.len() < SCAN_BATCH {
            break;
        }
    }
    if !cursor_seen {
        return Err("git_history_cursor_not_found".to_string());
    }
    let has_more = commits.len() > PAGE_SIZE;
    commits.truncate(PAGE_SIZE);
    let next_cursor = has_more.then(|| commits.last().expect("page is non-empty").id.clone());
    Ok(GitCommitPage {
        commits,
        next_cursor,
    })
}

// 校验完整 ID 后用 show 读取提交摘要，返回首条可解析记录；无记录时报告提交未找到。
fn load_commit(repo: &std::path::Path, commit_id: &str) -> Result<GitCommitSummary, String> {
    validate_oid(commit_id)?;
    let output = run_git(
        repo,
        &[
            "show",
            "-s",
            "--decorate=short",
            "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s",
            commit_id,
        ],
        false,
        READ_TIMEOUT,
    )?;
    parse_commits(&output.stdout)
        .into_iter()
        .next()
        .ok_or_else(|| "git_history_commit_not_found".to_string())
}

// 普通或合并提交只对比第一父提交，根提交使用 show --root；启用重命名检测并禁用外部处理和颜色。
fn diff_args(commit: &GitCommitSummary) -> Vec<String> {
    if let Some(parent) = commit.parents.first() {
        vec![
            "diff".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--no-color".to_string(),
            "-M".to_string(),
            parent.clone(),
            commit.id.clone(),
        ]
    } else {
        vec![
            "show".to_string(),
            "--format=".to_string(),
            "--root".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--no-color".to_string(),
            "-M".to_string(),
            commit.id.clone(),
        ]
    }
}

// 解析 NUL 分隔的状态与路径；重命名/复制保留旧路径并只取状态首字母，路径使用有损 UTF-8。
fn parse_name_status(bytes: &[u8]) -> Vec<(String, Option<String>, String)> {
    let fields = bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let status = String::from_utf8_lossy(fields[index]).to_string();
        index += 1;
        if matches!(status.chars().next(), Some('R' | 'C')) && index + 1 < fields.len() {
            result.push((
                String::from_utf8_lossy(fields[index + 1]).to_string(),
                Some(String::from_utf8_lossy(fields[index]).to_string()),
                status.chars().next().unwrap().to_string(),
            ));
            index += 2;
        } else if index < fields.len() {
            result.push((
                String::from_utf8_lossy(fields[index]).to_string(),
                None,
                status.chars().next().unwrap_or('M').to_string(),
            ));
            index += 1;
        }
    }
    result
}

// 按目标路径聚合 NUL 分隔的增删统计，重命名取新路径；短横线标记二进制，非法数字按零处理。
fn parse_numstat(bytes: &[u8]) -> HashMap<String, (usize, usize, bool)> {
    let mut result = HashMap::new();
    let records = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut index = 0;
    while index < records.len() {
        let text = String::from_utf8_lossy(records[index]);
        index += 1;
        if text.is_empty() {
            continue;
        }
        let fields = text.splitn(3, '\t').collect::<Vec<_>>();
        if fields.len() != 3 {
            continue;
        }
        let binary = fields[0] == "-" || fields[1] == "-";
        let path = if fields[2].is_empty() && index + 1 < records.len() {
            index += 2;
            String::from_utf8_lossy(records[index - 1]).to_string()
        } else {
            fields[2].to_string()
        };
        result.insert(
            path,
            (
                fields[0].parse().unwrap_or(0),
                fields[1].parse().unwrap_or(0),
                binary,
            ),
        );
    }
    result
}

// 加载提交后分别查询 name-status 与 numstat，再按路径合并文件详情；缺失统计使用零值与非二进制默认值。
pub fn commit_detail(request: CommitRequest) -> Result<GitCommitDetail, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let commit = load_commit(&repo, &request.commit_id)?;
    let mut names = diff_args(&commit);
    names.extend(["--name-status".to_string(), "-z".to_string()]);
    let mut stats = diff_args(&commit);
    stats.extend(["--numstat".to_string(), "-z".to_string()]);
    let names = run_git(
        &repo,
        &names.iter().map(String::as_str).collect::<Vec<_>>(),
        false,
        READ_TIMEOUT,
    )?;
    let stats = run_git(
        &repo,
        &stats.iter().map(String::as_str).collect::<Vec<_>>(),
        false,
        READ_TIMEOUT,
    )?;
    let stats = parse_numstat(&stats.stdout);
    let files = parse_name_status(&names.stdout)
        .into_iter()
        .map(|(path, old_path, status)| {
            let (added, deleted, binary) = stats.get(&path).copied().unwrap_or_default();
            GitCommitFile {
                path,
                old_path,
                status,
                added,
                deleted,
                binary,
            }
        })
        .collect();
    Ok(GitCommitDetail { commit, files })
}

// 校验新旧相对路径后生成三行上下文的历史 Diff，不要求文件仍在工作区存在。
// 有损 UTF-8 转换后检查字节/行数上限；结果始终禁止分块回退，空内容可以成功返回。
pub fn commit_file_diff(request: CommitFileRequest) -> Result<GitCommitDiff, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let path = validate_repo_relative_path(&request.relative_path)?;
    let old_path = request
        .old_relative_path
        .as_deref()
        .map(validate_repo_relative_path)
        .transpose()?;
    let commit = load_commit(&repo, &request.commit_id)?;
    let mut args = diff_args(&commit);
    args.extend(["--unified=3".to_string(), "--".to_string(), path]);
    if let Some(old_path) = old_path.filter(|old_path| old_path != &request.relative_path) {
        args.push(old_path);
    }
    let output = run_git(
        &repo,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        false,
        READ_TIMEOUT,
    )?;
    let content = String::from_utf8_lossy(&output.stdout).to_string();
    let byte_length = content.len();
    let line_count = content.lines().count();
    if byte_length > MAX_DIFF_BYTES || line_count > MAX_DIFF_LINES {
        return Err("git_diff_too_large".to_string());
    }
    Ok(GitCommitDiff {
        content,
        can_revert_hunks: false,
        byte_length,
        line_count,
    })
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::{commit_detail, list_commits, CommitRequest, ListCommitsRequest};
    #[cfg(unix)]
    use super::{commit_file_diff, CommitFileRequest};
    use super::{parse_commits, validate_oid};
    #[cfg(unix)]
    use std::path::Path;
    #[cfg(unix)]
    use std::process::Command;

    #[cfg(unix)]
    // 在指定测试仓库执行 Git，为该子进程设置固定提交身份并断言成功。
    fn git(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Alice")
            .env("GIT_AUTHOR_EMAIL", "alice@example.com")
            .env("GIT_COMMITTER_NAME", "Alice")
            .env("GIT_COMMITTER_EMAIL", "alice@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "git command failed: {args:?}");
    }

    #[cfg(unix)]
    // 在测试仓库捕获 Git stdout，要求命令成功且输出严格 UTF-8，再去掉两端空白。
    fn git_output(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git command failed: {args:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    #[cfg(unix)]
    // 更新固定文件并创建带编号提交，为历史分页测试构造稳定数量的记录。
    fn commit_file(repo: &Path, index: usize) {
        std::fs::write(repo.join("page.txt"), format!("{index}\n")).unwrap();
        git(repo, &["add", "page.txt"]);
        git(repo, &["commit", "-m", &format!("Commit {index}")]);
    }

    #[test]
    // 验证两种完整十六进制 ID 长度可接受、分支名不作为 ID，并检查相对路径的父目录逃逸被拒绝。
    fn validates_full_commit_ids() {
        assert!(validate_oid("0123456789012345678901234567890123456789").is_ok());
        assert!(
            validate_oid("0123456789012345678901234567890123456789012345678901234567890123")
                .is_ok()
        );
        assert!(validate_oid("main").is_err());
        assert!(crate::git::validate_repo_relative_path("history/file.txt").is_ok());
        assert!(crate::git::validate_repo_relative_path("../outside.txt").is_err());
    }

    #[test]
    // 验证分隔符格式可解析出一条提交，短 ID 固定取前八个字符。
    fn parses_commit_wire_format() {
        let commits = parse_commits(b"\x1e0123456789012345678901234567890123456789\x1f\x1fA\x1fa@b.c\x1f1\x1fHEAD -> main\x1fTitle\n");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].short_id, "01234567");
    }

    #[cfg(unix)]
    #[test]
    // 用临时仓库验证空历史、52 条提交的两页查询、根提交详情及已删除文件的历史 Diff，并拒绝逃逸路径。
    fn git_cli_history_handles_empty_repositories_and_cursor_pagination() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        let root = temp.path().to_string_lossy().into_owned();
        let empty = list_commits(ListCommitsRequest {
            root_path: root.clone(),
            repo_path: String::new(),
            cursor: None,
            search: None,
            reference: None,
            filters: None,
        })
        .unwrap();
        assert!(empty.commits.is_empty());

        for index in 0..52 {
            commit_file(temp.path(), index);
        }
        let first = list_commits(ListCommitsRequest {
            root_path: root.clone(),
            repo_path: String::new(),
            cursor: None,
            search: None,
            reference: None,
            filters: None,
        })
        .unwrap();
        assert_eq!(first.commits.len(), 50);
        let cursor = first.next_cursor.clone().expect("second page cursor");
        let second = list_commits(ListCommitsRequest {
            root_path: root.clone(),
            repo_path: String::new(),
            cursor: Some(cursor),
            search: Some("commit".to_string()),
            reference: None,
            filters: None,
        })
        .unwrap();
        assert_eq!(second.commits.len(), 2);
        assert!(second.next_cursor.is_none());

        let root_detail = commit_detail(CommitRequest {
            root_path: root.clone(),
            repo_path: String::new(),
            commit_id: second.commits.last().unwrap().id.clone(),
        })
        .unwrap();
        assert_eq!(root_detail.commit.parents.len(), 0);
        assert_eq!(root_detail.files.len(), 1);
        assert_eq!(root_detail.files[0].status, "A");

        let detail = commit_detail(CommitRequest {
            root_path: root,
            repo_path: String::new(),
            commit_id: first.commits[0].id.clone(),
        })
        .unwrap();
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].path, "page.txt");

        std::fs::create_dir(temp.path().join("removed")).unwrap();
        std::fs::write(temp.path().join("removed/history.txt"), "history\n").unwrap();
        git(temp.path(), &["add", "removed/history.txt"]);
        git(temp.path(), &["commit", "-m", "Add historical file"]);
        let historical_commit = git_output(temp.path(), &["rev-parse", "HEAD"]);
        std::fs::remove_dir_all(temp.path().join("removed")).unwrap();
        git(temp.path(), &["add", "-A"]);
        git(temp.path(), &["commit", "-m", "Remove historical file"]);

        let diff = commit_file_diff(CommitFileRequest {
            root_path: temp.path().to_string_lossy().into_owned(),
            repo_path: String::new(),
            commit_id: historical_commit.clone(),
            relative_path: "removed/history.txt".to_string(),
            old_relative_path: None,
        })
        .unwrap();
        assert!(diff.content.contains("history"));
        assert!(!diff.can_revert_hunks);
        assert_eq!(
            commit_file_diff(CommitFileRequest {
                root_path: temp.path().to_string_lossy().into_owned(),
                repo_path: String::new(),
                commit_id: historical_commit,
                relative_path: "../outside.txt".to_string(),
                old_relative_path: None,
            })
            .unwrap_err(),
            "remote_git_path_invalid"
        );
    }
}
