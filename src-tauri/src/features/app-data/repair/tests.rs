use super::*;
use sqlx::Executor;

#[test]
fn maps_complete_feature_schema_to_current_migration_versions() {
    let features = SchemaFeatures {
        favorite_snapshots: SchemaState::Complete,
        cli_args: SchemaState::Complete,
        worktree_isolation: SchemaState::Complete,
        ssh_hosts: SchemaState::Complete,
        ssh_host_groups: SchemaState::Complete,
    };

    let expected = expected_migrations_for_features(&features).unwrap();
    let versions: Vec<i64> = expected.iter().map(|migration| migration.version).collect();

    assert_eq!(
        versions,
        vec![
            MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_VERSION,
            MIGRATION_ADD_CLI_ARGS_VERSION,
            MIGRATION_ADD_WORKTREE_ISOLATION_VERSION,
            MIGRATION_CREATE_SSH_HOSTS_VERSION,
            MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION,
        ]
    );
}

#[test]
fn rejects_partial_worktree_schema() {
    let features = SchemaFeatures {
        favorite_snapshots: SchemaState::Absent,
        cli_args: SchemaState::Complete,
        worktree_isolation: SchemaState::Partial,
        ssh_hosts: SchemaState::Absent,
        ssh_host_groups: SchemaState::Absent,
    };

    assert_eq!(
        expected_migrations_for_features(&features).unwrap_err(),
        "migration_repair_partial_worktree_schema"
    );
}

#[tokio::test]
async fn rewrites_old_worktree_lineage_rows_to_current_versions() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_complete_feature_schema(&mut conn).await;

    insert_migration_row(
        &mut conn,
        13,
        MIGRATION_ADD_CLI_ARGS_DESCRIPTION,
        MIGRATION_ADD_CLI_ARGS_SQL,
    )
    .await;
    insert_migration_row(
        &mut conn,
        14,
        MIGRATION_ADD_WORKTREE_ISOLATION_DESCRIPTION,
        MIGRATION_ADD_WORKTREE_ISOLATION_SQL,
    )
    .await;
    insert_migration_row(
        &mut conn,
        15,
        MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_DESCRIPTION,
        MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_SQL,
    )
    .await;

    let result = repair_known_migration_drift(&mut conn).await.unwrap();
    let rows = read_known_migration_rows(&mut conn).await.unwrap();

    assert!(result.repaired);
    assert_eq!(
        rows,
        expected_rows(
            &expected_migrations_for_features(&SchemaFeatures {
                favorite_snapshots: SchemaState::Complete,
                cli_args: SchemaState::Complete,
                worktree_isolation: SchemaState::Complete,
                ssh_hosts: SchemaState::Absent,
                ssh_host_groups: SchemaState::Absent,
            })
            .unwrap()
        )
    );
}

#[tokio::test]
async fn moves_cli_args_only_lineage_forward_and_leaves_missing_features_to_sqlx() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    conn.execute(
        "CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            cli_args TEXT NOT NULL DEFAULT ''
        )",
    )
    .await
    .unwrap();
    insert_migration_row(
        &mut conn,
        13,
        MIGRATION_ADD_CLI_ARGS_DESCRIPTION,
        MIGRATION_ADD_CLI_ARGS_SQL,
    )
    .await;

    let result = repair_known_migration_drift(&mut conn).await.unwrap();
    let rows = read_known_migration_rows(&mut conn).await.unwrap();

    assert!(result.repaired);
    assert_eq!(
        rows,
        vec![MigrationRow {
            version: MIGRATION_ADD_CLI_ARGS_VERSION,
            description: MIGRATION_ADD_CLI_ARGS_DESCRIPTION.to_string(),
            checksum: migration_checksum(MIGRATION_ADD_CLI_ARGS_SQL),
        }]
    );
}

