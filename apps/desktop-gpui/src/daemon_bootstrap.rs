use cli_manager_core::discovery::{
    daemon_info_path, is_pid_alive, read_daemon_info, remove_daemon_info,
};
use cli_manager_pty_client::Endpoint;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Default)]
struct SpawnState {
    last_attempt: Option<Instant>,
}

fn spawn_state() -> &'static Mutex<SpawnState> {
    static STATE: OnceLock<Mutex<SpawnState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(SpawnState::default()))
}

pub(crate) fn endpoint_or_start(data_root: &Path) -> Result<Endpoint, String> {
    if let Some(endpoint) = recorded_endpoint(data_root, cfg!(debug_assertions))? {
        return Ok(endpoint);
    }
    request_spawn(data_root)?;
    Err("daemon endpoint is starting".into())
}

fn recorded_endpoint(data_root: &Path, is_dev: bool) -> Result<Option<Endpoint>, String> {
    let path = daemon_info_path(data_root, is_dev);
    let Some(info) = read_daemon_info(&path)? else {
        return Ok(None);
    };
    if !is_pid_alive(info.pid) {
        remove_daemon_info(&path);
        return Ok(None);
    }
    if !info
        .features
        .iter()
        .any(|feature| feature == "ws_native_client_v1")
    {
        return Err(
            "recorded daemon lacks ws_native_client_v1; upgrade the daemon in this environment"
                .into(),
        );
    }
    Endpoint::from_discovery(&info).map(Some)
}

fn request_spawn(data_root: &Path) -> Result<(), String> {
    let now = Instant::now();
    {
        let mut state = spawn_state()
            .lock()
            .map_err(|_| "daemon bootstrap state poisoned")?;
        if state
            .last_attempt
            .is_some_and(|last| now.duration_since(last) < Duration::from_secs(2))
        {
            return Ok(());
        }
        state.last_attempt = Some(now);
    }
    let (program, self_dispatch) = daemon_command(data_root)?;
    let mut command = std::process::Command::new(&program);
    if self_dispatch {
        command.arg("__daemon");
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("spawn daemon failed: {error}"))
}

fn daemon_command(data_root: &Path) -> Result<(PathBuf, bool), String> {
    if let Some(raw) = std::env::var_os("CLI_MANAGER_DAEMON_EXECUTABLE") {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Ok((path, false));
        }
        return Err("configured daemon executable is not a file".into());
    }
    let current =
        std::env::current_exe().map_err(|error| format!("current_exe failed: {error}"))?;
    if let Some(parent) = current.parent() {
        let sidecar = parent.join(if cfg!(windows) {
            "cli-manager-daemon.exe"
        } else {
            "cli-manager-daemon"
        });
        if sidecar.is_file() {
            return Ok((sidecar, false));
        }
        let app = parent.join(if cfg!(windows) {
            "cli-manager.exe"
        } else {
            "cli-manager"
        });
        if app.is_file() {
            return Ok((app, true));
        }
    }
    let _ = data_root;
    Err("daemon executable not found".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cli_manager_core::discovery::{write_daemon_info_exclusive, DaemonInfo};

    fn info(port: u16) -> DaemonInfo {
        DaemonInfo {
            port: port - 1,
            ws_port: port,
            hook_port: 0,
            token: "test-token".into(),
            pid: std::process::id(),
            version: "test".into(),
            protocol_version: 3,
            binary_protocol_version: 1,
            features: vec!["ws_binary_output_v1".into(), "ws_native_client_v1".into()],
        }
    }

    #[test]
    fn discovery_keeps_development_and_installed_daemons_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let dev = daemon_info_path(directory.path(), true);
        let installed = daemon_info_path(directory.path(), false);
        write_daemon_info_exclusive(&installed, &info(21002)).unwrap();
        assert!(recorded_endpoint(directory.path(), true).unwrap().is_none());
        write_daemon_info_exclusive(&dev, &info(21001)).unwrap();
        assert_eq!(
            recorded_endpoint(directory.path(), true)
                .unwrap()
                .unwrap()
                .port,
            21001
        );
        assert_eq!(
            recorded_endpoint(directory.path(), false)
                .unwrap()
                .unwrap()
                .port,
            21002
        );
        std::fs::remove_file(&installed).unwrap();
        assert!(recorded_endpoint(directory.path(), false)
            .unwrap()
            .is_none());
        assert!(dev.exists());
    }

    #[test]
    fn incompatible_daemon_is_reported_without_removing_its_discovery() {
        let directory = tempfile::tempdir().unwrap();
        let path = daemon_info_path(directory.path(), true);
        let mut legacy = info(21001);
        legacy.features.clear();
        write_daemon_info_exclusive(&path, &legacy).unwrap();
        let error = recorded_endpoint(directory.path(), true).err().unwrap();
        assert!(error.contains("ws_native_client_v1"));
        assert!(!error.contains(&legacy.token));
        assert_eq!(read_daemon_info(&path).unwrap().unwrap(), legacy);
    }

    #[test]
    fn stale_discovery_cleanup_only_affects_selected_environment() {
        let directory = tempfile::tempdir().unwrap();
        let dev = daemon_info_path(directory.path(), true);
        let installed = daemon_info_path(directory.path(), false);
        let mut stale = info(21001);
        stale.pid = u32::MAX;
        write_daemon_info_exclusive(&dev, &stale).unwrap();
        write_daemon_info_exclusive(&installed, &info(21002)).unwrap();
        assert!(recorded_endpoint(directory.path(), true).unwrap().is_none());
        assert!(!dev.exists());
        assert!(installed.exists());
    }

    #[test]
    fn malformed_discovery_does_not_fall_back_to_another_environment() {
        let directory = tempfile::tempdir().unwrap();
        let dev = daemon_info_path(directory.path(), true);
        std::fs::write(&dev, b"not json").unwrap();
        write_daemon_info_exclusive(&daemon_info_path(directory.path(), false), &info(21002))
            .unwrap();
        assert!(recorded_endpoint(directory.path(), true).is_err());
        assert!(dev.exists());
    }
}
