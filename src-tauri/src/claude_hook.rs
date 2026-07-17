use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::third_party_notification::HookNotificationJob;

const REQUEST_PATH: &str = "/api/claude-hook";
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// hook 上报的消费出口：主进程实现为 Tauri 事件，daemon 实现为帧广播 + 缓存
/// （Issue #123 Phase 2 复用点：HTTP 解析/校验逻辑两侧共享，只有出口不同）。
pub type HookPayloadSink = Arc<dyn Fn(ClaudeHookPayload) + Send + Sync + 'static>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeHookRequest {
    tab_id: String,
    source: Option<String>,
    event: String,
    title: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    // 仅 SubagentStart 等子 Agent 事件携带：用于定位子 Agent 转录 jsonl。
    agent_id: Option<String>,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    mcp_server: Option<String>,
    skill_name: Option<String>,
    agent_type: Option<String>,
    agent_transcript_path: Option<String>,
    transcript_path: Option<String>,
    reasoning_effort: Option<String>,
    wsl_distro_name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookPayload {
    tab_id: String,
    source: String,
    event: String,
    title: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    agent_id: Option<String>,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    mcp_server: Option<String>,
    skill_name: Option<String>,
    agent_type: Option<String>,
    agent_transcript_path: Option<String>,
    transcript_path: Option<String>,
    reasoning_effort: Option<String>,
    wsl_distro_name: Option<String>,
}

impl ClaudeHookPayload {
    pub fn tab_id(&self) -> &str {
        &self.tab_id
    }

    pub fn event(&self) -> &str {
        &self.event
    }

    pub fn to_notification_job(&self) -> HookNotificationJob {
        HookNotificationJob {
            source: self.source.clone(),
            event: self.event.clone(),
            cwd: self.cwd.clone(),
            timestamp: self.timestamp.clone(),
        }
    }
}

/// 在给定 listener 上跑 hook HTTP 服务：解析/鉴权/校验后把 payload 交给 sink。
/// daemon 与主进程共用（Issue #123 Phase 2）。
pub fn spawn_hook_listener(listener: TcpListener, token: String, sink: HookPayloadSink) {
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let token = token.clone();
                    let sink = Arc::clone(&sink);
                    thread::spawn(move || handle_stream(stream, sink, &token));
                }
                Err(err) => warn!("cli hook bridge accept failed: {}", err),
            }
        }
    });
}

fn handle_stream(mut stream: TcpStream, sink: HookPayloadSink, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(status) => {
            write_response(&mut stream, status, "bad request");
            return;
        }
    };

    if request.method != "POST" || request.path != REQUEST_PATH {
        write_response(&mut stream, "404 Not Found", "not found");
        return;
    }

    let expected_auth = format!("Bearer {token}");
    if request
        .headers
        .get("authorization")
        .map(|value| value.as_str())
        != Some(expected_auth.as_str())
    {
        write_response(&mut stream, "401 Unauthorized", "unauthorized");
        return;
    }

    let payload = match serde_json::from_slice::<ClaudeHookRequest>(&request.body) {
        Ok(payload) => payload,
        Err(err) => {
            debug!("cli hook bridge payload parse failed: {}", err);
            write_response(&mut stream, "400 Bad Request", "invalid json");
            return;
        }
    };

    if !is_valid_payload(&payload) {
        write_response(&mut stream, "400 Bad Request", "invalid payload");
        return;
    }

    log_hook_payload_diagnostic(&payload);

    let payload = ClaudeHookPayload {
        tab_id: payload.tab_id,
        source: normalize_source(payload.source.as_deref()).to_string(),
        event: payload.event,
        title: payload.title,
        message: payload.message,
        session_id: payload.session_id,
        cwd: payload.cwd,
        timestamp: payload.timestamp,
        agent_id: payload.agent_id,
        tool_use_id: payload.tool_use_id,
        tool_name: payload.tool_name,
        mcp_server: payload.mcp_server,
        skill_name: payload.skill_name,
        agent_type: payload.agent_type,
        agent_transcript_path: payload.agent_transcript_path,
        transcript_path: payload.transcript_path,
        reasoning_effort: payload.reasoning_effort,
        wsl_distro_name: payload.wsl_distro_name,
    };

    sink(payload);

    write_response(&mut stream, "204 No Content", "");
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, &'static str> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let bytes_read = stream.read(&mut chunk).map_err(|_| "400 Bad Request")?;
        if bytes_read == 0 {
            return Err("400 Bad Request");
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
            return Err("413 Payload Too Large");
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("431 Request Header Fields Too Large");
        }
    };

    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("400 Bad Request")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().ok_or("400 Bad Request")?.to_string();
    let path = request_parts.next().ok_or("400 Bad Request")?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .ok_or("411 Length Required")?
        .parse::<usize>()
        .map_err(|_| "400 Bad Request")?;
    if content_length > MAX_BODY_BYTES {
        return Err("413 Payload Too Large");
    }

    let body_start = header_end + 4;
    while buffer.len().saturating_sub(body_start) < content_length {
        let bytes_read = stream.read(&mut chunk).map_err(|_| "400 Bad Request")?;
        if bytes_read == 0 {
            return Err("400 Bad Request");
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.len().saturating_sub(body_start) > MAX_BODY_BYTES {
            return Err("413 Payload Too Large");
        }
    }

    let body = buffer[body_start..body_start + content_length].to_vec();
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn is_valid_payload(payload: &ClaudeHookRequest) -> bool {
    let tab_id = payload.tab_id.trim();
    if tab_id.is_empty() || tab_id.len() > 128 {
        return false;
    }

    match normalize_source(payload.source.as_deref()) {
        "claude" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "Notification"
                | "Stop"
                | "StopFailure"
                | "SubagentStart"
                | "SubagentStop"
                | "AgentToolStart"
                | "AgentToolStop"
                | "ToolStart"
                | "ToolStop"
        ),
        "codex" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "PermissionRequest"
                | "Stop"
                | "SubagentStart"
                | "SubagentStop"
        ),
        _ => false,
    }
}

fn log_hook_payload_diagnostic(payload: &ClaudeHookRequest) {
    if !matches!(
        payload.event.as_str(),
        "SubagentStart"
            | "SubagentStop"
            | "AgentToolStart"
            | "AgentToolStop"
            | "ToolStart"
            | "ToolStop"
            | "Notification"
    ) {
        return;
    }

    info!(
        "cli hook payload diagnostic: source={} event={} tabId={} sessionId={:?} agentId={:?} toolUseId={:?} toolName={:?} mcpServer={:?} skillName={:?} agentType={:?} hasAgentTranscriptPath={} hasTranscriptPath={} wslDistro={:?} cwd={:?}",
        normalize_source(payload.source.as_deref()),
        payload.event,
        payload.tab_id,
        payload.session_id,
        payload.agent_id,
        payload.tool_use_id,
        payload.tool_name,
        payload.mcp_server,
        payload.skill_name,
        payload.agent_type,
        payload
            .agent_transcript_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        payload
            .transcript_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        payload.wsl_distro_name,
        payload.cwd,
    );

    // AgentTool 事件详细诊断：记录完整 payload JSON 以定位 Claude Code 实际字段。
    if matches!(payload.event.as_str(), "AgentToolStart" | "AgentToolStop") {
        if let Ok(full_json) = serde_json::to_string_pretty(payload) {
            info!(
                "[agent_tool_diagnostic] {} full payload:\n{}",
                payload.event, full_json
            );
        }
    }
}

fn normalize_source(source: Option<&str>) -> &str {
    match source {
        Some("codex") => "codex",
        Some("claude") | None => "claude",
        _ => "",
    }
}

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
