use super::*;

#[test]
fn kimi_wire_parser_covers_history_pipeline() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".kimi-code");
    let session_id = "01KIMISESSIONID0000000001";
    let path = write_kimi_session_fixture(
        &home,
        session_id,
        r"F:\github\CLI-Manager",
        &[
            json!({"type": "metadata", "protocol_version": "1.1", "created_at": 1_787_097_600_000i64}),
            json!({
                "type": "config.update",
                "cwd": r"F:\github\CLI-Manager",
                "modelAlias": "kimi-k2",
                "time": 1_787_097_600_100i64
            }),
            json!({
                "type": "turn.prompt",
                "time": 1_787_097_601_000i64,
                "input": [{"type": "text", "text": "hello kimi"}],
                "origin": {"kind": "user"}
            }),
            json!({
                "type": "context.append_message",
                "time": 1_787_097_601_001i64,
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "hello kimi"}],
                    "toolCalls": []
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_602_000i64,
                "event": {"type": "step.begin", "uuid": "step-1", "turnId": "turn-1", "step": 0}
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_602_100i64,
                "event": {
                    "type": "content.part",
                    "uuid": "content-1",
                    "turnId": "turn-1",
                    "step": 0,
                    "stepUuid": "step-1",
                    "part": {"type": "text", "text": "hi there"}
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_602_200i64,
                "event": {
                    "type": "tool.call",
                    "uuid": "tool-event-1",
                    "turnId": "turn-1",
                    "step": 0,
                    "stepUuid": "step-1",
                    "toolCallId": "tc1",
                    "name": "Read",
                    "args": {"path": "README.md"}
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_602_500i64,
                "event": {
                    "type": "tool.result",
                    "parentUuid": "tool-event-1",
                    "toolCallId": "tc1",
                    "result": {"output": "README contents"}
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_603_000i64,
                "event": {
                    "type": "step.end",
                    "uuid": "step-1",
                    "turnId": "turn-1",
                    "step": 0,
                    "usage": {"inputOther": 12, "output": 8, "inputCacheRead": 2, "inputCacheCreation": 3},
                    "finishReason": "tool_calls"
                }
            }),
            json!({
                "type": "usage.record",
                "time": 1_787_097_603_002i64,
                "model": "kimi-k2",
                "usage": {
                    "inputOther": 12,
                    "output": 8,
                    "inputCacheRead": 2,
                    "inputCacheCreation": 3
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_604_000i64,
                "event": {"type": "step.begin", "uuid": "step-2", "turnId": "turn-1", "step": 1}
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_605_000i64,
                "event": {
                    "type": "step.end",
                    "uuid": "step-2",
                    "turnId": "turn-1",
                    "step": 1,
                    "usage": {"inputOther": 4, "output": 3, "inputCacheRead": 1, "inputCacheCreation": 2},
                    "finishReason": "end_turn"
                }
            }),
        ],
    );

    let (summary, stats, messages) = kimi::scan_kimi_jsonl_session(&path, true);
    assert_eq!(summary.session_id.as_deref(), Some(session_id));
    assert_eq!(summary.parent_session_id.as_deref(), Some("parent-session"));
    assert_eq!(summary.first_user_message.as_deref(), Some("hello kimi"));
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "hello kimi");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].content, "hi there");
    assert_eq!(stats.input_tokens, 16);
    assert_eq!(stats.output_tokens, 11);
    assert_eq!(stats.cache_read_tokens, 3);
    assert_eq!(stats.cache_creation_tokens, 5);
    assert_eq!(stats.usage_events.len(), 2);
    assert_eq!(stats.current_model.as_deref(), Some("kimi-k2"));
    assert_eq!(stats.tool_call_count, 1);
    assert_eq!(stats.builtin_calls.get("Read"), Some(&1));
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.role == "user")
            .count(),
        1
    );

    let tool_events = kimi::scan_kimi_tool_events(&path);
    assert_eq!(tool_events.len(), 1);
    assert_eq!(tool_events[0].call_id.as_deref(), Some("tc1"));
    assert_eq!(tool_events[0].status.as_deref(), Some("completed"));
    assert_eq!(tool_events[0].duration_ms, Some(300));
    assert_eq!(
        tool_events[0].output_summary.as_deref(),
        Some("README contents")
    );

    let project = scan_session_project(&path);
    assert_eq!(project.cwd.as_deref(), Some(r"F:\github\CLI-Manager"));
    let computed = build_session_computation(&path, 1, 2, summary, stats);
    assert_eq!(computed.session_id, session_id);
    assert_eq!(computed.title, "Kimi summary");

    let files = kimi::collect_kimi_session_files(&home);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "kimi");
    assert_eq!(files[0].path, path);

    let mut iterated = Vec::new();
    iter_session_messages(&path, |_, message| {
        iterated.push(message.content);
        true
    })
    .unwrap();
    assert_eq!(iterated[0], "hello kimi");
    assert_eq!(iterated[1], "hi there");
}

