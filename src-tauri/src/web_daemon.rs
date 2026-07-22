//! Desktop-side Web device bridge daemon.
//!
//! The daemon owns the remote Device WebSocket and exposes a small, loopback-only
//! NDJSON control socket to the Tauri process. It deliberately has no Tauri or
//! filesystem operation authority beyond the Web profile and credential store.

use cli_manager_web_protocol::{
    DeviceToServerFrame, HistorySessionSummary, OperationError, OperationStatus, OperationView,
    ServerToDeviceFrame, WorkspaceSnapshot, DEVICE_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Error as WsError, Message, WebSocket};
use uuid::Uuid;

const PROFILE_FILE_NAME: &str = "web-device.json";
const DEV_PROFILE_FILE_NAME: &str = "web-device.dev.json";
const TOKEN_ACCOUNT_PREFIX: &str = "web-device-token:";
const INFO_FILE_NAME: &str = "web-daemon.json";
const DEV_INFO_FILE_NAME: &str = "web-daemon.dev.json";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const RECONNECT_DELAY: Duration = Duration::from_secs(3);
const READ_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_OPERATIONS: usize = 128;
const MAX_SEEN_OPERATIONS: usize = 1024;
const MAX_OUTBOUND_FRAMES: usize = 256;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const PAIRING_LIFETIME_MS: i64 = 5 * 60 * 1000;
const IDLE_EXIT_AFTER: Duration = Duration::from_secs(10 * 60);
const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
    pub protocol_version: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    server_url: String,
    #[serde(alias = "deviceId")]
    client_id: String,
    #[serde(default)]
    machine_id: String,
    #[serde(default)]
    client_kind: String,
    name: String,
    #[serde(default)]
    auto_start: bool,
    #[serde(default = "default_true")]
    upload_wallpaper: bool,
    #[serde(default = "default_capabilities")]
    capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    configured: bool,
    running: bool,
    connected: bool,
    paired: bool,
    profile: Option<Profile>,
    pairing_code: Option<String>,
    pairing_expires_at: Option<i64>,
    pending_operations: usize,
    last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Auth {
        token: String,
        client_version: String,
    },
    GetStatus,
    SaveProfile {
        server_url: String,
        name: String,
        auto_start: bool,
        #[serde(default = "default_true")]
        upload_wallpaper: bool,
    },
    Start,
    Stop,
    Restart,
    CreatePairing,
    ClearPairing,
    TakeOperations,
    PublishHistory {
        sessions: Vec<HistorySessionSummary>,
        workspace: WorkspaceSnapshot,
    },
    OperationAccepted {
        operation_id: String,
    },
    OperationRunning {
        operation_id: String,
    },
    OperationCompleted {
        operation_id: String,
        status: OperationStatus,
        result: Option<Value>,
        error: Option<OperationError>,
    },
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    ok: bool,
    payload: Option<Value>,
    error: Option<String>,
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

impl OperationQueue {
    fn push(&mut self, operation: OperationView) -> bool {
        if self.seen.contains(&operation.id) {
            return true;
        }
        if self.pending.len() >= MAX_OPERATIONS {
            self.overflowed = true;
            return false;
        }
        self.seen.insert(operation.id.clone());
        self.seen_order.push_back(operation.id.clone());
        while self.seen_order.len() > MAX_SEEN_OPERATIONS {
            if let Some(id) = self.seen_order.pop_front() {
                self.seen.remove(&id);
            }
        }
        self.pending.push_back(operation);
        true
    }

    fn snapshot(&self) -> Vec<OperationView> {
        self.pending.iter().cloned().collect()
    }

    fn acknowledge(&mut self, operation_id: &str) {
        self.pending
            .retain(|operation| operation.id != operation_id);
        self.overflowed = false;
    }

    fn mark_status(&mut self, operation_id: &str, status: OperationStatus) {
        if let Some(operation) = self.pending.iter_mut().find(|item| item.id == operation_id) {
            operation.status = status;
        }
    }
}

