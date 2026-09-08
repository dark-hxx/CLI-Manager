use log::{debug, warn};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::third_party_notification::HookNotificationJob;

const REQUEST_PATH: &str = "/api/claude-hook";
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const RECENT_HOOK_EVENT_LIMIT: usize = 1024;
const CLAUDE_QUESTION_TOOL_NAME: &str = "AskUserQuestion";
const CODEX_QUESTION_TOOL_NAME: &str = "request_user_input";
const PROVISIONAL_APPROVAL_GRACE: Duration = Duration::from_secs(15);
const PROVISIONAL_APPROVAL_POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_PROVISIONAL_APPROVALS: usize = 256;
const APPROVAL_PROGRESS_TOMBSTONE_TTL: Duration = Duration::from_secs(5);
const MAX_APPROVAL_PROGRESS_TOMBSTONES: usize = 512;

#[derive(Default)]
struct RecentHookEvents {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl RecentHookEvents {
    // 接纳未见过的非空事件 ID，按容量淘汰旧 ID；无 ID 的旧请求直接接纳。
    fn accept(&mut self, event_id: Option<&str>) -> bool {
        let Some(event_id) = event_id.map(str::trim).filter(|value| !value.is_empty()) else {
            return true;
        };
        if self.ids.contains(event_id) {
            return false;
        }
        let event_id = event_id.to_string();
        self.ids.insert(event_id.clone());
        self.order.push_back(event_id);
        while self.order.len() > RECENT_HOOK_EVENT_LIMIT {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}

/// hook 上报的消费出口：主进程实现为 Tauri 事件，daemon 实现为帧广播 + 缓存
/// （Issue #123 Phase 2 复用点：HTTP 解析/校验逻辑两侧共享，只有出口不同）。
pub type HookPayloadSink = Arc<dyn Fn(ClaudeHookPayload) + Send + Sync + 'static>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeHookRequest {
    tab_id: String,
    source: Option<String>,
    event: String,
    title: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    // 仅 SubagentStart 等子 Agent 事件携带：用于定位子 Agent 转录 jsonl。
    agent_id: Option<String>,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    mcp_server: Option<String>,
    skill_name: Option<String>,
    agent_type: Option<String>,
    agent_transcript_path: Option<String>,
    transcript_path: Option<String>,
    transcript_bytes: Option<u64>,
    reasoning_effort: Option<String>,
    wsl_distro_name: Option<String>,
    environment_type: Option<String>,
    remote_host_id: Option<String>,
    remote_project_id: Option<String>,
    remote_transcript_ref: Option<String>,
    remote_agent_transcript_ref: Option<String>,
    remote_event_id: Option<String>,
    remote_sequence: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookPayload {
    tab_id: String,
    source: String,
    event: String,
    title: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    agent_id: Option<String>,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    mcp_server: Option<String>,
    skill_name: Option<String>,
    agent_type: Option<String>,
    agent_transcript_path: Option<String>,
    transcript_path: Option<String>,
    transcript_bytes: Option<u64>,
    reasoning_effort: Option<String>,
    wsl_distro_name: Option<String>,
    environment_type: Option<String>,
    remote_host_id: Option<String>,
    remote_project_id: Option<String>,
    remote_project_name: Option<String>,
    remote_transcript_ref: Option<String>,
    remote_agent_transcript_ref: Option<String>,
    remote_event_id: Option<String>,
    remote_sequence: Option<u64>,
}

impl ClaudeHookPayload {
    // 返回该 Hook 载荷的终端标签标识。
    pub fn tab_id(&self) -> &str {
        &self.tab_id
    }

    // 识别审批事件或 Claude、Codex 精确提问工具的 Notification。
    pub fn requires_user_response(&self) -> bool {
        self.event == "PermissionRequest"
            || (self.event == "Notification"
                && matches!(
                    (self.source.as_str(), self.tool_name.as_deref()),
                    ("claude", Some(CLAUDE_QUESTION_TOOL_NAME))
                        | ("codex", Some(CODEX_QUESTION_TOOL_NAME))
                ))
    }

    // 识别本地或 WSL 中带子 Agent 标识但无明确消息的 Codex 审批。
    fn is_ambiguous_codex_child_approval(&self) -> bool {
        self.source == "codex"
            && self.event == "PermissionRequest"
            && non_empty(self.agent_id.as_deref()).is_some()
            && non_empty(self.message.as_deref()).is_none()
            && matches!(self.approval_environment().as_str(), "local" | "wsl")
    }

    // 识别非 SSH 环境的 Codex ToolStart、ToolStop 内部进度事件。
    fn is_internal_codex_tool_progress(&self) -> bool {
        self.source == "codex"
            && matches!(self.event.as_str(), "ToolStart" | "ToolStop")
            && self.approval_environment() != "ssh"
    }

    // 以标签、来源、环境、可选父会话及必需子 Agent 构建审批范围。
    fn approval_scope(&self) -> Option<ApprovalScope> {
        Some(ApprovalScope {
            tab_id: self.tab_id.clone(),
            source: self.source.clone(),
            environment: self.approval_environment(),
            session_id: non_empty(self.session_id.as_deref()).map(str::to_string),
            agent_id: non_empty(self.agent_id.as_deref())?.to_string(),
        })
    }

    // 按 WSL 信息规范化转录路径，仅返回通过现有根目录校验的候选。
    fn normalize_approval_transcript_path(&self, raw: &str) -> Option<PathBuf> {
        let path = crate::commands::subagent_transcript::normalize_explicit_transcript_path(
            raw.to_string(),
            self.wsl_distro_name.as_deref(),
        );
        crate::commands::subagent_transcript::validate_explicit_transcript_path(&path).ok()?;
        Some(PathBuf::from(path))
    }

    // 独立校验子、父转录路径并去重，不因一个无效而跳过另一个。
    fn approval_transcript_paths(&self) -> Vec<PathBuf> {
        let mut paths = Vec::with_capacity(2);
        for raw in [
            non_empty(self.agent_transcript_path.as_deref()),
            non_empty(self.transcript_path.as_deref()),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(path) = self.normalize_approval_transcript_path(raw) {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        paths
    }

    // 优先选择子路径再选父路径，校验载荷字节基线所对应的路径。
    fn approval_payload_baseline_path(&self) -> Option<PathBuf> {
        non_empty(self.agent_transcript_path.as_deref())
            .or_else(|| non_empty(self.transcript_path.as_deref()))
            .and_then(|raw| self.normalize_approval_transcript_path(raw))
    }

    // 将非空显式环境转为小写，缺失时使用 local。
    fn approval_environment(&self) -> String {
        non_empty(self.environment_type.as_deref())
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| "local".to_string())
    }

    // 写入裁剪后的可信远端项目显示名，空白值清空该字段。
    pub fn with_remote_project_name(mut self, project_name: String) -> Self {
        self.remote_project_name =
            (!project_name.trim().is_empty()).then(|| project_name.trim().to_string());
        self
    }

    // 生成最小通知任务；SSH 不携带 cwd，仅使用注入的项目显示名。
    pub fn to_notification_job(&self) -> HookNotificationJob {
        let is_ssh = self.environment_type.as_deref() == Some("ssh");
        HookNotificationJob {
            source: self.source.clone(),
            event: self.event.clone(),
            cwd: (!is_ssh).then(|| self.cwd.clone()).flatten(),
            project: is_ssh.then(|| self.remote_project_name.clone()).flatten(),
            timestamp: self.timestamp.clone(),
        }
    }
}

// 裁剪可选字符串，并将空白值转换为 None。
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ApprovalScope {
    tab_id: String,
    source: String,
    environment: String,
    session_id: Option<String>,
    agent_id: String,
}

impl ApprovalScope {
    // 严格比较标签、来源、环境及可选父会话，缺失会话不是通配符。
    fn same_parent(&self, payload: &ClaudeHookPayload) -> bool {
        if self.tab_id != payload.tab_id
            || self.source != payload.source
            || self.environment != payload.approval_environment()
        {
            return false;
        }
        self.session_id.as_deref() == non_empty(payload.session_id.as_deref())
    }

    // 在同父范围匹配基础上要求子 Agent 标识相同。
    fn same_child(&self, payload: &ClaudeHookPayload) -> bool {
        self.same_parent(payload)
            && non_empty(payload.agent_id.as_deref()) == Some(self.agent_id.as_str())
    }
}

struct ProvisionalApproval {
    payload: ClaudeHookPayload,
    scope: ApprovalScope,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    event_id: Option<String>,
    transcript_baselines: Vec<TranscriptBaseline>,
    deadline: Instant,
}

struct TranscriptBaseline {
    path: PathBuf,
    bytes: Option<u64>,
}

impl ProvisionalApproval {
    // 捕获可信原生转录的独立字节基线及审批截止时间，WSL UNC 不读取元数据。
    fn from_payload(payload: ClaudeHookPayload, now: Instant) -> Self {
        let payload_baseline_path = payload.approval_payload_baseline_path();
        let transcript_baselines = payload
            .approval_transcript_paths()
            .into_iter()
            .map(|path| {
                let bytes = if is_wsl_unc_path(&path) {
                    None
                } else if payload_baseline_path.as_ref() == Some(&path) {
                    payload
                        .transcript_bytes
                        .or_else(|| fs::metadata(&path).ok().map(|metadata| metadata.len()))
                } else {
                    fs::metadata(&path).ok().map(|metadata| metadata.len())
                };
                TranscriptBaseline { path, bytes }
            })
            .collect();
        Self {
            scope: payload
                .approval_scope()
                .expect("ambiguous child approval must have an agent id"),
            tool_use_id: non_empty(payload.tool_use_id.as_deref()).map(str::to_string),
            tool_name: non_empty(payload.tool_name.as_deref()).map(str::to_string),
            event_id: non_empty(payload.remote_event_id.as_deref()).map(str::to_string),
            transcript_baselines,
            deadline: now + PROVISIONAL_APPROVAL_GRACE,
            payload,
        }
    }

    // 检查有字节基线的转录候选是否增长，元数据失败视为无进度。
    fn transcript_progressed(&self) -> bool {
        self.transcript_baselines.iter().any(|candidate| {
            candidate.bytes.is_some_and(|baseline| {
                fs::metadata(&candidate.path)
                    .map(|metadata| metadata.len() > baseline)
                    .unwrap_or(false)
            })
        })
    }

    // 要求审批请求属于同一子范围，并按工具 ID 优先、名称回退匹配。
    fn matches_request(&self, payload: &ClaudeHookPayload) -> bool {
        if !self.scope.same_child(payload) {
            return false;
        }
        matches_approval_tool(
            self.tool_use_id.as_deref(),
            self.tool_name.as_deref(),
            payload,
        )
    }
}

struct ApprovalProgressTombstone {
    scope: ApprovalScope,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    expires_at: Instant,
}

impl ApprovalProgressTombstone {
    // 为带工具 ID 或名称的子范围事件创建短期进度记录。
    fn from_payload(payload: &ClaudeHookPayload, now: Instant) -> Option<Self> {
        let tool_use_id = non_empty(payload.tool_use_id.as_deref()).map(str::to_string);
        let tool_name = non_empty(payload.tool_name.as_deref()).map(str::to_string);
        if tool_use_id.is_none() && tool_name.is_none() {
            return None;
        }
        Some(Self {
            scope: payload.approval_scope()?,
            tool_use_id,
            tool_name,
            expires_at: now + APPROVAL_PROGRESS_TOMBSTONE_TTL,
        })
    }

    // 要求进度记录与审批请求属于同一子范围及同一工具。
    fn matches_request(&self, payload: &ClaudeHookPayload) -> bool {
        if !self.scope.same_child(payload) {
            return false;
        }
        matches_approval_tool(
            self.tool_use_id.as_deref(),
            self.tool_name.as_deref(),
            payload,
        )
    }

    // 精确比较进度记录的审批范围、工具 ID 和工具名称。
    fn same_identity(&self, other: &Self) -> bool {
        self.scope == other.scope
            && self.tool_use_id == other.tool_use_id
            && self.tool_name == other.tool_name
    }
}

// 双方都有工具 ID 时精确比较，否则只允许非空工具名精确匹配。
fn matches_approval_tool(
    expected_tool_use_id: Option<&str>,
    expected_tool_name: Option<&str>,
    payload: &ClaudeHookPayload,
) -> bool {
    let incoming_tool_use_id = non_empty(payload.tool_use_id.as_deref());
    if let (Some(expected), Some(actual)) = (expected_tool_use_id, incoming_tool_use_id) {
        return expected == actual;
    }
    let incoming_tool_name = non_empty(payload.tool_name.as_deref());
    matches!(
        (expected_tool_name, incoming_tool_name),
        (Some(expected), Some(actual)) if expected == actual
    )
}

// 通过共享 UNC 解析器识别指定路径是否属于 WSL。
fn is_wsl_unc_path(path: &std::path::Path) -> bool {
    crate::wsl::parse_wsl_unc_path(&path.to_string_lossy()).is_some()
}

#[derive(Default)]
struct ApprovalArbiterState {
    pending: VecDeque<ProvisionalApproval>,
    recent_progress: VecDeque<ApprovalProgressTombstone>,
}

impl ApprovalArbiterState {
    // 先用新事件消解待定审批，再轮询到期项；内部进度仅记录，模糊审批入有界队列。
    fn accept(&mut self, payload: ClaudeHookPayload, now: Instant) -> Vec<ClaudeHookPayload> {
        self.prune_progress(now);
        let resolved = self.resolve_from_event(&payload);
        let mut deliver = self.poll(now);
        if payload.is_internal_codex_tool_progress() {
            if resolved == 0 {
                self.record_progress(&payload, now);
            }
            return deliver;
        }
        if !payload.is_ambiguous_codex_child_approval() {
            deliver.push(payload);
            return deliver;
        }

        if let Some(index) = self
            .recent_progress
            .iter()
            .position(|progress| progress.matches_request(&payload))
        {
            self.recent_progress.remove(index);
            debug!(
                "resolved provisional child approval from earlier hook progress: event_id={}",
                payload.remote_event_id.as_deref().unwrap_or("unknown")
            );
            return deliver;
        }

        if self.pending.len() >= MAX_PROVISIONAL_APPROVALS {
            if let Some(oldest) = self.pending.pop_front() {
                warn!(
                    "provisional approval capacity reached; delivering oldest event id={}",
                    oldest.event_id.as_deref().unwrap_or("unknown")
                );
                deliver.push(oldest.payload);
            }
        }
        self.pending
            .push_back(ProvisionalApproval::from_payload(payload, now));
        deliver
    }

    // 先清理过期进度，再消解转录增长的审批，投递到期项并保留其余项。
    fn poll(&mut self, now: Instant) -> Vec<ClaudeHookPayload> {
        self.prune_progress(now);
        let mut retained = VecDeque::with_capacity(self.pending.len());
        let mut deliver = Vec::new();
        while let Some(pending) = self.pending.pop_front() {
            if pending.transcript_progressed() {
                debug!(
                    "resolved provisional child approval from rollout progress: event_id={}",
                    pending.event_id.as_deref().unwrap_or("unknown")
                );
            } else if now >= pending.deadline {
                debug!(
                    "escalating unresolved provisional child approval: event_id={}",
                    pending.event_id.as_deref().unwrap_or("unknown")
                );
                deliver.push(pending.payload);
            } else {
                retained.push_back(pending);
            }
        }
        self.pending = retained;
        deliver
    }

    // 移除已到期的工具进度记录。
    fn prune_progress(&mut self, now: Instant) {
        self.recent_progress
            .retain(|progress| now < progress.expires_at);
    }

    // 更新同身份进度记录，并在容量达到上限时淘汰最旧记录。
    fn record_progress(&mut self, payload: &ClaudeHookPayload, now: Instant) {
        let Some(progress) = ApprovalProgressTombstone::from_payload(payload, now) else {
            return;
        };
        self.recent_progress
            .retain(|existing| !existing.same_identity(&progress));
        if self.recent_progress.len() >= MAX_APPROVAL_PROGRESS_TOMBSTONES {
            self.recent_progress.pop_front();
        }
        self.recent_progress.push_back(progress);
    }

    // 按父范围、子范围或工具身份消解匹配审批，返回移除数量。
    fn resolve_from_event(&mut self, payload: &ClaudeHookPayload) -> usize {
        let event = payload.event.as_str();
        let before = self.pending.len();
        self.pending.retain(|pending| {
            let resolved = match event {
                "UserPromptSubmit" | "Stop" | "StopFailure" => pending.scope.same_parent(payload),
                "SubagentStop" => pending.scope.same_child(payload),
                "ToolStart" | "ToolStop" | "AgentToolStart" | "AgentToolStop"
                | "PermissionRequest" => pending.matches_request(payload),
                _ => false,
            };
            if resolved {
                debug!(
                    "resolved provisional child approval from hook progress: event_id={}",
                    pending.event_id.as_deref().unwrap_or("unknown")
                );
            }
            !resolved
        });
        before.saturating_sub(self.pending.len())
    }
}

struct ApprovalArbiter {
    state: Mutex<ApprovalArbiterState>,
    delivery: HookPayloadSink,
}

impl ApprovalArbiter {
    // 在锁内仲裁载荷，锁中毒时转为立即投递待定项及当前载荷。
    fn submit(&self, payload: ClaudeHookPayload) {
        let deliver = match self.state.lock() {
            Ok(mut state) => state.accept(payload, Instant::now()),
            Err(poisoned) => {
                warn!("approval arbiter state poisoned; delivering retained events immediately");
                let mut state = poisoned.into_inner();
                let mut deliver = state
                    .pending
                    .drain(..)
                    .map(|pending| pending.payload)
                    .collect::<Vec<_>>();
                deliver.push(payload);
                deliver
            }
        };
        self.deliver_all(deliver);
    }

    // 在锁内轮询待定审批，锁中毒时清空待定项并在锁外投递。
    fn poll(&self) {
        let deliver = match self.state.lock() {
            Ok(mut state) => state.poll(Instant::now()),
            Err(poisoned) => {
                warn!("approval arbiter state poisoned; delivering retained events immediately");
                poisoned
                    .into_inner()
                    .pending
                    .drain(..)
                    .map(|pending| pending.payload)
                    .collect()
            }
        };
        self.deliver_all(deliver);
    }

    // 按列表顺序将待投递载荷交给共享出口。
    fn deliver_all(&self, payloads: Vec<ClaudeHookPayload>) {
        for payload in payloads {
            (self.delivery)(payload);
        }
    }
}

// 创建带弱引用轮询线程的审批出口，线程启动失败时返回原出口。
pub fn approval_aware_hook_sink(delivery: HookPayloadSink) -> HookPayloadSink {
    let arbiter = Arc::new(ApprovalArbiter {
        state: Mutex::new(ApprovalArbiterState::default()),
        delivery: Arc::clone(&delivery),
    });
    let weak = Arc::downgrade(&arbiter);
    if thread::Builder::new()
        .name("hook-approval-arbiter".to_string())
        .spawn(move || loop {
            thread::sleep(PROVISIONAL_APPROVAL_POLL_INTERVAL);
            let Some(arbiter) = weak.upgrade() else {
                break;
            };
            arbiter.poll();
        })
        .is_err()
    {
        warn!("approval arbiter worker failed to start; approvals will be delivered immediately");
        return delivery;
    }
    Arc::new(move |payload| arbiter.submit(payload))
}

/// 在给定 listener 上跑 hook HTTP 服务：解析/鉴权/校验后把 payload 交给 sink。
/// daemon 与主进程共用（Issue #123 Phase 2）。
// 启动 HTTP 接收线程并为每个连接派生处理线程，共享近期事件去重状态。
pub fn spawn_hook_listener(listener: TcpListener, token: String, sink: HookPayloadSink) {
    let recent_events = Arc::new(Mutex::new(RecentHookEvents::default()));
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let token = token.clone();
                    let sink = Arc::clone(&sink);
                    let recent_events = Arc::clone(&recent_events);
                    thread::spawn(move || handle_stream(stream, sink, &token, recent_events));
                }
                Err(err) => warn!("cli hook bridge accept failed: {}", err),
            }
        }
    });
}

