use cli_manager_web_protocol::{
    DeviceToServerFrame, HistorySessionSummary, OperationError, OperationStatus, OperationView,
    ServerToDeviceFrame, WorkspaceSnapshot, DEVICE_PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::env;
use std::fs;
use std::net::{IpAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Error as WsError, Message, WebSocket};
use uuid::Uuid;

use crate::shell_resolver::silent_command;

const PROFILE_FILE_NAME: &str = "web-device.json";
const DEV_PROFILE_FILE_NAME: &str = "web-device.dev.json";
const TOKEN_ACCOUNT_PREFIX: &str = "web-device-token:";
const STATUS_EVENT: &str = "web-device-status-changed";
const OPERATION_EVENT: &str = "web-device-operation-ready";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const RECONNECT_DELAY: Duration = Duration::from_secs(3);
const READ_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_OPERATIONS: usize = 128;
const MAX_SEEN_OPERATIONS: usize = 1024;
const MAX_OUTBOUND_FRAMES: usize = 256;
const PAIRING_LIFETIME_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDeviceProfile {
    pub server_url: String,
    #[serde(alias = "deviceId")]
    pub client_id: String,
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub client_kind: String,
    pub name: String,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_true")]
    pub upload_wallpaper: bool,
    #[serde(default = "default_capabilities")]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProfileRequest {
    pub server_url: String,
    pub name: String,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_true")]
    pub upload_wallpaper: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebDeviceStatus {
    pub configured: bool,
    pub running: bool,
    pub connected: bool,
    pub paired: bool,
    pub profile: Option<WebDeviceProfile>,
    pub pairing_code: Option<String>,
    pub pairing_expires_at: Option<i64>,
    pub pending_operations: usize,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingResult {
    pub code: String,
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishHistoryRequest {
    pub sessions: Vec<HistorySessionSummary>,
    pub workspace: WorkspaceSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationIdRequest {
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCompletedRequest {
    pub operation_id: String,
    pub status: OperationStatus,
    pub result: Option<Value>,
    pub error: Option<OperationError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateContextRequest {
    pub root_path: String,
    pub cwd: String,
}

#[derive(Default)]
struct RuntimeState {
    running: bool,
    connected: bool,
    paired: bool,
    pairing_code: Option<String>,
    pairing_expires_at: Option<i64>,
    last_error: Option<String>,
    heartbeat_sequence: u64,
    history_sequence: u64,
}

#[derive(Default)]
struct OperationQueue {
    pending: VecDeque<OperationView>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
    overflowed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationPushResult {
    Inserted,
    Duplicate,
    Full,
}

impl OperationQueue {
    fn push(&mut self, operation: OperationView) -> OperationPushResult {
        if self.seen.contains(&operation.id) {
            return OperationPushResult::Duplicate;
        }
        if self.pending.len() >= MAX_OPERATIONS {
            self.overflowed = true;
            return OperationPushResult::Full;
        }
        self.seen.insert(operation.id.clone());
        self.seen_order.push_back(operation.id.clone());
        while self.seen_order.len() > MAX_SEEN_OPERATIONS {
            if let Some(id) = self.seen_order.pop_front() {
                self.seen.remove(&id);
            }
        }
        self.pending.push_back(operation);
        OperationPushResult::Inserted
    }

    fn snapshot(&self) -> Vec<OperationView> {
        self.pending.iter().cloned().collect()
    }

    fn acknowledge(&mut self, operation_id: &str) -> bool {
        self.pending
            .retain(|operation| operation.id != operation_id);
        if self.overflowed && self.pending.len() < MAX_OPERATIONS {
            self.overflowed = false;
            return true;
        }
        false
    }

    fn mark_status(&mut self, operation_id: &str, status: OperationStatus) {
        if let Some(operation) = self
            .pending
            .iter_mut()
            .find(|operation| operation.id == operation_id)
        {
            operation.status = status;
        }
    }
}

#[derive(Clone)]
pub struct WebDeviceManager {
    runtime: Arc<Mutex<RuntimeState>>,
    operations: Arc<Mutex<OperationQueue>>,
    outbound: Arc<Mutex<VecDeque<DeviceToServerFrame>>>,
    generation: Arc<AtomicU64>,
}

impl Default for WebDeviceManager {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(RuntimeState::default())),
            operations: Arc::new(Mutex::new(OperationQueue::default())),
            outbound: Arc::new(Mutex::new(VecDeque::new())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl WebDeviceManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn status(&self) -> Result<WebDeviceStatus, String> {
        let profile = load_profile()?;
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "web device state lock poisoned")?;
        let pending_operations = self
            .operations
            .lock()
            .map_err(|_| "web device operation lock poisoned")?
            .pending
            .len();
        Ok(WebDeviceStatus {
            configured: profile.is_some(),
            running: runtime.running,
            connected: runtime.connected,
            paired: runtime.paired,
            profile,
            pairing_code: runtime.pairing_code.clone(),
            pairing_expires_at: runtime.pairing_expires_at,
            pending_operations,
            last_error: runtime.last_error.clone(),
        })
    }

    fn emit_status(&self, app: &AppHandle) {
        if let Ok(status) = self.status() {
            let _ = app.emit(STATUS_EVENT, status);
        }
    }

    fn queue(&self, frame: DeviceToServerFrame) -> Result<(), String> {
        let mut outbound = self
            .outbound
            .lock()
            .map_err(|_| "web device send lock poisoned")?;
        if outbound.len() >= MAX_OUTBOUND_FRAMES {
            return Err("web device send queue is full".to_string());
        }
        outbound.push_back(frame);
        Ok(())
    }

    fn start(&self, app: AppHandle) -> Result<(), String> {
        let profile =
            load_profile()?.ok_or_else(|| "web device profile is not configured".to_string())?;
        validate_profile(&profile)?;
        {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "web device state lock poisoned")?;
            if runtime.running {
                return Ok(());
            }
            runtime.running = true;
            runtime.last_error = None;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let manager = self.clone();
        manager.emit_status(&app);
        thread::Builder::new()
            .name("web-device".to_string())
            .spawn(move || manager.run(app, generation))
            .map_err(|err| {
                if let Ok(mut runtime) = self.runtime.lock() {
                    runtime.running = false;
                    runtime.last_error = Some(format!("start web device worker failed: {err}"));
                }
                format!("start web device worker failed: {err}")
            })?;
        Ok(())
    }

    fn stop(&self, app: &AppHandle) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.running = false;
            runtime.connected = false;
            runtime.paired = false;
        }
        self.emit_status(app);
    }

    fn run(&self, app: AppHandle, generation: u64) {
        while self.is_current(generation) {
            let result = self.run_connection(&app, generation);
            if !self.is_current(generation) {
                break;
            }
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.connected = false;
                runtime.paired = false;
                runtime.last_error = result.err();
            }
            self.emit_status(&app);
            thread::sleep(RECONNECT_DELAY);
        }
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
            && self
                .runtime
                .lock()
                .map(|state| state.running)
                .unwrap_or(false)
    }

    fn run_connection(&self, app: &AppHandle, generation: u64) -> Result<(), String> {
        let profile =
            load_profile()?.ok_or_else(|| "web device profile is not configured".to_string())?;
        let url = normalize_server_url(&profile.server_url)?;
        let token = crate::credential_store::get(&token_account(&profile.client_id))?;
        let (mut socket, _) =
            connect(url.as_str()).map_err(|err| format!("connect web device failed: {err}"))?;
        set_read_timeout(&mut socket)?;
        let identity = crate::device_identity::collect(profile.upload_wallpaper);
        send_frame(
            &mut socket,
            &DeviceToServerFrame::Hello {
                protocol_version: DEVICE_PROTOCOL_VERSION,
                device_id: profile.client_id.clone(),
                client_id: Some(profile.client_id.clone()),
                machine_id: Some(profile.machine_id.clone()),
                client_kind: Some(profile.client_kind.clone()),
                device_token: token,
                name: profile.name.clone(),
                platform: env::consts::OS.to_string(),
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                capabilities: default_capabilities(),
                host_info: Some(identity.host_info),
                wallpaper: identity.wallpaper,
            },
        )?;
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.connected = true;
            runtime.last_error = None;
            let seed = now_millis().max(1) as u64;
            runtime.heartbeat_sequence = runtime.heartbeat_sequence.max(seed);
            runtime.history_sequence = runtime.history_sequence.max(seed);
        }
        self.emit_status(app);
        let mut last_heartbeat = Instant::now();
        while self.is_current(generation) {
            self.flush_outbound(&mut socket)?;
            if last_heartbeat.elapsed() >= HEARTBEAT_INTERVAL {
                let sequence = {
                    let mut runtime = self
                        .runtime
                        .lock()
                        .map_err(|_| "web device state lock poisoned")?;
                    runtime.heartbeat_sequence = runtime.heartbeat_sequence.saturating_add(1);
                    runtime.heartbeat_sequence
                };
                send_frame(&mut socket, &DeviceToServerFrame::Heartbeat { sequence })?;
                last_heartbeat = Instant::now();
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    let frame = serde_json::from_str::<ServerToDeviceFrame>(&text)
                        .map_err(|err| format!("invalid web device frame: {err}"))?;
                    self.handle_server_frame(app, &profile, frame)?;
                }
                Ok(Message::Ping(payload)) => socket
                    .send(Message::Pong(payload))
                    .map_err(|err| format!("send web device pong failed: {err}"))?,
                Ok(Message::Close(_)) => return Err("web device connection closed".to_string()),
                Ok(_) => {}
                Err(WsError::Io(err))
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => {
                    return Err("web device connection closed".to_string())
                }
                Err(err) => return Err(format!("read web device frame failed: {err}")),
            }
        }
        let _ = socket.close(None);
        Ok(())
    }

    fn flush_outbound(&self, socket: &mut DeviceSocket) -> Result<(), String> {
        loop {
            let frame = self
                .outbound
                .lock()
                .map_err(|_| "web device send lock poisoned")?
                .front()
                .cloned();
            let Some(frame) = frame else { return Ok(()) };
            send_frame(socket, &frame)?;
            self.outbound
                .lock()
                .map_err(|_| "web device send lock poisoned")?
                .pop_front();
        }
    }

    fn handle_server_frame(
        &self,
        app: &AppHandle,
        profile: &WebDeviceProfile,
        frame: ServerToDeviceFrame,
    ) -> Result<(), String> {
        match frame {
            ServerToDeviceFrame::HelloOk { paired, .. } => {
                if let Ok(mut runtime) = self.runtime.lock() {
                    runtime.paired = paired;
                }
                self.emit_status(app);
            }
            ServerToDeviceFrame::PairingOffered { .. } => {}
            ServerToDeviceFrame::PairingClaimed { device_token, .. } => {
                crate::credential_store::set(&token_account(&profile.client_id), &device_token)?;
                if let Ok(mut runtime) = self.runtime.lock() {
                    runtime.paired = true;
                    runtime.pairing_code = None;
                    runtime.pairing_expires_at = None;
                }
                self.emit_status(app);
            }
            ServerToDeviceFrame::OperationRequest { operation } => {
                if operation.device_id != profile.client_id {
                    return Err("operation device id does not match profile".to_string());
                }
                let push_result = self
                    .operations
                    .lock()
                    .map_err(|_| "web device operation lock poisoned")?
                    .push(operation);
                match push_result {
                    OperationPushResult::Inserted => {
                        let _ = app.emit(OPERATION_EVENT, ());
                        self.emit_status(app);
                    }
                    OperationPushResult::Duplicate => {}
                    OperationPushResult::Full => {}
                }
            }
            ServerToDeviceFrame::OperationAck {
                operation_id,
                status,
            } => {
                let mut operations = self
                    .operations
                    .lock()
                    .map_err(|_| "web device operation lock poisoned")?;
                let reconnect_for_deferred = if status.is_terminal() {
                    operations.acknowledge(&operation_id)
                } else {
                    operations.mark_status(&operation_id, status);
                    false
                };
                drop(operations);
                self.emit_status(app);
                if reconnect_for_deferred {
                    return Err(
                        "web device operation capacity recovered; reconnecting for deferred operations"
                            .to_string(),
                    );
                }
            }
            ServerToDeviceFrame::Ack { .. } => {}
            ServerToDeviceFrame::Error { code, message } => {
                return Err(format!(
                    "server rejected web device frame ({code}): {message}"
                ));
            }
        }
        Ok(())
    }
}

type DeviceSocket = WebSocket<MaybeTlsStream<TcpStream>>;

fn send_frame(socket: &mut DeviceSocket, frame: &DeviceToServerFrame) -> Result<(), String> {
    let json = serde_json::to_string(frame)
        .map_err(|err| format!("serialize web device frame failed: {err}"))?;
    socket
        .send(Message::Text(json.into()))
        .map_err(|err| format!("send web device frame failed: {err}"))
}

fn set_read_timeout(socket: &mut DeviceSocket) -> Result<(), String> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream.set_read_timeout(Some(READ_TIMEOUT)),
        MaybeTlsStream::Rustls(stream) => stream.sock.set_read_timeout(Some(READ_TIMEOUT)),
        _ => Ok(()),
    }
    .map_err(|err| format!("configure web device socket failed: {err}"))
}

