use super::{
    bridge_failure_should_fail_pending, bridge_refresh_plan, bridge_slot, checked_response,
    classify_bridge_stderr, fail_pending_requests, handle_agent_request, permanent_bridge_error,
    read_preamble, readonly_client_instance_id, receive_agent_response, receive_frame, request,
    request_error_requires_disconnect, required_capability, response_timeout, retry_delay,
    should_refresh_capability_error, validate_hook_batch, AgentBridgeRequest, BridgeControl,
    BridgeEntry, BridgeLane, ClientFrame, CounterPermit, EventDedup, PermitPool, ReaderMessage,
    ServerFrame, SshAgentBridgeManager, DEDUP_EVENT_IDS,
};
use crate::ssh_launch::SshLaunchPlan;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Cursor};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, OnceLock};
use std::time::Duration;

fn test_bridge_plan() -> SshLaunchPlan {
    SshLaunchPlan {
        host_id: "host-1".to_string(),
        host: "example.com".to_string(),
        port: 22,
        username: "root".to_string(),
        config_alias: String::new(),
        config_file: String::new(),
        auth_mode: "identity_file".to_string(),
        identity_file: "C:/Users/test/.ssh/id_ed25519".to_string(),
        credential_ref: String::new(),
        jump_target: String::new(),
        proxy_type: String::new(),
        proxy_host: String::new(),
        proxy_port: 0,
        proxy_command: String::new(),
        connect_timeout_sec: 15,
        server_alive_interval_sec: 30,
        server_alive_count_max: 3,
        remote_path: "/root".to_string(),
        client_instance_id: "client-1".to_string(),
        project_id: "project-1".to_string(),
        project_name: "Project".to_string(),
        bridge_epoch: "epoch-1".to_string(),
        agent_path: "/root/.local/bin/cli-manager-ssh-agent".to_string(),
        agent_installation_id: "installation-1".to_string(),
        agent_remote_machine_id: "machine-1".to_string(),
        tool_source: "codex".to_string(),
        environment_overrides: HashMap::new(),
        initialization_command: None,
        startup_command: None,
    }
}

#[test]
fn missing_diff_options_capability_is_rejected_before_request_write() {
    let (_reader_sender, reader_receiver) = mpsc::sync_channel(1);
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    let mut writer = Vec::new();
    let mut request_number = 7;

    handle_agent_request(
        &mut writer,
        &reader_receiver,
        "host-1",
        &mut request_number,
        &[],
        AgentBridgeRequest {
            kind: "gitDiffWithOptions".to_string(),
            payload: json!({}),
            response: response_sender,
        },
    )
    .unwrap_err();

    assert!(writer.is_empty());
    assert_eq!(request_number, 7);
    assert_eq!(
        response_receiver.recv().unwrap().unwrap_err(),
        "ssh_agent_capability_missing:gitDiffOptions"
    );
}

#[test]
fn missing_git_history_capability_is_rejected_before_request_write() {
    let (_reader_sender, reader_receiver) = mpsc::sync_channel(1);
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    let mut writer = Vec::new();
    let mut request_number = 8;

    handle_agent_request(
        &mut writer,
        &reader_receiver,
        "host-1",
        &mut request_number,
        &[],
        AgentBridgeRequest {
            kind: "gitListCommits".to_string(),
            payload: json!({}),
            response: response_sender,
        },
    )
    .unwrap_err();

    assert!(writer.is_empty());
    assert_eq!(request_number, 8);
    assert_eq!(
        response_receiver.recv().unwrap().unwrap_err(),
        "ssh_agent_capability_missing:gitHistory"
    );
}

