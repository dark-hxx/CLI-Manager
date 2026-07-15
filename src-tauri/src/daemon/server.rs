//! daemon TCP 服务：鉴权、帧分发、PTY 会话托管、ring buffer 回放、空闲自灭。
//!
//! 增量 2：接入 `PtyManager`（经 `PtyEventSink` 解耦）。输出帧在 PTY reader
//! 线程已按 ANSI/UTF-8 安全边界切好，本层只整帧存储/透传（契约禁止再分片）。
//! 增量 3 待办：Windows Job Object 兜底、hook 上报转发、exited 会话宽限自灭。

use super::discovery::{remove_daemon_info, write_daemon_info_exclusive, DaemonInfo};
use super::protocol::{
    decode_client_frame, encode_frame, ClientFrame, DaemonFrame, ProtocolError, SessionMeta,
    SessionStatusInfo, MAX_FRAME_BYTES,
};
use crate::claude_hook::{spawn_hook_listener, HookPayloadSink};
use crate::pty::manager::{PtyEventSink, PtyManager, PtyProcessStatus};
use crate::third_party_notification::DispatcherHandle;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// 按整帧存储的回放缓冲：每帧都是 PTY reader 切好的 ANSI 安全块，
/// 超限时从头丢弃整帧，天然保持边界安全（契约）。
struct SessionBuffer {
    frames: VecDeque<Vec<u8>>,
    total_bytes: usize,
}

impl SessionBuffer {
    fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            total_bytes: 0,
        }
    }

    fn push_frame(&mut self, data: &[u8]) {
        self.total_bytes += data.len();
        self.frames.push_back(data.to_vec());
        while self.total_bytes > SESSION_BUFFER_MAX_BYTES {
            match self.frames.pop_front() {
                Some(front) => self.total_bytes -= front.len(),
                None => break,
            }
        }
    }

    fn replay_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.total_bytes);
        for frame in &self.frames {
            out.extend_from_slice(frame);
        }
        out
    }
}

struct ClientHandle {
    writer: Arc<Mutex<TcpStream>>,
    attached: HashSet<String>,
}

struct SessionEntry {
    meta: SessionMeta,
    buffer: SessionBuffer,
}

/// daemon 共享宿主：PTY 管理器 + 会话表 + 客户端注册表。
pub struct DaemonHost {
    pty: PtyManager,
    sessions: Mutex<HashMap<String, SessionEntry>>,
    clients: Mutex<HashMap<u64, ClientHandle>>,
    last_idle_since: Mutex<Instant>,
    /// 无客户端期间收到的 hook 上报缓存，客户端连上后补发（契约）。
    hook_cache: Mutex<VecDeque<serde_json::Value>>,
}

impl DaemonHost {
    fn new() -> Self {
        Self {
            pty: PtyManager::new(),
            sessions: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            last_idle_since: Mutex::new(Instant::now()),
            hook_cache: Mutex::new(VecDeque::new()),
        }
    }

