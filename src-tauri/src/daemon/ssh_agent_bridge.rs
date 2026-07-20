use super::server::DaemonHost;
use crate::shell_resolver::silent_command;
use crate::ssh_launch::SshLaunchPlan;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread;
use std::time::Duration;

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_PREAMBLE_BYTES: usize = 8 * 1024;
const DEDUP_EVENT_IDS: usize = 10_000;
const MAX_CONCURRENT_CONNECTS: usize = 2;

struct ConnectPermit;

impl ConnectPermit {
    fn acquire(control: &BridgeControl) -> Option<Self> {
        let state = CONNECT_LIMIT.get_or_init(|| (Mutex::new(0), Condvar::new()));
        let mut active = state.0.lock().ok()?;
        while *active >= MAX_CONCURRENT_CONNECTS {
            if control.stop.load(Ordering::Acquire) {
                return None;
            }
            active = state
                .1
                .wait_timeout(active, Duration::from_millis(250))
                .ok()?
                .0;
        }
        *active += 1;
        Some(Self)
    }
}

impl Drop for ConnectPermit {
    fn drop(&mut self) {
        let state = CONNECT_LIMIT.get_or_init(|| (Mutex::new(0), Condvar::new()));
        if let Ok(mut active) = state.0.lock() {
            *active = active.saturating_sub(1);
            state.1.notify_one();
        }
    }
}

static CONNECT_LIMIT: OnceLock<(Mutex<usize>, Condvar)> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientFrame<'a> {
    request_id: String,
    kind: &'a str,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerFrame {
    request_id: String,
    kind: String,
    payload: Value,
}

struct BridgeControl {
    stop: AtomicBool,
    finished: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl BridgeControl {
    fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            child: Mutex::new(None),
        }
    }

    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

struct BridgeEntry {
    identity: String,
    sessions: HashSet<String>,
    control: Arc<BridgeControl>,
}

#[derive(Default)]
struct EventDedup {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl EventDedup {
    fn insert(&mut self, event_id: &str) -> bool {
        if !self.ids.insert(event_id.to_string()) {
            return false;
        }
        self.order.push_back(event_id.to_string());
        while self.order.len() > DEDUP_EVENT_IDS {
            if let Some(removed) = self.order.pop_front() {
                self.ids.remove(&removed);
            }
        }
        true
    }
}

#[derive(Default)]
pub struct SshAgentBridgeManager {
    bridges: Mutex<HashMap<String, BridgeEntry>>,
}

impl SshAgentBridgeManager {
    pub fn ensure(&self, host: Weak<DaemonHost>, session_id: &str, plan: &SshLaunchPlan) {
        if plan.agent_path.is_empty()
            || plan.agent_installation_id.is_empty()
            || plan.agent_remote_machine_id.is_empty()
            || plan.client_instance_id.is_empty()
            || plan.project_id.is_empty()
            || plan.bridge_epoch.is_empty()
            || plan.tool_source.is_empty()
        {
            return;
        }
        let identity = format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
            plan.host,
            plan.port,
            plan.username,
            plan.config_alias,
            plan.auth_mode,
            plan.identity_file,
            plan.credential_ref,
            plan.jump_target,
            plan.proxy_type,
            plan.proxy_host,
            plan.proxy_port,
            plan.proxy_command,
            plan.agent_path,
            plan.agent_installation_id,
            plan.agent_remote_machine_id,
            plan.client_instance_id,
            plan.connect_timeout_sec,
            plan.server_alive_interval_sec,
            plan.server_alive_count_max,
        );
        let mut bridges = match self.bridges.lock() {
            Ok(bridges) => bridges,
            Err(_) => return,
        };
        let mut sessions = HashSet::from([session_id.to_string()]);
        if let Some(existing) = bridges.get_mut(&plan.host_id) {
            if existing.identity == identity && !existing.control.finished.load(Ordering::Acquire) {
                existing.sessions.insert(session_id.to_string());
                return;
            }
            sessions.extend(existing.sessions.iter().cloned());
            existing.control.stop();
        }
        let control = Arc::new(BridgeControl::new());
        let thread_control = Arc::clone(&control);
        let thread_plan = plan.clone();
        thread::spawn(move || run_bridge_loop(host, thread_plan, thread_control));
        bridges.insert(
            plan.host_id.clone(),
            BridgeEntry {
                identity,
                sessions,
                control,
            },
        );
    }

