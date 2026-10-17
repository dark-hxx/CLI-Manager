//! Codex CLI 對話紀錄（rollout）的唯讀解析。
//!
//! 紀錄位於 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<時間>-<uuid>.jsonl`（封存的在
//! `archived_sessions/`），每行是 `{"timestamp","type","payload"}`。同一段對話有兩條平行的流：
//! 模型看到的 `response_item`，以及介面事件 `event_msg`（舊版為 `user_message`、`agent_message`、
//! `agent_reasoning`，新版改寫成 `item_completed`）。提示詞、回覆與思考只取介面事件——它們不含
//! CLI 注入的 AGENTS.md、環境資訊等上下文；工具呼叫兩條流都可能寫，依呼叫 ID 只呈現先出現的一個。
//! 產生的事件種類與 Claude Code 逐字稿相同，前端不需要分辨來源。
//!
//! 找出紀錄檔與綁定會話由主機端負責（CLI Hook 或歷史目錄），這裡只解析給定的檔案。

mod calls;
mod events;
#[cfg(test)]
mod image_tests;
mod images;
mod patch;
mod status;
#[cfg(test)]
mod tests;

pub use images::{line_images, ImageSource};

use crate::{
    diff::Patch,
    event::{Event, Status, BASH_TAIL, ERROR_TEXT},
    text::{keep_head, keep_tail, parse_timestamp, strip_ansi},
    window::{read_with, Limits, LineParser, Page, Window, LINE_LIMIT},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io,
    path::Path,
};

/// CLI 注入、不是使用者輸入的內容（AGENTS.md、環境資訊、技能展開、子代理通知等）。
const INJECTED: &[&str] = &[
    "<environment_context>",
    "<user_instructions>",
    "<codex_internal_context>",
    "<goal_context>",
    "<skill>",
    "<subagent_notification>",
    "<turn_aborted>",
    "<user_action>",
    "<user_shell_command>",
    "# AGENTS.md instructions",
];

/// 不呈現的呼叫：程式碼模式的 `exec`（它啟動的命令、修改另有 `item_completed` 紀錄）、
/// 等待儲存格或子代理、列出代理與計時。
const QUIET: &[&str] = &[
    "exec",
    "wait",
    "wait_agent",
    "list_agents",
    "close_agent",
    "interrupt_agent",
    "resume_agent",
    "sleep",
];

/// 依視窗讀取 Codex rollout；語意與 Claude Code 的 `read` 相同（初始視窗、游標之後增量、
/// 某位置之前往前分頁、落後太多時重置）。
pub fn read(path: &Path, window: Window, limits: &Limits, cwd: Option<&str>) -> io::Result<Page> {
    read_with(path, window, limits, Parser::new(cwd.map(String::from)))
}

/// 等待輸出的呼叫，決定結果怎麼呈現。
enum Call {
    /// 殼層命令：輸出含結束碼與輸出內容。
    Shell,
    /// 檔案修補：每個檔案一個工具事件，結果附差異。
    Patch(Vec<FileEdit>),
    /// 附上輸出開頭（MCP、其他工具）。
    Text,
    /// 只標示完成（子代理的輸出是內部識別資料）。
    Plain,
    /// 查看圖片。
    Image,
    /// 不呈現結果（計畫、等待等）。
    Quiet,
    /// 呼叫在讀取範圍之前：依輸出的格式推斷（有結束碼的視為命令）。
    Unknown,
}

/// 一個檔案的變更：工具事件的 ID 與名稱、顯示路徑與差異。
struct FileEdit {
    id: String,
    name: &'static str,
    path: String,
    patch: Patch,
}

