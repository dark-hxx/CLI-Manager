use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const EVENT_NAME: &str = "claude-hook-notification";
const REQUEST_PATH: &str = "/api/claude-hook";
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

pub struct ClaudeHookBridge {
    port: u16,
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeHookRequest {
    tab_id: String,
    event: String,
    title: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookPayload {
    tab_id: String,
    event: String,
    title: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
}

impl ClaudeHookBridge {
    pub fn start(app_handle: AppHandle) -> Self {
        match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => {
                let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
                let token = Uuid::new_v4().to_string();
                let thread_token = token.clone();
                thread::spawn(move || run_listener(listener, app_handle, thread_token));
                info!("claude hook bridge listening: 127.0.0.1:{}", port);
                Self { port, token }
            }
            Err(err) => {
                error!("claude hook bridge failed to bind: {}", err);
                Self::disabled()
            }
        }
    }

    pub fn disabled() -> Self {
        Self {
            port: 0,
            token: String::new(),
        }
    }

    pub fn apply_env(&self, session_id: &str, env_vars: &mut HashMap<String, String>) {
        if self.port == 0 || self.token.is_empty() {
            return;
        }
        env_vars.insert("CLI_MANAGER_TAB_ID".to_string(), session_id.to_string());
        env_vars.insert("CLI_MANAGER_NOTIFY_PORT".to_string(), self.port.to_string());
        env_vars.insert("CLI_MANAGER_NOTIFY_TOKEN".to_string(), self.token.clone());
    }
}

fn run_listener(listener: TcpListener, app_handle: AppHandle, token: String) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app_handle = app_handle.clone();
                let token = token.clone();
                thread::spawn(move || handle_stream(stream, app_handle, &token));
            }
            Err(err) => warn!("claude hook bridge accept failed: {}", err),
        }
    }
}

fn handle_stream(mut stream: TcpStream, app_handle: AppHandle, token: &str) {
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
            debug!("claude hook bridge payload parse failed: {}", err);
            write_response(&mut stream, "400 Bad Request", "invalid json");
            return;
        }
    };

    if !is_valid_payload(&payload) {
        write_response(&mut stream, "400 Bad Request", "invalid payload");
        return;
    }

    let payload = ClaudeHookPayload {
        tab_id: payload.tab_id,
        event: payload.event,
        title: payload.title,
        message: payload.message,
        session_id: payload.session_id,
        cwd: payload.cwd,
        timestamp: payload.timestamp,
    };

    if let Err(err) = app_handle.emit(EVENT_NAME, payload) {
        warn!("claude hook bridge emit failed: {}", err);
        write_response(&mut stream, "500 Internal Server Error", "emit failed");
        return;
    }

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
    matches!(
        payload.event.as_str(),
        "Notification" | "Stop" | "StopFailure"
    )
}

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
