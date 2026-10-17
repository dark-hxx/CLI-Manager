//! 工具呼叫的摘要，以及工具結果的整理：差異、圖片、文字內容與依結構推斷工具種類。

use crate::{
    diff::{created, Patch},
    event::{Hunk, AGENT_DETAIL, BASH_DETAIL, PLAN_DETAIL, SUMMARY_TEXT},
    text::{
        first_line, first_short_string, keep_head, number, relative, strip_ansi, strip_reminders,
    },
};
use serde_json::Value;

/// 工具摘要只放關鍵參數本身（路徑、命令、樣式），文字描述交給前端。
pub(super) fn describe(name: &str, input: &Value, cwd: Option<&str>) -> (String, Option<String>) {
    let field = |key: &str| input[key].as_str().unwrap_or_default();
    let detail = |text: &str, max: usize| {
        let text = text.trim();
        (!text.is_empty()).then(|| keep_head(text, max))
    };
    let (summary, detail) = match name {
        "Read" | "Edit" | "Write" | "MultiEdit" => (relative(field("file_path"), cwd), None),
        "NotebookEdit" | "NotebookRead" => {
            let path = Some(field("notebook_path"))
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| field("file_path"));
            (relative(path, cwd), None)
        }
        "Bash" => (
            first_line(field("command")),
            detail(field("command"), BASH_DETAIL),
        ),
        "Grep" | "Glob" => {
            let path = field("path");
            let summary = if path.is_empty() {
                field("pattern").to_string()
            } else {
                format!("{} · {}", field("pattern"), relative(path, cwd))
            };
            (summary, None)
        }
        "WebFetch" => (field("url").into(), None),
        "WebSearch" => (field("query").into(), None),
        "Agent" | "Task" => (
            field("description").into(),
            detail(field("prompt"), AGENT_DETAIL),
        ),
        "Skill" => (
            ["skill", "name", "command"]
                .into_iter()
                .map(field)
                .find(|value| !value.is_empty())
                .unwrap_or_default()
                .into(),
            None,
        ),
        "ExitPlanMode" => (String::new(), detail(field("plan"), PLAN_DETAIL)),
        _ => match name.strip_prefix("mcp__") {
            Some(rest) => (
                match rest.split_once("__") {
                    Some((server, tool)) => format!("{server} · {tool}"),
                    None => rest.into(),
                },
                None,
            ),
            None => (first_short_string(input), None),
        },
    };
    (keep_head(summary.trim(), SUMMARY_TEXT), detail)
}

/// 看不到對應的工具呼叫時，依結果結構推斷工具種類。
pub(super) fn infer_tool(data: &Value) -> Option<&'static str> {
    let object = data.as_object()?;
    let has = |key: &str| object.contains_key(key);
    if has("stdout") && has("stderr") {
        return Some("Bash");
    }
    if has("structuredPatch") {
        return Some(if has("content") && data["type"].is_string() {
            "Write"
        } else {
            "Edit"
        });
    }
    if has("file") && has("type") {
        return Some("Read");
    }
    if has("newTodos") || has("oldTodos") {
        return Some("TodoWrite");
    }
    if has("taskId") && has("updatedFields") {
        return Some("TaskUpdate");
    }
    if data["tasks"].is_array() {
        return Some("TaskList");
    }
    let task = &data["task"];
    if task.is_object()
        && task.get("id").is_some()
        && task.get("subject").is_some()
        && task.get("status").is_none()
        && task.get("description").is_none()
    {
        return Some("TaskCreate");
    }
    None
}

/// 檔案變更的差異；顯示的部分受 `diff` 模組的上限約束，增刪行數則以完整差異計算。
pub(super) fn structured_patch(data: &Value) -> Option<Patch> {
    let hunks = data["structuredPatch"].as_array();
    if data["type"].as_str() == Some("create") && hunks.is_none_or(|hunks| hunks.is_empty()) {
        return data["content"].as_str().map(created);
    }
    let mut patch = Patch::new();
    for hunk in hunks? {
        let lines = hunk["lines"]
            .as_array()
            .map(|lines| lines.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        let header = Hunk {
            old_start: number(&hunk["oldStart"]).unwrap_or(0),
            old_lines: number(&hunk["oldLines"]).unwrap_or(0),
            new_start: number(&hunk["newStart"]).unwrap_or(0),
            new_lines: number(&hunk["newLines"]).unwrap_or(0),
            lines: Vec::new(),
        };
        patch.hunk(header, &lines);
    }
    Some(patch)
}

/// 工具結果的文字內容：去掉 `<system-reminder>` 與控制序列；陣列只取文字片段。
pub(super) fn content_text(content: &Value) -> String {
    let raw = match content {
        Value::String(text) => strip_reminders(text),
        Value::Array(parts) => strip_reminders(
            &parts
                .iter()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => String::new(),
    };
    strip_ansi(&raw).trim().to_string()
}

/// 內嵌（base64）圖片的張數；只有這些能從紀錄裡取出來顯示。
pub(super) fn embedded_images(content: &Value) -> u32 {
    content.as_array().map_or(0, |parts| {
        parts
            .iter()
            .filter(|part| part["type"] == "image" && part["source"]["type"] == "base64")
            .count() as u32
    })
}

/// 結果裡有沒有任何圖片（不論能不能取出來顯示）。
pub(super) fn has_image(content: &Value) -> bool {
    content
        .as_array()
        .is_some_and(|parts| parts.iter().any(|part| part["type"] == "image"))
}

/// 任務 ID：非空字串（去掉前後空白）或數字。
pub(super) fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().into()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}
