// 隐藏子命令 `__hook` 的实现：作为 Claude/Codex/Grok 的 hook 命令被高频调用。
// 取代旧版 PowerShell 脚本，做到 Windows / macOS / Linux 跨平台一致。
//
// 流程：读取回调环境变量（或回退到 daemon 发现文件）+ stdin 事件 JSON，
// 向本地通知服务 POST 一条事件，然后无条件退出。失败只写脱敏诊断日志，绝不打断 CLI。
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::exit;
use std::thread;
use std::time::Duration;

use cli_manager_hook_schema::{non_empty_trimmed, normalize_hook_input};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

const NOTIFY_ATTEMPTS: usize = 2;
const NOTIFY_RETRY_DELAY: Duration = Duration::from_millis(80);

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
    let tab_id =
        non_empty_env("CLI_MANAGER_TAB_ID").unwrap_or_else(|| format!("external:{source}"));

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
    // Prefer explicit env tab id; if external, include session id for uniqueness.
    let tab_id = if tab_id.starts_with("external:") {
        normalized
            .session_id
            .as_deref()
            .map(|session| format!("external:{source}:{session}"))
            .unwrap_or(tab_id)
    } else {
        tab_id
    };

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
        // 同一次 Hook 进程内的重试复用该 ID，daemon 可幂等去重。
        "remoteEventId": Uuid::new_v4().to_string(),
    });
    let body = serde_json::to_vec(&payload).map_err(|_| HookNotifyError::PayloadSerialize)?;

    let mut last_error = if non_empty_env("CLI_MANAGER_NOTIFY_PORT").is_some() {
        HookNotifyError::MissingToken
    } else {
        HookNotifyError::MissingPort
    };
    for attempt in 0..NOTIFY_ATTEMPTS {
        let targets = resolve_notify_targets();
        for target in targets {
            match post(&target.port, &target.token, &body) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = error,
            }
        }
        if attempt + 1 < NOTIFY_ATTEMPTS {
            thread::sleep(NOTIFY_RETRY_DELAY);
        }
    }
    Err(last_error)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NotifyTarget {
    port: String,
    token: String,
}

fn resolve_notify_targets() -> Vec<NotifyTarget> {
    let mut targets = Vec::with_capacity(2);
    if let (Some(port), Some(token)) = (
        non_empty_env("CLI_MANAGER_NOTIFY_PORT"),
        non_empty_env("CLI_MANAGER_NOTIFY_TOKEN"),
    ) {
        targets.push(NotifyTarget { port, token });
    }

    // 外部 CLI 没有注入环境；旧终端也可能仍持有重启前的端口，始终补充当前 daemon 发现目标。
    if let Ok(data_dir) = crate::app_paths::cli_manager_data_dir() {
        for name in ["daemon.dev.json", "daemon.json"] {
            if let Some(target) = read_daemon_notify_target(&data_dir.join(name)) {
                if !targets.contains(&target) {
                    targets.push(target);
                }
                break;
            }
        }
    }
    targets
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonInfoLite {
    hook_port: u16,
    token: String,
    #[serde(default)]
    pid: u32,
}

fn read_daemon_notify_target(path: &PathBuf) -> Option<NotifyTarget> {
    let raw = fs::read_to_string(path).ok()?;
    let info: DaemonInfoLite = serde_json::from_str(&raw).ok()?;
    if info.hook_port == 0 || info.token.trim().is_empty() {
        return None;
    }
    if info.pid != 0 && !crate::daemon::discovery::is_pid_alive(info.pid) {
        return None;
    }
    Some(NotifyTarget {
        port: info.hook_port.to_string(),
        token: info.token,
    })
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
        "grok" => "grok",
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
    if event != "PermissionRequest" {
        return false;
    }
    match source {
        "codex" => matches!(
            hook_input.get("permission_mode").and_then(Value::as_str),
            Some("dontAsk" | "bypassPermissions")
        ),
        "grok" => {
            hook_input
                .get("permissionMode")
                .or_else(|| hook_input.get("permission_mode"))
                .and_then(Value::as_str)
                == Some("bypassPermissions")
        }
        _ => false,
    }
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
        ("grok", "SessionStart") => "Grok Build session started",
        ("grok", "UserPromptSubmit") => "Grok Build running",
        ("grok", "Stop") => "Grok Build done",
        ("grok", "StopFailure") => "Grok Build failed",
        ("grok", "SubagentStart") => "Grok Build subagent started",
        ("grok", "SubagentStop") => "Grok Build subagent done",
        ("grok", "AgentToolStart") => "Grok Build Agent tool started",
        ("grok", "AgentToolStop") => "Grok Build Agent tool done",
        ("grok", "ToolStart") => "Grok Build tool started",
        ("grok", "ToolStop") => "Grok Build tool done",
        ("grok", _) => "Grok Build needs attention",
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

    #[test]
    fn suppresses_only_bypassed_grok_permission_request() {
        assert!(should_suppress_codex_permission_request(
            "grok",
            "PermissionRequest",
            &json!({ "permissionMode": "bypassPermissions" })
        ));
        for input in [
            json!({ "permissionMode": "auto" }),
            json!({ "permissionMode": "default" }),
            json!({}),
        ] {
            assert!(!should_suppress_codex_permission_request(
                "grok",
                "PermissionRequest",
                &input
            ));
        }
    }
}
