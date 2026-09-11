#[cfg(target_os = "windows")]
use crate::shell_resolver::silent_command;
use crate::ssh_transport::{
    format_remote_home_path, posix_quote, validate_remote_home_path, SshOneShotOptions,
    SshTransportLaunch, SshTransportSpec,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HELPER_SUBCOMMAND: &str = "__codex_app_server_proxy";
pub(crate) const PROXY_EXECUTABLE_ENV: &str = "CLI_MANAGER_CODEX_APP_SERVER_PROXY";
pub(crate) const EXPECTED_SESSION_ID_ENV: &str = "CLI_MANAGER_CODEX_EXPECTED_SESSION_ID";
pub(crate) const CODEX_LAUNCHER_ENV: &str = "CLI_MANAGER_CODEX_LAUNCHER";
pub(crate) const CODEX_LAUNCHER_ARGS_ENV: &str = "CLI_MANAGER_CODEX_LAUNCHER_ARGS";
pub(crate) const CODEX_BASE_URL_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_BASE_URL_OVERRIDE";
pub(crate) const CODEX_ENV_KEY_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_ENV_KEY_OVERRIDE";
pub(crate) const CODEX_MODEL_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_MODEL_OVERRIDE";
pub(crate) const CODEX_MODEL_CATALOG_OVERRIDE_ENV: &str =
    "CLI_MANAGER_CODEX_MODEL_CATALOG_OVERRIDE";
pub(crate) const CODEX_WIRE_API_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_WIRE_API_OVERRIDE";
pub(crate) const CODEX_PROVIDER_NAME_OVERRIDE_ENV: &str =
    "CLI_MANAGER_CODEX_PROVIDER_NAME_OVERRIDE";
pub(crate) const CODEX_PROFILE_NAME_ENV: &str = "CLI_MANAGER_CODEX_PROFILE_NAME";
pub(crate) const CODEX_MODEL_PROVIDER_ENV: &str = "CLI_MANAGER_CODEX_MODEL_PROVIDER";
pub(crate) const CODEX_SSH_LAUNCH_ENV: &str = "CLI_MANAGER_CODEX_SSH_LAUNCH";
pub(crate) const CODEX_PROTOCOL_TRACE_PATH_ENV: &str = "CLI_MANAGER_CODEX_PROTOCOL_TRACE_PATH";

// A resumed Codex thread can legitimately exceed cc-connect's 10 MB scanner limit.
// Keep a finite ceiling so a broken child cannot exhaust the host process indefinitely.
const MAX_PROTOCOL_LINE_BYTES: usize = 512 * 1024 * 1024;
const MAX_CODEX_LAUNCHER_ARGS: usize = 64;
const MAX_CODEX_LAUNCHER_ARG_BYTES: usize = 8 * 1024;
const MAX_CODEX_PROFILE_BYTES: u64 = 20 * 1024;
const MAX_CODEX_PROFILE_OVERRIDES: usize = 256;
// Leave room below Windows' 32,767 UTF-16 command-line limit for the
// executable path and shell launcher arguments used by .cmd/.ps1 installs.
const MAX_CODEX_CHILD_ARGUMENT_UTF16_UNITS: usize = 20 * 1024;
const MAX_PROTOCOL_TRACE_PENDING_REQUESTS: usize = 64;
const MAX_PENDING_RESUMES: usize = 64;
const STRICT_RESUME_ERROR_CODE: i64 = -32091;
const SSH_HANDOFF_HOOK_QUEUE_CAPACITY: usize = 32;
const LOCAL_HANDOFF_DELIVERY_INSTRUCTION: &str = "CLI-Manager remote handoff: deliver output files with `cc-connect send --file <absolute-path>` and output images with `cc-connect send --image <absolute-path>`.";
const LOCAL_HANDOFF_DELIVERY_CONTEXT_KEY: &str = "cli-manager.remote-handoff.delivery";

#[derive(Debug, Deserialize)]
struct RpcProbe {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeResponseEnvelope {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    result: Option<ResumeResult>,
    #[serde(default)]
    error: Option<MinimalRpcError>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeResult {
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    model_provider: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    thread: ResumeThread,
}

#[derive(Debug, Default, Deserialize)]
struct ResumeThread {
    #[serde(default)]
    id: String,
    #[serde(default)]
    model_provider: String,
}

#[derive(Debug, Deserialize)]
struct MinimalRpcError {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone)]
struct PendingResume {
    requested_thread_id: String,
    expected_thread_id: Option<String>,
    expected_model_provider: Option<String>,
}

enum ClientLineAction {
    Forward(Vec<u8>),
    Reject(Vec<u8>),
}

struct SshHandoffHookForwarder {
    sender: SyncSender<Value>,
    tab_id: String,
    expected_thread_id: Option<String>,
}

impl SshHandoffHookForwarder {
    // 有有效 Tab 标识时创建有界 Hook 队列，并启动后台线程尝试发送事件。
    fn from_environment(expected_thread_id: Option<String>) -> Option<Self> {
        let tab_id = env::var("CLI_MANAGER_TAB_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        let (sender, receiver) = sync_channel::<Value>(SSH_HANDOFF_HOOK_QUEUE_CAPACITY);
        std::thread::spawn(move || {
            while let Ok(payload) = receiver.recv() {
                let _ = crate::hook_client::try_notify_prepared_payload(&payload);
            }
        });
        Some(Self {
            sender,
            tab_id,
            expected_thread_id,
        })
    }

    // 将服务器行转换为 Hook 事件后非阻塞入队；队列满或关闭时丢弃该事件。
    fn inspect_server_line(&self, line: &[u8]) {
        let Some(payload) =
            ssh_handoff_hook_payload(line, &self.tab_id, self.expected_thread_id.as_deref())
        else {
            return;
        };
        match self.sender.try_send(payload) {
            Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshCodexLaunch {
    pub(crate) transport: SshTransportSpec,
    pub(crate) remote_path: String,
    #[serde(default)]
    pub(crate) environment_overrides: HashMap<String, String>,
    #[serde(default)]
    pub(crate) initialization_command: Option<String>,
}

impl SshCodexLaunch {
    // 校验 SSH 启动计划后序列化为 JSON，再编码为 Base64。
    pub(crate) fn encode(&self) -> Result<String, String> {
        self.validate()?;
        let payload = serde_json::to_vec(self)
            .map_err(|err| format!("serialize SSH Codex launch failed: {err}"))?;
        Ok(BASE64_STANDARD.encode(payload))
    }

    // 从可选环境变量解码 SSH 启动计划，反序列化并校验；缺失时返回 None。
    fn from_environment() -> Result<Option<Self>, String> {
        let Some(encoded) = optional_unicode_env(CODEX_SSH_LAUNCH_ENV)? else {
            return Ok(None);
        };
        let payload = BASE64_STANDARD
            .decode(encoded)
            .map_err(|err| format!("decode SSH Codex launch failed: {err}"))?;
        let launch: Self = serde_json::from_slice(&payload)
            .map_err(|err| format!("parse SSH Codex launch failed: {err}"))?;
        launch.validate()?;
        Ok(Some(launch))
    }

    // 校验传输、远程目录及环境值，并拒绝需要交互认证的接管配置。
    fn validate(&self) -> Result<(), String> {
        self.transport.validate()?;
        validate_remote_work_dir(&self.remote_path)?;
        if matches!(
            self.transport.auth_mode.as_str(),
            "password_prompt" | "interactive"
        ) {
            return Err("handoff_ssh_interactive_auth_unsupported".to_string());
        }
        if self
            .environment_overrides
            .keys()
            .any(|key| !is_valid_environment_key(key))
        {
            return Err("ssh_environment_key_invalid".to_string());
        }
        if self
            .environment_overrides
            .values()
            .any(|value| value.contains('\0'))
        {
            return Err("ssh_environment_value_invalid".to_string());
        }
        if let Some(codex_home) = self.environment_overrides.get("CODEX_HOME") {
            validate_remote_home_path(codex_home)
                .map_err(|_| "ssh_tool_config_root_invalid".to_string())?;
        }
        if self
            .initialization_command
            .as_deref()
            .is_some_and(|command| command.contains('\0'))
        {
            return Err("ssh_startup_command_invalid".to_string());
        }
        Ok(())
    }

    // 校验当前计划后构造一次性 SSH 启动参数，不在此启动进程。
    fn build_launch(&self, args: &[String]) -> Result<SshTransportLaunch, String> {
        self.validate()?;
        self.transport
            .build_one_shot_launch(self.remote_command(args), SshOneShotOptions::default())
    }

    // 拼接远程登录 shell、初始化及环境导出命令，隔离启动输出并恢复 Codex 协议 stdout。
    fn remote_command(&self, args: &[String]) -> String {
        let mut commands = Vec::new();
        if let Some(command) = self
            .initialization_command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            commands.push(command.to_string());
        }
        let mut environment = self.environment_overrides.iter().collect::<Vec<_>>();
        environment.sort_by(|left, right| left.0.cmp(right.0));
        commands.extend(environment.into_iter().map(|(key, value)| {
            let value = if key == "CODEX_HOME" {
                format_remote_home_path(value)
            } else {
                posix_quote(value)
            };
            format!("export {key}={value}")
        }));
        let invocation = std::iter::once("codex".to_string())
            .chain(args.iter().cloned())
            .map(|argument| posix_quote(&argument))
            .collect::<Vec<_>>()
            .join(" ");
        commands.push(format!("exec {invocation} 1>&3 3>&-"));
        format!(
            "cd -- {} && exec 3>&1 && exec \"${{SHELL:-/bin/sh}}\" -lic {} 1>&2",
            posix_quote(self.remote_path.trim()),
            posix_quote(&commands.join("\n"))
        )
    }
}

// 检查第一个用户参数是否为代理辅助子命令。
pub fn is_helper_request(args: &[String]) -> bool {
    args.get(1).map(String::as_str) == Some(HELPER_SUBCOMMAND)
}

// 跳过辅助入口参数运行代理，并将结果转换为当前进程退出码。
pub fn run_helper_and_exit(args: &[String]) -> ! {
    let child_args = args
        .get(2..)
        .ok_or_else(|| "missing Codex app-server arguments".to_string());
    exit_after_proxy(child_args.and_then(run_proxy))
}

// 按首个子命令选择 app-server 代理或普通命令透传，然后退出当前进程。
pub fn run_shim_and_exit(args: &[String]) -> ! {
    let child_args = args
        .get(1..)
        .ok_or_else(|| "missing Codex arguments".to_string());
    exit_after_proxy(child_args.and_then(|child_args| {
        if is_app_server_command(child_args) {
            run_proxy(child_args)
        } else {
            run_passthrough(child_args)
        }
    }))
}

// 成功时沿用子进程退出码；错误写入 stderr 并以 1 退出。
fn exit_after_proxy(result: Result<i32, String>) -> ! {
    let exit_code = match result {
        Ok(code) => code,
        Err(err) => {
            eprintln!("CLI-Manager Codex app-server proxy: {err}");
            1
        }
    };
    std::process::exit(exit_code);
}

// 启动本机或 SSH app-server，双向转发协议并检查恢复结果，输出转发失败时终止子进程。
fn run_proxy(child_args: &[String]) -> Result<i32, String> {
    if !is_app_server_command(child_args) {
        return Err("refusing to proxy a non app-server Codex command".to_string());
    }

    let ssh_launch = SshCodexLaunch::from_environment()?;
    let expected_thread_id = env::var(EXPECTED_SESSION_ID_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let protocol_trace_path =
        optional_unicode_env(CODEX_PROTOCOL_TRACE_PATH_ENV)?.map(PathBuf::from);
    append_protocol_trace(protocol_trace_path.as_deref(), "process.starting");
    let (mut command, expected_model_provider) = if let Some(ssh_launch) = ssh_launch.as_ref() {
        (
            command_from_ssh_launch(ssh_launch.build_launch(child_args)?),
            None,
        )
    } else {
        let launcher = codex_launcher_from_environment()?;
        let launcher_args = codex_launcher_args_from_environment()?;
        let provider_overrides = CodexProviderOverrides::from_environment()?;
        let expected_model_provider = provider_overrides.model_provider.clone();
        let mut effective_args = launcher_args;
        effective_args.extend(build_codex_child_args(child_args, &provider_overrides)?);
        validate_codex_app_server_argument_budget(child_args, &effective_args)?;
        (
            codex_command(&launcher, &effective_args)?,
            expected_model_provider,
        )
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command
        .spawn()
        .map_err(|err| format!("start real Codex app-server failed: {err}"))?;
    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "real Codex stdin pipe is unavailable".to_string())?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "real Codex stdout pipe is unavailable".to_string())?;

    let pending = Arc::new(Mutex::new(HashMap::<String, PendingResume>::new()));
    let trace_state = Arc::new(Mutex::new(ProtocolTraceState::default()));
    let parent_output = Arc::new(Mutex::new(io::stdout()));
    let input_pending = Arc::clone(&pending);
    let input_trace_state = Arc::clone(&trace_state);
    let input_output = Arc::clone(&parent_output);
    let input_trace_path = protocol_trace_path.clone();
    let hook_forwarder = ssh_launch
        .as_ref()
        .and_then(|_| SshHandoffHookForwarder::from_environment(expected_thread_id.clone()));
    let remote_work_dir = ssh_launch.as_ref().map(|launch| launch.remote_path.clone());
    std::thread::spawn(move || {
        if let Err(err) = forward_parent_input(
            child_stdin,
            expected_thread_id.as_deref(),
            expected_model_provider.as_deref(),
            remote_work_dir.as_deref(),
            &input_pending,
            &input_output,
            input_trace_path.as_deref(),
            &input_trace_state,
        ) {
            eprintln!("CLI-Manager Codex app-server proxy input failed: {err}");
        }
    });

    if let Err(err) = forward_child_output(
        child_stdout,
        &pending,
        &parent_output,
        hook_forwarder.as_ref(),
        protocol_trace_path.as_deref(),
        &trace_state,
    ) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }
    let status = child
        .wait()
        .map_err(|err| format!("wait for real Codex app-server failed: {err}"))?;
    append_protocol_trace(protocol_trace_path.as_deref(), "process.exited");
    Ok(status.code().unwrap_or(1))
}

// 仅依据参数列表首项判断是否为 app-server 命令。
fn is_app_server_command(child_args: &[String]) -> bool {
    child_args.first().map(String::as_str) == Some("app-server")
}

// 启动本机或 SSH Codex 普通命令并继承标准流，等待退出后返回退出码。
fn run_passthrough(child_args: &[String]) -> Result<i32, String> {
    if let Some(ssh_launch) = SshCodexLaunch::from_environment()? {
        let status = command_from_ssh_launch(ssh_launch.build_launch(child_args)?)
            .status()
            .map_err(|err| format!("start remote Codex command failed: {err}"))?;
        return Ok(status.code().unwrap_or(1));
    }
    let launcher = codex_launcher_from_environment()?;
    let mut command_args = codex_launcher_args_from_environment()?;
    command_args.extend(build_codex_child_args(
        child_args,
        &CodexProviderOverrides::from_environment()?,
    )?);
    let status = codex_command(&launcher, &command_args)?
        .status()
        .map_err(|err| format!("start real Codex command failed: {err}"))?;
    Ok(status.code().unwrap_or(1))
}

// 要求远程目录为绝对 POSIX 形式，拒绝控制边界字符、反斜杠及父目录组件。
fn validate_remote_work_dir(path: &str) -> Result<(), String> {
    let path = path.trim();
    if !path.starts_with('/') || path.contains(['\0', '\r', '\n', '\\']) {
        return Err("ssh_remote_path_invalid".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("ssh_remote_path_parent_forbidden".to_string());
    }
    Ok(())
}

// 检查环境键是否符合 ASCII shell 变量命名规则。
fn is_valid_environment_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|character| matches!(character, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

#[cfg(target_os = "windows")]
// 在 Windows 下以隐藏窗口方式构造 SSH 命令，附加计划中的参数和环境。
fn command_from_ssh_launch(launch: SshTransportLaunch) -> Command {
    let mut command = silent_command(&launch.executable);
    command.args(launch.args).envs(launch.env);
    command
}

#[cfg(not(target_os = "windows"))]
// 在非 Windows 平台构造 SSH 命令，附加计划中的参数和环境。
fn command_from_ssh_launch(launch: SshTransportLaunch) -> Command {
    let mut command = Command::new(&launch.executable);
    command.args(launch.args).envs(launch.env);
    command
}

// 读取非空启动器环境变量并转为路径，缺失时返回错误。
fn codex_launcher_from_environment() -> Result<PathBuf, String> {
    env::var_os(CODEX_LAUNCHER_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "real Codex launcher is unavailable".to_string())
}

// 读取可选启动器参数环境变量，要求 Unicode 后交给结构化参数解析。
fn codex_launcher_args_from_environment() -> Result<Vec<String>, String> {
    let Some(value) = env::var_os(CODEX_LAUNCHER_ARGS_ENV).filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    let value = value
        .into_string()
        .map_err(|_| "Codex launcher arguments are not valid Unicode".to_string())?;
    parse_codex_launcher_args(&value)
}

// 解析 JSON 字符串数组，并限制参数数量、单项字节数及禁止的控制字符。
fn parse_codex_launcher_args(value: &str) -> Result<Vec<String>, String> {
    let args = serde_json::from_str::<Vec<String>>(value)
        .map_err(|_| "Codex launcher arguments are invalid".to_string())?;
    if args.len() > MAX_CODEX_LAUNCHER_ARGS
        || args.iter().any(|arg| {
            arg.is_empty()
                || arg.len() > MAX_CODEX_LAUNCHER_ARG_BYTES
                || arg.contains(['\0', '\r', '\n'])
        })
    {
        return Err("Codex launcher arguments are invalid".to_string());
    }
    Ok(args)
}

#[derive(Debug, Default, PartialEq, Eq)]
struct CodexProviderOverrides {
    profile_name: Option<String>,
    profile_overrides: Vec<String>,
    model_provider: Option<String>,
    provider_name: Option<String>,
    base_url: Option<String>,
    env_key: Option<String>,
    model: Option<String>,
    model_catalog: Option<String>,
    wire_api: Option<String>,
}

impl CodexProviderOverrides {
    // 加载可选供应商 profile 的配置投影及各项运行时覆盖环境变量。
    fn from_environment() -> Result<Self, String> {
        let profile_name = optional_unicode_env(CODEX_PROFILE_NAME_ENV)?;
        let profile_overrides = profile_name
            .as_deref()
            .map(load_codex_profile_overrides)
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            profile_name,
            profile_overrides,
            model_provider: optional_unicode_env(CODEX_MODEL_PROVIDER_ENV)?,
            provider_name: optional_unicode_env(CODEX_PROVIDER_NAME_OVERRIDE_ENV)?,
            base_url: optional_unicode_env(CODEX_BASE_URL_OVERRIDE_ENV)?,
            env_key: optional_unicode_env(CODEX_ENV_KEY_OVERRIDE_ENV)?,
            model: optional_unicode_env(CODEX_MODEL_OVERRIDE_ENV)?,
            model_catalog: optional_unicode_env(CODEX_MODEL_CATALOG_OVERRIDE_ENV)?,
            wire_api: optional_unicode_env(CODEX_WIRE_API_OVERRIDE_ENV)?,
        })
    }

    // 校验供应商覆盖所需字段，按调用场景选择 profile 或展开配置，再追加显式覆盖。
    fn command_args(&self, include_profile: bool) -> Result<Vec<String>, String> {
        let has_any = self.profile_name.is_some()
            || !self.profile_overrides.is_empty()
            || self.model_provider.is_some()
            || self.provider_name.is_some()
            || self.base_url.is_some()
            || self.env_key.is_some()
            || self.model.is_some()
            || self.model_catalog.is_some()
            || self.wire_api.is_some();
        if !has_any {
            return Ok(Vec::new());
        }
        let model_provider = self
            .model_provider
            .as_ref()
            .ok_or_else(|| "Codex model Provider ID is missing".to_string())?;
        let provider_name = self
            .provider_name
            .as_ref()
            .ok_or_else(|| "Codex Provider name override is missing".to_string())?;
        let base_url = self
            .base_url
            .as_ref()
            .ok_or_else(|| "Codex Provider base URL override is missing".to_string())?;
        let env_key = self
            .env_key
            .as_ref()
            .ok_or_else(|| "Codex Provider environment key override is missing".to_string())?;
        let wire_api = self
            .wire_api
            .as_ref()
            .ok_or_else(|| "Codex Provider wire API override is missing".to_string())?;
        let model_catalog = self
            .model_catalog
            .as_ref()
            .ok_or_else(|| "Codex model catalog override is missing".to_string())?;
        let mut args = Vec::new();
        if include_profile {
            let profile_name = self
                .profile_name
                .as_ref()
                .ok_or_else(|| "Codex Provider profile name is missing".to_string())?;
            args.extend(["--profile".to_string(), profile_name.clone()]);
        } else {
            for value in &self.profile_overrides {
                args.extend(["-c".to_string(), value.clone()]);
            }
        }
        args.extend([
            "-c".to_string(),
            format!(
                "model_provider={}",
                serde_json::to_string(model_provider)
                    .map_err(|err| format!("encode Codex model Provider ID failed: {err}"))?
            ),
            "-c".to_string(),
            provider_name.clone(),
            "-c".to_string(),
            base_url.clone(),
            "-c".to_string(),
            env_key.clone(),
            "-c".to_string(),
            wire_api.clone(),
            "-c".to_string(),
            model_catalog.clone(),
        ]);
        if let Some(model) = self.model.as_ref() {
            args.extend(["-c".to_string(), model.clone()]);
        }
        Ok(args)
    }
}

// 读取可选 Unicode 环境变量，空白视为缺失，非 Unicode 值返回错误。
fn optional_unicode_env(key: &str) -> Result<Option<String>, String> {
    match env::var(key) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{key} is not valid Unicode")),
    }
}

// 校验 profile 名称和文件元数据，从 CODEX_HOME 读取 TOML 并展开为数量受限的配置项。
pub(crate) fn load_codex_profile_overrides(profile_name: &str) -> Result<Vec<String>, String> {
    if profile_name.is_empty()
        || profile_name.len() > 128
        || !profile_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("Codex Provider profile name is invalid".to_string());
    }
    let codex_home = resolve_codex_profile_home(
        env::var_os("CODEX_HOME"),
        crate::provider::home::default_config_root("codex"),
    )
    .ok_or_else(|| "Codex home is unavailable for the Provider profile".to_string())?;
    let path = codex_home.join(format!("{profile_name}.config.toml"));
    let file = std::fs::File::open(&path)
        .map_err(|err| format!("open Codex Provider profile failed: {err}"))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("read Codex Provider profile metadata failed: {err}"))?;
    if !metadata.is_file() {
        return Err("Codex Provider profile is missing or too large".to_string());
    }
    let mut profile = String::new();
    file.take(MAX_CODEX_PROFILE_BYTES + 1)
        .read_to_string(&mut profile)
        .map_err(|err| format!("read Codex Provider profile failed: {err}"))?;
    if profile.len() as u64 > MAX_CODEX_PROFILE_BYTES {
        return Err("Codex Provider profile is missing or too large".to_string());
    }
    let document = toml::from_str::<toml::Value>(&profile)
        .map_err(|err| format!("parse Codex Provider profile failed: {err}"))?;
    let mut overrides = Vec::new();
    flatten_codex_profile_value(None, &document, &mut overrides)?;
    if overrides.len() > MAX_CODEX_PROFILE_OVERRIDES {
        return Err("Codex Provider profile contains too many runtime options".to_string());
    }
    Ok(overrides)
}

fn resolve_codex_profile_home(
    environment_home: Option<OsString>,
    managed_home: Option<PathBuf>,
) -> Option<PathBuf> {
    environment_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or(managed_home)
}

// 递归展开 TOML 表为点路径配置项；非表值保留其 TOML 文本表示。
fn flatten_codex_profile_value(
    prefix: Option<&str>,
    value: &toml::Value,
    output: &mut Vec<String>,
) -> Result<(), String> {
    if let toml::Value::Table(table) = value {
        for (key, child) in table {
            let key = codex_profile_key_segment(key)?;
            let path = prefix.map_or_else(|| key.clone(), |prefix| format!("{prefix}.{key}"));
            flatten_codex_profile_value(Some(&path), child, output)?;
        }
        return Ok(());
    }
    let prefix = prefix.ok_or_else(|| "Codex Provider profile root is invalid".to_string())?;
    output.push(format!("{prefix}={value}"));
    Ok(())
}

// 校验配置键片段，简单 ASCII 键直接使用，其他键采用 JSON 字符串引号。
fn codex_profile_key_segment(value: &str) -> Result<String, String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err("Codex Provider profile key is invalid".to_string());
    }
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Ok(value.to_string());
    }
    serde_json::to_string(value).map_err(|_| "Codex Provider profile key is invalid".to_string())
}

