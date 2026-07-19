//! daemon TCP 服务：鉴权、帧分发、PTY 会话托管、ring buffer 回放、空闲自灭。
//!
//! 增量 2：接入 `PtyManager`（经 `PtyEventSink` 解耦）。输出帧在 PTY reader
//! 线程已按 ANSI/UTF-8 安全边界切好，本层只整帧存储/透传（契约禁止再分片）。
//! 增量 3 待办：Windows Job Object 兜底、hook 上报转发、exited 会话宽限自灭。

use super::discovery::{remove_daemon_info, write_daemon_info_exclusive, DaemonInfo};
use super::protocol::{
    decode_binary_terminal_frame, decode_client_frame, encode_binary_terminal_frame, encode_frame,
    supported_features, ClientFrame, DaemonFrame, ProcessTraits, ProtocolError, ReplayEntry,
    SessionMeta, SessionStatusInfo, BINARY_KIND_CHECKPOINT, BINARY_KIND_INPUT, BINARY_KIND_OUTPUT,
    BINARY_KIND_REPLAY, BINARY_KIND_REPLAY_RESET, BINARY_PROTOCOL_VERSION,
    CONTROL_PROTOCOL_VERSION, MAX_FRAME_BYTES,
};
use crate::claude_hook::{spawn_hook_listener, HookPayloadSink};
use crate::pty::manager::{PtyEventSink, PtyManager, PtyProcessStatus};
use crate::ssh_launch::SshLaunchPlan;
use crate::third_party_notification::DispatcherHandle;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::Role;
use tungstenite::{accept_hdr, Message, WebSocket};

/// 无会话且无客户端持续该时长后自灭（契约：10 分钟）。
pub const IDLE_EXIT_AFTER: Duration = Duration::from_secs(10 * 60);
/// 空闲 watchdog 检查间隔。
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// 单会话 ring buffer 字节上限（契约：2 MiB）。
pub const SESSION_BUFFER_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const SESSION_SPOOL_MAX_BYTES: usize = 10 * 1024 * 1024;
/// 全部会话 buffer 总内存上限（契约：128 MiB）。
pub const TOTAL_BUFFER_MAX_BYTES: usize = 128 * 1024 * 1024;
/// 会话数上限（契约：64）。
pub const MAX_SESSIONS: usize = 64;
/// 无客户端时缓存的 hook 上报条数上限（契约：200，attach 后补发）。
pub const HOOK_CACHE_MAX: usize = 200;
const OUTPUT_BUFFERING_DURATION: Duration = Duration::from_millis(5);
const OUTPUT_BUFFERING_MAX_BYTES: usize = 256 * 1024;
const CLIENT_OUTPUT_QUEUE_MAX_BYTES: usize = 2 * 1024 * 1024;
const CLIENT_CONTROL_QUEUE_MAX_FRAMES: usize = 256;

struct ReplayFrame {
    cols: u16,
    rows: u16,
    sequence: u64,
    data: Vec<u8>,
}

/// 按整帧存储的回放缓冲：每帧都是 PTY reader 切好的 ANSI 安全块，
/// 超限时从头丢弃整帧，天然保持边界安全（契约）。
struct SessionBuffer {
    frames: VecDeque<ReplayFrame>,
    total_bytes: usize,
    spool_path: Option<PathBuf>,
    spool_bytes: usize,
    checkpoint: Option<ReplayFrame>,
    truncated: bool,
}

impl SessionBuffer {
    #[cfg(test)]
    fn new() -> Self {
        Self::with_spool(None)
    }

    fn with_spool(spool_path: Option<PathBuf>) -> Self {
        Self {
            frames: VecDeque::new(),
            total_bytes: 0,
            spool_path,
            spool_bytes: 0,
            checkpoint: None,
            truncated: false,
        }
    }

    fn push_output(&mut self, cols: u16, rows: u16, sequence: u64, data: &[u8]) {
        self.total_bytes += data.len();
        self.frames.push_back(ReplayFrame {
            cols,
            rows,
            sequence,
            data: data.to_vec(),
        });
        while self.total_bytes > SESSION_BUFFER_MAX_BYTES {
            let Some(front) = self.frames.pop_front() else {
                break;
            };
            if let Err(err) = self.append_spooled_frame(&front) {
                log::warn!("daemon session spool write failed, retaining frame in memory: {err}");
                self.frames.push_front(front);
                break;
            }
            self.total_bytes = self.total_bytes.saturating_sub(front.data.len());
            self.enforce_spool_cap();
        }
    }

    fn push_resize(&mut self, cols: u16, rows: u16, sequence: u64) {
        if let Some(last) = self.frames.back_mut() {
            if last.data.is_empty() {
                last.cols = cols;
                last.rows = rows;
                last.sequence = sequence;
                return;
            }
        }
        self.frames.push_back(ReplayFrame {
            cols,
            rows,
            sequence,
            data: Vec::new(),
        });
    }

    fn replay_entries(&self) -> Vec<ReplayEntry> {
        self.checkpoint
            .iter()
            .map(|frame| ReplayFrame {
                cols: frame.cols,
                rows: frame.rows,
                sequence: frame.sequence,
                data: frame.data.clone(),
            })
            .chain(self.read_spooled_frames())
            .chain(self.frames.iter().map(|frame| ReplayFrame {
                cols: frame.cols,
                rows: frame.rows,
                sequence: frame.sequence,
                data: frame.data.clone(),
            }))
            .map(|frame| ReplayEntry {
                cols: frame.cols,
                rows: frame.rows,
                sequence: frame.sequence,
                data_base64: STANDARD.encode(frame.data),
            })
            .collect()
    }

    fn replay_entries_after(&self, after_sequence: Option<u64>) -> Vec<ReplayEntry> {
        let after_sequence = after_sequence.unwrap_or(0);
        self.replay_entries()
            .into_iter()
            .filter(|entry| entry.sequence > after_sequence)
            .collect()
    }

    fn oldest_sequence(&self) -> Option<u64> {
        self.checkpoint
            .as_ref()
            .map(|frame| frame.sequence)
            .or_else(|| {
                self.read_spooled_frames()
                    .first()
                    .map(|frame| frame.sequence)
            })
            .or_else(|| self.frames.front().map(|frame| frame.sequence))
    }

    fn accept_checkpoint(
        &mut self,
        cols: u16,
        rows: u16,
        sequence: u64,
        data: Vec<u8>,
    ) -> Result<(), String> {
        if self
            .checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.sequence >= sequence)
        {
            return Ok(());
        }
        self.checkpoint = Some(ReplayFrame {
            cols,
            rows,
            sequence,
            data,
        });
        while self
            .frames
            .front()
            .is_some_and(|frame| frame.sequence <= sequence)
        {
            if let Some(frame) = self.frames.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(frame.data.len());
            }
        }
        let retained: Vec<ReplayFrame> = self
            .read_spooled_frames()
            .into_iter()
            .filter(|frame| frame.sequence > sequence)
            .collect();
        self.write_spooled_frames(&retained)
    }

    fn replay_available(&self) -> bool {
        self.checkpoint.is_some() || self.spool_bytes > 0 || !self.frames.is_empty()
    }

    fn append_spooled_frame(&self, frame: &ReplayFrame) -> Result<(), String> {
        let Some(path) = self.spool_path.as_ref() else {
            return Err("spool path unavailable".to_string());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| err.to_string())?;
        file.write_all(&frame.cols.to_be_bytes())
            .and_then(|_| file.write_all(&frame.rows.to_be_bytes()))
            .and_then(|_| file.write_all(&frame.sequence.to_be_bytes()))
            .and_then(|_| file.write_all(&(frame.data.len() as u32).to_be_bytes()))
            .and_then(|_| file.write_all(&frame.data))
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn write_spooled_frames(&mut self, frames: &[ReplayFrame]) -> Result<(), String> {
        let Some(path) = self.spool_path.as_ref() else {
            self.spool_bytes = 0;
            return Ok(());
        };
        if frames.is_empty() {
            let _ = std::fs::remove_file(path);
            self.spool_bytes = 0;
            return Ok(());
        }
        let temp_path = path.with_extension("tmp");
        let mut file = File::create(&temp_path).map_err(|err| err.to_string())?;
        let mut bytes = 0usize;
        for frame in frames {
            file.write_all(&frame.cols.to_be_bytes())
                .and_then(|_| file.write_all(&frame.rows.to_be_bytes()))
                .and_then(|_| file.write_all(&frame.sequence.to_be_bytes()))
                .and_then(|_| file.write_all(&(frame.data.len() as u32).to_be_bytes()))
                .and_then(|_| file.write_all(&frame.data))
                .map_err(|err| err.to_string())?;
            bytes = bytes.saturating_add(16 + frame.data.len());
        }
        file.flush().map_err(|err| err.to_string())?;
        if path.exists() {
            std::fs::remove_file(path).map_err(|err| err.to_string())?;
        }
        std::fs::rename(&temp_path, path).map_err(|err| err.to_string())?;
        self.spool_bytes = bytes;
        Ok(())
    }

    fn enforce_spool_cap(&mut self) {
        let actual = self
            .spool_path
            .as_ref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|meta| meta.len() as usize)
            .unwrap_or(0);
        self.spool_bytes = actual;
        if actual <= SESSION_SPOOL_MAX_BYTES {
            return;
        }
        let mut frames = self.read_spooled_frames();
        let mut bytes = frames
            .iter()
            .map(|frame| 16 + frame.data.len())
            .sum::<usize>();
        while bytes > SESSION_SPOOL_MAX_BYTES && !frames.is_empty() {
            let removed = frames.remove(0);
            bytes = bytes.saturating_sub(16 + removed.data.len());
            self.truncated = true;
        }
        if let Err(err) = self.write_spooled_frames(&frames) {
            log::warn!("daemon session spool compaction failed: {err}");
        }
    }

    fn read_spooled_frames(&self) -> Vec<ReplayFrame> {
        let Some(path) = self.spool_path.as_ref() else {
            return Vec::new();
        };
        let Ok(mut file) = File::open(path) else {
            return Vec::new();
        };
        let mut frames = Vec::new();
        loop {
            let mut header = [0u8; 16];
            match file.read_exact(&mut header) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(err) => {
                    log::warn!("daemon session spool read failed: {err}");
                    break;
                }
            }
            let cols = u16::from_be_bytes([header[0], header[1]]);
            let rows = u16::from_be_bytes([header[2], header[3]]);
            let sequence = u64::from_be_bytes(header[4..12].try_into().unwrap());
            let data_len = u32::from_be_bytes(header[12..16].try_into().unwrap()) as usize;
            if data_len > MAX_FRAME_BYTES {
                log::warn!("daemon session spool frame exceeds protocol limit: {data_len}");
                break;
            }
            let mut data = vec![0u8; data_len];
            if let Err(err) = file.read_exact(&mut data) {
                log::warn!("daemon session spool payload read failed: {err}");
                break;
            }
            frames.push(ReplayFrame {
                cols,
                rows,
                sequence,
                data,
            });
        }
        frames
    }
}

