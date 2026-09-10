//! Desktop-side Web device bridge daemon.
//!
//! The daemon owns the remote Device WebSocket and exposes a small, loopback-only
//! NDJSON control socket to the Tauri process. It deliberately has no Tauri or
//! filesystem operation authority beyond the Web profile and credential store.

use cli_manager_web_protocol::{
    ConversationEvent, DeviceToServerFrame, HistorySessionSummary, OperationError, OperationStatus,
    OperationView, ServerToDeviceFrame, TerminalCommand, TerminalOutputFrame, WorkspaceSnapshot,
    DEVICE_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WsError, Message, WebSocket};
use uuid::Uuid;

const PROFILE_FILE_NAME: &str = "web-device.json";
const DEV_PROFILE_FILE_NAME: &str = "web-device.dev.json";
const TOKEN_ACCOUNT_PREFIX: &str = "web-device-token:";
const INFO_FILE_NAME: &str = "web-daemon.json";
const DEV_INFO_FILE_NAME: &str = "web-daemon.dev.json";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const RECONNECT_DELAY: Duration = Duration::from_secs(3);
const READ_TIMEOUT: Duration = Duration::from_millis(500);
pub(crate) const SERVER_SILENCE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OPERATIONS: usize = 128;
const MAX_SEEN_OPERATIONS: usize = 1024;
const MAX_TERMINAL_COMMANDS: usize = 512;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const PAIRING_LIFETIME_MS: i64 = 5 * 60 * 1000;
const IDLE_EXIT_AFTER: Duration = Duration::from_secs(10 * 60);
const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_millis(200);
const CONTROL_RETRY_DELAY: Duration = Duration::from_secs(3);
pub(crate) const PROTOCOL_VERSION: u16 = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(default)]
    trusted_network: bool,
    #[serde(default)]
    public_access_url: String,
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
        #[serde(default)]
        protocol_version: u16,
    },
    GetStatus,
    SaveProfile {
        server_url: String,
        #[serde(default)]
        trusted_network: bool,
        #[serde(default)]
        public_access_url: String,
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
    TakeTerminalCommands,
    TerminalOutput {
        session_id: String,
        sequence: u64,
        frames: Vec<TerminalOutputFrame>,
    },
    TerminalStatus {
        session_id: String,
        status: String,
        exit_code: Option<i32>,
        control_mode: Option<String>,
    },
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
    ConversationEvent {
        event: ConversationEvent,
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
    terminal_commands: Arc<Mutex<VecDeque<TerminalCommand>>>,
    outbound: Arc<Mutex<crate::web_device_outbox::WebDeviceOutbox>>,
    output_ready: Arc<tokio::sync::Notify>,
    generation: Arc<AtomicU64>,
    connection: Arc<DeviceConnectionControl>,
    stopping: Arc<AtomicBool>,
    info_path: PathBuf,
    info: DaemonInfo,
}

impl DaemonState {
    pub fn new(info_path: PathBuf, info: DaemonInfo) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(RuntimeState::default())),
            operations: Arc::new(Mutex::new(OperationQueue::default())),
            terminal_commands: Arc::new(Mutex::new(VecDeque::new())),
            outbound: Arc::new(Mutex::new(
                crate::web_device_outbox::WebDeviceOutbox::default(),
            )),
            generation: Arc::new(AtomicU64::new(0)),
            output_ready: Arc::new(tokio::sync::Notify::new()),
            connection: Arc::new(DeviceConnectionControl::default()),
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
        let accept_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| err.to_string())?;
        let listener = {
            let _guard = accept_runtime.enter();
            tokio::net::TcpListener::from_std(listener).map_err(|err| err.to_string())?
        };
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
            match accept_runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(1), listener.accept()).await
            }) {
                Ok(Ok((stream, _))) => {
                    let stream = stream.into_std().map_err(|err| err.to_string())?;
                    stream
                        .set_nonblocking(false)
                        .map_err(|err| err.to_string())?;
                    idle_since = Instant::now();
                    let state = self.clone();
                    thread::spawn(move || state.handle_client(stream));
                }
                Err(_) => {}
                Ok(Err(err)) => return Err(format!("accept web daemon client failed: {err}")),
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
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let mut reader = match stream.try_clone() {
            Ok(stream) => BufReader::new(stream),
            Err(_) => return,
        };
        let Some(line) = read_line(&mut reader) else {
            return;
        };
        let Ok(Request::Auth {
            token,
            protocol_version,
            ..
        }) = serde_json::from_str(&line)
        else {
            return;
        };
        if token != self.info.token {
            let _ = write_response(&mut stream, None, Some("auth_failed"));
            return;
        }
        if protocol_version != PROTOCOL_VERSION {
            let _ = write_response(&mut stream, None, Some("web_daemon_protocol_mismatch"));
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
                trusted_network,
                public_access_url,
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
                    server_url: normalize_device_url(&server_url, trusted_network)?,
                    trusted_network,
                    public_access_url: normalize_public_url(&public_access_url, trusted_network)?,
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
            Request::TakeTerminalCommands => {
                let commands = self
                    .terminal_commands
                    .lock()
                    .map_err(|_| "web daemon terminal command lock poisoned")?
                    .drain(..)
                    .collect::<Vec<_>>();
                Ok(Some(serde_json::to_value(commands).unwrap()))
            }
            Request::TerminalOutput {
                session_id,
                sequence,
                frames,
            } => {
                self.queue(DeviceToServerFrame::TerminalOutput {
                    session_id,
                    sequence,
                    frames,
                })?;
                Ok(None)
            }
            Request::TerminalStatus {
                session_id,
                status,
                exit_code,
                control_mode,
            } => {
                self.queue(DeviceToServerFrame::TerminalStatus {
                    session_id,
                    status,
                    exit_code,
                    control_mode,
                })?;
                Ok(None)
            }
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
            Request::ConversationEvent { event } => {
                self.queue(DeviceToServerFrame::ConversationEvent { event })?;
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
        normalize_device_url(&profile.server_url, profile.trusted_network)?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "web daemon state lock poisoned")?;
        if runtime.running {
            return Ok(());
        }
        runtime.running = true;
        runtime.last_error = None;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        drop(runtime);
        let state = self.clone();
        thread::spawn(move || state.run_connection_loop(generation));
        Ok(())
    }

    fn stop(&self) {
        self.output_ready.notify_one();
        if let Ok(mut runtime) = self.runtime.lock() {
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.connection.cancel();
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
                if self.generation.load(Ordering::SeqCst) != generation {
                    break;
                }
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
        let _attempt = self.connection.begin()?;
        if !self.is_current(generation) {
            return Ok(());
        }
        self.outbound
            .lock()
            .map_err(|_| "web daemon send lock poisoned")?
            .reconnect();
        let profile =
            load_profile()?.ok_or_else(|| "web device profile is not configured".to_string())?;
        let url = normalize_device_url(&profile.server_url, profile.trusted_network)?;
        let token = crate::credential_store::get(&token_account(&profile.client_id))?;
        let mut socket = self
            .connection
            .connect(&url, &self.generation, generation)?;
        let identity = crate::device_identity::collect(profile.upload_wallpaper);
        if !self.is_current(generation) {
            return Ok(());
        }
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
            if self.generation.load(Ordering::SeqCst) != generation {
                return Ok(());
            }
            runtime.last_error = None;
            let seed = now_millis().max(1) as u64;
            runtime.heartbeat_sequence = runtime.heartbeat_sequence.max(seed);
            runtime.history_sequence = runtime.history_sequence.max(seed);
        }
        let mut socket = EventDeviceSocket::new(socket, self.output_ready.clone())?;
        let mut last_heartbeat = Instant::now();
        let mut last_received = Instant::now();
        while self.is_current(generation) {
            if last_received.elapsed() >= SERVER_SILENCE_TIMEOUT {
                return Err("web device server heartbeat timed out".into());
            }
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
                socket.send_frame(&DeviceToServerFrame::Heartbeat { sequence })?;
                last_heartbeat = Instant::now();
            }
            let received = socket.read();
            if !self.is_current(generation) {
                return Ok(());
            }
            if received.is_ok() {
                last_received = Instant::now();
            }
            match received {
                Ok(Message::Text(text)) => {
                    let frame = serde_json::from_str::<ServerToDeviceFrame>(&text)
                        .map_err(|err| format!("invalid web device frame: {err}"))?;
                    self.handle_server_frame(frame, generation)?;
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
        let _ = socket.socket.close(None);
        Ok(())
    }

    fn flush_outbound(&self, socket: &mut EventDeviceSocket) -> Result<(), String> {
        let started = Instant::now();
        for _ in 0..32 {
            let frame = self
                .outbound
                .lock()
                .map_err(|_| "web daemon send lock poisoned")?
                .next();
            let Some(frame) = frame else { return Ok(()) };
            socket.send_frame(&frame)?;
            self.outbound
                .lock()
                .map_err(|_| "web daemon send lock poisoned")?
                .sent();
            if started.elapsed() >= Duration::from_millis(4) {
                break;
            }
        }
        // A full quantum must continue immediately even when the server is silent.
        self.output_ready.notify_one();
        Ok(())
    }

    fn handle_server_frame(
        &self,
        frame: ServerToDeviceFrame,
        generation: u64,
    ) -> Result<(), String> {
        match frame {
            ServerToDeviceFrame::HelloOk { paired, .. } => {
                if let Ok(mut runtime) = self.runtime.lock() {
                    if self.generation.load(Ordering::SeqCst) != generation {
                        return Ok(());
                    }
                    runtime.connected = true;
                    runtime.paired = paired;
                }
            }
            ServerToDeviceFrame::PairingOffered { .. } => {}
            ServerToDeviceFrame::PairingClaimed { device_token, .. } => {
                let profile = load_profile()?
                    .ok_or_else(|| "web device profile is not configured".to_string())?;
                crate::credential_store::set(&token_account(&profile.client_id), &device_token)?;
                if let Ok(mut runtime) = self.runtime.lock() {
                    if self.generation.load(Ordering::SeqCst) != generation {
                        return Ok(());
                    }
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
            ServerToDeviceFrame::TerminalCommand { command } => {
                let mut commands = self
                    .terminal_commands
                    .lock()
                    .map_err(|_| "web daemon terminal command lock poisoned")?;
                if commands.len() >= MAX_TERMINAL_COMMANDS {
                    commands.pop_front();
                }
                commands.push_back(command);
            }
            ServerToDeviceFrame::OperationAck {
                operation_id,
                status,
            } => {
                self.outbound
                    .lock()
                    .map_err(|_| "web daemon send lock poisoned")?
                    .acknowledge_operation(&operation_id, &status);
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
            ServerToDeviceFrame::ConversationAck {
                operation_id,
                sequence,
            } => {
                self.outbound
                    .lock()
                    .map_err(|_| "web daemon send lock poisoned")?
                    .acknowledge_event(&operation_id, sequence);
            }
            ServerToDeviceFrame::Ack { .. } => {}
            ServerToDeviceFrame::Error { code, message } if code == "invalid_terminal_output" => {
                if let Ok(mut runtime) = self.runtime.lock() {
                    if self.generation.load(Ordering::SeqCst) == generation {
                        runtime.last_error = Some(format!("terminal output rejected: {message}"));
                    }
                }
            }
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
        outbound.push(frame)?;
        self.output_ready.notify_one();
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

/// Shared by the helper process and the in-process fallback. The attempt guard
/// prevents retired workers from consuming the replacement worker's outbox.
#[derive(Default)]
pub(crate) struct DeviceConnectionControl {
    attempt: Mutex<()>,
    active: Mutex<Option<TcpStream>>,
}

pub(crate) struct DeviceConnectionAttempt<'a> {
    control: &'a DeviceConnectionControl,
    _guard: std::sync::MutexGuard<'a, ()>,
}

impl Drop for DeviceConnectionAttempt<'_> {
    fn drop(&mut self) {
        self.control.cancel();
    }
}

impl DeviceConnectionControl {
    pub(crate) fn begin(&self) -> Result<DeviceConnectionAttempt<'_>, String> {
        Ok(DeviceConnectionAttempt {
            control: self,
            _guard: self
                .attempt
                .lock()
                .map_err(|_| "web connection lock poisoned")?,
        })
    }
    pub(crate) fn cancel(&self) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(stream) = active.take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }

    pub(crate) fn connect(
        &self,
        url: &str,
        generation: &AtomicU64,
        expected: u64,
    ) -> Result<DeviceSocket, String> {
        self.connect_with_timeout(url, generation, expected, Duration::from_secs(5))
    }

    fn connect_with_timeout(
        &self,
        url: &str,
        generation: &AtomicU64,
        expected: u64,
        timeout: Duration,
    ) -> Result<DeviceSocket, String> {
        let uri = url
            .parse::<tungstenite::http::Uri>()
            .map_err(|err| err.to_string())?;
        let host = uri
            .host()
            .ok_or("web device URL requires host")?
            .trim_matches(['[', ']'])
            .to_string();
        let port = uri
            .port_u16()
            .unwrap_or(if uri.scheme_str() == Some("wss") {
                443
            } else {
                80
            });
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            let addresses = (host.as_str(), port)
                .to_socket_addrs()
                .map(|items| items.collect::<Vec<_>>())
                .map_err(|err| err.to_string());
            let _ = sender.send(addresses);
        });
        let started = Instant::now();
        let addresses = loop {
            if generation.load(Ordering::SeqCst) != expected {
                return Err("web device connection canceled".into());
            }
            if started.elapsed() >= timeout {
                return Err("resolve web device server timed out".into());
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(result) => break result?,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(err) => return Err(err.to_string()),
            }
        };
        let mut last_error = "web device server has no addresses".to_string();
        for address in addresses {
            if generation.load(Ordering::SeqCst) != expected {
                return Err("web device connection canceled".into());
            }
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err("connect web device timed out".into());
            }
            let stream = match TcpStream::connect_timeout(&address, remaining) {
                Ok(stream) => stream,
                Err(err) => {
                    last_error = err.to_string();
                    continue;
                }
            };
            stream
                .set_read_timeout(Some(timeout))
                .map_err(|err| err.to_string())?;
            stream
                .set_write_timeout(Some(timeout))
                .map_err(|err| err.to_string())?;
            {
                let mut active = self
                    .active
                    .lock()
                    .map_err(|_| "web device socket lock poisoned")?;
                if generation.load(Ordering::SeqCst) != expected {
                    return Err("web device connection canceled".into());
                }
                *active = Some(stream.try_clone().map_err(|err| err.to_string())?);
            }
            // The socket is registered before TLS/HTTP handshake so Stop can
            // interrupt a server which accepts TCP but never completes upgrade.
            // A peer trickling bytes must not extend the handshake indefinitely.
            let deadline_socket = stream.try_clone().map_err(|err| err.to_string())?;
            let (finished, wait_finished) = std::sync::mpsc::channel::<()>();
            thread::spawn(move || {
                if matches!(
                    wait_finished.recv_timeout(timeout),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ) {
                    let _ = deadline_socket.shutdown(Shutdown::Both);
                }
            });
            let result = tungstenite::client_tls(url, stream);
            drop(finished);
            let (mut socket, _) =
                result.map_err(|err| format!("connect web device handshake failed: {err}"))?;
            if generation.load(Ordering::SeqCst) != expected {
                return Err("web device connection canceled".into());
            }
            set_read_timeout(&mut socket)?;
            return Ok(socket);
        }
        Err(format!("connect web device failed: {last_error}"))
    }
}

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
    request_checked(request, false)
}

