use cli_manager_agent_capabilities::{
    apply_probe_output, assemble_snapshot, collect_local_bundle, discovery_layout,
    AgentCapabilitySnapshot, AgentKind, BridgeStatus, CapabilityDiagnostic, ConfigDocument,
    DiagnosticLevel, DiscoveryBundle, EnvironmentKind, InspectRequest, SkillDocument,
};
use serde::Deserialize;
use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::daemon::client::DaemonBridge;
use crate::shell_resolver::{output_with_timeout_bounded, silent_command, BoundedOutput};
use crate::ssh_launch::SshLaunchPlan;

const INSPECT_TIMEOUT: Duration = Duration::from_secs(3);
const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ID_BYTES: usize = 512;
const MAX_PATH_BYTES: usize = 4096;
const MAX_WSL_SKILLS: usize = 500;
const MAX_PROBE_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_WSL_OUTPUT_BYTES: usize = 2 * 1024 * 1024 + 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityCommandRequest {
    #[serde(flatten)]
    core: InspectRequest,
    #[serde(default)]
    wsl_distro_name: Option<String>,
    #[serde(default)]
    ssh_consumer_id: Option<String>,
    #[serde(default)]
    ssh_launch: Option<SshLaunchPlan>,
}

fn validate_plain(value: &str, max: usize, code: &'static str) -> Result<(), String> {
    if value.is_empty() || value.len() > max || value.contains(['\0', '\r', '\n']) {
        return Err(code.to_string());
    }
    Ok(())
}

fn validate_request(request: &AgentCapabilityCommandRequest) -> Result<(), String> {
    validate_plain(
        &request.core.terminal_session_id,
        MAX_ID_BYTES,
        "agent_capability_terminal_id_invalid",
    )?;
    validate_plain(
        &request.core.cli_session_id,
        MAX_ID_BYTES,
        "agent_capability_session_id_invalid",
    )?;
    validate_plain(
        &request.core.cwd,
        MAX_PATH_BYTES,
        "agent_capability_cwd_invalid",
    )?;
    if request.core.launch_args.len() > 4096 || request.core.launch_args.contains('\0') {
        return Err("agent_capability_launch_args_invalid".to_string());
    }
    if let Some(root) = request.core.config_root.as_deref() {
        if root.len() > MAX_PATH_BYTES || root.contains('\0') {
            return Err("agent_capability_config_root_invalid".to_string());
        }
    }
    match request.core.environment {
        EnvironmentKind::Local => {
            if request.ssh_launch.is_some() || request.ssh_consumer_id.is_some() {
                return Err("agent_capability_environment_invalid".to_string());
            }
        }
        EnvironmentKind::Wsl => {
            if request.ssh_launch.is_some() || request.ssh_consumer_id.is_some() {
                return Err("agent_capability_environment_invalid".to_string());
            }
        }
        EnvironmentKind::Ssh => {
            if request.ssh_launch.is_none()
                || request
                    .ssh_consumer_id
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
            {
                return Err("agent_capability_ssh_context_required".to_string());
            }
        }
    }
    Ok(())
}

fn local_home() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "agent_capability_home_unavailable".to_string())
}

fn canonical_existing_dir(path: &Path, code: &'static str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(code.to_string());
    }
    path.canonicalize()
        .ok()
        .filter(|resolved| resolved.is_dir())
        .ok_or_else(|| code.to_string())
}

fn inspect_local(core: InspectRequest) -> Result<AgentCapabilitySnapshot, String> {
    let home = canonical_existing_dir(&local_home()?, "agent_capability_home_unavailable")?;
    let cwd = canonical_existing_dir(Path::new(&core.cwd), "agent_capability_cwd_unavailable")?;
    let config_root = core
        .config_root
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(Path::new)
        .map(|path| canonical_existing_dir(path, "agent_capability_config_root_unavailable"))
        .transpose()?;
    let layout = discovery_layout(core.agent, &home, &cwd, config_root.as_deref());
    Ok(assemble_snapshot(core, collect_local_bundle(&layout)))
}

