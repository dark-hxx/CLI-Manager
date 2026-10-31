use cli_manager_core_db::{extensions::list_extension_overview, pool::DbPool, run_migrations};

#[tokio::test]
async fn lists_all_extension_kinds_in_global_order_without_exposing_definition_json() {
    let directory = tempfile::tempdir().unwrap();
    let pool = DbPool::open(directory.path().join("extensions.db"))
        .await
        .unwrap();
    run_migrations(pool.writer()).await.unwrap();

    sqlx::query(
        "INSERT INTO extension_mcp_resources
            (resource_id, server_key, name, definition_json, source_kind, created_at, updated_at)
         VALUES ('mcp-1', 'server-1', 'MCP name', '{\"name\":\"secret should stay in db\"}', 'native', 1, 30)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO extension_skill_packages
            (package_id, name, source_kind, source_identity, content_hash, package_path, created_at, updated_at)
         VALUES ('skill-1', 'Skill name', 'github', 'org/repo', 'hash-1', 'C:/skills/one', 1, 20)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO extension_skill_installations
            (installation_id, package_id, environment_kind, environment_id, cli, home_path,
             target_path, requested_mode, actual_mode, deployed_hash, owned, external_modified,
             created_at, updated_at)
         VALUES ('install-1', 'skill-1', 'wsl', 'Ubuntu', 'codex', '/home/user',
                 '/home/user/.codex/skills/one', 'copy', 'copy', 'hash-1', 1, 0, 1, 40)",
    )
    .execute(pool.writer())
    .await
    .unwrap();

    let items = list_extension_overview(pool.reader()).await.unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(
        items
            .iter()
            .map(|item| (
                item.kind.as_str(),
                item.item_id.as_str(),
                item.name.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("skill-installation", "install-1", "codex · wsl"),
            ("mcp", "mcp-1", "MCP name"),
            ("skill", "skill-1", "Skill name"),
        ]
    );
    assert!(items.iter().all(|item| !item.name.contains("secret")));
    assert!(items[1].enabled_for("claude"));
    assert!(items
        .iter()
        .all(|item| item.status == "managed" || item.status == "owned"));
    pool.close().await;
}

#[tokio::test]
async fn reports_external_modified_before_owned_and_unowned_installations() {
    let directory = tempfile::tempdir().unwrap();
    let pool = DbPool::open(directory.path().join("statuses.db"))
        .await
        .unwrap();
    run_migrations(pool.writer()).await.unwrap();

    sqlx::query(
        "INSERT INTO extension_skill_packages
            (package_id, name, source_kind, source_identity, content_hash, package_path, created_at, updated_at)
         VALUES ('skill-1', 'Skill', 'local', 'source', 'hash', 'C:/skills', 1, 1)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    for (id, owned, external_modified, timestamp) in [
        ("external", 1, 1, 30),
        ("owned", 1, 0, 20),
        ("unowned", 0, 0, 10),
    ] {
        sqlx::query(
            "INSERT INTO extension_skill_installations
                (installation_id, package_id, environment_kind, environment_id, cli, home_path,
                 target_path, requested_mode, actual_mode, deployed_hash, owned, external_modified,
                 created_at, updated_at)
             VALUES (?1, 'skill-1', 'local', 'windows', 'claude', 'C:/home', ?2,
                     'copy', 'copy', 'hash', ?3, ?4, 1, ?5)",
        )
        .bind(id)
        .bind(format!("C:/target/{id}"))
        .bind(owned)
        .bind(external_modified)
        .bind(timestamp)
        .execute(pool.writer())
        .await
        .unwrap();
    }

    let items = list_extension_overview(pool.reader()).await.unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| (item.item_id.as_str(), item.status.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("external", "externalModified"),
            ("owned", "owned"),
            ("unowned", "unowned"),
            ("skill-1", "managed"),
        ]
    );
    pool.close().await;
}

#[tokio::test]
async fn empty_database_returns_empty_and_malformed_mcp_json_does_not_break_listing() {
    let directory = tempfile::tempdir().unwrap();
    let pool = DbPool::open(directory.path().join("empty.db"))
        .await
        .unwrap();
    run_migrations(pool.writer()).await.unwrap();
    assert!(list_extension_overview(pool.reader())
        .await
        .unwrap()
        .is_empty());

    sqlx::query(
        "INSERT INTO extension_mcp_resources
            (resource_id, server_key, name, definition_json, created_at, updated_at)
         VALUES ('broken', 'broken-server', 'Saved name', '{broken json', 1, 1)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    let items = list_extension_overview(pool.reader()).await.unwrap();
    assert_eq!(items[0].name, "Saved name");
    assert!(items[0].enabled_for("claude"));
    pool.close().await;
}

#[tokio::test]
async fn deletes_only_the_requested_mcp_record_and_rejects_missing_ids() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("delete.db");
    let pool = DbPool::open(&path).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    sqlx::query(
        "INSERT INTO extension_mcp_resources
            (resource_id, server_key, name, definition_json, created_at, updated_at)
         VALUES ('mcp-1', 'server-1', 'MCP', '{}', 1, 1)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO extension_skill_packages
            (package_id, name, source_kind, source_identity, content_hash, package_path, created_at, updated_at)
         VALUES ('skill-1', 'Skill', 'local', 'source', 'hash', 'C:/skill', 1, 1)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    pool.close().await;

    cli_manager_core_db::extensions::delete_mcp_resource(&path, "mcp-1".into())
        .await
        .unwrap();
    assert_eq!(
        cli_manager_core_db::extensions::delete_mcp_resource(&path, "mcp-1".into())
            .await
            .unwrap_err(),
        "extensions_mcp_not_found"
    );
    assert_eq!(
        cli_manager_core_db::extensions::delete_mcp_resource(&path, "skill-1".into())
            .await
            .unwrap_err(),
        "extensions_mcp_not_found"
    );
    let verify = DbPool::open(&path).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM extension_skill_packages")
            .fetch_one(verify.reader())
            .await
            .unwrap(),
        1
    );
    verify.close().await;
}

#[tokio::test]
async fn toggles_one_cli_without_replacing_other_canonical_fields_or_secrets() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("toggle.db");
    let pool = DbPool::open(&path).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    let original = r#"{
        "resourceId":"mcp-1",
        "serverKey":"server-1",
        "name":"Name",
        "transport":"stdio",
        "command":"tool",
        "secretRefs":{"token":"vault-key"},
        "enabledByCli":{"claude":true,"codex":true,"grok":false}
    }"#;
    sqlx::query(
        "INSERT INTO extension_mcp_resources
            (resource_id, server_key, name, definition_json, revision, created_at, updated_at)
         VALUES ('mcp-1', 'server-1', 'Name', ?1, 2, 10, 10)",
    )
    .bind(original)
    .execute(pool.writer())
    .await
    .unwrap();
    pool.close().await;

    cli_manager_core_db::extensions::set_mcp_enabled(&path, "mcp-1".into(), "codex".into(), false)
        .await
        .unwrap();
    let verify = DbPool::open(&path).await.unwrap();
    let json: String = sqlx::query_scalar(
        "SELECT definition_json FROM extension_mcp_resources WHERE resource_id = 'mcp-1'",
    )
    .fetch_one(verify.reader())
    .await
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["name"], "Name");
    assert_eq!(value["secretRefs"]["token"], "vault-key");
    assert_eq!(value["enabledByCli"]["claude"], true);
    assert_eq!(value["enabledByCli"]["codex"], false);
    assert_eq!(value["enabledByCli"]["grok"], false);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM extension_mcp_resources WHERE resource_id = 'mcp-1'",
        )
        .fetch_one(verify.reader())
        .await
        .unwrap(),
        3
    );
    verify.close().await;
}

