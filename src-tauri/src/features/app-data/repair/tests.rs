use super::*;
use sqlx::Executor;

#[test]
// 验证完整功能结构映射到当前五项迁移版本。
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
// 验证部分工作树结构会阻止迁移登记修复。
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
// 验证旧工作树分支的迁移顺序被重写为当前版本映射。
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
// 验证仅存在 CLI 参数列的旧库只移动对应登记，缺失功能留给 SQLx。
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
// 验证前端已创建的 SSH 分组结构补登记后仍可继续后续迁移。
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
// 验证内联快照补丁迁出到临时文件并替换为完整文件元数据。
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
// 验证当前版本清理标记存在时保留内联补丁且不创建补丁目录。
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
// 验证无快照表时版本清理仍写入当前版本完成标记。
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

// 创建只含快照载荷列的回放事件表，供快照瘦身测试复用。
async fn create_replay_events_table(conn: &mut SqliteConnection) {
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
}

// 插入一条指定类型的回放事件。
async fn insert_replay_event(conn: &mut SqliteConnection, kind: &str, payload: &Value) {
    sqlx::query(
        "INSERT INTO ai_replay_events (session_key, event_index, kind, payload_json)
         VALUES ('session-one', 1, ?1, ?2)",
    )
    .bind(kind)
    .bind(payload.to_string())
    .execute(&mut *conn)
    .await
    .unwrap();
}

// 读取指定行的回放事件载荷。
async fn replay_event_payload(conn: &mut SqliteConnection, id: i64) -> Value {
    let (payload_json,): (String,) =
        sqlx::query_as("SELECT payload_json FROM ai_replay_events WHERE id = ?1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    serde_json::from_str(&payload_json).unwrap()
}

#[tokio::test]
// 验证快照瘦身移除完整文件列表、截断变更文件名并保留回滚所需字段。
async fn slims_replay_snapshot_file_lists_and_keeps_rollback_fields() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_replay_events_table(&mut conn).await;
    let paths: Vec<String> = (0..25)
        .map(|index| format!("src/file-{index}.ts"))
        .collect();
    let files: Vec<Value> = paths
        .iter()
        .map(|path| serde_json::json!({ "path": path, "status": "M", "staged": false, "added": 1, "deleted": 0 }))
        .collect();
    insert_replay_event(
        &mut conn,
        "snapshot",
        &serde_json::json!({
            "head": "abc123",
            "projectPath": "F:/repo",
            "patchPath": "replay-snapshots/session-one/snapshot-1.patch",
            "patchTruncated": false,
            "files": files,
            "changedFiles": paths,
        }),
    )
    .await;
    insert_replay_event(
        &mut conn,
        "snapshot",
        &serde_json::json!({
            "head": "abc123",
            "files": [{ "path": "README.md", "status": "M", "staged": false, "added": 1, "deleted": 1 }],
        }),
    )
    .await;
    let small = serde_json::json!({ "head": "abc123", "changedFiles": ["a.ts"] });
    insert_replay_event(&mut conn, "snapshot", &small).await;
    let tool = serde_json::json!({ "files": ["kept"] });
    insert_replay_event(&mut conn, "tool", &tool).await;

    let slimmed = slim_replay_snapshot_payloads(&mut conn).await.unwrap();

    assert_eq!(slimmed, 2);
    let large = replay_event_payload(&mut conn, 1).await;
    assert!(large.get("files").is_none());
    assert_eq!(large["changedFiles"].as_array().unwrap().len(), 20);
    assert_eq!(large["changedFiles"][0], "src/file-0.ts");
    assert_eq!(large["fileCount"], 25);
    assert_eq!(large["changedFilesTruncated"], true);
    assert_eq!(large["head"], "abc123");
    assert_eq!(large["projectPath"], "F:/repo");
    assert_eq!(
        large["patchPath"],
        "replay-snapshots/session-one/snapshot-1.patch"
    );
    let derived = replay_event_payload(&mut conn, 2).await;
    assert!(derived.get("files").is_none());
    assert_eq!(derived["changedFiles"], serde_json::json!(["README.md"]));
    assert_eq!(derived["fileCount"], 1);
    assert!(derived.get("changedFilesTruncated").is_none());
    assert_eq!(replay_event_payload(&mut conn, 3).await, small);
    assert_eq!(replay_event_payload(&mut conn, 4).await, tool);
}

