//! daemon TCP 服务：鉴权、帧分发、PTY 会话托管、ring buffer 回放、空闲自灭。
//!
//! 增量 2：接入 `PtyManager`（经 `PtyEventSink` 解耦）。输出帧在 PTY reader
//! 线程已按 ANSI/UTF-8 安全边界切好，本层只整帧存储/透传（契约禁止再分片）。
//! 增量 3 待办：Windows Job Object 兜底、hook 上报转发、exited 会话宽限自灭。

use super::discovery::{remove_daemon_info, write_daemon_info_exclusive, DaemonInfo};
use super::protocol::{
    decode_client_frame, encode_binary_terminal_frame, encode_frame, ClientFrame, DaemonFrame,
    ProtocolError, ReplayEntry, SessionMeta, SessionStatusInfo, BINARY_KIND_OUTPUT,
    BINARY_KIND_REPLAY, MAX_FRAME_BYTES,
};
use crate::claude_hook::{spawn_hook_listener, HookPayloadSink};
use crate::pty::manager::{PtyEventSink, PtyManager, PtyProcessStatus};
use crate::third_party_notification::DispatcherHandle;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, sync_channel, RecvTimeoutError, Sender, SyncSender};
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
/// 全部会话 buffer 总内存上限（契约：128 MiB）。
pub const TOTAL_BUFFER_MAX_BYTES: usize = 128 * 1024 * 1024;
/// 会话数上限（契约：64）。
pub const MAX_SESSIONS: usize = 64;
/// 无客户端时缓存的 hook 上报条数上限（契约：200，attach 后补发）。
pub const HOOK_CACHE_MAX: usize = 200;
pub const FLOW_CONTROL_HIGH_WATERMARK_CHARS: usize = 100_000;
pub const FLOW_CONTROL_LOW_WATERMARK_CHARS: usize = 5_000;
const OUTPUT_BUFFERING_DURATION: Duration = Duration::from_millis(5);
const OUTPUT_BUFFERING_MAX_BYTES: usize = 256 * 1024;

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
        self.read_spooled_frames()
            .into_iter()
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
            .map_err(|err| err.to_string())
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
                        ..
                    } => {
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
}

struct ClientWriter {
    sender: Sender<DaemonFrame>,
}

impl ClientWriter {
    fn new(transport: ClientTransport) -> Arc<Self> {
        let (sender, receiver) = channel::<DaemonFrame>();
        std::thread::spawn(move || {
            while let Ok(frame) = receiver.recv() {
                if let Err(err) = transport.send_frame(&frame) {
                    log::debug!("daemon client writer stopped: {err}");
                    break;
                }
            }
        });
        Arc::new(Self { sender })
    }

    fn send_frame(&self, frame: &DaemonFrame) -> Result<(), String> {
        self.sender
            .send(frame.clone())
            .map_err(|_| "client writer closed".to_string())
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

/// daemon 共享宿主：PTY 管理器 + 会话表 + 客户端注册表。
pub struct DaemonHost {
    pty: PtyManager,
    sessions: Mutex<HashMap<String, SessionEntry>>,
    clients: Mutex<HashMap<u64, ClientHandle>>,
    last_idle_since: Mutex<Instant>,
    /// 无客户端期间收到的 hook 上报缓存，客户端连上后补发（契约）。
    hook_cache: Mutex<VecDeque<serde_json::Value>>,
    flow_wait_lock: Mutex<()>,
    flow_changed: Condvar,
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
            flow_wait_lock: Mutex::new(()),
            flow_changed: Condvar::new(),
            spool_dir,
        }
    }

    fn session_spool_path(&self, session_id: &str) -> PathBuf {
        self.spool_dir.join(format!("{session_id}.bin"))
    }

