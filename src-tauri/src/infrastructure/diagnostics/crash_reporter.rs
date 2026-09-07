use crate::log_rotation::{create_log_writer, DailyRollingLogWriter};
use chrono::Local;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::backtrace::Backtrace;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use uuid::Uuid;

const CRASH_LOG_FILE_NAME: &str = "crash.log";
const MARKER_SCHEMA_VERSION: u32 = 1;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const MAX_MESSAGE_CHARS: usize = 16_384;
const MAX_STACK_CHARS: usize = 64_000;
const MAX_CONTEXT_BYTES: usize = 64_000;
const MAX_BREADCRUMBS: usize = 50;

static REPORTER: OnceLock<CrashReporter> = OnceLock::new();
static SENSITIVE_ASSIGNMENT_RE: OnceLock<Regex> = OnceLock::new();
static SENSITIVE_FLAG_RE: OnceLock<Regex> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendBreadcrumb {
    timestamp: String,
    level: String,
    message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendRuntimeContext {
    activity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    visibility: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    focused: Option<bool>,
    #[serde(default)]
    breadcrumbs: Vec<FrontendBreadcrumb>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendCrashReport {
    kind: String,
    message: String,
    #[serde(default)]
    stack: Option<String>,
    #[serde(default)]
    component_stack: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    column: Option<u32>,
    #[serde(default)]
    context: Option<FrontendRuntimeContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMarker {
    schema_version: u32,
    session_id: String,
    pid: u32,
    process_role: String,
    version: String,
    build: String,
    os: String,
    arch: String,
    started_at: String,
    updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_context: Option<FrontendRuntimeContext>,
}

impl RuntimeMarker {
    fn new(session_id: String, process_role: &str) -> Self {
        let now = timestamp();
        Self {
            schema_version: MARKER_SCHEMA_VERSION,
            session_id,
            pid: std::process::id(),
            process_role: process_role.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            build: build_kind().to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            started_at: now.clone(),
            updated_at: now,
            last_context: None,
        }
    }
}

struct CrashReporter {
    log_dir: PathBuf,
    writer: Mutex<DailyRollingLogWriter>,
    marker_path: Mutex<Option<PathBuf>>,
    marker: Mutex<RuntimeMarker>,
    started: AtomicBool,
    stopped: AtomicBool,
}

pub fn initialize(log_dir: PathBuf, process_role: &str) -> io::Result<()> {
    fs::create_dir_all(&log_dir)?;
    let _ = sensitive_assignment_re();
    let _ = sensitive_flag_re();
    let writer = create_log_writer(log_dir.clone(), CRASH_LOG_FILE_NAME)?;
    let reporter = CrashReporter {
        log_dir,
        writer: Mutex::new(writer),
        marker_path: Mutex::new(None),
        marker: Mutex::new(RuntimeMarker::new(Uuid::new_v4().to_string(), process_role)),
        started: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
    };
    REPORTER.set(reporter).map_err(|_| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "crash reporter already initialized",
        )
    })?;
    install_panic_hook();
    Ok(())
}

pub fn start_runtime() -> io::Result<()> {
    let reporter = REPORTER
        .get()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "crash reporter unavailable"))?;
    if reporter
        .started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    let result = (|| {
        {
            let mut writer = reporter
                .writer
                .lock()
                .map_err(|_| io::Error::other("crash log lock poisoned"))?;
            recover_unclean_markers(&reporter.log_dir, &mut writer)?;
        }
        {
            let mut marker_path = reporter
                .marker_path
                .lock()
                .map_err(|_| io::Error::other("crash marker path lock poisoned"))?;
            *marker_path = Some(available_marker_path(&reporter.log_dir));
        }
        reporter.persist_marker()?;
        start_heartbeat();
        Ok(())
    })();
    if result.is_err() {
        reporter.started.store(false, Ordering::Release);
    }
    result
}

