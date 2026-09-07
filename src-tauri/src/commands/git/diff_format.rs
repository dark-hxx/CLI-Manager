use super::BoundedPatch;

pub(in crate::commands) fn format_diff_to_text_allow_empty(
    diff: &git2::Diff,
) -> Result<String, String> {
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

pub(super) fn format_diff_to_bounded_text(
    diff: &git2::Diff,
    max_bytes: usize,
) -> Result<BoundedPatch, String> {
    let mut patch_text = String::new();
    let mut patch_bytes = 0usize;
    let mut truncated = false;

    let result = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if line.origin() == 'B' {
            truncated = true;
            return false;
        }
        let prefix_bytes = usize::from(matches!(line.origin(), '+' | '-' | ' '));
        let line_bytes = prefix_bytes.saturating_add(line.content().len());
        patch_bytes = patch_bytes.saturating_add(line_bytes);
        if patch_text.len().saturating_add(line_bytes) > max_bytes {
            truncated = true;
            return false;
        }
        match line.origin() {
            '+' | '-' | ' ' => patch_text.push(line.origin()),
            _ => {}
        }
        patch_text.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    });

    if let Err(err) = result {
        if !truncated {
            return Err(format!("打印受限 diff 失败: {}", err));
        }
    }
    if truncated {
        patch_text = String::new();
    }

    Ok(BoundedPatch {
        text: patch_text,
        bytes: patch_bytes,
        truncated,
    })
}

/// 校验前端传入的 repo 相对路径（前端不可信，防越界）。
///
/// 纯函数，便于单测。返回稳定错误字符串供前端分支。
pub(in crate::commands) fn validate_repo_relative_path(p: &str) -> Result<(), String> {
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
