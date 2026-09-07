use super::*;

#[test]
fn convert_codex_history_to_claude_jsonl_readable_by_history_parser() {
    let temp_dir = TempDir::new().unwrap();
    let roots = HistoryRoots {
        claude_config_dir: Some(temp_dir.path().join(".claude")),
        codex_config_dir: Some(temp_dir.path().join(".codex")),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    if cfg!(target_os = "windows") {
        std::fs::create_dir_all(
            resolve_claude_history_root(&roots).join("F--ws-Labway-Fee-Control"),
        )
        .unwrap();
    }

    let mut source_detail = sample_detail("codex");
    source_detail.cwd = Some(r"F:\ws\Labway\Fee-Control".to_string());
    let result = convert_history_session(&source_detail, "claude", &roots).unwrap();
    assert_eq!(result.target_source, "claude");
    assert_eq!(result.message_count, 2);
    assert!(result.resume_command.starts_with("claude --resume "));
    assert_eq!(result.summary.source, "claude");
    assert_eq!(result.summary.session_id, result.session_id);
    assert_eq!(result.summary.message_count, 2);
    assert_eq!(result.detail.source, "claude");
    assert_eq!(result.detail.session_id, result.session_id);
    assert_eq!(result.detail.file_path, result.summary.file_path);
    assert_eq!(result.detail.messages.len(), 2);

    let files = collect_claude_session_files(&resolve_claude_history_root(&roots));
    assert_eq!(files.len(), 1);
    assert_eq!(result.project_key, files[0].project_key);
    assert_eq!(result.summary.project_key, files[0].project_key);
    assert_eq!(result.detail.project_key, files[0].project_key);
    let reopened = validate_session_file_ref(
        &result.file_path,
        &result.target_source,
        &result.project_key,
        &roots,
    )
    .unwrap();
    assert_eq!(reopened.path, files[0].path.canonicalize().unwrap());
    let detail = build_session_detail(&files[0], false).unwrap();
    assert_eq!(detail.source, "claude");
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.messages[0].role, "user");
    assert_eq!(detail.messages[0].content, "hello");
    assert_eq!(detail.messages[1].role, "assistant");

    let raw_lines = std::fs::read_to_string(&files[0].path).unwrap();
    let assistant_line = raw_lines.lines().nth(1).unwrap();
    let assistant_value: Value = serde_json::from_str(assistant_line).unwrap();
    assert!(assistant_value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .is_some());
}

#[test]
fn convert_claude_history_to_codex_jsonl_readable_by_history_parser() {
    let temp_dir = TempDir::new().unwrap();
    let roots = HistoryRoots {
        claude_config_dir: Some(temp_dir.path().join(".claude")),
        codex_config_dir: Some(temp_dir.path().join(".codex")),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    write_text(
        &resolve_codex_config_root(&roots).join("config.toml"),
        "model_provider = \"test-provider\"\nmodel = \"gpt-test\"\nsqlite_home = \"sqlite\"\n",
    );

    let result = convert_history_session(&sample_detail("claude"), "codex", &roots).unwrap();
    assert_eq!(result.target_source, "codex");
    assert_eq!(result.message_count, 2);
    assert!(result.resume_command.starts_with("codex resume "));
    assert_eq!(result.summary.source, "codex");
    assert_eq!(result.summary.session_id, result.session_id);
    assert_eq!(result.summary.message_count, 2);
    assert_eq!(result.detail.source, "codex");
    assert_eq!(result.detail.session_id, result.session_id);
    assert_eq!(result.detail.file_path, result.summary.file_path);
    assert_eq!(result.detail.messages.len(), 2);

    let files = collect_codex_session_files(&resolve_codex_history_root(&roots));
    assert_eq!(files.len(), 1);
    let file_name = files[0]
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap();
    assert!(file_name.starts_with("rollout-20"));
    assert!(file_name.contains(&result.session_id));

    let raw_lines = std::fs::read_to_string(&files[0].path).unwrap();
    let session_meta: Value = serde_json::from_str(raw_lines.lines().next().unwrap()).unwrap();
    assert_eq!(
        session_meta
            .get("payload")
            .and_then(|payload| payload.get("session_id"))
            .and_then(Value::as_str),
        Some(result.session_id.as_str())
    );
    assert_eq!(
        session_meta
            .get("payload")
            .and_then(|payload| payload.get("model_provider"))
            .and_then(Value::as_str),
        Some("test-provider")
    );
    assert_eq!(
        session_meta
            .get("payload")
            .and_then(|payload| payload.get("cli_version"))
            .and_then(Value::as_str),
        Some("cli-manager-converted")
    );
    let codex_lines: Vec<Value> = raw_lines
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(codex_lines.iter().any(|line| {
        line.get("type").and_then(Value::as_str) == Some("event_msg")
            && line
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                == Some("user_message")
    }));
    assert!(codex_lines.iter().any(|line| {
        line.get("type").and_then(Value::as_str) == Some("event_msg")
            && line
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                == Some("agent_message")
    }));

    let history_index =
        std::fs::read_to_string(resolve_codex_config_root(&roots).join("history.jsonl")).unwrap();
    let history_entry: Value = serde_json::from_str(history_index.lines().next().unwrap()).unwrap();
    assert_eq!(
        history_entry.get("session_id").and_then(Value::as_str),
        Some(result.session_id.as_str())
    );
    assert_eq!(
        history_entry.get("text").and_then(Value::as_str),
        Some("hello")
    );
    let session_index =
        std::fs::read_to_string(resolve_codex_config_root(&roots).join("session_index.jsonl"))
            .unwrap();
    let session_entry: Value = serde_json::from_str(session_index.lines().next().unwrap()).unwrap();
    assert_eq!(
        session_entry.get("id").and_then(Value::as_str),
        Some(result.session_id.as_str())
    );
    assert_eq!(
        resolve_codex_state_db_path(&roots),
        resolve_codex_config_root(&roots)
            .join("sqlite")
            .join("state_5.sqlite")
    );

    let detail = build_session_detail(&files[0], false).unwrap();
    assert_eq!(detail.source, "codex");
    assert_eq!(detail.session_id, result.session_id);
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.messages[0].role, "user");
    assert_eq!(detail.messages[1].content, "world");
}

