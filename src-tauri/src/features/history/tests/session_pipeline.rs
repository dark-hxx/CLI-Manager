use super::*;

#[test]
// 验证 JSON 会话迭代保留消息顺序、角色和文本。
fn iter_session_messages_reads_json_sessions() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("session.json");
    write_text(
        &path,
        &json!({
            "sessionId": "gemini-session",
            "messages": [
                { "type": "user", "content": "first" },
                { "type": "model", "content": "second" }
            ]
        })
        .to_string(),
    );

    let mut messages = Vec::new();
    iter_session_messages(&path, |index, message| {
        messages.push((index, message.role, message.content));
        true
    })
    .unwrap();

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0], (0, "user".to_string(), "first".to_string()));
    assert_eq!(
        messages[1],
        (1, "assistant".to_string(), "second".to_string())
    );
}

#[test]
// 验证 Claude 编辑与 Codex 转义补丁均被提取并保留操作时间顺序。
fn scan_file_changes_reads_claude_and_codex_jsonl_operations_in_time_order() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("session.jsonl");
    let claude_edit = json!({
        "type": "assistant",
        "timestamp": "2026-07-11T10:00:00Z",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "claude-edit-1",
                "name": "Edit",
                "input": {
                    "file_path": "src/claude.ts",
                    "old_string": "old",
                    "new_string": "new"
                }
            }]
        }
    });
    let codex_patch = json!({
        "type": "response_item",
        "timestamp": "2026-07-11T10:01:00Z",
        "payload": {
            "type": "custom_tool_call",
            "call_id": "codex-patch-1",
            "name": "exec",
            "input": r#"const patch = \"*** Begin Patch\n*** Update File: src/codex.ts\n@@\n-old\n+new\n*** End Patch\";"#
        }
    });
    write_text(
        &path,
        &format!(
            "{}\n{}\n",
            serde_json::to_string(&claude_edit).unwrap(),
            serde_json::to_string(&codex_patch).unwrap()
        ),
    );

    let changes = scan_file_changes(&path);
    assert_eq!(changes.len(), 2);

    let claude_change = changes
        .iter()
        .find(|change| change.file_path == "src/claude.ts")
        .unwrap();
    assert_eq!(claude_change.operations.len(), 1);
    assert_eq!(claude_change.operations[0].operation_group_index, Some(0));
    assert_eq!(
        claude_change.operations[0].timestamp.as_deref(),
        Some("2026-07-11T10:00:00Z")
    );

    let codex_change = changes
        .iter()
        .find(|change| change.file_path == "src/codex.ts")
        .unwrap();
    assert_eq!(codex_change.operations.len(), 1);
    assert_eq!(codex_change.operations[0].operation_group_index, Some(1));
    assert_eq!(codex_change.additions, 1);
    assert_eq!(codex_change.deletions, 1);
    assert!(codex_change.operations[0]
        .patch
        .as_deref()
        .unwrap()
        .contains("*** Update File: src/codex.ts"));
}

#[test]
// 验证 Codex 文件发现从 cwd 提取项目名称。
fn collect_codex_session_files_uses_cwd_project_name() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().join(".codex");
    let file = root
        .join("sessions")
        .join("2026")
        .join("06")
        .join("12")
        .join("rollout-session.jsonl");
    write_text(
        &file,
        r#"{"type":"session_meta","payload":{"cwd":"D:\\work\\pythonProject\\CLI-Manager"}}"#,
    );

    let files = collect_codex_session_files(&root);

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "codex");
    assert_eq!(files[0].project_key, "CLI-Manager");
    assert_eq!(files[0].path, file);
}

#[test]
// 验证 Codex 使用元数据会话标识并在缺失日志时间时保留文件时间。
fn build_session_computation_uses_codex_session_meta_id() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir
        .path()
        .join("rollout-2026-06-17T16-10-35-019ed4a1-d197-75d0-950c-28cb3bbed404.jsonl");
    write_text(
        &file,
        r#"{"type":"session_meta","payload":{"id":"019ed4a1-d197-75d0-950c-28cb3bbed404","cwd":"D:\\work\\pythonProject\\CLI-Manager"}}"#,
    );

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.session_id, "019ed4a1-d197-75d0-950c-28cb3bbed404");
    assert_eq!(computed.created_at, 1);
    assert_eq!(computed.updated_at, 2);
}