    /// hook 上报广播给全部客户端；无客户端时进缓存（有界）。
    fn broadcast_hook(&self, payload: serde_json::Value) {
        let frame = DaemonFrame::HookReport {
            payload: payload.clone(),
        };
        let encoded = encode_frame(&frame);
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
            if let Ok(mut writer) = client.writer.lock() {
                let _ = writer.write_all(encoded.as_bytes());
            }
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
    fn flush_hook_cache_to(&self, writer: &Arc<Mutex<TcpStream>>) {
        let cached: Vec<serde_json::Value> = match self.hook_cache.lock() {
            Ok(mut cache) => cache.drain(..).collect(),
            Err(_) => return,
        };
        for payload in cached {
            let _ = write_frame(writer, &DaemonFrame::HookReport { payload });
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
        let encoded = encode_frame(frame);
        let Ok(clients) = self.clients.lock() else {
            return;
        };
        for client in clients.values() {
            if !client.attached.contains(session_id) {
                continue;
            }
            if let Ok(mut writer) = client.writer.lock() {
                let _ = writer.write_all(encoded.as_bytes());
            }
        }
    }
}

/// daemon 侧 [`PtyEventSink`]：输出进 ring buffer 并推送给订阅客户端。
struct DaemonPtyEventSink {
    host: Arc<DaemonHost>,
}

impl PtyEventSink for DaemonPtyEventSink {
    fn on_output(&self, session_id: &str, data: &[u8]) {
        if let Ok(mut sessions) = self.host.sessions.lock() {
            if let Some(entry) = sessions.get_mut(session_id) {
                entry.buffer.push_frame(data);
            }
        }
        self.host.push_to_attached(
            session_id,
            &DaemonFrame::Output {
                session_id: session_id.to_string(),
                data_base64: STANDARD.encode(data),
            },
        );
    }

    fn on_status(&self, session_id: &str, status: PtyProcessStatus) {
        if status.status == "running" {
            return;
        }
        if let Ok(mut sessions) = self.host.sessions.lock() {
            if let Some(entry) = sessions.get_mut(session_id) {
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
        self.host.push_to_attached(
            session_id,
            &DaemonFrame::Exit {
                session_id: session_id.to_string(),
                exit_code: status.exit_code,
            },
        );
        self.host.enforce_total_buffer_cap();
    }
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
            hook_port,
            token: token.clone(),
            pid: std::process::id(),
            version: config.version.clone(),
        };
        // 独占创建：已存在存活实例时这里失败，新 daemon 立即退出（单实例契约）。
        write_daemon_info_exclusive(&config.info_path, &info)?;
        log::info!("cli-manager-daemon listening on 127.0.0.1:{port}, hook on {hook_port}");

        let server = Arc::new(DaemonServer {
            host: Arc::new(DaemonHost::new()),
            next_client_id: AtomicU64::new(1),
            token: token.clone(),
            version: config.version,
            info_path: config.info_path,
        });

        let hook_host = Arc::clone(&server.host);
        let dispatcher = DispatcherHandle::start("daemon");
        let hook_sink: HookPayloadSink = Arc::new(move |payload| {
            maybe_activate_app_for_hook(&payload);
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
            Ok(writer) => Arc::new(Mutex::new(writer)),
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
                    let _ = write_frame(
                        &writer,
                        &DaemonFrame::AuthOk {
                            daemon_version: self.version.clone(),
                            pid: std::process::id(),
                        },
                    );
                }
                _ => {
                    log::warn!("daemon auth rejected ({peer})");
                    let _ = write_frame(
                        &writer,
                        &DaemonFrame::AuthErr {
                            reason: "auth_failed".to_string(),
                        },
                    );
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
                },
            );
        }
        log::info!("daemon client connected ({peer}, id={client_id})");

        while let Some(line) = read_line_bounded(&mut reader) {
            match decode_client_frame(&line) {
                Ok(frame) => {
                    if !self.dispatch(client_id, frame, &writer) {
                        break;
                    }
                }
                Err(ProtocolError::UnknownType(kind)) => {
                    // 前向兼容：未知 type 回错误帧但保持连接。
                    let _ = write_frame(
                        &writer,
                        &DaemonFrame::Err {
                            id: 0,
                            message: format!("unknown frame type: {kind}"),
                        },
                    );
                }
                Err(ProtocolError::Malformed(reason)) => {
                    log::warn!("daemon malformed frame ({peer}): {reason}");
                    break; // 非法帧断连（契约）。
                }
            }
        }

        if let Ok(mut clients) = self.host.clients.lock() {
            clients.remove(&client_id);
        }
        log::info!("daemon client disconnected ({peer}, id={client_id})");
    }

    /// 返回 false 表示应结束该连接。
    fn dispatch(&self, client_id: u64, frame: ClientFrame, writer: &Arc<Mutex<TcpStream>>) -> bool {
        // 积压 hook 上报在首次 List 时补发（而非连接瞬间）：此时前端 webview
        // 的事件监听器已就绪（恢复流程先查会话列表），避免 re-emit 被丢。
        if matches!(frame, ClientFrame::List { .. }) {
            self.host.flush_hook_cache_to(writer);
        }
        let reply = self.handle_frame(client_id, frame);
        write_frame(writer, &reply).is_ok()
    }

    fn handle_frame(&self, client_id: u64, frame: ClientFrame) -> DaemonFrame {
        match frame {
            ClientFrame::Auth { .. } => DaemonFrame::Err {
                id: 0,
                message: "already authenticated".to_string(),
            },
            ClientFrame::Ping { id } => DaemonFrame::Pong { id },
            ClientFrame::List { id } => {
                let sessions = self
                    .host
                    .sessions
                    .lock()
                    .map(|sessions| sessions.values().map(|s| s.meta.clone()).collect())
                    .unwrap_or_default();
                DaemonFrame::Sessions { id, sessions }
            }
            ClientFrame::Create {
                id,
                session_id,
                cwd,
                env_vars,
                shell,
            } => self.handle_create(id, session_id, cwd, env_vars, shell),
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
            ClientFrame::Resize {
                id,
                session_id,
                cols,
                rows,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                match self.host.pty.resize(&session_id, cols, rows) {
                    Ok(()) => DaemonFrame::Ok { id },
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
                match result {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::Attach { id, session_id } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                let attach_info = self.host.sessions.lock().ok().and_then(|sessions| {
                    sessions
                        .get(&session_id)
                        .map(|entry| (entry.meta.clone(), entry.buffer.replay_bytes()))
                });
                match attach_info {
                    Some((meta, replay)) => {
                        if let Ok(mut clients) = self.host.clients.lock() {
                            if let Some(client) = clients.get_mut(&client_id) {
                                client.attached.insert(session_id.clone());
                            }
                        }
                        DaemonFrame::Attached {
                            id,
                            session_id,
                            replay_base64: STANDARD.encode(replay),
                            meta,
                        }
                    }
                    None => err_frame(id, "session not found"),
                }
            }
            ClientFrame::Detach { id } => {
                if let Ok(mut clients) = self.host.clients.lock() {
                    if let Some(client) = clients.get_mut(&client_id) {
                        client.attached.clear();
                    }
                }
                DaemonFrame::Ok { id }
            }
            ClientFrame::Reconcile {
                id,
                active_session_ids,
            } => {
                let summary = self.host.pty.reconcile_active_sessions(active_session_ids);
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
        id: u64,
        session_id: String,
        cwd: Option<String>,
        env_vars: Option<HashMap<String, String>>,
        shell: Option<String>,
    ) -> DaemonFrame {
        if !is_valid_session_id(&session_id) {
            return err_frame(id, "invalid session id");
        }
        {
            let Ok(sessions) = self.host.sessions.lock() else {
                return err_frame(id, "daemon state unavailable");
            };
            if sessions.contains_key(&session_id) {
                return err_frame(id, "session already exists");
            }
            if sessions.values().filter(|s| s.meta.alive).count() >= MAX_SESSIONS {
                return err_frame(id, "session limit reached");
            }
        }
        let sink = Arc::new(DaemonPtyEventSink {
            host: Arc::clone(&self.host),
        });
        // 先登记会话表再启动 PTY：reader 线程首帧输出可能早于登记完成。
        if let Ok(mut sessions) = self.host.sessions.lock() {
            sessions.insert(
                session_id.clone(),
                SessionEntry {
                    meta: SessionMeta {
                        session_id: session_id.clone(),
                        cwd: cwd.clone(),
                        shell: shell.clone(),
                        alive: true,
                        task_status: None,
                        task_updated_at_ms: None,
                        created_at_ms: now_ms(),
                    },
                    buffer: SessionBuffer::new(),
                },
            );
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

fn write_frame(writer: &Arc<Mutex<TcpStream>>, frame: &DaemonFrame) -> std::io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| std::io::Error::other("writer poisoned"))?;
    writer.write_all(encode_frame(frame).as_bytes())
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
    fn session_buffer_caps_by_dropping_whole_frames() {
        let mut buffer = SessionBuffer::new();
        let frame = vec![b'x'; 1024 * 1024]; // 1 MiB/帧
        buffer.push_frame(&frame);
        buffer.push_frame(&frame);
        buffer.push_frame(&frame); // 超 2 MiB，最旧帧被整帧丢弃
        assert!(buffer.total_bytes <= SESSION_BUFFER_MAX_BYTES);
        assert_eq!(buffer.frames.len(), 2);
        assert_eq!(buffer.replay_bytes().len(), buffer.total_bytes);
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