/// The only legacy operations allowed are inspection and an explicitly gated shutdown.
pub(crate) fn upgrade_control<T: for<'de> Deserialize<'de>>(request: Request) -> Result<T, String> {
    if !matches!(request, Request::GetStatus | Request::Shutdown) {
        return Err("web_daemon_upgrade_control_forbidden".into());
    }
    request_checked(request, true)
}

fn request_checked<T: for<'de> Deserialize<'de>>(
    request: Request,
    upgrade: bool,
) -> Result<T, String> {
    let data_dir = crate::app_paths::cli_manager_data_dir()?;
    let path = data_dir.join(if cfg!(debug_assertions) {
        DEV_INFO_FILE_NAME
    } else {
        INFO_FILE_NAME
    });
    let info = read_info(&path)?.ok_or_else(|| "web daemon unavailable".to_string())?;
    request_with_info(request, upgrade, &info)
}

// Cache only failed TCP connects, never business errors or requests that may
// already have been applied. A new discovery identity bypasses the cooldown.
#[derive(Default)]
struct ControlConnector {
    failed: Mutex<Option<(DaemonInfo, Instant)>>,
}

impl ControlConnector {
    fn connect(&self, info: &DaemonInfo) -> Result<TcpStream, String> {
        let mut failed = self
            .failed
            .lock()
            .map_err(|_| "web daemon connection lock poisoned")?;
        if failed
            .as_ref()
            .is_some_and(|(previous, retry_at)| previous == info && Instant::now() < *retry_at)
        {
            return Err("web daemon unavailable (connection cooldown)".into());
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, info.port));
        match TcpStream::connect_timeout(&address, CONTROL_CONNECT_TIMEOUT) {
            Ok(stream) => {
                *failed = None;
                Ok(stream)
            }
            Err(error) => {
                *failed = Some((info.clone(), Instant::now() + CONTROL_RETRY_DELAY));
                Err(format!("connect web daemon failed: {error}"))
            }
        }
    }
}

