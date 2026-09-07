use super::client_transport::{
    websocket_attached_frames, ClientWireFrame, ClientWriterState, QueuedOutputFrame,
};
use super::pty_events::{emit_daemon_output, output_batch_would_overflow};
use super::*;
use std::io::Write;
use crate::daemon::protocol::{decode_daemon_frame, ROUTING_ERROR_PROTOCOL_UNSUPPORTED};
use crate::daemon::protocol::{
    encode_frame, ReplayEntry, BINARY_KIND_OUTPUT, BINARY_KIND_REPLAY, BINARY_KIND_REPLAY_RESET,
};
use tungstenite::client::IntoClientRequest;

#[test]
fn daemon_output_batch_stops_before_crossing_live_frame_budget() {
    assert!(!output_batch_would_overflow(0, 80 * 1024));
    assert!(!output_batch_would_overflow(32 * 1024, 32 * 1024));
    assert!(output_batch_would_overflow(40 * 1024, 40 * 1024));
}

fn test_session(session_id: &str, buffer: SessionBuffer, next_sequence: u64) -> SharedSession {
    Arc::new(Mutex::new(SessionEntry {
        meta: SessionMeta {
            session_id: session_id.to_string(),
            cwd: None,
            shell: None,
            environment_type: None,
            ssh_host_id: None,
            remote_path: None,
            alive: true,
            task_status: None,
            task_updated_at_ms: None,
            created_at_ms: 1,
            process_traits: Some(ProcessTraits::current_platform(false)),
            replay_available: buffer.replay_available(),
            replay_truncated: buffer.truncated,
        },
        buffer,
        cols: 80,
        rows: 24,
        next_sequence,
        ssh_hook_binding: None,
    }))
}

fn remote_hook_launch(source: &str) -> SshLaunchPlan {
    SshLaunchPlan {
        host_id: "host-1".to_string(),
        host: "example.com".to_string(),
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
        server_alive_interval_sec: 30,
        server_alive_count_max: 3,
        remote_path: "/srv/private-directory".to_string(),
        client_instance_id: "client-1".to_string(),
        project_id: "project-1".to_string(),
        project_name: "Sidebar Project".to_string(),
        bridge_epoch: "epoch-1".to_string(),
        agent_path: "~/.local/bin/cli-manager-ssh-agent".to_string(),
        agent_installation_id: "installation-1".to_string(),
        agent_remote_machine_id: "machine-1".to_string(),
        tool_source: source.to_string(),
        environment_overrides: HashMap::new(),
        initialization_command: None,
        startup_command: None,
    }
}

#[test]
fn remote_hook_binding_injects_sidebar_project_for_claude_and_codex() {
    for (index, source) in ["claude", "codex"].into_iter().enumerate() {
        let host = DaemonHost::new();
        let tab_id = format!("tab-{index}");
        let launch = remote_hook_launch(source);
        host.reserve_session_with_launch(&tab_id, None, None, Some(&launch))
            .unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        host.set_hook_sink(Arc::new(move |payload| {
            sender.send(payload.to_notification_job()).unwrap();
        }));

        host.accept_remote_hook_event(serde_json::json!({
            "kind": "hookEvent",
            "eventId": format!("event-{index}"),
            "sequence": index + 1,
            "tabId": tab_id,
            "hostId": launch.host_id,
            "clientInstanceId": launch.client_instance_id,
            "projectId": launch.project_id,
            "bridgeEpoch": launch.bridge_epoch,
            "installationId": launch.agent_installation_id,
            "source": source,
            "event": "Stop",
            "sessionId": format!("session-{index}"),
            "remoteCwd": launch.remote_path,
            "occurredAt": 1,
        }));

        let job = receiver.try_recv().unwrap();
        assert_eq!(job.source, source);
        assert_eq!(job.cwd, None);
        assert_eq!(job.project.as_deref(), Some("Sidebar Project"));
    }
}

