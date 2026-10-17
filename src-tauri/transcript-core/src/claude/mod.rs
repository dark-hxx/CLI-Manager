//! Claude Code 逐字稿（JSONL）的唯讀解析：把原生記錄整理成前端可直接呈現的事件。
//! 回退（`/rewind`）丟掉的分支不顯示，和 CLI 一致（見 [`crate::rewinds`]）。

mod messages;
#[cfg(test)]
mod tests;
mod tools;

use crate::{
    event::{ContextUsage, Event, Status, TITLE_TEXT},
    rewinds,
    text::{keep_head, number, parse_timestamp},
    window::{read_with, Limits, LineParser, Page, Window, LINE_LIMIT},
};
use serde_json::Value;
use std::{collections::HashMap, io, path::Path};

/// 依視窗讀取 Claude Code 逐字稿；只解析以換行結尾的完整行，最後一行若仍在寫入則留待下次。
/// 回退丟掉的分支不顯示（和 CLI 一致）；前端手上的內容裡有剛被丟掉的部分時（回退後的
/// 第一則提問剛寫進來），改回最新視窗並要求重置。
pub fn read(path: &Path, window: Window, limits: &Limits, cwd: Option<&str>) -> io::Result<Page> {
    let abandoned = rewinds::abandoned(path)?;
    let stale = matches!(window, Window::After(from)
        if abandoned.iter().any(|&(start, end)| start < from && from <= end));
    let parser = Branches {
        parser: Parser::new(cwd.map(String::from)),
        abandoned,
    };
    let mut page = read_with(
        path,
        if stale { Window::Tail } else { window },
        limits,
        parser,
    )?;
    page.reset |= stale;
    Ok(page)
}

/// 跳過回退（/rewind）丟掉的分支：只跳過對話內容，標題、模式這類設定照讀。
struct Branches {
    parser: Parser,
    abandoned: Vec<(u64, u64)>,
}

impl LineParser for Branches {
    fn parse_line(&mut self, raw: &[u8], out: &mut Vec<Event>) {
        self.parser.line(raw, out);
    }

    fn parse_line_at(&mut self, offset: u64, raw: &[u8], out: &mut Vec<Event>) {
        self.parser.abandoned = self
            .abandoned
            .iter()
            .any(|&(start, end)| start <= offset && offset < end);
        self.parser.line(raw, out);
    }
}

/// 一行紀錄共用的欄位：訊息 uuid 與時間（Unix 毫秒）。
struct Meta {
    uuid: Option<String>,
    at: Option<u64>,
}

/// 逐行整理事件；記住工具呼叫的名稱，讓之後的結果能依工具呈現。
pub struct Parser {
    tools: HashMap<String, String>,
    cwd: Option<String>,
    /// CLI 會反覆寫入相同的標題與權限模式，只在改變時送出。
    title: Option<String>,
    mode: Option<String>,
    status: Status,
    sent: Status,
    /// 目前這一行在回退丟掉的分支裡。
    abandoned: bool,
}

