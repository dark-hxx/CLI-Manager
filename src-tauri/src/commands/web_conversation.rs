//! Web turns own their child process in Rust; terminal hooks and window focus are irrelevant.
use super::web_device::{self, ValidateContextRequest};
use crate::codex_app_server_proxy::{CODEX_LAUNCHER_ARGS_ENV, CODEX_LAUNCHER_ENV};
use cli_manager_web_protocol::{ConversationEvent, OperationError, OperationStatus};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const MAX_LINE: u64 = 8 * 1024 * 1024;
const MAX_STDERR_CAPTURE: u64 = 32 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(60);
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub operation_id: String,
    pub source: String,
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub cwd: String,
    pub root_path: String,
    pub session_id: Option<String>,
    pub launcher: String,
    #[serde(default)]
    pub launcher_args: Vec<String>,
    #[serde(default)]
    pub environment: HashMap<String, String>,
    pub model: Option<String>,
    pub locale: Option<String>,
    pub wsl_distro: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    pub operation_id: String,
    pub file_path: String,
    pub project_key: String,
    pub cwd: String,
    pub root_path: String,
    pub claude_config_dir: Option<String>,
    pub codex_config_dir: Option<String>,
}

#[tauri::command]
pub async fn web_conversation_history(
    app: AppHandle,
    request: HistoryRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || history_start(app, request))
        .await
        .map_err(|_| "conversation_history_worker_failed".to_string())?
}

fn history_start(app: AppHandle, request: HistoryRequest) -> Result<(), String> {
    if registry()
        .lock()
        .map_err(|_| "runtime lock poisoned")?
        .operations
        .contains(&request.operation_id)
    {
        return Ok(());
    }
    let operation = web_device::conversation_operation(&app, &request.operation_id)?;
    if operation.kind != "conversation.history" {
        return Err("invalid_conversation_operation".into());
    }
    let field = |key: &str| {
        operation.payload[key]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("invalid_history_context:{key}"))
    };
    let context = StartRequest {
        operation_id: request.operation_id.clone(),
        source: field("source")?,
        project_id: field("projectId")?,
        worktree_id: operation.payload["worktreeId"].as_str().map(String::from),
        cwd: request.cwd.clone(),
        root_path: request.root_path.clone(),
        session_id: Some(field("sessionId")?),
        launcher: String::new(),
        launcher_args: Vec::new(),
        environment: HashMap::new(),
        model: None,
        locale: None,
        wsl_distro: None,
    };
    if !matches!(context.source.as_str(), "codex" | "claude") {
        return Err("unsupported_cli_source".into());
    }
    {
        let mut state = registry().lock().map_err(|_| "runtime lock poisoned")?;
        if state.operations.contains(&request.operation_id) {
            return Ok(());
        }
        if state.operations.len() >= 4096 {
            return Err("conversation_runtime_capacity".into());
        }
        state.operations.insert(request.operation_id.clone());
        state.active.insert(request.operation_id.clone());
    }
    std::thread::spawn(move || {
        let mut events = Events {
            app: &app,
            request: &context,
            session_id: context.session_id.clone().unwrap_or_default(),
            sequence: 0,
            pending_delta: None,
            last_flush: Instant::now(),
            streamed_messages: HashSet::new(),
            session_established: true,
        };
        let result =
            tauri::async_runtime::block_on(history_publish(&request, &context, &mut events));
        let (status, result, error) = match result {
            Ok(count) => (
                OperationStatus::Succeeded,
                Some(json!({"sessionId":events.session_id,"messages":count})),
                None,
            ),
            Err(error) => {
                let _ = events.emit("turn_failed", None, Some(error.clone()));
                (
                    OperationStatus::Failed,
                    None,
                    Some(OperationError {
                        code: "conversation_history_failed".into(),
                        message: error,
                    }),
                )
            }
        };
        if let Err(error) = retry_delivery(|| {
            web_device::complete_conversation_operation(
                &app,
                &request.operation_id,
                status.clone(),
                result.clone(),
                error.clone(),
            )
        }) {
            log::error!("Web history completion delivery failed: {error}");
        }
        if let Ok(mut state) = registry().lock() {
            state.active.remove(&request.operation_id);
        }
    });
    Ok(())
}

async fn history_publish(
    request: &HistoryRequest,
    context: &StartRequest,
    events: &mut Events<'_>,
) -> Result<usize, String> {
    web_device::web_device_operation_accepted_blocking(
        events.app.clone(),
        events.app.state::<web_device::WebDeviceManager>().inner().clone(),
        web_device::OperationIdRequest {
            operation_id: request.operation_id.clone(),
        },
    )?;
    web_device::web_device_operation_running_blocking(
        events.app.clone(),
        events.app.state::<web_device::WebDeviceManager>().inner().clone(),
        web_device::OperationIdRequest {
            operation_id: request.operation_id.clone(),
        },
    )?;
    web_device::web_device_validate_context(ValidateContextRequest {
        root_path: request.root_path.clone(),
        cwd: request.cwd.clone(),
    })
    .await?;
    let detail = super::history::history_get_session(
        events.app.clone(),
        request.file_path.clone(),
        request.claude_config_dir.clone(),
        request.codex_config_dir.clone(),
        None,
        None,
        context.source.clone(),
        request.project_key.clone(),
        Some(false),
        Some(true),
    )
    .await?;
    if detail.source != context.source
        || Some(detail.session_id.as_str()) != context.session_id.as_deref()
    {
        return Err("history_session_mismatch".into());
    }
    let actual_cwd = detail.cwd.ok_or("history_cwd_missing")?;
    // Two containment checks require the recorded cwd to be exactly this authorized project/worktree.
    web_device::web_device_validate_context(ValidateContextRequest {
        root_path: request.cwd.clone(),
        cwd: actual_cwd.clone(),
    })
    .await?;
    web_device::web_device_validate_context(ValidateContextRequest {
        root_path: actual_cwd,
        cwd: request.cwd.clone(),
    })
    .await?;
    events.emit("session_started", None, None)?;
    let mut count = 0;
    for (index, message) in detail.messages.iter().enumerate() {
        if let Some(text) = history_visible_text(message) {
            events.emit(
                if message.role == "user" {
                    "user_message"
                } else {
                    "assistant_done"
                },
                Some(format!("history:{index}")),
                Some(text),
            )?;
            count += 1;
        }
    }
    events.emit("turn_completed", None, None)?;
    Ok(count)
}