#[test]
// 验证 Codex 会话时长采用转录中的起止时间。
fn build_session_computation_uses_codex_transcript_timestamps_for_duration() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir
        .path()
        .join("rollout-2026-06-17T16-10-35-019ed4a1-d197-75d0-950c-28cb3bbed404.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"timestamp":"2026-06-17T16:10:36Z","type":"session_meta","payload":{"id":"019ed4a1-d197-75d0-950c-28cb3bbed404","timestamp":"2026-06-17T16:10:35Z"}}"#,
            "\n",
            r#"{"timestamp":"2026-06-17T16:12:00Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            "\n",
        ),
    );

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(
        computed.created_at,
        parse_timestamp_millis_str("2026-06-17T16:10:35Z").unwrap()
    );
    assert_eq!(
        computed.updated_at,
        parse_timestamp_millis_str("2026-06-17T16:12:00Z").unwrap()
    );
}

#[test]
// 验证 Codex 子代理元数据中的父线程标识被提取。
fn build_session_computation_extracts_codex_parent_thread_id() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-child.jsonl");
    write_text(
        &file,
        r#"{"type":"session_meta","payload":{"id":"child-session","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-session","depth":1}}}}}"#,
    );

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.session_id, "child-session");
    assert_eq!(
        computed.parent_session_id.as_deref(),
        Some("parent-session")
    );
}

#[test]
// 验证线程名称索引保留最新有效名称并跳过无效行。
fn codex_thread_name_index_uses_last_valid_name_and_skips_invalid_rows() {
    let names = parse_codex_thread_name_index(concat!(
        r#"{"id":"session-1","thread_name":"Old name"}"#,
        "\n",
        "not json\n",
        r#"{"id":"session-1","thread_name":"  New name  "}"#,
        "\n",
        r#"{"id":"session-2","thread_name":"   "}"#,
        "\n",
        r#"{"id":"","thread_name":"No session"}"#,
        "\n",
    ));

    assert_eq!(names.get("session-1").map(String::as_str), Some("New name"));
    assert!(!names.contains_key("session-2"));
}

#[test]
// 验证会话详情公开元数据中的工作目录。
fn build_session_detail_exposes_cwd() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        r#"{"type":"session_meta","payload":{"id":"session-1","cwd":"D:\\work\\CLI-Manager"}}"#,
    );
    let file_ref = SessionFileRef {
        source: "codex".to_string(),
        project_key: "CLI-Manager".to_string(),
        path: file,
    };

    let detail = build_session_detail(&file_ref, false).unwrap();

    assert_eq!(detail.cwd.as_deref(), Some("D:\\work\\CLI-Manager"));
}

#[test]
// 验证父子会话聚合合并消息、Token 趋势及各类工具计数。
fn build_session_detail_aggregates_subtasks_for_realtime_stats() {
    let temp_dir = TempDir::new().unwrap();
    let parent_file = temp_dir.path().join("rollout-session.jsonl");
    let child_file = temp_dir.path().join("subagents").join("agent-child.jsonl");
    write_text(
        &parent_file,
        concat!(
            r#"{"type":"session_meta","payload":{"id":"session-1","cwd":"D:\\work\\CLI-Manager"}}"#,
            "\n",
            r#"{"type":"assistant","timestamp":"2026-06-26T10:00:00Z","requestId":"req-parent","message":{"id":"msg-parent","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"parent"}],"usage":{"input_tokens":100,"output_tokens":50}}}"#,
            "\n",
            r#"{"type":"assistant","timestamp":"2026-06-26T10:00:00Z","message":{"id":"tools-parent","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}"#,
            "\n",
        ),
    );
    write_text(
        &child_file,
        concat!(
            r#"{"type":"assistant","timestamp":"2026-06-26T10:01:00Z","requestId":"req-child","message":{"id":"msg-child","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"child"}],"usage":{"input_tokens":40,"output_tokens":10,"cache_read_input_tokens":20}}}"#,
            "\n",
            r#"{"type":"assistant","timestamp":"2026-06-26T10:01:00Z","message":{"id":"tools-child","content":[{"type":"tool_use","id":"t2","name":"mcp__exa__web_search_exa","input":{}}]}}"#,
            "\n",
        ),
    );
    let file_ref = SessionFileRef {
        source: "claude".to_string(),
        project_key: "CLI-Manager".to_string(),
        path: parent_file,
    };

    let detail = build_session_detail(&file_ref, true).unwrap();

    assert_eq!(detail.session_id, "session-1");
    assert_eq!(detail.cwd.as_deref(), Some("D:\\work\\CLI-Manager"));
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.message_count, 2);
    assert_eq!(detail.usage.input_tokens, 140);
    assert_eq!(detail.usage.output_tokens, 60);
    assert_eq!(detail.usage.cache_read_tokens, 20);
    assert_eq!(detail.usage.tool_call_count, 2);
    assert_eq!(detail.usage.builtin_calls[0].name, "Read");
    assert_eq!(detail.usage.builtin_calls[0].count, 1);
    assert_eq!(detail.usage.mcp_calls[0].name, "exa");
    assert_eq!(detail.usage.mcp_calls[0].count, 1);
    assert_eq!(detail.usage.token_trend.len(), 2);
    assert_eq!(detail.usage.token_trend[0].total_tokens, 150);
    assert_eq!(detail.usage.token_trend[1].total_tokens, 70);
}

