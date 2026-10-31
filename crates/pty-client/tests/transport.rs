use cli_manager_core::pty_frame::encode_binary_terminal_frame;
use cli_manager_pty_client::{Client, ConnectionOptions, Endpoint, Event};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

fn options() -> ConnectionOptions {
    ConnectionOptions {
        request_timeout: Duration::from_secs(2),
        ..Default::default()
    }
}

#[tokio::test]
async fn correlates_requests_and_sends_ack_only_after_explicit_commit() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let auth: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(auth["token"], "test-token");
        assert_eq!(
            auth["client_features"],
            json!([
                "ws_binary_output_v1",
                "ws_binary_input_v1",
                "ws_native_client_v1",
                "ws_ack_bytes_v1",
                "checkpoint_replay_v1",
                "session_status_push_v1"
            ])
        );
        socket.send(Message::Text(json!({"type":"auth_ok", "protocol_version":3, "binary_protocol_version":1, "features":["ws_binary_output_v1", "ws_native_client_v1", "ws_ack_bytes_v1"]}).to_string().into())).await.unwrap();
        let request: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(request["type"], "list");
        socket
            .send(Message::Binary(
                encode_binary_terminal_frame(1, "s", 5, 80, 24, "😀中".as_bytes())
                    .unwrap()
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({"type":"session_status","session_id":"s","status":"exited","exit_code":0})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({"type":"sessions", "id":request["id"], "sessions":[]})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let ack: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(ack["type"], "ack");
        assert_eq!(ack["sequence"], 5);
        assert_eq!(ack["char_count"], 0);
        assert_eq!(ack["byte_count"], 7);
        socket
            .send(Message::Text(
                json!({"type":"ok", "id":ack["id"]}).to_string().into(),
            ))
            .await
            .unwrap();
    });
    let (client, mut events) =
        Client::connect(Endpoint::new(port, "test-token".into()).unwrap(), options())
            .await
            .unwrap();
    assert_eq!(client.list().await.unwrap()["sessions"], json!([]));
    let output = match events.recv().await.unwrap() {
        Event::Output(output) => output,
        other => panic!("{other:?}"),
    };
    assert_eq!(output.data.as_ref(), "😀中".as_bytes());
    client.commit(&output).await.unwrap();
    match events.recv().await.unwrap() {
        Event::Control(value) => {
            assert_eq!(value["type"], "session_status");
            assert_eq!(value["session_id"], "s");
        }
        other => panic!("{other:?}"),
    }
    server.await.unwrap();
}