fn history_visible_text(message: &super::history::HistoryMessage) -> Option<String> {
    if !matches!(message.role.as_str(), "user" | "assistant") {
        return None;
    }
    let text = message
        .parts
        .iter()
        .filter(|part| part.kind == "text" && part.tool_name.is_none() && part.call_id.is_none())
        .map(|part| part.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    // No flattened content fallback: it can contain tool arguments or internal instructions.
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

#[derive(Default)]
struct Registry {
    operations: HashSet<String>,
    active: HashSet<String>,
    sessions: HashSet<String>,
    provider_snapshots: HashSet<String>,
}
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}

pub(crate) fn active_provider_snapshot_ids() -> Vec<String> {
    registry()
        .lock()
        .map(|state| state.provider_snapshots.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn web_conversation_is_running(operation_id: String) -> bool {
    registry()
        .lock()
        .is_ok_and(|state| state.active.contains(&operation_id))
}

#[tauri::command]
pub async fn web_conversation_start(app: AppHandle, request: StartRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(start_inner(app, request))
    })
    .await
    .map_err(|_| "conversation_start_worker_failed".to_string())?
}

async fn start_inner(app: AppHandle, mut request: StartRequest) -> Result<(), String> {
    if registry()
        .lock()
        .map_err(|_| "runtime lock poisoned")?
        .operations
        .contains(&request.operation_id)
    {
        return Ok(());
    }
    let operation = web_device::conversation_operation(&app, &request.operation_id)?;
    if !matches!(
        operation.kind.as_str(),
        "conversation.start" | "conversation.prompt"
    ) {
        return Err("invalid_conversation_operation".into());
    }
    let prompt = operation
        .payload
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or("invalid_prompt")?
        .to_string();
    validate_request(&request, &prompt)?;
    if request.source == "codex" {
        request.launcher_args = codex_launcher_args(&request.launcher_args)?;
    }
    for (key, expected) in [
        ("source", Some(request.source.as_str())),
        ("projectId", Some(request.project_id.as_str())),
        ("worktreeId", request.worktree_id.as_deref()),
        ("sessionId", request.session_id.as_deref()),
    ] {
        if operation.payload.get(key).and_then(Value::as_str) != expected {
            return Err(format!("conversation_context_mismatch:{key}"));
        }
    }
    web_device::web_device_validate_context(ValidateContextRequest {
        root_path: request.root_path.clone(),
        cwd: request.cwd.clone(),
    })
    .await?;
    let snapshot = crate::provider::scope::prepare(crate::provider::scope::ScopePrepareInput {
        app_type: request.source.clone(),
        project_id: Some(request.project_id.clone()),
        worktree_id: request.worktree_id.clone(),
        provider_id: None,
    })
    .await?;
    let snapshot_guard = SnapshotGuard(
        snapshot
            .as_ref()
            .map(|snapshot| snapshot.snapshot_id.clone()),
    );
    if let Some(id) = &snapshot_guard.0 {
        registry()
            .lock()
            .map_err(|_| "runtime lock poisoned")?
            .provider_snapshots
            .insert(id.clone());
    }
    if let Some(snapshot) = snapshot {
        request.environment = crate::provider::scope::apply_launch_environment(
            crate::provider::scope::ProviderLaunchConfig {
                app_type: snapshot.app_type,
                provider_id: snapshot.provider_id,
                snapshot_id: snapshot.snapshot_id,
                claude_settings_path: snapshot.claude_settings_path.clone(),
                generated_home: snapshot.generated_home,
                grok_model: snapshot.grok_model,
            },
            None,
            request.environment,
        )
        .await?;
        if let Some(profile) = snapshot.codex_profile_name {
            for value in crate::codex_app_server_proxy::load_codex_profile_overrides(&profile)? {
                request.launcher_args.extend(["-c".into(), value]);
            }
        }
        for value in snapshot.config_overrides {
            request.launcher_args.extend(["-c".into(), value]);
        }
        if let Some(path) = snapshot.claude_settings_path {
            request.launcher_args.extend(["--settings".into(), path]);
        }
    }
    let session_key = format!(
        "{}:{}",
        request.source,
        request
            .session_id
            .as_deref()
            .unwrap_or(&request.operation_id)
    );
    {
        let mut state = registry().lock().map_err(|_| "runtime lock poisoned")?;
        if state.operations.contains(&request.operation_id) {
            return Ok(());
        }
        if state.sessions.contains(&session_key) {
            return Err("conversation_busy".into());
        }
        if state.operations.len() >= 4096 {
            return Err("conversation_runtime_capacity".into());
        }
        state.operations.insert(request.operation_id.clone());
        state.active.insert(request.operation_id.clone());
        state.sessions.insert(session_key.clone());
    }
    std::thread::spawn(move || {
        let _snapshot = snapshot_guard;
        let mut events = Events {
            app: &app,
            request: &request,
            session_id: request
                .session_id
                .clone()
                .unwrap_or_else(|| request.operation_id.clone()),
            sequence: 0,
            pending_delta: None,
            last_flush: Instant::now(),
            streamed_messages: HashSet::new(),
            session_established: request.session_id.is_some(),
        };
        let outcome = execute(&request, &prompt, &mut events)
            .and_then(|()| events.emit("turn_completed", None, None));
        let (status, result, error) = match outcome {
            Ok(()) => (
                OperationStatus::Succeeded,
                Some(json!({"sessionId":events.session_id})),
                None,
            ),
            Err(error) => {
                log::warn!(
                    "Web conversation {} failed: {}",
                    request.operation_id,
                    error
                );
                if events.session_established {
                    let _ = events.emit("turn_failed", None, Some(error.clone()));
                }
                (
                    OperationStatus::Failed,
                    None,
                    Some(OperationError {
                        code: error
                            .split(':')
                            .next()
                            .unwrap_or("conversation_failed")
                            .into(),
                        message: error,
                    }),
                )
            }
        };
        if let Err(error) = retry_delivery(|| {
            web_device::complete_conversation_operation(
                &app,
                &request.operation_id,
                status.clone(),
                result.clone(),
                error.clone(),
            )
        }) {
            log::error!("Web conversation completion delivery failed: {error}");
        }
        if let Ok(mut state) = registry().lock() {
            state.active.remove(&request.operation_id);
            state.sessions.remove(&session_key);
            state
                .sessions
                .remove(&format!("{}:{}", request.source, events.session_id));
        }
    });
    Ok(())
}

struct SnapshotGuard(Option<String>);
impl Drop for SnapshotGuard {
    fn drop(&mut self) {
        if let Some(id) = self.0.take() {
            if let Ok(mut state) = registry().lock() {
                state.provider_snapshots.remove(&id);
            }
            tauri::async_runtime::spawn(async move {
                if let Err(error) = crate::provider::scope::release_snapshot(id).await {
                    log::warn!("Web provider snapshot release failed: {error}");
                }
            });
        }
    }
}

fn validate_request(request: &StartRequest, prompt: &str) -> Result<(), String> {
    if !matches!(request.source.as_str(), "codex" | "claude") {
        return Err("unsupported_cli_source".into());
    }
    if prompt.trim().is_empty() || prompt.len() > 128 * 1024 || prompt.contains('\0') {
        return Err("invalid_prompt".into());
    }
    if request.launcher.trim().is_empty()
        || request.launcher.contains(['\0', '\r', '\n'])
        || request.launcher_args.iter().any(|arg| arg.contains('\0'))
    {
        return Err("invalid_cli_launcher".into());
    }
    if request.session_id.as_ref().is_some_and(|id| {
        id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
    }) {
        return Err("invalid_session_id".into());
    }
    Ok(())
}

fn codex_launcher_args(args: &[String]) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        index += 1;
        match arg.as_str() {
            "-p" | "--profile" => {
                let profile = args.get(index).ok_or("invalid_codex_profile_argument")?;
                index += 1;
                for value in crate::codex_app_server_proxy::load_codex_profile_overrides(profile)? {
                    result.extend(["-c".into(), value]);
                }
            }
            "resume" => {
                // The Web runtime resumes through thread/resume. Passing the project's terminal
                // `resume <session>` arguments before `app-server` starts the TUI instead, which
                // exits immediately because the structured child has no terminal.
                if args.get(index).is_some_and(|value| {
                    value == "--last" || value == "--all" || !value.starts_with('-')
                }) {
                    index += 1;
                }
            }
            "--no-alt-screen" => {}
            "--yolo"
            | "--dangerously-bypass-approvals-and-sandbox"
            | "--full-auto"
            | "--dangerously-skip-permissions" => {
                return Err("unsupported_web_approval_override".into())
            }
            _ => result.push(arg.clone()),
        }
    }
    Ok(result)
}

