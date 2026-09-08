use super::open_git_repo;
use git2::Repository;
use std::path::Path;

/// 解析 unified diff 的 hunk 头 `@@ -a,b +c,d @@ heading`。
/// 返回 (old_start, old_count, new_start, new_count, heading)。count 省略时为 1。
// 解析 unified hunk 的新旧起点、行数和标题，省略行数时取一。
pub(super) fn parse_hunk_header(header: &str) -> Result<(u32, u32, u32, u32, String), String> {
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

// 解析起点及可选逗号行数，缺省行数为一。
pub(super) fn parse_range(s: &str) -> Result<(u32, u32), String> {
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
// 交换 hunk 新旧范围与增删前缀，保留上下文、无末尾换行标记及 CR。
pub(super) fn reverse_hunk(hunk: &[&str]) -> Result<Vec<String>, String> {
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
// 按索引提取一个 hunk 并反向，保留原文件头和末尾换行。
pub(super) fn build_reverse_hunk_patch(
    diff_text: &str,
    hunk_index: usize,
) -> Result<String, String> {
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
// 解析反向 Patch，先检查可应用性，再仅应用到工作区。
pub(super) fn apply_patch_to_repo(repo: &Repository, reverse_patch: &str) -> Result<(), String> {
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

// 检查路径并打开仓库，再执行工作区 Patch 的预检及正式应用。
pub(super) fn apply_patch_to_workdir(
    project_path: &str,
    reverse_patch: &str,
) -> Result<(), String> {
    let path = Path::new(project_path);
    if !crate::wsl::is_wsl_config_dir(project_path) && !path.exists() {
        return Err("path_not_found".to_string());
    }
    let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
    apply_patch_to_repo(&repo, reverse_patch)
}
