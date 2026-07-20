use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(unix)]
use std::fs;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::path::{Path, PathBuf};

use crate::hook_runtime::{ack_spool, read_spool_batch, spool_namespace};
use crate::installer::read_installation_record;
use crate::layout::resolve_layout;
use crate::{PROTOCOL_MAJOR, PROTOCOL_MINOR};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_PREAMBLE_BANNER_BYTES: usize = 8 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientFrame {
    pub request_id: String,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFrame {
    pub request_id: String,
    pub kind: String,
    pub payload: Value,
}

struct HookBridgeBinding {
    namespace: String,
    remote_machine_id: String,
    #[cfg(unix)]
    socket: std::os::unix::net::UnixDatagram,
    #[cfg(unix)]
    socket_path: PathBuf,
    #[cfg(unix)]
    pid_path: PathBuf,
}

#[cfg(unix)]
impl Drop for HookBridgeBinding {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
        let _ = fs::remove_file(&self.pid_path);
    }
}

fn valid_binding_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains(['\0', '\r', '\n', '/', '\\'])
}

#[cfg(unix)]
fn process_alive(pid_path: &Path) -> bool {
    let Some(pid) = fs::read_to_string(pid_path)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
    else {
        return false;
    };
    Path::new("/proc").is_dir() && Path::new("/proc").join(pid.to_string()).exists()
}

fn bind_hook_bridge(payload: &Value) -> Result<HookBridgeBinding, String> {
    let client_instance_id = payload
        .get("clientInstanceId")
        .and_then(Value::as_str)
        .filter(|value| valid_binding_value(value))
        .ok_or_else(|| "bridge_client_instance_invalid".to_string())?;
    let host_id = payload
        .get("hostId")
        .and_then(Value::as_str)
        .filter(|value| valid_binding_value(value))
        .ok_or_else(|| "bridge_host_id_invalid".to_string())?;
    let installation_id = payload
        .get("installationId")
        .and_then(Value::as_str)
        .ok_or_else(|| "bridge_installation_id_invalid".to_string())?;
    uuid::Uuid::parse_str(installation_id)
        .map_err(|_| "bridge_installation_id_invalid".to_string())?;
    let layout = resolve_layout().map_err(str::to_string)?;
    let installed = read_installation_record(&layout)?
        .ok_or_else(|| "agent_installation_record_missing".to_string())?;
    if installed.installation_id != installation_id {
        return Err("bridge_installation_id_mismatch".to_string());
    }
    let namespace = spool_namespace(host_id, client_instance_id, installation_id);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixDatagram;
        fs::create_dir_all(&layout.runtime_dir)
            .map_err(|_| "bridge_runtime_dir_failed".to_string())?;
        fs::set_permissions(&layout.runtime_dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "bridge_runtime_permissions_failed".to_string())?;
        let socket_path = layout.runtime_dir.join(format!("hook-{namespace}.sock"));
        let pid_path = layout.runtime_dir.join(format!("hook-{namespace}.pid"));
        if socket_path.exists() || pid_path.exists() {
            if process_alive(&pid_path) {
                return Err("bridge_already_active".to_string());
            }
            let _ = fs::remove_file(&socket_path);
            let _ = fs::remove_file(&pid_path);
        }
        let socket = UnixDatagram::bind(&socket_path)
            .map_err(|_| "bridge_hook_socket_bind_failed".to_string())?;
        socket
            .set_nonblocking(true)
            .map_err(|_| "bridge_hook_socket_nonblocking_failed".to_string())?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "bridge_hook_socket_permissions_failed".to_string())?;
        fs::write(&pid_path, std::process::id().to_string())
            .map_err(|_| "bridge_hook_pid_write_failed".to_string())?;
        fs::set_permissions(&pid_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "bridge_hook_pid_permissions_failed".to_string())?;
        return Ok(HookBridgeBinding {
            namespace,
            remote_machine_id: installed.remote_machine_id,
            socket,
            socket_path,
            pid_path,
        });
    }
    #[cfg(not(unix))]
    Ok(HookBridgeBinding {
        namespace,
        remote_machine_id: installed.remote_machine_id,
    })
}

fn drain_hook_notifications(binding: &HookBridgeBinding) {
    #[cfg(unix)]
    loop {
        let mut buffer = [0u8; 32];
        match binding.socket.recv(&mut buffer) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(_) => break,
        }
    }
    #[cfg(not(unix))]
    let _ = binding;
}

fn wait_for_hook_notification(binding: &HookBridgeBinding, wait: std::time::Duration) {
    #[cfg(unix)]
    {
        let _ = binding.socket.set_nonblocking(false);
        let _ = binding.socket.set_read_timeout(Some(wait));
        let mut buffer = [0u8; 32];
        let _ = binding.socket.recv(&mut buffer);
        let _ = binding.socket.set_read_timeout(None);
        let _ = binding.socket.set_nonblocking(true);
        drain_hook_notifications(binding);
    }
    #[cfg(not(unix))]
    {
        let _ = binding;
        std::thread::sleep(wait);
    }
}

