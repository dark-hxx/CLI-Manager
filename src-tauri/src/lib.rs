#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod app_paths;
mod ccswitch_db;
mod claude_hook;
pub mod codex_app_server_proxy;
pub mod codex_statusline;
mod commands;
mod conpty_sideload;
mod crash_reporter;
mod credential_store;
// daemon 二进制（src/bin/cli-manager-daemon.rs）经 lib 复用以下模块，
// 因此 app_paths 与 daemon 需 pub。
pub mod daemon;
mod file_watcher;
mod git_watcher;
pub mod hook_client;
mod linux_graphics;
mod log_rotation;
mod process_job;
pub(crate) mod provider;
pub mod pty;
mod runtime_diagnostics;
mod shell_resolver;
mod ssh_agent_supply_chain;
pub mod ssh_askpass;
pub mod ssh_launch;
pub mod ssh_proxy;
pub mod ssh_transport;
pub mod statusline;
pub mod statusline_profiles;
mod sync;
mod text_encoding;
mod third_party_notification;
pub mod usage;
pub(crate) mod usage_schema;
mod webdav;
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
use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

const WEBVIEW_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
const WEBVIEW_DISABLE_GPU_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu";

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[derive(Default)]
struct PendingBackgroundSession(Mutex<Option<String>>);

fn background_session_arg(args: &[String]) -> Option<String> {
    args.windows(2).find_map(|pair| {
        (pair[0] == "--restore-background-session" && !pair[1].trim().is_empty())
            .then(|| pair[1].clone())
    })
}

fn set_pending_background_session<R: Runtime>(app: &AppHandle<R>, session_id: String) {
    if let Ok(mut pending) = app.state::<PendingBackgroundSession>().0.lock() {
        *pending = Some(session_id.clone());
    }
    let _ = app.emit("background-task-activate-requested", session_id);
}

#[tauri::command]
fn take_pending_background_session(
    pending: tauri::State<'_, PendingBackgroundSession>,
) -> Option<String> {
    pending.0.lock().ok().and_then(|mut value| value.take())
}

#[tauri::command]
fn app_show_main_window(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
fn app_exit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn app_open_devtools(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.open_devtools();
    Ok(())
}

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
        fn enabled(&self, metadata: &Metadata) -> bool {
            metadata.level() <= Level::Info
        }
        fn log(&self, record: &Record) {
            if self.enabled(record.metadata()) {
                eprintln!("[{}] {}", record.level(), record.args());
            }
        }
        fn flush(&self) {}
    }

    static LOGGER: StderrLogger = StderrLogger;

    pub fn init() -> Result<(), log::SetLoggerError> {
        log::set_logger(&LOGGER).map(|_| log::set_max_level(log::LevelFilter::Info))
    }
}

pub(crate) const MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_VERSION: i64 = 13;
pub(crate) const MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_DESCRIPTION: &str =
    "create_session_favorite_snapshots_table";
