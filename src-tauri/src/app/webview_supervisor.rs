//! WebView2 进程故障监督。
//!
//! 浏览器进程退出会带走本应用全部 WebView：主窗口只剩背景色，自绘标题栏也随之消失；
//! 而关闭窗口与托盘退出都要经前端 JS 处理，前端一死窗口就既不能用也关不掉，只能被强杀。
//! 这里在 Rust 侧订阅每个窗口的 ProcessFailed：
//! - 浏览器进程退出：整应用重启。终端会话运行在 daemon 中不受影响，重启后可重新接管；
//! - 主框架渲染进程退出：原地重载该窗口，短时间内反复崩溃则升级为整应用重启；
//! - 其余类型（渲染无响应、GPU/工具进程退出等）WebView2 会自行重建或可自愈，只记录。
//! 前端不可用期间，关闭窗口与托盘退出改由 Rust 直接退出，不再等待已经不存在的 JS。

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

use crate::crash_reporter::{self, SystemCommit};

/// 前端正常。
const PHASE_ALIVE: u8 = 0;
/// 前端已不可用，恢复流程进行中（等待提交余量、询问用户或已请求重启）。
const PHASE_RECOVERING: u8 = 1;
/// 已决定退出，恢复线程不得再发起重启。
const PHASE_EXITING: u8 = 2;
static PHASE: AtomicU8 = AtomicU8::new(PHASE_ALIVE);

// 单个窗口在该时间窗内渲染进程崩溃超过上限后不再原地重载，改走整应用重启，避免内存耗尽时空转。
const RENDER_RELOAD_WINDOW: Duration = Duration::from_secs(300);
const RENDER_RELOAD_LIMIT: usize = 3;
// 该时间窗内已自动重启过这么多次时改为询问用户，防止崩溃—重启死循环。
const RESTART_LOOP_WINDOW_SECS: u64 = 600;
const RESTART_LOOP_LIMIT: usize = 2;
const RESTART_HISTORY_KEEP: usize = 10;
// 新进程连同 WebView2 冷启动需要数百 MB 提交；余量不足时重启大概率再次失败。
const RESTART_MIN_AVAILABLE_COMMIT: u64 = 1024 * 1024 * 1024;
// 崩溃进程树的提交需要片刻才会归还系统，先等这么久再判定余量。
const COMMIT_RELEASE_WAIT: Duration = Duration::from_secs(5);
const COMMIT_POLL_INTERVAL: Duration = Duration::from_millis(500);
// 事发时可用提交低于上限的该比例，视为提交耗尽导致。
const LOW_COMMIT_PERCENT: u64 = 5;

static RENDER_RELOADS: OnceLock<Mutex<HashMap<String, Vec<Instant>>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    BrowserExited,
    RenderExited,
    RenderUnresponsive,
    FrameRenderExited,
    GpuExited,
    Other(i32),
}

impl FailureKind {
    fn from_raw(raw: i32) -> Self {
        match raw {
            0 => Self::BrowserExited,
            1 => Self::RenderExited,
            2 => Self::RenderUnresponsive,
            3 => Self::FrameRenderExited,
            6 => Self::GpuExited,
            other => Self::Other(other),
        }
    }