#[tokio::test]
async fn sends_ansi_checkpoint_as_binary_frame() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket.send(Message::Text(json!({
            "type":"auth_ok", "protocol_version":3, "binary_protocol_version":1,
            "features":["ws_binary_output_v1", "ws_binary_input_v1", "ws_native_client_v1", "checkpoint_replay_v1"]
        }).to_string().into())).await.unwrap();
        let frame = socket.next().await.unwrap().unwrap().into_data();
        let decoded = cli_manager_core::pty_frame::decode_binary_terminal_frame(&frame).unwrap();
        assert_eq!(
            decoded.kind,
            cli_manager_core::pty_frame::BINARY_KIND_CHECKPOINT
        );
        assert_eq!(decoded.session_id, "s");
        assert_eq!(decoded.sequence, 7);
        assert_eq!((decoded.cols, decoded.rows), (80, 24));
        assert_eq!(decoded.data, b"\x1b[2J\x1b[Hcheckpoint");
    });
    let (client, _events) =
        Client::connect(Endpoint::new(port, "token".into()).unwrap(), options())
            .await
            .unwrap();
    client
        .checkpoint("s", 7, 80, 24, b"\x1b[2J\x1b[Hcheckpoint")
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn sends_binary_input_without_utf8_reencoding() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server =
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            socket.next().await.unwrap().unwrap();
            socket.send(Message::Text(json!({
            "type":"auth_ok", "protocol_version":3, "binary_protocol_version":1,
            "features":["ws_binary_output_v1", "ws_binary_input_v1", "ws_native_client_v1"]
        }).to_string().into())).await.unwrap();
            let frame = socket.next().await.unwrap().unwrap().into_data();
            let decoded =
                cli_manager_core::pty_frame::decode_binary_terminal_frame(&frame).unwrap();
            assert_eq!(decoded.kind, cli_manager_core::pty_frame::BINARY_KIND_INPUT);
            assert_eq!(decoded.session_id, "s");
            assert_eq!(decoded.data, [0, 0xff, 0x1b]);
        });
    let (client, _events) =
        Client::connect(Endpoint::new(port, "token".into()).unwrap(), options())
            .await
            .unwrap();
    client.write_bytes("s", &[0, 0xff, 0x1b]).await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn create_or_probe_attaches_when_create_response_is_rejected_after_session_exists() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type":"auth_ok", "protocol_version":3, "binary_protocol_version":1,
                    "features":["ws_binary_output_v1", "ws_native_client_v1"]
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let create: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(create["type"], "create");
        socket
            .send(Message::Text(
                json!({
                    "type":"err", "id":create["id"], "code":"session_exists"
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let list: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(list["type"], "list");
        socket
            .send(Message::Text(
                json!({
                    "type":"sessions", "id":list["id"],
                    "sessions":[{"sessionId":"existing-session"}]
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let attach: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(attach["type"], "attach");
        assert_eq!(attach["session_id"], "existing-session");
        socket
            .send(Message::Text(
                json!({
                    "type":"attached", "id":attach["id"],
                    "meta":{"sessionId":"existing-session"}
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
    });

    let (client, _events) =
        Client::connect(Endpoint::new(port, "token".into()).unwrap(), options())
            .await
            .unwrap();
    let response = client
        .create_or_probe("existing-session", None, None)
        .await
        .unwrap();
    assert_eq!(response["type"], "attached");
    server.await.unwrap();
}

#[tokio::test]
async fn attach_or_create_prefers_an_existing_daemon_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type":"auth_ok", "protocol_version":3, "binary_protocol_version":1,
                    "features":["ws_binary_output_v1", "ws_native_client_v1"]
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let list: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(list["type"], "list");
        socket
            .send(Message::Text(
                json!({
                    "type":"sessions", "id":list["id"],
                    "sessions":[{"sessionId":"restored-session"}]
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let attach: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(attach["type"], "attach");
        assert_eq!(attach["session_id"], "restored-session");
        assert_eq!(attach["after_sequence"], 41);
        socket
            .send(Message::Text(
                json!({
                    "type":"attached", "id":attach["id"],
                    "meta":{"sessionId":"restored-session"}
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
    });

    let (client, _events) =
        Client::connect(Endpoint::new(port, "token".into()).unwrap(), options())
            .await
            .unwrap();
    let response = client
        .attach_or_create(
            "restored-session",
            Some(41),
            Some("C:/project"),
            Some("pwsh"),
        )
        .await
        .unwrap();
    assert_eq!(response["type"], "attached");
    server.await.unwrap();
}

#[tokio::test]
async fn create_or_probe_probes_after_create_response_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type":"auth_ok", "protocol_version":3, "binary_protocol_version":1,
                    "features":["ws_binary_output_v1", "ws_native_client_v1"]
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let create: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(create["type"], "create");
        tokio::time::sleep(Duration::from_millis(60)).await;

        let list: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type":"sessions", "id":list["id"],
                    "sessions":[{"sessionId":"timed-out-session"}]
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let attach: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type":"attached", "id":attach["id"],
                    "meta":{"sessionId":"timed-out-session"}
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
    });

    let mut connection_options = options();
    connection_options.request_timeout = Duration::from_millis(50);
    let (client, _events) = Client::connect(
        Endpoint::new(port, "token".into()).unwrap(),
        connection_options,
    )
    .await
    .unwrap();
    let response = client
        .create_or_probe("timed-out-session", None, None)
        .await
        .unwrap();
    assert_eq!(response["type"], "attached");
    server.await.unwrap();
}

#[tokio::test]
async fn rejects_authentication_without_echoing_server_or_token() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Text(
                json!({"type":"auth_err", "reason":"server-sensitive-detail"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
    });
    let error = Client::connect(
        Endpoint::new(port, "secret-token".into()).unwrap(),
        options(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error, "daemon authentication rejected");
    assert!(!error.contains("secret"));
    server.await.unwrap();
}

#[tokio::test]
async fn handshake_timeout_is_bounded() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _socket = accept_async(stream).await.unwrap();
        std::future::pending::<()>().await;
    });
    let mut options = options();
    options.request_timeout = Duration::from_millis(50);
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        Client::connect(Endpoint::new(port, "t".into()).unwrap(), options),
    )
    .await
    .unwrap();
    assert_eq!(result.err().unwrap(), "daemon handshake timeout");
    server.abort();
}

#[tokio::test]
async fn malformed_binary_disconnects_and_fails_pending_requests() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket.send(Message::Text(json!({"type":"auth_ok", "protocol_version":3, "binary_protocol_version":1, "features":["ws_binary_output_v1", "ws_native_client_v1"]}).to_string().into())).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Binary(vec![1, 1, 0].into()))
            .await
            .unwrap();
        let _ = socket.next().await;
    });
    let (client, mut events) = Client::connect(Endpoint::new(port, "t".into()).unwrap(), options())
        .await
        .unwrap();
    assert_eq!(client.list().await.unwrap_err(), "daemon disconnected");
    assert!(matches!(events.recv().await, Some(Event::Disconnected)));
    server.await.unwrap();
}

#[tokio::test]
async fn unanswered_heartbeat_terminates_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket.send(Message::Text(json!({"type":"auth_ok", "protocol_version":3, "binary_protocol_version":1, "features":["ws_binary_output_v1", "ws_native_client_v1"]}).to_string().into())).await.unwrap();
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
        }
    });
    let options = ConnectionOptions {
        heartbeat_interval: Duration::from_millis(10),
        heartbeat_timeout: Duration::from_millis(40),
        ..options()
    };
    let (_client, mut events) = Client::connect(Endpoint::new(port, "t".into()).unwrap(), options)
        .await
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap();
    assert!(matches!(event, Some(Event::Disconnected)));
    server.await.unwrap();
}

#[tokio::test]
async fn reconcile_submits_active_sessions_and_returns_diagnostic_summary() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type": "auth_ok",
                    "protocol_version": 3,
                    "binary_protocol_version": 1,
                    "features": ["session_status_push_v1", "ws_native_client_v1", "ws_binary_output_v1"]
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let request: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(request["type"], "reconcile");
        assert_eq!(request["active_session_ids"], json!(["visible-1"]));
        socket
            .send(Message::Text(
                json!({
                    "type": "reconciled",
                    "id": request["id"],
                    "summary": {
                        "active_count": 1,
                        "tracked_count": 2,
                        "marked_missing": 0,
                        "protected_count": 2,
                        "cleaned_count": 0,
                        "skipped_empty_active_list": false
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
    });
    let (client, _events) =
        Client::connect(Endpoint::new(port, "token".into()).unwrap(), options())
            .await
            .unwrap();
    let summary = client.reconcile(&["visible-1".to_owned()]).await.unwrap();
    assert_eq!(summary["cleaned_count"], 0);
    server.await.unwrap();
}
