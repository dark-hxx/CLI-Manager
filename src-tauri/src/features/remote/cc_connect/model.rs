use super::{
    now_millis, DEFAULT_MAX_TURN_TIME_MINS, MAX_LOG_LINES,
};
#[cfg(target_os = "windows")]
use crate::process_job::ChildJob;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CcConnectAgent {
    Claude,
    Codex,
    Pi,
    Opencode,
}

impl CcConnectAgent {
    pub(super) fn config_type(self) -> &'static str {
        match self {
            Self::Claude => "claudecode",
            Self::Codex => "codex",
            Self::Pi => "pi",
            Self::Opencode => "opencode",
        }
    }
    pub(super) fn safe_mode(self) -> &'static str {
        match self {
            Self::Claude => "default",
            Self::Codex => "suggest",
            Self::Pi | Self::Opencode => "default",
        }
    }

    pub(super) fn configured_mode(self, yolo_enabled: bool) -> &'static str {
        if !yolo_enabled {
            return self.safe_mode();
        }
        match self {
            Self::Claude => "bypassPermissions",
            Self::Codex => "yolo",
            Self::Pi | Self::Opencode => "yolo",
        }
    }

    pub(super) fn backend(self) -> Option<&'static str> {
        matches!(self, Self::Codex).then_some("app_server")
    }

    pub(super) fn app_server_url(self) -> Option<&'static str> {
        matches!(self, Self::Codex).then_some("stdio://")
    }

    pub(super) fn rpc(self) -> Option<bool> {
        matches!(self, Self::Pi).then_some(true)
    }

    pub(super) fn session_type(self) -> &'static str {
        self.config_type()
    }

    pub(super) fn hook_source(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
            Self::Opencode => "opencode",
        }
    }
}

pub(super) const MAX_REGISTERED_LAUNCHER_ARGS: usize = 64;
pub(super) const MAX_REGISTERED_LAUNCHER_ARG_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ResolvedAgentLauncher {
    pub(super) executable: PathBuf,
    pub(super) args: Vec<String>,
}

