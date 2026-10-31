#![cfg(windows)]

use cli_manager_web_server::{config::Config, run_with_shutdown_ready};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::windows::io::AsRawSocket;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};

// Keep this test in the desktop crate: its dependency lockfile can differ from
// the standalone server's and determines the installed application's sockets.
#[test]
fn web_listener_cannot_be_inherited_by_spawned_helpers() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut flags = 0;
        let result = unsafe { GetHandleInformation(listener.as_raw_socket() as _, &mut flags) };
        assert_ne!(result, 0, "{}", std::io::Error::last_os_error());
        assert_eq!(
            flags & HANDLE_FLAG_INHERIT,
            0,
            "Web listener must not leak into desktop helper processes"
        );
        let client = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (accepted, _) = listener.accept().await.unwrap();
        for socket in [client.as_raw_socket(), accepted.as_raw_socket()] {
            let result = unsafe { GetHandleInformation(socket as _, &mut flags) };
            assert_ne!(result, 0, "{}", std::io::Error::last_os_error());
            assert_eq!(
                flags & HANDLE_FLAG_INHERIT,
                0,
                "Web connections must not leak into helpers"
            );
        }
    });
}

struct Helper(Child);

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn health(bind: SocketAddr) {
    let mut socket = TcpStream::connect_timeout(&bind, Duration::from_secs(3)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        socket,
        "GET /api/health HTTP/1.1\r\nHost: {bind}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
}

#[test]
fn managed_runtime_releases_port_with_a_live_helper_ten_times() {
    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let bind = probe.local_addr().unwrap();
    drop(probe);
    let directory = tempfile::tempdir().unwrap();
    for iteration in 0..10 {
        let config = Config {
            bind,
            database_path: directory.path().join("server.db"),
            web_dist: directory.path().join("missing-dist"),
            admin_username: "admin".into(),
            admin_password: "test-password".into(),
            cookie_secure: false,
            allowed_origin: None,
        };
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let (ready, ready_rx) = std::sync::mpsc::sync_channel(1);
        let server = std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime
                .block_on(run_with_shutdown_ready(
                    config,
                    async move {
                        let _ = stopped.await;
                    },
                    Some(ready),
                ))
                .unwrap();
        });
        ready_rx
            .recv_timeout(Duration::from_secs(20))
            .unwrap()
            .unwrap();
        health(bind);
        let mut active = TcpStream::connect_timeout(&bind, Duration::from_secs(3)).unwrap();
        active
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(active, "GET /ws/device HTTP/1.1\r\nHost: {bind}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
        let mut response = Vec::new();
        while !response.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            active.read_exact(&mut byte).unwrap();
            response.push(byte[0]);
            assert!(response.len() < 8192);
        }
        assert!(response.starts_with(b"HTTP/1.1 101"));
        let mut partial_http = TcpStream::connect_timeout(&bind, Duration::from_secs(3)).unwrap();
        partial_http
            .write_all(b"GET /api/health HTTP/1.1\r\n")
            .unwrap();
        // Match the application's hidden helper launch with redirected stdio.
        // The helper remains alive while the managed runtime is shut down.
        let mut helper = Helper(
            Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ])
                .creation_flags(0x0800_0000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let mut active = Some(active);
        // Exercise both orders: disconnect the device before stopping, or
        // stop while the device WebSocket and unfinished HTTP request are live.
        if iteration % 2 == 0 {
            drop(active.take());
        }
        stop.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        while !server.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            server.is_finished(),
            "iteration {iteration}: managed runtime did not stop within 8 seconds"
        );
        server.join().unwrap();
        assert!(helper.0.try_wait().unwrap().is_none());
        let rebound = TcpListener::bind(bind);
        assert!(
            rebound.is_ok(),
            "iteration {iteration}: stopped server retained its port with a live helper: {:?}",
            rebound.err()
        );
        drop(rebound);
        drop(active);
        drop(partial_http);
        drop(helper);
    }
}
