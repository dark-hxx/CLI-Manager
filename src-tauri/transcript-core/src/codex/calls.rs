//! 模型看到的紀錄（`response_item`）裡的工具呼叫與輸出，以及兩條流共用的工具事件：
//! 殼層命令、檔案修補、MCP、圖片、子代理與網頁搜尋。

use super::{
    detail, part_id,
    patch::{deleted, parse_patch, unified_hunks},
    shell_tail, text_result, Call, FileEdit, Parser, QUIET,
};
use crate::{
    diff::{cap, created, Patch},
    event::{Event, AGENT_DETAIL, BASH_DETAIL, RESULT_TEXT, SUMMARY_TEXT},
    text::{first_line, first_short_string, keep_head, relative, strip_ansi, text_field},
};
use serde_json::Value;

impl Parser {
    /// 模型看到的紀錄：只取工具呼叫與輸出；訊息與思考由介面事件提供。
    pub(super) fn response(&mut self, payload: &Value, at: Option<u64>, out: &mut Vec<Event>) {
        let id = payload["call_id"]
            .as_str()
            .or_else(|| payload["id"].as_str())
            .unwrap_or_default();
        match payload["type"].as_str() {
            Some("function_call") => {
                let input = match &payload["arguments"] {
                    Value::String(raw) => {
                        serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.clone()))
                    }
                    other => other.clone(),
                };
                let name = payload["name"].as_str().unwrap_or_default();
                self.call(id, name, payload["namespace"].as_str(), &input, at, out);
            }
            Some("custom_tool_call") => {
                let name = payload["name"].as_str().unwrap_or_default();
                self.call(
                    id,
                    name,
                    payload["namespace"].as_str(),
                    &payload["input"],
                    at,
                    out,
                );
            }
            Some("local_shell_call") => {
                if self.fresh(id) {
                    let argv = &payload["action"]["command"];
                    let call = self.shell_call(out, at, id, argv, &command_text(argv));
                    self.remember(id, call);
                }
            }
            Some(
                "function_call_output" | "custom_tool_call_output" | "local_shell_call_output",
            ) => self.output(id, payload, at, out),
            Some("web_search_call") => {
                let id = match payload["id"].as_str().filter(|id| !id.is_empty()) {
                    Some(id) => id.to_string(),
                    None => {
                        self.searches += 1;
                        format!("search-{}-{}", at.unwrap_or(0), self.searches)
                    }
                };
                if !self.fresh(&id) {
                    return;
                }
                let (name, summary) = search(&payload["action"], None);
                self.tool(out, at, &id, name, &summary, None);
                let ok = payload["status"].as_str() != Some("failed");
                self.push(out, text_result(&id, at, ok, "", false));
            }
            _ => {}
        }
    }

    /// 模型的工具呼叫；`input` 是 function_call 解析後的參數，或 custom_tool_call 的原始文字。
    fn call(
        &mut self,
        id: &str,
        name: &str,
        namespace: Option<&str>,
        input: &Value,
        at: Option<u64>,
        out: &mut Vec<Event>,
    ) {
        if !self.fresh(id) {
            return;
        }
        let field = |key: &str| input[key].as_str().unwrap_or_default();
        let call = if let Some(server) = namespace.and_then(|space| space.strip_prefix("mcp__")) {
            self.tool(
                out,
                at,
                id,
                &format!("mcp__{server}__{name}"),
                &format!("{server} · {name}"),
                None,
            );
            Call::Text
        } else {
            match name {
                "shell" | "container.exec" | "local_shell" | "shell_command" | "exec_command" => {
                    let command = match name {
                        "exec_command" => field("cmd").to_string(),
                        _ => command_text(&input["command"]),
                    };
                    self.shell_call(out, at, id, &input["command"], &command)
                }
                // 寫入執行中命令的輸入（空字串時只是讀取新的輸出）。
                "write_stdin" => {
                    self.tool(out, at, id, "BashOutput", &first_line(field("chars")), None);
                    Call::Shell
                }
                "apply_patch" => {
                    let text = input.as_str().unwrap_or_else(|| field("input"));
                    let edits = self.patch_edits(id, text);
                    self.edit_tools(out, at, &edits);
                    Call::Patch(edits)
                }
                "update_plan" => {
                    self.plan(input, at, out);
                    Call::Quiet
                }
                "view_image" => {
                    let path = relative(field("path"), self.cwd.as_deref());
                    self.tool(out, at, id, "Read", &path, None);
                    Call::Image
                }
                "spawn_agent" => {
                    let summary = Some(field("task_name"))
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or_else(|| field("agent_type"));
                    let prompt = detail(field("message"), AGENT_DETAIL);
                    self.tool(out, at, id, "Agent", summary, prompt);
                    Call::Plain
                }
                "send_message" | "followup_task" => {
                    let prompt = detail(field("message"), AGENT_DETAIL);
                    self.tool(out, at, id, "Agent", field("target"), prompt);
                    Call::Plain
                }
                "request_user_input" | "request_user_input_async" => {
                    let question = &input["questions"][0];
                    let summary = text_field(question, "question")
                        .or_else(|| text_field(question, "header"))
                        .or_else(|| text_field(question, "title"))
                        .unwrap_or_default();
                    self.tool(out, at, id, "AskUserQuestion", &summary, None);
                    Call::Text
                }
                _ if QUIET.contains(&name) => Call::Quiet,
                _ => {
                    let summary = match name.strip_prefix("mcp__") {
                        Some(rest) => rest.replacen("__", " · ", 1),
                        None => match input {
                            Value::String(text) => first_line(text),
                            other => first_short_string(other),
                        },
                    };
                    self.tool(out, at, id, name, &summary, None);
                    Call::Text
                }
            }
        };
        self.remember(id, call);
    }

    /// 工具輸出：依呼叫種類整理。已由介面事件呈現的呼叫略過；呼叫在讀取範圍之前時仍送出結果，
    /// 讓前端與更早一頁的工具事件對上。
    fn output(&mut self, id: &str, payload: &Value, at: Option<u64>, out: &mut Vec<Event>) {
        let call = match self.calls.remove(id) {
            Some(call) => call,
            None if id.is_empty() || self.seen.contains(id) => return,
            None => Call::Unknown,
        };
        let (text, image) = output_text(&payload["output"]);
        let failed = payload["success"].as_bool() == Some(false);
        match call {
            Call::Shell => {
                let (code, body) = exec_output(&text);
                let ok = code.unwrap_or(true) && !failed;
                // 命令也可能帶回圖片（例如看了一張截圖）：和其他工具一樣顯示縮圖。
                let event = self.with_images(text_result(id, at, ok, &shell_tail(&body), false));
                self.push(out, event);
            }
            Call::Patch(edits) => {
                let (code, body) = exec_output(&text);
                let ok =
                    code.unwrap_or_else(|| body.trim_start().starts_with("Success")) && !failed;
                self.edit_results(out, at, &edits, ok, &body);
            }
            Call::Image => {
                let event = self.with_images(text_result(id, at, !failed, "", true));
                self.push(out, event);
            }
            Call::Plain => {
                let event = self.with_images(text_result(id, at, !failed, "", false));
                self.push(out, event);
            }
            Call::Text => {
                let text = keep_head(strip_ansi(&text).trim(), RESULT_TEXT);
                let event = self.with_images(text_result(id, at, !failed, &text, image));
                self.push(out, event);
            }
            Call::Quiet => {}
            Call::Unknown => {
                let event = match exec_output(&text) {
                    (Some(ok), body) => self.with_images(text_result(
                        id,
                        at,
                        ok && !failed,
                        &shell_tail(&body),
                        false,
                    )),
                    (None, _) => {
                        let text = keep_head(strip_ansi(&text).trim(), RESULT_TEXT);
                        self.with_images(text_result(id, at, !failed, &text, image))
                    }
                };
                self.push(out, event);
            }
        }
    }

    /// 這個呼叫還沒呈現過；同時記下它，另一條流的同一個呼叫就會略過。
    pub(super) fn fresh(&mut self, id: &str) -> bool {
        id.is_empty() || self.seen.insert(id.to_string())
    }

    /// 記下等待輸出的呼叫；沒有 ID 的呼叫無從對應，不記。
    pub(super) fn remember(&mut self, id: &str, call: Call) {
        if !id.is_empty() {
            self.calls.insert(id.into(), call);
        }
    }

    /// 送出一個工具事件；摘要去掉前後空白後最多 `SUMMARY_TEXT` 字。
    pub(super) fn tool(
        &mut self,
        out: &mut Vec<Event>,
        at: Option<u64>,
        id: &str,
        name: &str,
        summary: &str,
        detail: Option<String>,
    ) {
        self.push(
            out,
            Event::Tool {
                uuid: None,
                at,
                id: id.into(),
                name: name.into(),
                summary: keep_head(summary.trim(), SUMMARY_TEXT),
                detail,
            },
        );
    }

    /// 殼層命令；透過殼層執行的 apply_patch 改以檔案修改呈現。
    fn shell_call(
        &mut self,
        out: &mut Vec<Event>,
        at: Option<u64>,
        id: &str,
        argv: &Value,
        command: &str,
    ) -> Call {
        match shell_patch(argv, command) {
            Some(patch) => {
                let edits = self.patch_edits(id, patch);
                self.edit_tools(out, at, &edits);
                Call::Patch(edits)
            }
            None => {
                self.shell_tool(out, at, id, command);
                Call::Shell
            }
        }
    }

    /// 殼層命令的工具事件：摘要是第一行，detail 是完整命令。
    pub(super) fn shell_tool(
        &mut self,
        out: &mut Vec<Event>,
        at: Option<u64>,
        id: &str,
        command: &str,
    ) {
        let summary = first_line(command);
        self.tool(out, at, id, "Bash", &summary, detail(command, BASH_DETAIL));
    }

    /// 修補裡每個檔案各一個工具事件。
    pub(super) fn edit_tools(&mut self, out: &mut Vec<Event>, at: Option<u64>, edits: &[FileEdit]) {
        for edit in edits {
            self.tool(out, at, &edit.id, edit.name, &edit.path, None);
        }
    }

    /// 修補的結果：成功時每個檔案附上差異；失敗時把錯誤放在第一個檔案。
    pub(super) fn edit_results(
        &mut self,
        out: &mut Vec<Event>,
        at: Option<u64>,
        edits: &[FileEdit],
        ok: bool,
        failure: &str,
    ) {
        for (index, edit) in edits.iter().enumerate() {
            let event = if ok {
                Event::Result {
                    uuid: None,
                    at,
                    id: edit.id.clone(),
                    ok: true,
                    text: None,
                    diff: (!edit.patch.hunks.is_empty()).then(|| edit.patch.hunks.clone()),
                    added: Some(edit.patch.added),
                    removed: Some(edit.patch.removed),
                    truncated: edit.patch.truncated.then_some(true),
                    image: None,
                    images: None,
                }
            } else {
                let text = if index == 0 {
                    keep_head(strip_ansi(failure).trim(), RESULT_TEXT)
                } else {
                    String::new()
                };
                text_result(&edit.id, at, false, &text, false)
            };
            self.push(out, event);
        }
    }

    /// 已由 apply_patch 呼叫呈現、還在等輸出的修補：改用介面紀錄裡的精確差異（含行號），
    /// 傳回 `None`；不是這種情況時原樣交回。
    pub(super) fn refine(&mut self, id: &str, edits: Vec<FileEdit>) -> Option<Vec<FileEdit>> {
        let Some(Call::Patch(pending)) = self.calls.get_mut(id) else {
            return Some(edits);
        };
        for edit in edits {
            if let Some(target) = pending.iter_mut().find(|target| target.path == edit.path) {
                target.patch = edit.patch;
            }
        }
        None
    }

    /// apply_patch 文字裡的檔案；解析不出檔案時仍保留一個工具事件，讓結果有地方顯示。
    fn patch_edits(&self, id: &str, text: &str) -> Vec<FileEdit> {
        let changes = parse_patch(text);
        if changes.is_empty() {
            return vec![FileEdit {
                id: id.into(),
                name: "Edit",
                path: String::new(),
                patch: Patch::new(),
            }];
        }
        let total = changes.len();
        changes
            .into_iter()
            .enumerate()
            .map(|(index, change)| FileEdit {
                id: part_id(id, index, total),
                name: if change.added { "Write" } else { "Edit" },
                path: self.shown(&change.path, change.moved.as_deref()),
                patch: cap(change.hunks),
            })
            .collect()
    }

    /// FileChange 與 patch_apply_begin 的 `changes`：新版為 `{"type":"update","unified_diff":…}`，
    /// 舊版為 `{"update":{"unified_diff":…}}`；新增與刪除附整份內容。
    pub(super) fn changes(&self, id: &str, value: &Value) -> Vec<FileEdit> {
        let Some(map) = value.as_object() else {
            return Vec::new();
        };
        let total = map.len();
        map.iter()
            .enumerate()
            .map(|(index, (path, change))| {
                let (kind, body) = match change["type"].as_str() {
                    Some(kind) => (kind, change),
                    None => change
                        .as_object()
                        .and_then(|object| object.iter().next())
                        .map_or(("update", change), |(kind, body)| (kind.as_str(), body)),
                };
                let content = body["content"].as_str().unwrap_or_default();
                let patch = match kind {
                    "add" => created(content),
                    "delete" => cap(deleted(content)),
                    _ => cap(unified_hunks(
                        body["unified_diff"].as_str().unwrap_or_default(),
                    )),
                };
                FileEdit {
                    id: part_id(id, index, total),
                    name: if kind == "add" { "Write" } else { "Edit" },
                    path: self.shown(path, body["move_path"].as_str()),
                    patch,
                }
            })
            .collect()
    }

    /// 顯示用的路徑（工作目錄內改為相對路徑）；搬移時寫成「舊 → 新」。
    fn shown(&self, path: &str, moved: Option<&str>) -> String {
        let cwd = self.cwd.as_deref();
        match moved.filter(|moved| !moved.trim().is_empty()) {
            Some(moved) => format!("{} → {}", relative(path, cwd), relative(moved, cwd)),
            None => relative(path, cwd),
        }
    }
}

