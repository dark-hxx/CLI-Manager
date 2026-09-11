mod model;
use model::{
    agent_from_launcher_program, cc_connect_agent_from_cli_tool, parse_registered_command, CcConnectLogBuffer,
    DetectedBinary, DetectionCache, ManagedProcess, ProcessState, ResolvedAgentLauncher,
    SharedLogWriter, WeixinAuthorizationProcess, WeixinAuthorizationState, CC_CONNECT_PLATFORMS,
    MAX_REGISTERED_LAUNCHER_ARGS,
};
pub use model::{
    CcConnectAgent, CcConnectExecutableStatus, CcConnectLanguage,
    CcConnectLogPage, CcConnectPlatform, CcConnectPlatformProfile, CcConnectPlatformStatus,
    CcConnectProfile, CcConnectSaveProfileRequest, CcConnectStatus,
    CcConnectWeixinAuthorizationPhase, CcConnectWeixinAuthorizationStatus,
    CcConnectWeixinAuthorizeRequest,
};
mod paths;
use paths::{
    cleanup_weixin_authorization_files, config_path, control_work_dir, data_dir, log_path,
    now_millis, path_string, profile_path, remote_manager_dir, remove_file_if_exists, weixin_account_dir, weixin_account_dir_at,
    weixin_authorization_dir, weixin_authorization_error_detail, weixin_authorization_paths,
    weixin_authorization_qr_data_url,
};
mod executable;
use executable::{
    detect_binary_uncached, output_text, probe_codex_app_server,
    sha256_file, trusted_binary_version,
};
mod config_types;
use config_types::{
    CodexModelCatalog, CodexModelDiscoveryConfig, DisabledFeature, ManagedAgent,
    ManagedAgentOptions, ManagedAlias, ManagedCommand, ManagedConfig, ManagedLogConfig,
    ManagedPlatform, ManagedProject, ManagedQueueConfig, ManagedRateLimitConfig, ProviderCatalog,
    ProviderCatalogEntry, RegisteredGroup, RegisteredGroupSegment, RegisteredProject,
    RegisteredProjectRow, RegisteredSshHost,
};
mod platform_config;
use platform_config::{
    build_managed_config_with_agent_launch, build_weixin_authorization_config, merge_weixin_allow_from,
    parse_weixin_authorization_result, platform_type,
};
mod project_commands;
use project_commands::{
    agent_display_name, build_remote_project_commands, is_switch_identifier, project_list_path, project_switch_script_path,
    project_switch_token, remote_switch_request_from_args,
    render_project_list, render_project_switch_script, single_line, switch_result_path,
};
mod file_io;
#[cfg(not(target_os = "windows"))]
use file_io::replace_file;
#[cfg(unix)]
use file_io::write_executable_file_atomically_if_changed;
use file_io::{
    config_path_value, normalize_executable_path_value, user_path_string, write_file_atomically,
    write_file_atomically_if_changed, write_managed_config, write_managed_config_with_agent_launch,
};
#[cfg(target_os = "windows")]
use file_io::{copy_file_atomically_if_changed, replace_file};
mod profile;
use profile::{
    apply_control_profile, enabled_platforms,
    hydrate_profile_platforms, load_profile, normalize_allow_from, normalize_profile, normalize_proxy_url, persist_profile, platform_profile,
    prepare_weixin_authorization_platforms, profile_issue_codes, profile_platforms, set_platform_allow_from,
};
mod launcher;
#[cfg(all(test, unix))]
use launcher::resolve_codex_launcher_from_path;
use launcher::{
    ensure_local_agent_available, managed_agent_command, managed_project_environment, user_home_dir,
};
pub(crate) use launcher::resolve_local_agent_program;
mod codex_launch;
use codex_launch::{
    apply_remote_codex_launch_environment, prepare_remote_codex_launch,
    probe_remote_codex_app_server, RemoteCodexLaunch,
};
#[cfg(not(target_os = "windows"))]
use codex_launch::{codex_profile_wrapper_payload, write_codex_profile_wrapper};
mod project_catalog;
use project_catalog::{
    load_provider_catalog, load_registered_projects, project_provider,
};
mod ssh_launch;
use ssh_launch::{
    load_ssh_codex_launch,
    registered_project_by_token,
};
mod credentials;
use credentials::{
    credential_environment_for_profile, credentials_ready,
    credentials_ready_for_profile, platform_statuses, save_request_credentials,
};
#[cfg(target_os = "windows")]
use credentials::{delete_credential, get_credential, set_credential};
#[cfg(not(target_os = "windows"))]
use credentials::{delete_credential, get_credential, set_credential};
mod process_environment;
use process_environment::{
    apply_git_safe_directory_environment, apply_proxy_environment, git_safe_directory_environment_for_value, resolve_proxy_url_if_enabled, ProxySource, ResolvedProxy,
};
mod rollback;
use rollback::{CredentialSnapshot, FileSnapshot};
mod logging;
pub(crate) use logging::redact_log_line;
use logging::{
    format_and_check_config_syntax, push_log_line, spawn_log_reader,
};

