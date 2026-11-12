//! 本应用自身（主进程 + WebView2 + PTY daemon）的内存占用统计与一键优化。
//!
//! 口径：优先使用私有工作集（与任务管理器“内存”列一致），取不到时退回工作集。
//! 终端里运行的 shell/CLI 属于用户负载，单独汇总但不计入应用合计，也不会被优化修剪。
//!
//! 孤儿进程：只认“可证明属于本应用、且已没有任何入口能再触达”的进程——
//! 父进程已退出的本应用 WebView2（按 `--user-data-dir` 精确匹配）、helper 子命令与 conpty 宿主，
//! 以及不再登记在发现文件里的旧 daemon（客户端只经发现文件连接，未登记即不可达）。
//! 当前应用进程树与已登记的 daemon 永不纳入；身份信息缺失时对应类别直接跳过，宁可漏判不误杀。

use crate::runtime_diagnostics::{classify_process, current_daemon_pid, ManagedProcessRole};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Manager, Runtime};

// WebView2 收到 Low 目标后需要一点时间丢弃缓存，过早修剪工作集会被随后的回收抵消。
const WEBVIEW_LOW_SETTLE: Duration = Duration::from_millis(1200);
// 修剪后给系统一个短暂窗口更新计数，再读取优化后的占用。
const POST_TRIM_SETTLE: Duration = Duration::from_millis(400);
// 刚启动的进程可能处于发现文件发布、父子交接的中间态，存活不足该时长的一律不判为孤儿。
const ORPHAN_MIN_AGE_SECS: u64 = 60;
// 沿父链向上查找的最大深度，防止异常父子映射导致长循环。
const MAX_ANCESTOR_DEPTH: usize = 64;
const DAEMON_HELPER_NAME: &str = if cfg!(windows) {
    "cli-manager-daemon.exe"
} else {
    "cli-manager-daemon"
};

static PROCESS_SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
static OPTIMIZING: AtomicBool = AtomicBool::new(false);
static WEBVIEW_DATA_DIR: OnceLock<Option<String>> = OnceLock::new();

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMemoryGroup {
    pub bytes: u64,
    pub process_count: usize,
}