impl Drop for SessionBuffer {
    fn drop(&mut self) {
        if let Some(path) = self.spool_path.as_ref() {
            let _ = std::fs::remove_file(path);
        }
    }
}

enum ClientTransport {
    Ndjson(Mutex<TcpStream>),
    WebSocket(Mutex<WebSocket<TcpStream>>),
}

impl ClientTransport {
    fn send_frame(&self, frame: &DaemonFrame) -> Result<(), String> {
        match self {
            Self::Ndjson(writer) => writer
                .lock()
                .map_err(|_| "writer poisoned".to_string())?
                .write_all(encode_frame(frame).as_bytes())
                .map_err(|err| err.to_string()),
            Self::WebSocket(socket) => {
                let mut socket = socket
                    .lock()
                    .map_err(|_| "websocket writer poisoned".to_string())?;
                match frame {
                    DaemonFrame::Output {
                        session_id,
                        sequence,
                        cols,
                        rows,
                        data_base64,
                    } => {
                        let data = STANDARD
                            .decode(data_base64)
                            .map_err(|err| err.to_string())?;
                        let binary = encode_binary_terminal_frame(
                            BINARY_KIND_OUTPUT,
                            session_id,
                            *sequence,
                            *cols,
                            *rows,
                            &data,
                        )?;
                        socket
                            .send(Message::Binary(binary.into()))
                            .map_err(|err| err.to_string())
                    }
                    DaemonFrame::Attached {
                        id,
                        session_id,
                        replay,
                        latest_sequence,
                        meta,
                        replay_reset,
                        replay_truncated,
                        oldest_sequence,
                        ..
                    } => {
                        if *replay_reset {
                            let reset = encode_binary_terminal_frame(
                                BINARY_KIND_REPLAY_RESET,
                                session_id,
                                0,
                                replay.first().map(|entry| entry.cols).unwrap_or(80),
                                replay.first().map(|entry| entry.rows).unwrap_or(24),
                                &[],
                            )?;
                            socket
                                .send(Message::Binary(reset.into()))
                                .map_err(|err| err.to_string())?;
                        }
                        for entry in replay {
                            let data = STANDARD
                                .decode(&entry.data_base64)
                                .map_err(|err| err.to_string())?;
                            let binary = encode_binary_terminal_frame(
                                BINARY_KIND_REPLAY,
                                session_id,
                                entry.sequence,
                                entry.cols,
                                entry.rows,
                                &data,
                            )?;
                            socket
                                .send(Message::Binary(binary.into()))
                                .map_err(|err| err.to_string())?;
                        }
                        let control = DaemonFrame::Attached {
                            id: *id,
                            session_id: session_id.clone(),
                            replay_base64: String::new(),
                            replay: Vec::new(),
                            latest_sequence: *latest_sequence,
                            meta: meta.clone(),
                            replay_reset: *replay_reset,
                            replay_truncated: *replay_truncated,
                            oldest_sequence: *oldest_sequence,
                        };
                        socket
                            .send(Message::Text(
                                encode_frame(&control).trim_end().to_string().into(),
                            ))
                            .map_err(|err| err.to_string())
                    }
                    _ => socket
                        .send(Message::Text(
                            encode_frame(frame).trim_end().to_string().into(),
                        ))
                        .map_err(|err| err.to_string()),
                }
            }
        }
    }

    fn close(&self) {
        match self {
            Self::Ndjson(stream) => {
                if let Ok(stream) = stream.lock() {
                    let _ = stream.shutdown(Shutdown::Both);
                }
            }
            Self::WebSocket(socket) => {
                if let Ok(mut socket) = socket.lock() {
                    let _ = socket.close(None);
                    let _ = socket.get_mut().shutdown(Shutdown::Both);
                }
            }
        }
    }
}

struct ClientWriterState {
    control: VecDeque<DaemonFrame>,
    output: VecDeque<DaemonFrame>,
    output_bytes: usize,
    closed: bool,
}

impl ClientWriterState {
    fn pop_next(&mut self) -> Option<DaemonFrame> {
        if let Some(frame) = self.control.pop_front() {
            return Some(frame);
        }
        let frame = self.output.pop_front()?;
        self.output_bytes = self
            .output_bytes
            .saturating_sub(frame_payload_bytes(&frame));
        Some(frame)
    }
}

struct ClientWriter {
    shared: Arc<(Mutex<ClientWriterState>, Condvar)>,
}

impl ClientWriter {
    fn new(transport: ClientTransport) -> Arc<Self> {
        let shared = Arc::new((
            Mutex::new(ClientWriterState {
                control: VecDeque::new(),
                output: VecDeque::new(),
                output_bytes: 0,
                closed: false,
            }),
            Condvar::new(),
        ));
        let thread_shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            loop {
                let frame = {
                    let (lock, changed) = &*thread_shared;
                    let Ok(mut state) = lock.lock() else {
                        break;
                    };
                    while !state.closed && state.control.is_empty() && state.output.is_empty() {
                        let Ok(next) = changed.wait(state) else {
                            return;
                        };
                        state = next;
                    }
                    if state.closed {
                        None
                    } else {
                        state.pop_next()
                    }
                };
                let Some(frame) = frame else {
                    break;
                };
                if let Err(err) = transport.send_frame(&frame) {
                    log::debug!("daemon client writer stopped: {err}");
                    break;
                }
            }
            transport.close();
        });
        Arc::new(Self { shared })
    }

    fn send_frame(&self, frame: &DaemonFrame) -> Result<(), String> {
        if matches!(frame, DaemonFrame::Output { .. }) {
            self.send_output(frame)
        } else {
            self.send_control(frame)
        }
    }

    fn send_control(&self, frame: &DaemonFrame) -> Result<(), String> {
        let (lock, changed) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "client writer unavailable".to_string())?;
        if state.closed || state.control.len() >= CLIENT_CONTROL_QUEUE_MAX_FRAMES {
            state.closed = true;
            changed.notify_all();
            return Err("client control queue full".to_string());
        }
        state.control.push_back(frame.clone());
        changed.notify_one();
        Ok(())
    }

    fn send_output(&self, frame: &DaemonFrame) -> Result<(), String> {
        let bytes = frame_payload_bytes(frame);
        let (lock, changed) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "client writer unavailable".to_string())?;
        if state.closed || state.output_bytes.saturating_add(bytes) > CLIENT_OUTPUT_QUEUE_MAX_BYTES
        {
            state.closed = true;
            changed.notify_all();
            return Err("client output queue full".to_string());
        }
        state.output_bytes = state.output_bytes.saturating_add(bytes);
        state.output.push_back(frame.clone());
        changed.notify_one();
        Ok(())
    }

    fn close(&self) {
        let (lock, changed) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            state.closed = true;
            changed.notify_all();
        }
    }
}