#[tokio::test]
async fn marks_frontend_created_ssh_group_schema_as_migrated() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    conn.execute(
        "CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
    sqlx::raw_sql(MIGRATION_CREATE_SSH_HOSTS_SQL)
        .execute(&mut conn)
        .await
        .unwrap();
    conn.execute(
        "CREATE TABLE ssh_host_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
    conn.execute(
        "ALTER TABLE ssh_hosts
         ADD COLUMN group_id TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL",
    )
    .await
    .unwrap();
    insert_migration_row(
        &mut conn,
        MIGRATION_CREATE_SSH_HOSTS_VERSION,
        MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION,
        "legacy migration 20 sql",
    )
    .await;

    let result = repair_known_migration_drift(&mut conn).await.unwrap();
    let rows = read_known_migration_rows(&mut conn).await.unwrap();

    assert!(result.repaired);
    assert_eq!(
        rows,
        vec![
            MigrationRow {
                version: MIGRATION_CREATE_SSH_HOSTS_VERSION,
                description: MIGRATION_CREATE_SSH_HOSTS_DESCRIPTION.to_string(),
                checksum: migration_checksum(MIGRATION_CREATE_SSH_HOSTS_SQL),
            },
            MigrationRow {
                version: MIGRATION_CREATE_SSH_HOST_GROUPS_VERSION,
                description: MIGRATION_CREATE_SSH_HOST_GROUPS_DESCRIPTION.to_string(),
                checksum: migration_checksum(MIGRATION_CREATE_SSH_HOST_GROUPS_SQL),
            },
        ]
    );

    sqlx::raw_sql(crate::MIGRATION_ADD_SSH_CONFIG_FILE_SQL)
        .execute(&mut conn)
        .await
        .unwrap();
    let columns = table_columns(&mut conn, "ssh_hosts").await.unwrap();
    assert!(columns.contains("config_file"));
}

#[tokio::test]
async fn migrates_replay_snapshot_inline_patch_to_file_metadata() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    conn.execute(
        "CREATE TABLE ai_replay_events (
            id INTEGER PRIMARY KEY,
            session_key TEXT NOT NULL,
            event_index INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL
        )",
    )
    .await
    .unwrap();

    let patch = "diff --git a/a.txt b/a.txt\n+hello\n";
    let payload = serde_json::json!({
        "checkpointId": "checkpoint/one",
        "label": "snapshot",
        "patch": patch
    });
    sqlx::query(
        "INSERT INTO ai_replay_events (session_key, event_index, kind, payload_json)
         VALUES (?1, ?2, 'snapshot', ?3)",
    )
    .bind("session:one")
    .bind(7_i64)
    .bind(payload.to_string())
    .execute(&mut conn)
    .await
    .unwrap();

    let data_dir = tempfile::tempdir().unwrap();
    let migrated = cleanup_replay_snapshot_inline_patches(&mut conn, data_dir.path())
        .await
        .unwrap();

    assert_eq!(migrated, 1);

    let (stored_payload_json,): (String,) =
        sqlx::query_as("SELECT payload_json FROM ai_replay_events WHERE id = 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let stored_payload: Value = serde_json::from_str(&stored_payload_json).unwrap();
    let object = stored_payload.as_object().unwrap();
    assert!(object.get("patch").is_none());
    assert_eq!(
        object.get("patchStorage").and_then(Value::as_str),
        Some(REPLAY_SNAPSHOT_PATCH_STORAGE)
    );
    assert_eq!(
        object.get("patchBytes").and_then(Value::as_u64),
        Some(patch.len() as u64)
    );

    let patch_path = object.get("patchPath").and_then(Value::as_str).unwrap();
    assert_eq!(
        patch_path,
        "replay-snapshots/session-one/checkpoint-one.patch"
    );
    let written_patch = std::fs::read_to_string(data_dir.path().join(patch_path)).unwrap();
    assert_eq!(written_patch, patch);
}

