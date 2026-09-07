use super::*;

async fn create_legacy_source_instances_schema(conn: &mut SqliteConnection) {
    sqlx::query(
        "CREATE TABLE history_source_instances (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            environment_kind TEXT NOT NULL,
            environment_key TEXT NOT NULL,
            storage_kind TEXT NOT NULL,
            display_name TEXT,
            locations_json TEXT NOT NULL,
            settings_hash TEXT NOT NULL,
            activation_state TEXT NOT NULL DEFAULT 'pending',
            discovered INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    sqlx::query(
        "CREATE UNIQUE INDEX idx_history_source_instances_one_active
         ON history_source_instances(source_id)
         WHERE activation_state = 'active'",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    sqlx::query("PRAGMA user_version = 2")
        .execute(&mut *conn)
        .await
        .unwrap();
}

async fn assert_catalog_fk_support_indexes(conn: &mut SqliteConnection) {
    for index_name in [
        "idx_history_session_artifacts_session",
        "idx_history_session_relations_child",
        "idx_history_message_parts_message",
        "idx_history_tool_events_message",
        "idx_history_usage_events_session",
        "idx_history_file_changes_session",
        "idx_history_file_changes_message",
    ] {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = ?1",
        )
        .bind(index_name)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        assert_eq!(count, 1, "missing catalog index {index_name}");
    }
}

fn remote_sync_result() -> RemoteHistorySyncResult {
    serde_json::from_value(json!({
        "sourceInstanceId": "remote-instance",
        "source": "claude",
        "installationId": "installation-1",
        "remoteMachineId": "machine-1",
        "sshUser": "dev",
        "configuredConfigRoot": "$HOME/.claude",
        "canonicalConfigRoot": "/home/dev/.claude",
        "configRootHash": "root-hash",
        "generation": 1,
        "cursor": "1:1",
        "hasMore": false,
        "totalSessions": 1,
        "freshnessState": "fresh",
        "asOf": 100,
        "discoveryComplete": true,
        "partial": false,
        "sessions": [{
            "sessionRef": {
                "sourceId": "claude",
                "sourceInstanceId": "remote-instance",
                "sourceSessionId": "session-1",
                "transportKind": "ssh",
                "rawPointers": [{
                    "role": "transcript",
                    "kind": "claude-jsonl",
                    "rawKey": "projects/session-1.jsonl"
                }]
            },
            "projectKey": "project",
            "cwd": "/home/dev/project",
            "title": "Remote session",
            "branch": null,
            "createdAt": 10,
            "updatedAt": 20,
            "messageCount": 2,
            "dominantModel": "claude-sonnet",
            "currentModel": "claude-sonnet",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 5,
                "cacheReadTokens": 2,
                "cacheCreationTokens": 1
            },
            "usageFacts": [{
                "eventIndex": 0,
                "timestampMs": 20,
                "model": "claude-sonnet",
                "usage": {
                    "inputTokens": 10,
                    "outputTokens": 5,
                    "cacheReadTokens": 2,
                    "cacheCreationTokens": 1
                }
            }],
            "parserVersion": 1,
            "indexGeneration": 1,
            "materializationLevel": "summary"
        }],
        "tombstones": [],
        "warnings": []
    }))
    .unwrap()
}

#[test]
fn remote_catalog_busy_errors_use_stable_code() {
    assert_eq!(
        map_remote_catalog_error(
            "error returned from database: (code: 5) database is locked".to_string()
        ),
        "history_catalog_busy"
    );
    assert_eq!(
        map_remote_catalog_error("history_remote_identity_invalid".to_string()),
        "history_remote_identity_invalid"
    );
}

#[tokio::test]
async fn catalog_refresh_lock_serializes_all_roots() {
    let first_refresh = catalog_refresh_lock().lock().await;
    assert!(catalog_refresh_lock().try_lock().is_err());
    drop(first_refresh);
    assert!(catalog_refresh_lock().try_lock().is_ok());
}

#[test]
fn fts_literal_escapes_quotes() {
    assert_eq!(fts_literal("foo \"bar\""), "\"foo \"\"bar\"\"\"");
}

#[test]
fn fts_trigram_query_preserves_overlapping_literal_terms() {
    assert_eq!(
        fts_trigram_query("history"),
        "\"his\" AND \"ist\" AND \"sto\" AND \"tor\" AND \"ory\""
    );
    assert_eq!(fts_trigram_query("数据库"), "\"数据库\"");
}

#[test]
fn project_candidates_include_claude_key_and_basename() {
    let (_cwd, keys, basename) = project_candidates(r"D:\work\pythonProject\CLI-Manager");
    assert!(keys.iter().any(|key| key.contains("cli-manager")));
    assert_eq!(basename.as_deref(), Some("cli-manager"));
}

#[test]
fn catalog_scope_rejects_native_codex_entry_for_wsl_roots() {
    let roots = HistoryRoots {
        claude_config_dir: None,
        codex_config_dir: Some(PathBuf::from(
            r"\\wsl.localhost\Ubuntu-22.04\home\dministrator\.codex",
        )),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let wsl_file =
        r"\\wsl.localhost\Ubuntu-22.04\home\dministrator\.codex\sessions\2026\07\14\rollout.jsonl";
    let native_file = r"\\?\C:\Users\Administrator\.codex\sessions\2026\07\02\rollout.jsonl";

    assert!(catalog_path_within_roots("codex", wsl_file, &roots));
    assert!(!catalog_path_within_roots("codex", native_file, &roots));
}

#[test]
fn collect_catalog_files_includes_kimi_main_wire_and_skips_subagents() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let home = temp_dir.path().join(".kimi-code");
    let session_id = "01KIMICATALOGFILE000000001";
    let session_dir = home.join("sessions").join("wd__fixture").join(session_id);
    let wire = session_dir.join("agents").join("main").join("wire.jsonl");
    std::fs::create_dir_all(wire.parent().unwrap()).unwrap();
    std::fs::write(
        &wire,
        "{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"hello\"}]}\n",
    )
    .unwrap();
    std::fs::write(
        session_dir.join("state.json"),
        r#"{"id":"01KIMICATALOGFILE000000001","title":"Kimi summary","cwd":"/tmp/cli-manager"}"#,
    )
    .unwrap();
    std::fs::create_dir_all(session_dir.join("agents").join("agent-0")).unwrap();
    std::fs::write(
        session_dir
            .join("agents")
            .join("agent-0")
            .join("wire.jsonl"),
        "{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"subagent\"}]}\n",
    )
    .unwrap();

    let roots = HistoryRoots {
        claude_config_dir: Some(temp_dir.path().join("missing-claude")),
        codex_config_dir: Some(temp_dir.path().join("missing-codex")),
        grok_session_root: Some(temp_dir.path().join("missing-grok")),
        kimi_config_dir: Some(home),
    };
    let kimi_files: Vec<_> = collect_catalog_files(&roots)
        .into_iter()
        .filter(|file| file.file_ref.source == "kimi")
        .collect();
    assert_eq!(kimi_files.len(), 1);
    assert_eq!(kimi_files[0].file_ref.path, wire);
    assert!(catalog_path_within_roots(
        "kimi",
        &wire.to_string_lossy(),
        &roots,
    ));
}

