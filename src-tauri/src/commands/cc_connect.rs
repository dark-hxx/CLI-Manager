#[cfg(not(target_os = "windows"))]
use crate::codex_app_server_proxy::HELPER_SUBCOMMAND as CODEX_PROXY_SUBCOMMAND;
use crate::codex_app_server_proxy::{
    SshCodexLaunch, CODEX_BASE_URL_OVERRIDE_ENV, CODEX_ENV_KEY_OVERRIDE_ENV,
    CODEX_LAUNCHER_ARGS_ENV, CODEX_LAUNCHER_ENV, CODEX_MODEL_CATALOG_OVERRIDE_ENV,
    CODEX_MODEL_OVERRIDE_ENV, CODEX_MODEL_PROVIDER_ENV, CODEX_PROFILE_NAME_ENV,
    CODEX_PROVIDER_NAME_OVERRIDE_ENV, CODEX_SSH_LAUNCH_ENV, CODEX_WIRE_API_OVERRIDE_ENV,
    EXPECTED_SESSION_ID_ENV, PROXY_EXECUTABLE_ENV,
};
#[cfg(target_os = "windows")]
use crate::process_job::ChildJob;
use crate::shell_resolver::{output_with_timeout, silent_command};
use crate::ssh_transport::SshTransportSpec;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

pub(crate) mod handoff;
pub(crate) mod handoff_notification;
mod handoff_session;
pub(crate) mod update;

const PROFILE_FILE_NAME: &str = "profile.json";
const CONFIG_FILE_NAME: &str = "config.toml";
const PROJECT_LIST_FILE_NAME: &str = "cli-manager-projects.txt";
const PROJECT_SWITCH_SCRIPT_FILE_NAME: &str = "cli-manager-switch.ps1";
const LOG_FILE_NAME: &str = "cc-connect.log";
const CONTROL_WORK_DIR_NAME: &str = "control-workdir";
const CONTROL_PROJECT_ID: &str = "cli-manager-remote-control";
const CONTROL_PROJECT_NAME: &str = "CLI-Manager Remote";
const WEIXIN_AUTH_DIR_NAME: &str = "weixin-authorization";
const WEIXIN_AUTH_CONFIG_FILE_NAME: &str = "setup.toml";
const WEIXIN_AUTH_QR_FILE_NAME: &str = "qr.png";
const WEIXIN_AUTH_STDOUT_FILE_NAME: &str = "stdout.log";
const WEIXIN_AUTH_STDERR_FILE_NAME: &str = "stderr.log";
const WEIXIN_AUTH_TIMEOUT_SECS: u64 = 480;
const MAX_WEIXIN_AUTH_QR_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LOG_LINES: usize = 1_000;
const DEFAULT_LOG_PAGE_SIZE: usize = 200;
const MAX_LOG_PAGE_SIZE: usize = 500;
const MAX_CAPTURED_LOG_LINE_BYTES: usize = 8 * 1024;
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const CONFIG_FORMAT_TIMEOUT: Duration = Duration::from_secs(8);
const CODEX_APP_SERVER_PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const CODEX_MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_CODEX_MODEL_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CODEX_MODEL_CACHE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MANAGED_CODEX_MODELS: usize = 200;
const CODEX_MODEL_CATALOG_FILE_NAME: &str = "cli-manager-model-catalog.json";
const CODEX_MODELS_CACHE_FILE_NAME: &str = "models_cache.json";
const LOCAL_PROXY_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const DEFAULT_MAX_TURN_TIME_MINS: u32 = 15;
const MAX_TURN_TIME_MINS: u32 = 24 * 60;
const LOCAL_PROXY_PORTS: [u16; 2] = [7890, 10808];
const REMOTE_SWITCH_ARG_PREFIX: &str = "--cc-connect-switch=";
const REMOTE_SWITCH_RESTART_DELAY: Duration = Duration::from_secs(5);
const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];
const TELEGRAM_TOKEN_ACCOUNT: &str = "cc-connect-telegram-token";
const FEISHU_APP_ID_ACCOUNT: &str = "cc-connect-feishu-app-id";
const FEISHU_APP_SECRET_ACCOUNT: &str = "cc-connect-feishu-app-secret";
const WEIXIN_TOKEN_ACCOUNT: &str = "cc-connect-weixin-token";
const WECOM_BOT_ID_ACCOUNT: &str = "cc-connect-wecom-bot-id";
const WECOM_BOT_SECRET_ACCOUNT: &str = "cc-connect-wecom-bot-secret";
const TELEGRAM_TOKEN_ENV: &str = "CLI_MANAGER_CC_TELEGRAM_TOKEN";
const FEISHU_APP_ID_ENV: &str = "CLI_MANAGER_CC_FEISHU_APP_ID";
const FEISHU_APP_SECRET_ENV: &str = "CLI_MANAGER_CC_FEISHU_APP_SECRET";
const WEIXIN_TOKEN_ENV: &str = "CLI_MANAGER_CC_WEIXIN_TOKEN";
const WECOM_BOT_ID_ENV: &str = "CLI_MANAGER_CC_WECOM_BOT_ID";
const WECOM_BOT_SECRET_ENV: &str = "CLI_MANAGER_CC_WECOM_BOT_SECRET";
// Official v1.4.1 executable digests from the upstream release checksums.txt.
// Hash before executing --version so an arbitrary PATH candidate cannot run during detection.
const VERIFIED_V1_4_1_BINARY_SHA256: &[&str] = &[
    "C71905EA41981564ADE01EF9FC2A7BCC567E3A47A166D82F6176E520378D25BE",
    "9F1F99B9D5EC790E5B7C3CF929EDA6274DCD80A9DA28A95241C41E3217AA9A83",
    "FB0EE29DBBEDE9BF5F7D22BEC88EF89517B31FC0E46AFB639F26D3627B82CB11",
    "419FB47D77158408F63B124288A59C0EE61E80DB090EF08306F1CE96E372AD21",
    "D3F7B0C673A4D5539A461639C98ECA054D18B1FA38FC1AFC6422A7BBF3A2B18D",
    "A3CD94B23C84F5269534B0FC9316BDE0B9FEA8D8FC8EB9E4C13C22776D0D421",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CcConnectAgent {
    Claude,
    Codex,
    Pi,
    Opencode,
}

impl CcConnectAgent {
    fn config_type(self) -> &'static str {
        match self {
            Self::Claude => "claudecode",
            Self::Codex => "codex",
            Self::Pi => "pi",
            Self::Opencode => "opencode",
        }
    }
    fn safe_mode(self) -> &'static str {
        match self {
            Self::Claude => "default",
            Self::Codex => "suggest",
            Self::Pi | Self::Opencode => "default",
        }
    }

    fn configured_mode(self, yolo_enabled: bool) -> &'static str {
        if !yolo_enabled {
            return self.safe_mode();
        }
        match self {
            Self::Claude => "bypassPermissions",
            Self::Codex => "yolo",
            Self::Pi | Self::Opencode => "yolo",
        }
    }

    fn backend(self) -> Option<&'static str> {
        matches!(self, Self::Codex).then_some("app_server")
    }

    fn app_server_url(self) -> Option<&'static str> {
        matches!(self, Self::Codex).then_some("stdio://")
    }

    fn rpc(self) -> Option<bool> {
        matches!(self, Self::Pi).then_some(true)
    }

    fn session_type(self) -> &'static str {
        self.config_type()
    }

    fn hook_source(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
            Self::Opencode => "opencode",
        }
    }
}

const MAX_REGISTERED_LAUNCHER_ARGS: usize = 64;
const MAX_REGISTERED_LAUNCHER_ARG_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedAgentLauncher {
    executable: PathBuf,
    args: Vec<String>,
}

fn parse_registered_command(value: &str) -> Result<Vec<String>, String> {
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

fn agent_from_launcher_program(program: &str) -> Option<CcConnectAgent> {
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

fn cc_connect_agent_from_cli_tool(value: &str) -> Option<CcConnectAgent> {
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

const CC_CONNECT_PLATFORMS: [CcConnectPlatform; 4] = [
    CcConnectPlatform::Telegram,
    CcConnectPlatform::Feishu,
    CcConnectPlatform::Weixin,
    CcConnectPlatform::Wecom,
];

fn default_cc_connect_platform() -> CcConnectPlatform {
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

fn default_true() -> bool {
    true
}

fn default_max_turn_time_mins() -> u32 {
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
struct DetectedBinary {
    path: PathBuf,
    version: Option<String>,
    sha256: String,
    compatible: bool,
}

#[derive(Debug, Clone)]
struct DetectionCache {
    requested_path: Option<String>,
    result: Result<DetectedBinary, String>,
}

struct ManagedProcess {
    child: Child,
    #[cfg(target_os = "windows")]
    job: ChildJob,
    started_at_ms: i64,
}

struct WeixinAuthorizationProcess {
    child: Child,
    profile: CcConnectProfile,
    config_path: PathBuf,
    qr_path: PathBuf,
    stdout_path: PathBuf,
    stderr_path: PathBuf,
    #[cfg(target_os = "windows")]
    job: ChildJob,
    started_at_ms: i64,
}

enum WeixinAuthorizationState {
    Running(WeixinAuthorizationProcess),
    Finished(CcConnectWeixinAuthorizationStatus),
}

#[derive(Default)]
struct ProcessState {
    process: Option<ManagedProcess>,
    starting: bool,
    last_exit_code: Option<i32>,
    last_exit_at_ms: Option<i64>,
}

struct CcConnectLogBuffer {
    next_seq: u64,
    lines: VecDeque<CcConnectLogLine>,
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
    fn push(&mut self, source: &str, message: String) {
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

    fn page(&self, after_seq: u64, limit: usize) -> Vec<CcConnectLogLine> {
        self.lines
            .iter()
            .filter(|line| line.seq > after_seq)
            .take(limit)
            .cloned()
            .collect()
    }
}

type SharedLogWriter = Arc<Mutex<Option<crate::log_rotation::DailyRollingLogWriter>>>;

#[derive(Clone)]
pub struct CcConnectManager {
    operation: Arc<Mutex<()>>,
    process: Arc<Mutex<ProcessState>>,
    logs: Arc<Mutex<CcConnectLogBuffer>>,
    log_writer: SharedLogWriter,
    detection: Arc<Mutex<Option<DetectionCache>>>,
    codex_app_server_check: Arc<Mutex<Option<Result<(), String>>>>,
    weixin_authorization: Arc<Mutex<Option<WeixinAuthorizationState>>>,
}

impl Default for CcConnectManager {
    fn default() -> Self {
        #[cfg(not(test))]
        if let Ok((config, qr, stdout, stderr)) = weixin_authorization_paths() {
            cleanup_weixin_authorization_files([&config, &qr, &stdout, &stderr]);
        }
        Self {
            operation: Arc::new(Mutex::new(())),
            process: Arc::new(Mutex::new(ProcessState::default())),
            logs: Arc::new(Mutex::new(CcConnectLogBuffer::default())),
            log_writer: Arc::new(Mutex::new(None)),
            detection: Arc::new(Mutex::new(None)),
            codex_app_server_check: Arc::new(Mutex::new(None)),
            weixin_authorization: Arc::new(Mutex::new(None)),
        }
    }
}

impl CcConnectManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure_log_writer(&self) -> Result<(), String> {
        let mut writer = self
            .log_writer
            .lock()
            .map_err(|_| "cc-connect log writer lock poisoned".to_string())?;
        if writer.is_none() {
            *writer = Some(
                crate::log_rotation::create_log_writer(
                    crate::app_paths::logs_dir()?,
                    LOG_FILE_NAME,
                )
                .map_err(|err| format!("create cc-connect log failed: {err}"))?,
            );
        }
        Ok(())
    }

    fn append_system_log(&self, message: impl Into<String>) {
        if !load_profile()
            .ok()
            .flatten()
            .is_some_and(|profile| profile.logging_enabled)
        {
            return;
        }
        let _ = self.ensure_log_writer();
        push_log_line(&self.logs, &self.log_writer, "system", &message.into(), &[]);
    }

    fn detect(&self, explicit_path: Option<&str>, refresh: bool) -> Result<DetectedBinary, String> {
        let requested_path = explicit_path
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let requested_key = requested_path.map(ToOwned::to_owned);
        if !refresh {
            if let Ok(cache) = self.detection.lock() {
                if let Some(cache) = cache.as_ref() {
                    if cache.requested_path == requested_key {
                        return cache.result.clone();
                    }
                }
            }
        }
        let result = detect_binary_uncached(requested_path);
        if let Ok(mut cache) = self.detection.lock() {
            *cache = Some(DetectionCache {
                requested_path: requested_key,
                result: result.clone(),
            });
        }
        result
    }

    fn inspect_executable(&self, explicit_path: &str) -> CcConnectExecutableStatus {
        let requested_path = explicit_path.trim();
        let executable_path =
            normalize_executable_path_value(Some(requested_path)).unwrap_or_default();
        if requested_path.is_empty() {
            return CcConnectExecutableStatus {
                installed: false,
                executable_path,
                version: None,
                sha256: None,
                compatible: false,
                detection_error: Some("cc-connect executable path is required".to_string()),
            };
        }

        match self.detect(Some(requested_path), true) {
            Ok(binary) => CcConnectExecutableStatus {
                installed: true,
                executable_path: user_path_string(&binary.path),
                version: binary.version,
                sha256: Some(binary.sha256),
                compatible: binary.compatible,
                detection_error: None,
            },
            Err(err) => CcConnectExecutableStatus {
                installed: false,
                executable_path,
                version: None,
                sha256: None,
                compatible: false,
                detection_error: Some(err),
            },
        }
    }

    fn check_codex_app_server(&self, refresh: bool) -> Result<(), String> {
        if !refresh {
            if let Ok(cache) = self.codex_app_server_check.lock() {
                if let Some(result) = cache.as_ref() {
                    return result.clone();
                }
            }
        }
        let result = probe_codex_app_server();
        if let Ok(mut cache) = self.codex_app_server_check.lock() {
            *cache = Some(result.clone());
        }
        result
    }

    fn refresh_process_state(&self) {
        let exited = {
            let Ok(mut state) = self.process.lock() else {
                return;
            };
            let Some(process) = state.process.as_mut() else {
                return;
            };
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    state.process.take();
                    state.last_exit_code = code;
                    state.last_exit_at_ms = Some(now_millis());
                    Some(code)
                }
                Ok(None) => None,
                Err(err) => {
                    state.process.take();
                    state.last_exit_code = None;
                    state.last_exit_at_ms = Some(now_millis());
                    self.append_system_log(format!("failed to inspect cc-connect process: {err}"));
                    Some(None)
                }
            }
        };
        if let Some(code) = exited {
            self.append_system_log(format!("cc-connect exited (code={code:?})"));
        }
    }

    fn log_page(
        &self,
        after_seq: Option<u64>,
        limit: Option<usize>,
    ) -> Result<CcConnectLogPage, String> {
        let after_seq = after_seq.unwrap_or(0);
        if !load_profile()?.is_some_and(|profile| profile.logging_enabled) {
            return Ok(CcConnectLogPage {
                lines: Vec::new(),
                next_seq: after_seq,
                log_path: path_string(&log_path()?),
            });
        }
        let limit = limit
            .unwrap_or(DEFAULT_LOG_PAGE_SIZE)
            .clamp(1, MAX_LOG_PAGE_SIZE);
        let logs = self
            .logs
            .lock()
            .map_err(|_| "cc-connect log buffer lock poisoned".to_string())?;
        let lines = logs.page(after_seq, limit);
        let next_seq = lines.last().map(|line| line.seq).unwrap_or(after_seq);
        Ok(CcConnectLogPage {
            lines,
            next_seq,
            log_path: path_string(&log_path()?),
        })
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn remote_manager_dir() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?.join("remote-manager"))
}
fn profile_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(PROFILE_FILE_NAME))
}
fn config_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(CONFIG_FILE_NAME))
}
fn data_dir() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join("data"))
}
fn control_work_dir() -> Result<PathBuf, String> {
    let path = remote_manager_dir()?.join(CONTROL_WORK_DIR_NAME);
    fs::create_dir_all(&path)
        .map_err(|err| format!("create cc-connect control work directory failed: {err}"))?;
    path.canonicalize()
        .map_err(|err| format!("canonicalize cc-connect control work directory failed: {err}"))
}
fn sanitize_weixin_path_segment(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "default".to_string();
    }
    value
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':' | '\0') {
                '_'
            } else {
                character
            }
        })
        .collect()
}
fn weixin_account_dir_at(data_root: &Path, project_name: &str, project_id: &str) -> PathBuf {
    data_root
        .join("weixin")
        .join(sanitize_weixin_path_segment(project_name))
        .join(sanitize_weixin_path_segment(project_id))
}
fn weixin_account_dir(project_name: &str, project_id: &str) -> Result<PathBuf, String> {
    Ok(weixin_account_dir_at(
        &data_dir()?,
        project_name,
        project_id,
    ))
}
fn log_path() -> Result<PathBuf, String> {
    Ok(crate::app_paths::logs_dir()?.join(LOG_FILE_NAME))
}

fn weixin_authorization_dir() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(WEIXIN_AUTH_DIR_NAME))
}

fn weixin_authorization_paths() -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let dir = weixin_authorization_dir()?;
    Ok((
        dir.join(WEIXIN_AUTH_CONFIG_FILE_NAME),
        dir.join(WEIXIN_AUTH_QR_FILE_NAME),
        dir.join(WEIXIN_AUTH_STDOUT_FILE_NAME),
        dir.join(WEIXIN_AUTH_STDERR_FILE_NAME),
    ))
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("remove {} failed: {err}", path.display())),
    }
}

fn cleanup_weixin_authorization_files(paths: [&Path; 4]) {
    for path in paths {
        let _ = remove_file_if_exists(path);
    }
}

fn weixin_authorization_qr_data_url(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("inspect Weixin authorization QR failed: {err}")),
    };
    if metadata.len() == 0 || metadata.len() > MAX_WEIXIN_AUTH_QR_BYTES {
        return Ok(None);
    }
    let bytes =
        fs::read(path).map_err(|err| format!("read Weixin authorization QR failed: {err}"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(None);
    }
    Ok(Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(bytes)
    )))
}

fn weixin_authorization_error_detail(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let lines = raw
        .lines()
        .rev()
        .filter_map(|line| {
            let line = redact_log_line(line.trim(), &[]);
            (!line.is_empty()).then_some(line)
        })
        .take(4)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        None
    } else {
        Some(lines.into_iter().rev().collect::<Vec<_>>().join(" | "))
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn detect_binary_uncached(explicit_path: Option<&str>) -> Result<DetectedBinary, String> {
    let candidates = executable_candidates(explicit_path)?;
    let mut failures = Vec::new();
    let mut incompatible = None;
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        match inspect_binary(&candidate) {
            Ok(binary) if binary.compatible => return Ok(binary),
            Ok(binary) => {
                if incompatible.is_none() {
                    incompatible = Some(binary);
                }
            }
            Err(err) => failures.push(format!("{}: {err}", candidate.display())),
        }
    }
    if let Some(binary) = incompatible {
        return Ok(binary);
    }
    if failures.is_empty() {
        Err("cc-connect native executable not found in PATH".to_string())
    } else {
        Err(failures.join("; "))
    }
}

fn executable_candidates(explicit_path: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let mut raw = Vec::new();
    if let Some(explicit) = explicit_path {
        let path = PathBuf::from(explicit);
        if !path.is_absolute() {
            return Err("cc-connect executable path must be absolute".to_string());
        }
        raw.extend(expand_native_candidate(&path));
    } else {
        if let Some(path) = env::var_os("CC_CONNECT_PATH") {
            raw.extend(expand_native_candidate(&PathBuf::from(path)));
        }
        if let Some(path_value) = env::var_os("PATH") {
            for dir in env::split_paths(&path_value) {
                #[cfg(target_os = "windows")]
                {
                    raw.push(
                        dir.join("node_modules")
                            .join("cc-connect")
                            .join("bin")
                            .join("cc-connect.exe"),
                    );
                    raw.push(dir.join("cc-connect.exe"));
                }
                #[cfg(not(target_os = "windows"))]
                raw.push(dir.join("cc-connect"));
            }
        }
    }
    let mut seen = HashSet::new();
    Ok(raw
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .collect())
}

fn expand_native_candidate(path: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        if let Some(parent) = path.parent() {
            candidates.push(
                parent
                    .join("node_modules")
                    .join("cc-connect")
                    .join("bin")
                    .join("cc-connect.exe"),
            );
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            candidates.insert(0, path.to_path_buf());
        }
        candidates
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![path.to_path_buf()]
    }
}

fn inspect_binary(path: &Path) -> Result<DetectedBinary, String> {
    if !path.is_file() {
        return Err("not a file".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("canonicalize failed: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if canonical
            .metadata()
            .map_err(|err| format!("read metadata failed: {err}"))?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("file is not executable".to_string());
        }
    }
    let sha256 = sha256_file(&canonical)?;
    let Some(trusted_version) = trusted_binary_version(&sha256) else {
        return Ok(DetectedBinary {
            path: canonical,
            version: None,
            sha256,
            compatible: false,
        });
    };
    let mut command = silent_command(&path_string(&canonical));
    command.arg("--version");
    let output = output_with_timeout(command, VERSION_PROBE_TIMEOUT)
        .map_err(|err| format!("version probe failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "version probe exited with {}: {}",
            output.status,
            output_text(&output.stdout, &output.stderr)
        ));
    }
    let version_output = output_text(&output.stdout, &output.stderr);
    let (version, compatible) = parse_version(&version_output)
        .ok_or_else(|| format!("unrecognized version output: {version_output}"))?;
    let compatible = compatible && version == trusted_version;
    Ok(DetectedBinary {
        sha256,
        path: canonical,
        version: Some(version),
        compatible,
    })
}

fn trusted_binary_version(sha256: &str) -> Option<String> {
    if VERIFIED_V1_4_1_BINARY_SHA256
        .iter()
        .any(|expected| expected.eq_ignore_ascii_case(sha256))
    {
        return Some("1.4.1".to_string());
    }
    update::trusted_version_for_sha256(sha256).ok().flatten()
}

fn output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if stdout.is_empty() {
        stderr
    } else {
        stdout
    }
}

fn codex_app_server_help_supported(output: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    normalized.contains("codex app-server")
        && normalized.contains("--listen")
        && normalized.contains("stdio://")
}

fn probe_codex_app_server() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let command = {
        let mut command = silent_command("cmd.exe");
        command.args(["/d", "/s", "/c", "codex app-server --help"]);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let command = {
        let mut command = silent_command("codex");
        command.args(["app-server", "--help"]);
        command
    };
    let output = output_with_timeout(command, CODEX_APP_SERVER_PROBE_TIMEOUT)
        .map_err(|err| format!("Codex app-server probe failed: {err}"))?;
    let help = output_text(&output.stdout, &output.stderr);
    if !output.status.success() {
        return Err(format!(
            "Codex app-server probe exited with {}: {}",
            output.status, help
        ));
    }
    if !codex_app_server_help_supported(&help) {
        return Err("installed Codex CLI does not support app-server stdio transport".to_string());
    }
    Ok(())
}

fn parse_version(output: &str) -> Option<(String, bool)> {
    let version = output.split_whitespace().find_map(|token| {
        let clean = token
            .trim_matches(|value: char| matches!(value, '(' | ')' | '[' | ']' | ',' | ';'))
            .trim_start_matches(['v', 'V']);
        semver::Version::parse(clean).ok()
    })?;
    let version = version.to_string();
    let compatible = update::is_compatible_version(&version);
    Some((version, compatible))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|err| format!("open executable failed: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("read executable failed: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:X}", hasher.finalize()))
}

#[derive(Serialize)]
struct ManagedConfig {
    data_dir: String,
    language: String,
    max_turn_time_mins: u32,
    queue: ManagedQueueConfig,
    rate_limit: ManagedRateLimitConfig,
    log: ManagedLogConfig,
    webhook: DisabledFeature,
    bridge: DisabledFeature,
    management: DisabledFeature,
    commands: Vec<ManagedCommand>,
    aliases: Vec<ManagedAlias>,
    projects: Vec<ManagedProject>,
}
#[derive(Serialize)]
struct ManagedLogConfig {
    level: String,
}
#[derive(Serialize)]
struct ManagedQueueConfig {
    max_depth: u32,
}
#[derive(Serialize)]
struct ManagedRateLimitConfig {
    max_messages: u32,
    window_secs: u32,
}
#[derive(Serialize)]
struct DisabledFeature {
    enabled: bool,
}
#[derive(Serialize)]
struct ManagedProject {
    name: String,
    admin_from: String,
    disabled_commands: Vec<String>,
    reset_on_idle_mins: u32,
    agent: ManagedAgent,
    platforms: Vec<ManagedPlatform>,
}
#[derive(Serialize)]
struct ManagedAgent {
    #[serde(rename = "type")]
    kind: String,
    options: ManagedAgentOptions,
}
#[derive(Serialize)]
struct ManagedAgentOptions {
    work_dir: String,
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cmd: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rpc: Option<bool>,
    env: BTreeMap<String, String>,
}
#[derive(Serialize)]
struct CodexModelDiscoveryConfig<'a> {
    model_catalog_json: &'a str,
}
#[derive(Serialize)]
struct CodexModelCatalog {
    models: Vec<serde_json::Value>,
}
#[derive(Serialize)]
struct ManagedPlatform {
    #[serde(rename = "type")]
    kind: String,
    options: BTreeMap<String, toml::Value>,
}

#[derive(Serialize)]
struct ManagedCommand {
    name: String,
    description: String,
    exec: String,
    work_dir: String,
}