fn frame_payload_bytes(frame: &DaemonFrame) -> usize {
    match frame {
        DaemonFrame::Output { data_base64, .. } => data_base64.len(),
        _ => 0,
    }
}

struct ClientHandle {
    writer: Arc<ClientWriter>,
    attached: HashSet<String>,
    unacknowledged_chars: HashMap<String, usize>,
    last_sent_sequence: HashMap<String, u64>,
    last_acknowledged_sequence: HashMap<String, u64>,
    attaching: HashMap<String, Vec<DaemonFrame>>,
}

struct SessionEntry {
    meta: SessionMeta,
    buffer: SessionBuffer,
    cols: u16,
    rows: u16,
    next_sequence: u64,
}

type SharedSession = Arc<Mutex<SessionEntry>>;

/// daemon 共享宿主：PTY 管理器 + 会话表 + 客户端注册表。
pub struct DaemonHost {
    pty: PtyManager,
    sessions: Mutex<HashMap<String, SharedSession>>,
    clients: Mutex<HashMap<u64, ClientHandle>>,
    last_idle_since: Mutex<Instant>,
    /// 无客户端期间收到的 hook 上报缓存，客户端连上后补发（契约）。
    hook_cache: Mutex<VecDeque<serde_json::Value>>,
    spool_dir: PathBuf,
}

impl DaemonHost {
    #[cfg(test)]
    fn new() -> Self {
        Self::with_spool_dir(std::env::temp_dir().join(format!(
            "cli-manager-daemon-spool-test-{}",
            uuid::Uuid::new_v4()
        )))
    }

    fn with_spool_dir(spool_dir: PathBuf) -> Self {
        Self {
            pty: PtyManager::new(),
            sessions: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            last_idle_since: Mutex::new(Instant::now()),
            hook_cache: Mutex::new(VecDeque::new()),
            spool_dir,
        }
    }

    fn session_spool_path(&self, session_id: &str) -> PathBuf {
        self.spool_dir.join(format!("{session_id}.bin"))
    }

    fn get_session(&self, session_id: &str) -> Option<SharedSession> {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).cloned())
    }

    #[cfg(test)]
    fn reserve_session(
        &self,
        session_id: &str,
        cwd: Option<String>,
        shell: Option<String>,
    ) -> Result<(), &'static str> {
        self.reserve_session_with_launch(session_id, cwd, shell, None)
    }

    fn reserve_session_with_launch(
        &self,
        session_id: &str,
        cwd: Option<String>,
        shell: Option<String>,
        ssh_launch: Option<&SshLaunchPlan>,
    ) -> Result<(), &'static str> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "daemon state unavailable")?;
        if sessions.contains_key(session_id) {
            return Err("session already exists");
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err("session limit reached");
        }
        sessions.insert(
            session_id.to_string(),
            Arc::new(Mutex::new(SessionEntry {
                meta: SessionMeta {
                    session_id: session_id.to_string(),
                    cwd,
                    shell,
                    environment_type: ssh_launch.map(|_| "ssh".to_string()),
                    ssh_host_id: ssh_launch.map(|plan| plan.host_id.clone()),
                    remote_path: ssh_launch.map(|plan| plan.remote_path.clone()),
                    alive: true,
                    task_status: None,
                    task_updated_at_ms: None,
                    created_at_ms: now_ms(),
                    process_traits: Some(ProcessTraits::current_platform(
                        std::env::var_os("CLI_MANAGER_CONPTY_DLL_PATH").is_some(),
                    )),
                    replay_available: false,
                    replay_truncated: false,
                },
                buffer: SessionBuffer::with_spool(Some(self.session_spool_path(session_id))),
                cols: 80,
                rows: 24,
                next_sequence: 1,
            })),
        );
        Ok(())
    }

    /// hook 上报广播给全部客户端；无客户端时进缓存（有界）。
    fn broadcast_hook(&self, payload: serde_json::Value) {
        let frame = DaemonFrame::HookReport {
            payload: payload.clone(),
        };
        let Ok(clients) = self.clients.lock() else {
            return;
        };
        if clients.is_empty() {
            drop(clients);
            if let Ok(mut cache) = self.hook_cache.lock() {
                cache.push_back(payload);
                while cache.len() > HOOK_CACHE_MAX {
                    cache.pop_front();
                }
            }
            return;
        }
        for client in clients.values() {
            let _ = client.writer.send_frame(&frame);
        }
    }

    fn update_task_status_from_hook(&self, payload: &serde_json::Value) {
        let Some(session_id) = payload
            .get("tabId")
            .or_else(|| payload.get("tab_id"))
            .and_then(|value| value.as_str())
        else {
            return;
        };
        let Some(event) = payload.get("event").and_then(|value| value.as_str()) else {
            return;
        };
        let Some(task_status) = map_hook_event_to_task_status(event) else {
            return;
        };
        let updated_at_ms = now_ms();
        if let Some(session) = self.get_session(session_id) {
            if let Ok(mut entry) = session.lock() {
                entry.meta.task_status = Some(task_status.to_string());
                entry.meta.task_updated_at_ms = Some(updated_at_ms);
                log::debug!(
                    "daemon task status updated: session_id={}, event={}, status={}",
                    session_id,
                    event,
                    task_status
                );
            }
        }
    }

    /// 新客户端连上后补发缓存的 hook 上报。
    fn flush_hook_cache_to(&self, writer: &Arc<ClientWriter>) {
        let cached: Vec<serde_json::Value> = match self.hook_cache.lock() {
            Ok(mut cache) => cache.drain(..).collect(),
            Err(_) => return,
        };
        for payload in cached {
            let _ = writer.send_frame(&DaemonFrame::HookReport { payload });
        }
    }

    fn alive_session_count(&self) -> usize {
        let sessions = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        sessions
            .into_iter()
            .filter(|session| {
                session
                    .lock()
                    .map(|entry| entry.meta.alive)
                    .unwrap_or(false)
            })
            .count()
    }

    fn client_count(&self) -> usize {
        self.clients.lock().map(|c| c.len()).unwrap_or(0)
    }

    /// 总 buffer 超限时从最旧的 exited 会话开始整会话丢弃（契约资源上限）。
    fn enforce_total_buffer_cap(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let mut total: usize = sessions
            .values()
            .filter_map(|session| session.lock().ok().map(|entry| entry.buffer.total_bytes))
            .sum();
        if total <= TOTAL_BUFFER_MAX_BYTES {
            return;
        }
        let mut exited: Vec<(String, u64, usize)> = sessions
            .iter()
            .filter_map(|(id, session)| {
                let entry = session.lock().ok()?;
                (!entry.meta.alive).then(|| {
                    (
                        id.clone(),
                        entry.meta.created_at_ms,
                        entry.buffer.total_bytes,
                    )
                })
            })
            .collect();
        exited.sort_by_key(|(_, created, _)| *created);
        for (id, _, bytes) in exited {
            if total <= TOTAL_BUFFER_MAX_BYTES {
                break;
            }
            sessions.remove(&id);
            total -= bytes;
            log::warn!("daemon dropped exited session buffer to enforce cap: id={id}");
        }
    }

    /// 向所有 attach 了该会话的客户端推送一帧；写失败的客户端跳过（由其读线程负责回收）。
    fn push_to_attached(&self, session_id: &str, frame: &DaemonFrame) {
        let Ok(mut clients) = self.clients.lock() else {
            return;
        };
        for client in clients.values_mut() {
            if !client.attached.contains(session_id) {
                continue;
            }
            if let Some(buffered) = client.attaching.get_mut(session_id) {
                buffered.push(frame.clone());
                continue;
            }
            if client.writer.send_frame(frame).is_err() {
                client.writer.close();
            }
        }
    }

    fn push_output_to_attached(
        &self,
        session_id: &str,
        sequence: u64,
        char_count: usize,
        frame: &DaemonFrame,
    ) {
        let Ok(mut clients) = self.clients.lock() else {
            return;
        };
        for client in clients.values_mut() {
            if !client.attached.contains(session_id) {
                continue;
            }
            *client
                .unacknowledged_chars
                .entry(session_id.to_string())
                .or_default() += char_count;
            client
                .last_sent_sequence
                .insert(session_id.to_string(), sequence);
            if let Some(buffered) = client.attaching.get_mut(session_id) {
                buffered.push(frame.clone());
                let buffered_bytes = buffered.iter().map(frame_payload_bytes).sum::<usize>();
                if buffered_bytes > CLIENT_OUTPUT_QUEUE_MAX_BYTES {
                    client.writer.close();
                    client.attached.remove(session_id);
                }
                continue;
            }
            if client.writer.send_frame(frame).is_err() {
                client.writer.close();
                client.attached.remove(session_id);
                client.unacknowledged_chars.remove(session_id);
                client.last_sent_sequence.remove(session_id);
                client.last_acknowledged_sequence.remove(session_id);
            }
        }
    }

    fn complete_attach(&self, client_id: u64, session_id: &str) {
        let Ok(mut clients) = self.clients.lock() else {
            return;
        };
        let Some(client) = clients.get_mut(&client_id) else {
            return;
        };
        let Some(buffered) = client.attaching.remove(session_id) else {
            return;
        };
        for frame in buffered {
            if client.writer.send_frame(&frame).is_err() {
                client.writer.close();
                client.attached.remove(session_id);
                break;
            }
        }
    }

    fn acknowledge_output(
        &self,
        client_id: u64,
        session_id: &str,
        sequence: u64,
        char_count: usize,
    ) {
        if let Ok(mut clients) = self.clients.lock() {
            if let Some(client) = clients.get_mut(&client_id) {
                let last_sent = client
                    .last_sent_sequence
                    .get(session_id)
                    .copied()
                    .unwrap_or(0);
                let last_acknowledged = client
                    .last_acknowledged_sequence
                    .get(session_id)
                    .copied()
                    .unwrap_or(0);
                if sequence > last_acknowledged && sequence <= last_sent {
                    let remaining = client
                        .unacknowledged_chars
                        .entry(session_id.to_string())
                        .or_default();
                    *remaining = remaining.saturating_sub(char_count);
                    client
                        .last_acknowledged_sequence
                        .insert(session_id.to_string(), sequence);
                }
            }
        }
    }

    fn detach_session_from_clients(&self, session_id: &str) {
        if let Ok(mut clients) = self.clients.lock() {
            for client in clients.values_mut() {
                client.attached.remove(session_id);
                client.unacknowledged_chars.remove(session_id);
                client.last_sent_sequence.remove(session_id);
                client.last_acknowledged_sequence.remove(session_id);
                client.attaching.remove(session_id);
            }
        }
    }

    fn detach_all_sessions_from_clients(&self) {
        if let Ok(mut clients) = self.clients.lock() {
            for client in clients.values_mut() {
                client.attached.clear();
                client.unacknowledged_chars.clear();
                client.last_sent_sequence.clear();
                client.last_acknowledged_sequence.clear();
                client.attaching.clear();
            }
        }
    }
}

