use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;
use uuid::Uuid;

use crate::shell_resolver::{output_with_timeout, silent_command};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshClientStatus {
    available: bool,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionSpec {
    host: String,
    port: u16,
    username: String,
    config_alias: String,
    #[serde(default)]
    config_file: String,
    auth_mode: String,
    identity_file: String,
    #[serde(default)]
    credential_ref: String,
    jump_target: String,
    #[serde(default)]
    proxy_type: String,
    #[serde(default)]
    proxy_host: String,
    #[serde(default)]
    proxy_port: u16,
    #[serde(default)]
    proxy_command: String,
    connect_timeout_sec: u64,
    server_alive_interval_sec: u64,
    server_alive_count_max: u32,
}

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

fn validate_spec(spec: &SshConnectionSpec) -> Result<(), String> {
    if spec.config_alias.trim().is_empty() && spec.host.trim().is_empty() {
        return Err("ssh_host_address_required".to_string());
    }
    if spec.config_alias.trim().is_empty() && spec.port == 0 {
        return Err("ssh_host_port_invalid".to_string());
    }
    validate_config_file(&spec.config_file)?;
    if spec.connect_timeout_sec == 0 || spec.connect_timeout_sec > 300 {
        return Err("ssh_connect_timeout_invalid".to_string());
    }
    if spec.server_alive_count_max > 100 {
        return Err("ssh_server_alive_count_invalid".to_string());
    }
    if !matches!(
        spec.auth_mode.as_str(),
        "ssh_config"
            | "agent"
            | "identity_file"
            | "password_prompt"
            | "interactive"
            | "credential_ref"
    ) {
        return Err("ssh_auth_mode_invalid".to_string());
    }
    if spec.auth_mode == "identity_file" && spec.identity_file.trim().is_empty() {
        return Err("ssh_identity_file_required".to_string());
    }
    if spec.auth_mode == "credential_ref" && spec.credential_ref.trim().is_empty() {
        return Err("ssh_credential_ref_required".to_string());
    }
    Ok(())
}

fn validate_config_file(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.chars().any(|ch| matches!(ch, '\0' | '\r' | '\n')) {
        return Err("ssh_config_file_invalid".to_string());
    }
    let path = std::path::Path::new(trimmed);
    if !path.is_absolute() {
        return Err("ssh_config_file_invalid".to_string());
    }
    if !path.is_file() {
        return Err("ssh_config_file_not_found".to_string());
    }
    Ok(())
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

fn target(spec: &SshConnectionSpec) -> String {
    if !spec.config_alias.trim().is_empty() {
        return spec.config_alias.trim().to_string();
    }
    if spec.username.trim().is_empty() {
        spec.host.trim().to_string()
    } else {
        format!("{}@{}", spec.username.trim(), spec.host.trim())
    }
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

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
    let mut command = silent_command("ssh");
    if !spec.config_file.trim().is_empty() {
        command.args(["-F", spec.config_file.trim()]);
    }
    command.arg("-T");
    if verbose {
        command.arg("-v");
    }
    if accept_new_host_key {
        command.args(["-o", "StrictHostKeyChecking=accept-new"]);
    }
    command.args([
        "-o",
        if spec.auth_mode == "credential_ref" {
            "BatchMode=no"
        } else {
            "BatchMode=yes"
        },
    ]);
    command
        .args([
            "-o",
            &format!("ConnectTimeout={}", spec.connect_timeout_sec),
        ])
        .args([
            "-o",
            &format!("ServerAliveInterval={}", spec.server_alive_interval_sec),
        ])
        .args([
            "-o",
            &format!("ServerAliveCountMax={}", spec.server_alive_count_max),
        ])
        .args(["-o", "ConnectionAttempts=1"]);
    if spec.config_alias.trim().is_empty() {
        command.args(["-p", &spec.port.to_string()]);
    }
    if spec.auth_mode == "identity_file" && !spec.identity_file.trim().is_empty() {
        command.args(["-i", spec.identity_file.trim()]);
    }
    match spec.auth_mode.as_str() {
        "agent" => {
            command.args(["-o", "PubkeyAuthentication=yes"]);
            command.args(["-o", "PreferredAuthentications=publickey"]);
        }
        "identity_file" => {
            command.args(["-o", "IdentitiesOnly=yes"]);
            command.args(["-o", "PreferredAuthentications=publickey"]);
        }
        "password_prompt" | "credential_ref" => {
            command.args(["-o", "PubkeyAuthentication=no"]);
            command.args(["-o", "PasswordAuthentication=yes"]);
            command.args(["-o", "KbdInteractiveAuthentication=yes"]);
            command.args([
                "-o",
                "PreferredAuthentications=password,keyboard-interactive",
            ]);
            command.args(["-o", "NumberOfPasswordPrompts=1"]);
        }
        "interactive" => {
            command.args(["-o", "PubkeyAuthentication=no"]);
            command.args(["-o", "PasswordAuthentication=no"]);
            command.args(["-o", "KbdInteractiveAuthentication=yes"]);
            command.args(["-o", "PreferredAuthentications=keyboard-interactive"]);
        }
        _ => {}
    }
    if spec.auth_mode == "credential_ref" {
        command.envs(crate::ssh_askpass::prepare(&spec.credential_ref)?);
    }
    let proxy_command = crate::ssh_proxy::build_proxy_command(
        &spec.proxy_type,
        &spec.proxy_host,
        spec.proxy_port,
        &spec.proxy_command,
    )?;
    if proxy_command.is_empty() && !spec.jump_target.trim().is_empty() {
        command.args(["-J", spec.jump_target.trim()]);
    }
    if !proxy_command.is_empty() {
        command.args(["-o", &format!("ProxyCommand={proxy_command}")]);
    }
    command.arg(target(spec)).arg(remote_command);
    Ok(command)
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
        host_key_fingerprint, is_authenticated_log, posix_quote, ssh_password_account,
        ssh_probe_command, target, validate_remote_path, validate_spec, SshConnectionSpec,
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
        assert_eq!(target(&spec), "dev@example.com");
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
    fn config_alias_owns_address_and_port_resolution() {
        let mut spec = spec();
        spec.config_alias = "gpu-dev".to_string();
        spec.host.clear();
        spec.port = 0;
        spec.auth_mode = "ssh_config".to_string();
        validate_spec(&spec).unwrap();
        assert_eq!(target(&spec), "gpu-dev");
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

        assert!(args.windows(2).any(|pair| pair == ["-F", spec.config_file.as_str()]));
    }

    #[test]
    fn missing_custom_config_file_is_rejected() {
        let mut spec = spec();
        spec.config_file = std::env::temp_dir()
            .join("cli-manager-missing-ssh-config")
            .to_string_lossy()
            .into_owned();

        assert_eq!(validate_spec(&spec).unwrap_err(), "ssh_config_file_not_found");
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
