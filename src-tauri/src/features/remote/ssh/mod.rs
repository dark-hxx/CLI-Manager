mod process_io;
#[cfg(test)]
use process_io::{
    effective_ssh_user_command, is_authenticated_log, parse_effective_ssh_user, read_bounded,
};
use process_io::{
    host_key_fingerprint, resolve_effective_ssh_user, run_agent_input_process,
    run_agent_probe_process, run_ssh_auth_probe, single_line,
};

use cli_manager_hook_schema::{HookConfigReport, HookConfigRequest, HookExpectedFile};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::process::Command;
use std::time::Duration;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::shell_resolver::{output_with_timeout, silent_command};
use crate::ssh_agent_supply_chain::{download_artifact, fetch_verified_release, select_artifact};
use crate::ssh_transport::{
    format_remote_home_path, posix_quote, validate_remote_home_path, SshOneShotOptions,
    SshRemoteHomePathError, SshTransportLaunch, SshTransportSpec,
};

const SSH_AGENT_RESOURCE_ROOT: &str = "resources/ssh-agent";

const AGENT_PROBE_MAGIC: &str = "CLI_MANAGER_SSH_AGENT_PROBE/1";
const AGENT_ENV_MAGIC: &str = "CLI_MANAGER_SSH_AGENT_ENV/1";
const AGENT_OPERATION_MAGIC: &str = "CLI_MANAGER_SSH_AGENT_OPERATION/1";
const AGENT_HOOK_CONFIG_MAGIC: &str = "CLI_MANAGER_SSH_AGENT_HOOK_CONFIG/1";
const MAX_AGENT_HOOK_ENTRIES: u32 = 64;
const AGENT_PROTOCOL_MAJOR: u16 = 1;
const AGENT_PROTOCOL_MINOR_REQUIRED: u16 = 6;
const MAX_AGENT_PROBE_BANNER_BYTES: usize = 8 * 1024;
const MAX_AGENT_PROBE_REPORT_BYTES: usize = 64 * 1024;
const MAX_AGENT_PROBE_STDERR_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshClientStatus {
    available: bool,
    version: Option<String>,
    error: Option<String>,
}