#[tokio::test]
async fn skips_replay_snapshot_cleanup_when_current_version_marker_exists() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    conn.execute(
        "CREATE TABLE ai_replay_events (
            id INTEGER PRIMARY KEY,
            session_key TEXT NOT NULL,
            event_index INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
    let payload = serde_json::json!({
        "checkpointId": "checkpoint-one",
        "patch": "diff --git a/a.txt b/a.txt\n+hello\n"
    });
    sqlx::query(
        "INSERT INTO ai_replay_events (session_key, event_index, kind, payload_json)
         VALUES (?1, ?2, 'snapshot', ?3)",
    )
    .bind("session-one")
    .bind(1_i64)
    .bind(payload.to_string())
    .execute(&mut conn)
    .await
    .unwrap();

    let data_dir = tempfile::tempdir().unwrap();
    fs::write(
        replay_snapshot_cleanup_marker_path(data_dir.path()),
        APP_VERSION,
    )
    .unwrap();

    let migrated =
        cleanup_replay_snapshot_inline_patches_for_current_version(&mut conn, data_dir.path())
            .await
            .unwrap();

    assert_eq!(migrated, 0);
    let (stored_payload_json,): (String,) =
        sqlx::query_as("SELECT payload_json FROM ai_replay_events WHERE id = 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let stored_payload: Value = serde_json::from_str(&stored_payload_json).unwrap();
    assert!(stored_payload.get("patch").is_some());
    assert!(!data_dir.path().join(REPLAY_SNAPSHOT_PATCH_DIR).exists());
}

#[tokio::test]
async fn writes_replay_snapshot_cleanup_marker_after_version_check() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    let data_dir = tempfile::tempdir().unwrap();

    let migrated =
        cleanup_replay_snapshot_inline_patches_for_current_version(&mut conn, data_dir.path())
            .await
            .unwrap();

    assert_eq!(migrated, 0);
    assert_eq!(
        std::fs::read_to_string(replay_snapshot_cleanup_marker_path(data_dir.path())).unwrap(),
        APP_VERSION
    );
}

#[tokio::test]
async fn recovers_legacy_db_when_current_db_has_no_user_rows() {
    let temp = tempfile::tempdir().unwrap();
    let legacy = temp.path().join("legacy.db");
    let current = temp.path().join("current.db");
    create_user_data_db(&legacy, &[("project-1", "Legacy Project")]).await;
    create_user_data_db(&current, &[]).await;

    let recovered = recover_legacy_db_file_if_current_empty(&legacy, &current)
        .await
        .unwrap();

    assert!(recovered);
    let mut conn = open_cli_manager_db(&current).await.unwrap();
    let row = sqlx::query("SELECT name FROM projects WHERE id = 'project-1'")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    let name: String = row.try_get("name").unwrap();
    assert_eq!(name, "Legacy Project");
    let backup_count = fs::read_dir(temp.path())
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("current.db.backup-")
        })
        .count();
    assert_eq!(backup_count, 1);
}

#[tokio::test]
async fn does_not_overwrite_current_db_when_it_has_user_rows() {
    let temp = tempfile::tempdir().unwrap();
    let legacy = temp.path().join("legacy.db");
    let current = temp.path().join("current.db");
    create_user_data_db(&legacy, &[("project-legacy", "Legacy Project")]).await;
    create_user_data_db(&current, &[("project-current", "Current Project")]).await;

    let recovered = recover_legacy_db_file_if_current_empty(&legacy, &current)
        .await
        .unwrap();

    assert!(!recovered);
    let mut conn = open_cli_manager_db(&current).await.unwrap();
    let current_rows: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM projects WHERE id = 'project-current'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let legacy_rows: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM projects WHERE id = 'project-legacy'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(current_rows.0, 1);
    assert_eq!(legacy_rows.0, 0);
}