    pub fn release(&self, host_id: &str, session_id: &str) {
        let mut bridges = match self.bridges.lock() {
            Ok(bridges) => bridges,
            Err(_) => return,
        };
        let remove = bridges.get_mut(host_id).is_some_and(|entry| {
            entry.sessions.remove(session_id);
            entry.sessions.is_empty()
        });
        if remove {
            if let Some(entry) = bridges.remove(host_id) {
                entry.control.stop();
            }
        }
    }
}

impl Drop for SshAgentBridgeManager {
    fn drop(&mut self) {
        if let Ok(bridges) = self.bridges.get_mut() {
            for entry in bridges.values() {
                entry.control.stop();
            }
        }
    }
}

fn write_frame(writer: &mut impl Write, frame: &ClientFrame<'_>) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(frame).map_err(|_| "ssh_agent_bridge_frame_invalid".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err("ssh_agent_bridge_frame_too_large".to_string());
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(&bytes))
        .and_then(|_| writer.flush())
        .map_err(|_| "ssh_agent_bridge_write_failed".to_string())
}

fn read_frame(reader: &mut impl Read) -> Result<ServerFrame, String> {
    let mut length = [0u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(|_| "ssh_agent_bridge_read_failed".to_string())?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("ssh_agent_bridge_frame_too_large".to_string());
    }
    let mut bytes = vec![0u8; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| "ssh_agent_bridge_read_failed".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "ssh_agent_bridge_frame_invalid".to_string())
}

