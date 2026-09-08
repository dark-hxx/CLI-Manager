use super::*;

#[test]
// 验证显式 Grok 会话根目录覆盖默认位置。
fn explicit_grok_history_root_overrides_default_root() {
    let roots = history_roots(None, None, Some(r"C:\history\grok\sessions".to_string()));
    assert_eq!(
        resolve_grok_history_root(&roots),
        PathBuf::from(r"C:\history\grok\sessions")
    );
}

#[test]
// 验证默认 Grok 根目录指向真实 sessions 目录。
fn default_grok_history_root_is_the_real_session_root() {
    let roots = history_roots(None, None, None);
    let expected = crate::provider::home::default_history_root("grok")
        .or_else(|| detect_home_dir().map(|home| home.join(".grok").join("sessions")))
        .unwrap_or_else(|| PathBuf::from(".grok").join("sessions"));

    assert_eq!(resolve_grok_history_root(&roots), expected);
}

#[test]
// 验证显式 Grok sessions 路径不会重复追加目录名。
fn explicit_grok_session_root_is_scanned_without_appending_sessions() {
    let temp_dir = TempDir::new().unwrap();
    let session_root = temp_dir.path().join(".grok").join("sessions");
    let session_dir = session_root.join("project").join("session-1");
    write_text(
        &session_dir.join("summary.json"),
        &json!({
            "info": { "id": "session-1", "cwd": r"F:\project" },
            "session_summary": "Explicit root"
        })
        .to_string(),
    );
    write_text(
        &session_dir.join("updates.jsonl"),
        &json!({
            "method": "session/update",
            "params": {
                "sessionId": "session-1",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "hello" }
                }
            }
        })
        .to_string(),
    );

    let roots = history_roots(
        None,
        None,
        Some(session_root.to_string_lossy().into_owned()),
    );
    assert_eq!(resolve_grok_history_root(&roots), session_root);
    let files = collect_grok_session_files(&resolve_grok_history_root(&roots));

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, session_dir.join("updates.jsonl"));
}

#[test]
// 验证 Grok 分块消息合并、工具结果、缓存用量与历史扫描链路。
fn grok_updates_parser_covers_history_pipeline() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().join(".grok").join("sessions");
    let path = root
        .join("F%3A%5Cidea-work%5Cbusiness-center")
        .join("grok-session")
        .join("updates.jsonl");
    write_text(
        &path.with_file_name("summary.json"),
        &json!({
            "info": {
                "id": "grok-session",
                "cwd": r"F:\idea-work\business-center"
            },
            "session_summary": "Grok summary",
            "created_at": "2026-06-01T00:00:00Z",
            "updated_at": "2026-06-01T00:00:03Z",
            "num_messages": 2,
            "current_model_id": "grok-4-code-fast-1"
        })
        .to_string(),
    );
    let updates = [
        json!({
            "timestamp": 1780272000u64,
            "method": "session/update",
            "params": {
                "sessionId": "grok-session",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "hello " }
                }
            }
        }),
        json!({
            "timestamp": 1780272001u64,
            "method": "session/update",
            "params": {
                "sessionId": "grok-session",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "grok" }
                }
            }
        }),
        json!({
            "timestamp": 1780272002u64,
            "method": "session/update",
            "params": {
                "sessionId": "grok-session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hi there" }
                }
            }
        }),
        json!({
            "timestamp": 1780272003u64,
            "method": "session/update",
            "params": {
                "sessionId": "grok-session",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tc1",
                    "title": "Read file",
                    "kind": "read",
                    "locations": [{ "path": "README.md" }]
                }
            }
        }),
        json!({
            "timestamp": 1780272004u64,
            "method": "session/update",
            "params": {
                "sessionId": "grok-session",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc1",
                    "status": "completed",
                    "content": [{ "type": "text", "text": "done" }]
                }
            }
        }),
        json!({
            "timestamp": 1780272005u64,
            "method": "session/update",
            "params": {
                "sessionId": "grok-session",
                "update": {
                    "sessionUpdate": "turn_completed",
                    "usage": {
                        "inputTokens": 120,
                        "outputTokens": 34,
                        "cachedReadTokens": 10,
                        "modelUsage": { "grok-4-code-fast-1": { "inputTokens": 120, "outputTokens": 34 } }
                    }
                }
            }
        }),
    ]
    .into_iter()
    .map(|event| event.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    write_text(&path, &updates);

    let files = collect_grok_session_files(&root);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "grok");
    // project_key is the full normalized workspace path for display/filter fidelity.
    assert!(files[0]
        .project_key
        .to_lowercase()
        .contains("business-center"));

    let (summary, stats, messages) = scan_session_detail(&path);
    assert_eq!(summary.session_id.as_deref(), Some("grok-session"));
    // user + assistant + tool call bubble
    assert_eq!(summary.message_count, 3);
    assert_eq!(summary.first_user_message.as_deref(), Some("hello grok"));
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "hello grok");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].content, "hi there");
    assert_eq!(messages[1].model.as_deref(), Some("grok-4-code-fast-1"));
    assert_eq!(messages[2].role, "tool");
    assert!(messages[2].content.contains("Read file"));
    assert_eq!(stats.current_model.as_deref(), Some("grok-4-code-fast-1"));
    assert_eq!(stats.tool_call_count, 1);
    assert_eq!(stats.builtin_calls.get("Read file"), Some(&1));
    assert_eq!(stats.input_tokens, 110);
    assert_eq!(stats.output_tokens, 34);
    assert_eq!(stats.cache_read_tokens, 10);
    assert_eq!(stats.token_trend.len(), 1);
    assert_eq!(stats.token_trend[0].input_tokens, 110);
    assert_eq!(stats.token_trend[0].output_tokens, 34);
    assert_eq!(stats.token_trend[0].cache_read_tokens, 10);
    assert_eq!(stats.token_trend[0].total_tokens, 154);
    assert_eq!(
        stats.token_trend[0].model.as_deref(),
        Some("grok-4-code-fast-1")
    );

    let project = scan_session_project(&path);
    assert_eq!(
        project.cwd.as_deref(),
        Some(r"F:\idea-work\business-center")
    );
    let computed = build_session_computation(&path, 1, 2, summary, stats);
    assert_eq!(computed.session_id, "grok-session");

    let tool_events = scan_tool_events(&path);
    assert_eq!(tool_events.len(), 1);
    assert_eq!(tool_events[0].name, "Read file");
    assert_eq!(tool_events[0].status.as_deref(), Some("completed"));
    assert_eq!(tool_events[0].output_summary.as_deref(), Some("done"));

    let mut iterated = Vec::new();
    iter_session_messages(&path, |_, message| {
        iterated.push(message.content);
        true
    })
    .unwrap();
    assert_eq!(iterated.len(), 3);
    assert_eq!(iterated[0], "hello grok");
    assert_eq!(iterated[1], "hi there");
    assert!(iterated[2].contains("Read file"));
}