#[test]
fn remote_codex_permission_request_bypasses_provisional_approval_in_daemon_host() {
    let host = DaemonHost::new();
    let launch = remote_hook_launch("codex");
    host.reserve_session_with_launch("tab-1", None, None, Some(&launch))
        .unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    host.set_hook_sink(approval_aware_hook_sink(Arc::new(move |payload| {
        sender.send(payload).unwrap();
    })));

    host.accept_remote_hook_event(serde_json::json!({
        "kind": "hookEvent",
        "eventId": "event-1",
        "sequence": 1,
        "tabId": "tab-1",
        "hostId": launch.host_id,
        "clientInstanceId": launch.client_instance_id,
        "projectId": launch.project_id,
        "bridgeEpoch": launch.bridge_epoch,
        "installationId": launch.agent_installation_id,
        "source": "codex",
        "event": "PermissionRequest",
        "sessionId": "session-1",
        "agentId": "child-1",
        "toolName": "apply_patch",
        "remoteCwd": launch.remote_path,
        "occurredAt": 1,
    }));

    let payload = receiver
        .try_recv()
        .expect("SSH approval must not be delayed");
    let payload = serde_json::to_value(payload).unwrap();
    assert_eq!(payload["event"], "PermissionRequest");
    assert_eq!(payload["environmentType"], "ssh");
}

#[test]
fn websocket_writer_sends_binary_terminal_output() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let socket = tungstenite::accept(stream).unwrap();
        let writer_stream = socket.get_ref().try_clone().unwrap();
        let writer = ClientWriter::new(ClientTransport::WebSocket(Mutex::new(
            WebSocket::from_raw_socket(writer_stream, Role::Server, None),
        )));
        writer
            .send_frame(&DaemonFrame::Output {
                session_id: "session-1".to_string(),
                sequence: 3,
                cols: 120,
                rows: 30,
                data_base64: STANDARD.encode(b"hello"),
            })
            .unwrap();
        drop(socket);
    });

    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let (mut client, _) = tungstenite::client("ws://127.0.0.1/pty", stream).unwrap();
    let message = client.read().unwrap();
    let Message::Binary(binary) = message else {
        panic!("expected binary output frame");
    };
    assert_eq!(binary[0], super::super::protocol::BINARY_PROTOCOL_VERSION);
    assert_eq!(binary[1], BINARY_KIND_OUTPUT);
    assert_eq!(&binary[binary.len() - 5..], b"hello");
    server.join().unwrap();
}

#[test]
fn ndjson_redacts_unknown_frame_types() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = Arc::new(DaemonServer {
        host: Arc::new(DaemonHost::new()),
        next_client_id: AtomicU64::new(1),
        token: "token".to_string(),
        version: "test".to_string(),
        info_path: PathBuf::new(),
    });
    let server_thread = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        server.handle_connection(stream);
    });

    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    writer
        .write_all(
            encode_frame(&ClientFrame::Auth {
                token: "token".to_string(),
                client_version: "test".to_string(),
            })
            .as_bytes(),
        )
        .unwrap();
    assert!(matches!(
        decode_daemon_frame(&read_line_bounded(&mut reader).unwrap()).unwrap(),
        DaemonFrame::AuthOk { .. }
    ));

    writer
        .write_all(b"{\"type\":\"token=must-not-be-returned\",\"id\":8}\n")
        .unwrap();
    let DaemonFrame::Err { message, .. } =
        decode_daemon_frame(&read_line_bounded(&mut reader).unwrap()).unwrap()
    else {
        panic!("expected generic daemon error");
    };
    assert_eq!(message, "unknown frame type");
    assert!(!message.contains("must-not-be-returned"));

    drop(writer);
    drop(reader);
    server_thread.join().unwrap();
}

