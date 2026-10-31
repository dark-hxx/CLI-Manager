use super::*;
use crate::daemon::protocol::{decode_daemon_frame, encode_frame};
use std::io::Write;
use std::sync::mpsc;

// 人为持有 A 的锁，必须在释放前完成治理，且 B 的表引用始终可读取；不创建真实 PTY。
#[test]
fn busy_session_does_not_pin_global_session_table_during_buffer_cleanup() {
    let host = Arc::new(DaemonHost::new());
    host.reserve_session("slow", None, None).unwrap();
    host.reserve_session("healthy", None, None).unwrap();
    let session = host.get_session("slow").unwrap();
    let held = session.lock().unwrap();
    let (sent, done) = mpsc::channel();
    let worker_host = Arc::clone(&host);
    let worker = std::thread::spawn(move || {
        worker_host.enforce_total_buffer_cap();
        sent.send(()).unwrap();
    });
    let finished_while_busy = done.recv_timeout(Duration::from_millis(500)).is_ok();
    let table_available = host.sessions.try_lock().is_ok();
    drop(held);
    worker.join().unwrap();
    assert!(
        finished_while_busy,
        "buffer cleanup waited on an unrelated busy entry"
    );
    assert!(
        table_available,
        "busy entry pinned the global session table"
    );
}

// 同连接的 A attach 阻塞时，Ping 与 B attach 必须仍有进展；释放后保留 A 的正常应答。
#[test]
fn blocked_attach_allows_ping_and_healthy_attach_on_same_connection() {
    let server = Arc::new(DaemonServer {
        host: Arc::new(DaemonHost::new()),
        next_client_id: AtomicU64::new(1),
        token: "token".into(),
        version: "test".into(),
        info_path: PathBuf::new(),
    });
    server.host.reserve_session("slow", None, None).unwrap();
    server.host.reserve_session("healthy", None, None).unwrap();
    let session = server.host.get_session("slow").unwrap();
    let held = session.lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let (accepted, _) = listener.accept().unwrap();
    let worker = std::thread::spawn(move || server.handle_connection(accepted));
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    writer
        .write_all(
            encode_frame(&ClientFrame::Auth {
                token: "token".into(),
                client_version: "test".into(),
            })
            .as_bytes(),
        )
        .unwrap();
    assert!(matches!(
        read_reply(&mut reader),
        Some(DaemonFrame::AuthOk { .. })
    ));
    for frame in [
        ClientFrame::Attach {
            id: 1,
            session_id: "slow".into(),
            after_sequence: None,
        },
        ClientFrame::Ping { id: 2 },
        ClientFrame::Attach {
            id: 3,
            session_id: "healthy".into(),
            after_sequence: None,
        },
    ] {
        writer.write_all(encode_frame(&frame).as_bytes()).unwrap();
    }
    let first = read_reply(&mut reader);
    let second = read_reply(&mut reader);
    drop(held);
    let third = read_reply(&mut reader);
    drop(reader);
    drop(writer);
    worker.join().unwrap();
    assert!(matches!(first, Some(DaemonFrame::Pong { id: 2 })));
    assert!(matches!(second, Some(DaemonFrame::Attached { id: 3, .. })));
    assert!(matches!(third, Some(DaemonFrame::Attached { id: 1, .. })));
}

// 超时转换为 None，确保断言前先释放实验锁并回收连接线程。
fn read_reply(reader: &mut BufReader<TcpStream>) -> Option<DaemonFrame> {
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    decode_daemon_frame(&line).ok()
}

// 无法锁住一个会话时列表必须明确失败，不能把部分列表冒充全部会话。
#[test]
fn busy_session_inventory_is_an_error_instead_of_a_partial_list() {
    let host = DaemonHost::new();
    host.reserve_session("slow", None, None).unwrap();
    let session = host.get_session("slow").unwrap();
    let held = session.lock().unwrap();
    assert!(host.session_metadata().is_err());
    drop(held);
    assert_eq!(host.session_metadata().unwrap().len(), 1);
}

// writer 的底层 socket 已失败时必须传播关闭状态，避免持续吞入永远无法送达的响应。
#[test]
fn failed_writer_marks_closed_and_rejects_future_replies() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (stream, _) = listener.accept().unwrap();
    stream.shutdown(std::net::Shutdown::Both).unwrap();
    let writer = ClientWriter::new(ClientTransport::Ndjson(Mutex::new(stream)));
    let _ = writer.send_frame(&DaemonFrame::Pong { id: 1 });
    let deadline = Instant::now() + Duration::from_secs(1);
    while !writer.is_closed() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(writer.is_closed());
    assert!(writer.send_frame(&DaemonFrame::Pong { id: 2 }).is_err());
    drop(peer);
}