#[tokio::test]
async fn rejects_invalid_switch_data_without_mutation_and_never_creates_missing_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invalid-switch.db");
    let pool = DbPool::open(&path).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    sqlx::query(
        "INSERT INTO extension_mcp_resources
            (resource_id, server_key, name, definition_json, revision, created_at, updated_at)
         VALUES ('broken', 'broken-server', 'Broken', '{\"enabledByCli\":false}', 7, 1, 1)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    pool.close().await;

    assert_eq!(
        cli_manager_core_db::extensions::set_mcp_enabled(
            &path,
            "broken".into(),
            "claude".into(),
            false,
        )
        .await
        .unwrap_err(),
        "extensions_storage_corrupt"
    );
    assert_eq!(
        cli_manager_core_db::extensions::set_mcp_enabled(
            &path,
            "broken".into(),
            "unknown".into(),
            false,
        )
        .await
        .unwrap_err(),
        "extensions_mcp_cli_invalid"
    );
    let verify = DbPool::open(&path).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM extension_mcp_resources WHERE resource_id = 'broken'",
        )
        .fetch_one(verify.reader())
        .await
        .unwrap(),
        7
    );
    verify.close().await;

    let missing = directory.path().join("missing.db");
    assert!(
        cli_manager_core_db::extensions::delete_mcp_resource(&missing, "x".into())
            .await
            .is_err()
    );
    assert!(cli_manager_core_db::extensions::set_mcp_enabled(
        &missing,
        "x".into(),
        "claude".into(),
        false,
    )
    .await
    .is_err());
    assert!(!missing.exists());
}

