//! daemon TCP 服务：鉴权、帧分发、PTY 会话托管、ring buffer 回放、空闲自灭。
//!
//! 增量 2：接入 `PtyManager`（经 `PtyEventSink` 解耦）。输出帧在 PTY reader
//! 线程已按 ANSI/UTF-8 安全边界切好，本层只整帧存储/透传（契约禁止再分片）。
//! 增量 3 待办：Windows Job Object 兜底、hook 上报转发、exited 会话宽限自灭。

mod replay;
use replay::{ReplayFrame, SessionBuffer};
mod client_transport;
use client_transport::{frame_payload_bytes, ClientTransport, ClientWriter};
mod pty_events;
use pty_events::DaemonPtyEventSink;

use super::discovery::{remove_daemon_info, write_daemon_info_exclusive, DaemonInfo};
use super::protocol::{
    decode_binary_terminal_frame, decode_client_frame, routing_control_id, supported_features,
    ClientFrame, DaemonFrame, ProcessTraits, ProtocolError, RoutingCircuitStatus, RoutingError,
    RoutingEvent, RoutingStatus, SessionMeta, SessionStatusInfo, BINARY_KIND_CHECKPOINT,
    BINARY_KIND_INPUT, BINARY_PROTOCOL_VERSION, CONTROL_PROTOCOL_VERSION, MAX_FRAME_BYTES,
};
use super::routing::{PortAllocator, RoutingRuntime, FALLBACK_PORT_START};
use super::ssh_agent_bridge::SshAgentBridgeManager;
use crate::claude_hook::{
    approval_aware_hook_sink, remote_hook_payload_from_spool, spawn_hook_listener, HookPayloadSink,
};
use crate::commands::cc_connect::handoff_notification::RemoteHandoffNotifier;
use crate::pty::manager::PtyManager;
use crate::ssh_launch::SshLaunchPlan;
use crate::third_party_notification::DispatcherHandle;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
const OUTPUT_BUFFERING_MAX_BYTES: usize = 64 * 1024;
const CLIENT_OUTPUT_HIGH_WATERMARK: usize = 100_000;
const CLIENT_OUTPUT_LOW_WATERMARK: usize = 5_000;
const CLIENT_OUTPUT_QUEUE_MAX_BYTES: usize = 2 * 1024 * 1024;
const CLIENT_CONTROL_QUEUE_MAX_FRAMES: usize = 256;

struct ClientHandle {
    writer: Arc<ClientWriter>,
    attached: HashSet<String>,
    unacknowledged_chars: HashMap<String, usize>,
    flow_control_paused: HashSet<String>,
    last_sent_sequence: HashMap<String, u64>,
    last_acknowledged_sequence: HashMap<String, u64>,
    attaching: HashMap<String, Vec<DaemonFrame>>,
}

fn clear_client_session_state(client: &mut ClientHandle, session_id: &str) {
    client.attached.remove(session_id);
    client.unacknowledged_chars.remove(session_id);
    client.flow_control_paused.remove(session_id);
    client.last_sent_sequence.remove(session_id);
    client.last_acknowledged_sequence.remove(session_id);
    client.attaching.remove(session_id);
}

struct SessionEntry {
    meta: SessionMeta,
    buffer: SessionBuffer,
    cols: u16,
    rows: u16,
    next_sequence: u64,
    ssh_hook_binding: Option<SshHookBinding>,
}

struct SshHookBinding {
    host_id: String,
    client_instance_id: String,
    project_id: String,
    project_name: String,
    bridge_epoch: String,
    installation_id: String,
    source: String,
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
    hook_gap_cache: Mutex<VecDeque<(String, u64)>>,
    hook_sink: Mutex<Option<HookPayloadSink>>,
    ssh_agent_bridges: SshAgentBridgeManager,
    routing: Mutex<RoutingRuntime>,
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
            hook_gap_cache: Mutex::new(VecDeque::new()),
            hook_sink: Mutex::new(None),
            ssh_agent_bridges: SshAgentBridgeManager::default(),
            routing: Mutex::new(RoutingRuntime::new()),
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

    fn set_hook_sink(&self, sink: HookPayloadSink) {
        if let Ok(mut current) = self.hook_sink.lock() {
            *current = Some(sink);
        }
    }

