//! 各種紀錄行整理成事件：你的訊息、模型回覆、工具呼叫與結果、系統訊息與排隊的訊息。

use super::{
    tools::{
        content_text, describe, embedded_images, has_image, id_text, infer_tool, structured_patch,
    },
    Meta, Parser,
};
use crate::{
    event::{
        Event, TaskItem, ASSISTANT_TEXT, BASH_TAIL, COMMAND_OUTPUT, ERROR_TEXT, NOTICE_TEXT,
        PROMPT_TEXT, RESULT_TEXT, SUMMARY_TEXT, THINKING_TEXT,
    },
    text::{
        join_output, keep_head, keep_tail, number, strip_ansi, strip_reminders, styled_output,
        text_field,
    },
};
use serde_json::Value;

impl Parser {
    /// 使用者那一行：文字與圖片合成一則訊息，工具結果各自成為結果事件。
    pub(super) fn user(&mut self, line: &Value, meta: &Meta, out: &mut Vec<Event>) {
        // 內部注入的內容（技能展開、壓縮摘要等）不是使用者輸入。
        if line["isMeta"].as_bool() == Some(true)
            || line["isCompactSummary"].as_bool() == Some(true)
        {
            return;
        }
        let mut texts = Vec::new();
        let mut images = 0u32;
        match &line["message"]["content"] {
            Value::String(text) => user_text(text, meta, &mut texts, out),
            Value::Array(blocks) => {
                for block in blocks {
                    match block["type"].as_str() {
                        Some("text") => {
                            if let Some(text) = block["text"].as_str() {
                                user_text(text, meta, &mut texts, out);
                            }
                        }
                        Some("image") => images += 1,
                        Some("tool_result") => self.result(block, line, meta, out),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        if !texts.is_empty() || images > 0 {
            out.push(Event::User {
                uuid: meta.uuid.clone(),
                at: meta.at,
                text: keep_head(&texts.join("\n\n"), PROMPT_TEXT),
                images: (images > 0).then_some(images),
            });
        }
    }

    /// 模型回覆那一行：文字、思考與工具呼叫依序成為事件。
    pub(super) fn assistant(&mut self, line: &Value, meta: &Meta, out: &mut Vec<Event>) {
        let message = &line["message"];
        // CLI 自己合成的訊息（例如本機指令後的「No response requested.」）不是模型回覆；
        // 只保留其中的 API 錯誤，改以錯誤呈現。
        if message["model"].as_str() == Some("<synthetic>") {
            let text = match &message["content"] {
                Value::String(text) => text.clone(),
                Value::Array(blocks) => blocks
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            let text = strip_ansi(&text);
            let text = text.trim();
            if text.starts_with("API Error") {
                out.push(Event::Error {
                    at: meta.at,
                    text: keep_head(text, ERROR_TEXT),
                    retry_in_ms: None,
                    attempt: None,
                    max: None,
                });
            }
            return;
        }
        let model = message["model"]
            .as_str()
            .filter(|model| !model.is_empty())
            .map(String::from);
        let fast = message["usage"]["speed"].as_str() == Some("fast");
        let blocks = match &message["content"] {
            Value::Array(blocks) => blocks,
            Value::String(text) => {
                assistant_text(text, model, fast, meta, out);
                return;
            }
            _ => return,
        };
        for block in blocks {
            match block["type"].as_str() {
                Some("text") => assistant_text(
                    block["text"].as_str().unwrap_or_default(),
                    model.clone(),
                    fast,
                    meta,
                    out,
                ),
                Some("thinking") => out.push(Event::Thinking {
                    uuid: meta.uuid.clone(),
                    at: meta.at,
                    text: block["thinking"]
                        .as_str()
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .map(|text| keep_head(text, THINKING_TEXT)),
                    ms: number(&line["thinkingDurationMs"]),
                }),
                Some("redacted_thinking") => out.push(Event::Thinking {
                    uuid: meta.uuid.clone(),
                    at: meta.at,
                    text: None,
                    ms: number(&line["thinkingDurationMs"]),
                }),
                Some("tool_use") => self.tool_use(block, line, meta, out),
                _ => {}
            }
        }
    }

    /// 工具呼叫：記下名稱給之後的結果用；任務清單類的工具改以任務事件呈現。
    fn tool_use(&mut self, block: &Value, line: &Value, meta: &Meta, out: &mut Vec<Event>) {
        let id = block["id"].as_str().unwrap_or_default();
        let name = block["name"].as_str().unwrap_or_default();
        let input = &block["input"];
        if !id.is_empty() {
            self.tools.insert(id.into(), name.into());
        }
        match name {
            // 任務清單只以任務事件呈現；建立的 ID 要等結果才知道。
            "TaskCreate" | "TaskList" => {}
            "TaskUpdate" => {
                if let Some(task) = id_text(&input["taskId"]) {
                    out.push(Event::Task {
                        at: meta.at,
                        op: "update",
                        id: task,
                        status: text_field(input, "status"),
                        subject: text_field(input, "subject"),
                    });
                }
            }
            "TodoWrite" => {
                if let Some(todos) = input["todos"].as_array() {
                    let items = todos
                        .iter()
                        .enumerate()
                        .map(|(index, todo)| TaskItem {
                            id: index.to_string(),
                            subject: todo["content"].as_str().unwrap_or_default().into(),
                            status: text_field(todo, "status"),
                        })
                        .collect();
                    out.push(Event::Tasks { at: meta.at, items });
                }
            }
            _ => {
                let cwd = line["cwd"].as_str().or(self.cwd.as_deref());
                let (summary, detail) = describe(name, input, cwd);
                out.push(Event::Tool {
                    uuid: meta.uuid.clone(),
                    at: meta.at,
                    id: id.into(),
                    name: name.into(),
                    summary,
                    detail,
                });
            }
        }
    }

    /// 工具結果：依工具種類整理文字、差異或圖片；失敗時只留錯誤訊息的開頭。
    fn result(&mut self, block: &Value, line: &Value, meta: &Meta, out: &mut Vec<Event>) {
        let id = block["tool_use_id"].as_str().unwrap_or_default();
        let ok = block["is_error"].as_bool() != Some(true);
        let data = &line["toolUseResult"];
        let content = &block["content"];
        // 工具呼叫可能在更早的視窗；看不到名稱時依結構推斷。
        let name = self
            .tools
            .get(id)
            .map(String::as_str)
            .or_else(|| infer_tool(data));
        match name {
            Some("TaskCreate") => {
                let task = &data["task"];
                if let (true, Some(task_id)) = (ok, id_text(&task["id"])) {
                    out.push(Event::Task {
                        at: meta.at,
                        op: "create",
                        id: task_id,
                        status: None,
                        subject: text_field(task, "subject"),
                    });
                }
                return;
            }
            Some("TaskList") => {
                if let Some(tasks) = data["tasks"].as_array() {
                    let items = tasks
                        .iter()
                        .filter_map(|task| {
                            Some(TaskItem {
                                id: id_text(&task["id"])?,
                                subject: task["subject"].as_str().unwrap_or_default().into(),
                                status: text_field(task, "status"),
                            })
                        })
                        .collect();
                    out.push(Event::Tasks { at: meta.at, items });
                }
                return;
            }
            Some("TaskUpdate" | "TodoWrite") => return,
            _ => {}
        }
        let mut text = None;
        let mut patch = None;
        if !ok {
            text = Some(keep_head(&content_text(content), RESULT_TEXT));
        } else {
            match name {
                Some("Read") => {}
                Some("Bash") => {
                    let output = if data.is_object() {
                        strip_ansi(&join_output(
                            data["stdout"].as_str().unwrap_or_default(),
                            data["stderr"].as_str().unwrap_or_default(),
                        ))
                    } else {
                        content_text(content)
                    };
                    text = Some(keep_tail(output.trim(), BASH_TAIL));
                }
                Some("Edit" | "Write" | "MultiEdit") => match structured_patch(data) {
                    Some(found) => patch = Some(found),
                    None => text = Some(keep_head(&content_text(content), RESULT_TEXT)),
                },
                _ => text = Some(keep_head(&content_text(content), RESULT_TEXT)),
            }
        }
        out.push(Event::Result {
            uuid: meta.uuid.clone(),
            at: meta.at,
            id: id.into(),
            ok,
            text: text.filter(|text| !text.is_empty()),
            diff: patch
                .as_ref()
                .filter(|patch| !patch.hunks.is_empty())
                .map(|patch| patch.hunks.clone()),
            added: patch.as_ref().map(|patch| patch.added),
            removed: patch.as_ref().map(|patch| patch.removed),
            truncated: patch.as_ref().filter(|patch| patch.truncated).map(|_| true),
            image: has_image(content).then_some(true),
            images: Some(embedded_images(content)).filter(|count| *count > 0),
        });
    }
}

/// 使用者文字：辨識斜線指令、本機指令輸出、`!` 命令與背景任務通知，其餘才是真正的提示詞。
fn user_text(raw: &str, meta: &Meta, texts: &mut Vec<String>, out: &mut Vec<Event>) {
    let stripped = strip_reminders(raw);
    let text = stripped.trim_start().to_string();
    if text.is_empty() {
        return;
    }
    if slash_command(&text, meta, out) {
        return;
    }
    if text.starts_with("<local-command-caveat>") {
        return;
    }
    if text.starts_with("<local-command-stdout>") || text.starts_with("<local-command-stderr>") {
        let output = join_output(
            inner(&text, "local-command-stdout").unwrap_or_default(),
            inner(&text, "local-command-stderr").unwrap_or_default(),
        );
        command_output(&output, meta, out);
        return;
    }
    if text.starts_with("<bash-input>") {
        out.push(Event::Command {
            uuid: meta.uuid.clone(),
            at: meta.at,
            name: "!".into(),
            args: inner(&text, "bash-input")
                .map(str::trim)
                .filter(|command| !command.is_empty())
                .map(|command| keep_head(command, COMMAND_OUTPUT)),
        });
        return;
    }
    if text.starts_with("<bash-stdout>") || text.starts_with("<bash-stderr>") {
        let output = join_output(
            inner(&text, "bash-stdout").unwrap_or_default(),
            inner(&text, "bash-stderr").unwrap_or_default(),
        );
        command_output(&output, meta, out);
        return;
    }
    if text.starts_with("<task-notification>") {
        out.push(Event::Notice {
            at: meta.at,
            code: None,
            text: task_notification(&text),
        });
        return;
    }
    // CLI 自己寫入的中斷標記，不是使用者輸入的文字；帶代碼讓前端依介面語言顯示。
    if text.starts_with("[Request interrupted by user") {
        out.push(Event::Notice {
            at: meta.at,
            code: Some("turn_interrupted".into()),
            text: keep_head(&text, NOTICE_TEXT),
        });
        return;
    }
    texts.push(text);
}

/// `<command-name>/x</command-name><command-message>…<command-args>…` 這組標籤（順序與縮排不拘）
/// 轉成一則斜線指令事件；不是這種格式時回傳 false。
fn slash_command(text: &str, meta: &Meta, out: &mut Vec<Event>) -> bool {
    if !(text.starts_with("<command-") || text.starts_with("<local-command-caveat>")) {
        return false;
    }
    let Some(name) = inner(text, "command-name")
        .map(str::trim)
        .filter(|name| !name.is_empty())
    else {
        return false;
    };
    out.push(Event::Command {
        uuid: meta.uuid.clone(),
        at: meta.at,
        name: keep_head(name, SUMMARY_TEXT),
        args: inner(text, "command-args")
            .map(str::trim)
            .filter(|args| !args.is_empty())
            .map(|args| keep_head(args, COMMAND_OUTPUT)),
    });
    true
}

/// 回覆裡的一段文字；去掉前後空白後為空時不送出。
fn assistant_text(
    text: &str,
    model: Option<String>,
    fast: bool,
    meta: &Meta,
    out: &mut Vec<Event>,
) {
    let text = text.trim();
    if !text.is_empty() {
        out.push(Event::Assistant {
            uuid: meta.uuid.clone(),
            at: meta.at,
            text: keep_head(text, ASSISTANT_TEXT),
            model,
            fast,
        });
    }
}

/// 本機指令或 `!` 命令的輸出：純文字一份，有顏色時另附只留 SGR 的版本。
fn command_output(output: &str, meta: &Meta, out: &mut Vec<Event>) {
    let text = strip_ansi(output);
    let text = text.trim();
    if !text.is_empty() {
        out.push(Event::CommandOutput {
            uuid: meta.uuid.clone(),
            at: meta.at,
            text: keep_head(text, COMMAND_OUTPUT),
            ansi: styled_output(output, COMMAND_OUTPUT),
        });
    }
}

/// 系統訊息：一輪的用時、上下文壓縮、API 錯誤、CLI 的提示與本機指令。
pub(super) fn system(line: &Value, meta: &Meta, out: &mut Vec<Event>) {
    let at = meta.at;
    match line["subtype"].as_str() {
        Some("turn_duration") => {
            if let Some(ms) = number(&line["durationMs"]) {
                out.push(Event::Turn {
                    at,
                    ms,
                    messages: number(&line["messageCount"]),
                });
            }
        }
        Some("compact_boundary") => out.push(Event::Compact { at }),
        Some("api_error") => out.push(Event::Error {
            at,
            text: keep_head(strip_ansi(&error_text(&line["error"])).trim(), ERROR_TEXT),
            retry_in_ms: number(&line["retryInMs"]),
            attempt: number(&line["retryAttempt"]),
            max: number(&line["maxRetries"]),
        }),
        Some("away_summary" | "informational" | "model_refusal_fallback") => {
            let text = strip_ansi(line["content"].as_str().unwrap_or_default());
            let text = text.trim();
            if !text.is_empty() {
                out.push(Event::Notice {
                    at,
                    code: None,
                    text: keep_head(text, NOTICE_TEXT),
                });
            }
        }
        Some("local_command") => {
            let content = line["content"].as_str().unwrap_or_default();
            // 2.1 起斜線指令本身也記成 local_command，內容是 <command-name> 等標籤。
            if slash_command(content.trim_start(), meta, out) {
                return;
            }
            if content.contains("<local-command-std") {
                let output = join_output(
                    inner(content, "local-command-stdout").unwrap_or_default(),
                    inner(content, "local-command-stderr").unwrap_or_default(),
                );
                command_output(&output, meta, out);
            } else {
                command_output(content, meta, out);
            }
        }
        _ => {}
    }
}

/// 使用者在 Claude 忙碌時送出的訊息；背景任務通知也走這條路，改以通知呈現。
pub(super) fn attachment(line: &Value, meta: &Meta, out: &mut Vec<Event>) {
    let attachment = &line["attachment"];
    if attachment["type"].as_str() != Some("queued_command")
        || line["isMeta"].as_bool() == Some(true)
        || attachment["isMeta"].as_bool() == Some(true)
    {
        return;
    }
    let raw = match &attachment["prompt"] {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => return,
    };
    let text = strip_reminders(&raw);
    if text.is_empty() || slash_command(text.trim_start(), meta, out) {
        return;
    }
    if attachment["commandMode"].as_str() == Some("task-notification")
        || text.starts_with("<task-notification>")
    {
        out.push(Event::Notice {
            at: meta.at,
            code: None,
            text: task_notification(&text),
        });
    } else {
        out.push(Event::Queued {
            at: meta.at,
            text: keep_head(&text, PROMPT_TEXT),
        });
    }
}

/// API 錯誤的訊息：字串照用；物件依序找幾個常見的訊息欄位，都沒有時改用 HTTP 狀態碼。
fn error_text(error: &Value) -> String {
    match error {
        Value::String(text) => text.clone(),
        Value::Object(_) => [
            &error["message"],
            &error["error"]["message"],
            &error["error"]["error"]["message"],
            &error["formatted"],
        ]
        .into_iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|text| !text.is_empty())
        .map(String::from)
        .or_else(|| number(&error["status"]).map(|status| format!("HTTP {status}")))
        .unwrap_or_default(),
        _ => String::new(),
    }
}

/// 背景任務通知只留下人看得懂的部分（摘要、事件、備註、結果）。
fn task_notification(text: &str) -> String {
    let parts = ["summary", "event", "note", "result"]
        .into_iter()
        .filter_map(|tag| inner(text, tag))
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let text = if parts.is_empty() {
        strip_tags(text)
    } else {
        parts.join("\n")
    };
    keep_head(&strip_ansi(&text), NOTICE_TEXT)
}

/// `<tag>` 與 `</tag>` 之間的文字；沒有結尾標籤時取到文字結尾。
fn inner<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let rest = &text[start..];
    Some(
        rest.find(&format!("</{tag}>"))
            .map_or(rest, |end| &rest[..end]),
    )
}

/// 去除形如 `<tag>`、`</tag>` 的標記，保留其中文字並略去空行。
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('<') {
        out.push_str(&rest[..index]);
        let after = &rest[index + 1..];
        let name = after.strip_prefix('/').unwrap_or(after);
        let tag = name.find('>').filter(|&end| {
            end > 0
                && name[..end].chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
        });
        match tag {
            Some(end) => rest = &name[end + 1..],
            None => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
