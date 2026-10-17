//! 檔案差異的保留規則：Claude Code 的 structuredPatch 與 Codex 的修補共用同一套上限。
//!
//! 增刪行數一律以完整差異計算；顯示用的段落最多 `DIFF_HUNKS` 段、`DIFF_LINES` 行（每行
//! `DIFF_LINE_CHARS` 字）、合計 `DIFF_TEXT` 字。超過任一上限時標成截斷（結果事件的
//! `truncated`），放不下的那一行以「…」收尾，之後的行不再保留。

use crate::{
    event::{Hunk, DIFF_HUNKS, DIFF_LINES, DIFF_LINE_CHARS, DIFF_TEXT},
    text::keep_head,
};
use std::mem;

/// 檔案變更的差異：保留的段落、以完整差異計算的增刪行數，以及是否因上限而截斷。
#[derive(Debug)]
pub(crate) struct Patch {
    pub(crate) hunks: Vec<Hunk>,
    pub(crate) added: u64,
    pub(crate) removed: u64,
    pub(crate) truncated: bool,
    /// 還能保留的行數與字元數。
    lines_left: usize,
    chars_left: usize,
}

impl Patch {
    pub(crate) fn new() -> Self {
        Self {
            hunks: Vec::new(),
            added: 0,
            removed: 0,
            truncated: false,
            lines_left: DIFF_LINES,
            chars_left: DIFF_TEXT,
        }
    }

    /// 加入一段差異：`lines` 是這段完整的差異行（以 `+`、`-` 或空白開頭），`header` 的
    /// `lines` 會換成實際保留的行。增刪行數以完整內容計算。
    pub(crate) fn hunk<S: AsRef<str>>(&mut self, header: Hunk, lines: &[S]) {
        for line in lines {
            match line.as_ref().as_bytes().first() {
                Some(b'+') => self.added += 1,
                Some(b'-') => self.removed += 1,
                _ => {}
            }
        }
        let shown = lines
            .iter()
            .map(|line| keep_head(line.as_ref(), DIFF_LINE_CHARS));
        self.keep(header, lines.len(), shown);
    }

    /// 依剩餘的段數、行數與字元數收下一段的顯示行（每行已截斷到 `DIFF_LINE_CHARS`）；
    /// `total` 是這段完整的行數。有內容的段落一行都放不下時整段略過，和行數用完時一樣。
    fn keep(&mut self, mut header: Hunk, total: usize, shown: impl Iterator<Item = String>) {
        if self.hunks.len() >= DIFF_HUNKS {
            self.truncated = true;
            return;
        }
        if total > self.lines_left {
            self.truncated = true;
        }
        let wanted = total.min(self.lines_left);
        self.lines_left -= wanted;
        let mut lines = Vec::with_capacity(wanted);
        for line in shown.take(wanted) {
            let count = line.chars().count();
            if count > self.chars_left {
                // 總字元數用完：這一行截到剩下的字數（保留開頭的 +/- 標記），之後的行都不收。
                self.truncated = true;
                if self.chars_left > 0 {
                    lines.push(keep_head(&line, self.chars_left));
                }
                self.chars_left = 0;
                self.lines_left = 0;
                break;
            }
            self.chars_left -= count;
            lines.push(line);
        }
        if lines.is_empty() && total > 0 {
            return;
        }
        header.lines = lines;
        self.hunks.push(header);
    }
}

/// 已解析成段落的差異（Codex 的修補、統一差異格式、刪除的檔案）套用同一套上限。
pub(crate) fn cap(hunks: Vec<Hunk>) -> Patch {
    let mut patch = Patch::new();
    for mut hunk in hunks {
        let lines = mem::take(&mut hunk.lines);
        patch.hunk(hunk, &lines);
    }
    patch
}

/// 新建檔案沒有差異時，以整份內容合成一段新增；只格式化保留得下的行。
pub(crate) fn created(content: &str) -> Patch {
    let mut lines = content.split('\n').collect::<Vec<_>>();
    if content.is_empty() || content.ends_with('\n') {
        lines.pop();
    }
    let total = lines.len();
    let mut patch = Patch::new();
    patch.added = total as u64;
    if total > 0 {
        let header = Hunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: total as u64,
            lines: Vec::new(),
        };
        let shown = lines.iter().map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            format!("+{}", keep_head(line, DIFF_LINE_CHARS))
        });
        patch.keep(header, total, shown);
    }
    patch
}
