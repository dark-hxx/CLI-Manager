use super::server::DaemonHost;
use crate::shell_resolver::silent_command;
use crate::ssh_launch::SshLaunchPlan;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_PREAMBLE_BYTES: usize = 8 * 1024;
const MAX_STDERR_BYTES: usize = 8 * 1024;
const DEDUP_EVENT_IDS: usize = 10_000;
const READER_QUEUE_CAPACITY: usize = 32;
const AGENT_REQUEST_QUEUE_CAPACITY: usize = 16;
const MAX_CONCURRENT_BRIDGES: usize = 4;
const MAX_CONCURRENT_CONNECTS: usize = 2;
const MAX_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const HISTORY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_HISTORY_DETAIL_CHUNKS: usize = 257;
const MAX_HISTORY_DETAIL_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const HOOK_DRAIN_WAIT_MS: u64 = 2_000;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const STABLE_CONNECTION_RESET: Duration = Duration::from_secs(30);
const RETRY_BASE_SECONDS: [u64; 6] = [1, 2, 5, 10, 30, 60];

#[derive(Default)]
struct PermitPool {
    active: Mutex<usize>,
    changed: Condvar,
}

struct CounterPermit {
    pool: &'static PermitPool,
}

impl CounterPermit {
    fn acquire(
        state: &'static OnceLock<PermitPool>,
        limit: usize,
        control: &BridgeControl,
    ) -> Option<Self> {
        let pool = state.get_or_init(PermitPool::default);
        let mut active = pool.active.lock().ok()?;
        while *active >= limit {
            if control.stop.load(Ordering::Acquire) {
                return None;
            }
            active = pool
                .changed
                .wait_timeout(active, Duration::from_millis(250))
                .ok()?
                .0;
        }
        *active += 1;
        Some(Self { pool })
    }
}

impl Drop for CounterPermit {
    fn drop(&mut self) {
        if let Ok(mut active) = self.pool.active.lock() {
            *active = active.saturating_sub(1);
            self.pool.changed.notify_one();
        }
    }
}

static BRIDGE_LIMIT: OnceLock<PermitPool> = OnceLock::new();
static CONNECT_LIMIT: OnceLock<PermitPool> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientFrame<'a> {
    request_id: String,
    kind: &'a str,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerFrame {
    request_id: String,
    kind: String,
    payload: Value,
}

enum ReaderMessage {
    Ready,
    Frame(ServerFrame),
    Error(String),
}

struct BridgeRunError {
    code: String,
    connected_for: Option<Duration>,
}

fn bridge_identity(plan: &SshLaunchPlan) -> String {
    format!(
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
    )
}

struct BridgeControl {
    stop: AtomicBool,
    finished: AtomicBool,
    connecting: AtomicBool,
    connected: AtomicBool,
    pending_requests: AtomicUsize,
    child: Mutex<Option<Child>>,
}

impl BridgeControl {
    fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            connecting: AtomicBool::new(true),
            connected: AtomicBool::new(false),
            pending_requests: AtomicUsize::new(0),
            child: Mutex::new(None),
        }
    }

    fn reserve(&self) {
        self.pending_requests.fetch_add(1, Ordering::AcqRel);
    }

    fn try_reserve_idle(&self) -> bool {
        if self.finished.load(Ordering::Acquire)
            || (!self.connecting.load(Ordering::Acquire) && !self.connected.load(Ordering::Acquire))
        {
            return false;
        }
        self.pending_requests
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn release_request(&self) {
        let released =
            self.pending_requests
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                    pending.checked_sub(1)
                });
        debug_assert!(released.is_ok());
    }

    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.terminate_current_child();
    }

    fn terminate_current_child(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                terminate_child(&mut child);
            }
        }
    }
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

struct BridgeEntry {
    identity: String,
    sessions: HashSet<String>,
    consumers: HashSet<String>,
    request_sender: SyncSender<AgentBridgeRequest>,
    control: Arc<BridgeControl>,
}

struct AgentBridgeRequest {
    kind: String,
    payload: Value,
    response: SyncSender<Result<Value, String>>,
}

struct BridgeHandle {
    request_sender: SyncSender<AgentBridgeRequest>,
    control: Arc<BridgeControl>,
}

impl BridgeHandle {
    fn reserve(self) -> BridgeRequestReservation {
        self.control.reserve();
        BridgeRequestReservation {
            request_sender: self.request_sender,
            control: self.control,
        }
    }
}

struct BridgeRequestReservation {
    request_sender: SyncSender<AgentBridgeRequest>,
    control: Arc<BridgeControl>,
}