#[test]
fn websocket_rejects_routing_control_and_redacts_unknown_frame_types() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = Arc::new(DaemonServer {
        host: Arc::new(DaemonHost::new()),
        next_client_id: AtomicU64::new(1),
        token: "token".to_string(),
        version: "test".to_string(),
        info_path: PathBuf::new(),
    });
    let server_thread = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        server.handle_websocket_connection(stream);
    });

    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut request = format!("ws://{address}/pty").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", "http://localhost:1420".parse().unwrap());
    let (mut client, _) = tungstenite::client(request, stream).unwrap();
    client
        .send(Message::Text(
            encode_frame(&ClientFrame::Auth {
                token: "token".to_string(),
                client_version: "test".to_string(),
            })
            .trim_end()
            .to_string()
            .into(),
        ))
        .unwrap();
    assert!(matches!(
        client.read().unwrap(),
        Message::Text(text)
            if matches!(decode_daemon_frame(text.as_ref()).unwrap(), DaemonFrame::AuthOk { .. })
    ));

    client
        .send(Message::Text(
            encode_frame(&ClientFrame::RoutingStart {
                id: 7,
                listen_address: None,
                preferred_port: None,
                last_actual_port: None,
                listener_addresses: Vec::new(),
            })
            .trim_end()
            .to_string()
            .into(),
        ))
        .unwrap();
    let Message::Text(text) = client.read().unwrap() else {
        panic!("expected routing rejection");
    };
    let DaemonFrame::RoutingEvent { event } = decode_daemon_frame(text.as_ref()).unwrap() else {
        panic!("expected routing event");
    };
    assert_eq!(event.request_id, Some(7));
    let error = event.error.unwrap();
    assert_eq!(error.code, ROUTING_ERROR_PROTOCOL_UNSUPPORTED);
    assert_eq!(
        error.params.get("transport").map(String::as_str),
        Some("websocket")
    );

    client
        .send(Message::Text(
            r#"{"type":"token=must-not-be-returned","id":8}"#.to_string().into(),
        ))
        .unwrap();
    let Message::Text(text) = client.read().unwrap() else {
        panic!("expected unknown-frame error");
    };
    let DaemonFrame::Err { message, .. } = decode_daemon_frame(text.as_ref()).unwrap() else {
        panic!("expected generic daemon error");
    };
    assert_eq!(message, "unknown frame type");
    assert!(!message.contains("must-not-be-returned"));

    drop(client);
    server_thread.join().unwrap();
}

#[test]
fn routing_reset_circuit_before_runtime_returns_closed_status() {
    let server = DaemonServer {
        host: Arc::new(DaemonHost::new()),
        next_client_id: AtomicU64::new(1),
        token: String::new(),
        version: String::new(),
        info_path: PathBuf::new(),
    };
    let reply = server.handle_frame(
        0,
        ClientFrame::RoutingResetCircuit {
            id: 9,
            app_type: "codex".to_string(),
            provider_id: "token=must-not-be-returned".to_string(),
        },
    );
    let encoded = encode_frame(&reply);
    let DaemonFrame::RoutingEvent { event } = reply else {
        panic!("expected routing event");
    };
    assert_eq!(event.request_id, Some(9));
    assert_eq!(event.error, None);
    assert_eq!(event.status.unwrap().status, "stopped");
    assert!(!encoded.contains("must-not-be-returned"));
}

#[test]
fn routing_start_binds_and_stop_keeps_actual_port() {
    let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let preferred_port = probe.local_addr().unwrap().port();
    drop(probe);
    let server = DaemonServer {
        host: Arc::new(DaemonHost::new()),
        next_client_id: AtomicU64::new(1),
        token: String::new(),
        version: String::new(),
        info_path: PathBuf::new(),
    };

    let start = server.handle_frame(
        0,
        ClientFrame::RoutingStart {
            id: 10,
            listen_address: Some("127.0.0.1".to_string()),
            preferred_port: Some(preferred_port),
            last_actual_port: None,
            listener_addresses: Vec::new(),
        },
    );
    let DaemonFrame::RoutingEvent { event } = start else {
        panic!("expected routing status");
    };
    let status = event.status.expect("running status");
    assert_eq!(status.status, "running");
    assert_eq!(status.actual_port, Some(preferred_port));

    let stop = server.handle_frame(0, ClientFrame::RoutingStop { id: 11 });
    let DaemonFrame::RoutingEvent { event } = stop else {
        panic!("expected routing status");
    };
    let status = event.status.expect("stopped status");
    assert_eq!(status.status, "stopped");
    assert_eq!(status.actual_port, Some(preferred_port));
}

