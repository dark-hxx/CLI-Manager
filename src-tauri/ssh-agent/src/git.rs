use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_REPOSITORIES: usize = 64;
const MAX_CHANGES: usize = 10_000;
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

pub fn as_of_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    #[serde(default)]
    pub relative_path: String,
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
    pub added: u32,
    pub deleted: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub detached: bool,
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

pub fn list_repositories(request: GitRequest) -> Result<Vec<GitRepoInfo>, String> {
    let root = resolve_root(&request.root_path)?;
    let mut repos = Vec::new();
    walk_repositories(&root, &root, &mut repos, 0)?;
    Ok(repos)
}

pub fn changes(request: GitRequest) -> Result<Vec<GitChange>, String> {
    let repo = resolve_repo(&request)?;
    let output = run_git(&repo, &["status", "--porcelain=v1", "-z"])?;
    parse_status(&output)
}

pub fn diff(request: GitRequest) -> Result<String, String> {
    let repo = resolve_repo(&request)?;
    let path = validate_relative(&request.relative_path)?;
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        path.as_str(),
    ];
    if path.is_empty() {
        args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    }
    let output = run_git(&repo, &args)?;
    if output.len() > MAX_DIFF_BYTES {
        return Err("remote_git_diff_too_large".to_string());
    }
    String::from_utf8(output).map_err(|_| "remote_git_diff_invalid_utf8".to_string())
}