impl Drop for BridgeRequestReservation {
    fn drop(&mut self) {
        self.control.release_request();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BridgeLane {
    Primary,
    Readonly,
    Git,
}

impl BridgeLane {
    fn for_request(kind: &str) -> Self {
        if matches!(
            kind,
            "fileList"
                | "fileRead"
                | "fileSearch"
                | "gitListRepositories"
                | "gitChanges"
                | "gitDiff"
                | "gitBranchStatus"
                | "gitBranches"
                | "gitStage"
                | "gitUnstage"
                | "gitStageAll"
                | "gitUnstageAll"
                | "gitDiscardFile"
                | "gitDeleteUntracked"
                | "gitRevertHunk"
                | "gitRevertLines"
                | "gitCommit"
                | "gitCommitPaths"
                | "gitFetch"
                | "gitPush"
                | "gitCheckout"
                | "gitSmartCheckout"
                | "gitCreateBranch"
                | "gitPull"
                | "gitPullAbort"
                | "gitRebaseContinue"
        ) {
            if kind.starts_with("git") {
                Self::Git
            } else {
                Self::Readonly
            }
        } else {
            Self::Primary
        }
    }
}

fn bridge_slot(host_id: &str, lane: BridgeLane) -> String {
    match lane {
        BridgeLane::Primary => host_id.to_string(),
        BridgeLane::Readonly => format!("{host_id}\0readonly"),
        BridgeLane::Git => format!("{host_id}\0git"),
    }
}

fn bridge_plan(plan: &SshLaunchPlan, lane: BridgeLane) -> SshLaunchPlan {
    let mut plan = plan.clone();
    if matches!(lane, BridgeLane::Readonly | BridgeLane::Git) {
        plan.client_instance_id = if lane == BridgeLane::Readonly {
            readonly_client_instance_id(&plan.host_id, &plan.client_instance_id)
        } else {
            isolated_client_instance_id(&plan.host_id, &plan.client_instance_id, lane)
        };
    }
    plan
}

fn readonly_client_instance_id(host_id: &str, client_instance_id: &str) -> String {
    isolated_client_instance_id(host_id, client_instance_id, BridgeLane::Readonly)
}

fn isolated_client_instance_id(
    host_id: &str,
    client_instance_id: &str,
    lane: BridgeLane,
) -> String {
    let mut high = DefaultHasher::new();
    match lane {
        BridgeLane::Readonly => "cli-manager-readonly-high".hash(&mut high),
        BridgeLane::Git => "cli-manager-git-high".hash(&mut high),
        BridgeLane::Primary => "cli-manager-primary-high".hash(&mut high),
    }
    host_id.hash(&mut high);
    client_instance_id.hash(&mut high);

    let mut low = DefaultHasher::new();
    match lane {
        BridgeLane::Readonly => "cli-manager-readonly-low".hash(&mut low),
        BridgeLane::Git => "cli-manager-git-low".hash(&mut low),
        BridgeLane::Primary => "cli-manager-primary-low".hash(&mut low),
    }
    client_instance_id.hash(&mut low);
    host_id.hash(&mut low);

    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&high.finish().to_be_bytes());
    bytes[8..].copy_from_slice(&low.finish().to_be_bytes());
    // RFC 9562 UUIDv8: deterministic application-defined identity with RFC variant bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut id = uuid::Uuid::from_bytes(bytes);
    if id.to_string().eq_ignore_ascii_case(client_instance_id) {
        bytes[15] ^= 1;
        id = uuid::Uuid::from_bytes(bytes);
    }
    id.to_string()
}

fn response_timeout(kind: &str) -> Duration {
    if kind.starts_with("history") {
        HISTORY_RESPONSE_TIMEOUT
    } else if matches!(
        kind,
        "gitFetch" | "gitPush" | "gitPull" | "gitSmartCheckout"
    ) {
        Duration::from_secs(150)
    } else if matches!(
        kind,
        "gitListRepositories" | "gitChanges" | "gitDiff" | "gitBranchStatus" | "gitBranches"
    ) {
        Duration::from_secs(40)
    } else if kind.starts_with("git") {
        Duration::from_secs(75)
    } else {
        Duration::from_secs(60)
    }
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
    resume_claims: Mutex<HashMap<String, String>>,
}

impl SshAgentBridgeManager {
    fn claim_resume_session(&self, claim_key: &str, consumer_id: &str) -> Result<(), String> {
        let mut claims = self
            .resume_claims
            .lock()
            .map_err(|_| "history_resume_claims_unavailable".to_string())?;
        if claims
            .get(claim_key)
            .is_some_and(|owner| owner != consumer_id)
        {
            return Err("remote_session_active_elsewhere".to_string());
        }
        claims.insert(claim_key.to_string(), consumer_id.to_string());
        Ok(())
    }

    fn release_resume_claims(&self, _host_id: &str, consumer_id: &str) {
        if let Ok(mut claims) = self.resume_claims.lock() {
            claims.retain(|_, owner| owner != consumer_id);
        }
    }

    pub fn ensure(&self, host: Weak<DaemonHost>, session_id: &str, plan: &SshLaunchPlan) {
        let _ = self.ensure_bridge(host, plan, BridgeLane::Primary, Some(session_id), None);
    }

    fn ensure_bridge(
        &self,
        host: Weak<DaemonHost>,
        plan: &SshLaunchPlan,
        lane: BridgeLane,
        session_id: Option<&str>,
        consumer_id: Option<&str>,
    ) -> Option<BridgeHandle> {
        if plan.agent_path.is_empty()
            || plan.agent_installation_id.is_empty()
            || plan.agent_remote_machine_id.is_empty()
            || plan.client_instance_id.is_empty()
            || plan.project_id.is_empty()
            || plan.bridge_epoch.is_empty()
            || (lane != BridgeLane::Git && plan.tool_source.is_empty())
        {
            return None;
        }
        let identity = bridge_identity(plan);
        let slot = bridge_slot(&plan.host_id, lane);
        let mut bridges = match self.bridges.lock() {
            Ok(bridges) => bridges,
            Err(_) => return None,
        };
        let mut sessions = session_id
            .map(|value| HashSet::from([value.to_string()]))
            .unwrap_or_default();
        let mut consumers = consumer_id
            .map(|value| HashSet::from([value.to_string()]))
            .unwrap_or_default();
        let mut replaced_control = None;
        if let Some(existing) = bridges.get_mut(&slot) {
            if existing.identity == identity && !existing.control.finished.load(Ordering::Acquire) {
                if let Some(session_id) = session_id {
                    existing.sessions.insert(session_id.to_string());
                }
                if let Some(consumer_id) = consumer_id {
                    existing.consumers.insert(consumer_id.to_string());
                }
                return Some(BridgeHandle {
                    request_sender: existing.request_sender.clone(),
                    control: Arc::clone(&existing.control),
                });
            }
            sessions.extend(existing.sessions.iter().cloned());
            consumers.extend(existing.consumers.iter().cloned());
            replaced_control = Some(Arc::clone(&existing.control));
        }
        let (request_sender, request_receiver) = mpsc::sync_channel(AGENT_REQUEST_QUEUE_CAPACITY);
        let control = Arc::new(BridgeControl::new());
        let thread_control = Arc::clone(&control);
        let thread_plan = plan.clone();
        bridges.insert(
            slot,
            BridgeEntry {
                identity,
                sessions,
                consumers,
                request_sender: request_sender.clone(),
                control: Arc::clone(&control),
            },
        );
        drop(bridges);
        if let Some(replaced_control) = replaced_control {
            replaced_control.stop();
        }
        let thread_lane = lane;
        thread::spawn(move || {
            run_bridge_loop(
                host,
                thread_plan,
                thread_control,
                request_receiver,
                thread_lane,
            )
        });
        Some(BridgeHandle {
            request_sender,
            control,
        })
    }

    fn try_reserve_primary(
        &self,
        host_id: &str,
        identity: &str,
        consumer_id: &str,
    ) -> Option<BridgeRequestReservation> {
        let slot = bridge_slot(host_id, BridgeLane::Primary);
        let mut bridges = self.bridges.lock().ok()?;
        let entry = bridges.get_mut(&slot)?;
        if entry.identity != identity || !entry.control.try_reserve_idle() {
            return None;
        }
        entry.consumers.insert(consumer_id.to_string());
        Some(BridgeRequestReservation {
            request_sender: entry.request_sender.clone(),
            control: Arc::clone(&entry.control),
        })
    }

