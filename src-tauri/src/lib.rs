#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_paths;
mod claude_hook;
mod commands;
mod file_watcher;
mod git_watcher;
pub mod hook_client;
mod log_rotation;
mod pty;
mod shell_resolver;
mod sync;
mod webdav;
mod wsl;

use log::LevelFilter;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};
use tauri_plugin_log::{fern, Builder as LogBuilder, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn app_show_main_window(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
fn app_open_devtools(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.open_devtools();
    Ok(())
}

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_projects_table",
            sql: "CREATE TABLE IF NOT EXISTS projects (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                path        TEXT NOT NULL,
                group_name  TEXT NOT NULL DEFAULT '',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                cli_tool    TEXT NOT NULL DEFAULT '',
                startup_cmd TEXT NOT NULL DEFAULT '',
                env_vars    TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_command_templates_table",
            sql: "CREATE TABLE IF NOT EXISTS command_templates (
                id          TEXT PRIMARY KEY,
                project_id  TEXT,
                name        TEXT NOT NULL,
                command     TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            )",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_groups_table_and_migrate",
            sql: "
                CREATE TABLE IF NOT EXISTS groups (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    parent_id   TEXT,
                    sort_order  INTEGER NOT NULL DEFAULT 0,
                    created_at  TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE CASCADE
                );

                ALTER TABLE projects ADD COLUMN group_id TEXT DEFAULT NULL REFERENCES groups(id) ON DELETE SET NULL;

                INSERT INTO groups (id, name, parent_id, sort_order, created_at)
                SELECT DISTINCT
                    lower(hex(randomblob(16))),
                    group_name,
                    NULL,
                    0,
                    strftime('%s','now') * 1000
                FROM projects
                WHERE group_name != '' AND group_name IS NOT NULL;

                UPDATE projects SET group_id = (
                    SELECT g.id FROM groups g WHERE g.name = projects.group_name AND g.parent_id IS NULL
                ) WHERE group_name != '' AND group_name IS NOT NULL;
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create_command_history_table",
            sql: "
                CREATE TABLE IF NOT EXISTS command_history (
                    id          TEXT PRIMARY KEY,
                    project_id  TEXT,
                    command     TEXT NOT NULL,
                    executed_at TEXT NOT NULL,
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_command_history_project ON command_history(project_id);
                CREATE INDEX IF NOT EXISTS idx_command_history_time ON command_history(executed_at DESC);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_shell_to_projects",
            sql: "ALTER TABLE projects ADD COLUMN shell TEXT NOT NULL DEFAULT 'powershell';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "create_session_meta_table",
            sql: "
                CREATE TABLE IF NOT EXISTS session_meta (
                    session_key TEXT PRIMARY KEY,
                    session_id  TEXT NOT NULL,
                    source      TEXT NOT NULL,
                    project_key TEXT NOT NULL,
                    file_path   TEXT NOT NULL,
                    alias       TEXT NOT NULL DEFAULT '',
                    starred     INTEGER NOT NULL DEFAULT 0,
                    tags_json   TEXT NOT NULL DEFAULT '[]',
                    updated_at  TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_session_meta_source ON session_meta(source);
                CREATE INDEX IF NOT EXISTS idx_session_meta_updated ON session_meta(updated_at DESC);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "create_sync_meta_table",
            sql: "
                CREATE TABLE IF NOT EXISTS sync_meta (
                    id TEXT PRIMARY KEY DEFAULT 'singleton',
                    device_id TEXT NOT NULL,
                    last_sync_at TEXT,
                    remote_version TEXT
                );
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "add_secondary_indexes",
            sql: "
                CREATE INDEX IF NOT EXISTS idx_session_meta_project ON session_meta(project_key);
                CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "add_path_and_session_indexes",
            sql: "
                CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
                CREATE INDEX IF NOT EXISTS idx_session_meta_file ON session_meta(file_path);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "create_ccusage_cache_table",
            sql: "
                CREATE TABLE IF NOT EXISTS ccusage_cache (
                    cache_key   TEXT PRIMARY KEY,
                    source      TEXT NOT NULL,
                    report_kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    updated_at  INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_ccusage_cache_source ON ccusage_cache(source, report_kind);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "create_model_prices_table",
            sql: "
                CREATE TABLE IF NOT EXISTS model_prices (
                    model                  TEXT PRIMARY KEY,
                    input_per_1m           REAL NOT NULL DEFAULT 0,
                    output_per_1m          REAL NOT NULL DEFAULT 0,
                    cache_read_per_1m      REAL NOT NULL DEFAULT 0,
                    cache_creation_per_1m  REAL NOT NULL DEFAULT 0,
                    source                 TEXT NOT NULL DEFAULT 'manual',
                    source_model_id        TEXT,
                    raw_json               TEXT,
                    updated_at_ms          INTEGER NOT NULL DEFAULT 0,
                    synced_at_ms           INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_model_prices_source ON model_prices(source);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "add_provider_overrides_to_projects",
            sql: "ALTER TABLE projects ADD COLUMN provider_overrides TEXT NOT NULL DEFAULT '{}';",
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
                .level_for("sqlx", LevelFilter::Info)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .targets(targets)
                .build()
        })
        .setup(move |app| {
            if let Err(err) = app_paths::migrate_legacy_app_files(app.handle()) {
                log::warn!("CLI-Manager data migration skipped: {err}");
            }
            // 保留应用自身调试日志，但压掉 sqlx 的逐条 SQL 输出。
            log::set_max_level(log_level);
            app.manage(claude_hook::ClaudeHookBridge::start(app.handle().clone()));
            // 注入 appLocalData 目录用于历史索引磁盘缓存（加速冷启动加载）。
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
        .manage(pty::manager::PtyManager::new())
        .manage(file_watcher::FileWatcherBridge::new())
        .manage(git_watcher::GitWatcherBridge::new())
        .manage(commands::subagent_transcript::SubagentTranscriptBridge::new())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            SqlBuilder::default()
                .add_migrations(&data_db_url, migrations())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::terminal::pty_create,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_close,
            commands::terminal::pty_close_all,
            commands::terminal::pty_status,
            commands::logging::set_debug_logging,
            commands::fs::check_paths_exist,
            commands::fs::file_watch_start,
            commands::fs::file_watch_stop,
            commands::fs::file_list_dir,
            commands::fs::file_search,
            commands::fs::file_search_content,
            commands::fs::file_read_text,
            commands::fs::file_read_image,
            commands::fs::file_write_text,
            commands::fs::file_create_file,
            commands::fs::file_create_dir,
            commands::fs::file_rename,
            commands::fs::file_delete,
            commands::fs::file_copy,
            commands::fs::file_move,
            commands::shell::open_windows_terminal,
            commands::shell::open_folder_in_explorer,
            commands::history::history_list_sessions,
            commands::history::history_get_session,
            commands::history::history_delete_session,
            commands::history::history_search,
            commands::history::history_list_prompts,
            commands::history::history_list_stats_projects,
            commands::history::history_get_stats,
            commands::sync::sync_get_default_device_name,
            commands::sync::sync_list_device_snapshots,
            commands::sync::sync_test_connection,
            commands::sync::sync_upload,
            commands::sync::sync_download,
            commands::sync::sync_local_export,
            commands::sync::sync_local_import,
            commands::version::get_app_version,
            commands::version::get_os_platform,
            app_open_devtools,
            app_paths::app_get_data_paths,
            commands::fonts::list_system_fonts,
            commands::background::save_background_image,
            commands::background::cleanup_unused_backgrounds,
            commands::background::background_image_exists,
            commands::hook_settings::hook_settings_get_status,
            commands::hook_settings::hook_settings_install,
            commands::hook_settings::hook_settings_uninstall,
            commands::hook_settings::hook_settings_install_codex,
            commands::hook_settings::hook_settings_uninstall_codex,
            commands::hook_settings::hook_settings_select_dir,
            commands::ccusage::ccusage_get_status,
            commands::ccusage::ccusage_install_tools,
            commands::ccusage::ccusage_refresh_report,
            commands::ccswitch::ccswitch_list_providers,
            commands::ccswitch::ccswitch_get_project_provider,
            commands::ccswitch::ccswitch_apply_provider,
            commands::ccswitch::ccswitch_reset_project_provider,
            commands::ccswitch::ccswitch_prepare_claude_provider,
            commands::ccswitch::ccswitch_prepare_codex_provider,
            commands::ccswitch::ccswitch_test_provider_model,
            commands::ccswitch::ccswitch_cleanup_codex_profiles,
            commands::ccswitch::ccswitch_probe_projects,
            commands::ccswitch::ccswitch_list_common_configs,
            commands::git::get_current_git_branch,
            commands::git::git_get_changes,
            commands::git::git_get_file_diff,
            commands::git::git_fork_worktree_snapshot,
            commands::git::git_get_worktree_snapshot,
            commands::git::git_restore_worktree_snapshot,
            commands::git::git_discard_file,
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
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_pull_abort,
            commands::git::git_rebase_continue,
            commands::git::git_watch_start,
            commands::git::git_watch_stop,
            commands::subagent_transcript::subagent_transcript_subscribe,
            commands::subagent_transcript::subagent_transcript_unsubscribe,
            commands::subagent_transcript::subagent_transcript_discover,
            commands::subagent_transcript::codex_subagent_transcript_discover,
            commands::model_pricing::model_prices_set_cache,
            commands::model_pricing::model_prices_sync,
            commands::system_notification::is_wsl,
            commands::system_notification::send_notification_via_windows,
            commands::system_notification::send_interactive_system_notification,
            app_show_main_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
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