#[test]
fn missing_attachment_capabilities_are_rejected_before_request_write() {
    for (kind, expected_error) in [
        ("fileAttachBegin", "ssh_agent_capability_missing:fileAttach"),
        (
            "fileAttachAnyBegin",
            "ssh_agent_capability_missing:fileAttachAny",
        ),
        ("filePutBegin", "ssh_agent_capability_missing:filePut"),
        ("fileGet", "ssh_agent_capability_missing:fileGet"),
        ("fileDelete", "ssh_agent_capability_missing:fileDelete"),
    ] {
        let (_reader_sender, reader_receiver) = mpsc::sync_channel(1);
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        let mut writer = Vec::new();
        let mut request_number = 9;

        handle_agent_request(
            &mut writer,
            &reader_receiver,
            "host-1",
            &mut request_number,
            &[],
            AgentBridgeRequest {
                kind: kind.to_string(),
                payload: json!({}),
                response: response_sender,
            },
        )
        .unwrap_err();

        assert!(writer.is_empty());
        assert_eq!(request_number, 9);
        assert_eq!(
            response_receiver.recv().unwrap().unwrap_err(),
            expected_error
        );
    }
}

#[test]
fn bridge_frames_require_matching_request_ids() {
    let frame = ClientFrame {
        request_id: "request-1".to_string(),
        kind: "ping",
        payload: json!({}),
    };
    assert!(serde_json::to_vec(&frame).unwrap().len() > 4);
    let error = checked_response(
        ServerFrame {
            request_id: "other".to_string(),
            kind: "pong".to_string(),
            payload: json!({}),
        },
        "request-1",
        "pong",
    )
    .unwrap_err();
    assert_eq!(error, "ssh_agent_bridge_response_mismatch");
}

#[test]
fn remote_error_codes_are_short_and_stable() {
    let error = checked_response(
        ServerFrame {
            request_id: "request-1".to_string(),
            kind: "error".to_string(),
            payload: json!({ "code": "x".repeat(129) }),
        },
        "request-1",
        "response",
    )
    .unwrap_err();
    assert_eq!(error, "ssh_agent_bridge_remote_error");
}

#[test]
fn resume_claims_block_other_consumers_until_release() {
    let manager = SshAgentBridgeManager::default();
    let key = "source-instance-1\0claude\0session-1";
    manager.claim_resume_session(key, "consumer-1").unwrap();
    manager.claim_resume_session(key, "consumer-1").unwrap();
    assert_eq!(
        manager.claim_resume_session(key, "consumer-2").unwrap_err(),
        "remote_session_active_elsewhere"
    );
    manager.release_resume_claims("host-1", "consumer-1");
    manager.claim_resume_session(key, "consumer-2").unwrap();
}

#[test]
fn hook_batch_requires_monotonic_sequences_and_exact_latest() {
    assert!(validate_hook_batch(
        &json!({
            "events": [
                { "sequence": 2, "kind": "gap" },
                { "sequence": 3, "kind": "hookEvent" }
            ],
            "latestSequence": 3
        }),
        1,
    )
    .is_ok());
    assert_eq!(
        validate_hook_batch(
            &json!({
                "events": [
                    { "sequence": 3, "kind": "hookEvent" },
                    { "sequence": 2, "kind": "gap" }
                ],
                "latestSequence": 3
            }),
            1,
        )
        .unwrap_err(),
        "ssh_agent_bridge_hook_batch_invalid"
    );
}

#[test]
fn dedup_window_covers_the_bounded_agent_spool() {
    let mut dedup = EventDedup::default();
    for index in 0..DEDUP_EVENT_IDS {
        assert!(dedup.insert(&format!("event-{index}")));
    }
    assert!(!dedup.insert("event-0"));
    assert!(dedup.insert("gap:10001"));
    assert!(!dedup.insert("gap:10001"));
}

#[test]
fn preamble_is_bounded_and_requires_a_hex_nonce() {
    let mut valid = BufReader::new(Cursor::new(
        b"login banner\nCLI_MANAGER_SSH_AGENT/1 0123456789abcdef0123456789abcdef\n",
    ));
    read_preamble(&mut valid).unwrap();

    let mut invalid = BufReader::new(Cursor::new(b"CLI_MANAGER_SSH_AGENT/1 not-a-valid-nonce\n"));
    assert_eq!(
        read_preamble(&mut invalid).unwrap_err(),
        "ssh_agent_bridge_preamble_invalid"
    );
}