    pub fn request(
        &self,
        host: Weak<DaemonHost>,
        consumer_id: &str,
        plan: &SshLaunchPlan,
        kind: &str,
        payload: Value,
    ) -> Result<Value, String> {
        if consumer_id.is_empty()
            || consumer_id.len() > 512
            || consumer_id.contains(['\0', '\r', '\n'])
            || !matches!(
                kind,
                "historySync"
                    | "historySearch"
                    | "historyGet"
                    | "historyResumePreflight"
                    | "fileList"
                    | "fileRead"
                    | "fileSearch"
                    | "gitListRepositories"
                    | "gitChanges"
                    | "gitDiff"
                    | "gitBranchStatus"
                    | "gitBranches"
                    | "gitStage"
                    | "gitUnstage"
                    | "gitStageAll"
                    | "gitUnstageAll"
                    | "gitDiscardFile"
                    | "gitDeleteUntracked"
                    | "gitRevertHunk"
                    | "gitRevertLines"
                    | "gitCommit"
                    | "gitCommitPaths"
                    | "gitFetch"
                    | "gitPush"
                    | "gitCheckout"
                    | "gitSmartCheckout"
                    | "gitCreateBranch"
                    | "gitPull"
                    | "gitPullAbort"
                    | "gitRebaseContinue"
            )
        {
            return Err("ssh_agent_request_invalid".to_string());
        }
        let resume_claim_key = if kind == "historyResumePreflight" {
            let source = payload
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let session_id = payload
                .get("sourceSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let source_instance_id = payload
                .get("expectedSourceInstanceId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if source.is_empty() || source_instance_id.is_empty() || session_id.is_empty() {
                return Err("history_resume_request_invalid".to_string());
            }
            let claim_key = format!("{}\0{}\0{}", source_instance_id, source, session_id);
            self.claim_resume_session(&claim_key, consumer_id)?;
            Some(claim_key)
        } else {
            None
        };
        let result = (|| {
            let lane = BridgeLane::for_request(kind);
            let reservation = if lane == BridgeLane::Readonly {
                self.try_reserve_primary(&plan.host_id, &bridge_identity(plan), consumer_id)
                    .or_else(|| {
                        let request_plan = bridge_plan(plan, lane);
                        self.ensure_bridge(host, &request_plan, lane, None, Some(consumer_id))
                            .map(BridgeHandle::reserve)
                    })
            } else {
                self.ensure_bridge(
                    host,
                    &bridge_plan(plan, lane),
                    lane,
                    None,
                    Some(consumer_id),
                )
                .map(BridgeHandle::reserve)
            }
            .ok_or_else(|| "ssh_agent_identity_required".to_string())?;
            let (response_sender, response_receiver) = mpsc::sync_channel(1);
            let timeout = response_timeout(kind);
            reservation
                .request_sender
                .send(AgentBridgeRequest {
                    kind: kind.to_string(),
                    payload,
                    response: response_sender,
                })
                .map_err(|_| "ssh_agent_bridge_request_queue_closed".to_string())?;
            receive_agent_response(&response_receiver, timeout + RESPONSE_TIMEOUT)
        })();
        if result.is_err() {
            if let (Some(claim_key), Ok(mut claims)) =
                (resume_claim_key.as_ref(), self.resume_claims.lock())
            {
                if claims
                    .get(claim_key)
                    .is_some_and(|owner| owner == consumer_id)
                {
                    claims.remove(claim_key);
                }
            }
        }
        result
    }

    pub fn release(&self, host_id: &str, session_id: &str) {
        let mut bridges = match self.bridges.lock() {
            Ok(bridges) => bridges,
            Err(_) => return,
        };
        let slot = bridge_slot(host_id, BridgeLane::Primary);
        let remove = bridges.get_mut(&slot).is_some_and(|entry| {
            entry.sessions.remove(session_id);
            entry.sessions.is_empty() && entry.consumers.is_empty()
        });
        let removed = remove.then(|| bridges.remove(&slot)).flatten();
        drop(bridges);
        if let Some(entry) = removed {
            entry.control.stop();
        }
    }

    pub fn release_consumer(&self, host_id: &str, consumer_id: &str) {
        self.release_resume_claims(host_id, consumer_id);
        let mut bridges = match self.bridges.lock() {
            Ok(bridges) => bridges,
            Err(_) => return,
        };
        let mut consumer_ids = HashSet::from([consumer_id.to_string()]);
        if let Some(suffix) = consumer_id.strip_prefix("history:") {
            consumer_ids.insert(format!("files:{suffix}"));
            consumer_ids.insert(format!("git:{suffix}"));
        }
        let mut removed = Vec::new();
        for lane in [BridgeLane::Primary, BridgeLane::Readonly, BridgeLane::Git] {
            let slot = bridge_slot(host_id, lane);
            let remove = bridges.get_mut(&slot).is_some_and(|entry| {
                entry
                    .consumers
                    .retain(|value| !consumer_ids.contains(value));
                entry.sessions.is_empty() && entry.consumers.is_empty()
            });
            if remove {
                if let Some(entry) = bridges.remove(&slot) {
                    removed.push(entry);
                }
            }
        }
        drop(bridges);
        for entry in removed {
            entry.control.stop();
        }
    }
}

fn receive_agent_response(
    receiver: &Receiver<Result<Value, String>>,
    timeout: Duration,
) -> Result<Value, String> {
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err("ssh_agent_bridge_response_timeout".to_string()),
        Err(RecvTimeoutError::Disconnected) => {
            Err("ssh_agent_bridge_response_channel_closed".to_string())
        }
    }
}

fn fail_pending_requests(receiver: &Receiver<AgentBridgeRequest>, error: &str) {
    while let Ok(request) = receiver.try_recv() {
        let _ = request.response.send(Err(error.to_string()));
    }
}

fn request_error_requires_disconnect(error: &str) -> bool {
    error.starts_with("ssh_agent_bridge_")
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
        if let Some(nonce) = text
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("CLI_MANAGER_SSH_AGENT/1 ")
        {
            if nonce.len() == 32 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Ok(());
            }
            return Err("ssh_agent_bridge_preamble_invalid".to_string());
        }
    }
}

