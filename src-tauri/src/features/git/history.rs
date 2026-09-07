use git2::{Delta, DiffFindOptions, DiffOptions, Oid, Repository, Sort};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use super::git::{
    format_diff_to_text_allow_empty, open_git_repo, resolve_wsl_mnt_git_project_path, run_wsl_git,
    validate_repo_relative_path,
};
use super::git_diff::{
    build_diff_payload, GitDiffOptions, GitDiffWhitespaceMode, GitFileDiffPayload,
};

const PAGE_SIZE: usize = 50;
const SHELL_SCAN_BATCH: usize = 500;
const RECORD_SEPARATOR: char = '\x1e';
const FIELD_SEPARATOR: char = '\x1f';

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub title: String,
    pub author_name: String,
    pub author_email: Option<String>,
    pub authored_at: i64,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPage {
    pub commits: Vec<GitCommitSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
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

fn validate_history_filters(filters: &GitHistoryFilters) -> Result<(), String> {
    if filters.references.len() > 64 {
        return Err("git_history_too_many_references".to_string());
    }
    for reference in &filters.references {
        validate_history_reference(reference)?;
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub added: usize,
    pub deleted: usize,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub commit: GitCommitSummary,
    pub files: Vec<GitCommitFile>,
}

fn validate_oid_text(value: &str) -> Result<(), String> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("git_history_oid_invalid".to_string());
    }
    Ok(())
}

fn validate_oid(value: &str) -> Result<Oid, String> {
    validate_oid_text(value)?;
    Oid::from_str(value).map_err(|_| "git_history_oid_invalid".to_string())
}

fn normalize_search(search: Option<String>) -> Option<String> {
    search
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

fn validate_history_reference(reference: &str) -> Result<(), String> {
    let value = reference.trim();
    if value.is_empty()
        || value != reference
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

fn matches_search(commit: &GitCommitSummary, search: Option<&str>) -> bool {
    let Some(search) = search else { return true };
    commit.title.to_lowercase().contains(search)
        || commit.author_name.to_lowercase().contains(search)
        || commit
            .author_email
            .as_deref()
            .is_some_and(|email| email.to_lowercase().contains(search))
        || commit.id.to_lowercase().contains(search)
}

fn commit_touches_path(
    repo: &Repository,
    commit: &git2::Commit<'_>,
    path: &str,
) -> Result<bool, String> {
    if path.is_empty() {
        return Ok(true);
    }
    let tree = commit
        .tree()
        .map_err(|error| format!("git_history_tree_failed:{error}"))?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .and_then(|parent| parent.tree())
                .map_err(|error| format!("git_history_parent_failed:{error}"))?,
        )
    } else {
        None
    };
    let mut options = DiffOptions::new();
    options.pathspec(path);
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut options))
        .map_err(|error| format!("git_history_diff_failed:{error}"))?;
    Ok(diff.deltas().len() > 0)
}

fn matches_filters(
    repo: &Repository,
    commit: &git2::Commit<'_>,
    summary: &GitCommitSummary,
    filters: Option<&GitHistoryFilters>,
) -> Result<bool, String> {
    let Some(filters) = filters else {
        return Ok(true);
    };
    let author = filters.author.trim().to_lowercase();
    if !author.is_empty()
        && !summary.author_name.to_lowercase().contains(&author)
        && !summary
            .author_email
            .as_deref()
            .is_some_and(|value| value.to_lowercase().contains(&author))
    {
        return Ok(false);
    }
    if filters
        .since
        .is_some_and(|since| summary.authored_at < since)
        || filters
            .until
            .is_some_and(|until| summary.authored_at > until)
    {
        return Ok(false);
    }
    commit_touches_path(repo, commit, filters.path.trim())
}

fn reference_map(repo: &Repository) -> HashMap<Oid, Vec<String>> {
    let mut result: HashMap<Oid, Vec<String>> = HashMap::new();
    let Ok(references) = repo.references() else {
        return result;
    };
    for reference in references.flatten() {
        let Some(name) = reference.shorthand().map(str::to_string) else {
            continue;
        };
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        result.entry(commit.id()).or_default().push(name);
    }
    for labels in result.values_mut() {
        labels.sort();
        labels.dedup();
    }
    result
}

