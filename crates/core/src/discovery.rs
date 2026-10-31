use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const DAEMON_INFO_FILE_NAME: &str = "daemon.json";
const DEV_DAEMON_INFO_FILE_NAME: &str = "daemon.dev.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    pub port: u16,
    #[serde(default)]
    pub ws_port: u16,
    #[serde(default)]
    pub hook_port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
    #[serde(default)]
    pub protocol_version: u16,
    #[serde(default)]
    pub binary_protocol_version: u8,
    #[serde(default)]
    pub features: Vec<String>,
}

pub fn daemon_info_file_name(is_dev: bool) -> &'static str {
    if is_dev {
        DEV_DAEMON_INFO_FILE_NAME
    } else {
        DAEMON_INFO_FILE_NAME
    }
}

pub fn daemon_info_path(data_dir: &Path, is_dev: bool) -> PathBuf {
    data_dir.join(daemon_info_file_name(is_dev))
}

pub fn write_daemon_info_exclusive(path: &Path, info: &DaemonInfo) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("create data dir failed: {err}"))?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|err| format!("daemon info exists or not writable: {err}"))?;
    let payload =
        serde_json::to_string_pretty(info).map_err(|err| format!("serialize failed: {err}"))?;
    file.write_all(payload.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|err| format!("write daemon info failed: {err}"))
}

pub fn read_daemon_info(path: &Path) -> Result<Option<DaemonInfo>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("read daemon info failed: {err}")),
    };
    serde_json::from_str::<DaemonInfo>(&raw)
        .map(Some)
        .map_err(|err| format!("parse daemon info failed: {err}"))
}

pub fn remove_daemon_info(path: &Path) {
    if let Err(err) = fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            log::warn!("remove daemon info failed: {err}");
        }
    }
}

pub fn is_pid_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let target = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(target).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> DaemonInfo {
        DaemonInfo {
            port: 12345,
            ws_port: 12347,
            hook_port: 12346,
            token: "tok".into(),
            pid: 42,
            version: "1.2.7".into(),
            protocol_version: 9,
            binary_protocol_version: 1,
            features: vec!["localRoutingV1".into()],
        }
    }

    #[test]
    fn file_name_is_isolated_per_environment() {
        assert_eq!(daemon_info_file_name(false), "daemon.json");
        assert_eq!(daemon_info_file_name(true), "daemon.dev.json");
    }
    #[test]
    fn write_read_roundtrip_and_exclusive_create() {
        let dir = tempfile::tempdir().unwrap();
        let path = daemon_info_path(dir.path(), false);
        write_daemon_info_exclusive(&path, &sample()).unwrap();
        assert_eq!(read_daemon_info(&path).unwrap(), Some(sample()));
        assert!(write_daemon_info_exclusive(&path, &sample()).is_err());
        remove_daemon_info(&path);
        assert_eq!(read_daemon_info(&path).unwrap(), None);
        write_daemon_info_exclusive(&path, &sample()).unwrap();
    }
    #[test]
    fn missing_file_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_daemon_info(&daemon_info_path(dir.path(), true)).unwrap(),
            None
        );
    }
    #[test]
    fn legacy_info_defaults_protocol_capabilities() {
        let info: DaemonInfo =
            serde_json::from_str(r#"{"port":1,"token":"tok","pid":2,"version":"old"}"#).unwrap();
        assert_eq!(info.protocol_version, 0);
        assert_eq!(info.binary_protocol_version, 0);
        assert!(info.features.is_empty());
    }
    #[test]
    fn pid_liveness() {
        assert!(is_pid_alive(std::process::id()));
        assert!(!is_pid_alive(u32::MAX - 1));
    }
}