// 读取请求并检查路由、Bearer 和载荷，去重后交给出口并回复成功。
fn handle_stream(
    mut stream: TcpStream,
    sink: HookPayloadSink,
    token: &str,
    recent_events: Arc<Mutex<RecentHookEvents>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(status) => {
            write_response(&mut stream, status, "bad request");
            return;
        }
    };

    if request.method != "POST" || request.path != REQUEST_PATH {
        write_response(&mut stream, "404 Not Found", "not found");
        return;
    }

    let expected_auth = format!("Bearer {token}");
    if request
        .headers
        .get("authorization")
        .map(|value| value.as_str())
        != Some(expected_auth.as_str())
    {
        write_response(&mut stream, "401 Unauthorized", "unauthorized");
        return;
    }

    let payload = match serde_json::from_slice::<ClaudeHookRequest>(&request.body) {
        Ok(payload) => payload,
        Err(err) => {
            debug!("cli hook bridge payload parse failed: {}", err);
            write_response(&mut stream, "400 Bad Request", "invalid json");
            return;
        }
    };

    if !is_valid_payload(&payload) {
        write_response(&mut stream, "400 Bad Request", "invalid payload");
        return;
    }

    let accepted = recent_events
        .lock()
        .map(|mut recent| recent.accept(payload.remote_event_id.as_deref()))
        .unwrap_or(true);
    if !accepted {
        write_response(&mut stream, "204 No Content", "");
        return;
    }

    log_hook_payload_diagnostic(&payload);

    let payload = ClaudeHookPayload {
        tab_id: payload.tab_id,
        source: normalize_source(payload.source.as_deref()).to_string(),
        event: payload.event,
        title: payload.title,
        message: payload.message,
        session_id: payload.session_id,
        cwd: payload.cwd,
        timestamp: payload.timestamp,
        agent_id: payload.agent_id,
        tool_use_id: payload.tool_use_id,
        tool_name: payload.tool_name,
        mcp_server: payload.mcp_server,
        skill_name: payload.skill_name,
        agent_type: payload.agent_type,
        agent_transcript_path: payload.agent_transcript_path,
        transcript_path: payload.transcript_path,
        transcript_bytes: payload.transcript_bytes,
        reasoning_effort: payload.reasoning_effort,
        wsl_distro_name: payload.wsl_distro_name,
        environment_type: payload.environment_type,
        remote_host_id: payload.remote_host_id,
        remote_project_id: payload.remote_project_id,
        remote_project_name: None,
        remote_transcript_ref: payload.remote_transcript_ref,
        remote_agent_transcript_ref: payload.remote_agent_transcript_ref,
        remote_event_id: payload.remote_event_id,
        remote_sequence: payload.remote_sequence,
    };

    sink(payload);

    write_response(&mut stream, "204 No Content", "");
}