// 把供应商配置参数放在子命令之前，并校验 app-server 的命令行预算。
fn build_codex_child_args(
    child_args: &[String],
    overrides: &CodexProviderOverrides,
) -> Result<Vec<String>, String> {
    // app-server rejects --profile even when it precedes the subcommand. Load
    // the same generated profile as -c overrides, then append explicit locks
    // for Provider identity, model catalog, and active model.
    let mut args = overrides.command_args(!is_app_server_command(child_args))?;
    args.extend_from_slice(child_args);
    validate_codex_app_server_argument_budget(child_args, &args)?;
    Ok(args)
}

// 仅对 app-server 检查保守估算的 Windows 参数长度是否超出预算。
fn validate_codex_app_server_argument_budget(
    child_args: &[String],
    effective_args: &[String],
) -> Result<(), String> {
    if is_app_server_command(child_args)
        && estimated_windows_argument_units(effective_args) > MAX_CODEX_CHILD_ARGUMENT_UTF16_UNITS
    {
        return Err(
            "Codex app-server startup arguments exceed the safe Windows command-line budget"
                .to_string(),
        );
    }
    Ok(())
}

// 累计 UTF-16 参数长度，并为分隔符、引号及反斜杠预留转义空间。
fn estimated_windows_argument_units(args: &[String]) -> usize {
    args.iter()
        .map(|arg| {
            // Rust quotes Windows process arguments. Count the argument, a
            // separator and outer quotes, plus conservative escaping space
            // for quotes and backslashes so the check fails closed.
            arg.encode_utf16().count()
                + 3
                + arg
                    .chars()
                    .filter(|character| matches!(character, '\\' | '"'))
                    .count()
        })
        .sum()
}