fn default_capabilities() -> Vec<String> {
    vec![
        "history.snapshot".to_string(),
        "conversation".to_string(),
        "conversation.start".to_string(),
        "conversation.prompt".to_string(),
        "ssh.management".to_string(),
        "file.management".to_string(),
        "git.management".to_string(),
        "worktree.management".to_string(),
        "hook.management".to_string(),
    ]
}

fn default_true() -> bool {
    true
}

fn new_profile(
    request: SaveProfileRequest,
    existing: Option<WebDeviceProfile>,
) -> Result<WebDeviceProfile, String> {
    let client_id = existing.as_ref().map(|profile| profile.client_id.clone());
    let machine_id = existing
        .as_ref()
        .map(|profile| profile.machine_id.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(crate::app_paths::machine_id()?);
    Ok(WebDeviceProfile {
        server_url: request.server_url,
        client_id: client_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        machine_id,
        client_kind: client_kind().to_string(),
        name: request.name,
        auto_start: request.auto_start,
        upload_wallpaper: request.upload_wallpaper,
        capabilities: default_capabilities(),
    })
}

fn profile_path() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?.join(profile_file_name()))
}

fn profile_file_name() -> &'static str {
    if cfg!(debug_assertions) {
        DEV_PROFILE_FILE_NAME
    } else {
        PROFILE_FILE_NAME
    }
}

