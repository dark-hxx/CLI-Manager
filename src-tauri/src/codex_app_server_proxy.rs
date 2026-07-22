use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

pub const HELPER_SUBCOMMAND: &str = "__codex_app_server_proxy";
pub(crate) const PROXY_EXECUTABLE_ENV: &str = "CLI_MANAGER_CODEX_APP_SERVER_PROXY";
pub(crate) const EXPECTED_SESSION_ID_ENV: &str = "CLI_MANAGER_CODEX_EXPECTED_SESSION_ID";
pub(crate) const CODEX_LAUNCHER_ENV: &str = "CLI_MANAGER_CODEX_LAUNCHER";

// A resumed Codex thread can legitimately exceed cc-connect's 10 MB scanner limit.
// Keep a finite ceiling so a broken child cannot exhaust the host process indefinitely.
const MAX_PROTOCOL_LINE_BYTES: usize = 512 * 1024 * 1024;
const STRICT_RESUME_ERROR_CODE: i64 = -32091;

#[derive(Debug, Deserialize)]
struct RpcProbe {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeResponseEnvelope {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    result: Option<ResumeResult>,
    #[serde(default)]
    error: Option<MinimalRpcError>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeResult {
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    thread: ResumeThread,
}

#[derive(Debug, Default, Deserialize)]
struct ResumeThread {
    #[serde(default)]
    id: String,
}

#[derive(Debug, Deserialize)]
struct MinimalRpcError {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone)]
struct PendingResume {
    requested_thread_id: String,
    expected_thread_id: Option<String>,
}

enum ClientLineAction {
    Forward,
    Reject(Vec<u8>),
}

pub fn is_helper_request(args: &[String]) -> bool {
    args.get(1).map(String::as_str) == Some(HELPER_SUBCOMMAND)
}

pub fn run_helper_and_exit(args: &[String]) -> ! {
    let exit_code = match run_proxy(args) {
        Ok(code) => code,
        Err(err) => {
            eprintln!("CLI-Manager Codex app-server proxy: {err}");
            1
        }
    };
    std::process::exit(exit_code);
}

fn run_proxy(args: &[String]) -> Result<i32, String> {
    let child_args = args
        .get(2..)
        .ok_or_else(|| "missing Codex app-server arguments".to_string())?;
    if !child_args.iter().any(|arg| arg == "app-server") {
        return Err("refusing to proxy a non app-server Codex command".to_string());
    }

    let launcher = env::var_os(CODEX_LAUNCHER_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "real Codex launcher is unavailable".to_string())?;
    let expected_thread_id = env::var(EXPECTED_SESSION_ID_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let mut command = codex_command(&launcher, child_args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command
        .spawn()
        .map_err(|err| format!("start real Codex app-server failed: {err}"))?;
    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "real Codex stdin pipe is unavailable".to_string())?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "real Codex stdout pipe is unavailable".to_string())?;

    let pending = Arc::new(Mutex::new(HashMap::<String, PendingResume>::new()));
    let parent_output = Arc::new(Mutex::new(io::stdout()));
    let input_pending = Arc::clone(&pending);
    let input_output = Arc::clone(&parent_output);
    std::thread::spawn(move || {
        if let Err(err) = forward_parent_input(
            child_stdin,
            expected_thread_id.as_deref(),
            &input_pending,
            &input_output,
        ) {
            eprintln!("CLI-Manager Codex app-server proxy input failed: {err}");
        }
    });

    if let Err(err) = forward_child_output(child_stdout, &pending, &parent_output) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }
    let status = child
        .wait()
        .map_err(|err| format!("wait for real Codex app-server failed: {err}"))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(target_os = "windows")]
fn codex_command(launcher: &Path, args: &[String]) -> Command {
    let is_script = launcher
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat")
        });
    if is_script {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c"]).arg(launcher).args(args);
        command
    } else {
        let mut command = Command::new(launcher);
        command.args(args);
        command
    }
}

#[cfg(not(target_os = "windows"))]
fn codex_command(launcher: &Path, args: &[String]) -> Command {
    let mut command = Command::new(launcher);
    command.args(args);
    command
}