struct Events<'a> {
    app: &'a AppHandle,
    request: &'a StartRequest,
    session_id: String,
    sequence: u64,
    pending_delta: Option<(Option<String>, String)>,
    last_flush: Instant,
    streamed_messages: HashSet<Option<String>>,
    session_established: bool,
}
impl Events<'_> {
    fn bind_session(&mut self, session_id: &str) -> Result<(), String> {
        if self.request.session_id.is_none() {
            let key = format!("{}:{session_id}", self.request.source);
            let mut state = registry().lock().map_err(|_| "runtime lock poisoned")?;
            if !state.sessions.insert(key) {
                return Err("conversation_busy".into());
            }
        }
        self.session_id = session_id.into();
        self.session_established = true;
        Ok(())
    }
    fn emit(
        &mut self,
        kind: &str,
        message_id: Option<String>,
        text: Option<String>,
    ) -> Result<(), String> {
        if kind == "assistant_delta" {
            if self
                .pending_delta
                .as_ref()
                .is_some_and(|(id, _)| id != &message_id)
            {
                self.flush()?;
            }
            let pending = self
                .pending_delta
                .get_or_insert_with(|| (message_id, String::new()));
            pending.1.push_str(text.as_deref().unwrap_or(""));
            if pending.1.len() >= 16 * 1024
                || self.last_flush.elapsed() >= Duration::from_millis(100)
            {
                self.flush()?;
            }
            return Ok(());
        }
        self.flush()?;
        self.publish(kind, message_id, text)
    }
    fn flush(&mut self) -> Result<(), String> {
        if let Some((id, text)) = self.pending_delta.take() {
            self.publish("assistant_delta", id, Some(text))?;
        }
        self.last_flush = Instant::now();
        Ok(())
    }
    fn publish(
        &mut self,
        kind: &str,
        message_id: Option<String>,
        text: Option<String>,
    ) -> Result<(), String> {
        if kind == "assistant_done" && text.as_ref().is_some_and(|text| text.len() > 128 * 1024) {
            if !self.streamed_messages.contains(&message_id) {
                for chunk in text_chunks(text.as_deref().unwrap_or_default(), 32 * 1024) {
                    self.publish("assistant_delta", message_id.clone(), Some(chunk.into()))?;
                }
            }
            return self.publish("assistant_done", message_id, None);
        }
        if kind == "assistant_delta" {
            self.streamed_messages.insert(message_id.clone());
            if text.as_ref().is_some_and(|text| text.len() > 32 * 1024) {
                for chunk in text_chunks(text.as_deref().unwrap_or_default(), 32 * 1024) {
                    self.publish("assistant_delta", message_id.clone(), Some(chunk.into()))?;
                }
                return Ok(());
            }
        }
        if text.as_ref().is_some_and(|text| text.len() > 128 * 1024) {
            return Err("cli_message_too_large".into());
        }
        self.sequence += 1;
        let event = ConversationEvent {
            operation_id: self.request.operation_id.clone(),
            session_id: self.session_id.clone(),
            source: self.request.source.clone(),
            project_id: self.request.project_id.clone(),
            worktree_id: self.request.worktree_id.clone(),
            sequence: self.sequence,
            kind: kind.into(),
            message_id,
            text,
            occurred_at: chrono::Utc::now().timestamp_millis(),
        };
        retry_delivery(|| web_device::publish_conversation_event(self.app, event.clone()))
    }
}

