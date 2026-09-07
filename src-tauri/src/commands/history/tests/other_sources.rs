use super::*;

#[test]
fn scan_json_session_reads_gemini_messages() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir
        .path()
        .join("hash-a")
        .join("chats")
        .join("session-2026-01-01T00-00-00.json");
    write_text(
        &path,
        &json!({
            "sessionId": "gemini-session",
            "projectHash": "hash-a",
            "startTime": "2026-01-01T00:00:00Z",
            "messages": [
                {
                    "id": "m1",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "type": "user",
                    "content": "hello gemini"
                },
                {
                    "id": "m2",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "type": "gemini",
                    "content": "hi user",
                    "model": "gemini-2.5-pro",
                    "tokens": {
                        "input": 120,
                        "output": 30,
                        "thoughts": 10,
                        "cached": 20,
                        "cacheCreation": 5
                    }
                }
            ]
        })
        .to_string(),
    );

    let (summary, stats, messages) = scan_session_detail(&path);

    assert_eq!(summary.session_id.as_deref(), Some("gemini-session"));
    assert_eq!(summary.message_count, 2);
    assert_eq!(summary.first_user_message.as_deref(), Some("hello gemini"));
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].content, "hi user");
    assert_eq!(messages[1].input_tokens, Some(100));
    assert_eq!(messages[1].output_tokens, Some(40));
    assert_eq!(messages[1].cache_read_tokens, Some(20));
    assert_eq!(messages[1].cache_creation_tokens, Some(5));
    assert!(messages.iter().all(|message| !message.editable));
    assert_eq!(stats.input_tokens, 100);
    assert_eq!(stats.output_tokens, 40);
    assert_eq!(stats.cache_read_tokens, 20);
    assert_eq!(stats.cache_creation_tokens, 5);
    assert_eq!(stats.usage_events.len(), 1);
    assert_eq!(stats.usage_events[0].event_key, "gemini:m2");
}

#[test]
fn scan_json_session_reads_kiro_workspace_history() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir
        .path()
        .join("workspace-key")
        .join("kiro-session.json");
    write_text(
        &path,
        &json!({
            "sessionId": "kiro-session",
            "title": "Kiro title",
            "workspaceDirectory": r"F:\idea-work\business-center",
            "selectedModel": "claude-sonnet-4",
            "history": [
                {
                    "message": {
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "hello kiro" },
                            { "type": "file", "path": "src/main.rs" }
                        ]
                    }
                },
                {
                    "message": {
                        "role": "assistant",
                        "content": "kiro answer"
                    }
                }
            ]
        })
        .to_string(),
    );

    let (summary, stats, messages) = scan_session_detail(&path);
    let project = scan_session_project(&path);

    assert_eq!(summary.session_id.as_deref(), Some("kiro-session"));
    assert_eq!(summary.message_count, 2);
    assert_eq!(summary.first_user_message.as_deref(), Some("hello kiro"));
    assert_eq!(messages[0].content, "hello kiro");
    assert_eq!(messages[1].model.as_deref(), Some("claude-sonnet-4"));
    assert_eq!(stats.dominant_model.as_deref(), Some("claude-sonnet-4"));
    assert_eq!(
        project.cwd.as_deref(),
        Some(r"F:\idea-work\business-center")
    );
}

