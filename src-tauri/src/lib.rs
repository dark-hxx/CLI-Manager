#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
pub(crate) use app::migrations::{
    migrations, MIGRATION_ADD_CLI_ARGS_DESCRIPTION, MIGRATION_ADD_CLI_ARGS_SQL,
    MIGRATION_ADD_CLI_ARGS_VERSION, MIGRATION_ADD_GROUP_BOUND_PATH_DESCRIPTION,
    MIGRATION_ADD_GROUP_BOUND_PATH_SQL, MIGRATION_ADD_GROUP_BOUND_PATH_VERSION,
    MIGRATION_ADD_PROJECT_PATH_MODE_DESCRIPTION, MIGRATION_ADD_PROJECT_PATH_MODE_SQL,
    MIGRATION_ADD_PROJECT_PATH_MODE_VERSION, MIGRATION_ADD_SSH_ATTACHMENT_ROOT_DESCRIPTION,
    MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL, MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION,
    MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION, MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL,
    MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION, MIGRATION_ADD_WORKTREE_ISOLATION_DESCRIPTION,
    MIGRATION_ADD_WORKTREE_ISOLATION_SQL, MIGRATION_ADD_WORKTREE_ISOLATION_VERSION,
    MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL,
    MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION, MIGRATION_CREATE_REQUEST_LOGS_SQL,
    MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_DESCRIPTION,
    MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_SQL,
    MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_VERSION, MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION,
    MIGRATION_CREATE_SSH_HOSTS_SQL, MIGRATION_CREATE_SSH_HOSTS_VERSION,
    MIGRATION_CREATE_SSH_HOST_GROUPS_DESCRIPTION, MIGRATION_CREATE_SSH_HOST_GROUPS_SQL,
    MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION, MIGRATION_CREATE_USAGE_RECORDS_SQL,
    MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_SQL,
    MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_SQL, MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_SQL,
    MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_WITH_ERROR_DETAIL_SQL,
    NODE_APPEARANCE_MIGRATION_DESCRIPTION, NODE_APPEARANCE_MIGRATION_SQL,
    NODE_APPEARANCE_MIGRATION_VERSION,
};
#[cfg(test)]
pub(crate) use app::migrations::{
    MIGRATION_ADD_NODE_APPEARANCE_VERSION, MIGRATION_ADD_SSH_CONFIG_FILE_SQL,
    MIGRATION_CREATE_HISTORY_GENERATED_TITLES_VERSION, MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_SQL,
    MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_VERSION,
};

#[path = "infrastructure/storage/app_paths.rs"]
pub mod app_paths;
#[path = "features/providers/ccswitch_db.rs"]
mod ccswitch_db;
#[path = "features/hooks/claude.rs"]
mod claude_hook;
#[path = "features/codex-proxy/mod.rs"]
pub mod codex_app_server_proxy;
#[path = "features/statusline/codex.rs"]
pub mod codex_statusline;
mod commands;
#[path = "infrastructure/process/conpty_sideload.rs"]
mod conpty_sideload;
#[path = "infrastructure/diagnostics/crash_reporter.rs"]
mod crash_reporter;
#[path = "infrastructure/storage/credential_store.rs"]
mod credential_store;
// daemon 二进制（src/bin/cli-manager-daemon.rs）经 lib 复用以下模块，
// 因此 app_paths 与 daemon 需 pub。
#[path = "infrastructure/daemon/mod.rs"]
pub mod daemon;
#[path = "infrastructure/files/file_watcher.rs"]
mod file_watcher;
#[path = "features/git/watcher.rs"]
mod git_watcher;
#[path = "features/hooks/client.rs"]
pub mod hook_client;
#[path = "features/hooks/codex_goal.rs"]
mod codex_goal;
#[path = "infrastructure/system/linux_graphics.rs"]
mod linux_graphics;
#[path = "features/files/live_server/mod.rs"]
mod live_server;
#[path = "infrastructure/diagnostics/log_rotation.rs"]
mod log_rotation;
#[path = "infrastructure/process/process_job.rs"]
mod process_job;
#[path = "features/providers/service/mod.rs"]
pub(crate) mod provider;
#[path = "infrastructure/pty/mod.rs"]
pub mod pty;
#[path = "infrastructure/diagnostics/runtime.rs"]
mod runtime_diagnostics;
#[path = "infrastructure/process/shell_resolver.rs"]
mod shell_resolver;
#[path = "infrastructure/ssh/agent_supply_chain.rs"]
mod ssh_agent_supply_chain;
#[path = "infrastructure/ssh/askpass.rs"]
pub mod ssh_askpass;
#[path = "infrastructure/ssh/launch.rs"]
pub mod ssh_launch;
#[path = "infrastructure/ssh/proxy.rs"]
pub mod ssh_proxy;
#[path = "infrastructure/ssh/transport.rs"]
pub mod ssh_transport;
#[path = "features/statusline/mod.rs"]
pub mod statusline;
#[path = "features/statusline/profiles.rs"]
pub mod statusline_profiles;
#[path = "features/sync/service/mod.rs"]
mod sync;
#[path = "shared/text_encoding.rs"]
mod text_encoding;
#[path = "features/notifications/service/mod.rs"]
mod third_party_notification;
#[path = "features/stats/usage.rs"]
pub mod usage;
#[path = "features/stats/usage_schema.rs"]
pub(crate) mod usage_schema;
#[path = "infrastructure/webdav/mod.rs"]
mod webdav;
#[path = "infrastructure/process/wsl.rs"]
mod wsl;