#[test]
// 验证 Grok 备份删除仅移除目标会话目录并保留历史根目录。
fn grok_delete_removes_session_directory_inside_history_home() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".grok").join("sessions");
    let session_dir = home.join("workspace").join("grok-session");
    let path = session_dir.join("updates.jsonl");
    write_text(
        &session_dir.join("summary.json"),
        &json!({ "info": { "id": "grok-session" } }).to_string(),
    );
    write_text(&path, "{}\n");
    let file_ref = SessionFileRef {
        source: "grok".to_string(),
        project_key: "workspace".to_string(),
        path: path.clone(),
    };

    delete_grok_session_tree_with_backup_root(&file_ref, &home, &temp_dir.path().join("backups"))
        .unwrap();
    assert!(!path.exists());
    assert!(!session_dir.exists());
    assert!(home.exists());
}

#[test]
// 验证 Grok 删除拒绝历史根目录之外的会话。
fn grok_delete_rejects_session_outside_history_home() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".grok").join("sessions");
    std::fs::create_dir_all(&home).unwrap();
    let outsider = temp_dir.path().join("outside").join("grok-session");
    let path = outsider.join("updates.jsonl");
    write_text(
        &outsider.join("summary.json"),
        &json!({ "info": { "id": "grok-session" } }).to_string(),
    );
    write_text(&path, "{}\n");
    let file_ref = SessionFileRef {
        source: "grok".to_string(),
        project_key: "workspace".to_string(),
        path,
    };
    let err = delete_grok_session_tree_with_backup_root(
        &file_ref,
        &home,
        &temp_dir.path().join("backups"),
    )
    .unwrap_err();
    assert_eq!(err, "session_file_outside_history_scope");
}

#[test]
// 验证 Grok 删除不会将历史根目录本身视为会话目录。
fn grok_delete_rejects_session_at_history_home() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".grok").join("sessions");
    let path = home.join("updates.jsonl");
    write_text(
        &home.join("summary.json"),
        &json!({ "info": { "id": "sessions" } }).to_string(),
    );
    write_text(&path, "{}\n");
    let file_ref = SessionFileRef {
        source: "grok".to_string(),
        project_key: "workspace".to_string(),
        path,
    };
    let err = delete_grok_session_tree_with_backup_root(
        &file_ref,
        &home,
        &temp_dir.path().join("backups"),
    )
    .unwrap_err();
    assert_eq!(err, "session_file_outside_history_scope");
    assert!(home.exists());
}

