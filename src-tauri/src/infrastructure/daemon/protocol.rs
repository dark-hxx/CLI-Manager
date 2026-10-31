//! daemon 通信协议：换行分隔 JSON 帧（NDJSON），`type` 字段区分帧类型。
//!
//! 前向兼容约定（契约）：未知字段忽略（serde 默认）；未知 `type` 返回
//! [`ProtocolError::UnknownType`]，由服务端回错误帧而不断连；JSON 解析失败
//! 视为非法帧，调用方应断连。单帧上限 8 MiB 防 DoS。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::ssh_launch::SshLaunchPlan;

/// 单帧最大字节数（含换行前的 JSON 文本）。超限视为非法帧，断连。
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const CONTROL_PROTOCOL_VERSION: u16 = 3;
pub const BINARY_PROTOCOL_VERSION: u8 = 1;
pub const BINARY_KIND_OUTPUT: u8 = 1;
pub const BINARY_KIND_REPLAY: u8 = 2;
pub const BINARY_KIND_INPUT: u8 = 3;
pub const BINARY_KIND_CHECKPOINT: u8 = 4;
pub const BINARY_KIND_REPLAY_RESET: u8 = 5;
const BINARY_HEADER_BYTES: usize = 20;

pub const FEATURE_WS_BINARY_OUTPUT: &str = "ws_binary_output_v1";
pub const FEATURE_WS_BINARY_INPUT: &str = "ws_binary_input_v1";
pub const FEATURE_CHECKPOINT_REPLAY: &str = "checkpoint_replay_v1";
pub const FEATURE_PIXEL_RESIZE: &str = "pixel_resize_v1";
pub const FEATURE_PROCESS_TRAITS: &str = "process_traits_v1";
pub const FEATURE_TERMINAL_COLORS: &str = "terminal_colors_v1";
pub const FEATURE_SSH_AGENT_RPC: &str = "ssh_agent_rpc_v1";
pub const FEATURE_LOCAL_ROUTING_V1: &str = "local_routing_v1";
pub const ROUTING_ERROR_FEATURE_NOT_SUPPORTED: &str = "routing_feature_not_supported";
pub const ROUTING_ERROR_PROTOCOL_UNSUPPORTED: &str = "routing_protocol_unsupported";
pub const ROUTING_ERROR_SERVICE_UNAVAILABLE: &str = "routing_service_unavailable";