fn text_chunks(text: &str, max_bytes: usize) -> Vec<&str> {
    let mut result = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let mut end = rest.len().min(max_bytes);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        result.push(&rest[..end]);
        rest = &rest[end..];
    }
    result
}

fn retry_delivery(mut publish: impl FnMut() -> Result<(), String>) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match publish() {
            Ok(()) => return Ok(()),
            Err(error)
                if !["invalid", "mismatch", "too_large", "must be", "poisoned"]
                    .iter()
                    .any(|part| error.contains(part))
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(100))
            }
            Err(error) => return Err(error),
        }
    }
}

struct Process {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Result<Value, String>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    #[cfg(target_os = "windows")]
    _job: crate::process_job::ChildJob,
}
impl Drop for Process {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Process {
    fn send(&mut self, value: Value) -> Result<(), String> {
        let input = self.input.as_mut().ok_or("cli_input_closed")?;
        serde_json::to_writer(&mut *input, &value).map_err(|_| "cli_input_write_failed")?;
        input
            .write_all(b"\n")
            .and_then(|_| input.flush())
            .map_err(|_| "cli_input_write_failed".into())
    }
    fn next(&self, deadline: Instant, stage: &str) -> Result<Value, String> {
        self.output
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => format!("cli_timeout:{stage}"),
                _ => {
                    let detail = self
                        .stderr
                        .lock()
                        .map(|stderr| classify_cli_stderr(&stderr))
                        .unwrap_or("diagnostic_unavailable");
                    format!("cli_exited:{stage}:{detail}")
                }
            })?
    }
}

fn classify_cli_stderr(stderr: &[u8]) -> &'static str {
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if stderr.contains("term is set to")
        || stderr.contains("not a tty")
        || stderr.contains("interactive tui")
    {
        "interactive_arguments"
    } else if stderr.contains("unexpected argument")
        || stderr.contains("unrecognized option")
        || stderr.contains("usage:")
    {
        "invalid_arguments"
    } else if stderr.contains("not logged in")
        || stderr.contains("login required")
        || stderr.contains("authentication")
    {
        "authentication_failed"
    } else if stderr.contains("config") && (stderr.contains("parse") || stderr.contains("invalid"))
    {
        "invalid_configuration"
    } else if stderr.trim().is_empty() {
        "no_diagnostic"
    } else {
        // Never forward raw CLI stderr: it may contain prompts, paths, URLs, or credentials.
        "launcher_error"
    }
}