#[derive(Serialize)]
struct ManagedAlias {
    name: String,
    command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegisteredProject {
    id: String,
    name: String,
    path: String,
    agent: CcConnectAgent,
    cli_tool: String,
    cli_args: String,
    group_path: Vec<RegisteredGroupSegment>,
    provider_id: Option<String>,
    codex_provider_id: Option<String>,
    provider_name: Option<String>,
    provider_is_global: bool,
    environment_type: String,
    ssh_host_id: Option<String>,
    remote_path: String,
    cli_config_root: String,
    env_vars: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegisteredGroupSegment {
    id: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegisteredGroup {
    id: String,
    name: String,
    parent_id: Option<String>,
    sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegisteredProjectRow {
    id: String,
    name: String,
    path: String,
    agent: CcConnectAgent,
    cli_tool: String,
    cli_args: String,
    group_id: Option<String>,
    sort_order: i64,
    provider_overrides: String,
    environment_type: String,
    ssh_host_id: Option<String>,
    remote_path: String,
    cli_config_root: String,
    host_codex_config_root: String,
    env_vars: String,
}

#[derive(Debug, Clone)]
struct RegisteredSshHost {
    host: String,
    port: u16,
    username: String,
    config_alias: String,
    config_file: String,
    auth_mode: String,
    identity_file: String,
    credential_ref: String,
    jump_mode: String,
    jump_host_id: Option<String>,
    proxy_type: String,
    proxy_host: String,
    proxy_port: u16,
    proxy_command: String,
    connect_timeout_sec: u64,
    server_alive_interval_sec: u64,
    server_alive_count_max: u32,
    startup_script: String,
}

#[derive(Debug, Default)]
struct ProviderCatalog {
    current_by_app: BTreeMap<String, ProviderCatalogEntry>,
    names_by_app_and_id: BTreeMap<(String, String), String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderCatalogEntry {
    id: String,
    name: String,
}

fn platform_type(platform: CcConnectPlatform) -> &'static str {
    match platform {
        CcConnectPlatform::Telegram => "telegram",
        CcConnectPlatform::Feishu => "feishu",
        CcConnectPlatform::Weixin => "weixin",
        CcConnectPlatform::Wecom => "wecom",
    }
}

fn build_managed_platform(
    profile: &CcConnectProfile,
    platform_profile: &CcConnectPlatformProfile,
) -> Result<(ManagedPlatform, String), String> {
    let allow_from = normalize_allow_from(platform_profile.platform, &platform_profile.allow_from)?;
    let mut options = BTreeMap::new();
    options.insert(
        "allow_from".to_string(),
        toml::Value::String(allow_from.clone()),
    );
    options.insert("group_reply_all".to_string(), toml::Value::Boolean(false));
    options.insert(
        "share_session_in_channel".to_string(),
        toml::Value::Boolean(false),
    );
    match platform_profile.platform {
        CcConnectPlatform::Telegram => {
            options.insert(
                "token".to_string(),
                toml::Value::String(format!("${{{}}}", TELEGRAM_TOKEN_ENV)),
            );
            options.insert("enable_reactions".to_string(), toml::Value::Boolean(false));
            options.insert(
                "progress_style".to_string(),
                toml::Value::String("compact".to_string()),
            );
        }
        CcConnectPlatform::Feishu => {
            options.insert(
                "app_id".to_string(),
                toml::Value::String(format!("${{{}}}", FEISHU_APP_ID_ENV)),
            );
            options.insert(
                "app_secret".to_string(),
                toml::Value::String(format!("${{{}}}", FEISHU_APP_SECRET_ENV)),
            );
            options.insert("group_only".to_string(), toml::Value::Boolean(false));
            options.insert("thread_isolation".to_string(), toml::Value::Boolean(false));
            options.insert("reply_to_trigger".to_string(), toml::Value::Boolean(true));
        }
        CcConnectPlatform::Weixin => {
            options.insert(
                "token".to_string(),
                toml::Value::String(format!("${{{}}}", WEIXIN_TOKEN_ENV)),
            );
            options.insert(
                "account_id".to_string(),
                toml::Value::String(profile.project_id.clone()),
            );
        }
        CcConnectPlatform::Wecom => {
            options.insert(
                "mode".to_string(),
                toml::Value::String("websocket".to_string()),
            );
            options.insert(
                "bot_id".to_string(),
                toml::Value::String(format!("${{{}}}", WECOM_BOT_ID_ENV)),
            );
            options.insert(
                "bot_secret".to_string(),
                toml::Value::String(format!("${{{}}}", WECOM_BOT_SECRET_ENV)),
            );
        }
    }
    Ok((
        ManagedPlatform {
            kind: platform_type(platform_profile.platform).to_string(),
            options,
        },
        allow_from,
    ))
}

fn build_managed_config(
    profile: &CcConnectProfile,
    project_list_path: &Path,
    project_switch_script_path: &Path,
) -> Result<ManagedConfig, String> {
    build_managed_config_with_codex(profile, project_list_path, project_switch_script_path, None)
}

fn build_managed_config_with_codex(
    profile: &CcConnectProfile,
    project_list_path: &Path,
    project_switch_script_path: &Path,
    codex_launch: Option<&RemoteCodexLaunch>,
) -> Result<ManagedConfig, String> {
    build_managed_config_with_agent_launch(
        profile,
        project_list_path,
        project_switch_script_path,
        codex_launch,
        None,
        None,
        &BTreeMap::new(),
    )
}

fn build_managed_config_with_agent_launch(
    profile: &CcConnectProfile,
    project_list_path: &Path,
    project_switch_script_path: &Path,
    codex_launch: Option<&RemoteCodexLaunch>,
    agent_launcher: Option<&ResolvedAgentLauncher>,
    claude_settings_path: Option<&Path>,
    additional_agent_environment: &BTreeMap<String, String>,
) -> Result<ManagedConfig, String> {
    let configured_platforms = enabled_platforms(profile);
    if configured_platforms.is_empty() {
        return Err("at least one messaging platform must be enabled".to_string());
    }
    let mut platforms = Vec::with_capacity(configured_platforms.len());
    let mut admin_users = Vec::new();
    let mut seen_admin_users = HashSet::new();
    for platform_profile in &configured_platforms {
        let (platform, allow_from) = build_managed_platform(profile, platform_profile)?;
        for user in allow_from.split(',') {
            if seen_admin_users.insert(user.to_string()) {
                admin_users.push(user.to_string());
            }
        }
        platforms.push(platform);
    }
    let admin_from = admin_users.join(",");
    let (commands, aliases) =
        build_remote_project_commands(profile, project_list_path, project_switch_script_path)?;
    let codex_home = (profile.agent == CcConnectAgent::Codex)
        .then(|| codex_launch.and_then(|launch| launch.codex_home.as_ref()))
        .flatten()
        .map(|path| config_path_value(path));
    let active_model = (profile.agent == CcConnectAgent::Codex)
        .then(|| {
            codex_launch
                .and_then(|launch| launch.provider.as_ref())
                .and_then(|provider| provider.model.clone())
        })
        .flatten();
    let mut agent_environment = [
        (TELEGRAM_TOKEN_ENV.to_string(), String::new()),
        (FEISHU_APP_ID_ENV.to_string(), String::new()),
        (FEISHU_APP_SECRET_ENV.to_string(), String::new()),
        (WEIXIN_TOKEN_ENV.to_string(), String::new()),
        (WECOM_BOT_ID_ENV.to_string(), String::new()),
        (WECOM_BOT_SECRET_ENV.to_string(), String::new()),
    ]
    .into_iter()
    .collect::<BTreeMap<_, _>>();
    if let Some(provider) = codex_launch.and_then(|launch| launch.provider.as_ref()) {
        // cc-connect builds the Codex child environment from this map. Keep the
        // credential in the managed process environment and reference it here,
        // so the generated config never persists the secret itself.
        agent_environment.insert(
            provider.env_key.clone(),
            format!("${{{}}}", provider.env_key),
        );
    }
    agent_environment.extend(additional_agent_environment.clone());
    let managed_command = agent_launcher.map(managed_agent_command);
    let agent_command = match profile.agent {
        CcConnectAgent::Claude => {
            let mut command = managed_command.unwrap_or_else(|| vec!["claude".to_string()]);
            if let Some(settings_path) = claude_settings_path {
                command.extend(["--settings".to_string(), config_path_value(settings_path)]);
            }
            (agent_launcher.is_some() || claude_settings_path.is_some()).then_some(command)
        }
        CcConnectAgent::Pi | CcConnectAgent::Opencode => managed_command,
        CcConnectAgent::Codex => None,
    };
    Ok(ManagedConfig {
        data_dir: config_path_value(&data_dir()?),
        language: match profile.language {
            CcConnectLanguage::Zh => "zh",
            CcConnectLanguage::En => "en",
        }
        .to_string(),
        max_turn_time_mins: profile.max_turn_time_mins,
        queue: ManagedQueueConfig { max_depth: 2 },
        rate_limit: ManagedRateLimitConfig {
            max_messages: 10,
            window_secs: 60,
        },
        log: ManagedLogConfig {
            level: "info".to_string(),
        },
        webhook: DisabledFeature { enabled: false },
        bridge: DisabledFeature { enabled: false },
        management: DisabledFeature { enabled: false },
        commands,
        aliases,
        projects: vec![ManagedProject {
            name: profile.project_name.clone(),
            // Exec-backed CLI-Manager commands require cc-connect admin status.
            // Every other privileged built-in remains disabled below.
            admin_from,
            // Preserve basic session controls while blocking commands that can
            // change authorization, persistence, providers, workspaces, or files.
            disabled_commands: [
                "list",
                "switch",
                "name",
                "current",
                "history",
                "allow",
                "mode",
                "provider",
                "memory",
                "cron",
                "timer",
                "heartbeat",
                "commands",
                "skills",
                "config",
                "doctor",
                "upgrade",
                "restart",
                "alias",
                "delete",
                "bind",
                "search",
                "shell",
                "show",
                "dir",
                "tts",
                "workspace",
                "web",
                "diff",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            reset_on_idle_mins: 0,
            agent: ManagedAgent {
                kind: profile.agent.config_type().to_string(),
                options: ManagedAgentOptions {
                    work_dir: config_path_value(Path::new(&profile.project_path)),
                    mode: profile
                        .agent
                        .configured_mode(profile.yolo_enabled)
                        .to_string(),
                    cmd: agent_command,
                    backend: profile.agent.backend().map(str::to_string),
                    app_server_url: profile.agent.app_server_url().map(str::to_string),
                    model: active_model,
                    codex_home,
                    rpc: profile.agent.rpc(),
                    env: agent_environment,
                },
            },
            platforms,
        }],
    })
}

fn build_weixin_authorization_config(profile: &CcConnectProfile) -> Result<String, String> {
    let dir = weixin_authorization_dir()?;
    let mut authorization_profile = profile.clone();
    hydrate_profile_platforms(&mut authorization_profile);
    authorization_profile.platform = CcConnectPlatform::Weixin;
    for item in &mut authorization_profile.platforms {
        item.enabled = item.platform == CcConnectPlatform::Weixin;
    }
    authorization_profile.allow_from = authorization_profile
        .platforms
        .iter()
        .find(|item| item.platform == CcConnectPlatform::Weixin)
        .map(|item| item.allow_from.clone())
        .unwrap_or_default();
    let mut config = build_managed_config(
        &authorization_profile,
        &dir.join(PROJECT_LIST_FILE_NAME),
        &dir.join(PROJECT_SWITCH_SCRIPT_FILE_NAME),
    )?;
    let platform = config
        .projects
        .first_mut()
        .and_then(|project| {
            project
                .platforms
                .iter_mut()
                .find(|platform| platform.kind == "weixin")
        })
        .ok_or_else(|| "Weixin authorization platform is missing".to_string())?;
    platform
        .options
        .insert("token".to_string(), toml::Value::String(String::new()));
    platform
        .options
        .insert("allow_from".to_string(), toml::Value::String(String::new()));
    toml::to_string_pretty(&config)
        .map_err(|err| format!("serialize Weixin authorization config failed: {err}"))
}

#[derive(Debug)]
struct WeixinAuthorizationResult {
    token: String,
    allow_from: String,
}

fn parse_weixin_authorization_result(
    path: &Path,
    project_name: &str,
) -> Result<WeixinAuthorizationResult, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read Weixin authorization result failed: {err}"))?;
    let root: toml::Value = toml::from_str(&raw)
        .map_err(|err| format!("parse Weixin authorization result failed: {err}"))?;
    let projects = root
        .get("projects")
        .and_then(toml::Value::as_array)
        .ok_or_else(|| "Weixin authorization result has no projects".to_string())?;
    let project = projects
        .iter()
        .find(|project| {
            project
                .get("name")
                .and_then(toml::Value::as_str)
                .is_some_and(|name| name == project_name)
        })
        .ok_or_else(|| "Weixin authorization project is missing".to_string())?;
    let platform = project
        .get("platforms")
        .and_then(toml::Value::as_array)
        .and_then(|platforms| {
            platforms.iter().find(|platform| {
                platform
                    .get("type")
                    .and_then(toml::Value::as_str)
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("weixin"))
            })
        })
        .ok_or_else(|| "Weixin authorization platform is missing".to_string())?;
    let options = platform
        .get("options")
        .and_then(toml::Value::as_table)
        .ok_or_else(|| "Weixin authorization options are missing".to_string())?;
    let token = options
        .get("token")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Weixin authorization token is missing".to_string())?
        .to_string();
    let allow_from = options
        .get("allow_from")
        .and_then(toml::Value::as_str)
        .unwrap_or_default();
    let allow_from = normalize_allow_from(CcConnectPlatform::Weixin, allow_from)
        .map_err(|_| "Weixin authorization user ID is missing".to_string())?;
    Ok(WeixinAuthorizationResult { token, allow_from })
}

fn merge_weixin_allow_from(existing: &str, scanned: &str) -> Result<String, String> {
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for source in [existing, scanned] {
        let normalized = if source.trim().is_empty() {
            continue;
        } else {
            normalize_allow_from(CcConnectPlatform::Weixin, source)?
        };
        for value in normalized.split(',') {
            if seen.insert(value.to_string()) {
                values.push(value.to_string());
            }
        }
    }
    if values.is_empty() {
        Err("Weixin authorization user ID is missing".to_string())
    } else {
        Ok(values.join(","))
    }
}

fn build_remote_project_commands(
    profile: &CcConnectProfile,
    project_list_path: &Path,
    project_switch_script_path: &Path,
) -> Result<(Vec<ManagedCommand>, Vec<ManagedAlias>), String> {
    let work_dir = config_path_value(&remote_manager_dir()?);
    let list_path = powershell_single_quoted(&user_path_string(project_list_path));
    let list_description = match profile.language {
        CcConnectLanguage::Zh => "列出 CLI-Manager 已登记项目",
        CcConnectLanguage::En => "List projects registered in CLI-Manager",
    };
    let list_exec = format!(
        "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; \
         Get-Content -Raw -Encoding UTF8 -LiteralPath {list_path}; $null='{{{{0:}}}}'"
    );
    let switch_script = powershell_single_quoted(&user_path_string(project_switch_script_path));
    let switch_description = match profile.language {
        CcConnectLanguage::Zh => "按序号切换 CLI-Manager 项目，例如 /cli_manager_switch 2",
        CcConnectLanguage::En => {
            "Switch CLI-Manager project by number, for example /cli_manager_switch 2"
        }
    };
    // cc-connect v1.4.1 removes ASCII quote characters while tokenizing command
    // arguments. A single-quoted here-string therefore keeps newlines and every
    // remaining PowerShell metacharacter as data; its ASCII footer cannot be
    // supplied by the remote user. The pinned cc-connect hash protects this
    // parser contract until a newer version is reviewed explicitly.
    let switch_exec = format!(
        "$raw=@'\n{{{{args:}}}}\n'@\n\
         $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($raw))\n\
         powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
         -File {switch_script} $encoded"
    );
    Ok((
        vec![
            ManagedCommand {
                name: "cli_manager_list".to_string(),
                description: list_description.to_string(),
                exec: list_exec,
                work_dir: work_dir.clone(),
            },
            ManagedCommand {
                name: "cli_manager_switch".to_string(),
                description: switch_description.to_string(),
                exec: switch_exec,
                work_dir,
            },
        ],
        Vec::new(),
    ))
}

fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn project_switch_token(project_id: &str) -> String {
    format!("{:x}", Sha256::digest(project_id.as_bytes()))[..32].to_string()
}

fn project_list_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(PROJECT_LIST_FILE_NAME))
}

fn project_switch_script_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(PROJECT_SWITCH_SCRIPT_FILE_NAME))
}

fn is_switch_identifier(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn switch_result_path(request_id: &str) -> Result<PathBuf, String> {
    if !is_switch_identifier(request_id) {
        return Err("invalid CLI-Manager project switch request ID".to_string());
    }
    Ok(remote_manager_dir()?.join(format!("switch-result-{request_id}.txt")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteSwitchRequest {
    project_token: String,
    request_id: String,
}

fn remote_switch_request_from_args(args: &[String]) -> Option<RemoteSwitchRequest> {
    args.iter().find_map(|arg| {
        let payload = arg.strip_prefix(REMOTE_SWITCH_ARG_PREFIX)?;
        let (project_token, request_id) = payload.split_once(':').unwrap_or((payload, payload));
        Some(RemoteSwitchRequest {
            project_token: project_token.to_string(),
            request_id: request_id.to_string(),
        })
    })
}

fn base64_utf8(value: &str) -> String {
    BASE64_STANDARD.encode(value.as_bytes())
}

fn render_project_switch_script(
    profile: &CcConnectProfile,
    registered_projects: &[RegisteredProject],
    cli_manager_executable: &Path,
) -> Result<String, String> {
    let project_tokens = registered_projects
        .iter()
        .map(|project| format!("    '{}'", project_switch_token(&project.id)))
        .collect::<Vec<_>>()
        .join(",\n");
    let cli_manager = base64_utf8(&user_path_string(cli_manager_executable));
    let result_directory = base64_utf8(&user_path_string(&remote_manager_dir()?));
    let (invalid_message, range_message, timeout_message) = match profile.language {
        CcConnectLanguage::Zh => (
            "请输入有效的项目序号，例如 /cli_manager_switch 2。",
            "项目序号超出范围，请先发送 /cli_manager_list 查看可用项目。",
            "CLI-Manager 项目切换请求超时。",
        ),
        CcConnectLanguage::En => (
            "Enter a valid project number, for example /cli_manager_switch 2.",
            "The project number is out of range. Send /cli_manager_list to view available projects.",
            "The CLI-Manager project switch request timed out.",
        ),
    };
    let invalid_message = base64_utf8(invalid_message);
    let range_message = base64_utf8(range_message);
    let timeout_message = base64_utf8(timeout_message);
    Ok(format!(
        r#"$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding

function Decode-Base64Utf8([string]$Value) {{
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}}

$invalidMessage = Decode-Base64Utf8 '{invalid_message}'
$rangeMessage = Decode-Base64Utf8 '{range_message}'
$timeoutMessage = Decode-Base64Utf8 '{timeout_message}'

if ($args.Count -ne 1) {{
    Write-Output $invalidMessage
    exit 0
}}

$raw = ''
try {{
    $raw = Decode-Base64Utf8 $args[0]
}} catch {{
    Write-Output $invalidMessage
    exit 0
}}
if ($raw -notmatch '^[1-9][0-9]*$') {{
    Write-Output $invalidMessage
    exit 0
}}

$projectNumber = 0
if (-not [int]::TryParse($raw, [ref]$projectNumber)) {{
    Write-Output $invalidMessage
    exit 0
}}

$tokens = @(
{project_tokens}
)
if ($projectNumber -gt $tokens.Count) {{
    Write-Output $rangeMessage
    exit 0
}}

$cliManager = Decode-Base64Utf8 '{cli_manager}'
$resultDirectory = Decode-Base64Utf8 '{result_directory}'
$token = $tokens[$projectNumber - 1]
$request = [Guid]::NewGuid().ToString('N')
$result = Join-Path -Path $resultDirectory -ChildPath "switch-result-$request.txt"
$argument = "{REMOTE_SWITCH_ARG_PREFIX}" + $token + ':' + $request
Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $cliManager -ArgumentList $argument -Wait -WindowStyle Hidden | Out-Null
$deadline = (Get-Date).AddSeconds(10)
while (!(Test-Path -LiteralPath $result) -and (Get-Date) -lt $deadline) {{
    Start-Sleep -Milliseconds 100
}}
if (Test-Path -LiteralPath $result) {{
    try {{
        Get-Content -Raw -Encoding UTF8 -LiteralPath $result
    }} finally {{
        Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
    }}
}} else {{
    Write-Output $timeoutMessage
}}
"#
    ))
}

fn render_project_list(
    profile: &CcConnectProfile,
    registered_projects: &[RegisteredProject],
) -> String {
    let current_summary = registered_projects
        .iter()
        .find(|project| profile.runtime_project_id.as_deref() == Some(project.id.as_str()))
        .map(|project| project_summary(profile.language, project))
        .unwrap_or_else(|| match profile.language {
            CcConnectLanguage::Zh => "等待宠物选择托管会话".to_string(),
            CcConnectLanguage::En => "waiting for a desktop-pet handoff".to_string(),
        });
    let mut output = match profile.language {
        CcConnectLanguage::Zh => format!("CLI-Manager 项目（当前：{current_summary}）"),
        CcConnectLanguage::En => format!("CLI-Manager projects (current: {current_summary})"),
    };
    if registered_projects.is_empty() {
        output.push_str(match profile.language {
            CcConnectLanguage::Zh => "\n暂无已登记项目。",
            CcConnectLanguage::En => "\nNo registered projects.",
        });
        return output;
    }

    let mut previous_group_ids = Vec::<String>::new();
    let mut ungrouped_header_rendered = false;
    for (index, project) in registered_projects.iter().enumerate() {
        let item_depth = if project.group_path.is_empty() {
            previous_group_ids.clear();
            if !ungrouped_header_rendered {
                output.push_str(match profile.language {
                    CcConnectLanguage::Zh => "\n📁 未分组",
                    CcConnectLanguage::En => "\n📁 Ungrouped",
                });
                ungrouped_header_rendered = true;
            }
            1
        } else {
            let common_depth = project
                .group_path
                .iter()
                .zip(&previous_group_ids)
                .take_while(|(group, previous_id)| group.id == **previous_id)
                .count();
            for (offset, group) in project.group_path[common_depth..].iter().enumerate() {
                let depth = common_depth + offset;
                output.push_str(&format!(
                    "\n{}📁 {}",
                    "  ".repeat(depth),
                    single_line(&group.name)
                ));
            }
            previous_group_ids = project
                .group_path
                .iter()
                .map(|group| group.id.clone())
                .collect();
            project.group_path.len()
        };
        let current = profile.runtime_project_id.as_deref() == Some(project.id.as_str());
        let unavailable = !Path::new(&project.path).is_dir();
        let state = match (profile.language, current, unavailable) {
            (CcConnectLanguage::Zh, true, false) => " [当前]",
            (CcConnectLanguage::Zh, _, true) => " [路径不可用]",
            (CcConnectLanguage::En, true, false) => " [current]",
            (CcConnectLanguage::En, _, true) => " [path unavailable]",
            _ => "",
        };
        let item_indent = "  ".repeat(item_depth);
        let detail_indent = format!("{item_indent}   ");
        let path_label = match profile.language {
            CcConnectLanguage::Zh => "路径：",
            CcConnectLanguage::En => "Path: ",
        };
        output.push_str(&format!(
            "\n{item_indent}{}. {}{}\n{detail_indent}{} · {}\n{detail_indent}{path_label}{}",
            index + 1,
            single_line(&project.name),
            state,
            agent_display_name(project.agent),
            provider_display_value(profile.language, project),
            single_line(&user_path_string(Path::new(&project.path)))
        ));
    }
    output.push_str(match profile.language {
        CcConnectLanguage::Zh => "\n\n切换项目：/cli_manager_switch <序号>",
        CcConnectLanguage::En => "\n\nSwitch project: /cli_manager_switch <number>",
    });
    output
}

fn agent_display_name(agent: CcConnectAgent) -> &'static str {
    match agent {
        CcConnectAgent::Claude => "Claude Code",
        CcConnectAgent::Codex => "Codex",
        CcConnectAgent::Pi => "Pi",
        CcConnectAgent::Opencode => "OpenCode",
    }
}

fn provider_display_value(language: CcConnectLanguage, project: &RegisteredProject) -> String {
    if matches!(project.agent, CcConnectAgent::Pi | CcConnectAgent::Opencode) {
        return match (language, project.agent) {
            (CcConnectLanguage::Zh, CcConnectAgent::Pi) => "Provider：跟随 Pi 配置".to_string(),
            (CcConnectLanguage::En, CcConnectAgent::Pi) => {
                "Provider: follow Pi configuration".to_string()
            }
            (CcConnectLanguage::Zh, CcConnectAgent::Opencode) => {
                "Provider：跟随 OpenCode 配置".to_string()
            }
            (CcConnectLanguage::En, CcConnectAgent::Opencode) => {
                "Provider: follow OpenCode configuration".to_string()
            }
            _ => unreachable!(),
        };
    }
    let provider_name = project.provider_name.as_deref().map(single_line);
    match (language, project.provider_is_global, provider_name) {
        (CcConnectLanguage::Zh, true, Some(name)) => format!("Provider：{name}（全局）"),
        (CcConnectLanguage::Zh, true, None) => "Provider：跟随全局".to_string(),
        (CcConnectLanguage::Zh, false, Some(name)) => format!("Provider：{name}"),
        (CcConnectLanguage::Zh, false, None) => "Provider：项目指定".to_string(),
        (CcConnectLanguage::En, true, Some(name)) => format!("Provider: {name} (global)"),
        (CcConnectLanguage::En, true, None) => "Provider: follow global".to_string(),
        (CcConnectLanguage::En, false, Some(name)) => format!("Provider: {name}"),
        (CcConnectLanguage::En, false, None) => "Provider: project override".to_string(),
    }
}

fn project_summary(language: CcConnectLanguage, project: &RegisteredProject) -> String {
    format!(
        "{} · {} · {}",
        single_line(&project.name),
        agent_display_name(project.agent),
        provider_display_value(language, project)
    )
}

fn single_line(value: &str) -> String {
    value.replace(['\r', '\n'], " ").trim().to_string()
}

fn user_path_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    let value = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.into_owned()
    };
    #[cfg(not(target_os = "windows"))]
    let value = value.into_owned();
    value
}

fn normalize_executable_path_value(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| user_path_string(Path::new(value)))
}

fn config_path_value(path: &Path) -> String {
    user_path_string(path).replace('\\', "/")
}