#[test]
fn copilot_events_jsonl_parser_covers_history_pipeline() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().join("session-state");
    let path = root.join("directory-fallback").join("events.jsonl");
    let events = [
        json!({
            "type": "session.start",
            "timestamp": "2026-01-01T00:00:00Z",
            "data": {
                "sessionId": "copilot-session",
                "startTime": "2026-01-01T00:00:00Z",
                "context": { "cwd": r"F:\idea-work\business-center" }
            }
        }),
        json!({
            "type": "user.message",
            "timestamp": "2026-01-01T00:00:01Z",
            "data": { "content": "hello copilot" }
        }),
        json!({
            "type": "assistant.message",
            "timestamp": "2026-01-01T00:00:02Z",
            "data": {
                "content": "I will read it.",
                "model": "gpt-4.1",
                "toolRequests": [{
                    "toolCallId": "tool-1",
                    "name": "read_file",
                    "arguments": { "path": "README.md" }
                }]
            }
        }),
        json!({
            "type": "tool.execution_start",
            "timestamp": "2026-01-01T00:00:03Z",
            "data": {
                "toolCallId": "tool-1",
                "toolName": "read_file",
                "arguments": { "path": "README.md" }
            }
        }),
        json!({
            "type": "tool.execution_complete",
            "timestamp": "2026-01-01T00:00:04Z",
            "data": {
                "toolCallId": "tool-1",
                "toolName": "read_file",
                "success": true,
                "result": {
                    "content": "short summary",
                    "detailedContent": "# Project\nHello"
                }
            }
        }),
    ]
    .into_iter()
    .map(|event| event.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    write_text(&path, &events);

    let files = collect_copilot_session_files(&root);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "copilot");
    assert_eq!(files[0].project_key, "business-center");

    let (summary, stats, messages) = scan_session_detail(&path);
    assert_eq!(summary.session_id.as_deref(), Some("copilot-session"));
    assert_eq!(summary.message_count, 3);
    assert_eq!(summary.first_user_message.as_deref(), Some("hello copilot"));
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].model.as_deref(), Some("gpt-4.1"));
    assert_eq!(messages[2].role, "tool");
    assert_eq!(messages[2].content, "# Project\nHello");
    assert_eq!(messages[2].line_index, Some(4));
    assert!(messages.iter().all(|message| !message.editable));
    assert_eq!(stats.tool_call_count, 1);
    assert_eq!(stats.builtin_calls.get("read_file"), Some(&1));

    let project = scan_session_project(&path);
    assert_eq!(
        project.cwd.as_deref(),
        Some(r"F:\idea-work\business-center")
    );
    let computed = build_session_computation(&path, 1, 2, summary, stats);
    assert_eq!(computed.session_id, "copilot-session");

    let tool_events = scan_tool_events(&path);
    assert_eq!(tool_events.len(), 1);
    assert_eq!(tool_events[0].name, "read_file");
    assert_eq!(tool_events[0].status.as_deref(), Some("completed"));
    assert_eq!(
        tool_events[0].output_summary.as_deref(),
        Some("# Project\nHello")
    );

    let mut iterated = Vec::new();
    iter_session_messages(&path, |_, message| {
        iterated.push(message.content);
        true
    })
    .unwrap();
    assert_eq!(iterated.len(), 3);
}

#[test]
fn antigravity_transcript_parser_covers_history_pipeline() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().join("antigravity-cli");
    let conversation_id = "52d82992-7695-4d38-8d02-9747eecba839";
    let path = root
        .join("brain")
        .join(conversation_id)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    write_text(
        &root.join("history.jsonl"),
        &json!({
            "display": "fixture",
            "workspace": r"F:\idea-work\business-center",
            "conversationId": conversation_id
        })
        .to_string(),
    );
    let transcript = [
        json!({
            "step_index": 0,
            "source": "USER_EXPLICIT",
            "type": "USER_INPUT",
            "status": "DONE",
            "created_at": "2026-05-20T06:03:19Z",
            "content": "<USER_REQUEST>\nAnalyze this project\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>"
        }),
        json!({
            "step_index": 2,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "created_at": "2026-05-20T06:03:20Z",
            "tool_calls": [{ "name": "list_dir" }]
        }),
        json!({
            "step_index": 3,
            "source": "MODEL",
            "type": "LIST_DIRECTORY",
            "status": "DONE",
            "created_at": "2026-05-20T06:03:21Z",
            "content": "tool output should not be indexed"
        }),
        json!({
            "step_index": 15,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "created_at": "2026-05-20T06:03:30Z",
            "content": "This project is a local agent configuration hub."
        }),
        json!({
            "source": "USER_EXPLICIT",
            "type": "USER_INPUT",
            "status": "RUNNING",
            "content": "unfinished"
        }),
    ]
    .into_iter()
    .map(|event| event.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    write_text(&path, &transcript);

    let files = collect_antigravity_session_files(&root);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "antigravity");
    assert_eq!(files[0].project_key, "business-center");

    let (summary, stats, messages) = scan_session_detail(&path);
    assert_eq!(summary.session_id.as_deref(), Some(conversation_id));
    assert_eq!(summary.message_count, 2);
    assert_eq!(
        summary.first_user_message.as_deref(),
        Some("Analyze this project")
    );
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "Analyze this project");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(
        messages[1].content,
        "This project is a local agent configuration hub."
    );
    assert_eq!(messages[1].line_index, Some(3));
    assert_eq!(stats.tool_call_count, 1);
    assert_eq!(stats.builtin_calls.get("list_dir"), Some(&1));

    let project = scan_session_project(&path);
    assert_eq!(
        project.cwd.as_deref(),
        Some(r"F:\idea-work\business-center")
    );
    let computed = build_session_computation(&path, 1, 2, summary, stats);
    assert_eq!(computed.session_id, conversation_id);

    let mut iterated = Vec::new();
    iter_session_messages(&path, |_, message| {
        iterated.push(message.content);
        true
    })
    .unwrap();
    assert_eq!(iterated.len(), 2);
}

