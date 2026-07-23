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

fn single_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn host_key_fingerprint(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        line.split_once("Server host key:")
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn is_authenticated_log(line: &str) -> bool {
    line.contains("Authenticated to ")
}

fn run_ssh_auth_probe(
    mut command: Command,
    timeout: Duration,
) -> std::io::Result<SshAuthProbeOutput> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Instant;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stderr_pipe = child.stderr.take();
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let reader_lines = Arc::clone(&lines);
    let (authenticated_tx, authenticated_rx) = mpsc::channel();
    let (reader_done_tx, reader_done_rx) = mpsc::channel();
    let _reader = std::thread::spawn(move || {
        if let Some(pipe) = stderr_pipe {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                let authenticated = is_authenticated_log(&trimmed);
                if let Ok(mut output) = reader_lines.lock() {
                    if output.len() < 256 {
                        output.push(trimmed);
                    }
                }
                if authenticated {
                    let _ = authenticated_tx.send(());
                }
            }
        }
        let _ = reader_done_tx.send(());
    });
    let collect_log = || {
        lines
            .lock()
            .map(|output| output.join("\n"))
            .unwrap_or_default()
    };

    let deadline = Instant::now() + timeout;
    let wait_for_reader = || {
        let _ = reader_done_rx.recv_timeout(Duration::from_millis(100));
    };
    loop {
        if authenticated_rx.try_recv().is_ok() {
            let _ = child.kill();
            let _ = child.wait();
            wait_for_reader();
            return Ok(SshAuthProbeOutput {
                authenticated: true,
                timed_out: false,
                status_success: true,
                status_code: Some(0),
                stderr: collect_log(),
            });
        }
        if let Some(status) = child.try_wait()? {
            wait_for_reader();
            let stderr = collect_log();
            return Ok(SshAuthProbeOutput {
                authenticated: stderr.lines().any(is_authenticated_log),
                timed_out: false,
                status_success: status.success(),
                status_code: status.code(),
                stderr,
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            wait_for_reader();
            return Ok(SshAuthProbeOutput {
                authenticated: false,
                timed_out: true,
                status_success: false,
                status_code: None,
                stderr: collect_log(),
            });
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn read_bounded(mut reader: impl std::io::Read, limit: usize) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(limit.min(8 * 1024));
    let mut truncated = false;
    let mut buffer = [0u8; 8 * 1024];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let remaining = limit.saturating_sub(output.len());
        let retained = remaining.min(read);
        output.extend_from_slice(&buffer[..retained]);
        if retained < read {
            truncated = true;
        }
    }
    (output, truncated)
}

fn run_agent_probe_process(
    mut command: Command,
    timeout: Duration,
) -> std::io::Result<AgentProbeProcessOutput> {
    use std::process::Stdio;
    use std::time::Instant;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        stdout
            .map(|pipe| read_bounded(pipe, MAX_AGENT_PROBE_REPORT_BYTES))
            .unwrap_or_default()
    });
    let stderr_reader = std::thread::spawn(move || {
        stderr
            .map(|pipe| read_bounded(pipe, MAX_AGENT_PROBE_STDERR_BYTES))
            .unwrap_or_default()
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "ssh_agent_probe_timeout",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let (stdout, stdout_truncated) = stdout_reader.join().unwrap_or_default();
    let (stderr, _) = stderr_reader.join().unwrap_or_default();
    Ok(AgentProbeProcessOutput {
        status_success: status.success(),
        status_code: status.code(),
        stdout,
        stderr,
        stdout_truncated,
    })
}

fn run_agent_input_process(
    mut command: Command,
    input: Vec<u8>,
    timeout: Duration,
) -> std::io::Result<AgentProbeProcessOutput> {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::Instant;

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let writer = std::thread::spawn(move || {
        let mut stdin = stdin.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "ssh_agent_upload_stdin_missing",
            )
        })?;
        stdin.write_all(&input)
    });
    let stdout_reader = std::thread::spawn(move || {
        stdout
            .map(|pipe| read_bounded(pipe, MAX_AGENT_PROBE_REPORT_BYTES))
            .unwrap_or_default()
    });
    let stderr_reader = std::thread::spawn(move || {
        stderr
            .map(|pipe| read_bounded(pipe, MAX_AGENT_PROBE_STDERR_BYTES))
            .unwrap_or_default()
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = writer.join();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "ssh_agent_operation_timeout",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    writer
        .join()
        .map_err(|_| std::io::Error::other("ssh_agent_upload_writer_panicked"))??;
    let (stdout, stdout_truncated) = stdout_reader.join().unwrap_or_default();
    let (stderr, _) = stderr_reader.join().unwrap_or_default();
    Ok(AgentProbeProcessOutput {
        status_success: status.success(),
        status_code: status.code(),
        stdout,
        stderr,
        stdout_truncated,
    })
}

fn validate_spec(spec: &SshConnectionSpec) -> Result<(), String> {
    spec.validate()
}

fn ssh_password_account(host_id: &str) -> Result<String, String> {
    let id = Uuid::parse_str(host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    Ok(format!("ssh:{id}:password"))
}

#[tauri::command]
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
pub async fn ssh_delete_password(host_id: String) -> Result<(), String> {
    let account = ssh_password_account(&host_id)?;
    tokio::task::spawn_blocking(move || crate::credential_store::delete(&account))
        .await
        .map_err(|err| format!("ssh credential task failed: {err}"))?
}

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

fn ensure_non_interactive(spec: &SshConnectionSpec) -> Result<(), String> {
    if matches!(spec.auth_mode.as_str(), "password_prompt" | "interactive") {
        return Err("ssh_interactive_auth_required".to_string());
    }
    Ok(())
}

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

fn command_from_transport_launch(launch: SshTransportLaunch) -> Command {
    let mut command = silent_command(&launch.executable);
    command.args(launch.args).envs(launch.env);
    command
}

fn ssh_remote_command(spec: &SshConnectionSpec, remote_command: &str) -> Result<Command, String> {
    ssh_remote_command_with_options(spec, remote_command, false, false)
}

fn ssh_probe_command(
    spec: &SshConnectionSpec,
    accept_new_host_key: bool,
) -> Result<Command, String> {
    ssh_remote_command_with_options(spec, "true", true, accept_new_host_key)
}

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

fn emit_agent_install_progress(app: &AppHandle, host_id: &str, phase: &'static str, progress: u8) {
    let event = format!("ssh-agent-install-progress-{}", host_id.trim());
    let _ = app.emit(&event, SshAgentInstallProgress { phase, progress });
}

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

fn validate_hook_source(source: &str) -> Result<&str, String> {
    match source.trim() {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        _ => Err("hook_source_invalid".to_string()),
    }
}

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

fn validate_hook_fingerprint(value: &str) -> bool {
    value == "missing" || (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn validate_hook_remote_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.contains(['\0', '\r', '\n', '\\'])
        && !value.split('/').any(|segment| segment == "..")
}

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
    let required = if expected_source == "claude" { 11 } else { 6 };
    if report.required_entries != required || report.managed_entries > required {
        return Err("ssh_agent_hook_count_invalid".to_string());
    }
    let expected_roles: HashSet<&str> = if expected_source == "claude" {
        HashSet::from(["claudeSettings"])
    } else {
        HashSet::from(["codexHooks", "codexFeature"])
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
    if report.config_files.len() != if expected_source == "claude" { 1 } else { 2 } {
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
        if expected_action != "installed"
            || record.source != report.source
            || record.installation_id != report.installation_id
            || record.owner_id != format!("cli-manager-ssh-agent:{}", report.installation_id)
            || record.configured_config_root != report.configured_config_root
            || record.canonical_config_root != report.canonical_config_root
            || record.history_source_candidate.source != report.source
            || record.history_source_candidate.canonical_config_root != report.canonical_config_root
            || record.history_source_candidate.config_root_hash != report.config_root_hash
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
    let allowed_roles: HashSet<&str> = if source == "claude" {
        HashSet::from(["claudeSettings"])
    } else {
        HashSet::from(["codexHooks", "codexFeature"])
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
mod tests {
    use super::{
        build_agent_install_script, build_agent_management_script, build_agent_probe_script,
        hook_request, host_key_fingerprint, install_action, is_authenticated_log,
        parse_agent_environment, parse_agent_operation, parse_agent_probe_stdout, posix_quote,
        read_bounded, result_from_agent_report, ssh_password_account, ssh_probe_command,
        validate_agent_hook_report, validate_remote_path, validate_spec, AgentDoctorProbe,
        AgentVersionProbe, ParsedAgentProbe, RemoteAgentEnvironment, SshConnectionSpec,
    };
    use cli_manager_hook_schema::{
        HookConfigChange, HookConfigFile, HookConfigReport, HookHistorySourceCandidate,
        HookInstallationFile, HookInstallationRecord,
    };

    fn spec() -> SshConnectionSpec {
        SshConnectionSpec {
            host: "example.com".to_string(),
            port: 2222,
            username: "dev".to_string(),
            config_alias: String::new(),
            config_file: String::new(),
            auth_mode: "identity_file".to_string(),
            identity_file: "/home/dev/.ssh/id_ed25519".to_string(),
            credential_ref: String::new(),
            jump_target: "bastion".to_string(),
            proxy_type: "none".to_string(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_command: String::new(),
            connect_timeout_sec: 12,
            server_alive_interval_sec: 30,
            server_alive_count_max: 3,
        }
    }

    #[test]
    fn builds_safe_structured_probe_arguments() {
        let spec = spec();
        validate_spec(&spec).unwrap();
        assert_eq!(spec.target(), "dev@example.com");
        let command = ssh_probe_command(&spec, false).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(args.windows(2).any(|pair| pair == ["-J", "bastion"]));
        assert!(args.iter().any(|arg| arg == "BatchMode=yes"));
        assert_eq!(args.last().map(String::as_str), Some("true"));
    }

    #[test]
    fn direct_address_probe_ignores_the_default_ssh_config() {
        let mut value = spec();
        value.jump_target.clear();
        let command = ssh_probe_command(&value, false).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["-F", "none"]));
    }

    #[test]
    fn agent_probe_script_rejects_unsafe_explicit_paths() {
        assert_eq!(
            build_agent_probe_script(Some("$HOME/agent")).unwrap_err(),
            "ssh_agent_path_invalid"
        );
        assert_eq!(
            build_agent_probe_script(Some("~/../agent")).unwrap_err(),
            "ssh_agent_path_parent_forbidden"
        );
        let script = build_agent_probe_script(Some("~/bin/cli-manager-ssh-agent")).unwrap();
        assert!(script.contains("agent=\"${HOME}\"/'bin/cli-manager-ssh-agent'"));
    }

    #[test]
    fn agent_environment_parser_ignores_only_bounded_banner() {
        let stdout = b"Welcome\nCLI_MANAGER_SSH_AGENT_ENV/1 found\nlinux-aarch64\n/home/dev/.local/share/cli-manager-ssh-agent\n/home/dev/.local/state/cli-manager-ssh-agent\n/home/dev/.local/bin/cli-manager-ssh-agent\n";
        let environment = parse_agent_environment(stdout).unwrap();
        assert_eq!(environment.target, "linux-aarch64");
        assert_eq!(
            environment.install_root,
            "/home/dev/.local/share/cli-manager-ssh-agent"
        );
        assert!(parse_agent_environment(
            b"CLI_MANAGER_SSH_AGENT_ENV/1 found\nlinux-x86_64\nrelative\n/state\n/bin\n"
        )
        .is_err());
    }

    #[test]
    fn agent_install_script_quotes_remote_values() {
        let environment = RemoteAgentEnvironment {
            target: "linux-x86_64".into(),
            install_root: "/home/dev/.local/share/cli-manager-ssh-agent".into(),
            state_dir: "/home/dev/state dir".into(),
            install_path: "/home/dev/.local/bin/cli-manager-ssh-agent".into(),
        };
        let script = build_agent_install_script(
            &environment,
            "/opt/agent root",
            "https://example.com/agent's.json",
            &"a".repeat(64),
            true,
        );
        assert!(script.contains("--install-dir '/opt/agent root'"));
        assert!(script.contains("agent'\\''s.json"));
        assert!(script.contains("--allow-downgrade"));
    }

    #[test]
    fn agent_management_allows_only_fixed_commands() {
        assert!(build_agent_management_script(None, "rollback", false).is_ok());
        assert!(build_agent_management_script(None, "uninstall", true).is_ok());
        assert_eq!(
            build_agent_management_script(None, "shell", false).unwrap_err(),
            "ssh_agent_operation_invalid"
        );
    }

    #[test]
    fn agent_operation_parser_rejects_trailing_output() {
        let report = parse_agent_operation(
            b"banner\nCLI_MANAGER_SSH_AGENT_OPERATION/1 result\n{\"action\":\"uninstalled\",\"installation\":null}\n",
        )
        .unwrap();
        assert_eq!(report.action, "uninstalled");
        assert!(parse_agent_operation(
            b"CLI_MANAGER_SSH_AGENT_OPERATION/1 result\n{\"action\":\"uninstalled\",\"installation\":null}\nnoise"
        )
        .is_err());
        assert!(parse_agent_operation(
            b"CLI_MANAGER_SSH_AGENT_OPERATION/1 forged\n{\"action\":\"uninstalled\",\"installation\":null}\n"
        )
        .is_err());
        assert!(parse_agent_operation(
            b"CLI_MANAGER_SSH_AGENT_OPERATION/1 result\n{\"action\":\"unknown\",\"installation\":null}\n"
        )
        .is_err());
    }

    #[test]
    fn install_preview_uses_semantic_version_order() {
        assert_eq!(install_action(None, "1.0.0"), "install");
        assert_eq!(install_action(Some("1.0.0"), "1.0.1"), "upgrade");
        assert_eq!(install_action(Some("1.0.0"), "1.0.0"), "reinstall");
        assert_eq!(install_action(Some("2.0.0"), "1.0.0"), "downgrade");
    }

    #[test]
    fn agent_probe_parser_allows_bounded_login_banner() {
        let stdout = b"Welcome to server\nCLI_MANAGER_SSH_AGENT_PROBE/1 found\n/usr/bin/cli-manager-ssh-agent\n{\"version\":{\"agentName\":\"cli-manager-ssh-agent\",\"agentVersion\":\"0.1.0\",\"protocolMajor\":1,\"protocolMinor\":6,\"targetOs\":\"linux\",\"targetArch\":\"x86_64\"},\"supported\":true,\"code\":\"ok\"}\n";
        let ParsedAgentProbe::Report {
            install_path,
            report,
        } = parse_agent_probe_stdout(stdout).unwrap()
        else {
            panic!("expected report");
        };
        assert_eq!(install_path, "/usr/bin/cli-manager-ssh-agent");
        let result = result_from_agent_report(install_path, report);
        assert_eq!(result.status, "installed");
        assert_eq!(result.protocol_version, "1.6");
        assert_eq!(result.target, "linux/x86_64");
    }

    #[test]
    fn agent_probe_parser_rejects_banner_over_limit() {
        let mut stdout = vec![b'x'; super::MAX_AGENT_PROBE_BANNER_BYTES + 1];
        stdout.extend_from_slice(b"CLI_MANAGER_SSH_AGENT_PROBE/1 notInstalled\n");
        assert_eq!(
            parse_agent_probe_stdout(&stdout).unwrap_err(),
            "ssh_agent_probe_banner_too_large"
        );
    }

    #[test]
    fn agent_probe_classifies_protocol_mismatch() {
        let result = result_from_agent_report(
            "/opt/agent".into(),
            AgentDoctorProbe {
                version: AgentVersionProbe {
                    agent_name: "cli-manager-ssh-agent".into(),
                    agent_version: "2.0.0".into(),
                    protocol_major: 2,
                    protocol_minor: 0,
                    target_os: "linux".into(),
                    target_arch: "aarch64".into(),
                },
                supported: true,
                code: "ok".into(),
                installation: None,
            },
        );
        assert_eq!(result.status, "incompatible");
        assert_eq!(result.code, "ssh_agent_protocol_incompatible");
        assert!(!result.supported);
    }

    #[test]
    fn agent_probe_requires_the_bridge_runtime_minor() {
        let result = result_from_agent_report(
            "/opt/agent".into(),
            AgentDoctorProbe {
                version: AgentVersionProbe {
                    agent_name: "cli-manager-ssh-agent".into(),
                    agent_version: "0.1.0".into(),
                    protocol_major: 1,
                    protocol_minor: 0,
                    target_os: "linux".into(),
                    target_arch: "x86_64".into(),
                },
                supported: true,
                code: "ok".into(),
                installation: None,
            },
        );
        assert_eq!(result.status, "incompatible");
        assert_eq!(result.code, "ssh_agent_protocol_incompatible");
        assert!(!result.supported);
    }

    #[test]
    fn agent_probe_does_not_mark_failed_doctor_as_usable() {
        let result = result_from_agent_report(
            "/opt/agent".into(),
            AgentDoctorProbe {
                version: AgentVersionProbe {
                    agent_name: "cli-manager-ssh-agent".into(),
                    agent_version: "0.1.0".into(),
                    protocol_major: 1,
                    protocol_minor: 0,
                    target_os: "linux".into(),
                    target_arch: "x86_64".into(),
                },
                supported: true,
                code: "home_directory_unavailable".into(),
                installation: None,
            },
        );
        assert_eq!(result.status, "corrupt");
        assert_eq!(result.code, "home_directory_unavailable");
        assert!(!result.supported);
    }

    #[test]
    fn bounded_probe_reader_drains_without_growing_past_the_limit() {
        let input = vec![b'x'; 128];
        let (output, truncated) = read_bounded(std::io::Cursor::new(input), 32);
        assert_eq!(output.len(), 32);
        assert!(truncated);
    }

    #[test]
    fn hook_request_validates_expected_canonical_root() {
        let request = hook_request(
            "claude".to_string(),
            "~/.claude".to_string(),
            Some("/home/dev/.claude".to_string()),
            Vec::new(),
        )
        .unwrap();
        assert_eq!(
            request.expected_canonical_root.as_deref(),
            Some("/home/dev/.claude")
        );
        assert_eq!(
            hook_request(
                "claude".to_string(),
                "~/.claude".to_string(),
                Some("/home/dev/../other".to_string()),
                Vec::new(),
            )
            .unwrap_err(),
            "hook_config_root_invalid"
        );
    }

    #[test]
    fn hook_report_must_match_expected_canonical_root() {
        let fingerprint = "a".repeat(64);
        let report = HookConfigReport {
            action: "previewUninstall".to_string(),
            status: "installed".to_string(),
            source: "claude".to_string(),
            installation_id: "00000000-0000-4000-8000-000000000001".to_string(),
            remote_machine_id: "machine".to_string(),
            configured_config_root: "~/.claude".to_string(),
            canonical_config_root: "/home/dev/.claude".to_string(),
            config_root_hash: "b".repeat(64),
            config_root_exists: true,
            will_create_config_root: false,
            config_files: vec![HookConfigFile {
                role: "claudeSettings".to_string(),
                canonical_path: "/home/dev/.claude/settings.json".to_string(),
                fingerprint: fingerprint.clone(),
                exists: true,
            }],
            managed_entries: 11,
            required_entries: 11,
            changes: vec![HookConfigChange {
                role: "claudeSettings".to_string(),
                canonical_path: "/home/dev/.claude/settings.json".to_string(),
                before_fingerprint: fingerprint.clone(),
                after_fingerprint: fingerprint,
                action: "unchanged".to_string(),
            }],
            installation: None,
        };
        assert!(validate_agent_hook_report(
            &report,
            "previewUninstall",
            "claude",
            "00000000-0000-4000-8000-000000000001",
            "machine",
            "~/.claude",
            Some("/home/dev/.claude"),
        )
        .is_ok());
        assert_eq!(
            validate_agent_hook_report(
                &report,
                "previewUninstall",
                "claude",
                "00000000-0000-4000-8000-000000000001",
                "machine",
                "~/.claude",
                Some("/home/dev/other"),
            )
            .unwrap_err(),
            "hook_config_root_changed"
        );
    }

    #[test]
    fn hook_installation_record_requires_each_config_file_once() {
        let hooks_path = "/home/dev/.codex/hooks.json";
        let feature_path = "/home/dev/.codex/config.toml";
        let hooks_fingerprint = "a".repeat(64);
        let feature_fingerprint = "b".repeat(64);
        let duplicate = HookInstallationFile {
            role: "codexHooks".to_string(),
            canonical_path: hooks_path.to_string(),
            before_fingerprint: "missing".to_string(),
            after_fingerprint: hooks_fingerprint.clone(),
        };
        let report = HookConfigReport {
            action: "installed".to_string(),
            status: "installed".to_string(),
            source: "codex".to_string(),
            installation_id: "00000000-0000-4000-8000-000000000001".to_string(),
            remote_machine_id: "machine".to_string(),
            configured_config_root: "~/.codex".to_string(),
            canonical_config_root: "/home/dev/.codex".to_string(),
            config_root_hash: "c".repeat(64),
            config_root_exists: true,
            will_create_config_root: false,
            config_files: vec![
                HookConfigFile {
                    role: "codexHooks".to_string(),
                    canonical_path: hooks_path.to_string(),
                    fingerprint: hooks_fingerprint.clone(),
                    exists: true,
                },
                HookConfigFile {
                    role: "codexFeature".to_string(),
                    canonical_path: feature_path.to_string(),
                    fingerprint: feature_fingerprint.clone(),
                    exists: true,
                },
            ],
            managed_entries: 6,
            required_entries: 6,
            changes: vec![
                HookConfigChange {
                    role: "codexHooks".to_string(),
                    canonical_path: hooks_path.to_string(),
                    before_fingerprint: "missing".to_string(),
                    after_fingerprint: hooks_fingerprint,
                    action: "create".to_string(),
                },
                HookConfigChange {
                    role: "codexFeature".to_string(),
                    canonical_path: feature_path.to_string(),
                    before_fingerprint: "missing".to_string(),
                    after_fingerprint: feature_fingerprint,
                    action: "create".to_string(),
                },
            ],
            installation: Some(HookInstallationRecord {
                source: "codex".to_string(),
                installation_id: "00000000-0000-4000-8000-000000000001".to_string(),
                owner_id: "cli-manager-ssh-agent:00000000-0000-4000-8000-000000000001".to_string(),
                configured_config_root: "~/.codex".to_string(),
                canonical_config_root: "/home/dev/.codex".to_string(),
                config_files: vec![duplicate.clone(), duplicate],
                managed_entries: 6,
                adapter_version: 1,
                installed_at: 1,
                history_source_candidate: HookHistorySourceCandidate {
                    source: "codex".to_string(),
                    canonical_config_root: "/home/dev/.codex".to_string(),
                    config_root_hash: "c".repeat(64),
                },
            }),
        };
        assert_eq!(
            validate_agent_hook_report(
                &report,
                "installed",
                "codex",
                "00000000-0000-4000-8000-000000000001",
                "machine",
                "~/.codex",
                None,
            )
            .unwrap_err(),
            "ssh_agent_hook_record_invalid"
        );
    }

    #[test]
    fn config_alias_owns_address_and_port_resolution() {
        let mut spec = spec();
        spec.config_alias = "gpu-dev".to_string();
        spec.host.clear();
        spec.port = 0;
        spec.auth_mode = "ssh_config".to_string();
        validate_spec(&spec).unwrap();
        assert_eq!(spec.target(), "gpu-dev");
        let command = ssh_probe_command(&spec, false).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(!args.iter().any(|arg| arg == "-p"));
        assert!(!args.iter().any(|arg| arg == "-i"));
    }

    #[test]
    fn custom_config_file_is_forwarded_to_probe() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let mut spec = spec();
        spec.config_alias = "gpu-dev".to_string();
        spec.config_file = temp.path().to_string_lossy().into_owned();
        spec.auth_mode = "ssh_config".to_string();

        validate_spec(&spec).unwrap();
        let command = ssh_probe_command(&spec, false).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| pair == ["-F", spec.config_file.as_str()]));
    }

    #[test]
    fn missing_custom_config_file_is_rejected() {
        let mut spec = spec();
        spec.config_file = std::env::temp_dir()
            .join("cli-manager-missing-ssh-config")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            validate_spec(&spec).unwrap_err(),
            "ssh_config_file_not_found"
        );
    }

    #[test]
    fn quotes_remote_paths_and_rejects_parent_traversal() {
        assert_eq!(posix_quote("/srv/team's app"), "'/srv/team'\\''s app'");
        assert_eq!(validate_remote_path("/srv/app").unwrap(), "/srv/app");
        assert!(validate_remote_path("srv/app").is_err());
        assert!(validate_remote_path("/srv/../etc").is_err());
    }

    #[test]
    fn password_probe_does_not_include_stale_identity_file() {
        let mut spec = spec();
        spec.auth_mode = "password_prompt".to_string();
        let command = ssh_probe_command(&spec, false).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(!args.iter().any(|arg| arg == "-i"));
        assert!(args
            .iter()
            .any(|arg| arg == "PreferredAuthentications=password,keyboard-interactive"));
        assert!(args.iter().any(|arg| arg == "NumberOfPasswordPrompts=1"));
    }

    #[test]
    fn interactive_probe_does_not_include_stale_identity_file() {
        let mut spec = spec();
        spec.auth_mode = "interactive".to_string();
        let command = ssh_probe_command(&spec, false).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(!args.iter().any(|arg| arg == "-i"));
        assert!(args
            .iter()
            .any(|arg| arg == "PreferredAuthentications=keyboard-interactive"));
    }

    #[test]
    fn credential_account_is_scoped_to_valid_host_uuid() {
        assert_eq!(
            ssh_password_account("550e8400-e29b-41d4-a716-446655440000").unwrap(),
            "ssh:550e8400-e29b-41d4-a716-446655440000:password"
        );
        assert!(ssh_password_account("../webdav").is_err());
    }

    #[test]
    fn accept_new_probe_never_disables_changed_host_protection() {
        let command = ssh_probe_command(&spec(), true).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "StrictHostKeyChecking=accept-new"]));
        assert!(!args.iter().any(|arg| arg == "StrictHostKeyChecking=no"));
    }

    #[test]
    fn extracts_server_host_key_fingerprint_from_verbose_output() {
        let stderr = "debug1: Connecting\ndebug1: Server host key: ssh-ed25519 SHA256:abc123";
        assert_eq!(
            host_key_fingerprint(stderr).as_deref(),
            Some("ssh-ed25519 SHA256:abc123")
        );
    }

    #[test]
    fn detects_openssh_authenticated_verbose_output() {
        assert!(is_authenticated_log(
            "debug1: Authenticated to example.com ([203.0.113.10]:22) using \"password\"."
        ));
        assert!(!is_authenticated_log(
            "debug1: Authentication succeeded (password)."
        ));
    }
}