#[tokio::test]
async fn merges_legacy_custom_model_prices_without_overwriting_current_custom_prices() {
    let temp = tempfile::tempdir().unwrap();
    let legacy = temp.path().join("legacy.db");
    let current = temp.path().join("current.db");
    let data_dir = temp.path().join("data");
    create_user_data_db(&legacy, &[]).await;
    create_user_data_db(&current, &[("project-current", "Current Project")]).await;
    create_model_prices_table(&legacy).await;
    create_model_prices_table(&current).await;

    insert_model_price(&legacy, "gpt-5", 123.0, "manual").await;
    insert_model_price(&legacy, "legacy-only", 7.0, "manual").await;
    insert_model_price(&legacy, "current-custom", 999.0, "manual").await;
    insert_model_price(&current, "gpt-5", 1.25, "builtin").await;
    insert_model_price(&current, "current-custom", 42.0, "manual").await;

    let merged = merge_legacy_model_prices_once(&legacy, &current, &data_dir)
        .await
        .unwrap();

    assert_eq!(merged, 2);
    assert_eq!(
        read_model_price(&current, "gpt-5").await,
        (123.0, "manual".to_string())
    );
    assert_eq!(
        read_model_price(&current, "legacy-only").await,
        (7.0, "manual".to_string())
    );
    assert_eq!(
        read_model_price(&current, "current-custom").await,
        (42.0, "manual".to_string())
    );

    let mut conn = open_cli_manager_db(&current).await.unwrap();
    sqlx::query("DELETE FROM model_prices WHERE model = 'legacy-only'")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();

    assert_eq!(
        merge_legacy_model_prices_once(&legacy, &current, &data_dir)
            .await
            .unwrap(),
        0
    );
    let mut conn = open_cli_manager_db(&current).await.unwrap();
    let count: i64 =
        sqlx::query("SELECT COUNT(*) AS count FROM model_prices WHERE model = 'legacy-only'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("count")
            .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn defers_large_project_path_migration_with_original_checksum() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_project_path_backfill_schema(&mut conn).await;
    insert_usage_row(
        &mut conn,
        "legacy-1",
        "session_log",
        "codex",
        Some("session-1"),
        Some("demo"),
        None,
        1,
    )
    .await;

    assert!(defer_request_log_project_path_backfill(&mut conn)
        .await
        .unwrap());
    assert!(!defer_request_log_project_path_backfill(&mut conn)
        .await
        .unwrap());

    let row = sqlx::query("SELECT description, checksum FROM _sqlx_migrations WHERE version = ?1")
        .bind(MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION)
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(
        row.try_get::<String, _>("description").unwrap(),
        REQUEST_LOG_PROJECT_PATH_BACKFILL_DESCRIPTION
    );
    assert_eq!(
        row.try_get::<Vec<u8>, _>("checksum").unwrap(),
        migration_checksum(MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL)
    );
    let project_path: Option<String> =
        sqlx::query_scalar("SELECT project_path FROM usage_records WHERE record_id='legacy-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(
        project_path, None,
        "startup compatibility must not backfill rows"
    );
}

#[tokio::test]
async fn leaves_empty_or_incompatible_databases_to_standard_migrations() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_project_path_backfill_schema(&mut conn).await;
    assert!(!defer_request_log_project_path_backfill(&mut conn)
        .await
        .unwrap());

    let mut missing_schema = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut missing_schema).await;
    assert!(
        !defer_request_log_project_path_backfill(&mut missing_schema)
            .await
            .unwrap()
    );
}

