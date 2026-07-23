// 隐藏子命令 `__hook` 的实现：作为 Claude/Codex 的 hook 命令被高频调用。
// 取代旧版 PowerShell 脚本，做到 Windows / macOS / Linux 跨平台一致。
//
// 流程：读取注入的回调环境变量 + stdin 事件 JSON，向本地通知服务
// POST 一条事件，然后无条件退出。失败只写脱敏诊断日志，绝不打断 CLI。
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::exit;
use std::time::Duration;

use cli_manager_hook_schema::{non_empty_trimmed, normalize_hook_input};
use serde_json::{json, Value};

/// `main` 在初始化 Tauri runtime 之前调用本函数并退出，因此这里
/// 不依赖任何 Tauri/WebView 状态，冷启动开销极小。
pub fn run_and_exit(source: &str, event: &str) -> ! {
    if let Err(err) = try_notify(source, event) {
        write_failure_diagnostic(source, event, err.code());
    }
    exit(0);
}

#[derive(Debug, Clone, Copy)]
enum HookNotifyError {
    MissingPort,
    MissingToken,
    StdinRead,
    InvalidInput,
    UnsupportedPayload,
    PayloadSerialize,
    InvalidPort,
    BridgeConnect,
    BridgeWrite,
    BridgeResponse,
}

impl HookNotifyError {
    fn code(self) -> &'static str {
        match self {
            Self::MissingPort => "missing_port",
            Self::MissingToken => "missing_token",
            Self::StdinRead => "stdin_read_failed",
            Self::InvalidInput => "invalid_input",
            Self::UnsupportedPayload => "unsupported_payload",
            Self::PayloadSerialize => "payload_serialize_failed",
            Self::InvalidPort => "invalid_port",
            Self::BridgeConnect => "bridge_connect_failed",
            Self::BridgeWrite => "bridge_write_failed",
            Self::BridgeResponse => "bridge_response_failed",
        }
    }
}

fn try_notify(source: &str, event: &str) -> Result<(), HookNotifyError> {
    // 无 tab id 表示并非 CLI-Manager 托管会话，正常静默退出。
    let Some(tab_id) = non_empty_env("CLI_MANAGER_TAB_ID") else {
        return Ok(());
    };
    let port = non_empty_env("CLI_MANAGER_NOTIFY_PORT").ok_or(HookNotifyError::MissingPort)?;
    let token = non_empty_env("CLI_MANAGER_NOTIFY_TOKEN").ok_or(HookNotifyError::MissingToken)?;

    let mut stdin_raw = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin_raw)
        .map_err(|_| HookNotifyError::StdinRead)?;
    let hook_input: Value =
        serde_json::from_str(stdin_raw.trim()).map_err(|_| HookNotifyError::InvalidInput)?;
    if should_suppress_codex_permission_request(source, event, &hook_input) {
        return Ok(());
    }

    let normalized =
        normalize_hook_input(event, &hook_input).ok_or(HookNotifyError::UnsupportedPayload)?;
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
    let body = serde_json::to_vec(&payload).map_err(|_| HookNotifyError::PayloadSerialize)?;

    post(&port, &token, &body)
}

fn post(port: &str, token: &str, body: &[u8]) -> Result<(), HookNotifyError> {
    let port: u16 = port.parse().map_err(|_| HookNotifyError::InvalidPort)?;
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|_| HookNotifyError::BridgeConnect)?;
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
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body))
        .and_then(|_| stream.flush())
        .map_err(|_| HookNotifyError::BridgeWrite)?;

    // 读掉响应，确保服务端已接收；只校验 HTTP 成功状态，不记录响应内容。
    let mut sink = [0u8; 256];
    let size = stream
        .read(&mut sink)
        .map_err(|_| HookNotifyError::BridgeResponse)?;
    let response = std::str::from_utf8(&sink[..size]).unwrap_or_default();
    if !response.starts_with("HTTP/1.1 2") && !response.starts_with("HTTP/1.0 2") {
        return Err(HookNotifyError::BridgeResponse);
    }
    Ok(())
}

fn write_failure_diagnostic(source: &str, event: &str, code: &str) {
    let Some(home) = env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("HOME").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
    else {
        return;
    };
    let log_dir = home.join(".cli-manager").join("logs");
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let path = log_dir.join("hook-client.log");
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .write(true)
        .open(path)
    else {
        return;
    };
    if file
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= 1024 * 1024)
    {
        let _ = file.set_len(0);
    }
    let line = failure_diagnostic_line(source, event, code);
    let _ = file.write_all(line.as_bytes());
}

fn failure_diagnostic_line(source: &str, event: &str, code: &str) -> String {
    format!(
        "{} source={} event={} error={}\n",
        chrono::Utc::now().to_rfc3339(),
        diagnostic_source(source),
        diagnostic_event(event),
        diagnostic_error(code)
    )
}

fn diagnostic_source(value: &str) -> &'static str {
    match value {
        "claude" => "claude",
        "codex" => "codex",
        "pi" => "pi",
        _ => "unknown",
    }
}

fn diagnostic_event(value: &str) -> &'static str {
    match value {
        "SessionStart" => "SessionStart",
        "UserPromptSubmit" => "UserPromptSubmit",
        "Notification" => "Notification",
        "PermissionRequest" => "PermissionRequest",
        "Stop" => "Stop",
        "StopFailure" => "StopFailure",
        "SubagentStart" => "SubagentStart",
        "SubagentStop" => "SubagentStop",
        "AgentToolStart" => "AgentToolStart",
        "AgentToolStop" => "AgentToolStop",
        "ToolStart" => "ToolStart",
        "ToolStop" => "ToolStop",
        _ => "unknown",
    }
}

fn diagnostic_error(value: &str) -> &'static str {
    match value {
        "missing_port" => "missing_port",
        "missing_token" => "missing_token",
        "stdin_read_failed" => "stdin_read_failed",
        "invalid_input" => "invalid_input",
        "unsupported_payload" => "unsupported_payload",
        "payload_serialize_failed" => "payload_serialize_failed",
        "invalid_port" => "invalid_port",
        "bridge_connect_failed" => "bridge_connect_failed",
        "bridge_write_failed" => "bridge_write_failed",
        "bridge_response_failed" => "bridge_response_failed",
        _ => "unknown",
    }
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
        ("pi", "SessionStart") => "Pi Agent session started",
        ("pi", "UserPromptSubmit") => "Pi Agent running",
        ("pi", "Stop") => "Pi Agent done",
        ("pi", _) => "Pi Agent needs attention",
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
    use super::{failure_diagnostic_line, should_suppress_codex_permission_request};
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

    #[test]
    fn hook_failure_diagnostic_is_redacted_and_single_line() {
        let line = failure_diagnostic_line(
            "codex\nAuthorization: Bearer secret",
            "SessionStart\nprompt=private",
            "bridge_connect_failed\ntoken=secret",
        );

        assert!(line.contains("source=unknown"));
        assert!(line.contains("event=unknown"));
        assert!(line.contains("error=unknown"));
        assert_eq!(line.lines().count(), 1);
        assert!(!line.contains("Bearer secret"));
        assert!(!line.contains("prompt=private"));
        assert!(!line.contains("token=secret"));
    }
}