#[tauri::command]
pub fn crash_context_update(payload: FrontendRuntimeContext) -> Result<(), String> {
    let payload = sanitize_context(payload);
    let reporter = REPORTER
        .get()
        .ok_or_else(|| "crash_reporter_unavailable".to_string())?;
    reporter
        .update_context(payload)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn frontend_crash_report(payload: FrontendCrashReport) -> Result<(), String> {
    let reporter = REPORTER
        .get()
        .ok_or_else(|| "crash_reporter_unavailable".to_string())?;
    reporter
        .report_frontend(payload)
        .map_err(|err| err.to_string())
}

pub fn mark_graceful_exit() {
    let Some(reporter) = REPORTER.get() else {
        return;
    };
    reporter.stopped.store(true, Ordering::Release);
    let marker_path = reporter
        .marker_path
        .lock()
        .ok()
        .and_then(|path| path.clone());
    let Some(marker_path) = marker_path else {
        return;
    };
    if let Err(err) = fs::remove_file(marker_path) {
        if err.kind() != io::ErrorKind::NotFound {
            eprintln!("failed to remove crash runtime marker: {err}");
        }
    }
}

impl CrashReporter {
    fn update_context(&self, payload: FrontendRuntimeContext) -> io::Result<()> {
        if let Ok(mut marker) = self.marker.lock() {
            marker.updated_at = timestamp();
            marker.last_context = Some(payload);
        }
        self.persist_marker()
    }

    fn touch(&self) -> io::Result<()> {
        if let Ok(mut marker) = self.marker.lock() {
            marker.updated_at = timestamp();
        }
        self.persist_marker()
    }

    fn persist_marker(&self) -> io::Result<()> {
        let marker_path = self
            .marker_path
            .lock()
            .map_err(|_| io::Error::other("crash marker path lock poisoned"))?
            .clone()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "runtime marker not started"))?;
        let marker = self
            .marker
            .lock()
            .map_err(|_| io::Error::other("crash marker lock poisoned"))?;
        let bytes = serde_json::to_vec_pretty(&*marker).map_err(io::Error::other)?;
        write_and_sync(&marker_path, &bytes)
    }

    fn report_frontend(&self, payload: FrontendCrashReport) -> io::Result<()> {
        let context = payload.context.map(sanitize_context);
        if let Some(context) = context.clone() {
            let _ = self.update_context(context);
        }
        let event = self.base_event(&payload.kind, context);
        self.write_event(json!({
            "event": event,
            "message": truncate_chars(&redact_sensitive(&payload.message), MAX_MESSAGE_CHARS),
            "stack": payload.stack.map(|value| truncate_chars(&redact_sensitive(&value), MAX_STACK_CHARS)),
            "componentStack": payload.component_stack.map(|value| truncate_chars(&redact_sensitive(&value), MAX_STACK_CHARS)),
            "url": payload.url.map(|value| truncate_chars(&redact_sensitive(&value), 4_096)),
            "line": payload.line,
            "column": payload.column,
        }))
    }

    fn report_panic(&self, info: &PanicHookInfo<'_>) {
        let message = panic_message(info);
        let location = info.location().map(|location| {
            json!({
                "file": location.file(),
                "line": location.line(),
                "column": location.column(),
            })
        });
        let thread = std::thread::current();
        let event = json!({
            "event": self.base_event("rust_panic", self.current_context()),
            "message": truncate_chars(&redact_sensitive(&message), MAX_MESSAGE_CHARS),
            "location": location,
            "thread": thread.name().unwrap_or("unnamed"),
            "backtrace": truncate_chars(&redact_sensitive(&Backtrace::force_capture().to_string()), MAX_STACK_CHARS),
        });
        if self.try_write_event(event.clone()).is_err() {
            let _ = write_emergency_event(&self.log_dir, &event);
        }
    }

    fn current_context(&self) -> Option<FrontendRuntimeContext> {
        self.marker
            .try_lock()
            .ok()
            .and_then(|marker| marker.last_context.clone())
    }

    fn base_event(&self, kind: &str, context: Option<FrontendRuntimeContext>) -> Value {
        let marker = self.marker.try_lock().ok().map(|marker| marker.clone());
        json!({
            "timestamp": timestamp(),
            "eventId": Uuid::new_v4().to_string(),
            "kind": truncate_chars(kind, 128),
            "sessionId": marker.as_ref().map(|value| value.session_id.as_str()),
            "processRole": marker.as_ref().map(|value| value.process_role.as_str()),
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "build": build_kind(),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "context": context,
        })
    }

    fn write_event(&self, event: Value) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(&event).map_err(io::Error::other)?;
        bytes.push(b'\n');
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("crash log lock poisoned"))?;
        writer.write_all(&bytes)?;
        writer.flush()
    }

    fn try_write_event(&self, event: Value) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(&event).map_err(io::Error::other)?;
        bytes.push(b'\n');
        let mut writer = self
            .writer
            .try_lock()
            .map_err(|_| io::Error::other("crash log busy during panic"))?;
        writer.write_all(&bytes)?;
        writer.flush()
    }
}