fn spawn_reader(
    reader: impl Read + Send + 'static,
    sender: SyncSender<ReaderMessage>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        match read_preamble(&mut reader) {
            Ok(()) => {
                if sender.send(ReaderMessage::Ready).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = sender.send(ReaderMessage::Error(error));
                return;
            }
        }
        loop {
            match read_frame(&mut reader) {
                Ok(frame) => {
                    if sender.send(ReaderMessage::Frame(frame)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(ReaderMessage::Error(error));
                    return;
                }
            }
        }
    })
}

fn spawn_stderr_reader(
    mut reader: impl Read + Send + 'static,
    captured: Arc<Mutex<Vec<u8>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            if let Ok(mut output) = captured.lock() {
                let remaining = MAX_STDERR_BYTES.saturating_sub(output.len());
                output.extend_from_slice(&buffer[..read.min(remaining)]);
            }
        }
    })
}

fn classify_bridge_stderr(bytes: &[u8]) -> Option<&'static str> {
    let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    if [
        "permission denied",
        "authentication failed",
        "no supported authentication methods",
        "enter passphrase",
        "keyboard-interactive",
    ]
    .iter()
    .any(|pattern| text.contains(pattern))
    {
        return Some("ssh_interactive_auth_required");
    }
    if text.contains("host key verification failed")
        || text.contains("remote host identification has changed")
    {
        return Some("ssh_host_key_verification_required");
    }
    None
}

fn receive_ready(receiver: &Receiver<ReaderMessage>, timeout: Duration) -> Result<(), String> {
    match receiver.recv_timeout(timeout) {
        Ok(ReaderMessage::Ready) => Ok(()),
        Ok(ReaderMessage::Error(error)) => Err(error),
        Ok(ReaderMessage::Frame(_)) => Err("ssh_agent_bridge_preamble_invalid".to_string()),
        Err(RecvTimeoutError::Timeout) => Err("ssh_agent_bridge_handshake_timeout".to_string()),
        Err(RecvTimeoutError::Disconnected) => Err("ssh_agent_bridge_read_failed".to_string()),
    }
}

fn receive_frame(
    receiver: &Receiver<ReaderMessage>,
    timeout: Duration,
) -> Result<ServerFrame, String> {
    match receiver.recv_timeout(timeout) {
        Ok(ReaderMessage::Frame(frame)) => Ok(frame),
        Ok(ReaderMessage::Error(error)) => Err(error),
        Ok(ReaderMessage::Ready) => Err("ssh_agent_bridge_preamble_invalid".to_string()),
        Err(RecvTimeoutError::Timeout) => Err("ssh_agent_bridge_response_timeout".to_string()),
        Err(RecvTimeoutError::Disconnected) => Err("ssh_agent_bridge_read_failed".to_string()),
    }
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
            .filter(|code| {
                !code.is_empty()
                    && code.len() <= 128
                    && code
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
            .unwrap_or("ssh_agent_bridge_remote_error")
            .to_string());
    }
    if frame.kind != kind {
        return Err("ssh_agent_bridge_response_invalid".to_string());
    }
    Ok(frame.payload)
}

fn validate_hook_batch(payload: &Value, cursor: u64) -> Result<(&[Value], u64), String> {
    let events = payload
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "ssh_agent_bridge_hook_batch_invalid".to_string())?;
    let latest = payload
        .get("latestSequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| "ssh_agent_bridge_hook_batch_invalid".to_string())?;
    if events.len() > 128 || latest < cursor {
        return Err("ssh_agent_bridge_hook_batch_invalid".to_string());
    }
    let mut previous = cursor;
    for event in events {
        let sequence = event
            .get("sequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| "ssh_agent_bridge_hook_batch_invalid".to_string())?;
        if sequence <= previous || sequence > latest {
            return Err("ssh_agent_bridge_hook_batch_invalid".to_string());
        }
        previous = sequence;
    }
    if previous != latest {
        return Err("ssh_agent_bridge_hook_batch_invalid".to_string());
    }
    Ok((events.as_slice(), latest))
}

fn request(
    writer: &mut impl Write,
    receiver: &Receiver<ReaderMessage>,
    request_id: String,
    kind: &str,
    payload: Value,
    response_kind: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    write_frame(
        writer,
        &ClientFrame {
            request_id: request_id.clone(),
            kind,
            payload,
        },
    )?;
    let first = receive_frame(receiver, deadline.saturating_duration_since(Instant::now()))?;
    if kind == "historyGet" && first.kind == "historyDetailChunk" {
        return receive_history_detail_chunks(receiver, first, &request_id, deadline);
    }
    checked_response(first, &request_id, response_kind)
}

fn receive_history_detail_chunks(
    receiver: &Receiver<ReaderMessage>,
    mut frame: ServerFrame,
    request_id: &str,
    deadline: Instant,
) -> Result<Value, String> {
    let mut serialized = String::new();
    let mut expected_index = 0usize;
    let mut expected_total = None;
    loop {
        if frame.request_id != request_id || frame.kind != "historyDetailChunk" {
            return Err("ssh_agent_bridge_history_chunk_invalid".to_string());
        }
        let index = frame
            .payload
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| "ssh_agent_bridge_history_chunk_invalid".to_string())?;
        let total = frame
            .payload
            .get("total")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| (1..=MAX_HISTORY_DETAIL_CHUNKS).contains(value))
            .ok_or_else(|| "ssh_agent_bridge_history_chunk_invalid".to_string())?;
        let data = frame
            .payload
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "ssh_agent_bridge_history_chunk_invalid".to_string())?;
        if index != expected_index || expected_total.is_some_and(|value| value != total) {
            return Err("ssh_agent_bridge_history_chunk_invalid".to_string());
        }
        expected_total = Some(total);
        if serialized.len().saturating_add(data.len()) > MAX_HISTORY_DETAIL_RESPONSE_BYTES {
            return Err("ssh_agent_bridge_history_chunk_too_large".to_string());
        }
        serialized.push_str(data);
        expected_index += 1;
        if expected_index == total {
            return serde_json::from_str(&serialized)
                .map_err(|_| "ssh_agent_bridge_history_chunk_invalid".to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("ssh_agent_bridge_response_timeout".to_string());
        }
        frame = receive_frame(receiver, remaining)?;
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn retry_delay(attempt: usize, seed: &str) -> Duration {
    let base = RETRY_BASE_SECONDS[attempt.min(RETRY_BASE_SECONDS.len() - 1)] * 1_000;
    let span = base / 5;
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    attempt.hash(&mut hasher);
    let offset =
        (hasher.finish() % (span.saturating_mul(2).saturating_add(1))) as i64 - span as i64;
    Duration::from_millis((base as i64 + offset).max(1) as u64)
}

fn wait_for_retry(control: &BridgeControl, delay: Duration) -> bool {
    let deadline = Instant::now() + delay;
    while !control.stop.load(Ordering::Acquire) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        thread::sleep(remaining.min(Duration::from_millis(250)));
    }
    false
}

