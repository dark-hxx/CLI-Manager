use super::*;
use super::super::tool_observations::*;
use super::super::nested_tools::literal_tool_calls;
use std::collections::HashSet;

fn observations(rows: &[serde_json::Value]) -> Vec<HistoryToolEvent> {
    let mut events = Vec::new();
    let mut seen = HashSet::new();
    for row in rows { collect_tool_events_from_value(row, Some(0), &mut seen, &mut events); }
    merge_tool_events(events)
}

#[test]
fn normalized_native_shapes_share_mcp_classification_and_result_semantics() {
    let shapes = [
        // Claude, Cursor and Cline share Anthropic content blocks.
        json!({"message":{"content":[{"type":"tool_use","id":"a","name":"mcp__docs__read","input":{}}]}}),
        // Gemini toolCalls and Antigravity/OpenAI tool_calls.
        json!({"message":{"toolCalls":[{"id":"b","name":"read","serverName":"docs","args":{},"result":{"isError":true}}]}}),
        json!({"message":{"tool_calls":[{"id":"c","function":{"name":"mcp__docs__read","arguments":"{}"}}]}}),
        // Kiro Bedrock blocks.
        json!({"message":{"content":[{"toolUse":{"toolUseId":"d","name":"mcp__docs__read","input":{}}}]}}),
        // Copilot native execution records.
        json!({"type":"assistant.message","data":{"toolRequests":[{"toolCallId":"e","name":"mcp__docs__read","arguments":{}}]}}),
    ];
    for row in shapes {
        let events = observations(&[row.clone(), row]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].category, "mcp:docs");
        let mut stats = SessionStatsScan::default();
        reconcile_tool_stats(&mut stats, &events);
        assert_eq!(stats.tool_call_count, 1);
        assert_eq!(stats.mcp_calls.get("docs"), Some(&1));
        assert!(stats.builtin_calls.is_empty());
    }
}

#[test]
fn codex_custom_output_does_not_promote_inferred_children() {
    let request = json!({"payload":{"type":"custom_tool_call","call_id":"outer","name":"exec",
        "input":"await tools.mcp__docs__read({}); await tools.exec_command({});"}});
    let events = observations(&[request.clone(), request,
        json!({"payload":{"type":"custom_tool_call_output","call_id":"outer","output":"ok"}})]);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].status.as_deref(), Some("completed"));
    assert_eq!(events[1].category, "mcp:docs");
    assert!(events[1].status.is_none());
    assert!(is_inferred(&events[1]));
    let mut stats = SessionStatsScan::default();
    reconcile_tool_stats(&mut stats, &events);
    assert_eq!(stats.tool_call_count, 1);
    assert!(stats.mcp_calls.is_empty());
    assert_eq!(stats.builtin_calls.get("exec"), Some(&1));
}

#[test]
fn protocol_errors_and_tool_results_are_not_guessed_from_text() {
    assert_eq!(result_status(&json!({"content":"example: error"})), "completed");
    assert_eq!(result_status(&json!({"output":"{\"isError\":true}"})), "failed");
    assert_eq!(result_status(&json!({"result":{"Err":{"message":"failure"}}})), "failed");
    let events = observations(&[
        json!({"message":{"content":[{"type":"tool_use","id":"a","name":"mcp__docs__read"}]}}),
        json!({"message":{"content":[{"type":"tool_result","tool_use_id":"a","is_error":true,"content":"bad"}]}}),
    ]);
    assert_eq!(events[0].status.as_deref(), Some("failed"));
}