#[test]
fn resolves_only_unambiguous_local_project_paths() {
    let projects = vec![
        BackfillProject {
            name: "demo".to_string(),
            path: "d:/work/demo".to_string(),
        },
        BackfillProject {
            name: "duplicate".to_string(),
            path: "d:/one/duplicate".to_string(),
        },
        BackfillProject {
            name: "duplicate".to_string(),
            path: "d:/two/duplicate".to_string(),
        },
    ];

    assert_eq!(
        resolve_backfill_project_path("demo", &projects).as_deref(),
        Some("d:/work/demo")
    );
    assert_eq!(resolve_backfill_project_path("duplicate", &projects), None);
    assert_eq!(
        resolve_backfill_project_path(r"C:\Work\Repo\", &projects).as_deref(),
        Some("c:/work/repo")
    );
}

#[tokio::test]
async fn backfills_large_legacy_sets_in_batches_and_inherits_route_paths() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_project_path_backfill_schema(&mut conn).await;
    sqlx::query(
        "INSERT INTO projects (id, name, path, environment_type) VALUES
         ('demo', 'demo', 'D:\\work\\demo', 'local'),
         ('dup-1', 'duplicate', 'D:\\one\\duplicate', 'local'),
         ('dup-2', 'duplicate', 'D:\\two\\duplicate', 'local'),
         ('remote', 'remote-only', '', 'ssh')",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "WITH RECURSIVE seq(value) AS (
             SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 50005
         )
         INSERT INTO usage_records (
             record_id, data_source, source, session_id, project_key,
             project_path, updated_at_ms, started_at_ms
         )
         SELECT 'demo-' || value, 'session_log', 'codex',
                CASE WHEN value = 1 THEN 'shared-session' ELSE 'session-' || value END,
                'demo', NULL, value, value
         FROM seq",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    insert_usage_row(
        &mut conn,
        "absolute",
        "session_log",
        "codex",
        Some("absolute-session"),
        Some(r"C:\Work\Repo"),
        None,
        5_000,
    )
    .await;
    insert_usage_row(
        &mut conn,
        "ambiguous",
        "session_log",
        "codex",
        Some("ambiguous-session"),
        Some("duplicate"),
        None,
        5_001,
    )
    .await;
    insert_usage_row(
        &mut conn,
        "route",
        "route",
        "codex",
        Some("shared-session"),
        None,
        None,
        5_002,
    )
    .await;
    insert_usage_row(
        &mut conn,
        "preexisting",
        "session_log",
        "codex",
        Some("preexisting-session"),
        Some("demo"),
        Some("keep/me"),
        5_003,
    )
    .await;

    let result = backfill_request_log_project_paths(&mut conn).await.unwrap();
    assert_eq!(result.mapped_project_keys, 2);
    assert_eq!(result.updated_rows, 50_007);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT project_path FROM usage_records WHERE record_id='demo-50005'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        "d:/work/demo"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT project_path FROM usage_records WHERE record_id='absolute'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        "c:/work/repo"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT project_path FROM usage_records WHERE record_id='route'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        "d:/work/demo"
    );
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT project_path FROM usage_records WHERE record_id='ambiguous'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        None
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT project_path FROM usage_records WHERE record_id='preexisting'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        "keep/me"
    );

    let rerun = backfill_request_log_project_paths(&mut conn).await.unwrap();
    assert_eq!(rerun.updated_rows, 0);
}

async fn create_migration_table(conn: &mut SqliteConnection) {
    conn.execute(
        "CREATE TABLE _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        )",
    )
    .await
    .unwrap();
}

async fn create_appearance_drift_schema(conn: &mut SqliteConnection, with_columns: bool) {
    let group_extra = if with_columns {
        ", icon TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT ''"
    } else {
        ""
    };
    conn.execute(
        format!("CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL{group_extra})")
            .as_str(),
    )
    .await
    .unwrap();
    conn.execute(
        format!("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL{group_extra})")
            .as_str(),
    )
    .await
    .unwrap();
}

async fn register_appearance_migration(conn: &mut SqliteConnection) {
    sqlx::query(
        "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
         VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
    )
    .bind(NODE_APPEARANCE_MIGRATION_VERSION)
    .bind(NODE_APPEARANCE_MIGRATION_DESCRIPTION)
    .bind(migration_checksum(NODE_APPEARANCE_MIGRATION_SQL))
    .execute(&mut *conn)
    .await
    .unwrap();
}

async fn create_group_binding_drift_schema(conn: &mut SqliteConnection, with_columns: bool) {
    let group_extra = if with_columns {
        ", bound_path TEXT NOT NULL DEFAULT ''"
    } else {
        ""
    };
    let project_extra = if with_columns {
        ", path_mode TEXT NOT NULL DEFAULT 'custom'"
    } else {
        ""
    };
    conn.execute(
        format!("CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL{group_extra})")
            .as_str(),
    )
    .await
    .unwrap();
    conn.execute(
        format!("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL{project_extra})")
            .as_str(),
    )
    .await
    .unwrap();
}

async fn create_ssh_attachment_drift_schema(conn: &mut SqliteConnection, with_column: bool) {
    let attachment_extra = if with_column {
        ", attachment_root TEXT NOT NULL DEFAULT ''"
    } else {
        ""
    };
    conn.execute(
        format!(
            "CREATE TABLE ssh_hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL{attachment_extra})"
        )
        .as_str(),
    )
    .await
    .unwrap();
}

