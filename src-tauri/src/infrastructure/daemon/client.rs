//! 主进程侧 daemon 客户端：发现/拉起 daemon、鉴权连接、请求-应答关联、
//! 低频请求代理与 hook 通知转发；终端输出由 WebView 直连 WebSocket 接收。
//!
//! PtyHost daemon 是唯一生产终端路径；本模块失败时返回 Err/None，绝不 panic，
//! 由命令层向前端明确报告终端暂不可用。

use super::discovery::{
    daemon_info_path, is_pid_alive, read_daemon_info, remove_daemon_info, DaemonInfo,
};
use super::protocol::{
    decode_daemon_frame, encode_frame, ClientFrame, DaemonFrame, ProtocolError, SessionMeta,
    MAX_FRAME_BYTES,
};
use crate::pty::manager::PtyProcessStatus;
use crate::ssh_launch::SshLaunchPlan;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const AUTH_READ_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const SPAWN_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const SPAWN_RETRY_MAX: usize = 20;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
// 返回仅隐藏控制台的 Windows 创建标志，保留 ConPTY 的 Ctrl+C 进程组兼容性。
fn windows_daemon_creation_flags() -> u32 {
    CREATE_NO_WINDOW
}

pub struct DaemonClient {
    info: DaemonInfo,
    writer: Mutex<TcpStream>,
    pending: Mutex<HashMap<u64, SyncSender<DaemonFrame>>>,
    next_id: AtomicU64,
    connected: Arc<AtomicBool>,
}

/// Tauri managed state：daemon 客户端插槽。
/// None = daemon 尚未就绪或连接已失效。
pub struct DaemonBridge {
    inner: Mutex<Option<Arc<DaemonClient>>>,
}

impl DaemonBridge {
    // 创建尚未连接 daemon 的客户端插槽。
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    // 在锁可用时替换客户端插槽，锁中毒时不更新。
    pub fn set(&self, client: Arc<DaemonClient>) {
        if let Ok(mut inner) = self.inner.lock() {
            *inner = Some(client);
        }
    }

    /// 取存活的客户端；连接已断则清槽返回 None。
    // 返回标记为已连接的客户端，发现断连时清空插槽。
    pub fn get(&self) -> Option<Arc<DaemonClient>> {
        let mut inner = self.inner.lock().ok()?;
        match inner.as_ref() {
            Some(client) if client.is_connected() => Some(Arc::clone(client)),
            Some(_) => {
                *inner = None;
                None
            }
            None => None,
        }
    }
}

impl DaemonClient {
    // 借用当前 daemon 发现及握手信息。
    pub fn info(&self) -> &DaemonInfo {
        &self.info
    }

    // 读取接收线程维护的连接状态标记，不主动探测网络。
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// 连接并完成鉴权握手；成功后启动推送分发线程。
    // 连接本机 daemon 并完成鉴权，更新协议能力后启动后台接收线程。
    pub fn connect(mut info: DaemonInfo, app_handle: AppHandle) -> Result<Arc<Self>, String> {
        let addr = SocketAddr::from(([127, 0, 0, 1], info.port));
        let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
            .map_err(|err| format!("daemon connect failed: {err}"))?;
        let _ = stream.set_nodelay(true);
        let mut writer = stream
            .try_clone()
            .map_err(|err| format!("daemon stream clone failed: {err}"))?;
        writer
            .set_write_timeout(Some(REQUEST_TIMEOUT))
            .map_err(|err| format!("daemon write timeout setup failed: {err}"))?;
        writer
            .write_all(
                encode_frame(&ClientFrame::Auth {
                    token: info.token.clone(),
                    client_version: env!("CARGO_PKG_VERSION").to_string(),
                })
                .as_bytes(),
            )
            .map_err(|err| format!("daemon auth write failed: {err}"))?;

        let _ = stream.set_read_timeout(Some(AUTH_READ_TIMEOUT));
        let mut reader = BufReader::new(stream);
        let first = read_line_bounded(&mut reader).ok_or("daemon auth read failed")?;
        match decode_daemon_frame(&first) {
            Ok(DaemonFrame::AuthOk {
                daemon_version,
                protocol_version,
                binary_protocol_version,
                features,
                ..
            }) => {
                if daemon_version != env!("CARGO_PKG_VERSION") {
                    log::warn!(
                        "daemon version mismatch: daemon={daemon_version}, app={}",
                        env!("CARGO_PKG_VERSION")
                    );
                }
                info.protocol_version = protocol_version;
                info.binary_protocol_version = binary_protocol_version;
                info.features = features;
            }
            Ok(DaemonFrame::AuthErr { reason }) => {
                return Err(format!("daemon auth rejected: {reason}"));
            }
            other => return Err(format!("daemon auth unexpected reply: {other:?}")),
        }
        let _ = reader.get_ref().set_read_timeout(None);

        let client = Arc::new(DaemonClient {
            info,
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            connected: Arc::new(AtomicBool::new(true)),
        });
        client.spawn_reader(reader, app_handle);
        Ok(client)
    }