fn commit_summary(commit: &git2::Commit<'_>, refs: &HashMap<Oid, Vec<String>>) -> GitCommitSummary {
    let id = commit.id().to_string();
    let author = commit.author();
    GitCommitSummary {
        short_id: id.chars().take(8).collect(),
        id,
        parents: commit
            .parent_ids()
            .map(|parent| parent.to_string())
            .collect(),
        title: commit.summary().unwrap_or_default().to_string(),
        author_name: author.name().unwrap_or_default().to_string(),
        author_email: author.email().map(str::to_string),
        authored_at: author.when().seconds().saturating_mul(1000),
        refs: refs.get(&commit.id()).cloned().unwrap_or_default(),
    }
}

fn list_native(
    project_path: &str,
    cursor: Option<String>,
    search: Option<String>,
    reference: Option<String>,
    filters: Option<GitHistoryFilters>,
) -> Result<GitCommitPage, String> {
    let repo = open_git_repo(project_path)?;
    if repo
        .is_empty()
        .map_err(|error| format!("git_history_head_failed:{error}"))?
    {
        return Ok(GitCommitPage {
            commits: Vec::new(),
            next_cursor: None,
        });
    }
    let cursor = cursor.as_deref().map(validate_oid).transpose()?;
    let search = normalize_search(search);
    let reference = reference
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            validate_history_reference(&value)?;
            Ok::<_, String>(value)
        })
        .transpose()?;
    if let Some(filters) = filters.as_ref() {
        validate_history_filters(filters)?;
    }
    let refs = reference_map(&repo);
    let mut revwalk = repo
        .revwalk()
        .map_err(|error| format!("git_history_walk_failed:{error}"))?;
    let selected_references = filters
        .as_ref()
        .filter(|value| !value.references.is_empty())
        .map(|value| value.references.as_slice());
    let push_result = if let Some(references) = selected_references {
        for reference in references {
            let object = repo
                .revparse_single(reference)
                .map_err(|_| "git_history_reference_not_found".to_string())?;
            revwalk
                .push(object.id())
                .map_err(|error| format!("git_history_head_failed:{error}"))?;
        }
        Ok(())
    } else if filters.as_ref().is_some_and(|value| value.all_refs) {
        revwalk
            .push_glob("refs/heads/*")
            .and_then(|_| revwalk.push_glob("refs/remotes/*"))
            .and_then(|_| revwalk.push_glob("refs/tags/*"))
    } else if let Some(reference) = reference.as_deref() {
        let object = repo
            .revparse_single(reference)
            .map_err(|_| "git_history_reference_not_found".to_string())?;
        revwalk.push(object.id())
    } else {
        revwalk.push_head()
    };
    match push_result {
        Ok(()) => {}
        Err(error)
            if matches!(
                error.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            return Ok(GitCommitPage {
                commits: Vec::new(),
                next_cursor: None,
            });
        }
        Err(error) => return Err(format!("git_history_head_failed:{error}")),
    }
    revwalk
        .set_sorting(Sort::TIME | Sort::TOPOLOGICAL)
        .map_err(|error| format!("git_history_sort_failed:{error}"))?;

    let mut after_cursor = cursor.is_none();
    let mut commits = Vec::with_capacity(PAGE_SIZE + 1);
    for oid in revwalk {
        let oid = oid.map_err(|error| format!("git_history_walk_failed:{error}"))?;
        if !after_cursor {
            if Some(oid) == cursor {
                after_cursor = true;
            }
            continue;
        }
        let commit = repo
            .find_commit(oid)
            .map_err(|error| format!("git_history_commit_failed:{error}"))?;
        let summary = commit_summary(&commit, &refs);
        if matches_search(&summary, search.as_deref())
            && matches_filters(&repo, &commit, &summary, filters.as_ref())?
        {
            commits.push(summary);
            if commits.len() > PAGE_SIZE {
                break;
            }
        }
    }
    if cursor.is_some() && !after_cursor {
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

fn parse_shell_commits(bytes: &[u8]) -> Vec<GitCommitSummary> {
    String::from_utf8_lossy(bytes)
        .split(RECORD_SEPARATOR)
        .filter_map(|record| {
            let fields = record
                .trim_matches(['\r', '\n'])
                .split(FIELD_SEPARATOR)
                .collect::<Vec<_>>();
            if fields.len() != 7 {
                return None;
            }
            let id = fields[0].to_string();
            if validate_oid_text(&id).is_err() {
                return None;
            }
            Some(GitCommitSummary {
                short_id: id.chars().take(8).collect(),
                id,
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

fn list_wsl(
    distro: &str,
    linux_path: &str,
    cursor: Option<String>,
    search: Option<String>,
    reference: Option<String>,
    filters: Option<GitHistoryFilters>,
) -> Result<GitCommitPage, String> {
    if let Some(value) = cursor.as_deref() {
        validate_oid_text(value)?;
    }
    let search = normalize_search(search);
    let reference = reference
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            validate_history_reference(&value)?;
            Ok::<_, String>(value)
        })
        .transpose()?;
    if let Some(filters) = filters.as_ref() {
        validate_history_filters(filters)?;
    }
    let mut skip = 0usize;
    let mut cursor_seen = cursor.is_none();
    let mut commits = Vec::with_capacity(PAGE_SIZE + 1);
    loop {
        let mut args = vec![
            "log".to_string(),
            "--date-order".to_string(),
            "--decorate=short".to_string(),
            format!("--max-count={SHELL_SCAN_BATCH}"),
            format!("--skip={skip}"),
            "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s".to_string(),
        ];
        if filters.as_ref().is_some_and(|value| value.all_refs) {
            args.push("--all".to_string());
        } else if let Some(references) = filters
            .as_ref()
            .filter(|value| !value.references.is_empty())
            .map(|value| value.references.as_slice())
        {
            args.extend(references.iter().cloned());
        } else if let Some(reference) = reference.as_deref() {
            args.push(reference.to_string());
        }
        if let Some(filters) = filters.as_ref() {
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
        let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        let batch = match run_wsl_git(distro, linux_path, &refs) {
            Ok(bytes) => parse_shell_commits(&bytes),
            Err(error)
                if error.contains("does not have any commits")
                    || error.contains("unknown revision") =>
            {
                Vec::new()
            }
            Err(error) => return Err(error),
        };
        if batch.is_empty() {
            break;
        }
        skip += batch.len();
        let start = if cursor_seen {
            0
        } else if let Some(index) = batch
            .iter()
            .position(|commit| Some(commit.id.as_str()) == cursor.as_deref())
        {
            cursor_seen = true;
            index + 1
        } else {
            if batch.len() < SHELL_SCAN_BATCH {
                break;
            }
            continue;
        };
        for commit in &batch[start..] {
            if matches_search(commit, search.as_deref()) {
                commits.push(commit.clone());
                if commits.len() > PAGE_SIZE {
                    break;
                }
            }
        }
        if commits.len() > PAGE_SIZE || batch.len() < SHELL_SCAN_BATCH {
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

fn delta_status(status: Delta) -> Option<&'static str> {
    match status {
        Delta::Added => Some("A"),
        Delta::Deleted => Some("D"),
        Delta::Modified | Delta::Typechange => Some("M"),
        Delta::Renamed => Some("R"),
        Delta::Copied => Some("C"),
        _ => None,
    }
}

fn commit_diff<'repo>(
    repo: &'repo Repository,
    commit: &git2::Commit<'repo>,
    paths: &[&str],
    options: GitDiffOptions,
) -> Result<git2::Diff<'repo>, String> {
    let tree = commit
        .tree()
        .map_err(|error| format!("git_history_tree_failed:{error}"))?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .and_then(|parent| parent.tree())
                .map_err(|error| format!("git_history_parent_failed:{error}"))?,
        )
    } else {
        None
    };
    let mut diff_options = DiffOptions::new();
    diff_options.context_lines(options.context_lines);
    for path in paths {
        diff_options.pathspec(path);
    }
    match options.whitespace {
        GitDiffWhitespaceMode::Exact => {}
        GitDiffWhitespaceMode::IgnoreEol => {
            diff_options.ignore_whitespace_eol(true);
        }
        GitDiffWhitespaceMode::IgnoreAll => {
            diff_options.ignore_whitespace(true);
        }
    }
    repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut diff_options))
        .map_err(|error| format!("git_history_diff_failed:{error}"))
}

fn detail_native(project_path: &str, commit_id: &str) -> Result<GitCommitDetail, String> {
    let repo = open_git_repo(project_path)?;
    let oid = validate_oid(commit_id)?;
    let commit = repo
        .find_commit(oid)
        .map_err(|_| "git_history_commit_not_found".to_string())?;
    let summary = commit_summary(&commit, &reference_map(&repo));
    let mut diff = commit_diff(&repo, &commit, &[], GitDiffOptions::default())?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true).copies(true)))
        .map_err(|error| format!("git_history_rename_failed:{error}"))?;
    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        let Some(status) = delta_status(delta.status()) else {
            continue;
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let old_path = delta
            .old_file()
            .path()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .filter(|value| value != &path);
        let binary = [delta.old_file().id(), delta.new_file().id()]
            .into_iter()
            .filter(|id| !id.is_zero())
            .filter_map(|id| repo.find_blob(id).ok())
            .any(|blob| blob.is_binary());
        let patch = git2::Patch::from_diff(&diff, index)
            .map_err(|error| format!("git_history_stats_failed:{error}"))?;
        let (added, deleted) = match patch {
            Some(patch) => {
                let (_, added, deleted) = patch
                    .line_stats()
                    .map_err(|error| format!("git_history_stats_failed:{error}"))?;
                (added, deleted)
            }
            None => (0, 0),
        };
        files.push(GitCommitFile {
            path,
            old_path,
            status: status.to_string(),
            added,
            deleted,
            binary,
        });
    }
    Ok(GitCommitDetail {
        commit: summary,
        files,
    })
}