fn read_preamble(reader: &mut BufReader<impl Read>) -> Result<(), String> {
    let mut consumed = 0;
    loop {
        let mut line = Vec::new();
        reader
            .take((MAX_PREAMBLE_BYTES.saturating_sub(consumed) + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "ssh_agent_bridge_preamble_read_failed".to_string())?;
        if line.is_empty() || !line.ends_with(b"\n") {
            return Err("ssh_agent_bridge_preamble_invalid".to_string());
        }
        consumed += line.len();
        if consumed > MAX_PREAMBLE_BYTES {
            return Err("ssh_agent_bridge_preamble_invalid".to_string());
        }
        let text = std::str::from_utf8(&line)
            .map_err(|_| "ssh_agent_bridge_preamble_invalid".to_string())?;
        if text.starts_with("CLI_MANAGER_SSH_AGENT/1 ") {
            break;
        }
    }
    Ok(())
}

fn checked_response(frame: ServerFrame, request_id: &str, kind: &str) -> Result<Value, String> {
    if frame.request_id != request_id {
        return Err("ssh_agent_bridge_response_mismatch".to_string());
    }
    if frame.kind == "error" {
        return Err(frame
            .payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("ssh_agent_bridge_remote_error")
            .to_string());
    }
    if frame.kind != kind {
        return Err("ssh_agent_bridge_response_invalid".to_string());
    }
    Ok(frame.payload)
}

fn run_bridge_loop(host: Weak<DaemonHost>, plan: SshLaunchPlan, control: Arc<BridgeControl>) {
    let mut backoff = Duration::from_secs(1);
    let mut dedup = EventDedup::default();
    while !control.stop.load(Ordering::Acquire) {
        match run_bridge_once(&host, &plan, &control, &mut dedup) {
            Ok(()) => break,
            Err(error) => {
                log::warn!(
                    "SSH Agent bridge stopped for host {}: {}",
                    plan.host_id,
                    error
                );
                if matches!(
                    error.as_str(),
                    "ssh_interactive_auth_required"
                        | "bridge_installation_id_mismatch"
                        | "ssh_agent_identity_changed"
                        | "ssh_agent_identity_required"
                        | "bridge_already_active"
                        | "ssh_agent_bridge_protocol_incompatible"
                ) {
                    break;
                }
            }
        }
        if control.stop.load(Ordering::Acquire) {
            break;
        }
        thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
    control.finished.store(true, Ordering::Release);
}

fn run_bridge_once(
    host: &Weak<DaemonHost>,
    plan: &SshLaunchPlan,
    control: &Arc<BridgeControl>,
    dedup: &mut EventDedup,
) -> Result<(), String> {
    let connect_permit =
        ConnectPermit::acquire(control).ok_or_else(|| "ssh_agent_bridge_stopped".to_string())?;
    let launch = plan.build_agent_bridge_launch()?;
    let mut command = silent_command(&launch.executable);
    command
        .args(launch.args)
        .envs(launch.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "ssh_agent_bridge_spawn_failed".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ssh_agent_bridge_stdin_missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ssh_agent_bridge_stdout_missing".to_string())?;
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = [0u8; 4096];
            while reader.read(&mut buffer).ok().is_some_and(|read| read > 0) {}
        });
    }
    *control
        .child
        .lock()
        .map_err(|_| "ssh_agent_bridge_state_failed".to_string())? = Some(child);

    let result = (|| {
        let mut reader = BufReader::new(stdout);
        let mut writer = BufWriter::new(stdin);
        read_preamble(&mut reader)?;
        let hello_id = "hello-1";
        write_frame(
            &mut writer,
            &ClientFrame {
                request_id: hello_id.to_string(),
                kind: "hello",
                payload: json!({
                    "hostId": plan.host_id,
                    "clientInstanceId": plan.client_instance_id,
                    "installationId": plan.agent_installation_id,
                }),
            },
        )?;
        let hello = checked_response(read_frame(&mut reader)?, hello_id, "helloOk")?;
        if hello.get("protocolMajor").and_then(Value::as_u64) != Some(1) {
            return Err("ssh_agent_bridge_protocol_incompatible".to_string());
        }
        if !hello
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|capabilities| {
                capabilities
                    .iter()
                    .any(|value| value.as_str() == Some("hookSpool"))
            })
        {
            return Err("ssh_agent_bridge_protocol_incompatible".to_string());
        }
        if hello.get("remoteMachineId").and_then(Value::as_str)
            != Some(plan.agent_remote_machine_id.as_str())
        {
            return Err("ssh_agent_identity_changed".to_string());
        }
        drop(connect_permit);
        let mut cursor = 0u64;
        let mut request = 2u64;
        while !control.stop.load(Ordering::Acquire) {
            let drain_id = format!("hook-drain-{request}");
            request = request.saturating_add(1);
            write_frame(
                &mut writer,
                &ClientFrame {
                    request_id: drain_id.clone(),
                    kind: "hookDrain",
                    payload: json!({ "afterSequence": cursor, "limit": 128, "waitMs": 2000 }),
                },
            )?;
            let payload = checked_response(read_frame(&mut reader)?, &drain_id, "hookBatch")?;
            let events = payload
                .get("events")
                .and_then(Value::as_array)
                .ok_or_else(|| "ssh_agent_bridge_hook_batch_invalid".to_string())?;
            let latest = payload
                .get("latestSequence")
                .and_then(Value::as_u64)
                .unwrap_or(cursor);
            for event in events {
                if event.get("kind").and_then(Value::as_str) == Some("gap") {
                    let Some(sequence) = event.get("sequence").and_then(Value::as_u64) else {
                        continue;
                    };
                    if !dedup.insert(&format!("gap:{sequence}")) {
                        continue;
                    }
                    let dropped = event
                        .get("dropped")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    log::warn!(
                        "SSH Agent Hook spool gap for host {}: dropped={}",
                        plan.host_id,
                        dropped
                    );
                    if let Some(host) = host.upgrade() {
                        host.broadcast_remote_hook_gap(plan.host_id.clone(), dropped);
                    }
                    continue;
                }
                let Some(event_id) = event.get("eventId").and_then(Value::as_str) else {
                    continue;
                };
                if uuid::Uuid::parse_str(event_id).is_err() || !dedup.insert(event_id) {
                    continue;
                }
                if let Some(host) = host.upgrade() {
                    host.accept_remote_hook_event(event.clone());
                } else {
                    return Ok(());
                }
            }
            if latest > cursor {
                let ack_id = format!("hook-ack-{request}");
                request = request.saturating_add(1);
                write_frame(
                    &mut writer,
                    &ClientFrame {
                        request_id: ack_id.clone(),
                        kind: "hookAck",
                        payload: json!({ "throughSequence": latest }),
                    },
                )?;
                checked_response(read_frame(&mut reader)?, &ack_id, "response")?;
                cursor = latest;
            }
        }
        Ok(())
    })();

    if let Ok(mut child) = control.child.lock() {
        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{checked_response, ClientFrame, EventDedup, ServerFrame, DEDUP_EVENT_IDS};
    use serde_json::json;

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
    fn dedup_window_covers_the_bounded_agent_spool() {
        let mut dedup = EventDedup::default();
        for index in 0..DEDUP_EVENT_IDS {
            assert!(dedup.insert(&format!("event-{index}")));
        }
        assert!(!dedup.insert("event-0"));
        assert!(dedup.insert("gap:10001"));
        assert!(!dedup.insert("gap:10001"));
    }
}
