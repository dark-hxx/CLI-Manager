#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod pty;
mod webdav;
mod sync;

use log::LevelFilter;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind, TimezoneStrategy};

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

    tauri::Builder::default()
        .plugin({
            let mut targets = vec![Target::new(TargetKind::LogDir {
                file_name: Some("cli-manager.log".into()),
            })];
            if debug_logs {
                targets.push(Target::new(TargetKind::Webview));
                targets.push(Target::new(TargetKind::Stdout));
            }
            LogBuilder::new()
                .level(log_level)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .targets(targets)
                .build()
        })
        .setup(move |app| {
            log::set_max_level(log_level);
            log::info!(
                "CLI-Manager started (log_level={})",
                if log_level == LevelFilter::Debug { "debug" } else { "info" }
            );

            let show_item = MenuItem::with_id(app, "tray_show", "显示", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().ok_or("missing default window icon")?)
                .tooltip("CLI-Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
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
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(pty::manager::PtyManager::new())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:cli-manager.db", migrations())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::terminal::pty_create,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_close,
            commands::terminal::pty_status,
            commands::logging::set_debug_logging,
            commands::fs::check_paths_exist,
            commands::shell::open_windows_terminal,
            commands::history::history_list_sessions,
            commands::history::history_get_session,
            commands::history::history_search,
            commands::history::history_list_prompts,
            commands::history::history_get_stats,
            commands::sync::sync_get_default_device_name,
            commands::sync::sync_list_device_snapshots,
            commands::sync::sync_test_connection,
            commands::sync::sync_upload,
            commands::sync::sync_download,
            commands::sync::sync_local_export,
            commands::sync::sync_local_import,
            commands::version::get_app_version,
            commands::background::save_background_image,
            commands::background::cleanup_unused_backgrounds,
            commands::background::background_image_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