    fn label(self) -> String {
        match self {
            Self::BrowserExited => "browser_process_exited".to_string(),
            Self::RenderExited => "render_process_exited".to_string(),
            Self::RenderUnresponsive => "render_process_unresponsive".to_string(),
            Self::FrameRenderExited => "frame_render_process_exited".to_string(),
            Self::GpuExited => "gpu_process_exited".to_string(),
            Self::Other(raw) => format!("other_{raw}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureAction {
    Restart,
    Reload,
    Observe,
}

// 只有浏览器进程与主框架渲染进程退出会让前端整体失效；其余类型由 WebView2 自行重建。
fn failure_action(kind: FailureKind) -> FailureAction {
    match kind {
        FailureKind::BrowserExited => FailureAction::Restart,
        FailureKind::RenderExited => FailureAction::Reload,
        _ => FailureAction::Observe,
    }
}

fn reason_label(raw: i32) -> &'static str {
    match raw {
        0 => "unexpected",
        1 => "unresponsive",
        2 => "terminated",
        3 => "crashed",
        4 => "launch_failed",
        5 => "out_of_memory",
        6 => "profile_deleted",
        _ => "unknown",
    }
}

#[derive(Debug, Clone)]
struct ProcessFailure {
    kind: FailureKind,
    reason: Option<i32>,
    exit_code: Option<i32>,
    description: Option<String>,
}

/// 前端是否已不可用（WebView 进程退出且尚未恢复）。
pub(crate) fn frontend_unavailable() -> bool {
    PHASE.load(Ordering::Acquire) != PHASE_ALIVE
}

/// 前端不可用时由 Rust 直接退出；daemon 中的终端会话保留，下次启动可重新接管。
pub(crate) fn exit_without_frontend<R: Runtime>(app: &AppHandle<R>, source: &str) {
    PHASE.store(PHASE_EXITING, Ordering::Release);
    log::warn!("webview frontend unavailable; exiting from {source} without frontend");
    app.exit(0);
}

/// 为当前全部 WebView 窗口挂上 ProcessFailed 监听；须在窗口创建之后调用（Tauri 在 setup 前创建配置窗口）。
pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) {
    for window in app.webview_windows().into_values() {
        watch(app, &window);
    }
}

#[cfg(windows)]
fn watch<R: Runtime>(app: &AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_REASON,
    };
    use webview2_com::{take_pwstr, ProcessFailedEventHandler};
    use windows_core::{Interface, PWSTR};

    let app = app.clone();
    let label = window.label().to_string();
    let queued_label = label.clone();
    let queued = window.with_webview(move |platform| {
        let handler_label = queued_label.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            unsafe { args.ProcessFailedKind(&mut kind)? };
            let mut failure = ProcessFailure {
                kind: FailureKind::from_raw(kind.0),
                reason: None,
                exit_code: None,
                description: None,
            };
            // Reason/ExitCode/ProcessDescription 需要 WebView2 Runtime 1.0.1185+，更旧的运行时只有类型。
            if let Ok(args) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                if unsafe { args.Reason(&mut reason) }.is_ok() {
                    failure.reason = Some(reason.0);
                }
                let mut exit_code = 0i32;
                if unsafe { args.ExitCode(&mut exit_code) }.is_ok() {
                    failure.exit_code = Some(exit_code);
                }
                let mut description = PWSTR::null();
                if unsafe { args.ProcessDescription(&mut description) }.is_ok() {
                    failure.description =
                        Some(take_pwstr(description)).filter(|value| !value.is_empty());
                }
            }
            on_process_failed(&app, &handler_label, failure);
            Ok(())
        }));
        let mut token = 0i64;
        let registered = unsafe { platform.controller().CoreWebView2() }
            .and_then(|core| unsafe { core.add_ProcessFailed(&handler, &mut token) });
        match registered {
            Ok(()) => log::debug!("webview supervisor attached: {queued_label}"),
            Err(err) => log::warn!("webview supervisor attach failed for {queued_label}: {err}"),
        }
    });
    if let Err(err) = queued {
        log::warn!("webview supervisor not scheduled for {label}: {err}");
    }
}

#[cfg(not(windows))]
fn watch<R: Runtime>(_app: &AppHandle<R>, _window: &tauri::WebviewWindow<R>) {}

// 运行在 WebView2 回调所在的 UI 线程上：只做记录与分派，耗时的等待放到恢复线程。
fn on_process_failed<R: Runtime>(app: &AppHandle<R>, label: &str, failure: ProcessFailure) {
    let action = failure_action(failure.kind);
    let kind = failure.kind.label();
    let reason = failure.reason.map(reason_label);
    if action == FailureAction::Observe {
        log::warn!(
            "webview process failed (window={label}, kind={kind}, reason={reason:?}, exit_code={:?}, process={:?})",
            failure.exit_code,
            failure.description
        );
    } else {
        log::error!(
            "webview process failed (window={label}, kind={kind}, reason={reason:?}, exit_code={:?}, process={:?})",
            failure.exit_code,
            failure.description
        );
    }
    crash_reporter::report_native_event(
        "webview_process_failed",
        json!({
            "window": label,
            "failureKind": kind,
            "reason": reason,
            "exitCode": failure.exit_code,
            "process": failure.description,
            "action": format!("{action:?}").to_ascii_lowercase(),
        }),
    );
    match action {
        FailureAction::Restart => {
            begin_recovery(app, &kind, failure.reason == Some(5));
        }
        FailureAction::Reload => reload_or_escalate(app, label, &kind, failure.reason == Some(5)),
        FailureAction::Observe => {}
    }
}