impl AppMemoryGroup {
    fn add(&mut self, bytes: u64) {
        self.bytes = self.bytes.saturating_add(bytes);
        self.process_count += 1;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMemoryUsage {
    /// 主进程 + WebView2 + daemon 合计，不含终端子进程与孤儿进程。
    pub total_bytes: u64,
    pub main: AppMemoryGroup,
    pub webview: AppMemoryGroup,
    pub daemon: AppMemoryGroup,
    /// 终端内运行的 shell/CLI 及应用直接拉起的其他子进程，仅展示不计入合计。
    pub terminal: AppMemoryGroup,
    /// 可清理的孤儿进程（含其后代），仅展示不计入合计，优化时一并结束。
    pub orphan: AppMemoryGroup,
    /// 全部进程都取到了私有工作集时为 true；否则部分进程退回了工作集口径。
    pub private_working_set: bool,
    pub sampled_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMemoryOptimizeResult {
    pub before: AppMemoryUsage,
    pub after: AppMemoryUsage,
    /// 应用合计的下降量加上已结束孤儿进程的占用。
    pub freed_bytes: u64,
    /// 成功下发 WebView2 内存目标级别的窗口数；运行时过旧时为 0，但工作集修剪仍会执行。
    pub webview_hint_count: usize,
    pub trimmed_process_count: usize,
    pub orphan_killed_count: usize,
    pub orphan_freed_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemoryGroup {
    Main,
    Webview,
    Daemon,
    Terminal,
    Orphan,
}

impl From<ManagedProcessRole> for MemoryGroup {
    fn from(role: ManagedProcessRole) -> Self {
        match role {
            ManagedProcessRole::AppMain => Self::Main,
            ManagedProcessRole::WebviewChild => Self::Webview,
            ManagedProcessRole::PtyDaemon => Self::Daemon,
            ManagedProcessRole::AppChild | ManagedProcessRole::PtyChild => Self::Terminal,
        }
    }
}

struct TrackedProcess {
    pid: u32,
    group: MemoryGroup,
    fallback_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrphanKind {
    Webview,
    StaleDaemon,
    Helper,
    Console,
}

/// 孤儿判定所需的本应用身份；路径均已归一化（小写、反斜杠、去掉 `\\?\` 与末尾分隔符）。
#[derive(Debug, Default)]
struct OrphanContext {
    app_pid: u32,
    app_exe: Option<String>,
    app_dir: Option<String>,
    daemon_exe: Option<String>,
    /// 当前构建发现文件中登记的 daemon pid；读不到时不判定任何 daemon。
    registered_daemon_pid: Option<u32>,
    webview_data_dir: Option<String>,
}

/// 进程快照的最小视图；exe/cmd 只为名称可疑的候选进程读取。
#[derive(Debug, Clone, Default)]
struct ProcessEntry {
    pid: u32,
    parent: Option<u32>,
    name: String,
    exe: Option<String>,
    cmd: Vec<String>,
    start_time: u64,
}

impl ProcessEntry {
    fn subcommand(&self) -> Option<&str> {
        self.cmd.get(1).map(String::as_str)
    }
}

fn normalize_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"');
    let stripped = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    stripped
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn is_orphan_candidate_name(name: &str) -> bool {
    name.contains("msedgewebview2") || name.contains("cli-manager") || name.contains("openconsole")
}

fn build_orphan_context<R: Runtime>(app: &AppHandle<R>) -> OrphanContext {
    let app_exe_path = std::env::current_exe().ok();
    let app_dir_path = app_exe_path.as_deref().and_then(Path::parent);
    let daemon_exe = app_dir_path
        .map(|dir| dir.join(DAEMON_HELPER_NAME))
        .filter(|path| path.is_file())
        .map(|path| normalize_path(&path.to_string_lossy()));
    let registered_daemon_pid = crate::app_paths::cli_manager_data_dir()
        .ok()
        .map(|dir| crate::daemon::discovery::daemon_info_path(&dir, cfg!(debug_assertions)))
        .and_then(|path| {
            crate::daemon::discovery::read_daemon_info(&path)
                .ok()
                .flatten()
        })
        .map(|info| info.pid);
    // Tauri 在 Windows 上默认把 WebView2 用户数据放在 `<app_local_data_dir>/EBWebView`。
    let webview_data_dir = WEBVIEW_DATA_DIR
        .get_or_init(|| {
            app.path()
                .app_local_data_dir()
                .ok()
                .map(|dir| normalize_path(&dir.join("EBWebView").to_string_lossy()))
        })
        .clone();
    OrphanContext {
        app_pid: std::process::id(),
        app_exe: app_exe_path
            .as_deref()
            .map(|path| normalize_path(&path.to_string_lossy())),
        app_dir: app_dir_path.map(|path| normalize_path(&path.to_string_lossy())),
        daemon_exe,
        registered_daemon_pid,
        webview_data_dir,
    }
}

// 父进程仍存活且早于自身启动才算真父进程；pid 被复用时父进程启动时间会晚于子进程。
fn live_parent<'a>(
    entry: &ProcessEntry,
    by_pid: &'a HashMap<u32, &'a ProcessEntry>,
) -> Option<&'a ProcessEntry> {
    let parent = by_pid.get(&entry.parent?)?;
    (parent.start_time <= entry.start_time).then_some(*parent)
}

fn has_user_data_dir(entry: &ProcessEntry, data_dir: &str) -> bool {
    entry.cmd.iter().any(|arg| {
        arg.strip_prefix("--user-data-dir=")
            .is_some_and(|value| normalize_path(value) == data_dir)
    })
}

// 判断单个进程本身是否是孤儿根；后代由调用方沿父链补齐。
fn orphan_root_kind(
    entry: &ProcessEntry,
    ctx: &OrphanContext,
    parent_alive: bool,
) -> Option<OrphanKind> {
    if entry.pid == ctx.app_pid {
        return None;
    }
    let exe = entry.exe.as_deref();
    let is_app_exe = exe.is_some() && exe == ctx.app_exe.as_deref();
    // daemon 本就设计为在 app 退出后存活，父进程是否存活不能说明问题；只看是否仍登记在发现文件中。
    let is_daemon = (exe.is_some() && exe == ctx.daemon_exe.as_deref())
        || (is_app_exe && entry.subcommand() == Some("__daemon"));
    if is_daemon {
        let registered = ctx.registered_daemon_pid?;
        return (entry.pid != registered).then_some(OrphanKind::StaleDaemon);
    }
    if parent_alive {
        return None;
    }
    if entry.name.contains("msedgewebview2")
        && ctx
            .webview_data_dir
            .as_deref()
            .is_some_and(|dir| has_user_data_dir(entry, dir))
    {
        return Some(OrphanKind::Webview);
    }
    // helper 都以 `__xxx` 子命令启动；不带子命令的同路径进程可能是另一个 GUI 实例，不碰。
    if is_app_exe && entry.subcommand().is_some_and(|arg| arg.starts_with("__")) {
        return Some(OrphanKind::Helper);
    }
    if entry.name.contains("openconsole") {
        if let (Some(exe), Some(dir)) = (exe, ctx.app_dir.as_deref()) {
            if exe.starts_with(&format!("{dir}\\")) {
                return Some(OrphanKind::Console);
            }
        }
    }
    None
}

/// 找出孤儿根及其全部后代。`protected` 为当前应用与登记 daemon 的进程树，永不返回。
fn find_orphans(
    entries: &[ProcessEntry],
    ctx: &OrphanContext,
    protected: &HashSet<u32>,
    now_secs: u64,
) -> Vec<(u32, OrphanKind)> {
    let by_pid = entries
        .iter()
        .map(|entry| (entry.pid, entry))
        .collect::<HashMap<_, _>>();
    let roots = entries
        .iter()
        .filter(|entry| !protected.contains(&entry.pid))
        .filter(|entry| now_secs.saturating_sub(entry.start_time) >= ORPHAN_MIN_AGE_SECS)
        .filter_map(|entry| {
            let parent_alive = live_parent(entry, &by_pid).is_some();
            orphan_root_kind(entry, ctx, parent_alive).map(|kind| (entry.pid, kind))
        })
        .collect::<HashMap<_, _>>();
    if roots.is_empty() {
        return Vec::new();
    }
    entries
        .iter()
        .filter(|entry| !protected.contains(&entry.pid) && entry.pid != ctx.app_pid)
        .filter_map(|entry| {
            let mut current = entry;
            for _ in 0..MAX_ANCESTOR_DEPTH {
                if let Some(kind) = roots.get(&current.pid) {
                    return Some((entry.pid, *kind));
                }
                current = live_parent(current, &by_pid)?;
            }
            None
        })
        .collect()
}

struct ProcessScan {
    tracked: Vec<TrackedProcess>,
}

// 刷新全部进程的父子关系与工作集，筛出本应用、daemon 进程树与孤儿进程；
// 只为名称可疑的候选进程读取路径与命令行，常规轮询开销与之前持平。
fn scan_processes(ctx: &OrphanContext) -> ProcessScan {
    with_process_system(|system| scan_with_system(system, ctx)).unwrap_or(ProcessScan {
        tracked: Vec::new(),
    })
}

fn with_process_system<T>(f: impl FnOnce(&mut System) -> T) -> Option<T> {
    let system = PROCESS_SYSTEM.get_or_init(|| Mutex::new(System::new()));
    let mut system = system.lock().ok()?;
    Some(f(&mut system))
}

fn scan_with_system(system: &mut System, ctx: &OrphanContext) -> ProcessScan {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().without_tasks(),
    );
    let app_pid = ctx.app_pid;
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
    let mut tracked = Vec::new();
    let mut candidates = Vec::new();
    // 应用直接拉起的普通子进程（AppChild）不受保护：握手失败后被替换的旧 daemon 正挂在当前应用下，
    // 它和它的会话进程需要能被识别为孤儿；其余 AppChild 父链存活且不是 daemon，不会命中孤儿规则。
    let mut protected = HashSet::new();
    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy();
        match classify_process(pid.as_u32(), &name, app_pid, daemon_pid, &parents) {
            Some(role) => {
                if role != ManagedProcessRole::AppChild {
                    protected.insert(pid.as_u32());
                } else if is_orphan_candidate_name(&name.to_ascii_lowercase()) {
                    candidates.push(*pid);
                }
                tracked.push(TrackedProcess {
                    pid: pid.as_u32(),
                    group: role.into(),
                    fallback_bytes: process.memory(),
                });
            }
            None if is_orphan_candidate_name(&name.to_ascii_lowercase()) => candidates.push(*pid),
            None => {}
        }
    }
    if candidates.is_empty() {
        return ProcessScan { tracked };
    }
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&candidates),
        false,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .without_tasks(),
    );
    let candidate_set = candidates.iter().copied().collect::<HashSet<_>>();
    let entries = system
        .processes()
        .iter()
        .map(|(pid, process)| {
            let detailed = candidate_set.contains(pid);
            ProcessEntry {
                pid: pid.as_u32(),
                parent: process.parent().map(Pid::as_u32),
                name: process.name().to_string_lossy().to_ascii_lowercase(),
                exe: detailed
                    .then(|| process.exe())
                    .flatten()
                    .map(|path| normalize_path(&path.to_string_lossy())),
                cmd: if detailed {
                    process
                        .cmd()
                        .iter()
                        .map(|arg| arg.to_string_lossy().into_owned())
                        .collect()
                } else {
                    Vec::new()
                },
                start_time: process.start_time(),
            }
        })
        .collect::<Vec<_>>();
    let orphans = find_orphans(&entries, ctx, &protected, epoch_secs())
        .into_iter()
        .map(|(pid, _)| pid)
        .collect::<HashSet<_>>();
    // 已归入终端分组的孤儿后代改记到孤儿分组，避免重复计数。
    tracked.retain(|process| !orphans.contains(&process.pid));
    for pid in orphans {
        let fallback_bytes = system
            .process(Pid::from_u32(pid))
            .map(|process| process.memory())
            .unwrap_or(0);
        tracked.push(TrackedProcess {
            pid,
            group: MemoryGroup::Orphan,
            fallback_bytes,
        });
    }
    ProcessScan { tracked }
}