async fn binding_migration_registered(conn: &mut SqliteConnection, version: i64) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version = ?1 AND success = 1)",
    )
    .bind(version)
    .fetch_one(conn)
    .await
    .unwrap()
        != 0
}

async fn register_legacy_node_appearance_v33_migration(conn: &mut SqliteConnection) {
    sqlx::query(
        "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
         VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
    )
    .bind(MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
    .bind(NODE_APPEARANCE_MIGRATION_DESCRIPTION)
    .bind(migration_checksum(NODE_APPEARANCE_MIGRATION_SQL))
    .execute(&mut *conn)
    .await
    .unwrap();
}

async fn appearance_columns(conn: &mut SqliteConnection) -> (HashSet<String>, HashSet<String>) {
    (
        table_columns(conn, "groups").await.unwrap(),
        table_columns(conn, "projects").await.unwrap(),
    )
}

#[tokio::test]
async fn appearance_repair_adds_columns_when_migration_registered_but_columns_missing() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_appearance_drift_schema(&mut conn, false).await;
    register_appearance_migration(&mut conn).await;

    assert!(ensure_node_appearance_columns(&mut conn).await.unwrap());
    let (groups, projects) = appearance_columns(&mut conn).await;
    assert!(groups.contains("icon") && groups.contains("color"));
    assert!(projects.contains("icon") && projects.contains("color"));

    // 幂等：第二次不再改动。
    assert!(!ensure_node_appearance_columns(&mut conn).await.unwrap());
}

#[tokio::test]
async fn group_binding_repair_adds_columns_and_registers_migrations() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_group_binding_drift_schema(&mut conn, false).await;

    assert!(ensure_group_binding_columns(&mut conn).await.unwrap());
    assert!(table_columns(&mut conn, "groups")
        .await
        .unwrap()
        .contains("bound_path"));
    assert!(table_columns(&mut conn, "projects")
        .await
        .unwrap()
        .contains("path_mode"));
    assert!(binding_migration_registered(&mut conn, MIGRATION_ADD_GROUP_BOUND_PATH_VERSION).await);
    assert!(binding_migration_registered(&mut conn, MIGRATION_ADD_PROJECT_PATH_MODE_VERSION).await);
    assert!(!ensure_group_binding_columns(&mut conn).await.unwrap());
}

#[tokio::test]
async fn group_binding_repair_registers_migrations_when_columns_exist() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_group_binding_drift_schema(&mut conn, true).await;

    assert!(ensure_group_binding_columns(&mut conn).await.unwrap());
    assert!(binding_migration_registered(&mut conn, MIGRATION_ADD_GROUP_BOUND_PATH_VERSION).await);
    assert!(binding_migration_registered(&mut conn, MIGRATION_ADD_PROJECT_PATH_MODE_VERSION).await);
    assert!(!ensure_group_binding_columns(&mut conn).await.unwrap());
}

#[tokio::test]
async fn ssh_attachment_root_repair_adds_column_and_registers_migration() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_ssh_attachment_drift_schema(&mut conn, false).await;

    assert!(ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
    assert!(table_columns(&mut conn, "ssh_hosts")
        .await
        .unwrap()
        .contains("attachment_root"));
    assert!(
        binding_migration_registered(&mut conn, MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION,).await
    );
    assert!(!ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
}

#[tokio::test]
async fn ssh_attachment_root_repair_handles_registered_and_preexisting_states() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_ssh_attachment_drift_schema(&mut conn, false).await;
    sqlx::query(
        "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
         VALUES (?1, ?2, CURRENT_TIMESTAMP, 1, ?3, 0)",
    )
    .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION)
    .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_DESCRIPTION)
    .bind(migration_checksum(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_SQL))
    .execute(&mut conn)
    .await
    .unwrap();

    // 版本已登记但列缺失时，只补列，不重复插入 migration 记录。
    assert!(ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
    assert!(table_columns(&mut conn, "ssh_hosts")
        .await
        .unwrap()
        .contains("attachment_root"));
    let registered_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ?1 AND success = 1",
    )
    .bind(MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION)
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(registered_count, 1);

    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_ssh_attachment_drift_schema(&mut conn, true).await;
    assert!(ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
    assert!(
        binding_migration_registered(&mut conn, MIGRATION_ADD_SSH_ATTACHMENT_ROOT_VERSION,).await
    );
    assert!(!ensure_ssh_attachment_root_column(&mut conn).await.unwrap());
}