fn client_kind() -> &'static str {
    if cfg!(debug_assertions) {
        "development"
    } else {
        "release"
    }
}

fn load_profile() -> Result<Option<WebDeviceProfile>, String> {
    let path = profile_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("read web device profile failed: {err}"))?;
    let mut profile: WebDeviceProfile = serde_json::from_str(&raw)
        .map_err(|err| format!("parse web device profile failed: {err}"))?;
    if profile.machine_id.trim().is_empty() {
        profile.machine_id = crate::app_paths::machine_id()?;
    }
    profile.client_kind = client_kind().to_string();
    Ok(Some(profile))
}

fn save_profile_file(profile: &WebDeviceProfile) -> Result<(), String> {
    validate_profile(profile)?;
    let path = profile_path()?;
    let raw = serde_json::to_vec_pretty(profile)
        .map_err(|err| format!("serialize web device profile failed: {err}"))?;
    replace_file(&path, &raw)
}

fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid web device profile path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("create web device profile directory failed: {err}"))?;
    let temporary = parent.join(format!(".{}.{}.tmp", profile_file_name(), Uuid::new_v4()));
    fs::write(&temporary, bytes)
        .map_err(|err| format!("write web device profile failed: {err}"))?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| {
            let _ = fs::remove_file(&temporary);
            format!("replace web device profile failed: {err}")
        })?;
    }
    fs::rename(&temporary, path).map_err(|err| {
        let _ = fs::remove_file(&temporary);
        format!("replace web device profile failed: {err}")
    })
}