fn write_file_atomically(path: &Path, payload: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} parent is missing"))?;
    fs::create_dir_all(parent).map_err(|err| format!("create {label} directory failed: {err}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("cc-connect");
    let temp = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let result = (|| {
        let mut file =
            File::create(&temp).map_err(|err| format!("create temporary {label} failed: {err}"))?;
        file.write_all(payload)
            .map_err(|err| format!("write temporary {label} failed: {err}"))?;
        file.sync_all()
            .map_err(|err| format!("sync temporary {label} failed: {err}"))?;
        replace_file(&temp, path).map_err(|err| format!("replace {label} failed: {err}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_file_atomically_if_changed(
    path: &Path,
    payload: &[u8],
    label: &str,
) -> Result<(), String> {
    if fs::read(path).is_ok_and(|current| current == payload) {
        return Ok(());
    }
    write_file_atomically(path, payload, label)
}

#[cfg(unix)]
fn write_executable_file_atomically_if_changed(
    path: &Path,
    payload: &[u8],
    label: &str,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    write_file_atomically_if_changed(path, payload, label)?;
    let metadata =
        fs::metadata(path).map_err(|err| format!("read {label} metadata failed: {err}"))?;
    let mut permissions = metadata.permissions();
    if permissions.mode() & 0o777 != 0o755 {
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)
            .map_err(|err| format!("set {label} executable permissions failed: {err}"))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_file_atomically_if_changed(
    source: &Path,
    destination: &Path,
    label: &str,
) -> Result<(), String> {
    let source_digest = sha256_file(source)?;
    if destination.is_file()
        && sha256_file(destination)
            .ok()
            .is_some_and(|digest| digest == source_digest)
    {
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| format!("{label} parent is missing"))?;
    fs::create_dir_all(parent).map_err(|err| format!("create {label} directory failed: {err}"))?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("codex.exe");
    let temp = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let result = (|| {
        let mut input =
            File::open(source).map_err(|err| format!("open source {label} failed: {err}"))?;
        let mut output =
            File::create(&temp).map_err(|err| format!("create temporary {label} failed: {err}"))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|err| format!("copy temporary {label} failed: {err}"))?;
        output
            .sync_all()
            .map_err(|err| format!("sync temporary {label} failed: {err}"))?;
        drop(output);
        replace_file(&temp, destination).map_err(|err| format!("replace {label} failed: {err}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|err| err.to_string())
}

fn write_managed_config(profile: &CcConnectProfile) -> Result<PathBuf, String> {
    write_managed_config_with_codex(profile, None)
}

fn write_managed_config_with_codex(
    profile: &CcConnectProfile,
    codex_launch: Option<&RemoteCodexLaunch>,
) -> Result<PathBuf, String> {
    write_managed_config_with_agent_launch(profile, codex_launch, None, None, &BTreeMap::new())
}

fn write_managed_config_with_agent_launch(
    profile: &CcConnectProfile,
    codex_launch: Option<&RemoteCodexLaunch>,
    agent_launcher: Option<&ResolvedAgentLauncher>,
    claude_settings_path: Option<&Path>,
    additional_agent_environment: &BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    let dir = remote_manager_dir()?;
    fs::create_dir_all(&dir).map_err(|err| format!("create remote manager dir failed: {err}"))?;
    fs::create_dir_all(data_dir()?)
        .map_err(|err| format!("create cc-connect data dir failed: {err}"))?;
    let path = config_path()?;
    let list_path = project_list_path()?;
    let switch_script_path = project_switch_script_path()?;
    let registered_projects = load_registered_projects(Some(profile))?;
    let cli_manager_executable = std::env::current_exe()
        .map_err(|err| format!("resolve CLI-Manager executable failed: {err}"))?;
    let payload = toml::to_string_pretty(&build_managed_config_with_agent_launch(
        profile,
        &list_path,
        &switch_script_path,
        codex_launch,
        agent_launcher,
        claude_settings_path,
        additional_agent_environment,
    )?)
    .map_err(|err| format!("serialize cc-connect config failed: {err}"))?;
    let list_payload = render_project_list(profile, &registered_projects);
    let switch_script_payload =
        render_project_switch_script(profile, &registered_projects, &cli_manager_executable)?;
    let config_snapshot = FileSnapshot::capture(path.clone(), "cc-connect config")?;
    let list_snapshot = FileSnapshot::capture(list_path.clone(), "CLI-Manager project list")?;
    let switch_script_snapshot = FileSnapshot::capture(
        switch_script_path.clone(),
        "CLI-Manager project switch script",
    )?;
    if let Err(write_error) = (|| {
        write_file_atomically(
            &list_path,
            list_payload.as_bytes(),
            "CLI-Manager project list",
        )?;
        write_file_atomically_if_changed(
            &switch_script_path,
            switch_script_payload.as_bytes(),
            "CLI-Manager project switch script",
        )?;
        write_file_atomically(&path, payload.as_bytes(), "cc-connect config")
    })() {
        let mut rollback_errors = Vec::new();
        if let Err(err) = config_snapshot.restore() {
            rollback_errors.push(err);
        }
        if let Err(err) = list_snapshot.restore() {
            rollback_errors.push(err);
        }
        if let Err(err) = switch_script_snapshot.restore() {
            rollback_errors.push(err);
        }
        return if rollback_errors.is_empty() {
            Err(write_error)
        } else {
            Err(format!(
                "{write_error}; rollback failed: {}",
                rollback_errors.join("; ")
            ))
        };
    }
    Ok(path)
}

fn copy_profile_state_file_if_missing(
    source: &Path,
    target: &Path,
    label: &'static str,
) -> Result<(), String> {
    if target.is_file() || !source.is_file() {
        return Ok(());
    }
    let payload = fs::read(source).map_err(|err| format!("read legacy {label} failed: {err}"))?;
    write_file_atomically(target, &payload, label)
}

fn migrate_legacy_profile_state_at(
    profile: &CcConnectProfile,
    control_path: &Path,
    data_root: &Path,
) -> Result<(), String> {
    let legacy_path = PathBuf::from(profile.project_path.trim());
    if legacy_path.is_absolute() && !profile.project_name.trim().is_empty() {
        let sessions_root = data_root.to_path_buf();
        let source = handoff_session::cc_session_store_path(
            &sessions_root,
            &profile.project_name,
            &user_path_string(&legacy_path),
        )?;
        let target = handoff_session::cc_session_store_path(
            &sessions_root,
            CONTROL_PROJECT_NAME,
            &user_path_string(control_path),
        )?;
        copy_profile_state_file_if_missing(&source, &target, "cc-connect control session")?;
    }

    if !profile.project_name.trim().is_empty() && !profile.project_id.trim().is_empty() {
        let source_dir =
            weixin_account_dir_at(data_root, &profile.project_name, &profile.project_id);
        let target_dir = weixin_account_dir_at(data_root, CONTROL_PROJECT_NAME, CONTROL_PROJECT_ID);
        for filename in ["context_tokens.json", "get_updates.buf"] {
            copy_profile_state_file_if_missing(
                &source_dir.join(filename),
                &target_dir.join(filename),
                "Weixin control state",
            )?;
        }
    }
    Ok(())
}

fn migrate_legacy_profile_state(
    profile: &CcConnectProfile,
    control_path: &Path,
) -> Result<(), String> {
    migrate_legacy_profile_state_at(profile, control_path, &data_dir()?)
}

fn set_control_profile_values(profile: &mut CcConnectProfile, control_path: &Path) -> bool {
    let runtime_project_id = profile
        .runtime_project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let changed = profile.project_id != CONTROL_PROJECT_ID
        || profile.project_name != CONTROL_PROJECT_NAME
        || profile.agent != CcConnectAgent::Codex
        || profile.runtime_project_id != runtime_project_id
        || PathBuf::from(&profile.project_path)
            .canonicalize()
            .map(|path| path != control_path)
            .unwrap_or(true);
    profile.project_id = CONTROL_PROJECT_ID.to_string();
    profile.project_name = CONTROL_PROJECT_NAME.to_string();
    profile.project_path = user_path_string(control_path);
    profile.agent = CcConnectAgent::Codex;
    profile.runtime_project_id = runtime_project_id;
    changed
}

fn apply_control_profile(profile: &mut CcConnectProfile) -> Result<bool, String> {
    let control_path = control_work_dir()?;
    let legacy_profile = profile.clone();
    let changed = set_control_profile_values(profile, &control_path);
    if changed {
        migrate_legacy_profile_state(&legacy_profile, &control_path)?;
    }
    Ok(changed)
}

fn load_profile() -> Result<Option<CcConnectProfile>, String> {
    let path = profile_path()?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("read cc-connect profile failed: {err}")),
    };
    let mut profile: CcConnectProfile = serde_json::from_str(&raw)
        .map_err(|err| format!("parse cc-connect profile failed: {err}"))?;
    profile.executable_path = normalize_executable_path_value(profile.executable_path.as_deref());
    hydrate_profile_platforms(&mut profile);
    if handoff_session::load_handoff_record()?.is_none() && apply_control_profile(&mut profile)? {
        persist_profile(&profile)?;
    }
    Ok(Some(profile))
}

fn persist_profile(profile: &CcConnectProfile) -> Result<(), String> {
    let path = profile_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create remote manager dir failed: {err}"))?;
    }
    let payload = serde_json::to_string_pretty(profile)
        .map_err(|err| format!("serialize cc-connect profile failed: {err}"))?;
    write_file_atomically(&path, payload.as_bytes(), "cc-connect profile")
}

fn profile_platforms(profile: &CcConnectProfile) -> Vec<CcConnectPlatformProfile> {
    if profile.platforms.is_empty() {
        return vec![CcConnectPlatformProfile {
            platform: profile.platform,
            enabled: true,
            allow_from: profile.allow_from.clone(),
        }];
    }
    profile.platforms.clone()
}

fn hydrate_profile_platforms(profile: &mut CcConnectProfile) {
    let legacy_platform = profile.platform;
    let legacy_allow_from = profile.allow_from.clone();
    let had_platforms = !profile.platforms.is_empty();
    let mut configured = BTreeMap::new();
    for platform in profile.platforms.drain(..) {
        configured.entry(platform.platform).or_insert(platform);
    }
    if !had_platforms {
        configured.insert(
            legacy_platform,
            CcConnectPlatformProfile {
                platform: legacy_platform,
                enabled: true,
                allow_from: legacy_allow_from,
            },
        );
    }
    profile.platforms = CC_CONNECT_PLATFORMS
        .into_iter()
        .map(|platform| {
            configured
                .remove(&platform)
                .unwrap_or(CcConnectPlatformProfile {
                    platform,
                    enabled: false,
                    allow_from: String::new(),
                })
        })
        .collect();
    profile.allow_from = profile
        .platforms
        .iter()
        .find(|item| item.platform == profile.platform)
        .map(|item| item.allow_from.clone())
        .unwrap_or_default();
}

fn enabled_platforms(profile: &CcConnectProfile) -> Vec<CcConnectPlatformProfile> {
    profile_platforms(profile)
        .into_iter()
        .filter(|item| item.enabled)
        .collect()
}

fn platform_profile(
    profile: &CcConnectProfile,
    platform: CcConnectPlatform,
) -> Option<CcConnectPlatformProfile> {
    profile_platforms(profile)
        .into_iter()
        .find(|item| item.platform == platform)
}

fn set_platform_allow_from(
    profile: &mut CcConnectProfile,
    platform: CcConnectPlatform,
    allow_from: String,
) {
    hydrate_profile_platforms(profile);
    if let Some(item) = profile
        .platforms
        .iter_mut()
        .find(|item| item.platform == platform)
    {
        item.allow_from = allow_from.clone();
    }
    if profile.platform == platform {
        profile.allow_from = allow_from;
    }
}

fn normalize_profile(
    manager: &CcConnectManager,
    mut profile: CcConnectProfile,
) -> Result<CcConnectProfile, String> {
    hydrate_profile_platforms(&mut profile);
    if profile.max_turn_time_mins > MAX_TURN_TIME_MINS {
        return Err(format!(
            "max_turn_time_mins must be between 0 and {MAX_TURN_TIME_MINS}"
        ));
    }
    apply_control_profile(&mut profile)?;
    profile.cc_switch_db_path = profile
        .cc_switch_db_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    profile.codex_config_dir = profile
        .codex_config_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| {
            if !path.is_absolute() {
                return Err("codex_config_dir_invalid".to_string());
            }
            Ok(user_path_string(&path))
        })
        .transpose()?;
    let mut enabled_count = 0usize;
    for item in &mut profile.platforms {
        item.allow_from = item.allow_from.trim().to_string();
        if item.enabled {
            enabled_count += 1;
            item.allow_from = normalize_allow_from(item.platform, &item.allow_from)?;
        }
    }
    if enabled_count == 0 {
        return Err("at least one messaging platform must be enabled".to_string());
    }
    profile.allow_from = profile
        .platforms
        .iter()
        .find(|item| item.platform == profile.platform)
        .map(|item| item.allow_from.clone())
        .unwrap_or_default();
    if profile.proxy_enabled {
        profile.proxy_url = normalize_proxy_url(profile.proxy_url.as_deref())?;
    }
    profile.executable_path = normalize_executable_path_value(profile.executable_path.as_deref());
    if let Some(explicit_path) = profile.executable_path.as_deref() {
        let binary = manager.detect(Some(explicit_path), true)?;
        profile.executable_path = Some(user_path_string(&binary.path));
    }
    Ok(profile)
}

fn normalize_proxy_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let url = reqwest::Url::parse(raw).map_err(|_| "proxy URL is invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return Err("proxy URL must use http, https, socks5, or socks5h".to_string());
    }
    if url.host_str().is_none() {
        return Err("proxy URL host is required".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("proxy URL credentials are not allowed".to_string());
    }
    Ok(Some(url.to_string()))
}

fn normalize_allow_from(platform: CcConnectPlatform, raw: &str) -> Result<String, String> {
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for value in raw
        .split(|ch| matches!(ch, ',' | ';' | '\n' | '\r'))
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if value == "*" {
            return Err("allow_from wildcard is forbidden".to_string());
        }
        let valid = match platform {
            CcConnectPlatform::Telegram => value.chars().all(|ch| ch.is_ascii_digit()),
            CcConnectPlatform::Feishu => value.starts_with("ou_") && value.len() > 3,
            CcConnectPlatform::Weixin => {
                value.ends_with("@im.wechat") && value.len() > "@im.wechat".len()
            }
            CcConnectPlatform::Wecom => {
                value.len() <= 256 && !value.chars().any(char::is_whitespace)
            }
        };
        if !valid {
            return Err(match platform {
                CcConnectPlatform::Telegram => {
                    "Telegram allow_from must contain numeric user IDs".to_string()
                }
                CcConnectPlatform::Feishu => {
                    "Feishu allow_from must contain ou_ open IDs".to_string()
                }
                CcConnectPlatform::Weixin => {
                    "Weixin allow_from must contain user IDs ending in @im.wechat".to_string()
                }
                CcConnectPlatform::Wecom => {
                    "WeCom allow_from must contain explicit user IDs".to_string()
                }
            });
        }
        if seen.insert(value.to_string()) {
            values.push(value.to_string());
        }
    }
    if values.is_empty() {
        return Err("allow_from must contain at least one explicit user ID".to_string());
    }
    Ok(values.join(","))
}

fn profile_issue_codes(profile: &CcConnectProfile) -> Vec<String> {
    let mut issues = Vec::new();
    let enabled = enabled_platforms(profile);
    if enabled.is_empty() {
        issues.push("platform_missing".to_string());
    } else if enabled
        .iter()
        .any(|item| normalize_allow_from(item.platform, &item.allow_from).is_err())
    {
        issues.push("allowlist_invalid".to_string());
    }
    if profile.proxy_enabled && normalize_proxy_url(profile.proxy_url.as_deref()).is_err() {
        issues.push("proxy_invalid".to_string());
    }
    issues
}

fn user_home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("HOME").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

fn default_agent_command(agent: CcConnectAgent) -> &'static str {
    match agent {
        CcConnectAgent::Claude => "claude",
        CcConnectAgent::Codex => "codex",
        CcConnectAgent::Pi => "pi",
        CcConnectAgent::Opencode => "opencode",
    }
}

fn directory_matches(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn resolve_program_from_path(
    program: &str,
    path_value: &std::ffi::OsStr,
    skip_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    for directory in env::split_paths(path_value) {
        if skip_dir.is_some_and(|wrapper| directory_matches(&directory, wrapper)) {
            continue;
        }
        #[cfg(target_os = "windows")]
        let candidates = if Path::new(program).extension().is_some() {
            vec![program.to_string()]
        } else {
            vec![
                format!("{program}.exe"),
                format!("{program}.cmd"),
                format!("{program}.bat"),
                format!("{program}.com"),
                format!("{program}.ps1"),
            ]
        };
        #[cfg(not(target_os = "windows"))]
        let candidates = vec![program.to_string()];
        for candidate in candidates {
            let candidate = directory.join(candidate);
            #[cfg(not(target_os = "windows"))]
            {
                use std::os::unix::fs::PermissionsExt;
                let Ok(metadata) = candidate.metadata() else {
                    continue;
                };
                if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            #[cfg(target_os = "windows")]
            if !candidate.is_file() {
                continue;
            }
            if let Ok(canonical) = candidate.canonicalize() {
                return Ok(canonical);
            }
        }
    }
    Err("handoff_agent_unavailable".to_string())
}

#[cfg(unix)]
fn resolve_codex_launcher_from_path(
    wrapper_dir: &Path,
    path_value: impl AsRef<std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    resolve_program_from_path("codex", path_value.as_ref(), Some(wrapper_dir))
}

fn resolve_local_agent_program(program: &str, work_dir: &Path) -> Result<PathBuf, String> {
    let configured = Path::new(program);
    if configured.is_absolute() || program.contains(['/', '\\']) {
        let candidate = if configured.is_absolute() {
            configured.to_path_buf()
        } else {
            work_dir.join(configured)
        };
        let candidate = candidate
            .canonicalize()
            .map_err(|_| "handoff_agent_unavailable".to_string())?;
        return candidate
            .is_file()
            .then_some(candidate)
            .ok_or_else(|| "handoff_agent_unavailable".to_string());
    }

    let path_value = env::var_os("PATH").ok_or_else(|| "handoff_agent_unavailable".to_string())?;
    let skip_wrapper = (program == "codex" || program.eq_ignore_ascii_case("codex.exe"))
        .then(|| remote_manager_dir().ok().map(|dir| dir.join("bin")))
        .flatten();
    resolve_program_from_path(program, &path_value, skip_wrapper.as_deref())
}

fn has_handoff_session_argument(agent: CcConnectAgent, argument: &str) -> bool {
    let option = argument
        .split_once('=')
        .map(|(name, _)| name)
        .unwrap_or(argument)
        .to_ascii_lowercase();
    let common = matches!(
        option.as_str(),
        "--resume" | "--continue" | "--last" | "--session" | "--session-id" | "--fork" | "-r"
    );
    common
        || matches!(agent, CcConnectAgent::Codex) && option == "resume"
        || matches!(agent, CcConnectAgent::Claude) && option == "-c"
}

fn validate_registered_launcher_arguments(
    agent: CcConnectAgent,
    args: &[String],
) -> Result<(), String> {
    if args
        .iter()
        .any(|argument| has_handoff_session_argument(agent, argument))
    {
        return Err("handoff_agent_launcher_session_arg".to_string());
    }
    let has_provider_override = args.iter().any(|argument| {
        let option = argument
            .split_once('=')
            .map(|(name, _)| name)
            .unwrap_or(argument)
            .to_ascii_lowercase();
        matches!(
            (agent, option.as_str()),
            (CcConnectAgent::Claude, "--settings") | (CcConnectAgent::Codex, "--profile" | "-p")
        )
    });
    if has_provider_override {
        return Err("handoff_agent_launcher_provider_arg".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn validate_windows_script_launcher(executable: &Path, args: &[String]) -> Result<(), String> {
    let is_script = executable
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd")
                || extension.eq_ignore_ascii_case("bat")
                || extension.eq_ignore_ascii_case("ps1")
        });
    let executable = executable.to_string_lossy();
    if is_script
        && std::iter::once(executable.as_ref())
            .chain(args.iter().map(String::as_str))
            .any(|value| value.contains(['&', '|', '<', '>', '^', '%', '!']))
    {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    Ok(())
}

fn ensure_local_agent_available(
    project: &RegisteredProject,
) -> Result<ResolvedAgentLauncher, String> {
    let mut command = if project.cli_tool.trim().is_empty() {
        vec![default_agent_command(project.agent).to_string()]
    } else {
        parse_registered_command(&project.cli_tool)?
    };
    let program = command.remove(0);
    if agent_from_launcher_program(&program) != Some(project.agent) {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    if !project.cli_args.trim().is_empty() {
        command.extend(parse_registered_command(&project.cli_args)?);
    }
    if command.len() > MAX_REGISTERED_LAUNCHER_ARGS {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    validate_registered_launcher_arguments(project.agent, &command)?;
    let executable = resolve_local_agent_program(&program, Path::new(&project.path))?;
    #[cfg(target_os = "windows")]
    validate_windows_script_launcher(&executable, &command)?;
    Ok(ResolvedAgentLauncher {
        executable,
        args: command,
    })
}

fn managed_agent_command(launcher: &ResolvedAgentLauncher) -> Vec<String> {
    let executable = config_path_value(&launcher.executable);
    #[cfg(target_os = "windows")]
    if launcher
        .executable
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ps1"))
    {
        let mut command = vec![
            "powershell.exe".to_string(),
            "-NoProfile".to_string(),
            "-File".to_string(),
            executable,
        ];
        command.extend(launcher.args.clone());
        return command;
    }
    let mut command = vec![executable];
    command.extend(launcher.args.clone());
    command
}

fn managed_project_environment(
    project: &RegisteredProject,
) -> (BTreeMap<String, String>, Vec<(String, String)>) {
    if !matches!(project.agent, CcConnectAgent::Pi | CcConnectAgent::Opencode) {
        return (BTreeMap::new(), Vec::new());
    }
    let Ok(serde_json::Value::Object(values)) = serde_json::from_str(&project.env_vars) else {
        return (BTreeMap::new(), Vec::new());
    };
    let reserved = [
        TELEGRAM_TOKEN_ENV,
        FEISHU_APP_ID_ENV,
        FEISHU_APP_SECRET_ENV,
        WEIXIN_TOKEN_ENV,
        WECOM_BOT_ID_ENV,
        WECOM_BOT_SECRET_ENV,
    ];
    let mut config = BTreeMap::new();
    let mut process = Vec::new();
    for (key, value) in values.into_iter().take(128) {
        let Some(value) = value.as_str() else {
            continue;
        };
        let valid_key = key.len() <= 128
            && key
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let upper = key.to_ascii_uppercase();
        if !valid_key
            || value.len() > 32 * 1024
            || value.contains('\0')
            || upper.starts_with("CLI_MANAGER_")
            || upper.starts_with("CC_CONNECT_")
            || reserved.contains(&upper.as_str())
            || PROXY_ENV_KEYS
                .iter()
                .any(|reserved_key| reserved_key.eq_ignore_ascii_case(&key))
        {
            continue;
        }
        config.insert(key.clone(), format!("${{{key}}}"));
        process.push((key, value.to_string()));
    }
    (config, process)
}

struct RemoteCodexProviderLaunch {
    name: String,
    profile_name: String,
    model_provider: String,
    provider_name_override: String,
    model: Option<String>,
    models: Vec<String>,
    base_url_override: String,
    env_key_override: String,
    model_override: Option<String>,
    wire_api_override: String,
    env_key: String,
    secret: String,
}

struct RemoteCodexLaunch {
    wrapper_dir: PathBuf,
    launcher: Option<PathBuf>,
    launcher_args: Vec<String>,
    proxy_executable: PathBuf,
    expected_session_id: Option<String>,
    codex_home: Option<PathBuf>,
    discovery_codex_home: Option<PathBuf>,
    provider: Option<RemoteCodexProviderLaunch>,
    ssh_launch: Option<SshCodexLaunch>,
}

fn codex_config_dir(profile: &CcConnectProfile) -> Result<PathBuf, String> {
    profile
        .codex_config_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| user_home_dir().map(|home| home.join(".codex")))
        .ok_or_else(|| "home_dir_unavailable".to_string())
}

#[cfg(not(target_os = "windows"))]
fn codex_profile_wrapper_payload() -> String {
    format!(
        "#!/bin/sh\nif [ -n \"${{{CODEX_SSH_LAUNCH_ENV}:-}}\" ]; then\n  exec \"${PROXY_EXECUTABLE_ENV}\" {CODEX_PROXY_SUBCOMMAND} \"$@\"\nfi\nif [ \"${{1:-}}\" = \"app-server\" ]; then\n  exec \"${PROXY_EXECUTABLE_ENV}\" {CODEX_PROXY_SUBCOMMAND} \"$@\"\nfi\nif [ -n \"${{{CODEX_LAUNCHER_ARGS_ENV}:-}}\" ] && [ \"${CODEX_LAUNCHER_ARGS_ENV}\" != \"[]\" ]; then\n  exec \"${PROXY_EXECUTABLE_ENV}\" {CODEX_PROXY_SUBCOMMAND} \"$@\"\nfi\nif [ -z \"${{{CODEX_BASE_URL_OVERRIDE_ENV}:-}}\" ]; then\n  exec \"${CODEX_LAUNCHER_ENV}\" \"$@\"\nfi\nif [ -n \"${{{CODEX_MODEL_OVERRIDE_ENV}:-}}\" ]; then\n  exec \"${CODEX_LAUNCHER_ENV}\" --profile \"${CODEX_PROFILE_NAME_ENV}\" -c \"${CODEX_BASE_URL_OVERRIDE_ENV}\" -c \"${CODEX_ENV_KEY_OVERRIDE_ENV}\" -c \"${CODEX_WIRE_API_OVERRIDE_ENV}\" -c \"${CODEX_MODEL_CATALOG_OVERRIDE_ENV}\" -c \"${CODEX_MODEL_OVERRIDE_ENV}\" \"$@\"\nelse\n  exec \"${CODEX_LAUNCHER_ENV}\" --profile \"${CODEX_PROFILE_NAME_ENV}\" -c \"${CODEX_BASE_URL_OVERRIDE_ENV}\" -c \"${CODEX_ENV_KEY_OVERRIDE_ENV}\" -c \"${CODEX_WIRE_API_OVERRIDE_ENV}\" -c \"${CODEX_MODEL_CATALOG_OVERRIDE_ENV}\" \"$@\"\nfi\n"
    )
}

fn codex_wrapper_override(key: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Codex {key} is empty"));
    }
    if value
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '"' | '%' | '!' | '^' | '&' | '|' | '<' | '>'))
    {
        return Err(format!(
            "Codex {key} contains unsupported command characters"
        ));
    }
    Ok(format!("{key}={value}"))
}

fn codex_provider_override_key(model_provider: &str, field: &str) -> Result<String, String> {
    let model_provider = model_provider.trim();
    if model_provider.is_empty() || model_provider.chars().any(char::is_control) {
        return Err("Codex model Provider ID is invalid".to_string());
    }
    let segment = if model_provider
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        model_provider.to_string()
    } else {
        serde_json::to_string(model_provider)
            .map_err(|err| format!("encode Codex model Provider ID failed: {err}"))?
    };
    Ok(format!("model_providers.{segment}.{field}"))
}

fn codex_base_url_override(model_provider: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    let url =
        reqwest::Url::parse(value).map_err(|_| "Codex Provider base URL is invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Codex Provider base URL must use HTTP or HTTPS".to_string());
    }
    codex_wrapper_override(
        &codex_provider_override_key(model_provider, "base_url")?,
        value,
    )
}

fn codex_env_key_override(model_provider: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    let mut chars = value.chars();
    if !chars
        .next()
        .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
        || !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
    {
        return Err("Codex Provider environment key is invalid".to_string());
    }
    codex_wrapper_override(
        &codex_provider_override_key(model_provider, "env_key")?,
        value,
    )
}

fn codex_wire_api_override(model_provider: &str, value: Option<&str>) -> Result<String, String> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("responses");
    codex_wrapper_override(
        &codex_provider_override_key(model_provider, "wire_api")?,
        value,
    )
}

fn codex_model_override(value: Option<&str>) -> Result<Option<String>, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| codex_wrapper_override("model", value))
        .transpose()
}

fn codex_model_catalog_override(directory: &Path) -> Result<String, String> {
    let catalog_path = directory.join(CODEX_MODEL_CATALOG_FILE_NAME);
    let encoded_path = serde_json::to_string(&path_string(&catalog_path))
        .map_err(|err| format!("encode Codex model catalog path failed: {err}"))?;
    Ok(format!("model_catalog_json={encoded_path}"))
}

fn codex_models_endpoint(base_url: &str) -> Result<reqwest::Url, String> {
    let normalized = format!("{}/", base_url.trim().trim_end_matches('/'));
    let base_url = reqwest::Url::parse(&normalized)
        .map_err(|_| "Codex Provider models URL is invalid".to_string())?;
    if !matches!(base_url.scheme(), "http" | "https") || base_url.host_str().is_none() {
        return Err("Codex Provider models URL must use HTTP or HTTPS".to_string());
    }
    base_url
        .join("models")
        .map_err(|_| "Codex Provider models URL is invalid".to_string())
}

fn normalize_managed_codex_models(
    current_model: Option<&str>,
    discovered_models: impl IntoIterator<Item = String>,
) -> Vec<String> {
    const NON_CHAT_MARKERS: [&str; 12] = [
        "embedding",
        "whisper",
        "tts",
        "moderation",
        "dall-e",
        "realtime",
        "transcribe",
        "search-preview",
        "image",
        "audio-preview",
        "rerank",
        "speech",
    ];
    let current_model = current_model
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    if let Some(model) = current_model {
        seen.insert(model.to_string());
        models.push(model.to_string());
    }
    let mut discovered = discovered_models
        .into_iter()
        .map(|model| model.trim().to_string())
        .filter(|model| {
            !model.is_empty()
                && model.len() <= 256
                && !model.chars().any(|character| character.is_control())
                && !NON_CHAT_MARKERS
                    .iter()
                    .any(|marker| model.to_ascii_lowercase().contains(marker))
        })
        .collect::<Vec<_>>();
    discovered.sort_by(|left, right| {
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(right))
    });
    for model in discovered {
        if seen.insert(model.clone()) {
            models.push(model);
            if models.len() == MAX_MANAGED_CODEX_MODELS {
                break;
            }
        }
    }
    models
}

fn fallback_codex_model_catalog_entry() -> serde_json::Value {
    serde_json::json!({
        "slug": "",
        "display_name": "",
        "description": "",
        "default_reasoning_level": "medium",
        "supported_reasoning_levels": [
            { "effort": "low", "description": "Fast responses with lighter reasoning" },
            { "effort": "medium", "description": "Balances speed and reasoning depth" },
            { "effort": "high", "description": "Greater reasoning depth for complex tasks" },
            { "effort": "xhigh", "description": "Extra reasoning depth for complex tasks" }
        ],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 0,
        "availability_nux": null,
        "upgrade": null,
        "base_instructions": "You are Codex, a coding agent. Follow the user's instructions and work carefully in the provided workspace.",
        "supports_reasoning_summaries": true,
        "default_reasoning_summary": "auto",
        "support_verbosity": false,
        "default_verbosity": null,
        "apply_patch_tool_type": "freeform",
        "truncation_policy": { "mode": "tokens", "limit": 10000 },
        "supports_parallel_tool_calls": true,
        "supports_image_detail_original": true,
        "context_window": 272000,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": ["text", "image"],
        "prefer_websockets": false
    })
}

fn is_usable_codex_model_catalog_entry(entry: &serde_json::Map<String, serde_json::Value>) -> bool {
    [
        "slug",
        "display_name",
        "description",
        "default_reasoning_level",
        "shell_type",
        "visibility",
        "base_instructions",
    ]
    .iter()
    .all(|key| entry.get(*key).is_some_and(serde_json::Value::is_string))
        && entry
            .get("supported_reasoning_levels")
            .is_some_and(serde_json::Value::is_array)
        && entry
            .get("supported_in_api")
            .is_some_and(serde_json::Value::is_boolean)
        && entry
            .get("priority")
            .is_some_and(serde_json::Value::is_number)
        && entry
            .get("input_modalities")
            .is_some_and(serde_json::Value::is_array)
}

fn load_codex_model_catalog_templates(
    codex_home: Option<&Path>,
) -> Vec<serde_json::Map<String, serde_json::Value>> {
    let Some(cache_path) = codex_home.map(|home| home.join(CODEX_MODELS_CACHE_FILE_NAME)) else {
        return Vec::new();
    };
    let Ok(metadata) = fs::metadata(&cache_path) else {
        return Vec::new();
    };
    if !metadata.is_file() || metadata.len() > MAX_CODEX_MODEL_CACHE_BYTES {
        return Vec::new();
    }
    let Ok(payload) = fs::read(cache_path) else {
        return Vec::new();
    };
    let Ok(catalog) = serde_json::from_slice::<serde_json::Value>(&payload) else {
        return Vec::new();
    };
    catalog
        .get("models")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_object)
        .filter(|entry| is_usable_codex_model_catalog_entry(entry))
        .cloned()
        .collect()
}

fn build_codex_model_catalog(
    codex_home: Option<&Path>,
    provider: &RemoteCodexProviderLaunch,
) -> CodexModelCatalog {
    let templates = load_codex_model_catalog_templates(codex_home);
    let preferred_template = provider
        .model
        .as_deref()
        .and_then(|model| {
            templates
                .iter()
                .find(|entry| entry.get("slug").and_then(serde_json::Value::as_str) == Some(model))
        })
        .or_else(|| templates.first());
    let models = provider
        .models
        .iter()
        .enumerate()
        .map(|(priority, model)| {
            let template = templates
                .iter()
                .find(|entry| {
                    entry.get("slug").and_then(serde_json::Value::as_str) == Some(model.as_str())
                })
                .or(preferred_template);
            let mut entry = template
                .cloned()
                .map(serde_json::Value::Object)
                .unwrap_or_else(fallback_codex_model_catalog_entry);
            let object = entry
                .as_object_mut()
                .expect("Codex model catalog template must be an object");
            object.insert("slug".to_string(), model.clone().into());
            object.insert("display_name".to_string(), model.clone().into());
            object.insert("description".to_string(), provider.name.clone().into());
            object.insert("visibility".to_string(), "list".into());
            object.insert("supported_in_api".to_string(), true.into());
            object.insert("priority".to_string(), (priority as u64).into());
            object.insert("availability_nux".to_string(), serde_json::Value::Null);
            object.insert("upgrade".to_string(), serde_json::Value::Null);
            entry
        })
        .collect();
    CodexModelCatalog { models }
}

fn write_codex_model_discovery_home(
    directory: &Path,
    codex_home: Option<&Path>,
    provider: &RemoteCodexProviderLaunch,
) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|err| format!("create Codex model discovery directory failed: {err}"))?;
    let config = toml::to_string_pretty(&CodexModelDiscoveryConfig {
        model_catalog_json: CODEX_MODEL_CATALOG_FILE_NAME,
    })
    .map_err(|err| format!("serialize Codex model discovery config failed: {err}"))?;
    let catalog = build_codex_model_catalog(codex_home, provider);
    let mut catalog = serde_json::to_vec_pretty(&catalog)
        .map_err(|err| format!("serialize Codex model discovery catalog failed: {err}"))?;
    catalog.push(b'\n');
    write_file_atomically(
        &directory.join(CODEX_MODEL_CATALOG_FILE_NAME),
        &catalog,
        "Codex model discovery catalog",
    )?;
    write_file_atomically(
        &directory.join(CONFIG_FILE_NAME),
        config.as_bytes(),
        "Codex model discovery config",
    )
}

fn parse_codex_models_response(payload: &[u8]) -> Vec<String> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Vec::new();
    };
    let Some(items) = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            item.as_str().map(str::to_string).or_else(|| {
                ["id", "model", "name"]
                    .into_iter()
                    .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
                    .map(str::to_string)
            })
        })
        .collect()
}

async fn discover_codex_provider_models(
    base_url: &str,
    secret: &str,
    proxy_enabled: bool,
    proxy: Option<&ResolvedProxy>,
) -> Result<Vec<String>, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(CODEX_MODEL_DISCOVERY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if !proxy_enabled {
        builder = builder.no_proxy();
    } else if let Some(proxy) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(&proxy.url)
                .map_err(|err| format!("configure Codex model proxy failed: {err}"))?,
        );
    }
    let client = builder
        .build()
        .map_err(|err| format!("build Codex model client failed: {err}"))?;
    let mut response = client
        .get(codex_models_endpoint(base_url)?)
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|err| format!("query Codex Provider models failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "query Codex Provider models returned HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CODEX_MODEL_RESPONSE_BYTES as u64)
    {
        return Err("Codex Provider models response is too large".to_string());
    }
    let mut payload = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("read Codex Provider models failed: {err}"))?
    {
        if payload.len().saturating_add(chunk.len()) > MAX_CODEX_MODEL_RESPONSE_BYTES {
            return Err("Codex Provider models response is too large".to_string());
        }
        payload.extend_from_slice(&chunk);
    }
    Ok(parse_codex_models_response(&payload))
}