// 校验远端字段并转换为 SSH 载荷，清除本地转录字段及消息内容。
pub fn remote_hook_payload_from_spool(
    value: &serde_json::Value,
) -> Result<ClaudeHookPayload, String> {
    for key in [
        "tabId",
        "source",
        "event",
        "sessionId",
        "agentId",
        "toolUseId",
        "toolName",
        "mcpServer",
        "skillName",
        "agentType",
        "hostId",
        "projectId",
        "eventId",
    ] {
        if value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| text.len() > 256 || text.contains(['\0', '\r', '\n']))
        {
            return Err("remote_hook_payload_invalid".to_string());
        }
    }
    for key in ["remoteCwd", "remoteTranscriptRef", "agentTranscriptPath"] {
        if value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| text.len() > 4096 || text.contains(['\0', '\r', '\n']))
        {
            return Err("remote_hook_payload_invalid".to_string());
        }
    }
    let string = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let occurred_at = value
        .get("occurredAt")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default();
    let request = ClaudeHookRequest {
        tab_id: string("tabId").ok_or_else(|| "remote_hook_tab_missing".to_string())?,
        source: string("source"),
        event: string("event").ok_or_else(|| "remote_hook_event_missing".to_string())?,
        title: None,
        message: None,
        session_id: string("sessionId"),
        cwd: string("remoteCwd"),
        timestamp: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(occurred_at as i64)
            .map(|value| value.to_rfc3339()),
        agent_id: string("agentId"),
        tool_use_id: string("toolUseId"),
        tool_name: string("toolName"),
        mcp_server: string("mcpServer"),
        skill_name: string("skillName"),
        agent_type: string("agentType"),
        agent_transcript_path: None,
        transcript_path: None,
        transcript_bytes: None,
        reasoning_effort: string("reasoningEffort"),
        wsl_distro_name: None,
        environment_type: Some("ssh".to_string()),
        remote_host_id: string("hostId"),
        remote_project_id: string("projectId"),
        remote_transcript_ref: string("remoteTranscriptRef"),
        remote_agent_transcript_ref: string("agentTranscriptPath"),
        remote_event_id: string("eventId"),
        remote_sequence: value.get("sequence").and_then(serde_json::Value::as_u64),
    };
    if !is_valid_payload(&request) {
        return Err("remote_hook_payload_invalid".to_string());
    }
    Ok(ClaudeHookPayload {
        tab_id: request.tab_id,
        source: normalize_source(request.source.as_deref()).to_string(),
        event: request.event,
        title: request.title,
        message: request.message,
        session_id: request.session_id,
        cwd: request.cwd,
        timestamp: request.timestamp,
        agent_id: request.agent_id,
        tool_use_id: request.tool_use_id,
        tool_name: request.tool_name,
        mcp_server: request.mcp_server,
        skill_name: request.skill_name,
        agent_type: request.agent_type,
        agent_transcript_path: None,
        transcript_path: None,
        transcript_bytes: None,
        reasoning_effort: request.reasoning_effort,
        wsl_distro_name: None,
        environment_type: request.environment_type,
        remote_host_id: request.remote_host_id,
        remote_project_id: request.remote_project_id,
        remote_project_name: None,
        remote_transcript_ref: request.remote_transcript_ref,
        remote_agent_transcript_ref: request.remote_agent_transcript_ref,
        remote_event_id: request.remote_event_id,
        remote_sequence: request.remote_sequence,
    })
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