#[tokio::test]
async fn appearance_repair_registers_migration_when_columns_exist_but_version_missing() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_appearance_drift_schema(&mut conn, true).await;

    assert!(ensure_node_appearance_columns(&mut conn).await.unwrap());
    let registered: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version = ?1 AND success = 1)",
    )
    .bind(NODE_APPEARANCE_MIGRATION_VERSION)
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(registered, 1);
    assert!(!ensure_node_appearance_columns(&mut conn).await.unwrap());
}

#[tokio::test]
async fn appearance_repair_applies_missing_columns_before_sqlx() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_appearance_drift_schema(&mut conn, false).await;

    // 列缺失且版本未登记 —— 先在数据库打开前补齐，避免首次外观写入撞缺列。
    assert!(ensure_node_appearance_columns(&mut conn).await.unwrap());
    let (groups, projects) = appearance_columns(&mut conn).await;
    assert!(groups.contains("icon") && groups.contains("color"));
    assert!(projects.contains("icon") && projects.contains("color"));
    let registered: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version = ?1 AND success = 1)",
    )
    .bind(NODE_APPEARANCE_MIGRATION_VERSION)
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(registered, 1);
    assert!(!ensure_node_appearance_columns(&mut conn).await.unwrap());
}

#[tokio::test]
async fn legacy_node_appearance_v33_migration_is_reconciled_before_sqlx_runs() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_appearance_drift_schema(&mut conn, true).await;
    register_legacy_node_appearance_v33_migration(&mut conn).await;

    assert!(reconcile_legacy_node_appearance_v33_migration(&mut conn)
        .await
        .unwrap());
    assert!(ensure_node_appearance_columns(&mut conn).await.unwrap());

    let usage_marker =
        sqlx::query("SELECT description, checksum FROM _sqlx_migrations WHERE version = ?1")
            .bind(MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(
        usage_marker.try_get::<String, _>("description").unwrap(),
        MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION
    );
    assert_eq!(
        usage_marker.try_get::<Vec<u8>, _>("checksum").unwrap(),
        migration_checksum(MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL)
    );

    let appearance_marker =
        sqlx::query("SELECT description, checksum FROM _sqlx_migrations WHERE version = ?1")
            .bind(NODE_APPEARANCE_MIGRATION_VERSION)
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(
        appearance_marker
            .try_get::<String, _>("description")
            .unwrap(),
        NODE_APPEARANCE_MIGRATION_DESCRIPTION
    );
    assert_eq!(
        appearance_marker.try_get::<Vec<u8>, _>("checksum").unwrap(),
        migration_checksum(NODE_APPEARANCE_MIGRATION_SQL)
    );

    let error_detail_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('usage_records') WHERE name = 'error_detail'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(error_detail_columns, 1);
}

async fn create_project_path_backfill_schema(conn: &mut SqliteConnection) {
    conn.execute(
        "CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            environment_type TEXT NOT NULL DEFAULT 'local'
        )",
    )
    .await
    .unwrap();
    conn.execute(
        "CREATE TABLE usage_records (
            record_id TEXT PRIMARY KEY,
            data_source TEXT NOT NULL,
            source TEXT NOT NULL,
            session_id TEXT,
            project_key TEXT,
            project_path TEXT,
            updated_at_ms INTEGER NOT NULL,
            started_at_ms INTEGER NOT NULL
        )",
    )
    .await
    .unwrap();
    conn.execute(
        "CREATE INDEX idx_usage_records_project
         ON usage_records(project_key, started_at_ms DESC)",
    )
    .await
    .unwrap();
    conn.execute(
        "CREATE INDEX idx_usage_records_route_dedup
         ON usage_records(source, data_source, session_id, started_at_ms)",
    )
    .await
    .unwrap();
}

