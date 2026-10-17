//! 修補文字解析成差異段落：apply_patch 的格式、統一差異格式（`@@ -a,b +c,d @@`）與刪除的檔案。
//! 這裡保留完整的段落，顯示時的上限由 `diff::cap` 套用。

use crate::event::Hunk;

/// apply_patch 修補中的一個檔案。
pub(super) struct Change {
    pub(super) path: String,
    pub(super) moved: Option<String>,
    pub(super) added: bool,
    pub(super) hunks: Vec<Hunk>,
}

/// 解析 apply_patch 的修補文字（`*** Add File:`、`*** Update File:`、`*** Delete File:`、
/// `*** Move to:` 與 `@@` 段落）。修補沒有行號，段落的起始行記為 0；新增檔案從第 1 行起。
pub(super) fn parse_patch(text: &str) -> Vec<Change> {
    let mut changes: Vec<Change> = Vec::new();
    for line in text.lines() {
        let file = |path: &str, added: bool| Change {
            path: path.trim().into(),
            moved: None,
            added,
            hunks: Vec::new(),
        };
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            changes.push(file(path, true));
        } else if let Some(path) = line
            .strip_prefix("*** Update File: ")
            .or_else(|| line.strip_prefix("*** Delete File: "))
        {
            changes.push(file(path, false));
        } else if let Some(path) = line.strip_prefix("*** Move to: ") {
            if let Some(change) = changes.last_mut() {
                change.moved = Some(path.trim().into());
            }
        } else if line.starts_with("*** End Patch") {
            break;
        } else if line.starts_with("*** ") {
            continue;
        } else if let Some(change) = changes.last_mut() {
            if change.added {
                if let Some(content) = line.strip_prefix('+') {
                    if change.hunks.is_empty() {
                        change.hunks.push(hunk(0, 1));
                    }
                    let hunk = &mut change.hunks[0];
                    hunk.new_lines += 1;
                    hunk.lines.push(format!("+{content}"));
                }
                continue;
            }
            if line.starts_with("@@") {
                change.hunks.push(hunk(0, 0));
                continue;
            }
            let entry = match line.chars().next() {
                Some(' ' | '-' | '+') => line.to_string(),
                None => " ".to_string(),
                _ => continue,
            };
            if change.hunks.is_empty() {
                change.hunks.push(hunk(0, 0));
            }
            let Some(hunk) = change.hunks.last_mut() else {
                continue;
            };
            match entry.as_bytes()[0] {
                b'-' => hunk.old_lines += 1,
                b'+' => hunk.new_lines += 1,
                _ => {
                    hunk.old_lines += 1;
                    hunk.new_lines += 1;
                }
            }
            hunk.lines.push(entry);
        }
    }
    changes
}

/// 空的段落，從指定的行開始。
fn hunk(old_start: u64, new_start: u64) -> Hunk {
    Hunk {
        old_start,
        old_lines: 0,
        new_start,
        new_lines: 0,
        lines: Vec::new(),
    }
}

/// 統一差異格式（`@@ -a,b +c,d @@` 段落）；依段落宣告的行數收行，檔頭與其他行略過。
pub(super) fn unified_hunks(text: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let (mut old, mut new) = (0u64, 0u64);
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("@@") {
            let ranges = hunk_header(header);
            let (old_start, old_lines, new_start, new_lines) = ranges.unwrap_or((0, 0, 0, 0));
            (old, new) = match ranges {
                Some(_) => (old_lines, new_lines),
                None => (u64::MAX, u64::MAX),
            };
            hunks.push(Hunk {
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = hunks.last_mut().filter(|_| old > 0 || new > 0) else {
            continue;
        };
        match line.as_bytes().first() {
            Some(b'-') => old = old.saturating_sub(1),
            Some(b'+') => new = new.saturating_sub(1),
            Some(b' ') | None => {
                old = old.saturating_sub(1);
                new = new.saturating_sub(1);
            }
            _ => continue,
        }
        hunk.lines.push(if line.is_empty() {
            " ".into()
        } else {
            line.into()
        });
    }
    hunks
}

/// ` -12,3 +12,4 @@ …` 的起始行與行數；省略行數時為 1。
fn hunk_header(header: &str) -> Option<(u64, u64, u64, u64)> {
    let mut parts = header.split_whitespace();
    let range = |text: &str| -> Option<(u64, u64)> {
        match text.split_once(',') {
            Some((start, lines)) => Some((start.parse().ok()?, lines.parse().ok()?)),
            None => Some((text.parse().ok()?, 1)),
        }
    };
    let (old_start, old_lines) = range(parts.next()?.strip_prefix('-')?)?;
    let (new_start, new_lines) = range(parts.next()?.strip_prefix('+')?)?;
    Some((old_start, old_lines, new_start, new_lines))
}

/// 刪除的檔案：整份內容成為一段刪除。
pub(super) fn deleted(content: &str) -> Vec<Hunk> {
    let mut lines = content.split('\n').collect::<Vec<_>>();
    if content.is_empty() || content.ends_with('\n') {
        lines.pop();
    }
    if lines.is_empty() {
        return Vec::new();
    }
    vec![Hunk {
        old_start: 1,
        old_lines: lines.len() as u64,
        new_start: 0,
        new_lines: 0,
        lines: lines
            .iter()
            .map(|line| format!("-{}", line.strip_suffix('\r').unwrap_or(line)))
            .collect(),
    }]
}