/// daemon 侧 [`PtyEventSink`]：输出进 ring buffer 并推送给订阅客户端。
struct DaemonPtyEventSink {
    sender: SyncSender<DaemonPtyEvent>,
}

enum DaemonPtyEvent {
    Output(Vec<u8>),
    Status(PtyProcessStatus),
}

impl DaemonPtyEventSink {
    fn new(host: Arc<DaemonHost>, session_id: String) -> Self {
        let (sender, receiver) = sync_channel(1);
        std::thread::spawn(move || loop {
            let first = match receiver.recv() {
                Ok(event) => event,
                Err(_) => return,
            };
            match first {
                DaemonPtyEvent::Status(status) => {
                    emit_daemon_status(&host, &session_id, status);
                    return;
                }
                DaemonPtyEvent::Output(data) => {
                    let mut pending = data;
                    let deadline = Instant::now() + OUTPUT_BUFFERING_DURATION;
                    let mut final_status = None;
                    while pending.len() < OUTPUT_BUFFERING_MAX_BYTES {
                        let now = Instant::now();
                        if now >= deadline {
                            break;
                        }
                        match receiver.recv_timeout(deadline.saturating_duration_since(now)) {
                            Ok(DaemonPtyEvent::Output(data)) => pending.extend_from_slice(&data),
                            Ok(DaemonPtyEvent::Status(status)) => {
                                final_status = Some(status);
                                break;
                            }
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    }
                    emit_daemon_output(&host, &session_id, &pending);
                    if let Some(status) = final_status {
                        emit_daemon_status(&host, &session_id, status);
                        return;
                    }
                }
            }
        });
        Self { sender }
    }
}

impl PtyEventSink for DaemonPtyEventSink {
    fn on_output(&self, _session_id: &str, data: &[u8]) {
        let _ = self.sender.send(DaemonPtyEvent::Output(data.to_vec()));
    }

    fn on_status(&self, _session_id: &str, status: PtyProcessStatus) {
        let _ = self.sender.send(DaemonPtyEvent::Status(status));
    }
}

fn emit_daemon_output(host: &DaemonHost, session_id: &str, data: &[u8]) {
    let char_count = String::from_utf8_lossy(data).encode_utf16().count();
    let mut sequence = 0;
    let mut output_size = (80, 24);
    if let Some(session) = host.get_session(session_id) {
        if let Ok(mut entry) = session.lock() {
            sequence = entry.next_sequence;
            entry.next_sequence = entry.next_sequence.saturating_add(1);
            output_size = (entry.cols, entry.rows);
            entry
                .buffer
                .push_output(output_size.0, output_size.1, sequence, data);
            entry.meta.replay_available = entry.buffer.replay_available();
            entry.meta.replay_truncated = entry.buffer.truncated;
        }
    }
    if sequence == 0 {
        return;
    }
    host.push_output_to_attached(
        session_id,
        sequence,
        char_count,
        &DaemonFrame::Output {
            session_id: session_id.to_string(),
            sequence,
            cols: output_size.0,
            rows: output_size.1,
            data_base64: STANDARD.encode(data),
        },
    );
}

fn emit_daemon_status(host: &DaemonHost, session_id: &str, status: PtyProcessStatus) {
    if status.status == "running" {
        return;
    }
    if let Some(session) = host.get_session(session_id) {
        if let Ok(mut entry) = session.lock() {
            entry.meta.alive = false;
            if !matches!(entry.meta.task_status.as_deref(), Some("done" | "failed")) {
                entry.meta.task_status = Some(if status.status == "error" {
                    "failed".to_string()
                } else {
                    "done".to_string()
                });
                entry.meta.task_updated_at_ms = Some(now_ms());
            }
        }
    }
    host.push_to_attached(
        session_id,
        &DaemonFrame::Exit {
            session_id: session_id.to_string(),
            exit_code: status.exit_code,
        },
    );
    host.enforce_total_buffer_cap();
}

pub struct DaemonServer {
    host: Arc<DaemonHost>,
    next_client_id: AtomicU64,
    token: String,
    version: String,
    info_path: PathBuf,
}

pub struct DaemonServerConfig {
    pub info_path: PathBuf,
    pub version: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// sessionId 白名单校验：uuid/字母数字与连字符，防注入与异常键（不可信输入契约）。
fn is_valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 64
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn map_hook_event_to_task_status(event: &str) -> Option<&'static str> {
    match event {
        "UserPromptSubmit" => Some("running"),
        "Notification" | "PermissionRequest" => Some("attention"),
        "Stop" => Some("done"),
        "StopFailure" => Some("failed"),
        _ => None,
    }
}

fn websocket_error(status: StatusCode, message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = status;
    response
}

fn is_allowed_webview_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || origin.starts_with("http://localhost:")
        || origin.starts_with("https://localhost:")
        || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("https://127.0.0.1:")
}

fn validate_websocket_request(
    request: &Request,
    response: Response,
) -> Result<Response, ErrorResponse> {
    if request.uri().path() != "/pty" {
        return Err(websocket_error(StatusCode::NOT_FOUND, "not found"));
    }
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !is_allowed_webview_origin(origin) {
        return Err(websocket_error(StatusCode::FORBIDDEN, "origin rejected"));
    }
    Ok(response)
}

enum WebSocketClientMessage {
    Text(String),
    Binary(Vec<u8>),
}

fn read_websocket_client_message(
    socket: &mut WebSocket<TcpStream>,
) -> Option<WebSocketClientMessage> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) if text.len() <= MAX_FRAME_BYTES => {
                return Some(WebSocketClientMessage::Text(text.to_string()))
            }
            Ok(Message::Text(_)) => return None,
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(Message::Binary(data)) if data.len() <= MAX_FRAME_BYTES => {
                return Some(WebSocketClientMessage::Binary(data.to_vec()))
            }
            Ok(Message::Binary(_)) => return None,
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => continue,
        }
    }
}