// 增量读取 HTTP 头和定长请求体，解析头字段并检查配置的长度门槛。
fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, &'static str> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let bytes_read = stream.read(&mut chunk).map_err(|_| "400 Bad Request")?;
        if bytes_read == 0 {
            return Err("400 Bad Request");
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
            return Err("413 Payload Too Large");
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("431 Request Header Fields Too Large");
        }
    };

    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("400 Bad Request")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().ok_or("400 Bad Request")?.to_string();
    let path = request_parts.next().ok_or("400 Bad Request")?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .ok_or("411 Length Required")?
        .parse::<usize>()
        .map_err(|_| "400 Bad Request")?;
    if content_length > MAX_BODY_BYTES {
        return Err("413 Payload Too Large");
    }

    let body_start = header_end + 4;
    while buffer.len().saturating_sub(body_start) < content_length {
        let bytes_read = stream.read(&mut chunk).map_err(|_| "400 Bad Request")?;
        if bytes_read == 0 {
            return Err("400 Bad Request");
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.len().saturating_sub(body_start) > MAX_BODY_BYTES {
            return Err("413 Payload Too Large");
        }
    }

    let body = buffer[body_start..body_start + content_length].to_vec();
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

// 查找首个 CRLF 空行分隔符的位置。
fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

// 验证标签与可选事件 ID 长度，并按来源白名单检查事件名称。
fn is_valid_payload(payload: &ClaudeHookRequest) -> bool {
    let tab_id = payload.tab_id.trim();
    if tab_id.is_empty() || tab_id.len() > 128 {
        return false;
    }
    if payload
        .remote_event_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty() || value.len() > 128)
    {
        return false;
    }

    match normalize_source(payload.source.as_deref()) {
        "claude" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "Notification"
                | "Stop"
                | "StopFailure"
                | "SubagentStart"
                | "SubagentStop"
                | "AgentToolStart"
                | "AgentToolStop"
                | "ToolStart"
                | "ToolStop"
        ),
        "grok" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "Notification"
                | "PermissionRequest"
                | "Stop"
                | "StopFailure"
                | "SubagentStart"
                | "SubagentStop"
                | "AgentToolStart"
                | "AgentToolStop"
                | "ToolStart"
                | "ToolStop"
        ),
        "codex" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "Notification"
                | "PermissionRequest"
                | "Stop"
                | "SubagentStart"
                | "SubagentStop"
                | "ToolStart"
                | "ToolStop"
        ),
        "kimi" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "PermissionRequest"
                | "PermissionResult"
                | "Stop"
                | "Interrupt"
                | "StopFailure"
                | "SubagentStart"
                | "SubagentStop"
        ),
        "pi" => matches!(
            payload.event.as_str(),
            "SessionStart" | "UserPromptSubmit" | "Stop"
        ),
        "opencode" => matches!(
            payload.event.as_str(),
            "SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure"
        ),
        _ => false,
    }
}