#[test]
fn inference_ignores_comments_strings_dynamic_access_and_duplicate_parent_records() {
    assert!(literal_tool_calls(r"const regex = /tools.fake()/; tools.real();").is_empty());
    let calls = literal_tool_calls(r#"// tools.fake()
        const text = "tools.fake()"; /* tools.fake() */
        tools[name](); obj.tools.fake(); await tools["mcp__docs__read"]({});
        await tools.exec_command({});"#);
    assert_eq!(calls.iter().map(|(_, name)| name.as_str()).collect::<Vec<_>>(),
        ["mcp__docs__read", "exec_command"]);
}

#[test]
fn json_document_adapters_preserve_server_metadata() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("gemini.json");
    write_text(&path, &json!({"messages":[{"content":"reading", "toolCalls":[
        {"id":"g1","name":"lookup","serverName":"docs","args":{},"result":{"isError":false}}
    ]}]}).to_string());
    let events = scan_tool_events(&path);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].category, "mcp:docs");
    assert_eq!(events[0].status.as_deref(), Some("completed"));
    assert_eq!(events[0].message_index, Some(0));
}

#[test]
fn pi_grok_and_kimi_native_files_use_shared_mcp_counts() {
    let temp = TempDir::new().unwrap();
    let cases = [
        (temp.path().join(".pi/agent/sessions/project/session.jsonl"), vec![
            json!({"type":"message","message":{"role":"assistant","content":[
                {"type":"toolCall","toolCallId":"p1","name":"mcp__docs__read","arguments":{}}
            ]}}),
            json!({"type":"message","message":{"role":"toolResult","toolCallId":"p1","isError":true,"content":"bad"}}),
        ]),
        (temp.path().join(".grok/sessions/project/session/updates.jsonl"), vec![
            json!({"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"g1","title":"mcp__docs__read"}}}),
            json!({"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"g1","status":"failed"}}}),
        ]),
        (temp.path().join(".kimi-code/sessions/session/agents/main/wire.jsonl"), vec![
            json!({"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"k1","name":"mcp__docs__read","args":{}}}),
            json!({"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"k1","result":{"isError":true}}}),
        ]),
    ];
    for (path, rows) in cases {
        if path.file_name().unwrap() == "updates.jsonl" {
            write_text(&path.with_file_name("summary.json"), r#"{"info":{"id":"session","cwd":"/repo"}}"#);
        }
        write_text(&path, &rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n"));
        let events = scan_tool_events(&path);
        assert_eq!(events.len(), 1, "{}", path.display());
        assert_eq!(events[0].category, "mcp:docs", "{}", path.display());
        let (_, stats) = scan_session_combined(&path);
        assert_eq!(stats.tool_call_count, 1);
        assert_eq!(stats.mcp_calls.get("docs"), Some(&1));
        assert!(stats.builtin_calls.is_empty());
    }
}

#[tokio::test]
async fn opencode_database_uses_native_server_metadata_and_state() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("opencode.db");
    let mut conn = open_opencode_test_database(&path).await;
    sqlx::query("INSERT INTO session(id, directory, title, slug, time_created, time_updated) VALUES ('ses_mcp', '/repo', 'mcp', 'mcp', 1, 2)")
        .execute(&mut conn).await.unwrap();
    sqlx::query("INSERT INTO message(id, session_id, time_created, time_updated, data) VALUES ('msg_1', 'ses_mcp', 1, 2, ?1)")
        .bind(json!({"role":"assistant"}).to_string()).execute(&mut conn).await.unwrap();
    sqlx::query("INSERT INTO part(id, message_id, session_id, time_created, time_updated, data) VALUES ('part_1', 'msg_1', 'ses_mcp', 1, 2, ?1)")
        .bind(json!({"type":"tool","tool":"lookup","callID":"native-call","server":"docs",
            "state":{"status":"completed","input":{"query":"hello"},"output":"found"}}).to_string())
        .execute(&mut conn).await.unwrap();
    conn.close().await.unwrap();
    let sessions = parse_opencode_database(&path, None).await.unwrap();
    let parsed = &sessions[0];
    assert_eq!(parsed.computed.stats.mcp_calls.get("docs"), Some(&1));
    assert!(parsed.computed.stats.builtin_calls.is_empty());
    assert_eq!(parsed.tool_events[0].call_id.as_deref(), Some("native-call"));
    assert_eq!(parsed.tool_events[0].output_summary.as_deref(), Some("found"));
}