pub type SshConnectionSpec = SshTransportSpec;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDiagnosticStage {
    key: String,
    status: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionTestResult {
    success: bool,
    stages: Vec<SshDiagnosticStage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathCheckResult {
    exists: bool,
    accessible: bool,
    git_repository: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryEntry {
    name: String,
    path: String,
}

struct SshAuthProbeOutput {
    authenticated: bool,
    timed_out: bool,
    status_success: bool,
    status_code: Option<i32>,
    stderr: String,
}

struct AgentProbeProcessOutput {
    status_success: bool,
    status_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
}

// 委托共享传输模型校验 SSH 连接参数。
fn validate_spec(spec: &SshConnectionSpec) -> Result<(), String> {
    spec.validate()
}

// 将主机 UUID 规范化为凭据存储账户名。
fn ssh_password_account(host_id: &str) -> Result<String, String> {
    let id = Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    Ok(format!("ssh:{id}:password"))
}

#[tauri::command]
// 拒绝空密码并在阻塞任务中保存凭据，返回账户引用。
pub async fn ssh_save_password(host_id: String, password: String) -> Result<String, String> {
    if password.is_empty() {
        return Err("ssh_password_required".to_string());
    }
    let account = ssh_password_account(&host_id)?;
    let account_for_store = account.clone();
    tokio::task::spawn_blocking(move || {
        crate::credential_store::set(&account_for_store, &password)
    })
    .await
    .map_err(|err| format!("ssh credential task failed: {err}"))??;
    Ok(account)
}

#[tauri::command]
// 查询该主机的凭据是否存在且非空。
pub async fn ssh_password_status(host_id: String) -> Result<bool, String> {
    let account = ssh_password_account(&host_id)?;
    tokio::task::spawn_blocking(move || {
        crate::credential_store::get(&account)
            .map(|value| value.is_some_and(|item| !item.is_empty()))
    })
    .await
    .map_err(|err| format!("ssh credential task failed: {err}"))?
}

#[tauri::command]
// 在阻塞任务中删除该主机保存的密码。
pub async fn ssh_delete_password(host_id: String) -> Result<(), String> {
    let account = ssh_password_account(&host_id)?;
    tokio::task::spawn_blocking(move || crate::credential_store::delete(&account))
        .await
        .map_err(|err| format!("ssh credential task failed: {err}"))?
}

// 校验绝对 POSIX 路径并拒绝控制换行及父级段。
fn validate_remote_path(path: &str) -> Result<&str, String> {
    let path = path.trim();
    if !path.starts_with('/') || path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err("ssh_remote_path_invalid".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("ssh_remote_path_parent_forbidden".to_string());
    }
    Ok(path)
}

// 拒绝需要真实终端交互的认证方式。
fn ensure_non_interactive(spec: &SshConnectionSpec) -> Result<(), String> {
    if matches!(spec.auth_mode.as_str(), "password_prompt" | "interactive") {
        return Err("ssh_interactive_auth_required".to_string());
    }
    Ok(())
}

// 按一次性传输选项构造远程命令进程。
fn ssh_remote_command_with_options(
    spec: &SshConnectionSpec,
    remote_command: &str,
    verbose: bool,
    accept_new_host_key: bool,
) -> Result<Command, String> {
    let launch = spec.build_one_shot_launch(
        remote_command.to_string(),
        SshOneShotOptions {
            verbose,
            accept_new_host_key,
        },
    )?;
    Ok(command_from_transport_launch(launch))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentProbeResult {
    status: String,
    code: String,
    installation_id: String,
    remote_machine_id: String,
    install_path: String,
    agent_version: String,
    protocol_version: String,
    target: String,
    supported: bool,
    detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentVersionProbe {
    agent_name: String,
    agent_version: String,
    protocol_major: u16,
    protocol_minor: u16,
    target_os: String,
    target_arch: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AgentDoctorProbe {
    version: AgentVersionProbe,
    supported: bool,
    code: String,
    installation: Option<AgentDoctorInstallation>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentDoctorInstallation {
    installation_id: String,
    remote_machine_id: String,
}

#[derive(Debug)]
enum ParsedAgentProbe {
    NotInstalled,
    Report {
        install_path: String,
        report: AgentDoctorProbe,
    },
}

// 将传输计划转换为静默进程及其参数、环境。
fn command_from_transport_launch(launch: SshTransportLaunch) -> Command {
    let mut command = silent_command(&launch.executable);
    command.args(launch.args).envs(launch.env);
    command
}

// 以默认一次性选项构造远程命令。
fn ssh_remote_command(spec: &SshConnectionSpec, remote_command: &str) -> Result<Command, String> {
    ssh_remote_command_with_options(spec, remote_command, false, false)
}

// 构造带详细认证日志及主机密钥策略的 true 探测命令。
fn ssh_probe_command(
    spec: &SshConnectionSpec,
    accept_new_host_key: bool,
) -> Result<Command, String> {
    ssh_remote_command_with_options(spec, "true", true, accept_new_host_key)
}

// 生成依次检查显式路径、PATH 和标准目录的 Agent 发现脚本。
fn agent_discovery_script(agent_path: Option<&str>) -> Result<String, String> {
    let explicit = match agent_path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => {
            validate_remote_home_path(path).map_err(|error| match error {
                SshRemoteHomePathError::Invalid => "ssh_agent_path_invalid".to_string(),
                SshRemoteHomePathError::ParentTraversal => {
                    "ssh_agent_path_parent_forbidden".to_string()
                }
            })?;
            Some(format_remote_home_path(path))
        }
        None => None,
    };
    let explicit_probe = explicit
        .map(|path| format!("if [ -x {path} ]; then agent={path}; fi\n"))
        .unwrap_or_default();
    Ok(format!(
        "agent=''\n{explicit_probe}\
         if [ -z \"$agent\" ] && command -v cli-manager-ssh-agent >/dev/null 2>&1; then agent=$(command -v cli-manager-ssh-agent); fi\n\
         if [ -z \"$agent\" ] && [ -x \"${{HOME}}/.local/bin/cli-manager-ssh-agent\" ]; then agent=\"${{HOME}}/.local/bin/cli-manager-ssh-agent\"; fi\n\
         data_agent=\"${{XDG_DATA_HOME:-${{HOME}}/.local/share}}/cli-manager-ssh-agent/current/cli-manager-ssh-agent\"\n\
         if [ -z \"$agent\" ] && [ -x \"$data_agent\" ]; then agent=\"$data_agent\"; fi\n"
    ))
}

// 生成输出探测标记、路径及 doctor 报告的脚本。
fn build_agent_probe_script(agent_path: Option<&str>) -> Result<String, String> {
    let discovery = agent_discovery_script(agent_path)?;
    Ok(format!(
        "set -eu\n{discovery}\
         if [ -z \"$agent\" ]; then printf '{AGENT_PROBE_MAGIC} notInstalled\\n'; exit 127; fi\n\
         printf '{AGENT_PROBE_MAGIC} found\\n%s\\n' \"$agent\"\n\
         exec \"$agent\" doctor"
    ))
}

#[derive(Debug, Clone)]
struct RemoteAgentEnvironment {
    target: String,
    install_root: String,
    state_dir: String,
    install_path: String,
}

// 生成识别 Linux 架构和 HOME/XDG 安装布局的脚本。
fn build_agent_environment_script() -> String {
    format!(
        "set -eu\n\
         if [ -z \"${{HOME:-}}\" ]; then printf '{AGENT_ENV_MAGIC} error\\nhome_directory_unavailable\\n'; exit 65; fi\n\
         os=$(uname -s 2>/dev/null || true)\narch=$(uname -m 2>/dev/null || true)\n\
         case \"$os/$arch\" in Linux/x86_64|Linux/amd64) target='linux-x86_64' ;; Linux/aarch64|Linux/arm64) target='linux-aarch64' ;; *) printf '{AGENT_ENV_MAGIC} error\\nunsupported_target:%s/%s\\n' \"$os\" \"$arch\"; exit 65 ;; esac\n\
         install_root=\"${{XDG_DATA_HOME:-${{HOME}}/.local/share}}/cli-manager-ssh-agent\"\n\
         state_dir=\"${{XDG_STATE_HOME:-${{HOME}}/.local/state}}/cli-manager-ssh-agent\"\n\
         install_path=\"${{HOME}}/.local/bin/cli-manager-ssh-agent\"\n\
         printf '{AGENT_ENV_MAGIC} found\\n%s\\n%s\\n%s\\n%s\\n' \"$target\" \"$install_root\" \"$state_dir\" \"$install_path\""
    )
}

// 解析受限 banner 后的环境标记、目标和三个远程路径。
fn parse_agent_environment(stdout: &[u8]) -> Result<RemoteAgentEnvironment, String> {
    let text = std::str::from_utf8(stdout)
        .map_err(|_| "ssh_agent_environment_output_invalid".to_string())?;
    let marker_offset = text
        .find(AGENT_ENV_MAGIC)
        .ok_or_else(|| "ssh_agent_environment_magic_missing".to_string())?;
    if marker_offset > MAX_AGENT_PROBE_BANNER_BYTES {
        return Err("ssh_agent_probe_banner_too_large".to_string());
    }
    let mut lines = text[marker_offset..].lines();
    match lines.next() {
        Some(line) if line.trim_end_matches('\r') == format!("{AGENT_ENV_MAGIC} found") => {}
        Some(line) if line.trim_end_matches('\r') == format!("{AGENT_ENV_MAGIC} error") => {
            return Err(lines
                .next()
                .unwrap_or("ssh_agent_environment_failed")
                .to_string())
        }
        _ => return Err("ssh_agent_environment_magic_invalid".to_string()),
    }
    let target = lines
        .next()
        .ok_or_else(|| "ssh_agent_environment_output_invalid".to_string())?
        .trim_end_matches('\r')
        .to_string();
    if !matches!(target.as_str(), "linux-x86_64" | "linux-aarch64") {
        return Err("unsupported_target".to_string());
    }
    let mut next_path = || -> Result<String, String> {
        let path = lines
            .next()
            .ok_or_else(|| "ssh_agent_environment_output_invalid".to_string())?
            .trim_end_matches('\r')
            .to_string();
        validate_remote_home_path(&path)
            .map_err(|_| "ssh_agent_environment_path_invalid".to_string())?;
        Ok(path)
    };
    let environment = RemoteAgentEnvironment {
        target,
        install_root: next_path()?,
        state_dir: next_path()?,
        install_path: next_path()?,
    };
    if lines.any(|line| !line.trim().is_empty()) {
        return Err("ssh_agent_environment_output_contaminated".to_string());
    }
    Ok(environment)
}

// 运行非交互环境探测并转换输出或连接失败原因。
async fn detect_remote_agent_environment(
    spec: &SshConnectionSpec,
) -> Result<RemoteAgentEnvironment, String> {
    validate_spec(spec)?;
    ensure_non_interactive(spec)?;
    let launch = spec.build_one_shot_launch(
        build_agent_environment_script(),
        SshOneShotOptions::default(),
    )?;
    let timeout = Duration::from_secs(spec.connect_timeout_sec.saturating_add(15).min(315));
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_agent_probe_process(command_from_transport_launch(launch), timeout)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("ssh_agent_environment_failed:{error}"))?;
    if output.stdout_truncated {
        return Err("ssh_agent_probe_output_too_large".to_string());
    }
    parse_agent_environment(&output.stdout).map_err(|error| {
        if error == "ssh_agent_environment_magic_missing" && output.status_code == Some(255) {
            "ssh_agent_unreachable".to_string()
        } else if error == "ssh_agent_environment_magic_missing" {
            let detail = single_line(&output.stderr);
            if detail.is_empty() {
                error
            } else {
                format!("{error}:{detail}")
            }
        } else {
            error
        }
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentInstallPreview {
    action: String,
    manifest_url: String,
    channel: String,
    version: String,
    protocol_min: u16,
    protocol_max: u16,
    target: String,
    artifact_url: String,
    artifact_size: u64,
    artifact_sha256: String,
    install_root: String,
    install_path: String,
    current_version: String,
    distribution_source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshAgentInstallProgress {
    phase: &'static str,
    progress: u8,
}

// 向该主机的安装进度事件发送阶段及百分比。
fn emit_agent_install_progress(app: &AppHandle, host_id: &str, phase: &'static str, progress: u8) {
    let event = format!("ssh-agent-install-progress-{}", host_id.trim());
    let _ = app.emit(&event, SshAgentInstallProgress { phase, progress });
}

// 解析桌面资源中的内置 Agent 发布目录。
fn bundled_agent_release_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve(SSH_AGENT_RESOURCE_ROOT, BaseDirectory::Resource)
        .map_err(|error| format!("ssh_agent_bundled_resource_resolve_failed:{error}"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentOperationInstallation {
    installation_id: String,
    remote_machine_id: String,
    agent_version: String,
    protocol_version: String,
    target: String,
    install_root: String,
    install_path: String,
    source: String,
    manifest_url: String,
    artifact_sha256: String,
    previous_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentOperationReport {
    action: String,
    installation: Option<AgentOperationInstallation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentOperationResult {
    action: String,
    installation_id: String,
    remote_machine_id: String,
    agent_version: String,
    protocol_version: String,
    target: String,
    install_root: String,
    install_path: String,
    source: String,
    manifest_url: String,
    artifact_sha256: String,
    previous_version: String,
}

// 解析操作标记后的 JSON 并校验安装元数据。
fn parse_agent_operation(stdout: &[u8]) -> Result<AgentOperationReport, String> {
    let text = std::str::from_utf8(stdout)
        .map_err(|_| "ssh_agent_operation_output_invalid".to_string())?;
    let marker_offset = text
        .find(AGENT_OPERATION_MAGIC)
        .ok_or_else(|| "ssh_agent_operation_magic_missing".to_string())?;
    if marker_offset > MAX_AGENT_PROBE_BANNER_BYTES {
        return Err("ssh_agent_probe_banner_too_large".to_string());
    }
    let (marker, payload) = text[marker_offset..]
        .split_once('\n')
        .ok_or_else(|| "ssh_agent_operation_output_invalid".to_string())?;
    if marker.trim_end_matches('\r') != format!("{AGENT_OPERATION_MAGIC} result") {
        return Err("ssh_agent_operation_magic_invalid".to_string());
    }
    let report: AgentOperationReport = serde_json::from_str(payload.trim())
        .map_err(|_| "ssh_agent_operation_output_contaminated".to_string())?;
    validate_agent_operation(&report)?;
    Ok(report)
}

// 校验操作类型以及对应安装身份、版本、路径和来源字段。
fn validate_agent_operation(report: &AgentOperationReport) -> Result<(), String> {
    let needs_installation = matches!(
        report.action.as_str(),
        "installed" | "updated" | "rolledBack"
    );
    let removes_installation = matches!(report.action.as_str(), "uninstalled" | "purged");
    if !needs_installation && !removes_installation {
        return Err("ssh_agent_operation_action_invalid".to_string());
    }
    if removes_installation {
        return if report.installation.is_none() {
            Ok(())
        } else {
            Err("ssh_agent_operation_installation_unexpected".to_string())
        };
    }
    let installation = report
        .installation
        .as_ref()
        .ok_or_else(|| "ssh_agent_operation_installation_missing".to_string())?;
    Uuid::parse_str(&installation.installation_id)
        .map_err(|_| "ssh_agent_operation_installation_id_invalid".to_string())?;
    if installation.remote_machine_id.is_empty()
        || installation.remote_machine_id.len() > 256
        || installation.remote_machine_id.contains(['\0', '\r', '\n'])
    {
        return Err("ssh_agent_operation_machine_id_invalid".to_string());
    }
    Version::parse(installation.agent_version.trim_start_matches('v'))
        .map_err(|_| "ssh_agent_operation_version_invalid".to_string())?;
    let (protocol_major, protocol_minor) = installation
        .protocol_version
        .split_once('.')
        .ok_or_else(|| "ssh_agent_operation_protocol_invalid".to_string())?;
    if protocol_major.parse::<u16>().ok() != Some(AGENT_PROTOCOL_MAJOR)
        || protocol_minor.parse::<u16>().is_err()
    {
        return Err("ssh_agent_operation_protocol_invalid".to_string());
    }
    if !matches!(
        installation.target.as_str(),
        "linux/x86_64" | "linux/aarch64"
    ) {
        return Err("ssh_agent_operation_target_invalid".to_string());
    }
    for path in [&installation.install_root, &installation.install_path] {
        validate_remote_home_path(path)
            .map_err(|_| "ssh_agent_operation_path_invalid".to_string())?;
    }
    if !matches!(
        installation.source.as_str(),
        "desktop" | "https-script" | "http-script" | "manual"
    ) {
        return Err("ssh_agent_operation_source_invalid".to_string());
    }
    if !installation.manifest_url.is_empty() {
        let url = reqwest::Url::parse(&installation.manifest_url)
            .map_err(|_| "ssh_agent_operation_manifest_url_invalid".to_string())?;
        if !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("ssh_agent_operation_manifest_url_invalid".to_string());
        }
    }
    if installation.source != "manual" && installation.manifest_url.is_empty() {
        return Err("ssh_agent_operation_manifest_url_missing".to_string());
    }
    if !installation.artifact_sha256.is_empty()
        && (installation.artifact_sha256.len() != 64
            || !installation
                .artifact_sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit()))
    {
        return Err("ssh_agent_operation_sha256_invalid".to_string());
    }
    if installation.source != "manual" && installation.artifact_sha256.is_empty() {
        return Err("ssh_agent_operation_sha256_missing".to_string());
    }
    if !installation.previous_version.is_empty() {
        Version::parse(installation.previous_version.trim_start_matches('v'))
            .map_err(|_| "ssh_agent_operation_previous_version_invalid".to_string())?;
    }
    Ok(())
}

// 将操作报告展开为响应，缺失安装信息时使用空字段。
fn operation_result(report: AgentOperationReport) -> SshAgentOperationResult {
    let installation = report.installation;
    SshAgentOperationResult {
        action: report.action,
        installation_id: installation
            .as_ref()
            .map(|value| value.installation_id.clone())
            .unwrap_or_default(),
        remote_machine_id: installation
            .as_ref()
            .map(|value| value.remote_machine_id.clone())
            .unwrap_or_default(),
        agent_version: installation
            .as_ref()
            .map(|value| value.agent_version.clone())
            .unwrap_or_default(),
        protocol_version: installation
            .as_ref()
            .map(|value| value.protocol_version.clone())
            .unwrap_or_default(),
        target: installation
            .as_ref()
            .map(|value| value.target.clone())
            .unwrap_or_default(),
        install_root: installation
            .as_ref()
            .map(|value| value.install_root.clone())
            .unwrap_or_default(),
        install_path: installation
            .as_ref()
            .map(|value| value.install_path.clone())
            .unwrap_or_default(),
        source: installation
            .as_ref()
            .map(|value| value.source.clone())
            .unwrap_or_default(),
        manifest_url: installation
            .as_ref()
            .map(|value| value.manifest_url.clone())
            .unwrap_or_default(),
        artifact_sha256: installation
            .as_ref()
            .map(|value| value.artifact_sha256.clone())
            .unwrap_or_default(),
        previous_version: installation
            .map(|value| value.previous_version)
            .unwrap_or_default(),
    }
}

// 选取请求或默认安装根目录并校验远程路径语法。
fn validated_install_root(
    requested: Option<&str>,
    environment: &RemoteAgentEnvironment,
) -> Result<String, String> {
    let root = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&environment.install_root);
    validate_remote_home_path(root).map_err(|error| match error {
        SshRemoteHomePathError::Invalid => "ssh_agent_install_dir_invalid".to_string(),
        SshRemoteHomePathError::ParentTraversal => {
            "ssh_agent_install_dir_parent_forbidden".to_string()
        }
    })?;
    Ok(root.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentAvailableRelease {
    action: String,
    manifest_url: String,
    channel: String,
    version: String,
    protocol_min: u16,
    protocol_max: u16,
    published_at: String,
    current_version: String,
    distribution_source: String,
}

// 组合已验证发布信息及基于当前版本的动作预览。
fn available_release_preview(
    manifest_url: String,
    channel: String,
    version: String,
    protocol_min: u16,
    protocol_max: u16,
    published_at: String,
    distribution_source: String,
    current_version: Option<&str>,
) -> SshAgentAvailableRelease {
    let current = current_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string();
    SshAgentAvailableRelease {
        action: install_action(current_version, &version),
        manifest_url,
        channel,
        version,
        protocol_min,
        protocol_max,
        published_at,
        current_version: current,
        distribution_source,
    }
}

// 比较语义版本确定安装、升级、重装或降级。
fn install_action(current_version: Option<&str>, incoming_version: &str) -> String {
    let Some(current) = current_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Version::parse(value.trim_start_matches('v')).ok())
    else {
        return "install".to_string();
    };
    let Ok(incoming) = Version::parse(incoming_version.trim_start_matches('v')) else {
        return "install".to_string();
    };
    match incoming.cmp(&current) {
        std::cmp::Ordering::Greater => "upgrade",
        std::cmp::Ordering::Equal => "reinstall",
        std::cmp::Ordering::Less => "downgrade",
    }
    .to_string()
}

// 生成接收二进制、执行安装并清理随机暂存目录的脚本。
fn build_agent_install_script(
    environment: &RemoteAgentEnvironment,
    install_root: &str,
    manifest_url: &str,
    artifact_sha256: &str,
    allow_downgrade: bool,
) -> String {
    let staging = format!(
        "{}/upload-{}",
        environment.state_dir.trim_end_matches('/'),
        Uuid::new_v4().simple()
    );
    let downgrade = if allow_downgrade {
        " --allow-downgrade"
    } else {
        ""
    };
    format!(
        "set -eu\numask 077\nstage={}\nmkdir -p \"$stage\"\ntrap 'rm -rf \"$stage\"' EXIT HUP INT TERM\n\
         cat > \"$stage/cli-manager-ssh-agent\"\nchmod 700 \"$stage/cli-manager-ssh-agent\"\n\
         printf '{AGENT_OPERATION_MAGIC} result\\n'\nset +e\n\
         \"$stage/cli-manager-ssh-agent\" install --install-dir {} --source desktop --manifest-url {} --artifact-sha256 {}{}\n\
         status=$?\nset -e\nrm -rf \"$stage\"\ntrap - EXIT HUP INT TERM\nexit $status",
        posix_quote(&staging),
        posix_quote(install_root),
        posix_quote(manifest_url),
        posix_quote(artifact_sha256),
        downgrade,
    )
}

// 生成仅允许回滚或卸载的 Agent 管理脚本。
fn build_agent_management_script(
    agent_path: Option<&str>,
    command: &str,
    purge: bool,
) -> Result<String, String> {
    if !matches!(command, "rollback" | "uninstall") {
        return Err("ssh_agent_operation_invalid".to_string());
    }
    let discovery = agent_discovery_script(agent_path)?;
    let purge = if purge { " --purge" } else { "" };
    Ok(format!(
        "set -eu\n{discovery}\
         if [ -z \"$agent\" ]; then exit 127; fi\n\
         printf '{AGENT_OPERATION_MAGIC} result\\n'\n\
         exec \"$agent\" {command}{purge}"
    ))
}

// 规范化并限制 Hook 来源为支持的四种 CLI。
fn validate_hook_source(source: &str) -> Result<&str, String> {
    match source.trim() {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        "kimi" => Ok("kimi"),
        "grok" => Ok("grok"),
        _ => Err("hook_source_invalid".to_string()),
    }
}

// 允许默认空根目录，否则校验远程 HOME 路径语法。
fn validate_hook_config_root(root: &str) -> Result<&str, String> {
    let root = root.trim();
    if root.is_empty() {
        return Ok(root);
    }
    validate_remote_home_path(root).map_err(|error| match error {
        SshRemoteHomePathError::Invalid => "hook_config_root_invalid".to_string(),
        SshRemoteHomePathError::ParentTraversal => "hook_config_root_parent_forbidden".to_string(),
    })?;
    Ok(root)
}

// 生成受限动作的 Agent Hook 配置调用脚本。
fn build_agent_hook_config_script(
    agent_path: Option<&str>,
    action: &str,
) -> Result<String, String> {
    if !matches!(
        action,
        "inspect" | "preview-install" | "preview-uninstall" | "install" | "uninstall"
    ) {
        return Err("hook_config_action_invalid".to_string());
    }
    let discovery = agent_discovery_script(agent_path)?;
    Ok(format!(
        "set -eu\n{discovery}\
         if [ -z \"$agent\" ]; then exit 127; fi\n\
         printf '{AGENT_HOOK_CONFIG_MAGIC} result\\n'\n\
         exec \"$agent\" hook-config {action}"
    ))
}

// 判断指纹是否为 missing 或 64 位十六进制摘要。
fn validate_hook_fingerprint(value: &str) -> bool {
    value == "missing" || (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

// 检查报告路径为无父级段和禁用字符的绝对 POSIX 路径。
fn validate_hook_remote_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.contains(['\0', '\r', '\n', '\\'])
        && !value.split('/').any(|segment| segment == "..")
}

// 解析 Hook 配置标记后的单个 JSON 报告。
fn parse_agent_hook_config(stdout: &[u8]) -> Result<HookConfigReport, String> {
    let text =
        std::str::from_utf8(stdout).map_err(|_| "ssh_agent_hook_output_invalid".to_string())?;
    let marker_offset = text
        .find(AGENT_HOOK_CONFIG_MAGIC)
        .ok_or_else(|| "ssh_agent_hook_magic_missing".to_string())?;
    if marker_offset > MAX_AGENT_PROBE_BANNER_BYTES {
        return Err("ssh_agent_probe_banner_too_large".to_string());
    }
    let (marker, payload) = text[marker_offset..]
        .split_once('\n')
        .ok_or_else(|| "ssh_agent_hook_output_invalid".to_string())?;
    if marker.trim_end_matches('\r') != format!("{AGENT_HOOK_CONFIG_MAGIC} result") {
        return Err("ssh_agent_hook_magic_invalid".to_string());
    }
    serde_json::from_str(payload.trim())
        .map_err(|_| "ssh_agent_hook_output_contaminated".to_string())
}

// 校验 Hook 报告与请求身份、根目录、文件变更及安装记录一致。
fn validate_agent_hook_report(
    report: &HookConfigReport,
    expected_action: &str,
    expected_source: &str,
    expected_installation_id: &str,
    expected_remote_machine_id: &str,
    expected_configured_root: &str,
    expected_canonical_root: Option<&str>,
) -> Result<(), String> {
    if report.action != expected_action {
        return Err("ssh_agent_hook_action_invalid".to_string());
    }
    if report.source != expected_source {
        return Err("ssh_agent_hook_source_invalid".to_string());
    }
    if report.configured_config_root != expected_configured_root {
        return Err("ssh_agent_hook_root_invalid".to_string());
    }
    Uuid::parse_str(&report.installation_id)
        .map_err(|_| "ssh_agent_hook_installation_id_invalid".to_string())?;
    if report.installation_id != expected_installation_id {
        return Err("ssh_agent_identity_changed".to_string());
    }
    if report.remote_machine_id.is_empty()
        || report.remote_machine_id.len() > 256
        || report.remote_machine_id.contains(['\0', '\r', '\n'])
    {
        return Err("ssh_agent_hook_machine_id_invalid".to_string());
    }
    if report.remote_machine_id != expected_remote_machine_id {
        return Err("ssh_agent_identity_changed".to_string());
    }
    if !matches!(
        report.status.as_str(),
        "notInstalled" | "partialInstalled" | "outdated" | "installed" | "conflict"
    ) {
        return Err("ssh_agent_hook_status_invalid".to_string());
    }
    if !validate_hook_remote_path(&report.canonical_config_root)
        || report.config_root_hash.len() != 64
        || !report
            .config_root_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("ssh_agent_hook_root_invalid".to_string());
    }
    if expected_canonical_root.is_some_and(|expected| report.canonical_config_root != expected) {
        return Err("hook_config_root_changed".to_string());
    }
    if report.will_create_config_root
        && (expected_action != "previewInstall" || report.config_root_exists)
        || expected_action == "installed" && !report.config_root_exists
    {
        return Err("ssh_agent_hook_root_invalid".to_string());
    }
    let required = report.required_entries;
    if required == 0 || required > MAX_AGENT_HOOK_ENTRIES || report.managed_entries > required {
        return Err("ssh_agent_hook_count_invalid".to_string());
    }
    let expected_roles: HashSet<&str> = match expected_source {
        "claude" => HashSet::from(["claudeSettings"]),
        "codex" => HashSet::from(["codexHooks", "codexFeature"]),
        "kimi" => HashSet::from(["kimiConfig"]),
        "grok" => HashSet::from(["grokHooks", "grokCompat"]),
        _ => return Err("ssh_agent_hook_source_invalid".to_string()),
    };
    let mut files = HashSet::new();
    for file in &report.config_files {
        if !expected_roles.contains(file.role.as_str())
            || !validate_hook_remote_path(&file.canonical_path)
            || !validate_hook_fingerprint(&file.fingerprint)
            || !files.insert((file.role.as_str(), file.canonical_path.as_str()))
        {
            return Err("ssh_agent_hook_file_invalid".to_string());
        }
    }
    let expected_file_count = if matches!(expected_source, "codex" | "grok") {
        2
    } else {
        1
    };
    if report.config_files.len() != expected_file_count {
        return Err("ssh_agent_hook_file_invalid".to_string());
    }
    for change in &report.changes {
        if !files.contains(&(change.role.as_str(), change.canonical_path.as_str()))
            || !validate_hook_fingerprint(&change.before_fingerprint)
            || !validate_hook_fingerprint(&change.after_fingerprint)
            || !matches!(
                change.action.as_str(),
                "unchanged" | "create" | "update" | "delete"
            )
        {
            return Err("ssh_agent_hook_change_invalid".to_string());
        }
        let Some(file) = report
            .config_files
            .iter()
            .find(|file| file.role == change.role && file.canonical_path == change.canonical_path)
        else {
            return Err("ssh_agent_hook_change_invalid".to_string());
        };
        let expected_fingerprint = if matches!(expected_action, "installed" | "uninstalled") {
            &change.after_fingerprint
        } else {
            &change.before_fingerprint
        };
        if &file.fingerprint != expected_fingerprint {
            return Err("ssh_agent_hook_change_invalid".to_string());
        }
    }
    if report.changes.len() != report.config_files.len() {
        return Err("ssh_agent_hook_change_invalid".to_string());
    }
    if let Some(record) = &report.installation {
        let history_candidate_valid = match (
            report.source.as_str(),
            record.history_source_candidate.as_ref(),
        ) {
            ("kimi" | "grok", None) => true,
            ("claude" | "codex", Some(candidate)) => {
                candidate.source == report.source
                    && candidate.canonical_config_root == report.canonical_config_root
                    && candidate.config_root_hash == report.config_root_hash
            }
            _ => false,
        };
        if expected_action != "installed"
            || record.source != report.source
            || record.installation_id != report.installation_id
            || record.owner_id != format!("cli-manager-ssh-agent:{}", report.installation_id)
            || record.configured_config_root != report.configured_config_root
            || record.canonical_config_root != report.canonical_config_root
            || !history_candidate_valid
            || record.adapter_version == 0
            || record.managed_entries != required
            || record.config_files.len() != report.config_files.len()
        {
            return Err("ssh_agent_hook_record_invalid".to_string());
        }
        let mut record_files = HashSet::new();
        for file in &record.config_files {
            if !files.contains(&(file.role.as_str(), file.canonical_path.as_str()))
                || !record_files.insert((file.role.as_str(), file.canonical_path.as_str()))
                || !validate_hook_fingerprint(&file.before_fingerprint)
                || !validate_hook_fingerprint(&file.after_fingerprint)
            {
                return Err("ssh_agent_hook_record_invalid".to_string());
            }
            let Some(change) = report.changes.iter().find(|change| {
                change.role == file.role && change.canonical_path == file.canonical_path
            }) else {
                return Err("ssh_agent_hook_record_invalid".to_string());
            };
            if file.before_fingerprint != change.before_fingerprint
                || file.after_fingerprint != change.after_fingerprint
            {
                return Err("ssh_agent_hook_record_invalid".to_string());
            }
        }
        if record_files != files {
            return Err("ssh_agent_hook_record_invalid".to_string());
        }
    } else if expected_action == "installed" {
        return Err("ssh_agent_hook_record_missing".to_string());
    }
    Ok(())
}

// 发送 Hook 配置请求并校验成功响应的身份和文件契约。
async fn run_agent_hook_config(
    spec: &SshConnectionSpec,
    agent_path: Option<&str>,
    action: &str,
    expected_action: &str,
    expected_installation_id: &str,
    expected_remote_machine_id: &str,
    request: HookConfigRequest,
) -> Result<HookConfigReport, String> {
    validate_spec(spec)?;
    ensure_non_interactive(spec)?;
    Uuid::parse_str(expected_installation_id)
        .map_err(|_| "ssh_agent_identity_required".to_string())?;
    if expected_remote_machine_id.is_empty()
        || expected_remote_machine_id.len() > 256
        || expected_remote_machine_id.contains(['\0', '\r', '\n'])
    {
        return Err("ssh_agent_identity_required".to_string());
    }
    let source = validate_hook_source(&request.source)?.to_string();
    let configured_root = request.configured_config_root.clone();
    let expected_canonical_root = request.expected_canonical_root.clone();
    let script = build_agent_hook_config_script(agent_path, action)?;
    let input =
        serde_json::to_vec(&request).map_err(|_| "ssh_agent_hook_request_invalid".to_string())?;
    let launch = spec.build_one_shot_launch(script, SshOneShotOptions::default())?;
    let timeout = Duration::from_secs(spec.connect_timeout_sec.saturating_add(45).min(345));
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_agent_input_process(command_from_transport_launch(launch), input, timeout)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("ssh_agent_hook_operation_failed:{error}"))?;
    if output.stdout_truncated {
        return Err("ssh_agent_probe_output_too_large".to_string());
    }
    let report = match parse_agent_hook_config(&output.stdout) {
        Ok(report) if output.status_success => report,
        Ok(_) | Err(_) => {
            let detail = single_line(&output.stderr);
            return Err(if detail.is_empty() {
                format!(
                    "ssh_agent_hook_operation_failed:{}",
                    output.status_code.unwrap_or(-1)
                )
            } else {
                detail
            });
        }
    };
    validate_agent_hook_report(
        &report,
        expected_action,
        &source,
        expected_installation_id,
        expected_remote_machine_id,
        &configured_root,
        expected_canonical_root.as_deref(),
    )?;
    Ok(report)
}

// 执行可带二进制输入的 Agent 管理操作并转换结果。
async fn run_agent_operation(
    spec: &SshConnectionSpec,
    script: String,
    input: Option<Vec<u8>>,
) -> Result<SshAgentOperationResult, String> {
    let launch = spec.build_one_shot_launch(script, SshOneShotOptions::default())?;
    let timeout = Duration::from_secs(spec.connect_timeout_sec.saturating_add(180).min(480));
    let output = tauri::async_runtime::spawn_blocking(move || match input {
        Some(input) => {
            run_agent_input_process(command_from_transport_launch(launch), input, timeout)
        }
        None => run_agent_probe_process(command_from_transport_launch(launch), timeout),
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("ssh_agent_operation_failed:{error}"))?;
    if output.stdout_truncated {
        return Err("ssh_agent_probe_output_too_large".to_string());
    }
    match parse_agent_operation(&output.stdout) {
        Ok(report) if output.status_success => Ok(operation_result(report)),
        Ok(_) | Err(_) => {
            let detail = single_line(&output.stderr);
            if detail.is_empty() {
                Err(format!(
                    "ssh_agent_operation_failed:{}",
                    output.status_code.unwrap_or(-1)
                ))
            } else {
                Err(detail)
            }
        }
    }
}

// 在输出及 banner 限额内解析 Agent 缺失或 doctor 报告。
fn parse_agent_probe_stdout(stdout: &[u8]) -> Result<ParsedAgentProbe, String> {
    if stdout.len() > MAX_AGENT_PROBE_REPORT_BYTES {
        return Err("ssh_agent_probe_output_too_large".to_string());
    }
    let text =
        std::str::from_utf8(stdout).map_err(|_| "ssh_agent_probe_output_invalid".to_string())?;
    let marker_offset = text
        .find(AGENT_PROBE_MAGIC)
        .ok_or_else(|| "ssh_agent_probe_magic_missing".to_string())?;
    if marker_offset > MAX_AGENT_PROBE_BANNER_BYTES {
        return Err("ssh_agent_probe_banner_too_large".to_string());
    }
    let marker_remainder = &text[marker_offset..];
    let (marker_line, payload) = marker_remainder
        .split_once('\n')
        .ok_or_else(|| "ssh_agent_probe_output_invalid".to_string())?;
    match marker_line.trim_end_matches('\r') {
        line if line == format!("{AGENT_PROBE_MAGIC} notInstalled") => {
            if payload.trim().is_empty() {
                Ok(ParsedAgentProbe::NotInstalled)
            } else {
                Err("ssh_agent_probe_stdout_contaminated".to_string())
            }
        }
        line if line == format!("{AGENT_PROBE_MAGIC} found") => {
            let (install_path, json_payload) = payload
                .split_once('\n')
                .ok_or_else(|| "ssh_agent_probe_output_invalid".to_string())?;
            let install_path = install_path.trim_end_matches('\r').to_string();
            validate_remote_home_path(&install_path)
                .map_err(|_| "ssh_agent_probe_path_invalid".to_string())?;
            let report = serde_json::from_str::<AgentDoctorProbe>(json_payload.trim())
                .map_err(|_| "ssh_agent_probe_stdout_contaminated".to_string())?;
            Ok(ParsedAgentProbe::Report {
                install_path,
                report,
            })
        }
        _ => Err("ssh_agent_probe_magic_invalid".to_string()),
    }
}

// 构造不携带安装元数据的探测状态结果。
fn agent_probe_result(status: &str, code: &str, detail: String) -> SshAgentProbeResult {
    SshAgentProbeResult {
        status: status.to_string(),
        code: code.to_string(),
        installation_id: String::new(),
        remote_machine_id: String::new(),
        install_path: String::new(),
        agent_version: String::new(),
        protocol_version: String::new(),
        target: String::new(),
        supported: false,
        detail,
    }
}

// 依据 doctor 状态和协议要求组合探测结果及可用安装身份。
fn result_from_agent_report(install_path: String, report: AgentDoctorProbe) -> SshAgentProbeResult {
    let installation = report.installation.filter(|installation| {
        Uuid::parse_str(&installation.installation_id).is_ok()
            && !installation.remote_machine_id.is_empty()
            && installation.remote_machine_id.len() <= 256
            && !installation.remote_machine_id.contains(['\0', '\r', '\n'])
    });
    let version = report.version;
    let protocol_version = format!("{}.{}", version.protocol_major, version.protocol_minor);
    let target = format!("{}/{}", version.target_os, version.target_arch);
    let (status, code, supported) = if version.agent_name != "cli-manager-ssh-agent" {
        ("corrupt", "ssh_agent_identity_invalid", false)
    } else if version.protocol_major != AGENT_PROTOCOL_MAJOR {
        ("incompatible", "ssh_agent_protocol_incompatible", false)
    } else if !report.supported {
        ("unsupported", report.code.as_str(), false)
    } else if report.code != "ok" {
        ("corrupt", report.code.as_str(), false)
    } else if version.protocol_minor < AGENT_PROTOCOL_MINOR_REQUIRED {
        ("incompatible", "ssh_agent_protocol_incompatible", false)
    } else {
        ("installed", report.code.as_str(), true)
    };
    SshAgentProbeResult {
        status: status.to_string(),
        code: code.to_string(),
        installation_id: installation
            .as_ref()
            .map(|value| value.installation_id.clone())
            .unwrap_or_default(),
        remote_machine_id: installation
            .map(|value| value.remote_machine_id)
            .unwrap_or_default(),
        install_path,
        agent_version: version.agent_version,
        protocol_version,
        target,
        supported,
        detail: String::new(),
    }
}

#[tauri::command]
// 限时运行 ssh -V 并返回客户端可用性与版本输出。
pub async fn ssh_client_status() -> SshClientStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let mut command = silent_command("ssh");
        command.arg("-V");
        match output_with_timeout(command, Duration::from_secs(5)) {
            Ok(output) => {
                let stderr = single_line(&output.stderr);
                let stdout = single_line(&output.stdout);
                let version = if stderr.is_empty() { stdout } else { stderr };
                SshClientStatus {
                    available: output.status.success() || !version.is_empty(),
                    version: (!version.is_empty()).then_some(version),
                    error: None,
                }
            }
            Err(error) => SshClientStatus {
                available: false,
                version: None,
                error: Some(error.to_string()),
            },
        }
    })
    .await
    .unwrap_or_else(|error| SshClientStatus {
        available: false,
        version: None,
        error: Some(error.to_string()),
    })
}

#[tauri::command]
// 在阻塞任务中解析 SSH 最终用户名。
pub async fn ssh_resolve_user(spec: SshConnectionSpec) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_effective_ssh_user(&spec))
        .await
        .map_err(|error| format!("ssh_user_resolve_failed:{error}"))?
}

#[tauri::command]
// 依次检查客户端、代理及认证并返回分阶段诊断。
pub async fn ssh_test_connection(
    spec: SshConnectionSpec,
    accept_new_host_key: Option<bool>,
) -> Result<SshConnectionTestResult, String> {
    validate_spec(&spec)?;
    let client = ssh_client_status().await;
    let mut stages = vec![SshDiagnosticStage {
        key: "client".to_string(),
        status: if client.available { "passed" } else { "failed" }.to_string(),
        detail: client
            .version
            .or(client.error)
            .unwrap_or_else(|| "ssh_client_unavailable".to_string()),
    }];
    if !client.available {
        return Ok(SshConnectionTestResult {
            success: false,
            stages,
        });
    }

    if matches!(spec.auth_mode.as_str(), "password_prompt" | "interactive") {
        stages.push(SshDiagnosticStage {
            key: "authentication".to_string(),
            status: "interactive_required".to_string(),
            detail: "ssh_interactive_auth_required".to_string(),
        });
        return Ok(SshConnectionTestResult {
            success: false,
            stages,
        });
    }

    if matches!(spec.proxy_type.as_str(), "http" | "socks5") {
        let proxy_type = spec.proxy_type.clone();
        let proxy_host = spec.proxy_host.clone();
        let proxy_port = spec.proxy_port;
        let target_host = spec.host.clone();
        let target_port = spec.port;
        let proxy_timeout = Duration::from_secs(spec.connect_timeout_sec.min(300));
        let proxy_label = format!(
            "{}://{}:{} → {}:{}",
            proxy_type, proxy_host, proxy_port, target_host, target_port
        );
        let proxy_result = tauri::async_runtime::spawn_blocking(move || {
            crate::ssh_proxy::probe_proxy(
                &proxy_type,
                &proxy_host,
                proxy_port,
                &target_host,
                target_port,
                proxy_timeout,
            )
        })
        .await
        .map_err(|error| error.to_string())?;
        match proxy_result {
            Ok(()) => stages.push(SshDiagnosticStage {
                key: "proxy".to_string(),
                status: "passed".to_string(),
                detail: proxy_label,
            }),
            Err(error) => {
                stages.push(SshDiagnosticStage {
                    key: "proxy".to_string(),
                    status: "failed".to_string(),
                    detail: format!("{proxy_label}\n{error}"),
                });
                return Ok(SshConnectionTestResult {
                    success: false,
                    stages,
                });
            }
        }
    }

    let timeout = Duration::from_secs(spec.connect_timeout_sec.saturating_add(5).min(305));
    let command = ssh_probe_command(&spec, accept_new_host_key.unwrap_or(false))?;
    let output = tauri::async_runtime::spawn_blocking(move || run_ssh_auth_probe(command, timeout))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let stderr = output.stderr;
    let success = output.authenticated || output.status_success;
    if !success && stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        stages.push(SshDiagnosticStage {
            key: "host_key".to_string(),
            status: "failed".to_string(),
            detail: format!("ssh_host_key_changed\n{stderr}"),
        });
    } else if !success && stderr.contains("Host key verification failed") {
        let fingerprint = host_key_fingerprint(&stderr).unwrap_or_default();
        stages.push(SshDiagnosticStage {
            key: "host_key".to_string(),
            status: "confirmation_required".to_string(),
            detail: format!("ssh_host_key_confirmation_required\n{fingerprint}\n{stderr}"),
        });
    } else if output.timed_out {
        stages.push(SshDiagnosticStage {
            key: "authentication".to_string(),
            status: "failed".to_string(),
            detail: format!("ssh_authentication_timeout\n{stderr}"),
        });
    } else {
        stages.push(SshDiagnosticStage {
            key: "connection".to_string(),
            status: if success { "passed" } else { "failed" }.to_string(),
            detail: if success {
                "ssh_connection_ready".to_string()
            } else if stderr.is_empty() {
                format!("ssh_exit_status_{}", output.status_code.unwrap_or(-1))
            } else {
                stderr
            },
        });
    }
    Ok(SshConnectionTestResult { success, stages })
}

#[tauri::command]
// 执行显式 Agent 探测并分类缺失、损坏、不可达或已安装状态。
pub async fn ssh_agent_probe(
    host_id: String,
    spec: SshConnectionSpec,
    agent_path: Option<String>,
) -> Result<SshAgentProbeResult, String> {
    Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    validate_spec(&spec)?;
    if matches!(spec.auth_mode.as_str(), "password_prompt" | "interactive") {
        return Ok(agent_probe_result(
            "authenticationRequired",
            "ssh_agent_authentication_required",
            String::new(),
        ));
    }
    let script = build_agent_probe_script(agent_path.as_deref())?;
    let launch = spec.build_one_shot_launch(script, SshOneShotOptions::default())?;
    let timeout = Duration::from_secs(spec.connect_timeout_sec.saturating_add(15).min(315));
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_agent_probe_process(command_from_transport_launch(launch), timeout)
    })
    .await
    .map_err(|error| error.to_string())?;
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            return Ok(agent_probe_result(
                "unreachable",
                "ssh_agent_probe_failed",
                error.to_string(),
            ));
        }
    };
    if output.stdout_truncated {
        return Ok(agent_probe_result(
            "corrupt",
            "ssh_agent_probe_output_too_large",
            single_line(&output.stderr),
        ));
    }
    match parse_agent_probe_stdout(&output.stdout) {
        Ok(ParsedAgentProbe::NotInstalled) => Ok(agent_probe_result(
            "notInstalled",
            "ssh_agent_not_installed",
            single_line(&output.stderr),
        )),
        Ok(ParsedAgentProbe::Report {
            install_path,
            report,
        }) => Ok(result_from_agent_report(install_path, report)),
        Err(code) => Ok(agent_probe_result(
            if output.status_success {
                "corrupt"
            } else {
                "unreachable"
            },
            if output.status_code == Some(255) {
                "ssh_agent_unreachable"
            } else {
                &code
            },
            single_line(&output.stderr),
        )),
    }
}

#[tauri::command]
// 读取已验证发布信息并比较版本，不建立 SSH 连接。
pub async fn ssh_agent_available_release(
    app: AppHandle,
    manifest_url: Option<String>,
    current_version: Option<String>,
    allow_http: bool,
) -> Result<SshAgentAvailableRelease, String> {
    let bundled_root = bundled_agent_release_dir(&app)?;
    let release = fetch_verified_release(
        manifest_url.as_deref(),
        allow_http,
        Some(bundled_root.as_path()),
    )
    .await?;
    let distribution_source = release.distribution_source().to_string();
    Ok(available_release_preview(
        release.manifest_url,
        release.manifest.channel,
        release.manifest.version,
        release.manifest.protocol_min,
        release.manifest.protocol_max,
        release.manifest.published_at,
        distribution_source,
        current_version.as_deref(),
    ))
}

#[tauri::command]
// 验证发布和远端环境后返回安装目标与动作预览。
pub async fn ssh_agent_install_preview(
    app: AppHandle,
    host_id: String,
    spec: SshConnectionSpec,
    manifest_url: Option<String>,
    install_dir: Option<String>,
    current_version: Option<String>,
    allow_http: bool,
) -> Result<SshAgentInstallPreview, String> {
    Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    validate_spec(&spec)?;
    ensure_non_interactive(&spec)?;
    let bundled_root = bundled_agent_release_dir(&app)?;
    let release = fetch_verified_release(
        manifest_url.as_deref(),
        allow_http,
        Some(bundled_root.as_path()),
    )
    .await?;
    let environment = detect_remote_agent_environment(&spec).await?;
    let install_root = validated_install_root(install_dir.as_deref(), &environment)?;
    let artifact = select_artifact(&release.manifest, &environment.target)?.clone();
    let distribution_source = release.distribution_source().to_string();
    Ok(SshAgentInstallPreview {
        action: install_action(current_version.as_deref(), &release.manifest.version),
        manifest_url: release.manifest_url,
        channel: release.manifest.channel,
        version: release.manifest.version,
        protocol_min: release.manifest.protocol_min,
        protocol_max: release.manifest.protocol_max,
        target: artifact.target.clone(),
        artifact_url: artifact.url.clone(),
        artifact_size: artifact.size,
        artifact_sha256: artifact.sha256.clone(),
        install_root,
        install_path: environment.install_path,
        current_version: current_version.unwrap_or_default(),
        distribution_source,
    })
}

#[tauri::command]
// 重新验证发布、下载校验产物并上传安装，发送阶段进度。
pub async fn ssh_agent_install(
    app: AppHandle,
    host_id: String,
    spec: SshConnectionSpec,
    manifest_url: Option<String>,
    install_dir: Option<String>,
    allow_http: bool,
    allow_downgrade: bool,
) -> Result<SshAgentOperationResult, String> {
    Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    validate_spec(&spec)?;
    ensure_non_interactive(&spec)?;
    emit_agent_install_progress(&app, &host_id, "resolvingRelease", 10);
    let bundled_root = bundled_agent_release_dir(&app)?;
    let release = fetch_verified_release(
        manifest_url.as_deref(),
        allow_http,
        Some(bundled_root.as_path()),
    )
    .await?;
    emit_agent_install_progress(&app, &host_id, "detectingRemote", 35);
    let environment = detect_remote_agent_environment(&spec).await?;
    let install_root = validated_install_root(install_dir.as_deref(), &environment)?;
    let artifact = select_artifact(&release.manifest, &environment.target)?.clone();
    emit_agent_install_progress(&app, &host_id, "downloadingArtifact", 55);
    let bytes = download_artifact(&release, &artifact, allow_http).await?;
    let script = build_agent_install_script(
        &environment,
        &install_root,
        &release.manifest_url,
        &artifact.sha256,
        allow_downgrade,
    );
    emit_agent_install_progress(&app, &host_id, "installingRemote", 75);
    let result = run_agent_operation(&spec, script, Some(bytes)).await?;
    emit_agent_install_progress(&app, &host_id, "completed", 100);
    Ok(result)
}

#[tauri::command]
// 校验主机与非交互认证后执行远端 Agent 回滚。
pub async fn ssh_agent_rollback(
    host_id: String,
    spec: SshConnectionSpec,
    agent_path: Option<String>,
) -> Result<SshAgentOperationResult, String> {
    Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    validate_spec(&spec)?;
    ensure_non_interactive(&spec)?;
    let script = build_agent_management_script(agent_path.as_deref(), "rollback", false)?;
    run_agent_operation(&spec, script, None).await
}

#[tauri::command]
// 校验主机与非交互认证后执行卸载及可选状态清理。
pub async fn ssh_agent_uninstall(
    host_id: String,
    spec: SshConnectionSpec,
    agent_path: Option<String>,
    purge: bool,
) -> Result<SshAgentOperationResult, String> {
    Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    validate_spec(&spec)?;
    ensure_non_interactive(&spec)?;
    let script = build_agent_management_script(agent_path.as_deref(), "uninstall", purge)?;
    run_agent_operation(&spec, script, None).await
}

// 校验来源、根目录和预期文件后组装 Hook 请求。
fn hook_request(
    source: String,
    configured_config_root: String,
    expected_canonical_root: Option<String>,
    expected_files: Vec<HookExpectedFile>,
) -> Result<HookConfigRequest, String> {
    let source = validate_hook_source(&source)?.to_string();
    let configured_config_root = validate_hook_config_root(&configured_config_root)?.to_string();
    let expected_canonical_root = expected_canonical_root
        .map(|value| {
            let value = value.trim();
            if !validate_hook_remote_path(value) {
                return Err("hook_config_root_invalid".to_string());
            }
            Ok(value.to_string())
        })
        .transpose()?;
    let allowed_roles: HashSet<&str> = match source.as_str() {
        "claude" => HashSet::from(["claudeSettings"]),
        "codex" => HashSet::from(["codexHooks", "codexFeature"]),
        "kimi" => HashSet::from(["kimiConfig"]),
        "grok" => HashSet::from(["grokHooks", "grokCompat"]),
        _ => return Err("hook_source_invalid".to_string()),
    };
    let mut seen = HashSet::new();
    for file in &expected_files {
        if !allowed_roles.contains(file.role.as_str())
            || !validate_hook_remote_path(&file.canonical_path)
            || !validate_hook_fingerprint(&file.fingerprint)
            || !seen.insert((file.role.as_str(), file.canonical_path.as_str()))
        {
            return Err("ssh_agent_hook_expected_file_invalid".to_string());
        }
    }
    Ok(HookConfigRequest {
        source,
        configured_config_root,
        expected_canonical_root,
        expected_files,
    })
}

#[tauri::command]
// 读取指定远端 Hook 配置并验证 Agent 身份。
pub async fn ssh_agent_hook_inspect(
    host_id: String,
    spec: SshConnectionSpec,
    agent_path: Option<String>,
    expected_installation_id: String,
    expected_remote_machine_id: String,
    source: String,
    configured_config_root: String,
) -> Result<HookConfigReport, String> {
    Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    let request = hook_request(source, configured_config_root, None, Vec::new())?;
    run_agent_hook_config(
        &spec,
        agent_path.as_deref(),
        "inspect",
        "inspect",
        &expected_installation_id,
        &expected_remote_machine_id,
        request,
    )
    .await
}

#[tauri::command]
// 映射安装或卸载预览动作并校验保留根目录限制。
pub async fn ssh_agent_hook_preview(
    host_id: String,
    spec: SshConnectionSpec,
    agent_path: Option<String>,
    expected_installation_id: String,
    expected_remote_machine_id: String,
    source: String,
    configured_config_root: String,
    expected_canonical_root: Option<String>,
    action: String,
) -> Result<HookConfigReport, String> {
    Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    let (remote_action, expected_action) = match action.as_str() {
        "install" => ("preview-install", "previewInstall"),
        "uninstall" => ("preview-uninstall", "previewUninstall"),
        _ => return Err("hook_config_action_invalid".to_string()),
    };
    if action == "install" && expected_canonical_root.is_some() {
        return Err("hook_config_action_invalid".to_string());
    }
    let request = hook_request(
        source,
        configured_config_root,
        expected_canonical_root,
        Vec::new(),
    )?;
    run_agent_hook_config(
        &spec,
        agent_path.as_deref(),
        remote_action,
        expected_action,
        &expected_installation_id,
        &expected_remote_machine_id,
        request,
    )
    .await
}

#[tauri::command]
// 携带预期文件指纹执行远端 Hook 安装或卸载。
pub async fn ssh_agent_hook_apply(
    host_id: String,
    spec: SshConnectionSpec,
    agent_path: Option<String>,
    expected_installation_id: String,
    expected_remote_machine_id: String,
    source: String,
    configured_config_root: String,
    expected_canonical_root: Option<String>,
    action: String,
    expected_files: Vec<HookExpectedFile>,
) -> Result<HookConfigReport, String> {
    Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    let (remote_action, expected_action) = match action.as_str() {
        "install" => ("install", "installed"),
        "uninstall" => ("uninstall", "uninstalled"),
        _ => return Err("hook_config_action_invalid".to_string()),
    };
    if action == "install" && expected_canonical_root.is_some() {
        return Err("hook_config_action_invalid".to_string());
    }
    let request = hook_request(
        source,
        configured_config_root,
        expected_canonical_root,
        expected_files,
    )?;
    run_agent_hook_config(
        &spec,
        agent_path.as_deref(),
        remote_action,
        expected_action,
        &expected_installation_id,
        &expected_remote_machine_id,
        request,
    )
    .await
}

#[tauri::command]
// 通过远端目录和 Git 探测返回存在及可进入状态。
pub async fn ssh_check_path(
    spec: SshConnectionSpec,
    path: String,
) -> Result<SshPathCheckResult, String> {
    validate_spec(&spec)?;
    ensure_non_interactive(&spec)?;
    let path = validate_remote_path(&path)?.to_string();
    let quoted = posix_quote(&path);
    let script = format!(
        "if [ ! -d {quoted} ]; then printf 'missing'; \
         elif [ ! -x {quoted} ]; then printf 'inaccessible'; \
         elif git -C {quoted} rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf 'git'; \
         else printf 'ok'; fi"
    );
    let timeout = Duration::from_secs(spec.connect_timeout_sec.saturating_add(5).min(305));
    let command = ssh_remote_command(&spec, &script)?;
    let output =
        tauri::async_runtime::spawn_blocking(move || output_with_timeout(command, timeout))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(single_line(&output.stderr));
    }
    Ok(match String::from_utf8_lossy(&output.stdout).trim() {
        "git" => SshPathCheckResult {
            exists: true,
            accessible: true,
            git_repository: true,
        },
        "ok" => SshPathCheckResult {
            exists: true,
            accessible: true,
            git_repository: false,
        },
        "inaccessible" => SshPathCheckResult {
            exists: true,
            accessible: false,
            git_repository: false,
        },
        _ => SshPathCheckResult {
            exists: false,
            accessible: false,
            git_repository: false,
        },
    })
}

