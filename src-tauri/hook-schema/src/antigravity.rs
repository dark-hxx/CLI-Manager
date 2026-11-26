//! Antigravity CLI 的被动 Hook 契约。与 Gemini/Claude 通用 normalizer 隔离。
use serde::{Deserialize, Deserializer};
use std::io::{BufReader, Read};

#[cfg(test)]
#[path = "antigravity_tests.rs"]
mod tests;

pub const EVENTS: [&str; 3] = ["SessionStart", "PreInvocation", "Stop"];
const MAX_BYTES: u64 = 2 * 1024 * 1024;

// 未安装的决策类事件不做观测；意外收到 PreToolUse 时仍然委托 agy 原审批链。
pub fn passive_response(event: &str) -> &'static [u8] {
    match event {
        "Stop" => b"{\"decision\":\"stop\"}\n",
        "PreToolUse" => b"{\"decision\":\"ask\"}\n",
        _ => b"{}\n",
    }
}

// UUID 只接受原生带连字符语法，不把文件路径或任意文本当成会话身份。
pub fn valid_session_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        && id.bytes().any(|b| b != b'0' && b != b'-')
}

// 拒绝外部占位 Tab 和协议控制字符，不用 cwd、转录文件名或 active tab 猜身份。
pub fn valid_tab_id(id: &str) -> bool {
    valid_session_id(id)
}

// distro 也是 UNC 的单一组件，不允许路径、点目录、前导选项及不可见字符。
pub fn valid_distro(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.trim() == name
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._- ".contains(&b))
}

// serde 跳过未知字段（尤其 lastUserInput、toolCall）；错误文本仅折叠为布尔，不进入结果。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeInput {
    conversation_id: String,
    transcript_path: Option<String>,
    hook_event_name: Option<String>,
    fully_idle: Option<bool>,
    termination_reason: Option<String>,
    #[serde(default, deserialize_with = "has_error")]
    error: bool,
}

fn has_error<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Option::<String>::deserialize(d)?.is_some_and(|s| !s.trim().is_empty()))
}

// 如果 CLI 提供转录线索，拒绝来自共用 Hook 的 App/IDE 或矛盾的会话；绝不打开该路径。
fn transcript_matches(path: &str, id: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    !normalized.split('/').any(|s| s == "..")
        && normalized.ends_with(&format!(
            "/antigravity-cli/brain/{}/.system_generated/logs/transcript.jsonl",
            id.to_ascii_lowercase()
        ))
}

// 受限流反序列化，只有完整 JSON 才可能变成事件；绝不把超限输入当作合法前缀。
pub fn observation(event: &str, reader: impl Read) -> Option<(&'static str, String)> {
    if !EVENTS.contains(&event) {
        return None;
    }
    let mut limited = reader.take(MAX_BYTES + 1);
    let input: NativeInput = serde_json::from_reader(BufReader::new(&mut limited)).ok()?;
    let hook_event_name = input
        .hook_event_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let transcript_path = input
        .transcript_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if limited.limit() == 0
        || !valid_session_id(&input.conversation_id)
        || hook_event_name.is_some_and(|name| name != event)
        || transcript_path.is_some_and(|p| !transcript_matches(p, &input.conversation_id))
    {
        return None;
    }
    let kind = match event {
        "SessionStart" => "SessionStart",
        "PreInvocation" => "PreInvocation",
        "Stop" if input.fully_idle == Some(true) => match input.termination_reason.as_deref() {
            _ if input.error => "StopFailure",
            Some("NO_TOOL_CALL" | "TERMINAL_STEP_TYPE" | "INJECTED_RESPONSE" | "model_stop") => {
                "Stop"
            }
            Some("USER_CANCELED") => "Interrupt",
            Some(
                "ERROR"
                | "MAX_INVOCATIONS"
                | "MAX_FORCED_INVOCATIONS"
                | "MAX_TOKEN_BUDGET_EXCEEDED"
                | "TERMINAL_CUSTOM_HOOK"
                | "error"
                | "max_steps_exceeded",
            ) => "StopFailure",
            _ => return None,
        },
        _ => return None,
    };
    Some((kind, input.conversation_id.to_ascii_lowercase()))
}