#[test]
fn catalog_scope_accepts_canonical_native_entry() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let codex_dir = temp_dir.path().join(".codex");
    let file = codex_dir.join("sessions").join("rollout.jsonl");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"{}\n").unwrap();
    let roots = HistoryRoots {
        claude_config_dir: None,
        codex_config_dir: Some(codex_dir),
        grok_session_root: None,
        kimi_config_dir: None,
    };

    assert!(catalog_path_within_roots(
        "codex",
        &file.canonicalize().unwrap().to_string_lossy(),
        &roots,
    ));
}

#[tokio::test]
async fn schema_triggers_populate_trigram_search() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    sqlx::query(
        "INSERT INTO history_catalog_messages(
            roots_key, file_path, message_index, role, timestamp, content
         ) VALUES ('roots', 'session.jsonl', 0, 'user', NULL, '历史会话 searchCatalog')",
    )
    .execute(&mut conn)
    .await
    .unwrap();

    let chinese: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_catalog_messages_fts
         WHERE history_catalog_messages_fts MATCH ?1",
    )
    .bind(fts_trigram_query("历史会话"))
    .fetch_one(&mut conn)
    .await
    .unwrap();
    let code: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_catalog_messages_fts
         WHERE history_catalog_messages_fts MATCH ?1",
    )
    .bind(fts_trigram_query("Catalog"))
    .fetch_one(&mut conn)
    .await
    .unwrap();

    assert_eq!(chinese, 1);
    assert_eq!(code, 1);
}

#[tokio::test]
async fn schema_v5_upgrade_rebuilds_compact_fts_without_losing_messages() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    sqlx::query(
        "INSERT INTO history_catalog_messages(
            roots_key, file_path, message_index, role, timestamp, content
         ) VALUES ('roots', 'session.jsonl', 0, 'user', NULL,
                   'history-catalog 数据库压缩测试')",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query("DROP TRIGGER history_catalog_messages_ai")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER history_catalog_messages_ad")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER history_catalog_messages_au")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("DROP TABLE history_catalog_messages_fts")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query(
        "CREATE VIRTUAL TABLE history_catalog_messages_fts USING fts5(
            content,
            content='history_catalog_messages',
            content_rowid='id',
            tokenize='trigram case_sensitive 0'
        )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_catalog_messages_fts(history_catalog_messages_fts) VALUES ('rebuild')",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query("PRAGMA user_version = 5")
        .execute(&mut conn)
        .await
        .unwrap();

    ensure_schema(&mut conn).await.unwrap();

    let detail: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master
         WHERE name = 'history_catalog_messages_fts'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert!(detail.contains("detail='none'"));
    let content: String =
        sqlx::query_scalar("SELECT content FROM history_catalog_messages WHERE id = 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(content, "history-catalog 数据库压缩测试");
    let english: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_catalog_messages_fts
         WHERE history_catalog_messages_fts MATCH ?1",
    )
    .bind(fts_trigram_query("history"))
    .fetch_one(&mut conn)
    .await
    .unwrap();
    let chinese: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_catalog_messages_fts
         WHERE history_catalog_messages_fts MATCH ?1",
    )
    .bind(fts_trigram_query("数据库"))
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(english, 1);
    assert_eq!(chinese, 1);
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(version, HISTORY_INDEX_SCHEMA_VERSION);
}

#[tokio::test]
async fn current_version_rebuilds_legacy_fts_schema() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    for trigger in [
        "history_catalog_messages_ai",
        "history_catalog_messages_ad",
        "history_catalog_messages_au",
        "history_messages_ai",
        "history_messages_ad",
        "history_messages_au",
    ] {
        sqlx::query(&format!("DROP TRIGGER {trigger}"))
            .execute(&mut conn)
            .await
            .unwrap();
    }
    for (table, column, source_table) in [
        (
            "history_catalog_messages_fts",
            "content",
            "history_catalog_messages",
        ),
        (
            "history_messages_fts",
            "display_content",
            "history_messages",
        ),
    ] {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(&format!(
            "CREATE VIRTUAL TABLE {table} USING fts5(
                {column}, content='{source_table}', content_rowid='id',
                tokenize='trigram case_sensitive 0'
            )"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
    }
    sqlx::query("PRAGMA user_version = 6")
        .execute(&mut conn)
        .await
        .unwrap();

    ensure_schema(&mut conn).await.unwrap();

    for table in ["history_catalog_messages_fts", "history_messages_fts"] {
        let sql: String =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1")
                .bind(table)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert!(sql.contains("detail='none'"));
    }
}

#[tokio::test]
async fn schema_upgrades_legacy_source_instances_before_creating_scoped_index() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_legacy_source_instances_schema(&mut conn).await;
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-default', 'claude', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();

    ensure_schema(&mut conn).await.unwrap();
    ensure_schema(&mut conn).await.unwrap();

    let upgraded: (String, String, String) = sqlx::query_as(
        "SELECT scope_kind, scope_key, transport_kind
         FROM history_source_instances WHERE id = 'claude-default'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(
        upgraded,
        (
            "configured".to_string(),
            "desktop".to_string(),
            "local".to_string(),
        )
    );

    let scoped_index: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_history_source_instances_active_scope'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(scoped_index, 1);

    let duplicate = sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-duplicate', 'claude', 'windows', 'windows', 'file',
            '{}', 'duplicate', 'active', 2, 2
         )",
    )
    .execute(&mut conn)
    .await;
    assert!(duplicate.is_err());
}