#[tokio::test]
async fn renames_mcp_in_both_projection_columns_and_canonical_json() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rename.db");
    let pool = DbPool::open(&path).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    sqlx::query(
        "INSERT INTO extension_mcp_resources
            (resource_id, server_key, name, definition_json, revision, created_at, updated_at)
         VALUES ('mcp-1', 'server-1', 'Old',
                 '{\"name\":\"Old\",\"secretRefs\":{\"token\":\"keep\"},\"enabledByCli\":{\"codex\":false}}',
                 4, 1, 1)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    pool.close().await;
    cli_manager_core_db::extensions::rename_mcp_resource(
        &path,
        "mcp-1".into(),
        " New name ".into(),
    )
    .await
    .unwrap();
    let verify = DbPool::open(&path).await.unwrap();
    let (name, json, revision): (String, String, i64) = sqlx::query_as(
        "SELECT name, definition_json, revision FROM extension_mcp_resources WHERE resource_id = 'mcp-1'",
    )
    .fetch_one(verify.reader())
    .await
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(name, "New name");
    assert_eq!(value["name"], "New name");
    assert_eq!(value["secretRefs"]["token"], "keep");
    assert_eq!(value["enabledByCli"]["codex"], false);
    assert_eq!(revision, 5);
    verify.close().await;
}

#[tokio::test]
async fn rejects_invalid_or_corrupt_mcp_rename_without_changing_storage() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rename-invalid.db");
    let pool = DbPool::open(&path).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    sqlx::query(
        "INSERT INTO extension_mcp_resources
            (resource_id, server_key, name, definition_json, revision, created_at, updated_at)
         VALUES ('broken', 'broken-server', 'Original', '{bad', 9, 1, 1)",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    pool.close().await;

    for invalid_name in ["  ".to_string(), "x".repeat(16 * 1024 + 1)] {
        assert_eq!(
            cli_manager_core_db::extensions::rename_mcp_resource(
                &path,
                "broken".into(),
                invalid_name,
            )
            .await
            .unwrap_err(),
            "extensions_mcp_name_invalid"
        );
    }
    assert_eq!(
        cli_manager_core_db::extensions::rename_mcp_resource(
            &path,
            "broken".into(),
            "Changed".into(),
        )
        .await
        .unwrap_err(),
        "extensions_storage_corrupt"
    );
    let verify = DbPool::open(&path).await.unwrap();
    let (name, revision): (String, i64) = sqlx::query_as(
        "SELECT name, revision FROM extension_mcp_resources WHERE resource_id = 'broken'",
    )
    .fetch_one(verify.reader())
    .await
    .unwrap();
    assert_eq!((name.as_str(), revision), ("Original", 9));
    verify.close().await;
}