#[cfg(target_os = "windows")]
fn write_codex_profile_wrapper() -> Result<PathBuf, String> {
    // cc-connect v1.4.1 hardcodes `codex` for its app-server backend. A native
    // GUI-subsystem shim is required here because a batch shim allocates a console.
    let wrapper_dir = remote_manager_dir()?.join("bin");
    fs::create_dir_all(&wrapper_dir)
        .map_err(|err| format!("create Codex wrapper directory failed: {err}"))?;
    let source = env::current_exe()
        .map_err(|err| format!("resolve CLI-Manager executable failed: {err}"))?
        .with_file_name("cli-manager-codex-proxy.exe");
    if !source.is_file() {
        return Err(format!(
            "bundled Codex app-server proxy is missing: {}",
            path_string(&source)
        ));
    }
    let wrapper_path = wrapper_dir.join("codex.exe");
    copy_file_atomically_if_changed(&source, &wrapper_path, "Codex app-server proxy")?;
    Ok(wrapper_path)
}

#[cfg(not(target_os = "windows"))]
fn write_codex_profile_wrapper() -> Result<PathBuf, String> {
    let wrapper_dir = remote_manager_dir()?.join("bin");
    fs::create_dir_all(&wrapper_dir)
        .map_err(|err| format!("create Codex wrapper directory failed: {err}"))?;
    let wrapper_path = wrapper_dir.join("codex");
    let payload = codex_profile_wrapper_payload();
    write_executable_file_atomically_if_changed(
        &wrapper_path,
        payload.as_bytes(),
        "Codex profile wrapper",
    )?;
    Ok(wrapper_path)
}

fn prepare_remote_codex_launch(
    profile: &CcConnectProfile,
    project: &RegisteredProject,
    local_launcher: Option<&ResolvedAgentLauncher>,
) -> Result<Option<RemoteCodexLaunch>, String> {
    if profile.agent != CcConnectAgent::Codex {
        return Ok(None);
    }
    let ssh_launch = (project.environment_type == "ssh")
        .then(|| load_ssh_codex_launch(project))
        .transpose()?;
    let codex_home = ssh_launch
        .is_none()
        .then(|| codex_config_dir(profile))
        .transpose()?;
    let provider = match (ssh_launch.is_none(), project.codex_provider_id.as_deref()) {
        (true, Some(provider_id)) => {
            let query_runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|err| format!("create provider query runtime failed: {err}"))?;
            let runtime = query_runtime.block_on(
                crate::provider::runtime::load_codex_runtime_config(provider_id),
            )?;
            crate::provider::runtime::write_codex_profile_to_dir(
                codex_home.as_deref().ok_or_else(|| {
                    "Codex home is unavailable for the registered Provider".to_string()
                })?,
                &runtime.profile,
            )?;
            let proxy = resolve_proxy_url_if_enabled(
                profile.proxy_enabled,
                profile.proxy_url.as_deref(),
                &LOCAL_PROXY_PORTS,
            )?;
            let discovered_models = query_runtime
                .block_on(discover_codex_provider_models(
                    &runtime.base_url,
                    &runtime.secret_value,
                    profile.proxy_enabled,
                    proxy.as_ref(),
                ))
                .unwrap_or_default();
            let model = runtime
                .model
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let profile_name = runtime.profile.profile_name.clone();
            let model_provider = runtime.profile.model_provider.clone();
            Some(RemoteCodexProviderLaunch {
                name: project
                    .provider_name
                    .as_deref()
                    .map(single_line)
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| provider_id.to_string()),
                profile_name,
                model_provider: model_provider.clone(),
                provider_name_override: codex_wrapper_override(
                    &codex_provider_override_key(&model_provider, "name")?,
                    "CLI-Manager remote",
                )?,
                models: normalize_managed_codex_models(model.as_deref(), discovered_models),
                model: model.clone(),
                base_url_override: codex_base_url_override(&model_provider, &runtime.base_url)?,
                env_key_override: codex_env_key_override(&model_provider, &runtime.env_key)?,
                model_override: codex_model_override(model.as_deref())?,
                wire_api_override: codex_wire_api_override(
                    &model_provider,
                    runtime.wire_api.as_deref(),
                )?,
                env_key: runtime.env_key,
                secret: runtime.secret_value,
            })
        }
        _ => None,
    };
    let discovery_codex_home = match provider.as_ref() {
        Some(provider) => {
            let path = remote_manager_dir()?.join("codex-model-discovery");
            write_codex_model_discovery_home(&path, codex_home.as_deref(), provider)?;
            Some(path)
        }
        None => None,
    };
    let wrapper_path = write_codex_profile_wrapper()?;
    let wrapper_dir = wrapper_path
        .parent()
        .ok_or_else(|| "Codex wrapper directory is missing".to_string())?
        .to_path_buf();
    let (launcher, launcher_args) = if ssh_launch.is_some() {
        (None, Vec::new())
    } else {
        let launcher = local_launcher.ok_or_else(|| "handoff_agent_unavailable".to_string())?;
        (Some(launcher.executable.clone()), launcher.args.clone())
    };
    let proxy_executable = env::current_exe()
        .map_err(|err| format!("resolve Codex app-server proxy failed: {err}"))?;
    let expected_session_id =
        handoff_session::load_handoff_record()?.map(|record| record.cli_session_id);
    Ok(Some(RemoteCodexLaunch {
        wrapper_dir,
        launcher,
        launcher_args,
        proxy_executable,
        expected_session_id,
        codex_home,
        discovery_codex_home,
        provider,
        ssh_launch,
    }))
}

fn apply_remote_codex_launch_environment(
    command: &mut Command,
    launch: &RemoteCodexLaunch,
) -> Result<(), String> {
    let mut paths = vec![launch.wrapper_dir.clone()];
    if let Some(path_value) = env::var_os("PATH") {
        paths.extend(env::split_paths(&path_value));
    }
    let path_value =
        env::join_paths(paths).map_err(|err| format!("build Codex wrapper PATH failed: {err}"))?;
    command
        .env("PATH", path_value)
        .env(PROXY_EXECUTABLE_ENV, &launch.proxy_executable);
    match launch.launcher.as_ref() {
        Some(launcher) => {
            command.env(CODEX_LAUNCHER_ENV, launcher);
            if launch.launcher_args.is_empty() {
                command.env_remove(CODEX_LAUNCHER_ARGS_ENV);
            } else {
                command.env(
                    CODEX_LAUNCHER_ARGS_ENV,
                    serde_json::to_string(&launch.launcher_args)
                        .map_err(|err| format!("encode Codex launcher arguments failed: {err}"))?,
                );
            }
        }
        None => {
            command.env_remove(CODEX_LAUNCHER_ENV);
            command.env_remove(CODEX_LAUNCHER_ARGS_ENV);
        }
    }
    // The generated catalog directory is not a Codex home: redirecting CODEX_HOME
    // there hides the rollout database needed by thread/resume.
    match launch.codex_home.as_ref() {
        Some(codex_home) => {
            command.env("CODEX_HOME", codex_home);
        }
        None => {
            command.env_remove("CODEX_HOME");
        }
    }
    match launch.ssh_launch.as_ref() {
        Some(ssh_launch) => {
            command.env(CODEX_SSH_LAUNCH_ENV, ssh_launch.encode()?);
        }
        None => {
            command.env_remove(CODEX_SSH_LAUNCH_ENV);
        }
    }
    match launch.expected_session_id.as_ref() {
        Some(session_id) => {
            command.env(EXPECTED_SESSION_ID_ENV, session_id);
        }
        None => {
            command.env_remove(EXPECTED_SESSION_ID_ENV);
        }
    }
    match launch.provider.as_ref() {
        Some(provider) => {
            let model_catalog_override = launch
                .discovery_codex_home
                .as_deref()
                .ok_or_else(|| "Codex model discovery directory is missing".to_string())
                .and_then(codex_model_catalog_override)?;
            command
                .env(CODEX_PROFILE_NAME_ENV, &provider.profile_name)
                .env(CODEX_MODEL_PROVIDER_ENV, &provider.model_provider)
                .env(
                    CODEX_PROVIDER_NAME_OVERRIDE_ENV,
                    &provider.provider_name_override,
                )
                .env(CODEX_BASE_URL_OVERRIDE_ENV, &provider.base_url_override)
                .env(CODEX_ENV_KEY_OVERRIDE_ENV, &provider.env_key_override)
                .env(CODEX_MODEL_CATALOG_OVERRIDE_ENV, model_catalog_override)
                .env(CODEX_WIRE_API_OVERRIDE_ENV, &provider.wire_api_override);
            match provider.model_override.as_ref() {
                Some(model_override) => {
                    command.env(CODEX_MODEL_OVERRIDE_ENV, model_override);
                }
                None => {
                    command.env_remove(CODEX_MODEL_OVERRIDE_ENV);
                }
            }
        }
        None => {
            command
                .env_remove(CODEX_PROFILE_NAME_ENV)
                .env_remove(CODEX_MODEL_PROVIDER_ENV)
                .env_remove(CODEX_PROVIDER_NAME_OVERRIDE_ENV)
                .env_remove(CODEX_BASE_URL_OVERRIDE_ENV)
                .env_remove(CODEX_ENV_KEY_OVERRIDE_ENV)
                .env_remove(CODEX_MODEL_CATALOG_OVERRIDE_ENV)
                .env_remove(CODEX_MODEL_OVERRIDE_ENV)
                .env_remove(CODEX_WIRE_API_OVERRIDE_ENV);
        }
    }
    Ok(())
}

fn codex_app_server_probe_args(strict_config: bool) -> Vec<&'static str> {
    let mut args = vec!["app-server"];
    if strict_config {
        args.push("--strict-config");
    }
    args.extend(["--listen", "stdio://"]);
    args
}

fn probe_remote_codex_app_server(launch: &RemoteCodexLaunch) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = silent_command(&path_string(&launch.wrapper_dir.join("codex.exe")));
    #[cfg(not(target_os = "windows"))]
    let mut command = silent_command(&path_string(&launch.wrapper_dir.join("codex")));
    command.args(codex_app_server_probe_args(
        launch.discovery_codex_home.is_some(),
    ));
    if let Some(provider) = launch.provider.as_ref() {
        command.env(&provider.env_key, &provider.secret);
    }
    apply_remote_codex_launch_environment(&mut command, launch)?;
    if let Some(discovery_home) = launch.discovery_codex_home.as_ref() {
        // Strict validation remains isolated from the user's config. The managed
        // cc-connect process itself keeps the registered CODEX_HOME.
        command.env("CODEX_HOME", discovery_home);
    }
    let probe_timeout = launch
        .ssh_launch
        .as_ref()
        .map(|ssh| Duration::from_secs(ssh.transport.connect_timeout_sec.saturating_add(10)))
        .unwrap_or(CODEX_APP_SERVER_PROBE_TIMEOUT);
    let output = output_with_timeout(command, probe_timeout)
        .map_err(|err| format!("Codex app-server proxy probe failed: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = redact_remote_codex_probe_output(launch, &output.stdout, &output.stderr);
    Err(format!(
        "Codex app-server proxy probe exited with {}: {}",
        output.status,
        if detail.is_empty() {
            "no diagnostic output"
        } else {
            &detail
        }
    ))
}

fn redact_remote_codex_probe_output(
    launch: &RemoteCodexLaunch,
    stdout: &[u8],
    stderr: &[u8],
) -> String {
    let secrets = launch
        .provider
        .as_ref()
        .map(|provider| vec![provider.secret.clone()])
        .unwrap_or_default();
    redact_log_line(&output_text(stdout, stderr), &secrets)
}

async fn load_provider_catalog() -> ProviderCatalog {
    let Ok(mut connection) = crate::provider::open_connection().await else {
        return ProviderCatalog::default();
    };
    let rows = sqlx::query(
        "SELECT id, app_type, name, is_current FROM providers \
         WHERE app_type IN ('claude', 'codex') \
         ORDER BY app_type ASC, sort_index ASC, name COLLATE NOCASE ASC",
    )
    .fetch_all(&mut connection)
    .await;
    let _ = connection.close().await;
    let Ok(rows) = rows else {
        return ProviderCatalog::default();
    };

    let mut catalog = ProviderCatalog::default();
    for row in rows {
        let (Ok(id), Ok(app_type), Ok(name), Ok(is_current)) = (
            row.try_get::<String, _>("id"),
            row.try_get::<String, _>("app_type"),
            row.try_get::<String, _>("name"),
            row.try_get::<bool, _>("is_current"),
        ) else {
            continue;
        };
        let app_type = app_type.trim().to_ascii_lowercase();
        let name = single_line(&name);
        if app_type.is_empty() || id.trim().is_empty() || name.is_empty() {
            continue;
        }
        catalog
            .names_by_app_and_id
            .insert((app_type.clone(), id.trim().to_string()), name.clone());
        if is_current {
            catalog
                .current_by_app
                .entry(app_type)
                .or_insert(ProviderCatalogEntry {
                    id: id.trim().to_string(),
                    name,
                });
        }
    }
    catalog
}

fn project_provider(
    agent: CcConnectAgent,
    provider_overrides: &str,
    catalog: &ProviderCatalog,
) -> (Option<String>, Option<String>, bool) {
    let app_type = match agent {
        CcConnectAgent::Claude => "claude",
        CcConnectAgent::Codex => "codex",
        CcConnectAgent::Pi | CcConnectAgent::Opencode => return (None, None, true),
    };
    let project_override = serde_json::from_str::<serde_json::Value>(provider_overrides)
        .ok()
        .and_then(|value| value.get(app_type).cloned())
        .and_then(|value| value.as_object().cloned())
        .and_then(|value| {
            let provider_id = value
                .get("providerId")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let provider_name = value
                .get("providerName")
                .and_then(serde_json::Value::as_str)
                .map(single_line)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    catalog
                        .names_by_app_and_id
                        .get(&(app_type.to_string(), provider_id.to_string()))
                        .cloned()
                })
                .unwrap_or_else(|| provider_id.to_string());
            Some((provider_id.to_string(), provider_name))
        });
    if let Some((provider_id, provider_name)) = project_override {
        return (Some(provider_id), Some(provider_name), false);
    }
    match catalog.current_by_app.get(app_type) {
        Some(provider) => (Some(provider.id.clone()), Some(provider.name.clone()), true),
        None => (None, None, true),
    }
}

fn compare_display_names(left: &str, right: &str) -> std::cmp::Ordering {
    let left_ascii = left.chars().all(|character| character.is_ascii());
    let right_ascii = right.chars().all(|character| character.is_ascii());
    left_ascii
        .cmp(&right_ascii)
        .then_with(|| left.to_lowercase().cmp(&right.to_lowercase()))
}

fn compare_registered_groups(
    left: &RegisteredGroup,
    right: &RegisteredGroup,
) -> std::cmp::Ordering {
    left.sort_order
        .cmp(&right.sort_order)
        .then_with(|| compare_display_names(&left.name, &right.name))
        .then_with(|| left.id.cmp(&right.id))
}

fn compare_registered_project_rows(
    left: &RegisteredProjectRow,
    right: &RegisteredProjectRow,
) -> std::cmp::Ordering {
    left.sort_order
        .cmp(&right.sort_order)
        .then_with(|| compare_display_names(&left.name, &right.name))
        .then_with(|| left.id.cmp(&right.id))
}

fn registered_project_from_row(
    row: &RegisteredProjectRow,
    group_path: &[RegisteredGroupSegment],
    catalog: &ProviderCatalog,
) -> RegisteredProject {
    let remote = row.environment_type == "ssh";
    let (provider_id, provider_name, provider_is_global) = if remote {
        (None, None, true)
    } else {
        project_provider(row.agent, &row.provider_overrides, catalog)
    };
    let codex_provider_id = if remote {
        None
    } else if row.agent == CcConnectAgent::Codex {
        provider_id.clone()
    } else {
        project_provider(CcConnectAgent::Codex, &row.provider_overrides, catalog).0
    };
    RegisteredProject {
        id: row.id.clone(),
        name: row.name.clone(),
        path: row.path.clone(),
        agent: row.agent,
        cli_tool: row.cli_tool.clone(),
        cli_args: row.cli_args.clone(),
        group_path: group_path.to_vec(),
        provider_id,
        codex_provider_id,
        provider_name,
        provider_is_global,
        environment_type: row.environment_type.clone(),
        ssh_host_id: row.ssh_host_id.clone(),
        remote_path: row.remote_path.clone(),
        cli_config_root: if row.cli_config_root.trim().is_empty() {
            row.host_codex_config_root.clone()
        } else {
            row.cli_config_root.clone()
        },
        env_vars: row.env_vars.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
fn append_registered_group(
    group_id: &str,
    groups_by_id: &HashMap<String, RegisteredGroup>,
    child_group_ids: &HashMap<Option<String>, Vec<String>>,
    project_indices_by_group: &HashMap<Option<String>, Vec<usize>>,
    project_rows: &[RegisteredProjectRow],
    catalog: &ProviderCatalog,
    visited_group_ids: &mut HashSet<String>,
    included_project_indices: &mut HashSet<usize>,
    group_path: &mut Vec<RegisteredGroupSegment>,
    output: &mut Vec<RegisteredProject>,
) {
    if !visited_group_ids.insert(group_id.to_string()) {
        return;
    }
    let Some(group) = groups_by_id.get(group_id) else {
        return;
    };
    group_path.push(RegisteredGroupSegment {
        id: group.id.clone(),
        name: group.name.clone(),
    });
    if let Some(children) = child_group_ids.get(&Some(group_id.to_string())) {
        for child_id in children {
            append_registered_group(
                child_id,
                groups_by_id,
                child_group_ids,
                project_indices_by_group,
                project_rows,
                catalog,
                visited_group_ids,
                included_project_indices,
                group_path,
                output,
            );
        }
    }
    if let Some(project_indices) = project_indices_by_group.get(&Some(group_id.to_string())) {
        for index in project_indices {
            if included_project_indices.insert(*index) {
                output.push(registered_project_from_row(
                    &project_rows[*index],
                    group_path,
                    catalog,
                ));
            }
        }
    }
    group_path.pop();
}

fn order_registered_projects(
    groups: Vec<RegisteredGroup>,
    project_rows: Vec<RegisteredProjectRow>,
    catalog: &ProviderCatalog,
) -> Vec<RegisteredProject> {
    let groups_by_id = groups
        .iter()
        .cloned()
        .map(|group| (group.id.clone(), group))
        .collect::<HashMap<_, _>>();
    let mut child_group_ids = HashMap::<Option<String>, Vec<String>>::new();
    for group in &groups {
        let parent_id = group
            .parent_id
            .as_ref()
            .filter(|parent_id| groups_by_id.contains_key(*parent_id))
            .cloned();
        child_group_ids
            .entry(parent_id)
            .or_default()
            .push(group.id.clone());
    }
    for child_ids in child_group_ids.values_mut() {
        child_ids.sort_by(|left, right| {
            compare_registered_groups(&groups_by_id[left], &groups_by_id[right])
        });
    }

    let mut project_indices_by_group = HashMap::<Option<String>, Vec<usize>>::new();
    for (index, project) in project_rows.iter().enumerate() {
        let group_id = project
            .group_id
            .as_ref()
            .filter(|group_id| groups_by_id.contains_key(*group_id))
            .cloned();
        project_indices_by_group
            .entry(group_id)
            .or_default()
            .push(index);
    }
    for project_indices in project_indices_by_group.values_mut() {
        project_indices.sort_by(|left, right| {
            compare_registered_project_rows(&project_rows[*left], &project_rows[*right])
        });
    }

    let mut output = Vec::with_capacity(project_rows.len());
    let mut visited_group_ids = HashSet::new();
    let mut included_project_indices = HashSet::new();
    let mut group_path = Vec::new();
    if let Some(root_group_ids) = child_group_ids.get(&None) {
        for group_id in root_group_ids {
            append_registered_group(
                group_id,
                &groups_by_id,
                &child_group_ids,
                &project_indices_by_group,
                &project_rows,
                catalog,
                &mut visited_group_ids,
                &mut included_project_indices,
                &mut group_path,
                &mut output,
            );
        }
    }

    let mut remaining_group_ids = groups
        .iter()
        .filter(|group| !visited_group_ids.contains(&group.id))
        .map(|group| group.id.clone())
        .collect::<Vec<_>>();
    remaining_group_ids.sort_by(|left, right| {
        compare_registered_groups(&groups_by_id[left], &groups_by_id[right])
    });
    for group_id in remaining_group_ids {
        append_registered_group(
            &group_id,
            &groups_by_id,
            &child_group_ids,
            &project_indices_by_group,
            &project_rows,
            catalog,
            &mut visited_group_ids,
            &mut included_project_indices,
            &mut group_path,
            &mut output,
        );
    }

    if let Some(project_indices) = project_indices_by_group.get(&None) {
        for index in project_indices {
            if included_project_indices.insert(*index) {
                output.push(registered_project_from_row(
                    &project_rows[*index],
                    &[],
                    catalog,
                ));
            }
        }
    }
    let mut remaining_project_indices = (0..project_rows.len())
        .filter(|index| !included_project_indices.contains(index))
        .collect::<Vec<_>>();
    remaining_project_indices.sort_by(|left, right| {
        compare_registered_project_rows(&project_rows[*left], &project_rows[*right])
    });
    for index in remaining_project_indices {
        output.push(registered_project_from_row(
            &project_rows[index],
            &[],
            catalog,
        ));
    }
    output
}

fn load_registered_projects(
    _profile: Option<&CcConnectProfile>,
) -> Result<Vec<RegisteredProject>, String> {
    let database_path = crate::app_paths::db_path()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("create project query runtime failed: {err}"))?;
    runtime.block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .read_only(true)
            .busy_timeout(Duration::from_secs(3));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|err| format!("open CLI-Manager project database failed: {err}"))?;
        let group_rows = sqlx::query("SELECT id, name, parent_id, sort_order FROM groups")
            .fetch_all(&mut connection)
            .await
            .map_err(|err| format!("query CLI-Manager groups failed: {err}"))?;
        let project_rows = sqlx::query(
            "SELECT p.id, p.name, p.path, p.cli_tool, p.cli_args, p.group_id, p.sort_order, \
                    p.provider_overrides, p.environment_type, p.ssh_host_id, p.remote_path, \
                    p.cli_config_root, p.env_vars, \
                    COALESCE(( \
                      SELECT pref.configured_root FROM ssh_host_tool_preferences AS pref \
                      WHERE pref.host_id = p.ssh_host_id AND pref.source = 'codex' \
                      LIMIT 1 \
                    ), '') AS host_codex_config_root \
             FROM projects AS p",
        )
        .fetch_all(&mut connection)
        .await
        .map_err(|err| format!("query CLI-Manager projects failed: {err}"))?;
        let _ = connection.close().await;

        let groups = group_rows
            .into_iter()
            .map(|row| {
                Ok(RegisteredGroup {
                    id: row
                        .try_get("id")
                        .map_err(|err| format!("read group ID failed: {err}"))?,
                    name: row
                        .try_get("name")
                        .map_err(|err| format!("read group name failed: {err}"))?,
                    parent_id: row
                        .try_get("parent_id")
                        .map_err(|err| format!("read group parent failed: {err}"))?,
                    sort_order: row
                        .try_get("sort_order")
                        .map_err(|err| format!("read group sort order failed: {err}"))?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let projects = project_rows
            .into_iter()
            .map(|row| {
                let cli_tool: String = row
                    .try_get("cli_tool")
                    .map_err(|err| format!("read project CLI tool failed: {err}"))?;
                let Some(agent) = cc_connect_agent_from_cli_tool(&cli_tool) else {
                    return Ok(None);
                };
                Ok(Some(RegisteredProjectRow {
                    id: row
                        .try_get("id")
                        .map_err(|err| format!("read project ID failed: {err}"))?,
                    name: row
                        .try_get("name")
                        .map_err(|err| format!("read project name failed: {err}"))?,
                    path: row
                        .try_get("path")
                        .map_err(|err| format!("read project path failed: {err}"))?,
                    agent,
                    cli_tool,
                    cli_args: row
                        .try_get("cli_args")
                        .map_err(|err| format!("read project CLI arguments failed: {err}"))?,
                    group_id: row
                        .try_get("group_id")
                        .map_err(|err| format!("read project group failed: {err}"))?,
                    sort_order: row
                        .try_get("sort_order")
                        .map_err(|err| format!("read project sort order failed: {err}"))?,
                    provider_overrides: row
                        .try_get("provider_overrides")
                        .map_err(|err| format!("read project provider override failed: {err}"))?,
                    environment_type: row
                        .try_get("environment_type")
                        .map_err(|err| format!("read project environment type failed: {err}"))?,
                    ssh_host_id: row
                        .try_get("ssh_host_id")
                        .map_err(|err| format!("read project SSH host failed: {err}"))?,
                    remote_path: row
                        .try_get("remote_path")
                        .map_err(|err| format!("read project remote path failed: {err}"))?,
                    cli_config_root: row
                        .try_get("cli_config_root")
                        .map_err(|err| format!("read project CLI config root failed: {err}"))?,
                    host_codex_config_root: row
                        .try_get("host_codex_config_root")
                        .map_err(|err| format!("read SSH Codex config root failed: {err}"))?,
                    env_vars: row
                        .try_get("env_vars")
                        .map_err(|err| format!("read project environment failed: {err}"))?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect();
        let provider_catalog = load_provider_catalog().await;
        Ok(order_registered_projects(
            groups,
            projects,
            &provider_catalog,
        ))
    })
}

fn sqlite_u16(row: &sqlx::sqlite::SqliteRow, field: &str) -> Result<u16, String> {
    let value: i64 = row
        .try_get(field)
        .map_err(|err| format!("read SSH host {field} failed: {err}"))?;
    u16::try_from(value).map_err(|_| format!("read SSH host {field} failed: out of range"))
}

fn sqlite_u32(row: &sqlx::sqlite::SqliteRow, field: &str) -> Result<u32, String> {
    let value: i64 = row
        .try_get(field)
        .map_err(|err| format!("read SSH host {field} failed: {err}"))?;
    u32::try_from(value).map_err(|_| format!("read SSH host {field} failed: out of range"))
}

fn sqlite_u64(row: &sqlx::sqlite::SqliteRow, field: &str) -> Result<u64, String> {
    let value: i64 = row
        .try_get(field)
        .map_err(|err| format!("read SSH host {field} failed: {err}"))?;
    u64::try_from(value).map_err(|_| format!("read SSH host {field} failed: out of range"))
}

async fn query_registered_ssh_host(
    connection: &mut SqliteConnection,
    host_id: &str,
) -> Result<Option<RegisteredSshHost>, String> {
    let row = sqlx::query(
        "SELECT host, port, username, config_alias, config_file, auth_mode, identity_file, \
                credential_ref, jump_mode, jump_host_id, proxy_type, proxy_host, proxy_port, \
                proxy_command, connect_timeout_sec, server_alive_interval_sec, \
                server_alive_count_max, startup_script \
         FROM ssh_hosts WHERE id = ?",
    )
    .bind(host_id)
    .fetch_optional(connection)
    .await
    .map_err(|err| format!("query CLI-Manager SSH host failed: {err}"))?;
    row.map(|row| {
        Ok(RegisteredSshHost {
            host: row
                .try_get("host")
                .map_err(|err| format!("read SSH host address failed: {err}"))?,
            port: sqlite_u16(&row, "port")?,
            username: row
                .try_get("username")
                .map_err(|err| format!("read SSH host username failed: {err}"))?,
            config_alias: row
                .try_get("config_alias")
                .map_err(|err| format!("read SSH config alias failed: {err}"))?,
            config_file: row
                .try_get("config_file")
                .map_err(|err| format!("read SSH config file failed: {err}"))?,
            auth_mode: row
                .try_get("auth_mode")
                .map_err(|err| format!("read SSH authentication mode failed: {err}"))?,
            identity_file: row
                .try_get("identity_file")
                .map_err(|err| format!("read SSH identity file failed: {err}"))?,
            credential_ref: row
                .try_get("credential_ref")
                .map_err(|err| format!("read SSH credential reference failed: {err}"))?,
            jump_mode: row
                .try_get("jump_mode")
                .map_err(|err| format!("read SSH jump mode failed: {err}"))?,
            jump_host_id: row
                .try_get("jump_host_id")
                .map_err(|err| format!("read SSH jump host failed: {err}"))?,
            proxy_type: row
                .try_get("proxy_type")
                .map_err(|err| format!("read SSH proxy type failed: {err}"))?,
            proxy_host: row
                .try_get("proxy_host")
                .map_err(|err| format!("read SSH proxy host failed: {err}"))?,
            proxy_port: sqlite_u16(&row, "proxy_port")?,
            proxy_command: row
                .try_get("proxy_command")
                .map_err(|err| format!("read SSH proxy command failed: {err}"))?,
            connect_timeout_sec: sqlite_u64(&row, "connect_timeout_sec")?,
            server_alive_interval_sec: sqlite_u64(&row, "server_alive_interval_sec")?,
            server_alive_count_max: sqlite_u32(&row, "server_alive_count_max")?,
            startup_script: row
                .try_get("startup_script")
                .map_err(|err| format!("read SSH startup script failed: {err}"))?,
        })
    })
    .transpose()
}

fn ssh_jump_target(host: &RegisteredSshHost) -> String {
    if !host.config_alias.trim().is_empty() {
        return host.config_alias.trim().to_string();
    }
    let address = host.host.trim();
    if address.is_empty() {
        return String::new();
    }
    let address = if address.contains(':') && !address.starts_with('[') {
        format!("[{address}]")
    } else {
        address.to_string()
    };
    let user = if host.username.trim().is_empty() {
        String::new()
    } else {
        format!("{}@", host.username.trim())
    };
    let port = if host.port == 0 || host.port == 22 {
        String::new()
    } else {
        format!(":{}", host.port)
    };
    format!("{user}{address}{port}")
}

fn selected_ssh_jump_host_id<'a>(
    jump_mode: &str,
    jump_host_id: Option<&'a str>,
    proxy_type: &str,
) -> Result<Option<&'a str>, String> {
    if matches!(proxy_type, "http" | "socks5" | "proxy_command") || jump_mode == "none" {
        return Ok(None);
    }
    jump_host_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Some)
        .ok_or_else(|| "handoff_ssh_jump_host_missing".to_string())
}

fn parse_project_environment(raw: &str) -> HashMap<String, String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .map(|values| {
            values
                .into_iter()
                .filter_map(|(key, value)| value.as_str().map(|value| (key, value.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn load_ssh_codex_launch(project: &RegisteredProject) -> Result<SshCodexLaunch, String> {
    if project.environment_type != "ssh" {
        return Err("handoff_ssh_project_required".to_string());
    }
    let host_id = project
        .ssh_host_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "handoff_ssh_host_missing".to_string())?;
    let database_path = crate::app_paths::db_path()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("create SSH host query runtime failed: {err}"))?;
    let (host, jump_target) = runtime.block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .read_only(true)
            .busy_timeout(Duration::from_secs(3));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|err| format!("open CLI-Manager SSH database failed: {err}"))?;
        let host = query_registered_ssh_host(&mut connection, host_id)
            .await?
            .ok_or_else(|| "handoff_ssh_host_missing".to_string())?;
        let jump_target = match selected_ssh_jump_host_id(
            &host.jump_mode,
            host.jump_host_id.as_deref(),
            &host.proxy_type,
        )? {
            Some(jump_host_id) => query_registered_ssh_host(&mut connection, jump_host_id)
                .await?
                .map(|jump_host| ssh_jump_target(&jump_host))
                .filter(|target| !target.is_empty())
                .ok_or_else(|| "handoff_ssh_jump_host_missing".to_string())?,
            None => String::new(),
        };
        let _ = connection.close().await;
        Ok::<_, String>((host, jump_target))
    })?;
    if matches!(host.auth_mode.as_str(), "password_prompt" | "interactive") {
        return Err("handoff_ssh_interactive_auth_unsupported".to_string());
    }
    let mut environment_overrides = parse_project_environment(&project.env_vars);
    if !project.cli_config_root.trim().is_empty() {
        environment_overrides.insert(
            "CODEX_HOME".to_string(),
            project.cli_config_root.trim().to_string(),
        );
    }
    let inherited_git_config_count = environment_overrides.get("GIT_CONFIG_COUNT").cloned();
    for (key, value) in git_safe_directory_environment_for_value(
        project.remote_path.trim(),
        inherited_git_config_count.as_deref(),
    ) {
        environment_overrides.insert(key, value);
    }
    let transport = SshTransportSpec {
        host: host.host,
        port: host.port,
        username: host.username,
        config_alias: host.config_alias,
        config_file: host.config_file,
        auth_mode: host.auth_mode.clone(),
        identity_file: if host.auth_mode == "identity_file" {
            host.identity_file
        } else {
            String::new()
        },
        credential_ref: if host.auth_mode == "credential_ref" {
            host.credential_ref
        } else {
            String::new()
        },
        jump_target,
        proxy_type: host.proxy_type.clone(),
        proxy_host: host.proxy_host,
        proxy_port: host.proxy_port,
        proxy_command: if host.proxy_type == "proxy_command" {
            host.proxy_command
        } else {
            String::new()
        },
        connect_timeout_sec: host.connect_timeout_sec,
        server_alive_interval_sec: host.server_alive_interval_sec,
        server_alive_count_max: host.server_alive_count_max,
    };
    let launch = SshCodexLaunch {
        transport,
        remote_path: project.remote_path.trim().to_string(),
        environment_overrides,
        initialization_command: (!host.startup_script.trim().is_empty())
            .then(|| host.startup_script.trim().to_string()),
    };
    launch.encode()?;
    Ok(launch)
}

fn registered_project_by_token(
    profile: &CcConnectProfile,
    token: &str,
) -> Result<RegisteredProject, String> {
    if !is_switch_identifier(token) {
        return Err("invalid CLI-Manager project switch token".to_string());
    }
    load_registered_projects(Some(profile))?
        .into_iter()
        .find(|project| project_switch_token(&project.id).eq_ignore_ascii_case(token))
        .ok_or_else(|| "the selected project is no longer registered in CLI-Manager".to_string())
}

#[cfg(target_os = "windows")]
fn set_credential(account: &str, value: &str) -> Result<(), String> {
    crate::credential_store::entry(account)?
        .set_password(value)
        .map_err(|err| format!("save cc-connect credential failed: {err}"))
}
#[cfg(target_os = "windows")]
fn get_credential(account: &str) -> Result<Option<String>, String> {
    match crate::credential_store::entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("read cc-connect credential failed: {err}")),
    }
}
#[cfg(target_os = "windows")]
fn delete_credential(account: &str) -> Result<(), String> {
    match crate::credential_store::entry(account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("delete cc-connect credential failed: {err}")),
    }
}
#[cfg(not(target_os = "windows"))]
fn set_credential(_account: &str, _value: &str) -> Result<(), String> {
    Err("secure cc-connect credential storage is only available on Windows".to_string())
}
#[cfg(not(target_os = "windows"))]
fn get_credential(_account: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(target_os = "windows"))]
fn delete_credential(_account: &str) -> Result<(), String> {
    Ok(())
}