#[tokio::test]
async fn concurrent_catalog_opens_serialize_legacy_schema_upgrade() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("history-catalog.db");
    let mut legacy = SqliteConnection::connect_with(&catalog_connect_options(&path))
        .await
        .unwrap();
    create_legacy_source_instances_schema(&mut legacy).await;
    legacy.close().await.unwrap();

    let (first, second) = tokio::join!(open_catalog_once(&path), open_catalog_once(&path));
    let mut first = first.unwrap();
    let second = second.unwrap();

    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut first)
        .await
        .unwrap();
    assert_eq!(user_version, HISTORY_INDEX_SCHEMA_VERSION);
    let scope_kind: String = sqlx::query_scalar(
        "SELECT name FROM pragma_table_info('history_source_instances')
         WHERE name = 'scope_kind'",
    )
    .fetch_one(&mut first)
    .await
    .unwrap();
    assert_eq!(scope_kind, "scope_kind");

    first.close().await.unwrap();
    second.close().await.unwrap();
}

#[tokio::test]
async fn schema_version_does_not_advance_when_metadata_update_fails() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    create_legacy_source_instances_schema(&mut conn).await;
    sqlx::query(
        "CREATE TABLE history_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_history_meta_insert
         BEFORE INSERT ON history_meta
         BEGIN
            SELECT RAISE(ABORT, 'metadata blocked');
         END",
    )
    .execute(&mut conn)
    .await
    .unwrap();

    let error = ensure_schema(&mut conn).await.unwrap_err();
    assert!(error.contains("metadata blocked"));
    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(user_version, 2);
}

#[tokio::test]
async fn schema_creates_v2_history_index_tables() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();

    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(user_version, HISTORY_INDEX_SCHEMA_VERSION);

    let schema_version: String =
        sqlx::query_scalar("SELECT value FROM history_meta WHERE key = 'schema_version'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(schema_version, HISTORY_INDEX_SCHEMA_VERSION.to_string());

    let session_table: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name = 'history_sessions'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(session_table, 1);
    assert_catalog_fk_support_indexes(&mut conn).await;

    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-default', 'claude', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, title,
            created_at, updated_at, fingerprint_kind, fingerprint_value,
            parser_version, model_version, parse_status, last_seen_generation, indexed_at
         ) VALUES (
            'claude-default', 'session-1', 'file', 'Session',
            1, 1, 'mtime-size', 'fp', 1, 1, 'ok', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_messages(session_id, message_index, role, display_content)
         VALUES (1, 0, 'user', 'v2 历史索引 schema')",
    )
    .execute(&mut conn)
    .await
    .unwrap();

    let fts_hits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_messages_fts
         WHERE history_messages_fts MATCH ?1",
    )
    .bind(fts_trigram_query("历史索引"))
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(fts_hits, 1);
}

#[tokio::test]
async fn schema_upgrade_adds_catalog_fk_support_indexes() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    for index_name in [
        "idx_history_session_artifacts_session",
        "idx_history_session_relations_child",
        "idx_history_message_parts_message",
        "idx_history_tool_events_message",
        "idx_history_usage_events_session",
        "idx_history_file_changes_session",
        "idx_history_file_changes_message",
    ] {
        sqlx::query(&format!("DROP INDEX {index_name}"))
            .execute(&mut conn)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE history_meta SET value = '3' WHERE key = 'schema_version'")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("PRAGMA user_version = 3")
        .execute(&mut conn)
        .await
        .unwrap();

    ensure_schema(&mut conn).await.unwrap();

    let schema_version: String =
        sqlx::query_scalar("SELECT value FROM history_meta WHERE key = 'schema_version'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(schema_version, HISTORY_INDEX_SCHEMA_VERSION.to_string());
    assert_catalog_fk_support_indexes(&mut conn).await;
}

#[tokio::test]
async fn shadow_v2_source_selection_excludes_ssh_instances() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    for (id, scope_kind, transport_kind) in [
        ("codex-local", "configured", "local"),
        ("codex-wsl", "configured", "wsl"),
        ("codex-ssh", "ssh", "ssh"),
    ] {
        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state,
                scope_kind, scope_key, transport_kind,
                created_at, updated_at
             ) VALUES (?1, 'codex', ?3, ?1, 'file', '{}', ?1, 'active', ?2, ?1, ?3, 1, 1)",
        )
        .bind(id)
        .bind(scope_kind)
        .bind(transport_kind)
        .execute(&mut conn)
        .await
        .unwrap();
    }

    let instances = active_v2_source_instances(&mut conn).await.unwrap();
    let mut ids = instances
        .into_iter()
        .map(|instance| instance.id)
        .collect::<Vec<_>>();
    ids.sort();

    assert_eq!(
        ids,
        vec!["codex-local".to_string(), "codex-wsl".to_string()]
    );
}

#[tokio::test]
async fn source_activation_scope_allows_local_and_multiple_ssh_instances() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    for (id, environment_kind, scope_kind, scope_key, transport_kind) in [
        ("claude-local", "windows", "configured", "desktop", "local"),
        ("claude-ssh-a", "ssh", "ssh", "machine-a:user:root", "ssh"),
        ("claude-ssh-b", "ssh", "ssh", "machine-b:user:root", "ssh"),
    ] {
        sqlx::query(
            "INSERT INTO history_source_instances(
                id, source_id, environment_kind, environment_key, storage_kind,
                locations_json, settings_hash, activation_state,
                scope_kind, scope_key, transport_kind,
                created_at, updated_at
             ) VALUES (?1, 'claude', ?2, ?1, 'file', '{}', ?1, 'active', ?3, ?4, ?5, 1, 1)",
        )
        .bind(id)
        .bind(environment_kind)
        .bind(scope_kind)
        .bind(scope_key)
        .bind(transport_kind)
        .execute(&mut conn)
        .await
        .unwrap();
    }
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_source_instances
         WHERE source_id = 'claude' AND activation_state = 'active'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(active, 3);

    let duplicate = sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state,
            scope_kind, scope_key, transport_kind,
            created_at, updated_at
         ) VALUES ('claude-ssh-a-duplicate', 'claude', 'ssh', 'duplicate', 'file',
            '{}', 'duplicate', 'active', 'ssh', 'machine-a:user:root', 'ssh', 1, 1)",
    )
    .execute(&mut conn)
    .await;
    assert!(duplicate.is_err());
}