pub fn branch_status(request: GitRequest) -> Result<GitBranchStatus, String> {
    let repo = resolve_repo(&request)?;
    let output = run_git(&repo, &["status", "--porcelain=v1", "-b"])?;
    let header = String::from_utf8_lossy(&output)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let branch = header
        .strip_prefix("## ")
        .and_then(|line| line.split("...").next())
        .filter(|value| *value != "HEAD (no branch)")
        .map(str::to_string);
    let upstream = header
        .split("...")
        .nth(1)
        .and_then(|value| value.split_whitespace().next())
        .map(str::to_string);
    let ahead = header
        .split("ahead ")
        .nth(1)
        .and_then(|value| value.split(',').next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let behind = header
        .split("behind ")
        .nth(1)
        .and_then(|value| value.split(']').next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok(GitBranchStatus {
        detached: branch.is_none(),
        has_upstream: upstream.is_some(),
        branch,
        upstream,
        ahead,
        behind,
    })
}

pub fn branches(request: GitRequest) -> Result<Vec<GitBranchInfo>, String> {
    let repo = resolve_repo(&request)?;
    let output = run_git(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname)\t%(HEAD)\t%(upstream:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut result = Vec::new();
    for line in String::from_utf8_lossy(&output)
        .lines()
        .take(MAX_REPOSITORIES)
    {
        let mut parts = line.split('\t');
        let ref_name = parts.next().unwrap_or_default();
        let (name, branch_type) = if let Some(name) = ref_name.strip_prefix("refs/heads/") {
            (name.to_string(), "local")
        } else if let Some(name) = ref_name.strip_prefix("refs/remotes/") {
            (name.to_string(), "remote")
        } else {
            continue;
        };
        if name.ends_with("/HEAD") {
            continue;
        }
        let current = parts.next() == Some("*");
        let upstream = parts
            .next()
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let remote = (branch_type == "remote")
            .then(|| name.split('/').next().unwrap_or_default().to_string());
        result.push(GitBranchInfo {
            name,
            branch_type: branch_type.to_string(),
            current,
            upstream,
            remote,
        });
    }
    Ok(result)
}

fn run_git(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "diff.external=",
            "-c",
            "pager.diff=false",
            "-C",
            repo.to_str().ok_or("remote_git_path_invalid")?,
        ])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .map_err(|_| "remote_git_unavailable".to_string())?;
    if !output.status.success() {
        return Err("remote_git_command_failed".to_string());
    }
    Ok(output.stdout)
}

fn resolve_root(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if !Path::new(value).is_absolute()
        || value.contains(['\0', '\r', '\n', '\\'])
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

fn resolve_repo(request: &GitRequest) -> Result<PathBuf, String> {
    let root = resolve_root(&request.root_path)?;
    let relative = validate_relative(&request.repo_path)?;
    let repo = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "remote_git_repo_not_found".to_string())?;
    if !repo.starts_with(&root) || !repo.is_dir() {
        return Err("remote_git_repo_confined".to_string());
    }
    Ok(repo)
}

fn validate_relative(value: &str) -> Result<String, String> {
    if value.contains(['\0', '\r', '\n', '\\'])
        || Path::new(value).is_absolute()
        || value.split('/').any(|part| part == "..")
    {
        return Err("remote_git_path_invalid".to_string());
    }
    Ok(value.trim_matches('/').to_string())
}

fn walk_repositories(
    root: &Path,
    directory: &Path,
    repos: &mut Vec<GitRepoInfo>,
    depth: usize,
) -> Result<(), String> {
    if depth > 3 || repos.len() >= MAX_REPOSITORIES {
        return Ok(());
    }
    if directory.join(".git").is_dir() || directory.join(".git").is_file() {
        let relative_path = directory
            .strip_prefix(root)
            .map_err(|_| "remote_git_path_confined")?
            .to_string_lossy()
            .replace('\\', "/");
        let branch = branch_status(GitRequest {
            root_path: root.display().to_string(),
            repo_path: relative_path.clone(),
            relative_path: String::new(),
        })
        .ok()
        .and_then(|status| status.branch);
        repos.push(GitRepoInfo {
            repo_id: relative_path.clone(),
            relative_path,
            branch,
        });
        return Ok(());
    }
    for entry in std::fs::read_dir(directory).map_err(|_| "remote_git_list_failed")? {
        let entry = entry.map_err(|_| "remote_git_list_failed")?;
        if entry
            .file_type()
            .map_err(|_| "remote_git_list_failed")?
            .is_dir()
            && !entry.file_name().to_string_lossy().starts_with('.')
        {
            walk_repositories(root, &entry.path(), repos, depth + 1)?;
        }
    }
    Ok(())
}

fn parse_status(bytes: &[u8]) -> Result<Vec<GitChange>, String> {
    let mut result = Vec::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .take(MAX_CHANGES)
    {
        let text =
            String::from_utf8(record.to_vec()).map_err(|_| "remote_git_status_invalid_utf8")?;
        if text.len() < 4 {
            continue;
        }
        let index = text.as_bytes()[0] as char;
        let worktree = text.as_bytes()[1] as char;
        let path = text[3..].to_string();
        let conflict = matches!(
            (index, worktree),
            ('D', 'D')
                | ('A', 'U')
                | ('U', 'D')
                | ('U', 'A')
                | ('D', 'U')
                | ('A', 'A')
                | ('U', 'U')
        );
        let status = if conflict {
            "C".to_string()
        } else if worktree == '?' {
            "??".to_string()
        } else if worktree != ' ' {
            worktree.to_string()
        } else {
            index.to_string()
        };
        result.push(GitChange {
            path,
            status,
            staged: index != ' ' && index != '?',
            added: 0,
            deleted: 0,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{parse_status, validate_relative};
    #[test]
    fn relative_paths_are_confined() {
        assert!(validate_relative("src/lib.rs").is_ok());
        assert!(validate_relative("../secret").is_err());
        assert!(validate_relative("C:\\secret").is_err());
        assert!(validate_relative("bad\0path").is_err());
    }

    #[test]
    fn porcelain_status_maps_staged_untracked_and_conflicts() {
        let changes =
            parse_status(b"M  staged.txt\0 M work.txt\0?? new.txt\0UU conflict.txt\0").unwrap();
        assert_eq!(changes.len(), 4);
        assert_eq!((changes[0].status.as_str(), changes[0].staged), ("M", true));
        assert_eq!(
            (changes[1].status.as_str(), changes[1].staged),
            ("M", false)
        );
        assert_eq!(
            (changes[2].status.as_str(), changes[2].staged),
            ("??", false)
        );
        assert_eq!((changes[3].status.as_str(), changes[3].staged), ("C", true));
    }
}
