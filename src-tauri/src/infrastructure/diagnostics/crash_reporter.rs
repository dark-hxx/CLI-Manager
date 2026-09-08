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
    // 构造当前进程的运行标记，记录版本/平台和起始时间，前端上下文初始为空。
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

// 创建崩溃日志写入器并安装全局 reporter 与 panic hook；重复初始化返回 AlreadyExists。
// 此阶段尚未恢复旧标记、写当前标记或启动心跳，这些由 start_runtime 负责。
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

// 用原子标志避免重复启动，恢复遗留标记后持久化当前标记并启动心跳；失败时允许再次尝试。
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
// IPC 更新前先限制上下文并处理可识别敏感文本，再交给 reporter 持久化；未初始化时返回错误。
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
// 将前端错误交给已初始化 reporter 做字段处理和写盘，不在此入口创建 reporter。
pub fn frontend_crash_report(payload: FrontendCrashReport) -> Result<(), String> {
    let reporter = REPORTER
        .get()
        .ok_or_else(|| "crash_reporter_unavailable".to_string())?;
    reporter
        .report_frontend(payload)
        .map_err(|err| err.to_string())
}

// 标记心跳应停止并尝试删除本进程标记；缺失无操作，其余删除失败写 stderr，不等待线程退出。
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
    // 更新内存标记时间与上下文后持久化；传入上下文应已由外层处理大小和敏感文本。
    fn update_context(&self, payload: FrontendRuntimeContext) -> io::Result<()> {
        if let Ok(mut marker) = self.marker.lock() {
            marker.updated_at = timestamp();
            marker.last_context = Some(payload);
        }
        self.persist_marker()
    }

    // 心跳刷新更新时间并写回标记，不改变最近前端上下文。
    fn touch(&self) -> io::Result<()> {
        if let Ok(mut marker) = self.marker.lock() {
            marker.updated_at = timestamp();
        }
        self.persist_marker()
    }

    // 取得已启动的标记路径，持有标记锁序列化并覆盖同步写盘；不是临时文件替换式发布。
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

    // 处理错误文本、堆栈、URL 和可选上下文后写 JSON 日志；上下文标记更新失败不阻止错误日志写入。
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

    // 收集 panic 位置、线程、消息与强制回溯，尝试非阻塞获取日志锁；失败改写独立应急文件。
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

    // 尝试读取最近上下文，标记锁繁忙或中毒时返回 None，避免 panic 路径等待该锁。
    fn current_context(&self) -> Option<FrontendRuntimeContext> {
        self.marker
            .try_lock()
            .ok()
            .and_then(|marker| marker.last_context.clone())
    }

    // 生成事件时间、UUID 与构建信息；标记锁不可用时允许会话/角色为空，传入上下文不再处理。
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

    // 将事件序列化为单行 JSON，阻塞获取滚动日志锁后写入并 flush，序列化或 IO 失败向上传播。
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

    // panic 专用日志路径：获取锁不等待，但成功后的写入仍同步执行；失败交由调用方应急处理。
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

// 扫描匹配名称的标记，跳过可解析且属于其他存活 PID 的项；其余记为未正常退出并尝试删除。
// 包括无效标记和当前 PID 的遗留标记；该事件不能单独证明软件崩溃。
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

// 优先选构建模式的基础标记名，已存在时附加当前 PID；不预留或再次检查 PID 路径是否占用。
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

// 按当前 debug_assertions 对应前缀和 .json 后缀匹配；不是严格文件名解析，release 前缀也匹配 dev 名。
fn is_runtime_marker_name(file_name: &str) -> bool {
    let prefix = if cfg!(debug_assertions) {
        "runtime-state-dev"
    } else {
        "runtime-state"
    };
    let Some(stem) = file_name.strip_suffix(".json") else {
        return false;
    };
    if stem == prefix {
        return true;
    }
    stem.strip_prefix(prefix)
        .and_then(|suffix| suffix.strip_prefix('-'))
        .is_some_and(|pid| !pid.is_empty() && pid.chars().all(|ch| ch.is_ascii_digit()))
}

// 安装先记录再调用原 hook 的 panic 处理链，保留原有默认或外部处理逻辑。
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(reporter) = REPORTER.get() {
            reporter.report_panic(info);
        }
        previous(info);
    }));
}

// 启动命名后台线程，每 15 秒刷新标记；停止标志使其下次醒来退出，线程创建和写入失败被忽略。
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

// 限制活动/窗口字段并保留最新 50 条轨迹，对 data 字符串叶子和轨迹消息做正则脱敏及分项限长。
// 不按对象键删除敏感字段，也不对活动名等所有文本脱敏；调用方仍须避免上传秘密。
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

// 最多三次尝试读并解析标记，失败之间等待 10ms 以容忍正在覆盖写入；最终失败返回 None。
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