    // 启动接收分发线程，读取结束或帧损坏后标记断连并清除等待请求。
    fn spawn_reader(self: &Arc<Self>, mut reader: BufReader<TcpStream>, app_handle: AppHandle) {
        let client = Arc::clone(self);
        std::thread::spawn(move || {
            while let Some(line) = read_line_bounded(&mut reader) {
                match decode_daemon_frame(&line) {
                    Ok(frame) => client.route_frame(frame, &app_handle),
                    Err(ProtocolError::UnknownType(_)) => {
                        log::warn!("daemon pushed unknown frame type");
                    }
                    Err(ProtocolError::Malformed(_)) => {
                        log::warn!("daemon pushed malformed frame");
                        break;
                    }
                }
            }
            client.connected.store(false, Ordering::SeqCst);
            // 唤醒所有等待中的请求（发送端 drop 即 RecvTimeoutError::Disconnected）。
            if let Ok(mut pending) = client.pending.lock() {
                pending.clear();
            }
            log::warn!("daemon connection lost");
        });
    }

    // 将异步输出与通知转发到应用事件，将带请求 ID 的应答送回等待方。
    fn route_frame(&self, frame: DaemonFrame, app_handle: &AppHandle) {
        match frame {
            DaemonFrame::Output {
                session_id,
                sequence,
                cols,
                rows,
                data_base64,
            } => {
                let _ = app_handle.emit(
                    "pty-legacy-output",
                    serde_json::json!({
                        "sessionId": session_id,
                        "sequence": sequence,
                        "cols": cols,
                        "rows": rows,
                        "dataBase64": data_base64,
                    }),
                );
            }
            DaemonFrame::Exit {
                session_id,
                exit_code,
            } => {
                let _ = app_handle.emit(
                    &format!("pty-status-{session_id}"),
                    PtyProcessStatus {
                        status: "exited".to_string(),
                        exit_code,
                    },
                );
                let _ = app_handle.emit(
                    "pty-legacy-status",
                    serde_json::json!({
                        "sessionId": session_id,
                        "status": "exited",
                        "exit_code": exit_code,
                    }),
                );
            }
            DaemonFrame::HookReport { payload } => {
                let _ = app_handle.emit("claude-hook-notification", payload);
            }
            DaemonFrame::SshAgentHookGap { host_id, dropped } => {
                let _ = app_handle.emit(
                    "ssh-agent-hook-gap",
                    serde_json::json!({ "hostId": host_id, "dropped": dropped }),
                );
            }
            DaemonFrame::CheckpointAccepted { .. } | DaemonFrame::CheckpointRejected { .. } => {}
            DaemonFrame::RoutingEvent { event } => {
                if let Some(id) = event.request_id {
                    let sender = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
                    if let Some(sender) = sender {
                        let _ = sender.send(DaemonFrame::RoutingEvent { event });
                    }
                } else {
                    let _ = app_handle.emit("routing-event", event);
                }
            }
            DaemonFrame::Pong { id }
            | DaemonFrame::Ok { id }
            | DaemonFrame::Created { id, .. }
            | DaemonFrame::Err { id, .. }
            | DaemonFrame::Sessions { id, .. }
            | DaemonFrame::Statuses { id, .. }
            | DaemonFrame::Reconciled { id, .. }
            | DaemonFrame::SshAgentResponse { id, .. }
            | DaemonFrame::Attached { id, .. } => {
                let sender = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
                if let Some(sender) = sender {
                    let _ = sender.send(frame);
                }
            }
            DaemonFrame::AuthOk { .. } | DaemonFrame::AuthErr { .. } => {
                log::warn!("daemon sent auth frame after handshake");
            }
        }
    }

    // 原子递增并返回下一个请求 ID。
    pub fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// 发请求并等待对应 id 的应答（超时/断连返回 Err）。
    // 使用默认应答等待时限发送请求。
    pub fn request(&self, id: u64, frame: &ClientFrame) -> Result<DaemonFrame, String> {
        self.request_with_timeout(id, frame, REQUEST_TIMEOUT)
    }

