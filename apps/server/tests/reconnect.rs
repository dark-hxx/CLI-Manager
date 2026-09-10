use cli_manager_web_server::{auth, config::Config, run_with_shutdown_ready, storage::Storage};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

fn test_config() -> Config {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    Config {
        bind: listener.local_addr().unwrap(),
        database_path: std::env::temp_dir()
            .join(format!("web-reconnect-{}.db", uuid::Uuid::new_v4())),
        web_dist: "missing-dist".into(),
        admin_username: "admin".into(),
        admin_password: "test-password".into(),
        cookie_secure: false,
        trusted_network: false,
        allowed_origin: None,
    }
}

async fn start(
    config: Config,
) -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<Result<(), String>>,
) {
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let (ready, ready_rx) = std::sync::mpsc::sync_channel(1);
    let server = tokio::spawn(run_with_shutdown_ready(
        config,
        async move {
            let _ = stopped.await;
        },
        Some(ready),
    ));
    tokio::task::spawn_blocking(move || {
        ready_rx
            .recv_timeout(Duration::from_secs(20))
            .unwrap()
            .unwrap()
    })
    .await
    .unwrap();
    (stop, server)
}

fn upgrade(bind: SocketAddr, path: &str, cookie: &str) -> TcpStream {
    let mut stream = TcpStream::connect_timeout(&bind, Duration::from_secs(3)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {bind}\r\nOrigin: http://{bind}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: {cookie}\r\n\r\n").unwrap();
    let mut response = Vec::new();
    while !response.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        response.push(byte[0]);
        assert!(response.len() < 8192);
    }
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 101"));
    stream
}