fn shell_diff_base_args(commit: &GitCommitSummary) -> Vec<String> {
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

fn wsl_commit(distro: &str, linux_path: &str, commit_id: &str) -> Result<GitCommitSummary, String> {
    validate_oid_text(commit_id)?;
    let format_arg = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s";
    let bytes = run_wsl_git(
        distro,
        linux_path,
        &["show", "-s", "--decorate=short", format_arg, commit_id],
    )?;
    parse_shell_commits(&bytes)
        .into_iter()
        .next()
        .ok_or_else(|| "git_history_commit_not_found".to_string())
}

fn parse_name_status(bytes: &[u8]) -> Vec<(String, Option<String>, String)> {
    let parts = bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let status = String::from_utf8_lossy(parts[index]).to_string();
        index += 1;
        if matches!(status.chars().next(), Some('R' | 'C')) && index + 1 < parts.len() {
            let old_path = String::from_utf8_lossy(parts[index]).to_string();
            let path = String::from_utf8_lossy(parts[index + 1]).to_string();
            result.push((
                path,
                Some(old_path),
                status.chars().next().unwrap().to_string(),
            ));
            index += 2;
        } else if index < parts.len() {
            result.push((
                String::from_utf8_lossy(parts[index]).to_string(),
                None,
                status.chars().next().unwrap_or('M').to_string(),
            ));
            index += 1;
        }
    }
    result
}

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