#[tokio::test]
async fn remote_sync_rejects_existing_source_instance_identity_change() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let result = remote_sync_result();
    apply_remote_sync_with_conn(&mut conn, "host-1", &result)
        .await
        .unwrap();
    apply_remote_sync_with_conn(&mut conn, "host-2", &result)
        .await
        .unwrap();

    let mut changed = result;
    changed.remote_machine_id = "machine-2".to_string();
    assert_eq!(
        apply_remote_sync_with_conn(&mut conn, "host-3", &changed)
            .await
            .unwrap_err(),
        "history_remote_identity_changed"
    );
}

#[tokio::test]
async fn remote_sync_accepts_agent_installation_rotation_for_same_source_instance() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let result = remote_sync_result();
    apply_remote_sync_with_conn(&mut conn, "host-1", &result)
        .await
        .unwrap();

    let mut rotated = result;
    rotated.installation_id = "installation-2".to_string();
    assert!(apply_remote_sync_with_conn(&mut conn, "host-2", &rotated)
        .await
        .unwrap());

    let identity_json: String = sqlx::query_scalar(
        "SELECT remote_identity_json FROM history_source_instances WHERE id = ?1",
    )
    .bind(&rotated.source_instance_id)
    .fetch_one(&mut conn)
    .await
    .unwrap();
    let identity: Value = serde_json::from_str(&identity_json).unwrap();
    assert_eq!(identity["installationId"], "installation-2");
    assert_eq!(identity["hostId"], "host-2");
}

#[tokio::test]
async fn remote_sync_ignores_older_generation_and_cursor() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let mut current = remote_sync_result();
    current.generation = 2;
    current.cursor = "2:20".to_string();
    current.sessions[0].index_generation = 2;
    current.sessions[0].title = "current".to_string();
    assert!(apply_remote_sync_with_conn(&mut conn, "host-1", &current)
        .await
        .unwrap());

    let mut stale_generation = remote_sync_result();
    stale_generation.cursor = "1:100".to_string();
    stale_generation.sessions[0].title = "stale-generation".to_string();
    assert!(
        !apply_remote_sync_with_conn(&mut conn, "host-1", &stale_generation)
            .await
            .unwrap()
    );

    let mut stale_cursor = current.clone();
    stale_cursor.cursor = "2:10".to_string();
    stale_cursor.sessions[0].title = "stale-cursor".to_string();
    assert!(
        !apply_remote_sync_with_conn(&mut conn, "host-1", &stale_cursor)
            .await
            .unwrap()
    );

    let state: (i64, String, String) = sqlx::query_as(
        "SELECT state.generation, instance.sync_cursor_json, session.title
         FROM history_source_state AS state
         JOIN history_source_instances AS instance ON instance.id = state.source_instance_id
         JOIN history_sessions AS session ON session.source_instance_id = instance.id
         WHERE instance.id = 'remote-instance' AND session.source_session_id = 'session-1'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(state, (2, "2:20".to_string(), "current".to_string()));
}

#[tokio::test]
async fn remote_summary_sync_removes_persisted_message_and_fts_rows() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let result = remote_sync_result();
    apply_remote_sync_with_conn(&mut conn, "host-1", &result)
        .await
        .unwrap();
    let session_id: i64 = sqlx::query_scalar(
        "SELECT id FROM history_sessions
         WHERE source_instance_id = 'remote-instance' AND source_session_id = 'session-1'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_messages(session_id, message_index, role, display_content)
         VALUES (?1, 0, 'user', 'must not persist')",
    )
    .bind(session_id)
    .execute(&mut conn)
    .await
    .unwrap();

    apply_remote_sync_with_conn(&mut conn, "host-1", &result)
        .await
        .unwrap();
    let messages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM history_messages WHERE session_id = ?1")
            .bind(session_id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let fts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_messages_fts")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    let usage: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_usage_events")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!((messages, fts, usage), (0, 0, 1));
}

#[tokio::test]
async fn remote_sync_rejects_total_session_count_overflow() {
    if usize::BITS <= 63 {
        return;
    }
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let mut result = remote_sync_result();
    result.total_sessions = usize::MAX;
    assert_eq!(
        apply_remote_sync_with_conn(&mut conn, "host-1", &result)
            .await
            .unwrap_err(),
        "history_remote_numeric_overflow"
    );
}

#[tokio::test]
async fn schema_initialization_uses_user_version_fast_path() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    sqlx::query("UPDATE history_meta SET updated_at = 7 WHERE key = 'schema_version'")
        .execute(&mut conn)
        .await
        .unwrap();

    ensure_schema(&mut conn).await.unwrap();

    let updated_at: i64 =
        sqlx::query_scalar("SELECT updated_at FROM history_meta WHERE key = 'schema_version'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(updated_at, 7);
}