#[tokio::test]
// 验证快照瘦身仅执行一次：完成后写标记，标记存在时不再改动载荷。
async fn slims_replay_snapshots_once_per_marker() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_replay_events_table(&mut conn).await;
    let data_dir = tempfile::tempdir().unwrap();

    assert_eq!(
        slim_replay_snapshot_payloads_once(&mut conn, data_dir.path())
            .await
            .unwrap(),
        0
    );
    assert!(data_dir
        .path()
        .join(REPLAY_SNAPSHOT_SLIM_MARKER_FILE)
        .is_file());

    let payload = serde_json::json!({ "files": [{ "path": "a.ts" }] });
    insert_replay_event(&mut conn, "snapshot", &payload).await;
    assert_eq!(
        slim_replay_snapshot_payloads_once(&mut conn, data_dir.path())
            .await
            .unwrap(),
        0
    );
    assert_eq!(replay_event_payload(&mut conn, 1).await, payload);
}

// 创建只含保留清理所需列的回放会话表。
async fn create_replay_sessions_table(conn: &mut SqliteConnection) {
    conn.execute(
        "CREATE TABLE ai_replay_sessions (
            session_key TEXT PRIMARY KEY,
            updated_at TEXT NOT NULL
        )",
    )
    .await
    .unwrap();
}

// 插入指定会话与最后活动时间的回放会话及一条快照事件。
async fn insert_replay_session_with_snapshot(
    conn: &mut SqliteConnection,
    session_key: &str,
    updated_at: &str,
    payload: &Value,
) {
    sqlx::query("INSERT INTO ai_replay_sessions (session_key, updated_at) VALUES (?1, ?2)")
        .bind(session_key)
        .bind(updated_at)
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO ai_replay_events (session_key, event_index, kind, payload_json)
         VALUES (?1, 1, 'snapshot', ?2)",
    )
    .bind(session_key)
    .bind(payload.to_string())
    .execute(&mut *conn)
    .await
    .unwrap();
}

#[test]
// 验证保留截止时间与前端 toISOString 同格式且回退 7 天。
fn replay_retention_cutoff_matches_iso_format() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-11-26T08:30:00.123Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert_eq!(replay_retention_cutoff(now), "2026-11-19T08:30:00.123Z");
}

#[tokio::test]
// 验证过期会话连同事件与补丁文件被删除，活跃会话与越界路径保持不动。
async fn prunes_expired_replay_sessions_with_patch_files() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_replay_sessions_table(&mut conn).await;
    create_replay_events_table(&mut conn).await;
    let data_dir = tempfile::tempdir().unwrap();
    let patch_dir = data_dir.path().join(REPLAY_SNAPSHOT_PATCH_DIR);
    fs::create_dir_all(patch_dir.join("old")).unwrap();
    fs::create_dir_all(patch_dir.join("live")).unwrap();
    fs::write(patch_dir.join("old/a.patch"), "old").unwrap();
    fs::write(patch_dir.join("live/b.patch"), "live").unwrap();
    fs::write(data_dir.path().join("outside.patch"), "keep").unwrap();

    let old_payload = serde_json::json!({ "patchPath": "replay-snapshots/old/a.patch" });
    let live_payload = serde_json::json!({ "patchPath": "replay-snapshots/live/b.patch" });
    let escape_payload = serde_json::json!({ "patchPath": "replay-snapshots/../outside.patch" });
    insert_replay_session_with_snapshot(&mut conn, "old", "2026-11-01T00:00:00.000Z", &old_payload)
        .await;
    insert_replay_session_with_snapshot(
        &mut conn,
        "escape",
        "2026-11-02T00:00:00.000Z",
        &escape_payload,
    )
    .await;
    insert_replay_session_with_snapshot(
        &mut conn,
        "live",
        "2026-11-25T00:00:00.000Z",
        &live_payload,
    )
    .await;
    sqlx::query(
        "INSERT INTO ai_replay_events (session_key, event_index, kind, payload_json)
         VALUES ('old', 2, 'prompt', 'not-json')",
    )
    .execute(&mut conn)
    .await
    .unwrap();

    let pruned =
        prune_expired_replay_sessions(&mut conn, data_dir.path(), "2026-11-19T00:00:00.000Z")
            .await
            .unwrap();

    assert_eq!(pruned, 2);
    let sessions: Vec<String> = sqlx::query_scalar("SELECT session_key FROM ai_replay_sessions")
        .fetch_all(&mut conn)
        .await
        .unwrap();
    assert_eq!(sessions, vec!["live".to_string()]);
    let events: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT session_key FROM ai_replay_events")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    assert_eq!(events, vec!["live".to_string()]);
    assert!(!patch_dir.join("old").exists());
    assert!(patch_dir.join("live/b.patch").is_file());
    assert!(data_dir.path().join("outside.patch").is_file());
}