#[cfg(target_os = "windows")]
// 移除 Windows 扩展路径前缀，将扩展 UNC 转为普通 UNC 供脚本启动器使用。
pub(crate) fn windows_shell_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

#[derive(Default)]
struct ProtocolTraceState {
    pending_requests: HashMap<String, &'static str>,
}

#[cfg(target_os = "windows")]
// 检查脚本启动路径或参数是否包含当前实现禁止的 shell 边界字符。
fn contains_unsupported_script_characters(value: &str) -> bool {
    value.contains(['&', '|', '<', '>', '^', '%', '!', '\r', '\n'])
}

#[cfg(target_os = "windows")]
// 按 Windows 启动器扩展名选择 CMD、PowerShell 或直接运行，并拒绝脚本危险字符。
fn codex_command(launcher: &Path, args: &[String]) -> Result<Command, String> {
    let extension = launcher
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let is_script = matches!(
        extension.to_ascii_lowercase().as_str(),
        "cmd" | "bat" | "ps1"
    );
    let shell_launcher = windows_shell_path(launcher);
    let launcher_value = shell_launcher.to_string_lossy();
    if is_script
        && std::iter::once(launcher_value.as_ref())
            .chain(args.iter().map(String::as_str))
            .any(contains_unsupported_script_characters)
    {
        return Err("Codex launcher contains unsupported script characters".to_string());
    }
    if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
        let mut command = silent_command("cmd.exe");
        // `call` is the fixed first command after /c, so CMD honors Rust's
        // quoting for a script path that contains spaces. Passing the script
        // itself as the first /c token makes CMD strip/split its outer quotes.
        command
            .args(["/d", "/s", "/c", "call"])
            .arg(&shell_launcher)
            .args(args);
        Ok(command)
    } else if extension.eq_ignore_ascii_case("ps1") {
        let mut command = silent_command("powershell.exe");
        command
            .args(["-NoProfile", "-File"])
            .arg(&shell_launcher)
            .args(args);
        Ok(command)
    } else {
        let mut command = silent_command(&launcher.to_string_lossy());
        command.args(args);
        Ok(command)
    }
}

