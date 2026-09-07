use super::*;

pub(super) fn request_log_dedup_fixture(
    source: &str,
    session_id: &str,
    occurred_at: i64,
    model: &str,
    usage: UsageStatsScan,
) -> HistoryStatsSessionFact {
    HistoryStatsSessionFact {
        summary: HistorySessionSummary {
            session_id: session_id.to_string(),
            parent_session_id: None,
            source: source.to_string(),
            project_key: "project".to_string(),
            title: "session".to_string(),
            file_path: "session.jsonl".to_string(),
            cwd: None,
            created_at: occurred_at,
            updated_at: occurred_at,
            message_count: 1,
            branch: None,
        },
        occurred_at,
        stats: usage,
        model: Some(model.to_string()),
    }
}

pub(super) fn write_file(path: &Path) {
    write_text(path, "{}\n");
}

pub(super) fn write_text(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

pub(super) fn expect_string_err<T>(result: Result<T, String>) -> String {
    match result {
        Ok(_) => panic!("expected error"),
        Err(err) => err,
    }
}

pub(super) fn remote_history_plan() -> SshLaunchPlan {
    SshLaunchPlan {
        host_id: "host-1".to_string(),
        host: "example.test".to_string(),
        port: 22,
        username: "dev".to_string(),
        config_alias: String::new(),
        config_file: String::new(),
        auth_mode: "agent".to_string(),
        identity_file: String::new(),
        credential_ref: String::new(),
        jump_target: String::new(),
        proxy_type: String::new(),
        proxy_host: String::new(),
        proxy_port: 0,
        proxy_command: String::new(),
        connect_timeout_sec: 10,
        server_alive_interval_sec: 15,
        server_alive_count_max: 3,
        remote_path: "/work/project".to_string(),
        client_instance_id: "client-1".to_string(),
        project_id: "project-1".to_string(),
        project_name: "Project One".to_string(),
        bridge_epoch: "epoch-1".to_string(),
        agent_path: "~/.local/bin/cli-manager-ssh-agent".to_string(),
        agent_installation_id: "installation-1".to_string(),
        agent_remote_machine_id: "machine-1".to_string(),
        tool_source: "claude".to_string(),
        environment_overrides: HashMap::new(),
        initialization_command: None,
        startup_command: None,
    }
}

pub(super) fn remote_sync_result() -> RemoteHistorySyncResult {
    serde_json::from_value(json!({
        "sourceInstanceId": "instance-1",
        "source": "claude",
        "installationId": "installation-1",
        "remoteMachineId": "machine-1",
        "sshUser": "dev",
        "configuredConfigRoot": "~/.claude",
        "canonicalConfigRoot": "/home/dev/.claude",
        "configRootHash": "root-1",
        "generation": 1,
        "cursor": "1:0",
        "hasMore": false,
        "totalSessions": 0,
        "freshnessState": "fresh",
        "asOf": 1,
        "discoveryComplete": true,
        "partial": false,
        "sessions": [],
        "tombstones": [],
        "warnings": []
    }))
    .unwrap()
}

pub(super) fn empty_usage() -> HistorySessionUsage {
    HistorySessionUsage {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0.0,
        dominant_model: None,
        current_model: None,
        context_window: None,
        last_context_tokens: None,
        reasoning_effort: None,
        token_trend: Vec::new(),
        tool_call_count: 0,
        mcp_calls: Vec::new(),
        skill_calls: Vec::new(),
        builtin_calls: Vec::new(),
    }
}

pub(super) fn sample_detail(source: &str) -> HistorySessionDetail {
    HistorySessionDetail {
        session_id: "source-session".to_string(),
        source: source.to_string(),
        project_key: "CLI-Manager".to_string(),
        title: "implement conversion".to_string(),
        file_path: "source.jsonl".to_string(),
        cwd: Some(r"D:\work\CLI-Manager".to_string()),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_001_000,
        message_count: 2,
        branch: None,
        usage: empty_usage(),
        tool_events: Vec::new(),
        file_changes: Vec::new(),
        messages: vec![
            HistoryMessage {
                role: "user".to_string(),
                content: "hello".to_string(),
                parts: vec![fallback_history_message_part("user", "hello")],
                timestamp: Some("2026-01-01T00:00:00Z".to_string()),
                model: None,
                input_tokens: None,
                output_tokens: None,
                cache_creation_tokens: None,
                cache_read_tokens: None,
                line_index: None,
                editable: false,
                editable_text: None,
            },
            HistoryMessage {
                role: "assistant".to_string(),
                content: "world".to_string(),
                parts: vec![fallback_history_message_part("assistant", "world")],
                timestamp: Some("2026-01-01T00:00:01Z".to_string()),
                model: None,
                input_tokens: None,
                output_tokens: None,
                cache_creation_tokens: None,
                cache_read_tokens: None,
                line_index: None,
                editable: false,
                editable_text: None,
            },
        ],
    }
}

pub(super) fn write_kimi_session_fixture(
    home: &Path,
    session_id: &str,
    cwd: &str,
    wire_lines: &[Value],
) -> PathBuf {
    let session_dir = home.join("sessions").join("wd__fixture").join(session_id);
    let wire = session_dir.join("agents").join("main").join("wire.jsonl");
    write_text(
        &session_dir.join("state.json"),
        &json!({
            "title": "Kimi summary",
            "lastPrompt": "hello kimi",
            "workDir": cwd,
            "forkedFrom": "parent-session",
            "createdAt": "2026-08-19T00:00:00Z",
            "updatedAt": "2026-08-19T00:00:03Z"
        })
        .to_string(),
    );
    let body = wire_lines
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    write_text(&wire, &format!("{body}\n"));
    write_text(
        &home.join("session_index.jsonl"),
        &format!(
            "{}\n{}\n",
            json!({
                "sessionId": session_id,
                "sessionDir": session_dir.to_string_lossy(),
                "workDir": cwd
            }),
            json!({
                "sessionId": "other-session",
                "sessionDir": home.join("sessions").join("wd__fixture").join("other-session").to_string_lossy(),
                "workDir": cwd
            })
        ),
    );
    write_text(
        &session_dir
            .join("agents")
            .join("agent-0")
            .join("wire.jsonl"),
        &json!({
            "type": "turn.prompt",
            "input": [{"type": "text", "text": "subagent should not be listed"}]
        })
        .to_string(),
    );
    wire
}

pub(super) async fn open_opencode_test_database(db_path: &Path) -> SqliteConnection {
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    for statement in [
        "CREATE TABLE session(
            id TEXT PRIMARY KEY,
            directory TEXT,
            title TEXT,
            slug TEXT,
            time_created REAL,
            time_updated REAL
         )",
        "CREATE TABLE message(
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created REAL,
            time_updated REAL,
            data TEXT NOT NULL
         )",
        "CREATE TABLE part(
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created REAL,
            time_updated REAL,
            data TEXT NOT NULL
         )",
    ] {
        sqlx::query(statement).execute(&mut conn).await.unwrap();
    }
    conn
}