/// 逐行整理 Codex 紀錄；記住等待輸出的呼叫，讓之後的輸出能依工具呈現。
pub struct Parser {
    /// 縮短檔案路徑用的工作目錄；session_meta 與 turn_context 的 cwd 會更新它。
    cwd: Option<String>,
    /// 已呈現的呼叫 ID（兩條流可能寫同一個呼叫，只取先出現的一個）。
    seen: HashSet<String>,
    calls: HashMap<String, Call>,
    /// 自上一個非文字事件以來送出的文字；新舊兩種事件重複寫入同一段文字時只送一次。
    recent: Vec<(&'static str, String)>,
    /// 上一個事件是上下文壓縮（壓縮同時有 `compacted` 與 `ContextCompaction` 兩筆紀錄）。
    compacted: bool,
    /// 本輪開始的時間（毫秒），用來推算沒有寫入用時的回合。
    turn_started: Option<u64>,
    /// 這一輪已經有你的訊息：同一輪裡再出現的是工作中插入的話（steer）。
    prompted: bool,
    /// 沒有 ID 的網頁搜尋以序號區分。
    searches: u64,
    /// 權限設定的三個來源；`thread_settings_applied` 可能只寫其中幾項，沿用之前的值。
    approval: Option<String>,
    sandbox: Option<String>,
    reviewer: Option<String>,
    status: Status,
    sent: Status,
    /// 正在解析的那一行在檔案裡的位置；帶圖片的事件以 `@位置` 當 uuid，讀圖片時找回那一行。
    offset: u64,
    /// 這一行有幾張圖片（見 `line_images`）。
    images: u32,
}

impl Parser {
    /// `cwd` 是紀錄裡還沒有工作目錄時，用來縮短檔案路徑的預設目錄。
    pub fn new(cwd: Option<String>) -> Self {
        Self {
            cwd,
            seen: HashSet::new(),
            calls: HashMap::new(),
            recent: Vec::new(),
            compacted: false,
            turn_started: None,
            prompted: false,
            searches: 0,
            approval: None,
            sandbox: None,
            reviewer: None,
            status: Default::default(),
            sent: Default::default(),
            offset: 0,
            images: 0,
        }
    }

    /// 解析一行原始 JSON；超過單行上限或不是 JSON 的行略過。
    pub fn line(&mut self, raw: &[u8], out: &mut Vec<Event>) {
        if raw.len() > LINE_LIMIT {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(raw) {
            self.value(&value, out);
        }
    }

    /// 整理一行已解析的紀錄；這一行產生的事件都補上欄位上限（見 `Event::bound`）。
    pub fn value(&mut self, line: &Value, out: &mut Vec<Event>) {
        let before = out.len();
        self.record(line, out);
        out[before..].iter_mut().for_each(Event::bound);
    }

    fn record(&mut self, line: &Value, out: &mut Vec<Event>) {
        self.images = line_images(line).len() as u32;
        let at = line["timestamp"].as_str().and_then(parse_timestamp);
        let payload = &line["payload"];
        match line["type"].as_str() {
            Some("session_meta") => self.set_cwd(&payload["cwd"]),
            Some("turn_context") => self.settings(payload),
            Some("response_item") => self.response(payload, at, out),
            Some("event_msg") => self.event(payload, at, out),
            Some("compacted") => self.push(out, Event::Compact { at }),
            _ => {}
        }
        if self.status != self.sent {
            self.sent = self.status.clone();
            out.push(Event::Status(self.status.clone()));
        }
    }

    fn set_cwd(&mut self, value: &Value) {
        if let Some(cwd) = value.as_str().filter(|cwd| !cwd.trim().is_empty()) {
            self.cwd = Some(cwd.into());
        }
    }

    /// 模型、思考強度與審批策略；turn_context 與 thread_settings_applied 的欄位相同。
    fn settings(&mut self, value: &Value) {
        self.set_cwd(&value["cwd"]);
        if let Some(model) = short(&value["model"]) {
            if self.status.model.as_deref() != Some(model.as_str()) {
                self.status.model_name = Some(status::model_name(&model));
                self.status.model = Some(model);
            }
        }
        let effort = short(&value["effort"])
            .or_else(|| short(&value["reasoning_effort"]))
            .or_else(|| short(&value["collaboration_mode"]["settings"]["reasoning_effort"]));
        if let Some(effort) = effort {
            self.status.effort = Some(effort);
        }
        if let Some(policy) = short(&value["approval_policy"]) {
            self.approval = Some(policy);
        }
        if let Some(sandbox) = short(&value["sandbox_policy"]["type"])
            .or_else(|| status::profile_sandbox(&value["permission_profile"]))
        {
            self.sandbox = Some(sandbox);
        }
        if let Some(reviewer) = short(&value["approvals_reviewer"]) {
            self.reviewer = Some(reviewer);
        }
        if let Some(mode) = status::permission_mode(
            self.approval.as_deref(),
            self.sandbox.as_deref(),
            self.reviewer.as_deref(),
        ) {
            self.status.permission_mode = Some(mode);
        }
    }

    /// 送出事件並記錄最近的文字；相同的文字或連續的壓縮標記不重複送出。
    fn push(&mut self, out: &mut Vec<Event>, event: Event) {
        let text = match &event {
            Event::User { text, .. } | Event::Queued { text, .. } => Some(("user", text)),
            Event::Assistant { text, .. } => Some(("assistant", text)),
            Event::Thinking {
                text: Some(text), ..
            } => Some(("thinking", text)),
            Event::Compact { .. } => {
                if self.compacted {
                    return;
                }
                self.recent.clear();
                self.compacted = true;
                out.push(event);
                return;
            }
            _ => None,
        };
        match text {
            Some((kind, text)) => {
                if self
                    .recent
                    .iter()
                    .any(|(seen, previous)| *seen == kind && previous == text)
                {
                    return;
                }
                if self.recent.len() >= 16 {
                    self.recent.remove(0);
                }
                self.recent.push((kind, text.clone()));
            }
            None => self.recent.clear(),
        }
        self.compacted = false;
        out.push(event);
    }

    /// 這一行有圖片（工具輸出的截圖、查看的圖片）：結果帶上這一行的位置與張數，前端顯示縮圖、點開看原圖。
    fn with_images(&self, mut event: Event) -> Event {
        if self.images > 0 {
            if let Event::Result {
                uuid,
                image,
                images,
                ..
            } = &mut event
            {
                *uuid = Some(format!("@{}", self.offset));
                *image = Some(true);
                *images = Some(self.images);
            }
        }
        event
    }
}

impl LineParser for Parser {
    fn parse_line(&mut self, raw: &[u8], out: &mut Vec<Event>) {
        self.line(raw, out);
    }