// 记录指定工具及子 Agent 事件诊断；AgentTool 事件另输出完整载荷 JSON。
fn log_hook_payload_diagnostic(payload: &ClaudeHookRequest) {
    if !matches!(
        payload.event.as_str(),
        "SubagentStart"
            | "SubagentStop"
            | "AgentToolStart"
            | "AgentToolStop"
            | "ToolStart"
            | "ToolStop"
            | "Notification"
    ) {
        return;
    }

    debug!(
        "cli hook payload diagnostic: source={} event={} tabId={} sessionId={:?} agentId={:?} toolUseId={:?} toolName={:?} mcpServer={:?} skillName={:?} agentType={:?} hasAgentTranscriptPath={} hasTranscriptPath={} wslDistro={:?} cwd={:?}",
        normalize_source(payload.source.as_deref()),
        payload.event,
        payload.tab_id,
        payload.session_id,
        payload.agent_id,
        payload.tool_use_id,
        payload.tool_name,
        payload.mcp_server,
        payload.skill_name,
        payload.agent_type,
        payload
            .agent_transcript_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        payload
            .transcript_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        payload.wsl_distro_name,
        payload.cwd,
    );

    // AgentTool 事件详细诊断：记录完整 payload JSON 以定位 Claude Code 实际字段。
    if matches!(payload.event.as_str(), "AgentToolStart" | "AgentToolStop") {
        if let Ok(full_json) = serde_json::to_string_pretty(payload) {
            debug!(
                "[agent_tool_diagnostic] {} full payload:\n{}",
                payload.event, full_json
            );
        }
    }
}

// 保留已知来源，缺省兼容 Claude，未知显式来源映射为空字符串。
fn normalize_source(source: Option<&str>) -> &str {
    match source {
        Some("codex") => "codex",
        Some("pi") => "pi",
        Some("grok") => "grok",
        Some("kimi") => "kimi",
        Some("opencode") => "opencode",
        Some("claude") | None => "claude",
        _ => "",
    }
}

// 尽力写入带长度和关闭连接头的纯文本 HTTP 响应。
fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod validation_tests {
    use super::{
        is_valid_payload, normalize_source, ClaudeHookRequest, RecentHookEvents,
        RECENT_HOOK_EVENT_LIMIT,
    };
    use serde_json::json;

    #[test]
    // 验证 Grok 来源保持不变且所有支持事件均通过接纳检查。
    fn normalizes_and_accepts_grok_hook_events() {
        assert_eq!(normalize_source(Some("grok")), "grok");

        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Notification",
            "PermissionRequest",
            "Stop",
            "StopFailure",
            "SubagentStart",
            "SubagentStop",
            "AgentToolStart",
            "AgentToolStop",
            "ToolStart",
            "ToolStop",
        ] {
            let request: ClaudeHookRequest = serde_json::from_value(json!({
                "tabId": "external:grok:session",
                "source": "grok",
                "event": event,
            }))
            .expect("test payload should deserialize");
            assert!(
                is_valid_payload(&request),
                "Grok event should be valid: {event}"
            );
        }
    }

    #[test]
    // 验证 Grok 未知事件被拒绝。
    fn rejects_unknown_grok_hook_events() {
        let request: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "external:grok:session",
            "source": "grok",
            "event": "UnknownEvent",
        }))
        .expect("test payload should deserialize");

        assert!(!is_valid_payload(&request));
    }

    #[test]
    // 验证 Codex 内部工具开始、结束事件通过载荷接纳检查。
    fn accepts_codex_internal_tool_progress_events() {
        for event in ["ToolStart", "ToolStop"] {
            let request: ClaudeHookRequest = serde_json::from_value(json!({
                "tabId": "tab-codex",
                "source": "codex",
                "event": event,
            }))
            .expect("test payload should deserialize");
            assert!(
                is_valid_payload(&request),
                "Codex event should be valid: {event}"
            );
        }
    }

    #[test]
    // 验证 Kimi 九类桥接事件可接纳，而 SessionEnd 被拒绝。
    fn normalizes_and_accepts_only_kimi_bridge_events() {
        assert_eq!(normalize_source(Some("kimi")), "kimi");
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "PermissionResult",
            "Stop",
            "Interrupt",
            "StopFailure",
            "SubagentStart",
            "SubagentStop",
        ] {
            let request: ClaudeHookRequest = serde_json::from_value(json!({
                "tabId": "external:kimi:session",
                "source": "kimi",
                "event": event,
            }))
            .unwrap();
            assert!(
                is_valid_payload(&request),
                "Kimi event should be valid: {event}"
            );
        }
        let request: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "external:kimi:session",
            "source": "kimi",
            "event": "SessionEnd",
        }))
        .unwrap();
        assert!(!is_valid_payload(&request));
    }

    #[test]
    // 验证 OpenCode 来源及四类会话生命周期事件被接受。
    fn normalizes_and_accepts_opencode_session_events() {
        assert_eq!(normalize_source(Some("opencode")), "opencode");
        for event in ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"] {
            let request: ClaudeHookRequest = serde_json::from_value(json!({
                "tabId": "external:opencode:session",
                "source": "opencode",
                "event": event,
                "sessionId": "session-1",
            }))
            .expect("test payload should deserialize");
            assert!(
                is_valid_payload(&request),
                "OpenCode event should be valid: {event}"
            );
        }
    }

    #[test]
    // 验证 Codex 提问 Notification 可接纳，未知事件不可接纳。
    fn accepts_codex_question_notification_and_rejects_unknown_event() {
        let notification: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "external:codex:session",
            "source": "codex",
            "event": "Notification",
            "toolName": "request_user_input",
        }))
        .expect("test payload should deserialize");
        assert!(is_valid_payload(&notification));

        let unknown: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "external:codex:session",
            "source": "codex",
            "event": "UnknownEvent",
        }))
        .expect("test payload should deserialize");
        assert!(!is_valid_payload(&unknown));
    }

    #[test]
    // 验证非空事件 ID 去重、旧式无 ID 接纳及容量淘汰后的再次接纳。
    fn deduplicates_bounded_hook_event_ids() {
        let mut recent = RecentHookEvents::default();
        assert!(recent.accept(Some("event-1")));
        assert!(!recent.accept(Some("event-1")));
        assert!(recent.accept(None));

        for index in 0..=RECENT_HOOK_EVENT_LIMIT {
            assert!(recent.accept(Some(&format!("event-{index}-next"))));
        }
        assert!(recent.accept(Some("event-1")));
    }

    #[test]
    // 验证显式空事件 ID 被载荷校验拒绝。
    fn rejects_invalid_hook_event_id() {
        let request: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "tab",
            "source": "grok",
            "event": "SessionStart",
            "remoteEventId": ""
        }))
        .expect("test payload should deserialize");
        assert!(!is_valid_payload(&request));
    }
}