#[test]
// 验证 Grok 删除拒绝将工作区层级目录作为会话。
fn grok_delete_rejects_workspace_directory_under_history_home() {
    let temp_dir = TempDir::new().unwrap();
    let home = temp_dir.path().join(".grok").join("sessions");
    let workspace = home.join("workspace");
    let path = workspace.join("updates.jsonl");
    write_text(
        &workspace.join("summary.json"),
        &json!({ "info": { "id": "workspace" } }).to_string(),
    );
    write_text(&path, "{}\n");
    let file_ref = SessionFileRef {
        source: "grok".to_string(),
        project_key: "workspace".to_string(),
        path,
    };
    let err = delete_grok_session_tree_with_backup_root(
        &file_ref,
        &home,
        &temp_dir.path().join("backups"),
    )
    .unwrap_err();
    assert_eq!(err, "session_file_outside_history_scope");
    assert!(workspace.exists());
    assert!(home.exists());
}

#[test]
// 验证 Linux Grok 路径识别不受嵌入 Windows 分隔符影响。
fn grok_linux_update_paths_do_not_use_host_path_parser() {
    assert!(looks_like_grok_linux_updates(
        "/home/u/.grok/sessions/workspace/abc-123/updates.jsonl"
    ));
    assert!(looks_like_grok_linux_updates(
        r"/home/u/.grok/sessions/C:\github\CLI-Manager/abc-123/updates.jsonl"
    ));
    assert!(!looks_like_grok_linux_updates("updates.jsonl"));
    assert!(!looks_like_grok_linux_updates("/updates.jsonl"));
    assert!(!looks_like_grok_linux_updates("/tmp/updates.jsonl"));
    assert_eq!(
        grok_project_key_from_linux_path("/home/u/.grok/sessions/workspace/abc-123/updates.jsonl"),
        "abc-123"
    );
    assert_eq!(
        grok_project_key_from_linux_path(
            r"/home/u/.grok/sessions/C:\github\CLI-Manager/abc-123/updates.jsonl"
        ),
        "abc-123"
    );
}

#[test]
// 验证 Grok 精确查找直接读取磁盘，并拒绝错误项目或越界标识。
fn exact_grok_session_lookup_bypasses_catalog_miss() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().join(".grok").join("sessions");
    let session_id = "019f8f73-cf03-7eb1-88bd-ae350e2cb327";
    let path = root
        .join("F%3A%5Cgithub%5CCLI-Manager")
        .join(session_id)
        .join("updates.jsonl");
    write_text(
        &path.with_file_name("summary.json"),
        &json!({
            "info": {
                "id": session_id,
                "cwd": r"F:\github\CLI-Manager"
            },
            "session_summary": "Current Grok session"
        })
        .to_string(),
    );
    write_text(
        &path,
        &json!({
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "hello" }
                }
            }
        })
        .to_string(),
    );

    let summary =
        find_exact_grok_session_in_root(&root, session_id, Some(r"F:\github\CLI-Manager"))
            .expect("exact Grok session should be found directly from disk");
    assert_eq!(summary.session_id, session_id);
    assert_eq!(summary.source, "grok");
    assert_eq!(summary.message_count, 1);
    assert_eq!(summary.file_path, path.to_string_lossy());

    assert!(
        find_exact_grok_session_in_root(&root, session_id, Some(r"F:\other-project"),).is_none()
    );
    assert!(find_exact_grok_session_in_root(&root, "../session", None).is_none());
}

#[test]
// 验证 Grok 摘要元数据补充标题、消息数、分支、模型及时间。
fn apply_grok_summary_metadata_fills_list_fields() {
    let temp_dir = TempDir::new().unwrap();
    let session_dir = temp_dir.path().join("sess");
    fs::create_dir_all(&session_dir).unwrap();
    let updates = session_dir.join("updates.jsonl");
    fs::write(&updates, "{}\n").unwrap();
    fs::write(
        session_dir.join("summary.json"),
        r#"{"info":{"id":"g2","cwd":"F:\\github\\CLI-Manager"},"generated_title":"Grok titled session","num_chat_messages":38,"num_messages":116,"head_branch":"master","current_model_id":"grok-4.5","created_at":"2026-07-22T11:14:36.452422900Z","last_active_at":"2026-07-22T12:00:00.000000000Z"}"#,
    )
    .unwrap();

    let mut computed = CachedSessionComputation {
        created_at: 1,
        updated_at: 1,
        session_id: "g2".to_string(),
        parent_session_id: None,
        title: "g2".to_string(),
        message_count: 0,
        branch: None,
        stats: SessionStatsScan::default(),
    };
    apply_grok_summary_metadata(&updates, &mut computed);
    assert_eq!(computed.title, "Grok titled session");
    assert_eq!(computed.message_count, 38);
    assert_eq!(computed.branch.as_deref(), Some("master"));
    assert!(computed.updated_at > 1);
    assert_eq!(computed.stats.current_model.as_deref(), Some("grok-4.5"));
}