#[test]
fn shutdown_retains_daemon_while_routing_runtime_is_active() {
    let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let preferred_port = probe.local_addr().unwrap().port();
    drop(probe);
    let server = DaemonServer {
        host: Arc::new(DaemonHost::new()),
        next_client_id: AtomicU64::new(1),
        token: String::new(),
        version: String::new(),
        info_path: PathBuf::new(),
    };

    let start = server.handle_frame(
        0,
        ClientFrame::RoutingStart {
            id: 20,
            listen_address: Some("127.0.0.1".to_string()),
            preferred_port: Some(preferred_port),
            last_actual_port: None,
            listener_addresses: Vec::new(),
        },
    );
    assert!(matches!(start, DaemonFrame::RoutingEvent { .. }));

    let shutdown = server.handle_frame(0, ClientFrame::Shutdown { id: 21 });
    assert!(matches!(shutdown, DaemonFrame::Ok { id: 21 }));
    assert!(server.host.routing_is_running());

    let stop = server.handle_frame(0, ClientFrame::RoutingStop { id: 22 });
    assert!(matches!(stop, DaemonFrame::RoutingEvent { .. }));
}

#[test]
fn routing_reload_rejects_wildcard_while_stopped() {
    let server = DaemonServer {
        host: Arc::new(DaemonHost::new()),
        next_client_id: AtomicU64::new(1),
        token: String::new(),
        version: String::new(),
        info_path: PathBuf::new(),
    };
    let reply = server.handle_frame(
        0,
        ClientFrame::RoutingReload {
            id: 12,
            listen_address: Some("0.0.0.0".to_string()),
            preferred_port: Some(FALLBACK_PORT_START),
            last_actual_port: None,
            listener_addresses: Vec::new(),
        },
    );
    let DaemonFrame::RoutingEvent { event } = reply else {
        panic!("expected routing error");
    };
    assert_eq!(
        event.error.expect("routing error").code,
        "routing_listen_address_invalid"
    );
}

#[test]
fn websocket_replay_allows_control_frames_to_preempt_between_entries() {
    let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
    let meta = test_session(session_id, SessionBuffer::new(), 1)
        .lock()
        .unwrap()
        .meta
        .clone();
    let attached = DaemonFrame::Attached {
        id: 11,
        session_id: session_id.to_string(),
        replay_base64: String::new(),
        replay: vec![
            ReplayEntry {
                sequence: 1,
                cols: 80,
                rows: 24,
                data_base64: STANDARD.encode(b"first"),
            },
            ReplayEntry {
                sequence: 2,
                cols: 80,
                rows: 24,
                data_base64: STANDARD.encode(b"second"),
            },
        ],
        latest_sequence: 2,
        meta,
        replay_reset: true,
        replay_truncated: false,
        oldest_sequence: 1,
    };
    let replay_frames = websocket_attached_frames(&attached).unwrap();
    let mut state = ClientWriterState {
        control: VecDeque::new(),
        output: replay_frames
            .into_iter()
            .map(|frame| QueuedOutputFrame {
                frame,
                live_output_bytes: 0,
            })
            .collect(),
        output_bytes: 0,
        closed: false,
    };

    assert!(matches!(
        state.pop_next(),
        Some(ClientWireFrame::BinaryTerminal {
            kind: BINARY_KIND_REPLAY_RESET,
            ..
        })
    ));
    state
        .control
        .push_back(ClientWireFrame::Daemon(DaemonFrame::Ok { id: 12 }));
    assert!(matches!(
        state.pop_next(),
        Some(ClientWireFrame::Daemon(DaemonFrame::Ok { id: 12 }))
    ));
    assert!(matches!(
        state.pop_next(),
        Some(ClientWireFrame::BinaryTerminal {
            kind: BINARY_KIND_REPLAY,
            sequence: 1,
            ..
        })
    ));
    assert!(matches!(
        state.pop_next(),
        Some(ClientWireFrame::BinaryTerminal {
            kind: BINARY_KIND_REPLAY,
            sequence: 2,
            ..
        })
    ));
    assert!(matches!(
        state.pop_next(),
        Some(ClientWireFrame::Daemon(DaemonFrame::Attached {
            id: 11,
            replay,
            ..
        })) if replay.is_empty()
    ));
}