fn launch(request: &StartRequest) -> Result<Process, String> {
    let wsl = wsl_context(request)?;
    let local_launcher = if wsl.is_none() {
        Some(resolve_local_launcher(request)?)
    } else {
        None
    };
    let mut command = if let Some((distro, cwd)) = &wsl {
        if request.launcher.contains(['\\', ':']) {
            return Err("unsupported_wsl_launcher".into());
        }
        let executable = crate::wsl::find_wsl_exe().ok_or("wsl_unavailable")?;
        let mut command = crate::shell_resolver::silent_command(&executable.to_string_lossy());
        command.args([
            "--distribution",
            distro,
            "--cd",
            cwd,
            "--exec",
            &request.launcher,
        ]);
        let args = wsl_launcher_args(&request.launcher_args)?;
        command.args(args);
        if request.source == "codex" {
            command.arg("app-server");
        } else {
            command.args([
                "--print",
                "--verbose",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
            ]);
            if let Some(id) = &request.session_id {
                command.args(["--resume", id]);
            }
            if let Some(model) = &request.model {
                command.args(["--model", model]);
            }
        }
        let mut forwarded = std::env::var("WSLENV").unwrap_or_default();
        for key in request.environment.keys() {
            if !key
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
            {
                return Err("invalid_wsl_environment_key".into());
            }
            if matches!(key.as_str(), "CODEX_HOME" | "CLAUDE_CONFIG_DIR")
                && request.environment[key].contains(':')
            {
                return Err("unsupported_wsl_environment_path".into());
            }
            if !forwarded.is_empty() {
                forwarded.push(':');
            }
            forwarded.push_str(key);
        }
        command.envs(&request.environment).env("WSLENV", forwarded);
        command
    } else if request.source == "codex" {
        let executable = std::env::current_exe().map_err(|_| "cli_executable_unavailable")?;
        let mut command = crate::shell_resolver::silent_command(&executable.to_string_lossy());
        command.args([
            crate::codex_app_server_proxy::HELPER_SUBCOMMAND,
            "app-server",
        ]);
        command
            .envs(&request.environment)
            .env(
                CODEX_LAUNCHER_ENV,
                local_launcher
                    .as_deref()
                    .ok_or("cli_launcher_unavailable")?,
            )
            .env(
                CODEX_LAUNCHER_ARGS_ENV,
                serde_json::to_string(&request.launcher_args)
                    .map_err(|_| "invalid_cli_launcher")?,
            );
        command
    } else {
        let mut args = request.launcher_args.clone();
        args.extend(
            [
                "--print",
                "--verbose",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
            ]
            .map(String::from),
        );
        if let Some(id) = &request.session_id {
            args.extend(["--resume".into(), id.clone()]);
        }
        if let Some(model) = &request.model {
            args.extend(["--model".into(), model.clone()]);
        }
        let mut command = script_command(
            local_launcher
                .as_deref()
                .ok_or("cli_launcher_unavailable")?,
            &args,
        )?;
        command.envs(&request.environment);
        command
    };
    if wsl.is_none() {
        command.current_dir(&request.cwd);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("cli_spawn_failed:{error}"))?;
    #[cfg(target_os = "windows")]
    let job = match crate::process_job::ChildJob::assign(&child, "web conversation") {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let input = child.stdin.take();
    let output = child.stdout.take().ok_or("cli_stdout_unavailable")?;
    let stderr_capture = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let captured = stderr_capture.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stderr
                .by_ref()
                .take(MAX_STDERR_CAPTURE)
                .read_to_end(&mut bytes);
            if let Ok(mut destination) = captured.lock() {
                *destination = bytes;
            }
        });
    }
    let (sender, receiver) = mpsc::sync_channel(64);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let value = match read_protocol_line(&mut reader, MAX_LINE) {
                Ok(Some(value)) => Ok(value),
                Ok(None) => break,
                Err(error) => Err(error),
            };
            let failed = value.is_err();
            if sender.send(value).is_err() || failed {
                break;
            }
        }
    });
    Ok(Process {
        child,
        input,
        output: receiver,
        stderr: stderr_capture,
        #[cfg(target_os = "windows")]
        _job: job,
    })
}

fn wsl_launcher_args(args: &[String]) -> Result<Vec<String>, String> {
    let mut args = args.to_vec();
    for index in 1..args.len() {
        if args[index - 1] == "--settings" {
            args[index] = crate::wsl::windows_path_to_wsl(&args[index])
                .ok_or("unsupported_wsl_settings_path")?;
        }
        if matches!(args[index - 1].as_str(), "-c" | "--config") {
            let value = args[index]
                .split_once('=')
                .map(|(_, value)| value.trim().trim_matches(['\'', '"']))
                .unwrap_or("");
            if value.as_bytes().get(1) == Some(&b':') || value.starts_with("\\\\") {
                return Err("unsupported_wsl_config_path".into());
            }
        }
    }
    Ok(args)
}

fn read_protocol_line(reader: &mut impl BufRead, max_bytes: u64) -> Result<Option<Value>, String> {
    let mut line = Vec::new();
    match reader.take(max_bytes + 1).read_until(b'\n', &mut line) {
        Ok(0) => Ok(None),
        Ok(_) if line.len() as u64 > max_bytes => Err("cli_protocol_line_too_large".into()),
        Ok(_) => serde_json::from_slice(&line)
            .map(Some)
            .map_err(|_| "cli_protocol_invalid_json".into()),
        Err(_) => Err("cli_protocol_read_failed".into()),
    }
}

fn wsl_context(request: &StartRequest) -> Result<Option<(String, String)>, String> {
    if let Some((distro, path)) = crate::wsl::parse_wsl_unc_path(&request.cwd) {
        if request
            .wsl_distro
            .as_deref()
            .is_some_and(|expected| expected != distro)
        {
            return Err("wsl_distribution_mismatch".into());
        }
        return Ok(Some((distro, path)));
    }
    if let Some(distro) = &request.wsl_distro {
        if distro.is_empty() || distro.contains(['\0', '\r', '\n']) {
            return Err("invalid_wsl_distribution".into());
        }
        let path = if request.cwd.starts_with('/') {
            request.cwd.clone()
        } else {
            crate::wsl::windows_path_to_wsl(&request.cwd).ok_or("unsupported_wsl_cwd")?
        };
        return Ok(Some((distro.clone(), path)));
    }
    Ok(None)
}

fn resolve_local_launcher(request: &StartRequest) -> Result<String, String> {
    let path = super::cc_connect::resolve_local_agent_program(
        &request.launcher,
        std::path::Path::new(&request.cwd),
    )
    .map_err(|_| "cli_launcher_unavailable".to_string())?;
    #[cfg(target_os = "windows")]
    let path = crate::codex_app_server_proxy::windows_shell_path(&path);
    Ok(path.to_string_lossy().into_owned())
}

fn script_command(launcher: &str, args: &[String]) -> Result<Command, String> {
    #[cfg(target_os = "windows")]
    {
        let extension = std::path::Path::new(launcher)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "cmd" | "bat" | "ps1") {
            if std::iter::once(launcher)
                .chain(args.iter().map(String::as_str))
                .any(|arg| arg.contains(['&', '|', '<', '>', '^', '%', '!', '\r', '\n']))
            {
                return Err("invalid_cli_script_arguments".into());
            }
            let mut command = crate::shell_resolver::silent_command(if extension == "ps1" {
                "powershell.exe"
            } else {
                "cmd.exe"
            });
            if extension == "ps1" {
                command.args(["-NoProfile", "-File"]);
            } else {
                command.args(["/d", "/s", "/c", "call"]);
            }
            command.arg(launcher).args(args);
            return Ok(command);
        }
    }
    let mut command = crate::shell_resolver::silent_command(launcher);
    command.args(args);
    Ok(command)
}