use log::LevelFilter;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};
use tauri_plugin_log::{fern, Builder as LogBuilder, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_sql::Builder as SqlBuilder;

const WEBVIEW_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
const WEBVIEW_DISABLE_GPU_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu";

// 尝试显示、还原并聚焦主窗口，窗口不存在或操作失败时忽略。
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[derive(Default)]
struct PendingBackgroundSession(Mutex<Option<String>>);

// 从相邻命令行参数中提取非空后台会话恢复目标。
fn background_session_arg(args: &[String]) -> Option<String> {
    args.windows(2).find_map(|pair| {
        (pair[0] == "--restore-background-session" && !pair[1].trim().is_empty())
            .then(|| pair[1].clone())
    })
}

// 缓存待恢复后台会话并广播激活请求，锁失败仍尝试发送事件。
fn set_pending_background_session<R: Runtime>(app: &AppHandle<R>, session_id: String) {
    if let Ok(mut pending) = app.state::<PendingBackgroundSession>().0.lock() {
        *pending = Some(session_id.clone());
    }
    let _ = app.emit("background-task-activate-requested", session_id);
}

#[tauri::command]
// 一次性取走缓存的后台会话目标，锁异常时返回空。
fn take_pending_background_session(
    pending: tauri::State<'_, PendingBackgroundSession>,
) -> Option<String> {
    pending.0.lock().ok().and_then(|mut value| value.take())
}

#[tauri::command]
// 通过 IPC 请求唤起主窗口，底层窗口操作失败不向调用方传播。
fn app_show_main_window(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
// 请求 Tauri 以成功退出码结束应用，由退出事件执行相关清理。
fn app_exit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
// 打开主窗口开发者工具，主窗口不存在时返回错误。
fn app_open_devtools(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.open_devtools();
    Ok(())
}

// 初始化守护进程治理与崩溃记录，运行服务后按结果终止当前进程。
pub fn run_daemon_and_exit() -> ! {
    use crate::daemon::discovery::daemon_info_path;
    use crate::daemon::server::{DaemonServer, DaemonServerConfig};

    let _ = simple_stderr_logger::init();
    daemon::setup_process_governance();

    let data_dir = match app_paths::cli_manager_data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("cli-manager-daemon: data dir unavailable: {err}");
            std::process::exit(1);
        }
    };
    if let Err(err) = crash_reporter::initialize(data_dir.join("logs"), "pty-daemon") {
        eprintln!("cli-manager-daemon: crash reporter unavailable: {err}");
    } else if let Err(err) = crash_reporter::start_runtime() {
        eprintln!("cli-manager-daemon: crash runtime marker unavailable: {err}");
    }
    let info_path = daemon_info_path(&data_dir, cfg!(debug_assertions));
    let config = DaemonServerConfig {
        info_path,
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    if let Err(err) = DaemonServer::run(config) {
        eprintln!("cli-manager-daemon: {err}");
        std::process::exit(1);
    }
    crash_reporter::mark_graceful_exit();
    std::process::exit(0);
}

mod simple_stderr_logger {
    use log::{Level, Metadata, Record};

    struct StderrLogger;

    impl log::Log for StderrLogger {
        // 仅允许 Info 及更严重级别进入守护进程标准错误日志。
        fn enabled(&self, metadata: &Metadata) -> bool {
            metadata.level() <= Level::Info
        }
        // 按级别过滤后将原日志参数写入标准错误，不额外脱敏。
        fn log(&self, record: &Record) {
            if self.enabled(record.metadata()) {
                eprintln!("[{}] {}", record.level(), record.args());
            }
        }
        // 实现日志刷新接口；当前标准错误记录器不维护待刷缓存。
        fn flush(&self) {}
    }

    static LOGGER: StderrLogger = StderrLogger;

    // 安装静态标准错误记录器，成功后将全局最高日志级别设为 Info。
    pub fn init() -> Result<(), log::SetLoggerError> {
        log::set_logger(&LOGGER).map(|_| log::set_max_level(log::LevelFilter::Info))
    }
}

// 读取硬件加速禁用偏好，路径、读取或解析失败时使用 false。
fn load_disable_hardware_acceleration_setting() -> bool {
    let settings_path = match app_paths::cli_manager_data_dir() {
        Ok(dir) => dir.join("settings.json"),
        Err(_) => return false,
    };
    let text = match std::fs::read_to_string(settings_path) {
        Ok(text) => text,
        Err(_) => return false,
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("disableHardwareAcceleration")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

// 为所有窗口补入禁用 GPU 参数，保留已有浏览器参数。
fn apply_webview_disable_gpu_config(config: &mut tauri::Config) {
    for window in &mut config.app.windows {
        let browser_args = window
            .additional_browser_args
            .as_deref()
            .unwrap_or(WEBVIEW_DEFAULT_BROWSER_ARGS);
        window.additional_browser_args = Some(if window.additional_browser_args.is_none() {
            WEBVIEW_DISABLE_GPU_ARGS.to_string()
        } else if browser_args.contains("--disable-gpu") {
            browser_args.to_string()
        } else {
            format!("{browser_args} --disable-gpu")
        });
    }
}

#[cfg(target_os = "windows")]
// 用 Windows 消息框显示数据目录初始化错误及中英文提示。
fn show_startup_error(error: &str) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
    };

    let title = std::ffi::OsStr::new("CLI-Manager")
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let message = format!(
        "CLI-Manager 数据目录初始化失败，应用无法继续启动。\n\nData directory initialization failed.\n\n{error}"
    )
    .encode_utf16()
    .chain(Some(0))
    .collect::<Vec<_>>();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

#[cfg(not(target_os = "windows"))]
// 在非 Windows 平台将启动数据目录错误写入标准错误。
fn show_startup_error(error: &str) {
    eprintln!("CLI-Manager data directory initialization failed: {error}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// 准备数据目录并注册插件、状态、IPC 和后台初始化，运行桌面事件循环及退出清理。
pub fn run() {
    if let Err(err) = app_paths::prepare_gui_startup() {
        show_startup_error(&err);
        return;
    }
    let linux_graphics = linux_graphics::initialize(
        app_paths::cli_manager_data_dir()
            .ok()
            .map(|dir| dir.join("settings.json")),
    );
    let debug_logs = cfg!(debug_assertions)
        || matches!(
            std::env::var("CLI_MANAGER_DEBUG")
                .unwrap_or_default()
                .to_lowercase()
                .as_str(),
            "1" | "true" | "yes" | "on"
        );
    let log_level = if debug_logs {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let log_file_name = if cfg!(debug_assertions) {
        "cli-manager-dev.log"
    } else {
        "cli-manager.log"
    };
    let data_db_url = app_paths::db_url().expect("failed to resolve CLI-Manager database path");
    let log_dir = app_paths::logs_dir().expect("failed to resolve CLI-Manager log directory");
    std::fs::create_dir_all(&log_dir).expect("failed to create CLI-Manager log directory");
    if let Err(err) = crash_reporter::initialize(log_dir.clone(), "app") {
        eprintln!("failed to initialize CLI-Manager crash reporter: {err}");
    }
    let mut context = tauri::generate_context!();
    if load_disable_hardware_acceleration_setting() {
        apply_webview_disable_gpu_config(context.config_mut());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if commands::cc_connect::handle_single_instance_args(app, &args) {
                return;
            }
            if let Some(session_id) = background_session_arg(&args) {
                set_pending_background_session(app, session_id);
            }
            show_main_window(app);
        }))
        .plugin({
            let file_log_writer = log_rotation::create_log_writer(log_dir, log_file_name)
                .expect("failed to create CLI-Manager log writer");
            let file_log_target = fern::Dispatch::new()
                .chain(Box::new(file_log_writer) as Box<dyn std::io::Write + Send>);
            let mut targets = vec![Target::new(TargetKind::Dispatch(file_log_target))];
            if debug_logs {
                targets.push(Target::new(TargetKind::Webview));
                targets.push(Target::new(TargetKind::Stdout));
            }
            LogBuilder::new()
                .level(log_level)
                .level_for("h2", LevelFilter::Warn)
                .level_for("hyper", LevelFilter::Warn)
                .level_for("hyper_util", LevelFilter::Warn)
                .level_for("reqwest", LevelFilter::Warn)
                .level_for("sqlx", LevelFilter::Info)
                .level_for("keyring_core", LevelFilter::Warn)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .targets(targets)
                .build()
        })
        .setup(move |app| {
            if let Err(err) = crash_reporter::start_runtime() {
                log::warn!("failed to start CLI-Manager crash runtime marker: {err}");
            }
            let startup_args: Vec<String> = std::env::args().collect();
            if let Some(session_id) = background_session_arg(&startup_args) {
                if let Ok(mut pending) = app.state::<PendingBackgroundSession>().0.lock() {
                    *pending = Some(session_id);
                }
            }
            if let Err(err) = app_paths::migrate_legacy_app_files(app.handle()) {
                log::warn!("CLI-Manager data migration skipped: {err}");
            }
            if let Err(err) = tauri::async_runtime::block_on(provider::initialize()) {
                log::warn!("provider database initialization skipped: {err}");
            } else {
                if let Err(err) = tauri::async_runtime::block_on(
                    provider::network_client::reload_from_persisted(),
                ) {
                    log::warn!("global proxy client initialization skipped: {err}");
                }
                if let Err(err) = tauri::async_runtime::block_on(provider::initialize_cache()) {
                    log::warn!("provider Home cache initialization skipped: {err}");
                }
                if let Err(err) =
                    tauri::async_runtime::block_on(provider::global::recover_pending())
                {
                    log::warn!("provider apply recovery skipped: {err}");
                }
            }
            if let Ok(pets_dir) = app_paths::pets_dir() {
                if let Err(err) = app.asset_protocol_scope().allow_directory(pets_dir, true) {
                    log::warn!("desktop pet asset scope unavailable: {err}");
                }
            }
            conpty_sideload::initialize(app.handle());
            // 保留应用自身调试日志，但压掉 sqlx 的逐条 SQL 输出。
            log::set_max_level(log_level);
            runtime_diagnostics::start(debug_logs);
            // PtyHost 是唯一生产终端路径。后台线程发现/拉起 daemon，成功后写入 bridge；
            // 失败只记日志并让终端创建明确失败，不恢复已删除的进程内 PTY 路径。
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || match app_paths::cli_manager_data_dir() {
                    Ok(data_dir) => {
                        match daemon::client::connect_or_spawn(
                            handle.clone(),
                            &data_dir,
                            cfg!(debug_assertions),
                        ) {
                            Ok(client) => {
                                log::info!(
                                    "pty daemon connected: 127.0.0.1:{}",
                                    client.info().port
                                );
                                if let Err(error) =
                                    commands::routing::reconcile_persisted_service(client.clone())
                                {
                                    log::warn!(
                                        "persisted local routing recovery skipped: {}",
                                        error.code
                                    );
                                }
                                handle.state::<daemon::client::DaemonBridge>().set(client);
                            }
                            Err(err) => log::warn!(
                                "pty daemon unavailable; terminal creation disabled: {err}"
                            ),
                        }
                    }
                    Err(err) => log::warn!("pty daemon skipped (no data dir): {err}"),
                });
            }
            // 注入 appLocalData 目录用于历史索引磁盘缓存（加速冷启动加载）。
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(750));
                    if let Err(err) = commands::cc_connect::auto_start(&handle) {
                        log::warn!("cc-connect auto-start skipped: {err}");
                    }
                });
            }
            if let Ok(dir) = app_paths::history_cache_dir() {
                commands::history::set_history_index_cache_dir(dir);
            }
            log::info!(
                "CLI-Manager started (log_level={}, log_file={})",
                if log_level == LevelFilter::Debug {
                    "debug"
                } else {
                    "info"
                },
                log_file_name
            );
            log::debug!("Linux graphics diagnostics: {:?}", linux_graphics);

            let show_item = MenuItem::with_id(app, "tray_show", "显示", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("missing default window icon")?,
                )
                .tooltip("CLI-Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_show" => {
                        show_main_window(app);
                    }
                    "tray_quit" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("tray-quit-requested", ());
                        } else {
                            app.exit(0);
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        show_main_window(&app);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PendingBackgroundSession::default())
        .manage(daemon::client::DaemonBridge::new())
        .manage(file_watcher::FileWatcherBridge::new())
        .manage(git_watcher::GitWatcherBridge::new())
        .manage(live_server::LiveServerManager::new())
        .manage(commands::subagent_transcript::SubagentTranscriptBridge::new())
        .manage(commands::cc_connect::CcConnectManager::new())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            SqlBuilder::default()
                .add_migrations(&data_db_url, migrations())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::agent_capabilities::agent_capabilities_inspect,
            commands::agent_capabilities::agent_capabilities_probe,
            commands::opencode_hook::opencode_hook_status,
            commands::opencode_hook::opencode_hook_install,
            commands::opencode_hook::opencode_hook_uninstall,
            commands::terminal::pty_prepare_create,
            commands::terminal::pty_reconcile_active_sessions,
            commands::terminal::pty_status,
            commands::terminal::pty_daemon_active,
            commands::terminal::pty_daemon_shutdown_if_idle,
            commands::terminal::pty_host_get_endpoint,
            commands::terminal::pty_legacy_request,
            commands::terminal::pty_daemon_upgrade_if_idle,
            commands::terminal::pty_daemon_sessions,
            commands::app_data::app_get_data_storage_status,
            commands::app_data::app_inspect_data_dir,
            commands::app_data::app_prepare_data_dir_switch,
            commands::cc_connect::cc_connect_get_status,
            commands::cc_connect::cc_connect_inspect_executable,
            commands::cc_connect::cc_connect_check_update,
            commands::cc_connect::cc_connect_update,
            commands::cc_connect::cc_connect_save_profile,
            commands::cc_connect::cc_connect_clear_credentials,
            commands::cc_connect::cc_connect_weixin_authorization_start,
            commands::cc_connect::cc_connect_weixin_authorization_status,
            commands::cc_connect::cc_connect_weixin_authorization_cancel,
            commands::cc_connect::cc_connect_start,
            commands::cc_connect::cc_connect_stop,
            commands::cc_connect::cc_connect_restart,
            commands::cc_connect::cc_connect_get_logs,
            commands::cc_connect::handoff::cc_connect_handoff_status,
            commands::cc_connect::handoff::cc_connect_handoff_platforms,
            commands::cc_connect::handoff::cc_connect_handoff_preflight,
            commands::cc_connect::handoff::cc_connect_handoff_start,
            commands::cc_connect::handoff::cc_connect_handoff_cancel,
            commands::cc_connect::handoff_notification::cc_connect_handoff_notification_status,
            take_pending_background_session,
            commands::desktop_pet::desktop_pet_catalog,
            commands::desktop_pet::desktop_pet_list_installed,
            commands::desktop_pet::desktop_pet_get_installed,
            commands::desktop_pet::desktop_pet_install,
            commands::desktop_pet::desktop_pet_import,
            commands::desktop_pet::desktop_pet_uninstall,
            commands::desktop_pet::desktop_pet_window_sync,
            commands::desktop_pet::desktop_pet_window_set_bounds,
            commands::desktop_pet::desktop_pet_window_hide,
            commands::desktop_pet::desktop_pet_window_reset_position,
            commands::terminal_shell::terminal_shell_scan,
            commands::terminal_shell::terminal_shell_icon,
            commands::ssh::ssh_client_status,
            commands::ssh::ssh_resolve_user,
            commands::ssh::ssh_test_connection,
            commands::ssh::ssh_agent_probe,
            commands::ssh::ssh_agent_available_release,
            commands::ssh::ssh_agent_install_preview,
            commands::ssh::ssh_agent_install,
            commands::ssh::ssh_agent_rollback,
            commands::ssh::ssh_agent_uninstall,
            commands::ssh::ssh_agent_hook_inspect,
            commands::ssh::ssh_agent_hook_preview,
            commands::ssh::ssh_agent_hook_apply,
            commands::ssh_integration::ssh_agent_record_hook_report,
            commands::ssh_integration::ssh_agent_save_host_preferences,
            commands::ssh::ssh_save_password,
            commands::ssh::ssh_password_status,
            commands::ssh::ssh_delete_password,
            commands::ssh_db::ssh_db_ensure_group_schema,
            commands::ssh_db::ssh_db_import_config_hosts,
            commands::ssh_db::ssh_db_delete_host,
            commands::ssh_db::ssh_db_delete_group,
            commands::ssh_db::ssh_db_save_host_preferences,
            commands::ssh_db::ssh_db_record_hook_report,
            commands::ssh_db::ssh_db_record_history_source,
            commands::ssh::ssh_check_path,
            commands::ssh::ssh_list_directories,
            commands::ssh_config::ssh_config_default_directory,
            commands::ssh_config::ssh_config_import_preview,
            commands::third_party_notification::third_party_notification_test_send,
            commands::logging::set_debug_logging,
            commands::logging::resource_diagnostics_write,
            commands::live_server::live_server_start,
            commands::live_server::live_server_status,
            commands::live_server::live_server_stop,
            commands::fs::clipboard_read_file_paths,
            commands::fs::clipboard_attach_image_files,
            commands::fs::check_paths_exist,
            commands::fs::file_get_path_kind,
            commands::fs::file_watch_start,
            commands::fs::file_watch_stop,
            commands::fs::file_list_dir,
            commands::fs::file_search,
            commands::fs::file_search_content,
            commands::fs::file_read_text,
            commands::fs::file_read_project_text,
            commands::fs::file_read_image,
            commands::fs::file_write_text,
            commands::fs::file_write_project_text,
            commands::fs::file_create_file,
            commands::fs::file_create_dir,
            commands::fs::file_rename,
            commands::fs::file_delete,
            commands::fs::file_copy,
            commands::fs::file_attach_data,
            commands::fs::file_cleanup_expired_attachments,
            commands::fs::file_move,
            commands::shell::open_windows_terminal,
            commands::shell::open_folder_in_explorer,
            commands::history::history_list_sessions,
            commands::history::history_get_session,
            commands::history::history_convert_session,
            commands::history::history_delete_session,
            commands::history_edit::history_update_message,
            commands::history_edit::history_delete_message,
            commands::history_edit::history_delete_messages,
            commands::history_edit::history_insert_message,
            commands::history_edit::history_reinsert_message,
            commands::history_edit::history_restore_session_backup,
            commands::history_edit::history_get_backup_status,
            commands::history_backup::history_backup_get_root_status,
            commands::history_backup::history_backup_cleanup,
            commands::history_backup::history_backup_list_restore_candidates,
            commands::history_backup::history_backup_build_restore_plan,
            commands::history_backup::history_backup_execute_restore,
            commands::history_backup::history_backup_preflight_file,
            commands::history_backup::history_backup_export_manifest,
            commands::history::history_search,
            commands::history::history_get_index_status,
            commands::history::history_get_index_v2_status,
            commands::history::history_index_v2_preview_adapter_sessions,
            commands::history::history_index_v2_upsert_source_instance,
            commands::history::history_index_v2_deactivate_source_instance,
            commands::history::history_remote_sync,
            commands::history::history_remote_list_cached,
            commands::history::history_remote_search,
            commands::history::history_remote_get_session,
            commands::history::history_remote_resume_preflight,
            commands::history::history_remote_close,
            commands::ssh_files::ssh_remote_file_list,
            commands::ssh_files::ssh_remote_file_read,
            commands::ssh_files::ssh_remote_file_search,
            commands::ssh_files::ssh_remote_file_attach_data,
            commands::ssh_files::ssh_remote_file_attach_path,
            commands::ssh_files::ssh_remote_file_put_path,
            commands::ssh_files::ssh_remote_file_download,
            commands::ssh_files::ssh_remote_file_delete,
            commands::ssh_files::ssh_remote_file_attachment_root,
            commands::ssh_git::ssh_remote_git_request,
            commands::history::history_get_conversion_matrix,
            commands::history::history_refresh_index,
            commands::history::history_list_prompts,
            commands::history::history_list_stats_projects,
            commands::history::history_get_stats,
            commands::history_title::history_title_list_providers,
            commands::history_title::history_title_generate,
            commands::history_title::history_title_clear,
            commands::history_title::history_title_cancel,
            commands::history::request_logs::history_sync_request_logs,
            commands::history::request_logs::history_list_request_logs,
            commands::history::request_logs::history_get_request_log_stats,
            commands::history_sources::history_sources_list_descriptors,
            commands::history_sources::history_sources_detect,
            commands::history_sources::history_sources_validate,
            commands::sync::sync_get_default_device_name,
            commands::sync::sync_list_device_snapshots,
            commands::sync::sync_test_connection,
            commands::sync::sync_upload,
            commands::sync::sync_download,
            commands::sync::sync_local_export,
            commands::sync::sync_local_import,
            commands::sync::backup_upload,
            commands::sync::backup_list,
            commands::sync::backup_download,
            commands::sync::backup_delete,
            commands::sync::backup_import_legacy_cloud,
            commands::sync::backup_local_export,
            commands::sync::backup_local_import,
            commands::sync::backup_outbox_save,
            commands::sync::backup_outbox_list,
            commands::sync::backup_outbox_remove,
            commands::sync::backup_restore_safety_save,
            commands::sync::backup_restore_safety_load,
            commands::sync::backup_restore_safety_clear,
            commands::sync::backup_restore_database,
            commands::sync::sync_save_password,
            commands::sync::sync_load_password,
            commands::sync::sync_delete_password,
            commands::system_resources::system_resources_get_snapshot,
            commands::version::get_app_version,
            commands::version::get_os_platform,
            linux_graphics::app_get_graphics_diagnostics,
            app_open_devtools,
            app_paths::app_get_data_paths,
            commands::db_repair::db_repair_known_migration_drift,
            commands::db_repair::db_backfill_request_log_project_paths,
            commands::project_groups::project_group_save_binding,
            commands::project_groups::project_group_delete,
            commands::fonts::list_system_fonts,
            commands::background::save_background_image,
            commands::background::cleanup_unused_backgrounds,
            commands::background::background_image_exists,
            commands::hook_settings::hook_settings_get_status,
            commands::hook_settings::hook_settings_install,
            commands::hook_settings::hook_settings_uninstall,
            commands::hook_settings::hook_settings_install_codex,
            commands::hook_settings::hook_settings_uninstall_codex,
            commands::hook_settings::hook_settings_install_kimi,
            commands::hook_settings::hook_settings_uninstall_kimi,
            commands::hook_settings::hook_settings_install_pi,
            commands::hook_settings::hook_settings_uninstall_pi,
            commands::hook_settings::hook_settings_install_grok,
            commands::hook_settings::hook_settings_uninstall_grok,
            commands::hook_settings::hook_settings_select_dir,
            commands::ccusage::ccusage_get_status,
            commands::ccusage::ccusage_install_tools,
            commands::ccusage::ccusage_refresh_report,
            commands::provider::provider_catalog_list,
            commands::provider::provider_catalog_get,
            commands::provider::provider_fetch_models,
            commands::provider::provider_catalog_create,
            commands::provider::provider_catalog_update,
            commands::provider::provider_document_update,
            commands::provider::provider_catalog_duplicate,
            commands::provider::provider_catalog_delete,
            commands::provider::provider_catalog_set_enabled,
            commands::provider::provider_catalog_reorder,
            commands::provider::provider_key_list,
            commands::provider::provider_key_create,
            commands::provider::provider_key_update,
            commands::provider::provider_key_delete,
            commands::provider::provider_key_set_enabled,
            commands::provider::provider_key_activate,
            commands::provider::provider_key_reorder,
            commands::provider::provider_key_reveal,
            commands::provider::provider_common_config_get,
            commands::provider::provider_common_config_set,
            commands::provider::provider_common_config_validate,
            commands::provider::provider_home_get,
            commands::provider::provider_home_active_get,
            commands::provider::provider_home_cached_get,
            commands::provider::provider_wsl_list_distros,
            commands::provider::provider_home_preview,
            commands::provider::provider_home_select,
            commands::provider::provider_home_reset,
            commands::provider::provider_global_preview,
            commands::provider::provider_global_current,
            commands::provider::provider_global_apply,
            commands::provider::provider_environment_inspect,
            commands::provider::provider_environment_open_target,
            commands::provider::provider_global_repair,
            commands::provider::provider_scope_resolve,
            commands::provider::provider_scope_prepare,
            commands::provider::provider_scope_release_snapshot,
            commands::provider::provider_scope_gc_snapshots,
            commands::provider::provider_import_preview,
            commands::provider::provider_import_commit,
            commands::provider::provider_import_issues,
            commands::provider::provider_import_resolve_issue,
            commands::routing::routing_get_state,
            commands::routing::routing_get_failover_queue,
            commands::routing::routing_set_service_enabled,
            commands::routing::routing_set_preferred_port,
            commands::routing::routing_set_failover_enabled,
            commands::routing::routing_set_failover_queue,
            commands::routing::routing_update_failover_config,
            commands::routing::routing_get_global_proxy,
            commands::routing::routing_set_global_proxy,
            commands::routing::routing_scan_global_proxy,
            commands::routing::routing_test_global_proxy,
            commands::routing::routing_get_rectifier_config,
            commands::routing::routing_set_rectifier_config,
            commands::routing::routing_get_optimizer_config,
            commands::routing::routing_set_optimizer_config,
            commands::routing::routing_reset_circuit,
            commands::routing::routing_set_quick_controls,
            commands::routing::routing_set_takeover,
            commands::command_suggestion::command_suggestion_test_model,
            commands::command_suggestion::command_suggestion_generate,
            commands::command_suggestion::command_suggestion_list_path_entries,
            commands::command_suggestion::command_suggestion_resolve_directory,
            commands::git::get_current_git_branch,
            commands::git::git_get_changes,
            commands::git::git_list_repositories,
            commands::git::git_get_file_diff,
            commands::git_history::git_list_commits,
            commands::git_history::git_get_commit_detail,
            commands::git_history::git_get_commit_file_diff,
            commands::git::git_fork_worktree_snapshot,
            commands::git::git_get_worktree_snapshot,
            commands::git::git_restore_worktree_snapshot,
            commands::git::git_discard_file,
            commands::git::git_delete_untracked_paths,
            commands::git::git_revert_hunk,
            commands::git::git_revert_lines,
            commands::git::git_stage_file,
            commands::git::git_unstage_file,
            commands::git::git_stage_all,
            commands::git::git_unstage_all,
            commands::git::git_stage_paths,
            commands::git::git_unstage_paths,
            commands::git::git_commit,
            commands::git::git_commit_paths,
            commands::git::git_branch_status,
            commands::git::git_list_branches,
            commands::git::git_fetch,
            commands::git::git_checkout_branch,
            commands::git::git_smart_checkout_branch,
            commands::git::git_create_branch,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_pull_abort,
            commands::git::git_rebase_continue,
            commands::git::git_operation_continue,
            commands::git::git_operation_abort,
            commands::git::git_compare_refs,
            commands::git::git_execute_operation,
            commands::git_tools::git_list_tags,
            commands::git_tools::git_get_commit_patch,
            commands::git_tools::git_save_generated_patch,
            commands::git_tools::git_list_stashes,
            commands::git_tools::git_stash_create,
            commands::git_tools::git_stash_action,
            commands::git_tools::git_list_remotes,
            commands::git_tools::git_remote_action,
            commands::git_tools::git_push_tag,
            commands::git_tools::git_delete_remote_branch,
            commands::git_tools::git_force_push_with_lease,
            commands::git_tools::git_list_reflog,
            commands::git_tools::git_restore_reflog,
            commands::git_tools::git_file_history,
            commands::git_tools::git_blame_file,
            commands::git_tools::git_bisect_status,
            commands::git_tools::git_bisect_action,
            commands::git_tools::git_list_submodules,
            commands::git_tools::git_submodule_action,
            commands::git_tools::git_rewrite_commits,
            commands::git::git_watch_start,
            commands::git::git_watch_stop,
            commands::git_worktree::git_worktree_validate,
            commands::git_worktree::git_worktree_create,
            commands::git_worktree::git_worktree_check_deps,
            commands::git_worktree::git_worktree_merge,
            commands::git_worktree::git_worktree_remove,
            commands::subagent_transcript::subagent_transcript_subscribe,
            commands::subagent_transcript::subagent_transcript_unsubscribe,
            commands::subagent_transcript::subagent_transcript_discover,
            commands::subagent_transcript::codex_subagent_transcript_discover,
            commands::model_pricing::model_prices_set_cache,
            commands::model_pricing::model_prices_sync,
            commands::system_notification::is_wsl,
            commands::system_notification::send_notification_via_windows,
            commands::system_notification::validate_system_notification_sound,
            commands::system_notification::play_system_notification_sound,
            commands::system_notification::send_interactive_system_notification,
            commands::system_notification::set_taskbar_attention,
            statusline::statusline_get_status,
            statusline::statusline_load_settings,
            statusline::statusline_save_settings,
            statusline::statusline_import_legacy,
            statusline::statusline_render_preview,
            statusline::statusline_install,
            statusline::statusline_uninstall,
            statusline::statusline_get_catalog,
            statusline::statusline_powerline_font_status,
            statusline::statusline_powerline_install_fonts,
            codex_statusline::codex_statusline_load,
            codex_statusline::codex_statusline_save,
            statusline_profiles::statusline_profiles_load,
            statusline_profiles::statusline_backup_export,
            statusline_profiles::statusline_backup_restore,
            statusline_profiles::statusline_profiles_create,
            statusline_profiles::statusline_profiles_save,
            statusline_profiles::statusline_profiles_switch,
            statusline_profiles::statusline_profiles_rename,
            statusline_profiles::statusline_profiles_duplicate,
            statusline_profiles::statusline_profiles_delete,
            statusline_profiles::statusline_profiles_capture_external,
            statusline_profiles::statusline_profiles_export,
            statusline_profiles::statusline_profiles_analyze_import,
            statusline_profiles::statusline_profiles_commit_import,
            crash_reporter::crash_context_update,
            crash_reporter::frontend_crash_report,
            app_show_main_window,
            app_exit,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = &event {
                app.state::<live_server::LiveServerManager>().shutdown();
                app.state::<commands::cc_connect::CcConnectManager>()
                    .shutdown();
                crash_reporter::mark_graceful_exit();
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    show_main_window(app);
                }
            }

            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod ssh_migration_tests {
    use super::{
        MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL, MIGRATION_ADD_SSH_CONFIG_FILE_SQL,
        MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_SQL, MIGRATION_CREATE_SSH_HOSTS_SQL,
        MIGRATION_CREATE_SSH_HOST_GROUPS_SQL,
    };
    use sqlx::{Connection, Row, SqliteConnection};

    #[tokio::test]
    // 在内存数据库验证 SSH 主机迁移的本地默认值及删除主机后的外键置空。
    async fn ssh_host_migration_preserves_local_defaults_and_foreign_keys() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL
            )",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        sqlx::raw_sql(MIGRATION_CREATE_SSH_HOSTS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        sqlx::query("INSERT INTO projects (id, name, path) VALUES ('local', 'Local', 'D:/repo')")
            .execute(&mut conn)
            .await
            .unwrap();
        let local = sqlx::query(
            "SELECT environment_type, ssh_host_id, remote_path FROM projects WHERE id = 'local'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(local.get::<String, _>("environment_type"), "local");
        assert_eq!(local.get::<Option<String>, _>("ssh_host_id"), None);
        assert_eq!(local.get::<String, _>("remote_path"), "");

        sqlx::query(
            "INSERT INTO ssh_hosts (id, name, host, created_at, updated_at)
             VALUES ('host-1', 'Server', 'example.com', '1', '1')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO projects (
                id, name, path, environment_type, ssh_host_id, remote_path
             ) VALUES ('remote', 'Remote', '', 'ssh', 'host-1', '/srv/app')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("DELETE FROM ssh_hosts WHERE id = 'host-1'")
            .execute(&mut conn)
            .await
            .unwrap();
        let remote = sqlx::query("SELECT ssh_host_id FROM projects WHERE id = 'remote'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(remote.get::<Option<String>, _>("ssh_host_id"), None);
    }

    #[tokio::test]
    // 在内存数据库验证旧平面主机分组迁移为根分组并关联原主机。
    async fn ssh_group_migration_preserves_flat_groups_as_roots() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_SSH_HOSTS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO ssh_hosts (id, name, group_name, host, created_at, updated_at) VALUES ('host-1', 'Server', 'Production', 'example.com', '1', '1')")
            .execute(&mut conn).await.unwrap();

        sqlx::raw_sql(MIGRATION_CREATE_SSH_HOST_GROUPS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        let host = sqlx::query("SELECT group_id FROM ssh_hosts WHERE id = 'host-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let group_id = host.get::<Option<String>, _>("group_id").unwrap();
        let group = sqlx::query("SELECT name, parent_id FROM ssh_host_groups WHERE id = ?")
            .bind(group_id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(group.get::<String, _>("name"), "Production");
        assert_eq!(group.get::<Option<String>, _>("parent_id"), None);
    }

    #[tokio::test]
    // 在内存数据库验证删除主机保留集成身份元数据，同时级联删除偏好。
    async fn ssh_agent_integration_migration_preserves_rebind_metadata() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_SSH_HOSTS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        sqlx::query("INSERT INTO projects (id, name, path) VALUES ('local', 'Local', 'D:/repo')")
            .execute(&mut conn)
            .await
            .unwrap();
        let local = sqlx::query("SELECT cli_config_root FROM projects WHERE id = 'local'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(local.get::<String, _>("cli_config_root"), "");

        sqlx::query(
            "INSERT INTO ssh_hosts (id, name, host, created_at, updated_at)
             VALUES ('host-1', 'Server', 'example.com', '1', '1')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ssh_agent_tool_integrations (
                integration_id, host_id, installation_id, remote_machine_id,
                ssh_user, source, scope_kind, configured_root, config_root_hash
             ) VALUES (
                'integration-1', 'host-1', 'install-1', 'machine-1',
                'dev', 'claude', 'hostPrimary', '/home/dev/.claude', 'root-hash'
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ssh_host_tool_preferences (host_id, source, configured_root, updated_at)
             VALUES ('host-1', 'claude', '/home/dev/.claude', '1')",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        sqlx::query("DELETE FROM ssh_hosts WHERE id = 'host-1'")
            .execute(&mut conn)
            .await
            .unwrap();
        let integration = sqlx::query(
            "SELECT host_id, installation_id, remote_machine_id, configured_root
             FROM ssh_agent_tool_integrations WHERE integration_id = 'integration-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(integration.get::<Option<String>, _>("host_id"), None);
        assert_eq!(integration.get::<String, _>("installation_id"), "install-1");
        assert_eq!(
            integration.get::<String, _>("remote_machine_id"),
            "machine-1"
        );
        assert_eq!(
            integration.get::<String, _>("configured_root"),
            "/home/dev/.claude"
        );
        let preference_count =
            sqlx::query("SELECT COUNT(*) AS count FROM ssh_host_tool_preferences")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(preference_count.get::<i64, _>("count"), 0);
    }

    #[tokio::test]
    // 在内存数据库验证新增 SSH 配置文件列为空串，表示沿用系统配置。
    async fn ssh_config_file_migration_defaults_existing_hosts_to_system_config() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_SSH_HOSTS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO ssh_hosts (id, name, config_alias, created_at, updated_at)
             VALUES ('host-1', 'Server', 'prod', '1', '1')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION_ADD_SSH_CONFIG_FILE_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        let row = sqlx::query("SELECT config_file FROM ssh_hosts WHERE id = 'host-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("config_file"), "");
    }

    #[tokio::test]
    // 在内存数据库验证附件根默认空串且可写入自定义值，不访问远程缓存。
    async fn ssh_attachment_root_migration_defaults_existing_hosts_to_agent_cache() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_SSH_HOSTS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO ssh_hosts (id, name, host, created_at, updated_at)
             VALUES ('host-1', 'Server', 'example.com', '1', '1')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        let row = sqlx::query("SELECT attachment_root FROM ssh_hosts WHERE id = 'host-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("attachment_root"), "");

        sqlx::query("UPDATE ssh_hosts SET attachment_root = '~/attachments' WHERE id = 'host-1'")
            .execute(&mut conn)
            .await
            .unwrap();
        let row = sqlx::query("SELECT attachment_root FROM ssh_hosts WHERE id = 'host-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("attachment_root"), "~/attachments");
    }
}

#[cfg(test)]
mod provider_migration_tests {
    use super::migrations;
    use crate::provider::{
        MIGRATION_CREATE_NATIVE_PROVIDERS_VERSION, MIGRATION_LEGACY_PROVIDERS_VERSION,
    };
    use crate::{
        MIGRATION_ADD_GROUP_BOUND_PATH_VERSION, MIGRATION_ADD_NODE_APPEARANCE_VERSION,
        MIGRATION_ADD_PROJECT_PATH_MODE_VERSION, MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION,
        MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION,
        MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION,
        MIGRATION_CREATE_HISTORY_GENERATED_TITLES_VERSION,
        MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_VERSION,
    };

    #[test]
    // 验证旧供应商迁移与原生供应商迁移仍登记且版本顺序正确。
    fn registry_keeps_legacy_v25_before_native_v26() {
        let registry = migrations();
        let legacy = registry
            .iter()
            .find(|migration| migration.version == MIGRATION_LEGACY_PROVIDERS_VERSION)
            .expect("legacy provider migration must remain registered");
        let native = registry
            .iter()
            .find(|migration| migration.version == MIGRATION_CREATE_NATIVE_PROVIDERS_VERSION)
            .expect("native provider migration must be registered");
        assert_eq!(legacy.description, "create_providers_and_keys_tables");
        assert_eq!(native.description, "create_native_provider_management");
        assert!(legacy.version < native.version);
    }

    #[test]
    // 验证新增标题、用量路径、错误详情和项目设置迁移的版本、SQL 标记及顺序。
    fn history_generated_titles_and_request_project_path_migrations_are_additive() {
        let registry = migrations();
        let title_migrations: Vec<_> = registry
            .iter()
            .filter(|migration| {
                migration.version == MIGRATION_CREATE_HISTORY_GENERATED_TITLES_VERSION
            })
            .collect();
        assert_eq!(title_migrations.len(), 1);
        let title_migration = title_migrations[0];
        assert_eq!(title_migration.version, 30);
        assert!(title_migration
            .sql
            .contains("CREATE TABLE IF NOT EXISTS history_generated_titles"));
        assert!(title_migration
            .sql
            .contains("idx_history_generated_titles_state"));
        let project_path_migration = registry
            .iter()
            .find(|migration| {
                migration.version == MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_VERSION
            })
            .expect("request project path migration must be registered");
        assert_eq!(project_path_migration.version, 31);
        assert!(project_path_migration
            .sql
            .contains("COALESCE(u.project_path, '') AS project_path"));
        assert!(project_path_migration
            .sql
            .contains("idx_usage_records_project_path"));
        let project_path_backfill = registry
            .iter()
            .find(|migration| {
                migration.version == MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION
            })
            .expect("request project path backfill must be registered");
        assert_eq!(project_path_backfill.version, 32);
        assert!(project_path_backfill
            .sql
            .contains("UPDATE usage_records AS target"));
        assert!(project_path_backfill
            .sql
            .contains("SELECT session.project_path"));
        let error_detail_migration = registry
            .iter()
            .find(|migration| migration.version == MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
            .expect("route usage error detail migration must be registered");
        assert_eq!(error_detail_migration.version, 33);
        assert!(error_detail_migration
            .sql
            .contains("ALTER TABLE usage_records ADD COLUMN error_detail TEXT"));
        assert!(error_detail_migration.sql.contains("u.error_code"));
        assert!(error_detail_migration.sql.contains("u.error_detail"));
        let node_appearance_migration = registry
            .iter()
            .find(|migration| migration.version == MIGRATION_ADD_NODE_APPEARANCE_VERSION)
            .expect("node appearance migration must be registered");
        assert_eq!(node_appearance_migration.version, 34);
        assert!(node_appearance_migration
            .sql
            .contains("ALTER TABLE groups ADD COLUMN icon TEXT"));
        assert!(node_appearance_migration
            .sql
            .contains("ALTER TABLE projects ADD COLUMN color TEXT"));
        assert!(title_migration.version < project_path_migration.version);
        assert!(project_path_migration.version < project_path_backfill.version);
        assert!(project_path_backfill.version < error_detail_migration.version);
        assert!(error_detail_migration.version < node_appearance_migration.version);
        let group_bound_path_migration = registry
            .iter()
            .find(|migration| migration.version == MIGRATION_ADD_GROUP_BOUND_PATH_VERSION)
            .expect("group bound path migration must be registered");
        assert_eq!(group_bound_path_migration.version, 35);
        assert!(group_bound_path_migration
            .sql
            .contains("ALTER TABLE groups ADD COLUMN bound_path TEXT"));
        let project_path_mode_migration = registry
            .iter()
            .find(|migration| migration.version == MIGRATION_ADD_PROJECT_PATH_MODE_VERSION)
            .expect("project path mode migration must be registered");
        assert_eq!(project_path_mode_migration.version, 36);
        assert!(project_path_mode_migration
            .sql
            .contains("ALTER TABLE projects ADD COLUMN path_mode TEXT"));
        let ssh_attachment_root_migration = registry
            .iter()
            .find(|migration| migration.version == MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION)
            .expect("SSH attachment root migration must be registered");
        assert_eq!(ssh_attachment_root_migration.version, 37);
        assert!(ssh_attachment_root_migration
            .sql
            .contains("ALTER TABLE ssh_hosts ADD COLUMN attachment_root TEXT"));
        assert!(node_appearance_migration.version < group_bound_path_migration.version);
        assert!(group_bound_path_migration.version < project_path_mode_migration.version);
        assert!(project_path_mode_migration.version < ssh_attachment_root_migration.version);
        assert!(registry
            .iter()
            .all(|migration| migration.version <= ssh_attachment_root_migration.version));
        assert!(registry.iter().any(|migration| migration.version == 29
            && migration.description == "optimize_unified_usage_record_queries"));
    }
}

#[cfg(test)]
mod request_log_project_path_migration_tests {
    use super::{
        MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL, MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL,
        MIGRATION_CREATE_REQUEST_LOGS_SQL, MIGRATION_CREATE_USAGE_RECORDS_SQL,
        MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_SQL,
    };
    use sqlx::{Connection, Row, SqliteConnection};

    #[tokio::test]
    // 在内存数据库重复执行路径回填，验证唯一匹配、歧义保留和已有值不覆盖。
    async fn materialized_project_path_migration_backfills_legacy_rows_idempotently() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                environment_type TEXT NOT NULL DEFAULT 'local'
             )",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO projects(id, name, path, environment_type) VALUES
                ('project-a', 'Configured Project', 'D:\\Work\\Project-A', 'local'),
                ('duplicate-a', 'Duplicate A', 'D:\\Work\\One\\Duplicate', 'local'),
                ('duplicate-b', 'Duplicate B', 'E:\\Work\\Two\\Duplicate', 'wsl'),
                ('remote', 'Project-A', '', 'ssh')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_REQUEST_LOGS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_USAGE_RECORDS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO usage_records(
                record_id, logical_request_id, data_source, source, session_id,
                project_key, project_path, started_at_ms, created_at_ms, updated_at_ms
             ) VALUES
                ('absolute', 'absolute', 'session_log', 'grok', 'session-absolute',
                 '/mnt/d/Work/App/', NULL, 1, 1, 1),
                ('configured', 'configured', 'session_log', 'codex', 'session-configured',
                 'Project-A', NULL, 2, 2, 2),
                ('ambiguous', 'ambiguous', 'session_log', 'codex', 'session-ambiguous',
                 'Duplicate', NULL, 3, 3, 3),
                ('existing', 'existing', 'session_log', 'opencode', 'session-existing',
                 'Existing', 'keep/me', 4, 4, 4),
                ('route', 'route', 'route', 'codex', 'session-configured',
                 'Project-A', NULL, 5, 5, 5)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        for statement in MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_SQL.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&mut conn).await.unwrap();
            }
        }
        for _ in 0..2 {
            for statement in MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL.split(';') {
                let statement = statement.trim();
                if !statement.is_empty() {
                    sqlx::query(statement).execute(&mut conn).await.unwrap();
                }
            }
        }

        let rows = sqlx::query("SELECT record_id, project_path FROM usage_records")
            .fetch_all(&mut conn)
            .await
            .unwrap();
        let project_path = |record_id: &str| {
            rows.iter()
                .find(|row| row.get::<String, _>("record_id") == record_id)
                .and_then(|row| row.get::<Option<String>, _>("project_path"))
        };
        assert_eq!(project_path("absolute").as_deref(), Some("/mnt/d/work/app"));
        assert_eq!(
            project_path("configured").as_deref(),
            Some("d:/work/project-a")
        );
        assert_eq!(project_path("route").as_deref(), Some("d:/work/project-a"));
        assert_eq!(project_path("ambiguous"), None);
        assert_eq!(project_path("existing").as_deref(), Some("keep/me"));
    }

    #[tokio::test]
    // 在内存数据库验证错误详情迁移保留旧错误码并重建含空详情的统一视图。
    async fn route_usage_error_detail_migration_preserves_legacy_rows_and_rebuilds_view() {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_REQUEST_LOGS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_USAGE_RECORDS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO usage_records(
                record_id, logical_request_id, data_source, source, error_code,
                started_at_ms, created_at_ms, updated_at_ms
             ) VALUES ('route-error', 'route-error', 'route', 'codex',
                       'routing_upstream_timeout', 1, 1, 1)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        sqlx::raw_sql(MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        let row = sqlx::query(
            "SELECT error_code, error_detail
             FROM unified_usage_records
             WHERE request_id = 'route-error'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            row.get::<Option<String>, _>("error_code").as_deref(),
            Some("routing_upstream_timeout")
        );
        assert_eq!(row.get::<Option<String>, _>("error_detail"), None);
    }
}