#[cfg(not(target_os = "windows"))]
// 在非 Windows 平台直接构造启动器命令并附加参数。
fn codex_command(launcher: &Path, args: &[String]) -> Result<Command, String> {
    let mut command = Command::new(launcher);
    command.args(args);
    Ok(command)
}

// 读取父进程协议行，转发允许的请求或直接写回拒绝响应，并记录协议阶段。
fn forward_parent_input(
    mut child_stdin: impl Write,
    expected_thread_id: Option<&str>,
    expected_model_provider: Option<&str>,
    remote_work_dir: Option<&str>,
    pending: &Arc<Mutex<HashMap<String, PendingResume>>>,
    parent_output: &Arc<Mutex<io::Stdout>>,
    protocol_trace_path: Option<&Path>,
    trace_state: &Arc<Mutex<ProtocolTraceState>>,
) -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut delivery_instruction_pending =
        expected_thread_id.is_some() && remote_work_dir.is_none();
    while let Some(line) = read_protocol_line(&mut reader, MAX_PROTOCOL_LINE_BYTES)
        .map_err(|err| format!("read cc-connect request failed: {err}"))?
    {
        trace_client_protocol_line(protocol_trace_path, trace_state, &line);
        let action = {
            let mut pending = pending
                .lock()
                .map_err(|_| "resume request state lock poisoned".to_string())?;
            inspect_client_line(
                &line,
                expected_thread_id,
                expected_model_provider,
                remote_work_dir,
                &mut pending,
                &mut delivery_instruction_pending,
            )
        };
        match action {
            ClientLineAction::Forward(line) => {
                child_stdin
                    .write_all(&line)
                    .and_then(|_| child_stdin.flush())
                    .map_err(|err| format!("write real Codex request failed: {err}"))?;
            }
            ClientLineAction::Reject(response) => {
                write_parent_line(parent_output, &response)?;
            }
        }
    }
    Ok(())
}