fn save_request_credentials(request: &CcConnectSaveProfileRequest) -> Result<(), String> {
    let credentials = [
        (TELEGRAM_TOKEN_ACCOUNT, request.telegram_token.as_deref()),
        (FEISHU_APP_ID_ACCOUNT, request.feishu_app_id.as_deref()),
        (
            FEISHU_APP_SECRET_ACCOUNT,
            request.feishu_app_secret.as_deref(),
        ),
        (WEIXIN_TOKEN_ACCOUNT, request.weixin_token.as_deref()),
        (WECOM_BOT_ID_ACCOUNT, request.wecom_bot_id.as_deref()),
        (
            WECOM_BOT_SECRET_ACCOUNT,
            request.wecom_bot_secret.as_deref(),
        ),
    ];
    for (account, value) in credentials {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            set_credential(account, value)?;
        }
    }
    Ok(())
}

fn credentials_ready(platform: CcConnectPlatform) -> Result<bool, String> {
    Ok(match platform {
        CcConnectPlatform::Telegram => {
            get_credential(TELEGRAM_TOKEN_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
        }
        CcConnectPlatform::Feishu => {
            get_credential(FEISHU_APP_ID_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
                && get_credential(FEISHU_APP_SECRET_ACCOUNT)?
                    .is_some_and(|value| !value.trim().is_empty())
        }
        CcConnectPlatform::Weixin => {
            get_credential(WEIXIN_TOKEN_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
        }
        CcConnectPlatform::Wecom => {
            get_credential(WECOM_BOT_ID_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
                && get_credential(WECOM_BOT_SECRET_ACCOUNT)?
                    .is_some_and(|value| !value.trim().is_empty())
        }
    })
}

fn credential_environment(
    platform: CcConnectPlatform,
) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    match platform {
        CcConnectPlatform::Telegram => {
            let token = get_credential(TELEGRAM_TOKEN_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Telegram credential is missing".to_string())?;
            Ok((
                vec![(TELEGRAM_TOKEN_ENV.to_string(), token.clone())],
                vec![token],
            ))
        }
        CcConnectPlatform::Feishu => {
            let app_id = get_credential(FEISHU_APP_ID_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Feishu app ID is missing".to_string())?;
            let app_secret = get_credential(FEISHU_APP_SECRET_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Feishu app secret is missing".to_string())?;
            Ok((
                vec![
                    (FEISHU_APP_ID_ENV.to_string(), app_id.clone()),
                    (FEISHU_APP_SECRET_ENV.to_string(), app_secret.clone()),
                ],
                vec![app_id, app_secret],
            ))
        }
        CcConnectPlatform::Weixin => {
            let token = get_credential(WEIXIN_TOKEN_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Weixin token is missing".to_string())?;
            Ok((
                vec![(WEIXIN_TOKEN_ENV.to_string(), token.clone())],
                vec![token],
            ))
        }
        CcConnectPlatform::Wecom => {
            let bot_id = get_credential(WECOM_BOT_ID_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "WeCom bot ID is missing".to_string())?;
            let bot_secret = get_credential(WECOM_BOT_SECRET_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "WeCom bot secret is missing".to_string())?;
            Ok((
                vec![
                    (WECOM_BOT_ID_ENV.to_string(), bot_id.clone()),
                    (WECOM_BOT_SECRET_ENV.to_string(), bot_secret.clone()),
                ],
                vec![bot_id, bot_secret],
            ))
        }
    }
}

fn credentials_ready_for_profile(profile: &CcConnectProfile) -> Result<bool, String> {
    let enabled = enabled_platforms(profile);
    if enabled.is_empty() {
        return Ok(false);
    }
    for item in enabled {
        if !credentials_ready(item.platform)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn credential_environment_for_profile(
    profile: &CcConnectProfile,
) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    let enabled = enabled_platforms(profile);
    if enabled.is_empty() {
        return Err("at least one messaging platform must be enabled".to_string());
    }
    let mut environment = Vec::new();
    let mut secrets = Vec::new();
    for item in enabled {
        let (mut platform_environment, mut platform_secrets) =
            credential_environment(item.platform)?;
        environment.append(&mut platform_environment);
        secrets.append(&mut platform_secrets);
    }
    Ok((environment, secrets))
}

fn platform_statuses(profile: Option<&CcConnectProfile>) -> Vec<CcConnectPlatformStatus> {
    let configured = profile.map(profile_platforms).unwrap_or_default();
    CC_CONNECT_PLATFORMS
        .into_iter()
        .map(|platform| CcConnectPlatformStatus {
            platform,
            enabled: configured
                .iter()
                .find(|item| item.platform == platform)
                .is_some_and(|item| item.enabled),
            credentials_ready: credentials_ready(platform).unwrap_or(false),
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxySource {
    Configured,
    AutoDetected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedProxy {
    url: String,
    source: ProxySource,
}

fn resolve_proxy_url(
    configured: Option<&str>,
    local_ports: &[u16],
) -> Result<Option<ResolvedProxy>, String> {
    if let Some(url) = normalize_proxy_url(configured)? {
        return Ok(Some(ResolvedProxy {
            url,
            source: ProxySource::Configured,
        }));
    }
    Ok(
        detect_local_proxy_on_ports(local_ports).map(|url| ResolvedProxy {
            url,
            source: ProxySource::AutoDetected,
        }),
    )
}

fn resolve_proxy_url_if_enabled(
    enabled: bool,
    configured: Option<&str>,
    local_ports: &[u16],
) -> Result<Option<ResolvedProxy>, String> {
    if !enabled {
        return Ok(None);
    }
    resolve_proxy_url(configured, local_ports)
}

fn detect_local_proxy_on_ports(ports: &[u16]) -> Option<String> {
    ports.iter().find_map(|port| {
        let address = SocketAddr::from(([127, 0, 0, 1], *port));
        TcpStream::connect_timeout(&address, LOCAL_PROXY_CONNECT_TIMEOUT)
            .ok()
            .map(|_| format!("http://127.0.0.1:{port}/"))
    })
}

fn proxy_environment(proxy_url: &str) -> Vec<(String, String)> {
    PROXY_ENV_KEYS
        .into_iter()
        .map(|key| (key.to_string(), proxy_url.to_string()))
        .chain([
            (
                "NO_PROXY".to_string(),
                "localhost,127.0.0.1,[::1]".to_string(),
            ),
            (
                "no_proxy".to_string(),
                "localhost,127.0.0.1,[::1]".to_string(),
            ),
        ])
        .collect()
}

fn apply_proxy_environment(
    command: &mut Command,
    proxy_enabled: bool,
    proxy: Option<&ResolvedProxy>,
) {
    if !proxy_enabled {
        for key in PROXY_ENV_KEYS {
            command.env_remove(key);
        }
        command.env("NO_PROXY", "*").env("no_proxy", "*");
        return;
    }
    if let Some(proxy) = proxy {
        for (key, value) in proxy_environment(&proxy.url) {
            command.env(key, value);
        }
    }
}

fn git_safe_directory_environment(
    project_path: &Path,
    inherited_count: Option<&str>,
) -> Vec<(String, String)> {
    git_safe_directory_environment_for_value(&config_path_value(project_path), inherited_count)
}

fn git_safe_directory_environment_for_value(
    project_path: &str,
    inherited_count: Option<&str>,
) -> Vec<(String, String)> {
    let index = inherited_count
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value < 1_024)
        .unwrap_or(0);
    vec![
        ("GIT_CONFIG_COUNT".to_string(), (index + 1).to_string()),
        (
            format!("GIT_CONFIG_KEY_{index}"),
            "safe.directory".to_string(),
        ),
        (
            format!("GIT_CONFIG_VALUE_{index}"),
            project_path.to_string(),
        ),
    ]
}

fn apply_git_safe_directory_environment(command: &mut Command, project_path: &Path) {
    let inherited_count = env::var("GIT_CONFIG_COUNT").ok();
    for (key, value) in git_safe_directory_environment(project_path, inherited_count.as_deref()) {
        command.env(key, value);
    }
}

struct CredentialSnapshot {
    entries: Vec<(&'static str, Option<String>)>,
}

impl CredentialSnapshot {
    fn capture(platform: Option<CcConnectPlatform>) -> Result<Self, String> {
        let accounts: Vec<&'static str> = match platform {
            Some(CcConnectPlatform::Telegram) => vec![TELEGRAM_TOKEN_ACCOUNT],
            Some(CcConnectPlatform::Feishu) => {
                vec![FEISHU_APP_ID_ACCOUNT, FEISHU_APP_SECRET_ACCOUNT]
            }
            Some(CcConnectPlatform::Weixin) => vec![WEIXIN_TOKEN_ACCOUNT],
            Some(CcConnectPlatform::Wecom) => {
                vec![WECOM_BOT_ID_ACCOUNT, WECOM_BOT_SECRET_ACCOUNT]
            }
            None => vec![
                TELEGRAM_TOKEN_ACCOUNT,
                FEISHU_APP_ID_ACCOUNT,
                FEISHU_APP_SECRET_ACCOUNT,
                WEIXIN_TOKEN_ACCOUNT,
                WECOM_BOT_ID_ACCOUNT,
                WECOM_BOT_SECRET_ACCOUNT,
            ],
        };
        let mut entries = Vec::with_capacity(accounts.len());
        for account in accounts {
            entries.push((account, get_credential(account)?));
        }
        Ok(Self { entries })
    }

    fn restore(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (account, value) in &self.entries {
            if let Err(err) = restore_credential(account, value.as_deref()) {
                errors.push(err);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn restore_credential(account: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => set_credential(account, value),
        None => delete_credential(account),
    }
}

struct FileSnapshot {
    path: PathBuf,
    contents: Option<Vec<u8>>,
    label: &'static str,
}

impl FileSnapshot {
    fn capture(path: PathBuf, label: &'static str) -> Result<Self, String> {
        let contents = match fs::read(&path) {
            Ok(contents) => Some(contents),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(format!("snapshot {label} failed: {err}")),
        };
        Ok(Self {
            path,
            contents,
            label,
        })
    }

    fn restore(&self) -> Result<(), String> {
        if let Some(contents) = self.contents.as_deref() {
            write_file_atomically_if_changed(&self.path, contents, self.label)
        } else {
            match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(err) => Err(format!("remove rolled back {} failed: {err}", self.label)),
            }
        }
    }
}

struct RemoteSwitchOutcome {
    language: CcConnectLanguage,
    project_name: String,
    project_path: String,
    restart_required: bool,
    already_current: bool,
}

impl CcConnectManager {
    fn save_profile(&self, request: CcConnectSaveProfileRequest) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.save_profile_locked(request)
    }

    fn save_profile_locked(&self, request: CcConnectSaveProfileRequest) -> Result<(), String> {
        handoff::ensure_handoff_inactive()?;
        self.refresh_process_state();
        let was_running = {
            let state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.starting {
                return Err("cc-connect is still starting; retry shortly".to_string());
            }
            state.process.is_some()
        };
        let profile = normalize_profile(self, request.profile.clone())?;
        let credential_snapshot = CredentialSnapshot::capture(None)?;
        let config_snapshot = FileSnapshot::capture(config_path()?, "cc-connect config")?;
        let project_list_snapshot =
            FileSnapshot::capture(project_list_path()?, "CLI-Manager project list")?;
        let project_switch_script_snapshot = FileSnapshot::capture(
            project_switch_script_path()?,
            "CLI-Manager project switch script",
        )?;
        let profile_snapshot = FileSnapshot::capture(profile_path()?, "cc-connect profile")?;
        if was_running {
            self.stop_inner()?;
        }
        let save_result = (|| {
            save_request_credentials(&request)?;
            write_managed_config(&profile)?;
            persist_profile(&profile)?;
            if let Ok(mut cache) = self.detection.lock() {
                *cache = None;
            }
            if was_running {
                self.start_inner()?;
            }
            Ok::<_, String>(())
        })();
        if let Err(save_error) = save_result {
            let mut rollback_errors = Vec::new();
            if let Err(err) = profile_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = config_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = project_list_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = project_switch_script_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = credential_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Ok(mut cache) = self.detection.lock() {
                *cache = None;
            }
            if was_running {
                if let Err(err) = self.start_inner() {
                    rollback_errors
                        .push(format!("restart previous cc-connect profile failed: {err}"));
                }
            }
            if rollback_errors.is_empty() {
                return Err(save_error);
            }
            return Err(format!(
                "{save_error}; rollback failed: {}",
                rollback_errors.join("; ")
            ));
        }
        self.append_system_log(format!(
            "cc-connect connection profile saved ({} platforms)",
            enabled_platforms(&profile).len()
        ));
        Ok(())
    }

    fn start_weixin_authorization(
        &self,
        request: CcConnectWeixinAuthorizeRequest,
    ) -> Result<CcConnectWeixinAuthorizationStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        {
            let state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.process.is_some() || state.starting {
                return Err("stop cc-connect before authorizing Weixin".to_string());
            }
        }
        {
            let authorization = self
                .weixin_authorization
                .lock()
                .map_err(|_| "Weixin authorization lock poisoned".to_string())?;
            if matches!(
                authorization.as_ref(),
                Some(WeixinAuthorizationState::Running(_))
            ) {
                return Err("Weixin authorization is already running".to_string());
            }
        }

        let mut profile = request.profile;
        if profile.platform != CcConnectPlatform::Weixin {
            return Err("select the Weixin platform before authorization".to_string());
        }
        hydrate_profile_platforms(&mut profile);
        let existing_allow_from = platform_profile(&profile, CcConnectPlatform::Weixin)
            .map(|item| item.allow_from)
            .unwrap_or_default();
        let existing_allow_from = if existing_allow_from.trim().is_empty() {
            String::new()
        } else {
            normalize_allow_from(CcConnectPlatform::Weixin, &existing_allow_from)?
        };
        if let Some(item) = profile
            .platforms
            .iter_mut()
            .find(|item| item.platform == CcConnectPlatform::Weixin)
        {
            item.enabled = true;
        }
        set_platform_allow_from(
            &mut profile,
            CcConnectPlatform::Weixin,
            if existing_allow_from.is_empty() {
                "authorization-pending@im.wechat".to_string()
            } else {
                existing_allow_from.clone()
            },
        );
        let mut profile = normalize_profile(self, profile)?;
        set_platform_allow_from(&mut profile, CcConnectPlatform::Weixin, existing_allow_from);

        let binary = self.detect(profile.executable_path.as_deref(), true)?;
        if !binary.compatible {
            return Err(format!(
                "cc-connect {} is outside the supported range or failed official checksum verification",
                binary.version.as_deref().unwrap_or("binary")
            ));
        }
        let (config_path, qr_path, stdout_path, stderr_path) = weixin_authorization_paths()?;
        let auth_dir = config_path
            .parent()
            .ok_or_else(|| "Weixin authorization directory is missing".to_string())?;
        fs::create_dir_all(auth_dir)
            .map_err(|err| format!("create Weixin authorization directory failed: {err}"))?;
        cleanup_weixin_authorization_files([&config_path, &qr_path, &stdout_path, &stderr_path]);

        let mut setup_profile = profile.clone();
        set_platform_allow_from(
            &mut setup_profile,
            CcConnectPlatform::Weixin,
            "authorization-pending@im.wechat".to_string(),
        );
        let config = build_weixin_authorization_config(&setup_profile)?;
        write_file_atomically(
            &config_path,
            config.as_bytes(),
            "Weixin authorization config",
        )?;
        let stdout = File::create(&stdout_path)
            .map_err(|err| format!("create Weixin authorization output failed: {err}"))?;
        let stderr = File::create(&stderr_path)
            .map_err(|err| format!("create Weixin authorization error output failed: {err}"))?;
        let proxy = resolve_proxy_url_if_enabled(
            profile.proxy_enabled,
            profile.proxy_url.as_deref(),
            &LOCAL_PROXY_PORTS,
        )?;
        let mut command = silent_command(&path_string(&binary.path));
        command
            .arg("weixin")
            .arg("setup")
            .arg("--config")
            .arg(&config_path)
            .arg("--project")
            .arg(&profile.project_name)
            .arg("--platform-index")
            .arg("1")
            .arg("--timeout")
            .arg(WEIXIN_AUTH_TIMEOUT_SECS.to_string())
            .arg("--qr-image")
            .arg(&qr_path)
            .arg("--set-allow-from-empty")
            .current_dir(&profile.project_path)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        apply_proxy_environment(&mut command, profile.proxy_enabled, proxy.as_ref());
        let mut child = command
            .spawn()
            .map_err(|err| format!("start Weixin authorization failed: {err}"))?;
        #[cfg(target_os = "windows")]
        let job = match ChildJob::assign(&child, "Weixin authorization") {
            Ok(job) => job,
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                cleanup_weixin_authorization_files([
                    &config_path,
                    &qr_path,
                    &stdout_path,
                    &stderr_path,
                ]);
                return Err(err);
            }
        };
        let started_at_ms = now_millis();
        let process = WeixinAuthorizationProcess {
            child,
            profile,
            config_path,
            qr_path,
            stdout_path,
            stderr_path,
            #[cfg(target_os = "windows")]
            job,
            started_at_ms,
        };
        let status = CcConnectWeixinAuthorizationStatus {
            phase: CcConnectWeixinAuthorizationPhase::Starting,
            qr_data_url: None,
            error: None,
            allow_from: None,
            profile: None,
            started_at_ms: Some(started_at_ms),
        };
        let mut authorization = self
            .weixin_authorization
            .lock()
            .map_err(|_| "Weixin authorization lock poisoned".to_string())?;
        *authorization = Some(WeixinAuthorizationState::Running(process));
        Ok(status)
    }

    fn finish_weixin_authorization(
        &self,
        process: WeixinAuthorizationProcess,
    ) -> CcConnectWeixinAuthorizationStatus {
        let result = (|| {
            let authorization = parse_weixin_authorization_result(
                &process.config_path,
                &process.profile.project_name,
            )?;
            let existing_allow_from = platform_profile(&process.profile, CcConnectPlatform::Weixin)
                .map(|item| item.allow_from)
                .unwrap_or_default();
            let allow_from =
                merge_weixin_allow_from(&existing_allow_from, &authorization.allow_from)?;
            let mut profile = process.profile.clone();
            set_platform_allow_from(&mut profile, CcConnectPlatform::Weixin, allow_from.clone());
            self.save_profile_locked(CcConnectSaveProfileRequest {
                profile: profile.clone(),
                telegram_token: None,
                feishu_app_id: None,
                feishu_app_secret: None,
                weixin_token: Some(authorization.token),
                wecom_bot_id: None,
                wecom_bot_secret: None,
            })?;
            Ok::<_, String>((profile, allow_from))
        })();
        cleanup_weixin_authorization_files([
            &process.config_path,
            &process.qr_path,
            &process.stdout_path,
            &process.stderr_path,
        ]);
        match result {
            Ok((profile, allow_from)) => CcConnectWeixinAuthorizationStatus {
                phase: CcConnectWeixinAuthorizationPhase::Completed,
                qr_data_url: None,
                error: None,
                allow_from: Some(allow_from),
                profile: Some(profile),
                started_at_ms: Some(process.started_at_ms),
            },
            Err(error) => CcConnectWeixinAuthorizationStatus {
                phase: CcConnectWeixinAuthorizationPhase::Failed,
                qr_data_url: None,
                error: Some(error),
                allow_from: None,
                profile: None,
                started_at_ms: Some(process.started_at_ms),
            },
        }
    }

    fn failed_weixin_authorization(
        &self,
        process: WeixinAuthorizationProcess,
        error: String,
    ) -> CcConnectWeixinAuthorizationStatus {
        let detail = weixin_authorization_error_detail(&process.stderr_path);
        cleanup_weixin_authorization_files([
            &process.config_path,
            &process.qr_path,
            &process.stdout_path,
            &process.stderr_path,
        ]);
        CcConnectWeixinAuthorizationStatus {
            phase: CcConnectWeixinAuthorizationPhase::Failed,
            qr_data_url: None,
            error: Some(match detail {
                Some(detail) => format!("{error}: {detail}"),
                None => error,
            }),
            allow_from: None,
            profile: None,
            started_at_ms: Some(process.started_at_ms),
        }
    }

    fn weixin_authorization_status(&self) -> Result<CcConnectWeixinAuthorizationStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        let mut authorization = self
            .weixin_authorization
            .lock()
            .map_err(|_| "Weixin authorization lock poisoned".to_string())?;
        let state = authorization
            .as_mut()
            .ok_or_else(|| "Weixin authorization has not been started".to_string())?;
        match state {
            WeixinAuthorizationState::Finished(status) => Ok(status.clone()),
            WeixinAuthorizationState::Running(process) => {
                let qr_data_url =
                    weixin_authorization_qr_data_url(&process.qr_path).unwrap_or(None);
                match process.child.try_wait() {
                    Ok(None) => Ok(CcConnectWeixinAuthorizationStatus {
                        phase: if qr_data_url.is_some() {
                            CcConnectWeixinAuthorizationPhase::Waiting
                        } else {
                            CcConnectWeixinAuthorizationPhase::Starting
                        },
                        qr_data_url,
                        error: None,
                        allow_from: None,
                        profile: None,
                        started_at_ms: Some(process.started_at_ms),
                    }),
                    exit_result => {
                        let state = authorization
                            .take()
                            .ok_or_else(|| "Weixin authorization state is missing".to_string())?;
                        let WeixinAuthorizationState::Running(mut process) = state else {
                            return Err("Weixin authorization state is invalid".to_string());
                        };
                        drop(authorization);
                        let status = match exit_result {
                            Ok(Some(exit)) if exit.success() => {
                                self.finish_weixin_authorization(process)
                            }
                            Ok(Some(exit)) => self.failed_weixin_authorization(
                                process,
                                format!("Weixin authorization exited with code {:?}", exit.code()),
                            ),
                            Ok(None) => unreachable!(),
                            Err(err) => {
                                #[cfg(target_os = "windows")]
                                process.job.terminate();
                                let _ = process.child.kill();
                                let _ = process.child.wait();
                                self.failed_weixin_authorization(
                                    process,
                                    format!("inspect Weixin authorization failed: {err}"),
                                )
                            }
                        };
                        let mut authorization = self
                            .weixin_authorization
                            .lock()
                            .map_err(|_| "Weixin authorization lock poisoned".to_string())?;
                        *authorization = Some(WeixinAuthorizationState::Finished(status.clone()));
                        Ok(status)
                    }
                }
            }
        }
    }

    fn cancel_weixin_authorization(&self) -> Result<CcConnectWeixinAuthorizationStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        let mut authorization = self
            .weixin_authorization
            .lock()
            .map_err(|_| "Weixin authorization lock poisoned".to_string())?;
        let state = authorization.take();
        let started_at_ms = match state {
            Some(WeixinAuthorizationState::Running(mut process)) => {
                #[cfg(target_os = "windows")]
                process.job.terminate();
                let _ = process.child.kill();
                let _ = process.child.wait();
                cleanup_weixin_authorization_files([
                    &process.config_path,
                    &process.qr_path,
                    &process.stdout_path,
                    &process.stderr_path,
                ]);
                Some(process.started_at_ms)
            }
            Some(WeixinAuthorizationState::Finished(status)) => status.started_at_ms,
            None => None,
        };
        let status = CcConnectWeixinAuthorizationStatus {
            phase: CcConnectWeixinAuthorizationPhase::Cancelled,
            qr_data_url: None,
            error: None,
            allow_from: None,
            profile: None,
            started_at_ms,
        };
        *authorization = Some(WeixinAuthorizationState::Finished(status.clone()));
        Ok(status)
    }

    fn switch_project_from_remote(&self, token: &str) -> Result<RemoteSwitchOutcome, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        handoff::ensure_handoff_inactive()?;
        self.refresh_process_state();
        let mut profile =
            load_profile()?.ok_or_else(|| "cc-connect profile is not configured".to_string())?;
        let project = registered_project_by_token(&profile, token)?;
        let already_current = profile.runtime_project_id.as_deref() == Some(project.id.as_str());
        let restart_required = {
            let state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.starting {
                return Err("cc-connect is still starting; retry shortly".to_string());
            }
            state.process.is_some() && !already_current
        };
        if already_current {
            return Ok(RemoteSwitchOutcome {
                language: profile.language,
                project_name: project.name,
                project_path: user_path_string(Path::new(&project.path)),
                restart_required: false,
                already_current: true,
            });
        }

        profile.runtime_project_id = Some(project.id.clone());
        let profile = normalize_profile(self, profile)?;
        let config_snapshot = FileSnapshot::capture(config_path()?, "cc-connect config")?;
        let project_list_snapshot =
            FileSnapshot::capture(project_list_path()?, "CLI-Manager project list")?;
        let project_switch_script_snapshot = FileSnapshot::capture(
            project_switch_script_path()?,
            "CLI-Manager project switch script",
        )?;
        let profile_snapshot = FileSnapshot::capture(profile_path()?, "cc-connect profile")?;
        if let Err(save_error) = (|| {
            write_managed_config(&profile)?;
            persist_profile(&profile)
        })() {
            let mut rollback_errors = Vec::new();
            if let Err(err) = profile_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = config_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = project_list_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = project_switch_script_snapshot.restore() {
                rollback_errors.push(err);
            }
            return if rollback_errors.is_empty() {
                Err(save_error)
            } else {
                Err(format!(
                    "{save_error}; rollback failed: {}",
                    rollback_errors.join("; ")
                ))
            };
        }
        self.append_system_log(format!(
            "cc-connect remote project switched to '{}' ({})",
            project.name, project.path
        ));
        Ok(RemoteSwitchOutcome {
            language: profile.language,
            project_name: project.name,
            project_path: user_path_string(Path::new(&project.path)),
            restart_required,
            already_current: false,
        })
    }

    fn clear_credentials(&self, platform: Option<CcConnectPlatform>) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        {
            let state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.process.is_some() || state.starting {
                return Err("stop cc-connect before clearing its credentials".to_string());
            }
        }
        let snapshot = CredentialSnapshot::capture(platform)?;
        let result = (|| {
            match platform {
                Some(CcConnectPlatform::Telegram) => delete_credential(TELEGRAM_TOKEN_ACCOUNT)?,
                Some(CcConnectPlatform::Feishu) => {
                    delete_credential(FEISHU_APP_ID_ACCOUNT)?;
                    delete_credential(FEISHU_APP_SECRET_ACCOUNT)?;
                }
                Some(CcConnectPlatform::Weixin) => delete_credential(WEIXIN_TOKEN_ACCOUNT)?,
                Some(CcConnectPlatform::Wecom) => {
                    delete_credential(WECOM_BOT_ID_ACCOUNT)?;
                    delete_credential(WECOM_BOT_SECRET_ACCOUNT)?;
                }
                None => {
                    delete_credential(TELEGRAM_TOKEN_ACCOUNT)?;
                    delete_credential(FEISHU_APP_ID_ACCOUNT)?;
                    delete_credential(FEISHU_APP_SECRET_ACCOUNT)?;
                    delete_credential(WEIXIN_TOKEN_ACCOUNT)?;
                    delete_credential(WECOM_BOT_ID_ACCOUNT)?;
                    delete_credential(WECOM_BOT_SECRET_ACCOUNT)?;
                }
            }
            Ok(())
        })();
        if let Err(clear_error) = result {
            return match snapshot.restore() {
                Ok(()) => Err(clear_error),
                Err(rollback_error) => {
                    Err(format!("{clear_error}; rollback failed: {rollback_error}"))
                }
            };
        }
        self.append_system_log("cc-connect credentials cleared");
        Ok(())
    }

    fn status(&self, refresh_detection: bool) -> Result<CcConnectStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        let profile = load_profile()?;
        let explicit_path = profile
            .as_ref()
            .and_then(|profile| profile.executable_path.as_deref());
        let detection = self.detect(explicit_path, refresh_detection);
        let config_path = config_path()?;
        let config_exists = config_path.is_file();
        let mut blockers = Vec::new();
        let mut warnings = vec![
            "independent_sessions".to_string(),
            "current_user_permissions".to_string(),
        ];
        if let Some(profile) = profile.as_ref() {
            blockers.extend(profile_issue_codes(profile));
            if profile.agent == CcConnectAgent::Codex
                && self.check_codex_app_server(refresh_detection).is_err()
            {
                blockers.push("codex_app_server_unavailable".to_string());
            }
            if profile.yolo_enabled {
                warnings.push("yolo_enabled".to_string());
            }
        } else {
            blockers.push("profile_missing".to_string());
        }
        if profile.is_some() && !config_exists {
            blockers.push("config_missing".to_string());
        }
        let (credentials_ready, credential_error) = match profile.as_ref() {
            Some(profile) => match credentials_ready_for_profile(profile) {
                Ok(ready) => (ready, None),
                Err(err) => (false, Some(err)),
            },
            None => (false, None),
        };
        let platform_statuses = platform_statuses(profile.as_ref());
        if profile.is_some() && !credentials_ready {
            blockers.push(if credential_error.is_some() {
                "credential_store_error".to_string()
            } else {
                "credentials_missing".to_string()
            });
        }
        if credential_error.is_some() {
            warnings.push("credential_store_unavailable".to_string());
        }
        let (installed, executable_path, version, sha256, compatible, detection_error) =
            match detection {
                Ok(binary) => {
                    if !binary.compatible {
                        blockers.push("binary_incompatible".to_string());
                    }
                    (
                        true,
                        Some(user_path_string(&binary.path)),
                        binary.version,
                        Some(binary.sha256),
                        binary.compatible,
                        None,
                    )
                }
                Err(err) => {
                    blockers.push("binary_missing".to_string());
                    (
                        false,
                        explicit_path.map(ToOwned::to_owned),
                        None,
                        None,
                        false,
                        Some(err),
                    )
                }
            };
        blockers.sort();
        blockers.dedup();
        warnings.sort();
        warnings.dedup();
        let process = self
            .process
            .lock()
            .map_err(|_| "cc-connect process lock poisoned".to_string())?;
        let running = process.process.is_some();
        let pid = process.process.as_ref().map(|process| process.child.id());
        let started_at_ms = process
            .process
            .as_ref()
            .map(|process| process.started_at_ms);
        let starting = process.starting;
        let last_exit_code = process.last_exit_code;
        let last_exit_at_ms = process.last_exit_at_ms;
        drop(process);
        Ok(CcConnectStatus {
            installed,
            executable_path,
            version,
            sha256,
            compatible,
            detection_error,
            config_path: path_string(&config_path),
            data_dir: path_string(&data_dir()?),
            log_path: path_string(&log_path()?),
            profile,
            config_exists,
            credentials_ready,
            platform_statuses,
            ready: blockers.is_empty(),
            blockers,
            warnings,
            running,
            starting,
            pid,
            started_at_ms,
            last_exit_code,
            last_exit_at_ms,
        })
    }

    fn start(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.start_inner()
    }

    fn start_inner(&self) -> Result<(), String> {
        self.refresh_process_state();
        {
            let mut state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.process.is_some() {
                return Err("cc-connect is already running under CLI-Manager".to_string());
            }
            if state.starting {
                return Err("cc-connect is already starting".to_string());
            }
            state.starting = true;
        }
        let result = self.prepare_process();
        let mut state = self
            .process
            .lock()
            .map_err(|_| "cc-connect process lock poisoned".to_string())?;
        state.starting = false;
        match result {
            Ok(process) => {
                state.process = Some(process);
                drop(state);
                self.append_system_log("cc-connect managed process started");
                Ok(())
            }
            Err(err) => {
                drop(state);
                self.append_system_log(format!("cc-connect start failed: {err}"));
                Err(err)
            }
        }
    }

    fn prepare_process(&self) -> Result<ManagedProcess, String> {
        let base_profile =
            load_profile()?.ok_or_else(|| "cc-connect profile is not configured".to_string())?;
        let issues = profile_issue_codes(&base_profile);
        if !issues.is_empty() {
            return Err(format!(
                "cc-connect profile is invalid: {}",
                issues.join(", ")
            ));
        }
        let (profile, project) = handoff::effective_target_for_process(base_profile)?;
        if profile.agent == CcConnectAgent::Codex && project.environment_type != "ssh" {
            self.check_codex_app_server(true).map_err(|err| {
                format!("Codex interactive approval backend is unavailable: {err}")
            })?;
        }
        let local_agent_launcher = (project.environment_type != "ssh")
            .then(|| ensure_local_agent_available(&project))
            .transpose()?;
        let codex_launch =
            prepare_remote_codex_launch(&profile, &project, local_agent_launcher.as_ref())?;
        if let Some(launch) = codex_launch.as_ref() {
            probe_remote_codex_app_server(launch)
                .map_err(|err| format!("Codex remote app-server backend is unavailable: {err}"))?;
        }
        let claude_settings_path = handoff::active_claude_settings_path()?;
        let (project_agent_environment, project_process_environment) =
            managed_project_environment(&project);
        let binary = self.detect(profile.executable_path.as_deref(), true)?;
        if !binary.compatible {
            return Err(format!(
                "cc-connect {} is outside the supported range or failed official checksum verification",
                binary.version.as_deref().unwrap_or("binary")
            ));
        }
        let config_path = write_managed_config_with_agent_launch(
            &profile,
            codex_launch.as_ref(),
            local_agent_launcher.as_ref(),
            claude_settings_path.as_deref(),
            &project_agent_environment,
        )?;
        format_and_check_config_syntax(&binary.path, &config_path)?;
        let (mut environment, mut secrets) = credential_environment_for_profile(&profile)?;
        if let Some(provider) = codex_launch
            .as_ref()
            .and_then(|launch| launch.provider.as_ref())
        {
            environment.push((provider.env_key.clone(), provider.secret.clone()));
            secrets.push(provider.secret.clone());
        }
        for (key, value) in project_process_environment {
            if ["TOKEN", "KEY", "SECRET", "PASSWORD"]
                .iter()
                .any(|marker| key.to_ascii_uppercase().contains(marker))
                && !value.is_empty()
            {
                secrets.push(value.clone());
            }
            environment.push((key, value));
        }
        let proxy = resolve_proxy_url_if_enabled(
            profile.proxy_enabled,
            profile.proxy_url.as_deref(),
            &LOCAL_PROXY_PORTS,
        )?;
        if profile.logging_enabled {
            self.ensure_log_writer()?;
            match proxy.as_ref() {
                Some(proxy) if proxy.source == ProxySource::Configured => self
                    .append_system_log(format!("cc-connect proxy: using configured {}", proxy.url)),
                Some(proxy) => self.append_system_log(format!(
                    "cc-connect proxy: auto-detected local proxy {}",
                    proxy.url
                )),
                None if profile.proxy_enabled => self.append_system_log(
                    "cc-connect proxy: no configured local proxy detected; preserving inherited proxy environment",
                ),
                None => self.append_system_log("cc-connect proxy: disabled"),
            }
        }
        let mut command = silent_command(&path_string(&binary.path));
        command
            .arg("--config")
            .arg(&config_path)
            .current_dir(
                config_path
                    .parent()
                    .ok_or_else(|| "cc-connect config parent is missing".to_string())?,
            )
            .stdin(Stdio::null());
        if profile.logging_enabled {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        for (key, value) in environment {
            command.env(key, value);
        }
        if let Some(launch) = codex_launch.as_ref() {
            apply_remote_codex_launch_environment(&mut command, launch)?;
        }
        apply_git_safe_directory_environment(&mut command, Path::new(&profile.project_path));
        apply_proxy_environment(&mut command, profile.proxy_enabled, proxy.as_ref());
        // cc-connect app-server children merge the managed process environment,
        // so the existing Hook executable can report remote task state to the daemon.
        handoff_notification::apply_hook_environment(&mut command);
        let mut child = command
            .spawn()
            .map_err(|err| format!("spawn cc-connect failed: {err}"))?;
        #[cfg(target_os = "windows")]
        let job = match ChildJob::assign(&child, "cc-connect") {
            Ok(job) => job,
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
        };
        if profile.logging_enabled {
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let secrets = Arc::new(secrets);
            if let Some(stdout) = stdout {
                spawn_log_reader(
                    stdout,
                    "stdout",
                    self.logs.clone(),
                    self.log_writer.clone(),
                    secrets.clone(),
                );
            }
            if let Some(stderr) = stderr {
                spawn_log_reader(
                    stderr,
                    "stderr",
                    self.logs.clone(),
                    self.log_writer.clone(),
                    secrets,
                );
            }
        }
        std::thread::sleep(Duration::from_millis(350));
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("inspect cc-connect startup failed: {err}"))?
        {
            return Err(format!(
                "cc-connect exited during startup (code={:?})",
                status.code()
            ));
        }
        Ok(ManagedProcess {
            child,
            #[cfg(target_os = "windows")]
            job,
            started_at_ms: now_millis(),
        })
    }

    fn stop(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.stop_inner()
    }

    fn stop_inner(&self) -> Result<(), String> {
        self.refresh_process_state();
        let mut process = {
            let mut state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.starting {
                return Err("cc-connect is still starting".to_string());
            }
            state.process.take()
        };
        let Some(mut process) = process.take() else {
            return Ok(());
        };
        #[cfg(target_os = "windows")]
        process.job.terminate();
        let _ = process.child.kill();
        #[cfg(target_os = "windows")]
        let status = {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                match process.child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    Ok(None) => {
                        self.append_system_log("cc-connect stop timed out; closing the Job Object");
                        break None;
                    }
                    Err(err) => {
                        self.append_system_log(format!("inspect cc-connect stop failed: {err}"));
                        break None;
                    }
                }
            }
        };
        #[cfg(not(target_os = "windows"))]
        let status = process.child.wait().ok();
        let exit_code = status.as_ref().and_then(|status| status.code());
        {
            let mut state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            state.last_exit_code = exit_code;
            state.last_exit_at_ms = Some(now_millis());
        }
        self.append_system_log(format!("cc-connect stopped (code={exit_code:?})"));
        Ok(())
    }

    fn restart(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.stop_inner()?;
        self.start_inner()
    }

    fn apply_prepared_update(
        &self,
        prepared: update::CcConnectPreparedUpdate,
    ) -> Result<update::CcConnectUpdateResult, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        let was_running = {
            let state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.starting {
                return Err("cc_connect_update_process_starting".to_string());
            }
            state.process.is_some()
        };
        if self
            .weixin_authorization
            .lock()
            .map_err(|_| "Weixin authorization lock poisoned".to_string())?
            .as_ref()
            .is_some_and(|state| matches!(state, WeixinAuthorizationState::Running(_)))
        {
            return Err("cc_connect_update_weixin_authorization_active".to_string());
        }
        if was_running {
            let profile =
                load_profile()?.ok_or_else(|| "cc_connect_update_profile_missing".to_string())?;
            let active = self.detect(profile.executable_path.as_deref(), true)?;
            if active.path != prepared.executable_path() {
                return Err("cc_connect_update_running_target_mismatch".to_string());
            }
        }

        self.stop_inner()?;
        let update_result = update::apply_prepared_update(prepared);
        if let Ok(mut detection) = self.detection.lock() {
            *detection = None;
        }
        let restart_result = if was_running {
            self.start_inner()
        } else {
            Ok(())
        };

        match (update_result, restart_result) {
            (Ok(result), Ok(())) => {
                self.append_system_log(format!(
                    "cc-connect executable updated to {}",
                    result.installed_version
                ));
                Ok(result)
            }
            (Ok(_), Err(restart_error)) => Err(format!(
                "cc_connect_update_installed_restart_failed:{restart_error}"
            )),
            (Err(update_error), Ok(())) => Err(update_error),
            (Err(update_error), Err(restart_error)) => Err(format!(
                "{update_error}; cc_connect_update_restore_restart_failed:{restart_error}"
            )),
        }
    }

    fn auto_start_if_enabled(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        let Some(profile) = load_profile()? else {
            return Ok(());
        };
        if !profile.auto_start {
            return Ok(());
        }
        self.start_inner()
    }

    pub fn shutdown(&self) {
        if let Err(err) = self.cancel_weixin_authorization() {
            log::warn!("Weixin authorization shutdown cleanup failed: {err}");
        }
        if let Err(err) = self.stop() {
            log::warn!("cc-connect shutdown cleanup failed: {err}");
        }
    }
}

pub fn handle_single_instance_args(app: &AppHandle, args: &[String]) -> bool {
    let Some(request) = remote_switch_request_from_args(args) else {
        return false;
    };
    let language = load_profile()
        .ok()
        .flatten()
        .map(|profile| profile.language)
        .unwrap_or(CcConnectLanguage::Zh);
    let result_path = match switch_result_path(&request.request_id) {
        Ok(path) => path,
        Err(err) => {
            log::warn!("ignored invalid cc-connect remote switch request: {err}");
            return true;
        }
    };
    let manager = app.state::<CcConnectManager>().inner().clone();
    let token = request.project_token;
    std::thread::spawn(move || {
        let outcome = manager.switch_project_from_remote(&token);
        let (message, restart_required) = match outcome {
            Ok(outcome) => {
                let message = match (outcome.language, outcome.already_current) {
                    (CcConnectLanguage::Zh, true) => {
                        format!("当前已经是 CLI-Manager 项目：{}", outcome.project_name)
                    }
                    (CcConnectLanguage::En, true) => {
                        format!("Already using CLI-Manager project: {}", outcome.project_name)
                    }
                    (CcConnectLanguage::Zh, false) => format!(
                        "已切换到 CLI-Manager 项目：{}\n工作目录：{}\n远程连接将在数秒内重启。",
                        outcome.project_name, outcome.project_path
                    ),
                    (CcConnectLanguage::En, false) => format!(
                        "Switched to CLI-Manager project: {}\nWorking directory: {}\nRemote access will restart in a few seconds.",
                        outcome.project_name, outcome.project_path
                    ),
                };
                (message, outcome.restart_required)
            }
            Err(err) => (
                match language {
                    CcConnectLanguage::Zh => format!("切换 CLI-Manager 项目失败：{err}"),
                    CcConnectLanguage::En => {
                        format!("Failed to switch CLI-Manager project: {err}")
                    }
                },
                false,
            ),
        };
        if let Err(err) = write_file_atomically(
            &result_path,
            message.as_bytes(),
            "cc-connect project switch result",
        ) {
            log::warn!("write cc-connect project switch result failed: {err}");
        }
        if restart_required {
            std::thread::sleep(REMOTE_SWITCH_RESTART_DELAY);
            if let Err(err) = manager.restart() {
                log::warn!("restart cc-connect after remote project switch failed: {err}");
            }
        }
    });
    true
}

fn format_and_check_config_syntax(executable: &Path, config: &Path) -> Result<(), String> {
    let mut command = silent_command(&path_string(executable));
    command.args(["config", "format", "--config"]).arg(config);
    let output = output_with_timeout(command, CONFIG_FORMAT_TIMEOUT)
        .map_err(|err| format!("cc-connect config syntax check failed: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "cc-connect could not parse managed config: {}",
        output_text(&output.stdout, &output.stderr)
    ))
}

fn spawn_log_reader<R: Read + Send + 'static>(
    reader: R,
    source: &'static str,
    logs: Arc<Mutex<CcConnectLogBuffer>>,
    writer: SharedLogWriter,
    secrets: Arc<Vec<String>>,
) {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0u8; 4 * 1024];
        let mut line = Vec::with_capacity(4 * 1024);
        let mut truncated = false;
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => {
                    push_captured_log_line(&logs, &writer, source, &line, truncated, &secrets);
                    break;
                }
                Ok(read) => {
                    for byte in &chunk[..read] {
                        if *byte == b'\n' {
                            push_captured_log_line(
                                &logs, &writer, source, &line, truncated, &secrets,
                            );
                            line.clear();
                            truncated = false;
                        } else if *byte != b'\r' {
                            if line.len() < MAX_CAPTURED_LOG_LINE_BYTES {
                                line.push(*byte);
                            } else {
                                truncated = true;
                            }
                        }
                    }
                }
                Err(err) => {
                    push_log_line(
                        &logs,
                        &writer,
                        "system",
                        &format!("cc-connect {source} reader failed: {err}"),
                        &[],
                    );
                    break;
                }
            }
        }
    });
}

