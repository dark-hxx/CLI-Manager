//! CLI-Manager 對話模式的對話紀錄解析：把 Claude Code 的逐字稿（JSONL）與 Codex 的 rollout
//! 整理成前端可直接呈現的事件。紀錄檔可能非常大、最後一行可能還在寫，所以只依位元組視窗讀取
//! 完整的行，從不整檔載入；前端以游標增量讀取新內容、往前分頁讀取舊內容。
//!
//! 解析規則移植自 Tap-Code（github.com/tapaixx/Tap-Code），由原作者以本倉庫的授權
//! （AGPL-3.0-or-later，另有維護者的商業授權）貢獻。
//!
//! - [`read`]／[`transcript`]：依來源（[`Source`]）讀一頁事件；[`transcript`] 直接組出網頁端的回應。
//! - [`claude`]：Claude Code 逐字稿；回退（`/rewind`）丟掉的分支不顯示（見 [`rewinds`]）。
//! - [`codex`]：Codex rollout；讀取前先預讀視窗之前的一段，讓跨頁的工具呼叫與結果對得上。
//! - 兩者產生同一組 [`Event`]，共用 [`read_with`] 的視窗讀取（[`Window`]、[`Limits`]、[`Page`]）。
//! - 每個事件的每個欄位都有上限（[`PROMPT_TEXT`]、[`DIFF_TEXT`]、[`LABEL_TEXT`] 等常數），
//!   搭配 [`web_limits`] 讓網頁端單次結果維持在上限之內。
//!
//! 這裡不計算花費：主機端依自己的價目表另外算；紀錄本身寫入的累計花費（Claude Code 的
//! `cost-state`）照樣轉成 [`Event::Cost`]。找出紀錄檔與綁定會話也由主機端負責（CLI Hook 或
//! 歷史目錄），這裡只解析給定的檔案。

pub mod claude;
pub mod codex;
mod diff;
mod event;
pub mod rewinds;
mod text;
mod window;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

pub use event::{
    ContextUsage, Event, Hunk, Limit, Status, TaskItem, Transcript, AGENT_DETAIL, ASSISTANT_TEXT,
    BASH_DETAIL, BASH_TAIL, COMMAND_OUTPUT, DIFF_HUNKS, DIFF_LINES, DIFF_LINE_CHARS, DIFF_TEXT,
    ERROR_TEXT, LABEL_TEXT, NOTICE_TEXT, PARSER, PLAN_DETAIL, PROMPT_TEXT, RESULT_TEXT,
    STYLED_BYTES, SUMMARY_TEXT, TASK_ITEMS, TASK_TEXT, THINKING_TEXT, TITLE_TEXT,
};
pub use text::{keep_head, keep_tail, parse_timestamp, strip_ansi, strip_reminders};
pub use window::{
    for_each_line, for_each_line_from, read_with, Limits, LineParser, Page, Window, CATCH_UP,
    LINE_LIMIT, WINDOW,
};

use std::{io, path::Path};

/// 網頁端單次讀取的原始紀錄視窗（最新一段與往前分頁）：夠大，貼了截圖、好幾 MB 的提問行也讀得到；
/// 事件總量另由 [`WEB_OUTPUT`] 控制。
pub const WEB_WINDOW: u64 = 4 * 1024 * 1024;
/// 網頁端單次結果的事件總量上限（序列化後的位元組），低於橋接層 700 KiB 的上限。單一事件最壞約
/// 0.55 MB；超過總量時至少保留一行，整頁仍在橋接層上限之內。
pub const WEB_OUTPUT: usize = 512 * 1024;

/// 對話紀錄的來源 CLI。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    /// Claude Code 的逐字稿（`~/.claude/projects/<目錄>/<會話>.jsonl`）。
    Claude,
    /// Codex 的 rollout（`$CODEX_HOME/sessions/…/rollout-*.jsonl`）。
    Codex,
}

/// 依來源與視窗讀取一頁事件：初始視窗（`Tail`）、游標之後增量（`After`）或某位置之前往前分頁
/// （`Before`）。`cwd` 是紀錄裡還沒有工作目錄時，用來把檔案路徑縮成相對路徑的預設目錄。
/// 開檔或讀取失敗時傳回 I/O 錯誤（例如檔案不存在時為 `NotFound`）。
pub fn read(
    source: Source,
    path: &Path,
    window: Window,
    limits: &Limits,
    cwd: Option<&str>,
) -> io::Result<Page> {
    match source {
        Source::Claude => claude::read(path, window, limits, cwd),
        Source::Codex => codex::read(path, window, limits, cwd),
    }
}

/// 讀取一頁並組成網頁端的回應（`available` 為 true，`parser` 為 [`PARSER`]，其餘取自 [`Page`]）。
/// 讀取失敗時傳回錯誤，由呼叫端決定是否改回 [`Transcript::unavailable`]。
pub fn transcript(
    source: Source,
    path: &Path,
    window: Window,
    limits: &Limits,
    cwd: Option<&str>,
    agent_session_id: Option<String>,
) -> io::Result<Transcript> {
    let page = read(source, path, window, limits, cwd)?;
    Ok(Transcript {
        parser: PARSER,
        available: true,
        reason: None,
        agent_session_id,
        start: page.start,
        cursor: page.cursor,
        size: page.size,
        reset: page.reset,
        more: page.more,
        partial: page.partial,
        events: page.events,
    })
}

/// 網頁端用的讀取上限：視窗 [`WEB_WINDOW`]、增量讀取沿用 [`CATCH_UP`]（8 MiB）、單行 [`LINE_LIMIT`]，
/// 事件總量 [`WEB_OUTPUT`]。增量讀取超過總量時只推進一部分游標，下次輪詢接著讀，不會重置或卡住；
/// 單一行就超過總量時先降級（見 [`Event`] 的 `shrink`）。沒有 uuid 的事件補上位置 key。
pub fn web_limits() -> Limits {
    Limits {
        window: WEB_WINDOW,
        catch_up: CATCH_UP,
        line: LINE_LIMIT,
        output: WEB_OUTPUT,
        position_keys: true,
    }
}

/// 主機端的轉接：依來源名稱與游標，以 [`web_limits`] 讀一頁網頁端回應。
///
/// - `source` 為 `claude` 或 `codex`；其他來源回傳 `unsupported`，檔案不存在回傳 `missing`。
/// - 只帶 `cursor` 為增量、只帶 `before` 為更早一頁、都不帶則取最新一段；兩者同時出現視為錯誤。
pub fn read_window(
    source: &str,
    path: &Path,
    cursor: Option<u64>,
    before: Option<u64>,
    cwd: Option<&str>,
    agent_session_id: Option<String>,
) -> Result<Transcript, String> {
    let source = match source {
        "claude" => Source::Claude,
        "codex" => Source::Codex,
        _ => return Ok(Transcript::unavailable("unsupported", agent_session_id)),
    };
    let window = match (cursor, before) {
        (Some(cursor), None) => Window::After(cursor),
        (None, Some(before)) => Window::Before(before),
        (None, None) => Window::Tail,
        (Some(_), Some(_)) => return Err("invalid_transcript_window".to_string()),
    };
    match transcript(
        source,
        path,
        window,
        &web_limits(),
        cwd,
        agent_session_id.clone(),
    ) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(Transcript::unavailable("missing", agent_session_id))
        }
        result => result.map_err(|error| error.to_string()),
    }
}