#[test]
fn exact_kimi_session_lookup_bypasses_catalog_miss() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".kimi-code");
    let session_id = "01KIMIEXACTLOOKUP00000001";
    let path = write_kimi_session_fixture(
        &home,
        session_id,
        r"F:\github\CLI-Manager",
        &[json!({
            "type": "turn.prompt",
            "input": [{"type": "text", "text": "hello"}]
        })],
    );

    let summary =
        kimi::find_exact_kimi_session_in_root(&home, session_id, Some(r"F:\github\CLI-Manager"))
            .expect("exact Kimi session should be found directly from disk");
    assert_eq!(summary.session_id, session_id);
    assert_eq!(summary.source, "kimi");
    assert_eq!(
        PathBuf::from(&summary.file_path).canonicalize().unwrap(),
        path.canonicalize().unwrap()
    );

    assert!(
        kimi::find_exact_kimi_session_in_root(&home, session_id, Some(r"F:\other-project"),)
            .is_none()
    );
    assert!(kimi::find_exact_kimi_session_in_root(&home, "../session", None).is_none());
    assert!(kimi::find_exact_kimi_session_in_root(&home, "bad/id", None).is_none());
}

#[test]
fn exact_kimi_lookup_rejects_index_session_dir_escape() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".kimi-code");
    std::fs::create_dir_all(home.join("sessions")).unwrap();
    let session_id = "01KIMIESCAPE0000000000001";
    let outsider_wire = write_kimi_session_fixture(
        &temp_dir.path().join("outside"),
        session_id,
        r"F:\github\CLI-Manager",
        &[json!({
            "type": "turn.prompt",
            "input": [{"type": "text", "text": "hello"}]
        })],
    );
    let escaped_dir = home
        .join("sessions")
        .join("..")
        .join("..")
        .join("outside")
        .join("sessions")
        .join("wd__fixture")
        .join(session_id);
    write_text(
        &home.join("session_index.jsonl"),
        &json!({
            "sessionId": session_id,
            "sessionDir": escaped_dir.to_string_lossy(),
            "workDir": r"F:\github\CLI-Manager"
        })
        .to_string(),
    );
    assert!(outsider_wire.exists());
    assert!(kimi::find_exact_kimi_session_in_root(&home, session_id, None).is_none());
}

#[test]
fn kimi_workspace_fallback_uses_latest_active_index_record() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".kimi-code");
    let session_id = "01KIMIWORKDIRLATEST000001";
    let path = write_kimi_session_fixture(
        &home,
        session_id,
        r"F:\old-workdir",
        &[json!({
            "type": "turn.prompt",
            "input": [{"type": "text", "text": "hello"}]
        })],
    );
    let session_dir = kimi::kimi_session_dir_from_wire(&path).unwrap();
    write_text(
        &session_dir.join("state.json"),
        &json!({"title": "No embedded workdir"}).to_string(),
    );
    let mut index = OpenOptions::new()
        .append(true)
        .open(home.join("session_index.jsonl"))
        .unwrap();
    writeln!(
        index,
        "{}",
        json!({
            "sessionId": session_id,
            "sessionDir": session_dir.to_string_lossy(),
            "workDir": r"F:\new-workdir"
        })
    )
    .unwrap();
    assert_eq!(
        kimi::kimi_workspace_from_path(&path).as_deref(),
        Some(r"F:\new-workdir")
    );

    writeln!(
        index,
        "{}",
        json!({"sessionId": session_id, "deleted": true})
    )
    .unwrap();
    drop(index);
    assert!(kimi::kimi_workspace_from_path(&path).is_none());
    assert!(path.exists());
    assert!(kimi::collect_kimi_session_files(&home).is_empty());
    assert!(kimi::find_exact_kimi_session_in_root(&home, session_id, None).is_none());
}