fn probe_args(agent: AgentKind) -> Option<&'static [&'static str]> {
    match agent {
        AgentKind::Claude => Some(&["mcp", "list"]),
        AgentKind::Codex => Some(&["mcp", "list", "--json"]),
        AgentKind::Grok => Some(&["mcp", "list", "--json"]),
        AgentKind::Opencode => Some(&["mcp", "list"]),
        AgentKind::Pi => None,
    }
}

fn set_config_root_env(
    command: &mut std::process::Command,
    agent: AgentKind,
    config_root: Option<&str>,
) {
    let Some(root) = config_root.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    match agent {
        AgentKind::Claude => {
            command.env("CLAUDE_CONFIG_DIR", root);
        }
        AgentKind::Codex => {
            command.env("CODEX_HOME", root);
        }
        AgentKind::Pi | AgentKind::Grok | AgentKind::Opencode => {}
    }
}

fn probe_local(
    mut snapshot: AgentCapabilitySnapshot,
    core: &InspectRequest,
) -> AgentCapabilitySnapshot {
    let Some(args) = probe_args(core.agent) else {
        return snapshot;
    };
    let mut command = silent_command(core.agent.executable());
    command.args(args).current_dir(&core.cwd);
    set_config_root_env(&mut command, core.agent, core.config_root.as_deref());
    match output_with_timeout_bounded(command, LOCAL_PROBE_TIMEOUT, MAX_PROBE_OUTPUT_BYTES) {
        Ok(output) if output.stdout_truncated => {
            snapshot.diagnostics.push(CapabilityDiagnostic {
                code: "agent_probe_output_too_large".to_string(),
                level: DiagnosticLevel::Warning,
            });
        }
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            apply_probe_output(&mut snapshot, &text, output.status.success());
        }
        Err(error) => {
            let code = if error.kind() == std::io::ErrorKind::TimedOut {
                "agent_probe_timeout"
            } else {
                "agent_probe_unavailable"
            };
            snapshot.diagnostics.push(CapabilityDiagnostic {
                code: code.to_string(),
                level: DiagnosticLevel::Warning,
            });
        }
    }
    snapshot
}

#[cfg(target_os = "windows")]
fn wsl_command(distro: &str) -> Result<std::process::Command, String> {
    validate_plain(distro, 128, "agent_capability_wsl_distro_invalid")?;
    let executable =
        crate::wsl::find_wsl_exe().ok_or_else(|| "agent_capability_wsl_unavailable".to_string())?;
    let mut command = silent_command(executable.to_string_lossy().as_ref());
    command.args(["-d", distro]);
    Ok(command)
}

#[cfg(target_os = "windows")]
fn wsl_output(distro: &str, args: &[&str], timeout: Duration) -> Result<BoundedOutput, String> {
    let mut command = wsl_command(distro)?;
    command.args(args);
    output_with_timeout_bounded(command, timeout, MAX_WSL_OUTPUT_BYTES).map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            "agent_capability_wsl_timeout".to_string()
        } else {
            "agent_capability_wsl_command_failed".to_string()
        }
    })
}

