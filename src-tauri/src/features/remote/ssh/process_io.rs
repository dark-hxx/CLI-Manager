use super::{
    validate_spec, AgentProbeProcessOutput, SshAuthProbeOutput, SshConnectionSpec,
    MAX_AGENT_PROBE_REPORT_BYTES, MAX_AGENT_PROBE_STDERR_BYTES,
};
use crate::shell_resolver::{output_with_timeout, silent_command};
use std::process::Command;
use std::time::Duration;

// 取有损 UTF-8 输出中的首个非空去空白行。
pub(super) fn single_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

// 从 ssh -G 输出解析仅含键和值的 user 行。
pub(super) fn parse_effective_ssh_user(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes).lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let key = fields.next()?;
        if !key.eq_ignore_ascii_case("user") {
            return None;
        }
        fields
            .next()
            .map(str::trim)
            .filter(|value| {
                !value.is_empty() && !value.contains(['\0', '\r', '\n']) && fields.next().is_none()
            })
            .map(str::to_string)
    })
}

// 按连接配置构造只展开配置的 ssh -G 命令。
pub(super) fn effective_ssh_user_command(spec: &SshConnectionSpec) -> Result<Command, String> {
    validate_spec(spec)?;
    let mut command = silent_command("ssh");
    command.arg("-G");
    if !spec.config_file.trim().is_empty() {
        command.args(["-F", spec.config_file.trim()]);
    } else if spec.config_alias.trim().is_empty()
        && spec.jump_target.trim().is_empty()
        && matches!(
            spec.auth_mode.as_str(),
            "identity_file" | "password_prompt" | "credential_ref" | "interactive"
        )
    {
        command.args(["-F", "none"]);
    }
    if spec.config_alias.trim().is_empty() {
        command.args(["-p", &spec.port.to_string()]);
    }
    command.arg(spec.target());
    Ok(command)
}

// 优先取显式用户名，否则限时展开 SSH 配置解析用户。
pub(super) fn resolve_effective_ssh_user(spec: &SshConnectionSpec) -> Result<String, String> {
    if !spec.username.trim().is_empty() {
        return Ok(spec.username.trim().to_string());
    }
    let command = effective_ssh_user_command(spec)?;
    let output = output_with_timeout(command, Duration::from_secs(5))
        .map_err(|error| format!("ssh_user_resolve_failed:{error}"))?;
    if !output.status.success() {
        let detail = single_line(&output.stderr);
        return Err(if detail.is_empty() {
            "ssh_user_resolve_failed".to_string()
        } else {
            format!("ssh_user_resolve_failed:{detail}")
        });
    }
    parse_effective_ssh_user(&output.stdout).ok_or_else(|| "ssh_user_required".to_string())
}

