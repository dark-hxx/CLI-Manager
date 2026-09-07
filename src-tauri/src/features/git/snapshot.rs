use super::{
    collect_git_changes_from_repo, format_diff_to_bounded_text, normalize_path, repo_branch_name,
    repo_head_oid, run_wsl_git, BoundedPatch, GitWorktreeSnapshot, GIT_DIFF_LINE_STATS_LINE_LIMIT,
    GIT_DIFF_LINE_STATS_STATUS_LIMIT, MAX_WORKTREE_PATCH_BYTES,
    OOM_SNAPSHOT_PATCH_RETURN_MAX_BYTES,
};
use git2::{DiffOptions, Repository};

pub(super) fn build_worktree_patch(repo: &Repository) -> Result<BoundedPatch, String> {
    let head_tree = repo
        .head()
        .and_then(|head| head.peel_to_tree())
        .map_err(|e| format!("head_tree_failed: {e}"))?;

    let mut diff_opts = DiffOptions::new();
    diff_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .show_binary(false)
        .max_size(MAX_WORKTREE_PATCH_BYTES as i64)
        .context_lines(3);

    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut diff_opts))
        .map_err(|e| format!("snapshot_diff_failed: {e}"))?;
    format_diff_to_bounded_text(&diff, MAX_WORKTREE_PATCH_BYTES)
}

pub(super) fn build_worktree_snapshot(
    project_path: &str,
    repo: &Repository,
) -> Result<GitWorktreeSnapshot, String> {
    let files = collect_git_changes_from_repo(repo)?;
    let patch = build_worktree_patch(repo)?;
    Ok(GitWorktreeSnapshot {
        project_path: project_path.to_string(),
        head: repo_head_oid(repo)?,
        branch: repo_branch_name(repo),
        dirty: patch.truncated || !patch.text.trim().is_empty() || !files.is_empty(),
        patch: patch.text,
        patch_bytes: patch.bytes,
        patch_truncated: patch.truncated,
        files,
    })
}

pub(super) fn truncate_snapshot_patch_for_webview(snapshot: &mut GitWorktreeSnapshot) {
    if snapshot.patch.len() <= OOM_SNAPSHOT_PATCH_RETURN_MAX_BYTES {
        return;
    }
    // Assignment drops the oversized allocation; String::clear() would retain its capacity.
    snapshot.patch = String::new();
    snapshot.patch_truncated = true;
}

pub(super) fn should_skip_diff_line_stats(status_count: usize) -> bool {
    status_count > GIT_DIFF_LINE_STATS_STATUS_LIMIT
}

/// 一次性计算仓库内所有变更文件的真实增删行数（相对 HEAD，合并暂存区+工作区+未跟踪）。
///
/// 单次 `diff_tree_to_workdir_with_index` + `foreach` 累加，避免逐文件多次 diff 的 N 次扫描。
/// 二进制文件不进入 line callback，自然为 (0, 0)。失败时降级为空表（统计显示 0，不影响列表）。
///
/// # Returns
/// 路径（正斜杠归一化）→ (新增行数, 删除行数)
pub(super) fn compute_diff_line_stats(
    repo: &Repository,
) -> std::collections::HashMap<String, (i32, i32)> {
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
    log::debug!(
        "[git_get_changes] diff 行数统计完成 files={} lines_seen={} truncated={} elapsed_ms={}",
        map.len(),
        seen_lines,
        truncated,
        started_at.elapsed().as_millis()
    );

    map
}

pub(super) fn compute_wsl_diff_line_stats(
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
    log::debug!(
        "[git_get_changes:wsl] diff numstat 完成 files={} elapsed_ms={}",
        stats.len(),
        started_at.elapsed().as_millis()
    );
    Ok(stats)
}

pub(super) fn parse_wsl_numstat(stdout: &[u8]) -> std::collections::HashMap<String, (i32, i32)> {
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

pub(super) fn parse_numstat_count(value: &str) -> Option<i32> {
    if value == "-" {
        return Some(0);
    }
    value.parse::<i32>().ok()
}