fn validate_profile(profile: &WebDeviceProfile) -> Result<(), String> {
    normalize_server_url(&profile.server_url)?;
    validate_bounded("client id", &profile.client_id, 1, 128)?;
    validate_bounded("machine id", &profile.machine_id, 1, 128)?;
    validate_bounded("device name", &profile.name, 1, 128)?;
    if profile.capabilities.len() > 32
        || profile
            .capabilities
            .iter()
            .any(|value| value.is_empty() || value.len() > 64)
    {
        return Err("invalid web device capabilities".to_string());
    }
    Ok(())
}

fn validate_bounded(label: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let len = value.trim().len();
    if len < min || len > max {
        return Err(format!("{label} length must be between {min} and {max}"));
    }
    Ok(())
}

fn normalize_server_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let uri = raw
        .parse::<tungstenite::http::Uri>()
        .map_err(|_| "invalid web device server URL".to_string())?;
    let scheme = uri
        .scheme_str()
        .ok_or_else(|| "web device server URL requires a scheme".to_string())?;
    let host = uri
        .host()
        .ok_or_else(|| "web device server URL requires a host".to_string())?;
    let secure = matches!(scheme, "https" | "wss");
    if !secure && !matches!(scheme, "http" | "ws") {
        return Err("web device server URL must use http, https, ws, or wss".to_string());
    }
    if !secure && !is_loopback_host(host) {
        return Err("remote web device server must use TLS".to_string());
    }
    let authority = uri
        .authority()
        .ok_or_else(|| "web device server URL requires an authority".to_string())?;
    Ok(format!(
        "{}://{}/ws/device",
        if secure { "wss" } else { "ws" },
        authority
    ))
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

fn token_account(device_id: &str) -> String {
    format!("{TOKEN_ACCOUNT_PREFIX}{device_id}")
}