    // 登记请求并写入连接，随后限时等待对应应答；等待失败时移除登记。
    fn request_with_timeout(
        &self,
        id: u64,
        frame: &ClientFrame,
        timeout: Duration,
    ) -> Result<DaemonFrame, String> {
        if !self.is_connected() {
            return Err("daemon disconnected".to_string());
        }
        let (tx, rx) = sync_channel(1);
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, tx);
        }
        let write_result = self
            .writer
            .lock()
            .map_err(|_| "daemon writer poisoned".to_string())
            .and_then(|mut writer| {
                writer
                    .write_all(encode_frame(frame).as_bytes())
                    .map_err(|err| {
                        self.connected.store(false, Ordering::SeqCst);
                        format!("daemon write failed: {err}")
                    })
            });
        if let Err(error) = write_result {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        let reply = rx
            .recv_timeout(timeout)
            .map_err(|err| format!("daemon reply timeout: {err}"));
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
        reply
    }

    // 发送请求并要求 Ok 应答，daemon 错误或其他帧转换为错误。
    fn expect_ok(&self, frame: &ClientFrame, id: u64) -> Result<(), String> {
        match self.request(id, frame)? {
            DaemonFrame::Ok { .. } => Ok(()),
            DaemonFrame::Err { message, .. } => Err(message),
            other => Err(format!("daemon unexpected reply: {other:?}")),
        }
    }

    // 请求当前会话列表并检查响应类型。
    pub fn list(&self) -> Result<Vec<SessionMeta>, String> {
        let id = self.next_request_id();
        match self.request(id, &ClientFrame::List { id })? {
            DaemonFrame::Sessions { sessions, .. } => Ok(sessions),
            DaemonFrame::Err { message, .. } => Err(message),
            other => Err(format!("daemon unexpected reply: {other:?}")),
        }
    }

    // 获取所有会话状态并转换为前端使用的进程状态结构。
    pub fn status_all(&self) -> Result<HashMap<String, PtyProcessStatus>, String> {
        let id = self.next_request_id();
        match self.request(id, &ClientFrame::Status { id })? {
            DaemonFrame::Statuses { statuses, .. } => Ok(statuses
                .into_iter()
                .map(|(session_id, status)| {
                    (
                        session_id,
                        PtyProcessStatus {
                            status: status.status,
                            exit_code: status.exit_code,
                        },
                    )
                })
                .collect()),
            DaemonFrame::Err { message, .. } => Err(message),
            other => Err(format!("daemon unexpected reply: {other:?}")),
        }
    }

    // 提交当前活动会话标识列表，返回 daemon 的协调摘要。
    pub fn reconcile(&self, active_session_ids: Vec<String>) -> Result<serde_json::Value, String> {
        let id = self.next_request_id();
        match self.request(
            id,
            &ClientFrame::Reconcile {
                id,
                active_session_ids,
            },
        )? {
            DaemonFrame::Reconciled { summary, .. } => Ok(summary),
            DaemonFrame::Err { message, .. } => Err(message),
            other => Err(format!("daemon unexpected reply: {other:?}")),
        }
    }

    // 请求 daemon 在允许的空闲状态下关闭，并等待确认。
    pub fn shutdown_if_idle(&self) -> Result<(), String> {
        let id = self.next_request_id();
        self.expect_ok(&ClientFrame::Shutdown { id }, id)
    }

    // 按远程请求类别选择应答等待时限，发送 SSH Agent 请求并返回其载荷。
    pub fn ssh_agent_request(
        &self,
        consumer_id: String,
        ssh_launch: SshLaunchPlan,
        request_kind: String,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_request_id();
        let timeout = if matches!(
            request_kind.as_str(),
            "gitFetch" | "gitPush" | "gitPull" | "gitSmartCheckout"
        ) {
            Duration::from_secs(190)
        } else if request_kind.starts_with("git") {
            Duration::from_secs(100)
        } else {
            Duration::from_secs(75)
        };
        match self.request_with_timeout(
            id,
            &ClientFrame::SshAgentRequest {
                id,
                consumer_id,
                ssh_launch,
                request_kind,
                payload,
            },
            timeout,
        )? {
            DaemonFrame::SshAgentResponse { payload, .. } => Ok(payload),
            DaemonFrame::Err { message, .. } => Err(message),
            other => Err(format!("daemon unexpected reply: {other:?}")),
        }
    }

    // 通知 daemon 释放指定主机的消费者引用，并等待确认。
    pub fn ssh_agent_release(&self, host_id: String, consumer_id: String) -> Result<(), String> {
        let id = self.next_request_id();
        self.expect_ok(
            &ClientFrame::SshAgentRelease {
                id,
                host_id,
                consumer_id,
            },
            id,
        )
    }
}