// 从调试输出提取首条服务端主机密钥说明。
pub(super) fn host_key_fingerprint(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        line.split_once("Server host key:")
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

// 识别 OpenSSH 已认证日志标记。
pub(super) fn is_authenticated_log(line: &str) -> bool {
    line.contains("Authenticated to ")
}

// 读取认证日志并在成功标记、进程结束或超时时收集结果。
pub(super) fn run_ssh_auth_probe(
    mut command: Command,
    timeout: Duration,
) -> std::io::Result<SshAuthProbeOutput> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Instant;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stderr_pipe = child.stderr.take();
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let reader_lines = Arc::clone(&lines);
    let (authenticated_tx, authenticated_rx) = mpsc::channel();
    let (reader_done_tx, reader_done_rx) = mpsc::channel();
    let _reader = std::thread::spawn(move || {
        if let Some(pipe) = stderr_pipe {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                let authenticated = is_authenticated_log(&trimmed);
                if let Ok(mut output) = reader_lines.lock() {
                    if output.len() < 256 {
                        output.push(trimmed);
                    }
                }
                if authenticated {
                    let _ = authenticated_tx.send(());
                }
            }
        }
        let _ = reader_done_tx.send(());
    });
    let collect_log = || {
        lines
            .lock()
            .map(|output| output.join("\n"))
            .unwrap_or_default()
    };

    let deadline = Instant::now() + timeout;
    let wait_for_reader = || {
        let _ = reader_done_rx.recv_timeout(Duration::from_millis(100));
    };
    loop {
        if authenticated_rx.try_recv().is_ok() {
            let _ = child.kill();
            let _ = child.wait();
            wait_for_reader();
            return Ok(SshAuthProbeOutput {
                authenticated: true,
                timed_out: false,
                status_success: true,
                status_code: Some(0),
                stderr: collect_log(),
            });
        }
        if let Some(status) = child.try_wait()? {
            wait_for_reader();
            let stderr = collect_log();
            return Ok(SshAuthProbeOutput {
                authenticated: stderr.lines().any(is_authenticated_log),
                timed_out: false,
                status_success: status.success(),
                status_code: status.code(),
                stderr,
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            wait_for_reader();
            return Ok(SshAuthProbeOutput {
                authenticated: false,
                timed_out: true,
                status_success: false,
                status_code: None,
                stderr: collect_log(),
            });
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

// 保留限额内字节并持续排空超出部分，返回截断标志。
pub(super) fn read_bounded(mut reader: impl std::io::Read, limit: usize) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(limit.min(8 * 1024));
    let mut truncated = false;
    let mut buffer = [0u8; 8 * 1024];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let remaining = limit.saturating_sub(output.len());
        let retained = remaining.min(read);
        output.extend_from_slice(&buffer[..retained]);
        if retained < read {
            truncated = true;
        }
    }
    (output, truncated)
}

// 并行限量读取探测输出，轮询退出并在超时时终止子进程。
pub(super) fn run_agent_probe_process(
    mut command: Command,
    timeout: Duration,
) -> std::io::Result<AgentProbeProcessOutput> {
    use std::process::Stdio;
    use std::time::Instant;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        stdout
            .map(|pipe| read_bounded(pipe, MAX_AGENT_PROBE_REPORT_BYTES))
            .unwrap_or_default()
    });
    let stderr_reader = std::thread::spawn(move || {
        stderr
            .map(|pipe| read_bounded(pipe, MAX_AGENT_PROBE_STDERR_BYTES))
            .unwrap_or_default()
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "ssh_agent_probe_timeout",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let (stdout, stdout_truncated) = stdout_reader.join().unwrap_or_default();
    let (stderr, _) = stderr_reader.join().unwrap_or_default();
    Ok(AgentProbeProcessOutput {
        status_success: status.success(),
        status_code: status.code(),
        stdout,
        stderr,
        stdout_truncated,
    })
}

// 并行写入操作输入与限量读取输出，等待完成或超时终止。
pub(super) fn run_agent_input_process(
    mut command: Command,
    input: Vec<u8>,
    timeout: Duration,
) -> std::io::Result<AgentProbeProcessOutput> {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::Instant;

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let writer = std::thread::spawn(move || {
        let mut stdin = stdin.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "ssh_agent_upload_stdin_missing",
            )
        })?;
        stdin.write_all(&input)
    });
    let stdout_reader = std::thread::spawn(move || {
        stdout
            .map(|pipe| read_bounded(pipe, MAX_AGENT_PROBE_REPORT_BYTES))
            .unwrap_or_default()
    });
    let stderr_reader = std::thread::spawn(move || {
        stderr
            .map(|pipe| read_bounded(pipe, MAX_AGENT_PROBE_STDERR_BYTES))
            .unwrap_or_default()
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = writer.join();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "ssh_agent_operation_timeout",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    writer
        .join()
        .map_err(|_| std::io::Error::other("ssh_agent_upload_writer_panicked"))??;
    let (stdout, stdout_truncated) = stdout_reader.join().unwrap_or_default();
    let (stderr, _) = stderr_reader.join().unwrap_or_default();
    Ok(AgentProbeProcessOutput {
        status_success: status.success(),
        status_code: status.code(),
        stdout,
        stderr,
        stdout_truncated,
    })
}
