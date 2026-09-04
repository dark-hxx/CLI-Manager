use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::git::{
    git_command_output, run_git_cli, validate_commit_ref, validate_operation_ref,
    validate_repo_relative_path,
};

const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
const TAG_FIELD_SEPARATOR: char = '\x1f';
const MAX_LIST_ITEMS: usize = 500;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStashInfo {
    pub selector: String,
    pub oid: String,
    pub branch: String,
    pub message: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitReflogEntry {
    pub selector: String,
    pub oid: String,
    pub short_id: String,
    pub action: String,
    pub message: String,
    pub authored_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileHistoryEntry {
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub authored_at: i64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line_number: usize,
    pub commit_id: String,
    pub author: String,
    pub authored_at: i64,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBisectStatus {
    pub active: bool,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitSubmoduleInfo {
    pub name: String,
    pub path: String,
    pub url: String,
    pub commit_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRewriteStep {
    pub action: String,
    pub commit_id: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitTagInfo {
    pub name: String,
    pub target: String,
    pub annotated: bool,
    pub message: String,
}

fn parse_tags(bytes: &[u8]) -> Vec<GitTagInfo> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|line| {
            let fields = line.splitn(4, TAG_FIELD_SEPARATOR).collect::<Vec<_>>();
            if fields.len() != 4 || fields[0].is_empty() {
                return None;
            }
            Some(GitTagInfo {
                name: fields[0].to_string(),
                target: fields[1].to_string(),
                annotated: fields[2] == "tag",
                message: fields[3].to_string(),
            })
        })
        .collect()
}

fn list_tags(project_path: &str) -> Result<Vec<GitTagInfo>, String> {
    let format = format!(
        "%(refname:short){TAG_FIELD_SEPARATOR}%(objectname){TAG_FIELD_SEPARATOR}%(objecttype){TAG_FIELD_SEPARATOR}%(subject)"
    );
    let output = git_command_output(
        project_path,
        &["for-each-ref", "--sort=-creatordate", &format, "refs/tags"],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(parse_tags(&output.stdout))
}

#[tauri::command]
pub async fn git_list_tags(project_path: String) -> Result<Vec<GitTagInfo>, String> {
    tokio::task::spawn_blocking(move || list_tags(&project_path))
        .await
        .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_get_commit_patch(
    project_path: String,
    commit_id: String,
) -> Result<String, String> {
    validate_commit_ref(&project_path, &commit_id)?;
    tokio::task::spawn_blocking(move || {
        let output = git_command_output(
            &project_path,
            &["format-patch", "-1", "--stdout", "--binary", &commit_id],
        )?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        if output.stdout.len() > MAX_PATCH_BYTES {
            return Err("git_patch_too_large".to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

fn patch_output_path(commit_id: &str) -> Result<PathBuf, String> {
    validate_operation_ref(commit_id)?;
    if !commit_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("git_history_oid_invalid".to_string());
    }
    let root = crate::app_paths::cli_manager_data_dir()?.join("patches");
    fs::create_dir_all(&root).map_err(|error| format!("git_patch_dir_failed:{error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "git_patch_clock_invalid".to_string())?
        .as_secs();
    let short = commit_id.chars().take(12).collect::<String>();
    Ok(root.join(format!("{short}-{timestamp}.patch")))
}

#[tauri::command]
pub async fn git_save_generated_patch(
    commit_id: String,
    content: String,
) -> Result<String, String> {
    if content.is_empty() || content.len() > MAX_PATCH_BYTES {
        return Err("git_patch_content_invalid".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let path = patch_output_path(&commit_id)?;
        fs::write(&path, content.as_bytes())
            .map_err(|error| format!("git_patch_write_failed:{error}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

fn validate_plain_value(value: &str, code: &str, max: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        return Err(code.to_string());
    }
    Ok(())
}

fn output_text(project_path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command_output(project_path, args)?;
    if !output.status.success() {
        let message = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        return Err(message.trim().chars().take(500).collect());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
pub async fn git_list_stashes(project_path: String) -> Result<Vec<GitStashInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let output = output_text(
            &project_path,
            &[
                "stash",
                "list",
                "--date=unix",
                "--format=%gd%x1f%H%x1f%gs%x1f%ct",
            ],
        )?;
        Ok(output
            .lines()
            .take(MAX_LIST_ITEMS)
            .filter_map(|line| {
                let fields = line.splitn(4, TAG_FIELD_SEPARATOR).collect::<Vec<_>>();
                if fields.len() != 4 {
                    return None;
                }
                let subject = fields[2];
                let (branch, message) = subject
                    .split_once(": ")
                    .map(|(left, right)| {
                        (
                            left.trim_start_matches("On ").to_string(),
                            right.to_string(),
                        )
                    })
                    .unwrap_or_else(|| (String::new(), subject.to_string()));
                Some(GitStashInfo {
                    selector: fields[0].to_string(),
                    oid: fields[1].to_string(),
                    branch,
                    message,
                    created_at: fields[3].parse::<i64>().unwrap_or_default() * 1000,
                })
            })
            .collect())
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_stash_create(
    project_path: String,
    message: String,
    include_untracked: bool,
) -> Result<String, String> {
    if message.len() > 512 || message.chars().any(char::is_control) {
        return Err("git_stash_message_invalid".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        let trimmed = message.trim();
        if !trimmed.is_empty() {
            args.extend(["--message", trimmed]);
        }
        run_git_cli(&project_path, &args)
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_stash_action(
    project_path: String,
    action: String,
    selector: String,
) -> Result<String, String> {
    validate_plain_value(&selector, "git_stash_selector_invalid", 64)?;
    tokio::task::spawn_blocking(move || {
        let verb = match action.as_str() {
            "apply" => "apply",
            "pop" => "pop",
            "drop" => "drop",
            _ => return Err("git_stash_action_invalid".to_string()),
        };
        run_git_cli(&project_path, &["stash", verb, &selector])
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_list_remotes(project_path: String) -> Result<Vec<GitRemoteInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let output = output_text(&project_path, &["remote"])?;
        let mut result = Vec::new();
        for name in output
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .take(64)
        {
            validate_plain_value(name, "git_remote_name_invalid", 128)?;
            let fetch_url = output_text(&project_path, &["remote", "get-url", name])?
                .trim()
                .to_string();
            let push_url = output_text(&project_path, &["remote", "get-url", "--push", name])?
                .trim()
                .to_string();
            result.push(GitRemoteInfo {
                name: name.to_string(),
                fetch_url,
                push_url,
            });
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

fn validate_remote_url(url: &str) -> Result<(), String> {
    validate_plain_value(url, "git_remote_url_invalid", 2048)?;
    if url.chars().any(char::is_whitespace) {
        return Err("git_remote_url_invalid".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_remote_action(
    project_path: String,
    action: String,
    name: String,
    value: Option<String>,
) -> Result<String, String> {
    validate_plain_value(&name, "git_remote_name_invalid", 128)?;
    tokio::task::spawn_blocking(move || match action.as_str() {
        "add" => {
            let url = value.as_deref().ok_or("git_remote_url_required")?;
            validate_remote_url(url)?;
            run_git_cli(&project_path, &["remote", "add", &name, url])
        }
        "set-url" => {
            let url = value.as_deref().ok_or("git_remote_url_required")?;
            validate_remote_url(url)?;
            run_git_cli(&project_path, &["remote", "set-url", &name, url])
        }
        "rename" => {
            let next = value.as_deref().ok_or("git_remote_name_required")?;
            validate_plain_value(next, "git_remote_name_invalid", 128)?;
            run_git_cli(&project_path, &["remote", "rename", &name, next])
        }
        "remove" => run_git_cli(&project_path, &["remote", "remove", &name]),
        "fetch" => run_git_cli(&project_path, &["fetch", "--prune", &name]),
        _ => Err("git_remote_action_invalid".to_string()),
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_push_tag(
    project_path: String,
    remote: String,
    tag: String,
) -> Result<String, String> {
    validate_plain_value(&remote, "git_remote_name_invalid", 128)?;
    validate_operation_ref(&tag)?;
    tokio::task::spawn_blocking(move || run_git_cli(&project_path, &["push", &remote, &tag]))
        .await
        .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_delete_remote_branch(
    project_path: String,
    remote: String,
    branch: String,
) -> Result<String, String> {
    validate_plain_value(&remote, "git_remote_name_invalid", 128)?;
    validate_operation_ref(&branch)?;
    tokio::task::spawn_blocking(move || {
        run_git_cli(&project_path, &["push", &remote, "--delete", &branch])
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_force_push_with_lease(
    project_path: String,
    remote: String,
    branch: String,
) -> Result<String, String> {
    validate_plain_value(&remote, "git_remote_name_invalid", 128)?;
    validate_operation_ref(&branch)?;
    tokio::task::spawn_blocking(move || {
        run_git_cli(
            &project_path,
            &["push", "--force-with-lease", &remote, &branch],
        )
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_list_reflog(project_path: String) -> Result<Vec<GitReflogEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let output = output_text(
            &project_path,
            &[
                "reflog",
                "show",
                "--date=unix",
                "--format=%gD%x1f%H%x1f%h%x1f%gs%x1f%ct",
                "-n",
                "200",
            ],
        )?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let fields = line.splitn(5, TAG_FIELD_SEPARATOR).collect::<Vec<_>>();
                if fields.len() != 5 {
                    return None;
                }
                let (action, message) = fields[3]
                    .split_once(": ")
                    .map(|(a, m)| (a.to_string(), m.to_string()))
                    .unwrap_or_else(|| (String::new(), fields[3].to_string()));
                Some(GitReflogEntry {
                    selector: fields[0].to_string(),
                    oid: fields[1].to_string(),
                    short_id: fields[2].to_string(),
                    action,
                    message,
                    authored_at: fields[4].parse::<i64>().unwrap_or_default() * 1000,
                })
            })
            .collect())
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_restore_reflog(
    project_path: String,
    selector: String,
    branch: String,
) -> Result<String, String> {
    validate_operation_ref(&selector)?;
    validate_plain_value(&branch, "invalid_branch", 256)?;
    tokio::task::spawn_blocking(move || {
        run_git_cli(&project_path, &["check-ref-format", "--branch", &branch])?;
        validate_commit_ref(&project_path, &selector)?;
        run_git_cli(&project_path, &["branch", &branch, &selector])
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_file_history(
    project_path: String,
    path: String,
) -> Result<Vec<GitFileHistoryEntry>, String> {
    validate_repo_relative_path(&path)?;
    tokio::task::spawn_blocking(move || {
        let output = output_text(
            &project_path,
            &[
                "log",
                "--follow",
                "--date-order",
                "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s",
                "-n",
                "200",
                "--",
                &path,
            ],
        )?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let fields = line.splitn(5, TAG_FIELD_SEPARATOR).collect::<Vec<_>>();
                (fields.len() == 5).then(|| GitFileHistoryEntry {
                    id: fields[0].to_string(),
                    short_id: fields[1].to_string(),
                    author: fields[2].to_string(),
                    authored_at: fields[3].parse::<i64>().unwrap_or_default() * 1000,
                    title: fields[4].to_string(),
                })
            })
            .collect())
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

fn parse_blame(output: &str) -> Vec<GitBlameLine> {
    let mut result = Vec::new();
    let mut commit_id = String::new();
    let mut line_number = 0usize;
    let mut author = String::new();
    let mut authored_at = 0i64;
    for line in output.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            result.push(GitBlameLine {
                line_number,
                commit_id: commit_id.clone(),
                author: author.clone(),
                authored_at,
                content: content.to_string(),
            });
            continue;
        }
        let mut parts = line.split_whitespace();
        let first = parts.next().unwrap_or_default();
        if first.len() == 40 && first.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            commit_id = first.to_string();
            line_number = parts
                .nth(1)
                .and_then(|value| value.parse().ok())
                .unwrap_or_default();
        } else if let Some(value) = line.strip_prefix("author ") {
            author = value.to_string();
        } else if let Some(value) = line.strip_prefix("author-time ") {
            authored_at = value.parse::<i64>().unwrap_or_default() * 1000;
        }
    }
    result
}

#[tauri::command]
pub async fn git_blame_file(
    project_path: String,
    path: String,
) -> Result<Vec<GitBlameLine>, String> {
    validate_repo_relative_path(&path)?;
    tokio::task::spawn_blocking(move || {
        let output = output_text(
            &project_path,
            &["blame", "--line-porcelain", "HEAD", "--", &path],
        )?;
        if output.len() > MAX_PATCH_BYTES {
            return Err("git_blame_too_large".to_string());
        }
        Ok(parse_blame(&output))
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_bisect_status(project_path: String) -> Result<GitBisectStatus, String> {
    tokio::task::spawn_blocking(move || {
        let output = git_command_output(&project_path, &["bisect", "log"])?;
        if output.status.success() {
            Ok(GitBisectStatus {
                active: true,
                summary: String::from_utf8_lossy(&output.stdout).into_owned(),
            })
        } else {
            Ok(GitBisectStatus {
                active: false,
                summary: String::new(),
            })
        }
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_bisect_action(
    project_path: String,
    action: String,
    good: Option<String>,
    bad: Option<String>,
) -> Result<String, String> {
    if let Some(value) = good.as_deref() {
        validate_commit_ref(&project_path, value)?;
    }
    if let Some(value) = bad.as_deref() {
        validate_commit_ref(&project_path, value)?;
    }
    tokio::task::spawn_blocking(move || match action.as_str() {
        "start" => {
            let good = good.as_deref().ok_or("git_bisect_good_required")?;
            let bad = bad.as_deref().ok_or("git_bisect_bad_required")?;
            run_git_cli(&project_path, &["bisect", "start", bad, good])
        }
        "good" => run_git_cli(&project_path, &["bisect", "good"]),
        "bad" => run_git_cli(&project_path, &["bisect", "bad"]),
        "skip" => run_git_cli(&project_path, &["bisect", "skip"]),
        "reset" => run_git_cli(&project_path, &["bisect", "reset"]),
        _ => Err("git_bisect_action_invalid".to_string()),
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

fn submodule_urls(project_path: &str) -> Result<HashMap<String, (String, String)>, String> {
    let output = git_command_output(
        project_path,
        &[
            "config",
            "--file",
            ".gitmodules",
            "--get-regexp",
            "^submodule\\..*\\.path$",
        ],
    )?;
    if !output.status.success() {
        return Ok(HashMap::new());
    }
    let mut result = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((key, path)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let Some(name) = key
            .strip_prefix("submodule.")
            .and_then(|value| value.strip_suffix(".path"))
        else {
            continue;
        };
        let url_key = format!("submodule.{name}.url");
        let url = output_text(
            project_path,
            &["config", "--file", ".gitmodules", "--get", &url_key],
        )
        .unwrap_or_default()
        .trim()
        .to_string();
        result.insert(path.trim().to_string(), (name.to_string(), url));
    }
    Ok(result)
}

#[tauri::command]
pub async fn git_list_submodules(project_path: String) -> Result<Vec<GitSubmoduleInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let configured = submodule_urls(&project_path)?;
        if configured.is_empty() {
            return Ok(Vec::new());
        }
        let output = git_command_output(&project_path, &["submodule", "status", "--recursive"])?;
        let status_text = String::from_utf8_lossy(&output.stdout);
        let mut statuses = HashMap::new();
        for line in status_text.lines() {
            let status = line.chars().next().unwrap_or(' ');
            let body = line.get(1..).unwrap_or_default().trim();
            let mut fields = body.split_whitespace();
            let oid = fields.next().unwrap_or_default();
            let path = fields.next().unwrap_or_default();
            statuses.insert(path.to_string(), (oid.to_string(), status.to_string()));
        }
        Ok(configured
            .into_iter()
            .map(|(path, (name, url))| {
                let (commit_id, status) = statuses.remove(&path).unwrap_or_default();
                GitSubmoduleInfo {
                    name,
                    path,
                    url,
                    commit_id,
                    status,
                }
            })
            .collect())
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

#[tauri::command]
pub async fn git_submodule_action(
    project_path: String,
    action: String,
    path: Option<String>,
) -> Result<String, String> {
    if let Some(value) = path.as_deref() {
        validate_repo_relative_path(value)?;
    }
    tokio::task::spawn_blocking(move || {
        if let Some(value) = path.as_deref() {
            if !submodule_urls(&project_path)?.contains_key(value) {
                return Err("git_submodule_not_registered".to_string());
            }
        }
        let mut args = match action.as_str() {
            "init" => vec!["submodule", "init"],
            "update" => vec!["submodule", "update", "--init", "--recursive"],
            "sync" => vec!["submodule", "sync", "--recursive"],
            _ => return Err("git_submodule_action_invalid".to_string()),
        };
        if let Some(value) = path.as_deref() {
            args.extend(["--", value]);
        }
        run_git_cli(&project_path, &args)
    })
    .await
    .map_err(|error| format!("task_failed:{error}"))?
}

fn rewrite_commits(
    project_path: &str,
    upstream: &str,
    steps: &[GitRewriteStep],
) -> Result<String, String> {
    validate_operation_ref(upstream)?;
    validate_commit_ref(project_path, upstream)?;
    let dirty = output_text(project_path, &["status", "--porcelain"])?;
    if !dirty.trim().is_empty() {
        return Err("git_rewrite_worktree_dirty".to_string());
    }
    let sequence = output_text(
        project_path,
        &["rev-list", "--reverse", &format!("{upstream}..HEAD")],
    )?;
    let expected = sequence
        .lines()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if expected.is_empty() || expected.len() != steps.len() || expected.len() > 100 {
        return Err("git_rewrite_sequence_invalid".to_string());
    }
    let mut seen = HashSet::new();
    for (expected_id, step) in expected.iter().zip(steps) {
        validate_commit_ref(project_path, &step.commit_id)?;
        if !expected_id.starts_with(&step.commit_id) || !seen.insert(step.commit_id.clone()) {
            return Err("git_rewrite_sequence_invalid".to_string());
        }
        if !matches!(
            step.action.as_str(),
            "pick" | "reword" | "squash" | "fixup" | "drop"
        ) || step.message.len() > 16_384
            || step.message.chars().any(|ch| ch == '\0')
        {
            return Err("git_rewrite_step_invalid".to_string());
        }
    }
    if matches!(
        steps.first().map(|step| step.action.as_str()),
        Some("squash" | "fixup")
    ) {
        return Err("git_rewrite_first_step_invalid".to_string());
    }
    let merge_check = output_text(
        project_path,
        &["rev-list", "--min-parents=2", &format!("{upstream}..HEAD")],
    )?;
    if !merge_check.trim().is_empty() {
        return Err("git_rewrite_merge_commits_unsupported".to_string());
    }

    let original_head = output_text(project_path, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "git_rewrite_clock_invalid")?
        .as_secs();
    let backup_ref = format!("refs/cli-manager/rebase-backup/{timestamp}");
    run_git_cli(project_path, &["update-ref", &backup_ref, &original_head])?;
    run_git_cli(project_path, &["reset", "--hard", upstream])?;
    for step in steps {
        let result = match step.action.as_str() {
            "drop" => Ok(String::new()),
            "pick" => run_git_cli(project_path, &["cherry-pick", &step.commit_id]),
            "reword" => run_git_cli(
                project_path,
                &["cherry-pick", "--no-commit", &step.commit_id],
            )
            .and_then(|_| {
                run_git_cli(
                    project_path,
                    &["commit", "--no-gpg-sign", "--message", &step.message],
                )
            }),
            "fixup" => run_git_cli(
                project_path,
                &["cherry-pick", "--no-commit", &step.commit_id],
            )
            .and_then(|_| {
                run_git_cli(
                    project_path,
                    &["commit", "--amend", "--no-edit", "--no-gpg-sign"],
                )
            }),
            "squash" => {
                let previous = output_text(project_path, &["log", "-1", "--format=%B"])?
                    .trim()
                    .to_string();
                let addition = if step.message.trim().is_empty() {
                    output_text(
                        project_path,
                        &["show", "-s", "--format=%B", &step.commit_id],
                    )?
                    .trim()
                    .to_string()
                } else {
                    step.message.trim().to_string()
                };
                let combined = format!("{previous}\n\n{addition}");
                run_git_cli(
                    project_path,
                    &["cherry-pick", "--no-commit", &step.commit_id],
                )
                .and_then(|_| {
                    run_git_cli(
                        project_path,
                        &["commit", "--amend", "--no-gpg-sign", "--message", &combined],
                    )
                })
            }
            _ => unreachable!(),
        };
        if let Err(error) = result {
            let _ = run_git_cli(project_path, &["cherry-pick", "--abort"]);
            let _ = run_git_cli(project_path, &["reset", "--hard", &original_head]);
            return Err(format!("git_rewrite_failed:{error};backup={backup_ref}"));
        }
    }
    Ok(backup_ref)
}

#[tauri::command]
pub async fn git_rewrite_commits(
    project_path: String,
    upstream: String,
    steps: Vec<GitRewriteStep>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || rewrite_commits(&project_path, &upstream, &steps))
        .await
        .map_err(|error| format!("task_failed:{error}"))?
}

#[cfg(test)]
mod tests {
    use super::{parse_blame, parse_tags, rewrite_commits, GitRewriteStep, TAG_FIELD_SEPARATOR};
    use std::path::Path;
    use std::process::Command;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn commit(path: &Path, file: &str, content: &str, message: &str) -> String {
        std::fs::write(path.join(file), content).unwrap();
        git(path, &["add", "--", file]);
        git(path, &["commit", "--no-gpg-sign", "-m", message]);
        git(path, &["rev-parse", "HEAD"])
    }

    #[test]
    fn parses_lightweight_and_annotated_tags() {
        let input = format!(
            "v2{0}2222{0}tag{0}release two\nv1{0}1111{0}commit{0}release one\n",
            TAG_FIELD_SEPARATOR
        );
        let tags = parse_tags(input.as_bytes());
        assert_eq!(tags.len(), 2);
        assert!(tags[0].annotated);
        assert!(!tags[1].annotated);
    }

    #[test]
    fn parses_porcelain_blame_lines() {
        let oid = "0123456789012345678901234567890123456789";
        let input = format!("{oid} 1 7 1\nauthor Alice\nauthor-time 100\n\tlet answer = 42;\n");
        let lines = parse_blame(&input);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].line_number, 7);
        assert_eq!(lines[0].author, "Alice");
        assert_eq!(lines[0].authored_at, 100_000);
    }

    #[test]
    fn structured_rewrite_rewords_and_keeps_backup_ref() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        git(path, &["init"]);
        git(path, &["config", "user.name", "CLI Manager Test"]);
        git(
            path,
            &["config", "user.email", "cli-manager@example.invalid"],
        );
        let base = commit(path, "file.txt", "base\n", "base");
        let first = commit(path, "file.txt", "base\none\n", "first");
        let second = commit(path, "file.txt", "base\none\ntwo\n", "second");
        let backup = rewrite_commits(
            path.to_str().unwrap(),
            &base,
            &[
                GitRewriteStep {
                    action: "pick".into(),
                    commit_id: first,
                    message: "first".into(),
                },
                GitRewriteStep {
                    action: "reword".into(),
                    commit_id: second,
                    message: "second rewritten".into(),
                },
            ],
        )
        .unwrap();
        assert!(backup.starts_with("refs/cli-manager/rebase-backup/"));
        assert_eq!(git(path, &["log", "-1", "--format=%s"]), "second rewritten");
        assert!(!git(path, &["rev-parse", "--verify", &backup]).is_empty());
    }
}