#[cfg(target_os = "windows")]
fn wsl_read_bounded(distro: &str, path: &str, max_bytes: usize) -> Option<String> {
    let limit = (max_bytes + 1).to_string();
    let output = wsl_output(
        distro,
        &["--exec", "head", "-c", &limit, "--", path],
        INSPECT_TIMEOUT,
    )
    .ok()?;
    if !output.status.success() || output.stdout.len() > max_bytes {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[cfg(target_os = "windows")]
fn posix_join(root: &str, relative: &str) -> String {
    format!(
        "{}/{}",
        root.trim_end_matches('/'),
        relative.trim_start_matches('/')
    )
}

#[cfg(target_os = "windows")]
fn posix_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let index = trimmed.rfind('/')?;
    if index == 0 {
        Some("/".to_string())
    } else {
        Some(trimmed[..index].to_string())
    }
}

#[cfg(target_os = "windows")]
fn posix_project_roots(root: &str, cwd: &str) -> Vec<String> {
    let normalized_root = root.trim_end_matches('/');
    let mut current = cwd.trim_end_matches('/').to_string();
    let mut paths = Vec::new();
    for _ in 0..32 {
        paths.push(current.clone());
        if current == normalized_root {
            break;
        }
        let Some(parent) = posix_parent(&current) else {
            break;
        };
        if parent == current || !parent.starts_with(normalized_root) {
            break;
        }
        current = parent;
    }
    paths.reverse();
    paths
}

#[cfg(target_os = "windows")]
fn wsl_git_root(distro: &str, cwd: &str) -> String {
    let output = wsl_output(
        distro,
        &["--exec", "git", "-C", cwd, "rev-parse", "--show-toplevel"],
        INSPECT_TIMEOUT,
    );
    output
        .ok()
        .filter(|value| value.status.success())
        .and_then(|value| String::from_utf8(value.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with('/'))
        .unwrap_or_else(|| cwd.to_string())
}

#[cfg(target_os = "windows")]
fn push_wsl_config(
    bundle: &mut DiscoveryBundle,
    distro: &str,
    path: String,
    label: String,
    scope: &str,
    source_kind: &str,
    format: &str,
) {
    if let Some(content) = wsl_read_bounded(distro, &path, 2 * 1024 * 1024) {
        bundle.configs.push(ConfigDocument {
            path_label: label,
            scope: scope.to_string(),
            source_kind: source_kind.to_string(),
            format: format.to_string(),
            content,
        });
    }
}

#[cfg(target_os = "windows")]
fn push_wsl_skills(
    bundle: &mut DiscoveryBundle,
    distro: &str,
    root: String,
    label: String,
    scope: &str,
    source_kind: &str,
) {
    let output = match wsl_output(
        distro,
        &[
            "--exec",
            "find",
            &root,
            "-mindepth",
            "2",
            "-maxdepth",
            "8",
            "-type",
            "f",
            "-name",
            "SKILL.md",
            "-print",
        ],
        INSPECT_TIMEOUT,
    ) {
        Ok(value) if value.status.success() || !value.stdout.is_empty() => value,
        _ => return,
    };
    let paths = String::from_utf8_lossy(&output.stdout);
    for path in paths.lines().take(MAX_WSL_SKILLS) {
        let path = path.trim();
        if path.is_empty() || !path.starts_with(&root) {
            continue;
        }
        let fallback_name = Path::new(path)
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .unwrap_or("skill")
            .to_string();
        let content = wsl_read_bounded(distro, path, 256 * 1024)
            .unwrap_or_else(|| "__CLI_MANAGER_ERROR__:source_unreadable".to_string());
        let relative = path
            .strip_prefix(root.trim_end_matches('/'))
            .unwrap_or(path)
            .trim_start_matches('/');
        bundle.skills.push(SkillDocument {
            path_label: format!("{label}/{relative}"),
            scope: scope.to_string(),
            source_kind: source_kind.to_string(),
            fallback_name,
            content,
        });
    }
}

#[cfg(target_os = "windows")]
fn inspect_wsl(core: InspectRequest, distro: &str) -> Result<AgentCapabilitySnapshot, String> {
    let cwd = if let Some((path_distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&core.cwd) {
        if !path_distro.eq_ignore_ascii_case(distro) {
            return Err("agent_capability_wsl_distro_mismatch".to_string());
        }
        linux_path
    } else if core.cwd.starts_with('/') {
        core.cwd.clone()
    } else {
        return Err("agent_capability_wsl_cwd_invalid".to_string());
    };
    let home_output = wsl_output(distro, &["--exec", "printenv", "HOME"], INSPECT_TIMEOUT)?;
    let home = String::from_utf8(home_output.stdout)
        .map_err(|_| "agent_capability_wsl_home_invalid".to_string())?
        .trim()
        .to_string();
    if !home.starts_with('/') {
        return Err("agent_capability_wsl_home_invalid".to_string());
    }
    let config_root = core.config_root.as_deref().and_then(|value| {
        crate::wsl::parse_wsl_unc_path(value)
            .filter(|(value_distro, _)| value_distro.eq_ignore_ascii_case(distro))
            .map(|(_, path)| path)
            .or_else(|| value.starts_with('/').then(|| value.to_string()))
    });
    let agent_root = config_root.unwrap_or_else(|| match core.agent {
        AgentKind::Claude => posix_join(&home, ".claude"),
        AgentKind::Codex => posix_join(&home, ".codex"),
        AgentKind::Pi => posix_join(&home, ".pi/agent"),
        AgentKind::Grok => posix_join(&home, ".grok"),
        AgentKind::Opencode => posix_join(&home, ".config/opencode"),
    });
    let mut bundle = DiscoveryBundle::default();
    match core.agent {
        AgentKind::Claude => {
            push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&home, ".claude.json"),
                "home/.claude.json".into(),
                "user",
                "native",
                "json",
            );
            push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&agent_root, "settings.json"),
                "home/.claude/settings.json".into(),
                "user",
                "native",
                "json",
            );
        }
        AgentKind::Codex | AgentKind::Grok => push_wsl_config(
            &mut bundle,
            distro,
            posix_join(&agent_root, "config.toml"),
            "home/config.toml".into(),
            "user",
            "native",
            "toml",
        ),
        AgentKind::Opencode => {
            push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&agent_root, "opencode.json"),
                "home/opencode.json".into(),
                "user",
                "native",
                "json",
            );
            push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&agent_root, "opencode.jsonc"),
                "home/opencode.jsonc".into(),
                "user",
                "native",
                "json",
            );
        }
        AgentKind::Pi => {
            push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&home, ".config/mcp/mcp.json"),
                "home/.config/mcp/mcp.json".into(),
                "user",
                "native",
                "json",
            );
            push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&home, ".agents/mcp.json"),
                "home/.agents/mcp.json".into(),
                "user",
                "native",
                "json",
            );
            push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&home, ".agents/mcp/mcp.json"),
                "home/.agents/mcp/mcp.json".into(),
                "user",
                "native",
                "json",
            );
            push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&agent_root, "mcp.json"),
                "home/.pi/agent/mcp.json".into(),
                "user",
                "native",
                "json",
            );
        }
    }
    let mut user_skill_roots: Vec<(String, &str)> = match core.agent {
        AgentKind::Claude | AgentKind::Codex => vec![
            (posix_join(&home, ".agents/skills"), "agent-compatible"),
            (posix_join(&agent_root, "plugins/cache"), "plugin"),
            (posix_join(&agent_root, "skills"), "native"),
        ],
        AgentKind::Pi => vec![
            (posix_join(&home, ".agents/skills"), "agent-compatible"),
            (posix_join(&agent_root, "skills"), "native"),
        ],
        AgentKind::Grok | AgentKind::Opencode => vec![
            (posix_join(&home, ".claude/skills"), "claude-compatible"),
            (posix_join(&home, ".agents/skills"), "agent-compatible"),
            (posix_join(&agent_root, "skills"), "native"),
        ],
    };
    for (index, (root, kind)) in user_skill_roots.drain(..).enumerate() {
        push_wsl_skills(
            &mut bundle,
            distro,
            root,
            format!("home/skills-{index}"),
            "user",
            kind,
        );
    }
    let git_root = wsl_git_root(distro, &cwd);
    for project_root in posix_project_roots(&git_root, &cwd) {
        match core.agent {
            AgentKind::Claude => {
                push_wsl_config(
                    &mut bundle,
                    distro,
                    posix_join(&project_root, ".mcp.json"),
                    "project/.mcp.json".into(),
                    "project",
                    "native",
                    "json",
                );
                push_wsl_config(
                    &mut bundle,
                    distro,
                    posix_join(&project_root, ".claude/settings.json"),
                    "project/.claude/settings.json".into(),
                    "project",
                    "native",
                    "json",
                );
            }
            AgentKind::Codex => push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&project_root, ".codex/config.toml"),
                "project/.codex/config.toml".into(),
                "project",
                "native",
                "toml",
            ),
            AgentKind::Grok => push_wsl_config(
                &mut bundle,
                distro,
                posix_join(&project_root, ".grok/config.toml"),
                "project/.grok/config.toml".into(),
                "project",
                "native",
                "toml",
            ),
            AgentKind::Opencode => {
                push_wsl_config(
                    &mut bundle,
                    distro,
                    posix_join(&project_root, "opencode.json"),
                    "project/opencode.json".into(),
                    "project",
                    "native",
                    "json",
                );
                push_wsl_config(
                    &mut bundle,
                    distro,
                    posix_join(&project_root, ".opencode/opencode.json"),
                    "project/.opencode/opencode.json".into(),
                    "project",
                    "native",
                    "json",
                );
            }
            AgentKind::Pi => {
                push_wsl_config(
                    &mut bundle,
                    distro,
                    posix_join(&project_root, ".mcp.json"),
                    "project/.mcp.json".into(),
                    "project",
                    "native",
                    "json",
                );
                push_wsl_config(
                    &mut bundle,
                    distro,
                    posix_join(&project_root, ".pi/mcp.json"),
                    "project/.pi/mcp.json".into(),
                    "project",
                    "native",
                    "json",
                );
            }
        }
        let roots: Vec<(&str, &str)> = match core.agent {
            AgentKind::Claude => vec![
                (".agents/skills", "agent-compatible"),
                (".claude/skills", "native"),
            ],
            AgentKind::Codex => vec![(".agents/skills", "native")],
            AgentKind::Pi => vec![
                (".agents/skills", "agent-compatible"),
                (".pi/skills", "native"),
            ],
            AgentKind::Grok => vec![
                (".claude/skills", "claude-compatible"),
                (".cursor/skills", "cursor-compatible"),
                (".agents/skills", "agent-compatible"),
                (".grok/skills", "native"),
            ],
            AgentKind::Opencode => vec![
                (".claude/skills", "claude-compatible"),
                (".agents/skills", "agent-compatible"),
                (".opencode/skills", "native"),
            ],
        };
        for (index, (relative, kind)) in roots.into_iter().enumerate() {
            push_wsl_skills(
                &mut bundle,
                distro,
                posix_join(&project_root, relative),
                format!("project/skills-{index}"),
                "project",
                kind,
            );
        }
    }
    let mut normalized = core;
    normalized.cwd = cwd;
    Ok(assemble_snapshot(normalized, bundle))
}

