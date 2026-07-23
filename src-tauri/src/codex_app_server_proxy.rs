#[cfg(target_os = "windows")]
use crate::shell_resolver::silent_command;
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
pub(crate) const CODEX_BASE_URL_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_BASE_URL_OVERRIDE";
pub(crate) const CODEX_ENV_KEY_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_ENV_KEY_OVERRIDE";
pub(crate) const CODEX_MODEL_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_MODEL_OVERRIDE";
pub(crate) const CODEX_WIRE_API_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_WIRE_API_OVERRIDE";
pub(crate) const CODEX_REMOTE_PROVIDER_NAME: &str = "cli_manager_remote";

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
    let child_args = args
        .get(2..)
        .ok_or_else(|| "missing Codex app-server arguments".to_string());
    exit_after_proxy(child_args.and_then(run_proxy))
}

pub fn run_shim_and_exit(args: &[String]) -> ! {
    let child_args = args
        .get(1..)
        .ok_or_else(|| "missing Codex arguments".to_string());
    exit_after_proxy(child_args.and_then(|child_args| {
        if is_app_server_command(child_args) {
            run_proxy(child_args)
        } else {
            run_passthrough(child_args)
        }
    }))
}

fn exit_after_proxy(result: Result<i32, String>) -> ! {
    let exit_code = match result {
        Ok(code) => code,
        Err(err) => {
            eprintln!("CLI-Manager Codex app-server proxy: {err}");
            1
        }
    };
    std::process::exit(exit_code);
}

fn run_proxy(child_args: &[String]) -> Result<i32, String> {
    if !is_app_server_command(child_args) {
        return Err("refusing to proxy a non app-server Codex command".to_string());
    }

    let launcher = codex_launcher_from_environment()?;
    let expected_thread_id = env::var(EXPECTED_SESSION_ID_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let child_args =
        build_codex_child_args(child_args, &CodexProviderOverrides::from_environment()?)?;

    let mut command = codex_command(&launcher, &child_args);
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

fn is_app_server_command(child_args: &[String]) -> bool {
    child_args.first().map(String::as_str) == Some("app-server")
}

fn run_passthrough(child_args: &[String]) -> Result<i32, String> {
    let launcher = codex_launcher_from_environment()?;
    let child_args =
        build_codex_child_args(child_args, &CodexProviderOverrides::from_environment()?)?;
    let status = codex_command(&launcher, &child_args)
        .status()
        .map_err(|err| format!("start real Codex command failed: {err}"))?;
    Ok(status.code().unwrap_or(1))
}

fn codex_launcher_from_environment() -> Result<PathBuf, String> {
    env::var_os(CODEX_LAUNCHER_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "real Codex launcher is unavailable".to_string())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct CodexProviderOverrides {
    base_url: Option<String>,
    env_key: Option<String>,
    model: Option<String>,
    wire_api: Option<String>,
}

impl CodexProviderOverrides {
    fn from_environment() -> Result<Self, String> {
        Ok(Self {
            base_url: optional_unicode_env(CODEX_BASE_URL_OVERRIDE_ENV)?,
            env_key: optional_unicode_env(CODEX_ENV_KEY_OVERRIDE_ENV)?,
            model: optional_unicode_env(CODEX_MODEL_OVERRIDE_ENV)?,
            wire_api: optional_unicode_env(CODEX_WIRE_API_OVERRIDE_ENV)?,
        })
    }

    fn command_args(&self) -> Result<Vec<String>, String> {
        let has_any = self.base_url.is_some()
            || self.env_key.is_some()
            || self.model.is_some()
            || self.wire_api.is_some();
        if !has_any {
            return Ok(Vec::new());
        }
        let base_url = self
            .base_url
            .as_ref()
            .ok_or_else(|| "Codex Provider base URL override is missing".to_string())?;
        let env_key = self
            .env_key
            .as_ref()
            .ok_or_else(|| "Codex Provider environment key override is missing".to_string())?;
        let wire_api = self
            .wire_api
            .as_ref()
            .ok_or_else(|| "Codex Provider wire API override is missing".to_string())?;
        let mut args = vec![
            "-c".to_string(),
            format!("model_provider={CODEX_REMOTE_PROVIDER_NAME}"),
            "-c".to_string(),
            format!("model_providers.{CODEX_REMOTE_PROVIDER_NAME}.name=CLI-Manager remote"),
            "-c".to_string(),
            base_url.clone(),
            "-c".to_string(),
            env_key.clone(),
            "-c".to_string(),
            wire_api.clone(),
        ];
        if let Some(model) = self.model.as_ref() {
            args.extend(["-c".to_string(), model.clone()]);
        }
        Ok(args)
    }
}

fn optional_unicode_env(key: &str) -> Result<Option<String>, String> {
    match env::var(key) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{key} is not valid Unicode")),
    }
}

fn build_codex_child_args(
    child_args: &[String],
    overrides: &CodexProviderOverrides,
) -> Result<Vec<String>, String> {
    let mut args = overrides.command_args()?;
    args.extend_from_slice(child_args);
    Ok(args)
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
        let mut command = silent_command("cmd.exe");
        command.args(["/d", "/c"]).arg(launcher).args(args);
        command
    } else {
        let mut command = silent_command(&launcher.to_string_lossy());
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
    fn provider_overrides_are_inserted_before_app_server_without_secrets() {
        let args = build_codex_child_args(
            &[
                "app-server".to_string(),
                "--listen".to_string(),
                "stdio://".to_string(),
            ],
            &CodexProviderOverrides {
                base_url: Some(
                    "model_providers.cli_manager_remote.base_url=https://provider.example.com/v1"
                        .to_string(),
                ),
                env_key: Some(
                    "model_providers.cli_manager_remote.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY"
                        .to_string(),
                ),
                model: Some("model=gpt-5.4".to_string()),
                wire_api: Some("model_providers.cli_manager_remote.wire_api=responses".to_string()),
            },
        )
        .unwrap();

        assert_eq!(
            args,
            vec![
                "-c",
                "model_provider=cli_manager_remote",
                "-c",
                "model_providers.cli_manager_remote.name=CLI-Manager remote",
                "-c",
                "model_providers.cli_manager_remote.base_url=https://provider.example.com/v1",
                "-c",
                "model_providers.cli_manager_remote.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY",
                "-c",
                "model_providers.cli_manager_remote.wire_api=responses",
                "-c",
                "model=gpt-5.4",
                "app-server",
                "--listen",
                "stdio://",
            ]
        );
        assert!(!args.iter().any(|arg| arg.contains("sk-provider-secret")));
    }

    #[test]
    fn app_server_arguments_pass_through_without_provider_overrides() {
        let original = vec![
            "app-server".to_string(),
            "--listen".to_string(),
            "stdio://".to_string(),
        ];
        assert_eq!(
            build_codex_child_args(&original, &CodexProviderOverrides::default()).unwrap(),
            original
        );
    }

    #[test]
    fn only_the_first_argument_selects_app_server_proxying() {
        assert!(is_app_server_command(&["app-server".to_string()]));
        assert!(!is_app_server_command(&[
            "--version".to_string(),
            "app-server".to_string(),
        ]));
        assert!(!is_app_server_command(&[]));
    }

    #[test]
    fn partial_provider_overrides_are_rejected() {
        let error = CodexProviderOverrides {
            base_url: Some(
                "model_providers.cli_manager_remote.base_url=https://example.com".into(),
            ),
            ..CodexProviderOverrides::default()
        }
        .command_args()
        .unwrap_err();
        assert!(error.contains("environment key"));
    }

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
