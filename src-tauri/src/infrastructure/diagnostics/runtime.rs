use chrono::{Local, SecondsFormat};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(30);
const ENABLE_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const TOP_PROCESS_LIMIT: usize = 8;
const MAX_LOG_ENTRY_BYTES: usize = 64 * 1024;

static ENABLED: AtomicBool = AtomicBool::new(false);
static STARTED: OnceLock<()> = OnceLock::new();
static WRITE_FAILURE_REPORTED: AtomicBool = AtomicBool::new(false);
static RESOURCE_LOG_WRITER: OnceLock<
    Result<Mutex<crate::log_rotation::DailyRollingLogWriter>, String>,
> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ManagedProcessRole {
    AppMain,
    WebviewChild,
    AppChild,
    PtyDaemon,
    PtyChild,
}

impl ManagedProcessRole {
    fn label(self) -> &'static str {
        match self {
            Self::AppMain => "app-main",
            Self::WebviewChild => "webview-child",
            Self::AppChild => "app-child",
            Self::PtyDaemon => "pty-daemon",
            Self::PtyChild => "pty-child",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessGroupSnapshot {
    role: &'static str,
    process_count: usize,
    cpu_usage_percent: f32,
    memory_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedProcessSnapshot {
    role: &'static str,
    pid: u32,
    name: String,
    cpu_usage_percent: f32,
    memory_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeResourceSnapshot {
    sampled_at: u64,
    cpu_sample_ready: bool,
    app_pid: u32,
    daemon_pid: Option<u32>,
    groups: Vec<ProcessGroupSnapshot>,
    total_cpu_usage_percent: f32,
    total_memory_bytes: u64,
    top_processes: Vec<ManagedProcessSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceDiagnosticLogRecord<'a, T: Serialize + ?Sized> {
    timestamp: &'a str,
    level: &'a str,
    source: &'a str,
    event: &'a str,
    payload: &'a T,
}

pub fn start(initially_enabled: bool) {
    set_enabled(initially_enabled);
    if STARTED.set(()).is_err() {
        return;
    }
    if let Err(err) = std::thread::Builder::new()
        .name("resource-diagnostics".to_string())
        .spawn(run_sampler)
    {
        log::warn!("failed to start resource diagnostics sampler: {err}");
    }
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Release);
}

pub(crate) fn write_frontend_entry(
    level: &str,
    source: &str,
    event: &str,
    payload: &Value,
) -> Result<(), String> {
    validate_frontend_route(level, source, event)?;
    record_resource_diagnostic(level, source, event, payload)
}

fn validate_frontend_route(level: &str, source: &str, event: &str) -> Result<(), String> {
    let valid = matches!(
        (level, source, event),
        ("info", "webview", "runtimeSnapshot")
            | ("warn", "terminalProcessManager", "backlogThresholdExceeded")
            | ("info", "terminalProcessManager", "backlogRecovered")
            | ("warn", "ptyHostSocket", "backlogThresholdExceeded")
            | ("info", "ptyHostSocket", "backlogCleared")
    );
    if valid {
        Ok(())
    } else {
        Err("resource_diagnostics_invalid_entry".to_string())
    }
}

fn resource_log_file_name() -> &'static str {
    if cfg!(debug_assertions) {
        "resource-diagnostics-dev.log"
    } else {
        "resource-diagnostics.log"
    }
}

fn diagnostics_writer() -> Result<&'static Mutex<crate::log_rotation::DailyRollingLogWriter>, String>
{
    match RESOURCE_LOG_WRITER.get_or_init(|| {
        let log_dir = crate::app_paths::logs_dir()?;
        crate::log_rotation::create_log_writer(log_dir, resource_log_file_name())
            .map(Mutex::new)
            .map_err(|err| format!("resource_diagnostics_writer_init_failed: {err}"))
    }) {
        Ok(writer) => Ok(writer),
        Err(err) => Err(err.clone()),
    }
}

fn serialize_log_record_at<T: Serialize + ?Sized>(
    timestamp: &str,
    level: &str,
    source: &str,
    event: &str,
    payload: &T,
) -> Result<Vec<u8>, String> {
    let record = ResourceDiagnosticLogRecord {
        timestamp,
        level,
        source,
        event,
        payload,
    };
    let mut line = serde_json::to_vec(&record)
        .map_err(|err| format!("resource_diagnostics_serialize_failed: {err}"))?;
    if line.len() + 1 > MAX_LOG_ENTRY_BYTES {
        return Err("resource_diagnostics_entry_too_large".to_string());
    }
    line.push(b'\n');
    Ok(line)
}

fn write_resource_diagnostic<T: Serialize + ?Sized>(
    level: &str,
    source: &str,
    event: &str,
    payload: &T,
) -> Result<(), String> {
    let timestamp = Local::now().to_rfc3339_opts(SecondsFormat::Millis, false);
    let line = serialize_log_record_at(&timestamp, level, source, event, payload)?;
    let writer = diagnostics_writer()?;
    let mut writer = writer
        .lock()
        .map_err(|_| "resource_diagnostics_writer_poisoned".to_string())?;
    writer
        .write_all(&line)
        .map_err(|err| format!("resource_diagnostics_write_failed: {err}"))
}

fn record_resource_diagnostic<T: Serialize + ?Sized>(
    level: &str,
    source: &str,
    event: &str,
    payload: &T,
) -> Result<(), String> {
    let result = write_resource_diagnostic(level, source, event, payload);
    match &result {
        Ok(()) => WRITE_FAILURE_REPORTED.store(false, Ordering::Release),
        Err(err) => {
            if !WRITE_FAILURE_REPORTED.swap(true, Ordering::AcqRel) {
                log::warn!("resource diagnostics write failed: {err}");
            }
        }
    }
    result
}

fn run_sampler() {
    let mut system = System::new();
    let mut sampling_active = false;
    let mut next_sample_at = Instant::now();

    loop {
        if !ENABLED.load(Ordering::Acquire) {
            sampling_active = false;
            std::thread::sleep(ENABLE_CHECK_INTERVAL);
            continue;
        }

        let now = Instant::now();
        if !sampling_active || now >= next_sample_at {
            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_memory()
                    .without_tasks(),
            );
            log_snapshot(&system, sampling_active);
            sampling_active = true;
            next_sample_at = Instant::now() + SAMPLE_INTERVAL;
        }
        std::thread::sleep(ENABLE_CHECK_INTERVAL);
    }
}

fn log_snapshot(system: &System, cpu_sample_ready: bool) {
    let app_pid = std::process::id();
    let daemon_pid = current_daemon_pid(system);
    let parents = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            process
                .parent()
                .map(|parent| (pid.as_u32(), parent.as_u32()))
        })
        .collect::<HashMap<_, _>>();

    let mut processes = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let name = process.name().to_string_lossy().into_owned();
            let role = classify_process(pid.as_u32(), &name, app_pid, daemon_pid, &parents)?;
            Some(ManagedProcessSnapshot {
                role: role.label(),
                pid: pid.as_u32(),
                name,
                cpu_usage_percent: finite_cpu(process.cpu_usage()),
                memory_bytes: process.memory(),
            })
        })
        .collect::<Vec<_>>();

    let roles = [
        ManagedProcessRole::AppMain,
        ManagedProcessRole::WebviewChild,
        ManagedProcessRole::AppChild,
        ManagedProcessRole::PtyDaemon,
        ManagedProcessRole::PtyChild,
    ];
    let groups = roles
        .into_iter()
        .map(|role| {
            let role_processes = processes
                .iter()
                .filter(|process| process.role == role.label());
            let (process_count, cpu_usage_percent, memory_bytes) =
                role_processes.fold((0usize, 0.0f32, 0u64), |(count, cpu, memory), process| {
                    (
                        count + 1,
                        cpu + process.cpu_usage_percent,
                        memory.saturating_add(process.memory_bytes),
                    )
                });
            ProcessGroupSnapshot {
                role: role.label(),
                process_count,
                cpu_usage_percent,
                memory_bytes,
            }
        })
        .collect::<Vec<_>>();
    let total_cpu_usage_percent = processes
        .iter()
        .map(|process| process.cpu_usage_percent)
        .sum();
    let total_memory_bytes = processes.iter().fold(0u64, |total, process| {
        total.saturating_add(process.memory_bytes)
    });
    processes.sort_by(|left, right| {
        right
            .cpu_usage_percent
            .total_cmp(&left.cpu_usage_percent)
            .then_with(|| right.memory_bytes.cmp(&left.memory_bytes))
    });
    processes.truncate(TOP_PROCESS_LIMIT);

    let snapshot = RuntimeResourceSnapshot {
        sampled_at: epoch_millis(),
        cpu_sample_ready,
        app_pid,
        daemon_pid,
        groups,
        total_cpu_usage_percent,
        total_memory_bytes,
        top_processes: processes,
    };
    let _ = record_resource_diagnostic("info", "process", "runtimeSnapshot", &snapshot);
}