#[test]
fn kimi_delete_removes_session_dir_and_index_row() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".kimi-code");
    let session_id = "01KIMIDELETESESSION000001";
    let path = write_kimi_session_fixture(
        &home,
        session_id,
        r"F:\github\CLI-Manager",
        &[json!({
            "type": "turn.prompt",
            "input": [{"type": "text", "text": "hello"}]
        })],
    );
    let file_ref = SessionFileRef {
        source: "kimi".to_string(),
        project_key: normalize_history_path(r"F:\github\CLI-Manager"),
        path: path.clone(),
    };

    kimi::delete_kimi_session_tree_with_backup_root(
        &file_ref,
        &home,
        &temp_dir.path().join("backups"),
    )
    .unwrap();
    assert!(!path.exists());
    assert!(!path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .exists());
    let index = std::fs::read_to_string(home.join("session_index.jsonl")).unwrap();
    assert!(index.contains("other-session"));
    let tombstone: Value = serde_json::from_str(index.lines().last().unwrap()).unwrap();
    assert_eq!(
        tombstone.get("sessionId").and_then(Value::as_str),
        Some(session_id)
    );
    assert_eq!(
        tombstone.get("deleted").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn kimi_delete_rejects_session_outside_history_home() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".kimi-code");
    std::fs::create_dir_all(&home).unwrap();
    let outsider = temp_dir.path().join("outside");
    let path = write_kimi_session_fixture(
        &outsider,
        "01KIMIOUTSIDEHOME000000001",
        r"F:\github\CLI-Manager",
        &[json!({
            "type": "turn.prompt",
            "input": [{"type": "text", "text": "hello"}]
        })],
    );
    let file_ref = SessionFileRef {
        source: "kimi".to_string(),
        project_key: normalize_history_path(r"F:\github\CLI-Manager"),
        path,
    };
    let err = kimi::delete_kimi_session_tree_with_backup_root(
        &file_ref,
        &home,
        &temp_dir.path().join("backups"),
    )
    .unwrap_err();
    assert_eq!(err, "session_file_outside_history_scope");
}

#[test]
fn kimi_history_root_uses_explicit_config_dir_and_ignores_legacy_home() {
    let temp_dir = TempDir::new().unwrap();
    let custom = temp_dir.path().join("custom-kimi");
    let legacy = temp_dir.path().join(".kimi");
    write_kimi_session_fixture(
        &custom,
        "01KIMICUSTOMROOT000000001",
        r"F:\github\CLI-Manager",
        &[json!({"type": "turn.prompt", "input": [{"type": "text", "text": "custom"}]})],
    );
    write_text(
        &legacy.join("sessions").join("old").join("wire.jsonl"),
        "{}\n",
    );
    let roots = history_roots(None, None, None)
        .with_kimi_config_dir(Some(custom.to_string_lossy().into_owned()));
    let files = kimi::collect_kimi_session_files(&kimi::resolve_kimi_history_root(&roots));
    assert_eq!(files.len(), 1);
    assert!(files[0].path.starts_with(&custom.join("sessions")));
    assert!(kimi::collect_kimi_session_files(&legacy).is_empty());
}