fn push_captured_log_line(
    logs: &Arc<Mutex<CcConnectLogBuffer>>,
    writer: &SharedLogWriter,
    source: &str,
    bytes: &[u8],
    truncated: bool,
    secrets: &[String],
) {
    if bytes.is_empty() && !truncated {
        return;
    }
    let mut line = String::from_utf8_lossy(bytes).to_string();
    if truncated {
        line.push_str("...[truncated]");
    }
    push_log_line(logs, writer, source, &line, secrets);
}

fn push_log_line(
    logs: &Arc<Mutex<CcConnectLogBuffer>>,
    writer: &SharedLogWriter,
    source: &str,
    raw: &str,
    secrets: &[String],
) {
    let message = redact_log_line(raw, secrets);
    if let Ok(mut logs) = logs.lock() {
        logs.push(source, message.clone());
    }
    if let Ok(mut writer) = writer.lock() {
        if let Some(writer) = writer.as_mut() {
            let _ = writeln!(writer, "{} [{}] {}", now_millis(), source, message);
            let _ = writer.flush();
        }
    }
}

pub(crate) fn redact_log_line(raw: &str, secrets: &[String]) -> String {
    let mut value = raw.to_string();
    for secret in secrets.iter().filter(|secret| secret.len() >= 4) {
        value = value.replace(secret, "[REDACTED]");
    }
    let lower = value.to_ascii_lowercase();
    if [
        "token",
        "secret",
        "password",
        "api_key",
        "api key",
        "authorization",
        "bearer ",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword))
    {
        value = "[sensitive output redacted]".to_string();
    }
    const MAX_CHARS: usize = 4_000;
    if value.chars().count() > MAX_CHARS {
        value = value.chars().take(MAX_CHARS).collect::<String>() + "...";
    }
    value
}

#[tauri::command]
pub async fn cc_connect_get_status(
    manager: State<'_, CcConnectManager>,
    refresh_detection: Option<bool>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.status(refresh_detection.unwrap_or(false)))
        .await
        .map_err(|err| format!("cc-connect status task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_inspect_executable(
    manager: State<'_, CcConnectManager>,
    executable_path: String,
) -> Result<CcConnectExecutableStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.inspect_executable(&executable_path))
        .await
        .map_err(|err| format!("cc-connect executable inspection task failed: {err}"))
}

#[tauri::command]
pub async fn cc_connect_check_update(
    request: update::CcConnectCheckUpdateRequest,
) -> Result<update::CcConnectUpdateCheck, String> {
    update::check_update(request).await
}

#[tauri::command]
pub async fn cc_connect_update(
    manager: State<'_, CcConnectManager>,
    request: update::CcConnectInstallUpdateRequest,
) -> Result<update::CcConnectUpdateResult, String> {
    let prepared = update::prepare_update(request).await?;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.apply_prepared_update(prepared))
        .await
        .map_err(|err| format!("cc-connect update task failed: {err}"))?
}

#[tauri::command]
pub async fn cc_connect_save_profile(
    manager: State<'_, CcConnectManager>,
    request: CcConnectSaveProfileRequest,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.save_profile(request)?;
        manager.status(true)
    })
    .await
    .map_err(|err| format!("cc-connect save task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_clear_credentials(
    manager: State<'_, CcConnectManager>,
    platform: Option<CcConnectPlatform>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.clear_credentials(platform)?;
        manager.status(false)
    })
    .await
    .map_err(|err| format!("cc-connect credential task failed: {err}"))?
}

#[tauri::command]
pub async fn cc_connect_weixin_authorization_start(
    manager: State<'_, CcConnectManager>,
    request: CcConnectWeixinAuthorizeRequest,
) -> Result<CcConnectWeixinAuthorizationStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start_weixin_authorization(request))
        .await
        .map_err(|err| format!("Weixin authorization start task failed: {err}"))?
}

#[tauri::command]
pub async fn cc_connect_weixin_authorization_status(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectWeixinAuthorizationStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.weixin_authorization_status())
        .await
        .map_err(|err| format!("Weixin authorization status task failed: {err}"))?
}

#[tauri::command]
pub async fn cc_connect_weixin_authorization_cancel(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectWeixinAuthorizationStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.cancel_weixin_authorization())
        .await
        .map_err(|err| format!("Weixin authorization cancel task failed: {err}"))?
}

#[tauri::command]
pub async fn cc_connect_start(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.start()?;
        manager.status(false)
    })
    .await
    .map_err(|err| format!("cc-connect start task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_stop(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.stop()?;
        manager.status(false)
    })
    .await
    .map_err(|err| format!("cc-connect stop task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_restart(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.restart()?;
        manager.status(false)
    })
    .await
    .map_err(|err| format!("cc-connect restart task failed: {err}"))?
}
#[tauri::command]
pub fn cc_connect_get_logs(
    manager: State<'_, CcConnectManager>,
    after_seq: Option<u64>,
    limit: Option<usize>,
) -> Result<CcConnectLogPage, String> {
    manager.log_page(after_seq, limit)
}