#[allow(clippy::too_many_arguments)]
async fn insert_usage_row(
    conn: &mut SqliteConnection,
    record_id: &str,
    data_source: &str,
    source: &str,
    session_id: Option<&str>,
    project_key: Option<&str>,
    project_path: Option<&str>,
    timestamp: i64,
) {
    sqlx::query(
        "INSERT INTO usage_records (
            record_id, data_source, source, session_id, project_key,
            project_path, updated_at_ms, started_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    )
    .bind(record_id)
    .bind(data_source)
    .bind(source)
    .bind(session_id)
    .bind(project_key)
    .bind(project_path)
    .bind(timestamp)
    .execute(&mut *conn)
    .await
    .unwrap();
}

async fn create_user_data_db(path: &Path, projects: &[(&str, &str)]) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    conn.execute(
        "CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
    conn.execute(
        "CREATE TABLE groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
    conn.execute(
        "CREATE TABLE command_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
    for (id, name) in projects {
        sqlx::query("INSERT INTO projects (id, name) VALUES (?1, ?2)")
            .bind(id)
            .bind(name)
            .execute(&mut conn)
            .await
            .unwrap();
    }
    conn.close().await.unwrap();
}

async fn create_model_prices_table(path: &Path) {
    let mut conn = open_cli_manager_db(path).await.unwrap();
    conn.execute(
        "CREATE TABLE model_prices (
            model TEXT PRIMARY KEY,
            input_per_1m REAL NOT NULL DEFAULT 0,
            output_per_1m REAL NOT NULL DEFAULT 0,
            cache_read_per_1m REAL NOT NULL DEFAULT 0,
            cache_creation_per_1m REAL NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'manual',
            source_model_id TEXT,
            raw_json TEXT,
            updated_at_ms INTEGER NOT NULL DEFAULT 0,
            synced_at_ms INTEGER
        )",
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
}

async fn insert_model_price(path: &Path, model: &str, input: f64, source: &str) {
    let mut conn = open_cli_manager_db(path).await.unwrap();
    sqlx::query(
        "INSERT INTO model_prices (
            model, input_per_1m, output_per_1m, cache_read_per_1m,
            cache_creation_per_1m, source, updated_at_ms
         ) VALUES (?1, ?2, 10, 0, 0, ?3, 1)",
    )
    .bind(model)
    .bind(input)
    .bind(source)
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
}

async fn read_model_price(path: &Path, model: &str) -> (f64, String) {
    let mut conn = open_cli_manager_db(path).await.unwrap();
    let row = sqlx::query("SELECT input_per_1m, source FROM model_prices WHERE model = ?1")
        .bind(model)
        .fetch_one(&mut conn)
        .await
        .unwrap();
    (
        row.try_get("input_per_1m").unwrap(),
        row.try_get("source").unwrap(),
    )
}

async fn create_complete_feature_schema(conn: &mut SqliteConnection) {
    conn.execute(
        "CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            cli_args TEXT NOT NULL DEFAULT '',
            worktree_strategy TEXT NOT NULL DEFAULT 'disabled',
            worktree_root TEXT NOT NULL DEFAULT ''
        )",
    )
    .await
    .unwrap();
    conn.execute(
        "CREATE TABLE session_favorite_snapshots (
            session_key TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            source TEXT NOT NULL,
            project_key TEXT NOT NULL,
            file_path TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL,
            branch TEXT,
            detail_json TEXT NOT NULL,
            snapshot_at TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
    conn.execute(
        "CREATE TABLE worktrees (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            branch TEXT NOT NULL,
            path TEXT NOT NULL,
            base_branch TEXT NOT NULL DEFAULT '',
            deps_prompt_dismissed INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
}

async fn insert_migration_row(
    conn: &mut SqliteConnection,
    version: i64,
    description: &str,
    sql: &str,
) {
    sqlx::query(
        "INSERT INTO _sqlx_migrations
         (version, description, success, checksum, execution_time)
         VALUES (?1, ?2, TRUE, ?3, 0)",
    )
    .bind(version)
    .bind(description)
    .bind(migration_checksum(sql))
    .execute(conn)
    .await
    .unwrap();
}