fn validate_operation_context(root_path: &str, cwd: &str) -> Result<(), String> {
    validate_bounded("project root", root_path, 1, 4096)?;
    validate_bounded("working directory", cwd, 1, 4096)?;
    match (
        crate::wsl::parse_wsl_unc_path(root_path),
        crate::wsl::parse_wsl_unc_path(cwd),
    ) {
        (Some((root_distro, root_linux)), Some((cwd_distro, cwd_linux))) => {
            if !root_distro.eq_ignore_ascii_case(&cwd_distro) {
                return Err("working directory is outside the project root".to_string());
            }
            let root = resolve_wsl_realpath(&root_distro, &root_linux)?;
            let cwd = resolve_wsl_realpath(&cwd_distro, &cwd_linux)?;
            if !linux_path_within(&root, &cwd) {
                return Err("working directory is outside the project root".to_string());
            }
            Ok(())
        }
        (None, None) => {
            let root = Path::new(root_path)
                .canonicalize()
                .map_err(|err| format!("project root is unavailable: {err}"))?;
            let cwd = Path::new(cwd)
                .canonicalize()
                .map_err(|err| format!("working directory is unavailable: {err}"))?;
            if !root.is_dir() || !cwd.is_dir() || !cwd.starts_with(&root) {
                return Err("working directory is outside the project root".to_string());
            }
            Ok(())
        }
        _ => Err("working directory is outside the project root".to_string()),
    }
}

fn resolve_wsl_realpath(distro: &str, path: &str) -> Result<String, String> {
    let program = crate::wsl::find_wsl_exe()
        .unwrap_or_else(|| PathBuf::from("wsl.exe"))
        .to_string_lossy()
        .to_string();
    let output = silent_command(&program)
        .args(["-d", distro, "--exec", "readlink", "-f", path])
        .output()
        .map_err(|err| format!("resolve WSL working directory failed: {err}"))?;
    if !output.status.success() {
        return Err("working directory is unavailable".to_string());
    }
    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !resolved.starts_with('/') {
        return Err("working directory is unavailable".to_string());
    }
    Ok(resolved)
}

fn linux_path_within(root: &str, path: &str) -> bool {
    root == "/" || path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn pairing_code() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_ascii_uppercase()
}

fn daemon_call<T: DeserializeOwned>(request: crate::web_daemon::Request) -> Result<T, String> {
    crate::web_daemon::request(request)
}

fn daemon_executable_path() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|err| format!("current_exe failed: {err}"))?;
    let name = if cfg!(windows) {
        "cli-manager-web-daemon.exe"
    } else {
        "cli-manager-web-daemon"
    };
    Ok(current.with_file_name(name))
}

fn ensure_web_daemon() -> Result<(), String> {
    if let Some(info) = crate::web_daemon::read_discovery()? {
        if crate::daemon::discovery::is_pid_alive(info.pid) {
            if daemon_call::<serde_json::Value>(crate::web_daemon::Request::GetStatus).is_ok() {
                return Ok(());
            }
        } else {
            crate::web_daemon::remove_discovery();
        }
    }
    let executable = daemon_executable_path()?;
    if !executable.is_file() {
        return Err(format!(
            "web daemon executable not found: {}",
            executable.display()
        ));
    }
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .spawn()
        .map_err(|err| format!("spawn web daemon failed: {err}"))?;
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(250));
        if daemon_call::<serde_json::Value>(crate::web_daemon::Request::GetStatus).is_ok() {
            return Ok(());
        }
    }
    Err("web daemon did not become ready in time".to_string())
}

#[tauri::command]
pub fn web_device_get_status(
    manager: State<'_, WebDeviceManager>,
) -> Result<WebDeviceStatus, String> {
    if let Ok(status) = daemon_call::<WebDeviceStatus>(crate::web_daemon::Request::GetStatus) {
        return Ok(status);
    }
    manager.status()
}

#[tauri::command]
pub fn web_device_save_profile(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
    request: SaveProfileRequest,
) -> Result<WebDeviceStatus, String> {
    if ensure_web_daemon().is_ok() {
        if let Ok(status) =
            daemon_call::<WebDeviceStatus>(crate::web_daemon::Request::SaveProfile {
                server_url: request.server_url.clone(),
                name: request.name.clone(),
                auto_start: request.auto_start,
                upload_wallpaper: request.upload_wallpaper,
            })
        {
            return Ok(status);
        }
    }
    let mut profile = new_profile(request, load_profile()?)?;
    profile.server_url = normalize_server_url(&profile.server_url)?;
    save_profile_file(&profile)?;
    manager.emit_status(&app);
    manager.status()
}