// 读取子进程协议行，投递可选 Hook、压缩恢复响应并串行写回父进程。
fn forward_child_output(
    child_stdout: impl io::Read,
    pending: &Arc<Mutex<HashMap<String, PendingResume>>>,
    parent_output: &Arc<Mutex<io::Stdout>>,
    hook_forwarder: Option<&SshHandoffHookForwarder>,
    protocol_trace_path: Option<&Path>,
    trace_state: &Arc<Mutex<ProtocolTraceState>>,
) -> Result<(), String> {
    let mut reader = BufReader::new(child_stdout);
    while let Some(line) = read_protocol_line(&mut reader, MAX_PROTOCOL_LINE_BYTES)
        .map_err(|err| format!("read real Codex response failed: {err}"))?
    {
        trace_server_protocol_line(protocol_trace_path, trace_state, &line);
        if let Some(forwarder) = hook_forwarder {
            forwarder.inspect_server_line(&line);
        }
        let transformed = {
            let mut pending = pending
                .lock()
                .map_err(|_| "resume response state lock poisoned".to_string())?;
            transform_server_line(&line, &mut pending)
        };
        write_parent_line(parent_output, transformed.as_deref().unwrap_or(&line))?;
    }
    Ok(())
}

// 记录受支持的客户端协议阶段，并有界保存请求 ID 到阶段的关联。
fn trace_client_protocol_line(
    path: Option<&Path>,
    state: &Arc<Mutex<ProtocolTraceState>>,
    line: &[u8],
) {
    if path.is_none() {
        return;
    }
    let Ok(message) = serde_json::from_slice::<Value>(trim_line_ending(line)) else {
        return;
    };
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let stage = match method {
        "initialize" => "initialize",
        "initialized" => "initialized",
        "thread/resume" => "thread.resume",
        "turn/start" => "turn.start",
        _ => return,
    };
    if let Some(key) = message.get("id").and_then(rpc_id_key) {
        if let Ok(mut state) = state.lock() {
            if state.pending_requests.len() >= MAX_PROTOCOL_TRACE_PENDING_REQUESTS {
                state.pending_requests.clear();
            }
            state.pending_requests.insert(key, stage);
        }
    }
    append_protocol_trace(path, &format!("client.{stage}"));
}