pub(crate) const MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_SQL: &str = "
                CREATE TABLE IF NOT EXISTS session_favorite_snapshots (
                    session_key   TEXT PRIMARY KEY,
                    session_id    TEXT NOT NULL,
                    source        TEXT NOT NULL,
                    project_key   TEXT NOT NULL,
                    file_path     TEXT NOT NULL,
                    title         TEXT NOT NULL,
                    created_at    INTEGER NOT NULL,
                    updated_at    INTEGER NOT NULL,
                    message_count INTEGER NOT NULL,
                    branch        TEXT,
                    detail_json   TEXT NOT NULL,
                    snapshot_at   TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_session_favorite_snapshots_source ON session_favorite_snapshots(source);
                CREATE INDEX IF NOT EXISTS idx_session_favorite_snapshots_updated ON session_favorite_snapshots(updated_at DESC);
            ";

pub(crate) const MIGRATION_ADD_CLI_ARGS_VERSION: i64 = 14;
pub(crate) const MIGRATION_ADD_CLI_ARGS_DESCRIPTION: &str = "add_cli_args_to_projects";
pub(crate) const MIGRATION_ADD_CLI_ARGS_SQL: &str =
    "ALTER TABLE projects ADD COLUMN cli_args TEXT NOT NULL DEFAULT '';";

pub(crate) const MIGRATION_ADD_WORKTREE_ISOLATION_VERSION: i64 = 15;
pub(crate) const MIGRATION_ADD_WORKTREE_ISOLATION_DESCRIPTION: &str =
    "add_worktree_isolation_tables";
pub(crate) const MIGRATION_ADD_WORKTREE_ISOLATION_SQL: &str = "
                ALTER TABLE projects ADD COLUMN worktree_strategy TEXT NOT NULL DEFAULT 'disabled';
                ALTER TABLE projects ADD COLUMN worktree_root TEXT NOT NULL DEFAULT '';

                CREATE TABLE IF NOT EXISTS worktrees (
                    id                    TEXT PRIMARY KEY,
                    project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    name                  TEXT NOT NULL,
                    branch                TEXT NOT NULL,
                    path                  TEXT NOT NULL,
                    base_branch           TEXT NOT NULL DEFAULT '',
                    deps_prompt_dismissed INTEGER NOT NULL DEFAULT 0,
                    status                TEXT NOT NULL DEFAULT 'active',
                    created_at            TEXT NOT NULL,
                    updated_at            TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_project_name ON worktrees(project_id, name);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_path ON worktrees(path);
            ";

const MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_VERSION: i64 = 16;
const MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_DESCRIPTION: &str =
    "add_worktree_deps_prompt_setting";
const MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_SQL: &str =
    "ALTER TABLE projects ADD COLUMN worktree_deps_prompt_enabled INTEGER NOT NULL DEFAULT 0;";

const MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_VERSION: i64 = 17;
const MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_DESCRIPTION: &str =
    "add_provider_overrides_to_worktrees";
const MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_SQL: &str =
    "ALTER TABLE worktrees ADD COLUMN provider_overrides TEXT NOT NULL DEFAULT '{}';";

const MIGRATION_CREATE_HISTORY_EDIT_AUDIT_VERSION: i64 = 18;
const MIGRATION_CREATE_HISTORY_EDIT_AUDIT_DESCRIPTION: &str = "create_history_edit_audit_table";
const MIGRATION_CREATE_HISTORY_EDIT_AUDIT_SQL: &str = "
                CREATE TABLE IF NOT EXISTS history_edit_audit (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_key TEXT NOT NULL,
                    session_id  TEXT NOT NULL,
                    source      TEXT NOT NULL,
                    file_path   TEXT NOT NULL,
                    op          TEXT NOT NULL,
                    line_index  INTEGER,
                    role        TEXT,
                    before_text TEXT,
                    after_text  TEXT,
                    backup_path TEXT,
                    created_at  INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_history_edit_audit_session ON history_edit_audit(session_key, created_at DESC);
            ";

pub(crate) const MIGRATION_CREATE_REQUEST_LOGS_VERSION: i64 = 19;
pub(crate) const MIGRATION_CREATE_REQUEST_LOGS_DESCRIPTION: &str = "create_request_logs_tables";
pub(crate) const MIGRATION_CREATE_REQUEST_LOGS_SQL: &str = "
                CREATE TABLE IF NOT EXISTS request_logs (
                    request_id             TEXT PRIMARY KEY,
                    source                 TEXT NOT NULL,
                    project_key            TEXT NOT NULL DEFAULT '',
                    session_id             TEXT NOT NULL,
                    file_path              TEXT NOT NULL,
                    event_key              TEXT NOT NULL,
                    event_index            INTEGER NOT NULL,
                    timestamp_ms           INTEGER NOT NULL,
                    model                  TEXT,
                    input_tokens           INTEGER NOT NULL DEFAULT 0,
                    output_tokens          INTEGER NOT NULL DEFAULT 0,
                    cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
                    cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
                    created_at_ms          INTEGER NOT NULL,
                    updated_at_ms          INTEGER NOT NULL,
                    UNIQUE(file_path, event_key)
                );
                CREATE INDEX IF NOT EXISTS idx_request_logs_time
                    ON request_logs(timestamp_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_request_logs_source_project
                    ON request_logs(source, project_key, timestamp_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_request_logs_session
                    ON request_logs(source, session_id);
                CREATE INDEX IF NOT EXISTS idx_request_logs_model
                    ON request_logs(model, timestamp_ms DESC);

                CREATE TABLE IF NOT EXISTS request_log_sync (
                    file_path          TEXT PRIMARY KEY,
                    source             TEXT NOT NULL,
                    file_created_at    INTEGER NOT NULL,
                    file_updated_at    INTEGER NOT NULL,
                    file_size          INTEGER NOT NULL,
                    parser_version     INTEGER NOT NULL,
                    last_synced_at_ms  INTEGER NOT NULL
                );
            ";

pub(crate) const MIGRATION_CREATE_SSH_HOSTS_VERSION: i64 = 20;
pub(crate) const MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION: &str =
    "create_ssh_hosts_and_project_environment";
pub(crate) const MIGRATION_CREATE_SSH_HOSTS_SQL: &str = "
                CREATE TABLE IF NOT EXISTS ssh_hosts (
                    id                        TEXT PRIMARY KEY,
                    name                      TEXT NOT NULL,
                    group_name                TEXT NOT NULL DEFAULT '',
                    host                      TEXT NOT NULL DEFAULT '',
                    port                      INTEGER NOT NULL DEFAULT 22,
                    username                  TEXT NOT NULL DEFAULT '',
                    config_alias              TEXT NOT NULL DEFAULT '',
                    auth_mode                 TEXT NOT NULL DEFAULT 'ssh_config',
                    identity_file             TEXT NOT NULL DEFAULT '',
                    credential_ref            TEXT NOT NULL DEFAULT '',
                    jump_mode                 TEXT NOT NULL DEFAULT 'none',
                    jump_host_id              TEXT REFERENCES ssh_hosts(id) ON DELETE SET NULL,
                    proxy_type                TEXT NOT NULL DEFAULT 'none',
                    proxy_host                TEXT NOT NULL DEFAULT '',
                    proxy_port                INTEGER NOT NULL DEFAULT 0,
                    proxy_command             TEXT NOT NULL DEFAULT '',
                    connect_timeout_sec       INTEGER NOT NULL DEFAULT 15,
                    server_alive_interval_sec INTEGER NOT NULL DEFAULT 30,
                    server_alive_count_max    INTEGER NOT NULL DEFAULT 3,
                    terminal_encoding         TEXT NOT NULL DEFAULT 'UTF-8',
                    startup_script            TEXT NOT NULL DEFAULT '',
                    notes                     TEXT NOT NULL DEFAULT '',
                    sort_order                INTEGER NOT NULL DEFAULT 0,
                    created_at                TEXT NOT NULL,
                    updated_at                TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_ssh_hosts_group ON ssh_hosts(group_name, sort_order, name);
                CREATE INDEX IF NOT EXISTS idx_ssh_hosts_jump ON ssh_hosts(jump_host_id);

                ALTER TABLE projects ADD COLUMN environment_type TEXT NOT NULL DEFAULT 'local';
                ALTER TABLE projects ADD COLUMN ssh_host_id TEXT REFERENCES ssh_hosts(id) ON DELETE SET NULL;
                ALTER TABLE projects ADD COLUMN remote_path TEXT NOT NULL DEFAULT '';
                CREATE INDEX IF NOT EXISTS idx_projects_environment ON projects(environment_type);
                CREATE INDEX IF NOT EXISTS idx_projects_ssh_host ON projects(ssh_host_id);
              ";

pub(crate) const MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION: i64 = 21;
pub(crate) const MIGRATION_CREATE_SSH_HOST_GROUPS_DESCRIPTION: &str =
    "create_hierarchical_ssh_host_groups";
pub(crate) const MIGRATION_CREATE_SSH_HOST_GROUPS_SQL: &str = "
                CREATE TABLE IF NOT EXISTS ssh_host_groups (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    parent_id  TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_ssh_host_groups_parent
                    ON ssh_host_groups(parent_id, sort_order, name);
                ALTER TABLE ssh_hosts ADD COLUMN group_id TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL;
                INSERT INTO ssh_host_groups (id, name, parent_id, sort_order, created_at)
                SELECT lower(hex(randomblob(16))), group_name, NULL, 0, CAST(strftime('%s', 'now') AS TEXT)
                FROM ssh_hosts
                WHERE trim(group_name) <> ''
                GROUP BY group_name;
                UPDATE ssh_hosts
                SET group_id = (
                    SELECT id FROM ssh_host_groups
                    WHERE parent_id IS NULL AND name = ssh_hosts.group_name
                    ORDER BY created_at, id LIMIT 1
                )
                WHERE trim(group_name) <> '';
                CREATE INDEX IF NOT EXISTS idx_ssh_hosts_group_id
                    ON ssh_hosts(group_id, sort_order, name);
              ";

const MIGRATION_ADD_SSH_CONFIG_FILE_VERSION: i64 = 22;
const MIGRATION_ADD_SSH_CONFIG_FILE_DESCRIPTION: &str = "add_ssh_config_file";
const MIGRATION_ADD_SSH_CONFIG_FILE_SQL: &str =
    "ALTER TABLE ssh_hosts ADD COLUMN config_file TEXT NOT NULL DEFAULT '';";

const MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_VERSION: i64 = 23;
const MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_DESCRIPTION: &str =
    "create_ssh_agent_integrations_and_project_cli_config_root";
const MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_SQL: &str = "
                ALTER TABLE projects ADD COLUMN cli_config_root TEXT NOT NULL DEFAULT '';

                CREATE TABLE IF NOT EXISTS ssh_agent_installations (
                    host_id             TEXT PRIMARY KEY REFERENCES ssh_hosts(id) ON DELETE CASCADE,
                    installation_id     TEXT NOT NULL DEFAULT '',
                    remote_machine_id   TEXT NOT NULL DEFAULT '',
                    agent_version       TEXT NOT NULL DEFAULT '',
                    protocol_version    TEXT NOT NULL DEFAULT '',
                    target              TEXT NOT NULL DEFAULT '',
                    install_path        TEXT NOT NULL DEFAULT '',
                    status              TEXT NOT NULL DEFAULT 'unknown',
                    checked_at          TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS ssh_host_tool_preferences (
                    host_id          TEXT NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
                    source           TEXT NOT NULL,
                    configured_root  TEXT NOT NULL DEFAULT '',
                    updated_at       TEXT NOT NULL,
                    PRIMARY KEY (host_id, source)
                );

                CREATE TABLE IF NOT EXISTS ssh_agent_tool_integrations (
                    integration_id              TEXT PRIMARY KEY,
                    host_id                     TEXT REFERENCES ssh_hosts(id) ON DELETE SET NULL,
                    installation_id             TEXT NOT NULL DEFAULT '',
                    remote_machine_id           TEXT NOT NULL DEFAULT '',
                    ssh_user                    TEXT NOT NULL DEFAULT '',
                    source                      TEXT NOT NULL,
                    scope_kind                  TEXT NOT NULL DEFAULT 'hostPrimary',
                    configured_root             TEXT NOT NULL DEFAULT '',
                    canonical_root              TEXT NOT NULL DEFAULT '',
                    config_root_hash            TEXT NOT NULL DEFAULT '',
                    hook_record_json            TEXT NOT NULL DEFAULT '{}',
                    history_source_instance_id  TEXT NOT NULL DEFAULT '',
                    validation_state            TEXT NOT NULL DEFAULT 'unvalidated',
                    cleanup_state               TEXT NOT NULL DEFAULT 'active',
                    checked_at                  TEXT NOT NULL DEFAULT ''
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_agent_tool_host_primary
                    ON ssh_agent_tool_integrations(host_id, source)
                    WHERE host_id IS NOT NULL AND scope_kind = 'hostPrimary';
                CREATE INDEX IF NOT EXISTS idx_ssh_agent_tool_identity
                    ON ssh_agent_tool_integrations(
                        installation_id, remote_machine_id, ssh_user, source, config_root_hash
                    );
                CREATE INDEX IF NOT EXISTS idx_ssh_agent_tool_history_source
                    ON ssh_agent_tool_integrations(history_source_instance_id);
              ";

const MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_VERSION: i64 = 24;
const MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_DESCRIPTION: &str =
    "extend_ssh_agent_installation_metadata";
const MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_SQL: &str = "
                ALTER TABLE ssh_agent_installations ADD COLUMN install_root TEXT NOT NULL DEFAULT '';
                ALTER TABLE ssh_agent_installations ADD COLUMN source TEXT NOT NULL DEFAULT '';
                ALTER TABLE ssh_agent_installations ADD COLUMN manifest_url TEXT NOT NULL DEFAULT '';
                ALTER TABLE ssh_agent_installations ADD COLUMN artifact_sha256 TEXT NOT NULL DEFAULT '';
                ALTER TABLE ssh_agent_installations ADD COLUMN previous_version TEXT NOT NULL DEFAULT '';
              ";

pub(crate) const MIGRATION_CREATE_USAGE_RECORDS_VERSION: i64 = 27;
pub(crate) const MIGRATION_CREATE_USAGE_RECORDS_SQL: &str = "
                CREATE TABLE IF NOT EXISTS usage_records (
                    record_id              TEXT PRIMARY KEY,
                    logical_request_id     TEXT NOT NULL,
                    data_source            TEXT NOT NULL CHECK (data_source IN ('route', 'session_log')),
                    source                 TEXT NOT NULL,
                    event_key              TEXT NOT NULL DEFAULT '',
                    file_path             TEXT,
                    event_index           INTEGER NOT NULL DEFAULT 0,
                    session_id             TEXT,
                    project_key            TEXT,
                    project_path           TEXT,
                    attribution_status     TEXT NOT NULL DEFAULT 'pending',
                    provider_id            TEXT,
                    provider_name          TEXT,
                    requested_model        TEXT,
                    outbound_model         TEXT,
                    response_model         TEXT,
                    pricing_model          TEXT,
                    input_tokens           INTEGER NOT NULL DEFAULT 0,
                    output_tokens          INTEGER NOT NULL DEFAULT 0,
                    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
                    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                    usage_status           TEXT NOT NULL DEFAULT 'complete',
                    status_code            INTEGER,
                    outcome                TEXT NOT NULL DEFAULT 'success',
                    error_code             TEXT,
                    is_streaming           INTEGER NOT NULL DEFAULT 0,
                    started_at_ms          INTEGER NOT NULL,
                    completed_at_ms       INTEGER,
                    duration_ms            INTEGER NOT NULL DEFAULT 0,
                    attempt_index         INTEGER NOT NULL DEFAULT 0,
                    attempt_count         INTEGER NOT NULL DEFAULT 1,
                    degraded              INTEGER NOT NULL DEFAULT 0,
                    created_at_ms         INTEGER NOT NULL,
                    updated_at_ms         INTEGER NOT NULL,
                    UNIQUE(data_source, logical_request_id, event_key)
                );
                CREATE INDEX IF NOT EXISTS idx_usage_records_time ON usage_records(started_at_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_usage_records_project ON usage_records(project_key, started_at_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_usage_records_session ON usage_records(session_id, started_at_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records(provider_id, started_at_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_usage_records_source ON usage_records(source, data_source, started_at_ms DESC);
                INSERT OR IGNORE INTO usage_records(
                    record_id, logical_request_id, data_source, source, event_key,
                    file_path, event_index, session_id, project_key, attribution_status,
                    response_model, pricing_model, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens, usage_status, outcome,
                    started_at_ms, completed_at_ms, duration_ms, created_at_ms, updated_at_ms
                )
                SELECT request_id, request_id, 'session_log', source, event_key,
                       file_path, event_index, session_id, project_key, 'resolved',
                       model, model, input_tokens, output_tokens, cache_read_tokens,
                       cache_creation_tokens, 'complete', 'success', timestamp_ms,
                       timestamp_ms, 0, updated_at_ms, updated_at_ms
                FROM request_logs;
                DROP VIEW IF EXISTS unified_usage_records;
                CREATE VIEW unified_usage_records AS
                SELECT
                    u.record_id AS request_id,
                    u.source,
                    COALESCE(u.project_key, '') AS project_key,
                    COALESCE(u.session_id, '') AS session_id,
                    COALESCE(u.file_path, '') AS file_path,
                    u.event_index,
                    u.started_at_ms AS timestamp_ms,
                    COALESCE(u.outbound_model, u.response_model, u.requested_model, u.pricing_model) AS model,
                    u.input_tokens,
                    u.output_tokens,
                    u.cache_read_tokens,
                    u.cache_creation_tokens,
                    u.data_source,
                    u.provider_id,
                    u.provider_name,
                    u.requested_model,
                    u.outbound_model,
                    u.response_model,
                    u.usage_status,
                    u.status_code,
                    u.outcome,
                    u.duration_ms,
                    u.attempt_count,
                    u.degraded
                FROM usage_records u
                WHERE u.data_source = 'route'
                   OR NOT EXISTS (
                        SELECT 1
                        FROM usage_records r
                        WHERE r.data_source = 'route'
                          AND r.usage_status IN ('complete', 'partial')
                          AND NULLIF(r.session_id, '') IS NOT NULL
                          AND r.session_id = u.session_id
                          AND ABS(r.started_at_ms - u.started_at_ms) <= 120000
                          AND COALESCE(r.outbound_model, r.response_model, r.requested_model)
                              = COALESCE(u.response_model, u.pricing_model)
                          AND r.input_tokens = u.input_tokens
                          AND r.output_tokens = u.output_tokens
                          AND r.cache_read_tokens = u.cache_read_tokens
                          AND r.cache_creation_tokens = u.cache_creation_tokens
                   );
                CREATE TABLE IF NOT EXISTS usage_daily_rollups (
                    day_start_ms          INTEGER NOT NULL,
                    source                TEXT NOT NULL,
                    project_key           TEXT NOT NULL DEFAULT '',
                    provider_id           TEXT NOT NULL DEFAULT '',
                    outbound_model        TEXT NOT NULL DEFAULT '',
                    request_count         INTEGER NOT NULL DEFAULT 0,
                    input_tokens          INTEGER NOT NULL DEFAULT 0,
                    output_tokens         INTEGER NOT NULL DEFAULT 0,
                    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
                    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(day_start_ms, source, project_key, provider_id, outbound_model)
                );
              ";
const MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_VERSION: i64 = 28;
pub(crate) const MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_SQL: &str = "
                DROP VIEW IF EXISTS unified_usage_records;
                CREATE VIEW unified_usage_records AS
                SELECT
                    u.record_id AS request_id,
                    u.source,
                    COALESCE(u.project_key, '') AS project_key,
                    COALESCE(u.session_id, '') AS session_id,
                    COALESCE(u.file_path, '') AS file_path,
                    u.event_index,
                    u.started_at_ms AS timestamp_ms,
                    COALESCE(u.outbound_model, u.response_model, u.requested_model, u.pricing_model) AS model,
                    u.input_tokens,
                    u.output_tokens,
                    u.cache_read_tokens,
                    u.cache_creation_tokens,
                    u.data_source,
                    u.provider_id,
                    u.provider_name,
                    u.requested_model,
                    u.outbound_model,
                    u.response_model,
                    u.usage_status,
                    u.status_code,
                    u.outcome,
                    u.duration_ms,
                    u.attempt_count,
                    u.degraded
                FROM usage_records u
                WHERE u.data_source = 'route'
                   OR NOT EXISTS (
                        SELECT 1
                        FROM usage_records r
                        WHERE r.data_source = 'route'
                          AND r.usage_status IN ('complete', 'partial')
                          AND NULLIF(TRIM(r.session_id), '') IS NOT NULL
                          AND r.source = u.source
                          AND r.session_id = u.session_id
                          AND ABS(COALESCE(r.completed_at_ms, r.started_at_ms) - u.started_at_ms) <= 120000
                          AND LOWER(COALESCE(r.outbound_model, r.response_model, r.requested_model, ''))
                              = LOWER(COALESCE(u.response_model, u.pricing_model, ''))
                          AND r.output_tokens = u.output_tokens
                          AND (
                              r.input_tokens = u.input_tokens
                              OR r.input_tokens = u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens
                              OR u.input_tokens = r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens
                          )
                   );
              ";
const MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_VERSION: i64 = 29;
const MIGRATION_CREATE_HISTORY_GENERATED_TITLES_VERSION: i64 = 30;
const MIGRATION_CREATE_HISTORY_GENERATED_TITLES_DESCRIPTION: &str =
    "create_history_generated_titles_table";
const MIGRATION_CREATE_HISTORY_GENERATED_TITLES_SQL: &str = "
                CREATE TABLE IF NOT EXISTS history_generated_titles (
                    session_key             TEXT PRIMARY KEY,
                    source_id               TEXT NOT NULL,
                    source_instance_id      TEXT NOT NULL DEFAULT '',
                    source_session_id       TEXT NOT NULL,
                    transport_kind          TEXT NOT NULL DEFAULT 'local',
                    generated_title         TEXT,
                    generation_state        TEXT NOT NULL DEFAULT 'idle'
                                            CHECK (generation_state IN ('idle','pending','succeeded','failed')),
                    generation_revision     INTEGER NOT NULL DEFAULT 0,
                    trigger_kind            TEXT
                                            CHECK (trigger_kind IS NULL OR trigger_kind IN ('automatic','manual')),
                    source_message_identity TEXT,
                    source_content_sha256   TEXT,
                    provider_app_type       TEXT,
                    provider_id             TEXT,
                    model_id                TEXT,
                    failure_code            TEXT,
                    auto_suppressed         INTEGER NOT NULL DEFAULT 0 CHECK (auto_suppressed IN (0,1)),
                    suppressed_fingerprint  TEXT,
                    requested_at            INTEGER,
                    completed_at            INTEGER,
                    updated_at              INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_history_generated_titles_source_identity
                    ON history_generated_titles(source_id, source_instance_id, source_session_id);
                CREATE INDEX IF NOT EXISTS idx_history_generated_titles_state
                    ON history_generated_titles(generation_state, updated_at DESC);
            ";
pub(crate) const MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_VERSION: i64 = 31;
pub(crate) const MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_SQL: &str = "
                CREATE INDEX IF NOT EXISTS idx_usage_records_project_path
                    ON usage_records(project_path, started_at_ms DESC);
                DROP VIEW IF EXISTS unified_usage_records;
                CREATE VIEW unified_usage_records AS
                SELECT
                    u.record_id AS request_id,
                    u.source,
                    COALESCE(u.project_key, '') AS project_key,
                    COALESCE(u.project_path, '') AS project_path,
                    COALESCE(u.session_id, '') AS session_id,
                    COALESCE(u.file_path, '') AS file_path,
                    u.event_index,
                    u.started_at_ms AS timestamp_ms,
                    COALESCE(u.outbound_model, u.response_model, u.requested_model, u.pricing_model) AS model,
                    u.input_tokens,
                    u.output_tokens,
                    u.cache_read_tokens,
                    u.cache_creation_tokens,
                    u.data_source,
                    u.provider_id,
                    u.provider_name,
                    u.requested_model,
                    u.outbound_model,
                    u.response_model,
                    u.usage_status,
                    u.status_code,
                    u.outcome,
                    u.duration_ms,
                    u.attempt_count,
                    u.degraded
                FROM usage_records u
                WHERE u.data_source = 'route'
                   OR NOT EXISTS (
                        SELECT 1
                        FROM usage_records r
                        WHERE r.data_source = 'route'
                          AND r.usage_status IN ('complete', 'partial')
                          AND NULLIF(TRIM(r.session_id), '') IS NOT NULL
                          AND r.source = u.source
                          AND r.session_id = u.session_id
                          AND COALESCE(r.completed_at_ms, r.started_at_ms)
                              BETWEEN u.started_at_ms - 120000 AND u.started_at_ms + 120000
                          AND LOWER(COALESCE(r.outbound_model, r.response_model, r.requested_model, ''))
                              = LOWER(COALESCE(u.response_model, u.pricing_model, ''))
                          AND r.output_tokens = u.output_tokens
                          AND (
                              r.input_tokens = u.input_tokens
                              OR r.input_tokens = u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens
                              OR u.input_tokens = r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens
                          )
                   );
              ";
pub(crate) const MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION: i64 = 32;
pub(crate) const MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL: &str = r#"
                UPDATE usage_records
                   SET project_path = LOWER(RTRIM(REPLACE(TRIM(project_key), '\', '/'), '/'))
                 WHERE NULLIF(TRIM(project_path), '') IS NULL
                   AND NULLIF(TRIM(project_key), '') IS NOT NULL
                   AND (
                        SUBSTR(REPLACE(TRIM(project_key), '\', '/'), 1, 1) = '/'
                        OR SUBSTR(REPLACE(TRIM(project_key), '\', '/'), 2, 2) = ':/'
                   );
                WITH normalized_projects AS (
                    SELECT
                        LOWER(TRIM(name)) AS project_name,
                        LOWER(RTRIM(REPLACE(TRIM(path), '\', '/'), '/')) AS project_path
                    FROM projects
                    WHERE COALESCE(environment_type, 'local') <> 'ssh'
                      AND NULLIF(TRIM(path), '') IS NOT NULL
                ),
                resolved_paths AS (
                    SELECT target.record_id, MIN(project.project_path) AS project_path
                    FROM usage_records AS target
                    JOIN normalized_projects AS project
                      ON project.project_name = LOWER(TRIM(target.project_key))
                      OR project.project_path = LOWER(RTRIM(REPLACE(TRIM(target.project_key), '\', '/'), '/'))
                      OR project.project_path LIKE '%/' || LOWER(TRIM(target.project_key))
                    WHERE NULLIF(TRIM(target.project_path), '') IS NULL
                      AND NULLIF(TRIM(target.project_key), '') IS NOT NULL
                    GROUP BY target.record_id
                    HAVING COUNT(DISTINCT project.project_path) = 1
                )
                UPDATE usage_records
                   SET project_path = (
                        SELECT resolved.project_path
                        FROM resolved_paths AS resolved
                        WHERE resolved.record_id = usage_records.record_id
                   )
                 WHERE record_id IN (SELECT record_id FROM resolved_paths);
                UPDATE usage_records AS target
                   SET project_path = (
                        SELECT session.project_path
                          FROM usage_records AS session
                         WHERE session.data_source = 'session_log'
                           AND session.source = target.source
                           AND session.session_id = target.session_id
                           AND NULLIF(TRIM(session.project_path), '') IS NOT NULL
                         ORDER BY session.updated_at_ms DESC
                         LIMIT 1
                   )
                 WHERE target.data_source = 'route'
                   AND NULLIF(TRIM(target.project_path), '') IS NULL
                   AND NULLIF(TRIM(target.session_id), '') IS NOT NULL
                   AND EXISTS (
                        SELECT 1
                          FROM usage_records AS session
                         WHERE session.data_source = 'session_log'
                           AND session.source = target.source
                           AND session.session_id = target.session_id
                           AND NULLIF(TRIM(session.project_path), '') IS NOT NULL
                   );
              "#;
pub(crate) const MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_SQL: &str = "
                CREATE INDEX IF NOT EXISTS idx_usage_records_route_dedup
                ON usage_records(
                    source,
                    data_source,
                    session_id,
                    output_tokens,
                    COALESCE(completed_at_ms, started_at_ms)
                );
                DROP VIEW IF EXISTS unified_usage_records;
                CREATE VIEW unified_usage_records AS
                SELECT
                    u.record_id AS request_id,
                    u.source,
                    COALESCE(u.project_key, '') AS project_key,
                    COALESCE(u.session_id, '') AS session_id,
                    COALESCE(u.file_path, '') AS file_path,
                    u.event_index,
                    u.started_at_ms AS timestamp_ms,
                    COALESCE(u.outbound_model, u.response_model, u.requested_model, u.pricing_model) AS model,
                    u.input_tokens,
                    u.output_tokens,
                    u.cache_read_tokens,
                    u.cache_creation_tokens,
                    u.data_source,
                    u.provider_id,
                    u.provider_name,
                    u.requested_model,
                    u.outbound_model,
                    u.response_model,
                    u.usage_status,
                    u.status_code,
                    u.outcome,
                    u.duration_ms,
                    u.attempt_count,
                    u.degraded
                FROM usage_records u
                WHERE u.data_source = 'route'
                   OR NOT EXISTS (
                        SELECT 1
                        FROM usage_records r
                        WHERE r.data_source = 'route'
                          AND r.usage_status IN ('complete', 'partial')
                          AND NULLIF(TRIM(r.session_id), '') IS NOT NULL
                          AND r.source = u.source
                          AND r.session_id = u.session_id
                          AND COALESCE(r.completed_at_ms, r.started_at_ms)
                              BETWEEN u.started_at_ms - 120000 AND u.started_at_ms + 120000
                          AND LOWER(COALESCE(r.outbound_model, r.response_model, r.requested_model, ''))
                              = LOWER(COALESCE(u.response_model, u.pricing_model, ''))
                          AND r.output_tokens = u.output_tokens
                          AND (
                              r.input_tokens = u.input_tokens
                              OR r.input_tokens = u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens
                              OR u.input_tokens = r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens
                          )
                   );
              ";
/// 分组与项目的外观标记（issue #213）。空串表示"自动"：颜色按名称 hash 落到调色板，图标按节点类型回退。
/// `icon` 存单个 emoji 字符或内置图标 key，`color` 只存调色板 token（不存任意 hex，保证主题适配）。
const MIGRATION_ADD_NODE_APPEARANCE_VERSION: i64 = 33;
const MIGRATION_ADD_NODE_APPEARANCE_DESCRIPTION: &str =
    "add_node_appearance_to_groups_and_projects";
const MIGRATION_ADD_NODE_APPEARANCE_SQL: &str = "
                ALTER TABLE groups ADD COLUMN icon TEXT NOT NULL DEFAULT '';
                ALTER TABLE groups ADD COLUMN color TEXT NOT NULL DEFAULT '';
                ALTER TABLE projects ADD COLUMN icon TEXT NOT NULL DEFAULT '';
                ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT '';
              ";
/// 供 `commands::db_repair` 做"缺列自愈"用：外观列缺失时补列并按同一 checksum 登记 migration 33，
/// 避免 sqlx 随后重放 `ADD COLUMN` 撞 `duplicate column name`。
pub(crate) const NODE_APPEARANCE_MIGRATION_VERSION: i64 = MIGRATION_ADD_NODE_APPEARANCE_VERSION;
pub(crate) const NODE_APPEARANCE_MIGRATION_DESCRIPTION: &str =
    MIGRATION_ADD_NODE_APPEARANCE_DESCRIPTION;
pub(crate) const NODE_APPEARANCE_MIGRATION_SQL: &str = MIGRATION_ADD_NODE_APPEARANCE_SQL;
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
        Migration {
            version: MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_VERSION,
            description: MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_DESCRIPTION,
            sql: MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_CLI_ARGS_VERSION,
            description: MIGRATION_ADD_CLI_ARGS_DESCRIPTION,
            sql: MIGRATION_ADD_CLI_ARGS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_WORKTREE_ISOLATION_VERSION,
            description: MIGRATION_ADD_WORKTREE_ISOLATION_DESCRIPTION,
            sql: MIGRATION_ADD_WORKTREE_ISOLATION_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_VERSION,
            description: MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_DESCRIPTION,
            sql: MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_VERSION,
            description: MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_DESCRIPTION,
            sql: MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_CREATE_HISTORY_EDIT_AUDIT_VERSION,
            description: MIGRATION_CREATE_HISTORY_EDIT_AUDIT_DESCRIPTION,
            sql: MIGRATION_CREATE_HISTORY_EDIT_AUDIT_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_CREATE_REQUEST_LOGS_VERSION,
            description: MIGRATION_CREATE_REQUEST_LOGS_DESCRIPTION,
            sql: MIGRATION_CREATE_REQUEST_LOGS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_CREATE_SSH_HOSTS_VERSION,
            description: MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION,
            sql: MIGRATION_CREATE_SSH_HOSTS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION,
            description: MIGRATION_CREATE_SSH_HOST_GROUPS_DESCRIPTION,
            sql: MIGRATION_CREATE_SSH_HOST_GROUPS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_SSH_CONFIG_FILE_VERSION,
            description: MIGRATION_ADD_SSH_CONFIG_FILE_DESCRIPTION,
            sql: MIGRATION_ADD_SSH_CONFIG_FILE_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_VERSION,
            description: MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_DESCRIPTION,
            sql: MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_VERSION,
            description: MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_DESCRIPTION,
            sql: MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: provider::MIGRATION_LEGACY_PROVIDERS_VERSION,
            description: provider::MIGRATION_LEGACY_PROVIDERS_DESCRIPTION,
            sql: provider::MIGRATION_LEGACY_PROVIDERS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: provider::MIGRATION_CREATE_NATIVE_PROVIDERS_VERSION,
            description: provider::MIGRATION_CREATE_NATIVE_PROVIDERS_DESCRIPTION,
            sql: provider::MIGRATION_CREATE_NATIVE_PROVIDERS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_CREATE_USAGE_RECORDS_VERSION,
            description: "create_unified_usage_records",
            sql: MIGRATION_CREATE_USAGE_RECORDS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_VERSION,
            description: "deduplicate_routed_session_usage",
            sql: MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_VERSION,
            description: "optimize_unified_usage_record_queries",
            sql: MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_CREATE_HISTORY_GENERATED_TITLES_VERSION,
            description: MIGRATION_CREATE_HISTORY_GENERATED_TITLES_DESCRIPTION,
            sql: MIGRATION_CREATE_HISTORY_GENERATED_TITLES_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_VERSION,
            description: "materialize_request_log_project_path",
            sql: MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION,
            description: "backfill_request_log_project_path",
            sql: MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_NODE_APPEARANCE_VERSION,
            description: MIGRATION_ADD_NODE_APPEARANCE_DESCRIPTION,
            sql: MIGRATION_ADD_NODE_APPEARANCE_SQL,
            kind: MigrationKind::Up,
        },
    ]
}

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
fn show_startup_error(error: &str) {
    eprintln!("CLI-Manager data directory initialization failed: {error}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
            commands::fs::clipboard_read_file_paths,
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
        MIGRATION_ADD_SSH_CONFIG_FILE_SQL, MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_SQL,
        MIGRATION_CREATE_SSH_HOSTS_SQL, MIGRATION_CREATE_SSH_HOST_GROUPS_SQL,
    };
    use sqlx::{Connection, Row, SqliteConnection};

    #[tokio::test]
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
}

#[cfg(test)]
mod provider_migration_tests {
    use super::migrations;
    use crate::provider::{
        MIGRATION_CREATE_NATIVE_PROVIDERS_VERSION, MIGRATION_LEGACY_PROVIDERS_VERSION,
    };
    use crate::{
        MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION,
        MIGRATION_CREATE_HISTORY_GENERATED_TITLES_VERSION,
        MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_VERSION,
    };

    #[test]
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
        assert!(title_migration.version < project_path_migration.version);
        assert!(project_path_migration.version < project_path_backfill.version);
        assert!(registry
            .iter()
            .all(|migration| migration.version <= project_path_backfill.version));
        assert!(registry.iter().any(|migration| migration.version == 29
            && migration.description == "optimize_unified_usage_record_queries"));
    }
}

#[cfg(test)]
mod request_log_project_path_migration_tests {
    use super::{
        MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL, MIGRATION_CREATE_REQUEST_LOGS_SQL,
        MIGRATION_CREATE_USAGE_RECORDS_SQL, MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_SQL,
    };
    use sqlx::{Connection, Row, SqliteConnection};

    #[tokio::test]
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
}