pub fn write_preamble(writer: &mut impl Write, nonce: &str) -> io::Result<()> {
    writeln!(writer, "CLI_MANAGER_SSH_AGENT/{PROTOCOL_MAJOR} {nonce}")?;
    writer.flush()
}

pub fn read_frame(reader: &mut impl Read) -> Result<Option<ClientFrame>, String> {
    let mut length = [0u8; 4];
    match reader.read(&mut length[..1]) {
        Ok(0) => return Ok(None),
        Ok(1) => {}
        Ok(_) => unreachable!("single-byte read returned more than one byte"),
        Err(error) => return Err(format!("frame_length_read_failed:{error}")),
    }
    reader
        .read_exact(&mut length[1..])
        .map_err(|error| format!("frame_length_read_failed:{error}"))?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("frame_size_invalid".to_string());
    }
    let mut payload = vec![0u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("frame_payload_read_failed:{error}"))?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| format!("frame_json_invalid:{error}"))
}

pub fn write_frame(writer: &mut impl Write, frame: &ServerFrame) -> Result<(), String> {
    let payload =
        serde_json::to_vec(frame).map_err(|error| format!("frame_json_encode_failed:{error}"))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err("frame_size_invalid".to_string());
    }
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(&payload))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("frame_write_failed:{error}"))
}

fn response(request_id: String, kind: &str, payload: Value) -> ServerFrame {
    ServerFrame {
        request_id,
        kind: kind.to_string(),
        payload,
    }
}

pub fn handle_frame(frame: ClientFrame) -> (ServerFrame, bool) {
    let ClientFrame {
        request_id,
        kind,
        payload,
    } = frame;
    match kind.as_str() {
        "hello" => (
            response(
                request_id,
                "helloOk",
                json!({
                    "protocolMajor": PROTOCOL_MAJOR,
                    "protocolMinor": PROTOCOL_MINOR,
                    "capabilities": ["bridgeProtocol", "hookSpool"],
                }),
            ),
            false,
        ),
        "ping" => (response(request_id, "pong", payload), false),
        "shutdown" => (
            response(request_id, "response", json!({ "accepted": true })),
            true,
        ),
        _ => (
            response(
                request_id,
                "error",
                json!({ "code": "unsupported_message", "messageKind": kind }),
            ),
            false,
        ),
    }
}