#[test]
// 验证禁止独立删除子代理，父会话备份删除会级联子日志。
fn delete_session_tree_rejects_subagent_and_cascades_from_parent() {
    let temp_dir = TempDir::new().unwrap();
    let parent_file = temp_dir.path().join("rollout-session.jsonl");
    let child_file = temp_dir.path().join("subagents").join("agent-child.jsonl");
    write_text(&parent_file, "{}\n");
    write_text(&child_file, "{}\n");
    let child_ref = SessionFileRef {
        source: "test".to_string(),
        project_key: "CLI-Manager".to_string(),
        path: child_file.clone(),
    };
    assert_eq!(
        delete_session_tree(&child_ref).unwrap_err(),
        "history_subagent_mutation_not_allowed"
    );
    assert!(child_file.exists());

    let parent_ref = SessionFileRef {
        source: "test".to_string(),
        project_key: "CLI-Manager".to_string(),
        path: parent_file.clone(),
    };
    let backups_dir = temp_dir.path().join("backups");
    assert_eq!(
        delete_session_tree_with_backup_root(&parent_ref, &backups_dir).unwrap(),
        2
    );
    assert!(!parent_file.exists());
    assert!(!child_file.exists());
}

#[test]
// 验证直接读取子代理详情时消息不可编辑。
fn build_session_detail_marks_direct_subagent_messages_not_editable() {
    let temp_dir = TempDir::new().unwrap();
    let child_file = temp_dir.path().join("subagents").join("agent-child.jsonl");
    write_text(
        &child_file,
        concat!(
            r#"{"type":"user","timestamp":"2026-06-26T10:01:00Z","message":{"role":"user","content":"child question"}}"#,
            "\n",
        ),
    );
    let file_ref = SessionFileRef {
        source: "claude".to_string(),
        project_key: "CLI-Manager".to_string(),
        path: child_file,
    };

    let detail = build_session_detail(&file_ref, false).unwrap();

    assert_eq!(detail.messages.len(), 1);
    assert!(!detail.messages[0].editable);
    assert!(detail.messages[0].editable_text.is_none());
}

#[test]
// 验证 Codex 缺失元数据标识时回退文件名。
fn build_session_computation_falls_back_for_codex_without_session_meta_id() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        r#"{"type":"session_meta","payload":{"cwd":"D:\\work\\pythonProject\\CLI-Manager"}}"#,
    );

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.session_id, "rollout-session");
}

#[test]
// 验证 Claude 文件保持文件名标识，不采用 Codex 元数据标识。
fn build_session_computation_keeps_claude_file_stem_session_id() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("claude-session.jsonl");
    write_text(
        &file,
        r#"{"type":"session_meta","payload":{"id":"019ed4a1-d197-75d0-950c-28cb3bbed404"}}"#,
    );

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.session_id, "claude-session");
}

#[test]
// 验证标题可从内部目标上下文提取实际任务目标。
fn build_session_computation_title_uses_objective_from_internal_context() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    let content = concat!(
        "<codex_internal_context source=\"goal\">\n",
        "Continue working toward the active thread goal.\n",
        "<objective>\n",
        "历史会话列表加载的太久\n",
        "</objective>\n",
        "</codex_internal_context>"
    );
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    })
    .to_string();
    write_text(&file, &line);

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.title, "历史会话列表加载的太久");
}