#[cfg(test)]
mod remote_tests {
    use super::{remote_hook_payload_from_spool, ApprovalArbiterState};
    use serde_json::json;
    use std::time::Instant;

    // 构造带远端私有 cwd 的指定来源停止载荷，供通知最小化测试使用。
    fn remote_notification_job(source: &str) -> super::ClaudeHookPayload {
        let payload = remote_hook_payload_from_spool(&json!({
            "kind": "hookEvent",
            "eventId": "00000000-0000-4000-8000-000000000001",
            "sequence": 1,
            "hostId": "host",
            "projectId": "project",
            "tabId": "00000000-0000-4000-8000-000000000002",
            "source": source,
            "event": "Stop",
            "remoteCwd": "/srv/private-project",
            "occurredAt": 1
        }))
        .unwrap();
        payload
    }

    // 构造指定来源及工具名的远端提问 Notification 夹具。
    fn remote_question_notification(source: &str, tool_name: &str) -> super::ClaudeHookPayload {
        remote_hook_payload_from_spool(&json!({
            "kind": "hookEvent",
            "eventId": "00000000-0000-4000-8000-000000000001",
            "sequence": 1,
            "hostId": "host",
            "projectId": "project",
            "tabId": "00000000-0000-4000-8000-000000000002",
            "source": source,
            "event": "Notification",
            "toolName": tool_name,
            "remoteCwd": "/srv/private-project",
            "occurredAt": 1
        }))
        .unwrap()
    }

    // 构造带子 Agent 和工具信息的远端 Codex 审批夹具。
    fn remote_codex_permission_request() -> super::ClaudeHookPayload {
        remote_hook_payload_from_spool(&json!({
            "kind": "hookEvent",
            "eventId": "00000000-0000-4000-8000-000000000003",
            "sequence": 2,
            "hostId": "host",
            "projectId": "project",
            "tabId": "00000000-0000-4000-8000-000000000002",
            "source": "codex",
            "event": "PermissionRequest",
            "sessionId": "session-1",
            "agentId": "child-1",
            "toolName": "apply_patch",
            "remoteCwd": "/srv/private-project",
            "occurredAt": 1
        }))
        .unwrap()
    }

    #[test]
    // 验证精确 Claude、Codex 提问工具需要用户响应，普通工具不需要。
    fn question_notifications_require_user_response() {
        assert!(remote_question_notification("claude", "AskUserQuestion").requires_user_response());
        assert!(
            remote_question_notification("codex", "request_user_input").requires_user_response()
        );
        assert!(!remote_question_notification("codex", "Read").requires_user_response());
    }

    #[test]
    // 验证远端 Claude 通知移除 cwd 并保留注入的侧栏项目名。
    fn remote_claude_notification_omits_cwd_and_keeps_safe_project_label() {
        let payload = remote_notification_job("claude")
            .with_remote_project_name("Sidebar Project".to_string());
        let job = payload.to_notification_job();
        assert_eq!(job.cwd, None);
        assert_eq!(job.project.as_deref(), Some("Sidebar Project"));
    }

    #[test]
    // 验证远端 Codex 通知移除 cwd 并保留注入的侧栏项目名。
    fn remote_codex_notification_omits_cwd_and_keeps_safe_project_label() {
        let payload = remote_notification_job("codex")
            .with_remote_project_name("Sidebar Project".to_string());
        let job = payload.to_notification_job();
        assert_eq!(job.cwd, None);
        assert_eq!(job.project.as_deref(), Some("Sidebar Project"));
    }

    #[test]
    // 验证 spool 转换的 SSH 子审批立即投递，不进入待定队列。
    fn ssh_codex_permission_request_bypasses_provisional_approval() {
        let mut state = ApprovalArbiterState::default();
        let delivered = state.accept(remote_codex_permission_request(), Instant::now());
        assert_eq!(delivered.len(), 1);
        assert!(state.pending.is_empty());
    }
}

