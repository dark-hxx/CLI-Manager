//! 前端事件與逐字稿回應的型別，以及各欄位的大小上限。
//!
//! 網頁端單次結果有大小上限，所以每個事件的每個欄位都要有上界：文字類欄位在解析時以
//! `keep_head`／`keep_tail` 截斷（截斷處另補一個「…」），差異由 `diff` 模組套用行數、
//! 段數與總字元數的上限，其餘解析時沒有限制的欄位（識別字、名稱、任務清單）由
//! `Event::bound` 在每一行解析完時統一補上。

use crate::text::keep_head;
use serde::Serialize;

// 各類文字的上限（字元數）；Claude Code 與 Codex 的解析共用同一組數值。

/// 你的訊息與排隊的訊息。
pub const PROMPT_TEXT: usize = 64_000;
/// 模型回覆。
pub const ASSISTANT_TEXT: usize = 64_000;
/// 思考內容。
pub const THINKING_TEXT: usize = 2_000;
/// 本機指令與 `!` 命令的輸出，以及斜線指令、`!` 命令的參數。
pub const COMMAND_OUTPUT: usize = 4_000;
/// 殼層命令的結果只保留結尾。
pub const BASH_TAIL: usize = 3_000;
/// 其他工具的結果保留開頭。
pub const RESULT_TEXT: usize = 1_500;
/// 差異最多保留的行數。
pub const DIFF_LINES: usize = 300;
/// 差異每一行最多保留的字元數。
pub const DIFF_LINE_CHARS: usize = 2_000;
/// 差異最多保留的段數（沒有內容的段落也算），避免大量空段落撐大事件。
pub const DIFF_HUNKS: usize = 300;
/// 一份差異所有保留行合計的字元數：300 行 × 2000 字最壞會到 60 萬字，超過網頁端單次結果的上限。
pub const DIFF_TEXT: usize = 64_000;
/// 通知（背景任務、中斷標記、CLI 的提示）。
pub const NOTICE_TEXT: usize = 2_000;
/// 錯誤訊息。
pub const ERROR_TEXT: usize = 300;
/// 工具摘要與斜線指令名稱。
pub const SUMMARY_TEXT: usize = 200;
/// 對話標題。
pub const TITLE_TEXT: usize = 200;
/// 殼層命令的完整內容（工具事件的 detail）。
pub const BASH_DETAIL: usize = 4_000;
/// 計畫模式提出的計畫。
pub const PLAN_DETAIL: usize = 16_000;
/// 子代理收到的提示詞。
pub const AGENT_DETAIL: usize = 2_000;
/// 識別字與名稱：uuid、工具呼叫 ID、工具名稱、模型、權限模式、任務 ID 與狀態。
pub const LABEL_TEXT: usize = 200;
/// 任務清單一次最多保留的項目數。
pub const TASK_ITEMS: usize = 100;
/// 任務標題。
pub const TASK_TEXT: usize = 500;
/// 帶樣式的輸出上限（位元組）；超過時只給純文字，避免一段輸出撐大整頁事件。
pub const STYLED_BYTES: usize = 64 * 1024;

