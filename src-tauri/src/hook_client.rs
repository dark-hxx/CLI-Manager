// 隐藏子命令 `__hook` 的实现：作为 Claude/Codex 的 hook 命令被高频调用。
// 取代旧版 PowerShell 脚本，做到 Windows / macOS / Linux 跨平台一致。
//
// 流程：读取注入的回调环境变量 + stdin 事件 JSON，向本地通知服务
// POST 一条事件，然后无条件退出。任何缺失/失败都静默 exit(0)，绝不打断 CLI。
use std::env;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::exit;
use std::time::Duration;

use serde_json::{json, Value};

/// `main` 在初始化 Tauri runtime 之前调用本函数并退出，因此这里
/// 不依赖任何 Tauri/WebView 状态，冷启动开销极小。
pub fn run_and_exit(source: &str, event: &str) -> ! {
    // 忽略一切错误：hook 失败不能影响被监听的 CLI。
    let _ = try_notify(source, event);
    exit(0);
}

fn try_notify(source: &str, event: &str) -> Option<()> {
    // 三个回调环境变量由 PTY 注入（claude_hook::apply_env）。缺任一即未启用回调，直接退出。
    let tab_id = non_empty_env("CLI_MANAGER_TAB_ID")?;
    let port = non_empty_env("CLI_MANAGER_NOTIFY_PORT")?;
    let token = non_empty_env("CLI_MANAGER_NOTIFY_TOKEN")?;

    let mut stdin_raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin_raw);
    let hook_input: Value = serde_json::from_str(stdin_raw.trim()).unwrap_or(Value::Null);
    if should_suppress_codex_permission_request(source, event, &hook_input) {
        return None;
    }

    let tool_input = hook_input.get("tool_input");
    let tool_response = hook_input
        .get("tool_response")
        .or_else(|| hook_input.get("tool_result"));
    let message = first_string(
        &hook_input,
        &["message", "prompt", "notification", "reason"],
    )
    .or_else(|| {
        tool_input.and_then(|value| first_string(value, &["prompt", "description", "task"]))
    });
    let session_id = hook_input
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    // 子 Agent 事件（SubagentStart 等）字段；hook stdin 为 snake_case。
    let agent_id = first_string(&hook_input, &["agent_id"])
        .or_else(|| tool_input.and_then(|value| first_string(value, &["agent_id", "agentId"])))
        .or_else(|| tool_response.and_then(|value| first_string(value, &["agent_id", "agentId"])));
    let tool_use_id = first_string(&hook_input, &["tool_use_id", "toolUseId", "tool_id", "id"])
        .or_else(|| {
            tool_input.and_then(|value| first_string(value, &["tool_use_id", "toolUseId", "id"]))
        });
    let tool_name = first_string(&hook_input, &["tool_name", "toolName", "name"])
        .or_else(|| {
            tool_input.and_then(|value| first_string(value, &["tool_name", "toolName", "name"]))
        })
        .or_else(|| {
            tool_response.and_then(|value| first_string(value, &["tool_name", "toolName", "name"]))
        });
    if matches!(event, "ToolStart" | "ToolStop")
        && tool_name
            .as_deref()
            .is_some_and(|name| matches!(name, "Agent" | "Task"))
    {
        return None;
    }
    let mcp_server = tool_name
        .as_deref()
        .and_then(extract_mcp_server)
        .or_else(|| first_string(&hook_input, &["mcp_server", "mcpServer", "server"]))
        .or_else(|| {
            tool_input.and_then(|value| first_string(value, &["mcp_server", "mcpServer", "server"]))
        })
        .or_else(|| {
            tool_response
                .and_then(|value| first_string(value, &["mcp_server", "mcpServer", "server"]))
        });
    let skill_name = tool_input
        .and_then(|value| first_string(value, &["skill", "skill_name", "skillName"]))
        .or_else(|| first_string(&hook_input, &["skill", "skill_name", "skillName"]));
    let agent_type = first_string(&hook_input, &["agent_type"])
        .or_else(|| {
            tool_input.and_then(|value| {
                first_string(
                    value,
                    &["agent_type", "agentType", "subagent_type", "subagentType"],
                )
            })
        })
        .or_else(|| {
            tool_response.and_then(|value| {
                first_string(
                    value,
                    &["agent_type", "agentType", "subagent_type", "subagentType"],
                )
            })
        });
    let agent_transcript_path = first_string(&hook_input, &["agent_transcript_path"])
        .or_else(|| {
            tool_input.and_then(|value| {
                first_string(value, &["agent_transcript_path", "agentTranscriptPath"])
            })
        })
        .or_else(|| {
            tool_response.and_then(|value| {
                first_string(value, &["agent_transcript_path", "agentTranscriptPath"])
            })
        })
        .or_else(|| {
            deep_first_string(
                &hook_input,
                &[
                    "agent_transcript_path",
                    "agentTranscriptPath",
                    "child_transcript_path",
                    "childTranscriptPath",
                ],
            )
        });
    let transcript_path = first_string(&hook_input, &["transcript_path"]);
    let reasoning_effort = extract_reasoning_effort(&hook_input);
    let wsl_distro_name = non_empty_env("WSL_DISTRO_NAME");
    let cwd = env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string());

    // 字段名为 camelCase，对应 claude_hook::ClaudeHookRequest 的 serde(rename_all = "camelCase")。
    let payload = json!({
        "tabId": tab_id,
        "source": source,
        "event": event,
        "title": title_for(source, event),
        "message": message,
        "sessionId": session_id,
        "cwd": cwd,
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "agentId": agent_id,
        "toolUseId": tool_use_id,
        "toolName": tool_name,
        "mcpServer": mcp_server,
        "skillName": skill_name,
        "agentType": agent_type,
        "agentTranscriptPath": agent_transcript_path,
        "transcriptPath": transcript_path,
        "reasoningEffort": reasoning_effort,
        "wslDistroName": wsl_distro_name,
    });
    let body = serde_json::to_vec(&payload).ok()?;

    post(&port, &token, &body)
}

