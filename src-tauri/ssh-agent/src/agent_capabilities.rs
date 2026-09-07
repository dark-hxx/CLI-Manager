use cli_manager_agent_capabilities::{
    apply_probe_output, assemble_snapshot, collect_local_bundle, discovery_layout,
    AgentCapabilitySnapshot, AgentKind, CapabilityDiagnostic, DiagnosticLevel, DiscoveryBundle,
    EnvironmentKind, InspectRequest,
};
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PROBE_OUTPUT_BYTES: usize = 256 * 1024;

fn validate_request(request: &InspectRequest) -> Result<(), &'static str> {
    if request.environment != EnvironmentKind::Ssh {
        return Err("agent_capability_environment_invalid");
    }
    if request.terminal_session_id.is_empty()
        || request.cli_session_id.is_empty()
        || request.terminal_session_id.len() > 512
        || request.cli_session_id.len() > 512
        || request.terminal_session_id.contains(['\0', '\r', '\n'])
        || request.cli_session_id.contains(['\0', '\r', '\n'])
    {
        return Err("agent_capability_session_id_invalid");
    }
    if request.cwd.len() > 4096
        || request.cwd.contains('\0')
        || !Path::new(&request.cwd).is_absolute()
    {
        return Err("agent_capability_cwd_invalid");
    }
    if request.config_root.as_deref().is_some_and(|value| {
        value.len() > 4096 || value.contains('\0') || !Path::new(value).is_absolute()
    }) {
        return Err("agent_capability_config_root_invalid");
    }
    Ok(())
}

fn home_dir() -> Result<PathBuf, &'static str> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .and_then(|path| path.canonicalize().ok())
        .filter(|path| path.is_dir())
        .ok_or("agent_capability_home_unavailable")
}

fn inspect(request: InspectRequest) -> Result<AgentCapabilitySnapshot, &'static str> {
    validate_request(&request)?;
    let home = home_dir()?;
    let cwd = Path::new(&request.cwd)
        .canonicalize()
        .ok()
        .filter(|path| path.is_dir())
        .ok_or("agent_capability_cwd_unavailable")?;
    let config_root = request
        .config_root
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(Path::new)
        .map(|path| {
            path.canonicalize()
                .ok()
                .filter(|value| value.is_dir())
                .ok_or("agent_capability_config_root_unavailable")
        })
        .transpose()?;
    let layout = discovery_layout(request.agent, &home, &cwd, config_root.as_deref());
    Ok(assemble_snapshot(request, collect_local_bundle(&layout)))
}

fn probe_args(agent: AgentKind) -> Option<&'static [&'static str]> {
    match agent {
        AgentKind::Claude => Some(&["mcp", "list"]),
        AgentKind::Codex | AgentKind::Grok => Some(&["mcp", "list", "--json"]),
        AgentKind::Opencode => Some(&["mcp", "list"]),
        AgentKind::Pi => None,
    }
}

fn read_bounded(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut retained = Vec::with_capacity(limit.min(8 * 1024));
    let mut truncated = false;
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let count = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let remaining = limit.saturating_sub(retained.len());
        let copy_count = remaining.min(count);
        retained.extend_from_slice(&chunk[..copy_count]);
        truncated |= copy_count < count;
    }
    (retained, truncated)
}

fn run_probe(request: &InspectRequest) -> Result<(bool, Vec<u8>), &'static str> {
    let Some(args) = probe_args(request.agent) else {
        return Ok((true, Vec::new()));
    };
    let mut command = Command::new(request.agent.executable());
    command
        .args(args)
        .current_dir(&request.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(root) = request
        .config_root
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        match request.agent {
            AgentKind::Claude => {
                command.env("CLAUDE_CONFIG_DIR", root);
            }
            AgentKind::Codex => {
                command.env("CODEX_HOME", root);
            }
            AgentKind::Pi | AgentKind::Grok | AgentKind::Opencode => {}
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| "agent_probe_unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("agent_probe_output_unavailable")?;
    let output_thread = thread::spawn(move || {
        read_bounded(std::io::BufReader::new(stdout), MAX_PROBE_OUTPUT_BYTES)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= PROBE_TIMEOUT => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                let _ = output_thread.join();
                return Err("agent_probe_timeout");
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => return Err("agent_probe_failed"),
        }
    };
    let (output, output_truncated) = output_thread
        .join()
        .map_err(|_| "agent_probe_output_unavailable")?;
    if output_truncated {
        return Err("agent_probe_output_too_large");
    }
    Ok((status.success(), output))
}

pub fn execute(
    request: InspectRequest,
    probe: bool,
) -> Result<AgentCapabilitySnapshot, &'static str> {
    let mut snapshot = inspect(request.clone())?;
    if !probe || request.agent == AgentKind::Pi {
        return Ok(snapshot);
    }
    match run_probe(&request) {
        Ok((success, output)) => {
            apply_probe_output(&mut snapshot, &String::from_utf8_lossy(&output), success);
        }
        Err(code) => snapshot.diagnostics.push(CapabilityDiagnostic {
            code: code.to_string(),
            level: DiagnosticLevel::Warning,
        }),
    }
    Ok(snapshot)
}

pub fn invalid_snapshot(request: InspectRequest, code: &str) -> AgentCapabilitySnapshot {
    let mut snapshot = assemble_snapshot(request, DiscoveryBundle::default());
    snapshot.diagnostics.push(CapabilityDiagnostic {
        code: code.to_string(),
        level: DiagnosticLevel::Error,
    });
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_inspection_rejects_local_environment() {
        let request = InspectRequest {
            terminal_session_id: "tab".into(),
            cli_session_id: "session".into(),
            agent: AgentKind::Codex,
            environment: EnvironmentKind::Local,
            cwd: "/tmp".into(),
            config_root: None,
            launch_args: String::new(),
            baseline_config_fingerprint: None,
            runtime_evidence: Vec::new(),
        };
        assert_eq!(
            validate_request(&request),
            Err("agent_capability_environment_invalid")
        );
    }

    #[test]
    fn bounded_probe_reader_discards_bytes_over_the_limit() {
        let input = vec![b'x'; 64];
        let (retained, truncated) = read_bounded(input.as_slice(), 16);
        assert_eq!(retained.len(), 16);
        assert!(truncated);
    }
}