#[cfg(not(target_os = "windows"))]
fn inspect_wsl(_core: InspectRequest, _distro: &str) -> Result<AgentCapabilitySnapshot, String> {
    Err("agent_capability_wsl_unsupported".to_string())
}

#[cfg(target_os = "windows")]
fn probe_wsl(
    mut snapshot: AgentCapabilitySnapshot,
    core: &InspectRequest,
    distro: &str,
) -> AgentCapabilitySnapshot {
    let Some(args) = probe_args(core.agent) else {
        return snapshot;
    };
    let cwd = crate::wsl::parse_wsl_unc_path(&core.cwd)
        .map(|(_, path)| path)
        .unwrap_or_else(|| core.cwd.clone());
    let mut command = match wsl_command(distro) {
        Ok(value) => value,
        Err(_) => {
            snapshot.diagnostics.push(CapabilityDiagnostic {
                code: "agent_probe_unavailable".into(),
                level: DiagnosticLevel::Warning,
            });
            return snapshot;
        }
    };
    command.args(["--cd", &cwd, "--exec", core.agent.executable()]);
    command.args(args);
    match output_with_timeout_bounded(command, LOCAL_PROBE_TIMEOUT, MAX_PROBE_OUTPUT_BYTES) {
        Ok(output) if output.stdout_truncated => {
            snapshot.diagnostics.push(CapabilityDiagnostic {
                code: "agent_probe_output_too_large".to_string(),
                level: DiagnosticLevel::Warning,
            });
        }
        Ok(output) => apply_probe_output(
            &mut snapshot,
            &String::from_utf8_lossy(&output.stdout),
            output.status.success(),
        ),
        Err(error) => snapshot.diagnostics.push(CapabilityDiagnostic {
            code: if error.kind() == std::io::ErrorKind::TimedOut {
                "agent_probe_timeout"
            } else {
                "agent_probe_unavailable"
            }
            .to_string(),
            level: DiagnosticLevel::Warning,
        }),
    }
    snapshot
}