#[tokio::test]
async fn list_sessions_merges_v2_first_and_legacy_gaps() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp_dir = tempfile::TempDir::new().unwrap();
    let claude_root = temp_dir.path().join(".claude");
    let roots = HistoryRoots {
        claude_config_dir: Some(claude_root.clone()),
        codex_config_dir: None,
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let roots_key = roots.cache_key();
    let v2_file = claude_root
        .join("projects")
        .join("proj")
        .join("session-v2.jsonl");
    let legacy_file = claude_root
        .join("projects")
        .join("proj")
        .join("session-legacy.jsonl");

    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-default', 'claude', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            project_key, cwd, cwd_normalized, title, created_at, updated_at,
            message_count, fingerprint_kind, fingerprint_value, parser_version,
            model_version, parse_status, last_seen_generation, indexed_at
         ) VALUES (
            'claude-default', 'session-v2', 'file', ?1,
            'proj', 'C:/work/proj', 'c:/work/proj', 'v2 title', 10, 30,
            2, 'file-stat', 'fp', 1, 1, 'ok', 1, 1
         )",
    )
    .bind(v2_file.to_string_lossy().to_string())
    .execute(&mut conn)
    .await
    .unwrap();
    for (file, session_id, title, updated_at) in [
        (&v2_file, "session-v2", "legacy duplicate", 20_i64),
        (&legacy_file, "session-legacy", "legacy only", 25_i64),
    ] {
        sqlx::query(
            "INSERT INTO history_catalog_sessions(
                roots_key, file_path, source, project_key, cwd, cwd_normalized,
                session_id, title, branch, created_at, updated_at, message_count,
                file_created_at, file_updated_at, file_size, parser_version, indexed_at
             ) VALUES (?1, ?2, 'claude', 'proj', 'C:/work/proj', 'c:/work/proj',
                ?3, ?4, NULL, 10, ?5, 1, 10, ?5, 1, ?6, 30)",
        )
        .bind(&roots_key)
        .bind(file.to_string_lossy().to_string())
        .bind(session_id)
        .bind(title)
        .bind(updated_at)
        .bind(CATALOG_PARSER_VERSION)
        .execute(&mut conn)
        .await
        .unwrap();
    }

    let v2 = list_sessions_from_v2(&mut conn, &roots, None, None, None, Some(10), Some(0))
        .await
        .unwrap();
    let legacy =
        list_sessions_from_legacy_catalog(&mut conn, &roots, None, None, None, Some(10), Some(0))
            .await
            .unwrap();
    let sessions = merge_session_summaries(v2, legacy, Some(10), Some(0));

    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].title, "v2 title");
    assert_eq!(sessions[1].title, "legacy only");
}

#[tokio::test]
async fn search_sessions_merges_v2_first_and_legacy_gaps() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp_dir = tempfile::TempDir::new().unwrap();
    let claude_root = temp_dir.path().join(".claude");
    let roots = HistoryRoots {
        claude_config_dir: Some(claude_root.clone()),
        codex_config_dir: None,
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let roots_key = roots.cache_key();
    let v2_file = claude_root
        .join("projects")
        .join("proj")
        .join("search-v2.jsonl");
    let legacy_file = claude_root
        .join("projects")
        .join("proj")
        .join("search-legacy.jsonl");

    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-default', 'claude', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    let result = sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            project_key, title, created_at, updated_at, message_count,
            fingerprint_kind, fingerprint_value, parser_version, model_version,
            parse_status, last_seen_generation, indexed_at
         ) VALUES (
            'claude-default', 'search-v2', 'file', ?1,
            'proj', 'v2 search', 10, 30, 1,
            'file-stat', 'fp', 1, 1, 'ok', 1, 1
         )",
    )
    .bind(v2_file.to_string_lossy().to_string())
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_messages(
            session_id, message_index, role, display_content, timestamp_ms
         ) VALUES (?1, 0, 'user', 'needle from v2', 1000)",
    )
    .bind(result.last_insert_rowid())
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_catalog_sessions(
            roots_key, file_path, source, project_key, cwd, cwd_normalized,
            session_id, title, branch, created_at, updated_at, message_count,
            file_created_at, file_updated_at, file_size, parser_version, indexed_at
         ) VALUES (?1, ?2, 'claude', 'proj', NULL, NULL,
            'search-legacy', 'legacy search', NULL, 10, 20, 1,
            10, 20, 1, ?3, 30)",
    )
    .bind(&roots_key)
    .bind(legacy_file.to_string_lossy().to_string())
    .bind(CATALOG_PARSER_VERSION)
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_catalog_messages(
            roots_key, file_path, message_index, role, timestamp, content
         ) VALUES (?1, ?2, 0, 'user', NULL, 'needle from legacy')",
    )
    .bind(&roots_key)
    .bind(legacy_file.to_string_lossy().to_string())
    .execute(&mut conn)
    .await
    .unwrap();

    let v2 = search_sessions_from_v2(&mut conn, &roots, "needle", None, None, 10)
        .await
        .unwrap();
    let legacy = search_sessions_from_legacy_catalog(&mut conn, &roots, "needle", None, None, 10)
        .await
        .unwrap();
    let hits = merge_search_results(v2, legacy, 10);

    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].session_id, "search-v2");
    assert_eq!(hits[1].session_id, "search-legacy");
}