    fn reserve_session(
        &self,
        session_id: &str,
        cwd: Option<String>,
        shell: Option<String>,
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
            SessionEntry {
                meta: SessionMeta {
                    session_id: session_id.to_string(),
                    cwd,
                    shell,
                    alive: true,
                    task_status: None,
                    task_updated_at_ms: None,
                    created_at_ms: now_ms(),
                },
                buffer: SessionBuffer::with_spool(Some(self.session_spool_path(session_id))),
                cols: 80,
                rows: 24,
                next_sequence: 1,
            },
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
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(entry) = sessions.get_mut(session_id) {
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
        self.sessions
            .lock()
            .map(|sessions| sessions.values().filter(|s| s.meta.alive).count())
            .unwrap_or(0)
    }

    fn client_count(&self) -> usize {
        self.clients.lock().map(|c| c.len()).unwrap_or(0)
    }

    /// 总 buffer 超限时从最旧的 exited 会话开始整会话丢弃（契约资源上限）。
    fn enforce_total_buffer_cap(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let mut total: usize = sessions.values().map(|s| s.buffer.total_bytes).sum();
        if total <= TOTAL_BUFFER_MAX_BYTES {
            return;
        }
        let mut exited: Vec<(String, u64, usize)> = sessions
            .iter()
            .filter(|(_, s)| !s.meta.alive)
            .map(|(id, s)| (id.clone(), s.meta.created_at_ms, s.buffer.total_bytes))
            .collect();
        exited.sort_by_key(|(_, created, _)| *created);
        for (id, _, bytes) in exited {
            if total <= TOTAL_BUFFER_MAX_BYTES {
                break;
            }
            sessions.remove(&id);
            total -= bytes;
            log::info!("daemon dropped exited session buffer to enforce cap: id={id}");
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
            let _ = client.writer.send_frame(frame);
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
                continue;
            }
            let _ = client.writer.send_frame(frame);
        }
    }

    fn complete_attach(&self, client_id: u64, session_id: &str) {
        let Ok(mut clients) = se…8061 tokens truncated…aemonFrame::Reconciled { id, summary },
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
    ) -> DaemonFrame {
        if !is_valid_session_id(&session_id) {
            return err_frame(id, "invalid session id");
        }
        let sink = Arc::new(DaemonPtyEventSink::new(
            Arc::clone(&self.host),
            session_id.clone(),
        ));
        // 检查、预留与插入保持在同一临界区；并发 create 不得同时通过。
        if let Err(message) = self
            .host
            .reserve_session(&session_id, cwd.clone(), shell.clone())
        {
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
        if attached.is_none() {
            if let Ok(mut sessions) = self.host.sessions.lock() {
                sessions.remove(&session_id);
            }
            return err_frame(id, "client unavailable");
        }
        match self.host.pty.create(
            &session_id,
            cwd.as_deref(),
            env_vars,
            shell.as_deref(),
            sink,
        ) {
            Ok(()) => DaemonFrame::Ok { id },
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
        host.sessions.lock().expect("lock sessions").insert(
            session_id.to_string(),
            SessionEntry {
                meta: SessionMeta {
                    session_id: session_id.to_string(),
                    cwd: None,
                    shell: None,
                    alive: true,
                    task_status: None,
                    task_updated_at_ms: None,
                    created_at_ms: 1,
                },
                buffer,
                cols: 80,
                rows: 24,
                next_sequence: 2,
            },
        );
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
        host.sessions.lock().unwrap().insert(
            session_id.to_string(),
            SessionEntry {
                meta: SessionMeta {
                    session_id: session_id.to_string(),
                    cwd: None,
                    shell: None,
                    alive: true,
                    task_status: None,
                    task_updated_at_ms: None,
                    created_at_ms: 1,
                },
                buffer,
                cols: 80,
                rows: 24,
                next_sequence: 2,
            },
        );
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
            SessionEntry {
                meta: SessionMeta {
                    session_id: session_id.to_string(),
                    cwd: None,
                    shell: None,
                    alive: true,
                    task_status: None,
                    task_updated_at_ms: None,
                    created_at_ms: 1,
                },
                buffer: SessionBuffer::new(),
                cols: 80,
                rows: 24,
                next_sequence: 1,
            },
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
