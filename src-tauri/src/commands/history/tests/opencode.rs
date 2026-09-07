use super::*;

#[tokio::test]
async fn parse_opencode_database_reads_sqlite_sessions() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("opencode.db");
    let mut conn = open_opencode_test_database(&db_path).await;
    sqlx::query(
        "INSERT INTO session(id, directory, title, slug, time_created, time_updated)
         VALUES ('ses_1', 'F:\\idea-work\\business-center', 'OpenCode title', 'slug', 1700000000, 1700000010)",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO message(id, session_id, time_created, time_updated, data)
         VALUES
            ('msg_1', 'ses_1', 1700000001, 1700000001, ?1),
            ('msg_2', 'ses_1', 1700000002, 1700000002, ?2)",
    )
    .bind(json!({"role":"user"}).to_string())
    .bind(
        json!({
            "role":"assistant",
            "providerID":"anthropic",
            "modelID":"claude-sonnet-4",
            "tokens":{
                "input":10,
                "output":20,
                "reasoning":5,
                "cache":{"read":3,"write":2}
            }
        })
        .to_string(),
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO part(id, message_id, session_id, time_created, time_updated, data)
         VALUES
            ('part_1', 'msg_1', 'ses_1', 1700000001, 1700000001, ?1),
            ('part_2', 'msg_2', 'ses_1', 1700000002, 1700000002, ?2),
            ('part_3', 'msg_2', 'ses_1', 1700000003, 1700000003, ?3)",
    )
    .bind(json!({"type":"text","text":"hello opencode"}).to_string())
    .bind(json!({"type":"text","text":"hi user"}).to_string())
    .bind(json!({"type":"tool","name":"Edit","input":{"filePath":"src/main.rs"}}).to_string())
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();

    let sessions = parse_opencode_database(&db_path, None).await.unwrap();

    assert_eq!(sessions.len(), 1);
    let parsed = &sessions[0];
    assert_eq!(parsed.computed.session_id, "ses_1");
    assert_eq!(parsed.file_ref.source, "opencode");
    assert_eq!(parsed.file_ref.project_key, "business-center");
    assert!(parsed
        .file_ref
        .path
        .to_string_lossy()
        .contains("#session=ses_1"));
    assert_eq!(parsed.messages.len(), 2);
    assert_eq!(parsed.messages[0].role, "user");
    assert_eq!(parsed.messages[0].content, "hello opencode");
    assert_eq!(
        parsed.messages[1].model.as_deref(),
        Some("anthropic/claude-sonnet-4")
    );
    assert_eq!(parsed.computed.stats.input_tokens, 10);
    assert_eq!(parsed.computed.stats.output_tokens, 25);
    assert_eq!(parsed.computed.stats.cache_read_tokens, 3);
    assert_eq!(parsed.computed.stats.cache_creation_tokens, 2);
    assert_eq!(parsed.tool_events.len(), 1);
    assert_eq!(parsed.tool_events[0].name, "Edit");
}

#[test]
fn opencode_session_locator_requires_a_valid_session_id() {
    let valid = parse_opencode_session_locator(
        "C:/Users/test/.local/share/opencode/opencode.db#session=ses_abc123",
    );
    assert_eq!(
        valid,
        Some((
            PathBuf::from("C:/Users/test/.local/share/opencode/opencode.db"),
            "ses_abc123".to_string(),
        )),
    );
    assert!(parse_opencode_session_locator("C:/test/opencode.db#session=msg_abc123").is_none());
    assert!(parse_opencode_session_locator("C:/test/opencode.db#session=ses_bad-id").is_none());
}

#[tokio::test]
async fn delete_opencode_session_is_transactional_and_isolated() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("opencode.db");
    let mut conn = open_opencode_test_database(&db_path).await;

    sqlx::query(
        "INSERT INTO session(id, directory, title, slug, time_created, time_updated)
         VALUES
            ('ses_delete', 'F:/workspace/delete', 'delete', 'delete', 1, 1),
            ('ses_keep', 'F:/workspace/keep', 'keep', 'keep', 1, 1)",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO message(id, session_id, time_created, time_updated, data)
         VALUES
            ('msg_delete', 'ses_delete', 1, 1, '{}'),
            ('msg_keep', 'ses_keep', 1, 1, '{}'),
            ('msg_missing', 'ses_missing', 1, 1, '{}')",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO part(id, message_id, session_id, time_created, time_updated, data)
         VALUES
            ('part_delete', 'msg_delete', 'ses_delete', 1, 1, '{}'),
            ('part_keep', 'msg_keep', 'ses_keep', 1, 1, '{}'),
            ('part_missing', 'msg_missing', 'ses_missing', 1, 1, '{}')",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();

    assert_eq!(
        delete_opencode_session_from_database(&db_path, "ses_missing")
            .await
            .unwrap_err(),
        "session_file_not_indexed",
    );

    let mut conn = open_opencode_database(&db_path).await.unwrap();
    let missing_messages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM message WHERE session_id = 'ses_missing'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let missing_parts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM part WHERE session_id = 'ses_missing'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!((missing_messages, missing_parts), (1, 1));
    conn.close().await.unwrap();

    delete_opencode_session_from_database(&db_path, "ses_delete")
        .await
        .unwrap();

    let mut conn = open_opencode_database(&db_path).await.unwrap();
    let deleted_session: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM session WHERE id = 'ses_delete'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let deleted_messages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM message WHERE session_id = 'ses_delete'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let deleted_parts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM part WHERE session_id = 'ses_delete'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let kept_session: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM session WHERE id = 'ses_keep'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let kept_messages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM message WHERE session_id = 'ses_keep'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let kept_parts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM part WHERE session_id = 'ses_keep'")
            .fetch_one(&mut conn)
            .await
            .unwrap();

    assert_eq!(
        (deleted_session, deleted_messages, deleted_parts),
        (0, 0, 0)
    );
    assert_eq!((kept_session, kept_messages, kept_parts), (1, 1, 1));
}