#[tauri::command]
// 通过 find 读取直接子目录并按名称不区分大小写排序。
pub async fn ssh_list_directories(
    spec: SshConnectionSpec,
    path: String,
) -> Result<Vec<SshDirectoryEntry>, String> {
    validate_spec(&spec)?;
    ensure_non_interactive(&spec)?;
    let path = validate_remote_path(&path)?.to_string();
    let script = format!(
        "find -- {} -mindepth 1 -maxdepth 1 -type d -print0",
        posix_quote(&path)
    );
    let timeout = Duration::from_secs(spec.connect_timeout_sec.saturating_add(10).min(310));
    let command = ssh_remote_command(&spec, &script)?;
    let output =
        tauri::async_runtime::spawn_blocking(move || output_with_timeout(command, timeout))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(single_line(&output.stderr));
    }
    let mut entries: Vec<SshDirectoryEntry> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .filter_map(|value| String::from_utf8(value.to_vec()).ok())
        .map(|entry_path| {
            let normalized = entry_path.trim_end_matches('/').to_string();
            let name = normalized
                .rsplit('/')
                .next()
                .unwrap_or(&normalized)
                .to_string();
            SshDirectoryEntry {
                name,
                path: normalized,
            }
        })
        .collect();
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(entries)
}

#[cfg(test)]
mod tests;