#[test]
fn response_wait_has_a_hard_timeout() {
    let (_sender, receiver) = mpsc::sync_channel(1);
    assert_eq!(
        receive_frame(&receiver, Duration::from_millis(1)).unwrap_err(),
        "ssh_agent_bridge_response_timeout"
    );
}

#[test]
fn disconnected_response_channel_is_not_reported_as_a_timeout() {
    let (sender, receiver) = mpsc::sync_channel(1);
    drop(sender);
    assert_eq!(
        receive_agent_response(&receiver, Duration::from_secs(1)).unwrap_err(),
        "ssh_agent_bridge_response_channel_closed"
    );
}

#[test]
fn bridge_start_failure_is_forwarded_to_queued_requests() {
    let (request_sender, request_receiver) = mpsc::sync_channel(1);
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    request_sender
        .send(AgentBridgeRequest {
            kind: "fileList".to_string(),
            payload: json!({}),
            response: response_sender,
        })
        .unwrap();
    fail_pending_requests(&request_receiver, "ssh_interactive_auth_required");
    assert_eq!(
        receive_agent_response(&response_receiver, Duration::from_secs(1)).unwrap_err(),
        "ssh_interactive_auth_required"
    );
}

#[test]
fn readonly_request_reuses_only_a_request_ready_matching_primary_bridge() {
    let control = Arc::new(BridgeControl::new());
    control.connecting.store(false, Ordering::Release);
    control.connected.store(true, Ordering::Release);
    let (request_sender, _request_receiver) = mpsc::sync_channel(1);
    let manager = SshAgentBridgeManager {
        bridges: std::sync::Mutex::new(HashMap::from([(
            bridge_slot("host-1", BridgeLane::Primary),
            BridgeEntry {
                identity: "identity-1".to_string(),
                sessions: HashSet::from(["session-1".to_string()]),
                consumers: HashSet::new(),
                request_sender,
                control: Arc::clone(&control),
                plan: test_bridge_plan(),
                lane: BridgeLane::Primary,
            },
        )])),
        resume_claims: std::sync::Mutex::new(HashMap::new()),
    };

    let reservation = manager
        .try_reserve_primary("host-1", "identity-1", "files-1")
        .unwrap();
    assert_eq!(control.pending_requests.load(Ordering::Acquire), 1);
    assert!(manager
        .try_reserve_primary("host-1", "identity-1", "files-2")
        .is_none());
    assert!(manager
        .try_reserve_primary("host-1", "identity-2", "files-2")
        .is_none());
    drop(reservation);
    assert_eq!(control.pending_requests.load(Ordering::Acquire), 0);

    let hook_poll = control.try_reserve_idle_activity().unwrap();
    assert!(manager
        .try_reserve_primary("host-1", "identity-1", "files-2")
        .is_none());
    drop(hook_poll);

    let next = manager
        .try_reserve_primary("host-1", "identity-1", "files-2")
        .unwrap();
    drop(next);
    control.connected.store(false, Ordering::Release);
    assert!(manager
        .try_reserve_primary("host-1", "identity-1", "files-3")
        .is_none());
}