fn detail_wsl(distro: &str, linux_path: &str, commit_id: &str) -> Result<GitCommitDetail, String> {
    let commit = wsl_commit(distro, linux_path, commit_id)?;
    let mut base = shell_diff_base_args(&commit);
    let mut name_args = base.clone();
    name_args.extend(["--name-status".to_string(), "-z".to_string()]);
    let mut stat_args = std::mem::take(&mut base);
    stat_args.extend(["--numstat".to_string(), "-z".to_string()]);
    let names = run_wsl_git(
        distro,
        linux_path,
        &name_args.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    let stats = run_wsl_git(
        distro,
        linux_path,
        &stat_args.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    let stats = parse_numstat(&stats);
    let files = parse_name_status(&names)
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

#[tauri::command]
pub async fn git_list_commits(
    project_path: String,
    cursor: Option<String>,
    search: Option<String>,
    reference: Option<String>,
    filters: Option<GitHistoryFilters>,
) -> Result<GitCommitPage, String> {
    tokio::task::spawn_blocking(move || {
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&project_path) {
            if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
                return list_native(&windows_path, cursor, search, reference, filters);
            }
            return list_wsl(&distro, &linux_path, cursor, search, reference, filters);
        }
        list_native(&project_path, cursor, search, reference, filters)
    })
    .await
    .map_err(|error| format!("git_history_task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_get_commit_detail(
    project_path: String,
    commit_id: String,
) -> Result<GitCommitDetail, String> {
    tokio::task::spawn_blocking(move || {
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&project_path) {
            if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
                return detail_native(&windows_path, &commit_id);
            }
            return detail_wsl(&distro, &linux_path, &commit_id);
        }
        detail_native(&project_path, &commit_id)
    })
    .await
    .map_err(|error| format!("git_history_task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_get_commit_file_diff(
    project_path: String,
    commit_id: String,
    file_path: String,
    old_file_path: Option<String>,
    options: Option<GitDiffOptions>,
) -> Result<GitFileDiffPayload, String> {
    validate_repo_relative_path(&file_path)?;
    if let Some(path) = old_file_path.as_deref() {
        validate_repo_relative_path(path)?;
    }
    validate_oid_text(&commit_id)?;
    let options = options.unwrap_or_default().validate()?;
    tokio::task::spawn_blocking(move || {
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&project_path) {
            if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
                return commit_file_diff_native(
                    &windows_path,
                    &commit_id,
                    &file_path,
                    old_file_path.as_deref(),
                    options,
                );
            }
            let commit = wsl_commit(&distro, &linux_path, &commit_id)?;
            let mut args = shell_diff_base_args(&commit);
            args.push(format!("--unified={}", options.context_lines));
            match options.whitespace {
                GitDiffWhitespaceMode::Exact => {}
                GitDiffWhitespaceMode::IgnoreEol => args.push("--ignore-space-at-eol".to_string()),
                GitDiffWhitespaceMode::IgnoreAll => args.push("--ignore-all-space".to_string()),
            }
            args.extend(["--".to_string(), file_path.clone()]);
            if let Some(path) = old_file_path.filter(|path| path != &file_path) {
                args.push(path);
            }
            let bytes = run_wsl_git(
                &distro,
                &linux_path,
                &args.iter().map(String::as_str).collect::<Vec<_>>(),
            )?;
            return build_diff_payload(String::from_utf8_lossy(&bytes).to_string(), false);
        }
        commit_file_diff_native(
            &project_path,
            &commit_id,
            &file_path,
            old_file_path.as_deref(),
            options,
        )
    })
    .await
    .map_err(|error| format!("git_history_task_failed:{error}"))?
}

fn commit_file_diff_native(
    project_path: &str,
    commit_id: &str,
    file_path: &str,
    old_file_path: Option<&str>,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    let repo = open_git_repo(Path::new(project_path))?;
    let commit = repo
        .find_commit(validate_oid(commit_id)?)
        .map_err(|_| "git_history_commit_not_found".to_string())?;
    let mut paths = vec![file_path];
    if let Some(path) = old_file_path.filter(|path| *path != file_path) {
        paths.push(path);
    }
    let mut diff = commit_diff(&repo, &commit, &paths, options)?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true).copies(true)))
        .map_err(|error| format!("git_history_rename_failed:{error}"))?;
    build_diff_payload(format_diff_to_text_allow_empty(&diff)?, false)
}