fn current_daemon_pid(system: &System) -> Option<u32> {
    let data_dir = crate::app_paths::cli_manager_data_dir().ok()?;
    let path = crate::daemon::discovery::daemon_info_path(&data_dir, cfg!(debug_assertions));
    let pid = crate::daemon::discovery::read_daemon_info(&path)
        .ok()
        .flatten()?
        .pid;
    let process = system.process(sysinfo::Pid::from_u32(pid))?;
    process
        .name()
        .to_string_lossy()
        .to_ascii_lowercase()
        .contains("cli-manager-daemon")
        .then_some(pid)
}

fn classify_process(
    pid: u32,
    name: &str,
    app_pid: u32,
    daemon_pid: Option<u32>,
    parents: &HashMap<u32, u32>,
) -> Option<ManagedProcessRole> {
    if daemon_pid == Some(pid) {
        return Some(ManagedProcessRole::PtyDaemon);
    }
    if daemon_pid.is_some_and(|daemon| is_descendant_of(pid, daemon, parents)) {
        return Some(ManagedProcessRole::PtyChild);
    }
    if pid == app_pid {
        return Some(ManagedProcessRole::AppMain);
    }
    if !is_descendant_of(pid, app_pid, parents) {
        return None;
    }
    if is_webview_process_name(name) {
        Some(ManagedProcessRole::WebviewChild)
    } else {
        Some(ManagedProcessRole::AppChild)
    }
}