fn forward_parent_input(
    mut child_stdin: impl Write,
    expected_thread_id: Option<&str>,
    pending: &Arc<Mutex<HashMap<String, PendingResume>>>,
    parent_output: &Arc<Mutex<io::Stdout>>,
) -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    while let Some(line) = read_protocol_line(&mut reader, MAX_PROTOCOL_LINE_BYTES)
        .map_err(|err| format!("read cc-connect request failed: {err}"))?
    {
        let action = {
            let mut pending = pending
                .lock()
                .map_err(|_| "resume request state lock poisoned".to_string())?;
            inspect_client_line(&line, expected_thread_id, &mut pending)
        };
        match action {
            ClientLineAction::Forward => {
                child_stdin
                    .write_all(&line)
                    .and_then(|_| child_stdin.flush())
                    .map_err(|err| format!("write real Codex request failed: {err}"))?;
            }
            ClientLineAction::Reject(response) => {
                write_parent_line(parent_output, &response)?;
            }
        }
    }
    Ok(())
}

fn forward_child_output(
    child_stdout: impl io::Read,
    pending: &Arc<Mutex<HashMap<String, PendingResume>>>,
    parent_output: &Arc<Mutex<io::Stdout>>,
) -> Result<(), String> {
    let mut reader = BufReader::new(child_stdout);
    while let Some(line) = read_protocol_line(&mut reader, MAX_PROTOCOL_LINE_BYTES)
        .map_err(|err| format!("read real Codex response failed: {err}"))?
    {
        let transformed = {
            let mut pending = pending
                .lock()
                .map_err(|_| "resume response state lock poisoned".to_string())?;
            transform_server_line(&line, &mut pending)
        };
        write_parent_line(parent_output, transformed.as_deref().unwrap_or(&line))?;
    }
    Ok(())
}

fn inspect_client_line(
    line: &[u8],
    expected_thread_id: Option<&str>,
    pending: &mut HashMap<String, PendingResume>,
) -> ClientLineAction {
    let Ok(message) = serde_json::from_slice::<Value>(trim_line_ending(line)) else {
        return ClientLineAction::Forward;
    };
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return ClientLineAction::Forward;
    };
    let Some(id) = message.get("id") else {
        return ClientLineAction::Forward;
    };

    if method == "thread/start" {
        if let Some(expected) = expected_thread_id {
            return ClientLineAction::Reject(rpc_error_response(
                id,
                format!(
                    "CLI-Manager blocked a fresh thread because remote handoff requires session {expected}"
                ),
            ));
        }
        return ClientLineAction::Forward;
    }
    if method != "thread/resume" {
        return ClientLineAction::Forward;
    }

    let requested_thread_id = message
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if let Some(expected) = expected_thread_id {
        if requested_thread_id != expected {
            return ClientLineAction::Reject(rpc_error_response(
                id,
                format!(
                    "CLI-Manager detected Codex session drift: expected {expected}, received {}",
                    if requested_thread_id.is_empty() {
                        "an empty session ID"
                    } else {
                        &requested_thread_id
                    }
                ),
            ));
        }
    }
    if let Some(key) = rpc_id_key(id) {
        pending.insert(
            key,
            PendingResume {
                requested_thread_id,
                expected_thread_id: expected_thread_id.map(str::to_string),
            },
        );
    }
    ClientLineAction::Forward
}

fn transform_server_line(
    line: &[u8],
    pending: &mut HashMap<String, PendingResume>,
) -> Option<Vec<u8>> {
    let payload = trim_line_ending(line);
    let probe = serde_json::from_slice::<RpcProbe>(payload).ok()?;
    if probe.method.is_some() {
        return None;
    }
    let id = probe.id.as_ref()?;
    let resume = pending.remove(&rpc_id_key(id)?)?;
    Some(compact_resume_response(payload, id, &resume))
}

fn compact_resume_response(payload: &[u8], fallback_id: &Value, resume: &PendingResume) -> Vec<u8> {
    let envelope = match serde_json::from_slice::<ResumeResponseEnvelope>(payload) {
        Ok(envelope) => envelope,
        Err(err) => {
            return rpc_error_response(
                fallback_id,
                format!("CLI-Manager could not decode the Codex resume response: {err}"),
            )
        }
    };
    let response_id = envelope.id.as_ref().unwrap_or(fallback_id);
    if let Some(error) = envelope.error {
        return json_line(&json!({
            "jsonrpc": "2.0",
            "id": response_id,
            "error": {
                "code": error.code,
                "message": error.message,
            }
        }));
    }
    let Some(result) = envelope.result else {
        return rpc_error_response(
            response_id,
            "CLI-Manager received an empty Codex resume response".to_string(),
        );
    };
    if result.thread.id.trim().is_empty() {
        return rpc_error_response(
            response_id,
            "CLI-Manager received an empty Codex thread ID while resuming".to_string(),
        );
    }
    if let Some(expected) = resume.expected_thread_id.as_deref() {
        if result.thread.id != expected {
            return rpc_error_response(
                response_id,
                format!(
                    "CLI-Manager detected Codex session drift after resume: expected {expected}, received {}",
                    result.thread.id
                ),
            );
        }
    }

    let compact = json_line(&json!({
        "jsonrpc": "2.0",
        "id": response_id,
        "result": {
            "cwd": result.cwd,
            "model": result.model,
            "reasoningEffort": result.reasoning_effort,
            "thread": { "id": result.thread.id },
        }
    }));
    if payload.len() > 10 * 1024 * 1024 {
        eprintln!(
            "CLI-Manager compacted Codex thread/resume response from {} to {} bytes for session {}",
            payload.len(),
            compact.len(),
            resume.requested_thread_id
        );
    }
    compact
}