    fn ensure_ssh_agent_bridge(self: &Arc<Self>, session_id: &str, plan: &SshLaunchPlan) {
        self.ssh_agent_bridges
            .ensure(Arc::downgrade(self), session_id, plan);
    }

    fn release_ssh_agent_bridge(&self, session_id: &str) {
        let host_id = self.get_session(session_id).and_then(|session| {
            session
                .lock()
                .ok()
                .and_then(|entry| entry.meta.ssh_host_id.clone())
        });
        if let Some(host_id) = host_id {
            self.ssh_agent_bridges.release(&host_id, session_id);
        }
    }

    fn routing_status(&self) -> RoutingStatus {
        self.routing
            .lock()
            .map(|runtime| {
                let snapshot = runtime.snapshot();
                let circuit_states = runtime
                    .circuit_snapshots()
                    .into_iter()
                    .map(|circuit| RoutingCircuitStatus {
                        app_type: circuit.app_type,
                        provider_id: circuit.provider_id,
                        status: circuit.status,
                        consecutive_failures: circuit.consecutive_failures,
                        successful_probes: circuit.successful_probes,
                    })
                    .collect();
                RoutingStatus {
                    status: snapshot.status,
                    listener_addresses: snapshot.listen_addresses,
                    preferred_port: snapshot.preferred_port,
                    actual_port: snapshot.actual_port,
                    circuit_states,
                }
            })
            .unwrap_or(RoutingStatus {
                status: "unknown".to_string(),
                listener_addresses: Vec::new(),
                preferred_port: FALLBACK_PORT_START,
                actual_port: None,
                circuit_states: Vec::new(),
            })
    }

    fn routing_start(
        &self,
        listen_addresses: &[String],
        preferred_port: u16,
        last_actual_port: Option<u16>,
    ) -> Result<RoutingStatus, String> {
        let mut runtime = self
            .routing
            .lock()
            .map_err(|_| "routing_runtime_unavailable".to_string())?;
        runtime.start(listen_addresses, preferred_port, last_actual_port)?;
        drop(runtime);
        Ok(self.routing_status())
    }

    fn routing_reload(
        &self,
        listen_addresses: &[String],
        preferred_port: u16,
        last_actual_port: Option<u16>,
    ) -> Result<RoutingStatus, String> {
        let normalized_addresses = if listen_addresses.is_empty() {
            Vec::new()
        } else {
            PortAllocator::validate_addresses(listen_addresses)?
        };
        let mut runtime = self
            .routing
            .lock()
            .map_err(|_| "routing_runtime_unavailable".to_string())?;
        if runtime.is_running() {
            runtime.rebind(&normalized_addresses, preferred_port, last_actual_port)?;
        } else {
            runtime.snapshot();
        }
        drop(runtime);
        Ok(self.routing_status())
    }

    fn routing_stop(&self) -> Result<RoutingStatus, String> {
        let mut runtime = self
            .routing
            .lock()
            .map_err(|_| "routing_runtime_unavailable".to_string())?;
        runtime.stop();
        drop(runtime);
        Ok(self.routing_status())
    }

    fn routing_reset_circuit(
        &self,
        app_type: &str,
        provider_id: &str,
    ) -> Result<RoutingStatus, String> {
        let app_type = crate::provider::routing::normalize_routing_app_type(app_type)?;
        let runtime = self
            .routing
            .lock()
            .map_err(|_| "routing_runtime_unavailable".to_string())?;
        runtime.reset_circuit(&app_type, provider_id);
        drop(runtime);
        Ok(self.routing_status())
    }

    fn routing_is_running(&self) -> bool {
        self.routing
            .lock()
            .map(|runtime| runtime.is_running())
            .unwrap_or(false)
    }