impl Parser {
    /// `cwd` 是行內沒有工作目錄時，用來縮短檔案路徑的預設目錄。
    pub fn new(cwd: Option<String>) -> Self {
        Self {
            tools: HashMap::new(),
            cwd,
            title: None,
            mode: None,
            status: Status::default(),
            sent: Status::default(),
            abandoned: false,
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
        if line["isSidechain"].as_bool() == Some(true) {
            return;
        }
        // 回退丟掉的分支：對話內容不顯示，也不影響狀態（上下文、模型）。
        if self.abandoned
            && matches!(
                line["type"].as_str(),
                Some("user" | "assistant" | "system" | "attachment" | "progress")
            )
        {
            return;
        }
        let meta = Meta {
            uuid: line["uuid"].as_str().map(String::from),
            at: line["timestamp"].as_str().and_then(parse_timestamp),
        };
        self.observe(line);
        match line["type"].as_str() {
            Some("user") => self.user(line, &meta, out),
            Some("assistant") => self.assistant(line, &meta, out),
            Some("system") => messages::system(line, &meta, out),
            Some("attachment") => messages::attachment(line, &meta, out),
            Some("ai-title") => self.title(&line["aiTitle"], out),
            Some("summary") => self.title(&line["summary"], out),
            Some("cost-state") => out.push(Event::Cost {
                usd: line["totalCostUSD"].as_f64(),
                added: number(&line["totalLinesAdded"]),
                removed: number(&line["totalLinesRemoved"]),
                ms: number(&line["totalDuration"]),
            }),
            Some("permission-mode") => {
                if let Some(value) = line["permissionMode"].as_str() {
                    if self.mode.as_deref() != Some(value) {
                        self.mode = Some(value.into());
                        out.push(Event::Mode {
                            value: value.into(),
                        });
                    }
                }
            }
            _ => {}
        }
        if self.status != self.sent {
            self.sent = self.status.clone();
            out.push(Event::Status(self.status.clone()));
        }
    }

    /// 從每一行收集 CLI 目前的設定：審批模式與思考強度寫在多數行上，模型與用量在回覆裡，
    /// 模型的完整名稱（含 1M 上下文）在 model 附件裡。
    fn observe(&mut self, line: &Value) {
        let text = |value: &Value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty() && text.len() <= 80)
                .map(String::from)
        };
        if let Some(mode) = text(&line["permissionMode"]) {
            self.status.permission_mode = Some(mode);
        }
        if let Some(effort) = text(&line["effort"]) {
            self.status.effort = Some(effort);
        }
        match line["type"].as_str() {
            Some("assistant") => {
                let message = &line["message"];
                let Some(model) = text(&message["model"]).filter(|model| model != "<synthetic>")
                else {
                    return;
                };
                if self.status.model.as_deref() != Some(&model) {
                    // 換了模型，舊的完整名稱不再適用。
                    if self
                        .status
                        .model
                        .as_ref()
                        .is_some_and(|current| !model.starts_with(current.trim_end_matches("[1m]")))
                    {
                        self.status.model_name = None;
                        self.status.context_window = None;
                    }
                    self.status.model = Some(model);
                }
                let usage = &message["usage"];
                if let Some(speed) = text(&usage["speed"]) {
                    self.status.speed = Some(speed);
                }
                let parts = ContextUsage {
                    input: number(&usage["input_tokens"]).unwrap_or(0),
                    cache_read: number(&usage["cache_read_input_tokens"]).unwrap_or(0),
                    cache_write: number(&usage["cache_creation_input_tokens"]).unwrap_or(0),
                    output: number(&usage["output_tokens"]).unwrap_or(0),
                };
                let tokens = parts.input + parts.cache_read + parts.cache_write;
                if tokens > 0 {
                    self.status.context_tokens = Some(tokens);
                    self.status.context_usage = Some(parts);
                }
            }
            Some("permission-mode") => {
                if let Some(mode) = text(&line["permissionMode"]) {
                    self.status.permission_mode = Some(mode);
                }
            }
            Some("attachment") if line["attachment"]["type"].as_str() == Some("model") => {
                let identity = &line["attachment"]["identity"];
                if let Some(id) = text(&identity["modelId"]) {
                    self.status.context_window = Some(if id.contains("[1m]") {
                        1_000_000
                    } else {
                        200_000
                    });
                    self.status.model = Some(id);
                }
                if let Some(name) = text(&identity["marketingName"]) {
                    self.status.model_name = Some(name);
                }
            }
            _ => {}
        }
    }

    /// AI 產生的標題或舊版摘要；和上次送出的相同時不重送。
    fn title(&mut self, value: &Value, out: &mut Vec<Event>) {
        let Some(text) = value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| keep_head(text, TITLE_TEXT))
        else {
            return;
        };
        if self.title.as_ref() != Some(&text) {
            self.title = Some(text.clone());
            out.push(Event::Title { text });
        }
    }
}

impl LineParser for Parser {
    fn parse_line(&mut self, raw: &[u8], out: &mut Vec<Event>) {
        self.line(raw, out);
    }
}
