use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEVICE_PROTOCOL_VERSION: u16 = 1;

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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
    pub status: DeviceStatus,
    pub last_seen_at: i64,
    pub paired_at: Option<i64>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionSummary {
    pub session_id: String,
    pub device_id: String,
    pub source: String,
    pub project_key: String,
    pub title: String,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: u64,
    pub branch: Option<String>,
    pub freshness: String,
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
    Hello {
        protocol_version: u16,
        device_id: String,
        device_token: Option<String>,
        name: String,
        platform: String,
        app_version: String,
        capabilities: Vec<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