#[test]
fn invalidating_a_reservation_only_stops_the_same_bridge_slot_and_control() {
    let old_control = Arc::new(BridgeControl::new());
    old_control.connecting.store(false, Ordering::Release);
    old_control.connected.store(true, Ordering::Release);
    let (old_sender, _old_receiver) = mpsc::sync_channel(1);
    let slot = bridge_slot("host-1", BridgeLane::Primary);
    let manager = SshAgentBridgeManager {
        bridges: std::sync::Mutex::new(HashMap::from([(
            slot.clone(),
            BridgeEntry {
                identity: "identity-1".to_string(),
                sessions: HashSet::new(),
                consumers: HashSet::new(),
                request_sender: old_sender,
                control: Arc::clone(&old_control),
                plan: test_bridge_plan(),
                lane: BridgeLane::Primary,
            },
        )])),
        resume_claims: std::sync::Mutex::new(HashMap::new()),
    };

    let reservation = manager
        .try_reserve_primary("host-1", "identity-1", "files-1")
        .unwrap();
    let (refresh_plan, refresh_lane) = manager.invalidate_reservation(&reservation).unwrap();
    assert_eq!(refresh_plan.host_id, "host-1");
    assert_eq!(refresh_lane, BridgeLane::Primary);
    assert!(manager
        .bridges
        .lock()
        .unwrap()
        .get(&slot)
        .is_some_and(|entry| Arc::ptr_eq(&entry.control, &old_control)));
    assert!(old_control.stop.load(Ordering::Acquire));
    assert!(manager
        .try_reserve_primary("host-1", "identity-1", "files-2")
        .is_none());

    let new_control = Arc::new(BridgeControl::new());
    let (new_sender, _new_receiver) = mpsc::sync_channel(1);
    manager.bridges.lock().unwrap().insert(
        slot.clone(),
        BridgeEntry {
            identity: "identity-2".to_string(),
            sessions: HashSet::new(),
            consumers: HashSet::new(),
            request_sender: new_sender,
            control: Arc::clone(&new_control),
            plan: test_bridge_plan(),
            lane: BridgeLane::Primary,
        },
    );
    assert!(manager.invalidate_reservation(&reservation).is_none());
    let bridges = manager.bridges.lock().unwrap();
    assert!(bridges.contains_key(&slot));
    assert!(!new_control.stop.load(Ordering::Acquire));
}

#[test]
fn capability_missing_requests_refresh_once_and_only_for_capability_errors() {
    let missing = Err("ssh_agent_capability_missing:fileDelete".to_string());
    assert!(should_refresh_capability_error(false, &missing));
    assert!(!should_refresh_capability_error(true, &missing));
    assert!(!should_refresh_capability_error(
        false,
        &Err("ssh_agent_capability_missing:".to_string())
    ));
    assert!(!should_refresh_capability_error(
        false,
        &Err("ssh_agent_bridge_request_failed".to_string())
    ));
    assert!(!should_refresh_capability_error(false, &Ok(json!({}))));
}

#[test]
fn refresh_plan_keeps_primary_context_but_uses_current_agent_identity() {
    let stale_plan = test_bridge_plan();
    let mut current_plan = test_bridge_plan();
    current_plan.project_id.clear();
    current_plan.remote_path = "/tmp/uploads".to_string();
    current_plan.agent_path = "/root/.local/bin/cli-manager-ssh-agent-new".to_string();
    current_plan.agent_installation_id = "installation-new".to_string();
    current_plan.agent_remote_machine_id = "machine-new".to_string();

    let refreshed = bridge_refresh_plan(&current_plan, &stale_plan, BridgeLane::Primary);
    assert_eq!(refreshed.project_id, stale_plan.project_id);
    assert_eq!(refreshed.remote_path, stale_plan.remote_path);
    assert_eq!(refreshed.client_instance_id, stale_plan.client_instance_id);
    assert_eq!(refreshed.agent_path, current_plan.agent_path);
    assert_eq!(
        refreshed.agent_installation_id,
        current_plan.agent_installation_id
    );
    assert_eq!(
        refreshed.agent_remote_machine_id,
        current_plan.agent_remote_machine_id
    );
}