// 记录受支持的服务器事件，或消费请求关联以记录对应响应的成功或错误阶段。
fn trace_server_protocol_line(
    path: Option<&Path>,
    state: &Arc<Mutex<ProtocolTraceState>>,
    line: &[u8],
) {
    if path.is_none() {
        return;
    }
    let Ok(message) = serde_json::from_slice::<Value>(trim_line_ending(line)) else {
        return;
    };
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        let stage = match method {
            "turn/started" => "server.turn.started",
            "turn/completed" => "server.turn.completed",
            "error" => "server.error",
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
            | "mcpServer/elicitation/request"
            | "applyPatchApproval"
            | "execCommandApproval" => "server.approval.requested",
            _ => return,
        };
        append_protocol_trace(path, stage);
        return;
    }
    let Some(key) = message.get("id").and_then(rpc_id_key) else {
        return;
    };
    let stage = state
        .lock()
        .ok()
        .and_then(|mut state| state.pending_requests.remove(&key));
    let Some(stage) = stage else {
        return;
    };
    let outcome = if message.get("error").is_some() {
        "error"
    } else {
        "ok"
    };
    append_protocol_trace(path, &format!("server.{stage}.{outcome}"));
}

// 尽力向指定文件追加时间戳和阶段信息，不写入协议正文。
fn append_protocol_trace(path: Option<&Path>, stage: &str) {
    let Some(path) = path else {
        return;
    };
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "[{timestamp_ms}] [codex-proxy] stage={stage}");
}