fn request_with_info<T: for<'de> Deserialize<'de>>(
    request: Request,
    upgrade: bool,
    info: &DaemonInfo,
) -> Result<T, String> {
    static CONNECTOR: ControlConnector = ControlConnector {
        failed: Mutex::new(None),
    };
    thread_local! {
        static SESSION: std::cell::RefCell<Option<(DaemonInfo, Instant, BufReader<TcpStream>)>> = const { std::cell::RefCell::new(None) };
    }
    let protocol_version = control_protocol_version(info.protocol_version, upgrade)?;
    let cached = SESSION
        .with(|slot| slot.borrow_mut().take())
        .filter(|(previous, used, _)| previous == info && used.elapsed() < Duration::from_secs(8));
    let mut reader = if let Some((_, _, reader)) = cached {
        reader
    } else {
        let mut stream = CONNECTOR.connect(info)?;
        stream.set_nodelay(true).map_err(|err| err.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|err| err.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|err| err.to_string())?;
        let auth = serde_json::to_string(&Request::Auth {
            token: info.token.clone(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version,
        })
        .map_err(|err| err.to_string())?;
        writeln!(stream, "{auth}").map_err(|err| err.to_string())?;
        BufReader::new(stream)
    };
    let payload = serde_json::to_string(&request).map_err(|err| err.to_string())?;
    writeln!(reader.get_mut(), "{payload}").map_err(|err| err.to_string())?;
    let line = read_line(&mut reader).ok_or_else(|| "web daemon response missing".to_string())?;
    let response: Response = serde_json::from_str(&line)
        .map_err(|err| format!("parse web daemon response failed: {err}"))?;
    // Never retry an ambiguous write/read failure: the request may have executed.
    if !matches!(request, Request::Shutdown)
        && !matches!(
            response.error.as_deref(),
            Some("auth_failed" | "web_daemon_protocol_mismatch")
        )
    {
        SESSION.with(|slot| *slot.borrow_mut() = Some((info.clone(), Instant::now(), reader)));
    }
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

fn control_protocol_version(discovered: u16, upgrade: bool) -> Result<u16, String> {
    if discovered == PROTOCOL_VERSION || (upgrade && matches!(discovered, 1..=7)) {
        Ok(discovered)
    } else {
        Err("web_daemon_protocol_mismatch: finish pending operations before upgrading the Web daemon".into())
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

/// One owner for tungstenite, with OS readiness and an explicit producer wakeup.
/// This avoids parking outbound traffic behind a blocking receive or splitting TLS state.
pub(crate) struct EventDeviceSocket {
    pub(crate) socket: DeviceSocket,
    readiness: tokio::net::TcpStream,
    runtime: tokio::runtime::Runtime,
    output_ready: Arc<tokio::sync::Notify>,
}

impl EventDeviceSocket {
    pub(crate) fn new(
        mut socket: DeviceSocket,
        output_ready: Arc<tokio::sync::Notify>,
    ) -> Result<Self, String> {
        let stream = match socket.get_mut() {
            MaybeTlsStream::Plain(stream) => stream,
            MaybeTlsStream::Rustls(stream) => &mut stream.sock,
            _ => return Err("unsupported web device transport".into()),
        };
        stream
            .set_nonblocking(true)
            .map_err(|err| err.to_string())?;
        stream.set_nodelay(true).map_err(|err| err.to_string())?;
        let clone = stream.try_clone().map_err(|err| err.to_string())?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| err.to_string())?;
        let readiness = {
            let _guard = runtime.enter();
            tokio::net::TcpStream::from_std(clone).map_err(|err| err.to_string())?
        };
        Ok(Self {
            socket,
            readiness,
            runtime,
            output_ready,
        })
    }

    pub(crate) fn read(&mut self) -> Result<Message, WsError> {
        // Try the parser first: TLS / tungstenite may already hold a complete frame.
        match self.socket.read() {
            Err(WsError::Io(err)) if err.kind() == std::io::ErrorKind::WouldBlock => {}
            result => return result,
        }
        let socket = &mut self.socket;
        let readiness = &self.readiness;
        self.runtime.block_on(async {
            tokio::select! {
                _ = self.output_ready.notified() => Err(WsError::Io(std::io::ErrorKind::WouldBlock.into())),
                _ = tokio::time::sleep(Duration::from_secs(1)) => Err(WsError::Io(std::io::ErrorKind::WouldBlock.into())),
                result = readiness.async_io(tokio::io::Interest::READABLE, || {
                    match socket.read() {
                        Err(WsError::Io(err)) if err.kind() == std::io::ErrorKind::WouldBlock => Err(err),
                        result => Ok(result),
                    }
                }) => result.map_err(WsError::Io)?,
            }
        })
    }

    pub(crate) fn send(&mut self, message: Message) -> Result<(), WsError> {
        match self.socket.send(message) {
            Ok(()) => return Ok(()),
            // tungstenite retains the accepted frame; only flush, never resend it.
            Err(WsError::Io(err)) if err.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(err) => return Err(err),
        }
        let socket = &mut self.socket;
        let readiness = &self.readiness;
        self.runtime.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                readiness.async_io(tokio::io::Interest::WRITABLE, || match socket.flush() {
                    Err(WsError::Io(err)) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        Err(err)
                    }
                    result => Ok(result),
                }),
            )
            .await
            .map_err(|_| WsError::Io(std::io::ErrorKind::TimedOut.into()))?
            .map_err(WsError::Io)?
        })
    }

    pub(crate) fn send_frame(&mut self, frame: &DeviceToServerFrame) -> Result<(), String> {
        let text = serde_json::to_string(frame).map_err(|err| err.to_string())?;
        self.send(Message::Text(text.into()))
            .map_err(|err| format!("send web device frame failed: {err}"))
    }
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
    profile.capabilities = default_capabilities();
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