#[tokio::test]
async fn stats_session_facts_reads_all_active_v2_sources() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp_dir = tempfile::TempDir::new().unwrap();
    let claude_root = temp_dir.path().join(".claude");
    let roots = HistoryRoots {
        claude_config_dir: Some(claude_root.clone()),
        codex_config_dir: None,
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let file = claude_root
        .join("projects")
        .join("proj")
        .join("stats-v2.jsonl");

    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-default', 'claude', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'gemini-custom', 'gemini', 'windows', 'windows', 'file',
            '{\"configRoot\":\"D:/custom-gemini\"}', 'gemini-settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'codex-stats', 'codex', 'windows', 'windows', 'file',
            '{}', 'codex-settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    let gemini_result = sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            project_key, cwd, cwd_normalized, title, created_at, updated_at,
            message_count, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, fingerprint_kind, fingerprint_value, parser_version,
            model_version, parse_status, last_seen_generation, indexed_at
         ) VALUES (
            'gemini-custom', 'gemini-v2', 'file', 'D:/custom-gemini/session.json',
            'gemini-proj', 'D:/work/gemini', 'd:/work/gemini', 'Gemini stats', 10, 30,
            1, 7, 4, 0, 0, 'file-stat', 'gemini-fp', 1, 1, 'ok', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_usage_events(
            session_id, event_index, timestamp_ms, model, input_tokens,
            output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
         ) VALUES (?1, 0, 2000, 'gemini-2.5-pro', 7, 4, 0, 0, 0)",
    )
    .bind(gemini_result.last_insert_rowid())
    .execute(&mut conn)
    .await
    .unwrap();
    let codex_result = sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            project_key, cwd, cwd_normalized, title, created_at, updated_at,
            message_count, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, fingerprint_kind, fingerprint_value, parser_version,
            model_version, parse_status, last_seen_generation, indexed_at
         ) VALUES (
            'codex-stats', 'codex-v2', 'file', 'D:/codex/session.jsonl',
            'codex-proj', 'D:/work/codex', 'd:/work/codex', 'Codex stats', 10, 30,
            1, 9, 2, 3, 0, 'file-stat', 'codex-fp', 1, 1, 'ok', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_usage_events(
            session_id, event_index, timestamp_ms, model, input_tokens,
            output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
         ) VALUES (?1, 0, 2000, 'gpt-5.4', 9, 2, 3, 0, 0)",
    )
    .bind(codex_result.last_insert_rowid())
    .execute(&mut conn)
    .await
    .unwrap();
    let result = sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            project_key, cwd, cwd_normalized, title, created_at, updated_at,
            message_count, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, fingerprint_kind, fingerprint_value, parser_version,
            model_version, parse_status, last_seen_generation, indexed_at
         ) VALUES (
            'claude-default', 'stats-v2', 'file', ?1,
            'proj', 'C:/work/proj', 'c:/work/proj', 'v2 stats', 10, 30,
            2, 10, 5, 3, 2, 'file-stat', 'fp', 1, 1, 'ok', 1, 1
         )",
    )
    .bind(file.to_string_lossy().to_string())
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_usage_events(
            session_id, event_index, timestamp_ms, model, input_tokens,
            output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
         ) VALUES (?1, 0, 1000, 'claude-sonnet-4-5', 10, 5, 3, 2, 0)",
    )
    .bind(result.last_insert_rowid())
    .execute(&mut conn)
    .await
    .unwrap();

    let facts = stats_session_facts_from_v2(&mut conn, &roots, None, None, &[], None)
        .await
        .unwrap();

    assert_eq!(facts.len(), 3);
    let claude = facts
        .iter()
        .find(|fact| fact.summary.session_id == "stats-v2")
        .unwrap();
    assert_eq!(claude.occurred_at, 1000);
    assert_eq!(claude.stats.input_tokens, 10);
    assert_eq!(claude.stats.output_tokens, 5);
    assert_eq!(claude.stats.cache_read_tokens, 3);
    assert_eq!(claude.stats.cache_creation_tokens, 2);
    let gemini = facts
        .iter()
        .find(|fact| fact.summary.session_id == "gemini-v2")
        .unwrap();
    assert_eq!(gemini.summary.source, "gemini");
    assert_eq!(gemini.stats.input_tokens, 7);
    let codex = facts
        .iter()
        .find(|fact| fact.summary.session_id == "codex-v2")
        .unwrap();
    assert_eq!(codex.occurred_at, 2000);

    let codex_only =
        stats_session_facts_from_v2(&mut conn, &roots, None, None, &[], Some("codex-stats"))
            .await
            .unwrap();
    assert_eq!(codex_only.len(), 1);
    assert_eq!(codex_only[0].summary.session_id, "codex-v2");

    let all_source = stats_session_facts_from_v2(&mut conn, &roots, Some("all"), None, &[], None)
        .await
        .unwrap();
    assert_eq!(all_source.len(), 3);

    let codex_source =
        stats_session_facts_from_v2(&mut conn, &roots, Some("codex"), None, &[], None)
            .await
            .unwrap();
    assert_eq!(codex_source.len(), 1);
    assert_eq!(codex_source[0].summary.session_id, "codex-v2");
}

#[tokio::test]
async fn get_session_detail_from_v2_rehydrates_messages_tools_and_changes() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp_dir = tempfile::TempDir::new().unwrap();
    let claude_root = temp_dir.path().join(".claude");
    let roots = HistoryRoots {
        claude_config_dir: Some(claude_root.clone()),
        codex_config_dir: None,
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let file = claude_root
        .join("projects")
        .join("proj")
        .join("detail-v2.jsonl");
    let file_path = file.to_string_lossy().to_string();

    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-default', 'claude', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    let session_result = sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            project_key, cwd, cwd_normalized, title, created_at, updated_at,
            message_count, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, total_cost_usd, dominant_model, current_model,
            tool_call_count, fingerprint_kind, fingerprint_value, parser_version,
            model_version, parse_status, last_seen_generation, indexed_at
         ) VALUES (
            'claude-default', 'detail-v2', 'file', ?1,
            'proj', 'C:/work/proj', 'c:/work/proj', 'v2 detail', 10, 30,
            1, 10, 5, 3, 2, 0, 'claude-sonnet-4-5', 'claude-sonnet-4-5',
            1, 'file-stat', 'fp', 1, 1, 'ok', 1, 1
         )",
    )
    .bind(&file_path)
    .execute(&mut conn)
    .await
    .unwrap();
    let session_id = session_result.last_insert_rowid();
    let message_result = sqlx::query(
        "INSERT INTO history_messages(
            session_id, message_index, role, display_content, timestamp_ms,
            model, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, editable, raw_pointers_json
         ) VALUES (
            ?1, 0, 'assistant', 'hello detail', 1000,
            'claude-sonnet-4-5', 10, 5, 3, 2, 1,
            '[{\"lineIndex\":7}]'
         )",
    )
    .bind(session_id)
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_usage_events(
            session_id, event_index, timestamp_ms, model, input_tokens,
            output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
         ) VALUES (?1, 0, 1000, 'claude-sonnet-4-5', 10, 5, 3, 2, 0)",
    )
    .bind(session_id)
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_message_parts(
            message_id, part_index, kind, text_content, tool_call_id, tool_name
         ) VALUES (?1, 0, 'reasoning', 'inspect detail', NULL, NULL),
                  (?1, 1, 'text', 'hello detail', NULL, NULL)",
    )
    .bind(message_result.last_insert_rowid())
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_tool_events(
            session_id, message_id, event_index, call_id, name, category, status,
            timestamp_ms, duration_ms, input_summary, output_summary
         ) VALUES (?1, ?2, 0, 'tool-1', 'Edit', 'builtin', 'completed',
            1000, 12, 'in', 'out')",
    )
    .bind(session_id)
    .bind(message_result.last_insert_rowid())
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_file_changes(
            session_id, change_index, source_kind, tool_name, file_path,
            old_text, new_text, patch, additions, deletions, timestamp_ms
         ) VALUES (?1, 0, 'tool', 'Edit', 'src/main.rs',
            'old', 'new', NULL, 1, 1, 1000)",
    )
    .bind(session_id)
    .execute(&mut conn)
    .await
    .unwrap();

    let detail =
        get_session_detail_from_v2_with_conn(&mut conn, &roots, &file_path, "claude", "proj")
            .await
            .unwrap()
            .unwrap();

    assert_eq!(detail.session_id, "detail-v2");
    assert_eq!(detail.messages.len(), 1);
    assert_eq!(detail.messages[0].line_index, Some(7));
    assert_eq!(detail.messages[0].parts.len(), 2);
    assert_eq!(detail.messages[0].parts[0].kind, "reasoning");
    assert_eq!(detail.messages[0].parts[1].kind, "text");
    assert_eq!(detail.usage.token_trend.len(), 1);
    assert_eq!(detail.tool_events[0].message_index, Some(0));
    assert_eq!(detail.usage.builtin_calls[0].name, "Edit");
    assert_eq!(detail.file_changes[0].file_path, "src/main.rs");
    assert_eq!(detail.file_changes[0].additions, 1);
}