#[test]
// 验证标题选择跳过系统提醒而使用真实用户文本。
fn build_session_computation_title_skips_system_like_user_blocks() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    let system_line = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": "<system-reminder>\nDo not show this as title.\n</system-reminder>"
        }
    })
    .to_string();
    let user_line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": "真实用户第一句话" }
    })
    .to_string();
    write_text(&file, &format!("{system_line}\n{user_line}\n"));

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.title, "真实用户第一句话");
}

#[test]
// 验证 AGENTS 指令不被作为会话标题。
fn build_session_computation_title_skips_agents_instructions() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    let system_line = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": "# AGENTS.md instructions for D:\\work\\pythonProject\\CLI-Manager\n\n## 角色定位\n..."
        }
    })
    .to_string();
    let user_line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": "历史会话还是加载太慢了，重新优化" }
    })
    .to_string();
    write_text(&file, &format!("{system_line}\n{user_line}\n"));

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.title, "历史会话还是加载太慢了，重新优化");
}

#[test]
// 验证图像标签转换为占位符并保留用户文字标题。
fn build_session_computation_title_uses_image_placeholders_with_remaining_text() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("image-session.jsonl");
    let content = concat!(
        "<image name=[Image #1] path=\"C:\\\\Users\\\\Administrator\\\\image-a.png\">\n",
        "<image name=[Image #2] path=\"C:\\\\Users\\\\Administrator\\\\image-b.png\">\n",
        "请分析这两张截图的问题"
    );
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    })
    .to_string();
    write_text(&file, &line);

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(
        computed.title,
        "[Image #1][Image #2] 请分析这两张截图的问题"
    );
}

#[test]
// 验证标题移除图像闭合标签并去重重复占位符。
fn build_session_computation_title_skips_image_close_and_repeated_placeholder() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("image-with-text-session.jsonl");
    let content = concat!(
        "<image name=[Image #1] path=\"C:\\\\Users\\\\Administrator\\\\image.png\">\n",
        "</image>\n",
        "[Image #1] 重新设计历史会话中会话列表的这三个图标，关闭展开和 subagent 。需要实现简约干净的风格"
    );
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    })
    .to_string();
    write_text(&file, &line);

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(
        computed.title,
        "[Image #1] 重新设计历史会话中会话列表的这三个图标，关闭展开和 subagent 。需要实现简约干净的风格"
    );
}

#[test]
// 验证行内图像闭合标签不会污染后续标题文字。
fn build_session_computation_title_skips_inline_image_close_before_text() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("image-inline-close-session.jsonl");
    let content = concat!(
        "<image name=[Image #1] path=\"C:\\\\Users\\\\Administrator\\\\image.png\">\n",
        "</image>[Image #1]还是没有实现"
    );
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    })
    .to_string();
    write_text(&file, &line);

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.title, "[Image #1] 还是没有实现");
}

#[test]
// 验证纯图像用户消息生成单个图像占位标题。
fn build_session_computation_title_uses_single_image_placeholder() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("image-only-session.jsonl");
    let line = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": "<image name=[Image #1] path=\"C:\\\\Users\\\\Administrator\\\\image.png\">"
        }
    })
    .to_string();
    write_text(&file, &line);

    let computed = scan_session_computation(&file, 1, 2);

    assert_eq!(computed.title, "[Image #1]");
}

#[test]
// 验证匹配文件指纹的项目缓存可直接复用。
fn get_or_scan_session_project_reuses_matching_fingerprint_cache() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        r#"{"type":"session_meta","payload":{"cwd":"D:\\work\\ActualProject"}}"#,
    );
    let key = path_to_key(&file);
    let fingerprint = session_file_fingerprint(&file);

    get_project_cache().lock().unwrap().entries.insert(
        key.clone(),
        CachedSessionProjectCacheEntry {
            fingerprint,
            scan: SessionProjectScan {
                cwd: Some("D:\\work\\CachedProject".to_string()),
            },
        },
    );

    let scan = get_or_scan_session_project(&file);

    get_project_cache().lock().unwrap().entries.remove(&key);
    assert_eq!(scan.cwd.as_deref(), Some("D:\\work\\CachedProject"));
}