impl DaemonServer {
    /// 绑定 127.0.0.1 随机端口、独占写入发现文件并进入 accept 循环（阻塞）。
    /// 返回 Err 仅发生在启动阶段（端口/发现文件失败，例如已有实例存活）。
    pub fn run(config: DaemonServerConfig) -> Result<(), String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|err| format!("daemon bind failed: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("daemon local_addr failed: {err}"))?
            .port();
        let ws_listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|err| format!("daemon websocket bind failed: {err}"))?;
        let ws_port = ws_listener
            .local_addr()
            .map_err(|err| format!("daemon websocket local_addr failed: {err}"))?
            .port();
        // hook 上报稳定端口：PTY 子进程环境变量指向它，app 重启也不失效（契约★）。
        let hook_listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|err| format!("daemon hook bind failed: {err}"))?;
        let hook_port = hook_listener
            .local_addr()
            .map_err(|err| format!("daemon hook local_addr failed: {err}"))?
            .port();
        let token = uuid::Uuid::new_v4().to_string();
        let info = DaemonInfo {
            port,
            ws_port,
            hook_port,
            token: token.clone(),
            pid: std::process::id(),
            version: config.version.clone(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            binary_protocol_version: BINARY_PROTOCOL_VERSION,
            features: supported_features(),
        };
        // 独占创建：已存在存活实例时这里失败，新 daemon 立即退出（单实例契约）。
        write_daemon_info_exclusive(&config.info_path, &info)?;
        log::info!(
            "cli-manager-daemon listening on 127.0.0.1:{port}, websocket on {ws_port}, hook on {hook_port}"
        );

        let spool_dir = config.info_path.with_file_name(format!(
            "{}.spool",
            config
                .info_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("daemon")
        ));
        let _ = std::fs::remove_dir_all(&spool_dir);
        if let Err(err) = std::fs::create_dir_all(&spool_dir) {
            log::warn!("daemon spool directory unavailable, output will remain in memory: {err}");
        }
        let server = Arc::new(DaemonServer {
            host: Arc::new(DaemonHost::with_spool_dir(spool_dir)),
            next_client_id: AtomicU64::new(1),
            token: token.clone(),
            version: config.version,
            info_path: config.info_path,
        });

        let hook_host = Arc::clone(&server.host);
        let dispatcher = DispatcherHandle::start("daemon");
        let hook_sink: HookPayloadSink = Arc::new(move |payload| {
            // 仅当没有已连接的前端客户端时（app 已彻底退到后台，例如托盘退出后
            // 转入后台继续执行）才拉起 app 处理审批。app 正在运行时，事件会通过
            // 下方 broadcast_hook 送达前端，由前端决定是否通知/切换，绝不在此
            // 抢占前台——否则用户在其他应用里工作时会被 PermissionRequest（含
            // Codex 改代码时的误报）强制切回 CLI-Manager。
            if hook_host.client_count() == 0 {
                maybe_activate_app_for_hook(&payload);
            }
            dispatcher.try_enqueue(payload.to_notification_job());
            match serde_json::to_value(&payload) {
                Ok(value) => {
                    hook_host.update_task_status_from_hook(&value);
                    hook_host.broadcast_hook(value);
                }
                Err(err) => log::warn!("daemon hook payload serialize failed: {err}"),
            }
        });
        spawn_hook_listener(hook_listener, token, hook_sink);

        server.spawn_idle_watchdog();

        let websocket_server = Arc::clone(&server);
        std::thread::spawn(move || {
            for stream in ws_listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let server = Arc::clone(&websocket_server);
                        std::thread::spawn(move || server.handle_websocket_connection(stream));
                    }
                    Err(err) => log::warn!("daemon websocket accept failed: {err}"),
                }
            }
        });

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let server = Arc::clone(&server);
                    std::thread::spawn(move || server.handle_connection(stream));
                }
                Err(err) => log::warn!("daemon accept failed: {err}"),
            }
        }
        Ok(())
    }

    fn spawn_idle_watchdog(self: &Arc<Self>) {
        let server = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(IDLE_CHECK_INTERVAL);
            let busy = server.host.client_count() > 0 || server.host.alive_session_count() > 0;
            let Ok(mut idle_since) = server.host.last_idle_since.lock() else {
                continue;
            };
            if busy {
                *idle_since = Instant::now();
                continue;
            }
            if idle_since.elapsed() >= IDLE_EXIT_AFTER {
                log::info!("daemon idle (no clients, no alive sessions), exiting");
                remove_daemon_info(&server.info_path);
                std::process::exit(0);
            }
        });
    }

    fn handle_connection(self: Arc<Self>, stream: TcpStream) {
        let peer = stream
            .peer_addr()
            .map(|addr| addr.to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        let writer = match stream.try_clone() {
            Ok(writer) => ClientWriter::new(ClientTransport::Ndjson(Mutex::new(writer))),
            Err(err) => {
                log::warn!("daemon stream clone failed ({peer}): {err}");
                return;
            }
        };
        let mut reader = BufReader::new(stream);

        // 首帧必须 Auth，失败立即断连（契约）。
        match read_line_bounded(&mut reader) {
            Some(line) => match decode_client_frame(&line) {
                Ok(ClientFrame::Auth { token, .. }) if token == self.token => {
                    let _ = writer.send_frame(&DaemonFrame::AuthOk {
                        daemon_version: self.version.clone(),
                        pid: std::process::id(),
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        binary_protocol_version: BINARY_PROTOCOL_VERSION,
                        features: supported_features(),
                    });
                }
                _ => {
                    log::warn!("daemon auth rejected ({peer})");
                    let _ = writer.send_frame(&DaemonFrame::AuthErr {
                        reason: "auth_failed".to_string(),
                    });
                    return;
                }
            },
            None => return,
        }

        let client_id = self.next_client_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut clients) = self.host.clients.lock() {
            clients.insert(
                client_id,
                ClientHandle {
                    writer: Arc::clone(&writer),
                    attached: HashSet::new(),
                    unacknowledged_chars: HashMap::new(),
                    last_sent_sequence: HashMap::new(),
                    last_acknowledged_sequence: HashMap::new(),
                    attaching: HashMap::new(),
                },
            );
        }
        log::debug!("daemon client connected ({peer}, id={client_id})");

        while let Some(line) = read_line_bounded(&mut reader) {
            match decode_client_frame(&line) {
                Ok(frame) => {
                    if !self.dispatch(client_id, frame, &writer) {
                        break;
                    }
                }
                Err(ProtocolError::UnknownType(kind)) => {
                    // 前向兼容：未知 type 回错误帧但保持连接。
                    let _ = writer.send_frame(&DaemonFrame::Err {
                        id: 0,
                        message: format!("unknown frame type: {kind}"),
                    });
                }
                Err(ProtocolError::Malformed(reason)) => {
                    log::warn!("daemon malformed frame ({peer}): {reason}");
                    break; // 非法帧断连（契约）。
                }
            }
        }

        if let Ok(mut clients) = self.host.clients.lock() {
            if let Some(client) = clients.remove(&client_id) {
                client.writer.close();
            }
        }
        log::debug!("daemon client disconnected ({peer}, id={client_id})");
    }

    fn handle_websocket_connection(self: Arc<Self>, stream: TcpStream) {
        let peer = stream
            .peer_addr()
            .map(|addr| addr.to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        let mut socket = match accept_hdr(stream, validate_websocket_request) {
            Ok(socket) => socket,
            Err(err) => {
                log::warn!("daemon websocket handshake rejected ({peer}): {err}");
                return;
            }
        };
        let writer_stream = match socket.get_ref().try_clone() {
            Ok(stream) => stream,
            Err(err) => {
                log::warn!("daemon websocket stream clone failed ({peer}): {err}");
                return;
            }
        };
        let writer = ClientWriter::new(ClientTransport::WebSocket(Mutex::new(
            WebSocket::from_raw_socket(writer_stream, Role::Server, None),
        )));

        match read_websocket_client_message(&mut socket) {
            Some(WebSocketClientMessage::Text(line)) => match decode_client_frame(&line) {
                Ok(ClientFrame::Auth { token, .. }) if token == self.token => {
                    let _ = writer.send_frame(&DaemonFrame::AuthOk {
                        daemon_version: self.version.clone(),
                        pid: std::process::id(),
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        binary_protocol_version: BINARY_PROTOCOL_VERSION,
                        features: supported_features(),
                    });
                }
                _ => {
                    let _ = writer.send_frame(&DaemonFrame::AuthErr {
                        reason: "auth_failed".to_string(),
                    });
                    return;
                }
            },
            Some(WebSocketClientMessage::Binary(_)) | None => return,
        }

        let client_id = self.next_client_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut clients) = self.host.clients.lock() {
            clients.insert(
                client_id,
                ClientHandle {
                    writer: Arc::clone(&writer),
                    attached: HashSet::new(),
                    unacknowledged_chars: HashMap::new(),
                    last_sent_sequence: HashMap::new(),
                    last_acknowledged_sequence: HashMap::new(),
                    attaching: HashMap::new(),
                },
            );
        }
        log::debug!("daemon websocket client connected ({peer}, id={client_id})");

        while let Some(message) = read_websocket_client_message(&mut socket) {
            match message {
                WebSocketClientMessage::Text(line) => match decode_client_frame(&line) {
                    Ok(frame) => {
                        if !self.dispatch(client_id, frame, &writer) {
                            break;
                        }
                    }
                    Err(ProtocolError::UnknownType(kind)) => {
                        let _ = writer.send_frame(&DaemonFrame::Err {
                            id: 0,
                            message: format!("unknown frame type: {kind}"),
                        });
                    }
                    Err(ProtocolError::Malformed(reason)) => {
                        log::warn!("daemon websocket malformed frame ({peer}): {reason}");
                        break;
                    }
                },
                WebSocketClientMessage::Binary(data) => {
                    if !self.handle_binary_frame(client_id, &data, &writer) {
                        break;
                    }
                }
            }
        }

        if let Ok(mut clients) = self.host.clients.lock() {
            if let Some(client) = clients.remove(&client_id) {
                client.writer.close();
            }
        }
        log::debug!("daemon websocket client disconnected ({peer}, id={client_id})");
    }

    fn handle_binary_frame(&self, client_id: u64, data: &[u8], writer: &Arc<ClientWriter>) -> bool {
        let frame = match decode_binary_terminal_frame(data) {
            Ok(frame) => frame,
            Err(message) => {
                let _ = writer.send_frame(&DaemonFrame::Err { id: 0, message });
                return false;
            }
        };
        let attached = self
            .host
            .clients
            .lock()
            .ok()
            .and_then(|clients| {
                clients
                    .get(&client_id)
                    .map(|client| client.attached.contains(&frame.session_id))
            })
            .unwrap_or(false);
        if !attached || !is_valid_session_id(&frame.session_id) {
            let _ = writer.send_frame(&DaemonFrame::Err {
                id: 0,
                message: "binary frame session is not attached".to_string(),
            });
            return false;
        }
        match frame.kind {
            BINARY_KIND_INPUT => self
                .host
                .pty
                .write_bytes(&frame.session_id, &frame.data)
                .is_ok(),
            BINARY_KIND_CHECKPOINT => {
                let result = self
                    .host
                    .get_session(&frame.session_id)
                    .ok_or_else(|| "session not found".to_string())
                    .and_then(|session| {
                        let mut entry = session
                            .lock()
                            .map_err(|_| "session state unavailable".to_string())?;
                        let latest_sequence = entry.next_sequence.saturating_sub(1);
                        if frame.sequence > latest_sequence {
                            return Err("checkpoint sequence is ahead of daemon output".to_string());
                        }
                        entry.buffer.accept_checkpoint(
                            frame.cols,
                            frame.rows,
                            frame.sequence,
                            frame.data,
                        )?;
                        entry.meta.replay_available = entry.buffer.replay_available();
                        entry.meta.replay_truncated = entry.buffer.truncated;
                        Ok(())
                    });
                let response = match result {
                    Ok(()) => DaemonFrame::CheckpointAccepted {
                        session_id: frame.session_id,
                        sequence: frame.sequence,
                    },
                    Err(message) => DaemonFrame::CheckpointRejected {
                        session_id: frame.session_id,
                        sequence: frame.sequence,
                        message,
                    },
                };
                writer.send_frame(&response).is_ok()
            }
            _ => false,
        }
    }

    /// 返回 false 表示应结束该连接。
    fn dispatch(&self, client_id: u64, frame: ClientFrame, writer: &Arc<ClientWriter>) -> bool {
        // 积压 hook 上报在首次 List 时补发（而非连接瞬间）：此时前端 webview
        // 的事件监听器已就绪（恢复流程先查会话列表），避免 re-emit 被丢。
        if matches!(frame, ClientFrame::List { .. }) {
            self.host.flush_hook_cache_to(writer);
        }
        let attach_session_id = match &frame {
            ClientFrame::Attach { session_id, .. } => Some(session_id.clone()),
            _ => None,
        };
        let reply = self.handle_frame(client_id, frame);
        let sent = writer.send_frame(&reply).is_ok();
        if sent && matches!(reply, DaemonFrame::Attached { .. }) {
            if let Some(session_id) = attach_session_id {
                self.host.complete_attach(client_id, &session_id);
            }
        }
        sent
    }

    fn handle_frame(&self, client_id: u64, frame: ClientFrame) -> DaemonFrame {
        match frame {
            ClientFrame::Auth { .. } => DaemonFrame::Err {
                id: 0,
                message: "already authenticated".to_string(),
            },
            ClientFrame::Ping { id } => DaemonFrame::Pong { id },
            ClientFrame::List { id } => {
                let session_handles = self
                    .host
                    .sessions
                    .lock()
                    .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                let sessions = session_handles
                    .into_iter()
                    .filter_map(|session| session.lock().ok().map(|entry| entry.meta.clone()))
                    .collect();
                DaemonFrame::Sessions { id, sessions }
            }
            ClientFrame::Create {
                id,
                session_id,
                cwd,
                env_vars,
                shell,
                ssh_launch,
            } => self.handle_create(client_id, id, session_id, cwd, env_vars, shell, ssh_launch),
            ClientFrame::Write {
                id,
                session_id,
                data,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                match self.host.pty.write(&session_id, &data) {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::Ack {
                id,
                session_id,
                sequence,
                char_count,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                self.host
                    .acknowledge_output(client_id, &session_id, sequence, char_count);
                DaemonFrame::Ok { id }
            }
            ClientFrame::Resize {
                id,
                session_id,
                cols,
                rows,
                pixel_width,
                pixel_height,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                match self
                    .host
                    .pty
                    .resize(&session_id, cols, rows, pixel_width, pixel_height)
                {
                    Ok(()) => {
                        if let Some(session) = self.host.get_session(&session_id) {
                            if let Ok(mut entry) = session.lock() {
                                entry.cols = cols;
                                entry.rows = rows;
                                let sequence = entry.next_sequence;
                                entry.next_sequence = entry.next_sequence.saturating_add(1);
                                entry.buffer.push_resize(cols, rows, sequence);
                            }
                        }
                        DaemonFrame::Ok { id }
                    }
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::Close { id, session_id } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                let result = self.host.pty.close(&session_id);
                if let Ok(mut sessions) = self.host.sessions.lock() {
                    sessions.remove(&session_id);
                }
                self.host.detach_session_from_clients(&session_id);
                match result {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::CloseAll { id } => {
                let result = self.host.pty.close_all();
                if let Ok(mut sessions) = self.host.sessions.lock() {
                    sessions.clear();
                }
                self.host.detach_all_sessions_from_clients();
                match result {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::Attach {
                id,
                session_id,
                after_sequence,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                // Keep the replay snapshot and subscription registration atomic
                // relative to on_output (sessions -> clients). Output produced
                // before this block is replayed; output produced after it is live.
                let attach_info = self.host.get_session(&session_id).and_then(|session| {
                    let entry = session.lock().ok()?;
                    let meta = entry.meta.clone();
                    let oldest_sequence = entry.buffer.oldest_sequence().unwrap_or(0);
                    let replay_reset = after_sequence
                        .map(|sequence| sequence.saturating_add(1) < oldest_sequence)
                        .unwrap_or(true);
                    let replay_entries = if replay_reset {
                        entry.buffer.replay_entries()
                    } else {
                        entry.buffer.replay_entries_after(after_sequence)
                    };
                    let latest_sequence = entry.next_sequence.saturating_sub(1);
                    let mut clients = self.host.clients.lock().ok()?;
                    let client = clients.get_mut(&client_id)?;
                    client.attached.insert(session_id.clone());
                    client.unacknowledged_chars.insert(session_id.clone(), 0);
                    client
                        .last_sent_sequence
                        .insert(session_id.clone(), latest_sequence);
                    client
                        .last_acknowledged_sequence
                        .insert(session_id.clone(), latest_sequence);
                    client.attaching.insert(session_id.clone(), Vec::new());
                    Some((
                        meta,
                        replay_entries,
                        latest_sequence,
                        replay_reset,
                        oldest_sequence,
                    ))
                });
                match attach_info {
                    Some((
                        meta,
                        replay_entries,
                        latest_sequence,
                        replay_reset,
                        oldest_sequence,
                    )) => DaemonFrame::Attached {
                        id,
                        session_id,
                        replay_base64: String::new(),
                        replay: replay_entries,
                        latest_sequence,
                        meta,
                        replay_reset,
                        replay_truncated: false,
                        oldest_sequence,
                    },
                    None => err_frame(id, "session not found"),
                }
            }
            ClientFrame::Detach { id } => {
                if let Ok(mut clients) = self.host.clients.lock() {
                    if let Some(client) = clients.get_mut(&client_id) {
                        client.attached.clear();
                        client.unacknowledged_chars.clear();
                        client.last_sent_sequence.clear();
                        client.last_acknowledged_sequence.clear();
                        client.attaching.clear();
                    }
                }
                DaemonFrame::Ok { id }
            }
            ClientFrame::Reconcile {
                id,
                active_session_ids,
            } => {
                let active_count = active_session_ids
                    .iter()
                    .filter(|session_id| !session_id.trim().is_empty())
                    .count();
                let tracked_count = self
                    .host
                    .sessions
                    .lock()
                    .map(|sessions| sessions.len())
                    .unwrap_or(0);
                // daemon 会话可以在没有 UI Tab 的情况下继续运行；UI active list
                // 只能用于诊断，不能作为孤儿判定依据。
                let summary = crate::pty::manager::PtyOrphanCleanupSummary {
                    active_count,
                    tracked_count,
                    marked_missing: 0,
                    protected_count: tracked_count,
                    cleaned_count: 0,
                    skipped_empty_active_list: active_count == 0,
                };
                match serde_json::to_value(&summary) {
                    Ok(summary) => DaemonFrame::Reconciled { id, summary },
                    Err(err) => err_frame(id, &err.to_string()),
                }
            }
            ClientFrame::Status { id } => {
                let statuses = self
                    .host
                    .pty
                    .status_all()
                    .into_iter()
                    .map(|(session_id, status)| {
                        (
                            session_id,
                            SessionStatusInfo {
                                status: status.status,
                                exit_code: status.exit_code,
                            },
                        )
                    })
                    .collect();
                DaemonFrame::Statuses { id, statuses }
            }
            ClientFrame::Shutdown { id } => {
                if self.host.alive_session_count() > 0 {
                    return err_frame(id, "sessions active");
                }
                log::info!("daemon shutdown requested (no alive sessions)");
                let info_path = self.info_path.clone();
                std::thread::spawn(move || {
                    // 留出应答落盘时间再退出。
                    std::thread::sleep(Duration::from_millis(200));
                    remove_daemon_info(&info_path);
                    std::process::exit(0);
                });
                DaemonFrame::Ok { id }
            }
        }
    }

    fn handle_create(
        &self,
        client_id: u64,
        id: u64,
        session_id: String,
        cwd: Option<String>,
        env_vars: Option<HashMap<String, String>>,
        shell: Option<String>,
        ssh_launch: Option<SshLaunchPlan>,
    ) -> DaemonFrame {
        if !is_valid_session_id(&session_id) {
            return err_frame(id, "invalid session id");
        }
        let sink = Arc::new(DaemonPtyEventSink::new(
            Arc::clone(&self.host),
            session_id.clone(),
        ));
        // 检查、预留与插入保持在同一临界区；并发 create 不得同时通过。
        if let Err(message) = self.host.reserve_session_with_launch(
            &session_id,
            cwd.clone(),
            shell.clone(),
            ssh_launch.as_ref(),
        ) {
            return err_frame(id, message);
        }
        let attached = self.host.clients.lock().ok().and_then(|mut clients| {
            let client = clients.get_mut(&client_id)?;
            client.attached.insert(session_id.clone());
            client.unacknowledged_chars.insert(session_id.clone(), 0);
            client.last_sent_sequence.insert(session_id.clone(), 0);
            client
                .last_acknowledged_sequence
                .insert(session_id.clone(), 0);
            client.attaching.remove(&session_id);
            Some(())
        });
        // 先登记会话表再启动 PTY：reader 线程首帧输出可能早于登记完成。
        if attached.is_none() {
            if let Ok(mut sessions) = self.host.sessions.lock() {
                sessions.remove(&session_id);
            }
            return err_frame(id, "client unavailable");
        }
        match self.host.pty.create_with_launch(
            &session_id,
            cwd.as_deref(),
            env_vars,
            shell.as_deref(),
            ssh_launch.as_ref(),
            sink,
        ) {
            Ok(process_traits) => self
                .host
                .get_session(&session_id)
                .and_then(|session| {
                    session.lock().ok().map(|mut entry| {
                        entry.meta.process_traits = Some(ProcessTraits::current_platform(
                            process_traits.uses_conpty_dll,
                        ));
                        entry.meta.clone()
                    })
                })
                .map(|meta| DaemonFrame::Created { id, meta })
                .unwrap_or_else(|| err_frame(id, "session state unavailable")),
            Err(message) => {
                if let Ok(mut sessions) = self.host.sessions.lock() {
                    sessions.remove(&session_id);
                }
                if let Ok(mut clients) = self.host.clients.lock() {
                    if let Some(client) = clients.get_mut(&client_id) {
                        client.attached.remove(&session_id);
                        client.unacknowledged_chars.remove(&session_id);
                        client.last_sent_sequence.remove(&session_id);
                        client.last_acknowledged_sequence.remove(&session_id);
                        client.attaching.remove(&session_id);
                    }
                }
                DaemonFrame::Err { id, message }
            }
        }
    }
}

fn err_frame(id: u64, message: &str) -> DaemonFrame {
    DaemonFrame::Err {
        id,
        message: message.to_string(),
    }
}

/// 读一行并施加单帧字节上限；连接关闭/超限/非 UTF-8/IO 错误返回 None（调用方断连）。
fn read_line_bounded(reader: &mut BufReader<TcpStream>) -> Option<String> {
    let mut buf = Vec::new();
    let mut limited = reader.by_ref().take((MAX_FRAME_BYTES + 1) as u64);
    match limited.read_until(b'\n', &mut buf) {
        Ok(0) => None,
        Ok(_) => {
            if buf.last() != Some(&b'\n') {
                // 无换行结尾：要么超限被截断，要么对端半行断连，一律断。
                if buf.len() > MAX_FRAME_BYTES {
                    log::warn!("daemon frame exceeds {MAX_FRAME_BYTES} bytes, dropping client");
                }
                return None;
            }
            buf.pop();
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            match String::from_utf8(buf) {
                Ok(line) => Some(line),
                Err(_) => {
                    log::warn!("daemon frame is not valid UTF-8, dropping client");
                    None
                }
            }
        }
        Err(err) => {
            log::warn!("daemon read failed: {err}");
            None
        }
    }
}

fn maybe_activate_app_for_hook(payload: &crate::claude_hook::ClaudeHookPayload) {
    if payload.event() != "PermissionRequest" {
        return;
    }
    let Ok(daemon_exe) = std::env::current_exe() else {
        return;
    };
    let app_name = if cfg!(target_os = "windows") {
        "cli-manager.exe"
    } else {
        "cli-manager"
    };
    let app_exe = daemon_exe.with_file_name(app_name);
    if !app_exe.is_file() {
        log::warn!(
            "hook activation skipped: app executable not found at {}",
            app_exe.display()
        );
        return;
    }
    let mut command = Command::new(app_exe);
    command.args(["--restore-background-session", payload.tab_id()]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if let Err(err) = command.spawn() {
        log::warn!("hook activation failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session(session_id: &str, buffer: SessionBuffer, next_sequence: u64) -> SharedSession {
        Arc::new(Mutex::new(SessionEntry {
            meta: SessionMeta {
                session_id: session_id.to_string(),
                cwd: None,
                shell: None,
                environment_type: None,
                ssh_host_id: None,
                remote_path: None,
                alive: true,
                task_status: None,
                task_updated_at_ms: None,
                created_at_ms: 1,
                process_traits: Some(ProcessTraits::current_platform(false)),
                replay_available: buffer.replay_available(),
                replay_truncated: buffer.truncated,
            },
            buffer,
            cols: 80,
            rows: 24,
            next_sequence,
        }))
    }

    #[test]
    fn websocket_writer_sends_binary_terminal_output() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let socket = tungstenite::accept(stream).unwrap();
            let writer_stream = socket.get_ref().try_clone().unwrap();
            let writer = ClientWriter::new(ClientTransport::WebSocket(Mutex::new(
                WebSocket::from_raw_socket(writer_stream, Role::Server, None),
            )));
            writer
                .send_frame(&DaemonFrame::Output {
                    session_id: "session-1".to_string(),
                    sequence: 3,
                    cols: 120,
                    rows: 30,
                    data_base64: STANDARD.encode(b"hello"),
                })
                .unwrap();
            drop(socket);
        });

        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let (mut client, _) = tungstenite::client("ws://127.0.0.1/pty", stream).unwrap();
        let message = client.read().unwrap();
        let Message::Binary(binary) = message else {
            panic!("expected binary output frame");
        };
        assert_eq!(binary[0], super::super::protocol::BINARY_PROTOCOL_VERSION);
        assert_eq!(binary[1], BINARY_KIND_OUTPUT);
        assert_eq!(&binary[binary.len() - 5..], b"hello");
        server.join().unwrap();
    }

    #[test]
    fn attach_returns_replay_and_registers_client() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("read test listener address");
        let peer = TcpStream::connect(address).expect("connect test client");
        let (server_stream, _) = listener.accept().expect("accept test client");
        let host = Arc::new(DaemonHost::new());
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        let client_id = 7;
        let mut buffer = SessionBuffer::new();
        buffer.push_output(80, 24, 1, b"replay-before-attach");
        host.sessions
            .lock()
            .expect("lock sessions")
            .insert(session_id.to_string(), test_session(session_id, buffer, 2));
        host.clients.lock().expect("lock clients").insert(
            client_id,
            ClientHandle {
                writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
                attached: HashSet::new(),
                unacknowledged_chars: HashMap::new(),
                last_sent_sequence: HashMap::new(),
                last_acknowledged_sequence: HashMap::new(),
                attaching: HashMap::new(),
            },
        );
        let server = DaemonServer {
            host: Arc::clone(&host),
            next_client_id: AtomicU64::new(8),
            token: String::new(),
            version: String::new(),
            info_path: PathBuf::new(),
        };

        let reply = server.handle_frame(
            client_id,
            ClientFrame::Attach {
                id: 11,
                session_id: session_id.to_string(),
                after_sequence: None,
            },
        );

        match reply {
            DaemonFrame::Attached { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(
                    STANDARD.decode(&replay[0].data_base64).unwrap(),
                    b"replay-before-attach"
                );
            }
            other => panic!("unexpected attach reply: {other:?}"),
        }
        assert!(host
            .clients
            .lock()
            .expect("lock clients")
            .get(&client_id)
            .expect("client exists")
            .attached
            .contains(session_id));
        drop(peer);
    }

    #[test]
    fn attach_barrier_sends_replay_control_before_buffered_live_output() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let peer = TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let (server_stream, _) = listener.accept().unwrap();
        let host = Arc::new(DaemonHost::new());
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        let client_id = 9;
        let mut buffer = SessionBuffer::new();
        buffer.push_output(80, 24, 1, b"replay");
        host.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), test_session(session_id, buffer, 2));
        let writer = ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream)));
        host.clients.lock().unwrap().insert(
            client_id,
            ClientHandle {
                writer: Arc::clone(&writer),
                attached: HashSet::new(),
                unacknowledged_chars: HashMap::new(),
                last_sent_sequence: HashMap::new(),
                last_acknowledged_sequence: HashMap::new(),
                attaching: HashMap::new(),
            },
        );
        let server = DaemonServer {
            host: Arc::clone(&host),
            next_client_id: AtomicU64::new(10),
            token: String::new(),
            version: String::new(),
            info_path: PathBuf::new(),
        };

        let attached = server.handle_frame(
            client_id,
            ClientFrame::Attach {
                id: 12,
                session_id: session_id.to_string(),
                after_sequence: None,
            },
        );
        let live = DaemonFrame::Output {
            session_id: session_id.to_string(),
            sequence: 2,
            cols: 80,
            rows: 24,
            data_base64: STANDARD.encode(b"live"),
        };
        host.push_output_to_attached(session_id, 2, 4, &live);
        writer.send_frame(&attached).unwrap();
        host.complete_attach(client_id, session_id);

        let mut reader = BufReader::new(peer);
        let first = read_line_bounded(&mut reader).unwrap();
        let second = read_line_bounded(&mut reader).unwrap();
        assert!(matches!(
            super::super::protocol::decode_daemon_frame(&first).unwrap(),
            DaemonFrame::Attached { .. }
        ));
        assert!(matches!(
            super::super::protocol::decode_daemon_frame(&second).unwrap(),
            DaemonFrame::Output { sequence: 2, .. }
        ));
    }

    #[test]
    fn detach_session_clears_flow_control_state() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let peer = TcpStream::connect(address).unwrap();
        let (server_stream, _) = listener.accept().unwrap();
        let host = DaemonHost::new();
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        host.clients.lock().unwrap().insert(
            1,
            ClientHandle {
                writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
                attached: HashSet::from([session_id.to_string()]),
                unacknowledged_chars: HashMap::from([(session_id.to_string(), 10)]),
                last_sent_sequence: HashMap::from([(session_id.to_string(), 2)]),
                last_acknowledged_sequence: HashMap::from([(session_id.to_string(), 1)]),
                attaching: HashMap::new(),
            },
        );

        host.detach_session_from_clients(session_id);

        let clients = host.clients.lock().unwrap();
        let client = clients.get(&1).unwrap();
        assert!(!client.attached.contains(session_id));
        assert!(!client.unacknowledged_chars.contains_key(session_id));
        assert!(!client.last_sent_sequence.contains_key(session_id));
        assert!(!client.last_acknowledged_sequence.contains_key(session_id));
        drop(peer);
    }

    #[test]
    fn session_buffer_spills_whole_frames_without_losing_replay() {
        let temp = tempfile::tempdir().unwrap();
        let mut buffer = SessionBuffer::with_spool(Some(temp.path().join("session.bin")));
        let frame = vec![b'x'; 1024 * 1024]; // 1 MiB/帧
        buffer.push_output(80, 24, 1, &frame);
        buffer.push_output(80, 24, 2, &frame);
        buffer.push_output(80, 24, 3, &frame); // 超 2 MiB，最旧帧落磁盘
        assert!(buffer.total_bytes <= SESSION_BUFFER_MAX_BYTES);
        assert_eq!(buffer.frames.len(), 2);
        let replay = buffer.replay_entries();
        assert_eq!(replay.len(), 3);
        assert_eq!(
            replay
                .iter()
                .map(|entry| STANDARD.decode(&entry.data_base64).unwrap().len())
                .sum::<usize>(),
            frame.len() * 3
        );
    }

    #[test]
    fn session_buffer_preserves_resize_boundaries() {
        let mut buffer = SessionBuffer::new();
        buffer.push_output(80, 24, 1, b"first");
        buffer.push_resize(120, 30, 2);
        buffer.push_resize(140, 40, 3);
        buffer.push_output(140, 40, 4, b"second");

        let replay = buffer.replay_entries();
        assert_eq!(replay.len(), 3);
        assert_eq!((replay[1].cols, replay[1].rows), (140, 40));
        assert!(replay[1].data_base64.is_empty());
        assert_eq!(replay[1].sequence, 3);
        assert_eq!(replay[2].sequence, 4);
    }

    #[test]
    fn reconcile_never_closes_daemon_background_sessions() {
        let host = Arc::new(DaemonHost::new());
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        host.sessions.lock().unwrap().insert(
            session_id.to_string(),
            test_session(session_id, SessionBuffer::new(), 1),
        );
        let server = DaemonServer {
            host: Arc::clone(&host),
            next_client_id: AtomicU64::new(1),
            token: String::new(),
            version: String::new(),
            info_path: PathBuf::new(),
        };

        let reply = server.handle_frame(
            0,
            ClientFrame::Reconcile {
                id: 13,
                active_session_ids: Vec::new(),
            },
        );

        let DaemonFrame::Reconciled { summary, .. } = reply else {
            panic!("expected reconcile response");
        };
        assert_eq!(summary["cleaned_count"], 0);
        assert!(host.sessions.lock().unwrap().contains_key(session_id));
    }

    #[test]
    fn session_reservation_is_atomic_for_duplicate_ids() {
        let host = Arc::new(DaemonHost::new());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        let first_host = Arc::clone(&host);
        let first_barrier = Arc::clone(&barrier);
        let first = std::thread::spawn(move || {
            first_barrier.wait();
            first_host.reserve_session(session_id, None, None)
        });
        let second_host = Arc::clone(&host);
        let second_barrier = Arc::clone(&barrier);
        let second = std::thread::spawn(move || {
            second_barrier.wait();
            second_host.reserve_session(session_id, None, None)
        });

        let results = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert_eq!(host.sessions.lock().unwrap().len(), 1);
    }

    #[test]
    fn session_id_validation() {
        assert!(is_valid_session_id("0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("../etc/passwd"));
        assert!(!is_valid_session_id(&"x".repeat(65)));
    }

    #[test]
    fn hook_events_map_to_task_status() {
        assert_eq!(
            map_hook_event_to_task_status("UserPromptSubmit"),
            Some("running")
        );
        assert_eq!(
            map_hook_event_to_task_status("PermissionRequest"),
            Some("attention")
        );
        assert_eq!(map_hook_event_to_task_status("Stop"), Some("done"));
        assert_eq!(map_hook_event_to_task_status("StopFailure"), Some("failed"));
        assert_eq!(map_hook_event_to_task_status("SessionStart"), None);
    }
}