fn reload_or_escalate<R: Runtime>(app: &AppHandle<R>, label: &str, kind: &str, oom: bool) {
    if frontend_unavailable() {
        return;
    }
    let allowed = {
        let reloads = RENDER_RELOADS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut reloads = match reloads.lock() {
            Ok(reloads) => reloads,
            Err(poisoned) => poisoned.into_inner(),
        };
        let history = reloads.entry(label.to_string()).or_default();
        admit_reload(history, Instant::now())
    };
    if !allowed {
        log::error!("webview {label} keeps crashing; escalating to app restart");
        begin_recovery(app, kind, oom);
        return;
    }
    match app.get_webview_window(label).map(|window| window.reload()) {
        Some(Ok(())) => log::warn!("webview {label} renderer exited; reloading"),
        Some(Err(err)) => {
            log::error!("webview {label} reload failed: {err}; escalating to app restart");
            begin_recovery(app, kind, oom);
        }
        None => log::warn!("webview {label} renderer exited but the window is gone"),
    }
}

// 记录本次重载并判断是否仍在上限内；过期记录先剔除。
fn admit_reload(history: &mut Vec<Instant>, now: Instant) -> bool {
    history.retain(|at| now.saturating_duration_since(*at) < RENDER_RELOAD_WINDOW);
    if history.len() >= RENDER_RELOAD_LIMIT {
        return false;
    }
    history.push(now);
    true
}

// 多个窗口会为同一次浏览器崩溃各报一次，只有第一个进入恢复流程。
fn begin_recovery<R: Runtime>(app: &AppHandle<R>, kind: &str, oom: bool) {
    if PHASE
        .compare_exchange(
            PHASE_ALIVE,
            PHASE_RECOVERING,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return;
    }
    log::error!("webview frontend lost ({kind}); starting recovery");
    let app = app.clone();
    let kind = kind.to_string();
    let spawned = std::thread::Builder::new()
        .name("webview-recovery".to_string())
        .spawn(move || run_recovery(&app, &kind, oom));
    if let Err(err) = spawned {
        // 恢复线程起不来时仍保持 RECOVERING：关闭窗口与托盘退出会走 Rust 直接退出。
        log::error!("webview recovery thread spawn failed: {err}");
    }
}

fn run_recovery<R: Runtime>(app: &AppHandle<R>, kind: &str, oom: bool) {
    let history_path = recovery_history_path();
    let mut history = history_path
        .as_ref()
        .map(|path| read_history(path))
        .unwrap_or_default();
    let now = epoch_secs();
    let recent = recent_restart_count(&history.restarts, now);
    if recent >= RESTART_LOOP_LIMIT && !prompt(&Prompt::CrashLoop { count: recent }) {
        exit_without_frontend(app, "recovery prompt");
        return;
    }
    let mut commit = wait_for_commit_headroom(COMMIT_RELEASE_WAIT);
    while !has_restart_headroom(commit) {
        if !prompt(&Prompt::LowCommit(commit)) {
            exit_without_frontend(app, "recovery prompt");
            return;
        }
        commit = wait_for_commit_headroom(Duration::ZERO);
    }
    if PHASE.load(Ordering::Acquire) == PHASE_EXITING {
        return;
    }
    let low_commit = oom || commit.is_some_and(is_low_commit);
    history.restarts.push(now);
    let keep_from = history.restarts.len().saturating_sub(RESTART_HISTORY_KEEP);
    history.restarts.drain(..keep_from);
    history.pending_notice = Some(RecoveryNotice {
        failure_kind: kind.to_string(),
        low_commit,
        recovered_at: now,
    });
    if let Some(path) = history_path.as_ref() {
        write_history(path, &history);
    }
    crash_reporter::report_native_event(
        "webview_recovery_restart",
        json!({
            "failureKind": kind,
            "lowCommit": low_commit,
            "recentRestarts": recent,
            "availableCommitBytes": commit.map(|value| value.available_bytes()),
        }),
    );
    log::warn!("restarting app to recover webview frontend ({kind})");
    app.request_restart();
}