#[test]
// 验证命令标签解析移除开头斜杠且无标签时返回空值。
fn extract_command_name_strips_slash() {
    assert_eq!(
        extract_command_name(r#"text <command-name>/goal</command-name> rest"#),
        Some("goal".to_string())
    );
    assert_eq!(extract_command_name("no marker"), None);
}

#[test]
// 验证纯工具结果用户行归类为工具，真实文本仍为用户。
fn parse_message_classifies_tool_result_lines_as_tool() {
    // Claude 的工具结果行：user 角色 + content 全为 tool_result 块 → 归类为 tool
    let tool_result_line: Value = serde_json::from_str(
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
    )
    .unwrap();
    let tool_result = parse_message(&tool_result_line).unwrap();
    assert_eq!(tool_result.role, "tool");
    assert_eq!(tool_result.parts.len(), 1);
    assert_eq!(tool_result.parts[0].kind, "tool_result");
    assert_eq!(tool_result.parts[0].call_id.as_deref(), Some("t1"));

    // 真实用户输入保持 user
    let user_line: Value = serde_json::from_str(
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
    )
    .unwrap();
    let user = parse_message(&user_line).unwrap();
    assert_eq!(user.role, "user");
    assert_eq!(user.parts[0].kind, "text");
}

#[test]
// 验证 Codex developer 消息映射为系统角色和片段。
fn parse_message_classifies_codex_developer_messages_as_system() {
    let line: Value = serde_json::from_str(
        r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>internal context</skills_instructions>"}]}}"#,
    )
    .unwrap();

    let message = parse_message(&line).unwrap();

    assert_eq!(message.role, "system");
    assert_eq!(message.parts.len(), 1);
    assert_eq!(message.parts[0].kind, "system");
}

#[test]
// 验证 Claude 混合内容保留推理、文本及工具片段类型。
fn parse_message_preserves_mixed_content_part_kinds() {
    let line: Value = serde_json::from_str(
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"inspect state"},{"type":"text","text":"done"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"README.md"}}]}}"#,
    )
    .unwrap();

    let message = parse_message(&line).unwrap();

    assert_eq!(message.parts.len(), 3);
    assert_eq!(message.parts[0].kind, "reasoning");
    assert_eq!(message.parts[1].kind, "text");
    assert_eq!(message.parts[2].kind, "tool_call");
    assert_eq!(message.parts[2].tool_name.as_deref(), Some("Read"));
    assert_eq!(message.parts[2].call_id.as_deref(), Some("t1"));
}

#[test]
// 验证 Codex 混合响应内容保留各片段类型及调用标识。
fn parse_message_preserves_codex_response_item_part_kinds() {
    let line: Value = serde_json::from_str(
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"reasoning","text":"inspect state"},{"type":"output_text","text":"done"},{"type":"custom_tool_call","call_id":"c1","name":"shell_command","input":"Get-ChildItem"}]}}"#,
    )
    .unwrap();

    let message = parse_message(&line).unwrap();

    assert_eq!(message.parts.len(), 3);
    assert_eq!(message.parts[0].kind, "reasoning");
    assert_eq!(message.parts[1].kind, "text");
    assert_eq!(message.parts[2].kind, "tool_call");
    assert_eq!(message.parts[2].tool_name.as_deref(), Some("shell_command"));
    assert_eq!(message.parts[2].call_id.as_deref(), Some("c1"));
}

#[test]
// 验证注入的用户提醒保留角色但标记为系统片段。
fn parse_message_marks_injected_user_prompt_as_system_part() {
    let line: Value = serde_json::from_str(
        r#"{"type":"user","message":{"role":"user","content":"<system-reminder>internal context</system-reminder>"}}"#,
    )
    .unwrap();

    let message = parse_message(&line).unwrap();

    assert_eq!(message.role, "user");
    assert_eq!(message.parts[0].kind, "system");
}

#[test]
// 验证嵌入 Codex 权限与技能上下文标记为系统片段。
fn parse_message_marks_embedded_codex_context_as_system_part() {
    let line: Value = serde_json::from_str(
        r#"{"type":"user","message":{"role":"user","content":[{"type":"input_text","text":"<permissions instructions>internal context</permissions instructions>\n### Available skills\n- browser"}]}}"#,
    )
    .unwrap();

    let message = parse_message(&line).unwrap();

    assert_eq!(message.parts[0].kind, "system");
}