fn measure(processes: &[TrackedProcess]) -> AppMemoryUsage {
    let mut main = AppMemoryGroup::default();
    let mut webview = AppMemoryGroup::default();
    let mut daemon = AppMemoryGroup::default();
    let mut terminal = AppMemoryGroup::default();
    let mut orphan = AppMemoryGroup::default();
    let mut private_working_set = true;
    for process in processes {
        let bytes = match private_working_set_bytes(process.pid) {
            Some(bytes) => bytes,
            None => {
                private_working_set = false;
                process.fallback_bytes
            }
        };
        match process.group {
            MemoryGroup::Main => main.add(bytes),
            MemoryGroup::Webview => webview.add(bytes),
            MemoryGroup::Daemon => daemon.add(bytes),
            MemoryGroup::Terminal => terminal.add(bytes),
            MemoryGroup::Orphan => orphan.add(bytes),
        }
    }
    AppMemoryUsage {
        total_bytes: main
            .bytes
            .saturating_add(webview.bytes)
            .saturating_add(daemon.bytes),
        main,
        webview,
        daemon,
        terminal,
        orphan,
        private_working_set,
        sampled_at: epoch_millis(),
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

// 只修剪应用自身的进程（主进程、WebView2、daemon），不触碰用户在终端中运行的程序。
fn is_trim_target(group: MemoryGroup) -> bool {
    matches!(
        group,
        MemoryGroup::Main | MemoryGroup::Webview | MemoryGroup::Daemon
    )
}

// 在同一次快照内重新判定并结束孤儿进程，避免拿旧 pid 误杀已被复用的进程。
fn kill_orphans(ctx: &OrphanContext) -> (usize, u64) {
    with_process_system(|system| {
        let scan = scan_with_system(system, ctx);
        let mut killed = 0;
        let mut freed = 0u64;
        for process in scan
            .tracked
            .iter()
            .filter(|process| process.group == MemoryGroup::Orphan)
        {
            let bytes = private_working_set_bytes(process.pid).unwrap_or(process.fallback_bytes);
            let Some(target) = system.process(Pid::from_u32(process.pid)) else {
                continue;
            };
            if target.kill() {
                killed += 1;
                freed = freed.saturating_add(bytes);
            }
        }
        (killed, freed)
    })
    .unwrap_or((0, 0))
}

#[tauri::command]
pub async fn app_memory_get_usage<R: Runtime>(app: AppHandle<R>) -> Result<AppMemoryUsage, String> {
    let ctx = build_orphan_context(&app);
    tokio::task::spawn_blocking(move || measure(&scan_processes(&ctx).tracked))
        .await
        .map_err(|err| format!("app_memory_usage_failed: {err}"))
}

/// 一键优化：先结束孤儿进程，再让 WebView2 降低内存目标并丢弃缓存、修剪应用进程工作集，最后恢复正常级别。
/// 同一时间只允许一次优化；被修剪的页面在再次访问时按需换回，不影响功能。
#[tauri::command]
pub async fn app_memory_optimize<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AppMemoryOptimizeResult, String> {
    if OPTIMIZING.swap(true, Ordering::AcqRel) {
        return Err("app_memory_optimize_busy".to_string());
    }
    let result = optimize(&app).await;
    OPTIMIZING.store(false, Ordering::Release);
    result
}

async fn optimize<R: Runtime>(app: &AppHandle<R>) -> Result<AppMemoryOptimizeResult, String> {
    let ctx = std::sync::Arc::new(build_orphan_context(app));
    let blocking_err = |err: tokio::task::JoinError| format!("app_memory_optimize_failed: {err}");

    let scan_ctx = ctx.clone();
    let before = tokio::task::spawn_blocking(move || measure(&scan_processes(&scan_ctx).tracked))
        .await
        .map_err(blocking_err)?;

    let (orphan_killed_count, orphan_freed_bytes) = if before.orphan.process_count > 0 {
        let kill_ctx = ctx.clone();
        tokio::task::spawn_blocking(move || kill_orphans(&kill_ctx))
            .await
            .map_err(blocking_err)?
    } else {
        (0, 0)
    };

    let webview_hint_count = set_webview_memory_target_blocking(app, true).await;
    if webview_hint_count > 0 {
        tokio::time::sleep(WEBVIEW_LOW_SETTLE).await;
    }
    let trim_ctx = ctx.clone();
    let trimmed_process_count = tokio::task::spawn_blocking(move || {
        scan_processes(&trim_ctx)
            .tracked
            .iter()
            .filter(|process| is_trim_target(process.group))
            .filter(|process| trim_working_set(process.pid))
            .count()
    })
    .await
    .map_err(blocking_err)?;
    // 无论修剪是否成功都恢复 Normal，避免 WebView 长期停留在低内存目标导致交互变慢。
    set_webview_memory_target_blocking(app, false).await;

    tokio::time::sleep(POST_TRIM_SETTLE).await;
    let after_ctx = ctx.clone();
    let after = tokio::task::spawn_blocking(move || measure(&scan_processes(&after_ctx).tracked))
        .await
        .map_err(blocking_err)?;
    log::info!(
        "app memory optimized: before={} after={} webviews={} trimmed={} orphans_killed={} orphan_bytes={}",
        before.total_bytes,
        after.total_bytes,
        webview_hint_count,
        trimmed_process_count,
        orphan_killed_count,
        orphan_freed_bytes
    );
    Ok(AppMemoryOptimizeResult {
        freed_bytes: before
            .total_bytes
            .saturating_sub(after.total_bytes)
            .saturating_add(orphan_freed_bytes),
        before,
        after,
        webview_hint_count,
        trimmed_process_count,
        orphan_killed_count,
        orphan_freed_bytes,
    })
}

// 等待主线程回调属于阻塞操作，放到阻塞线程池里，避免占住异步运行时。
async fn set_webview_memory_target_blocking<R: Runtime>(app: &AppHandle<R>, low: bool) -> usize {
    let app = app.clone();
    tokio::task::spawn_blocking(move || set_webview_memory_target(&app, low))
        .await
        .unwrap_or(0)
}

// 向所有 WebView 窗口下发内存目标级别；返回成功排队的窗口数。实际调用在主线程异步执行。
#[cfg(windows)]
fn set_webview_memory_target<R: Runtime>(app: &AppHandle<R>, low: bool) -> usize {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let applied = Arc::new(AtomicUsize::new(0));
    let (sender, receiver) = std::sync::mpsc::channel::<()>();
    let mut scheduled = 0;
    for window in app.webview_windows().into_values() {
        let applied = Arc::clone(&applied);
        let sender = sender.clone();
        let queued = window.with_webview(move |platform| {
            // ICoreWebView2_19 需要 WebView2 Runtime 114+；更旧的运行时直接跳过。
            let supported = unsafe { platform.controller().CoreWebView2() }
                .and_then(|core| core.cast::<ICoreWebView2_19>())
                .and_then(|core| unsafe { core.SetMemoryUsageTargetLevel(level) });
            if supported.is_ok() {
                applied.fetch_add(1, Ordering::Relaxed);
            }
            let _ = sender.send(());
        });
        if queued.is_ok() {
            scheduled += 1;
        }
    }
    drop(sender);
    // 等主线程执行完已排队的回调，拿到真实成功数；主线程繁忙时最多等一秒。
    for _ in 0..scheduled {
        if receiver.recv_timeout(Duration::from_secs(1)).is_err() {
            break;
        }
    }
    applied.load(Ordering::Relaxed)
}

#[cfg(not(windows))]
fn set_webview_memory_target<R: Runtime>(_app: &AppHandle<R>, _low: bool) -> usize {
    0
}

#[cfg(windows)]
fn private_working_set_bytes(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return None;
        }
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
        let mut counters: PROCESS_MEMORY_COUNTERS_EX2 = std::mem::zeroed();
        counters.cb = size;
        let ok = K32GetProcessMemoryInfo(
            handle,
            &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2 as *mut PROCESS_MEMORY_COUNTERS,
            size,
        );
        CloseHandle(handle);
        // 旧版 Windows 不填充 PrivateWorkingSetSize（保持 0），交给调用方退回工作集口径。
        (ok != 0 && counters.PrivateWorkingSetSize > 0)
            .then_some(counters.PrivateWorkingSetSize as u64)
    }
}