#[cfg(not(target_os = "windows"))]
fn probe_wsl(
    snapshot: AgentCapabilitySnapshot,
    _core: &InspectRequest,
    _distro: &str,
) -> AgentCapabilitySnapshot {
    snapshot
}

fn upgrade_required_snapshot(core: InspectRequest) -> AgentCapabilitySnapshot {
    let mut snapshot = assemble_snapshot(core, DiscoveryBundle::default());
    snapshot.bridge_status = BridgeStatus::UpgradeRequired;
    snapshot.diagnostics.push(CapabilityDiagnostic {
        code: "ssh_agent_upgrade_required".to_string(),
        level: DiagnosticLevel::Warning,
    });
    snapshot
}

fn inspect_ssh(
    daemon_bridge: &DaemonBridge,
    request: AgentCapabilityCommandRequest,
    probe: bool,
) -> Result<AgentCapabilitySnapshot, String> {
    let core = request.core;
    let client = daemon_bridge
        .get()
        .ok_or_else(|| "agent_capability_daemon_unavailable".to_string())?;
    let payload =
        serde_json::to_value(&core).map_err(|_| "agent_capability_request_invalid".to_string())?;
    let result = client.ssh_agent_request(
        request.ssh_consumer_id.unwrap_or_default(),
        request
            .ssh_launch
            .ok_or_else(|| "agent_capability_ssh_context_required".to_string())?,
        if probe {
            "agentCapabilitiesProbe"
        } else {
            "agentCapabilitiesInspect"
        }
        .to_string(),
        payload,
    );
    match result {
        Ok(value) => serde_json::from_value(value)
            .map_err(|_| "agent_capability_response_invalid".to_string()),
        Err(error) if error.contains("agentCapabilitiesV1") => Ok(upgrade_required_snapshot(core)),
        Err(error) => Err(error),
    }
}