#[test]
fn readonly_requests_use_an_isolated_bridge_identity() {
    assert_eq!(BridgeLane::for_request("historySync"), BridgeLane::Primary);
    assert_eq!(BridgeLane::for_request("fileList"), BridgeLane::Readonly);
    assert_eq!(BridgeLane::for_request("fileGet"), BridgeLane::Readonly);
    assert_eq!(BridgeLane::for_request("fileDelete"), BridgeLane::Readonly);
    assert_eq!(
        BridgeLane::for_request("fileAttachChunk"),
        BridgeLane::Readonly
    );
    assert_eq!(BridgeLane::for_request("gitChanges"), BridgeLane::Git);
    assert_eq!(required_capability("fileAttachBegin"), Some("fileAttach"));
    assert_eq!(
        required_capability("fileAttachAnyBegin"),
        Some("fileAttachAny")
    );
    assert_eq!(
        required_capability("fileAttachmentRoot"),
        Some("fileAttachmentRoot")
    );
    assert_eq!(required_capability("filePutBegin"), Some("filePut"));
    assert_eq!(
        required_capability("gitRewriteCommits"),
        Some("gitWorkspaceTools")
    );
    assert_eq!(required_capability("gitListCommits"), Some("gitHistory"));
    assert_eq!(required_capability("fileGet"), Some("fileGet"));
    assert_eq!(required_capability("fileDelete"), Some("fileDelete"));
    let (_reader_sender, reader_receiver) = mpsc::sync_channel(1);
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    let mut writer = Vec::new();
    let mut request_number = 10;
    handle_agent_request(
        &mut writer,
        &reader_receiver,
        "host-1",
        &mut request_number,
        &[json!("fileAttachAny")],
        AgentBridgeRequest {
            kind: "fileAttachAnyBegin".to_string(),
            payload: json!({
                "attachmentRoot": "~/custom-files"
            }),
            response: response_sender,
        },
    )
    .unwrap_err();
    assert!(writer.is_empty());
    assert_eq!(request_number, 10);
    assert_eq!(
        response_receiver.recv().unwrap().unwrap_err(),
        "ssh_agent_capability_missing:fileAttachCustomRoot"
    );
    assert!(!BridgeLane::Primary.is_request_driven());
    assert!(BridgeLane::Readonly.is_request_driven());
    assert!(BridgeLane::Git.is_request_driven());
    assert!(BridgeLane::Primary.requires_tool_source());
    assert!(!BridgeLane::Readonly.requires_tool_source());
    assert!(!BridgeLane::Git.requires_tool_source());
    assert!(response_timeout("historySync") > response_timeout("fileList"));

    let readonly = readonly_client_instance_id("host-1", "client-1");
    assert_ne!(readonly, "client-1");
    assert_eq!(readonly, readonly_client_instance_id("host-1", "client-1"));
    assert_eq!(
        uuid::Uuid::parse_str(&readonly).unwrap().get_version_num(),
        8
    );
    assert_ne!(
        bridge_slot("host-1", BridgeLane::Primary),
        bridge_slot("host-1", BridgeLane::Readonly)
    );
    assert_ne!(
        bridge_slot("host-1", BridgeLane::Readonly),
        bridge_slot("host-1", BridgeLane::Git)
    );
}