fn post(port: &str, token: &str, body: &[u8]) -> Option<()> {
    let port: u16 = port.parse().ok()?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));

    let head = format!(
        "POST /api/claude-hook HTTP/1.1\r\n\
         Host: 127.0.0.1\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).ok()?;
    stream.write_all(body).ok()?;
    stream.flush().ok()?;

    // 读掉响应，确保服务端处理完再退出（内容不关心）。
    let mut sink = [0u8; 256];
    let _ = stream.read(&mut sink);
    Some(())
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

fn should_suppress_codex_permission_request(
    source: &str,
    event: &str,
    hook_input: &Value,
) -> bool {
    source == "codex"
        && event == "PermissionRequest"
        && matches!(
            hook_input.get("permission_mode").and_then(Value::as_str),
            Some("dontAsk" | "bypassPermissions")
        )
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_string))
}

fn deep_first_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(found) = keys
                .iter()
                .find_map(|key| map.get(*key).and_then(Value::as_str).map(str::to_string))
            {
                return Some(found);
            }
            map.values()
                .find_map(|child| deep_first_string(child, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| deep_first_string(child, keys)),
        _ => None,
    }
}

fn extract_mcp_server(value: &str) -> Option<String> {
    let rest = value.strip_prefix("mcp__")?;
    let (server, _) = rest.split_once("__")?;
    non_empty_trimmed(server)
}

fn extract_reasoning_effort(hook_input: &Value) -> Option<String> {
    let candidates = [
        hook_input.get("effort").and_then(Value::as_str),
        hook_input
            .get("effort")
            .and_then(|value| value.get("level"))
            .and_then(Value::as_str),
        hook_input.get("reasoning_effort").and_then(Value::as_str),
        hook_input.get("reasoningEffort").and_then(Value::as_str),
        hook_input.get("effort_level").and_then(Value::as_str),
        hook_input.get("effortLevel").and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(non_empty_trimmed)
        .or_else(|| non_empty_env("CLAUDE_EFFORT").and_then(|value| non_empty_trimmed(&value)))
}

fn non_empty_trimmed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// 与旧 PowerShell 脚本保持一致的标题文案；前端在缺省时会自行兜底（App.tsx）。
fn title_for(source: &str, event: &str) -> &'static str {
    match (source, event) {
        ("codex", "SessionStart") => "Codex CLI session started",
        ("codex", "UserPromptSubmit") => "Codex CLI running",
        ("codex", "Stop") => "Codex CLI done",
        ("codex", "SubagentStart") => "Codex CLI subagent started",
        ("codex", "SubagentStop") => "Codex CLI subagent done",
        ("codex", _) => "Codex CLI needs attention", // PermissionRequest
        (_, "SessionStart") => "Claude Code session started",
        (_, "UserPromptSubmit") => "Claude Code running",
        (_, "Stop") => "Claude Code done",
        (_, "StopFailure") => "Claude Code failed",
        (_, "SubagentStart") => "Claude Code subagent started",
        (_, "SubagentStop") => "Claude Code subagent done",
        (_, "AgentToolStart") => "Claude Code Agent tool started",
        (_, "AgentToolStop") => "Claude Code Agent tool done",
        (_, "ToolStart") => "Claude Code tool started",
        (_, "ToolStop") => "Claude Code tool done",
        (_, _) => "Claude Code needs attention", // Notification
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_reasoning_effort_reads_claude_hook_effort_level() {
        let input = json!({
            "session_id": "abc",
            "effort": { "level": " high " }
        });

        assert_eq!(extract_reasoning_effort(&input).as_deref(), Some("high"));
    }

    #[test]
    fn extract_reasoning_effort_reads_flat_legacy_keys() {
        let input = json!({
            "session_id": "abc",
            "reasoning_effort": "xhigh"
        });

        assert_eq!(extract_reasoning_effort(&input).as_deref(), Some("xhigh"));
    }

    #[test]
    fn extract_mcp_server_reads_claude_tool_name() {
        assert_eq!(
            extract_mcp_server("mcp__exa__web_search_exa").as_deref(),
            Some("exa")
        );
        assert_eq!(extract_mcp_server("Read"), None);
    }

    #[test]
    fn suppresses_codex_permission_request_without_interactive_approval() {
        for permission_mode in ["dontAsk", "bypassPermissions"] {
            let input = json!({ "permission_mode": permission_mode });
            assert!(should_suppress_codex_permission_request(
                "codex",
                "PermissionRequest",
                &input
            ));
        }
    }

    #[test]
    fn preserves_permission_request_for_interactive_or_unknown_modes() {
        for input in [
            json!({ "permission_mode": "default" }),
            json!({ "permission_mode": "acceptEdits" }),
            json!({ "permission_mode": "plan" }),
            json!({}),
        ] {
            assert!(!should_suppress_codex_permission_request(
                "codex",
                "PermissionRequest",
                &input
            ));
        }

        let bypass = json!({ "permission_mode": "bypassPermissions" });
        assert!(!should_suppress_codex_permission_request(
            "claude",
            "PermissionRequest",
            &bypass
        ));
        assert!(!should_suppress_codex_permission_request(
            "codex",
            "Stop",
            &bypass
        ));
    }
}