#[cfg(not(target_os = "windows"))]
use crate::codex_app_server_proxy::HELPER_SUBCOMMAND as CODEX_PROXY_SUBCOMMAND;
#[cfg(target_os = "windows")]
use crate::process_job::ChildJob;
use crate::shell_resolver::{output_with_timeout, silent_command};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::HashSet;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    // 初始化共享进程、日志和探测状态，非测试构造时清理旧微信授权文件。
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
    // 创建使用默认状态的 cc-connect 管理器。
    pub fn new() -> Self {
        Self::default()
    }

    // 按需创建轮转日志写入器并缓存在共享槽位。
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

    // 仅在配置启用日志时追加系统日志。
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

    // 按显式路径复用探测缓存，要求刷新时重新校验二进制。
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

    // 强制探测指定程序路径并返回安装、摘要和兼容性状态。
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

    // 按需刷新并缓存本地 Codex app-server 探测结果。
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

    // 轮询受管子进程退出状态并记录退出时间和日志。
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

    // 按序号分页读取有上限的日志，关闭日志时返回空页。
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

struct RemoteSwitchOutcome {
    language: CcConnectLanguage,
    project_name: String,
    project_path: String,
    restart_required: bool,
    already_current: bool,
}

impl CcConnectManager {
    // 取得操作锁后执行配置保存事务。
    fn save_profile(&self, request: CcConnectSaveProfileRequest) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.save_profile_locked(request)
    }

    // 在无活动接管时保存凭据与配置，失败则恢复快照及原运行状态。
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

    // 在主进程停止时准备临时配置并启动受管微信扫码授权进程。
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
        let existing_allow_from = prepare_weixin_authorization_platforms(&mut profile)?;
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

    // 解析成功授权、合并白名单并保存凭据，随后清理授权临时文件。
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

    // 读取授权错误详情并清理临时文件，生成失败状态。
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

    // 串行轮询授权进程与二维码，进程结束后落盘成功结果或缓存失败状态。
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

    // 终止正在运行的微信授权进程并清理临时文件，保留取消状态。
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

    // 校验远程项目令牌并保存运行目标，失败回滚配置且返回是否需重启。
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

    // 在主进程停止时清除指定平台或全部凭据，失败恢复凭据快照。
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

    // 综合配置、凭据、程序探测及进程状态生成阻塞项和警告。
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

    // 取得操作锁后启动受管进程。
    fn start(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.start_inner()
    }

    // 设置启动标记并准备进程，成功后登记进程，失败时清除标记。
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

    // 校验有效目标和代理后端，生成配置与环境后启动并检查受管进程。
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

    // 取得操作锁后停止受管进程。
    fn stop(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.stop_inner()
    }

    // 取出并终止受管进程，Windows 限时等待后记录退出状态。
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

    // 在同一操作锁内停止并重新启动受管进程。
    fn restart(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.stop_inner()?;
        self.start_inner()
    }

    // 暂停原运行进程后应用更新，清空探测缓存并尝试恢复运行状态。
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

    // 仅在已配置自动启动时启动受管进程。
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

    // 退出时取消微信授权并停止主进程，将清理失败写入日志。
    pub fn shutdown(&self) {
        if let Err(err) = self.cancel_weixin_authorization() {
            log::warn!("Weixin authorization shutdown cleanup failed: {err}");
        }
        if let Err(err) = self.stop() {
            log::warn!("cc-connect shutdown cleanup failed: {err}");
        }
    }
}

// 消费单实例远程切换参数，后台写回结果并按需延迟重启连接。
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

#[tauri::command]
// 在阻塞任务中获取状态，可选刷新程序与后端探测。
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
// 在阻塞任务中检查指定可执行文件。
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
// 异步获取指定通道的 cc-connect 更新检查结果。
pub async fn cc_connect_check_update(
    request: update::CcConnectCheckUpdateRequest,
) -> Result<update::CcConnectUpdateCheck, String> {
    update::check_update(request).await
}

#[tauri::command]
// 先异步准备已校验载荷，再在阻塞任务中应用更新和恢复进程。
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
// 在阻塞任务中保存配置并返回重新探测后的状态。
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
// 在阻塞任务中清除平台凭据并返回状态。
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
// 在阻塞任务中启动微信扫码授权。
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
// 在阻塞任务中轮询微信授权进度与完成结果。
pub async fn cc_connect_weixin_authorization_status(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectWeixinAuthorizationStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.weixin_authorization_status())
        .await
        .map_err(|err| format!("Weixin authorization status task failed: {err}"))?
}

#[tauri::command]
// 在阻塞任务中取消微信授权并清理临时文件。
pub async fn cc_connect_weixin_authorization_cancel(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectWeixinAuthorizationStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.cancel_weixin_authorization())
        .await
        .map_err(|err| format!("Weixin authorization cancel task failed: {err}"))?
}

#[tauri::command]
// 在阻塞任务中启动连接并返回最新状态。
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
// 在阻塞任务中停止连接并返回最新状态。
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
// 在阻塞任务中重启连接并返回最新状态。
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
// 返回指定序号之后、限定条数的连接日志页。
pub fn cc_connect_get_logs(
    manager: State<'_, CcConnectManager>,
    after_seq: Option<u64>,
    limit: Option<usize>,
) -> Result<CcConnectLogPage, String> {
    manager.log_page(after_seq, limit)
}

// 从应用状态获取管理器并按配置执行自动启动。
pub fn auto_start(app: &AppHandle) -> Result<(), String> {
    app.state::<CcConnectManager>().auto_start_if_enabled()
}

#[cfg(test)]
mod tests;