#[test]
fn attach_returns_replay_and_registers_client() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
    let address = listener.local_addr().expect("read test listener address");
    let peer = TcpStream::connect(address).expect("connect test client");
    let (server_stream, _) = listener.accept().expect("accept test client");
    let host = Arc::new(DaemonHost::new());
    let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
    let client_id = 7;
    let mut buffer = SessionBuffer::new();
    buffer.push_output(80, 24, 1, b"replay-before-attach");
    host.sessions
        .lock()
        .expect("lock sessions")
        .insert(session_id.to_string(), test_session(session_id, buffer, 2));
    host.clients.lock().expect("lock clients").insert(
        client_id,
        ClientHandle {
            writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
            attached: HashSet::new(),
            unacknowledged_chars: HashMap::new(),
            flow_control_paused: HashSet::new(),
            last_sent_sequence: HashMap::new(),
            last_acknowledged_sequence: HashMap::new(),
            attaching: HashMap::new(),
        },
    );
    let server = DaemonServer {
        host: Arc::clone(&host),
        next_client_id: AtomicU64::new(8),
        token: String::new(),
        version: String::new(),
        info_path: PathBuf::new(),
    };

    let reply = server.handle_frame(
        client_id,
        ClientFrame::Attach {
            id: 11,
            session_id: session_id.to_string(),
            after_sequence: None,
        },
    );

    match reply {
        DaemonFrame::Attached { replay, .. } => {
            assert_eq!(replay.len(), 1);
            assert_eq!(
                STANDARD.decode(&replay[0].data_base64).unwrap(),
                b"replay-before-attach"
            );
        }
        other => panic!("unexpected attach reply: {other:?}"),
    }
    assert!(host
        .clients
        .lock()
        .expect("lock clients")
        .get(&client_id)
        .expect("client exists")
        .attached
        .contains(session_id));
    drop(peer);
}

#[test]
fn attach_barrier_sends_replay_control_before_buffered_live_output() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let peer = TcpStream::connect(address).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let (server_stream, _) = listener.accept().unwrap();
    let host = Arc::new(DaemonHost::new());
    let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
    let client_id = 9;
    let mut buffer = SessionBuffer::new();
    buffer.push_output(80, 24, 1, b"replay");
    host.sessions
        .lock()
        .unwrap()
        .insert(session_id.to_string(), test_session(session_id, buffer, 2));
    let writer = ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream)));
    host.clients.lock().unwrap().insert(
        client_id,
        ClientHandle {
            writer: Arc::clone(&writer),
            attached: HashSet::new(),
            unacknowledged_chars: HashMap::new(),
            flow_control_paused: HashSet::new(),
            last_sent_sequence: HashMap::new(),
            last_acknowledged_sequence: HashMap::new(),
            attaching: HashMap::new(),
        },
    );
    let server = DaemonServer {
        host: Arc::clone(&host),
        next_client_id: AtomicU64::new(10),
        token: String::new(),
        version: String::new(),
        info_path: PathBuf::new(),
    };

    let attached = server.handle_frame(
        client_id,
        ClientFrame::Attach {
            id: 12,
            session_id: session_id.to_string(),
            after_sequence: None,
        },
    );
    let live = DaemonFrame::Output {
        session_id: session_id.to_string(),
        sequence: 2,
        cols: 80,
        rows: 24,
        data_base64: STANDARD.encode(b"live"),
    };
    host.push_output_to_attached(session_id, 2, 4, &live);
    writer.send_frame(&attached).unwrap();
    host.complete_attach(client_id, session_id);

    let mut reader = BufReader::new(peer);
    let first = read_line_bounded(&mut reader).unwrap();
    let second = read_line_bounded(&mut reader).unwrap();
    assert!(matches!(
        super::super::protocol::decode_daemon_frame(&first).unwrap(),
        DaemonFrame::Attached { .. }
    ));
    assert!(matches!(
        super::super::protocol::decode_daemon_frame(&second).unwrap(),
        DaemonFrame::Output { sequence: 2, .. }
    ));
}