    pub(crate) fn accept_remote_hook_event(&self, value: serde_json::Value) {
        let Some(tab_id) = value.get("tabId").and_then(serde_json::Value::as_str) else {
            return;
        };
        let project_name = self.get_session(tab_id).and_then(|session| {
            session.lock().ok().and_then(|entry| {
                let Some(binding) = entry.ssh_hook_binding.as_ref() else {
                    return None;
                };
                if !entry.meta.alive {
                    return None;
                }
                let field = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
                (field("hostId") == Some(binding.host_id.as_str())
                    && field("clientInstanceId") == Some(binding.client_instance_id.as_str())
                    && field("projectId") == Some(binding.project_id.as_str())
                    && field("bridgeEpoch") == Some(binding.bridge_epoch.as_str())
                    && field("installationId") == Some(binding.installation_id.as_str())
                    && field("source") == Some(binding.source.as_str()))
                .then(|| binding.project_name.clone())
            })
        });
        let Some(project_name) = project_name else {
            log::warn!("rejected remote Hook event with an unknown SSH session binding");
            return;
        };
        let payload = match remote_hook_payload_from_spool(&value) {
            Ok(payload) => payload,
            Err(error) => {
                log::warn!("rejected invalid remote Hook event: {error}");
                return;
            }
        }
        .with_remote_project_name(project_name);
        let sink = self
            .hook_sink
            .lock()
            .ok()
            .and_then(|sink| sink.as_ref().cloned());
        if let Some(sink) = sink {
            sink(payload);
        }
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
                ssh_hook_binding: ssh_launch.and_then(|plan| {
                    (!plan.client_instance_id.is_empty()
                        && !plan.project_id.is_empty()
                        && !plan.bridge_epoch.is_empty()
                        && !plan.agent_installation_id.is_empty()
                        && !plan.tool_source.is_empty())
                    .then(|| SshHookBinding {
                        host_id: plan.host_id.clone(),
                        client_instance_id: plan.client_instance_id.clone(),
                        project_id: plan.project_id.clone(),
                        project_name: plan.project_name.clone(),
                        bridge_epoch: plan.bridge_epoch.clone(),
                        installation_id: plan.agent_installation_id.clone(),
                        source: plan.tool_source.clone(),
                    })
                }),
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

    pub(crate) fn broadcast_remote_hook_gap(&self, host_id: String, dropped: u64) {
        let frame = DaemonFrame::SshAgentHookGap {
            host_id: host_id.clone(),
            dropped,
        };
        let Ok(clients) = self.clients.lock() else {
            return;
        };
        if clients.is_empty() {
            drop(clients);
            if let Ok(mut cache) = self.hook_gap_cache.lock() {
                cache.push_back((host_id, dropped));
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
        let gaps: Vec<(String, u64)> = match self.hook_gap_cache.lock() {
            Ok(mut cache) => cache.drain(..).collect(),
            Err(_) => return,
        };
        for (host_id, dropped) in gaps {
            let _ = writer.send_frame(&DaemonFrame::SshAgentHookGap { host_id, dropped });
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
            if client.attaching.contains_key(session_id) {
                let buffered_bytes = {
                    let buffered = client
                        .attaching
                        .get_mut(session_id)
                        .expect("attaching entry exists");
                    buffered.push(frame.clone());
                    buffered.iter().map(frame_payload_bytes).sum::<usize>()
                };
                let unacknowledged = {
                    let count = client
                        .unacknowledged_chars
                        .entry(session_id.to_string())
                        .or_default();
                    *count += char_count;
                    *count
                };
                client
                    .last_sent_sequence
                    .insert(session_id.to_string(), sequence);
                if unacknowledged >= CLIENT_OUTPUT_HIGH_WATERMARK {
                    client.flow_control_paused.insert(session_id.to_string());
                }
                if buffered_bytes > CLIENT_OUTPUT_QUEUE_MAX_BYTES {
                    client.writer.close();
                    clear_client_session_state(client, session_id);
                }
                continue;
            }
            if client.flow_control_paused.contains(session_id) {
                continue;
            }
            let current_unacknowledged = client
                .unacknowledged_chars
                .get(session_id)
                .copied()
                .unwrap_or(0);
            if current_unacknowledged >= CLIENT_OUTPUT_HIGH_WATERMARK {
                client.flow_control_paused.insert(session_id.to_string());
                continue;
            }
            if client.writer.send_frame(frame).is_err() {
                client.writer.close();
                clear_client_session_state(client, session_id);
                continue;
            }
            let unacknowledged = {
                let count = client
                    .unacknowledged_chars
                    .entry(session_id.to_string())
                    .or_default();
                *count += char_count;
                *count
            };
            client
                .last_sent_sequence
                .insert(session_id.to_string(), sequence);
            if unacknowledged >= CLIENT_OUTPUT_HIGH_WATERMARK {
                client.flow_control_paused.insert(session_id.to_string());
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
                clear_client_session_state(client, session_id);
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
        let Some(session) = self.get_session(session_id) else {
            return;
        };
        let Ok(entry) = session.lock() else {
            return;
        };
        let should_flush = {
            let Ok(mut clients) = self.clients.lock() else {
                return;
            };
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
                    let remaining_chars = {
                        let remaining = client
                            .unacknowledged_chars
                            .entry(session_id.to_string())
                            .or_default();
                        *remaining = remaining.saturating_sub(char_count);
                        *remaining
                    };
                    client
                        .last_acknowledged_sequence
                        .insert(session_id.to_string(), sequence);
                    remaining_chars <= CLIENT_OUTPUT_LOW_WATERMARK
                        && client.flow_control_paused.contains(session_id)
                } else {
                    false
                }
            } else {
                false
            }
        };
        if !should_flush {
            return;
        }

        // Read the bounded memory/spool replay while holding only the session
        // lock. In particular, never perform disk I/O while holding the global
        // clients lock: another session must remain able to enqueue output.
        let retained_frames = entry.buffer.live_frames();
        let Ok(mut clients) = self.clients.lock() else {
            return;
        };
        Self::flush_buffered_output_locked(session_id, client_id, &retained_frames, &mut clients);
    }

    fn flush_buffered_output_locked(
        session_id: &str,
        client_id: u64,
        retained_frames: &[ReplayFrame],
        clients: &mut HashMap<u64, ClientHandle>,
    ) {
        let Some(client) = clients.get_mut(&client_id) else {
            return;
        };
        if !client.attached.contains(session_id)
            || client.attaching.contains_key(session_id)
            || !client.flow_control_paused.contains(session_id)
        {
            return;
        }

        let last_sent = client
            .last_sent_sequence
            .get(session_id)
            .copied()
            .unwrap_or(0);
        let first_retained_sequence = retained_frames
            .iter()
            .find(|frame| frame.sequence > last_sent)
            .map(|frame| frame.sequence);
        if first_retained_sequence.is_some_and(|sequence| sequence > last_sent.saturating_add(1)) {
            // The suffix is no longer a complete stream. Closing this client
            // makes the existing reconnect+attach path send replay_reset and
            // the complete retained replay, instead of appending a truncated
            // ANSI stream to the current xterm.
            log::warn!(
                "daemon replay window gap for client {client_id}, session {session_id}; closing client for reset"
            );
            client.writer.close();
            clear_client_session_state(client, session_id);
            return;
        }

        for buffered in SessionBuffer::output_frames_after(retained_frames, last_sent) {
            let current_unacknowledged = client
                .unacknowledged_chars
                .get(session_id)
                .copied()
                .unwrap_or(0);
            if current_unacknowledged >= CLIENT_OUTPUT_HIGH_WATERMARK {
                client.flow_control_paused.insert(session_id.to_string());
                break;
            }
            let frame = DaemonFrame::Output {
                session_id: session_id.to_string(),
                sequence: buffered.sequence,
                cols: buffered.cols,
                rows: buffered.rows,
                data_base64: STANDARD.encode(&buffered.data),
            };
            if client.writer.send_frame(&frame).is_err() {
                client.writer.close();
                clear_client_session_state(client, session_id);
                return;
            }
            let unacknowledged = {
                let count = client
                    .unacknowledged_chars
                    .entry(session_id.to_string())
                    .or_default();
                *count += String::from_utf8_lossy(&buffered.data)
                    .encode_utf16()
                    .count();
                *count
            };
            client
                .last_sent_sequence
                .insert(session_id.to_string(), buffered.sequence);
            if unacknowledged >= CLIENT_OUTPUT_HIGH_WATERMARK {
                client.flow_control_paused.insert(session_id.to_string());
                break;
            }
        }

        if client
            .unacknowledged_chars
            .get(session_id)
            .copied()
            .unwrap_or(0)
            <= CLIENT_OUTPUT_LOW_WATERMARK
        {
            client.flow_control_paused.remove(session_id);
        }
    }

    fn detach_session_from_clients(&self, session_id: &str) {
        if let Ok(mut clients) = self.clients.lock() {
            for client in clients.values_mut() {
                clear_client_session_state(client, session_id);
            }
        }
    }

    fn detach_all_sessions_from_clients(&self) {
        if let Ok(mut clients) = self.clients.lock() {
            for client in clients.values_mut() {
                client.attached.clear();
                client.unacknowledged_chars.clear();
                client.flow_control_paused.clear();
                client.last_sent_sequence.clear();
                client.last_acknowledged_sequence.clear();
                client.attaching.clear();
            }
        }
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
        let handoff_notifier = RemoteHandoffNotifier::start();
        let delivery_sink: HookPayloadSink = Arc::new(move |payload| {
            // 仅当没有已连接的前端客户端时（app 已彻底退到后台，例如托盘退出后
            // 转入后台继续执行）才拉起 app 处理审批或回答。app 正在运行时，事件会通过
            // 下方 broadcast_hook 送达前端，由前端决定是否通知/切换，绝不在此
            // 抢占前台——否则用户在其他应用里工作时会被 PermissionRequest（含
            // Codex 改代码时的误报）强制切回 CLI-Manager。
            if hook_host.client_count() == 0 {
                maybe_activate_app_for_hook(&payload);
            }
            dispatcher.try_enqueue(payload.to_notification_job());
            match serde_json::to_value(&payload) {
                Ok(value) => {
                    handoff_notifier.try_enqueue(value.clone());
                    hook_host.update_task_status_from_hook(&value);
                    hook_host.broadcast_hook(value);
                }
                Err(err) => log::warn!("daemon hook payload serialize failed: {err}"),
            }
        });
        let hook_sink = approval_aware_hook_sink(delivery_sink);
        server.host.set_hook_sink(Arc::clone(&hook_sink));
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
            let busy = server.host.client_count() > 0
                || server.host.alive_session_count() > 0
                || server.host.routing_is_running();
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
                    flow_control_paused: HashSet::new(),
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
                Err(ProtocolError::UnknownType(_)) => {
                    // 前向兼容：未知 type 回错误帧但保持连接。
                    let _ = writer.send_frame(&DaemonFrame::Err {
                        id: 0,
                        message: "unknown frame type".to_string(),
                    });
                }
                Err(ProtocolError::Malformed(_)) => {
                    log::warn!("daemon malformed frame ({peer})");
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
                    flow_control_paused: HashSet::new(),
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
                        if let Some(id) = routing_control_id(&frame) {
                            let _ = writer.send_frame(&DaemonFrame::RoutingEvent {
                                event: RoutingEvent::error(
                                    id,
                                    RoutingError::protocol_unsupported("websocket"),
                                ),
                            });
                            continue;
                        }
                        if !self.dispatch(client_id, frame, &writer) {
                            break;
                        }
                    }
                    Err(ProtocolError::UnknownType(_)) => {
                        let _ = writer.send_frame(&DaemonFrame::Err {
                            id: 0,
                            message: "unknown frame type".to_string(),
                        });
                    }
                    Err(ProtocolError::Malformed(_)) => {
                        log::warn!("daemon websocket malformed frame ({peer})");
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
    fn dispatch(
        self: &Arc<Self>,
        client_id: u64,
        frame: ClientFrame,
        writer: &Arc<ClientWriter>,
    ) -> bool {
        // 积压 hook 上报在首次 List 时补发（而非连接瞬间）：此时前端 webview
        // 的事件监听器已就绪（恢复流程先查会话列表），避免 re-emit 被丢。
        if matches!(frame, ClientFrame::List { .. }) {
            self.host.flush_hook_cache_to(writer);
        }
        if matches!(frame, ClientFrame::SshAgentRequest { .. }) {
            let server = Arc::clone(self);
            let writer = Arc::clone(writer);
            std::thread::spawn(move || {
                let reply = server.handle_frame(client_id, frame);
                let _ = writer.send_frame(&reply);
            });
            return true;
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
                terminal_colors,
            } => self.handle_create(
                client_id,
                id,
                session_id,
                cwd,
                env_vars,
                shell,
                ssh_launch,
                terminal_colors,
            ),
            ClientFrame::SetTerminalColors {
                id,
                session_id,
                terminal_colors,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                match self.host.pty.update_terminal_colors(
                    &session_id,
                    &terminal_colors.foreground,
                    &terminal_colors.background,
                ) {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
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
                    client.flow_control_paused.remove(&session_id);
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
            ClientFrame::SshAgentRequest {
                id,
                consumer_id,
                ssh_launch,
                request_kind,
                payload,
            } => match self.host.ssh_agent_bridges.request(
                Arc::downgrade(&self.host),
                &consumer_id,
                &ssh_launch,
                &request_kind,
                payload,
            ) {
                Ok(payload) => DaemonFrame::SshAgentResponse { id, payload },
                Err(message) => DaemonFrame::Err { id, message },
            },
            ClientFrame::SshAgentRelease {
                id,
                host_id,
                consumer_id,
            } => {
                self.host
                    .ssh_agent_bridges
                    .release_consumer(&host_id, &consumer_id);
                DaemonFrame::Ok { id }
            }
            ClientFrame::RoutingReload {
                id,
                listen_address,
                preferred_port,
                last_actual_port,
                listener_addresses,
            } => {
                let current = self.host.routing_status();
                let addresses = if listener_addresses.is_empty() {
                    if let Some(address) = listen_address {
                        vec![address]
                    } else {
                        current.listener_addresses.clone()
                    }
                } else {
                    listener_addresses
                };
                match self.host.routing_reload(
                    &addresses,
                    preferred_port.unwrap_or(current.preferred_port),
                    last_actual_port.or(current.actual_port),
                ) {
                    Ok(status) => DaemonFrame::RoutingEvent {
                        event: RoutingEvent::status(id, status),
                    },
                    Err(error) => DaemonFrame::RoutingEvent {
                        event: RoutingEvent::error(id, RoutingError::runtime_failure(&error)),
                    },
                }
            }
            ClientFrame::RoutingStatus { id } => DaemonFrame::RoutingEvent {
                event: RoutingEvent::status(id, self.host.routing_status()),
            },
            ClientFrame::RoutingStart {
                id,
                listen_address,
                preferred_port,
                last_actual_port,
                listener_addresses,
            } => {
                let addresses = if listener_addresses.is_empty() {
                    vec![listen_address.unwrap_or_else(|| "127.0.0.1".to_string())]
                } else {
                    listener_addresses
                };
                match self.host.routing_start(
                    &addresses,
                    preferred_port.unwrap_or(FALLBACK_PORT_START),
                    last_actual_port,
                ) {
                    Ok(status) => DaemonFrame::RoutingEvent {
                        event: RoutingEvent::status(id, status),
                    },
                    Err(error) => DaemonFrame::RoutingEvent {
                        event: RoutingEvent::error(id, RoutingError::runtime_failure(&error)),
                    },
                }
            }
            ClientFrame::RoutingStop { id } => match self.host.routing_stop() {
                Ok(status) => DaemonFrame::RoutingEvent {
                    event: RoutingEvent::status(id, status),
                },
                Err(error) => DaemonFrame::RoutingEvent {
                    event: RoutingEvent::error(id, RoutingError::runtime_failure(&error)),
                },
            },
            ClientFrame::RoutingResetCircuit {
                id,
                app_type,
                provider_id,
            } => match self.host.routing_reset_circuit(&app_type, &provider_id) {
                Ok(status) => DaemonFrame::RoutingEvent {
                    event: RoutingEvent::status(id, status),
                },
                Err(error) => DaemonFrame::RoutingEvent {
                    event: RoutingEvent::error(id, RoutingError::runtime_failure(&error)),
                },
            },
            ClientFrame::Shutdown { id } => {
                if self.host.alive_session_count() > 0 || self.host.routing_is_running() {
                    log::info!(
                        "daemon shutdown retained (alive sessions or active routing runtime)"
                    );
                    return DaemonFrame::Ok { id };
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
        terminal_colors: Option<crate::daemon::protocol::TerminalColorSpec>,
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
            client.flow_control_paused.remove(&session_id);
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
            terminal_colors
                .as_ref()
                .map(|colors| (colors.foreground.as_str(), colors.background.as_str())),
            sink,
        ) {
            Ok(process_traits) => {
                if let Some(plan) = ssh_launch.as_ref() {
                    self.host.ensure_ssh_agent_bridge(&session_id, plan);
                }
                self.host
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
                    .unwrap_or_else(|| err_frame(id, "session state unavailable"))
            }
            Err(message) => {
                if let Ok(mut sessions) = self.host.sessions.lock() {
                    sessions.remove(&session_id);
                }
                if let Ok(mut clients) = self.host.clients.lock() {
                    if let Some(client) = clients.get_mut(&client_id) {
                        client.attached.remove(&session_id);
                        client.unacknowledged_chars.remove(&session_id);
                        client.flow_control_paused.remove(&session_id);
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
    if !payload.requires_user_response() {
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
mod tests;