#[cfg(test)]
mod approval_tests {
    use super::{
        approval_aware_hook_sink, ApprovalArbiterState, ClaudeHookPayload, HookPayloadSink,
        TranscriptBaseline, APPROVAL_PROGRESS_TOMBSTONE_TTL, PROVISIONAL_APPROVAL_GRACE,
    };
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // 构造本地 Codex 审批测试载荷，默认同标签、父会话并使用独立事件 ID。
    fn payload(
        event: &str,
        agent_id: Option<&str>,
        message: Option<&str>,
        tool_name: Option<&str>,
    ) -> ClaudeHookPayload {
        ClaudeHookPayload {
            tab_id: "tab-1".to_string(),
            source: "codex".to_string(),
            event: event.to_string(),
            title: None,
            message: message.map(str::to_string),
            session_id: Some("session-1".to_string()),
            cwd: None,
            timestamp: None,
            agent_id: agent_id.map(str::to_string),
            tool_use_id: None,
            tool_name: tool_name.map(str::to_string),
            mcp_server: None,
            skill_name: None,
            agent_type: None,
            agent_transcript_path: None,
            transcript_path: None,
            transcript_bytes: None,
            reasoning_effort: None,
            wsl_distro_name: None,
            environment_type: None,
            remote_host_id: None,
            remote_project_id: None,
            remote_project_name: None,
            remote_transcript_ref: None,
            remote_agent_transcript_ref: None,
            remote_event_id: Some(uuid::Uuid::new_v4().to_string()),
            remote_sequence: None,
        }
    }