#[test]
fn detach_session_clears_flow_control_state() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let peer = TcpStream::connect(address).unwrap();
    let (server_stream, _) = listener.accept().unwrap();
    let host = DaemonHost::new();
    let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
    host.clients.lock().unwrap().insert(
        1,
        ClientHandle {
            writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
            attached: HashSet::from([session_id.to_string()]),
            unacknowledged_chars: HashMap::from([(session_id.to_string(), 10)]),
            flow_control_paused: HashSet::from([session_id.to_string()]),
            last_sent_sequence: HashMap::from([(session_id.to_string(), 2)]),
            last_acknowledged_sequence: HashMap::from([(session_id.to_string(), 1)]),
            attaching: HashMap::new(),
        },
    );

    host.detach_session_from_clients(session_id);

    let clients = host.clients.lock().unwrap();
    let client = clients.get(&1).unwrap();
    assert!(!client.attached.contains(session_id));
    assert!(!client.unacknowledged_chars.contains_key(session_id));
    assert!(!client.flow_control_paused.contains(session_id));
    assert!(!client.last_sent_sequence.contains_key(session_id));
    assert!(!client.last_acknowledged_sequence.contains_key(session_id));
    drop(peer);
}

#[test]
fn output_flow_control_buffers_slow_client_and_flushes_after_ack() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let peer = TcpStream::connect(address).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let (server_stream, _) = listener.accept().unwrap();
    let host = Arc::new(DaemonHost::new());
    let session_id = "flow-control";
    let mut buffer = SessionBuffer::new();
    buffer.push_output(80, 24, 1, b"already-sent");
    host.sessions
        .lock()
        .unwrap()
        .insert(session_id.to_string(), test_session(session_id, buffer, 2));
    host.clients.lock().unwrap().insert(
        1,
        ClientHandle {
            writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
            attached: HashSet::from([session_id.to_string()]),
            unacknowledged_chars: HashMap::from([(
                session_id.to_string(),
                CLIENT_OUTPUT_HIGH_WATERMARK,
            )]),
            flow_control_paused: HashSet::from([session_id.to_string()]),
            last_sent_sequence: HashMap::from([(session_id.to_string(), 1)]),
            last_acknowledged_sequence: HashMap::from([(session_id.to_string(), 0)]),
            attaching: HashMap::new(),
        },
    );
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let output_host = Arc::clone(&host);
    let output_session = session_id.to_string();
    std::thread::spawn(move || {
        emit_daemon_output(&output_host, &output_session, b"buffered");
        done_tx.send(()).unwrap();
    });
    done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let session = host.get_session(session_id).unwrap();
    let entry = session.lock().unwrap();
    let replay = entry.buffer.replay_entries();
    assert_eq!(replay.len(), 2);
    assert_eq!(replay[1].sequence, 2);
    assert_eq!(
        STANDARD.decode(&replay[1].data_base64).unwrap(),
        b"buffered"
    );
    drop(entry);

    host.acknowledge_output(
        1,
        session_id,
        1,
        CLIENT_OUTPUT_HIGH_WATERMARK - CLIENT_OUTPUT_LOW_WATERMARK,
    );

    let mut reader = BufReader::new(peer);
    let line = read_line_bounded(&mut reader).expect("flushed output frame");
    match decode_daemon_frame(&line).unwrap() {
        DaemonFrame::Output {
            sequence,
            data_base64,
            ..
        } => {
            assert_eq!(sequence, 2);
            assert_eq!(STANDARD.decode(data_base64).unwrap(), b"buffered");
        }
        other => panic!("unexpected frame: {other:?}"),
    }
    let client = host.clients.lock().unwrap();
    let client = client.get(&1).unwrap();
    assert_eq!(client.last_sent_sequence.get(session_id).copied(), Some(2));
    assert_eq!(
        client.unacknowledged_chars.get(session_id).copied(),
        Some(CLIENT_OUTPUT_LOW_WATERMARK + "buffered".len())
    );
}