#[cfg(test)]
mod tests {
    use super::{
        commit_file_diff_native, detail_native, list_native, matches_search, parse_numstat,
        parse_shell_commits, validate_oid, validate_oid_text, GitCommitSummary, GitHistoryFilters,
    };
    use crate::commands::git_diff::GitDiffOptions;
    use git2::{IndexAddOption, Repository, Signature};
    use std::path::Path;

    fn commit_file(repo: &Repository, name: &str, content: &str, message: &str) -> git2::Oid {
        std::fs::write(repo.workdir().unwrap().join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = Signature::now("Alice", "alice@example.com").unwrap();
        let parent = repo
            .head()
            .ok()
            .and_then(|head| head.target())
            .map(|id| repo.find_commit(id).unwrap());
        match parent.as_ref() {
            Some(parent) => repo
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    message,
                    &tree,
                    &[parent],
                )
                .unwrap(),
            None => repo
                .commit(Some("HEAD"), &signature, &signature, message, &tree, &[])
                .unwrap(),
        }
    }

    #[test]
    fn rejects_non_full_object_ids() {
        assert!(validate_oid("abc123").is_err());
        assert!(validate_oid("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
        assert!(validate_oid("0123456789012345678901234567890123456789").is_ok());
        assert!(validate_oid_text(
            "0123456789012345678901234567890123456789012345678901234567890123"
        )
        .is_ok());
    }

    #[test]
    fn parses_structured_shell_history_and_searches_all_fields() {
        let bytes = b"\x1e0123456789012345678901234567890123456789\x1f\x1fAlice\x1falice@example.com\x1f100\x1fHEAD -> main, tag: v1\x1fInitial commit\n";
        let commits = parse_shell_commits(bytes);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].authored_at, 100_000);
        assert!(matches_search(&commits[0], Some("alice")));
        assert!(matches_search(&commits[0], Some("012345")));
        assert!(matches_search(&commits[0], Some("initial")));
    }