fn rpc_id_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(_) | Value::String(_) => serde_json::to_string(id).ok(),
        _ => None,
    }
}

fn rpc_error_response(id: &Value, message: String) -> Vec<u8> {
    json_line(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": STRICT_RESUME_ERROR_CODE,
            "message": message,
        }
    }))
}

fn json_line(value: &Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(value).unwrap_or_else(|_| {
        b"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"CLI-Manager proxy serialization failed\"}}".to_vec()
    });
    line.push(b'\n');
    line
}

fn trim_line_ending(mut line: &[u8]) -> &[u8] {
    while line
        .last()
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
    {
        line = &line[..line.len() - 1];
    }
    line
}

fn read_protocol_line(reader: &mut impl BufRead, max_bytes: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(consumed) > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("app-server protocol line exceeds {max_bytes} bytes"),
            ));
        }
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if line.last() == Some(&b'\n') {
            return Ok(Some(line));
        }
    }
}

fn write_parent_line(output: &Arc<Mutex<io::Stdout>>, line: &[u8]) -> Result<(), String> {
    let mut output = output
        .lock()
        .map_err(|_| "parent output lock poisoned".to_string())?;
    output
        .write_all(line)
        .and_then(|_| output.flush())
        .map_err(|err| format!("write cc-connect response failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_a_resume_response_larger_than_cc_connects_limit() {
        let huge_history = "x".repeat(11 * 1024 * 1024);
        let source = json_line(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "cwd": "F:\\repo",
                "model": "gpt-5.4",
                "reasoningEffort": "high",
                "thread": {
                    "id": "thread-original",
                    "turns": [{"items": [{"type": "message", "text": huge_history}]}]
                }
            }
        }));
        assert!(source.len() > 10 * 1024 * 1024);
        let mut pending = HashMap::from([(
            "2".to_string(),
            PendingResume {
                requested_thread_id: "thread-original".to_string(),
                expected_thread_id: Some("thread-original".to_string()),
            },
        )]);

        let compact = transform_server_line(&source, &mut pending).unwrap();
        assert!(compact.len() < 1024);
        let value: Value = serde_json::from_slice(trim_line_ending(&compact)).unwrap();
        assert_eq!(value["result"]["thread"]["id"], "thread-original");
        assert_eq!(value["result"]["cwd"], r"F:\repo");
        assert_eq!(value["result"]["model"], "gpt-5.4");
        assert_eq!(value["result"]["reasoningEffort"], "high");
        assert!(value["result"]["thread"].get("turns").is_none());
        assert!(pending.is_empty());
    }

    #[test]
    fn strict_handoff_rejects_session_drift_and_fresh_thread_fallback() {
        let mut pending = HashMap::new();
        let drifted = br#"{"jsonrpc":"2.0","id":3,"method":"thread/resume","params":{"threadId":"thread-new"}}
"#;
        let ClientLineAction::Reject(response) =
            inspect_client_line(drifted, Some("thread-original"), &mut pending)
        else {
            panic!("drifted resume must be rejected");
        };
        let response: Value = serde_json::from_slice(trim_line_ending(&response)).unwrap();
        assert_eq!(response["id"], 3);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("session drift"));
        assert!(pending.is_empty());

        let fresh = br#"{"jsonrpc":"2.0","id":4,"method":"thread/start","params":{}}
"#;
        assert!(matches!(
            inspect_client_line(fresh, Some("thread-original"), &mut pending),
            ClientLineAction::Reject(_)
        ));
    }

    #[test]
    fn matching_resume_is_forwarded_and_tracked() {
        let mut pending = HashMap::new();
        let request = br#"{"jsonrpc":"2.0","id":7,"method":"thread/resume","params":{"threadId":"thread-original"}}
"#;
        assert!(matches!(
            inspect_client_line(request, Some("thread-original"), &mut pending),
            ClientLineAction::Forward
        ));
        assert_eq!(
            pending
                .get("7")
                .map(|item| item.requested_thread_id.as_str()),
            Some("thread-original")
        );
    }
}