#[test]
fn output_flow_control_pauses_only_the_slow_client() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let slow_peer = TcpStream::connect(address).unwrap();
    let fast_peer = TcpStream::connect(address).unwrap();
    fast_peer
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let (slow_stream, _) = listener.accept().unwrap();
    let (fast_stream, _) = listener.accept().unwrap();
    let host = Arc::new(DaemonHost::new());
    let session_id = "flow-control-isolated";
    host.sessions.lock().unwrap().insert(
        session_id.to_string(),
        test_session(session_id, SessionBuffer::new(), 1),
    );
    host.clients.lock().unwrap().insert(
        1,
        ClientHandle {
            writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(slow_stream))),
            attached: HashSet::from([session_id.to_string()]),
            unacknowledged_chars: HashMap::from([(
                session_id.to_string(),
                CLIENT_OUTPUT_HIGH_WATERMARK,
            )]),
            flow_control_paused: HashSet::from([session_id.to_string()]),
            last_sent_sequence: HashMap::from([(session_id.to_string(), 0)]),
            last_acknowledged_sequence: HashMap::from([(session_id.to_string(), 0)]),
            attaching: HashMap::new(),
        },
    );
    host.clients.lock().unwrap().insert(
        2,
        ClientHandle {
            writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(fast_stream))),
            attached: HashSet::from([session_id.to_string()]),
            unacknowledged_chars: HashMap::from([(session_id.to_string(), 0)]),
            flow_control_paused: HashSet::new(),
            last_sent_sequence: HashMap::from([(session_id.to_string(), 0)]),
            last_acknowledged_sequence: HashMap::from([(session_id.to_string(), 0)]),
            attaching: HashMap::new(),
        },
    );

    emit_daemon_output(&host, session_id, b"fast-client");

    let mut reader = BufReader::new(fast_peer);
    let line = read_line_bounded(&mut reader).expect("fast client output frame");
    match decode_daemon_frame(&line).unwrap() {
        DaemonFrame::Output {
            sequence,
            data_base64,
            ..
        } => {
            assert_eq!(sequence, 1);
            assert_eq!(STANDARD.decode(data_base64).unwrap(), b"fast-client");
        }
        other => panic!("unexpected frame: {other:?}"),
    }
    let clients = host.clients.lock().unwrap();
    let slow_client = clients.get(&1).unwrap();
    assert_eq!(
        slow_client.last_sent_sequence.get(session_id).copied(),
        Some(0)
    );
    let fast_client = clients.get(&2).unwrap();
    assert_eq!(
        fast_client.last_sent_sequence.get(session_id).copied(),
        Some(1)
    );
    drop(slow_peer);
}

#[test]
fn output_flow_control_closes_client_when_replay_window_has_gap() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let peer = TcpStream::connect(address).unwrap();
    let (server_stream, _) = listener.accept().unwrap();
    let host = DaemonHost::new();
    let session_id = "flow-control-gap";
    let mut buffer = SessionBuffer::new();
    buffer.push_output(80, 24, 5, b"retained-suffix");
    host.sessions
        .lock()
        .unwrap()
        .insert(session_id.to_string(), test_session(session_id, buffer, 6));
    host.clients.lock().unwrap().insert(
        1,
        ClientHandle {
            writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
            attached: HashSet::from([session_id.to_string()]),
            unacknowledged_chars: HashMap::from([(
                session_id.to_string(),
                CLIENT_OUTPUT_HIGH_WATERMARK,
            )]),
            flow_control_paused: HashSet::from([session_id.to_string()]),
            last_sent_sequence: HashMap::from([(session_id.to_string(), 1)]),
            last_acknowledged_sequence: HashMap::from([(session_id.to_string(), 0)]),
            attaching: HashMap::new(),
        },
    );

    host.acknowledge_output(
        1,
        session_id,
        1,
        CLIENT_OUTPUT_HIGH_WATERMARK - CLIENT_OUTPUT_LOW_WATERMARK,
    );

    let clients = host.clients.lock().unwrap();
    let client = clients.get(&1).unwrap();
    assert!(!client.attached.contains(session_id));
    assert!(!client.flow_control_paused.contains(session_id));
    assert!(!client.last_sent_sequence.contains_key(session_id));
    assert!(client.writer.shared.0.lock().unwrap().closed);
    drop(peer);
}

#[test]
fn session_buffer_spills_whole_frames_without_losing_replay() {
    let temp = tempfile::tempdir().unwrap();
    let mut buffer = SessionBuffer::with_spool(Some(temp.path().join("session.bin")));
    let frame = vec![b'x'; 1024 * 1024]; // 1 MiB/帧
    buffer.push_output(80, 24, 1, &frame);
    buffer.push_output(80, 24, 2, &frame);
    buffer.push_output(80, 24, 3, &frame); // 超 2 MiB，最旧帧落磁盘
    assert!(buffer.total_bytes <= SESSION_BUFFER_MAX_BYTES);
    assert_eq!(buffer.frames.len(), 2);
    let replay = buffer.replay_entries();
    assert_eq!(replay.len(), 3);
    assert_eq!(
        replay
            .iter()
            .map(|entry| STANDARD.decode(&entry.data_base64).unwrap().len())
            .sum::<usize>(),
        frame.len() * 3
    );
}