// 轮询直到可用提交达到重启门槛或超时；读不到计数器时返回 None，由调用方按“可重启”处理。
fn wait_for_commit_headroom(max_wait: Duration) -> Option<SystemCommit> {
    let deadline = Instant::now() + max_wait;
    loop {
        let commit = crash_reporter::system_commit();
        if has_restart_headroom(commit) || Instant::now() >= deadline {
            return commit;
        }
        std::thread::sleep(COMMIT_POLL_INTERVAL);
    }
}

fn has_restart_headroom(commit: Option<SystemCommit>) -> bool {
    commit.is_none_or(|value| value.available_bytes() >= RESTART_MIN_AVAILABLE_COMMIT)
}

fn is_low_commit(commit: SystemCommit) -> bool {
    commit.limit_bytes > 0
        && commit.available_bytes().saturating_mul(100) < commit.limit_bytes * LOW_COMMIT_PERCENT
}

fn recent_restart_count(restarts: &[u64], now: u64) -> usize {
    restarts
        .iter()
        .filter(|at| now.saturating_sub(**at) < RESTART_LOOP_WINDOW_SECS)
        .count()
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryHistory {
    #[serde(default)]
    restarts: Vec<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_notice: Option<RecoveryNotice>,
}

/// 自动重启后留给新进程前端的一次性提示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNotice {
    failure_kind: String,
    /// 事发时系统提交接近上限或 WebView2 报告内存不足。
    low_commit: bool,
    recovered_at: u64,
}

fn recovery_history_path() -> Option<PathBuf> {
    let file_name = if cfg!(debug_assertions) {
        "webview-recovery-dev.json"
    } else {
        "webview-recovery.json"
    };
    crate::app_paths::logs_dir()
        .ok()
        .map(|dir| dir.join(file_name))
}

// 文件缺失或损坏都视为没有历史：宁可多重启一次，也不因读不到历史而卡在询问。
fn read_history(path: &Path) -> RecoveryHistory {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_history(path: &Path, history: &RecoveryHistory) {
    let result = serde_json::to_vec_pretty(history)
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(path, bytes));
    if let Err(err) = result {
        log::warn!("webview recovery history write failed: {err}");
    }
}

#[tauri::command]
/// 取走上一个进程自动重启时留下的提示，读取即清除；没有时返回空。
pub fn app_take_recovery_notice() -> Option<RecoveryNotice> {
    let path = recovery_history_path()?;
    let mut history = read_history(&path);
    let notice = history.pending_notice.take()?;
    write_history(&path, &history);
    Some(notice)
}

enum Prompt {
    CrashLoop { count: usize },
    LowCommit(Option<SystemCommit>),
}

fn prompt_message(prompt: &Prompt) -> String {
    const MIB: u64 = 1024 * 1024;
    match prompt {
        Prompt::CrashLoop { count } => format!(
            "CLI-Manager 界面进程在 10 分钟内已崩溃并自动重启 {count} 次，常见原因是系统虚拟内存（提交）不足。\n\
             终端会话仍在后台运行，不会丢失。\n\n是否再次重启界面？选择“否”将退出 CLI-Manager 界面。\n\n\
             The CLI-Manager UI crashed {count} times within 10 minutes. Terminal sessions keep running in the background.\n\
             Restart the UI again? Choose No to quit."
        ),
        Prompt::LowCommit(commit) => {
            let (available, limit) = commit
                .map(|value| (value.available_bytes() / MIB, value.limit_bytes / MIB))
                .unwrap_or((0, 0));
            format!(
                "CLI-Manager 界面进程已崩溃，系统虚拟内存（提交）几乎耗尽：可用 {available} MB / 上限 {limit} MB。\n\
                 现在重启很可能再次失败。终端会话仍在后台运行，不会丢失。\n\n\
                 请先关闭占用内存较多的程序，然后点“重试”重启界面；点“取消”退出 CLI-Manager 界面。\n\n\
                 The CLI-Manager UI crashed and system commit memory is nearly exhausted ({available} MB free of {limit} MB).\n\
                 Close memory-heavy programs and click Retry, or Cancel to quit."
            )
        }
    }
}

