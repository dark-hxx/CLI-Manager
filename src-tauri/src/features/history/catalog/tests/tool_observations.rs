use super::*;

#[tokio::test]
async fn normalized_mcp_survives_catalog_materialization() {
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
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","requestId":"req-1","message":{"id":"msg-1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"world"},{"type":"tool_use","id":"tool-1","name":"mcp__docs__read","input":{"file_path":"src/main.rs","old_string":"old","new_string":"new"}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}"#,
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

    let detail = get_session_detail_from_v2_with_conn(&mut conn, &roots,
        &file.to_string_lossy(), "claude", "proj").await.unwrap().unwrap();
    assert_eq!(detail.tool_events.len(), 1);
    assert_eq!(detail.tool_events[0].message_index, Some(1));
    assert_eq!(detail.usage.mcp_calls[0].name, "docs");
    assert_eq!(detail.usage.mcp_calls[0].count, 1);
    assert!(detail.usage.builtin_calls.is_empty());
    sqlx::query("UPDATE history_tool_events SET source_extension_json = ?1")
        .bind(r#"{"kind":"inferred","parentCallId":"outer","sourcePosition":7}"#)
        .execute(&mut conn).await.unwrap();
    let detail = get_session_detail_from_v2_with_conn(&mut conn, &roots,
        &file.to_string_lossy(), "claude", "proj").await.unwrap().unwrap();
    assert!(detail.usage.mcp_calls.is_empty());
    assert_eq!(detail.tool_events[0].evidence.as_ref().unwrap().parent_call_id.as_deref(), Some("outer"));
}