fn execute(request: &StartRequest, prompt: &str, events: &mut Events<'_>) -> Result<(), String> {
    web_device::web_device_operation_accepted_blocking(
        events.app.clone(),
        events.app.state::<web_device::WebDeviceManager>().inner().clone(),
        web_device::OperationIdRequest {
            operation_id: request.operation_id.clone(),
        },
    )?;
    web_device::web_device_operation_running_blocking(
        events.app.clone(),
        events.app.state::<web_device::WebDeviceManager>().inner().clone(),
        web_device::OperationIdRequest {
            operation_id: request.operation_id.clone(),
        },
    )?;
    let mut process = launch(request)?;
    if request.source == "codex" {
        run_codex(&mut process, request, prompt, events)
    } else {
        run_claude(&mut process, prompt, events)
    }
}

fn response(process: &Process, id: u64, deadline: Instant, stage: &str) -> Result<Value, String> {
    loop {
        let value = process.next(deadline, stage)?;
        if value.get("id").and_then(Value::as_u64) == Some(id) {
            if value.get("error").is_some() {
                return Err(format!("cli_rpc_failed:{stage}"));
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| format!("cli_protocol_missing_result:{stage}"));
        }
        if value.get("id").is_some() && value.get("method").is_some() {
            return Err(format!("cli_approval_during_startup:{stage}"));
        }
    }
}

fn run_codex(
    process: &mut Process,
    request: &StartRequest,
    prompt: &str,
    events: &mut Events<'_>,
) -> Result<(), String> {
    let deadline = Instant::now() + START_TIMEOUT;
    process.send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"cli_manager_web","version":env!("CARGO_PKG_VERSION")},"capabilities":{}}}))?;
    response(process, 1, deadline, "initialize")?;
    process.send(json!({"method":"initialized","params":{}}))?;
    let cwd = wsl_context(request)?
        .map(|(_, cwd)| cwd)
        .unwrap_or_else(|| request.cwd.clone());
    // Preserve the user's configured sandbox and approval policy.
    let mut params = json!({"cwd":cwd});
    if let Some(model) = &request.model {
        params["model"] = json!(model);
    }
    let method = if let Some(id) = &request.session_id {
        params["threadId"] = json!(id);
        "thread/resume"
    } else {
        "thread/start"
    };
    process.send(json!({"id":2,"method":method,"params":params}))?;
    let result = response(process, 2, deadline, method)?;
    let id = result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or("cli_protocol_missing_session")?;
    if request
        .session_id
        .as_deref()
        .is_some_and(|expected| expected != id)
    {
        return Err("cli_resume_session_mismatch".into());
    }
    events.bind_session(id)?;
    events.emit("session_started", None, None)?;
    events.emit(
        "user_message",
        Some(format!("{}:user", request.operation_id)),
        Some(prompt.into()),
    )?;
    process.send(json!({"id":3,"method":"turn/start","params":{"threadId":id,"input":[{"type":"text","text":prompt}]}}))?;
    events.emit("turn_started", None, None)?;
    let deadline = Instant::now() + TURN_TIMEOUT;
    loop {
        let value = process.next(deadline, "turn")?;
        if value.get("error").is_some() {
            return Err("cli_rpc_failed:turn".into());
        }
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id) = value.get("id").filter(|_| !method.is_empty()) {
            events.emit("approval_required", None, None)?;
            let supported = matches!(
                method,
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
            );
            let approved = supported && native_approval(events, &params);
            if supported {
                process.send(
                    json!({"id":id,"result":{"decision":if approved {"accept"} else {"decline"}}}),
                )?;
            } else {
                process.send(json!({"id":id,"error":{"code":-32601,"message":"Unsupported desktop approval request"}}))?;
            }
            if !approved {
                return Err("cli_approval_denied".into());
            }
            continue;
        }
        match method {
            "item/started" => {
                let item = &params["item"];
                if matches!(
                    item["type"].as_str(),
                    Some("commandExecution" | "fileChange" | "mcpToolCall")
                ) {
                    events.emit(
                        "tool_status",
                        item["id"].as_str().map(String::from),
                        item["type"].as_str().map(String::from),
                    )?;
                }
            }
            "item/agentMessage/delta" => {
                if let Some(text) = params.get("delta").and_then(Value::as_str) {
                    events.emit(
                        "assistant_delta",
                        params
                            .get("itemId")
                            .and_then(Value::as_str)
                            .map(String::from),
                        Some(text.into()),
                    )?;
                }
            }
            "item/completed" => {
                let item = &params["item"];
                if item["type"] == "agentMessage" {
                    events.emit(
                        "assistant_done",
                        item["id"].as_str().map(String::from),
                        item["text"].as_str().map(String::from),
                    )?;
                }
            }
            "turn/completed" => {
                if params.pointer("/turn/status").and_then(Value::as_str) != Some("completed") {
                    return Err("cli_turn_failed".into());
                }
                return Ok(());
            }
            "error" if !codex_will_retry(&params) => return Err("cli_turn_failed".into()),
            _ => {}
        }
    }
}

fn codex_will_retry(params: &Value) -> bool {
    params.get("willRetry").and_then(Value::as_bool) == Some(true)
}