#[cfg(not(windows))]
fn private_working_set_bytes(_pid: u32) -> Option<u64> {
    None
}

#[cfg(windows)]
fn trim_working_set(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::K32EmptyWorkingSet;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    };

    unsafe {
        let handle = OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if handle.is_null() {
            return false;
        }
        let ok = K32EmptyWorkingSet(handle) != 0;
        CloseHandle(handle);
        ok
    }
}

#[cfg(not(windows))]
fn trim_working_set(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 10_000;
    const OLD: u64 = NOW - 3600;

    fn ctx() -> OrphanContext {
        OrphanContext {
            app_pid: 100,
            app_exe: Some(r"f:\program files\cli-manager\cli-manager.exe".to_string()),
            app_dir: Some(r"f:\program files\cli-manager".to_string()),
            daemon_exe: Some(r"f:\program files\cli-manager\cli-manager-daemon.exe".to_string()),
            registered_daemon_pid: Some(200),
            webview_data_dir: Some(
                r"c:\users\u\appdata\local\com.cli-manager.app\ebwebview".to_string(),
            ),
        }
    }

    fn entry(pid: u32, parent: u32, name: &str, exe: Option<&str>, cmd: &[&str]) -> ProcessEntry {
        ProcessEntry {
            pid,
            parent: Some(parent),
            name: name.to_string(),
            exe: exe.map(normalize_path),
            cmd: cmd.iter().map(|arg| arg.to_string()).collect(),
            start_time: OLD,
        }
    }

    fn orphan_pids(entries: &[ProcessEntry], protected: &[u32]) -> Vec<u32> {
        let protected = protected.iter().copied().collect::<HashSet<_>>();
        let mut pids = find_orphans(entries, &ctx(), &protected, NOW)
            .into_iter()
            .map(|(pid, _)| pid)
            .collect::<Vec<_>>();
        pids.sort_unstable();
        pids
    }

    const WEBVIEW_EXE: &str = r"C:\Program Files (x86)\Microsoft\EdgeWebView\msedgewebview2.exe";
    const OUR_DATA_DIR_ARG: &str =
        r"--user-data-dir=C:\Users\u\AppData\Local\com.cli-manager.app\EBWebView";

    #[test]
    fn trim_targets_exclude_user_terminal_processes() {
        assert!(is_trim_target(MemoryGroup::Main));
        assert!(is_trim_target(MemoryGroup::Webview));
        assert!(is_trim_target(MemoryGroup::Daemon));
        assert!(!is_trim_target(MemoryGroup::Terminal));
        assert!(!is_trim_target(MemoryGroup::Orphan));
    }

    #[test]
    fn webview_group_with_dead_parent_is_orphan_including_renderers() {
        let entries = vec![
            entry(
                1,
                999,
                "msedgewebview2.exe",
                Some(WEBVIEW_EXE),
                &["x", OUR_DATA_DIR_ARG],
            ),
            entry(
                2,
                1,
                "msedgewebview2.exe",
                Some(WEBVIEW_EXE),
                &["x", OUR_DATA_DIR_ARG],
            ),
            entry(3, 1, "msedgewebview2.exe", None, &[]),
        ];
        assert_eq!(orphan_pids(&entries, &[]), vec![1, 2, 3]);
    }

    #[test]
    fn live_or_foreign_webviews_are_never_orphans() {
        let entries = vec![
            // 父进程（另一个本应用实例，如 dev 构建）仍存活。
            entry(50, 1, "explorer.exe", None, &[]),
            entry(51, 50, "cli-manager.exe", None, &[]),
            entry(
                52,
                51,
                "msedgewebview2.exe",
                Some(WEBVIEW_EXE),
                &["x", OUR_DATA_DIR_ARG],
            ),
            // 其他应用的 WebView2，数据目录只是前缀相同。
            entry(
                60,
                999,
                "msedgewebview2.exe",
                Some(WEBVIEW_EXE),
                &[
                    "x",
                    r"--user-data-dir=C:\Users\u\AppData\Local\com.cli-manager.app2\EBWebView",
                ],
            ),
        ];
        assert!(orphan_pids(&entries, &[]).is_empty());
    }

    #[test]
    fn reused_parent_pid_counts_as_dead_parent() {
        let mut parent = entry(10, 1, "explorer.exe", None, &[]);
        parent.start_time = NOW - 10;
        let entries = vec![
            parent,
            entry(
                11,
                10,
                "msedgewebview2.exe",
                Some(WEBVIEW_EXE),
                &["x", OUR_DATA_DIR_ARG],
            ),
        ];
        assert_eq!(orphan_pids(&entries, &[]), vec![11]);
    }

    #[test]
    fn only_unregistered_daemons_are_orphans_and_take_their_sessions() {
        let daemon_exe = r"\\?\F:\Program Files\CLI-Manager\cli-manager-daemon.exe";
        let entries = vec![
            // 已登记 daemon：父进程早已退出也是正常状态。
            entry(200, 999, "cli-manager-daemon.exe", Some(daemon_exe), &["d"]),
            entry(201, 200, "pwsh.exe", None, &[]),
            // 未登记的旧 daemon 及其会话进程。
            entry(300, 999, "cli-manager-daemon.exe", Some(daemon_exe), &["d"]),
            entry(301, 300, "openconsole.exe", None, &[]),
            entry(302, 300, "pwsh.exe", None, &[]),
            entry(303, 302, "node.exe", None, &[]),
        ];
        assert_eq!(orphan_pids(&entries, &[200, 201]), vec![300, 301, 302, 303]);
    }

    #[test]
    fn daemons_are_skipped_when_registration_is_unknown() {
        let mut context = ctx();
        context.registered_daemon_pid = None;
        let daemon_exe = r"F:\Program Files\CLI-Manager\cli-manager-daemon.exe";
        let entries = vec![entry(
            300,
            999,
            "cli-manager-daemon.exe",
            Some(daemon_exe),
            &["d"],
        )];
        assert!(find_orphans(&entries, &context, &HashSet::new(), NOW).is_empty());
    }

    #[test]
    fn helpers_need_subcommand_dead_parent_and_minimum_age() {
        let app_exe = r"F:\Program Files\CLI-Manager\cli-manager.exe";
        let mut young = entry(12, 999, "cli-manager.exe", Some(app_exe), &["a", "__hook"]);
        young.start_time = NOW - 5;
        let entries = vec![
            entry(10, 999, "cli-manager.exe", Some(app_exe), &["a", "__hook"]),
            // 同路径但无子命令：可能是另一个 GUI 实例。
            entry(11, 999, "cli-manager.exe", Some(app_exe), &["a"]),
            young,
            entry(
                13,
                999,
                "openconsole.exe",
                Some(r"F:\Program Files\CLI-Manager\resources\conpty\x64\OpenConsole.exe"),
                &[],
            ),
            entry(
                14,
                999,
                "openconsole.exe",
                Some(r"C:\Program Files\WindowsApps\Terminal\OpenConsole.exe"),
                &[],
            ),
            // 当前应用自身永不纳入。
            entry(100, 999, "cli-manager.exe", Some(app_exe), &["a", "__hook"]),
        ];
        assert_eq!(orphan_pids(&entries, &[]), vec![10, 13]);
    }

    #[test]
    fn protected_tree_is_never_returned() {
        let entries = vec![
            entry(
                1,
                999,
                "msedgewebview2.exe",
                Some(WEBVIEW_EXE),
                &["x", OUR_DATA_DIR_ARG],
            ),
            entry(2, 1, "msedgewebview2.exe", None, &[]),
        ];
        assert_eq!(orphan_pids(&entries, &[2]), vec![1]);
    }

    #[cfg(windows)]
    #[test]
    fn reads_private_working_set_and_trims_current_process() {
        let pid = std::process::id();
        let before = private_working_set_bytes(pid).expect("private working set available");
        assert!(before > 0);
        assert!(trim_working_set(pid));
        let after = private_working_set_bytes(pid).expect("private working set available");
        assert!(after <= before);
    }

    #[test]
    fn measure_excludes_terminal_and_orphan_processes_from_total() {
        let tracked = |pid, group, fallback_bytes| TrackedProcess {
            pid,
            group,
            fallback_bytes,
        };
        let processes = vec![
            tracked(u32::MAX, MemoryGroup::Main, 100),
            tracked(u32::MAX - 1, MemoryGroup::Webview, 50),
            tracked(u32::MAX - 2, MemoryGroup::Daemon, 20),
            tracked(u32::MAX - 3, MemoryGroup::Terminal, 999),
            tracked(u32::MAX - 4, MemoryGroup::Orphan, 77),
        ];
        let usage = measure(&processes);
        assert_eq!(usage.total_bytes, 170);
        assert_eq!(usage.terminal.bytes, 999);
        assert_eq!(usage.orphan.bytes, 77);
        assert_eq!(usage.webview.process_count, 1);
        assert!(!usage.private_working_set);
    }
}
