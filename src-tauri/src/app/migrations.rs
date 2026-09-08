use crate::provider;
use tauri_plugin_sql::{Migration, MigrationKind};

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

pub(crate) const MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_VERSION: i64 = 16;
pub(crate) const MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_DESCRIPTION: &str =
    "add_worktree_deps_prompt_setting";
pub(crate) const MIGRATION_ADD_WORKTREE_DEPS_PROMPT_SETTING_SQL: &str =
    "ALTER TABLE projects ADD COLUMN worktree_deps_prompt_enabled INTEGER NOT NULL DEFAULT 0;";

pub(crate) const MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_VERSION: i64 = 17;
pub(crate) const MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_DESCRIPTION: &str =
    "add_provider_overrides_to_worktrees";
pub(crate) const MIGRATION_ADD_WORKTREE_PROVIDER_OVERRIDES_SQL: &str =
    "ALTER TABLE worktrees ADD COLUMN provider_overrides TEXT NOT NULL DEFAULT '{}';";

pub(crate) const MIGRATION_CREATE_HISTORY_EDIT_AUDIT_VERSION: i64 = 18;
pub(crate) const MIGRATION_CREATE_HISTORY_EDIT_AUDIT_DESCRIPTION: &str =
    "create_history_edit_audit_table";
pub(crate) const MIGRATION_CREATE_HISTORY_EDIT_AUDIT_SQL: &str = "
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

pub(crate) const MIGRATION_ADD_SSH_CONFIG_FILE_VERSION: i64 = 22;
pub(crate) const MIGRATION_ADD_SSH_CONFIG_FILE_DESCRIPTION: &str = "add_ssh_config_file";
pub(crate) const MIGRATION_ADD_SSH_CONFIG_FILE_SQL: &str =
    "ALTER TABLE ssh_hosts ADD COLUMN config_file TEXT NOT NULL DEFAULT '';";

pub(crate) const MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_VERSION: i64 = 23;
pub(crate) const MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_DESCRIPTION: &str =
    "create_ssh_agent_integrations_and_project_cli_config_root";
pub(crate) const MIGRATION_CREATE_SSH_AGENT_INTEGRATIONS_SQL: &str = "
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

pub(crate) const MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_VERSION: i64 = 24;
pub(crate) const MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_DESCRIPTION: &str =
    "extend_ssh_agent_installation_metadata";
pub(crate) const MIGRATION_EXTEND_SSH_AGENT_INSTALLATIONS_SQL: &str = "
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
pub(crate) const MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_VERSION: i64 = 28;
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
pub(crate) const MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_VERSION: i64 = 29;
pub(crate) const MIGRATION_CREATE_HISTORY_GENERATED_TITLES_VERSION: i64 = 30;
pub(crate) const MIGRATION_CREATE_HISTORY_GENERATED_TITLES_DESCRIPTION: &str =
    "create_history_generated_titles_table";
pub(crate) const MIGRATION_CREATE_HISTORY_GENERATED_TITLES_SQL: &str = "
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
pub(crate) const MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION: i64 = 33;
pub(crate) const MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION: &str =
    "add_route_usage_error_diagnostics";

macro_rules! recreate_unified_usage_records_with_error_detail_sql {
    () => {
        r#"
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
                    u.error_code,
                    u.error_detail,
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
              "#
    };
}

pub(crate) const MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_WITH_ERROR_DETAIL_SQL: &str =
    recreate_unified_usage_records_with_error_detail_sql!();
pub(crate) const MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL: &str = concat!(
    "ALTER TABLE usage_records ADD COLUMN error_detail TEXT;",
    recreate_unified_usage_records_with_error_detail_sql!()
);
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
pub(crate) const MIGRATION_ADD_NODE_APPEARANCE_VERSION: i64 = 34;
pub(crate) const MIGRATION_ADD_NODE_APPEARANCE_DESCRIPTION: &str =
    "add_node_appearance_to_groups_and_projects";
pub(crate) const MIGRATION_ADD_NODE_APPEARANCE_SQL: &str = "
                ALTER TABLE groups ADD COLUMN icon TEXT NOT NULL DEFAULT '';
                ALTER TABLE groups ADD COLUMN color TEXT NOT NULL DEFAULT '';
                ALTER TABLE projects ADD COLUMN icon TEXT NOT NULL DEFAULT '';
                ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT '';
              ";
/// 供 `commands::db_repair` 做"缺列自愈"用：外观列缺失时补列并按同一 checksum 登记 migration 34，
/// 避免 sqlx 随后重放 `ADD COLUMN` 撞 `duplicate column name`。
pub(crate) const NODE_APPEARANCE_MIGRATION_VERSION: i64 = MIGRATION_ADD_NODE_APPEARANCE_VERSION;
pub(crate) const NODE_APPEARANCE_MIGRATION_DESCRIPTION: &str =
    MIGRATION_ADD_NODE_APPEARANCE_DESCRIPTION;
pub(crate) const NODE_APPEARANCE_MIGRATION_SQL: &str = MIGRATION_ADD_NODE_APPEARANCE_SQL;
pub(crate) const MIGRATION_ADD_GROUP_BOUND_PATH_VERSION: i64 = 35;
pub(crate) const MIGRATION_ADD_GROUP_BOUND_PATH_DESCRIPTION: &str = "add_bound_path_to_groups";
pub(crate) const MIGRATION_ADD_GROUP_BOUND_PATH_SQL: &str =
    "ALTER TABLE groups ADD COLUMN bound_path TEXT NOT NULL DEFAULT '';";
pub(crate) const MIGRATION_ADD_PROJECT_PATH_MODE_VERSION: i64 = 36;
pub(crate) const MIGRATION_ADD_PROJECT_PATH_MODE_DESCRIPTION: &str = "add_project_path_mode";
pub(crate) const MIGRATION_ADD_PROJECT_PATH_MODE_SQL: &str =
    "ALTER TABLE projects ADD COLUMN path_mode TEXT NOT NULL DEFAULT 'custom';";
pub(crate) const MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION: i64 = 37;
pub(crate) const MIGRATION_ADD_SSH_ATTACHMENT_ROOT_DESCRIPTION: &str =
    "add_attachment_root_to_ssh_hosts";
pub(crate) const MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL: &str =
    "ALTER TABLE ssh_hosts ADD COLUMN attachment_root TEXT NOT NULL DEFAULT '';";
// 按既定版本顺序返回向上迁移注册表，由 SQL 插件在初始化时应用；此函数本身不执行 SQL。
pub(crate) fn migrations() -> Vec<Migration> {
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
            version: MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION,
            description: MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION,
            sql: MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_NODE_APPEARANCE_VERSION,
            description: MIGRATION_ADD_NODE_APPEARANCE_DESCRIPTION,
            sql: MIGRATION_ADD_NODE_APPEARANCE_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_GROUP_BOUND_PATH_VERSION,
            description: MIGRATION_ADD_GROUP_BOUND_PATH_DESCRIPTION,
            sql: MIGRATION_ADD_GROUP_BOUND_PATH_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_PROJECT_PATH_MODE_VERSION,
            description: MIGRATION_ADD_PROJECT_PATH_MODE_DESCRIPTION,
            sql: MIGRATION_ADD_PROJECT_PATH_MODE_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION,
            description: MIGRATION_ADD_SSH_ATTACHMENT_ROOT_DESCRIPTION,
            sql: MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL,
            kind: MigrationKind::Up,
        },
    ]
}