#[test]
fn kimi_application_pipeline_lists_details_and_deletes_like_history_workspace() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".kimi-code");
    let session_id = "01KIMIAPPPIPELINE00000001";
    let cwd = r"/home/ubuntu/CLI-Manager";
    write_kimi_session_fixture(
        &home,
        session_id,
        cwd,
        &[
            json!({
                "type": "turn.prompt",
                "time": 1_787_097_600_000i64,
                "input": [{"type": "text", "text": "review the kimi history parser"}],
                "origin": {"kind": "user"}
            }),
            json!({
                "type": "context.append_message",
                "time": 1_787_097_600_001i64,
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "review the kimi history parser"}],
                    "toolCalls": []
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_601_000i64,
                "event": {"type": "step.begin", "uuid": "step-1", "turnId": "turn-1", "step": 0}
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_601_100i64,
                "event": {
                    "type": "content.part",
                    "uuid": "content-1",
                    "turnId": "turn-1",
                    "step": 0,
                    "stepUuid": "step-1",
                    "part": {"type": "text", "text": "looking at wire.jsonl"}
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_602_000i64,
                "event": {
                    "type": "tool.call",
                    "uuid": "tool-1",
                    "turnId": "turn-1",
                    "step": 0,
                    "stepUuid": "step-1",
                    "toolCallId": "call-1",
                    "name": "Read",
                    "args": {"path": "src-tauri/src/commands/history/kimi.rs"}
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_602_100i64,
                "event": {
                    "type": "tool.result",
                    "parentUuid": "tool-1",
                    "toolCallId": "call-1",
                    "result": {"output": "source"}
                }
            }),
            json!({
                "type": "context.append_loop_event",
                "time": 1_787_097_602_200i64,
                "event": {
                    "type": "step.end",
                    "uuid": "step-1",
                    "turnId": "turn-1",
                    "step": 0,
                    "usage": {"inputOther": 120, "output": 40, "inputCacheRead": 8, "inputCacheCreation": 0},
                    "finishReason": "tool_calls"
                }
            }),
            json!({
                "type": "usage.record",
                "time": 1_787_097_603_000i64,
                "model": "kimi-k2",
                "usage": {
                    "inputOther": 120,
                    "output": 40,
                    "inputCacheRead": 8,
                    "inputCacheCreation": 0
                }
            }),
        ],
    );
    let roots = history_roots(None, None, None)
        .with_kimi_config_dir(Some(home.to_string_lossy().into_owned()));

    let files = collect_session_files(Some("kimi"), &roots);
    assert_eq!(
        files.len(),
        1,
        "history list should index only main wire.jsonl"
    );
    assert_eq!(files[0].source, "kimi");
    assert_eq!(files[0].project_key, normalize_history_path(cwd));

    let detail = build_session_detail(&files[0], true).unwrap();
    assert_eq!(detail.session_id, session_id);
    assert_eq!(detail.source, "kimi");
    assert_eq!(detail.title, "Kimi summary");
    assert_eq!(detail.cwd.as_deref(), Some(cwd));
    assert_eq!(detail.messages[0].role, "user");
    assert_eq!(detail.messages[0].content, "review the kimi history parser");
    assert_eq!(detail.usage.input_tokens, 120);
    assert_eq!(detail.usage.output_tokens, 40);
    assert_eq!(detail.usage.cache_read_tokens, 8);
    assert_eq!(detail.usage.current_model.as_deref(), Some("kimi-k2"));
    assert_eq!(detail.usage.tool_call_count, 1);

    let exact = kimi::find_exact_kimi_session_in_root(&home, session_id, Some(cwd))
        .expect("realtime stats should hit the bound session without scanning every transcript");
    assert_eq!(exact.session_id, session_id);
    assert_eq!(exact.source, "kimi");

    kimi::delete_kimi_session_tree_with_backup_root(
        &files[0],
        &home,
        &temp_dir.path().join("backups"),
    )
    .unwrap();
    invalidate_history_caches();
    let files_after = collect_session_files_with_force(Some("kimi"), &roots, true);
    assert!(files_after.is_empty());
    assert!(kimi::find_exact_kimi_session_in_root(&home, session_id, None).is_none());
    let index = std::fs::read_to_string(home.join("session_index.jsonl")).unwrap();
    assert!(index.contains("other-session"));
    let tombstone: Value = serde_json::from_str(index.lines().last().unwrap()).unwrap();
    assert_eq!(
        tombstone.get("sessionId").and_then(Value::as_str),
        Some(session_id)
    );
    assert_eq!(
        tombstone.get("deleted").and_then(Value::as_bool),
        Some(true)
    );
}
