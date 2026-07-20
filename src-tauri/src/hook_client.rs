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

use cli_manager_hook_schema::{non_empty_trimmed, normalize_hook_input};
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

    let normalized = normalize_hook_input(event, &hook_input)?;
    let reasoning_effort = normalized
        .reasoning_effort
        .or_else(|| non_empty_env("CLAUDE_EFFORT").and_then(|value| non_empty_trimmed(&value)));
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
        "message": normalized.message,
        "sessionId": normalized.session_id,
        "cwd": cwd,
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "agentId": normalized.agent_id,
        "toolUseId": normalized.tool_use_id,
        "toolName": normalized.tool_name,
        "mcpServer": normalized.mcp_server,
        "skillName": normalized.skill_name,
        "agentType": normalized.agent_type,
        "agentTranscriptPath": normalized.agent_transcript_path,
        "transcriptPath": normalized.transcript_path,
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

fn should_suppress_codex_permission_request(source: &str, event: &str, hook_input: &Value) -> bool {
    source == "codex"
        && event == "PermissionRequest"
        && matches!(
            hook_input.get("permission_mode").and_then(Value::as_str),
            Some("dontAsk" | "bypassPermissions")
        )
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
    use super::should_suppress_codex_permission_request;
    use serde_json::json;

    #[test]
    fn extract_reasoning_effort_reads_claude_hook_effort_level() {
        let input = json!({
            "session_id": "abc",
            "effort": { "level": " high " }
        });

        assert_eq!(
            cli_manager_hook_schema::extract_reasoning_effort(&input).as_deref(),
            Some("high")
        );
    }

    #[test]
    fn extract_reasoning_effort_reads_flat_legacy_keys() {
        let input = json!({
            "session_id": "abc",
            "reasoning_effort": "xhigh"
        });

        assert_eq!(
            cli_manager_hook_schema::extract_reasoning_effort(&input).as_deref(),
            Some("xhigh")
        );
    }

    #[test]
    fn extract_mcp_server_reads_claude_tool_name() {
        assert_eq!(
            cli_manager_hook_schema::extract_mcp_server("mcp__exa__web_search_exa").as_deref(),
            Some("exa")
        );
        assert_eq!(cli_manager_hook_schema::extract_mcp_server("Read"), None);
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
            "codex", "Stop", &bypass
        ));
    }
}