// 检查接管请求，拒绝新会话和恢复漂移，按需改写恢复参数并注入一次性交付上下文。
fn inspect_client_line(
    line: &[u8],
    expected_thread_id: Option<&str>,
    expected_model_provider: Option<&str>,
    remote_work_dir: Option<&str>,
    pending: &mut HashMap<String, PendingResume>,
    delivery_instruction_pending: &mut bool,
) -> ClientLineAction {
    let Ok(mut message) = serde_json::from_slice::<Value>(trim_line_ending(line)) else {
        return ClientLineAction::Forward(line.to_vec());
    };
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return ClientLineAction::Forward(line.to_vec());
    };
    let method = method.to_string();

    if method == "turn/start"
        && *delivery_instruction_pending
        && expected_thread_id.is_some()
        && remote_work_dir.is_none()
        && inject_local_handoff_delivery_context(&mut message)
    {
        *delivery_instruction_pending = false;
        return ClientLineAction::Forward(json_line(&message));
    }

    let Some(id) = message.get("id") else {
        return ClientLineAction::Forward(line.to_vec());
    };
    let id = id.clone();

    if method == "thread/start" {
        if let Some(expected) = expected_thread_id {
            return ClientLineAction::Reject(rpc_error_response(
                &id,
                format!(
                    "CLI-Manager blocked a fresh thread because remote handoff requires session {expected}"
                ),
            ));
        }
        return ClientLineAction::Forward(line.to_vec());
    }
    if method != "thread/resume" {
        return ClientLineAction::Forward(line.to_vec());
    }

    let requested_thread_id = message
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if let Some(expected) = expected_thread_id {
        if requested_thread_id != expected {
            return ClientLineAction::Reject(rpc_error_response(
                &id,
                format!(
                    "CLI-Manager detected Codex session drift: expected {expected}, received {}",
                    if requested_thread_id.is_empty() {
                        "an empty session ID"
                    } else {
                        &requested_thread_id
                    }
                ),
            ));
        }
    }
    let mut request_changed = false;
    if remote_work_dir.is_some() || expected_model_provider.is_some() {
        let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) else {
            return ClientLineAction::Reject(rpc_error_response(
                &id,
                "CLI-Manager received an invalid Codex resume request".to_string(),
            ));
        };
        if let Some(remote_work_dir) = remote_work_dir {
            params.insert(
                "cwd".to_string(),
                Value::String(remote_work_dir.to_string()),
            );
            request_changed = true;
        }
        if let Some(model_provider) = expected_model_provider {
            params.insert(
                "modelProvider".to_string(),
                Value::String(model_provider.to_string()),
            );
            request_changed = true;
        }
    }
    if let Some(key) = rpc_id_key(&id) {
        if pending.len() >= MAX_PENDING_RESUMES && !pending.contains_key(&key) {
            return ClientLineAction::Reject(rpc_error_response(
                &id,
                "CLI-Manager has too many pending Codex resume requests".to_string(),
            ));
        }
        pending.insert(
            key,
            PendingResume {
                requested_thread_id,
                expected_thread_id: expected_thread_id.map(str::to_string),
                expected_model_provider: expected_model_provider.map(str::to_string),
            },
        );
    }
    if request_changed {
        ClientLineAction::Forward(json_line(&message))
    } else {
        ClientLineAction::Forward(line.to_vec())
    }
}

// 仅在有文本输入且上下文结构可写时加入应用级交付说明，保留用户输入。
fn inject_local_handoff_delivery_context(message: &mut Value) -> bool {
    let has_text_input = message
        .pointer("/params/input")
        .and_then(Value::as_array)
        .is_some_and(|inputs| {
            inputs.iter().any(|input| {
                input.get("type").and_then(Value::as_str) == Some("text")
                    && input.get("text").is_some_and(Value::is_string)
            })
        });
    if !has_text_input {
        return false;
    }
    let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) else {
        return false;
    };
    let additional_context = params
        .entry("additionalContext".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if additional_context.is_null() {
        *additional_context = Value::Object(Default::default());
    }
    let Some(additional_context) = additional_context.as_object_mut() else {
        return false;
    };
    additional_context.insert(
        LOCAL_HANDOFF_DELIVERY_CONTEXT_KEY.to_string(),
        json!({
            "kind": "application",
            "value": LOCAL_HANDOFF_DELIVERY_INSTRUCTION,
        }),
    );
    true
}