fn permanent_bridge_error(error: &str) -> bool {
    if error.starts_with("ssh_agent_capability_missing:") {
        return true;
    }
    matches!(
        error,
        "ssh_interactive_auth_required"
            | "bridge_installation_id_mismatch"
            | "ssh_agent_identity_changed"
            | "ssh_agent_identity_required"
            | "ssh_host_key_verification_required"
            | "agent_installation_record_missing"
            | "bridge_client_instance_invalid"
            | "bridge_host_id_invalid"
            | "bridge_installation_id_invalid"
            | "ssh_agent_bridge_protocol_incompatible"
    )
}

fn run_bridge_loop(
    host: Weak<DaemonHost>,
    plan: SshLaunchPlan,
    control: Arc<BridgeControl>,
    request_receiver: Receiver<AgentBridgeRequest>,
    lane: BridgeLane,
) {
    let Some(_bridge_permit) =
        CounterPermit::acquire(&BRIDGE_LIMIT, MAX_CONCURRENT_BRIDGES, &control)
    else {
        let error = if control.stop.load(Ordering::Acquire) {
            "ssh_agent_bridge_stopped"
        } else {
            "ssh_agent_bridge_capacity_exhausted"
        };
        fail_pending_requests(&request_receiver, error);
        control.finished.store(true, Ordering::Release);
        return;
    };
    let mut attempt = 0usize;
    let mut dedup = EventDedup::default();
    while !control.stop.load(Ordering::Acquire) {
        match run_bridge_once(&host, &plan, &control, &mut dedup, &request_receiver, lane) {
            Ok(()) => break,
            Err(failure) => {
                log::warn!(
                    "SSH Agent bridge stopped for host {}: {}",
                    plan.host_id,
                    failure.code
                );
                fail_pending_requests(&request_receiver, &failure.code);
                if permanent_bridge_error(&failure.code) {
                    break;
                }
                if failure
                    .connected_for
                    .is_some_and(|duration| duration >= STABLE_CONNECTION_RESET)
                {
                    attempt = 0;
                }
            }
        }
        if control.stop.load(Ordering::Acquire) {
            break;
        }
        let delay = retry_delay(attempt, &plan.host_id);
        attempt = attempt.saturating_add(1).min(RETRY_BASE_SECONDS.len() - 1);
        if !wait_for_retry(&control, delay) {
            break;
        }
    }
    control.finished.store(true, Ordering::Release);
}

fn run_bridge_once(
    host: &Weak<DaemonHost>,
    plan: &SshLaunchPlan,
    control: &Arc<BridgeControl>,
    dedup: &mut EventDedup,
    request_receiver: &Receiver<AgentBridgeRequest>,
    lane: BridgeLane,
) -> Result<(), BridgeRunError> {
    control.connecting.store(true, Ordering::Release);
    let mut connected_at = None;
    let result = run_bridge_once_inner(
        host,
        plan,
        control,
        dedup,
        request_receiver,
        &mut connected_at,
        lane,
    );
    control.connecting.store(false, Ordering::Release);
    result.map_err(|code| BridgeRunError {
        code,
        connected_for: connected_at.map(|started: Instant| started.elapsed()),
    })
}

