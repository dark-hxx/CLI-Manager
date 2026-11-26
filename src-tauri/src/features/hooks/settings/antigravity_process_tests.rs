//! 手动选择刚编译的产品 bin（不是 agy）。只执行配置生成器产出的隐藏子命令，绝不启动 GUI。
use super::*;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

const ID: &str = "ec33ebf9-0cba-4100-8142-c61503f6c587";
const TAB: &str = "39c6b972-c888-42c0-a739-cbabc32969ac";

// 在真正的 loopback 上捕获一次调用，只在本测试内保留合成认证令牌与白名单 JSON。
fn receive(listener: TcpListener) -> Result<Value, &'static str> {
    let end = Instant::now() + Duration::from_secs(8);
    listener.set_nonblocking(true).unwrap();
    let mut stream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < end => {
                thread::sleep(Duration::from_millis(5))
            }
            _ => return Err("no connection"),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let n = stream.read(&mut buf).map_err(|_| "socket read")?;
        if n == 0 || bytes.len() > 16384 {
            return Err("early EOF/oversize");
        }
        bytes.extend_from_slice(&buf[..n]);
        let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
            continue;
        };
        let header = std::str::from_utf8(&bytes[..end]).map_err(|_| "invalid header")?;
        assert!(header
            .lines()
            .any(|line| line == "Authorization: Bearer fixture-only"));
        assert!(header.starts_with("POST /api/claude-hook "));
        let size = header
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .ok_or("no length")?
            .parse::<usize>()
            .map_err(|_| "invalid length")?;
        if bytes.len() < end + 4 + size {
            continue;
        }
        let v =
            serde_json::from_slice(&bytes[end + 4..end + 4 + size]).map_err(|_| "invalid body")?;
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
            .map_err(|_| "response write")?;
        return Ok(v);
    }
}

#[test]
#[ignore = "requires an explicitly supplied fresh CLI-Manager product binary"]
fn antigravity_product_bin_preserves_native_stdout_exit_and_only_observes_managed_input() {
    let exe =
        std::env::var_os("CLI_MANAGER_AGY_TEST_BINARY").expect("set CLI_MANAGER_AGY_TEST_BINARY");
    let exe = Path::new(&exe);
    assert!(exe.is_absolute() && exe.is_file());
    let temp = tempfile::tempdir().unwrap();
    let helper = temp.path().join(if cfg!(windows) {
        "O'Brien ’ 空 格 & Hook.exe"
    } else {
        "O'Brien ’ 空 格 & Hook"
    });
    fs::copy(exe, &helper).unwrap();
    // 全角空格在 UTF-8 输入中是空错误；若被转码成问号，Stop 会错误地变成 StopFailure。
    let normal = json!({
        "conversationId": ID, "fullyIdle": true, "terminationReason": "NO_TOOL_CALL",
        "error": "\u{3000}", "lastUserInput": "合成私密提示", "toolCall": {"args":"private"}
    })
    .to_string()
    .into_bytes();
    let canceled = json!({
        "conversationId": ID, "fullyIdle": true, "terminationReason": "USER_CANCELED",
        "error": "", "transcriptPath": "", "hookEventName": ""
    })
    .to_string()
    .into_bytes();
    let corrupt = b"{bad".to_vec();
    let huge = json!({"conversationId":ID,"lastUserInput":"x".repeat(2 * 1024 * 1024)})
        .to_string()
        .into_bytes();
    let background =
        json!({"conversationId":ID,"fullyIdle":false,"terminationReason":"NO_TOOL_CALL"})
            .to_string()
            .into_bytes();
    for (event, mode, input, expected_event) in [
        ("SessionStart", "online", &normal, Some("SessionStart")),
        ("PreInvocation", "online", &normal, Some("PreInvocation")),
        ("Stop", "online", &normal, Some("Stop")),
        ("Stop", "canceled", &canceled, Some("Interrupt")),
        ("Stop", "disabled", &normal, None),
        ("Stop", "missing", &normal, None),
        ("Stop", "offline", &normal, None),
        ("Stop", "bad", &corrupt, None),
        ("PreInvocation", "large", &huge, None),
        ("Stop", "background", &background, None),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut worker = None;
        let mut unused = None;
        if expected_event.is_some() {
            worker = Some(thread::spawn(move || receive(listener)));
        } else if mode == "offline" {
            drop(listener);
        } else {
            listener.set_nonblocking(true).unwrap();
            unused = Some(listener);
        }
        let text = hook_command(helper.to_str().unwrap(), event, cfg!(windows)).unwrap();
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = Command::new("cmd.exe");
            cmd.args(["/d", "/c", &text]);
            cmd
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", &text]);
            cmd
        };
        cmd.current_dir(temp.path())
            .env("HOME", temp.path())
            .env("USERPROFILE", temp.path())
            .env_remove("WSL_DISTRO_NAME")
            .env_remove("CLI_MANAGER_SSH_ASKPASS")
            .env("CLI_MANAGER_TAB_ID", TAB)
            .env("CLI_MANAGER_NOTIFY_TOKEN", "fixture-only")
            .env("CLI_MANAGER_NOTIFY_PORT", port.to_string())
            .env(
                "CLI_MANAGER_AGY_HOOK_ENABLED",
                if mode == "disabled" { "0" } else { "1" },
            );
        if mode == "missing" {
            cmd.env_remove("CLI_MANAGER_TAB_ID");
        }
        // 旧版本 PowerShell 包装器可能提早关闭超限/禁用的 stdin；BrokenPipe 并非 Hook 输出错误。
        use std::process::Stdio;
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut pipe = child.stdin.take().unwrap();
        let data = input.clone();
        let writer = thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
        let deadline = Instant::now() + Duration::from_secs(8);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("helper timeout: {mode}");
            }
            thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        writer.join().unwrap();
        assert!(output.status.success(), "{event}:{mode}");
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            if event == "Stop" {
                json!({"decision":"stop"})
            } else {
                json!({})
            }
        );
        if let Some(worker) = worker {
            let mut v = worker
                .join()
                .unwrap()
                .unwrap_or_else(|cause| panic!("{event}:{mode}: {cause}"));
            let at = v.as_object_mut().unwrap().remove("timestamp").unwrap();
            assert!(chrono::DateTime::parse_from_rfc3339(at.as_str().unwrap()).is_ok());
            assert_eq!(
                v,
                json!({"event":expected_event.unwrap(),"source":"antigravity","sessionId":ID,"tabId":TAB,"wslDistroName":null})
            );
        }
        if let Some(unused) = unused {
            assert_eq!(
                unused.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }
    assert!(!temp.path().join(".cli-manager").exists());
    assert!(!temp.path().join(".gemini").exists());
}