fn recover_unclean_markers(log_dir: &Path, writer: &mut DailyRollingLogWriter) -> io::Result<()> {
    let mut recovered = Vec::new();
    for entry in fs::read_dir(log_dir)? {
        let entry = entry?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !is_runtime_marker_name(&file_name) {
            continue;
        }
        let path = entry.path();
        let parsed = read_runtime_marker(&path);
        if parsed
            .as_ref()
            .is_some_and(|marker| marker.pid != std::process::id() && is_pid_alive(marker.pid))
        {
            continue;
        }
        recovered.push((path, parsed));
    }

    if recovered.is_empty() {
        return Ok(());
    }
    for (path, marker) in recovered {
        let event = json!({
            "event": {
                "timestamp": timestamp(),
                "eventId": Uuid::new_v4().to_string(),
                "kind": "unclean_exit_detected",
                "pid": std::process::id(),
                "version": env!("CARGO_PKG_VERSION"),
                "build": build_kind(),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
            },
            "previousRuntime": marker,
            "note": "The previous app process ended without the normal Tauri Exit event. This can indicate a Rust/native/WebView crash, forced termination, power loss, or OS shutdown.",
        });
        let mut bytes = serde_json::to_vec(&event).map_err(io::Error::other)?;
        bytes.push(b'\n');
        writer.write_all(&bytes)?;
        writer.flush()?;
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn available_marker_path(log_dir: &Path) -> PathBuf {
    let base_name = if cfg!(debug_assertions) {
        "runtime-state-dev.json"
    } else {
        "runtime-state.json"
    };
    let base = log_dir.join(base_name);
    if !base.exists() {
        return base;
    }
    let stem = base_name.trim_end_matches(".json");
    log_dir.join(format!("{stem}-{}.json", std::process::id()))
}

fn is_runtime_marker_name(file_name: &str) -> bool {
    let prefix = if cfg!(debug_assertions) {
        "runtime-state-dev"
    } else {
        "runtime-state"
    };
    file_name.starts_with(prefix) && file_name.ends_with(".json")
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(reporter) = REPORTER.get() {
            reporter.report_panic(info);
        }
        previous(info);
    }));
}

fn start_heartbeat() {
    std::thread::Builder::new()
        .name("crash-heartbeat".to_string())
        .spawn(|| loop {
            std::thread::sleep(HEARTBEAT_INTERVAL);
            let Some(reporter) = REPORTER.get() else {
                return;
            };
            if reporter.stopped.load(Ordering::Acquire) {
                return;
            }
            let _ = reporter.touch();
        })
        .ok();
}

fn sanitize_context(mut context: FrontendRuntimeContext) -> FrontendRuntimeContext {
    context.activity = truncate_chars(&context.activity, 256);
    context.window_label = context
        .window_label
        .map(|value| truncate_chars(&value, 128));
    context.visibility = context.visibility.map(|value| truncate_chars(&value, 64));
    context.data = context
        .data
        .map(redact_json_value)
        .map(|value| limit_json_size(value, MAX_CONTEXT_BYTES));
    let start = context.breadcrumbs.len().saturating_sub(MAX_BREADCRUMBS);
    context.breadcrumbs = context.breadcrumbs.split_off(start);
    for breadcrumb in &mut context.breadcrumbs {
        breadcrumb.timestamp = truncate_chars(&breadcrumb.timestamp, 64);
        breadcrumb.level = truncate_chars(&breadcrumb.level, 32);
        breadcrumb.message = truncate_chars(&redact_sensitive(&breadcrumb.message), 1_024);
        breadcrumb.data = breadcrumb
            .data
            .take()
            .map(redact_json_value)
            .map(|value| limit_json_size(value, 8_192));
    }
    context
}

fn read_runtime_marker(path: &Path) -> Option<RuntimeMarker> {
    for attempt in 0..3 {
        if let Some(marker) = fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RuntimeMarker>(&bytes).ok())
        {
            return Some(marker);
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    None
}

fn sensitive_assignment_re() -> &'static Regex {
    SENSITIVE_ASSIGNMENT_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(["']?(?:token|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)"#,
        )
        .expect("valid sensitive assignment regex")
    })
}