#[derive(Clone)]
pub struct DaemonState {
    runtime: Arc<Mutex<RuntimeState>>,
    operations: Arc<Mutex<OperationQueue>>,
    outbound: Arc<Mutex<VecDeque<DeviceToServerFrame>>>,
    generation: Arc<AtomicU64>,
    stopping: Arc<AtomicBool>,
    info_path: PathBuf,
    info: DaemonInfo,
}

impl DaemonState {
    pub fn new(info_path: PathBuf, info: DaemonInfo) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(RuntimeState::default())),
            operations: Arc::new(Mutex::new(OperationQueue::default())),
            outbound: Arc::new(Mutex::new(VecDeque::new())),
            generation: Arc::new(AtomicU64::new(0)),
            stopping: Arc::new(AtomicBool::new(false)),
            info_path,
            info,
        }
    }

    pub fn run(self) -> Result<(), String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|err| format!("bind web daemon failed: {err}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("configure web daemon listener failed: {err}"))?;
        let info = DaemonInfo {
            port: listener
                .local_addr()
                .map_err(|err| format!("read web daemon port failed: {err}"))?
                .port(),
            ..self.info.clone()
        };
        write_info_exclusive(&self.info_path, &info)?;
        let mut idle_since = Instant::now();
        let state = self.clone();
        thread::spawn(move || {
            if let Some(profile) = load_profile().ok().flatten() {
                if profile.auto_start {
                    let _ = state.start();
                }
            }
        });
        while !self.stopping.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    idle_since = Instant::now();
                    let state = self.clone();
                    thread::spawn(move || state.handle_client(stream));
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(err) => return Err(format!("accept web daemon client failed: {err}")),
            }
            let idle = self
                .runtime
                .lock()
                .map(|runtime| !runtime.running)
                .unwrap_or(false)
                && self
                    .operations
                    .lock()
                    .map(|operations| operations.pending.is_empty())
                    .unwrap_or(false);
            if idle && idle_since.elapsed() >= IDLE_EXIT_AFTER {
                break;
            }
        }
        remove_info(&self.info_path);
        Ok(())
    }

    fn handle_client(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let mut reader = match stream.try_clone() {
            Ok(stream) => BufReader::new(stream),
            Err(_) => return,
        };
        let Some(line) = read_line(&mut reader) else {
            return;
        };
        let Ok(Request::Auth { token, .. }) = serde_json::from_str(&line) else {
            return;
        };
        if token != self.info.token {
            let _ = write_response(&mut stream, None, Some("auth_failed"));
            return;
        }
        loop {
            let Some(line) = read_line(&mut reader) else {
                return;
            };
            let Ok(request) = serde_json::from_str::<Request>(&line) else {
                let _ = write_response(&mut stream, None, Some("invalid_request"));
                return;
            };
            let shutdown = matches!(request, Request::Shutdown);
            let result = self.handle_request(request);
            match result {
                Ok(payload) => {
                    let _ = write_response(&mut stream, payload, None);
                }
                Err(error) => {
                    let _ = write_response(&mut stream, None, Some(&error));
                }
            }
            if shutdown {
                return;
            }
        }
    }

    fn handle_request(&self, request: Request) -> Result<Option<Value>, String> {
        match request {
            Request::Auth { .. } => Ok(None),
            Request::GetStatus => Ok(Some(serde_json::to_value(self.status()?).unwrap())),
            Request::SaveProfile {
                server_url,
                name,
                auto_start,
                upload_wallpaper,
            } => {
                let existing = load_profile()?;
                let client_id = existing.as_ref().map(|item| item.client_id.clone());
                let machine_id = existing
                    .as_ref()
                    .map(|item| item.machine_id.trim())
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .unwrap_or(crate::app_paths::machine_id()?);
                let profile = Profile {
                    server_url: normalize_server_url(&server_url)?,
                    client_id: client_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    machine_id,
                    client_kind: client_kind().to_string(),
                    name,
                    auto_start,
                    upload_wallpaper,
                    capabilities: default_capabilities(),
                };
                save_profile(&profile)?;
                Ok(Some(serde_json::to_value(self.status()?).unwrap()))
            }
            Request::Start => {
                self.start()?;
                Ok(Some(serde_json::to_value(self.status()?).unwrap()))
            }
            Request::Stop => {
                self.stop();
                Ok(Some(serde_json::to_value(self.status()?).unwrap()))
            }
            Request::Restart => {
                self.stop();
                self.start()?;
                Ok(Some(serde_json::to_value(self.status()?).unwrap()))
            }
            Request::CreatePairing => {
                let code = pairing_code();
                let expires_at = now_millis().saturating_add(PAIRING_LIFETIME_MS);
                {
                    let mut runtime = self
                        .runtime
                        .lock()
                        .map_err(|_| "web daemon state lock poisoned")?;
                    if !runtime.running || !runtime.connected || runtime.paired {
                        return Err("web device must be connected and unpaired".into());
                    }
                    runtime.pairing_code = Some(code.clone());
                    runtime.pairing_expires_at = Some(expires_at);
                }
                self.queue(DeviceToServerFrame::PairingOffer {
                    code: code.clone(),
                    expires_at,
                })?;
                Ok(Some(
                    serde_json::json!({"code": code, "expiresAt": expires_at}),
                ))
            }
            Request::ClearPairing => {
                self.clear_pairing()?;
                Ok(Some(serde_json::to_value(self.status()?).unwrap()))
            }
            Request::TakeOperations => Ok(Some(
                serde_json::to_value(
                    self.operations
                        .lock()
                        .map_err(|_| "web daemon operation lock poisoned")?
                        .snapshot(),
                )
                .unwrap(),
            )),
            Request::PublishHistory {
                sessions,
                workspace,
            } => {
                let sequence = {
                    let mut runtime = self
                        .runtime
                        .lock()
                        .map_err(|_| "web daemon state lock poisoned")?;
                    runtime.history_sequence = runtime.history_sequence.saturating_add(1);
                    runtime.history_sequence
                };
                self.queue(DeviceToServerFrame::HistorySnapshot {
                    sequence,
                    sessions,
                    workspace: Some(workspace),
                })?;
                Ok(None)
            }
            Request::OperationAccepted { operation_id } => {
                self.queue(DeviceToServerFrame::OperationAccepted {
                    operation_id: operation_id.clone(),
                })?;
                self.operations
                    .lock()
                    .map_err(|_| "web daemon operation lock poisoned")?
                    .mark_status(&operation_id, OperationStatus::Accepted);
                Ok(None)
            }
            Request::OperationRunning { operation_id } => {
                self.queue(DeviceToServerFrame::OperationRunning {
                    operation_id: operation_id.clone(),
                })?;
                self.operations
                    .lock()
                    .map_err(|_| "web daemon operation lock poisoned")?
                    .mark_status(&operation_id, OperationStatus::Running);
                Ok(None)
            }
            Request::OperationCompleted {
                operation_id,
                status,
                result,
                error,
            } => {
                if !status.is_terminal() {
                    return Err("operation completed status must be terminal".into());
                }
                self.queue(DeviceToServerFrame::OperationCompleted {
                    operation_id: operation_id.clone(),
                    status: status.clone(),
                    result,
                    error,
                })?;
                self.operations
                    .lock()
                    .map_err(|_| "web daemon operation lock poisoned")?
                    .mark_status(&operation_id, status);
                Ok(None)
            }
            Request::Shutdown => {
                self.stopping.store(true, Ordering::SeqCst);
                self.stop();
                Ok(None)
            }
        }
    }

    fn status(&self) -> Result<Status, String> {
        let profile = load_profile()?;
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "web daemon state lock poisoned")?;
        let pending = self
            .operations
            .lock()
            .map_err(|_| "web daemon operation lock poisoned")?
            .pending
            .len();
        Ok(Status {
            configured: profile.is_some(),
            running: runtime.running,
            connected: runtime.connected,
            paired: runtime.paired,
            profile,
            pairing_code: runtime.pairing_code.clone(),
            pairing_expires_at: runtime.pairing_expires_at,
            pending_operations: pending,
            last_error: runtime.last_error.clone(),
        })
    }

    fn start(&self) -> Result<(), String> {
        let profile =
            load_profile()?.ok_or_else(|| "web device profile is not configured".to_string())?;
        normalize_server_url(&profile.server_url)?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "web daemon state lock poisoned")?;
        if runtime.running {
            return Ok(());
        }
        runtime.running = true;
        runtime.last_error = None;
        drop(runtime);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let state = self.clone();
        thread::spawn(move || state.run_connection_loop(generation));
        Ok(())
    }

    fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.running = false;
            runtime.connected = false;
            runtime.paired = false;
        }
    }

    fn run_connection_loop(&self, generation: u64) {
        while self.is_current(generation) {
            let result = self.run_connection(generation);
            if !self.is_current(generation) {
                break;
            }
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.connected = false;
                runtime.paired = false;
                runtime.last_error = result.err();
            }
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

    fn run_connection(&self, generation: u64) -> Result<(), String> {
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
                capabilities: profile.capabilities.clone(),
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
        let mut last_heartbeat = Instant::now();
        while self.is_current(generation) {
            self.flush_outbound(&mut socket)?;
            if last_heartbeat.elapsed() >= HEARTBEAT_INTERVAL {
                let sequence = {
                    let mut runtime = self
                        .runtime
                        .lock()
                        .map_err(|_| "web daemon state lock poisoned")?;
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
                    self.handle_server_frame(frame)?;
                }
                Ok(Message::Ping(payload)) => socket
                    .send(Message::Pong(payload))
                    .map_err(|err| format!("send web device pong failed: {err}"))?,
                Ok(Message::Close(_)) => return Err("web device connection closed".into()),
                Ok(_) => {}
                Err(WsError::Io(err))
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => {
                    return Err("web device connection closed".into())
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
                .map_err(|_| "web daemon send lock poisoned")?
                .front()
                .cloned();
            let Some(frame) = frame else { return Ok(()) };
            send_frame(socket, &frame)?;
            self.outbound
                .lock()
                .map_err(|_| "web daemon send lock poisoned")?
                .pop_front();
        }
    }

    fn handle_server_frame(&self, frame: ServerToDeviceFrame) -> Result<(), String> {
        match frame {
            ServerToDeviceFrame::HelloOk { paired, .. } => {
                if let Ok(mut runtime) = self.runtime.lock() {
                    runtime.paired = paired;
                }
            }
            ServerToDeviceFrame::PairingOffered { .. } => {}
            ServerToDeviceFrame::PairingClaimed { device_token, .. } => {
                let profile = load_profile()?
                    .ok_or_else(|| "web device profile is not configured".to_string())?;
                crate::credential_store::set(&token_account(&profile.client_id), &device_token)?;
                if let Ok(mut runtime) = self.runtime.lock() {
                    runtime.paired = true;
                    runtime.pairing_code = None;
                    runtime.pairing_expires_at = None;
                }
            }
            ServerToDeviceFrame::OperationRequest { operation } => {
                let inserted = self
                    .operations
                    .lock()
                    .map_err(|_| "web daemon operation lock poisoned")?
                    .push(operation);
                if !inserted {
                    return Err("web device operation queue is full".to_string());
                }
            }
            ServerToDeviceFrame::OperationAck {
                operation_id,
                status,
            } => {
                let mut operations = self
                    .operations
                    .lock()
                    .map_err(|_| "web daemon operation lock poisoned")?;
                if status.is_terminal() {
                    operations.acknowledge(&operation_id);
                } else {
                    operations.mark_status(&operation_id, status);
                }
            }
            ServerToDeviceFrame::Ack { .. } => {}
            ServerToDeviceFrame::Error { code, message } => {
                return Err(format!(
                    "server rejected web device frame ({code}): {message}"
                ))
            }
        }
        Ok(())
    }

    fn queue(&self, frame: DeviceToServerFrame) -> Result<(), String> {
        let mut outbound = self
            .outbound
            .lock()
            .map_err(|_| "web daemon send lock poisoned")?;
        if outbound.len() >= MAX_OUTBOUND_FRAMES {
            return Err("web device send queue is full".into());
        }
        outbound.push_back(frame);
        Ok(())
    }

    fn clear_pairing(&self) -> Result<(), String> {
        let was_running = self
            .runtime
            .lock()
            .map(|runtime| runtime.running)
            .unwrap_or(false);
        self.stop();
        if let Some(mut profile) = load_profile()? {
            crate::credential_store::delete(&token_account(&profile.client_id))?;
            profile.client_id = Uuid::new_v4().to_string();
            save_profile(&profile)?;
        }
        if let Ok(mut operations) = self.operations.lock() {
            *operations = OperationQueue::default();
        }
        if let Ok(mut outbound) = self.outbound.lock() {
            outbound.clear();
        }
        if was_running {
            self.start()?;
        }
        Ok(())
    }
}

type DeviceSocket = WebSocket<MaybeTlsStream<TcpStream>>;

pub fn run_daemon() -> Result<(), String> {
    let data_dir = crate::app_paths::cli_manager_data_dir()?;
    let info_path = data_dir.join(if cfg!(debug_assertions) {
        DEV_INFO_FILE_NAME
    } else {
        INFO_FILE_NAME
    });
    let info = DaemonInfo {
        port: 0,
        token: Uuid::new_v4().to_string(),
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: PROTOCOL_VERSION,
    };
    DaemonState::new(info_path, info).run()
}

pub fn request<T: for<'de> Deserialize<'de>>(request: Request) -> Result<T, String> {
    let data_dir = crate::app_paths::cli_manager_data_dir()?;
    let path = data_dir.join(if cfg!(debug_assertions) {
        DEV_INFO_FILE_NAME
    } else {
        INFO_FILE_NAME
    });
    let info = read_info(&path)?.ok_or_else(|| "web daemon unavailable".to_string())?;
    let mut stream = TcpStream::connect(("127.0.0.1", info.port))
        .map_err(|err| format!("connect web daemon failed: {err}"))?;
    let auth = serde_json::to_string(&Request::Auth {
        token: info.token.clone(),
        client_version: env!("CARGO_PKG_VERSION").to_string(),
    })
    .map_err(|err| err.to_string())?;
    writeln!(stream, "{auth}").map_err(|err| err.to_string())?;
    let payload = serde_json::to_string(&request).map_err(|err| err.to_string())?;
    writeln!(stream, "{payload}").map_err(|err| err.to_string())?;
    let mut reader = BufReader::new(stream);
    let line = read_line(&mut reader).ok_or_else(|| "web daemon response missing".to_string())?;
    let response: Response = serde_json::from_str(&line)
        .map_err(|err| format!("parse web daemon response failed: {err}"))?;
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "web daemon request failed".into()));
    }
    match response.payload {
        Some(value) => serde_json::from_value(value)
            .map_err(|err| format!("decode web daemon response failed: {err}")),
        None => serde_json::from_value(Value::Null).map_err(|err| err.to_string()),
    }
}