    fn parse_line_at(&mut self, offset: u64, raw: &[u8], out: &mut Vec<Event>) {
        self.offset = offset;
        self.line(raw, out);
    }

    /// 呼叫與它的輸出、介面紀錄常落在相鄰兩次讀取；預讀前面 256 KiB，跨頁也對得上、不重複。
    fn prime_bytes(&self) -> u64 {
        256 * 1024
    }

    /// 前端沒有更早的狀態時，先送出預讀得到的模型、思考強度與用量。
    fn primed(&mut self, fresh: bool, out: &mut Vec<Event>) {
        if fresh && self.status != Status::default() {
            self.sent = self.status.clone();
            out.push(Event::Status(self.status.clone()));
        }
    }
}

/// 設定類的短字串（模型、思考強度、審批策略）：去掉前後空白後非空、不超過 80 位元組。
fn short(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.len() <= 80)
        .map(String::from)
}

/// 介面紀錄項目的 ID 當作事件 uuid；空字串時省略。
fn uuid(id: &str) -> Option<String> {
    (!id.is_empty()).then(|| id.to_string())
}

/// 陣列的項目數（圖片張數）；不是陣列時為 0。
fn count(value: &Value) -> u32 {
    value.as_array().map_or(0, |items| items.len() as u32)
}

/// 去掉前後空白後非空的字串訊息。
fn message(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(String::from)
}

/// 工具事件的 detail：去掉前後空白後非空時保留開頭最多 `max` 字。
fn detail(text: &str, max: usize) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| keep_head(text, max))
}

fn error(at: Option<u64>, text: &str) -> Event {
    Event::Error {
        at,
        text: keep_head(strip_ansi(text).trim(), ERROR_TEXT),
        retry_in_ms: None,
        attempt: None,
        max: None,
    }
}

/// 只有文字（或什麼都沒有）的工具結果；`image` 表示輸出裡有圖片。
fn text_result(id: &str, at: Option<u64>, ok: bool, text: &str, image: bool) -> Event {
    Event::Result {
        uuid: None,
        at,
        id: id.into(),
        ok,
        text: (!text.is_empty()).then(|| text.to_string()),
        diff: None,
        added: None,
        removed: None,
        truncated: None,
        image: image.then_some(true),
        images: None,
    }
}

/// 命令輸出只保留結尾（去掉控制序列與前後空白）。
fn shell_tail(output: &str) -> String {
    keep_tail(strip_ansi(output).trim(), BASH_TAIL)
}

/// 一個呼叫修改多個檔案時，每個檔案的工具事件 ID。
fn part_id(id: &str, index: usize, total: usize) -> String {
    if total <= 1 {
        id.into()
    } else {
        format!("{id}#{index}")
    }
}

/// 陣列中的文字（字串或 `{text}`），去除空白項。
fn texts(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part.as_str().or_else(|| part["text"].as_str()))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect()
}
