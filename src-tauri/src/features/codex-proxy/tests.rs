use super::*;

fn ssh_transport(auth_mode: &str) -> SshTransportSpec {
    SshTransportSpec {
        host: "example.com".to_string(),
        port: 22,
        username: "dev".to_string(),
        config_alias: String::new(),
        config_file: String::new(),
        auth_mode: auth_mode.to_string(),
        identity_file: if auth_mode == "identity_file" {
            "/home/dev/.ssh/id ed25519".to_string()
        } else {
            String::new()
        },
        credential_ref: if auth_mode == "credential_ref" {
            "cli-manager:ssh:host-1".to_string()
        } else {
            String::new()
        },
        jump_target: String::new(),
        proxy_type: "none".to_string(),
        proxy_host: String::new(),
        proxy_port: 0,
        proxy_command: String::new(),
        connect_timeout_sec: 10,
        server_alive_interval_sec: 30,
        server_alive_count_max: 3,
    }
}

fn ssh_codex_launch(auth_mode: &str) -> SshCodexLaunch {
    SshCodexLaunch {
        transport: ssh_transport(auth_mode),
        remote_path: "/srv/project dir".to_string(),
        environment_overrides: HashMap::from([
            ("CODEX_HOME".to_string(), "~/codex config".to_string()),
            ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
            ("GIT_CONFIG_KEY_0".to_string(), "safe.directory".to_string()),
            (
                "GIT_CONFIG_VALUE_0".to_string(),
                "/srv/project dir".to_string(),
            ),
        ]),
        initialization_command: Some("source ~/.profile".to_string()),
    }
}

#[test]
fn app_server_provider_overrides_expand_complete_profile_before_subcommand() {
    let args = build_codex_child_args(
        &[
            "app-server".to_string(),
            "--listen".to_string(),
            "stdio://".to_string(),
        ],
        &CodexProviderOverrides {
            profile_name: Some("cli-manager-project-provider-123".to_string()),
            profile_overrides: vec![
                "service_tier=\"fast\"".to_string(),
                "features.enable_request_compression=true".to_string(),
            ],
            model_provider: Some("custom".to_string()),
            provider_name: Some("model_providers.custom.name=CLI-Manager remote".to_string()),
            base_url: Some(
                "model_providers.custom.base_url=https://provider.example.com/v1".to_string(),
            ),
            env_key: Some(
                "model_providers.custom.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY".to_string(),
            ),
            model: Some("model=gpt-5.4".to_string()),
            model_catalog: Some(
                r#"model_catalog_json="C:/Users/test/CLI Manager/cli-manager-model-catalog.json""#
                    .to_string(),
            ),
            wire_api: Some("model_providers.custom.wire_api=responses".to_string()),
        },
    )
    .unwrap();

    assert_eq!(
        args,
        vec![
            "-c",
            "service_tier=\"fast\"",
            "-c",
            "features.enable_request_compression=true",
            "-c",
            "model_provider=\"custom\"",
            "-c",
            "model_providers.custom.name=CLI-Manager remote",
            "-c",
            "model_providers.custom.base_url=https://provider.example.com/v1",
            "-c",
            "model_providers.custom.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY",
            "-c",
            "model_providers.custom.wire_api=responses",
            "-c",
            r#"model_catalog_json="C:/Users/test/CLI Manager/cli-manager-model-catalog.json""#,
            "-c",
            "model=gpt-5.4",
            "app-server",
            "--listen",
            "stdio://",
        ]
    );
    assert!(!args.iter().any(|arg| arg.contains("sk-provider-secret")));
}