async fn execute(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    request: AgentCapabilityCommandRequest,
    probe: bool,
) -> Result<AgentCapabilitySnapshot, String> {
    validate_request(&request)?;
    if request.core.environment == EnvironmentKind::Ssh {
        return inspect_ssh(&daemon_bridge, request, probe);
    }
    let distro = request.wsl_distro_name.clone();
    let core = request.core;
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = match core.environment {
            EnvironmentKind::Local => inspect_local(core.clone())?,
            EnvironmentKind::Wsl => inspect_wsl(
                core.clone(),
                distro
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "agent_capability_wsl_distro_required".to_string())?,
            )?,
            EnvironmentKind::Ssh => unreachable!(),
        };
        Ok(match (probe, core.environment) {
            (true, EnvironmentKind::Local) => probe_local(snapshot, &core),
            (true, EnvironmentKind::Wsl) => {
                probe_wsl(snapshot, &core, distro.as_deref().unwrap_or_default())
            }
            _ => snapshot,
        })
    })
    .await
    .map_err(|_| "agent_capability_task_failed".to_string())?
}

#[tauri::command]
pub async fn agent_capabilities_inspect(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    request: AgentCapabilityCommandRequest,
) -> Result<AgentCapabilitySnapshot, String> {
    execute(daemon_bridge, request, false).await
}

#[tauri::command]
pub async fn agent_capabilities_probe(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    request: AgentCapabilityCommandRequest,
) -> Result<AgentCapabilitySnapshot, String> {
    execute(daemon_bridge, request, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> AgentCapabilityCommandRequest {
        AgentCapabilityCommandRequest {
            core: InspectRequest {
                terminal_session_id: "tab-1".into(),
                cli_session_id: "session-1".into(),
                agent: AgentKind::Codex,
                environment: EnvironmentKind::Local,
                cwd: if cfg!(windows) {
                    r"C:\repo".into()
                } else {
                    "/repo".into()
                },
                config_root: None,
                launch_args: String::new(),
                baseline_config_fingerprint: None,
                runtime_evidence: Vec::new(),
            },
            wsl_distro_name: None,
            ssh_consumer_id: None,
            ssh_launch: None,
        }
    }

    #[test]
    fn rejects_control_characters_at_the_boundary() {
        let mut request = valid_request();
        request.core.cwd.push('\0');
        assert_eq!(
            validate_request(&request).unwrap_err(),
            "agent_capability_cwd_invalid"
        );
    }

    #[test]
    fn ssh_requires_structured_launch_context() {
        let mut request = valid_request();
        request.core.environment = EnvironmentKind::Ssh;
        assert_eq!(
            validate_request(&request).unwrap_err(),
            "agent_capability_ssh_context_required"
        );
    }
}