fn read_json_frame(stream: &mut TcpStream) -> serde_json::Value {
    let mut header = [0; 2];
    stream.read_exact(&mut header).unwrap();
    assert_eq!(header[0] & 0x0f, 1, "expected text frame");
    assert_eq!(header[1] & 0x80, 0, "server must not mask frames");
    let len = match header[1] & 0x7f {
        126 => {
            let mut bytes = [0; 2];
            stream.read_exact(&mut bytes).unwrap();
            u16::from_be_bytes(bytes) as usize
        }
        127 => {
            let mut bytes = [0; 8];
            stream.read_exact(&mut bytes).unwrap();
            u64::from_be_bytes(bytes) as usize
        }
        n => n as usize,
    };
    assert!(len < 1024 * 1024);
    let mut body = vec![0; len];
    stream.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn write_json_frame(stream: &mut TcpStream, value: &serde_json::Value) {
    let json = value.to_string();
    let mut frame = vec![0x81];
    match json.len() {
        0..=125 => frame.push(0x80 | json.len() as u8),
        126..=65535 => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(json.len() as u16).to_be_bytes());
        }
        _ => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(json.len() as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(&[0; 4]);
    frame.extend_from_slice(json.as_bytes());
    stream.write_all(&frame).unwrap();
}

fn read_until_type(stream: &mut TcpStream, expected: &str) -> serde_json::Value {
    for _ in 0..20 {
        let frame = read_json_frame(stream);
        if frame["type"] == expected {
            return frame;
        }
    }
    panic!("did not receive {expected}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_terminal_output_preserves_device_socket_and_browser_stream() {
    let config = test_config();
    let storage = Storage::open(&config.database_path).await.unwrap();
    storage.ensure_single_user("admin", "unused").await.unwrap();
    let user = storage
        .find_user_by_username("admin")
        .await
        .unwrap()
        .unwrap();
    storage
        .create_browser_session(&auth::hash_secret("output-test"), &user.id, i64::MAX)
        .await
        .unwrap();
    storage
        .upsert_device_hello(
            "device-output",
            "test",
            "windows",
            "test",
            &[],
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    sqlx::query(
        "UPDATE devices SET user_id = ?1, device_token_hash = ?2 WHERE id = 'device-output'",
    )
    .bind(&user.id)
    .bind(auth::hash_secret("device-token"))
    .execute(storage.pool())
    .await
    .unwrap();
    let (stop, server) = start(config.clone()).await;
    let bind = config.bind;
    tokio::task::spawn_blocking(move || {
        let mut device = upgrade(bind, "/ws/device", "");
        write_json_frame(&mut device, &serde_json::json!({"type":"hello","protocolVersion":cli_manager_web_protocol::DEVICE_PROTOCOL_VERSION,"deviceId":"device-output","deviceToken":"device-token","name":"test","platform":"windows","appVersion":"test","capabilities":[]}));
        assert_eq!(read_json_frame(&mut device)["paired"], true);
        let mut browser = upgrade(bind, "/ws/browser?afterSequence=0", "cli_manager_session=output-test");
        assert_eq!(read_json_frame(&mut browser)["type"], "ready");
        let mut output = serde_json::json!({"type":"terminal_output","sessionId":"terminal-test","sequence":1,"frames":[{"sequence":1,"cols":120,"rows":32,"data":"A".repeat(512 * 1024 + 4),"kind":"output","replayBatchEnd":true}]});
        write_json_frame(&mut device, &output);
        let rejected = read_until_type(&mut device, "error");
        assert_eq!(rejected["code"], "invalid_terminal_output");
        assert!(rejected["message"].as_str().unwrap().starts_with("encoded_batch_too_large:"));
        let status = read_until_type(&mut browser, "terminal_status");
        assert_eq!(status["sessionId"], "terminal-test");
        assert_eq!(status["status"], "error");

        // No reconnect or second hello: the rejected batch is scoped to this output.
        write_json_frame(&mut device, &serde_json::json!({"type":"heartbeat","sequence":41}));
        assert_eq!(read_until_type(&mut device, "ack")["sequence"], 41);
        output["sequence"] = 2.into();
        output["frames"][0]["sequence"] = 2.into();
        output["frames"][0]["data"] = "aGVsbG8=".into();
        write_json_frame(&mut device, &output);
        let recovered = read_until_type(&mut browser, "terminal_output");
        assert_eq!(recovered["deviceId"], "device-output");
        assert_eq!(recovered["sequence"], 2);
        assert_eq!(recovered["frames"][0]["data"], "aGVsbG8=");
    }).await.unwrap();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(4), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    storage.pool().close().await;
}

fn assert_socket_closed(mut socket: TcpStream) {
    let mut bytes = [0; 4096];
    for _ in 0..16 {
        match socket.read(&mut bytes) {
            Ok(0) => return,
            Ok(_) => continue, // Drain a heartbeat already queued before shutdown.
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                        | std::io::ErrorKind::UnexpectedEof
                ) =>
            {
                return
            }
            other => panic!("upgraded socket survived server shutdown: {other:?}"),
        }
    }
    panic!("socket continued sending after shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paired_device_reconnects_with_same_credentials_after_server_restart() {
    let config = test_config();
    let storage = Storage::open(&config.database_path).await.unwrap();
    storage.ensure_single_user("admin", "unused").await.unwrap();
    let user = storage
        .find_user_by_username("admin")
        .await
        .unwrap()
        .unwrap();
    storage
        .upsert_device_hello(
            "device-test",
            "test",
            "windows",
            "test",
            &[],
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET user_id = ?1, device_token_hash = ?2 WHERE id = 'device-test'")
        .bind(&user.id)
        .bind(auth::hash_secret("device-token"))
        .execute(storage.pool())
        .await
        .unwrap();
    for _ in 0..3 {
        let (stop, server) = start(config.clone()).await;
        let bind = config.bind;
        let socket = tokio::task::spawn_blocking(move || {
            let mut socket = upgrade(bind, "/ws/device", "");
            let hello = serde_json::json!({"type":"hello","protocolVersion":cli_manager_web_protocol::DEVICE_PROTOCOL_VERSION,"deviceId":"device-test","deviceToken":"device-token","name":"test","platform":"windows","appVersion":"test","capabilities":[]}).to_string();
            let mut frame = vec![0x81, 0x80 | 126];
            frame.extend_from_slice(&(hello.len() as u16).to_be_bytes());
            frame.extend_from_slice(&[0; 4]);
            frame.extend_from_slice(hello.as_bytes());
            socket.write_all(&frame).unwrap();
            let response = read_json_frame(&mut socket);
            assert_eq!(response["type"], "hello_ok");
            assert_eq!(response["paired"], true);
            socket
        }).await.unwrap();
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(4), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        tokio::task::spawn_blocking(move || assert_socket_closed(socket))
            .await
            .unwrap();
    }
    storage.pool().close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upgraded_device_connections_close_and_same_port_restarts_repeatedly() {
    let config = test_config();
    for _ in 0..3 {
        let (stop, server) = start(config.clone()).await;
        let bind = config.bind;
        // Complete the upgrade but deliberately never send hello. Shutdown must
        // cancel the independent upgrade task, including its first-frame wait.
        let mut socket = tokio::task::spawn_blocking(move || upgrade(bind, "/ws/device", ""))
            .await
            .unwrap();
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(4), server)
            .await
            .expect("server must stop promptly")
            .unwrap()
            .unwrap();
        tokio::task::spawn_blocking(move || {
            let mut byte = [0];
            match socket.read(&mut byte) {
                Ok(0) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::UnexpectedEof
                    ) => {}
                other => panic!("upgraded socket survived server shutdown: {other:?}"),
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_from_zero_skips_ten_thousand_stale_history_notifications_but_keeps_conversation() {
    let config = test_config();
    let storage = Storage::open(&config.database_path).await.unwrap();
    storage.ensure_single_user("admin", "unused").await.unwrap();
    let user = storage
        .find_user_by_username("admin")
        .await
        .unwrap()
        .unwrap();
    storage
        .create_browser_session(&auth::hash_secret("replay-test"), &user.id, i64::MAX)
        .await
        .unwrap();
    let history =
        serde_json::json!({"type":"history.updated","deviceId":"device-test","latestUpdatedAt":1});
    sqlx::query("WITH RECURSIVE count(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM count WHERE n < 10000) INSERT INTO browser_events(user_id, occurred_at, payload_json) SELECT ?1, 1, ?2 FROM count")
        .bind(&user.id).bind(history.to_string()).execute(storage.pool()).await.unwrap();
    let conversation = serde_json::json!({"type":"conversation.updated","deviceId":"device-test","event":{"operationId":"operation-test","sessionId":"session-test","source":"codex","projectId":"project-test","worktreeId":null,"messageId":null,"sequence":1,"kind":"text","text":"preserve this reply","occurredAt":1}});
    storage
        .append_browser_event(
            &user.id,
            serde_json::from_value(conversation.clone()).unwrap(),
        )
        .await
        .unwrap();
    storage
        .append_browser_event(&user.id, serde_json::from_value(history).unwrap())
        .await
        .unwrap();
    let (stop, server) = start(config.clone()).await;
    let bind = config.bind;
    let socket = tokio::task::spawn_blocking(move || {
        let mut socket = upgrade(
            bind,
            "/ws/browser?afterSequence=0",
            "cli_manager_session=replay-test",
        );
        let ready = read_json_frame(&mut socket);
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["latestSequence"], 10002);
        let retained = read_json_frame(&mut socket);
        assert_eq!(retained["payload"], conversation);
        let last = read_json_frame(&mut socket);
        assert_eq!(last["sequence"], 10002);
        assert_eq!(last["payload"]["type"], "history.updated");
        socket
    })
    .await
    .unwrap();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(4), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::task::spawn_blocking(move || assert_socket_closed(socket))
        .await
        .unwrap();
    storage.pool().close().await;
}
