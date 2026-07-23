use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const SUPPORTED_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "StopFailure",
    "PermissionRequest",
];

#[derive(Clone, Debug)]
pub struct HookNotificationJob {
    pub source: String,
    pub event: String,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug)]
pub struct HookNotificationMessage {
    pub id: String,
    pub title: String,
    pub body: String,
    pub event: String,
    pub source: String,
    pub project: String,
    pub time: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyTarget {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub events: HashMap<String, bool>,
    #[serde(default)]
    pub config: Value,
}

#[derive(Clone, Debug)]
pub struct HttpRequestSpec {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: RequestBody,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Clone, Debug)]
pub enum RequestBody {
    Empty,
    Json(Value),
    Form(Vec<(String, String)>),
    Text(String),
}

#[derive(Clone, Debug)]
pub struct HttpResponseSnapshot {
    pub status: u16,
    pub body: Vec<u8>,
    pub elapsed_ms: u128,
}

#[derive(Clone, Debug)]
pub struct ProviderAccepted {
    pub code: Option<String>,
    pub message: Option<String>,
    pub delivery_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NotificationError {
    pub code: &'static str,
    pub message: String,
}

impl NotificationError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSendResult {
    pub accepted: bool,
    pub provider: String,
    pub target_id: String,
    pub elapsed_ms: u128,
    pub http_status: Option<u16>,
    pub code: Option<String>,
    pub message: Option<String>,
    pub delivery_id: Option<String>,
    pub error_code: Option<String>,
}

pub fn is_supported_event(event: &str) -> bool {
    SUPPORTED_EVENTS.contains(&event)
}