pub(super) fn parse_registered_command(value: &str) -> Result<Vec<String>, String> {
    if value.len() > MAX_REGISTERED_LAUNCHER_ARG_BYTES
        || value.contains(['\0', '\r', '\n', '&', ';', '|', '<', '>', '(', ')'])
    {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut chars = value.trim().chars().peekable();
    while let Some(character) = chars.next() {
        if let Some(expected_quote) = quote {
            if character == expected_quote {
                quote = None;
            } else if character == '\\'
                && chars
                    .peek()
                    .is_some_and(|next| *next == expected_quote || *next == '\\')
            {
                current.push(chars.next().expect("peeked launcher escape"));
            } else {
                current.push(character);
            }
            continue;
        }
        match character {
            '\'' | '"' => quote = Some(character),
            character if character.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if quote.is_some() || !current.is_empty() && current.len() > MAX_REGISTERED_LAUNCHER_ARG_BYTES {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    if !current.is_empty() {
        words.push(current);
    }
    if words.is_empty()
        || words.len() > MAX_REGISTERED_LAUNCHER_ARGS
        || words
            .iter()
            .any(|word| word.is_empty() || word.len() > MAX_REGISTERED_LAUNCHER_ARG_BYTES)
    {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    Ok(words)
}

pub(super) fn agent_from_launcher_program(program: &str) -> Option<CcConnectAgent> {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    let command = [".exe", ".cmd", ".bat", ".com", ".ps1"]
        .into_iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .unwrap_or(&name);
    match command {
        "claude" => Some(CcConnectAgent::Claude),
        "codex" => Some(CcConnectAgent::Codex),
        "pi" => Some(CcConnectAgent::Pi),
        "opencode" => Some(CcConnectAgent::Opencode),
        _ => None,
    }
}

pub(super) fn cc_connect_agent_from_cli_tool(value: &str) -> Option<CcConnectAgent> {
    parse_registered_command(value)
        .ok()
        .and_then(|words| words.into_iter().next())
        .and_then(|program| agent_from_launcher_program(&program))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CcConnectPlatform {
    Telegram,
    Feishu,
    Weixin,
    Wecom,
}

pub(super) const CC_CONNECT_PLATFORMS: [CcConnectPlatform; 4] = [
    CcConnectPlatform::Telegram,
    CcConnectPlatform::Feishu,
    CcConnectPlatform::Weixin,
    CcConnectPlatform::Wecom,
];

pub(super) fn default_cc_connect_platform() -> CcConnectPlatform {
    CcConnectPlatform::Telegram
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectPlatformProfile {
    pub platform: CcConnectPlatform,
    pub enabled: bool,
    pub allow_from: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CcConnectLanguage {
    Zh,
    En,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectProfile {
    pub auto_start: bool,
    pub executable_path: Option<String>,
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub agent: CcConnectAgent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_project_id: Option<String>,
    #[serde(default = "default_cc_connect_platform")]
    pub platform: CcConnectPlatform,
    #[serde(default)]
    pub allow_from: String,
    #[serde(default)]
    pub platforms: Vec<CcConnectPlatformProfile>,
    #[serde(default)]
    pub yolo_enabled: bool,
    #[serde(default = "default_max_turn_time_mins")]
    pub max_turn_time_mins: u32,
    #[serde(default = "default_true")]
    pub proxy_enabled: bool,
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub logging_enabled: bool,
    pub language: CcConnectLanguage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cc_switch_db_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config_dir: Option<String>,
}

pub(super) fn default_true() -> bool {
    true
}

pub(super) fn default_max_turn_time_mins() -> u32 {
    DEFAULT_MAX_TURN_TIME_MINS
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectSaveProfileRequest {
    pub profile: CcConnectProfile,
    pub telegram_token: Option<String>,
    pub feishu_app_id: Option<String>,
    pub feishu_app_secret: Option<String>,
    pub weixin_token: Option<String>,
    pub wecom_bot_id: Option<String>,
    pub wecom_bot_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectStatus {
    pub installed: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub sha256: Option<String>,
    pub compatible: bool,
    pub detection_error: Option<String>,
    pub config_path: String,
    pub data_dir: String,
    pub log_path: String,
    pub profile: Option<CcConnectProfile>,
    pub config_exists: bool,
    pub credentials_ready: bool,
    pub platform_statuses: Vec<CcConnectPlatformStatus>,
    pub ready: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub running: bool,
    pub starting: bool,
    pub pid: Option<u32>,
    pub started_at_ms: Option<i64>,
    pub last_exit_code: Option<i32>,
    pub last_exit_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectPlatformStatus {
    pub platform: CcConnectPlatform,
    pub enabled: bool,
    pub credentials_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectExecutableStatus {
    pub installed: bool,
    pub executable_path: String,
    pub version: Option<String>,
    pub sha256: Option<String>,
    pub compatible: bool,
    pub detection_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectLogLine {
    pub seq: u64,
    pub timestamp_ms: i64,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectLogPage {
    pub lines: Vec<CcConnectLogLine>,
    pub next_seq: u64,
    pub log_path: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CcConnectWeixinAuthorizationPhase {
    Starting,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectWeixinAuthorizationStatus {
    pub phase: CcConnectWeixinAuthorizationPhase,
    pub qr_data_url: Option<String>,
    pub error: Option<String>,
    pub allow_from: Option<String>,
    pub profile: Option<CcConnectProfile>,
    pub started_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectWeixinAuthorizeRequest {
    pub profile: CcConnectProfile,
}

#[derive(Debug, Clone)]
pub(super) struct DetectedBinary {
    pub(super) path: PathBuf,
    pub(super) version: Option<String>,
    pub(super) sha256: String,
    pub(super) compatible: bool,
}

#[derive(Debug, Clone)]
pub(super) struct DetectionCache {
    pub(super) requested_path: Option<String>,
    pub(super) result: Result<DetectedBinary, String>,
}

pub(super) struct ManagedProcess {
    pub(super) child: Child,
    #[cfg(target_os = "windows")]
    pub(super) job: ChildJob,
    pub(super) started_at_ms: i64,
}

pub(super) struct WeixinAuthorizationProcess {
    pub(super) child: Child,
    pub(super) profile: CcConnectProfile,
    pub(super) config_path: PathBuf,
    pub(super) qr_path: PathBuf,
    pub(super) stdout_path: PathBuf,
    pub(super) stderr_path: PathBuf,
    #[cfg(target_os = "windows")]
    pub(super) job: ChildJob,
    pub(super) started_at_ms: i64,
}

pub(super) enum WeixinAuthorizationState {
    Running(WeixinAuthorizationProcess),
    Finished(CcConnectWeixinAuthorizationStatus),
}

#[derive(Default)]
pub(super) struct ProcessState {
    pub(super) process: Option<ManagedProcess>,
    pub(super) starting: bool,
    pub(super) last_exit_code: Option<i32>,
    pub(super) last_exit_at_ms: Option<i64>,
}

pub(super) struct CcConnectLogBuffer {
    pub(super) next_seq: u64,
    pub(super) lines: VecDeque<CcConnectLogLine>,
}

impl Default for CcConnectLogBuffer {
    fn default() -> Self {
        Self {
            next_seq: 1,
            lines: VecDeque::new(),
        }
    }
}

impl CcConnectLogBuffer {
    pub(super) fn push(&mut self, source: &str, message: String) {
        self.lines.push_back(CcConnectLogLine {
            seq: self.next_seq,
            timestamp_ms: now_millis(),
            source: source.to_string(),
            message,
        });
        self.next_seq = self.next_seq.saturating_add(1);
        while self.lines.len() > MAX_LOG_LINES {
            self.lines.pop_front();
        }
    }

    pub(super) fn page(&self, after_seq: u64, limit: usize) -> Vec<CcConnectLogLine> {
        self.lines
            .iter()
            .filter(|line| line.seq > after_seq)
            .take(limit)
            .cloned()
            .collect()
    }
}

pub(super) type SharedLogWriter = Arc<Mutex<Option<crate::log_rotation::DailyRollingLogWriter>>>;