#[tokio::test]
async fn shadow_build_v2_populates_sessions_messages_and_sync_run() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp_dir = tempfile::TempDir::new().unwrap();
    let roots = HistoryRoots {
        claude_config_dir: Some(temp_dir.path().join(".claude")),
        codex_config_dir: Some(temp_dir.path().join(".codex")),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let roots_key = roots.cache_key();
    let file = resolve_claude_history_root(&roots)
        .join("proj")
        .join("session-1.jsonl");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        &file,
        concat!(
            r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}"#,
            "\n",
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","requestId":"req-1","message":{"id":"msg-1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"world"},{"type":"tool_use","id":"tool-1","name":"Edit","input":{"file_path":"src/main.rs","old_string":"old","new_string":"new"}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}"#,
            "\n",
        ),
    )
    .unwrap();
    let fingerprint = session_file_fingerprint(&file);
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-default', 'claude', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_catalog_sessions(
            roots_key, file_path, source, project_key, cwd, cwd_normalized,
            session_id, title, branch, created_at, updated_at, message_count,
            file_created_at, file_updated_at, file_size, parser_version, indexed_at
         ) VALUES (?1, ?2, 'claude', 'proj', 'C:/work/proj', 'c:/work/proj',
            'session-1', 'hello', NULL, 10, 20, 2, ?3, ?4, ?5, ?6, 30)",
    )
    .bind(&roots_key)
    .bind(file.to_string_lossy().to_string())
    .bind(fingerprint.created_at)
    .bind(fingerprint.updated_at)
    .bind(fingerprint.size as i64)
    .bind(CATALOG_PARSER_VERSION)
    .execute(&mut conn)
    .await
    .unwrap();

    shadow_build_v2(&mut conn, &roots, &roots_key, 7, false)
        .await
        .unwrap();

    let session_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_sessions WHERE source_instance_id = 'claude-default'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(session_count, 1);
    let message_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM history_messages m
         JOIN history_sessions s ON s.id = m.session_id
         WHERE s.source_instance_id = 'claude-default'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(message_count, 2);
    let tokens: (i64, i64, i64, i64, String, String, i64) = sqlx::query_as(
        "SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                dominant_model, usage_quality, tool_call_count
         FROM history_sessions LIMIT 1",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(
        tokens,
        (
            10,
            20,
            3,
            2,
            "claude-sonnet-4-5".to_string(),
            "parsed".to_string(),
            1
        )
    );
    let message_model: Option<String> =
        sqlx::query_scalar("SELECT model FROM history_messages WHERE role = 'assistant' LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(message_model.as_deref(), Some("claude-sonnet-4-5"));
    let usage_events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_usage_events")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(usage_events, 1);
    let tool_events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_tool_events")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(tool_events, 1);
    let file_changes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_file_changes")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(file_changes, 1);
    let raw_pointers_json: String =
        sqlx::query_scalar("SELECT raw_pointers_json FROM history_sessions LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert!(raw_pointers_json.contains("claude-jsonl"));
    let phase: String = sqlx::query_scalar("SELECT phase FROM history_sync_runs LIMIT 1")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(phase, "ready");
    let state_generation: i64 =
        sqlx::query_scalar("SELECT generation FROM history_source_state LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(state_generation, 7);

    sqlx::query("UPDATE history_sessions SET parser_version = 0")
        .execute(&mut conn)
        .await
        .unwrap();
    shadow_build_v2(&mut conn, &roots, &roots_key, 8, false)
        .await
        .unwrap();
    let parser_version: i64 =
        sqlx::query_scalar("SELECT parser_version FROM history_sessions LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(parser_version, HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION);

    sqlx::query("DELETE FROM history_catalog_messages")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("DELETE FROM history_catalog_sessions")
        .execute(&mut conn)
        .await
        .unwrap();
    shadow_build_v2(&mut conn, &roots, &roots_key, 9, false)
        .await
        .unwrap();
    let session_count_after_delete: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_sessions WHERE source_instance_id = 'claude-default'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(session_count_after_delete, 0);
}

#[tokio::test]
async fn shadow_build_v2_uses_codex_adapter_stats_and_raw_pointers() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp_dir = tempfile::TempDir::new().unwrap();
    let roots = HistoryRoots {
        claude_config_dir: Some(temp_dir.path().join(".claude")),
        codex_config_dir: Some(temp_dir.path().join(".codex")),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let roots_key = roots.cache_key();
    let file = resolve_codex_history_root(&roots)
        .join("2026")
        .join("01")
        .join("rollout-2026-01-01T00-00-00-codex-session.jsonl");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        &file,
        concat!(
            r#"{"type":"session_meta","payload":{"id":"codex-session","cwd":"F:\\work\\proj"}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{"model":"gpt-5.4"}}"#,
            "\n",
            r#"{"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello codex"}]}}"#,
            "\n",
            r#"{"type":"response_item","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}"#,
            "\n",
            r#"{"type":"event_msg","timestamp":"2026-01-01T00:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":20,"total_tokens":120},"last_token_usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":20,"total_tokens":120}}}}"#,
            "\n",
        ),
    )
    .unwrap();
    let fingerprint = session_file_fingerprint(&file);
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'codex-default', 'codex', 'windows', 'windows', 'mixed',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_catalog_sessions(
            roots_key, file_path, source, project_key, cwd, cwd_normalized,
            session_id, title, branch, created_at, updated_at, message_count,
            file_created_at, file_updated_at, file_size, parser_version, indexed_at
         ) VALUES (?1, ?2, 'codex', 'proj', 'F:\\work\\proj', 'f:/work/proj',
            'codex-session', 'hello codex', NULL, 10, 20, 2, ?3, ?4, ?5, ?6, 30)",
    )
    .bind(&roots_key)
    .bind(file.to_string_lossy().to_string())
    .bind(fingerprint.created_at)
    .bind(fingerprint.updated_at)
    .bind(fingerprint.size as i64)
    .bind(CATALOG_PARSER_VERSION)
    .execute(&mut conn)
    .await
    .unwrap();

    shadow_build_v2(&mut conn, &roots, &roots_key, 7, false)
        .await
        .unwrap();

    let session: (String, Option<String>, Option<String>, i64, i64, i64) = sqlx::query_as(
        "SELECT storage_kind, raw_key, database_path, input_tokens, cache_read_tokens, output_tokens
         FROM history_sessions
         WHERE source_instance_id = 'codex-default'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(session.0, "mixed");
    assert_eq!(session.1.as_deref(), Some("codex-session"));
    assert_eq!(
        session.2.as_deref(),
        Some(
            resolve_codex_state_db_path(&roots)
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!((session.3, session.4, session.5), (70, 30, 20));
    let assistant_usage: (Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT input_tokens, cache_read_tokens, output_tokens
         FROM history_messages WHERE role = 'assistant' LIMIT 1",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(assistant_usage, (Some(70), Some(30), Some(20)));
    let raw_pointers_json: String =
        sqlx::query_scalar("SELECT raw_pointers_json FROM history_sessions LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert!(raw_pointers_json.contains("codex-state-thread-row"));
}

#[tokio::test]
async fn shadow_build_v2_includes_active_non_core_sources() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp_dir = tempfile::TempDir::new().unwrap();
    let roots = HistoryRoots {
        claude_config_dir: Some(temp_dir.path().join(".claude")),
        codex_config_dir: Some(temp_dir.path().join(".codex")),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let roots_key = roots.cache_key();
    let file = temp_dir.path().join("gemini-session.json");
    std::fs::write(
        &file,
        r#"{
            "sessionId": "gemini-session",
            "projectHash": "hash-a",
            "messages": [
                { "role": "user", "content": "hello gemini", "timestamp": "2026-01-01T00:00:00Z" },
                { "role": "model", "content": "hi", "timestamp": "2026-01-01T00:00:01Z" }
            ]
        }"#,
    )
    .unwrap();
    let fingerprint = session_file_fingerprint(&file);
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'gemini-default', 'gemini', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_catalog_sessions(
            roots_key, file_path, source, project_key, cwd, cwd_normalized,
            session_id, title, branch, created_at, updated_at, message_count,
            file_created_at, file_updated_at, file_size, parser_version, indexed_at
         ) VALUES (?1, ?2, 'gemini', 'hash-a', NULL, NULL,
            'gemini-session', 'hello gemini', NULL, 10, 20, 2,
            ?3, ?4, ?5, ?6, 30)",
    )
    .bind(&roots_key)
    .bind(file.to_string_lossy().to_string())
    .bind(fingerprint.created_at)
    .bind(fingerprint.updated_at)
    .bind(fingerprint.size as i64)
    .bind(CATALOG_PARSER_VERSION)
    .execute(&mut conn)
    .await
    .unwrap();

    shadow_build_v2(&mut conn, &roots, &roots_key, 7, false)
        .await
        .unwrap();

    let source: String = sqlx::query_scalar(
        "SELECT i.source_id
         FROM history_sessions s
         JOIN history_source_instances i ON i.id = s.source_instance_id
         WHERE s.source_session_id = 'gemini-session'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(source, "gemini");
}

#[tokio::test]
async fn record_v2_index_failure_upserts_retry_count() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'claude-default', 'claude', 'windows', 'windows', 'file',
            '{}', 'settings', 'active', 1, 1
         )",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    let row = V2LegacySessionRow {
        file_ref: SessionFileRef {
            source: "claude".to_string(),
            project_key: "proj".to_string(),
            path: PathBuf::from("session-1.jsonl"),
        },
        fingerprint: SessionFileFingerprint {
            created_at: 1,
            updated_at: 2,
            size: 3,
        },
        session_id: "session-1".to_string(),
    };

    record_v2_index_failure(
        &mut conn,
        "claude-default",
        &row,
        "parse_failed",
        "bad json",
    )
    .await
    .unwrap();
    record_v2_index_failure(
        &mut conn,
        "claude-default",
        &row,
        "parse_failed",
        "bad json again",
    )
    .await
    .unwrap();

    let retry_count: i64 =
        sqlx::query_scalar("SELECT retry_count FROM history_index_failures LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(retry_count, 1);
}

#[test]
fn validate_source_instance_rejects_invalid_storage_and_locations() {
    let mut input = HistoryIndexV2SourceInstanceInput {
        source_id: "claude".to_string(),
        instance_id: "claude-12345678".to_string(),
        environment_kind: "windows".to_string(),
        environment_key: "windows".to_string(),
        storage_kind: "file".to_string(),
        display_name: None,
        locations_json: r#"{"configRoot":"C:\\Users\\me\\.claude"}"#.to_string(),
        settings_hash: "hash".to_string(),
        discovered: false,
    };
    assert!(validate_source_instance_input(&input).is_ok());

    input.storage_kind = "unknown".to_string();
    assert_eq!(
        validate_source_instance_input(&input).unwrap_err(),
        "history_source_storage_kind_invalid"
    );

    input.storage_kind = "file".to_string();
    input.locations_json = "{broken".to_string();
    assert_eq!(
        validate_source_instance_input(&input).unwrap_err(),
        "history_source_locations_json_invalid"
    );
}