fn sensitive_flag_re() -> &'static Regex {
    SENSITIVE_FLAG_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(--(?:token|password|passwd|secret|api[_-]?key)\s+)(?:"[^"]*"|'[^']*'|\S+)"#,
        )
        .expect("valid sensitive flag regex")
    })
}

fn redact_sensitive(value: &str) -> String {
    let redacted = sensitive_assignment_re().replace_all(value, |captures: &Captures<'_>| {
        format!("{}<redacted>", &captures[1])
    });
    sensitive_flag_re()
        .replace_all(&redacted, |captures: &Captures<'_>| {
            format!("{}<redacted>", &captures[1])
        })
        .into_owned()
}

fn redact_json_value(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact_sensitive(&value)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_json_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, redact_json_value(value)))
                .collect(),
        ),
        value => value,
    }
}

fn limit_json_size(value: Value, max_bytes: usize) -> Value {
    match serde_json::to_vec(&value) {
        Ok(bytes) if bytes.len() <= max_bytes => value,
        Ok(bytes) => Value::String(format!(
            "<truncated JSON: {} bytes, limit {} bytes>",
            bytes.len(),
            max_bytes
        )),
        Err(_) => Value::String("<unserializable JSON>".to_string()),
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut result = value.chars().take(max_chars).collect::<String>();
    result.push_str("…<truncated>");
    result
}

fn panic_message(info: &PanicHookInfo<'_>) -> String {
    if let Some(message) = info.payload().downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = info.payload().downcast_ref::<String>() {
        return message.clone();
    }
    "non-string panic payload".to_string()
}

fn timestamp() -> String {
    Local::now().to_rfc3339()
}

fn build_kind() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

fn is_pid_alive(pid: u32) -> bool {
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

fn write_and_sync(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_data()
}

fn write_emergency_event(log_dir: &Path, event: &Value) -> io::Result<()> {
    let file_name = format!(
        "crash-emergency-{}-{}.log",
        Local::now().format("%Y%m%d-%H%M%S%.3f"),
        std::process::id()
    );
    let bytes = serde_json::to_vec(event).map_err(io::Error::other)?;
    write_and_sync(&log_dir.join(file_name), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_marker_names_are_build_specific() {
        let expected = if cfg!(debug_assertions) {
            "runtime-state-dev.json"
        } else {
            "runtime-state.json"
        };
        assert!(is_runtime_marker_name(expected));
        assert!(!is_runtime_marker_name("cli-manager.log"));
    }

    #[test]
    fn context_is_bounded_and_keeps_latest_breadcrumbs() {
        let breadcrumbs = (0..60)
            .map(|index| FrontendBreadcrumb {
                timestamp: timestamp(),
                level: "info".to_string(),
                message: format!("breadcrumb-{index}"),
                data: None,
            })
            .collect();
        let context = sanitize_context(FrontendRuntimeContext {
            activity: "x".repeat(400),
            data: None,
            window_label: None,
            visibility: None,
            focused: None,
            breadcrumbs,
        });

        assert_eq!(context.activity.chars().count(), 268);
        assert_eq!(context.breadcrumbs.len(), MAX_BREADCRUMBS);
        assert_eq!(context.breadcrumbs[0].message, "breadcrumb-10");
    }

    #[test]
    fn dead_runtime_marker_is_recovered_into_crash_log() {
        let dir = tempfile::tempdir().unwrap();
        let marker_path = dir.path().join(if cfg!(debug_assertions) {
            "runtime-state-dev.json"
        } else {
            "runtime-state.json"
        });
        let mut marker = RuntimeMarker::new("previous-session".to_string(), "app");
        marker.pid = u32::MAX;
        fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();
        let mut writer = create_log_writer(dir.path().to_path_buf(), CRASH_LOG_FILE_NAME).unwrap();

        recover_unclean_markers(dir.path(), &mut writer).unwrap();

        let log = fs::read_to_string(dir.path().join(CRASH_LOG_FILE_NAME)).unwrap();
        assert!(log.contains("unclean_exit_detected"));
        assert!(log.contains("previous-session"));
        assert!(!marker_path.exists());
    }

    #[test]
    fn sensitive_values_are_redacted_in_json_and_cli_forms() {
        let input = r#"{"api_key":"my secret","password":'two words'} --token abc123"#;
        let redacted = redact_sensitive(input);

        assert!(!redacted.contains("my secret"));
        assert!(!redacted.contains("two words"));
        assert!(!redacted.contains("abc123"));
        assert_eq!(redacted.matches("<redacted>").count(), 3);
    }
}