/// 工具輸出：字串，或 `[{type:input_text,text}|{type:input_image}]` 陣列（第二個值表示含圖片）。
pub(super) fn output_text(value: &Value) -> (String, bool) {
    match value {
        Value::String(text) => (text.clone(), false),
        Value::Array(parts) => {
            let image = parts.iter().any(|part| {
                part["type"]
                    .as_str()
                    .is_some_and(|kind| kind.contains("image"))
            });
            let text = parts
                .iter()
                .filter_map(|part| part.as_str().or_else(|| part["text"].as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            (text, image)
        }
        Value::Object(_) if !value["content"].is_null() => output_text(&value["content"]),
        Value::Null => (String::new(), false),
        other => (other.to_string(), false),
    }
}

/// 命令輸出的結束碼與內容。舊版為 `{"output":…,"metadata":{"exit_code":…}}`；新版是表頭
/// （`Exit code:`、`Process exited with code`、`Wall time:`…）加上 `Output:` 之後的內容。
/// 結束碼不明（仍在執行或不是這種格式）時第一個值為 `None`。
fn exec_output(text: &str) -> (Option<bool>, String) {
    if text.trim_start().starts_with('{') {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            if let Some(output) = value["output"].as_str() {
                let code = value["metadata"]["exit_code"]
                    .as_i64()
                    .map(|code| code == 0);
                return (code, output.to_string());
            }
        }
    }
    let mut code = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n').take(12) {
        offset += line.len();
        let line = line.trim_end();
        if line == "Output:" {
            return (code, text[offset..].to_string());
        }
        if let Some(value) = line
            .strip_prefix("Exit code: ")
            .or_else(|| line.strip_prefix("Process exited with code "))
        {
            code = value.trim().parse::<i64>().ok().map(|value| value == 0);
        }
    }
    (code, text.to_string())
}