#[test]
fn protocol_trace_records_stages_without_message_content() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cc-connect.log");
    let state = Arc::new(Mutex::new(ProtocolTraceState::default()));
    trace_client_protocol_line(
        Some(&path),
        &state,
        br#"{"jsonrpc":"2.0","id":7,"method":"turn/start","params":{"input":[{"type":"text","text":"private prompt sk-secret"}]}}"#,
    );
    trace_server_protocol_line(
        Some(&path),
        &state,
        br#"{"jsonrpc":"2.0","id":7,"result":{"turn":{"id":"turn-1"}}}"#,
    );
    trace_server_protocol_line(
        Some(&path),
        &state,
        br#"{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-private"}}"#,
    );
    trace_server_protocol_line(
        Some(&path),
        &state,
        br#"{"jsonrpc":"2.0","method":"turn/completed","params":{"turn":{"status":"completed"},"output":"private answer"}}"#,
    );

    let trace = std::fs::read_to_string(path).unwrap();
    assert!(trace.contains("stage=client.turn.start"));
    assert!(trace.contains("stage=server.turn.start.ok"));
    assert!(trace.contains("stage=server.turn.started"));
    assert!(trace.contains("stage=server.turn.completed"));
    for private_value in [
        "private prompt",
        "sk-secret",
        "thread-private",
        "private answer",
    ] {
        assert!(!trace.contains(private_value));
    }
}

#[test]
fn runtime_provider_overrides_keep_the_generated_profile() {
    let args = build_codex_child_args(
        &["resume".to_string(), "thread-original".to_string()],
        &CodexProviderOverrides {
            profile_name: Some("cli-manager-project-provider-123".to_string()),
            profile_overrides: vec!["service_tier=\"fast\"".to_string()],
            model_provider: Some("custom".to_string()),
            provider_name: Some("model_providers.custom.name=CLI-Manager remote".to_string()),
            base_url: Some(
                "model_providers.custom.base_url=https://provider.example.com/v1".to_string(),
            ),
            env_key: Some(
                "model_providers.custom.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY".to_string(),
            ),
            model: Some("model=gpt-5.4".to_string()),
            model_catalog: Some(
                r#"model_catalog_json="C:/Users/test/CLI Manager/cli-manager-model-catalog.json""#
                    .to_string(),
            ),
            wire_api: Some("model_providers.custom.wire_api=responses".to_string()),
        },
    )
    .unwrap();

    assert_eq!(
        args.get(0..2),
        Some(
            [
                "--profile".to_string(),
                "cli-manager-project-provider-123".to_string(),
            ]
            .as_slice()
        )
    );
    assert!(!args.iter().any(|arg| arg == "service_tier=\"fast\""));
    assert_eq!(
        args.get(args.len().saturating_sub(2)..),
        Some(["resume".to_string(), "thread-original".to_string()].as_slice())
    );
}

#[test]
fn app_server_arguments_pass_through_without_provider_overrides() {
    let original = vec![
        "app-server".to_string(),
        "--listen".to_string(),
        "stdio://".to_string(),
    ];
    assert_eq!(
        build_codex_child_args(&original, &CodexProviderOverrides::default()).unwrap(),
        original
    );
}

#[test]
fn complete_profile_is_flattened_into_codex_config_overrides() {
    let profile = r#"
model_provider = "custom"
service_tier = "fast"

[features]
enable_request_compression = true

[model_providers."custom.provider"]
base_url = "https://provider.example.com/v1"
wire_api = "responses"
"#;
    let profile = toml::from_str::<toml::Value>(profile).unwrap();
    let mut overrides = Vec::new();
    flatten_codex_profile_value(None, &profile, &mut overrides).unwrap();

    assert!(overrides.contains(&"model_provider=\"custom\"".to_string()));
    assert!(overrides.contains(&"service_tier=\"fast\"".to_string()));
    assert!(overrides.contains(&"features.enable_request_compression=true".to_string()));
    assert!(overrides.contains(
        &"model_providers.\"custom.provider\".base_url=\"https://provider.example.com/v1\""
            .to_string()
    ));
}

