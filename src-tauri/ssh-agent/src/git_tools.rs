use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::git::{as_of_ms, resolve_repo, run_git, validate_repo_relative_path, READ_TIMEOUT};

const FIELD_SEPARATOR: char = '\x1f';
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_LIST_ITEMS: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepoRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StashCreateRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    include_untracked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StashActionRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    action: String,
    selector: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteActionRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    action: String,
    name: String,
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteRefRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    remote: String,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    tag: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReflogRestoreRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    selector: String,
    branch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BisectActionRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    action: String,
    #[serde(default)]
    good: Option<String>,
    #[serde(default)]
    bad: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmoduleActionRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    action: String,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RewriteStep {
    action: String,
    commit_id: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RewriteRequest {
    root_path: String,
    #[serde(default)]
    repo_path: String,
    upstream: String,
    steps: Vec<RewriteStep>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StashInfo {
    selector: String,
    oid: String,
    branch: String,
    message: String,
    created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteInfo {
    name: String,
    fetch_url: String,
    push_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReflogEntry {
    selector: String,
    oid: String,
    short_id: String,
    action: String,
    message: String,
    authored_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileHistoryEntry {
    id: String,
    short_id: String,
    author: String,
    authored_at: i64,
    title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlameLine {
    line_number: usize,
    commit_id: String,
    author: String,
    authored_at: i64,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmoduleInfo {
    name: String,
    path: String,
    url: String,
    commit_id: String,
    status: String,
}

pub fn handles(kind: &str) -> bool {
    matches!(
        kind,
        "gitListStashes"
            | "gitStashCreate"
            | "gitStashAction"
            | "gitListRemotes"
            | "gitRemoteAction"
            | "gitPushTag"
            | "gitDeleteRemoteBranch"
            | "gitForcePushWithLease"
            | "gitListReflog"
            | "gitRestoreReflog"
            | "gitFileHistory"
            | "gitBlameFile"
            | "gitBisectStatus"
            | "gitBisectAction"
            | "gitListSubmodules"
            | "gitSubmoduleAction"
            | "gitRewriteCommits"
    )
}

fn parse<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T, String> {
    serde_json::from_value(payload).map_err(|_| "remote_git_request_invalid".to_string())
}

fn validate_value(value: &str, code: &str, max: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max
        || value.starts_with('-')
        || value.contains(['\0', '\r', '\n'])
    {
        return Err(code.to_string());
    }
    Ok(())
}

fn validate_ref(value: &str) -> Result<(), String> {
    validate_value(value, "invalid_git_ref", 256)?;
    if value.chars().any(char::is_whitespace) {
        return Err("invalid_git_ref".to_string());
    }
    Ok(())
}

fn output(repo: &Path, args: &[&str], network: bool) -> Result<String, String> {
    let value = run_git(
        repo,
        args,
        network,
        if network {
            std::time::Duration::from_secs(120)
        } else {
            READ_TIMEOUT
        },
    )?;
    if value.stdout.len() > MAX_OUTPUT_BYTES {
        return Err("remote_git_output_too_large".to_string());
    }
    Ok(String::from_utf8_lossy(&value.stdout).into_owned())
}

fn validate_commit(repo: &Path, value: &str) -> Result<(), String> {
    validate_ref(value)?;
    let commit = format!("{value}^{{commit}}");
    output(repo, &["rev-parse", "--verify", &commit], false)
        .map(|_| ())
        .map_err(|_| "git_history_commit_not_found".to_string())
}

fn mutation(value: String) -> Value {
    json!({ "output": value, "asOf": as_of_ms() })
}

fn list_stashes(request: RepoRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let text = output(
        &repo,
        &[
            "stash",
            "list",
            "--date=unix",
            "--format=%gd%x1f%H%x1f%gs%x1f%ct",
        ],
        false,
    )?;
    let stashes = text
        .lines()
        .take(MAX_LIST_ITEMS)
        .filter_map(|line| {
            let fields = line.splitn(4, FIELD_SEPARATOR).collect::<Vec<_>>();
            if fields.len() != 4 {
                return None;
            }
            let (branch, message) = fields[2]
                .split_once(": ")
                .map(|(a, b)| (a.trim_start_matches("On ").to_string(), b.to_string()))
                .unwrap_or_else(|| (String::new(), fields[2].to_string()));
            Some(StashInfo {
                selector: fields[0].to_string(),
                oid: fields[1].to_string(),
                branch,
                message,
                created_at: fields[3].parse::<i64>().unwrap_or_default() * 1000,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "stashes": stashes, "asOf": as_of_ms() }))
}

fn stash_create(request: StashCreateRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    if request.message.len() > 512 || request.message.contains(['\0', '\r', '\n']) {
        return Err("git_stash_message_invalid".to_string());
    }
    let mut args = vec!["stash", "push"];
    if request.include_untracked {
        args.push("--include-untracked");
    }
    let message = request.message.trim();
    if !message.is_empty() {
        args.extend(["--message", message]);
    }
    Ok(mutation(output(&repo, &args, false)?))
}

fn stash_action(request: StashActionRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    validate_value(&request.selector, "git_stash_selector_invalid", 64)?;
    let verb = match request.action.as_str() {
        "apply" => "apply",
        "pop" => "pop",
        "drop" => "drop",
        _ => return Err("git_stash_action_invalid".to_string()),
    };
    Ok(mutation(output(
        &repo,
        &["stash", verb, &request.selector],
        false,
    )?))
}

fn list_remotes(request: RepoRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let names = output(&repo, &["remote"], false)?;
    let mut remotes = Vec::new();
    for name in names
        .lines()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .take(64)
    {
        validate_value(name, "git_remote_name_invalid", 128)?;
        let fetch_url = output(&repo, &["remote", "get-url", name], false)?
            .trim()
            .to_string();
        let push_url = output(&repo, &["remote", "get-url", "--push", name], false)?
            .trim()
            .to_string();
        remotes.push(RemoteInfo {
            name: name.to_string(),
            fetch_url,
            push_url,
        });
    }
    Ok(json!({ "remotes": remotes, "asOf": as_of_ms() }))
}

fn remote_action(request: RemoteActionRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    validate_value(&request.name, "git_remote_name_invalid", 128)?;
    let value = request.value.as_deref();
    let text = match request.action.as_str() {
        "add" => {
            let url = value.ok_or("git_remote_url_required")?;
            validate_value(url, "git_remote_url_invalid", 2048)?;
            output(&repo, &["remote", "add", &request.name, url], false)?
        }
        "set-url" => {
            let url = value.ok_or("git_remote_url_required")?;
            validate_value(url, "git_remote_url_invalid", 2048)?;
            output(&repo, &["remote", "set-url", &request.name, url], false)?
        }
        "rename" => {
            let next = value.ok_or("git_remote_name_required")?;
            validate_value(next, "git_remote_name_invalid", 128)?;
            output(&repo, &["remote", "rename", &request.name, next], false)?
        }
        "remove" => output(&repo, &["remote", "remove", &request.name], false)?,
        "fetch" => output(&repo, &["fetch", "--prune", &request.name], true)?,
        _ => return Err("git_remote_action_invalid".to_string()),
    };
    Ok(mutation(text))
}

fn remote_ref(request: RemoteRefRequest, action: &str) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    validate_value(&request.remote, "git_remote_name_invalid", 128)?;
    let args = match action {
        "push-tag" => {
            let tag = request.tag.as_deref().ok_or("git_tag_required")?;
            validate_ref(tag)?;
            vec!["push", request.remote.as_str(), tag]
        }
        "delete-branch" => {
            let branch = request.branch.as_deref().ok_or("branch_required")?;
            validate_ref(branch)?;
            vec!["push", request.remote.as_str(), "--delete", branch]
        }
        "force-lease" => {
            let branch = request.branch.as_deref().ok_or("branch_required")?;
            validate_ref(branch)?;
            vec![
                "push",
                "--force-with-lease",
                request.remote.as_str(),
                branch,
            ]
        }
        _ => return Err("remote_git_action_invalid".to_string()),
    };
    Ok(mutation(output(&repo, &args, true)?))
}

fn list_reflog(request: RepoRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let text = output(
        &repo,
        &[
            "reflog",
            "show",
            "--date=unix",
            "--format=%gD%x1f%H%x1f%h%x1f%gs%x1f%ct",
            "-n",
            "200",
        ],
        false,
    )?;
    let entries = text
        .lines()
        .filter_map(|line| {
            let fields = line.splitn(5, FIELD_SEPARATOR).collect::<Vec<_>>();
            if fields.len() != 5 {
                return None;
            }
            let (action, message) = fields[3]
                .split_once(": ")
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .unwrap_or_else(|| (String::new(), fields[3].to_string()));
            Some(ReflogEntry {
                selector: fields[0].to_string(),
                oid: fields[1].to_string(),
                short_id: fields[2].to_string(),
                action,
                message,
                authored_at: fields[4].parse::<i64>().unwrap_or_default() * 1000,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "entries": entries, "asOf": as_of_ms() }))
}

fn restore_reflog(request: ReflogRestoreRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    validate_ref(&request.selector)?;
    validate_value(&request.branch, "invalid_branch", 256)?;
    validate_commit(&repo, &request.selector)?;
    output(
        &repo,
        &["check-ref-format", "--branch", &request.branch],
        false,
    )?;
    Ok(mutation(output(
        &repo,
        &["branch", &request.branch, &request.selector],
        false,
    )?))
}

fn file_history(request: FileRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let path = validate_repo_relative_path(&request.path)?;
    let text = output(
        &repo,
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
        false,
    )?;
    let entries = text
        .lines()
        .filter_map(|line| {
            let f = line.splitn(5, FIELD_SEPARATOR).collect::<Vec<_>>();
            (f.len() == 5).then(|| FileHistoryEntry {
                id: f[0].into(),
                short_id: f[1].into(),
                author: f[2].into(),
                authored_at: f[3].parse::<i64>().unwrap_or_default() * 1000,
                title: f[4].into(),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "entries": entries, "asOf": as_of_ms() }))
}

fn blame_file(request: FileRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let path = validate_repo_relative_path(&request.path)?;
    let text = output(
        &repo,
        &["blame", "--line-porcelain", "HEAD", "--", &path],
        false,
    )?;
    let mut lines = Vec::new();
    let mut commit_id = String::new();
    let mut line_number = 0usize;
    let mut author = String::new();
    let mut authored_at = 0i64;
    for line in text.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            lines.push(BlameLine {
                line_number,
                commit_id: commit_id.clone(),
                author: author.clone(),
                authored_at,
                content: content.into(),
            });
            continue;
        }
        let mut p = line.split_whitespace();
        let first = p.next().unwrap_or_default();
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            commit_id = first.into();
            line_number = p.nth(1).and_then(|v| v.parse().ok()).unwrap_or_default();
        } else if let Some(v) = line.strip_prefix("author ") {
            author = v.into();
        } else if let Some(v) = line.strip_prefix("author-time ") {
            authored_at = v.parse::<i64>().unwrap_or_default() * 1000;
        }
    }
    Ok(json!({ "lines": lines, "asOf": as_of_ms() }))
}

fn bisect_status(request: RepoRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    match run_git(&repo, &["bisect", "log"], false, READ_TIMEOUT) {
        Ok(value) => Ok(
            json!({"status":{"active":true,"summary":String::from_utf8_lossy(&value.stdout)},"asOf":as_of_ms()}),
        ),
        Err(_) => Ok(json!({"status":{"active":false,"summary":""},"asOf":as_of_ms()})),
    }
}

fn bisect_action(request: BisectActionRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    if let Some(v) = request.good.as_deref() {
        validate_commit(&repo, v)?;
    }
    if let Some(v) = request.bad.as_deref() {
        validate_commit(&repo, v)?;
    }
    let args = match request.action.as_str() {
        "start" => vec![
            "bisect",
            "start",
            request.bad.as_deref().ok_or("git_bisect_bad_required")?,
            request.good.as_deref().ok_or("git_bisect_good_required")?,
        ],
        "good" => vec!["bisect", "good"],
        "bad" => vec!["bisect", "bad"],
        "skip" => vec!["bisect", "skip"],
        "reset" => vec!["bisect", "reset"],
        _ => return Err("git_bisect_action_invalid".into()),
    };
    Ok(mutation(output(&repo, &args, false)?))
}

fn submodule_urls(repo: &Path) -> Result<HashMap<String, (String, String)>, String> {
    let result = run_git(
        repo,
        &[
            "config",
            "--file",
            ".gitmodules",
            "--get-regexp",
            "^submodule\\..*\\.path$",
        ],
        false,
        READ_TIMEOUT,
    );
    let Ok(value) = result else {
        return Ok(HashMap::new());
    };
    let mut map = HashMap::new();
    for line in String::from_utf8_lossy(&value.stdout).lines() {
        let Some((key, path)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let Some(name) = key
            .strip_prefix("submodule.")
            .and_then(|v| v.strip_suffix(".path"))
        else {
            continue;
        };
        let url_key = format!("submodule.{name}.url");
        let url = output(
            repo,
            &["config", "--file", ".gitmodules", "--get", &url_key],
            false,
        )
        .unwrap_or_default()
        .trim()
        .into();
        map.insert(path.trim().into(), (name.into(), url));
    }
    Ok(map)
}

fn list_submodules(request: RepoRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let configured = submodule_urls(&repo)?;
    let mut statuses = HashMap::new();
    if !configured.is_empty() {
        if let Ok(text) = output(&repo, &["submodule", "status", "--recursive"], false) {
            for line in text.lines() {
                let status = line.chars().next().unwrap_or(' ').to_string();
                let mut p = line.get(1..).unwrap_or_default().trim().split_whitespace();
                let oid = p.next().unwrap_or_default().to_string();
                let path = p.next().unwrap_or_default().to_string();
                statuses.insert(path, (oid, status));
            }
        }
    }
    let modules = configured
        .into_iter()
        .map(|(path, (name, url))| {
            let (commit_id, status) = statuses.remove(&path).unwrap_or_default();
            SubmoduleInfo {
                name,
                path,
                url,
                commit_id,
                status,
            }
        })
        .collect::<Vec<_>>();
    Ok(json!({"submodules":modules,"asOf":as_of_ms()}))
}

fn submodule_action(request: SubmoduleActionRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    if let Some(path) = request.path.as_deref() {
        validate_repo_relative_path(path)?;
        if !submodule_urls(&repo)?.contains_key(path) {
            return Err("git_submodule_not_registered".into());
        }
    }
    let mut args = match request.action.as_str() {
        "init" => vec!["submodule", "init"],
        "update" => vec!["submodule", "update", "--init", "--recursive"],
        "sync" => vec!["submodule", "sync", "--recursive"],
        _ => return Err("git_submodule_action_invalid".into()),
    };
    if let Some(path) = request.path.as_deref() {
        args.extend(["--", path]);
    }
    Ok(mutation(output(&repo, &args, true)?))
}

fn rewrite(request: RewriteRequest) -> Result<Value, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    validate_ref(&request.upstream)?;
    validate_commit(&repo, &request.upstream)?;
    if !output(&repo, &["status", "--porcelain"], false)?
        .trim()
        .is_empty()
    {
        return Err("git_rewrite_worktree_dirty".into());
    }
    let range = format!("{}..HEAD", request.upstream);
    let sequence = output(&repo, &["rev-list", "--reverse", &range], false)?;
    let expected = sequence
        .lines()
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    if expected.is_empty() || expected.len() != request.steps.len() || expected.len() > 100 {
        return Err("git_rewrite_sequence_invalid".into());
    }
    let mut seen = HashSet::new();
    for (expected_id, step) in expected.iter().zip(&request.steps) {
        validate_commit(&repo, &step.commit_id)?;
        if !expected_id.starts_with(&step.commit_id) || !seen.insert(step.commit_id.clone()) {
            return Err("git_rewrite_sequence_invalid".into());
        }
        if !matches!(
            step.action.as_str(),
            "pick" | "reword" | "squash" | "fixup" | "drop"
        ) || step.message.len() > 16384
            || step.message.contains('\0')
        {
            return Err("git_rewrite_step_invalid".into());
        }
    }
    if matches!(
        request.steps.first().map(|v| v.action.as_str()),
        Some("squash" | "fixup")
    ) {
        return Err("git_rewrite_first_step_invalid".into());
    }
    if !output(&repo, &["rev-list", "--min-parents=2", &range], false)?
        .trim()
        .is_empty()
    {
        return Err("git_rewrite_merge_commits_unsupported".into());
    }
    let original = output(&repo, &["rev-parse", "HEAD"], false)?
        .trim()
        .to_string();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "git_rewrite_clock_invalid")?
        .as_secs();
    let backup = format!("refs/cli-manager/rebase-backup/{timestamp}");
    output(&repo, &["update-ref", &backup, &original], false)?;
    output(&repo, &["reset", "--hard", &request.upstream], false)?;
    for step in &request.steps {
        let result = match step.action.as_str() {
            "drop" => Ok(String::new()),
            "pick" => output(&repo, &["cherry-pick", &step.commit_id], false),
            "reword" => output(
                &repo,
                &["cherry-pick", "--no-commit", &step.commit_id],
                false,
            )
            .and_then(|_| {
                output(
                    &repo,
                    &["commit", "--no-gpg-sign", "--message", &step.message],
                    false,
                )
            }),
            "fixup" => output(
                &repo,
                &["cherry-pick", "--no-commit", &step.commit_id],
                false,
            )
            .and_then(|_| {
                output(
                    &repo,
                    &["commit", "--amend", "--no-edit", "--no-gpg-sign"],
                    false,
                )
            }),
            "squash" => {
                let previous = output(&repo, &["log", "-1", "--format=%B"], false)?
                    .trim()
                    .to_string();
                let addition = if step.message.trim().is_empty() {
                    output(
                        &repo,
                        &["show", "-s", "--format=%B", &step.commit_id],
                        false,
                    )?
                    .trim()
                    .to_string()
                } else {
                    step.message.trim().to_string()
                };
                let combined = format!("{previous}\n\n{addition}");
                output(
                    &repo,
                    &["cherry-pick", "--no-commit", &step.commit_id],
                    false,
                )
                .and_then(|_| {
                    output(
                        &repo,
                        &["commit", "--amend", "--no-gpg-sign", "--message", &combined],
                        false,
                    )
                })
            }
            _ => unreachable!(),
        };
        if let Err(error) = result {
            let _ = output(&repo, &["cherry-pick", "--abort"], false);
            let _ = output(&repo, &["reset", "--hard", &original], false);
            return Err(format!("git_rewrite_failed:{error};backup={backup}"));
        }
    }
    Ok(mutation(backup))
}

pub fn dispatch(kind: &str, payload: Value) -> Result<Value, String> {
    match kind {
        "gitListStashes" => list_stashes(parse(payload)?),
        "gitStashCreate" => stash_create(parse(payload)?),
        "gitStashAction" => stash_action(parse(payload)?),
        "gitListRemotes" => list_remotes(parse(payload)?),
        "gitRemoteAction" => remote_action(parse(payload)?),
        "gitPushTag" => remote_ref(parse(payload)?, "push-tag"),
        "gitDeleteRemoteBranch" => remote_ref(parse(payload)?, "delete-branch"),
        "gitForcePushWithLease" => remote_ref(parse(payload)?, "force-lease"),
        "gitListReflog" => list_reflog(parse(payload)?),
        "gitRestoreReflog" => restore_reflog(parse(payload)?),
        "gitFileHistory" => file_history(parse(payload)?),
        "gitBlameFile" => blame_file(parse(payload)?),
        "gitBisectStatus" => bisect_status(parse(payload)?),
        "gitBisectAction" => bisect_action(parse(payload)?),
        "gitListSubmodules" => list_submodules(parse(payload)?),
        "gitSubmoduleAction" => submodule_action(parse(payload)?),
        "gitRewriteCommits" => rewrite(parse(payload)?),
        _ => Err("remote_git_kind_invalid".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{dispatch, handles};
    use serde_json::json;

    #[test]
    fn advertises_only_workspace_tool_requests() {
        assert!(handles("gitListStashes"));
        assert!(handles("gitRewriteCommits"));
        assert!(!handles("gitChanges"));
    }

    #[test]
    fn rejects_unknown_fields_before_touching_a_repository() {
        let error = dispatch(
            "gitListStashes",
            json!({ "rootPath": "/tmp", "repoPath": "", "extra": true }),
        )
        .unwrap_err();
        assert_eq!(error, "remote_git_request_invalid");
    }
}