/// 前端事件；以 `kind` 區分種類，省略空欄位。欄位名稱是與網頁端的契約，不可隨意更動。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    User {
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<u32>,
    },
    Queued {
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        text: String,
    },
    Command {
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<String>,
    },
    CommandOutput {
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        /// 純文字（去掉所有控制序列），舊版網頁照常使用。
        text: String,
        /// 同一段輸出保留顏色與粗細：只剩白名單內的 SGR 序列（見 `styled_output`），
        /// 沒有任何樣式時省略。
        #[serde(skip_serializing_if = "Option::is_none")]
        ansi: Option<String>,
    },
    Assistant {
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// 這則回覆開了快速模式（Claude Code 的 /fast，用量裡的 speed 是 fast）。
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        fast: bool,
    },
    Thinking {
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        /// 思考內容；Claude Code 預設不顯示思考時為空，只剩思考時間。
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        /// 這段思考花的時間（Claude Code 的 `thinkingDurationMs`）。
        #[serde(skip_serializing_if = "Option::is_none")]
        ms: Option<u64>,
    },
    Tool {
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        id: String,
        name: String,
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Result {
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diff: Option<Vec<Hunk>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        added: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        removed: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        image: Option<bool>,
        /// 結果裡的圖片張數（base64 內嵌的才算），對話視圖直接顯示縮圖。
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<u32>,
    },
    Task {
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        op: &'static str,
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
    },
    Tasks {
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        items: Vec<TaskItem>,
    },
    Title {
        text: String,
    },
    /// 一輪結束：用時與訊息數。花費不在這裡計算，由主機端依自己的價目表另外算。
    Turn {
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        messages: Option<u64>,
    },
    Compact {
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_in_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<u64>,
    },
    Notice {
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
        /// 穩定代碼（例如 `turn_interrupted`）：前端依介面語言顯示對應文字，`text` 只是後備；
        /// 沒有代碼的提醒（CLI 自己寫的文字）直接顯示 `text`。
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        text: String,
    },
    /// Claude Code 自己寫在紀錄裡的累計花費（`cost-state`），原樣轉出。
    Cost {
        #[serde(skip_serializing_if = "Option::is_none")]
        usd: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        added: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        removed: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ms: Option<u64>,
    },
    Mode {
        value: String,
    },
    /// CLI 目前的模型、思考強度、審批模式、速度與上下文用量（取自紀錄欄位），只在變化時送出。
    Status(Status),
}

/// 降級時長文字保留的字數：單一行整理出的事件就超過一頁的總量時才會用到。
pub const SHRUNK_TEXT: usize = 4_000;

impl Event {
    /// 有 `uuid` 欄位但沒有值時補上 `key`（紀錄行的位置），讓前端的 key 不必用流水號：
    /// 讀進更早的內容或重新讀取時，同一則事件的 key 不變。
    pub(crate) fn fill_uuid(&mut self, key: impl FnOnce() -> String) {
        let uuid = match self {
            Event::User { uuid, .. }
            | Event::Command { uuid, .. }
            | Event::CommandOutput { uuid, .. }
            | Event::Assistant { uuid, .. }
            | Event::Thinking { uuid, .. }
            | Event::Tool { uuid, .. }
            | Event::Result { uuid, .. } => uuid,
            _ => return,
        };
        if uuid.is_none() {
            *uuid = Some(key());
        }
    }

    /// 單一行整理出的事件就超過一頁的總量時降級：拿掉 diff 與彩色輸出、長文字只留開頭
    /// [`SHRUNK_TEXT`] 字，拿掉 diff 的結果標成已截斷。步驟、摘要與增刪行數照樣顯示，讀取也能前進。
    pub(crate) fn shrink(&mut self) {
        let shorten = |text: &mut String| {
            let short = keep_head(text, SHRUNK_TEXT);
            *text = short;
        };
        match self {
            Event::User { text, .. }
            | Event::Queued { text, .. }
            | Event::Assistant { text, .. } => shorten(text),
            Event::CommandOutput { text, ansi, .. } => {
                shorten(text);
                *ansi = None;
            }
            Event::Thinking {
                text: Some(text), ..
            } => shorten(text),
            Event::Tool {
                detail: Some(detail),
                ..
            } => shorten(detail),
            Event::Result {
                text,
                diff,
                truncated,
                ..
            } => {
                if let Some(text) = text {
                    shorten(text);
                }
                if diff.take().is_some() {
                    *truncated = Some(true);
                }
            }
            _ => {}
        }
    }