#[tokio::test]
// 验证缺少回放表的旧库直接跳过保留清理。
async fn replay_retention_skips_missing_tables() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    assert_eq!(
        prune_expired_replay_sessions(&mut conn, data_dir.path(), "2026-11-19T00:00:00.000Z")
            .await
            .unwrap(),
        0
    );
}

#[test]
// 验证主库整理同时要求空闲字节与空闲占比达到阈值。
fn cli_manager_db_vacuum_requires_free_bytes_and_ratio() {
    assert!(cli_manager_db_needs_vacuum(4096, 40_000, 10_000));
    assert!(!cli_manager_db_needs_vacuum(4096, 400_000, 10_000));
    assert!(!cli_manager_db_needs_vacuum(4096, 4_000, 2_000));
    assert!(!cli_manager_db_needs_vacuum(0, 40_000, 10_000));
}

#[tokio::test]
// 验证旧库有用户数据且当前库为空时恢复数据并备份当前库。
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
// 验证当前数据库已有用户数据时不被旧数据库覆盖。
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
// 验证旧自定义价格只替换内置价格，保留当前自定义值且迁移只执行一次。
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
// 验证延后大数据回填时登记原始 SQL 校验和而不修改历史行。
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
// 验证空数据库或缺少必要结构的数据库保留标准迁移流程。
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

#[tokio::test]
// 验证旧 providers 覆盖表存在时登记已移除的原型迁移，让迁移链能越过 v25。
async fn registers_removed_provider_prototype_migrations_for_legacy_providers_table() {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    create_providers_drift_table(&mut conn, false).await;

    assert!(reconcile_legacy_provider_prototype_drift(&mut conn)
        .await
        .unwrap());

    let legacy_checksum: Vec<u8> = sqlx::query_scalar(
        "SELECT checksum FROM _sqlx_migrations WHERE version = ?1 AND success = 1",
    )
    .bind(25)
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(
        legacy_checksum,
        migration_checksum(crate::provider::MIGRATION_LEGACY_PROVIDERS_SQL),
        "登记的 v25 必须沿用墓碑迁移的 SQL 校验和"
    );
    for version in [25, 26] {
        assert!(
            binding_migration_registered(&mut conn, version).await,
            "原型迁移 v{version} 应已登记"
        );
    }

    // 两者都已登记后不再重复修复。
    assert!(!reconcile_legacy_provider_prototype_drift(&mut conn)
        .await
        .unwrap());
}

#[tokio::test]
// 验证原型表已落库或不存在 providers 表时不介入，原型迁移留给标准迁移流程。
async fn does_not_intervene_for_prototype_or_absent_providers_tables() {
    let mut prototype_conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut prototype_conn).await;
    create_providers_drift_table(&mut prototype_conn, true).await;
    assert!(
        !reconcile_legacy_provider_prototype_drift(&mut prototype_conn)
            .await
            .unwrap()
    );
    assert!(!binding_migration_registered(&mut prototype_conn, 25).await);

    let mut missing_conn = SqliteConnection::connect(":memory:").await.unwrap();
    create_migration_table(&mut missing_conn).await;
    assert!(
        !reconcile_legacy_provider_prototype_drift(&mut missing_conn)
            .await
            .unwrap()
    );
    assert!(!binding_migration_registered(&mut missing_conn, 25).await);
}

#[test]
// 验证项目名只在唯一匹配时解析，绝对路径可直接归一化。
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
// 验证五万余条历史记录分批回填，传播会话路径并保留歧义和现有值。
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

// 在测试连接创建 SQLx 迁移登记表。
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

// 创建可选择包含外观列的项目与分组漂移测试结构。
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

// 向测试数据库登记当前外观迁移及其精确校验和。
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

