//! daemon 通信协议：换行分隔 JSON 帧（NDJSON），`type` 字段区分帧类型。
//!
//! 前向兼容约定（契约）：未知字段忽略（serde 默认）；未知 `type` 返回
//! [`ProtocolError::UnknownType`]，由服务端回错误帧而不断连；JSON 解析失败
//! 视为非法帧，调用方应断连。单帧上限 8 MiB 防 DoS。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 单帧最大字节数（含换行前的 JSON 文本）。超限视为非法帧，断连。
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

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
    },
    Write {
        id: u64,
        session_id: String,
        /// UTF-8 文本按原样传输（与 `pty_write` 的 data 参数一致）。
        data: String,
    },
    Resize {
        id: u64,
        session_id: String,
        cols: u16,
        rows: u16,
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
    /// 请求 daemon 自杀（仅在无存活会话时被接受；版本升级路径用）。
    Shutdown {
        id: u64,
    },
}

/// daemon 会话元数据（List/Attach 应答用）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    pub cwd: Option<String>,
    pub shell: Option<String>,
    /// 进程仍存活为 true；false 表示已退出仅剩回放 buffer。
    pub alive: bool,
    /// CLI 任务状态，不等同于 PTY/shell 存活状态。
    pub task_status: Option<String>,
    pub task_updated_at_ms: Option<u64>,
    pub created_at_ms: u64,
}

/// 会话进程状态（与主进程 `PtyProcessStatus` 字段一致，daemon 协议自带定义以便反序列化）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusInfo {
    pub status: String,
    pub exit_code: Option<i32>,
}

/// daemon → 客户端帧：请求应答与主动推送共用一条流。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonFrame {
    AuthOk {
        daemon_version: String,
        pid: u32,
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
    /// Attach 应答：base64 编码的 ring buffer 尾部（已保证 ANSI/UTF-8 安全边界）。
    Attached {
        id: u64,
        session_id: String,
        replay_base64: String,
        meta: SessionMeta,
    },
    /// 主动推送：PTY 输出（base64；daemon 侧 safe_emit_boundary 切帧，转发层禁止再分片）。
    Output {
        session_id: String,
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
}

#[derive(Debug, PartialEq)]
pub enum ProtocolError {
    /// JSON 解析失败或超长帧：非法帧，调用方应断连。
    Malformed(String),
    /// JSON 合法但 `type` 未知：前向兼容场景，回错误帧但保持连接。
    UnknownType(String),
}

pub fn encode_frame<T: Serialize>(frame: &T) -> String {
    // 帧内不会出现裸换行：serde_json 序列化的字符串会转义 \n。
    let mut line = serde_json::to_string(frame).expect("frame serialization cannot fail");
    line.push('\n');
    line
}

fn frame_type_of(value: &serde_json::Value) -> Option<String> {
    value.get("type").and_then(|v| v.as_str()).map(String::from)
}

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
    "write",
    "resize",
    "close",
    "close_all",
    "attach",
    "detach",
    "reconcile",
    "status",
    "shutdown",
];

const DAEMON_FRAME_TYPES: &[&str] = &[
    "auth_ok",
    "auth_err",
    "pong",
    "ok",
    "err",
    "sessions",
    "statuses",
    "reconciled",
    "attached",
    "output",
    "exit",
    "hook_report",
];

pub fn decode_client_frame(line: &str) -> Result<ClientFrame, ProtocolError> {
    decode_with_known_types(line, CLIENT_FRAME_TYPES)
}

pub fn decode_daemon_frame(line: &str) -> Result<DaemonFrame, ProtocolError> {
    decode_with_known_types(line, DAEMON_FRAME_TYPES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_frame_roundtrip() {
        let frame = ClientFrame::Resize {
            id: 7,
            session_id: "abc".into(),
            cols: 120,
            rows: 30,
        };
        let encoded = encode_frame(&frame);
        assert!(encoded.ends_with('\n'));
        let decoded = decode_client_frame(encoded.trim_end()).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn daemon_frame_roundtrip() {
        let frame = DaemonFrame::Output {
            session_id: "abc".into(),
            data_base64: "aGk=".into(),
        };
        let decoded = decode_daemon_frame(encode_frame(&frame).trim_end()).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn unknown_type_is_forward_compatible_error() {
        let result = decode_client_frame(r#"{"type":"future_op","id":1}"#);
        assert_eq!(
            result.unwrap_err(),
            ProtocolError::UnknownType("future_op".to_string())
        );
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let decoded = decode_client_frame(r#"{"type":"ping","id":3,"futureField":"x"}"#).unwrap();
        assert_eq!(decoded, ClientFrame::Ping { id: 3 });
    }

    #[test]
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
}