#[test]
fn pi_session_parser_covers_history_pipeline() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().join(".pi").join("agent");
    let path = root
        .join("sessions")
        .join("--F--idea-work-business-center--")
        .join("20260717_pi-session.jsonl");
    let lines = [
        json!({
            "type": "session",
            "sessionId": "pi-session",
            "cwd": r"F:\idea-work\business-center",
            "title": "Pi summary",
            "model": "pi-agent"
        }),
        json!({
            "type": "message",
            "timestamp": "2026-07-17T00:00:00Z",
            "message": {
                "role": "user",
                "content": "hello pi"
            }
        }),
        json!({
            "type": "message",
            "timestamp": "2026-07-17T00:00:01Z",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "hi user" },
                    {
                        "type": "toolCall",
                        "toolCallId": "tc1",
                        "name": "read_file",
                        "arguments": { "path": "README.md" }
                    }
                ]
            }
        }),
        json!({
            "type": "message",
            "timestamp": "2026-07-17T00:00:02Z",
            "message": {
                "role": "toolResult",
                "toolCallId": "tc1",
                "content": "README content"
            }
        }),
    ]
    .into_iter()
    .map(|line| line.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    write_text(&path, &lines);

    let files = collect_pi_session_files(&root);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "pi");
    assert_eq!(files[0].project_key, "business-center");

    let (summary, stats, messages) = scan_session_detail(&path);
    assert_eq!(summary.session_id.as_deref(), Some("pi-session"));
    assert_eq!(summary.message_count, 3);
    assert_eq!(summary.first_user_message.as_deref(), Some("hello pi"));
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "hello pi");
    assert_eq!(messages[1].role, "assistant");
    assert!(messages[1].content.contains("hi user"));
    assert_eq!(messages[1].model.as_deref(), Some("pi-agent"));
    assert_eq!(messages[2].role, "tool");
    assert_eq!(stats.current_model.as_deref(), Some("pi-agent"));
    assert_eq!(stats.tool_call_count, 1);
    assert_eq!(stats.builtin_calls.get("read_file"), Some(&1));

    let project = scan_session_project(&path);
    assert_eq!(
        project.cwd.as_deref(),
        Some(r"F:\idea-work\business-center")
    );
    let computed = build_session_computation(&path, 1, 2, summary, stats);
    assert_eq!(computed.session_id, "pi-session");

    let tool_events = scan_tool_events(&path);
    assert_eq!(tool_events.len(), 1);
    assert_eq!(tool_events[0].name, "read_file");
    assert_eq!(tool_events[0].status.as_deref(), Some("completed"));
    assert_eq!(
        tool_events[0].output_summary.as_deref(),
        Some("README content")
    );

    let mut iterated = Vec::new();
    iter_session_messages(&path, |_, message| {
        iterated.push(message.role);
        true
    })
    .unwrap();
    assert_eq!(iterated, vec!["user", "assistant", "tool"]);
}