fn native_approval(events: &Events<'_>, params: &Value) -> bool {
    let chinese = events.request.locale.as_deref() != Some("en-US");
    let detail: String = serde_json::to_string_pretty(params)
        .unwrap_or_default()
        .chars()
        .take(4000)
        .collect();
    let message = if chinese {
        format!("Web 对话请求执行操作。仅在确认以下内容后允许：\n\n{detail}")
    } else {
        format!("A Web conversation requests an action. Allow only after reviewing:\n\n{detail}")
    };
    events
        .app
        .dialog()
        .message(message)
        .title(if chinese {
            "Web 对话审批"
        } else {
            "Web conversation approval"
        })
        .buttons(MessageDialogButtons::OkCancelCustom(
            if chinese { "允许" } else { "Allow" }.into(),
            if chinese { "拒绝" } else { "Deny" }.into(),
        ))
        .blocking_show()
}

fn run_claude(process: &mut Process, prompt: &str, events: &mut Events<'_>) -> Result<(), String> {
    let mut input = process.input.take().ok_or("cli_input_closed")?;
    input
        .write_all(prompt.as_bytes())
        .and_then(|_| input.write_all(b"\n"))
        .and_then(|_| input.flush())
        .map_err(|_| "cli_input_write_failed")?;
    drop(input);
    let mut deadline = Instant::now() + START_TIMEOUT;
    let mut ready = false;
    let mut stream_message_id = String::new();
    loop {
        let value = process.next(deadline, if ready { "turn" } else { "initialize" })?;
        if !ready {
            if let Some(id) = value["session_id"].as_str() {
                if events
                    .request
                    .session_id
                    .as_deref()
                    .is_some_and(|expected| expected != id)
                {
                    return Err("cli_resume_session_mismatch".into());
                }
                events.bind_session(id)?;
                ready = true;
                deadline = Instant::now() + TURN_TIMEOUT;
                events.emit("session_started", None, None)?;
                events.emit(
                    "user_message",
                    Some(format!("{}:user", events.request.operation_id)),
                    Some(prompt.into()),
                )?;
                events.emit("turn_started", None, None)?;
            }
        }
        match value["type"].as_str().unwrap_or("") {
            "stream_event" => {
                let event = &value["event"];
                if event["type"] == "message_start" {
                    stream_message_id = event
                        .pointer("/message/id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into();
                }
                if event["type"] == "content_block_delta"
                    && event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta")
                {
                    if let Some(text) = event.pointer("/delta/text").and_then(Value::as_str) {
                        if !stream_message_id.is_empty() {
                            events.emit(
                                "assistant_delta",
                                Some(format!(
                                    "{}:{}",
                                    stream_message_id,
                                    event["index"].as_u64().unwrap_or(0)
                                )),
                                Some(text.into()),
                            )?;
                        }
                    }
                }
            }
            "assistant" => {
                if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
                    for (index, block) in content.iter().enumerate() {
                        if block["type"] == "text" {
                            events.emit(
                                "assistant_done",
                                Some(format!(
                                    "{}:{index}",
                                    value
                                        .pointer("/message/id")
                                        .and_then(Value::as_str)
                                        .unwrap_or(&events.request.operation_id)
                                )),
                                block["text"].as_str().map(String::from),
                            )?;
                        } else if block["type"] == "tool_use" {
                            events.emit(
                                "tool_status",
                                block["id"].as_str().map(String::from),
                                block["name"].as_str().map(String::from),
                            )?;
                        }
                    }
                }
            }
            "result" => {
                if !ready {
                    return Err("cli_protocol_missing_session".into());
                }
                if value["is_error"] == true
                    || value["permission_denials"]
                        .as_array()
                        .is_some_and(|denials| !denials.is_empty())
                {
                    return Err("cli_turn_failed_or_permission_denied".into());
                }
                return Ok(());
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires locally installed Codex and Claude; read-only --version probes"]
    fn installed_bare_cli_launchers_resolve_and_execute() {
        for source in ["codex", "claude"] {
            let mut request = request();
            request.source = source.into();
            request.launcher = source.into();
            let launcher = resolve_local_launcher(&request).expect("installed CLI must resolve");
            assert!(std::path::Path::new(&launcher).is_absolute());
            let output = script_command(&launcher, &["--version".into()])
                .unwrap()
                .output()
                .unwrap();
            assert!(output.status.success(), "{source} --version failed");
            assert!(!output.stdout.is_empty(), "{source} must return a version");
        }
    }
    #[test]
    fn codex_recoverable_errors_do_not_finish_the_turn() {
        assert!(codex_will_retry(
            &json!({"willRetry":true,"error":{"message":"reconnecting"}})
        ));
        assert!(!codex_will_retry(&json!({"willRetry":false})));
        assert!(!codex_will_retry(
            &json!({"error":{"message":"terminal failure"}})
        ));
        assert!(!codex_will_retry(&json!({"willRetry":"true"})));
    }
    #[test]
    fn wsl_maps_known_snapshot_paths_but_rejects_unknown_native_config_paths() {
        assert_eq!(
            wsl_launcher_args(&["--settings".into(), "C:\\Users\\me\\settings.json".into()])
                .unwrap(),
            vec!["--settings", "/mnt/c/Users/me/settings.json"]
        );
        assert!(
            wsl_launcher_args(&["-c".into(), "model_catalog_json=\"C:/catalog.json\"".into()])
                .is_err()
        );
    }
    #[test]
    fn history_export_only_includes_explicit_visible_text_parts() {
        use super::super::history::{HistoryMessage, HistoryMessagePart};
        let mut message = HistoryMessage {
            role: "assistant".into(),
            content: "secret tool args must not be exported".into(),
            parts: vec![
                HistoryMessagePart {
                    kind: "tool_call".into(),
                    content: "secret".into(),
                    tool_name: Some("exec".into()),
                    call_id: Some("call1".into()),
                },
                HistoryMessagePart {
                    kind: "text".into(),
                    content: "Visible reply".into(),
                    tool_name: None,
                    call_id: None,
                },
            ],
            timestamp: None,
            model: None,
            input_tokens: None,
            output_tokens: None,
            cache_creation_tokens: None,
            cache_read_tokens: None,
            line_index: None,
            editable: true,
            editable_text: None,
        };
        assert_eq!(history_visible_text(&message), Some("Visible reply".into()));
        message.parts.clear();
        assert_eq!(history_visible_text(&message), None);
        message.role = "system".into();
        assert_eq!(history_visible_text(&message), None);
    }
    #[test]
    fn chunking_large_replies_preserves_unicode_without_truncation() {
        let text = "你好😀transport";
        let chunks = text_chunks(text, 5);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 5));
        assert_eq!(chunks.concat(), text);
    }
    #[test]
    fn transport_retry_keeps_transient_delivery_and_rejects_invalid_payload() {
        let mut calls = 0;
        assert!(retry_delivery(|| {
            calls += 1;
            if calls == 1 {
                Err("web device disconnected".into())
            } else {
                Ok(())
            }
        })
        .is_ok());
        assert_eq!(calls, 2);
        let mut calls = 0;
        assert!(retry_delivery(|| {
            calls += 1;
            Err("invalid_conversation_event".into())
        })
        .is_err());
        assert_eq!(calls, 1);
    }
    #[test]
    fn protocol_reader_preserves_separate_stream_frames_and_unicode() {
        let input = "{\"method\":\"item/agentMessage/delta\",\"params\":{\"delta\":\"你好\"}}\n{\"method\":\"turn/completed\"}\n";
        let mut reader = BufReader::with_capacity(3, input.as_bytes());
        assert_eq!(
            read_protocol_line(&mut reader, 1024).unwrap().unwrap()["params"]["delta"],
            "你好"
        );
        assert_eq!(
            read_protocol_line(&mut reader, 1024).unwrap().unwrap()["method"],
            "turn/completed"
        );
        assert_eq!(read_protocol_line(&mut reader, 1024).unwrap(), None);
    }
    #[test]
    fn malformed_and_unbounded_cli_output_fails_closed() {
        assert_eq!(
            read_protocol_line(&mut &b"not json\n"[..], 32),
            Err("cli_protocol_invalid_json".into())
        );
        assert_eq!(
            read_protocol_line(&mut &b"{\"long\":\"unbounded content\"}"[..], 8),
            Err("cli_protocol_line_too_large".into())
        );
    }
    #[test]
    fn cli_stderr_is_bounded_to_stable_non_secret_diagnostics() {
        assert_eq!(
            classify_cli_stderr(
                b"ERROR: TERM is set to dumb. Refusing to start the interactive TUI"
            ),
            "interactive_arguments"
        );
        assert_eq!(
            classify_cli_stderr(b"secret prompt and https://token.example"),
            "launcher_error"
        );
        assert_eq!(classify_cli_stderr(b""), "no_diagnostic");
    }
    #[test]
    fn codex_tui_flags_cannot_bypass_web_approval() {
        assert!(codex_launcher_args(&["--yolo".into()]).is_err());
        assert_eq!(
            codex_launcher_args(&[
                "--no-alt-screen".into(),
                "-c".into(),
                "model=example".into()
            ])
            .unwrap(),
            vec!["-c", "model=example"]
        );
        assert!(codex_launcher_args(&["--profile".into()]).is_err());
    }
    #[test]
    fn codex_terminal_resume_arguments_are_not_forwarded_to_app_server() {
        assert_eq!(
            codex_launcher_args(&[
                "resume".into(),
                "019fc591-8a0b-7872-95b5-49c591ed4db1".into(),
                "-c".into(),
                "model=example".into(),
            ])
            .unwrap(),
            vec!["-c", "model=example"]
        );
        assert!(codex_launcher_args(&["resume".into(), "--last".into()])
            .unwrap()
            .is_empty());
    }
    #[test]
    fn wsl_uses_own_distribution_and_maps_drive_cwd() {
        let mut request = request();
        request.cwd = "F:\\workspace\\项目".into();
        request.wsl_distro = Some("Ubuntu".into());
        assert_eq!(
            wsl_context(&request).unwrap(),
            Some(("Ubuntu".into(), "/mnt/f/workspace/项目".into()))
        );
        request.cwd = "\\\\wsl.localhost\\Debian\\home\\me".into();
        assert_eq!(
            wsl_context(&request),
            Err("wsl_distribution_mismatch".into())
        );
    }
    fn request() -> StartRequest {
        serde_json::from_value(json!({"operationId":"op","source":"codex","projectId":"project","cwd":".","rootPath":".","launcher":"codex"})).unwrap()
    }
    #[test]
    fn rejects_invalid_session_and_prompt_before_spawning() {
        let mut request = request();
        request.session_id = Some("abc;rm".into());
        assert_eq!(
            validate_request(&request, "hello"),
            Err("invalid_session_id".into())
        );
        request.session_id = None;
        assert!(validate_request(&request, "\0").is_err());
    }
    #[test]
    fn accepts_opaque_session_ids() {
        let mut request = request();
        request.session_id = Some("01a07ee7-b1ee-7fa0-9de8-bd414d933550".into());
        assert!(validate_request(&request, "hello").is_ok());
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn shell_launcher_rejects_command_substitution() {
        assert!(script_command("claude.cmd", &["bad&command".into()]).is_err());
        assert!(script_command("C:\\Program Files\\claude.cmd", &["--print".into()]).is_ok());
    }
}