#[cfg(windows)]
// 原生消息框不依赖 WebView，可在前端已死时与用户交互；返回用户是否同意继续重启。
fn prompt(prompt: &Prompt) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDRETRY, IDYES, MB_ICONWARNING, MB_RETRYCANCEL, MB_SETFOREGROUND, MB_TOPMOST,
        MB_YESNO,
    };

    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let title = wide("CLI-Manager");
    let message = wide(&prompt_message(prompt));
    let (buttons, accept) = match prompt {
        Prompt::CrashLoop { .. } => (MB_YESNO, IDYES),
        Prompt::LowCommit(_) => (MB_RETRYCANCEL, IDRETRY),
    };
    let answer = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            buttons | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST,
        )
    };
    answer == accept
}

#[cfg(not(windows))]
fn prompt(_prompt: &Prompt) -> bool {
    true
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn only_browser_and_main_frame_renderer_exits_need_recovery() {
        assert_eq!(
            failure_action(FailureKind::from_raw(0)),
            FailureAction::Restart
        );
        assert_eq!(
            failure_action(FailureKind::from_raw(1)),
            FailureAction::Reload
        );
        for raw in [2, 3, 4, 5, 6, 7, 8, 9, 42] {
            assert_eq!(
                failure_action(FailureKind::from_raw(raw)),
                FailureAction::Observe
            );
        }
    }

    #[test]
    fn renderer_reloads_are_capped_within_the_window() {
        let start = Instant::now();
        let mut history = Vec::new();
        for _ in 0..RENDER_RELOAD_LIMIT {
            assert!(admit_reload(&mut history, start));
        }
        assert!(!admit_reload(&mut history, start + Duration::from_secs(1)));
        assert!(admit_reload(&mut history, start + RENDER_RELOAD_WINDOW));
    }

    #[test]
    fn restart_loop_only_counts_recent_restarts() {
        let now = 10_000;
        let restarts = [now - RESTART_LOOP_WINDOW_SECS, now - 60, now - 1];
        assert_eq!(recent_restart_count(&restarts, now), 2);
    }

    #[test]
    fn restart_waits_for_commit_headroom_but_not_for_missing_counters() {
        let commit = |committed, limit| {
            Some(SystemCommit {
                committed_bytes: committed,
                limit_bytes: limit,
            })
        };
        assert!(has_restart_headroom(None));
        assert!(has_restart_headroom(commit(60 * GIB, 64 * GIB)));
        assert!(!has_restart_headroom(commit(63 * GIB + GIB / 2, 64 * GIB)));
        assert!(!has_restart_headroom(commit(70 * GIB, 64 * GIB)));
    }

    #[test]
    fn low_commit_is_relative_to_the_limit() {
        let commit = |committed| SystemCommit {
            committed_bytes: committed,
            limit_bytes: 100 * GIB,
        };
        assert!(is_low_commit(commit(96 * GIB)));
        assert!(!is_low_commit(commit(90 * GIB)));
        assert!(!is_low_commit(SystemCommit {
            committed_bytes: 0,
            limit_bytes: 0,
        }));
    }

    #[test]
    fn corrupted_history_is_treated_as_empty() {
        let dir =
            std::env::temp_dir().join(format!("cli-manager-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("webview-recovery.json");
        std::fs::write(&path, b"{not json").unwrap();
        let history = read_history(&path);
        assert!(history.restarts.is_empty());
        assert!(history.pending_notice.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