#[test]
fn cline_task_parser_covers_history_pipeline() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().join("saoudrizwan.claude-dev");
    let path = root
        .join("tasks")
        .join("cline-task")
        .join("api_conversation_history.json");
    write_text(
        &path.with_file_name("task_metadata.json"),
        &json!({
            "taskId": "cline-task",
            "task": "Cline summary",
            "cwd": r"F:\idea-work\business-center",
            "modelId": "claude-3-5-sonnet-20241022"
        })
        .to_string(),
    );
    write_text(
        &path.with_file_name("ui_messages.json"),
        &json!([
            { "ts": 1784246400000u64 },
            { "ts": 1784246401000u64 },
            { "ts": 1784246402000u64 },
            { "ts": 1784246403000u64 }
        ])
        .to_string(),
    );
    write_text(
        &path,
        &json!([
            {
                "role": "user",
                "content": [{ "type": "text", "text": "hello cline" }]
            },
            {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "I will edit it." },
                    {
                        "type": "tool_use",
                        "id": "tool-1",
                        "name": "replace_in_file",
                        "input": {
                            "path": "src/main.rs",
                            "old_string": "old",
                            "new_string": "new"
                        }
                    }
                ]
            },
            {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "content": "edited"
                }]
            },
            {
                "role": "assistant",
                "content": "done"
            }
        ])
        .to_string(),
    );

    let files = collect_cline_session_files(&root);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "cline");
    assert_eq!(files[0].project_key, "business-center");

    let (summary, stats, messages) = scan_session_detail(&path);
    assert_eq!(summary.session_id.as_deref(), Some("cline-task"));
    assert_eq!(summary.message_count, 4);
    assert_eq!(summary.first_user_message.as_deref(), Some("hello cline"));
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(
        messages[1].model.as_deref(),
        Some("claude-3-5-sonnet-20241022")
    );
    assert_eq!(messages[2].role, "tool");
    assert_eq!(
        messages[0].timestamp.as_deref(),
        Some("2026-07-17T00:00:00.000Z")
    );
    assert_eq!(
        stats.current_model.as_deref(),
        Some("claude-3-5-sonnet-20241022")
    );
    assert_eq!(stats.tool_call_count, 1);
    assert_eq!(stats.builtin_calls.get("replace_in_file"), Some(&1));

    let project = scan_session_project(&path);
    assert_eq!(
        project.cwd.as_deref(),
        Some(r"F:\idea-work\business-center")
    );
    let computed = build_session_computation(&path, 1, 2, summary, stats);
    assert_eq!(computed.session_id, "cline-task");

    let tool_events = scan_tool_events(&path);
    assert_eq!(tool_events.len(), 1);
    assert_eq!(tool_events[0].name, "replace_in_file");
    assert_eq!(tool_events[0].status.as_deref(), Some("completed"));
    assert_eq!(tool_events[0].output_summary.as_deref(), Some("edited"));

    let file_changes = scan_file_changes(&path);
    assert_eq!(file_changes.len(), 1);
    assert_eq!(file_changes[0].file_path, "src/main.rs");
    assert_eq!(file_changes[0].additions, 1);
    assert_eq!(file_changes[0].deletions, 1);

    let mut iterated = Vec::new();
    iter_session_messages(&path, |_, message| {
        iterated.push(message.role);
        true
    })
    .unwrap();
    assert_eq!(iterated, vec!["user", "assistant", "tool", "assistant"]);
}

#[test]
fn cursor_agent_transcript_parser_covers_history_pipeline() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().join(".cursor").join("projects");
    let session_id = "94cf58c5-78c3-49c8-9bb0-4c2ba2f97aa0";
    let path = root
        .join("f-github-CLI-Manager")
        .join("agent-transcripts")
        .join(session_id)
        .join(format!("{session_id}.jsonl"));
    let lines = [
        json!({
            "role": "user",
            "message": {
                "content": [{ "type": "text", "text": "hello cursor" }]
            }
        }),
        json!({
            "role": "assistant",
            "message": {
                "content": [
                    { "type": "text", "text": "I will update it." },
                    {
                        "type": "tool_use",
                        "id": "tool-1",
                        "name": "Edit",
                        "input": {
                            "path": "src/main.rs",
                            "old_string": "old",
                            "new_string": "new"
                        }
                    }
                ]
            }
        }),
        json!({ "type": "turn_ended", "status": "completed" }),
    ]
    .into_iter()
    .map(|line| line.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    write_text(&path, &lines);

    let files = collect_cursor_session_files(&root);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "cursor");
    assert_eq!(files[0].project_key, "f-github-CLI-Manager");
    #[cfg(windows)]
    assert!(session_matches_project_path(
        &files[0],
        &normalize_history_path(r"F:\github\CLI-Manager")
    ));

    let (summary, stats, messages) = scan_session_detail(&path);
    assert_eq!(summary.session_id.as_deref(), Some(session_id));
    assert_eq!(summary.message_count, 2);
    assert_eq!(summary.first_user_message.as_deref(), Some("hello cursor"));
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].line_index, Some(1));
    assert_eq!(stats.tool_call_count, 1);
    assert_eq!(stats.builtin_calls.get("Edit"), Some(&1));

    let computed = build_session_computation(&path, 1, 2, summary, stats);
    assert_eq!(computed.session_id, session_id);

    let tool_events = scan_tool_events(&path);
    assert_eq!(tool_events.len(), 1);
    assert_eq!(tool_events[0].name, "Edit");
    assert_eq!(tool_events[0].status.as_deref(), Some("started"));

    let file_changes = scan_file_changes(&path);
    assert_eq!(file_changes.len(), 1);
    assert_eq!(file_changes[0].file_path, "src/main.rs");
    assert_eq!(file_changes[0].additions, 1);
    assert_eq!(file_changes[0].deletions, 1);

    let mut iterated = Vec::new();
    iter_session_messages(&path, |_, message| {
        iterated.push(message.role);
        true
    })
    .unwrap();
    assert_eq!(iterated, vec!["user", "assistant"]);
}