#[test]
// 验证技能目录指令文本标记为系统片段。
fn parse_message_marks_skill_directory_context_as_system_part() {
    let line: Value = serde_json::from_str(
        r#"{"type":"user","message":{"role":"user","content":"Base directory for this skill: F:\\github\\CLI-Manager\\.claude\\skills\\trellis-update-spec\n\n# Update Code-Spec"}}"#,
    )
    .unwrap();

    let message = parse_message(&line).unwrap();

    assert_eq!(message.parts[0].kind, "system");
}

#[test]
// 验证重复流式消息仍保留，但清空后续重复 Token 计数。
fn iter_session_messages_blanks_duplicate_usage_lines() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    let line = r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":50}}}"#;
    write_text(&file, &format!("{line}\n{line}\n"));
    let mut messages = Vec::new();

    iter_session_messages(&file, |_, msg| {
        messages.push(msg);
        true
    })
    .unwrap();

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].input_tokens, Some(100));
    assert_eq!(messages[0].output_tokens, Some(50));
    assert_eq!(messages[1].input_tokens, None);
    assert_eq!(messages[1].output_tokens, None);
}

#[test]
// 验证消息模型可从显式字段或最近回合上下文补全。
fn iter_session_messages_extracts_model_with_fallback() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    let claude_line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":10,"output_tokens":5}}}"#;
    let codex_turn_context = r#"{"type":"turn_context","payload":{"model":"gpt-5-codex"}}"#;
    let codex_message = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#;
    write_text(
        &file,
        &format!("{claude_line}\n{codex_turn_context}\n{codex_message}\n"),
    );
    let mut messages = Vec::new();

    iter_session_messages(&file, |_, msg| {
        messages.push(msg);
        true
    })
    .unwrap();

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].model.as_deref(), Some("claude-opus-4-8"));
    assert_eq!(messages[1].model.as_deref(), Some("gpt-5-codex"));
}

#[test]
// 验证单遍详情扫描保留重复消息而仅累计一次用量。
fn scan_session_detail_collects_messages_and_stats_in_one_pass() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    let line = r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":50}}}"#;
    // 同一条流式消息重复两次：messages 都保留但重复行 token 清空；stats 只计一次。
    write_text(&file, &format!("{line}\n{line}\n"));

    let (summary, stats, messages) = scan_session_detail(&file);

    // 消息侧：两条都在，重复行 token 被清空（与 iter_session_messages 口径一致）
    assert_eq!(messages.len(), 2);
    assert_eq!(summary.message_count, 2);
    assert_eq!(messages[0].input_tokens, Some(100));
    assert_eq!(messages[0].output_tokens, Some(50));
    assert_eq!(messages[0].model.as_deref(), Some("claude-sonnet-4-5"));
    assert_eq!(messages[1].input_tokens, None);
    assert_eq!(messages[1].output_tokens, None);

    // stats 侧：去重后只计一次，不随重复行虚高（与 scan_session_combined 同一口径）
    assert_eq!(stats.input_tokens, 100);
    assert_eq!(stats.output_tokens, 50);
    assert_eq!(stats.token_trend.len(), 1);
}

#[test]
// 验证 Claude 消息物理行号、编辑权限及规范文本映射。
fn scan_session_detail_maps_claude_messages_to_physical_lines() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"summary","summary":"noise"}"#,
            "\n",
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"hello world"}}"#,
            "\n\n",
            r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"part one"},{"type":"text","text":"part two"}]}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"content":"file body"}}]}}"#,
            "\n",
        ),
    );

    let (_, _, messages) = scan_session_detail(&file);

    assert_eq!(messages.len(), 3);
    // 物理行号包含被跳过的 summary 行与空行
    assert_eq!(messages[0].line_index, Some(1));
    assert!(messages[0].editable);
    // 规范文本与展示 content 一致时省略 editable_text
    assert_eq!(messages[0].editable_text, None);
    assert_eq!(messages[1].line_index, Some(3));
    assert!(messages[1].editable);
    // 多 text 块：展示 content 以 \n 连接，规范文本以 \n\n 连接，不一致时必须显式返回
    assert_eq!(
        messages[1].editable_text.as_deref(),
        Some("part one\n\npart two")
    );
    // tool_use 行没有规范文本块，禁止编辑但保留行号（供只读定位）
    assert_eq!(messages[2].line_index, Some(4));
    assert!(!messages[2].editable);
    assert_eq!(messages[2].editable_text, None);
}