#[tauri::command]
pub fn web_device_start(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
) -> Result<WebDeviceStatus, String> {
    if ensure_web_daemon().is_ok() {
        if let Ok(status) = daemon_call::<WebDeviceStatus>(crate::web_daemon::Request::Start) {
            return Ok(status);
        }
    }
    manager.start(app)?;
    manager.status()
}

#[tauri::command]
pub fn web_device_stop(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
) -> Result<WebDeviceStatus, String> {
    if let Ok(status) = daemon_call::<WebDeviceStatus>(crate::web_daemon::Request::Stop) {
        return Ok(status);
    }
    manager.stop(&app);
    manager.status()
}

#[tauri::command]
pub fn web_device_restart(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
) -> Result<WebDeviceStatus, String> {
    if ensure_web_daemon().is_ok() {
        if let Ok(status) = daemon_call::<WebDeviceStatus>(crate::web_daemon::Request::Restart) {
            return Ok(status);
        }
    }
    manager.stop(&app);
    manager.start(app)?;
    manager.status()
}

#[tauri::command]
pub fn web_device_create_pairing(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
) -> Result<PairingResult, String> {
    if let Ok(result) = daemon_call::<PairingResult>(crate::web_daemon::Request::CreatePairing) {
        return Ok(result);
    }
    let code = pairing_code();
    let expires_at = now_millis().saturating_add(PAIRING_LIFETIME_MS);
    {
        let mut runtime = manager
            .runtime
            .lock()
            .map_err(|_| "web device state lock poisoned")?;
        if !runtime.running || !runtime.connected || runtime.paired {
            return Err("web device must be connected and unpaired".to_string());
        }
        runtime.pairing_code = Some(code.clone());
        runtime.pairing_expires_at = Some(expires_at);
    }
    if let Err(err) = manager.queue(DeviceToServerFrame::PairingOffer {
        code: code.clone(),
        expires_at,
    }) {
        if let Ok(mut runtime) = manager.runtime.lock() {
            runtime.pairing_code = None;
            runtime.pairing_expires_at = None;
        }
        return Err(err);
    }
    manager.emit_status(&app);
    Ok(PairingResult { code, expires_at })
}

#[tauri::command]
pub fn web_device_clear_pairing(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
) -> Result<WebDeviceStatus, String> {
    if let Ok(status) = daemon_call::<WebDeviceStatus>(crate::web_daemon::Request::ClearPairing) {
        return Ok(status);
    }
    let was_running = manager
        .runtime
        .lock()
        .map(|runtime| runtime.running)
        .unwrap_or(false);
    manager.stop(&app);
    if let Some(mut profile) = load_profile()? {
        crate::credential_store::delete(&token_account(&profile.client_id))?;
        profile.client_id = Uuid::new_v4().to_string();
        save_profile_file(&profile)?;
    }
    if let Ok(mut operations) = manager.operations.lock() {
        *operations = OperationQueue::default();
    }
    if let Ok(mut outbound) = manager.outbound.lock() {
        outbound.clear();
    }
    if let Ok(mut runtime) = manager.runtime.lock() {
        runtime.paired = false;
        runtime.pairing_code = None;
        runtime.pairing_expires_at = None;
    }
    if was_running {
        manager.start(app.clone())?;
    }
    manager.emit_status(&app);
    manager.status()
}

#[tauri::command]
pub fn web_device_take_operations(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
) -> Result<Vec<OperationView>, String> {
    if let Ok(operations) =
        daemon_call::<Vec<OperationView>>(crate::web_daemon::Request::TakeOperations)
    {
        return Ok(operations);
    }
    let operations = manager
        .operations
        .lock()
        .map_err(|_| "web device operation lock poisoned")?
        .snapshot();
    manager.emit_status(&app);
    Ok(operations)
}

#[tauri::command]
pub fn web_device_publish_history(
    manager: State<'_, WebDeviceManager>,
    request: PublishHistoryRequest,
) -> Result<(), String> {
    if ensure_web_daemon().is_ok() {
        if daemon_call::<()>(crate::web_daemon::Request::PublishHistory {
            sessions: request.sessions.clone(),
            workspace: request.workspace.clone(),
        })
        .is_ok()
        {
            return Ok(());
        }
    }
    let sequence = {
        let mut runtime = manager
            .runtime
            .lock()
            .map_err(|_| "web device state lock poisoned")?;
        runtime.history_sequence = runtime.history_sequence.saturating_add(1);
        runtime.history_sequence
    };
    manager.queue(DeviceToServerFrame::HistorySnapshot {
        sequence,
        sessions: request.sessions,
        workspace: Some(request.workspace),
    })
}