// 返回本版本声明支持的能力列表；具体连接是否可用仍由握手和调用方判断。
pub fn supported_features() -> Vec<String> {
    [
        FEATURE_WS_BINARY_OUTPUT,
        FEATURE_WS_BINARY_INPUT,
        FEATURE_CHECKPOINT_REPLAY,
        FEATURE_PIXEL_RESIZE,
        FEATURE_PROCESS_TRAITS,
        FEATURE_TERMINAL_COLORS,
        FEATURE_SSH_AGENT_RPC,
        FEATURE_LOCAL_ROUTING_V1,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// 客户端 → daemon 请求帧。`id` 用于应答关联（Auth 除外，Auth 必须是首帧）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    /// 连接后的首帧，token 校验失败立即断连。
    Auth {
        token: String,
        client_version: String,
    },
    Ping {
        id: u64,
    },
    /// 列出 daemon 持有的全部会话（含已退出但 buffer 未回收的）。
    List {
        id: u64,
    },
    Create {
        id: u64,
        session_id: String,
        cwd: Option<String>,
        env_vars: Option<HashMap<String, String>>,
        shell: Option<String>,
        #[serde(default)]
        ssh_launch: Option<SshLaunchPlan>,
        #[serde(default)]
        terminal_colors: Option<TerminalColorSpec>,
    },
    SetTerminalColors {
        id: u64,
        session_id: String,
        terminal_colors: TerminalColorSpec,
    },
    Write {
        id: u64,
        session_id: String,
        /// UTF-8 文本按原样传输（与 `pty_write` 的 data 参数一致）。
        data: String,
    },
    /// 确认前端已完成 xterm 解析的输出字符数，用于 daemon 背压。
    Ack {
        id: u64,
        session_id: String,
        sequence: u64,
        char_count: usize,
    },
    Resize {
        id: u64,
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        pixel_width: Option<u32>,
        #[serde(default)]
        pixel_height: Option<u32>,
    },
    Close {
        id: u64,
        session_id: String,
    },
    CloseAll {
        id: u64,
    },
    /// 订阅指定会话的输出推送并回放 ring buffer 尾部。
    Attach {
        id: u64,
        session_id: String,
        #[serde(default)]
        after_sequence: Option<u64>,
    },
    /// 取消本连接的全部订阅（app 转后台/正常退出前调用；断连等效）。
    Detach {
        id: u64,
    },
    Reconcile {
        id: u64,
        active_session_ids: Vec<String>,
    },
    Status {
        id: u64,
    },
    SshAgentRequest {
        id: u64,
        consumer_id: String,
        ssh_launch: SshLaunchPlan,
        request_kind: String,
        payload: serde_json::Value,
    },
    SshAgentRelease {
        id: u64,
        host_id: String,
        consumer_id: String,
    },
    RoutingReload {
        id: u64,
        #[serde(default)]
        listen_address: Option<String>,
        #[serde(default)]
        preferred_port: Option<u16>,
        #[serde(default)]
        last_actual_port: Option<u16>,
        #[serde(default)]
        listener_addresses: Vec<String>,
    },
    RoutingStatus {
        id: u64,
    },
    RoutingStart {
        id: u64,
        #[serde(default)]
        listen_address: Option<String>,
        #[serde(default)]
        preferred_port: Option<u16>,
        #[serde(default)]
        last_actual_port: Option<u16>,
        #[serde(default)]
        listener_addresses: Vec<String>,
    },
    RoutingStop {
        id: u64,
    },
    RoutingResetCircuit {
        id: u64,
        app_type: String,
        provider_id: String,
    },
    /// 请求 daemon 自杀（仅在无存活会话时被接受；版本升级路径用）。
    Shutdown {
        id: u64,
    },
}

// 仅提取五类路由控制帧的请求编号，供传输门禁和应答关联使用。
pub fn routing_control_id(frame: &ClientFrame) -> Option<u64> {
    match frame {
        ClientFrame::RoutingReload { id, .. }
        | ClientFrame::RoutingStatus { id }
        | ClientFrame::RoutingStart { id, .. }
        | ClientFrame::RoutingStop { id }
        | ClientFrame::RoutingResetCircuit { id, .. } => Some(*id),
        _ => None,
    }
}

// 检查握手能力列表是否包含本地路由标识；缺失时返回重启提示，不发送请求。
pub fn ensure_local_routing_capability(features: &[String]) -> Result<(), RoutingError> {
    if features
        .iter()
        .any(|feature| feature == FEATURE_LOCAL_ROUTING_V1)
    {
        Ok(())
    } else {
        Err(RoutingError::feature_not_supported())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutingError {
    pub code: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    pub hint: String,
}

impl RoutingError {
    // 构造能力缺失错误，参数仅包含固定能力名，提示调用方重启 daemon。
    pub fn feature_not_supported() -> Self {
        Self {
            code: ROUTING_ERROR_FEATURE_NOT_SUPPORTED.to_string(),
            params: BTreeMap::from([("feature".to_string(), FEATURE_LOCAL_ROUTING_V1.to_string())]),
            hint: "restart_daemon".to_string(),
        }
    }

    // 将传输名称限制为白名单值；未知输入不回显，并提示改用路由 Tauri 命令。
    pub fn protocol_unsupported(transport: &str) -> Self {
        let transport = match transport {
            "websocket" => "websocket",
            "pty_legacy_request" => "pty_legacy_request",
            _ => "unknown",
        };
        Self {
            code: ROUTING_ERROR_PROTOCOL_UNSUPPORTED.to_string(),
            params: BTreeMap::from([("transport".to_string(), transport.to_string())]),
            hint: "use_routing_tauri_command".to_string(),
        }
    }

    // 构造无动态参数的服务不可用错误，提供重试或重启提示。
    pub fn service_unavailable() -> Self {
        Self {
            code: ROUTING_ERROR_SERVICE_UNAVAILABLE.to_string(),
            params: BTreeMap::new(),
            hint: "retry_or_restart_daemon".to_string(),
        }
    }

    // 只保留已知地址/端口错误码，其余归为不可用；端口耗尽提示换端口，其余提示修正输入。
    pub fn runtime_failure(code: &str) -> Self {
        let code = match code {
            "routing_listen_address_invalid"
            | "routing_port_invalid"
            | "routing_port_range_exhausted" => code,
            _ => ROUTING_ERROR_SERVICE_UNAVAILABLE,
        };
        Self {
            code: code.to_string(),
            params: BTreeMap::new(),
            hint: if code == "routing_port_range_exhausted" {
                "choose_another_port".to_string()
            } else {
                "fix_input".to_string()
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RoutingError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<RoutingStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutingCircuitStatus {
    pub app_type: String,
    pub provider_id: String,
    pub status: String,
    pub consecutive_failures: u32,
    pub successful_probes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutingStatus {
    pub status: String,
    #[serde(default)]
    pub listener_addresses: Vec<String>,
    pub preferred_port: u16,
    #[serde(default)]
    pub actual_port: Option<u16>,
    #[serde(default)]
    pub circuit_states: Vec<RoutingCircuitStatus>,
}

impl RoutingEvent {
    // 将错误绑定到请求编号，生成不携带状态快照的错误事件。
    pub fn error(request_id: u64, error: RoutingError) -> Self {
        Self {
            request_id: Some(request_id),
            kind: "error".to_string(),
            error: Some(error),
            status: None,
        }
    }

    // 将状态快照绑定到请求编号，并以快照中的状态字符串作为事件种类。
    pub fn status(request_id: u64, status: RoutingStatus) -> Self {
        Self {
            request_id: Some(request_id),
            kind: status.status.clone(),
            error: None,
            status: Some(status),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalColorSpec {
    pub foreground: String,
    pub background: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsPtyTraits {
    pub backend: String,
    #[serde(default)]
    pub build_number: Option<u32>,
    #[serde(default)]
    pub uses_conpty_dll: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTraits {
    pub os: String,
    #[serde(default)]
    pub windows_pty: Option<WindowsPtyTraits>,
}

impl ProcessTraits {
    // 按编译平台生成进程特征；Windows 附带构建号与调用方提供的 DLL 使用标记。
    pub fn current_platform(uses_conpty_dll: bool) -> Self {
        #[cfg(target_os = "windows")]
        {
            return Self {
                os: "windows".to_string(),
                windows_pty: Some(WindowsPtyTraits {
                    backend: "conpty".to_string(),
                    build_number: windows_build_number(),
                    uses_conpty_dll,
                }),
            };
        }
        #[cfg(target_os = "macos")]
        {
            let _ = uses_conpty_dll;
            return Self {
                os: "macos".to_string(),
                windows_pty: None,
            };
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let _ = uses_conpty_dll;
            Self {
                os: "linux".to_string(),
                windows_pty: None,
            }
        }
    }
}

#[cfg(target_os = "windows")]
// 从系统版本描述中取首个至少五位的数字作为构建号候选，无法取得时返回 None。
fn windows_build_number() -> Option<u32> {
    sysinfo::System::long_os_version().and_then(|version| {
        version
            .split(|ch: char| !ch.is_ascii_digit())
            .filter_map(|part| part.parse::<u32>().ok())
            .find(|number| *number >= 10_000)
    })
}

/// daemon 会话元数据（List/Attach 应答用）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    pub cwd: Option<String>,
    pub shell: Option<String>,
    #[serde(default)]
    pub environment_type: Option<String>,
    #[serde(default)]
    pub ssh_host_id: Option<String>,
    #[serde(default)]
    pub remote_path: Option<String>,
    /// 进程仍存活为 true；false 表示已退出仅剩回放 buffer。
    pub alive: bool,
    /// CLI 任务状态，不等同于 PTY/shell 存活状态。
    pub task_status: Option<String>,
    pub task_updated_at_ms: Option<u64>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub process_traits: Option<ProcessTraits>,
    #[serde(default)]
    pub replay_available: bool,
    #[serde(default)]
    pub replay_truncated: bool,
}

/// 会话进程状态（与主进程 `PtyProcessStatus` 字段一致，daemon 协议自带定义以便反序列化）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusInfo {
    pub status: String,
    pub exit_code: Option<i32>,
}

/// 尺寸感知的回放记录。空 data 表示仅发生 resize。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayEntry {
    pub cols: u16,
    pub rows: u16,
    pub sequence: u64,
    pub data_base64: String,
}

/// daemon → 客户端帧：请求应答与主动推送共用一条流。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonFrame {
    AuthOk {
        daemon_version: String,
        pid: u32,
        #[serde(default)]
        protocol_version: u16,
        #[serde(default)]
        binary_protocol_version: u8,
        #[serde(default)]
        features: Vec<String>,
    },
    AuthErr {
        reason: String,
    },
    Pong {
        id: u64,
    },
    Ok {
        id: u64,
    },
    Created {
        id: u64,
        meta: SessionMeta,
    },
    Err {
        id: u64,
        message: String,
    },
    Sessions {
        id: u64,
        sessions: Vec<SessionMeta>,
    },
    Statuses {
        id: u64,
        statuses: HashMap<String, SessionStatusInfo>,
    },
    /// Reconcile 应答：孤儿清理摘要（结构与主进程 `PtyOrphanCleanupSummary` 一致）。
    Reconciled {
        id: u64,
        summary: serde_json::Value,
    },
    SshAgentResponse {
        id: u64,
        payload: serde_json::Value,
    },
    RoutingEvent {
        event: RoutingEvent,
    },
    /// Attach 应答：base64 编码的 ring buffer 尾部（已保证 ANSI/UTF-8 安全边界）。
    Attached {
        id: u64,
        session_id: String,
        replay_base64: String,
        replay: Vec<ReplayEntry>,
        latest_sequence: u64,
        meta: SessionMeta,
        #[serde(default)]
        replay_reset: bool,
        #[serde(default)]
        replay_truncated: bool,
        #[serde(default)]
        oldest_sequence: u64,
    },
    /// 主动推送：PTY 输出（base64；daemon 侧 safe_emit_boundary 切帧，转发层禁止再分片）。
    Output {
        session_id: String,
        sequence: u64,
        cols: u16,
        rows: u16,
        data_base64: String,
    },
    /// 主动推送：会话进程退出。
    Exit {
        session_id: String,
        exit_code: Option<i32>,
    },
    /// 主动推送：CLI hook 上报（daemon 稳定端口收到后转发；无客户端时缓存补发）。
    HookReport {
        payload: serde_json::Value,
    },
    SshAgentHookGap {
        host_id: String,
        dropped: u64,
    },
    CheckpointAccepted {
        session_id: String,
        sequence: u64,
    },
    CheckpointRejected {
        session_id: String,
        sequence: u64,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryTerminalFrame {
    pub kind: u8,
    pub session_id: String,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub data: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub enum ProtocolError {
    /// JSON 解析失败或超长帧：非法帧，调用方应断连。
    Malformed(String),
    /// JSON 合法但 `type` 未知：前向兼容场景，回错误帧但保持连接。
    UnknownType(String),
}

// 将可序列化值编码为单行 JSON 并追加换行；不检查帧大小，序列化失败会 panic。
pub fn encode_frame<T: Serialize>(frame: &T) -> String {
    // 帧内不会出现裸换行：serde_json 序列化的字符串会转义 \n。
    let mut line = serde_json::to_string(frame).expect("frame serialization cannot fail");
    line.push('\n');
    line
}

/// WebSocket 二进制终端帧：version/kind/sessionLen/sequence/cols/rows/dataLen + payload。
// 校验种类、字段长度和总帧上限后写入大端头部，再原样拼接会话 ID 与负载字节。
pub fn encode_binary_terminal_frame(
    kind: u8,
    session_id: &str,
    sequence: u64,
    cols: u16,
    rows: u16,
    data: &[u8],
) -> Result<Vec<u8>, String> {
    if !matches!(
        kind,
        BINARY_KIND_OUTPUT
            | BINARY_KIND_REPLAY
            | BINARY_KIND_INPUT
            | BINARY_KIND_CHECKPOINT
            | BINARY_KIND_REPLAY_RESET
    ) {
        return Err("invalid binary frame kind".to_string());
    }
    let session_bytes = session_id.as_bytes();
    let session_len = u16::try_from(session_bytes.len())
        .map_err(|_| "session id too long for binary frame".to_string())?;
    let data_len = u32::try_from(data.len())
        .map_err(|_| "terminal payload too large for binary frame".to_string())?;
    if BINARY_HEADER_BYTES + session_bytes.len() + data.len() > MAX_FRAME_BYTES {
        return Err("binary frame too large".to_string());
    }

    let mut frame = Vec::with_capacity(BINARY_HEADER_BYTES + session_bytes.len() + data.len());
    frame.push(BINARY_PROTOCOL_VERSION);
    frame.push(kind);
    frame.extend_from_slice(&session_len.to_be_bytes());
    frame.extend_from_slice(&sequence.to_be_bytes());
    frame.extend_from_slice(&cols.to_be_bytes());
    frame.extend_from_slice(&rows.to_be_bytes());
    frame.extend_from_slice(&data_len.to_be_bytes());
    frame.extend_from_slice(session_bytes);
    frame.extend_from_slice(data);
    Ok(frame)
}

// 仅接受客户端输入/检查点帧，校验版本、精确长度和 ID 的 UTF-8；负载保持原始字节。
pub fn decode_binary_terminal_frame(frame: &[u8]) -> Result<BinaryTerminalFrame, String> {
    if frame.len() < BINARY_HEADER_BYTES {
        return Err("binary frame too short".to_string());
    }
    if frame[0] != BINARY_PROTOCOL_VERSION {
        return Err("unsupported binary protocol version".to_string());
    }
    let kind = frame[1];
    if !matches!(kind, BINARY_KIND_INPUT | BINARY_KIND_CHECKPOINT) {
        return Err("unsupported client binary frame kind".to_string());
    }
    let session_len = u16::from_be_bytes([frame[2], frame[3]]) as usize;
    let sequence = u64::from_be_bytes(
        frame[4..12]
            .try_into()
            .map_err(|_| "invalid binary sequence".to_string())?,
    );
    let cols = u16::from_be_bytes([frame[12], frame[13]]);
    let rows = u16::from_be_bytes([frame[14], frame[15]]);
    let data_len = u32::from_be_bytes(
        frame[16..20]
            .try_into()
            .map_err(|_| "invalid binary data length".to_string())?,
    ) as usize;
    let expected = BINARY_HEADER_BYTES
        .checked_add(session_len)
        .and_then(|value| value.checked_add(data_len))
        .ok_or_else(|| "binary frame length overflow".to_string())?;
    if expected != frame.len() || expected > MAX_FRAME_BYTES {
        return Err("invalid binary frame length".to_string());
    }
    let session_start = BINARY_HEADER_BYTES;
    let data_start = session_start + session_len;
    let session_id = std::str::from_utf8(&frame[session_start..data_start])
        .map_err(|_| "binary session id is not utf-8".to_string())?
        .to_string();
    Ok(BinaryTerminalFrame {
        kind,
        session_id,
        sequence,
        cols,
        rows,
        data: frame[data_start..].to_vec(),
    })
}

// 仅提取字符串类型的 type 字段；缺失或其他 JSON 类型均返回 None。
fn frame_type_of(value: &serde_json::Value) -> Option<String> {
    value.get("type").and_then(|v| v.as_str()).map(String::from)
}

// 先检查字节上限，再解析 JSON 和帧类型；未知类型与畸形帧分开报告，连接策略由调用方负责。
// 错误仍含原始类型或解析原因，调用方必须避免直接写入生产日志或回显。
fn decode_with_known_types<T: for<'de> Deserialize<'de>>(
    line: &str,
    known_types: &[&str],
) -> Result<T, ProtocolError> {
    if line.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::Malformed("frame too large".to_string()));
    }
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|err| ProtocolError::Malformed(err.to_string()))?;
    let frame_type =
        frame_type_of(&value).ok_or_else(|| ProtocolError::Malformed("missing type".into()))?;
    if !known_types.contains(&frame_type.as_str()) {
        return Err(ProtocolError::UnknownType(frame_type));
    }
    serde_json::from_value(value).map_err(|err| ProtocolError::Malformed(err.to_string()))
}

const CLIENT_FRAME_TYPES: &[&str] = &[
    "auth",
    "ping",
    "list",
    "create",
    "set_terminal_colors",
    "write",
    "ack",
    "resize",
    "close",
    "close_all",
    "attach",
    "detach",
    "reconcile",
    "status",
    "ssh_agent_request",
    "ssh_agent_release",
    "routing_reload",
    "routing_status",
    "routing_start",
    "routing_stop",
    "routing_reset_circuit",
    "shutdown",
];

const DAEMON_FRAME_TYPES: &[&str] = &[
    "auth_ok",
    "auth_err",
    "pong",
    "ok",
    "created",
    "err",
    "sessions",
    "statuses",
    "reconciled",
    "ssh_agent_response",
    "routing_event",
    "attached",
    "output",
    "exit",
    "hook_report",
    "ssh_agent_hook_gap",
    "checkpoint_accepted",
    "checkpoint_rejected",
];

// 按客户端类型白名单解析控制帧；字段反序列化不替代后续鉴权及业务范围校验。
pub fn decode_client_frame(line: &str) -> Result<ClientFrame, ProtocolError> {
    decode_with_known_types(line, CLIENT_FRAME_TYPES)
}

// 按 daemon 类型白名单解析应答或推送帧，保留未知类型与畸形数据的错误区分。
pub fn decode_daemon_frame(line: &str) -> Result<DaemonFrame, ProtocolError> {
    decode_with_known_types(line, DAEMON_FRAME_TYPES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 验证含字符与像素尺寸的 resize 请求往返不丢字段，编码末尾带换行。
    fn client_frame_roundtrip() {
        let frame = ClientFrame::Resize {
            id: 7,
            session_id: "abc".into(),
            cols: 120,
            rows: 30,
            pixel_width: Some(1200),
            pixel_height: Some(600),
        };
        let encoded = encode_frame(&frame);
        assert!(encoded.ends_with('\n'));
        let decoded = decode_client_frame(encoded.trim_end()).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    // 验证 SSH 创建参数与终端颜色可往返，旧创建帧省略这两项时默认 None。
    fn ssh_create_frame_roundtrip_and_legacy_create_compatibility() {
        let frame = ClientFrame::Create {
            id: 9,
            session_id: "session-1".into(),
            cwd: None,
            env_vars: None,
            shell: None,
            ssh_launch: Some(SshLaunchPlan {
                host_id: "host-1".into(),
                host: "example.com".into(),
                port: 22,
                username: "dev".into(),
                config_alias: String::new(),
                config_file: String::new(),
                auth_mode: "agent".into(),
                identity_file: String::new(),
                credential_ref: String::new(),
                jump_target: String::new(),
                proxy_type: "none".into(),
                proxy_host: String::new(),
                proxy_port: 0,
                proxy_command: String::new(),
                connect_timeout_sec: 15,
                server_alive_interval_sec: 30,
                server_alive_count_max: 3,
                remote_path: "/srv/app".into(),
                client_instance_id: String::new(),
                project_id: String::new(),
                project_name: String::new(),
                bridge_epoch: String::new(),
                agent_path: String::new(),
                agent_installation_id: String::new(),
                agent_remote_machine_id: String::new(),
                tool_source: String::new(),
                environment_overrides: HashMap::new(),
                initialization_command: None,
                startup_command: Some("codex".into()),
            }),
            terminal_colors: Some(TerminalColorSpec {
                foreground: "#D3D7CF".into(),
                background: "#000000".into(),
            }),
        };
        assert_eq!(
            decode_client_frame(encode_frame(&frame).trim_end()).unwrap(),
            frame
        );

        let legacy = decode_client_frame(
            r#"{"type":"create","id":10,"session_id":"legacy","cwd":null,"env_vars":null,"shell":null}"#,
        )
        .unwrap();
        assert!(matches!(
            legacy,
            ClientFrame::Create {
                ssh_launch: None,
                terminal_colors: None,
                ..
            }
        ));
    }

    #[test]
    // 验证输出帧的会话、序号、尺寸和 base64 文本在 JSON 往返后保持一致。
    fn daemon_frame_roundtrip() {
        let frame = DaemonFrame::Output {
            session_id: "abc".into(),
            sequence: 1,
            cols: 80,
            rows: 24,
            data_base64: "aGk=".into(),
        };
        let decoded = decode_daemon_frame(encode_frame(&frame).trim_end()).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    // 验证路由重置帧保留身份与编号，但丢弃未知密钥字段，重编码不会带回这些值。
    fn routing_frames_roundtrip_and_drop_unknown_secret_fields() {
        let decoded = decode_client_frame(
            r#"{"type":"routing_reset_circuit","id":11,"app_type":"codex","provider_id":"provider-1","api_key":"sk-secret","proxy_password":"pw-secret","provider":{"key":"nested-secret"}}"#,
        )
        .unwrap();
        assert_eq!(routing_control_id(&decoded), Some(11));
        assert_eq!(
            decoded,
            ClientFrame::RoutingResetCircuit {
                id: 11,
                app_type: "codex".into(),
                provider_id: "provider-1".into(),
            }
        );
        let reencoded = encode_frame(&decoded);
        assert!(!reencoded.contains("sk-secret"));
        assert!(!reencoded.contains("pw-secret"));
        assert!(!reencoded.contains("nested-secret"));
    }

    #[test]
    // 验证未知传输输入归一化为 unknown，错误事件不泄露输入中的用户或密码片段。
    fn routing_error_dto_is_stable_and_sanitizes_transport_params() {
        let event = DaemonFrame::RoutingEvent {
            event: RoutingEvent::error(
                12,
                RoutingError::protocol_unsupported("https://user:password@proxy"),
            ),
        };
        let encoded = encode_frame(&event);
        assert!(encoded.contains(ROUTING_ERROR_PROTOCOL_UNSUPPORTED));
        assert!(encoded.contains(r#""transport":"unknown""#));
        assert!(encoded.contains(r#""hint":"use_routing_tauri_command""#));
        assert!(!encoded.contains("user"));
        assert!(!encoded.contains("password"));
        assert_eq!(decode_daemon_frame(encoded.trim_end()).unwrap(), event);
    }

    #[test]
    // 验证控制协议仍为版本 3、能力列表声明路由支持，旧能力列表返回固定重启提示。
    fn local_routing_capability_is_advertised_without_protocol_bump() {
        assert_eq!(CONTROL_PROTOCOL_VERSION, 3);
        assert!(ensure_local_routing_capability(&supported_features()).is_ok());

        let legacy_error = ensure_local_routing_capability(&[]).unwrap_err();
        assert_eq!(legacy_error.code, ROUTING_ERROR_FEATURE_NOT_SUPPORTED);
        assert_eq!(
            legacy_error.params.get("feature").map(String::as_str),
            Some(FEATURE_LOCAL_ROUTING_V1)
        );
        assert_eq!(legacy_error.hint, "restart_daemon");
    }

    #[test]
    // 验证未知客户端类型被分类为 UnknownType，并在内部错误中保留类型名。
    fn unknown_type_is_forward_compatible_error() {
        let result = decode_client_frame(r#"{"type":"future_op","id":1}"#);
        assert_eq!(
            result.unwrap_err(),
            ProtocolError::UnknownType("future_op".to_string())
        );
    }

    #[test]
    // 验证未知 daemon 类型也使用 UnknownType，而非归为 JSON 畸形错误。
    fn unknown_daemon_type_is_forward_compatible_error() {
        let result = decode_daemon_frame(r#"{"type":"future_daemon_event"}"#);
        assert_eq!(
            result.unwrap_err(),
            ProtocolError::UnknownType("future_daemon_event".to_string())
        );
    }

    #[test]
    // 验证 ping 帧新增未知字段不妨碍读取已有请求编号。
    fn unknown_fields_are_ignored() {
        let decoded = decode_client_frame(r#"{"type":"ping","id":3,"futureField":"x"}"#).unwrap();
        assert_eq!(decoded, ClientFrame::Ping { id: 3 });
    }

    #[test]
    // 验证无效 JSON 和缺失 type 的对象均被拒绝为 Malformed。
    fn malformed_json_is_rejected() {
        assert!(matches!(
            decode_client_frame("{not json"),
            Err(ProtocolError::Malformed(_))
        ));
        assert!(matches!(
            decode_client_frame(r#"{"id":1}"#),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    // 验证超过字节上限的控制帧在反序列化前返回固定超长原因。
    fn oversized_control_frame_is_rejected_before_deserialization() {
        let oversized = format!(
            r#"{{"type":"routing_reload","id":1,"padding":"{}"}}"#,
            "x".repeat(MAX_FRAME_BYTES)
        );
        assert!(matches!(
            decode_client_frame(&oversized),
            Err(ProtocolError::Malformed(reason)) if reason == "frame too large"
        ));
    }

    #[test]
    // 逐字段断言二进制输出头的大端布局以及会话 ID、负载的准确偏移。
    fn binary_terminal_frame_has_stable_header_and_payload() {
        let frame =
            encode_binary_terminal_frame(BINARY_KIND_OUTPUT, "session-1", 42, 120, 30, b"hello")
                .unwrap();
        assert_eq!(frame[0], BINARY_PROTOCOL_VERSION);
        assert_eq!(frame[1], BINARY_KIND_OUTPUT);
        assert_eq!(u16::from_be_bytes([frame[2], frame[3]]), 9);
        assert_eq!(u64::from_be_bytes(frame[4..12].try_into().unwrap()), 42);
        assert_eq!(u16::from_be_bytes(frame[12..14].try_into().unwrap()), 120);
        assert_eq!(u16::from_be_bytes(frame[14..16].try_into().unwrap()), 30);
        assert_eq!(u32::from_be_bytes(frame[16..20].try_into().unwrap()), 5);
        assert_eq!(&frame[20..29], b"session-1");
        assert_eq!(&frame[29..], b"hello");
    }
}