#[test]
fn session_buffer_does_not_send_checkpoint_as_live_output() {
    let mut buffer = SessionBuffer::new();
    buffer.push_output(80, 24, 1, b"before-checkpoint");
    buffer.push_output(80, 24, 2, b"after-checkpoint");
    buffer
        .accept_checkpoint(80, 24, 1, b"serialized-xterm-snapshot".to_vec())
        .unwrap();

    let replay = buffer.replay_entries();
    assert_eq!(replay.len(), 2);
    assert_eq!(replay[0].sequence, 1);
    assert_eq!(
        STANDARD.decode(&replay[0].data_base64).unwrap(),
        b"serialized-xterm-snapshot"
    );

    let live_frames = buffer.live_frames();
    let live_output = SessionBuffer::output_frames_after(&live_frames, 0);
    assert_eq!(live_output.len(), 1);
    assert_eq!(live_output[0].sequence, 2);
    assert_eq!(live_output[0].data, b"after-checkpoint");
}

#[test]
fn session_buffer_preserves_resize_boundaries() {
    let mut buffer = SessionBuffer::new();
    buffer.push_output(80, 24, 1, b"first");
    buffer.push_resize(120, 30, 2);
    buffer.push_resize(140, 40, 3);
    buffer.push_output(140, 40, 4, b"second");

    let replay = buffer.replay_entries();
    assert_eq!(replay.len(), 3);
    assert_eq!((replay[1].cols, replay[1].rows), (140, 40));
    assert!(replay[1].data_base64.is_empty());
    assert_eq!(replay[1].sequence, 3);
    assert_eq!(replay[2].sequence, 4);
}

#[test]
fn reconcile_never_closes_daemon_background_sessions() {
    let host = Arc::new(DaemonHost::new());
    let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
    host.sessions.lock().unwrap().insert(
        session_id.to_string(),
        test_session(session_id, SessionBuffer::new(), 1),
    );
    let server = DaemonServer {
        host: Arc::clone(&host),
        next_client_id: AtomicU64::new(1),
        token: String::new(),
        version: String::new(),
        info_path: PathBuf::new(),
    };

    let reply = server.handle_frame(
        0,
        ClientFrame::Reconcile {
            id: 13,
            active_session_ids: Vec::new(),
        },
    );

    let DaemonFrame::Reconciled { summary, .. } = reply else {
        panic!("expected reconcile response");
    };
    assert_eq!(summary["cleaned_count"], 0);
    assert!(host.sessions.lock().unwrap().contains_key(session_id));
}

#[test]
fn session_reservation_is_atomic_for_duplicate_ids() {
    let host = Arc::new(DaemonHost::new());
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
    let first_host = Arc::clone(&host);
    let first_barrier = Arc::clone(&barrier);
    let first = std::thread::spawn(move || {
        first_barrier.wait();
        first_host.reserve_session(session_id, None, None)
    });
    let second_host = Arc::clone(&host);
    let second_barrier = Arc::clone(&barrier);
    let second = std::thread::spawn(move || {
        second_barrier.wait();
        second_host.reserve_session(session_id, None, None)
    });

    let results = [first.join().unwrap(), second.join().unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    assert_eq!(host.sessions.lock().unwrap().len(), 1);
}

#[test]
fn session_id_validation() {
    assert!(is_valid_session_id("0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff"));
    assert!(!is_valid_session_id(""));
    assert!(!is_valid_session_id("../etc/passwd"));
    assert!(!is_valid_session_id(&"x".repeat(65)));
}

#[test]
fn hook_events_map_to_task_status() {
    assert_eq!(
        map_hook_event_to_task_status("UserPromptSubmit"),
        Some("running")
    );
    assert_eq!(
        map_hook_event_to_task_status("PermissionRequest"),
        Some("attention")
    );
    assert_eq!(map_hook_event_to_task_status("Stop"), Some("done"));
    assert_eq!(map_hook_event_to_task_status("StopFailure"), Some("failed"));
    assert_eq!(map_hook_event_to_task_status("SessionStart"), None);
}