#[tauri::command]
pub async fn web_device_validate_context(request: ValidateContextRequest) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_operation_context(&request.root_path, &request.cwd)
    })
    .await
    .map_err(|err| format!("validate web device context failed: {err}"))?
}

#[tauri::command]
pub fn web_device_operation_accepted(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
    request: OperationIdRequest,
) -> Result<(), String> {
    if let Ok(()) = daemon_call::<()>(crate::web_daemon::Request::OperationAccepted {
        operation_id: request.operation_id.clone(),
    }) {
        return Ok(());
    }
    manager.queue(DeviceToServerFrame::OperationAccepted {
        operation_id: request.operation_id.clone(),
    })?;
    manager
        .operations
        .lock()
        .map_err(|_| "web device operation lock poisoned")?
        .mark_status(&request.operation_id, OperationStatus::Accepted);
    manager.emit_status(&app);
    Ok(())
}

#[tauri::command]
pub fn web_device_operation_running(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
    request: OperationIdRequest,
) -> Result<(), String> {
    if let Ok(()) = daemon_call::<()>(crate::web_daemon::Request::OperationRunning {
        operation_id: request.operation_id.clone(),
    }) {
        return Ok(());
    }
    manager.queue(DeviceToServerFrame::OperationRunning {
        operation_id: request.operation_id.clone(),
    })?;
    manager
        .operations
        .lock()
        .map_err(|_| "web device operation lock poisoned")?
        .mark_status(&request.operation_id, OperationStatus::Running);
    manager.emit_status(&app);
    Ok(())
}

#[tauri::command]
pub fn web_device_operation_completed(
    app: AppHandle,
    manager: State<'_, WebDeviceManager>,
    request: OperationCompletedRequest,
) -> Result<(), String> {
    if !request.status.is_terminal() {
        return Err("operation completed status must be terminal".to_string());
    }
    if let Ok(()) = daemon_call::<()>(crate::web_daemon::Request::OperationCompleted {
        operation_id: request.operation_id.clone(),
        status: request.status.clone(),
        result: request.result.clone(),
        error: request.error.clone(),
    }) {
        return Ok(());
    }
    manager.queue(DeviceToServerFrame::OperationCompleted {
        operation_id: request.operation_id.clone(),
        status: request.status.clone(),
        result: request.result,
        error: request.error,
    })?;
    manager
        .operations
        .lock()
        .map_err(|_| "web device operation lock poisoned")?
        .mark_status(&request.operation_id, request.status);
    manager.emit_status(&app);
    Ok(())
}

pub fn auto_start(app: &AppHandle) -> Result<(), String> {
    let Some(profile) = load_profile()? else {
        return Ok(());
    };
    if profile.auto_start {
        if ensure_web_daemon().is_ok()
            && daemon_call::<WebDeviceStatus>(crate::web_daemon::Request::Start).is_ok()
        {
            return Ok(());
        }
        app.state::<WebDeviceManager>().start(app.clone())?;
    }
    Ok(())
}