#[test]
fn history_detail_chunks_are_reassembled_within_one_request() {
    let (sender, receiver) = mpsc::sync_channel(2);
    for (index, data) in ["{\"messages\":[", "]}"].into_iter().enumerate() {
        sender
            .send(ReaderMessage::Frame(ServerFrame {
                request_id: "history-1".to_string(),
                kind: "historyDetailChunk".to_string(),
                payload: json!({ "index": index, "total": 2, "data": data }),
            }))
            .unwrap();
    }
    let mut writer = Vec::new();
    let value = request(
        &mut writer,
        &receiver,
        "history-1".to_string(),
        "historyGet",
        json!({}),
        "response",
        Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(value, json!({ "messages": [] }));
    assert!(!writer.is_empty());
}

#[test]
fn history_detail_chunks_reject_out_of_order_frames() {
    let (sender, receiver) = mpsc::sync_channel(1);
    sender
        .send(ReaderMessage::Frame(ServerFrame {
            request_id: "history-1".to_string(),
            kind: "historyDetailChunk".to_string(),
            payload: json!({ "index": 1, "total": 2, "data": "{}" }),
        }))
        .unwrap();
    let error = request(
        &mut Vec::new(),
        &receiver,
        "history-1".to_string(),
        "historyGet",
        json!({}),
        "response",
        Duration::from_secs(1),
    )
    .unwrap_err();
    assert_eq!(error, "ssh_agent_bridge_history_chunk_invalid");
}

#[test]
fn file_get_chunks_are_reassembled_with_metadata() {
    let (sender, receiver) = mpsc::sync_channel(2);
    for (index, data) in ["aGVs", "bG8="].into_iter().enumerate() {
        sender
            .send(ReaderMessage::Frame(ServerFrame {
                request_id: "file-get-1".to_string(),
                kind: "fileGetChunk".to_string(),
                payload: json!({
                    "index": index,
                    "total": 2,
                    "dataBase64": data,
                    "relativePath": "notes.txt",
                    "sizeBytes": 5,
                }),
            }))
            .unwrap();
    }
    let value = request(
        &mut Vec::new(),
        &receiver,
        "file-get-1".to_string(),
        "fileGet",
        json!({}),
        "response",
        Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(
        value,
        json!({
            "relativePath": "notes.txt",
            "sizeBytes": 5,
            "dataBase64": "aGVsbG8=",
        })
    );
}

#[test]
fn reconnect_jitter_stays_within_twenty_percent() {
    for (attempt, base) in [1u64, 2, 5, 10, 30, 60].into_iter().enumerate() {
        let delay = retry_delay(attempt, "host-1").as_millis() as u64;
        assert!(delay >= base * 800);
        assert!(delay <= base * 1_200);
    }
}

#[test]
fn active_remote_bridge_is_retried_for_takeover() {
    assert!(!permanent_bridge_error("bridge_already_active"));
    assert!(!bridge_failure_should_fail_pending("bridge_already_active"));
    assert!(bridge_failure_should_fail_pending(
        "ssh_agent_bridge_protocol_incompatible"
    ));
    assert!(permanent_bridge_error(
        "ssh_agent_bridge_protocol_incompatible"
    ));
}

#[test]
fn bridge_stderr_classifies_auth_and_host_key_without_logging_raw_text() {
    assert_eq!(
        classify_bridge_stderr(b"user@example: Permission denied (publickey)."),
        Some("ssh_interactive_auth_required")
    );
    assert_eq!(
        classify_bridge_stderr(b"REMOTE HOST IDENTIFICATION HAS CHANGED"),
        Some("ssh_host_key_verification_required")
    );
    assert_eq!(classify_bridge_stderr(b"connection reset by peer"), None);
    assert!(permanent_bridge_error("ssh_host_key_verification_required"));
}

#[test]
fn permit_pool_enforces_the_configured_limit() {
    let state: &'static OnceLock<PermitPool> = Box::leak(Box::new(OnceLock::new()));
    let first_control = BridgeControl::new();
    let first = CounterPermit::acquire(state, 1, &first_control).unwrap();
    let stopped = BridgeControl::new();
    stopped.stop.store(true, Ordering::Release);
    assert!(CounterPermit::acquire(state, 1, &stopped).is_none());
    drop(first);
    assert!(CounterPermit::acquire(state, 1, &BridgeControl::new()).is_some());
}

#[test]
fn bridge_stays_alive_until_the_last_session_releases() {
    let control = Arc::new(BridgeControl::new());
    let (request_sender, _request_receiver) = mpsc::sync_channel(1);
    let manager = SshAgentBridgeManager {
        bridges: std::sync::Mutex::new(HashMap::from([(
            "host-1".to_string(),
            BridgeEntry {
                identity: "identity".to_string(),
                sessions: HashSet::from(["session-1".to_string(), "session-2".to_string()]),
                consumers: HashSet::new(),
                request_sender,
                control: Arc::clone(&control),
                plan: test_bridge_plan(),
                lane: BridgeLane::Primary,
            },
        )])),
        resume_claims: std::sync::Mutex::new(HashMap::new()),
    };
    manager.release("host-1", "session-1");
    assert_eq!(manager.bridges.lock().unwrap().len(), 1);
    assert!(!control.stop.load(Ordering::Acquire));
    manager.release("host-1", "session-2");
    assert!(manager.bridges.lock().unwrap().is_empty());
    assert!(control.stop.load(Ordering::Acquire));
}

#[test]
fn history_consumer_keeps_bridge_alive_after_terminal_closes() {
    let control = Arc::new(BridgeControl::new());
    let (request_sender, _request_receiver) = mpsc::sync_channel(1);
    let manager = SshAgentBridgeManager {
        bridges: std::sync::Mutex::new(HashMap::from([(
            "host-1".to_string(),
            BridgeEntry {
                identity: "identity".to_string(),
                sessions: HashSet::from(["session-1".to_string()]),
                consumers: HashSet::from(["history-1".to_string()]),
                request_sender,
                control: Arc::clone(&control),
                plan: test_bridge_plan(),
                lane: BridgeLane::Primary,
            },
        )])),
        resume_claims: std::sync::Mutex::new(HashMap::new()),
    };
    manager.release("host-1", "session-1");
    assert_eq!(manager.bridges.lock().unwrap().len(), 1);
    assert!(!control.stop.load(Ordering::Acquire));
    manager.release_consumer("host-1", "history-1");
    assert!(manager.bridges.lock().unwrap().is_empty());
    assert!(control.stop.load(Ordering::Acquire));
}

#[test]
fn releasing_history_consumer_also_releases_readonly_aliases() {
    let primary_control = Arc::new(BridgeControl::new());
    let readonly_control = Arc::new(BridgeControl::new());
    let (primary_sender, _primary_receiver) = mpsc::sync_channel(1);
    let (readonly_sender, _readonly_receiver) = mpsc::sync_channel(1);
    let manager = SshAgentBridgeManager {
        bridges: std::sync::Mutex::new(HashMap::from([
            (
                bridge_slot("host-1", BridgeLane::Primary),
                BridgeEntry {
                    identity: "primary".to_string(),
                    sessions: HashSet::new(),
                    consumers: HashSet::from(["history:client:host:codex:project".to_string()]),
                    request_sender: primary_sender,
                    control: Arc::clone(&primary_control),
                    plan: test_bridge_plan(),
                    lane: BridgeLane::Primary,
                },
            ),
            (
                bridge_slot("host-1", BridgeLane::Readonly),
                BridgeEntry {
                    identity: "readonly".to_string(),
                    sessions: HashSet::new(),
                    consumers: HashSet::from([
                        "files:client:host:codex:project".to_string(),
                        "git:client:host:codex:project".to_string(),
                    ]),
                    request_sender: readonly_sender,
                    control: Arc::clone(&readonly_control),
                    plan: test_bridge_plan(),
                    lane: BridgeLane::Readonly,
                },
            ),
        ])),
        resume_claims: std::sync::Mutex::new(HashMap::new()),
    };

    manager.release_consumer("host-1", "history:client:host:codex:project");
    assert!(manager.bridges.lock().unwrap().is_empty());
    assert!(primary_control.stop.load(Ordering::Acquire));
    assert!(readonly_control.stop.load(Ordering::Acquire));
}

#[test]
fn domain_request_errors_do_not_restart_the_bridge() {
    assert!(!request_error_requires_disconnect(
        "history_session_not_found"
    ));
    assert!(!request_error_requires_disconnect("history_index_busy"));
    assert!(request_error_requires_disconnect(
        "ssh_agent_bridge_response_timeout"
    ));
}