fn write_response(
    stream: &mut TcpStream,
    payload: Option<Value>,
    error: Option<&str>,
) -> Result<(), String> {
    let response = Response {
        ok: error.is_none(),
        payload,
        error: error.map(str::to_string),
    };
    let text = serde_json::to_string(&response).map_err(|err| err.to_string())?;
    writeln!(stream, "{text}").map_err(|err| err.to_string())
}

fn read_line(reader: &mut impl BufRead) -> Option<String> {
    let mut line = String::new();
    let bytes = reader
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_line(&mut line)
        .ok()?;
    if bytes == 0 || bytes > MAX_FRAME_BYTES || !line.ends_with('\n') {
        return None;
    }
    Some(line.trim_end_matches(['\r', '\n']).to_string())
}

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

fn load_profile() -> Result<Option<Profile>, String> {
    let path = crate::app_paths::cli_manager_data_dir()?.join(profile_file_name());
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        fs::read_to_string(path).map_err(|err| format!("read web device profile failed: {err}"))?;
    let mut profile: Profile = serde_json::from_str(&raw)
        .map_err(|err| format!("parse web device profile failed: {err}"))?;
    if profile.machine_id.trim().is_empty() {
        profile.machine_id = crate::app_paths::machine_id()?;
    }
    profile.client_kind = client_kind().to_string();
    Ok(Some(profile))
}