pub fn run_bridge(
    reader: &mut impl Read,
    writer: &mut impl Write,
    nonce: &str,
) -> Result<(), String> {
    write_preamble(writer, nonce).map_err(|error| format!("preamble_write_failed:{error}"))?;
    let mut hook_binding = None;
    while let Some(frame) = read_frame(reader)? {
        let request_id = frame.request_id.clone();
        let (response, shutdown) = match frame.kind.as_str() {
            "hello" if hook_binding.is_some() => (
                response(
                    request_id,
                    "error",
                    json!({ "code": "bridge_already_initialized" }),
                ),
                false,
            ),
            "hello" => match bind_hook_bridge(&frame.payload) {
                Ok(binding) => {
                    let namespace = binding.namespace.clone();
                    let remote_machine_id = binding.remote_machine_id.clone();
                    hook_binding = Some(binding);
                    (
                        response(
                            request_id,
                            "helloOk",
                            json!({
                                "protocolMajor": PROTOCOL_MAJOR,
                                "protocolMinor": PROTOCOL_MINOR,
                                "capabilities": ["bridgeProtocol", "hookSpool"],
                                "hookNamespace": namespace,
                                "remoteMachineId": remote_machine_id,
                            }),
                        ),
                        false,
                    )
                }
                Err(code) => (
                    response(request_id, "error", json!({ "code": code })),
                    false,
                ),
            },
            "hookDrain" => {
                let Some(binding) = hook_binding.as_ref() else {
                    let response = response(
                        request_id,
                        "error",
                        json!({ "code": "bridge_not_initialized" }),
                    );
                    write_frame(writer, &response)?;
                    continue;
                };
                drain_hook_notifications(binding);
                let after_sequence = frame
                    .payload
                    .get("afterSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let limit = frame
                    .payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(128) as usize;
                let layout = resolve_layout().map_err(str::to_string)?;
                let wait_ms = frame
                    .payload
                    .get("waitMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
                    .min(5_000);
                let mut batch =
                    read_spool_batch(&layout.state_dir, &binding.namespace, after_sequence, limit);
                if batch.as_ref().is_ok_and(|events| events.is_empty()) && wait_ms > 0 {
                    wait_for_hook_notification(binding, std::time::Duration::from_millis(wait_ms));
                    batch = read_spool_batch(
                        &layout.state_dir,
                        &binding.namespace,
                        after_sequence,
                        limit,
                    );
                }
                match batch {
                    Ok(events) => {
                        let latest_sequence = events
                            .iter()
                            .filter_map(|event| event.get("sequence").and_then(Value::as_u64))
                            .max()
                            .unwrap_or(after_sequence);
                        (
                            response(
                                request_id,
                                "hookBatch",
                                json!({
                                    "events": events,
                                    "latestSequence": latest_sequence,
                                }),
                            ),
                            false,
                        )
                    }
                    Err(code) => (
                        response(request_id, "error", json!({ "code": code })),
                        false,
                    ),
                }
            }
            "hookAck" => {
                let Some(binding) = hook_binding.as_ref() else {
                    let response = response(
                        request_id,
                        "error",
                        json!({ "code": "bridge_not_initialized" }),
                    );
                    write_frame(writer, &response)?;
                    continue;
                };
                let Some(through_sequence) =
                    frame.payload.get("throughSequence").and_then(Value::as_u64)
                else {
                    let response = response(
                        request_id,
                        "error",
                        json!({ "code": "hook_ack_sequence_invalid" }),
                    );
                    write_frame(writer, &response)?;
                    continue;
                };
                let layout = resolve_layout().map_err(str::to_string)?;
                match ack_spool(&layout.state_dir, &binding.namespace, through_sequence) {
                    Ok(()) => (
                        response(
                            request_id,
                            "response",
                            json!({ "accepted": true, "throughSequence": through_sequence }),
                        ),
                        false,
                    ),
                    Err(code) => (
                        response(request_id, "error", json!({ "code": code })),
                        false,
                    ),
                }
            }
            _ => handle_frame(frame),
        };
        write_frame(writer, &response)?;
        if shutdown {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{handle_frame, read_frame, run_bridge, write_frame, ClientFrame, ServerFrame};
    use serde_json::json;
    use std::io::Cursor;

    fn encoded_client_frame(frame: &ClientFrame) -> Vec<u8> {
        let payload = serde_json::to_vec(frame).unwrap();
        let mut bytes = Vec::with_capacity(payload.len() + 4);
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }

    impl serde::Serialize for ClientFrame {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            use serde::ser::SerializeStruct;
            let mut state = serializer.serialize_struct("ClientFrame", 3)?;
            state.serialize_field("requestId", &self.request_id)?;
            state.serialize_field("kind", &self.kind)?;
            state.serialize_field("payload", &self.payload)?;
            state.end()
        }
    }

    #[test]
    fn ping_round_trips_payload() {
        let (frame, shutdown) = handle_frame(ClientFrame {
            request_id: "request-1".into(),
            kind: "ping".into(),
            payload: json!({ "sentAt": 42 }),
        });
        assert!(!shutdown);
        assert_eq!(frame.kind, "pong");
        assert_eq!(frame.payload["sentAt"], 42);
    }

    #[test]
    fn bridge_writes_preamble_and_shutdown_response() {
        let input = encoded_client_frame(&ClientFrame {
            request_id: "request-2".into(),
            kind: "shutdown".into(),
            payload: json!({}),
        });
        let mut reader = Cursor::new(input);
        let mut output = Vec::new();
        run_bridge(&mut reader, &mut output, "nonce-1").unwrap();
        let preamble_end = output.iter().position(|byte| *byte == b'\n').unwrap() + 1;
        assert_eq!(
            &output[..preamble_end],
            b"CLI_MANAGER_SSH_AGENT/1 nonce-1\n"
        );
        let mut frame_reader = Cursor::new(&output[preamble_end..]);
        let mut length = [0u8; 4];
        std::io::Read::read_exact(&mut frame_reader, &mut length).unwrap();
        let mut payload = vec![0; u32::from_be_bytes(length) as usize];
        std::io::Read::read_exact(&mut frame_reader, &mut payload).unwrap();
        let response: ServerFrame = serde_json::from_slice(&payload).unwrap();
        assert_eq!(response.kind, "response");
        assert_eq!(response.payload["accepted"], true);
    }

    #[test]
    fn oversized_frame_is_rejected() {
        let mut input = Cursor::new(((super::MAX_FRAME_BYTES as u32) + 1).to_be_bytes().to_vec());
        assert_eq!(read_frame(&mut input).unwrap_err(), "frame_size_invalid");
    }

    #[test]
    fn clean_eof_and_truncated_length_are_distinct() {
        assert!(read_frame(&mut Cursor::new(Vec::<u8>::new()))
            .unwrap()
            .is_none());
        let error = read_frame(&mut Cursor::new(vec![0, 0])).unwrap_err();
        assert!(error.starts_with("frame_length_read_failed:"));
    }

    #[test]
    fn server_frame_uses_length_prefix() {
        let mut output = Vec::new();
        write_frame(
            &mut output,
            &ServerFrame {
                request_id: "request-3".into(),
                kind: "pong".into(),
                payload: json!({}),
            },
        )
        .unwrap();
        let length = u32::from_be_bytes(output[..4].try_into().unwrap()) as usize;
        assert_eq!(length, output.len() - 4);
    }
}