    #[test]
    // 验证没有子 Agent 的主会话审批立即投递。
    fn main_agent_permission_is_delivered_immediately() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        let delivered = state.accept(
            payload("PermissionRequest", None, None, Some("apply_patch")),
            now,
        );
        assert_eq!(delivered.len(), 1);
        assert!(state.pending.is_empty());
    }

    #[test]
    // 验证带明确消息的子 Agent 审批立即投递。
    fn explicit_child_permission_is_delivered_immediately() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        let delivered = state.accept(
            payload(
                "PermissionRequest",
                Some("child-1"),
                Some("Allow this command?"),
                Some("Bash"),
            ),
            now,
        );
        assert_eq!(delivered.len(), 1);
        assert!(state.pending.is_empty());
    }

    #[test]
    // 验证无消息的 Codex 子审批进入待定队列而不立即投递。
    fn ambiguous_child_permission_waits_for_positive_evidence() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        let delivered = state.accept(
            payload(
                "PermissionRequest",
                Some("child-1"),
                None,
                Some("apply_patch"),
            ),
            now,
        );
        assert!(delivered.is_empty());
        assert_eq!(state.pending.len(), 1);
    }

    #[test]
    // 手动注入临时转录基线，验证文件增长消解待定审批而不投递。
    fn rollout_growth_resolves_ambiguous_child_permission() {
        let temp = tempfile::tempdir().unwrap();
        let transcript = temp.path().join("rollout.jsonl");
        fs::write(&transcript, b"before").unwrap();
        let baseline = fs::metadata(&transcript).unwrap().len();
        let now = Instant::now();
        let mut pending = payload(
            "PermissionRequest",
            Some("child-1"),
            None,
            Some("apply_patch"),
        );
        pending.transcript_path = Some(transcript.to_string_lossy().to_string());
        pending.transcript_bytes = Some(baseline);
        let mut state = ApprovalArbiterState::default();
        assert!(state.accept(pending, now).is_empty());
        // The path is intentionally outside the trusted transcript roots in this
        // synthetic test. Seed the rollout state directly to exercise polling.
        state.pending[0].transcript_baselines = vec![TranscriptBaseline {
            path: transcript.clone(),
            bytes: Some(baseline),
        }];

        OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap()
            .write_all(b"\nafter")
            .unwrap();
        assert!(state.poll(now + PROVISIONAL_APPROVAL_GRACE).is_empty());
        assert!(state.pending.is_empty());
    }

    #[test]
    // 验证显式 SSH 子审批绕过本地延迟仲裁。
    fn ssh_child_permission_is_delivered_immediately() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        let mut remote = payload(
            "PermissionRequest",
            Some("child-1"),
            None,
            Some("apply_patch"),
        );
        remote.environment_type = Some("ssh".to_string());
        assert_eq!(state.accept(remote, now).len(), 1);
        assert!(state.pending.is_empty());
    }

    #[test]
    // 验证共享审批出口同步转发 SSH 事件至内存测试出口。
    fn global_approval_sink_forwards_ssh_permission_immediately() {
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&delivered);
        let delivery: HookPayloadSink = Arc::new(move |payload| {
            target.lock().unwrap().push(payload.tab_id().to_string());
        });
        let sink = approval_aware_hook_sink(delivery);
        let mut remote = payload(
            "PermissionRequest",
            Some("child-1"),
            None,
            Some("apply_patch"),
        );
        remote.environment_type = Some("ssh".to_string());
        sink(remote);
        assert_eq!(delivered.lock().unwrap().as_slice(), ["tab-1"]);
    }

    #[test]
    // 验证来源、环境或可选父会话不匹配的事件不能消解已有审批。
    fn foreign_source_environment_or_missing_session_cannot_resolve_pending_approval() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        assert!(state
            .accept(
                payload(
                    "PermissionRequest",
                    Some("child-1"),
                    None,
                    Some("apply_patch")
                ),
                now,
            )
            .is_empty());

        let mut other_source = payload("ToolStop", Some("child-1"), None, Some("apply_patch"));
        other_source.source = "claude".to_string();
        assert_eq!(state.accept(other_source, now).len(), 1);
        assert_eq!(state.pending.len(), 1);

        let mut other_environment = payload("ToolStop", Some("child-1"), None, Some("apply_patch"));
        other_environment.environment_type = Some("wsl".to_string());
        assert!(state.accept(other_environment, now).is_empty());
        assert_eq!(state.pending.len(), 1);

        let mut missing_session = payload("Stop", None, None, None);
        missing_session.session_id = None;
        assert_eq!(state.accept(missing_session, now).len(), 1);
        assert_eq!(state.pending.len(), 1);
    }

    #[test]
    // 验证 WSL 转录候选保留路径但不采集 UNC 元数据字节基线。
    fn wsl_transcript_path_is_trusted_without_unc_metadata_polling() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        let mut pending = payload(
            "PermissionRequest",
            Some("child-1"),
            None,
            Some("apply_patch"),
        );
        pending.environment_type = Some("wsl".to_string());
        pending.wsl_distro_name = Some("Ubuntu".to_string());
        pending.agent_transcript_path =
            Some("/home/test/.codex/sessions/session.jsonl".to_string());
        pending.transcript_bytes = Some(123);
        assert!(state.accept(pending, now).is_empty());
        assert_eq!(state.pending[0].transcript_baselines.len(), 1);
        assert_eq!(state.pending[0].transcript_baselines[0].bytes, None);
    }

    #[test]
    // 验证无效子转录不会阻止独立有效父转录候选进入仲裁。
    fn invalid_child_transcript_falls_back_to_trusted_parent_candidate() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        let mut pending = payload(
            "PermissionRequest",
            Some("child-1"),
            None,
            Some("apply_patch"),
        );
        pending.environment_type = Some("wsl".to_string());
        pending.wsl_distro_name = Some("Ubuntu".to_string());
        pending.agent_transcript_path = Some(r"C:\temp\untrusted.jsonl".to_string());
        pending.transcript_path = Some("/home/test/.codex/sessions/parent.jsonl".to_string());
        assert!(state.accept(pending, now).is_empty());
        assert_eq!(state.pending[0].transcript_baselines.len(), 1);
        assert!(state.pending[0].transcript_baselines[0]
            .path
            .to_string_lossy()
            .contains(".codex"));
        assert_eq!(state.pending[0].transcript_baselines[0].bytes, None);
    }

    #[test]
    // 验证根目录校验拒绝的转录路径不会进入元数据轮询候选。
    fn untrusted_transcript_path_is_not_polled() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        let mut pending = payload(
            "PermissionRequest",
            Some("child-1"),
            None,
            Some("apply_patch"),
        );
        pending.transcript_path = Some(r"C:\temp\untrusted.jsonl".to_string());
        pending.transcript_bytes = Some(123);
        assert!(state.accept(pending, now).is_empty());
        assert!(state.pending[0].transcript_baselines.is_empty());
    }

    #[test]
    // 验证待定审批到期只投递一次，重复轮询不重复投递。
    fn unresolved_child_permission_escalates_once() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        assert!(state
            .accept(
                payload(
                    "PermissionRequest",
                    Some("child-1"),
                    None,
                    Some("apply_patch"),
                ),
                now,
            )
            .is_empty());
        assert_eq!(state.poll(now + PROVISIONAL_APPROVAL_GRACE).len(), 1);
        assert!(state.poll(now + PROVISIONAL_APPROVAL_GRACE).is_empty());
    }

    #[test]
    // 验证工具进度只消解同一子 Agent 的待定审批。
    fn matching_tool_progress_resolves_only_matching_child() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        for child in ["child-1", "child-2"] {
            assert!(state
                .accept(
                    payload("PermissionRequest", Some(child), None, Some("apply_patch"),),
                    now,
                )
                .is_empty());
        }

        let delivered = state.accept(
            payload("ToolStop", Some("child-1"), None, Some("apply_patch")),
            now,
        );
        assert!(delivered.is_empty());
        assert_eq!(state.pending.len(), 1);
        assert_eq!(state.pending[0].scope.agent_id, "child-2");
    }

    #[test]
    // 验证其他子 Agent 的工具进度不会清空当前审批。
    fn unrelated_child_progress_does_not_clear_pending_approval() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        assert!(state
            .accept(
                payload(
                    "PermissionRequest",
                    Some("child-1"),
                    None,
                    Some("apply_patch"),
                ),
                now,
            )
            .is_empty());
        let delivered = state.accept(
            payload("ToolStop", Some("child-2"), None, Some("apply_patch")),
            now,
        );
        assert!(delivered.is_empty());
        assert_eq!(state.pending.len(), 1);
    }

    #[test]
    // 验证先到工具进度可按精确工具名消解后到审批，并单次消费进度记录。
    fn progress_before_permission_suppresses_matching_request_by_exact_tool_name() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        assert!(state
            .accept(
                payload("ToolStart", Some("child-1"), None, Some("apply_patch")),
                now,
            )
            .is_empty());
        assert_eq!(state.recent_progress.len(), 1);

        assert!(state
            .accept(
                payload(
                    "PermissionRequest",
                    Some("child-1"),
                    None,
                    Some("apply_patch"),
                ),
                now + Duration::from_millis(10),
            )
            .is_empty());
        assert!(state.pending.is_empty());
        assert!(state.recent_progress.is_empty());
    }

    #[test]
    // 验证进度记录不跨工具 ID 匹配，过期记录不能消解新审批。
    fn progress_tombstone_is_scoped_by_tool_id_and_expires() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        let mut progress = payload("ToolStart", Some("child-1"), None, Some("apply_patch"));
        progress.tool_use_id = Some("tool-1".to_string());
        assert!(state.accept(progress, now).is_empty());

        let mut other_request = payload(
            "PermissionRequest",
            Some("child-1"),
            None,
            Some("apply_patch"),
        );
        other_request.tool_use_id = Some("tool-2".to_string());
        assert!(state
            .accept(other_request, now + Duration::from_millis(10))
            .is_empty());
        assert_eq!(state.pending.len(), 1);

        let mut expired_state = ApprovalArbiterState::default();
        assert!(expired_state
            .accept(
                payload("ToolStop", Some("child-1"), None, Some("apply_patch")),
                now,
            )
            .is_empty());
        assert!(expired_state
            .accept(
                payload(
                    "PermissionRequest",
                    Some("child-1"),
                    None,
                    Some("apply_patch"),
                ),
                now + APPROVAL_PROGRESS_TOMBSTONE_TTL + Duration::from_millis(1),
            )
            .is_empty());
        assert_eq!(expired_state.pending.len(), 1);
    }

    #[test]
    // 验证截止时刻到达的匹配进度先消解审批，不触发超时投递。
    fn matching_progress_at_deadline_resolves_before_timeout_delivery() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        assert!(state
            .accept(
                payload(
                    "PermissionRequest",
                    Some("child-1"),
                    None,
                    Some("apply_patch"),
                ),
                now,
            )
            .is_empty());
        assert!(state
            .accept(
                payload("ToolStop", Some("child-1"), None, Some("apply_patch")),
                now + PROVISIONAL_APPROVAL_GRACE,
            )
            .is_empty());
        assert!(state.pending.is_empty());
    }

    #[test]
    // 验证正常仲裁路径中的 Codex 内部进度不进入下游内存出口。
    fn internal_codex_progress_never_reaches_shared_delivery_sink() {
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&delivered);
        let delivery: HookPayloadSink = Arc::new(move |payload| {
            target.lock().unwrap().push(payload.event);
        });
        let sink = approval_aware_hook_sink(delivery);
        sink(payload(
            "PermissionRequest",
            Some("child-1"),
            None,
            Some("apply_patch"),
        ));
        sink(payload(
            "ToolStop",
            Some("child-1"),
            None,
            Some("apply_patch"),
        ));
        assert!(delivered.lock().unwrap().is_empty());
    }

    #[test]
    // 验证子 Agent 结束只清理该子范围，父会话结束清理剩余同父审批。
    fn subagent_stop_and_parent_completion_clear_their_scopes() {
        let now = Instant::now();
        let mut state = ApprovalArbiterState::default();
        for child in ["child-1", "child-2"] {
            assert!(state
                .accept(
                    payload("PermissionRequest", Some(child), None, Some("apply_patch"),),
                    now,
                )
                .is_empty());
        }

        assert_eq!(
            state
                .accept(payload("SubagentStop", Some("child-1"), None, None), now)
                .len(),
            1
        );
        assert_eq!(state.pending.len(), 1);
        assert_eq!(
            state.accept(payload("Stop", None, None, None), now).len(),
            1
        );
        assert!(state.pending.is_empty());
    }
}