fn save_profile(profile: &Profile) -> Result<(), String> {
    let path = crate::app_paths::cli_manager_data_dir()?.join(profile_file_name());
    let parent = path
        .parent()
        .ok_or_else(|| "invalid web device profile path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("create web device profile directory failed: {err}"))?;
    let temporary = parent.join(format!(".{}.{}.tmp", profile_file_name(), Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(profile).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|err| err.to_string())?;
    }
    fs::rename(temporary, path).map_err(|err| err.to_string())
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

fn normalize_server_url(raw: &str) -> Result<String, String> {
    let uri = raw
        .trim()
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
        return Err("web device server URL must use http, https, ws, or wss".into());
    }
    if !secure && !is_loopback_host(host) {
        return Err("remote web device server must use TLS".into());
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
fn default_capabilities() -> Vec<String> {
    [
        "history.snapshot",
        "conversation",
        "conversation.start",
        "conversation.prompt",
        "ssh.management",
        "file.management",
        "git.management",
        "worktree.management",
        "hook.management",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}
fn default_true() -> bool {
    true
}
fn pairing_code() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_ascii_uppercase()
}
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn write_info_exclusive(path: &Path, info: &DaemonInfo) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|err| format!("web daemon info exists or not writable: {err}"))?;
    file.write_all(
        serde_json::to_string_pretty(info)
            .map_err(|err| err.to_string())?
            .as_bytes(),
    )
    .map_err(|err| err.to_string())
}
fn read_info(path: &Path) -> Result<Option<DaemonInfo>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|err| err.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}
fn remove_info(path: &Path) {
    let _ = fs::remove_file(path);
}

