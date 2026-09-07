use super::{
    now_millis, output_text, path_string, CcConnectLogBuffer, SharedLogWriter,
    CONFIG_FORMAT_TIMEOUT, MAX_CAPTURED_LOG_LINE_BYTES,
};
use crate::shell_resolver::{output_with_timeout, silent_command};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub(super) fn format_and_check_config_syntax(
    executable: &Path,
    config: &Path,
) -> Result<(), String> {
    let mut command = silent_command(&path_string(executable));
    command.args(["config", "format", "--config"]).arg(config);
    let output = output_with_timeout(command, CONFIG_FORMAT_TIMEOUT)
        .map_err(|err| format!("cc-connect config syntax check failed: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "cc-connect could not parse managed config: {}",
        output_text(&output.stdout, &output.stderr)
    ))
}

pub(super) fn spawn_log_reader<R: Read + Send + 'static>(
    reader: R,
    source: &'static str,
    logs: Arc<Mutex<CcConnectLogBuffer>>,
    writer: SharedLogWriter,
    secrets: Arc<Vec<String>>,
) {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0u8; 4 * 1024];
        let mut line = Vec::with_capacity(4 * 1024);
        let mut truncated = false;
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => {
                    push_captured_log_line(&logs, &writer, source, &line, truncated, &secrets);
                    break;
                }
                Ok(read) => {
                    for byte in &chunk[..read] {
                        if *byte == b'\n' {
                            push_captured_log_line(
                                &logs, &writer, source, &line, truncated, &secrets,
                            );
                            line.clear();
                            truncated = false;
                        } else if *byte != b'\r' {
                            if line.len() < MAX_CAPTURED_LOG_LINE_BYTES {
                                line.push(*byte);
                            } else {
                                truncated = true;
                            }
                        }
                    }
                }
                Err(err) => {
                    push_log_line(
                        &logs,
                        &writer,
                        "system",
                        &format!("cc-connect {source} reader failed: {err}"),
                        &[],
                    );
                    break;
                }
            }
        }
    });
}

pub(super) fn push_captured_log_line(
    logs: &Arc<Mutex<CcConnectLogBuffer>>,
    writer: &SharedLogWriter,
    source: &str,
    bytes: &[u8],
    truncated: bool,
    secrets: &[String],
) {
    if bytes.is_empty() && !truncated {
        return;
    }
    let mut line = String::from_utf8_lossy(bytes).to_string();
    if truncated {
        line.push_str("...[truncated]");
    }
    push_log_line(logs, writer, source, &line, secrets);
}

pub(super) fn push_log_line(
    logs: &Arc<Mutex<CcConnectLogBuffer>>,
    writer: &SharedLogWriter,
    source: &str,
    raw: &str,
    secrets: &[String],
) {
    let message = redact_log_line(raw, secrets);
    if let Ok(mut logs) = logs.lock() {
        logs.push(source, message.clone());
    }
    if let Ok(mut writer) = writer.lock() {
        if let Some(writer) = writer.as_mut() {
            let _ = writeln!(writer, "{} [{}] {}", now_millis(), source, message);
            let _ = writer.flush();
        }
    }
}

pub(crate) fn redact_log_line(raw: &str, secrets: &[String]) -> String {
    let mut value = raw.to_string();
    for secret in secrets.iter().filter(|secret| secret.len() >= 4) {
        value = value.replace(secret, "[REDACTED]");
    }
    let lower = value.to_ascii_lowercase();
    if [
        "token",
        "secret",
        "password",
        "api_key",
        "api key",
        "authorization",
        "bearer ",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword))
    {
        value = "[sensitive output redacted]".to_string();
    }
    const MAX_CHARS: usize = 4_000;
    if value.chars().count() > MAX_CHARS {
        value = value.chars().take(MAX_CHARS).collect::<String>() + "...";
    }
    value
}