/// 命令文字：`bash -lc '<命令>'` 只顯示命令本身，其餘參數以殼層引號接起來。
pub(super) fn command_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let argv = parts.iter().filter_map(Value::as_str).collect::<Vec<_>>();
            if let [program, flag, script, ..] = argv.as_slice() {
                let shell = program.rsplit('/').next().unwrap_or(program);
                if matches!(shell, "bash" | "sh" | "zsh" | "dash" | "ksh")
                    && flag.starts_with('-')
                    && flag.ends_with('c')
                {
                    return script.to_string();
                }
            }
            argv.iter()
                .map(|arg| quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        }
        _ => String::new(),
    }
}

/// 透過殼層呼叫的 apply_patch（`["apply_patch", 修補]` 或 `apply_patch <<'EOF'`）的修補文字。
fn shell_patch<'a>(argv: &'a Value, command: &'a str) -> Option<&'a str> {
    if let Some([program, patch, ..]) = argv.as_array().map(Vec::as_slice) {
        if matches!(program.as_str(), Some("apply_patch" | "applypatch")) {
            return patch.as_str();
        }
    }
    let script = command.trim_start();
    if script.starts_with("apply_patch") || script.starts_with("applypatch") {
        return script.find("*** Begin Patch").map(|start| &script[start..]);
    }
    None
}

/// 殼層引號：只含安全字元的參數原樣，其他以單引號包起來。
fn quote(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_./=:,+@%".contains(character));
    if plain {
        arg.into()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

/// 網頁搜尋或開啟網頁：傳回工具名稱與摘要（搜尋字串或網址）。
pub(super) fn search(action: &Value, query: Option<&str>) -> (&'static str, String) {
    let field = |key: &str| {
        action[key]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    match action["type"].as_str() {
        Some("open_page" | "find_in_page") => ("WebFetch", field("url").unwrap_or_default().into()),
        _ => (
            "WebSearch",
            query
                .map(str::trim)
                .filter(|query| !query.is_empty())
                .or_else(|| field("query"))
                .or_else(|| action["queries"][0].as_str())
                .unwrap_or_default()
                .into(),
        ),
    }
}