    /// 補上解析時沒有限制的欄位上限，讓每個事件的大小都有上界：uuid 與各種 ID 最多 `LABEL_TEXT`
    /// 字（見 `cap_id`）；工具名稱、回覆的模型、權限模式與任務狀態最多 `LABEL_TEXT` 字、任務標題
    /// 最多 `TASK_TEXT` 字（截斷處補「…」）；任務清單最多 `TASK_ITEMS` 項。正常的紀錄遠低於
    /// 這些上限，不受影響。
    pub(crate) fn bound(&mut self) {
        match self {
            Event::User { uuid, .. }
            | Event::Command { uuid, .. }
            | Event::CommandOutput { uuid, .. }
            | Event::Thinking { uuid, .. } => cap_id_option(uuid),
            Event::Assistant { uuid, model, .. } => {
                cap_id_option(uuid);
                cap_option(model, LABEL_TEXT);
            }
            Event::Tool { uuid, id, name, .. } => {
                cap_id_option(uuid);
                cap_id(id);
                cap(name, LABEL_TEXT);
            }
            Event::Result { uuid, id, .. } => {
                cap_id_option(uuid);
                cap_id(id);
            }
            Event::Task {
                id,
                status,
                subject,
                ..
            } => {
                cap_id(id);
                cap_option(status, LABEL_TEXT);
                cap_option(subject, TASK_TEXT);
            }
            Event::Tasks { items, .. } => {
                items.truncate(TASK_ITEMS);
                for item in items {
                    cap_id(&mut item.id);
                    cap(&mut item.subject, TASK_TEXT);
                    cap_option(&mut item.status, LABEL_TEXT);
                }
            }
            Event::Mode { value } => cap(value, LABEL_TEXT),
            _ => {}
        }
    }
}

/// 超過 `max` 個字元時改成 `keep_head` 的結果；已截斷過的文字再套一次不會改變。
fn cap(text: &mut String, max: usize) {
    if text.chars().nth(max).is_some() {
        *text = keep_head(text, max);
    }
}

fn cap_option(text: &mut Option<String>, max: usize) {
    if let Some(text) = text {
        cap(text, max);
    }
}

/// 識別字是前端配對工具事件與結果的鍵：超過 `LABEL_TEXT` 字時保留開頭，接「…」與整個字串的
/// FNV-1a 雜湊，剛好 `LABEL_TEXT` 字。同一個 ID 每次都得到同一個結果（跨頁也對得上），開頭相同的
/// 不同 ID（例如多檔修補的 `<ID>#0`、`<ID>#1`）截斷後仍不相同；再套一次不會改變。
fn cap_id(id: &mut String) {
    if id.chars().nth(LABEL_TEXT).is_none() {
        return;
    }
    let hash = id.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    let head = id.chars().take(LABEL_TEXT - 17).collect::<String>();
    *id = format!("{head}…{hash:016x}");
}

fn cap_id_option(id: &mut Option<String>) {
    if let Some(id) = id {
        cap_id(id);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// 最近一次請求的組成，也就是目前上下文的內容。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextUsage>,
    /// 方案額度的各個時間窗（例如 5 小時、7 天），由 CLI 自己的紀錄提供。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<Vec<Limit>>,
}

/// 一次請求的 token 組成：`input` 是沒有命中快取的新輸入；`output` 是那次回覆的輸出，
/// 會成為下一次請求上下文的一部分。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
}

/// 一個額度時間窗：`kind` 為 `five_hour`、`seven_day`，無法辨識長度時為來源欄位名稱。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub kind: String,
    pub used_percent: f64,
    /// 重設時間（Unix 秒）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskItem {
    pub id: String,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// 對話紀錄的解析方式改了、同一段紀錄會整理出不同的事件時（例如 Codex 的圖片、引用圖檔的回覆
/// 開始帶 `@位置` uuid），把這個數字加一：前端發現版本不同，就丟掉手上的事件重讀，不必重新整理頁面。
pub const PARSER: u32 = 3;

/// 逐字稿端點的回應。序列化後的欄位名稱（parser、available、reason、agentSessionId、start、
/// cursor、size、reset、more、events）是與網頁端的契約。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// 解析方式的版本（見 `PARSER`）：前端手上的事件是舊版解析的就整份重讀。
    pub parser: u32,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    pub start: u64,
    pub cursor: u64,
    pub size: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub reset: bool,
    pub more: bool,
    /// 增量讀取因事件總量上限提早停下：游標之後還有已寫完的內容，前端可以馬上再讀。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
    pub events: Vec<Event>,
}

impl Transcript {
    /// 讀不到紀錄時的回應（例如還沒綁定、檔案不存在）：`reason` 說明原因，其餘欄位為空。
    pub fn unavailable(reason: &'static str, agent_session_id: Option<String>) -> Self {
        Self {
            parser: PARSER,
            available: false,
            reason: Some(reason),
            agent_session_id,
            start: 0,
            cursor: 0,
            size: 0,
            reset: false,
            more: false,
            partial: false,
            events: Vec::new(),
        }
    }
}