#[tokio::test]
async fn cursor_metadata_reads_sqlite_title_time_and_workspace() {
    let temp_dir = TempDir::new().unwrap();
    let session_id = "94cf58c5-78c3-49c8-9bb0-4c2ba2f97aa0";
    let conversation_db = temp_dir.path().join("conversation-search.db");
    let state_db = temp_dir.path().join("state.vscdb");

    let mut conversation = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&conversation_db)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::query(
        "CREATE TABLE conversations(
            id TEXT PRIMARY KEY,
            title TEXT,
            updated_at INTEGER
         )",
    )
    .execute(&mut conversation)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversations(id, title, updated_at)
         VALUES (?1, 'Cursor DB title', 1700000090000)",
    )
    .bind(session_id)
    .execute(&mut conversation)
    .await
    .unwrap();
    conversation.close().await.unwrap();

    let mut state = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&state_db)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::query(
        "CREATE TABLE composerHeaders(
            composerId TEXT PRIMARY KEY,
            createdAt INTEGER,
            lastUpdatedAt INTEGER,
            value TEXT
         )",
    )
    .execute(&mut state)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO composerHeaders(composerId, createdAt, lastUpdatedAt, value)
         VALUES (?1, 1700000010000, 1700000020000, ?2)",
    )
    .bind(session_id)
    .bind(
        json!({
            "name": "State title",
            "workspaceIdentifier": {
                "uri": { "fsPath": "F:\\idea-work\\business-center" }
            }
        })
        .to_string(),
    )
    .execute(&mut state)
    .await
    .unwrap();
    state.close().await.unwrap();

    let metadata = cursor_metadata_from_databases(temp_dir.path(), session_id)
        .unwrap()
        .unwrap();

    assert_eq!(metadata.title.as_deref(), Some("Cursor DB title"));
    assert_eq!(metadata.created_at, Some(1_700_000_010_000));
    assert_eq!(metadata.updated_at, Some(1_700_000_020_000));
    assert_eq!(
        metadata.cwd.as_deref(),
        Some(r"F:\idea-work\business-center")
    );
}

#[test]
fn cursor_metadata_updates_computation_without_overriding_real_title() {
    let metadata = CursorSessionMetadata {
        title: Some("Cursor DB title".to_string()),
        created_at: Some(10),
        updated_at: Some(20),
        cwd: Some(r"F:\idea-work\business-center".to_string()),
    };
    let mut fallback_title = CachedSessionComputation {
        created_at: 1,
        updated_at: 2,
        session_id: "session-a".to_string(),
        parent_session_id: None,
        title: "session-a".to_string(),
        message_count: 0,
        branch: None,
        stats: SessionStatsScan::default(),
    };
    apply_cursor_metadata_to_computation(&mut fallback_title, &metadata);
    assert_eq!(fallback_title.title, "Cursor DB title");
    assert_eq!(fallback_title.created_at, 10);
    assert_eq!(fallback_title.updated_at, 20);

    let mut real_title = CachedSessionComputation {
        title: "hello cursor".to_string(),
        ..fallback_title
    };
    apply_cursor_metadata_to_computation(&mut real_title, &metadata);
    assert_eq!(real_title.title, "hello cursor");
}

#[test]
fn collect_kiro_session_files_skips_registry() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    write_text(
        &root.join("workspace").join("session-a.json"),
        r#"{"sessionId":"session-a","history":[]}"#,
    );
    write_text(&root.join("workspace").join("sessions.json"), "{}");
    write_text(&root.join("workspace").join("settings.json"), "{}");

    let files = collect_kiro_session_files(root);

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "kiro");
    assert_eq!(files[0].project_key, "workspace");
}

#[test]
fn collect_gemini_session_files_reads_project_hash_folder() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    write_text(
        &root
            .join("hash-a")
            .join("chats")
            .join("session-2026-01-01T00-00-00.json"),
        r#"{"sessionId":"gemini-session","projectHash":"hash-a","messages":[]}"#,
    );
    write_text(&root.join("hash-a").join("chats").join("notes.json"), "{}");

    let files = collect_gemini_session_files(root);

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "gemini");
    assert_eq!(files[0].project_key, "hash-a");
}