// 创建可选择包含绑定路径和路径模式列的漂移测试结构。
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

// 创建可选择包含附件根列的 SSH 主机测试表。
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

// 创建可选择包含 app_type 列的 providers 漂移测试表；缺少该列即旧版覆盖表。
async fn create_providers_drift_table(conn: &mut SqliteConnection, with_app_type: bool) {
    let prototype_extra = if with_app_type {
        ", app_type TEXT NOT NULL DEFAULT ''"
    } else {
        ", category TEXT NOT NULL DEFAULT 'custom'"
    };
    conn.execute(
        format!(
            "CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL{prototype_extra})"
        )
        .as_str(),
    )
    .await
    .unwrap();
}

// 检查测试数据库中指定迁移是否已有成功登记。
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

// 将旧外观 SQL 以冲突的 v33 版本写入测试迁移登记。
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

// 读取测试项目和分组的列集合供外观修复断言。
async fn appearance_columns(conn: &mut SqliteConnection) -> (HashSet<String>, HashSet<String>) {
    (
        table_columns(conn, "groups").await.unwrap(),
        table_columns(conn, "projects").await.unwrap(),
    )
}

#[tokio::test]
// 验证外观版本已登记但列缺失时补列，并保持重复修复幂等。
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
// 验证分组绑定修复同时补列和登记迁移，重复执行无变化。
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
// 验证分组绑定列已存在时仅补迁移登记。
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
// 验证 SSH 附件根列和迁移登记同时缺失时一并修复。
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
// 验证项目代理配置列缺失修复在三类漂移状态下均幂等生效。
async fn project_proxy_config_repair_handles_missing_registered_and_preexisting_states() {
    // 1. 列与登记均缺失
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        .await
        .unwrap();
    assert!(ensure_project_proxy_config_column(&mut conn).await.unwrap());
    assert!(table_columns(&mut conn, "projects")
        .await
        .unwrap()
        .contains("proxy_config"));
    assert!(
        binding_migration_registered(&mut conn, MIGRATION_ADD_PROJECT_PROXY_CONFIG_VERSION).await
    );
    assert!(!ensure_project_proxy_config_column(&mut conn).await.unwrap());

    // 2. 版本已登记但列缺失
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        .await
        .unwrap();
    insert_migration_row(
        &mut conn,
        MIGRATION_ADD_PROJECT_PROXY_CONFIG_VERSION,
        MIGRATION_ADD_PROJECT_PROXY_CONFIG_DESCRIPTION,
        MIGRATION_ADD_PROJECT_PROXY_CONFIG_SQL,
    )
    .await;
    assert!(ensure_project_proxy_config_column(&mut conn).await.unwrap());
    assert!(table_columns(&mut conn, "projects")
        .await
        .unwrap()
        .contains("proxy_config"));
    assert!(!ensure_project_proxy_config_column(&mut conn).await.unwrap());

    // 3. 列已存在但版本未登记
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_migration_table(&mut conn).await;
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, proxy_config TEXT NOT NULL DEFAULT '')",
    )
    .await
    .unwrap();
    assert!(ensure_project_proxy_config_column(&mut conn).await.unwrap());
    assert!(
        binding_migration_registered(&mut conn, MIGRATION_ADD_PROJECT_PROXY_CONFIG_VERSION).await
    );
    assert!(!ensure_project_proxy_config_column(&mut conn).await.unwrap());
}

#[tokio::test]
// 验证 SSH 附件根修复兼容仅缺列或仅缺登记且不重复插入。
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
// 验证外观列已存在但版本缺失时只补迁移登记。
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
// 验证外观列和版本均缺失时在 SQLx 前完整补齐且保持幂等。
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
// 验证旧外观 v33 转为用量诊断登记，并补登记当前外观迁移和错误详情列。
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

// 创建项目路径回填所需的项目、用量表及索引。
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
// 向测试用量表插入指定来源、会话、项目路径和时间记录。
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

// 在临时路径创建用户数据测试库并插入指定项目。
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

// 在测试数据库创建模型价格表。
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

// 向测试数据库插入指定模型的输入价格与来源。
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

// 从测试数据库读取指定模型的输入价格与来源。
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

// 创建收藏快照、CLI 参数和工作树的完整迁移测试结构。
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

// 向测试迁移表插入指定版本、描述和 SQL 校验和。
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