pub fn shutdown(app: &AppHandle) {
    if daemon_call::<()>(crate::web_daemon::Request::Shutdown).is_ok() {
        return;
    }
    app.state::<WebDeviceManager>().stop(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_secures_server_urls() {
        assert_eq!(
            normalize_server_url("http://localhost:8787/old").unwrap(),
            "ws://localhost:8787/ws/device"
        );
        assert_eq!(
            normalize_server_url("https://example.com/api").unwrap(),
            "wss://example.com/ws/device"
        );
        assert_eq!(
            normalize_server_url("ws://127.0.0.1:8787").unwrap(),
            "ws://127.0.0.1:8787/ws/device"
        );
        assert!(normalize_server_url("ws://example.com").is_err());
        assert!(normalize_server_url("ftp://localhost").is_err());
    }

    #[test]
    fn pairing_codes_are_bounded_ascii() {
        let code = pairing_code();
        assert_eq!(code.len(), 8);
        assert!(code
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() && !ch.is_ascii_lowercase()));
    }

    #[test]
    fn profile_validation_rejects_invalid_bounds() {
        let valid = WebDeviceProfile {
            server_url: "https://example.com".to_string(),
            client_id: "client-1".to_string(),
            machine_id: "machine-1".to_string(),
            client_kind: "development".to_string(),
            name: "Desktop".to_string(),
            auto_start: false,
            upload_wallpaper: true,
            capabilities: default_capabilities(),
        };
        assert!(validate_profile(&valid).is_ok());
        let mut invalid = valid.clone();
        invalid.client_id.clear();
        assert!(validate_profile(&invalid).is_err());
        invalid = valid;
        invalid.capabilities = vec!["x".repeat(65)];
        assert!(validate_profile(&invalid).is_err());
    }

    #[test]
    fn save_request_preserves_device_id_and_resets_capabilities() {
        let existing = WebDeviceProfile {
            server_url: "wss://old.example/ws/device".to_string(),
            client_id: "stable-client".to_string(),
            machine_id: "stable-machine".to_string(),
            client_kind: "development".to_string(),
            name: "Old".to_string(),
            auto_start: false,
            upload_wallpaper: false,
            capabilities: vec!["untrusted".to_string()],
        };
        let profile = new_profile(
            SaveProfileRequest {
                server_url: "https://example.com".to_string(),
                name: "Desktop".to_string(),
                auto_start: true,
                upload_wallpaper: true,
            },
            Some(existing),
        )
        .unwrap();
        assert_eq!(profile.client_id, "stable-client");
        assert_eq!(profile.machine_id, "stable-machine");
        assert_eq!(profile.capabilities, default_capabilities());
        assert!(profile.upload_wallpaper);
    }

    #[test]
    fn operation_queue_deduplicates_and_is_bounded() {
        let operation = |id: String| OperationView {
            id,
            device_id: "device-1".to_string(),
            kind: "conversation.start".to_string(),
            status: OperationStatus::Submitted,
            idempotency_key: "key".to_string(),
            payload: serde_json::json!({"prompt":"hello"}),
            result: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut queue = OperationQueue::default();
        assert_eq!(
            queue.push(operation("same".to_string())),
            OperationPushResult::Inserted
        );
        assert_eq!(
            queue.push(operation("same".to_string())),
            OperationPushResult::Duplicate
        );
        for index in 1..MAX_OPERATIONS {
            assert_eq!(
                queue.push(operation(format!("operation-{index}"))),
                OperationPushResult::Inserted
            );
        }
        assert_eq!(
            queue.push(operation("overflow".to_string())),
            OperationPushResult::Full
        );
        assert_eq!(queue.snapshot().len(), MAX_OPERATIONS);
        assert_eq!(queue.snapshot().len(), MAX_OPERATIONS);
        assert!(queue.acknowledge("same"));
        assert_eq!(queue.snapshot().len(), MAX_OPERATIONS - 1);
    }

    #[test]
    fn profile_json_is_camel_case_and_contains_no_token() {
        let profile = WebDeviceProfile {
            server_url: "wss://example.com/ws/device".to_string(),
            client_id: "client-1".to_string(),
            machine_id: "machine-1".to_string(),
            client_kind: "development".to_string(),
            name: "Desktop".to_string(),
            auto_start: true,
            upload_wallpaper: true,
            capabilities: default_capabilities(),
        };
        let value = serde_json::to_value(profile).unwrap();
        assert_eq!(value["serverUrl"], "wss://example.com/ws/device");
        assert_eq!(value["clientId"], "client-1");
        assert_eq!(value["machineId"], "machine-1");
        assert_eq!(value["uploadWallpaper"], true);
        assert!(value.get("deviceToken").is_none());
        assert!(value.get("token").is_none());
    }

    #[test]
    fn legacy_profile_device_id_migrates_to_client_id() {
        let profile: WebDeviceProfile = serde_json::from_value(serde_json::json!({
            "serverUrl": "https://example.com",
            "deviceId": "legacy-device",
            "name": "Desktop",
            "autoStart": true,
            "uploadWallpaper": true,
            "capabilities": []
        }))
        .unwrap();
        assert_eq!(profile.client_id, "legacy-device");
        assert!(profile.machine_id.is_empty());
    }

    #[test]
    fn development_profile_is_isolated_from_installed_profile() {
        assert_eq!(profile_file_name(), DEV_PROFILE_FILE_NAME);
        assert_ne!(profile_file_name(), PROFILE_FILE_NAME);
    }

    #[test]
    fn replaces_existing_profile_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PROFILE_FILE_NAME);
        replace_file(&path, b"first").unwrap();
        replace_file(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
    }

    #[test]
    fn validates_native_context_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        let nested = root.join("nested");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&outside).unwrap();
        assert!(
            validate_operation_context(&root.to_string_lossy(), &nested.to_string_lossy()).is_ok()
        );
        assert!(
            validate_operation_context(&root.to_string_lossy(), &outside.to_string_lossy())
                .is_err()
        );
    }
}