#[test]
// 验证 Codex 回放行占据物理行号但不重复生成消息。
fn scan_session_detail_maps_codex_messages_to_physical_lines() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"session_meta","payload":{"id":"s1","cwd":"D:\\work"}}"#,
            "\n",
            r#"{"type":"response_item","timestamp":"2026-03-08T06:31:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"question"}]}}"#,
            "\n",
            r#"{"type":"event_msg","timestamp":"2026-03-08T06:31:00Z","payload":{"type":"user_message","message":"question"}}"#,
            "\n",
            r#"{"type":"response_item","timestamp":"2026-03-08T06:32:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}}"#,
            "\n",
        ),
    );

    let (_, _, messages) = scan_session_detail(&file);

    // event_msg 行不产生消息，但仍占物理行号
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].line_index, Some(1));
    assert!(messages[0].editable);
    assert_eq!(messages[0].editable_text, None);
    assert_eq!(messages[1].line_index, Some(3));
    assert!(messages[1].editable);
}

#[test]
// 验证聚合子消息清空跨文件行映射并禁用编辑。
fn build_session_detail_blanks_line_mapping_for_aggregated_subtask_messages() {
    let temp_dir = TempDir::new().unwrap();
    let parent_file = temp_dir.path().join("rollout-session.jsonl");
    let child_file = temp_dir.path().join("subagents").join("agent-child.jsonl");
    write_text(
        &parent_file,
        concat!(
            r#"{"type":"user","uuid":"u1","timestamp":"2026-06-26T10:00:00Z","message":{"role":"user","content":"parent"}}"#,
            "\n",
        ),
    );
    write_text(
        &child_file,
        concat!(
            r#"{"type":"user","uuid":"c1","timestamp":"2026-06-26T10:01:00Z","message":{"role":"user","content":"child"}}"#,
            "\n",
        ),
    );
    let file_ref = SessionFileRef {
        source: "claude".to_string(),
        project_key: "CLI-Manager".to_string(),
        path: parent_file,
    };

    let detail = build_session_detail(&file_ref, true).unwrap();

    assert_eq!(detail.messages.len(), 2);
    let parent = detail
        .messages
        .iter()
        .find(|m| m.content == "parent")
        .unwrap();
    let child = detail
        .messages
        .iter()
        .find(|m| m.content == "child")
        .unwrap();
    // 父会话消息保留行映射；子任务消息属于其他文件，必须清空行映射并禁用编辑
    assert_eq!(parent.line_index, Some(0));
    assert!(parent.editable);
    assert_eq!(child.line_index, None);
    assert!(!child.editable);
    assert_eq!(child.editable_text, None);
}

#[test]
// 验证单遍详情从最近回合上下文回填助手模型。
fn scan_session_detail_backfills_assistant_model_from_turn_context() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    let turn_context = r#"{"type":"turn_context","payload":{"model":"gpt-5-codex"}}"#;
    let message = r#"{"type":"response_item","timestamp":"2026-03-08T06:32:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#;
    write_text(&file, &format!("{turn_context}\n{message}\n"));

    let (_, _, messages) = scan_session_detail(&file);

    // 消息行不带 model，回填最近 turn_context 的模型（detail 单遍路径与 iter_session_messages 一致）
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].model.as_deref(), Some("gpt-5-codex"));
    assert_eq!(
        messages[0].timestamp.as_deref(),
        Some("2026-03-08T06:32:00Z")
    );
}

#[test]
// 验证 Codex Token 事件回填最近助手消息并保持统计一致。
fn scan_session_detail_backfills_codex_token_count_to_latest_assistant_message() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    let message = r#"{"type":"response_item","timestamp":"2026-03-08T06:32:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#;
    let token_count = r#"{"type":"event_msg","timestamp":"2026-03-08T06:32:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":50,"total_tokens":150}}}}"#;
    write_text(&file, &format!("{message}\n{token_count}\n"));

    let (_, stats, messages) = scan_session_detail(&file);

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].input_tokens, Some(90));
    assert_eq!(messages[0].output_tokens, Some(50));
    assert_eq!(messages[0].cache_read_tokens, Some(10));
    assert_eq!(messages[0].cache_creation_tokens, None);
    assert_eq!(stats.input_tokens, 90);
    assert_eq!(stats.output_tokens, 50);
    assert_eq!(stats.cache_read_tokens, 10);
}
