use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEVICE_PROTOCOL_VERSION: u16 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalOutputKind {
    Output,
    Replay,
    Reset,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFrame {
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence_end: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence_start: Option<bool>,
    pub cols: u16,
    pub rows: u16,
    pub data: String,
    pub kind: TerminalOutputKind,
    #[serde(default)]
    pub replay_batch_end: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalCommand {
    Attach {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_sequence: Option<u64>,
    },
    Detach {
        session_id: String,
    },
    Close {
        session_id: String,
    },
    Input {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceStatus {
    Online,
    Offline,
}

impl DeviceStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Offline => "offline",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Submitted,
    WaitingDevice,
    Accepted,
    Running,
    Succeeded,
    Failed,
    Rejected,
    TimedOut,
    Canceled,
}

impl OperationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::WaitingDevice => "waiting_device",
            Self::Accepted => "accepted",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Rejected => "rejected",
            Self::TimedOut => "timed_out",
            Self::Canceled => "canceled",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Rejected | Self::TimedOut | Self::Canceled
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub error: ApiError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusResponse {
    pub authenticated: bool,
    pub user: Option<UserView>,
    #[serde(default)]
    pub device_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEvent {
    pub operation_id: String,
    pub session_id: String,
    pub source: String,
    pub project_id: String,
    #[serde(default)]
    pub worktree_id: Option<String>,
    pub sequence: u64,
    pub kind: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    pub occurred_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHostInfo {
    pub host_name: String,
    pub os_version: String,
    pub cpu_arch: String,
    pub cpu_model: String,
    pub total_memory_bytes: u64,
    pub display_width: u32,
    pub display_height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWallpaperUpload {
    pub mime_type: String,
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub client_id: String,
    pub machine_id: Option<String>,
    pub client_kind: Option<String>,
    pub name: String,
    pub platform: String,
    pub app_version: String,
    pub status: DeviceStatus,
    pub last_seen_at: i64,
    pub paired_at: Option<i64>,
    pub capabilities: Vec<String>,
    pub host_info: Option<DeviceHostInfo>,
    pub wallpaper_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionSummary {
    pub session_id: String,
    pub device_id: String,
    pub source: String,
    pub project_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub title: String,
    /// Legacy field retained for decoding old snapshots. New clients always send null.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: u64,
    pub branch: Option<String>,
    pub freshness: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGroupSummary {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectSummary {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub sort_order: i64,
    pub source: Option<String>,
    /// Available only inside an authenticated, device-scoped workspace response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub environment_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorktreeSummary {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub branch: String,
    /// Available only inside an authenticated, device-scoped workspace response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    #[serde(default)]
    pub terminals: Option<Vec<WorkspaceTerminalSummary>>,
    pub groups: Vec<WorkspaceGroupSummary>,
    pub projects: Vec<WorkspaceProjectSummary>,
    pub worktrees: Vec<WorkspaceWorktreeSummary>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTerminalSummary {
    pub session_id: String,
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationView {
    pub id: String,
    pub device_id: String,
    pub kind: String,
    pub status: OperationStatus,
    pub idempotency_key: String,
    pub payload: Value,
    pub result: Option<Value>,
    pub error: Option<OperationError>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DeviceToServerFrame {
    TerminalOutput {
        session_id: String,
        sequence: u64,
        frames: Vec<TerminalOutputFrame>,
    },
    TerminalStatus {
        session_id: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        control_mode: Option<String>,
    },
    ConversationEvent {
        event: ConversationEvent,
    },
    Hello {
        protocol_version: u16,
        device_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_kind: Option<String>,
        device_token: Option<String>,
        name: String,
        platform: String,
        app_version: String,
        capabilities: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host_info: Option<DeviceHostInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wallpaper: Option<DeviceWallpaperUpload>,
    },
    PairingOffer {
        code: String,
        expires_at: i64,
    },
    Heartbeat {
        sequence: u64,
    },
    HistorySnapshot {
        sequence: u64,
        sessions: Vec<HistorySessionSummary>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace: Option<WorkspaceSnapshot>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ServerToDeviceFrame {
    TerminalCommand {
        command: TerminalCommand,
    },
    ConversationAck {
        operation_id: String,
        sequence: u64,
    },
    HelloOk {
        paired: bool,
        device_token: Option<String>,
    },
    PairingOffered {
        pairing_id: String,
    },
    PairingClaimed {
        pairing_id: String,
        device_token: String,
    },
    OperationRequest {
        operation: OperationView,
    },
    OperationAck {
        operation_id: String,
        status: OperationStatus,
    },
    Ack {
        sequence: u64,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum BrowserEventPayload {
    #[serde(rename = "conversation.updated")]
    ConversationUpdated {
        device_id: String,
        event: ConversationEvent,
    },
    #[serde(rename = "device.updated")]
    DeviceUpdated { device: DeviceView },
    #[serde(rename = "operation.updated")]
    OperationUpdated { operation: OperationView },
    #[serde(rename = "history.updated")]
    HistoryUpdated {
        device_id: String,
        latest_updated_at: i64,
    },
    #[serde(rename = "pairing.updated")]
    PairingUpdated {
        pairing_id: String,
        status: String,
        device_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BrowserSocketFrame {
    Heartbeat,
    TerminalOutput {
        device_id: String,
        session_id: String,
        sequence: u64,
        frames: Vec<TerminalOutputFrame>,
    },
    TerminalStatus {
        device_id: String,
        session_id: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        control_mode: Option<String>,
    },
    Ready {
        latest_sequence: i64,
    },
    Event {
        sequence: i64,
        occurred_at: i64,
        payload: BrowserEventPayload,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BrowserToServerFrame {
    TerminalCommand {
        device_id: String,
        command: TerminalCommand,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_frames_preserve_identity_and_sequence() {
        let event = ConversationEvent {
            operation_id: "op".into(),
            session_id: "session".into(),
            source: "codex".into(),
            project_id: "project".into(),
            worktree_id: None,
            sequence: 3,
            kind: "assistant_delta".into(),
            message_id: Some("message".into()),
            text: Some("hello".into()),
            occurred_at: 12,
        };
        let value = serde_json::to_value(DeviceToServerFrame::ConversationEvent {
            event: event.clone(),
        })
        .unwrap();
        assert_eq!(value["type"], "conversation_event");
        assert_eq!(value["event"]["operationId"], "op");
        assert_eq!(value["event"]["sequence"], 3);
        assert_eq!(
            serde_json::from_value::<DeviceToServerFrame>(value).unwrap(),
            DeviceToServerFrame::ConversationEvent {
                event: event.clone()
            }
        );
        let value = serde_json::to_value(BrowserEventPayload::ConversationUpdated {
            device_id: "device".into(),
            event,
        })
        .unwrap();
        assert_eq!(value["type"], "conversation.updated");
        assert_eq!(value["deviceId"], "device");
        let ack = serde_json::to_value(ServerToDeviceFrame::ConversationAck {
            operation_id: "op".into(),
            sequence: 3,
        })
        .unwrap();
        assert_eq!(
            ack,
            serde_json::json!({"type":"conversation_ack","operationId":"op","sequence":3})
        );
    }

    #[test]
    fn operation_status_uses_snake_case() {
        assert_eq!(
            serde_json::to_string(&OperationStatus::WaitingDevice).unwrap(),
            "\"waiting_device\""
        );
    }

    #[test]
    fn device_frames_use_camel_case_fields() {
        let value = serde_json::to_value(DeviceToServerFrame::Heartbeat { sequence: 7 }).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "type": "heartbeat", "sequence": 7 })
        );
        let ack = serde_json::to_value(ServerToDeviceFrame::OperationAck {
            operation_id: "operation-1".to_string(),
            status: OperationStatus::Succeeded,
        })
        .unwrap();
        assert_eq!(
            ack,
            serde_json::json!({
                "type": "operation_ack",
                "operationId": "operation-1",
                "status": "succeeded"
            })
        );
    }

    #[test]
    fn terminal_frames_round_trip_with_camel_case_fields() {
        let browser = BrowserToServerFrame::TerminalCommand {
            device_id: "device-1".into(),
            command: TerminalCommand::Resize {
                session_id: "terminal-1".into(),
                cols: 120,
                rows: 32,
            },
        };
        let value = serde_json::to_value(&browser).unwrap();
        assert_eq!(value["type"], "terminal_command");
        assert_eq!(value["deviceId"], "device-1");
        assert_eq!(value["command"]["sessionId"], "terminal-1");
        assert_eq!(
            serde_json::from_value::<BrowserToServerFrame>(value).unwrap(),
            browser
        );

        let attach = TerminalCommand::Attach {
            session_id: "terminal-1".into(),
            after_sequence: Some(42),
        };
        let value = serde_json::to_value(&attach).unwrap();
        assert_eq!(value["afterSequence"], 42);
        assert_eq!(serde_json::from_value::<TerminalCommand>(value).unwrap(), attach);
        let legacy = serde_json::json!({"type": "attach", "sessionId": "terminal-1"});
        assert_eq!(
            serde_json::from_value::<TerminalCommand>(legacy).unwrap(),
            TerminalCommand::Attach {
                session_id: "terminal-1".into(),
                after_sequence: None,
            }
        );

        let close = TerminalCommand::Close {
            session_id: "terminal-1".into(),
        };
        let value = serde_json::to_value(&close).unwrap();
        assert_eq!(value["type"], "close");
        assert_eq!(serde_json::from_value::<TerminalCommand>(value).unwrap(), close);

        let output = BrowserSocketFrame::TerminalOutput {
            device_id: "device-1".into(),
            session_id: "terminal-1".into(),
            sequence: 7,
            frames: vec![TerminalOutputFrame {
                sequence: 6,
                data: "YQ==".into(),
                cols: 120,
                rows: 32,
                kind: TerminalOutputKind::Replay,
                replay_batch_end: true,
                sequence_end: Some(true),
                sequence_start: Some(true),
            }],
        };
        let value = serde_json::to_value(&output).unwrap();
        assert_eq!(value["type"], "terminal_output");
        assert_eq!(value["sessionId"], "terminal-1");
        assert_eq!(value["frames"][0]["cols"], 120);
        assert_eq!(value["frames"][0]["rows"], 32);
        assert_eq!(value["frames"][0]["kind"], "replay");
        assert_eq!(value["frames"][0]["replayBatchEnd"], true);
        assert_eq!(value["frames"][0]["sequenceEnd"], true);
        assert_eq!(value["frames"][0]["sequenceStart"], true);
        let mut legacy = value["frames"][0].clone();
        legacy.as_object_mut().unwrap().remove("sequenceEnd");
        legacy.as_object_mut().unwrap().remove("sequenceStart");
        assert_eq!(serde_json::from_value::<TerminalOutputFrame>(legacy.clone()).unwrap().sequence_start, None);
        assert_eq!(serde_json::from_value::<TerminalOutputFrame>(legacy.clone()).unwrap().sequence_end, None);
        legacy["sequenceEnd"] = serde_json::json!(false);
        assert_eq!(serde_json::from_value::<TerminalOutputFrame>(legacy).unwrap().sequence_end, Some(false));
        assert_eq!(
            serde_json::from_value::<BrowserSocketFrame>(value).unwrap(),
            output
        );
    }

    #[test]
    fn hello_identity_fields_are_optional_and_camel_case() {
        let legacy = serde_json::json!({
            "type": "hello",
            "protocolVersion": 1,
            "deviceId": "device-1",
            "deviceToken": null,
            "name": "PC",
            "platform": "windows",
            "appVersion": "1.0",
            "capabilities": []
        });
        let frame: DeviceToServerFrame = serde_json::from_value(legacy).unwrap();
        let DeviceToServerFrame::Hello {
            client_id,
            machine_id,
            client_kind,
            host_info,
            wallpaper,
            ..
        } = frame
        else {
            panic!("expected hello frame");
        };
        assert!(client_id.is_none());
        assert!(machine_id.is_none());
        assert!(client_kind.is_none());
        assert!(host_info.is_none());
        assert!(wallpaper.is_none());

        let value = serde_json::to_value(DeviceToServerFrame::Hello {
            protocol_version: 1,
            device_id: "device-1".to_string(),
            client_id: Some("client-1".to_string()),
            machine_id: Some("machine-1".to_string()),
            client_kind: Some("development".to_string()),
            device_token: None,
            name: "PC".to_string(),
            platform: "windows".to_string(),
            app_version: "1.0".to_string(),
            capabilities: vec![],
            host_info: Some(DeviceHostInfo {
                host_name: "WORKSTATION".to_string(),
                os_version: "Windows 11".to_string(),
                cpu_arch: "x86_64".to_string(),
                cpu_model: "Example CPU".to_string(),
                total_memory_bytes: 16 * 1024 * 1024 * 1024,
                display_width: 1920,
                display_height: 1080,
            }),
            wallpaper: None,
        })
        .unwrap();
        assert_eq!(value["hostInfo"]["hostName"], "WORKSTATION");
        assert_eq!(value["clientId"], "client-1");
        assert_eq!(value["machineId"], "machine-1");
        assert_eq!(value["clientKind"], "development");
        assert!(value.get("wallpaper").is_none());
    }

    #[test]
    fn browser_event_type_keeps_dotted_name() {
        let value = serde_json::to_value(BrowserEventPayload::PairingUpdated {
            pairing_id: "pairing-1".to_string(),
            status: "claimed".to_string(),
            device_id: "device-1".to_string(),
        })
        .unwrap();
        assert_eq!(value["type"], "pairing.updated");
        assert_eq!(value["pairingId"], "pairing-1");
        assert_eq!(value["deviceId"], "device-1");
    }

    #[test]
    fn history_snapshot_workspace_is_optional_and_camel_case() {
        let legacy = serde_json::json!({
            "type": "history_snapshot",
            "sequence": 1,
            "sessions": []
        });
        let frame: DeviceToServerFrame = serde_json::from_value(legacy).unwrap();
        let DeviceToServerFrame::HistorySnapshot { workspace, .. } = frame else {
            panic!("expected history snapshot");
        };
        assert!(workspace.is_none());

        let value = serde_json::to_value(DeviceToServerFrame::HistorySnapshot {
            sequence: 2,
            sessions: vec![],
            workspace: Some(WorkspaceSnapshot {
                terminals: None,
                groups: vec![],
                projects: vec![WorkspaceProjectSummary {
                    id: "project-1".to_string(),
                    name: "CLI-Manager".to_string(),
                    group_id: None,
                    sort_order: 0,
                    source: Some("codex".to_string()),
                    cwd: None,
                    environment_type: "local".to_string(),
                }],
                worktrees: vec![],
                updated_at: 7,
            }),
        })
        .unwrap();
        assert_eq!(value["workspace"]["projects"][0]["groupId"], Value::Null);
        assert!(value["workspace"]["projects"][0].get("cwd").is_none());
        assert_eq!(value["workspace"]["updatedAt"], 7);
    }
}