pub fn info_path() -> Result<PathBuf, String> {
    Ok(
        crate::app_paths::cli_manager_data_dir()?.join(if cfg!(debug_assertions) {
            DEV_INFO_FILE_NAME
        } else {
            INFO_FILE_NAME
        }),
    )
}

pub fn read_discovery() -> Result<Option<DaemonInfo>, String> {
    read_info(&info_path()?)
}

pub fn remove_discovery() {
    if let Ok(path) = info_path() {
        remove_info(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_protocol_uses_auth_first_and_camel_case_payloads() {
        let request = serde_json::to_value(Request::OperationRunning {
            operation_id: "op-1".into(),
        })
        .unwrap();
        assert_eq!(request["type"], "operation_running");
        assert_eq!(request["operation_id"], "op-1");
    }

    #[test]
    fn queue_is_bounded_and_deduplicated() {
        let operation = |id: String| OperationView {
            id,
            device_id: "d".into(),
            kind: "conversation.start".into(),
            status: OperationStatus::Submitted,
            idempotency_key: "k".into(),
            payload: serde_json::json!({}),
            result: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut queue = OperationQueue::default();
        assert!(queue.push(operation("same".into())));
        assert!(queue.push(operation("same".into())));
        for index in 1..MAX_OPERATIONS {
            assert!(queue.push(operation(index.to_string())));
        }
        assert!(!queue.push(operation("overflow".into())));
        assert_eq!(queue.snapshot().len(), MAX_OPERATIONS);
    }

    #[test]
    fn remote_plaintext_urls_are_rejected() {
        assert_eq!(
            normalize_server_url("http://localhost:8787").unwrap(),
            "ws://localhost:8787/ws/device"
        );
        assert!(normalize_server_url("http://example.com").is_err());
        assert_eq!(
            normalize_server_url("https://example.com").unwrap(),
            "wss://example.com/ws/device"
        );
    }

    #[test]
    fn serialized_status_contains_no_device_token() {
        let status = Status {
            configured: true,
            running: true,
            connected: true,
            paired: true,
            profile: Some(Profile {
                server_url: "wss://example.com/ws/device".into(),
                client_id: "client-1".into(),
                machine_id: "machine-1".into(),
                client_kind: "development".into(),
                name: "Desktop".into(),
                auto_start: true,
                upload_wallpaper: true,
                capabilities: default_capabilities(),
            }),
            pairing_code: None,
            pairing_expires_at: None,
            pending_operations: 0,
            last_error: None,
        };
        let value = serde_json::to_value(status).unwrap();
        assert!(value.get("deviceToken").is_none());
        assert!(value.get("token").is_none());
    }
}