    #[test]
    fn unmatched_search_is_rejected() {
        let commit = GitCommitSummary {
            id: "0123456789012345678901234567890123456789".to_string(),
            short_id: "01234567".to_string(),
            parents: Vec::new(),
            title: "Initial".to_string(),
            author_name: "Alice".to_string(),
            author_email: None,
            authored_at: 0,
            refs: Vec::new(),
        };
        assert!(!matches_search(&commit, Some("bob")));
    }

    #[test]
    fn native_history_lists_searches_and_loads_details() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        commit_file(&repo, "one.txt", "one\n", "Initial commit");
        let second = commit_file(&repo, "one.txt", "one\ntwo\n", "Second commit");

        let page = list_native(temp.path().to_str().unwrap(), None, None, None, None).unwrap();
        assert_eq!(page.commits.len(), 2);
        assert_eq!(page.commits[0].id, second.to_string());
        let search = list_native(
            temp.path().to_str().unwrap(),
            None,
            Some("initial".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(search.commits.len(), 1);
        let detail = detail_native(temp.path().to_str().unwrap(), &second.to_string()).unwrap();
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].path, "one.txt");
        assert_eq!(detail.files[0].added, 1);
    }

    #[test]
    fn native_history_filters_by_author_and_path() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        commit_file(&repo, "src.txt", "one\n", "Source");
        commit_file(&repo, "docs.txt", "docs\n", "Docs");

        let filtered = list_native(
            temp.path().to_str().unwrap(),
            None,
            None,
            None,
            Some(GitHistoryFilters {
                author: "alice@example.com".into(),
                path: "src.txt".into(),
                ..GitHistoryFilters::default()
            }),
        )
        .unwrap();
        assert_eq!(filtered.commits.len(), 1);
        assert_eq!(filtered.commits[0].title, "Source");
    }

    #[test]
    fn native_history_handles_empty_repositories_and_cursor_pagination() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        let empty = list_native(temp.path().to_str().unwrap(), None, None, None, None).unwrap();
        assert!(empty.commits.is_empty());
        assert!(empty.next_cursor.is_none());

        for index in 0..52 {
            commit_file(
                &repo,
                "page.txt",
                &format!("{index}\n"),
                &format!("Commit {index}"),
            );
        }
        let first = list_native(temp.path().to_str().unwrap(), None, None, None, None).unwrap();
        assert_eq!(first.commits.len(), 50);
        let cursor = first.next_cursor.clone().expect("second page cursor");
        assert_eq!(cursor, first.commits.last().unwrap().id);

        let second = list_native(
            temp.path().to_str().unwrap(),
            Some(cursor),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(second.commits.len(), 2);
        assert!(second.next_cursor.is_none());
        assert!(first
            .commits
            .iter()
            .all(|commit| second.commits.iter().all(|next| next.id != commit.id)));
    }

    #[test]
    fn native_merge_detail_compares_the_first_parent() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        let base_id = commit_file(&repo, "base.txt", "base\n", "Base");
        let base = repo.find_commit(base_id).unwrap();
        let signature = Signature::now("Alice", "alice@example.com").unwrap();

        std::fs::write(temp.path().join("main.txt"), "main\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("main.txt")).unwrap();
        index.write().unwrap();
        let main_tree_id = index.write_tree().unwrap();
        let main_tree = repo.find_tree(main_tree_id).unwrap();
        let main_id = repo
            .commit(None, &signature, &signature, "Main", &main_tree, &[&base])
            .unwrap();
        let main = repo.find_commit(main_id).unwrap();

        std::fs::remove_file(temp.path().join("main.txt")).unwrap();
        std::fs::write(temp.path().join("feature.txt"), "feature\n").unwrap();
        let mut feature_index = repo.index().unwrap();
        feature_index.read_tree(&base.tree().unwrap()).unwrap();
        feature_index.add_path(Path::new("feature.txt")).unwrap();
        feature_index.write().unwrap();
        let feature_tree_id = feature_index.write_tree().unwrap();
        let feature_tree = repo.find_tree(feature_tree_id).unwrap();
        let feature_id = repo
            .commit(
                None,
                &signature,
                &signature,
                "Feature",
                &feature_tree,
                &[&base],
            )
            .unwrap();
        let feature = repo.find_commit(feature_id).unwrap();

        let mut merge_index = repo.index().unwrap();
        merge_index.read_tree(&main_tree).unwrap();
        merge_index.add_path(Path::new("feature.txt")).unwrap();
        let merge_tree_id = merge_index.write_tree().unwrap();
        let merge_tree = repo.find_tree(merge_tree_id).unwrap();
        let merge_id = repo
            .commit(
                None,
                &signature,
                &signature,
                "Merge feature",
                &merge_tree,
                &[&main, &feature],
            )
            .unwrap();

        let detail = detail_native(temp.path().to_str().unwrap(), &merge_id.to_string()).unwrap();
        assert_eq!(detail.commit.parents[0], main_id.to_string());
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].path, "feature.txt");
        assert_eq!(detail.files[0].status, "A");
    }

    #[test]
    fn native_history_marks_binary_files() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        std::fs::write(temp.path().join("image.bin"), [0, 1, 2, 0, 3]).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("image.bin")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = Signature::now("Alice", "alice@example.com").unwrap();
        let commit_id = repo
            .commit(Some("HEAD"), &signature, &signature, "Binary", &tree, &[])
            .unwrap();

        let detail = detail_native(temp.path().to_str().unwrap(), &commit_id.to_string()).unwrap();
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].path, "image.bin");
        assert!(detail.files[0].binary);
        assert_eq!((detail.files[0].added, detail.files[0].deleted), (0, 0));
    }

    #[test]
    fn native_history_preserves_rename_metadata_in_file_diff() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        commit_file(&repo, "old.txt", "content\n", "Initial");
        std::fs::rename(temp.path().join("old.txt"), temp.path().join("new.txt")).unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new("old.txt")).unwrap();
        index.add_path(Path::new("new.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let signature = Signature::now("Alice", "alice@example.com").unwrap();
        let commit_id = repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "Rename",
                &tree,
                &[&parent],
            )
            .unwrap();

        let detail = detail_native(temp.path().to_str().unwrap(), &commit_id.to_string()).unwrap();
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].status, "R");
        assert_eq!(detail.files[0].old_path.as_deref(), Some("old.txt"));

        let diff = commit_file_diff_native(
            temp.path().to_str().unwrap(),
            &commit_id.to_string(),
            "new.txt",
            Some("old.txt"),
            GitDiffOptions::default(),
        )
        .unwrap();
        assert!(diff.content.contains("rename from old.txt"));
        assert!(diff.content.contains("rename to new.txt"));
    }

    #[test]
    fn parses_rename_numstat_target_path() {
        let stats = parse_numstat(b"3\t1\t\0old.txt\0new.txt\0");
        assert_eq!(stats.get("new.txt"), Some(&(3, 1, false)));
    }
}