#[test]
fn oversized_app_server_profile_fails_before_process_spawn() {
    let error = build_codex_child_args(
        &[
            "app-server".to_string(),
            "--listen".to_string(),
            "stdio://".to_string(),
        ],
        &CodexProviderOverrides {
            profile_name: Some("cli-manager-project-provider-123".to_string()),
            profile_overrides: vec![format!(
                "developer_instructions={}",
                serde_json::to_string(&"x".repeat(MAX_CODEX_CHILD_ARGUMENT_UTF16_UNITS)).unwrap()
            )],
            model_provider: Some("custom".to_string()),
            provider_name: Some("model_providers.custom.name=CLI-Manager remote".to_string()),
            base_url: Some(
                "model_providers.custom.base_url=https://provider.example.com/v1".to_string(),
            ),
            env_key: Some(
                "model_providers.custom.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY".to_string(),
            ),
            model_catalog: Some(r#"model_catalog_json="C:/Users/test/catalog.json""#.to_string()),
            wire_api: Some("model_providers.custom.wire_api=responses".to_string()),
            ..CodexProviderOverrides::default()
        },
    )
    .unwrap_err();

    assert!(error.contains("command-line budget"));
}

#[test]
fn registered_codex_launcher_args_are_decoded_as_structured_argv() {
    assert_eq!(
        parse_codex_launcher_args(r#"["-c","model_reasoning_effort=high"]"#).unwrap(),
        vec!["-c", "model_reasoning_effort=high"]
    );
    assert!(parse_codex_launcher_args(r#"{"command":"codex"}"#).is_err());
    assert!(parse_codex_launcher_args(r#"["line\nbreak"]"#).is_err());
}

#[test]
fn only_the_first_argument_selects_app_server_proxying() {
    assert!(is_app_server_command(&["app-server".to_string()]));
    assert!(!is_app_server_command(&[
        "--version".to_string(),
        "app-server".to_string(),
    ]));
    assert!(!is_app_server_command(&[]));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_script_launch_paths_drop_verbatim_prefixes() {
    assert_eq!(
        windows_shell_path(Path::new(r"\\?\D:\Code Space\codex.cmd")),
        PathBuf::from(r"D:\Code Space\codex.cmd")
    );
    assert_eq!(
        windows_shell_path(Path::new(r"\\?\UNC\server\share\codex.cmd")),
        PathBuf::from(r"\\server\share\codex.cmd")
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_script_launch_rejects_command_boundary_characters() {
    for unsafe_value in [
        r"D:\codex&more.cmd",
        "D:\\codex\rbreak.cmd",
        "model=gpt\nwhoami",
    ] {
        assert!(contains_unsupported_script_characters(unsafe_value));
    }
    assert!(!contains_unsupported_script_characters(
        r"D:\Code Space\中文\codex.cmd"
    ));
}

#[test]
fn partial_provider_overrides_are_rejected() {
    let error = CodexProviderOverrides {
        profile_name: Some("cli-manager-project-provider-123".into()),
        model_provider: Some("custom".into()),
        provider_name: Some("model_providers.custom.name=CLI-Manager remote".into()),
        base_url: Some("model_providers.custom.base_url=https://example.com".into()),
        ..CodexProviderOverrides::default()
    }
    .command_args(false)
    .unwrap_err();
    assert!(error.contains("environment key"));
}

#[test]
fn provider_overrides_require_the_managed_model_catalog() {
    let error = CodexProviderOverrides {
        profile_name: Some("cli-manager-project-provider-123".into()),
        model_provider: Some("custom".into()),
        provider_name: Some("model_providers.custom.name=CLI-Manager remote".into()),
        base_url: Some("model_providers.custom.base_url=https://example.com".into()),
        env_key: Some("model_providers.custom.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY".into()),
        wire_api: Some("model_providers.custom.wire_api=responses".into()),
        ..CodexProviderOverrides::default()
    }
    .command_args(false)
    .unwrap_err();
    assert!(error.contains("model catalog"));
}

#[test]
fn compacts_a_resume_response_larger_than_cc_connects_limit() {
    let huge_history = "x".repeat(11 * 1024 * 1024);
    let source = json_line(&json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "cwd": "F:\\repo",
            "model": "gpt-5.4",
            "modelProvider": "custom",
            "reasoningEffort": "high",
            "thread": {
                "id": "thread-original",
                "modelProvider": "custom",
                "turns": [{"items": [{"type": "message", "text": huge_history}]}]
            }
        }
    }));
    assert!(source.len() > 10 * 1024 * 1024);
    let mut pending = HashMap::from([(
        "2".to_string(),
        PendingResume {
            requested_thread_id: "thread-original".to_string(),
            expected_thread_id: Some("thread-original".to_string()),
            expected_model_provider: Some("custom".to_string()),
        },
    )]);

    let compact = transform_server_line(&source, &mut pending).unwrap();
    assert!(compact.len() < 1024);
    let value: Value = serde_json::from_slice(trim_line_ending(&compact)).unwrap();
    assert_eq!(value["result"]["thread"]["id"], "thread-original");
    assert_eq!(value["result"]["cwd"], r"F:\repo");
    assert_eq!(value["result"]["model"], "gpt-5.4");
    assert_eq!(value["result"]["modelProvider"], "custom");
    assert_eq!(value["result"]["reasoningEffort"], "high");
    assert!(value["result"]["thread"].get("turns").is_none());
    assert!(pending.is_empty());
}

#[test]
fn resume_response_rejects_a_provider_mismatch_before_the_first_turn() {
    let source = json_line(&json!({
        "jsonrpc": "2.0",
        "id": 15,
        "result": {
            "cwd": "F:\\repo",
            "model": "gpt-5.4",
            "modelProvider": "custom",
            "thread": {
                "id": "thread-original",
                "modelProvider": "custom",
            }
        }
    }));
    let mut pending = HashMap::from([(
        "15".to_string(),
        PendingResume {
            requested_thread_id: "thread-original".to_string(),
            expected_thread_id: Some("thread-original".to_string()),
            expected_model_provider: Some("cli_manager".to_string()),
        },
    )]);

    let response = transform_server_line(&source, &mut pending).unwrap();
    let response: Value = serde_json::from_slice(trim_line_ending(&response)).unwrap();
    assert!(response.get("result").is_none());
    assert!(response["error"]["message"]
        .as_str()
        .is_some_and(|message| message.contains("Provider mismatch")));
    assert!(pending.is_empty());
}

#[test]
fn resume_response_uses_the_effective_provider_over_stale_thread_metadata() {
    let source = json_line(&json!({
        "jsonrpc": "2.0",
        "id": 16,
        "result": {
            "cwd": "F:\\repo",
            "model": "gpt-5.4",
            "modelProvider": "cli_manager",
            "thread": {
                "id": "thread-original",
                "modelProvider": "custom",
            }
        }
    }));
    let mut pending = HashMap::from([(
        "16".to_string(),
        PendingResume {
            requested_thread_id: "thread-original".to_string(),
            expected_thread_id: Some("thread-original".to_string()),
            expected_model_provider: Some("cli_manager".to_string()),
        },
    )]);

    let response = transform_server_line(&source, &mut pending).unwrap();
    let response: Value = serde_json::from_slice(trim_line_ending(&response)).unwrap();
    assert_eq!(response["result"]["modelProvider"], "cli_manager");
    assert_eq!(response["result"]["thread"]["modelProvider"], "cli_manager");
    assert!(pending.is_empty());
}

#[test]
fn strict_handoff_rejects_session_drift_and_fresh_thread_fallback() {
    let mut pending = HashMap::new();
    let mut delivery_instruction_pending = false;
    let drifted =
        br#"{"jsonrpc":"2.0","id":3,"method":"thread/resume","params":{"threadId":"thread-new"}}
"#;
    let ClientLineAction::Reject(response) = inspect_client_line(
        drifted,
        Some("thread-original"),
        None,
        None,
        &mut pending,
        &mut delivery_instruction_pending,
    ) else {
        panic!("drifted resume must be rejected");
    };
    let response: Value = serde_json::from_slice(trim_line_ending(&response)).unwrap();
    assert_eq!(response["id"], 3);
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .contains("session drift"));
    assert!(pending.is_empty());

    let fresh = br#"{"jsonrpc":"2.0","id":4,"method":"thread/start","params":{}}
"#;
    assert!(matches!(
        inspect_client_line(
            fresh,
            Some("thread-original"),
            None,
            None,
            &mut pending,
            &mut delivery_instruction_pending,
        ),
        ClientLineAction::Reject(_)
    ));
}

#[test]
fn matching_resume_is_forwarded_and_tracked() {
    let mut pending = HashMap::new();
    let mut delivery_instruction_pending = false;
    let request = br#"{"jsonrpc":"2.0","id":7,"method":"thread/resume","params":{"threadId":"thread-original"}}
"#;
    assert!(matches!(
        inspect_client_line(
            request,
            Some("thread-original"),
            None,
            None,
            &mut pending,
            &mut delivery_instruction_pending,
        ),
        ClientLineAction::Forward(_)
    ));
    assert_eq!(
        pending
            .get("7")
            .map(|item| item.requested_thread_id.as_str()),
        Some("thread-original")
    );
}

#[test]
fn local_handoff_resume_injects_registered_provider() {
    let mut pending = HashMap::new();
    let mut delivery_instruction_pending = false;
    let request = br#"{"jsonrpc":"2.0","id":14,"method":"thread/resume","params":{"threadId":"thread-original"}}
"#;
    let ClientLineAction::Forward(forwarded) = inspect_client_line(
        request,
        Some("thread-original"),
        Some("custom"),
        None,
        &mut pending,
        &mut delivery_instruction_pending,
    ) else {
        panic!("managed local resume must be forwarded");
    };
    let forwarded: Value = serde_json::from_slice(trim_line_ending(&forwarded)).unwrap();
    assert_eq!(forwarded["params"]["modelProvider"], "custom");
    assert_eq!(forwarded["params"]["threadId"], "thread-original");
    assert!(pending.contains_key("14"));
}

#[test]
fn ssh_resume_rewrites_placeholder_cwd_to_remote_directory() {
    let mut pending = HashMap::new();
    let mut delivery_instruction_pending = false;
    let request = br#"{"jsonrpc":"2.0","id":8,"method":"thread/resume","params":{"threadId":"thread-original","cwd":"C:\\placeholder"}}
"#;
    let ClientLineAction::Forward(forwarded) = inspect_client_line(
        request,
        Some("thread-original"),
        None,
        Some("/srv/project"),
        &mut pending,
        &mut delivery_instruction_pending,
    ) else {
        panic!("matching SSH resume must be forwarded");
    };
    let forwarded: Value = serde_json::from_slice(trim_line_ending(&forwarded)).unwrap();
    assert_eq!(forwarded["params"]["cwd"], "/srv/project");
    assert!(pending.contains_key("8"));
}

#[test]
fn local_managed_turn_injects_delivery_context_without_changing_user_text() {
    let mut pending = HashMap::new();
    let mut delivery_instruction_pending = true;
    let first = br#"{"jsonrpc":"2.0","id":9,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"localImage","path":"C:\\tmp\\source.png"},{"type":"text","text":"Create the report"}],"additionalContext":{"cc-connect":{"kind":"application","value":"existing"}}}}
"#;
    let ClientLineAction::Forward(first) = inspect_client_line(
        first,
        Some("thread-original"),
        Some("custom"),
        None,
        &mut pending,
        &mut delivery_instruction_pending,
    ) else {
        panic!("managed local turn must be forwarded");
    };
    let first: Value = serde_json::from_slice(trim_line_ending(&first)).unwrap();
    assert_eq!(first["params"]["input"][0]["path"], r"C:\tmp\source.png");
    assert_eq!(first["params"]["input"][1]["text"], "Create the report");
    assert_eq!(
        first["params"]["additionalContext"][LOCAL_HANDOFF_DELIVERY_CONTEXT_KEY]["kind"],
        "application"
    );
    assert_eq!(
        first["params"]["additionalContext"][LOCAL_HANDOFF_DELIVERY_CONTEXT_KEY]["value"],
        LOCAL_HANDOFF_DELIVERY_INSTRUCTION
    );
    assert_eq!(
        first["params"]["additionalContext"]["cc-connect"]["value"],
        "existing"
    );
    assert!(!delivery_instruction_pending);

    let second = br#"{"jsonrpc":"2.0","id":10,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"text","text":"Continue"}]}}
"#;
    let ClientLineAction::Forward(forwarded) = inspect_client_line(
        second,
        Some("thread-original"),
        Some("custom"),
        None,
        &mut pending,
        &mut delivery_instruction_pending,
    ) else {
        panic!("subsequent managed local turn must be forwarded");
    };
    assert_eq!(forwarded, second);
}

#[test]
fn delivery_instruction_ignores_ssh_and_unmanaged_turns() {
    let request = br#"{"jsonrpc":"2.0","id":11,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"text","text":"Create a file"}]}}
"#;
    let mut pending = HashMap::new();
    let mut ssh_instruction_pending = true;
    let ClientLineAction::Forward(ssh_forwarded) = inspect_client_line(
        request,
        Some("thread-original"),
        None,
        Some("/srv/project"),
        &mut pending,
        &mut ssh_instruction_pending,
    ) else {
        panic!("SSH turn must be forwarded");
    };
    assert_eq!(ssh_forwarded, request);
    assert!(ssh_instruction_pending);

    let mut unmanaged_instruction_pending = true;
    let ClientLineAction::Forward(unmanaged_forwarded) = inspect_client_line(
        request,
        None,
        None,
        None,
        &mut pending,
        &mut unmanaged_instruction_pending,
    ) else {
        panic!("unmanaged turn must be forwarded");
    };
    assert_eq!(unmanaged_forwarded, request);
    assert!(unmanaged_instruction_pending);
}

#[test]
fn delivery_instruction_waits_for_the_first_text_input() {
    let mut pending = HashMap::new();
    let mut delivery_instruction_pending = true;
    let image_only = br#"{"jsonrpc":"2.0","id":12,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"localImage","path":"C:\\tmp\\source.png"}]}}
"#;
    let ClientLineAction::Forward(forwarded) = inspect_client_line(
        image_only,
        Some("thread-original"),
        Some("custom"),
        None,
        &mut pending,
        &mut delivery_instruction_pending,
    ) else {
        panic!("image-only turn must be forwarded");
    };
    assert_eq!(forwarded, image_only);
    assert!(delivery_instruction_pending);

    let text_turn = br#"{"jsonrpc":"2.0","id":13,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"text","text":"Now create it"}]}}
"#;
    let ClientLineAction::Forward(forwarded) = inspect_client_line(
        text_turn,
        Some("thread-original"),
        Some("custom"),
        None,
        &mut pending,
        &mut delivery_instruction_pending,
    ) else {
        panic!("text turn must be forwarded");
    };
    let forwarded: Value = serde_json::from_slice(trim_line_ending(&forwarded)).unwrap();
    assert_eq!(forwarded["params"]["input"][0]["text"], "Now create it");
    assert_eq!(
        forwarded["params"]["additionalContext"][LOCAL_HANDOFF_DELIVERY_CONTEXT_KEY]["value"],
        LOCAL_HANDOFF_DELIVERY_INSTRUCTION
    );
    assert!(!delivery_instruction_pending);
}

#[test]
fn ssh_codex_command_quotes_paths_environment_and_arguments() {
    let launch = ssh_codex_launch("identity_file");
    let args = vec![
        "app-server".to_string(),
        "--listen".to_string(),
        "stdio://".to_string(),
    ];
    let command = launch.remote_command(&args);

    assert!(command.starts_with("cd -- '/srv/project dir' && exec 3>&1 && exec"));
    assert!(command.contains("\"${SHELL:-/bin/sh}\" -lic"));
    assert!(command.ends_with("1>&2"));
    assert!(command.contains("1>&3 3>&-"));
    assert!(command.contains("source ~/.profile"));
    assert_eq!(
        format_remote_home_path("~/codex config"),
        "\"${HOME}\"/'codex config'"
    );
    for expected in [
        "CODEX_HOME",
        "${HOME}",
        "GIT_CONFIG_KEY_0",
        "safe.directory",
        "codex",
        "app-server",
        "--listen",
        "stdio://",
    ] {
        assert!(command.contains(expected), "missing {expected}: {command}");
    }

    let transport = launch.build_launch(&args).unwrap();
    assert_eq!(transport.args.first().map(String::as_str), Some("-T"));
    assert_eq!(transport.args.last(), Some(&command));
}

#[test]
fn ssh_codex_launch_rejects_interactive_authentication() {
    for auth_mode in ["password_prompt", "interactive"] {
        assert_eq!(
            ssh_codex_launch(auth_mode).encode().unwrap_err(),
            "handoff_ssh_interactive_auth_unsupported"
        );
    }
}

#[test]
fn ssh_codex_launch_serialization_contains_only_the_credential_reference() {
    let launch = ssh_codex_launch("credential_ref");
    let encoded = launch.encode().unwrap();
    let decoded = BASE64_STANDARD.decode(encoded).unwrap();
    let document: Value = serde_json::from_slice(&decoded).unwrap();

    assert_eq!(
        document.pointer("/transport/credentialRef"),
        Some(&Value::String("cli-manager:ssh:host-1".to_string()))
    );
    assert!(document.pointer("/transport/password").is_none());
    assert!(document.get("password").is_none());
}

#[test]
fn ssh_app_server_events_drive_handoff_notifications() {
    let started = json_line(&json!({
        "jsonrpc": "2.0",
        "method": "turn/started",
        "params": {
            "threadId": "thread-original",
            "turn": { "id": "turn-1", "status": "inProgress" }
        }
    }));
    let started =
        ssh_handoff_hook_payload(&started, "local-session", Some("thread-original")).unwrap();
    assert_eq!(started["tabId"], "local-session");
    assert_eq!(started["event"], "UserPromptSubmit");
    assert_eq!(started["sessionId"], "thread-original");

    let approval = json_line(&json!({
        "jsonrpc": "2.0",
        "id": 11,
        "method": "item/commandExecution/requestApproval",
        "params": {
            "threadId": "thread-original",
            "turnId": "turn-1",
            "itemId": "item-1"
        }
    }));
    let approval =
        ssh_handoff_hook_payload(&approval, "local-session", Some("thread-original")).unwrap();
    assert_eq!(approval["event"], "PermissionRequest");
    assert_eq!(approval["toolUseId"], "item-1");

    let completed = json_line(&json!({
        "jsonrpc": "2.0",
        "method": "turn/completed",
        "params": {
            "threadId": "thread-original",
            "turn": { "id": "turn-1", "status": "failed" }
        }
    }));
    let completed =
        ssh_handoff_hook_payload(&completed, "local-session", Some("thread-original")).unwrap();
    assert_eq!(completed["event"], "StopFailure");
}

#[test]
fn ssh_handoff_notifications_ignore_retrying_errors_and_session_drift() {
    let retrying = json_line(&json!({
        "jsonrpc": "2.0",
        "method": "error",
        "params": {
            "threadId": "thread-original",
            "turnId": "turn-1",
            "willRetry": true,
            "error": { "message": "temporary" }
        }
    }));
    assert!(
        ssh_handoff_hook_payload(&retrying, "local-session", Some("thread-original"),).is_none()
    );

    let drifted = json_line(&json!({
        "jsonrpc": "2.0",
        "method": "turn/started",
        "params": {
            "threadId": "thread-other",
            "turn": { "id": "turn-2", "status": "inProgress" }
        }
    }));
    assert!(
        ssh_handoff_hook_payload(&drifted, "local-session", Some("thread-original"),).is_none()
    );
}