#[cfg(test)]
fn normalize_server_url(raw: &str) -> Result<String, String> {
    normalize_device_url(raw, false)
}

pub(crate) fn normalize_device_url(raw: &str, trusted_network: bool) -> Result<String, String> {
    let parsed = reqwest::Url::parse(raw.trim()).map_err(|_| "invalid web device server URL")?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("web device URL must not contain credentials, query, or fragment".into());
    }
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
    if !secure && !is_loopback_host(host) && !trusted_network {
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

pub(crate) fn normalize_public_url(raw: &str, trusted_network: bool) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Ok(String::new());
    }
    let mut url = reqwest::Url::parse(raw.trim()).map_err(|_| "invalid public access URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "public access URL must be an HTTP(S) origin without credentials or path".into(),
        );
    }
    if url.scheme() == "http" && !is_loopback_host(url.host_str().unwrap_or("")) && !trusted_network
    {
        return Err("public access URL requires HTTPS or explicit trusted network mode".into());
    }
    url.set_path("/");
    Ok(url.to_string())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
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
        "terminal.stream",
        "project.management",
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

/// PID existence alone is insufficient after a reboot: Windows can reuse it
/// for an unrelated application. Unknown process paths are kept conservatively.
pub(crate) fn discovery_process_is_stale(info: &DaemonInfo) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new();
    let pid = Pid::from_u32(info.pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    let Some(process) = system.process(pid) else {
        return true;
    };
    process.exe().and_then(Path::file_stem).is_some_and(|name| {
        !name
            .to_string_lossy()
            .eq_ignore_ascii_case("cli-manager-web-daemon")
    })
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
    fn web_output_wakes_silent_socket_without_receive_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            let message = socket.read().unwrap();
            assert!(message.into_text().unwrap().contains("heartbeat"));
            Instant::now()
        });
        let (socket, _) = tungstenite::connect(format!("ws://{address}")).unwrap();
        let wake = Arc::new(tokio::sync::Notify::new());
        let mut socket = EventDeviceSocket::new(socket, wake.clone()).unwrap();
        let producer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(40));
            let queued = Instant::now();
            wake.notify_one();
            queued
        });
        assert!(
            matches!(socket.read(), Err(WsError::Io(err)) if err.kind() == std::io::ErrorKind::WouldBlock)
        );
        socket
            .send_frame(&DeviceToServerFrame::Heartbeat { sequence: 1 })
            .unwrap();
        let latency = server
            .join()
            .unwrap()
            .duration_since(producer.join().unwrap());
        eprintln!("silent-server output latency: {latency:?}");
        assert!(latency < Duration::from_millis(250), "{latency:?}");
    }

    #[test]
    fn web_control_reuses_one_authenticated_socket_for_multiple_requests() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let info = control_info(listener.local_addr().unwrap().port());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            assert!(matches!(
                serde_json::from_str::<Request>(&read_line(&mut reader).unwrap()).unwrap(),
                Request::Auth { .. }
            ));
            for _ in 0..3 {
                assert!(matches!(
                    serde_json::from_str::<Request>(&read_line(&mut reader).unwrap()).unwrap(),
                    Request::GetStatus
                ));
                write_response(&mut stream, Some(Value::Bool(true)), None).unwrap();
            }
        });
        for _ in 0..3 {
            assert!(request_with_info::<bool>(Request::GetStatus, false, &info).unwrap());
        }
        server.join().unwrap();
    }

    #[test]
    fn trusted_network_requires_explicit_opt_in_for_ip_and_domain() {
        for endpoint in [
            "http://192.168.1.20:9090",
            "ws://100.95.251.17:9090",
            "http://desktop.internal:9090",
            "http://[fd00::1]:9090",
        ] {
            assert!(normalize_device_url(endpoint, false).is_err(), "{endpoint}");
            assert!(normalize_device_url(endpoint, true)
                .unwrap()
                .ends_with("/ws/device"));
        }
        assert_eq!(
            normalize_device_url("http://[::1]:9090", false).unwrap(),
            "ws://[::1]:9090/ws/device"
        );
        assert_eq!(
            normalize_device_url("https://cli.example.com", false).unwrap(),
            "wss://cli.example.com/ws/device"
        );
        for endpoint in [
            "ftp://example.com",
            "http://user:secret@example.com",
            "http://example.com?token=secret",
            "http://example.com/#secret",
        ] {
            assert!(normalize_device_url(endpoint, true).is_err());
        }
    }

    #[test]
    fn public_browser_origin_is_independent_and_bounded() {
        assert_eq!(
            normalize_public_url("https://cli.example.com", false).unwrap(),
            "https://cli.example.com/"
        );
        assert_eq!(
            normalize_public_url("http://desktop.internal:9090", true).unwrap(),
            "http://desktop.internal:9090/"
        );
        assert!(normalize_public_url("http://desktop.internal:9090", false).is_err());
        for endpoint in [
            "ws://example.com",
            "https://example.com/path",
            "https://example.com?x=1",
            "https://user:pass@example.com",
            "https://example.com/#secret",
        ] {
            assert!(normalize_public_url(endpoint, true).is_err());
        }
        assert_eq!(normalize_public_url("", false).unwrap(), "");
    }

    fn control_info(port: u16) -> DaemonInfo {
        DaemonInfo {
            port,
            token: "control-test-token".into(),
            pid: std::process::id(),
            version: env!("CARGO_PKG_VERSION").into(),
            protocol_version: PROTOCOL_VERSION,
        }
    }

    #[test]
    fn web_control_closed_port_is_bounded_and_cooled_down() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let info = control_info(listener.local_addr().unwrap().port());
        drop(listener);
        let connector = ControlConnector::default();
        let started = Instant::now();
        assert!(connector.connect(&info).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        let cooled = Instant::now();
        for _ in 0..100 {
            assert!(connector.connect(&info).unwrap_err().contains("cooldown"));
        }
        assert!(cooled.elapsed() < Duration::from_millis(200));
        // The same endpoint can recover after the retry deadline.
        let _listener = TcpListener::bind(("127.0.0.1", info.port)).unwrap();
        connector.failed.lock().unwrap().as_mut().unwrap().1 = Instant::now();
        assert!(connector.connect(&info).is_ok());
    }

    #[test]
    fn web_control_new_discovery_bypasses_old_connection_failure() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut info = control_info(listener.local_addr().unwrap().port());
        drop(listener);
        let connector = ControlConnector::default();
        assert!(connector.connect(&info).is_err());
        let _listener = TcpListener::bind(("127.0.0.1", info.port)).unwrap();
        assert!(connector.connect(&info).is_err());
        info.token = "replacement-daemon-token".into();
        assert!(connector.connect(&info).is_ok());
    }

    #[test]
    fn web_control_auth_and_request_roundtrip_still_work() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let info = control_info(listener.local_addr().unwrap().port());
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let auth: Value = serde_json::from_str(&read_line(&mut reader).unwrap()).unwrap();
            assert_eq!(auth["token"], "control-test-token");
            assert!(matches!(
                serde_json::from_str::<Request>(&read_line(&mut reader).unwrap()).unwrap(),
                Request::GetStatus
            ));
            write_response(&mut stream, Some(Value::Bool(true)), None).unwrap();
        });
        assert!(request_with_info::<bool>(Request::GetStatus, false, &info).unwrap());
        worker.join().unwrap();
    }

    #[test]
    fn web_control_dead_or_reused_pid_is_stale() {
        let mut info = control_info(1);
        // Our test process is alive but is not the Web daemon executable.
        assert!(discovery_process_is_stale(&info));
        info.pid = u32::MAX - 1;
        assert!(discovery_process_is_stale(&info));
    }

    #[test]
    fn terminal_output_rejection_keeps_device_connected_but_auth_errors_fail() {
        let state = DaemonState::new(
            PathBuf::new(),
            DaemonInfo {
                port: 0,
                token: String::new(),
                pid: 0,
                version: String::new(),
                protocol_version: PROTOCOL_VERSION,
            },
        );
        state.generation.store(1, Ordering::SeqCst);
        {
            let mut runtime = state.runtime.lock().unwrap();
            runtime.running = true;
            runtime.connected = true;
            runtime.paired = true;
        }
        state
            .handle_server_frame(
                ServerToDeviceFrame::Error {
                    code: "invalid_terminal_output".into(),
                    message: "encoded_batch_too_large".into(),
                },
                1,
            )
            .unwrap();
        {
            let runtime = state.runtime.lock().unwrap();
            assert!(runtime.connected && runtime.paired && runtime.running);
            assert!(runtime
                .last_error
                .as_deref()
                .unwrap()
                .contains("encoded_batch_too_large"));
        }
        assert!(state
            .handle_server_frame(
                ServerToDeviceFrame::Error {
                    code: "invalid_device_token".into(),
                    message: "authentication failed".into(),
                },
                1
            )
            .is_err());
        state.stop();
        state
            .handle_server_frame(
                ServerToDeviceFrame::Error {
                    code: "invalid_terminal_output".into(),
                    message: "stale error".into(),
                },
                1,
            )
            .unwrap();
        assert!(!state
            .runtime
            .lock()
            .unwrap()
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("stale"));
    }

    #[test]
    fn stalled_handshake_times_out() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            let _ = wait.recv_timeout(Duration::from_secs(3));
        });
        let control = DeviceConnectionControl::default();
        let generation = AtomicU64::new(1);
        let started = Instant::now();
        let result = control.connect_with_timeout(
            &format!("ws://{address}/ws/device"),
            &generation,
            1,
            Duration::from_millis(150),
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        control.cancel();
        let _ = release.send(());
        server.join().unwrap();
    }

    #[test]
    fn stop_interrupts_handshake_and_next_generation_reconnects() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted, wait_accepted) = std::sync::mpsc::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (first, _) = listener.accept().unwrap();
            accepted.send(()).unwrap();
            let _ = wait_release.recv_timeout(Duration::from_secs(3));
            drop(first);
            let (second, _) = listener.accept().unwrap();
            let _socket = tungstenite::accept(second).unwrap();
        });
        let control = Arc::new(DeviceConnectionControl::default());
        let generation = Arc::new(AtomicU64::new(1));
        let worker_control = control.clone();
        let worker_generation = generation.clone();
        let (finished, wait_finished) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let _attempt = worker_control.begin().unwrap();
            let result =
                worker_control.connect(&format!("ws://{address}/ws/device"), &worker_generation, 1);
            finished.send(result.is_err()).unwrap();
        });
        wait_accepted.recv_timeout(Duration::from_secs(2)).unwrap();
        generation.store(2, Ordering::SeqCst);
        control.cancel();
        assert!(wait_finished.recv_timeout(Duration::from_secs(2)).unwrap());
        worker.join().unwrap();
        release.send(()).unwrap();
        let _attempt = control.begin().unwrap();
        let socket = control
            .connect(&format!("ws://{address}/ws/device"), &generation, 2)
            .unwrap();
        assert!(socket.can_write());
        server.join().unwrap();
    }

    #[test]
    fn retired_generation_cannot_restore_connected_status() {
        let state = DaemonState::new(
            PathBuf::new(),
            DaemonInfo {
                port: 0,
                token: String::new(),
                pid: 0,
                version: String::new(),
                protocol_version: PROTOCOL_VERSION,
            },
        );
        state.runtime.lock().unwrap().running = true;
        state.generation.store(1, Ordering::SeqCst);
        state.stop();
        let frame = serde_json::from_value(
            serde_json::json!({"type":"hello_ok","paired":true,"serverTime":0}),
        )
        .unwrap();
        state.handle_server_frame(frame, 1).unwrap();
        let runtime = state.runtime.lock().unwrap();
        assert!(!runtime.running);
        assert!(!runtime.connected);
        assert!(!runtime.paired);
    }

    #[test]
    fn local_protocol_uses_auth_first_and_camel_case_payloads() {
        let auth = serde_json::to_value(Request::Auth {
            token: "test-token".into(),
            client_version: "1.3.9".into(),
            protocol_version: PROTOCOL_VERSION,
        })
        .unwrap();
        assert_eq!(auth["protocol_version"], PROTOCOL_VERSION);
        let legacy: Request = serde_json::from_value(
            serde_json::json!({"type":"auth", "token":"test-token", "client_version":"1.3.9"}),
        )
        .unwrap();
        assert!(matches!(
            legacy,
            Request::Auth {
                protocol_version: 0,
                ..
            }
        ));
        let request = serde_json::to_value(Request::OperationRunning {
            operation_id: "op-1".into(),
        })
        .unwrap();
        assert_eq!(request["type"], "operation_running");
        assert_eq!(request["operation_id"], "op-1");
    }

    #[test]
    fn legacy_upgrade_auth_uses_the_old_protocol_only_for_inspection_and_shutdown() {
        for protocol in 1..PROTOCOL_VERSION {
            assert_eq!(control_protocol_version(protocol, true).unwrap(), protocol);
            assert!(control_protocol_version(protocol, false).is_err());
        }
        assert!(control_protocol_version(0, true).is_err());
        assert!(control_protocol_version(PROTOCOL_VERSION + 1, true).is_err());
        assert!(upgrade_control::<()>(Request::Start)
            .unwrap_err()
            .contains("forbidden"));
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
                trusted_network: false,
                public_access_url: String::new(),
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