// 将匹配会话的服务器活动、审批和终止事件转换为 Hook，忽略重试错误与其他事件。
fn ssh_handoff_hook_payload(
    line: &[u8],
    tab_id: &str,
    expected_thread_id: Option<&str>,
) -> Option<Value> {
    let message = serde_json::from_slice::<Value>(trim_line_ending(line)).ok()?;
    let method = message.get("method").and_then(Value::as_str)?;
    let params = message.get("params").and_then(Value::as_object)?;
    let session_id = params
        .get("threadId")
        .or_else(|| params.get("conversationId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(expected_thread_id)?;
    if expected_thread_id.is_some_and(|expected| session_id != expected) {
        return None;
    }

    let event = match method {
        "turn/started" => "UserPromptSubmit",
        "turn/completed" => match params
            .get("turn")
            .and_then(Value::as_object)
            .and_then(|turn| turn.get("status"))
            .and_then(Value::as_str)
        {
            Some("failed") => "StopFailure",
            Some("completed" | "interrupted") => "Stop",
            _ => return None,
        },
        "error"
            if !params
                .get("willRetry")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            "StopFailure"
        }
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval"
        | "item/tool/requestUserInput"
        | "mcpServer/elicitation/request"
        | "applyPatchApproval"
        | "execCommandApproval" => "PermissionRequest",
        _ => return None,
    };
    let tool_use_id = params
        .get("itemId")
        .or_else(|| params.get("approvalId"))
        .and_then(Value::as_str);
    Some(json!({
        "tabId": tab_id,
        "source": "codex",
        "event": event,
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "environmentType": "ssh",
        "goalStatus": if event == "Stop" { json!("none") } else { Value::Null },
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "remoteEventId": uuid::Uuid::new_v4().to_string(),
    }))
}

// 仅对已跟踪请求的非通知响应消费待恢复状态并生成压缩结果。
fn transform_server_line(
    line: &[u8],
    pending: &mut HashMap<String, PendingResume>,
) -> Option<Vec<u8>> {
    let payload = trim_line_ending(line);
    let probe = serde_json::from_slice::<RpcProbe>(payload).ok()?;
    if probe.method.is_some() {
        return None;
    }
    let id = probe.id.as_ref()?;
    let resume = pending.remove(&rpc_id_key(id)?)?;
    Some(compact_resume_response(payload, id, &resume))
}

// 校验恢复响应的线程和供应商身份，保留必要元数据并去掉历史；异常转换为 RPC 错误。
fn compact_resume_response(payload: &[u8], fallback_id: &Value, resume: &PendingResume) -> Vec<u8> {
    let envelope = match serde_json::from_slice::<ResumeResponseEnvelope>(payload) {
        Ok(envelope) => envelope,
        Err(err) => {
            return rpc_error_response(
                fallback_id,
                format!("CLI-Manager could not decode the Codex resume response: {err}"),
            )
        }
    };
    let response_id = envelope.id.as_ref().unwrap_or(fallback_id);
    if let Some(error) = envelope.error {
        return json_line(&json!({
            "jsonrpc": "2.0",
            "id": response_id,
            "error": {
                "code": error.code,
                "message": error.message,
            }
        }));
    }
    let Some(result) = envelope.result else {
        return rpc_error_response(
            response_id,
            "CLI-Manager received an empty Codex resume response".to_string(),
        );
    };
    if result.thread.id.trim().is_empty() {
        return rpc_error_response(
            response_id,
            "CLI-Manager received an empty Codex thread ID while resuming".to_string(),
        );
    }
    let resumed_model_provider = [
        result.model_provider.trim(),
        result.thread.model_provider.trim(),
    ]
    .into_iter()
    .find(|value| !value.is_empty())
    .unwrap_or_default()
    .to_string();
    if let Some(expected) = resume.expected_model_provider.as_deref() {
        if resumed_model_provider.is_empty() {
            return rpc_error_response(
                response_id,
                format!(
                    "CLI-Manager could not verify the Codex Provider after resume: expected {expected}, but Codex returned no Provider ID"
                ),
            );
        }
        if resumed_model_provider != expected {
            return rpc_error_response(
                response_id,
                format!(
                    "CLI-Manager blocked a Codex Provider mismatch after resume: expected {expected}, received {resumed_model_provider}"
                ),
            );
        }
    }
    if let Some(expected) = resume.expected_thread_id.as_deref() {
        if result.thread.id != expected {
            return rpc_error_response(
                response_id,
                format!(
                    "CLI-Manager detected Codex session drift after resume: expected {expected}, received {}",
                    result.thread.id
                ),
            );
        }
    }

    let compact = json_line(&json!({
        "jsonrpc": "2.0",
        "id": response_id,
        "result": {
            "cwd": result.cwd,
            "model": result.model,
            "modelProvider": resumed_model_provider.clone(),
            "reasoningEffort": result.reasoning_effort,
            "thread": {
                "id": result.thread.id,
                "modelProvider": resumed_model_provider,
            },
        }
    }));
    if payload.len() > 10 * 1024 * 1024 {
        eprintln!(
            "CLI-Manager compacted Codex thread/resume response from {} to {} bytes for session {}",
            payload.len(),
            compact.len(),
            resume.requested_thread_id
        );
    }
    compact
}

// 将数字或字符串 RPC ID 序列化为保留类型差异的映射键。
fn rpc_id_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(_) | Value::String(_) => serde_json::to_string(id).ok(),
        _ => None,
    }
}

// 生成使用严格恢复错误码的 JSON-RPC 单行错误响应。
fn rpc_error_response(id: &Value, message: String) -> Vec<u8> {
    json_line(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": STRICT_RESUME_ERROR_CODE,
            "message": message,
        }
    }))
}

// 序列化 JSON 并追加换行；序列化失败时返回固定内部错误响应。
fn json_line(value: &Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(value).unwrap_or_else(|_| {
        b"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"CLI-Manager proxy serialization failed\"}}".to_vec()
    });
    line.push(b'\n');
    line
}

// 移除字节片段尾部所有 CR/LF，不修改其他内容。
fn trim_line_ending(mut line: &[u8]) -> &[u8] {
    while line
        .last()
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
    {
        line = &line[..line.len() - 1];
    }
    line
}

// 在追加缓冲前检查行长度上限，读取到换行或 EOF；EOF 时允许返回未换行尾段。
fn read_protocol_line(reader: &mut impl BufRead, max_bytes: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(consumed) > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("app-server protocol line exceeds {max_bytes} bytes"),
            ));
        }
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if line.last() == Some(&b'\n') {
            return Ok(Some(line));
        }
    }
}

// 锁定父进程 stdout，完整写入并刷新协议行，锁或写入失败返回错误。
fn write_parent_line(output: &Arc<Mutex<io::Stdout>>, line: &[u8]) -> Result<(), String> {
    let mut output = output
        .lock()
        .map_err(|_| "parent output lock poisoned".to_string())?;
    output
        .write_all(line)
        .and_then(|_| output.flush())
        .map_err(|err| format!("write cc-connect response failed: {err}"))
}

#[cfg(test)]
mod tests;
