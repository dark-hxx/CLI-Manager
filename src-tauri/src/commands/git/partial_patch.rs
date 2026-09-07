use super::parse_hunk_header;

/// 行级反向单个 hunk：仅回滚选中的行。返回 None 表示该 hunk 无选中行（应跳过）。
///
/// 规则（撤销选中改动）：
/// * 上下文行：保留为上下文。
/// * 选中的 `-` 行（HEAD 有 / workdir 无）：反向为 `+`（恢复）。
/// * 未选中的 `-` 行：从反向 patch 省略（workdir 本就没有）。
/// * 选中的 `+` 行（workdir 有 / HEAD 无）：反向为 `-`（删除）。
/// * 未选中的 `+` 行：降为上下文（workdir 仍有，需用于对齐）。
/// 行号区间按反向后的实际行数重算（反向 old 侧起点 = 原 new_start）。
pub(super) fn reverse_hunk_lines(
    hunk: &[&str],
    selected: &std::collections::HashSet<(String, u32)>,
) -> Result<Option<String>, String> {
    let header = *hunk.first().ok_or("empty_hunk")?;
    let cr = header.ends_with('\r');
    let (old_start, _oc, new_start, _nc, heading) =
        parse_hunk_header(header.trim_end_matches('\r'))?;

    let mut cur_old = old_start;
    let mut cur_new = new_start;
    let mut body: Vec<String> = Vec::new();
    let mut rev_old_count = 0u32; // 反向后 old 侧行数（context + '-'）
    let mut rev_new_count = 0u32; // 反向后 new 侧行数（context + '+'）
    let mut any_selected = false;

    for &line in &hunk[1..] {
        if line.is_empty() {
            continue;
        }
        let first = line.as_bytes()[0];
        let content = &line[1..];
        match first {
            b' ' => {
                body.push(format!(" {content}"));
                rev_old_count += 1;
                rev_new_count += 1;
                cur_old += 1;
                cur_new += 1;
            }
            b'-' => {
                let hit = selected.contains(&("old".to_string(), cur_old));
                cur_old += 1;
                if hit {
                    body.push(format!("+{content}"));
                    rev_new_count += 1;
                    any_selected = true;
                }
                // 未选中：省略
            }
            b'+' => {
                let hit = selected.contains(&("new".to_string(), cur_new));
                cur_new += 1;
                if hit {
                    body.push(format!("-{content}"));
                    rev_old_count += 1;
                    any_selected = true;
                } else {
                    body.push(format!(" {content}"));
                    rev_old_count += 1;
                    rev_new_count += 1;
                }
            }
            b'\\' => {
                // 无尾换行标记：原样保留（关联前一行）。
                body.push(line.to_string());
            }
            _ => body.push(line.to_string()),
        }
    }

    if !any_selected {
        return Ok(None);
    }

    let mut new_header = format!(
        "@@ -{},{} +{},{} @@{}",
        new_start, rev_old_count, new_start, rev_new_count, heading
    );
    if cr {
        new_header.push('\r');
    }

    let mut out = vec![new_header];
    out.extend(body);
    Ok(Some(out.join("\n")))
}

/// 从完整 unified diff 文本构造行级反向 patch：仅回滚 `selected` 中的行。
/// 跨多个 hunk 的选择逐 hunk 处理并合并；无选中行的 hunk 跳过。纯函数，便于单测。
pub(super) fn build_reverse_lines_patch(
    diff_text: &str,
    selected: &[(String, u32)],
) -> Result<String, String> {
    let sel: std::collections::HashSet<(String, u32)> = selected.iter().cloned().collect();

    let lines: Vec<&str> = diff_text.split('\n').collect();
    let mut header: Vec<&str> = Vec::new();
    let mut idx = 0;
    while idx < lines.len() && !lines[idx].starts_with("@@") {
        header.push(lines[idx]);
        idx += 1;
    }

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

    let mut rev_hunks: Vec<String> = Vec::new();
    for hunk in &hunks {
        if let Some(rev) = reverse_hunk_lines(hunk, &sel)? {
            rev_hunks.push(rev);
        }
    }

    if rev_hunks.is_empty() {
        return Err("no_lines_selected".to_string());
    }

    let mut out: Vec<String> = header.iter().map(|s| s.to_string()).collect();
    out.extend(rev_hunks);
    let mut result = out.join("\n");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}