pub fn auto_start(app: &AppHandle) -> Result<(), String> {
    app.state::<CcConnectManager>().auto_start_if_enabled()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile(project_path: &Path) -> CcConnectProfile {
        CcConnectProfile {
            auto_start: false,
            executable_path: None,
            project_id: "project-1".to_string(),
            project_name: "Example".to_string(),
            project_path: path_string(project_path),
            agent: CcConnectAgent::Claude,
            runtime_project_id: None,
            platform: CcConnectPlatform::Telegram,
            allow_from: "123456789".to_string(),
            platforms: Vec::new(),
            yolo_enabled: false,
            max_turn_time_mins: DEFAULT_MAX_TURN_TIME_MINS,
            proxy_enabled: true,
            proxy_url: None,
            logging_enabled: false,
            language: CcConnectLanguage::Zh,
            cc_switch_db_path: None,
            codex_config_dir: None,
        }
    }

    fn sample_registered_project(id: &str, name: &str, project_path: &Path) -> RegisteredProject {
        RegisteredProject {
            id: id.to_string(),
            name: name.to_string(),
            path: path_string(project_path),
            agent: CcConnectAgent::Claude,
            cli_tool: "claude".to_string(),
            cli_args: String::new(),
            group_path: Vec::new(),
            provider_id: None,
            codex_provider_id: None,
            provider_name: None,
            provider_is_global: true,
            environment_type: "local".to_string(),
            ssh_host_id: None,
            remote_path: String::new(),
            cli_config_root: String::new(),
            env_vars: "{}".to_string(),
        }
    }

    #[test]
    fn control_profile_detaches_connection_settings_from_project_paths() {
        let control = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let control_path = control.path().canonicalize().unwrap();
        let mut profile = sample_profile(project.path());
        profile.runtime_project_id = Some("  project-2  ".to_string());

        assert!(set_control_profile_values(&mut profile, &control_path));
        assert_eq!(profile.project_id, CONTROL_PROJECT_ID);
        assert_eq!(profile.project_name, CONTROL_PROJECT_NAME);
        assert_eq!(profile.project_path, user_path_string(&control_path));
        assert_eq!(profile.agent, CcConnectAgent::Codex);
        assert_eq!(profile.runtime_project_id.as_deref(), Some("project-2"));
        assert!(!set_control_profile_values(&mut profile, &control_path));
    }

    #[test]
    fn legacy_platform_state_is_copied_to_the_control_identity() {
        let root = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let control = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.project_id = "legacy-project".to_string();
        profile.project_name = "Legacy".to_string();

        let source_session = handoff_session::cc_session_store_path(
            root.path(),
            &profile.project_name,
            &profile.project_path,
        )
        .unwrap();
        fs::create_dir_all(source_session.parent().unwrap()).unwrap();
        fs::write(&source_session, br#"{"active":"s1","sessions":{}}"#).unwrap();
        let source_weixin =
            weixin_account_dir_at(root.path(), &profile.project_name, &profile.project_id);
        fs::create_dir_all(&source_weixin).unwrap();
        fs::write(
            source_weixin.join("context_tokens.json"),
            br#"{"user":"token"}"#,
        )
        .unwrap();
        fs::write(source_weixin.join("get_updates.buf"), b"cursor").unwrap();

        migrate_legacy_profile_state_at(&profile, control.path(), root.path()).unwrap();

        let target_session = handoff_session::cc_session_store_path(
            root.path(),
            CONTROL_PROJECT_NAME,
            &user_path_string(control.path()),
        )
        .unwrap();
        assert_eq!(
            fs::read(target_session).unwrap(),
            br#"{"active":"s1","sessions":{}}"#
        );
        let target_weixin =
            weixin_account_dir_at(root.path(), CONTROL_PROJECT_NAME, CONTROL_PROJECT_ID);
        assert_eq!(
            fs::read(target_weixin.join("context_tokens.json")).unwrap(),
            br#"{"user":"token"}"#
        );
        assert_eq!(
            fs::read(target_weixin.join("get_updates.buf")).unwrap(),
            b"cursor"
        );
    }

    #[test]
    fn project_list_uses_standby_copy_without_a_runtime_target() {
        let project = tempfile::tempdir().unwrap();
        let profile = sample_profile(project.path());
        let list = render_project_list(
            &profile,
            &[sample_registered_project(
                "project-1",
                "Example",
                project.path(),
            )],
        );
        assert!(list.contains("等待宠物选择托管会话"));
        assert!(!list.contains("[当前]"));
    }

    fn sample_group(
        id: &str,
        name: &str,
        parent_id: Option<&str>,
        sort_order: i64,
    ) -> RegisteredGroup {
        RegisteredGroup {
            id: id.to_string(),
            name: name.to_string(),
            parent_id: parent_id.map(str::to_string),
            sort_order,
        }
    }

    fn sample_project_row(
        id: &str,
        name: &str,
        project_path: &Path,
        agent: CcConnectAgent,
        group_id: Option<&str>,
        sort_order: i64,
        provider_overrides: &str,
    ) -> RegisteredProjectRow {
        RegisteredProjectRow {
            id: id.to_string(),
            name: name.to_string(),
            path: path_string(project_path),
            agent,
            cli_tool: default_agent_command(agent).to_string(),
            cli_args: String::new(),
            group_id: group_id.map(str::to_string),
            sort_order,
            provider_overrides: provider_overrides.to_string(),
            environment_type: "local".to_string(),
            ssh_host_id: None,
            remote_path: String::new(),
            cli_config_root: String::new(),
            host_codex_config_root: String::new(),
            env_vars: "{}".to_string(),
        }
    }
    #[test]
    fn parses_supported_and_unsupported_versions() {
        assert_eq!(
            parse_version("cc-connect v1.4.1 (commit abc)"),
            Some(("1.4.1".to_string(), true))
        );
        assert_eq!(
            parse_version("cc-connect v1.3.9"),
            Some(("1.3.9".to_string(), false))
        );
        assert_eq!(
            parse_version("cc-connect v1.4.2"),
            Some(("1.4.2".to_string(), true))
        );
        assert_eq!(
            parse_version("cc-connect v1.5.0-beta.2 (commit abc)"),
            Some(("1.5.0-beta.2".to_string(), true))
        );
        assert_eq!(
            parse_version("cc-connect v2.0.0"),
            Some(("2.0.0".to_string(), false))
        );
        assert_eq!(
            trusted_binary_version(VERIFIED_V1_4_1_BINARY_SHA256[0]).as_deref(),
            Some("1.4.1")
        );
        assert_eq!(
            trusted_binary_version(
                "0000000000000000000000000000000000000000000000000000000000000000"
            ),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn executable_atomic_write_sets_and_repairs_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("codex");
        let payload = b"#!/bin/sh\nexit 0\n";

        write_executable_file_atomically_if_changed(&path, payload, "test wrapper").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );

        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&path, permissions).unwrap();
        write_executable_file_atomically_if_changed(&path, payload, "test wrapper").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_codex_launcher_resolution_skips_the_managed_wrapper() {
        let directory = tempfile::tempdir().unwrap();
        let wrapper_dir = directory.path().join("managed");
        let launcher_dir = directory.path().join("real");
        fs::create_dir_all(&wrapper_dir).unwrap();
        fs::create_dir_all(&launcher_dir).unwrap();
        let wrapper = wrapper_dir.join("codex");
        let launcher = launcher_dir.join("codex");
        write_executable_file_atomically_if_changed(&wrapper, b"#!/bin/sh\nexit 0\n", "wrapper")
            .unwrap();
        write_executable_file_atomically_if_changed(&launcher, b"#!/bin/sh\nexit 0\n", "launcher")
            .unwrap();
        let path_value = env::join_paths([&wrapper_dir, &launcher_dir]).unwrap();

        let resolved = resolve_codex_launcher_from_path(&wrapper_dir, &path_value).unwrap();

        assert_eq!(resolved, launcher.canonicalize().unwrap());
    }
    #[test]
    fn allowlist_is_fail_closed_and_normalized() {
        assert_eq!(
            normalize_allow_from(
                CcConnectPlatform::Telegram,
                "123456789, 987654321,123456789"
            )
            .unwrap(),
            "123456789,987654321"
        );
        assert!(normalize_allow_from(CcConnectPlatform::Telegram, "*").is_err());
        assert!(normalize_allow_from(CcConnectPlatform::Telegram, "alice").is_err());
        assert_eq!(
            normalize_allow_from(CcConnectPlatform::Feishu, "ou_owner").unwrap(),
            "ou_owner"
        );
        assert_eq!(
            normalize_allow_from(CcConnectPlatform::Weixin, "owner@im.wechat").unwrap(),
            "owner@im.wechat"
        );
        assert!(normalize_allow_from(CcConnectPlatform::Weixin, "owner").is_err());
        assert_eq!(
            normalize_allow_from(CcConnectPlatform::Wecom, "zhangsan, lisi").unwrap(),
            "zhangsan,lisi"
        );
        assert!(normalize_allow_from(CcConnectPlatform::Wecom, "*").is_err());
    }

    #[test]
    fn profile_without_yolo_field_defaults_to_safe_mode() {
        let project = tempfile::tempdir().unwrap();
        let mut value = serde_json::to_value(sample_profile(project.path())).unwrap();
        value.as_object_mut().unwrap().remove("yoloEnabled");
        let profile: CcConnectProfile = serde_json::from_value(value).unwrap();
        assert!(!profile.yolo_enabled);
    }

    #[test]
    fn profile_without_max_turn_time_defaults_to_fifteen_minutes() {
        let project = tempfile::tempdir().unwrap();
        let mut value = serde_json::to_value(sample_profile(project.path())).unwrap();
        value.as_object_mut().unwrap().remove("maxTurnTimeMins");

        let profile: CcConnectProfile = serde_json::from_value(value).unwrap();

        assert_eq!(profile.max_turn_time_mins, DEFAULT_MAX_TURN_TIME_MINS);
    }

    #[test]
    fn managed_config_preserves_supported_turn_time_boundaries() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());

        for expected in [0, MAX_TURN_TIME_MINS] {
            profile.max_turn_time_mins = expected;
            let config = build_managed_config(
                &profile,
                Path::new(r"C:\Users\test\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            )
            .unwrap();

            assert_eq!(config.max_turn_time_mins, expected);
        }
    }

    #[test]
    fn profile_rejects_turn_time_above_maximum_before_io() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.max_turn_time_mins = MAX_TURN_TIME_MINS + 1;

        let error = normalize_profile(&CcConnectManager::new(), profile).unwrap_err();

        assert_eq!(
            error,
            format!("max_turn_time_mins must be between 0 and {MAX_TURN_TIME_MINS}")
        );
    }

    #[test]
    fn codex_app_server_help_requires_stdio_transport() {
        assert!(codex_app_server_help_supported(
            "Usage: codex app-server [OPTIONS]\n--listen <URL>\n[default: stdio://]"
        ));
        assert!(!codex_app_server_help_supported(
            "Usage: codex app-server [OPTIONS]\n--listen <URL>"
        ));
    }
    #[test]
    fn proxy_url_is_normalized_and_rejects_unsafe_values() {
        assert_eq!(
            normalize_proxy_url(Some(" http://127.0.0.1:10808 ")).unwrap(),
            Some("http://127.0.0.1:10808/".to_string())
        );
        assert_eq!(
            normalize_proxy_url(Some("socks5h://proxy.example.com:7890")).unwrap(),
            Some("socks5h://proxy.example.com:7890".to_string())
        );
        assert_eq!(normalize_proxy_url(Some("   ")).unwrap(), None);
        assert!(normalize_proxy_url(Some("ftp://proxy.example.com:21")).is_err());
        assert!(normalize_proxy_url(Some("http://user:secret@proxy.example.com:8080")).is_err());
        assert!(normalize_proxy_url(Some("http://")).is_err());
    }
    #[test]
    fn local_proxy_detection_uses_the_first_reachable_port() {
        let first = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let second = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let first_port = first.local_addr().unwrap().port();
        let second_port = second.local_addr().unwrap().port();
        assert_eq!(
            detect_local_proxy_on_ports(&[first_port, second_port]),
            Some(format!("http://127.0.0.1:{first_port}/"))
        );
        assert_eq!(
            detect_local_proxy_on_ports(&[0, second_port]),
            Some(format!("http://127.0.0.1:{second_port}/"))
        );
        assert_eq!(detect_local_proxy_on_ports(&[]), None);
    }
    #[test]
    fn configured_proxy_takes_priority_over_local_detection() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let local_port = listener.local_addr().unwrap().port();
        assert_eq!(
            resolve_proxy_url(Some("https://proxy.example.com:8443"), &[local_port]).unwrap(),
            Some(ResolvedProxy {
                url: "https://proxy.example.com:8443/".to_string(),
                source: ProxySource::Configured,
            })
        );
    }
    #[test]
    fn legacy_profile_without_switch_fields_remains_compatible() {
        let project_dir = tempfile::tempdir().unwrap();
        let mut value = serde_json::to_value(sample_profile(project_dir.path())).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("proxyEnabled");
        object.remove("proxyUrl");
        object.remove("loggingEnabled");
        object.remove("platforms");
        let mut profile: CcConnectProfile = serde_json::from_value(value).unwrap();
        assert!(profile.proxy_enabled);
        assert_eq!(profile.proxy_url, None);
        assert!(!profile.logging_enabled);
        hydrate_profile_platforms(&mut profile);
        assert_eq!(enabled_platforms(&profile).len(), 1);
        assert_eq!(
            enabled_platforms(&profile)[0].platform,
            CcConnectPlatform::Telegram
        );
    }
    #[test]
    fn proxy_environment_covers_common_case_variants() {
        let environment = proxy_environment("http://127.0.0.1:7890/")
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            assert_eq!(
                environment.get(key).map(String::as_str),
                Some("http://127.0.0.1:7890/")
            );
        }
        assert_eq!(
            environment.get("NO_PROXY").map(String::as_str),
            Some("localhost,127.0.0.1,[::1]")
        );
    }
    #[test]
    fn disabled_proxy_ignores_manual_and_local_proxy_and_scrubs_inherited_environment() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let local_port = listener.local_addr().unwrap().port();
        let proxy = resolve_proxy_url_if_enabled(
            false,
            Some("http://proxy.example.com:8080"),
            &[local_port],
        )
        .unwrap();
        assert_eq!(proxy, None);

        let mut command = Command::new("cc-connect");
        for key in PROXY_ENV_KEYS {
            command.env(key, "http://inherited.example.com:3128");
        }
        apply_proxy_environment(&mut command, false, proxy.as_ref());
        let environment = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_ascii_lowercase(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        for key in ["http_proxy", "https_proxy", "all_proxy"] {
            assert!(environment.get(key).and_then(Option::as_ref).is_none());
        }
        assert_eq!(environment.get("no_proxy"), Some(&Some("*".to_string())));
    }
    #[test]
    fn disabled_proxy_does_not_validate_a_stored_manual_url() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.proxy_enabled = false;
        profile.proxy_url = Some("not a URL".to_string());
        assert!(!profile_issue_codes(&profile)
            .iter()
            .any(|code| code == "proxy_invalid"));
        profile.proxy_enabled = true;
        assert!(profile_issue_codes(&profile)
            .iter()
            .any(|code| code == "proxy_invalid"));
    }
    #[cfg(windows)]
    #[test]
    fn git_safe_directory_is_scoped_to_the_registered_project() {
        let environment =
            git_safe_directory_environment(Path::new(r"\\?\F:\test\work\amz\amazon"), Some("2"))
                .into_iter()
                .collect::<BTreeMap<_, _>>();

        assert_eq!(
            environment.get("GIT_CONFIG_COUNT").map(String::as_str),
            Some("3")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_KEY_2").map(String::as_str),
            Some("safe.directory")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_VALUE_2").map(String::as_str),
            Some("F:/test/work/amz/amazon")
        );
        assert!(!environment.contains_key("GIT_CONFIG_KEY_0"));
    }

    #[test]
    fn remote_git_safe_directory_is_scoped_to_the_registered_posix_path() {
        let environment = git_safe_directory_environment_for_value("/srv/project", Some("1"))
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            environment.get("GIT_CONFIG_COUNT").map(String::as_str),
            Some("2")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_KEY_1").map(String::as_str),
            Some("safe.directory")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_VALUE_1").map(String::as_str),
            Some("/srv/project")
        );
        assert!(!environment.contains_key("GIT_CONFIG_KEY_0"));
    }

    #[test]
    fn ssh_handoff_jump_routing_fails_closed_when_the_host_is_missing() {
        assert_eq!(
            selected_ssh_jump_host_id("none", None, "none").unwrap(),
            None
        );
        assert_eq!(
            selected_ssh_jump_host_id("host", None, "none").unwrap_err(),
            "handoff_ssh_jump_host_missing"
        );
        assert_eq!(
            selected_ssh_jump_host_id("host", Some("  jump-1  "), "none").unwrap(),
            Some("jump-1")
        );
        assert_eq!(
            selected_ssh_jump_host_id("host", None, "socks5").unwrap(),
            None
        );
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn config_paths_strip_windows_extended_prefixes() {
        assert_eq!(
            user_path_string(Path::new(r"\\?\D:\npm\cc-connect.exe")),
            r"D:\npm\cc-connect.exe"
        );
        assert_eq!(
            normalize_executable_path_value(Some(r"  \\?\D:\npm\cc-connect.exe  ")),
            Some(r"D:\npm\cc-connect.exe".to_string())
        );
        assert_eq!(
            config_path_value(Path::new(r"\\?\F:\test\work")),
            "F:/test/work"
        );
        assert_eq!(
            config_path_value(Path::new(r"\\?\UNC\server\share\repo")),
            "//server/share/repo"
        );
        assert_eq!(
            config_path_value(Path::new(r"F:\test\work")),
            "F:/test/work"
        );
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn explicit_executable_inspection_returns_a_user_path_and_digest() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("cc-connect.exe");
        fs::write(&executable, b"not an official cc-connect binary").unwrap();

        let status = CcConnectManager::new().inspect_executable(&path_string(&executable));

        assert!(status.installed);
        assert!(!status.compatible);
        assert_eq!(status.version, None);
        assert_eq!(status.sha256, Some(sha256_file(&executable).unwrap()));
        assert_eq!(
            status.executable_path,
            user_path_string(&executable.canonicalize().unwrap())
        );
        assert!(!status.executable_path.starts_with(r"\\?\"));
        assert_eq!(status.detection_error, None);
    }
    #[test]
    fn managed_config_is_safe() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.max_turn_time_mins = 60;
        let raw = toml::to_string(
            &build_managed_config(
                &profile,
                Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-switch.ps1"),
            )
            .unwrap(),
        )
        .unwrap();
        let value = toml::from_str::<toml::Value>(&raw).unwrap();
        assert_eq!(value["management"]["enabled"].as_bool(), Some(false));
        assert_eq!(value["max_turn_time_mins"].as_integer(), Some(60));
        assert_eq!(value["bridge"]["enabled"].as_bool(), Some(false));
        assert_eq!(value["webhook"]["enabled"].as_bool(), Some(false));
        assert_eq!(
            value["projects"][0]["agent"]["type"].as_str(),
            Some("claudecode")
        );
        assert_eq!(
            value["projects"][0]["agent"]["options"]["mode"].as_str(),
            Some("default")
        );
        let agent_options = value["projects"][0]["agent"]["options"].as_table().unwrap();
        assert!(!agent_options.contains_key("backend"));
        assert!(!agent_options.contains_key("app_server_url"));
        assert_eq!(
            value["projects"][0]["agent"]["options"]["env"][TELEGRAM_TOKEN_ENV].as_str(),
            Some("")
        );
        assert_eq!(
            value["projects"][0]["admin_from"].as_str(),
            Some("123456789")
        );
        let disabled = value["projects"][0]["disabled_commands"]
            .as_array()
            .unwrap();
        assert!(disabled.iter().any(|item| item.as_str() == Some("mode")));
        assert!(disabled.iter().any(|item| item.as_str() == Some("config")));
        assert!(disabled.iter().any(|item| item.as_str() == Some("dir")));
        assert!(disabled.iter().any(|item| item.as_str() == Some("shell")));
        assert!(!disabled.iter().any(|item| item.as_str() == Some("new")));
        assert_eq!(
            value["commands"][0]["name"].as_str(),
            Some("cli_manager_list")
        );
        assert_eq!(
            value["commands"][1]["name"].as_str(),
            Some("cli_manager_switch")
        );
        assert_eq!(value["commands"].as_array().unwrap().len(), 2);
        assert!(value["aliases"].as_array().unwrap().is_empty());
        let switch_exec = value["commands"][1]["exec"].as_str().unwrap();
        assert!(switch_exec.contains("cli-manager-switch.ps1"));
        assert!(switch_exec.contains("$raw=@'\n{{args:}}\n'@"));
        assert!(switch_exec.contains("ToBase64String"));
        assert!(!switch_exec.contains(&path_string(project.path())));
    }

    #[test]
    fn legacy_profile_migrates_to_a_single_enabled_platform() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());

        hydrate_profile_platforms(&mut profile);

        assert_eq!(profile.platforms.len(), CC_CONNECT_PLATFORMS.len());
        assert_eq!(
            enabled_platforms(&profile),
            vec![CcConnectPlatformProfile {
                platform: CcConnectPlatform::Telegram,
                enabled: true,
                allow_from: "123456789".to_string(),
            }]
        );
        assert_eq!(profile.allow_from, "123456789");
    }

    #[test]
    fn managed_config_keeps_multiple_enabled_platforms_online() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.platforms = vec![
            CcConnectPlatformProfile {
                platform: CcConnectPlatform::Telegram,
                enabled: true,
                allow_from: "123456789".to_string(),
            },
            CcConnectPlatformProfile {
                platform: CcConnectPlatform::Weixin,
                enabled: true,
                allow_from: "owner@im.wechat".to_string(),
            },
        ];
        let config = build_managed_config(
            &profile,
            Path::new(r"C:Users	estcli-manager-projects.txt"),
            Path::new(r"C:Users	estcli-manager-switch.ps1"),
        )
        .unwrap();
        let value = toml::from_str::<toml::Value>(&toml::to_string(&config).unwrap()).unwrap();
        let platforms = value["projects"][0]["platforms"].as_array().unwrap();

        assert_eq!(platforms.len(), 2);
        assert_eq!(platforms[0]["type"].as_str(), Some("telegram"));
        assert_eq!(platforms[1]["type"].as_str(), Some("weixin"));
        assert_eq!(
            value["projects"][0]["admin_from"].as_str(),
            Some("123456789,owner@im.wechat")
        );
    }

    #[test]
    fn managed_config_uses_cc_connect_native_weixin_and_wecom_platforms() {
        let project = tempfile::tempdir().unwrap();
        let render = |profile: &CcConnectProfile| {
            let config = build_managed_config(
                profile,
                Path::new(r"C:\Users\test\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            )
            .unwrap();
            toml::from_str::<toml::Value>(&toml::to_string(&config).unwrap()).unwrap()
        };

        let mut profile = sample_profile(project.path());
        profile.platform = CcConnectPlatform::Weixin;
        profile.allow_from = "owner@im.wechat".to_string();
        let weixin = render(&profile);
        assert_eq!(
            weixin["projects"][0]["platforms"][0]["type"].as_str(),
            Some("weixin")
        );
        assert_eq!(
            weixin["projects"][0]["platforms"][0]["options"]["token"].as_str(),
            Some("${CLI_MANAGER_CC_WEIXIN_TOKEN}")
        );
        assert_eq!(
            weixin["projects"][0]["platforms"][0]["options"]["account_id"].as_str(),
            Some("project-1")
        );

        profile.platform = CcConnectPlatform::Wecom;
        profile.allow_from = "zhangsan".to_string();
        let wecom = render(&profile);
        let options = &wecom["projects"][0]["platforms"][0]["options"];
        assert_eq!(
            wecom["projects"][0]["platforms"][0]["type"].as_str(),
            Some("wecom")
        );
        assert_eq!(options["mode"].as_str(), Some("websocket"));
        assert_eq!(
            options["bot_id"].as_str(),
            Some("${CLI_MANAGER_CC_WECOM_BOT_ID}")
        );
        assert_eq!(
            options["bot_secret"].as_str(),
            Some("${CLI_MANAGER_CC_WECOM_BOT_SECRET}")
        );
    }

    #[test]
    fn weixin_authorization_config_is_native_and_contains_no_credential() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.platform = CcConnectPlatform::Weixin;
        profile.allow_from = "authorization-pending@im.wechat".to_string();

        let raw = build_weixin_authorization_config(&profile).unwrap();
        let config: toml::Value = toml::from_str(&raw).unwrap();
        let options = &config["projects"][0]["platforms"][0]["options"];
        assert_eq!(
            config["projects"][0]["platforms"][0]["type"].as_str(),
            Some("weixin")
        );
        assert_eq!(options["token"].as_str(), Some(""));
        assert_eq!(options["allow_from"].as_str(), Some(""));
        assert!(!raw.contains(&format!("${{{WEIXIN_TOKEN_ENV}}}")));
    }

    #[test]
    fn weixin_authorization_result_is_parsed_and_allowlist_is_merged() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("setup.toml");
        fs::write(
            &config_path,
            r#"
[[projects]]
name = "amazon"

[[projects.platforms]]
type = "weixin"

[projects.platforms.options]
token = "test-ilink-token"
allow_from = "owner@im.wechat"
"#,
        )
        .unwrap();

        let result = parse_weixin_authorization_result(&config_path, "amazon").unwrap();
        assert_eq!(result.token, "test-ilink-token");
        assert_eq!(result.allow_from, "owner@im.wechat");
        assert_eq!(
            merge_weixin_allow_from("teammate@im.wechat", &result.allow_from).unwrap(),
            "teammate@im.wechat,owner@im.wechat"
        );

        fs::write(
            &config_path,
            r#"
[[projects]]
name = "amazon"
[[projects.platforms]]
type = "weixin"
[projects.platforms.options]
token = "must-not-leak"
allow_from = ""
"#,
        )
        .unwrap();
        let error = parse_weixin_authorization_result(&config_path, "amazon").unwrap_err();
        assert_eq!(error, "Weixin authorization user ID is missing");
        assert!(!error.contains("must-not-leak"));
    }

    fn sample_remote_codex_launch(provider: bool) -> RemoteCodexLaunch {
        let provider = provider.then(|| RemoteCodexProviderLaunch {
            name: "Project Provider".to_string(),
            profile_name: "cli-manager-project-provider-123".to_string(),
            model_provider: "custom".to_string(),
            provider_name_override: "model_providers.custom.name=CLI-Manager remote".to_string(),
            model: Some("gpt-5.4".to_string()),
            models: vec!["gpt-5.4".to_string(), "gpt-5.3-codex".to_string()],
            base_url_override: "model_providers.custom.base_url=https://provider.example.com/v1"
                .to_string(),
            env_key_override: "model_providers.custom.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY"
                .to_string(),
            model_override: Some("model=gpt-5.4".to_string()),
            wire_api_override: "model_providers.custom.wire_api=responses".to_string(),
            env_key: "CLI_MANAGER_CODEX_PROVIDER_API_KEY".to_string(),
            secret: "sk-provider-secret".to_string(),
        });
        RemoteCodexLaunch {
            wrapper_dir: PathBuf::from(r"C:\Users\test\.cli-manager\remote-manager\bin"),
            launcher: Some(PathBuf::from(r"D:\npm\codex.cmd")),
            launcher_args: vec![
                "--config".to_string(),
                "model_reasoning_effort=high".to_string(),
            ],
            proxy_executable: PathBuf::from(r"C:\Program Files\CLI-Manager\cli-manager.exe"),
            expected_session_id: Some("thread-original".to_string()),
            codex_home: Some(PathBuf::from(r"C:\Users\test\.codex")),
            discovery_codex_home: provider.is_some().then(|| {
                PathBuf::from(r"C:\Users\test\.cli-manager\remote-manager\codex-model-discovery")
            }),
            provider,
            ssh_launch: None,
        }
    }

    #[test]
    fn managed_codex_config_forwards_provider_key_without_persisting_secret() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.agent = CcConnectAgent::Codex;
        let launch = sample_remote_codex_launch(true);
        let raw = toml::to_string_pretty(
            &build_managed_config_with_codex(
                &profile,
                Path::new(r"C:\Users\test\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
                Some(&launch),
            )
            .unwrap(),
        )
        .unwrap();
        let config = toml::from_str::<toml::Value>(&raw).unwrap();
        let agent = &config["projects"][0]["agent"];
        assert_eq!(agent["options"]["model"].as_str(), Some("gpt-5.4"));
        assert_eq!(
            agent["options"]["codex_home"].as_str(),
            Some("C:/Users/test/.codex")
        );
        assert!(!agent["options"]
            .as_table()
            .unwrap()
            .contains_key("provider"));
        assert!(!agent.as_table().unwrap().contains_key("providers"));
        assert_eq!(
            agent["options"]["env"]["CLI_MANAGER_CODEX_PROVIDER_API_KEY"].as_str(),
            Some("${CLI_MANAGER_CODEX_PROVIDER_API_KEY}")
        );
        for secret in [
            "sk-provider-secret",
            "https://provider.example.com/v1",
            "Project Provider",
        ] {
            assert!(!raw.contains(secret));
        }
    }

    #[test]
    fn codex_model_discovery_catalog_is_isolated_and_contains_no_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let launch = sample_remote_codex_launch(true);
        let provider = launch.provider.as_ref().unwrap();
        write_codex_model_discovery_home(directory.path(), None, provider).unwrap();

        let config = fs::read_to_string(directory.path().join(CONFIG_FILE_NAME)).unwrap();
        let config = toml::from_str::<toml::Value>(&config).unwrap();
        assert_eq!(
            config["model_catalog_json"].as_str(),
            Some(CODEX_MODEL_CATALOG_FILE_NAME)
        );
        let raw_catalog =
            fs::read_to_string(directory.path().join(CODEX_MODEL_CATALOG_FILE_NAME)).unwrap();
        let catalog = serde_json::from_str::<serde_json::Value>(&raw_catalog).unwrap();
        assert_eq!(catalog["models"][0]["slug"], "gpt-5.4");
        assert_eq!(catalog["models"][1]["slug"], "gpt-5.3-codex");
        assert_eq!(catalog["models"][0]["description"], "Project Provider");
        assert_eq!(catalog["models"][0]["visibility"], "list");
        assert_eq!(catalog["models"][0]["supported_in_api"], true);
        assert_eq!(catalog["models"][0]["default_reasoning_level"], "medium");
        assert!(catalog["models"][0]["supported_reasoning_levels"]
            .as_array()
            .is_some_and(|levels| !levels.is_empty()));
        assert_eq!(catalog["models"][0]["shell_type"], "shell_command");
        assert!(catalog["models"][0]["base_instructions"]
            .as_str()
            .is_some_and(|instructions| !instructions.is_empty()));
        assert_eq!(catalog["models"][0]["input_modalities"][0], "text");
        for secret in [
            "sk-provider-secret",
            "https://provider.example.com/v1",
            "CLI_MANAGER_CODEX_PROVIDER_API_KEY",
        ] {
            assert!(!raw_catalog.contains(secret));
        }
    }

    #[test]
    fn codex_model_discovery_reuses_installed_catalog_capabilities() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let mut cached_model = fallback_codex_model_catalog_entry();
        cached_model["slug"] = "gpt-5.4".into();
        cached_model["display_name"] = "gpt-5.4".into();
        cached_model["description"] = "Installed model".into();
        cached_model["base_instructions"] = "installed Codex instructions".into();
        cached_model["context_window"] = 123_456.into();
        fs::write(
            source.path().join(CODEX_MODELS_CACHE_FILE_NAME),
            serde_json::to_vec(&serde_json::json!({ "models": [cached_model] })).unwrap(),
        )
        .unwrap();

        let launch = sample_remote_codex_launch(true);
        let provider = launch.provider.as_ref().unwrap();
        write_codex_model_discovery_home(destination.path(), Some(source.path()), provider)
            .unwrap();
        let catalog = serde_json::from_slice::<serde_json::Value>(
            &fs::read(destination.path().join(CODEX_MODEL_CATALOG_FILE_NAME)).unwrap(),
        )
        .unwrap();

        assert_eq!(catalog["models"][0]["slug"], "gpt-5.4");
        assert_eq!(catalog["models"][1]["slug"], "gpt-5.3-codex");
        assert_eq!(
            catalog["models"][0]["base_instructions"],
            "installed Codex instructions"
        );
        assert_eq!(
            catalog["models"][1]["base_instructions"],
            "installed Codex instructions"
        );
        assert_eq!(catalog["models"][1]["context_window"], 123_456);
        assert_eq!(catalog["models"][0]["priority"], 0);
        assert_eq!(catalog["models"][1]["priority"], 1);
    }

    #[test]
    fn codex_model_discovery_parses_filters_and_deduplicates_models() {
        assert_eq!(
            codex_models_endpoint("https://provider.example.com/v1")
                .unwrap()
                .as_str(),
            "https://provider.example.com/v1/models"
        );
        let discovered = parse_codex_models_response(
            br#"{"data":[{"id":"gpt-5.4"},{"id":"text-embedding-3-large"},{"id":"deepseek-r1"},{"model":"gpt-5.3-codex"},{"id":"gpt-5.4"}]}"#,
        );
        assert_eq!(
            normalize_managed_codex_models(Some("gpt-5.4"), discovered),
            vec![
                "gpt-5.4".to_string(),
                "deepseek-r1".to_string(),
                "gpt-5.3-codex".to_string(),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn codex_launch_environment_forces_provider_without_embedding_secrets() {
        let mut command = Command::new("cc-connect");
        let launch = sample_remote_codex_launch(true);
        apply_remote_codex_launch_environment(&mut command, &launch).unwrap();
        let environment = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            environment.get(CODEX_BASE_URL_OVERRIDE_ENV),
            Some(&Some(
                "model_providers.custom.base_url=https://provider.example.com/v1".to_string()
            ))
        );
        assert_eq!(
            environment.get(CODEX_PROFILE_NAME_ENV),
            Some(&Some("cli-manager-project-provider-123".to_string()))
        );
        assert_eq!(
            environment.get(CODEX_MODEL_PROVIDER_ENV),
            Some(&Some("custom".to_string()))
        );
        assert_eq!(
            environment.get(CODEX_PROVIDER_NAME_OVERRIDE_ENV),
            Some(&Some(
                "model_providers.custom.name=CLI-Manager remote".to_string()
            ))
        );
        assert_eq!(
            environment.get(CODEX_MODEL_OVERRIDE_ENV),
            Some(&Some("model=gpt-5.4".to_string()))
        );
        assert_eq!(
            environment.get("CODEX_HOME"),
            Some(&Some(r"C:\Users\test\.codex".to_string()))
        );
        assert_eq!(
            environment.get(CODEX_MODEL_CATALOG_OVERRIDE_ENV),
            Some(&Some(
                codex_model_catalog_override(launch.discovery_codex_home.as_deref().unwrap())
                    .unwrap()
            ))
        );
        assert_eq!(
            launch.codex_home.as_deref(),
            Some(Path::new(r"C:\Users\test\.codex"))
        );
        assert_eq!(
            environment.get(EXPECTED_SESSION_ID_ENV),
            Some(&Some("thread-original".to_string()))
        );
        assert_eq!(
            environment.get(CODEX_LAUNCHER_ARGS_ENV),
            Some(&Some(serde_json::to_string(&launch.launcher_args).unwrap()))
        );
        assert!(!environment
            .values()
            .flatten()
            .any(|value| value == "sk-provider-secret"));
    }

    #[cfg(windows)]
    #[test]
    fn codex_launch_environment_clears_provider_overrides_when_unregistered() {
        let mut command = Command::new("cc-connect");
        let launch = sample_remote_codex_launch(false);
        apply_remote_codex_launch_environment(&mut command, &launch).unwrap();
        let environment = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        for key in [
            CODEX_PROFILE_NAME_ENV,
            CODEX_MODEL_PROVIDER_ENV,
            CODEX_PROVIDER_NAME_OVERRIDE_ENV,
            CODEX_BASE_URL_OVERRIDE_ENV,
            CODEX_ENV_KEY_OVERRIDE_ENV,
            CODEX_MODEL_CATALOG_OVERRIDE_ENV,
            CODEX_MODEL_OVERRIDE_ENV,
            CODEX_WIRE_API_OVERRIDE_ENV,
        ] {
            assert_eq!(environment.get(key), Some(&None));
        }
        assert_eq!(
            environment.get(CODEX_LAUNCHER_ENV),
            Some(&Some(r"D:\npm\codex.cmd".to_string()))
        );
    }

    #[cfg(windows)]
    #[test]
    fn codex_launch_environment_omits_empty_registered_launcher_args() {
        let mut command = Command::new("cc-connect");
        let mut launch = sample_remote_codex_launch(false);
        launch.launcher_args.clear();
        apply_remote_codex_launch_environment(&mut command, &launch).unwrap();
        let environment = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(environment.get(CODEX_LAUNCHER_ARGS_ENV), Some(&None));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_codex_proxy_is_copied_atomically_and_refreshed() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("cli-manager-codex-proxy.exe");
        let destination = directory.path().join("bin").join("codex.exe");
        fs::write(&source, b"proxy-v1").unwrap();
        copy_file_atomically_if_changed(&source, &destination, "test proxy").unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"proxy-v1");

        fs::write(&source, b"proxy-v2").unwrap();
        copy_file_atomically_if_changed(&source, &destination, "test proxy").unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"proxy-v2");
    }

    #[test]
    fn codex_app_server_overrides_reject_command_injection_characters() {
        assert_eq!(
            codex_base_url_override("custom", "https://provider.example.com/v1").unwrap(),
            "model_providers.custom.base_url=https://provider.example.com/v1"
        );
        assert!(
            codex_base_url_override("custom", "https://provider.example.com/v1?x=1&whoami")
                .is_err()
        );
        assert!(codex_base_url_override("custom", "file:///tmp/provider").is_err());
        assert!(codex_env_key_override("custom", "OPENAI_API_KEY").is_ok());
        assert!(codex_env_key_override("custom", "OPENAI_API_KEY & whoami").is_err());
        assert_eq!(
            codex_wire_api_override("custom", None).unwrap(),
            "model_providers.custom.wire_api=responses"
        );
        assert_eq!(codex_model_override(None).unwrap(), None);
        assert!(codex_model_override(Some("gpt-5.4\" & whoami")).is_err());
    }

    #[test]
    fn codex_provider_probe_reports_startup_errors_without_leaking_secrets() {
        let detail = redact_remote_codex_probe_output(
            &sample_remote_codex_launch(true),
            b"",
            b"provider startup rejected sk-provider-secret",
        );
        assert!(detail.contains("provider startup rejected"));
        assert!(!detail.contains("sk-provider-secret"));
        assert!(detail.contains("[REDACTED]"));
    }

    #[test]
    fn codex_provider_probe_uses_strict_config_only_for_managed_catalog() {
        assert_eq!(
            codex_app_server_probe_args(true),
            vec!["app-server", "--strict-config", "--listen", "stdio://"]
        );
        assert_eq!(
            codex_app_server_probe_args(false),
            vec!["app-server", "--listen", "stdio://"]
        );
    }

    #[test]
    fn codex_uses_app_server_approvals_and_yolo_is_explicit() {
        let project = tempfile::tempdir().unwrap();
        let render = |profile: &CcConnectProfile| {
            let raw = toml::to_string(
                &build_managed_config(
                    profile,
                    Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-projects.txt"),
                    Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-switch.ps1"),
                )
                .unwrap(),
            )
            .unwrap();
            toml::from_str::<toml::Value>(&raw).unwrap()
        };

        let mut profile = sample_profile(project.path());
        profile.agent = CcConnectAgent::Codex;
        let safe = render(&profile);
        let safe_options = safe["projects"][0]["agent"]["options"].as_table().unwrap();
        assert_eq!(safe_options["mode"].as_str(), Some("suggest"));
        assert_eq!(safe_options["backend"].as_str(), Some("app_server"));
        assert_eq!(safe_options["app_server_url"].as_str(), Some("stdio://"));

        profile.yolo_enabled = true;
        let codex_yolo = render(&profile);
        assert_eq!(
            codex_yolo["projects"][0]["agent"]["options"]["mode"].as_str(),
            Some("yolo")
        );

        profile.agent = CcConnectAgent::Claude;
        let claude_yolo = render(&profile);
        let claude_options = claude_yolo["projects"][0]["agent"]["options"]
            .as_table()
            .unwrap();
        assert_eq!(claude_options["mode"].as_str(), Some("bypassPermissions"));
        assert!(!claude_options.contains_key("backend"));
        assert!(!claude_options.contains_key("app_server_url"));
    }

    #[test]
    fn managed_agent_config_maps_all_supported_handoff_agents() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        for (agent, kind, safe_mode, rpc) in [
            (CcConnectAgent::Claude, "claudecode", "default", None),
            (CcConnectAgent::Codex, "codex", "suggest", None),
            (CcConnectAgent::Pi, "pi", "default", Some(true)),
            (CcConnectAgent::Opencode, "opencode", "default", None),
        ] {
            profile.agent = agent;
            let raw = toml::to_string(
                &build_managed_config(
                    &profile,
                    Path::new(r"C:\Users\test\cli-manager-projects.txt"),
                    Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
                )
                .unwrap(),
            )
            .unwrap();
            let config = toml::from_str::<toml::Value>(&raw).unwrap();
            let managed_agent = &config["projects"][0]["agent"];
            assert_eq!(managed_agent["type"].as_str(), Some(kind));
            assert_eq!(managed_agent["options"]["mode"].as_str(), Some(safe_mode));
            assert_eq!(
                managed_agent["options"]
                    .as_table()
                    .unwrap()
                    .get("rpc")
                    .and_then(toml::Value::as_bool),
                rpc
            );
        }
    }

    #[test]
    fn registered_cli_tool_parser_accepts_supported_launchers_and_rejects_other_agents() {
        for (value, expected) in [
            ("claude", Some(CcConnectAgent::Claude)),
            (
                r#""D:\npm\codex.cmd" --profile managed"#,
                Some(CcConnectAgent::Codex),
            ),
            (r#"C:\tools\pi.bat --model test"#, Some(CcConnectAgent::Pi)),
            ("opencode.exe --continue", Some(CcConnectAgent::Opencode)),
            ("grok", None),
            ("npm run dev", None),
        ] {
            assert_eq!(cc_connect_agent_from_cli_tool(value), expected, "{value}");
        }
    }

    #[test]
    fn registered_launcher_parser_preserves_argv_and_rejects_shell_fragments() {
        assert_eq!(
            parse_registered_command(r#""D:\Tools\claude.cmd" --model "test model""#).unwrap(),
            vec![
                r#"D:\Tools\claude.cmd"#.to_string(),
                "--model".to_string(),
                "test model".to_string()
            ]
        );
        assert!(parse_registered_command("codex && whoami").is_err());
        assert_eq!(
            validate_registered_launcher_arguments(
                CcConnectAgent::Codex,
                &["resume".to_string(), "other-session".to_string()]
            ),
            Err("handoff_agent_launcher_session_arg".to_string())
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unix_codex_wrapper_routes_registered_launcher_args_through_proxy() {
        let payload = codex_profile_wrapper_payload();
        assert!(payload.contains(&format!("${{{CODEX_LAUNCHER_ARGS_ENV}:-}}")));
        assert_eq!(payload.matches(CODEX_PROXY_SUBCOMMAND).count(), 3);
    }

    #[test]
    fn managed_config_reuses_registered_launcher_for_non_codex_agents() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        let launcher = ResolvedAgentLauncher {
            executable: PathBuf::from(r"C:\Tools\claude.cmd"),
            args: vec!["--verbose".to_string()],
        };
        let settings_path = Path::new(r"C:\Users\test\.cli-manager\providers\settings.json");

        profile.agent = CcConnectAgent::Claude;
        let config = build_managed_config_with_agent_launch(
            &profile,
            Path::new(r"C:\Users\test\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            None,
            Some(&launcher),
            Some(settings_path),
            &BTreeMap::new(),
        )
        .unwrap();
        let raw = toml::to_string_pretty(&config).unwrap();
        let config = toml::from_str::<toml::Value>(&raw).unwrap();
        assert_eq!(
            config["projects"][0]["agent"]["options"]["cmd"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>(),
            vec![
                "C:/Tools/claude.cmd",
                "--verbose",
                "--settings",
                "C:/Users/test/.cli-manager/providers/settings.json"
            ]
        );

        for agent in [CcConnectAgent::Pi, CcConnectAgent::Opencode] {
            profile.agent = agent;
            let config = build_managed_config_with_agent_launch(
                &profile,
                Path::new(r"C:\Users\test\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
                None,
                Some(&launcher),
                None,
                &BTreeMap::new(),
            )
            .unwrap();
            let raw = toml::to_string_pretty(&config).unwrap();
            let config = toml::from_str::<toml::Value>(&raw).unwrap();
            assert_eq!(
                config["projects"][0]["agent"]["options"]["cmd"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .collect::<Vec<_>>(),
                vec!["C:/Tools/claude.cmd", "--verbose"]
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_launcher_uses_a_structured_host_command() {
        let command = managed_agent_command(&ResolvedAgentLauncher {
            executable: PathBuf::from(r"C:\Tools\pi.ps1"),
            args: vec!["--model".to_string(), "test".to_string()],
        });
        assert_eq!(
            command,
            vec![
                "powershell.exe",
                "-NoProfile",
                "-File",
                "C:/Tools/pi.ps1",
                "--model",
                "test"
            ]
        );
    }

    #[test]
    fn managed_claude_snapshot_uses_structured_cmd_without_persisting_project_secrets() {
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.agent = CcConnectAgent::Claude;
        let settings_path = Path::new(r"C:\Users\test\.cli-manager\providers\settings.json");
        let mut environment = BTreeMap::new();
        environment.insert(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "${ANTHROPIC_AUTH_TOKEN}".to_string(),
        );
        let raw = toml::to_string_pretty(
            &build_managed_config_with_agent_launch(
                &profile,
                Path::new(r"C:\Users\test\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
                None,
                None,
                Some(settings_path),
                &environment,
            )
            .unwrap(),
        )
        .unwrap();
        let config = toml::from_str::<toml::Value>(&raw).unwrap();
        assert_eq!(
            config["projects"][0]["agent"]["options"]["cmd"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>(),
            vec![
                "claude",
                "--settings",
                "C:/Users/test/.cli-manager/providers/settings.json"
            ]
        );
        assert_eq!(
            config["projects"][0]["agent"]["options"]["env"]["ANTHROPIC_AUTH_TOKEN"].as_str(),
            Some("${ANTHROPIC_AUTH_TOKEN}")
        );
        assert!(!raw.contains("sk-secret"));
    }

    #[test]
    fn pi_and_opencode_project_environment_uses_process_placeholders() {
        let project_dir = tempfile::tempdir().unwrap();
        let mut project = sample_registered_project("pi-project", "Pi", project_dir.path());
        project.agent = CcConnectAgent::Pi;
        project.env_vars = serde_json::json!({
            "PI_API_KEY": "sk-secret",
            "CLI_MANAGER_TAB_ID": "must-not-override",
            "HTTP_PROXY": "http://unmanaged-proxy"
        })
        .to_string();
        let (config, process) = managed_project_environment(&project);
        assert_eq!(
            config.get("PI_API_KEY").map(String::as_str),
            Some("${PI_API_KEY}")
        );
        assert_eq!(
            process,
            vec![("PI_API_KEY".to_string(), "sk-secret".to_string())]
        );
        assert!(!config.contains_key("CLI_MANAGER_TAB_ID"));
        assert!(!config.contains_key("HTTP_PROXY"));

        project.agent = CcConnectAgent::Claude;
        assert_eq!(
            managed_project_environment(&project),
            (BTreeMap::new(), Vec::new())
        );
    }
    #[test]
    fn project_list_and_switch_tokens_are_stable_and_safe() {
        let current = tempfile::tempdir().unwrap();
        let unavailable = current.path().join("missing");
        let mut profile = sample_profile(current.path());
        profile.project_name = "Current\nProject".to_string();
        profile.runtime_project_id = Some("project-1".to_string());
        let projects = vec![
            sample_registered_project("project-1", "Current\nProject", current.path()),
            sample_registered_project("project-2", "Missing", &unavailable),
        ];
        let list = render_project_list(&profile, &projects);
        assert!(list.contains("1. Current Project [当前]"));
        assert!(list.contains("2. Missing [路径不可用]"));
        assert!(list.contains("/cli_manager_switch <序号>"));
        assert!(!list.contains("Current\nProject"));

        let first = project_switch_token("project-1");
        let second = project_switch_token("project-2");
        assert_eq!(first.len(), 32);
        assert_eq!(first, project_switch_token("project-1"));
        assert_ne!(first, second);
        assert!(switch_result_path(&first).is_ok());
        assert!(switch_result_path("../invalid").is_err());
        assert_eq!(powershell_single_quoted("a'b"), "'a''b'");
        let request_id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            remote_switch_request_from_args(&[
                "cli-manager.exe".to_string(),
                format!("{REMOTE_SWITCH_ARG_PREFIX}{first}:{request_id}"),
            ]),
            Some(RemoteSwitchRequest {
                project_token: first.clone(),
                request_id: request_id.to_string(),
            })
        );
        assert_eq!(
            remote_switch_request_from_args(&[
                "cli-manager.exe".to_string(),
                format!("{REMOTE_SWITCH_ARG_PREFIX}{first}"),
            ]),
            Some(RemoteSwitchRequest {
                project_token: first.clone(),
                request_id: first.clone(),
            })
        );
        assert_eq!(
            remote_switch_request_from_args(&["cli-manager.exe".to_string()]),
            None
        );
        let script = render_project_switch_script(
            &profile,
            &projects,
            Path::new(r"C:\Program Files\CLI-Manager\cli-manager.exe"),
        )
        .unwrap();
        assert!(script.find(&first).unwrap() < script.find(&second).unwrap());
        assert!(script.contains("$args.Count -ne 1"));
        assert!(script.contains("'^[1-9][0-9]*$'"));
        assert!(script.contains("[Guid]::NewGuid().ToString('N')"));
        assert!(!script.contains(&path_string(current.path())));
    }

    #[test]
    fn project_list_groups_directories_and_disambiguates_provider() {
        let project_dir = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project_dir.path());
        profile.project_id = "claude-amazon".to_string();
        profile.project_name = "amazon".to_string();
        profile.runtime_project_id = Some("claude-amazon".to_string());

        let mut claude = sample_registered_project("claude-amazon", "amazon", project_dir.path());
        claude.group_path = vec![
            RegisteredGroupSegment {
                id: "claude-root".to_string(),
                name: "claude".to_string(),
            },
            RegisteredGroupSegment {
                id: "claude-amazon-group".to_string(),
                name: "amazon".to_string(),
            },
        ];
        claude.provider_name = Some("anyRouter-fable5".to_string());

        let mut codex = sample_registered_project("codex-amazon", "amazon", project_dir.path());
        codex.agent = CcConnectAgent::Codex;
        codex.group_path = vec![
            RegisteredGroupSegment {
                id: "codex-root".to_string(),
                name: "codex".to_string(),
            },
            RegisteredGroupSegment {
                id: "codex-amazon-group".to_string(),
                name: "amazon".to_string(),
            },
        ];
        codex.provider_name = Some("Amz项目".to_string());
        codex.provider_is_global = false;

        let mut ungrouped =
            sample_registered_project("ungrouped-amazon", "amazon", project_dir.path());
        ungrouped.provider_name = Some("muyuan".to_string());

        let projects = vec![claude, codex, ungrouped];
        let list = render_project_list(&profile, &projects);
        assert!(list.contains(
            "CLI-Manager 项目（当前：amazon · Claude Code · Provider：anyRouter-fable5（全局））"
        ));
        assert!(list.contains("📁 claude\n  📁 amazon\n    1. amazon [当前]"));
        assert!(list.contains("Claude Code · Provider：anyRouter-fable5（全局）"));
        assert!(list.contains("📁 codex\n  📁 amazon\n    2. amazon"));
        assert!(list.contains("Codex · Provider：Amz项目"));
        assert!(list.contains("📁 未分组\n  3. amazon"));
        assert!(list.contains("Claude Code · Provider：muyuan（全局）"));

        profile.language = CcConnectLanguage::En;
        let english = render_project_list(&profile, &projects);
        assert!(english.contains("Provider: anyRouter-fable5 (global)"));
        assert!(english.contains("📁 Ungrouped"));
        assert!(english.contains("Path: "));
    }

    #[test]
    fn project_provider_prefers_project_override_and_resolves_global_names() {
        let mut catalog = ProviderCatalog::default();
        catalog.current_by_app.insert(
            "claude".to_string(),
            ProviderCatalogEntry {
                id: "provider-global-claude".to_string(),
                name: "anyRouter-fable5".to_string(),
            },
        );
        catalog.names_by_app_and_id.insert(
            ("codex".to_string(), "provider-codex".to_string()),
            "Amz项目".to_string(),
        );

        assert_eq!(
            project_provider(CcConnectAgent::Claude, "{}", &catalog),
            (
                Some("provider-global-claude".to_string()),
                Some("anyRouter-fable5".to_string()),
                true
            )
        );
        assert_eq!(
            project_provider(
                CcConnectAgent::Claude,
                r#"{"claude":{"providerId":"provider-claude","providerName":"muyuan"}}"#,
                &catalog,
            ),
            (
                Some("provider-claude".to_string()),
                Some("muyuan".to_string()),
                false
            )
        );
        assert_eq!(
            project_provider(
                CcConnectAgent::Codex,
                r#"{"codex":{"providerId":"provider-codex","providerName":null}}"#,
                &catalog,
            ),
            (
                Some("provider-codex".to_string()),
                Some("Amz项目".to_string()),
                false
            )
        );
        assert_eq!(
            project_provider(CcConnectAgent::Codex, "not-json", &catalog),
            (None, None, true)
        );
    }

    #[test]
    fn registered_projects_follow_sidebar_tree_order_and_keep_ungrouped_entries() {
        let project_dir = tempfile::tempdir().unwrap();
        let groups = vec![
            sample_group("terminal", "终端", None, 0),
            sample_group("terminal-app", "应用", Some("terminal"), 0),
            sample_group("claude", "claude", None, 0),
            sample_group("claude-amazon", "amazon", Some("claude"), 0),
            sample_group("orphan", "遗留目录", Some("missing-parent"), 2),
        ];
        let projects = vec![
            sample_project_row(
                "ungrouped",
                "同名项目",
                project_dir.path(),
                CcConnectAgent::Codex,
                None,
                0,
                "{}",
            ),
            sample_project_row(
                "claude-project",
                "同名项目",
                project_dir.path(),
                CcConnectAgent::Claude,
                Some("claude-amazon"),
                0,
                "{}",
            ),
            sample_project_row(
                "terminal-project",
                "终端项目",
                project_dir.path(),
                CcConnectAgent::Claude,
                Some("terminal-app"),
                0,
                "{}",
            ),
            sample_project_row(
                "orphan-project",
                "遗留项目",
                project_dir.path(),
                CcConnectAgent::Claude,
                Some("orphan"),
                0,
                "{}",
            ),
        ];
        let ordered = order_registered_projects(groups, projects, &ProviderCatalog::default());
        assert_eq!(
            ordered
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "terminal-project",
                "claude-project",
                "orphan-project",
                "ungrouped"
            ]
        );
        assert_eq!(
            ordered[0]
                .group_path
                .iter()
                .map(|group| group.name.as_str())
                .collect::<Vec<_>>(),
            vec!["终端", "应用"]
        );
        assert_eq!(
            ordered[2]
                .group_path
                .iter()
                .map(|group| group.name.as_str())
                .collect::<Vec<_>>(),
            vec!["遗留目录"]
        );
        assert!(ordered[3].group_path.is_empty());
    }

    #[test]
    fn managed_config_matches_installed_cc_connect_when_requested() {
        let Ok(binary) = std::env::var("CLI_MANAGER_TEST_CC_CONNECT") else {
            return;
        };
        let project = tempfile::tempdir().unwrap();
        let mut profile = sample_profile(project.path());
        profile.agent = CcConnectAgent::Codex;
        let config_path = project.path().join("config.toml");
        for (platform, allow_from) in [
            (CcConnectPlatform::Telegram, "123456789"),
            (CcConnectPlatform::Feishu, "ou_owner"),
            (CcConnectPlatform::Weixin, "owner@im.wechat"),
            (CcConnectPlatform::Wecom, "zhangsan"),
        ] {
            profile.platform = platform;
            profile.allow_from = allow_from.to_string();
            let config = build_managed_config(
                &profile,
                Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-switch.ps1"),
            )
            .unwrap();
            fs::write(&config_path, toml::to_string_pretty(&config).unwrap()).unwrap();
            format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
        }
        profile.platforms = vec![
            CcConnectPlatformProfile {
                platform: CcConnectPlatform::Telegram,
                enabled: true,
                allow_from: "123456789".to_string(),
            },
            CcConnectPlatformProfile {
                platform: CcConnectPlatform::Feishu,
                enabled: true,
                allow_from: "ou_owner".to_string(),
            },
            CcConnectPlatformProfile {
                platform: CcConnectPlatform::Weixin,
                enabled: true,
                allow_from: "owner@im.wechat".to_string(),
            },
            CcConnectPlatformProfile {
                platform: CcConnectPlatform::Wecom,
                enabled: true,
                allow_from: "zhangsan".to_string(),
            },
        ];
        let config = build_managed_config(
            &profile,
            Path::new(r"C:Users	estAppDataLocalCLI-Managercli-manager-projects.txt"),
            Path::new(r"C:Users	estAppDataLocalCLI-Managercli-manager-switch.ps1"),
        )
        .unwrap();
        fs::write(&config_path, toml::to_string_pretty(&config).unwrap()).unwrap();
        format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
        let launch = sample_remote_codex_launch(true);
        let config = build_managed_config_with_codex(
            &profile,
            Path::new(r"C:\Users\test\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            Some(&launch),
        )
        .unwrap();
        fs::write(&config_path, toml::to_string_pretty(&config).unwrap()).unwrap();
        format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
        let formatted = fs::read_to_string(&config_path).unwrap();
        assert!(formatted.contains("${CLI_MANAGER_CODEX_PROVIDER_API_KEY}"));
        assert!(!formatted.contains("sk-provider-secret"));

        for agent in [
            CcConnectAgent::Claude,
            CcConnectAgent::Pi,
            CcConnectAgent::Opencode,
        ] {
            profile.agent = agent;
            let settings_path = project.path().join("claude-settings.json");
            let environment = BTreeMap::from([(
                "AGENT_TEST_TOKEN".to_string(),
                "${AGENT_TEST_TOKEN}".to_string(),
            )]);
            let config = build_managed_config_with_agent_launch(
                &profile,
                Path::new(r"C:\Users\test\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
                None,
                None,
                (agent == CcConnectAgent::Claude).then_some(settings_path.as_path()),
                &environment,
            )
            .unwrap();
            fs::write(&config_path, toml::to_string_pretty(&config).unwrap()).unwrap();
            format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
        }

        profile.platforms.clear();
        profile.agent = CcConnectAgent::Codex;
        profile.platform = CcConnectPlatform::Weixin;
        profile.allow_from = "authorization-pending@im.wechat".to_string();
        fs::write(
            &config_path,
            build_weixin_authorization_config(&profile).unwrap(),
        )
        .unwrap();
        format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn project_list_command_returns_utf8_manifest() {
        let project = tempfile::tempdir().unwrap();
        let profile = sample_profile(project.path());
        let list_path = project.path().join("projects.txt");
        fs::write(&list_path, "项目一\n1. 示例").unwrap();
        let (commands, _) =
            build_remote_project_commands(&profile, &list_path, &project.path().join("switch.ps1"))
                .unwrap();
        let command = commands[0].exec.replace("{{0:}}", "");
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            "项目一\n1. 示例"
        );
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn project_switch_script_rejects_invalid_or_out_of_range_arguments() {
        let project = tempfile::tempdir().unwrap();
        let profile = sample_profile(project.path());
        let projects = vec![
            sample_registered_project("project-1", "First", project.path()),
            sample_registered_project("project-2", "Second", project.path()),
        ];
        let script_path = project.path().join("switch.ps1");
        fs::write(
            &script_path,
            render_project_switch_script(
                &profile,
                &projects,
                Path::new(r"C:\does-not-run\cli-manager.exe"),
            )
            .unwrap(),
        )
        .unwrap();
        let run = |encoded: Option<String>| {
            let mut command = Command::new("powershell.exe");
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&script_path);
            if let Some(encoded) = encoded {
                command.arg(encoded);
            }
            command.output().unwrap()
        };
        assert!(run(None).status.success());
        for raw in ["", "0", "-1", "abc", "1;Write-Output hacked", "1 extra"] {
            let output = run(Some(base64_utf8(raw)));
            assert!(output.status.success());
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert!(stdout.contains("请输入有效的项目序号"));
            assert!(!stdout.contains("hacked"));
        }
        let output = run(Some("not-base64".to_string()));
        assert!(output.status.success());
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains("请输入有效的项目序号"));
        let output = run(Some(base64_utf8("3")));
        assert!(output.status.success());
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains("项目序号超出范围"));
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn project_switch_command_encodes_user_arguments() {
        fn split_cc_connect_v1_4_1_args(raw: &str) -> Vec<String> {
            let mut tokens = Vec::new();
            let mut current = String::new();
            let mut in_single = false;
            let mut in_double = false;
            for ch in raw.chars() {
                match ch {
                    '\'' if !in_double => in_single = !in_single,
                    '"' if !in_single => in_double = !in_double,
                    ' ' | '\t' if !in_single && !in_double => {
                        if !current.is_empty() {
                            tokens.push(std::mem::take(&mut current));
                        }
                    }
                    _ => current.push(ch),
                }
            }
            if !current.is_empty() {
                tokens.push(current);
            }
            tokens
        }

        let project = tempfile::tempdir().unwrap();
        let profile = sample_profile(project.path());
        let projects = vec![sample_registered_project(
            "project-1",
            "First",
            project.path(),
        )];
        let script_path = project.path().join("switch.ps1");
        fs::write(
            &script_path,
            render_project_switch_script(
                &profile,
                &projects,
                Path::new(r"C:\does-not-run\cli-manager.exe"),
            )
            .unwrap(),
        )
        .unwrap();
        let list_path = project.path().join("projects.txt");
        let (commands, _) =
            build_remote_project_commands(&profile, &list_path, &script_path).unwrap();
        let ascii_footer_attempt =
            split_cc_connect_v1_4_1_args("/cli_manager_switch 1\n'@\nWrite-Output hacked\n#")[1..]
                .join(" ");
        for raw in [
            "1;Write-Output hacked",
            "1\nWrite-Output hacked",
            "1’; Write-Output hacked; #",
            "1‘; Write-Output hacked; #",
            "1‛; Write-Output hacked; #",
            "1\n’@\nWrite-Output hacked\n#",
            &ascii_footer_attempt,
        ] {
            let command = commands[1].exec.replace("{{args:}}", raw);
            let output = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &command])
                .output()
                .unwrap();
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert!(!stdout.lines().any(|line| line.trim() == "hacked"));
            if output.status.success() {
                assert!(stdout.contains("请输入有效的项目序号"));
            }
        }
    }
    #[test]
    fn log_redaction_and_cursor_work() {
        assert_eq!(
            redact_log_line("connected with abcdefgh", &["abcdefgh".to_string()]),
            "connected with [REDACTED]"
        );
        assert_eq!(
            redact_log_line("telegram token=abcdefgh", &[]),
            "[sensitive output redacted]"
        );
        let mut logs = CcConnectLogBuffer::default();
        for index in 0..(MAX_LOG_LINES + 5) {
            logs.push("stdout", format!("line-{index}"));
        }
        assert_eq!(logs.lines.len(), MAX_LOG_LINES);
        let first_seq = logs.lines.front().unwrap().seq;
        assert_eq!(logs.page(first_seq, 3).len(), 3);
    }
}