// 缓存识别 token/password 等赋值文本的正则；只覆盖列出的文本形式，并非结构化字段策略。
fn sensitive_assignment_re() -> &'static Regex {
    SENSITIVE_ASSIGNMENT_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(["']?(?:token|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)"#,
        )
        .expect("valid sensitive assignment regex")
    })
}

// 缓存识别敏感长选项后空白分隔参数值的正则，带等号形式由赋值正则处理。
fn sensitive_flag_re() -> &'static Regex {
    SENSITIVE_FLAG_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(--(?:token|password|passwd|secret|api[_-]?key)\s+)(?:"[^"]*"|'[^']*'|\S+)"#,
        )
        .expect("valid sensitive flag regex")
    })
}

// 依次替换可识别的赋值和 CLI 参数值，保留键/选项前缀；未匹配文本原样保留。
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

// 递归处理数组和对象中的字符串值，仅对字符串内容做正则替换，不依据对象键判断敏感性。
fn redact_json_value(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact_sensitive(&value)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_json_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let value = if is_sensitive_json_key(&key) {
                        Value::String("<redacted>".to_string())
                    } else {
                        redact_json_value(value)
                    };
                    (key, value)
                })
                .collect(),
        ),
        value => value,
    }
}

fn is_sensitive_json_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "token",
        "password",
        "passwd",
        "secret",
        "apikey",
        "authorization",
        "cookie",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

// 序列化字节数超限时用摘要字符串替换整个值，不裁剪 JSON；摘要本身不再次套用字节限制。
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

// 按 Unicode 字符数截取前缀并追加截断标记，最终长度可超过 max_chars，避免切断 UTF-8 字节。
fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut result = value.chars().take(max_chars).collect::<String>();
    result.push_str("…<truncated>");
    result
}

// 提取两种常见字符串 panic 载荷，其他类型返回固定提示，不尝试调试打印未知对象。
fn panic_message(info: &PanicHookInfo<'_>) -> String {
    if let Some(message) = info.payload().downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = info.payload().downcast_ref::<String>() {
        return message.clone();
    }
    "non-string panic payload".to_string()
}

// 返回带本地时区偏移的 RFC3339 时间，用于日志与运行标记。
fn timestamp() -> String {
    Local::now().to_rfc3339()
}

// 根据 debug_assertions 返回诊断构建标签，与 Tauri cfg(dev) 不是同一判定。
fn build_kind() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

// 只刷新目标 PID 的存在信息，不读取命令行；不验证进程启动时间或身份是否与旧标记相同。
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

// 创建或截断目标文件，完整写入后 sync_data；失败可能留下部分内容，不执行原子替换。
fn write_and_sync(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_data()
}

// 主崩溃日志不可写时，将单个事件同步写到时间戳/PID 命名的应急文件，不经过滚动写入器。
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
    // 验证当前构建基础标记名被接受、普通日志名被拒绝；未断言另一构建标记名不匹配。
    fn runtime_marker_names_are_build_specific() {
        let expected = if cfg!(debug_assertions) {
            "runtime-state-dev.json"
        } else {
            "runtime-state.json"
        };
        assert!(is_runtime_marker_name(expected));
        let expected_pid = expected.replace(".json", "-123.json");
        assert!(is_runtime_marker_name(&expected_pid));
        let other_build = if cfg!(debug_assertions) {
            "runtime-state.json"
        } else {
            "runtime-state-dev.json"
        };
        assert!(!is_runtime_marker_name(other_build));
        assert!(!is_runtime_marker_name(
            &expected.replace(".json", "-pid.json")
        ));
        assert!(!is_runtime_marker_name("cli-manager.log"));
    }

    #[test]
    // 验证活动名前缀截断后含标记的长度，以及 60 条轨迹仅保留最新 50 条。
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
    // 用不存在的 PID 标记验证恢复写入未正常退出事件，并移除对应临时标记文件。
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
    // 验证包含赋值语法的原始 JSON 文本和 CLI 参数值会被替换；不覆盖结构化 JSON 键脱敏。
    fn sensitive_values_are_redacted_in_json_and_cli_forms() {
        let input = r#"{"api_key":"my secret","password":'two words'} --token abc123"#;
        let redacted = redact_sensitive(input);

        assert!(!redacted.contains("my secret"));
        assert!(!redacted.contains("two words"));
        assert!(!redacted.contains("abc123"));
        assert_eq!(redacted.matches("<redacted>").count(), 3);
    }

    #[test]
    fn json_object_keys_redact_plain_secret_values() {
        let value = serde_json::json!({
            "password": "plain-value",
            "nested": {"apiKey": "another-value", "label": "safe"},
            "authorizationHeader": 123,
        });
        let redacted = redact_json_value(value);

        assert_eq!(redacted["password"], "<redacted>");
        assert_eq!(redacted["nested"]["apiKey"], "<redacted>");
        assert_eq!(redacted["nested"]["label"], "safe");
        assert_eq!(redacted["authorizationHeader"], "<redacted>");
    }
}