/// 发现或拉起 daemon 并建立连接。失败返回 Err，由调用方向前端报告不可用。
// 优先连接已记录的存活 daemon，空闲旧版本可重启；失效记录移除后重新启动。
pub fn connect_or_spawn(
    app_handle: AppHandle,
    data_dir: &Path,
    is_dev: bool,
) -> Result<Arc<DaemonClient>, String> {
    let info_path = daemon_info_path(data_dir, is_dev);

    // 1) 已有存活 daemon → 直接连。
    if let Some(info) = read_daemon_info(&info_path)? {
        if is_pid_alive(info.pid) {
            match DaemonClient::connect(info.clone(), app_handle.clone()) {
                Ok(client) => {
                    // 版本不匹配且无存活会话 → 让旧 daemon 自杀后重拉（契约升级路径）。
                    if client.info().version != env!("CARGO_PKG_VERSION") {
                        let no_alive = client
                            .list()
                            .map(|sessions| sessions.iter().all(|s| !s.alive))
                            .unwrap_or(false);
                        if no_alive && client.shutdown_if_idle().is_ok() {
                            std::thread::sleep(Duration::from_millis(500));
                            return spawn_and_connect(app_handle, &info_path);
                        }
                        log::warn!(
                            "daemon version mismatch with active sessions, keeping old daemon"
                        );
                    }
                    return Ok(client);
                }
                Err(err) => {
                    log::warn!("daemon handshake with recorded instance failed: {err}");
                    // 握手不上视为僵尸：删残留文件走重拉（孤儿清扫契约）。
                    remove_daemon_info(&info_path);
                }
            }
        } else {
            log::info!("stale daemon info found (pid dead), removing");
            remove_daemon_info(&info_path);
        }
    }

    // 2) 拉起新 daemon 并重试连接。
    spawn_and_connect(app_handle, &info_path)
}

// 启动 daemon 后按固定间隔重试发现与鉴权，耗尽次数则返回未就绪错误。
fn spawn_and_connect(app_handle: AppHandle, info_path: &Path) -> Result<Arc<DaemonClient>, String> {
    spawn_daemon_process()?;
    for _ in 0..SPAWN_RETRY_MAX {
        std::thread::sleep(SPAWN_RETRY_INTERVAL);
        if let Some(info) = read_daemon_info(info_path)? {
            match DaemonClient::connect(info, app_handle.clone()) {
                Ok(client) => return Ok(client),
                Err(_) => continue,
            }
        }
    }
    Err("daemon did not become ready in time".to_string())
}

// 取得当前可执行文件路径并确认仍为文件，作为 daemon 自启动入口。
fn daemon_executable_path() -> Result<std::path::PathBuf, String> {
    let current = std::env::current_exe().map_err(|err| format!("current_exe failed: {err}"))?;
    if current.is_file() {
        return Ok(current);
    }
    Err("main executable not found for daemon self-spawn".to_string())
}

// 以 __daemon 子命令启动当前程序，丢弃标准流；Unix 使用独立会话，Windows 隐藏窗口。
fn spawn_daemon_process() -> Result<(), String> {
    let exe = daemon_executable_path()?;
    let mut command = std::process::Command::new(&exe);
    command
        .arg("__daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 仅隐藏控制台窗口。不要创建 detached/new process group：ConPTY 收到 ETX
        // 后需要向兼容的控制台进程组投递 Ctrl+C，否则普通输入正常但运行任务无法中断。
        command.creation_flags(windows_daemon_creation_flags());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 独立进程组：app 收到的 SIGINT/SIGTERM 组信号不波及 daemon（契约）。
        // Keep the daemon in an independent session so GUI exit signals do not
        // reach it. A separate process group alone is not sufficient on macOS.
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("spawn daemon failed: {err}"))
}

/// 读一行并施加单帧字节上限（与 daemon 服务端同规则）。
// 在帧字节预算内读取带换行的 UTF-8 文本，移除 CR/LF；不完整或读取失败返回 None。
fn read_line_bounded(reader: &mut BufReader<TcpStream>) -> Option<String> {
    let mut buf = Vec::new();
    let mut limited = reader.by_ref().take((MAX_FRAME_BYTES + 1) as u64);
    match limited.read_until(b'\n', &mut buf) {
        Ok(0) => None,
        Ok(_) => {
            if buf.last() != Some(&b'\n') {
                return None;
            }
            buf.pop();
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            String::from_utf8(buf).ok()
        }
        Err(err) => {
            log::warn!("daemon client read failed: {err}");
            None
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    // 验证 Windows daemon 不启用 detached 或新进程组标志。
    fn windows_daemon_keeps_conpty_ctrl_c_process_group_compatible() {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

        let flags = windows_daemon_creation_flags();
        assert_eq!(flags, CREATE_NO_WINDOW);
        assert_eq!(flags & DETACHED_PROCESS, 0);
        assert_eq!(flags & CREATE_NEW_PROCESS_GROUP, 0);
    }
}