fn run_bridge_once_inner(
    host: &Weak<DaemonHost>,
    plan: &SshLaunchPlan,
    control: &Arc<BridgeControl>,
    dedup: &mut EventDedup,
    request_receiver: &Receiver<AgentBridgeRequest>,
    connected_at: &mut Option<Instant>,
    lane: BridgeLane,
) -> Result<(), String> {
    let connect_permit = CounterPermit::acquire(&CONNECT_LIMIT, MAX_CONCURRENT_CONNECTS, control)
        .ok_or_else(|| "ssh_agent_bridge_stopped".to_string())?;
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
    let Some(stdin) = child.stdin.take() else {
        terminate_child(&mut child);
        return Err("ssh_agent_bridge_stdin_missing".to_string());
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_child(&mut child);
        return Err("ssh_agent_bridge_stdout_missing".to_string());
    };
    let stderr = child.stderr.take();
    let stderr_output = Arc::new(Mutex::new(Vec::new()));
    let stderr_handle =
        stderr.map(|stderr| spawn_stderr_reader(stderr, Arc::clone(&stderr_output)));
    let Ok(mut child_slot) = control.child.lock() else {
        terminate_child(&mut child);
        return Err("ssh_agent_bridge_state_failed".to_string());
    };
    *child_slot = Some(child);
    drop(child_slot);
    if control.stop.load(Ordering::Acquire) {
        control.terminate_current_child();
        if let Some(stderr_handle) = stderr_handle {
            let _ = stderr_handle.join();
        }
        return Err("ssh_agent_bridge_stopped".to_string());
    }

    let (reader_sender, reader_receiver) = mpsc::sync_channel(READER_QUEUE_CAPACITY);
    let reader_handle = spawn_reader(stdout, reader_sender);
    let result = (|| {
        let mut writer = BufWriter::new(stdin);
        let handshake_timeout = Duration::from_secs(plan.connect_timeout_sec.saturating_add(10))
            .min(MAX_HANDSHAKE_TIMEOUT);
        receive_ready(&reader_receiver, handshake_timeout)?;
        let hello = request(
            &mut writer,
            &reader_receiver,
            "hello-1".to_string(),
            "hello",
            json!({
                "hostId": plan.host_id,
                "clientInstanceId": plan.client_instance_id,
                "installationId": plan.agent_installation_id,
            }),
            "helloOk",
            RESPONSE_TIMEOUT,
        )?;
        if hello.get("protocolMajor").and_then(Value::as_u64) != Some(1) {
            return Err("ssh_agent_bridge_protocol_incompatible".to_string());
        }
        let capabilities = hello
            .get("capabilities")
            .and_then(Value::as_array)
            .ok_or_else(|| "ssh_agent_bridge_protocol_incompatible".to_string())?;
        let required_capabilities: &[&str] = if lane == BridgeLane::Git {
            &[
                "bridgeProtocol",
                "heartbeat",
                "requestCancellation",
                "boundedBackpressure",
                "gitFull",
            ]
        } else {
            &[
                "hookSpool",
                "heartbeat",
                "requestCancellation",
                "boundedBackpressure",
                "historyIndex",
                "historySearch",
                "historyDetail",
                "historyDetailChunks",
                "historyResumePreflight",
            ]
        };
        if let Some(missing) = required_capabilities.iter().find(|required| {
            !capabilities
                .iter()
                .any(|value| value.as_str() == Some(**required))
        }) {
            if lane == BridgeLane::Git {
                return Err(format!("ssh_agent_capability_missing:{missing}"));
            }
            return Err("ssh_agent_bridge_protocol_incompatible".to_string());
        }
        if hello.get("remoteMachineId").and_then(Value::as_str)
            != Some(plan.agent_remote_machine_id.as_str())
        {
            return Err("ssh_agent_identity_changed".to_string());
        }
        control.connected.store(true, Ordering::Release);
        *connected_at = Some(Instant::now());
        drop(connect_permit);
        let mut cursor = 0u64;
        let mut request_number = 2u64;
        let mut last_heartbeat = Instant::now();
        while !control.stop.load(Ordering::Acquire) {
            match request_receiver.try_recv() {
                Ok(agent_request) => {
                    let request_id = format!("agent-request-{request_number}");
                    request_number = request_number.saturating_add(1);
                    let kind = agent_request.kind.clone();
                    let started_at = Instant::now();
                    let result = request(
                        &mut writer,
                        &reader_receiver,
                        request_id,
                        &agent_request.kind,
                        agent_request.payload,
                        "response",
                        response_timeout(&kind),
                    );
                    let elapsed = started_at.elapsed();
                    if let Err(error) = &result {
                        log::warn!(
                            "SSH Agent request failed: host_id={} kind={} elapsed_ms={} error={}",
                            plan.host_id,
                            kind,
                            elapsed.as_millis(),
                            error
                        );
                    } else {
                        log::debug!(
                            "SSH Agent request completed: host_id={} kind={} elapsed_ms={}",
                            plan.host_id,
                            kind,
                            elapsed.as_millis()
                        );
                    }
                    let disconnect = result
                        .as_ref()
                        .err()
                        .is_some_and(|error| request_error_requires_disconnect(error));
                    let _ = agent_request.response.send(result);
                    if disconnect {
                        return Err("ssh_agent_bridge_request_failed".to_string());
                    }
                    continue;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {}
            }
            let drain_id = format!("hook-drain-{request_number}");
            request_number = request_number.saturating_add(1);
            let payload = request(
                &mut writer,
                &reader_receiver,
                drain_id,
                "hookDrain",
                json!({ "afterSequence": cursor, "limit": 128, "waitMs": HOOK_DRAIN_WAIT_MS }),
                "hookBatch",
                Duration::from_millis(HOOK_DRAIN_WAIT_MS) + RESPONSE_TIMEOUT,
            )?;
            let (events, latest) = validate_hook_batch(&payload, cursor)?;
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
                let ack_id = format!("hook-ack-{request_number}");
                request_number = request_number.saturating_add(1);
                let ack = request(
                    &mut writer,
                    &reader_receiver,
                    ack_id,
                    "hookAck",
                    json!({ "throughSequence": latest }),
                    "response",
                    RESPONSE_TIMEOUT,
                )?;
                if ack.get("accepted").and_then(Value::as_bool) != Some(true)
                    || ack.get("throughSequence").and_then(Value::as_u64) != Some(latest)
                {
                    return Err("ssh_agent_bridge_ack_invalid".to_string());
                }
                cursor = latest;
            }
            if last_heartbeat.elapsed() >= HEARTBEAT_INTERVAL {
                let ping_id = format!("ping-{request_number}");
                request_number = request_number.saturating_add(1);
                let sent_at = now_ms();
                let pong = request(
                    &mut writer,
                    &reader_receiver,
                    ping_id,
                    "ping",
                    json!({ "sentAt": sent_at }),
                    "pong",
                    RESPONSE_TIMEOUT,
                )?;
                if pong.get("sentAt").and_then(Value::as_u64) != Some(sent_at) {
                    return Err("ssh_agent_bridge_heartbeat_invalid".to_string());
                }
                last_heartbeat = Instant::now();
            }
        }
        Ok(())
    })();

    control.connected.store(false, Ordering::Release);
    drop(reader_receiver);
    control.terminate_current_child();
    let _ = reader_handle.join();
    if let Some(stderr_handle) = stderr_handle {
        let _ = stderr_handle.join();
    }
    if result.is_err() && connected_at.is_none() {
        if let Ok(stderr) = stderr_output.lock() {
            if let Some(code) = classify_bridge_stderr(&stderr) {
                return Err(code.to_string());
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{
        bridge_slot, checked_response, classify_bridge_stderr, fail_pending_requests,
        permanent_bridge_error, read_preamble, readonly_client_instance_id, receive_agent_response,
        receive_frame, request, request_error_requires_disconnect, response_timeout, retry_delay,
        validate_hook_batch, AgentBridgeRequest, BridgeControl, BridgeEntry, BridgeLane,
        ClientFrame, CounterPermit, EventDedup, PermitPool, ReaderMessage, ServerFrame,
        SshAgentBridgeManager, DEDUP_EVENT_IDS,
    };
    use serde_json::json;
    use std::collections::{HashMap, HashSet};
    use std::io::{BufReader, Cursor};
    use std::sync::atomic::Ordering;
    use std::sync::{mpsc, Arc, OnceLock};
    use std::time::Duration;

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
    fn remote_error_codes_are_short_and_stable() {
        let error = checked_response(
            ServerFrame {
                request_id: "request-1".to_string(),
                kind: "error".to_string(),
                payload: json!({ "code": "x".repeat(129) }),
            },
            "request-1",
            "response",
        )
        .unwrap_err();
        assert_eq!(error, "ssh_agent_bridge_remote_error");
    }

    #[test]
    fn resume_claims_block_other_consumers_until_release() {
        let manager = SshAgentBridgeManager::default();
        let key = "source-instance-1\0claude\0session-1";
        manager.claim_resume_session(key, "consumer-1").unwrap();
        manager.claim_resume_session(key, "consumer-1").unwrap();
        assert_eq!(
            manager.claim_resume_session(key, "consumer-2").unwrap_err(),
            "remote_session_active_elsewhere"
        );
        manager.release_resume_claims("host-1", "consumer-1");
        manager.claim_resume_session(key, "consumer-2").unwrap();
    }

    #[test]
    fn hook_batch_requires_monotonic_sequences_and_exact_latest() {
        assert!(validate_hook_batch(
            &json!({
                "events": [
                    { "sequence": 2, "kind": "gap" },
                    { "sequence": 3, "kind": "hookEvent" }
                ],
                "latestSequence": 3
            }),
            1,
        )
        .is_ok());
        assert_eq!(
            validate_hook_batch(
                &json!({
                    "events": [
                        { "sequence": 3, "kind": "hookEvent" },
                        { "sequence": 2, "kind": "gap" }
                    ],
                    "latestSequence": 3
                }),
                1,
            )
            .unwrap_err(),
            "ssh_agent_bridge_hook_batch_invalid"
        );
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

    #[test]
    fn preamble_is_bounded_and_requires_a_hex_nonce() {
        let mut valid = BufReader::new(Cursor::new(
            b"login banner\nCLI_MANAGER_SSH_AGENT/1 0123456789abcdef0123456789abcdef\n",
        ));
        read_preamble(&mut valid).unwrap();

        let mut invalid =
            BufReader::new(Cursor::new(b"CLI_MANAGER_SSH_AGENT/1 not-a-valid-nonce\n"));
        assert_eq!(
            read_preamble(&mut invalid).unwrap_err(),
            "ssh_agent_bridge_preamble_invalid"
        );
    }

    #[test]
    fn response_wait_has_a_hard_timeout() {
        let (_sender, receiver) = mpsc::sync_channel(1);
        assert_eq!(
            receive_frame(&receiver, Duration::from_millis(1)).unwrap_err(),
            "ssh_agent_bridge_response_timeout"
        );
    }

    #[test]
    fn disconnected_response_channel_is_not_reported_as_a_timeout() {
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(sender);
        assert_eq!(
            receive_agent_response(&receiver, Duration::from_secs(1)).unwrap_err(),
            "ssh_agent_bridge_response_channel_closed"
        );
    }

    #[test]
    fn bridge_start_failure_is_forwarded_to_queued_requests() {
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        request_sender
            .send(AgentBridgeRequest {
                kind: "fileList".to_string(),
                payload: json!({}),
                response: response_sender,
            })
            .unwrap();
        fail_pending_requests(&request_receiver, "ssh_interactive_auth_required");
        assert_eq!(
            receive_agent_response(&response_receiver, Duration::from_secs(1)).unwrap_err(),
            "ssh_interactive_auth_required"
        );
    }

    #[test]
    fn readonly_request_reuses_only_an_idle_matching_primary_bridge() {
        let control = Arc::new(BridgeControl::new());
        control.connecting.store(false, Ordering::Release);
        control.connected.store(true, Ordering::Release);
        let (request_sender, _request_receiver) = mpsc::sync_channel(1);
        let manager = SshAgentBridgeManager {
            bridges: std::sync::Mutex::new(HashMap::from([(
                bridge_slot("host-1", BridgeLane::Primary),
                BridgeEntry {
                    identity: "identity-1".to_string(),
                    sessions: HashSet::from(["session-1".to_string()]),
                    consumers: HashSet::new(),
                    request_sender,
                    control: Arc::clone(&control),
                },
            )])),
            resume_claims: std::sync::Mutex::new(HashMap::new()),
        };

        let reservation = manager
            .try_reserve_primary("host-1", "identity-1", "files-1")
            .unwrap();
        assert_eq!(control.pending_requests.load(Ordering::Acquire), 1);
        assert!(manager
            .try_reserve_primary("host-1", "identity-1", "files-2")
            .is_none());
        assert!(manager
            .try_reserve_primary("host-1", "identity-2", "files-2")
            .is_none());
        drop(reservation);
        assert_eq!(control.pending_requests.load(Ordering::Acquire), 0);

        let next = manager
            .try_reserve_primary("host-1", "identity-1", "files-2")
            .unwrap();
        drop(next);
        control.connected.store(false, Ordering::Release);
        assert!(manager
            .try_reserve_primary("host-1", "identity-1", "files-3")
            .is_none());
    }

    #[test]
    fn readonly_requests_use_an_isolated_bridge_identity() {
        assert_eq!(BridgeLane::for_request("historySync"), BridgeLane::Primary);
        assert_eq!(BridgeLane::for_request("fileList"), BridgeLane::Readonly);
        assert_eq!(BridgeLane::for_request("gitChanges"), BridgeLane::Git);
        assert!(response_timeout("historySync") > response_timeout("fileList"));

        let readonly = readonly_client_instance_id("host-1", "client-1");
        assert_ne!(readonly, "client-1");
        assert_eq!(readonly, readonly_client_instance_id("host-1", "client-1"));
        assert_eq!(
            uuid::Uuid::parse_str(&readonly).unwrap().get_version_num(),
            8
        );
        assert_ne!(
            bridge_slot("host-1", BridgeLane::Primary),
            bridge_slot("host-1", BridgeLane::Readonly)
        );
        assert_ne!(
            bridge_slot("host-1", BridgeLane::Readonly),
            bridge_slot("host-1", BridgeLane::Git)
        );
    }

    #[test]
    fn history_detail_chunks_are_reassembled_within_one_request() {
        let (sender, receiver) = mpsc::sync_channel(2);
        for (index, data) in ["{\"messages\":[", "]}"].into_iter().enumerate() {
            sender
                .send(ReaderMessage::Frame(ServerFrame {
                    request_id: "history-1".to_string(),
                    kind: "historyDetailChunk".to_string(),
                    payload: json!({ "index": index, "total": 2, "data": data }),
                }))
                .unwrap();
        }
        let mut writer = Vec::new();
        let value = request(
            &mut writer,
            &receiver,
            "history-1".to_string(),
            "historyGet",
            json!({}),
            "response",
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(value, json!({ "messages": [] }));
        assert!(!writer.is_empty());
    }

    #[test]
    fn history_detail_chunks_reject_out_of_order_frames() {
        let (sender, receiver) = mpsc::sync_channel(1);
        sender
            .send(ReaderMessage::Frame(ServerFrame {
                request_id: "history-1".to_string(),
                kind: "historyDetailChunk".to_string(),
                payload: json!({ "index": 1, "total": 2, "data": "{}" }),
            }))
            .unwrap();
        let error = request(
            &mut Vec::new(),
            &receiver,
            "history-1".to_string(),
            "historyGet",
            json!({}),
            "response",
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(error, "ssh_agent_bridge_history_chunk_invalid");
    }

    #[test]
    fn reconnect_jitter_stays_within_twenty_percent() {
        for (attempt, base) in [1u64, 2, 5, 10, 30, 60].into_iter().enumerate() {
            let delay = retry_delay(attempt, "host-1").as_millis() as u64;
            assert!(delay >= base * 800);
            assert!(delay <= base * 1_200);
        }
    }

    #[test]
    fn active_remote_bridge_is_retried_for_takeover() {
        assert!(!permanent_bridge_error("bridge_already_active"));
        assert!(permanent_bridge_error(
            "ssh_agent_bridge_protocol_incompatible"
        ));
    }

    #[test]
    fn bridge_stderr_classifies_auth_and_host_key_without_logging_raw_text() {
        assert_eq!(
            classify_bridge_stderr(b"user@example: Permission denied (publickey)."),
            Some("ssh_interactive_auth_required")
        );
        assert_eq!(
            classify_bridge_stderr(b"REMOTE HOST IDENTIFICATION HAS CHANGED"),
            Some("ssh_host_key_verification_required")
        );
        assert_eq!(classify_bridge_stderr(b"connection reset by peer"), None);
        assert!(permanent_bridge_error("ssh_host_key_verification_required"));
    }

    #[test]
    fn permit_pool_enforces_the_configured_limit() {
        let state: &'static OnceLock<PermitPool> = Box::leak(Box::new(OnceLock::new()));
        let first_control = BridgeControl::new();
        let first = CounterPermit::acquire(state, 1, &first_control).unwrap();
        let stopped = BridgeControl::new();
        stopped.stop.store(true, Ordering::Release);
        assert!(CounterPermit::acquire(state, 1, &stopped).is_none());
        drop(first);
        assert!(CounterPermit::acquire(state, 1, &BridgeControl::new()).is_some());
    }

    #[test]
    fn bridge_stays_alive_until_the_last_session_releases() {
        let control = Arc::new(BridgeControl::new());
        let (request_sender, _request_receiver) = mpsc::sync_channel(1);
        let manager = SshAgentBridgeManager {
            bridges: std::sync::Mutex::new(HashMap::from([(
                "host-1".to_string(),
                BridgeEntry {
                    identity: "identity".to_string(),
                    sessions: HashSet::from(["session-1".to_string(), "session-2".to_string()]),
                    consumers: HashSet::new(),
                    request_sender,
                    control: Arc::clone(&control),
                },
            )])),
            resume_claims: std::sync::Mutex::new(HashMap::new()),
        };
        manager.release("host-1", "session-1");
        assert_eq!(manager.bridges.lock().unwrap().len(), 1);
        assert!(!control.stop.load(Ordering::Acquire));
        manager.release("host-1", "session-2");
        assert!(manager.bridges.lock().unwrap().is_empty());
        assert!(control.stop.load(Ordering::Acquire));
    }

    #[test]
    fn history_consumer_keeps_bridge_alive_after_terminal_closes() {
        let control = Arc::new(BridgeControl::new());
        let (request_sender, _request_receiver) = mpsc::sync_channel(1);
        let manager = SshAgentBridgeManager {
            bridges: std::sync::Mutex::new(HashMap::from([(
                "host-1".to_string(),
                BridgeEntry {
                    identity: "identity".to_string(),
                    sessions: HashSet::from(["session-1".to_string()]),
                    consumers: HashSet::from(["history-1".to_string()]),
                    request_sender,
                    control: Arc::clone(&control),
                },
            )])),
            resume_claims: std::sync::Mutex::new(HashMap::new()),
        };
        manager.release("host-1", "session-1");
        assert_eq!(manager.bridges.lock().unwrap().len(), 1);
        assert!(!control.stop.load(Ordering::Acquire));
        manager.release_consumer("host-1", "history-1");
        assert!(manager.bridges.lock().unwrap().is_empty());
        assert!(control.stop.load(Ordering::Acquire));
    }

    #[test]
    fn releasing_history_consumer_also_releases_readonly_aliases() {
        let primary_control = Arc::new(BridgeControl::new());
        let readonly_control = Arc::new(BridgeControl::new());
        let (primary_sender, _primary_receiver) = mpsc::sync_channel(1);
        let (readonly_sender, _readonly_receiver) = mpsc::sync_channel(1);
        let manager = SshAgentBridgeManager {
            bridges: std::sync::Mutex::new(HashMap::from([
                (
                    bridge_slot("host-1", BridgeLane::Primary),
                    BridgeEntry {
                        identity: "primary".to_string(),
                        sessions: HashSet::new(),
                        consumers: HashSet::from(["history:client:host:codex:project".to_string()]),
                        request_sender: primary_sender,
                        control: Arc::clone(&primary_control),
                    },
                ),
                (
                    bridge_slot("host-1", BridgeLane::Readonly),
                    BridgeEntry {
                        identity: "readonly".to_string(),
                        sessions: HashSet::new(),
                        consumers: HashSet::from([
                            "files:client:host:codex:project".to_string(),
                            "git:client:host:codex:project".to_string(),
                        ]),
                        request_sender: readonly_sender,
                        control: Arc::clone(&readonly_control),
                    },
                ),
            ])),
            resume_claims: std::sync::Mutex::new(HashMap::new()),
        };

        manager.release_consumer("host-1", "history:client:host:codex:project");
        assert!(manager.bridges.lock().unwrap().is_empty());
        assert!(primary_control.stop.load(Ordering::Acquire));
        assert!(readonly_control.stop.load(Ordering::Acquire));
    }

    #[test]
    fn domain_request_errors_do_not_restart_the_bridge() {
        assert!(!request_error_requires_disconnect(
            "history_session_not_found"
        ));
        assert!(!request_error_requires_disconnect("history_index_busy"));
        assert!(request_error_requires_disconnect(
            "ssh_agent_bridge_response_timeout"
        ));
    }
}
