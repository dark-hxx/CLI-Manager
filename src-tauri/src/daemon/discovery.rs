//! daemon 发现与单实例：`~/.cli-manager/daemon.json`（dev 构建 `daemon.dev.json`）。
//!
//! 契约：daemon 启动以独占创建写入（防多实例并存）；退出时删除；
//! app 侧读到 pid 已死的残留文件应删除后重拉。文件不进日志（含 token）。

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
    /// WebView 直连 PtyHost 的本机 WebSocket 端口。
    #[serde(default)]
    pub ws_port: u16,
    /// hook 上报转发端口（稳定端口，PTY 子进程环境变量指向它，app 重启不失效）。
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

/// dev 与安装版使用不同发现文件，互不 attach（对齐 sessions.dev.json 隔离规则）。
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

/// 独占创建写入发现文件：已存在即失败（单实例约束，由调用方决定是否清扫残留后重试）。
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

/// pid 存活检测：用于识别 daemon.json 残留（进程已死 → 删除文件重拉）。
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
            protocol_version: crate::daemon::protocol::CONTROL_PROTOCOL_VERSION,
            binary_protocol_version: crate::daemon::protocol::BINARY_PROTOCOL_VERSION,
            features: crate::daemon::protocol::supported_features(),
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
        // 第二次独占创建必须失败：禁止多 daemon 并存。
        assert!(write_daemon_info_exclusive(&path, &sample()).is_err());
        remove_daemon_info(&path);
        assert_eq!(read_daemon_info(&path).unwrap(), None);
        // 删除后可重新创建。
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
        // u32::MAX 几乎不可能是真实 pid。
        assert!(!is_pid_alive(u32::MAX - 1));
    }
}