#[test]
fn append_jsonl_line_keeps_concurrent_records_intact() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("index.jsonl");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let handles = (0..8)
        .map(|worker| {
            let path = path.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                for record in 0..50 {
                    append_jsonl_line(&path, &json!({ "worker": worker, "record": record }))
                        .unwrap();
                }
            })
        })
        .collect::<Vec<_>>();

    for handle in handles {
        handle.join().unwrap();
    }

    let content = std::fs::read_to_string(path).unwrap();
    let records = content
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 400);
}

#[test]
fn v2_adapter_outputs_claude_session_ref_and_raw_pointers() {
    let temp_dir = TempDir::new().unwrap();
    let roots = HistoryRoots {
        claude_config_dir: Some(temp_dir.path().join(".claude")),
        codex_config_dir: Some(temp_dir.path().join(".codex")),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let file = resolve_claude_history_root(&roots)
        .join("proj")
        .join("claude-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}"#,
            "\n",
        ),
    );
    let file_ref = SessionFileRef {
        source: "claude".to_string(),
        project_key: "proj".to_string(),
        path: file.clone(),
    };

    let adapted = build_v2_adapter_session(&file_ref, &roots);

    assert_eq!(adapted.session_ref.source_id, "claude");
    assert_eq!(adapted.session_ref.source_session_id, "claude-session");
    assert_eq!(adapted.session_ref.storage_kind, "file");
    assert_eq!(
        adapted.session_ref.primary_path.as_deref(),
        Some(file.to_string_lossy().as_ref())
    );
    assert_eq!(adapted.session_ref.raw_pointers.len(), 1);
    assert_eq!(adapted.session_ref.raw_pointers[0].role, "primary");
    assert_eq!(adapted.messages.len(), 1);
    assert_eq!(adapted.messages[0].role, "user");
    assert_eq!(adapted.messages[0].display_content, "hello");
    assert_eq!(adapted.messages[0].raw_pointers[0].line_index, Some(0));
}

#[test]
fn v2_adapter_outputs_codex_mixed_artifact_raw_pointers() {
    let temp_dir = TempDir::new().unwrap();
    let roots = HistoryRoots {
        claude_config_dir: Some(temp_dir.path().join(".claude")),
        codex_config_dir: Some(temp_dir.path().join(".codex")),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    write_text(
        &resolve_codex_config_root(&roots).join("config.toml"),
        "model_provider = \"test-provider\"\nmodel = \"gpt-test\"\nsqlite_home = \"sqlite\"\n",
    );
    let result = convert_history_session(&sample_detail("claude"), "codex", &roots).unwrap();
    let file_ref = collect_codex_session_files(&resolve_codex_history_root(&roots))
        .into_iter()
        .next()
        .unwrap();

    let adapted = build_v2_adapter_session(&file_ref, &roots);

    assert_eq!(adapted.session_ref.source_id, "codex");
    assert_eq!(adapted.session_ref.source_session_id, result.session_id);
    assert_eq!(adapted.session_ref.storage_kind, "mixed");
    assert_eq!(
        adapted.session_ref.primary_path.as_deref(),
        Some(result.summary.file_path.as_str())
    );
    assert_eq!(
        adapted.session_ref.database_path.as_deref(),
        Some(
            resolve_codex_state_db_path(&roots)
                .to_string_lossy()
                .as_ref()
        )
    );
    let pointer_kinds: HashSet<&str> = adapted
        .session_ref
        .raw_pointers
        .iter()
        .map(|pointer| pointer.kind.as_str())
        .collect();
    assert!(pointer_kinds.contains("codex-jsonl"));
    assert!(pointer_kinds.contains("codex-history-jsonl"));
    assert!(pointer_kinds.contains("codex-session-index-jsonl"));
    assert!(pointer_kinds.contains("codex-state-thread-row"));
    assert_eq!(adapted.messages.len(), 2);
    assert!(adapted
        .messages
        .iter()
        .all(|message| !message.raw_pointers.is_empty()));
}

#[tokio::test]
async fn conversion_matrix_supports_current_writers_and_plans_other_pairs() {
    let matrix = history_get_conversion_matrix().await.unwrap();
    let claude_to_codex = matrix
        .iter()
        .find(|item| item.source_id == "claude" && item.target_id == "codex")
        .unwrap();
    assert_eq!(claude_to_codex.state, "supported");
    assert_eq!(claude_to_codex.writer_state, "supported");

    let gemini_to_codex = matrix
        .iter()
        .find(|item| item.source_id == "gemini" && item.target_id == "codex")
        .unwrap();
    assert_eq!(gemini_to_codex.state, "planned");
    assert_eq!(gemini_to_codex.writer_state, "planned");

    let same_source = matrix
        .iter()
        .find(|item| item.source_id == "claude" && item.target_id == "claude")
        .unwrap();
    assert_eq!(same_source.state, "unsupported");
}
