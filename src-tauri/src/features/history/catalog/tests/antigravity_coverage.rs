use super::*;

// Exercise the actual v2 evidence boundary for measured, tokenless, and mixed Antigravity sessions.
#[tokio::test]
async fn antigravity_sqlite_activity_and_known_zero_or_positive_have_distinct_coverage() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp = tempfile::TempDir::new().unwrap();
    let root = temp.path().join(".gemini").join("antigravity-cli");
    std::fs::create_dir_all(root.join("brain")).unwrap();
    let roots = HistoryRoots::default().with_antigravity_config_dir(Some(path_to_key(&root)));
    for source in ["antigravity", "codex"] {
        sqlx::query("INSERT INTO history_source_instances(id,source_id,environment_kind,environment_key,storage_kind,locations_json,settings_hash,activation_state,created_at,updated_at) VALUES(?1,?1,'windows','windows','file',?2,'fixture','active',1,1)")
            .bind(source).bind(serde_json::json!({"configRoot": &root}).to_string()).execute(&mut conn).await.unwrap();
    }

    let bounds = StatsTimeBounds {
        start_at: 0,
        end_at: 999,
        start_day: 0,
        range_days: 1,
        explicit: true,
    };

    let unmeasured_id = "d89738a2-f658-4a39-90a1-d3fcab02aa10";
    let unmeasured_path = root
        .join("brain")
        .join(unmeasured_id)
        .join(".system_generated/logs/transcript.jsonl");
    sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            project_key, cwd, cwd_normalized, title, created_at, updated_at,
            message_count, input_tokens, fingerprint_kind, fingerprint_value,
            parser_version, model_version, parse_status, last_seen_generation, indexed_at
         ) VALUES ('antigravity', ?1, 'file', ?2, 'fixture', '/work', '/work',
            'unmeasured', 10, 20, 2, 0, 'file-stat', 'fp', 1, 1, 'ok', 1, 1)",
    )
    .bind(unmeasured_id)
    .bind(path_to_key(&unmeasured_path))
    .execute(&mut conn)
    .await
    .unwrap();

    let unmeasured_only_facts =
        stats_session_facts_from_v2(&mut conn, &roots, Some("antigravity"), None, &[], None)
            .await
            .unwrap();
    let unmeasured_only = build_history_stats_response(
        &std::collections::BTreeMap::from([(0, unmeasured_only_facts)]),
        bounds,
    );
    assert_eq!(unmeasured_only.total_sessions, 1);
    assert_eq!(unmeasured_only.total_messages, 2);
    assert_eq!(unmeasured_only.unmeasured_sessions, 1);
    assert_eq!(unmeasured_only.total_input_tokens, 0);
    assert!(unmeasured_only.model_distribution.is_empty());

    let measured_id = "e89738a2-f658-4a39-90a1-d3fcab02aa11";
    let measured_path = root
        .join("brain")
        .join(measured_id)
        .join(".system_generated/logs/transcript.jsonl");
    let measured_row = sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            project_key, cwd, cwd_normalized, title, created_at, updated_at,
            message_count, input_tokens, output_tokens, cache_read_tokens,
            dominant_model, current_model, fingerprint_kind, fingerprint_value,
            parser_version, model_version, parse_status, last_seen_generation, indexed_at
         ) VALUES ('antigravity', ?1, 'file', ?2, 'fixture', '/work', '/work',
            'measured', 10, 20, 2, 91, 11, 7, 'claude-sonnet-5-5-medium',
            'claude-sonnet-5-5-medium', 'file-stat', 'fp', 1, 1, 'ok', 1, 1)",
    )
    .bind(measured_id)
    .bind(path_to_key(&measured_path))
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO history_usage_events(
            session_id, event_index, timestamp_ms, model, input_tokens,
            output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
         ) VALUES (?1, 0, 20, 'claude-sonnet-5-5-medium', 91, 11, 7, 0, 0)",
    )
    .bind(measured_row.last_insert_rowid())
    .execute(&mut conn)
    .await
    .unwrap();

    let agy_mixed_facts =
        stats_session_facts_from_v2(&mut conn, &roots, Some("antigravity"), None, &[], None)
            .await
            .unwrap();
    let agy_mixed = build_history_stats_response(
        &std::collections::BTreeMap::from([(0, agy_mixed_facts)]),
        bounds,
    );
    assert_eq!(agy_mixed.total_sessions, 2);
    assert_eq!(agy_mixed.total_messages, 4);
    assert_eq!(agy_mixed.unmeasured_sessions, 1);
    assert_eq!(agy_mixed.total_input_tokens, 91);
    assert_eq!(agy_mixed.total_output_tokens, 11);
    assert_eq!(agy_mixed.total_cache_read_tokens, 7);
    assert_eq!(agy_mixed.model_distribution.len(), 1);
    assert_eq!(agy_mixed.model_distribution[0].model, "claude-sonnet-5-5-medium");
    assert_eq!(agy_mixed.model_distribution[0].ratio, 1.0);

    for (session, event_tokens, count, missing, subtotal) in [
        ("zero", 0, 3, 1, 91),
        ("positive", 17, 4, 1, 108),
    ] {
        let row = sqlx::query(
            "INSERT INTO history_sessions(
                source_instance_id, source_session_id, storage_kind, primary_path,
                project_key, cwd, cwd_normalized, title, created_at, updated_at,
                message_count, input_tokens, fingerprint_kind, fingerprint_value,
                parser_version, model_version, parse_status, last_seen_generation, indexed_at
             ) VALUES ('codex', ?1, 'file', ?2, 'fixture', '/work', '/work',
                'fixture', 10, 20, 2, ?3, 'file-stat', 'fp', 1, 1, 'ok', 1, 1)",
        )
        .bind(session)
        .bind(format!("{session}.jsonl"))
        .bind(event_tokens)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO history_usage_events(
                session_id, event_index, timestamp_ms, model, input_tokens,
                output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
             ) VALUES (?1, 0, 20, 'fixture', ?2, 0, 0, 0, 0)",
        )
        .bind(row.last_insert_rowid())
        .bind(event_tokens)
        .execute(&mut conn)
        .await
        .unwrap();
        let facts = stats_session_facts_from_v2(&mut conn, &roots, None, None, &[], None)
            .await
            .unwrap();
        let result =
            build_history_stats_response(&std::collections::BTreeMap::from([(0, facts)]), bounds);
        assert_eq!(result.total_sessions, count);
        assert_eq!(result.total_messages, count * 2);
        assert_eq!(result.unmeasured_sessions, missing);
        assert_eq!(result.total_input_tokens, subtotal);
    }

    let wrong = HistoryRoots::default().with_antigravity_config_dir(Some(path_to_key(
        &temp.path().join("other/.gemini/antigravity-cli"),
    )));
    assert!(
        stats_session_facts_from_v2(&mut conn, &wrong, Some("antigravity"), None, &[], None)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn antigravity_catalog_and_v2_search_and_detail_hydrate_full_transcript() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let temp = tempfile::TempDir::new().unwrap();
    let root = temp.path().join(".gemini").join("antigravity-cli");
    let session_id = "f90849b3-1769-4b4a-a1b2-e4fdcb13bb22";
    let logs_dir = root
        .join("brain")
        .join(session_id)
        .join(".system_generated")
        .join("logs");
    let compact_path = logs_dir.join("transcript.jsonl");
    let full_path = logs_dir.join("transcript_full.jsonl");
    let roots = HistoryRoots::default().with_antigravity_config_dir(Some(path_to_key(&root)));
    let roots_key = roots.cache_key();

    std::fs::create_dir_all(&logs_dir).unwrap();
    std::fs::write(
        &compact_path,
        [
            serde_json::json!({
                "step_index": 0,
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-05-20T06:03:19Z",
                "content": "<USER_REQUEST>\nInspect catalog\n</USER_REQUEST>"
            })
            .to_string(),
            serde_json::json!({
                "step_index": 1,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-05-20T06:03:25Z",
                "model": "claude-sonnet-5-5-medium",
                "input_tokens": 500,
                "output_tokens": 50,
                "truncated_fields": ["content"],
                "content": "Start\n<truncated 1200 bytes>\nEnd"
            })
            .to_string(),
        ]
        .join("\n"),
    )
    .unwrap();
    std::fs::write(
        &full_path,
        [
            serde_json::json!({
                "step_index": 0,
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-05-20T06:03:19Z",
                "content": "<USER_REQUEST>\nInspect catalog\n</USER_REQUEST>"
            })
            .to_string(),
            serde_json::json!({
                "step_index": 1,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-05-20T06:03:25Z",
                "model": "claude-sonnet-5-5-medium",
                "input_tokens": 500,
                "output_tokens": 50,
                "content": "Start ANTIGRAVITY_FULL_ONLY_NEEDLE End"
            })
            .to_string(),
        ]
        .join("\n"),
    )
    .unwrap();

    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            locations_json, settings_hash, activation_state, created_at, updated_at
         ) VALUES (
            'antigravity', 'antigravity', 'windows', 'windows', 'file',
            ?1, 'fixture', 'active', 1, 1
         )",
    )
    .bind(serde_json::json!({ "configRoot": &root }).to_string())
    .execute(&mut conn)
    .await
    .unwrap();

    let catalog_files: Vec<_> = collect_catalog_files(&roots)
        .into_iter()
        .filter(|file| file.file_ref.source == "antigravity")
        .collect();
    assert_eq!(catalog_files.len(), 1);
    let doc = parse_catalog_file(catalog_files.into_iter().next().unwrap());
    replace_document(&mut conn, &roots_key, doc).await.unwrap();
    shadow_build_v2(&mut conn, &roots, &roots_key, 1, false)
        .await
        .unwrap();

    let legacy_hits = search_sessions_from_legacy_catalog(
        &mut conn,
        &roots,
        "ANTIGRAVITY_FULL_ONLY_NEEDLE",
        Some("antigravity"),
        None,
        10,
    )
    .await
    .unwrap();
    assert_eq!(legacy_hits.len(), 1);
    assert!(legacy_hits[0].file_path.ends_with("transcript.jsonl"));

    let v2_hits = search_sessions_from_v2(
        &mut conn,
        &roots,
        "ANTIGRAVITY_FULL_ONLY_NEEDLE",
        Some("antigravity"),
        None,
        10,
    )
    .await
    .unwrap();
    assert_eq!(v2_hits.len(), 1);
    assert!(v2_hits[0].file_path.ends_with("transcript.jsonl"));

    let file_path_str = v2_hits[0].file_path.clone();
    let detail = get_session_detail_from_v2_with_conn(
        &mut conn,
        &roots,
        &file_path_str,
        "antigravity",
        session_id,
    )
    .await
    .unwrap()
    .expect("v2 detail should hit");
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(
        detail.messages[1].content,
        "Start ANTIGRAVITY_FULL_ONLY_NEEDLE End"
    );
    assert_eq!(
        detail.messages[1].parts[0].content,
        "Start ANTIGRAVITY_FULL_ONLY_NEEDLE End"
    );

    // Mutating transcript_full.jsonl without touching transcript.jsonl must invalidate V2 cache.
    std::fs::write(
        &full_path,
        [
            serde_json::json!({
                "step_index": 0,
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-05-20T06:03:19Z",
                "content": "<USER_REQUEST>\nInspect catalog\n</USER_REQUEST>"
            })
            .to_string(),
            serde_json::json!({
                "step_index": 1,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-05-20T06:03:25Z",
                "model": "claude-sonnet-5-5-medium",
                "input_tokens": 500,
                "output_tokens": 50,
                "content": "Start ANTIGRAVITY_FULL_UPDATED_NEEDLE End"
            })
            .to_string(),
        ]
        .join("\n"),
    )
    .unwrap();
    let stale = get_session_detail_from_v2_with_conn(
        &mut conn,
        &roots,
        &file_path_str,
        "antigravity",
        session_id,
    )
    .await
    .unwrap();
    assert!(stale.is_none());
}