fn is_descendant_of(pid: u32, ancestor: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut current = pid;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        let Some(parent) = parents.get(&current).copied() else {
            return false;
        };
        if parent == ancestor {
            return true;
        }
        current = parent;
    }
    false
}

fn is_webview_process_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("msedgewebview2")
        || normalized.contains("webkitwebprocess")
        || normalized.contains("webkitnetworking")
        || normalized.contains("webview")
}

fn finite_cpu(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent_map(entries: &[(u32, u32)]) -> HashMap<u32, u32> {
        entries.iter().copied().collect()
    }

    #[test]
    fn daemon_tree_takes_priority_over_app_tree() {
        let parents = parent_map(&[(20, 10), (21, 20), (30, 10)]);
        assert_eq!(
            classify_process(20, "cli-manager-daemon.exe", 10, Some(20), &parents),
            Some(ManagedProcessRole::PtyDaemon)
        );
        assert_eq!(
            classify_process(21, "codex.exe", 10, Some(20), &parents),
            Some(ManagedProcessRole::PtyChild)
        );
        assert_eq!(
            classify_process(30, "msedgewebview2.exe", 10, Some(20), &parents),
            Some(ManagedProcessRole::WebviewChild)
        );
    }

    #[test]
    fn process_outside_managed_trees_is_ignored() {
        let parents = parent_map(&[(11, 10), (50, 40)]);
        assert_eq!(classify_process(50, "other.exe", 10, None, &parents), None);
    }

    #[test]
    fn parent_cycles_do_not_loop_forever() {
        let parents = parent_map(&[(20, 21), (21, 20)]);
        assert!(!is_descendant_of(20, 10, &parents));
    }

    #[test]
    fn diagnostic_records_are_single_line_json() {
        let payload = serde_json::json!({ "queuedBytes": 42, "text": "line\nbreak" });
        let line = serialize_log_record_at(
            "2026-07-31T12:00:00.000+08:00",
            "warn",
            "ptyHostSocket",
            "backlogThresholdExceeded",
            &payload,
        )
        .unwrap();

        assert_eq!(line.iter().filter(|byte| **byte == b'\n').count(), 1);
        assert_eq!(line.last(), Some(&b'\n'));
        let parsed: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(parsed["source"], "ptyHostSocket");
        assert_eq!(parsed["payload"]["queuedBytes"], 42);
    }

    #[test]
    fn oversized_diagnostic_records_are_rejected() {
        let payload = "x".repeat(MAX_LOG_ENTRY_BYTES);
        assert_eq!(
            serialize_log_record_at("timestamp", "info", "webview", "runtimeSnapshot", &payload)
                .unwrap_err(),
            "resource_diagnostics_entry_too_large"
        );
    }

    #[test]
    fn frontend_diagnostic_routes_are_allowlisted() {
        assert!(validate_frontend_route("info", "webview", "runtimeSnapshot").is_ok());
        assert!(validate_frontend_route(
            "warn",
            "terminalProcessManager",
            "backlogThresholdExceeded"
        )
        .is_ok());
        assert!(validate_frontend_route("info", "webview", "terminalText").is_err());
        assert!(validate_frontend_route("warn", "unknown", "runtimeSnapshot").is_err());
    }
}
