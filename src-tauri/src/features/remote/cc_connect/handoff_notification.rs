use super::handoff::{
    send_handoff_notification_once, HandoffNotificationSendError, HANDOFF_NOTIFICATION_ATTEMPTS,
    HANDOFF_NOTIFICATION_RETRY_DELAY,
};
#[cfg(test)]
use super::handoff_session::CcConnectHandoffTransport;
use super::handoff_session::{load_handoff_record, PersistedHandoffRecord};
use super::*;
use crate::daemon::discovery::{daemon_info_path, is_pid_alive, read_daemon_info, DaemonInfo};
use log::{debug, warn};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread;
use std::time::Instant;

const HOOK_QUEUE_CAPACITY: usize = 64;
const DELIVERY_QUEUE_CAPACITY: usize = 64;
const SCHEDULER_TICK: Duration = Duration::from_secs(1);
const DEFAULT_PROGRESS_INTERVAL_MINUTES: u64 = 5;
const MIN_PROGRESS_INTERVAL_MINUTES: u64 = 1;
const MAX_PROGRESS_INTERVAL_MINUTES: u64 = 60;
const TASK_STALE_AFTER: Duration = Duration::from_secs(20 * 60);
const TASK_STALE_GRACE: Duration = Duration::from_secs(5 * 60);
const PERMISSION_DEDUP_WINDOW: Duration = Duration::from_secs(5);
const STATUS_FILE_NAME: &str = "handoff-notification-status.json";
const HOOK_ENV_KEYS: [&str; 3] = [
    "CLI_MANAGER_TAB_ID",
    "CLI_MANAGER_NOTIFY_PORT",
    "CLI_MANAGER_NOTIFY_TOKEN",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectHandoffNotificationStatus {
    pub last_attempt_at_ms: Option<i64>,
    pub last_success_at_ms: Option<i64>,
    pub last_event: Option<String>,
    pub last_platform: Option<CcConnectPlatform>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct NotificationSettings {
    enabled: bool,
    completion_enabled: bool,
    permission_enabled: bool,
    progress_enabled: bool,
    progress_interval_minutes: u64,
}

impl Default for NotificationSettings {
    // 默认开启各类接管通知并设定五分钟进度间隔。
    fn default() -> Self {
        Self {
            enabled: true,
            completion_enabled: true,
            permission_enabled: true,
            progress_enabled: true,
            progress_interval_minutes: DEFAULT_PROGRESS_INTERVAL_MINUTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HandoffIdentity {
    agent: CcConnectAgent,
    local_session_id: String,
    cli_session_id: String,
    platform: CcConnectPlatform,
    platform_session_key: String,
    started_at_ms: i64,
}

impl HandoffIdentity {
    // 从持久化记录提取通知归属所需的接管身份。
    fn from_record(record: &PersistedHandoffRecord) -> Self {
        Self {
            agent: record.agent,
            local_session_id: record.local_session_id.clone(),
            cli_session_id: record.cli_session_id.clone(),
            platform: record.platform,
            platform_session_key: record.platform_session_key.clone(),
            started_at_ms: record.started_at_ms,
        }
    }

    // 比较当前记录与已捕获的接管身份是否一致。
    fn matches_record(&self, record: &PersistedHandoffRecord) -> bool {
        self == &Self::from_record(record)
    }
}

#[derive(Debug)]
struct RemoteHookEvent {
    tab_id: String,
    source: String,
    event: String,
    cli_session_id: Option<String>,
    permission_fingerprint: Option<u64>,
}

impl RemoteHookEvent {
    // 解析 Hook 标识及事件，并仅保留审批内容的哈希指纹。
    fn from_payload(payload: &Value) -> Option<Self> {
        let tab_id = string_field(payload, &["tabId", "tab_id"])?;
        let source = string_field(payload, &["source"])?;
        let event = string_field(payload, &["event"])?;
        let cli_session_id = string_field(payload, &["sessionId", "session_id"]);
        let fingerprint_source = string_field(payload, &["toolUseId", "tool_use_id", "message"]);
        let permission_fingerprint = fingerprint_source.map(|value| {
            let mut hasher = DefaultHasher::new();
            value.hash(&mut hasher);
            hasher.finish()
        });
        Some(Self {
            tab_id,
            source,
            event,
            cli_session_id,
            permission_fingerprint,
        })
    }

    // 校验事件来源、Tab 和可选 CLI 会话是否属于当前接管。
    fn belongs_to(&self, record: &PersistedHandoffRecord) -> bool {
        self.source == record.agent.hook_source()
            && self.tab_id == record.local_session_id
            && self
                .cli_session_id
                .as_deref()
                .is_none_or(|session_id| session_id == record.cli_session_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskPhase {
    Running,
    Attention,
    Terminal,
}

#[derive(Debug)]
struct TaskState {
    identity: HandoffIdentity,
    started_at: Instant,
    last_progress_at: Instant,
    phase: TaskPhase,
    terminal_kind: Option<NotificationKind>,
    terminal_enqueued: bool,
    status_unknown_enqueued: bool,
    last_permission_fingerprint: Option<u64>,
    last_permission_at: Option<Instant>,
}

impl TaskState {
    // 创建运行态任务并初始化通知去重及计时字段。
    fn new(record: &PersistedHandoffRecord, now: Instant) -> Self {
        Self {
            identity: HandoffIdentity::from_record(record),
            started_at: now,
            last_progress_at: now,
            phase: TaskPhase::Running,
            terminal_kind: None,
            terminal_enqueued: false,
            status_unknown_enqueued: false,
            last_permission_fingerprint: None,
            last_permission_at: None,
        }
    }

    // 有指纹时按指纹去重，无指纹时使用短时间窗口。
    fn is_duplicate_permission(&self, fingerprint: Option<u64>, now: Instant) -> bool {
        if fingerprint.is_some() {
            return fingerprint == self.last_permission_fingerprint;
        }
        self.last_permission_at
            .is_some_and(|last| now.duration_since(last) < PERMISSION_DEDUP_WINDOW)
    }

    // 首次标记状态未知提示已入队，重复调用返回否。
    fn mark_status_unknown_enqueued(&mut self) -> bool {
        if self.status_unknown_enqueued {
            return false;
        }
        self.status_unknown_enqueued = true;
        true
    }

    // 仅首次进入终态并记录待发送的完成或失败类型。
    fn mark_terminal(&mut self, kind: NotificationKind) -> bool {
        if self.phase == TaskPhase::Terminal {
            return false;
        }
        debug_assert!(matches!(
            kind,
            NotificationKind::Completed | NotificationKind::Failed
        ));
        self.phase = TaskPhase::Terminal;
        self.terminal_kind = Some(kind);
        self.terminal_enqueued = false;
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationKind {
    Progress,
    Permission,
    Completed,
    Failed,
    TimedOut,
}

impl NotificationKind {
    // 返回通知类型的持久化事件键。
    fn key(self) -> &'static str {
        match self {
            Self::Progress => "progress",
            Self::Permission => "permission",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::TimedOut => "timed_out",
        }
    }
}

#[derive(Debug)]
struct DeliveryJob {
    identity: HandoffIdentity,
    record: PersistedHandoffRecord,
    kind: NotificationKind,
    message: String,
}

enum SchedulerMessage {
    Hook(Value),
}

#[derive(Clone)]
pub struct RemoteHandoffNotifier {
    sender: SyncSender<SchedulerMessage>,
}

impl RemoteHandoffNotifier {
    // 创建有界 Hook 与投递队列并启动两条工作线程。
    pub fn start() -> Self {
        let (scheduler_sender, scheduler_receiver) =
            sync_channel::<SchedulerMessage>(HOOK_QUEUE_CAPACITY);
        let (delivery_sender, delivery_receiver) =
            sync_channel::<DeliveryJob>(DELIVERY_QUEUE_CAPACITY);
        thread::spawn(move || run_delivery_worker(delivery_receiver));
        thread::spawn(move || run_scheduler(scheduler_receiver, delivery_sender));
        Self {
            sender: scheduler_sender,
        }
    }

    // 非阻塞提交 Hook 事件，队列满或断开时记录警告。
    pub fn try_enqueue(&self, payload: Value) {
        match self.sender.try_send(SchedulerMessage::Hook(payload)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                warn!("remote handoff notification hook queue full, dropping event");
            }
            Err(TrySendError::Disconnected(_)) => {
                warn!("remote handoff notification scheduler unavailable");
            }
        }
    }
}

// 清除继承 Hook 绑定后，仅在接管和存活 daemon 可用时注入新绑定。
pub(super) fn apply_hook_environment(command: &mut Command) {
    for key in HOOK_ENV_KEYS {
        command.env_remove(key);
    }
    let record = match load_handoff_record() {
        Ok(Some(record)) => record,
        Ok(None) => return,
        Err(err) => {
            warn!("remote handoff hook record unavailable: {err}");
            return;
        }
    };
    let data_dir = match crate::app_paths::cli_manager_data_dir() {
        Ok(path) => path,
        Err(err) => {
            warn!("remote handoff hook data path unavailable: {err}");
            return;
        }
    };
    let info = match read_daemon_info(&daemon_info_path(&data_dir, cfg!(debug_assertions))) {
        Ok(Some(info)) if info.hook_port > 0 && is_pid_alive(info.pid) => info,
        Ok(_) => {
            warn!("remote handoff hook daemon is unavailable");
            return;
        }
        Err(err) => {
            warn!("remote handoff hook daemon discovery failed: {err}");
            return;
        }
    };
    for (key, value) in hook_environment_values(&record, &info) {
        command.env(key, value);
    }
}

// 组合本地 Tab 与 daemon Hook 端口、令牌的子进程环境。
fn hook_environment_values(
    record: &PersistedHandoffRecord,
    info: &DaemonInfo,
) -> [(&'static str, String); 3] {
    [
        ("CLI_MANAGER_TAB_ID", record.local_session_id.clone()),
        ("CLI_MANAGER_NOTIFY_PORT", info.hook_port.to_string()),
        ("CLI_MANAGER_NOTIFY_TOKEN", info.token.clone()),
    ]
}

// 接收 Hook 事件并按周期协调任务通知状态。
fn run_scheduler(receiver: Receiver<SchedulerMessage>, delivery_sender: SyncSender<DeliveryJob>) {
    let mut state: Option<TaskState> = None;
    loop {
        match receiver.recv_timeout(SCHEDULER_TICK) {
            Ok(SchedulerMessage::Hook(payload)) => {
                handle_hook_payload(payload, &mut state, &delivery_sender);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        tick_scheduler(&mut state, &delivery_sender);
    }
}

// 匹配接管身份后根据提交、审批及结束事件更新状态和通知队列。
fn handle_hook_payload(
    payload: Value,
    state: &mut Option<TaskState>,
    delivery_sender: &SyncSender<DeliveryJob>,
) {
    let Some(event) = RemoteHookEvent::from_payload(&payload) else {
        return;
    };
    let record = match load_handoff_record() {
        Ok(Some(record)) => record,
        Ok(None) => {
            *state = None;
            return;
        }
        Err(err) => {
            warn!("remote handoff notification record read failed: {err}");
            return;
        }
    };
    if !event.belongs_to(&record) {
        return;
    }
    let now = Instant::now();
    if state
        .as_ref()
        .is_some_and(|current| !current.identity.matches_record(&record))
    {
        *state = None;
    }
    match event.event.as_str() {
        "UserPromptSubmit" => {
            *state = Some(TaskState::new(&record, now));
        }
        "PermissionRequest" | "Notification" => {
            let current = state.get_or_insert_with(|| TaskState::new(&record, now));
            if current.is_duplicate_permission(event.permission_fingerprint, now) {
                return;
            }
            current.phase = TaskPhase::Attention;
            current.last_permission_fingerprint = event.permission_fingerprint;
            current.last_permission_at = Some(now);
            let settings = read_notification_settings();
            if settings.enabled && settings.permission_enabled {
                if enqueue_delivery(
                    delivery_sender,
                    &record,
                    NotificationKind::Permission,
                    now.duration_since(current.started_at),
                ) {
                    current.last_progress_at = now;
                }
            }
        }
        "Stop" | "StopFailure" => {
            let current = state.get_or_insert_with(|| TaskState::new(&record, now));
            let kind = if event.event == "StopFailure" {
                NotificationKind::Failed
            } else {
                NotificationKind::Completed
            };
            if !current.mark_terminal(kind) {
                return;
            }
            enqueue_terminal(current, &record, delivery_sender);
        }
        _ => {}
    }
}

// 核对接管仍有效并调度终态、状态未知或周期进度通知。
fn tick_scheduler(state: &mut Option<TaskState>, delivery_sender: &SyncSender<DeliveryJob>) {
    let Some(current) = state.as_mut() else {
        return;
    };
    let record = match load_handoff_record() {
        Ok(Some(record)) if current.identity.matches_record(&record) => record,
        Ok(_) => {
            *state = None;
            return;
        }
        Err(err) => {
            debug!("remote handoff notification reconciliation skipped: {err}");
            return;
        }
    };
    if current.phase == TaskPhase::Terminal {
        enqueue_terminal(current, &record, delivery_sender);
        return;
    }
    let now = Instant::now();
    let elapsed = now.duration_since(current.started_at);
    let settings = read_notification_settings();
    let interval = Duration::from_secs(settings.progress_interval_minutes * 60);
    if elapsed >= task_stale_after(settings) {
        enqueue_status_unknown(current, &record, delivery_sender);
        return;
    }
    if !settings.enabled || !settings.progress_enabled {
        return;
    }
    if now.duration_since(current.last_progress_at) < interval {
        return;
    }
    if enqueue_delivery(
        delivery_sender,
        &record,
        NotificationKind::Progress,
        elapsed,
    ) {
        current.last_progress_at = now;
    }
}

// 在设置允许时尝试发送一次状态未知提示。
fn enqueue_status_unknown(
    state: &mut TaskState,
    record: &PersistedHandoffRecord,
    delivery_sender: &SyncSender<DeliveryJob>,
) {
    if state.status_unknown_enqueued {
        return;
    }
    let settings = read_notification_settings();
    if !settings.enabled || !settings.completion_enabled {
        state.mark_status_unknown_enqueued();
        return;
    }
    if enqueue_delivery(
        delivery_sender,
        record,
        NotificationKind::TimedOut,
        Instant::now().duration_since(state.started_at),
    ) {
        state.mark_status_unknown_enqueued();
    }
}

// 按进度间隔和宽限期计算不小于二十分钟的未知状态阈值。
fn task_stale_after(settings: NotificationSettings) -> Duration {
    if settings.progress_enabled {
        let interval = Duration::from_secs(settings.progress_interval_minutes * 60);
        TASK_STALE_AFTER.max(interval + TASK_STALE_GRACE)
    } else {
        TASK_STALE_AFTER
    }
}

// 按完成通知开关及入队状态发送待处理终态通知。
fn enqueue_terminal(
    state: &mut TaskState,
    record: &PersistedHandoffRecord,
    delivery_sender: &SyncSender<DeliveryJob>,
) {
    if state.terminal_enqueued {
        return;
    }
    let Some(kind) = state.terminal_kind else {
        return;
    };
    let settings = read_notification_settings();
    if !settings.enabled || !settings.completion_enabled {
        state.terminal_enqueued = true;
        return;
    }
    state.terminal_enqueued = enqueue_delivery(
        delivery_sender,
        record,
        kind,
        Instant::now().duration_since(state.started_at),
    );
}

// 捕获当前接管与语言生成通知并非阻塞加入投递队列。
fn enqueue_delivery(
    sender: &SyncSender<DeliveryJob>,
    record: &PersistedHandoffRecord,
    kind: NotificationKind,
    elapsed: Duration,
) -> bool {
    let language = load_profile()
        .ok()
        .flatten()
        .map(|profile| profile.language)
        .unwrap_or(CcConnectLanguage::Zh);
    let job = DeliveryJob {
        identity: HandoffIdentity::from_record(record),
        record: record.clone(),
        kind,
        message: format_notification(record, kind, language, elapsed),
    };
    match sender.try_send(job) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            warn!("remote handoff notification delivery queue full");
            false
        }
        Err(TrySendError::Disconnected(_)) => {
            warn!("remote handoff notification delivery worker unavailable");
            false
        }
    }
}

// 消费仍有效的投递任务并更新持久化尝试、成功及失败状态。
fn run_delivery_worker(receiver: Receiver<DeliveryJob>) {
    let mut cached_binary: Option<(Option<String>, DetectedBinary)> = None;
    while let Ok(job) = receiver.recv() {
        if !delivery_job_is_current(&job) {
            continue;
        }
        let mut status = read_notification_status().unwrap_or_default();
        status.last_attempt_at_ms = Some(now_millis());
        status.last_event = Some(job.kind.key().to_string());
        status.last_platform = Some(job.record.platform);
        status.last_error = None;
        let _ = write_notification_status(&status);

        match deliver(&job, &mut cached_binary) {
            DeliveryOutcome::Delivered => {
                status.last_success_at_ms = Some(now_millis());
                status.last_error = None;
            }
            DeliveryOutcome::Stale => {
                status.last_error = Some("handoff_changed".to_string());
            }
            DeliveryOutcome::Failed(failure) => {
                status.last_error = Some(failure.code.to_string());
                warn!(
                    "remote handoff notification delivery failed: event={} platform={:?} error={} detail={}",
                    job.kind.key(),
                    job.record.platform,
                    failure.code,
                    failure.detail
                );
            }
        }
        let _ = write_notification_status(&status);
    }
}

// 核对持久化接管身份，读取失败或已替换视为任务失效。
fn delivery_job_is_current(job: &DeliveryJob) -> bool {
    load_handoff_record()
        .ok()
        .flatten()
        .is_some_and(|record| job.identity.matches_record(&record))
}

#[derive(Debug, PartialEq, Eq)]
struct DeliveryFailure {
    code: &'static str,
    detail: String,
}

#[derive(Debug, PartialEq, Eq)]
enum DeliveryOutcome {
    Delivered,
    Stale,
    Failed(DeliveryFailure),
}

#[derive(Debug, PartialEq, Eq)]
enum DeliveryAttemptOutcome {
    Delivered,
    Stale,
    Failed(HandoffNotificationSendError),
}

// 每次重试前校验归属，按指定次数投递并保留最终错误。
fn retry_delivery<Current, Send, Wait>(
    attempts: usize,
    mut is_current: Current,
    mut send_once: Send,
    mut wait: Wait,
) -> DeliveryAttemptOutcome
where
    Current: FnMut() -> bool,
    Send: FnMut() -> Result<(), HandoffNotificationSendError>,
    Wait: FnMut(),
{
    let mut last_error = None;
    for attempt in 0..attempts {
        if !is_current() {
            return DeliveryAttemptOutcome::Stale;
        }
        match send_once() {
            Ok(()) => return DeliveryAttemptOutcome::Delivered,
            Err(err) => last_error = Some(err),
        }
        if attempt + 1 < attempts {
            wait();
        }
    }
    DeliveryAttemptOutcome::Failed(last_error.unwrap_or(HandoffNotificationSendError {
        code: "send_unavailable",
        detail: "no delivery attempt was configured".to_string(),
    }))
}

// 解析配置与可信程序后重试投递，接管变化时停止。
fn deliver(
    job: &DeliveryJob,
    cached_binary: &mut Option<(Option<String>, DetectedBinary)>,
) -> DeliveryOutcome {
    let profile = match load_profile() {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            return DeliveryOutcome::Failed(delivery_failure(
                "profile_not_configured",
                "cc-connect profile is not configured",
                &[],
            ))
        }
        Err(err) => {
            return DeliveryOutcome::Failed(delivery_failure("profile_read_failed", &err, &[]))
        }
    };
    let secrets = delivery_redaction_secrets(&job.record);
    let requested_path = profile.executable_path.clone();
    let binary = match cached_binary {
        Some((cached_path, binary)) if cached_path == &requested_path => binary.clone(),
        _ => {
            let binary = match detect_binary_uncached(requested_path.as_deref()) {
                Ok(binary) => binary,
                Err(err) => {
                    return DeliveryOutcome::Failed(delivery_failure(
                        "binary_detection_failed",
                        &err,
                        &secrets,
                    ))
                }
            };
            *cached_binary = Some((requested_path, binary.clone()));
            binary
        }
    };
    if !binary.compatible {
        return DeliveryOutcome::Failed(delivery_failure(
            "version_unsupported",
            "cc-connect version is unsupported",
            &secrets,
        ));
    }
    match retry_delivery(
        HANDOFF_NOTIFICATION_ATTEMPTS,
        || delivery_job_is_current(job),
        || {
            send_handoff_notification_once(
                &binary.path,
                &job.record.project_name,
                &job.record.platform_session_key,
                &job.message,
            )
        },
        || std::thread::sleep(HANDOFF_NOTIFICATION_RETRY_DELAY),
    ) {
        DeliveryAttemptOutcome::Delivered => DeliveryOutcome::Delivered,
        DeliveryAttemptOutcome::Stale => DeliveryOutcome::Stale,
        DeliveryAttemptOutcome::Failed(err) => {
            DeliveryOutcome::Failed(delivery_failure(err.code, &err.detail, &secrets))
        }
    }
}

// 组合允许的错误码与脱敏后的投递详情。
fn delivery_failure(code: &'static str, detail: &str, secrets: &[String]) -> DeliveryFailure {
    DeliveryFailure {
        code: safe_delivery_error_code(code),
        detail: redact_delivery_detail(detail, secrets),
    }
}

// 将未知投递错误码归一化，禁止原始敏感文本成为持久化代码。
fn safe_delivery_error_code(code: &str) -> &'static str {
    match code {
        "binary_detection_failed" => "binary_detection_failed",
        "delivery_failed" => "delivery_failed",
        "handoff_changed" => "handoff_changed",
        "legacy_error_redacted" => "legacy_error_redacted",
        "profile_not_configured" => "profile_not_configured",
        "profile_read_failed" => "profile_read_failed",
        "send_data_dir_unavailable" => "send_data_dir_unavailable",
        "send_exit_nonzero" => "send_exit_nonzero",
        "send_process_error" => "send_process_error",
        "send_timeout" => "send_timeout",
        "send_unavailable" => "send_unavailable",
        "version_unsupported" => "version_unsupported",
        _ => "delivery_failed",
    }
}

// 脱敏投递详情并压为至多一千字符的单行文本。
fn redact_delivery_detail(detail: &str, secrets: &[String]) -> String {
    redact_log_line(detail, secrets)
        .replace(['\r', '\n'], " ")
        .chars()
        .take(1_000)
        .collect()
}

// 收集平台、Provider、daemon 及敏感环境值用于日志脱敏。
fn delivery_redaction_secrets(record: &PersistedHandoffRecord) -> Vec<String> {
    let mut secrets = Vec::new();
    for account in [
        TELEGRAM_TOKEN_ACCOUNT,
        FEISHU_APP_ID_ACCOUNT,
        FEISHU_APP_SECRET_ACCOUNT,
        WEIXIN_TOKEN_ACCOUNT,
        WECOM_BOT_ID_ACCOUNT,
        WECOM_BOT_SECRET_ACCOUNT,
    ] {
        if let Ok(Some(value)) = get_credential(account) {
            secrets.push(value);
        }
    }
    if let Some(provider_id) = record.provider_id.as_deref() {
        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            if let Ok(provider) = runtime.block_on(
                crate::provider::runtime::load_codex_runtime_config(provider_id),
            ) {
                secrets.push(provider.secret_value);
            }
        }
    }
    if let Ok(data_dir) = crate::app_paths::cli_manager_data_dir() {
        if let Ok(Some(info)) =
            read_daemon_info(&daemon_info_path(&data_dir, cfg!(debug_assertions)))
        {
            secrets.push(info.token);
        }
    }
    for (key, value) in std::env::vars() {
        let key = key.to_ascii_lowercase();
        if ["token", "secret", "password", "api_key", "authorization"]
            .iter()
            .any(|keyword| key.contains(keyword))
        {
            secrets.push(value);
        }
    }
    secrets.retain(|secret| secret.len() >= 4);
    secrets.sort();
    secrets.dedup();
    secrets
}

// 读取通知设置，缺失或读取解析失败时使用默认设置。
fn read_notification_settings() -> NotificationSettings {
    let path = match crate::app_paths::data_paths() {
        Ok(paths) => paths.settings_store_path,
        Err(err) => {
            debug!("remote handoff notification settings path unavailable: {err}");
            return NotificationSettings::default();
        }
    };
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return NotificationSettings::default()
        }
        Err(err) => {
            debug!("remote handoff notification settings read failed: {err}");
            return NotificationSettings::default();
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => notification_settings_from_value(&value),
        Err(err) => {
            warn!("remote handoff notification settings parse failed: {err}");
            NotificationSettings::default()
        }
    }
}

// 从 JSON 提取通知开关并将进度间隔限制为一至六十分钟。
fn notification_settings_from_value(value: &Value) -> NotificationSettings {
    let defaults = NotificationSettings::default();
    let interval = value
        .get("remoteHandoffProgressIntervalMinutes")
        .and_then(Value::as_u64)
        .unwrap_or(defaults.progress_interval_minutes)
        .clamp(MIN_PROGRESS_INTERVAL_MINUTES, MAX_PROGRESS_INTERVAL_MINUTES);
    NotificationSettings {
        enabled: bool_setting(value, "remoteHandoffNotificationsEnabled", defaults.enabled),
        completion_enabled: bool_setting(
            value,
            "remoteHandoffCompletionNotificationsEnabled",
            defaults.completion_enabled,
        ),
        permission_enabled: bool_setting(
            value,
            "remoteHandoffPermissionNotificationsEnabled",
            defaults.permission_enabled,
        ),
        progress_enabled: bool_setting(
            value,
            "remoteHandoffProgressNotificationsEnabled",
            defaults.progress_enabled,
        ),
        progress_interval_minutes: interval,
    }
}

// 读取布尔设置，类型不符或缺失时使用回退值。
fn bool_setting(value: &Value, key: &str, fallback: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

// 按候选键顺序提取首个非空去空白字符串。
fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
    })
}

// 返回托管通知状态 JSON 的路径。
fn notification_status_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(STATUS_FILE_NAME))
}

// 读取通知状态并将旧的不安全错误文本改写为脱敏标记。
fn read_notification_status() -> Result<CcConnectHandoffNotificationStatus, String> {
    let path = notification_status_path()?;
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CcConnectHandoffNotificationStatus::default())
        }
        Err(err) => return Err(format!("read handoff notification status failed: {err}")),
    };
    let mut status: CcConnectHandoffNotificationStatus = serde_json::from_str(&raw)
        .map_err(|err| format!("parse handoff notification status failed: {err}"))?;
    if let Some(error) = status.last_error.as_deref() {
        let safe_error = safe_delivery_error_code(error);
        if safe_error != error {
            status.last_error = Some("legacy_error_redacted".to_string());
            let _ = write_notification_status(&status);
        }
    }
    Ok(status)
}

// 序列化通知状态并原子式替换状态文件。
fn write_notification_status(status: &CcConnectHandoffNotificationStatus) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(status)
        .map_err(|err| format!("serialize handoff notification status failed: {err}"))?;
    write_file_atomically(
        &notification_status_path()?,
        &payload,
        "handoff notification status",
    )
}

// 按通知类型及语言格式化平台、项目、会话、目录和耗时元数据。
fn format_notification(
    record: &PersistedHandoffRecord,
    kind: NotificationKind,
    language: CcConnectLanguage,
    elapsed: Duration,
) -> String {
    let platform = platform_label(record.platform, language);
    let elapsed = elapsed_label(elapsed, language);
    let heading = match (language, kind) {
        (CcConnectLanguage::Zh, NotificationKind::Progress) => {
            "CLI-Manager 托管任务仍在进行"
        }
        (CcConnectLanguage::Zh, NotificationKind::Permission) => {
            "CLI-Manager 托管任务需要审批\n请在当前机器人会话中处理。"
        }
        (CcConnectLanguage::Zh, NotificationKind::Completed) => {
            "CLI-Manager 托管任务已完成"
        }
        (CcConnectLanguage::Zh, NotificationKind::Failed) => {
            "CLI-Manager 托管任务执行失败"
        }
        (CcConnectLanguage::Zh, NotificationKind::TimedOut) => {
            "CLI-Manager 托管任务长时间未收到结束事件\n当前状态未知，请检查机器人会话。"
        }
        (CcConnectLanguage::En, NotificationKind::Progress) => {
            "CLI-Manager managed task is still running"
        }
        (CcConnectLanguage::En, NotificationKind::Permission) => {
            "CLI-Manager managed task needs approval\nRespond in the current bot conversation."
        }
        (CcConnectLanguage::En, NotificationKind::Completed) => {
            "CLI-Manager managed task completed"
        }
        (CcConnectLanguage::En, NotificationKind::Failed) => {
            "CLI-Manager managed task failed"
        }
        (CcConnectLanguage::En, NotificationKind::TimedOut) => {
            "CLI-Manager has not received a completion event\nThe current state is unknown; check the bot conversation."
        }
    };
    match language {
        CcConnectLanguage::Zh => format!(
            "{heading}\n平台：{platform}\n项目：{}\nProvider：{}\ncliSessionId：{}\n工作目录：{}\n已用时间：{elapsed}",
            record.project_name,
            record.provider_name,
            record.cli_session_id,
            record.work_dir,
        ),
        CcConnectLanguage::En => format!(
            "{heading}\nPlatform: {platform}\nProject: {}\nProvider: {}\ncliSessionId: {}\nWorking directory: {}\nElapsed: {elapsed}",
            record.project_name,
            record.provider_name,
            record.cli_session_id,
            record.work_dir,
        ),
    }
}

// 返回对应语言的消息平台显示名称。
fn platform_label(platform: CcConnectPlatform, language: CcConnectLanguage) -> &'static str {
    match (platform, language) {
        (CcConnectPlatform::Telegram, _) => "Telegram",
        (CcConnectPlatform::Feishu, CcConnectLanguage::Zh) => "飞书",
        (CcConnectPlatform::Feishu, CcConnectLanguage::En) => "Feishu",
        (CcConnectPlatform::Weixin, CcConnectLanguage::Zh) => "微信",
        (CcConnectPlatform::Weixin, CcConnectLanguage::En) => "Weixin",
        (CcConnectPlatform::Wecom, CcConnectLanguage::Zh) => "企业微信",
        (CcConnectPlatform::Wecom, CcConnectLanguage::En) => "WeCom",
    }
}

// 将耗时按至少一分钟格式化为分钟或小时分钟。
fn elapsed_label(elapsed: Duration, language: CcConnectLanguage) -> String {
    let total_minutes = elapsed.as_secs() / 60;
    let minutes = total_minutes.max(1);
    match language {
        CcConnectLanguage::Zh if minutes < 60 => format!("{minutes} 分钟"),
        CcConnectLanguage::Zh => {
            format!("{} 小时 {} 分钟", minutes / 60, minutes % 60)
        }
        CcConnectLanguage::En if minutes < 60 => format!("{minutes} min"),
        CcConnectLanguage::En => {
            format!("{} h {} min", minutes / 60, minutes % 60)
        }
    }
}

#[tauri::command]
// 返回持久化接管通知状态。
pub fn cc_connect_handoff_notification_status() -> Result<CcConnectHandoffNotificationStatus, String>
{
    read_notification_status()
}

#[cfg(test)]
mod tests {
    use super::super::handoff_session::HANDOFF_SCHEMA_VERSION;
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    // 构造固定身份的纯内存接管记录。
    fn record() -> PersistedHandoffRecord {
        PersistedHandoffRecord {
            schema_version: HANDOFF_SCHEMA_VERSION,
            agent: CcConnectAgent::Codex,
            local_session_id: "local-session".to_string(),
            cli_session_id: "cli-session".to_string(),
            project_id: "project-1".to_string(),
            project_name: "CLI Manager".to_string(),
            worktree_id: None,
            worktree_name: None,
            work_dir: r"F:\repo".to_string(),
            provider_id: Some("provider-1".to_string()),
            provider_name: "Provider One".to_string(),
            provider_is_global: false,
            provider_snapshot_id: None,
            platform: CcConnectPlatform::Telegram,
            platform_session_key: "telegram:1:1".to_string(),
            cc_session_id: "cc-session".to_string(),
            session_file_path: r"F:\data\session.json".to_string(),
            previous_active_session_id: None,
            source_project_id: "source-project".to_string(),
            source_project_name: "Source".to_string(),
            source_project_path: r"F:\source".to_string(),
            started_at_ms: 100,
            transport: CcConnectHandoffTransport::Local,
            ssh_host_id: None,
            remote_path: None,
        }
    }

    #[test]
    // 验证通知默认开关、间隔上下界及过期阈值。
    fn notification_settings_default_and_clamp_interval() {
        let defaults = notification_settings_from_value(&json!({}));
        assert!(defaults.enabled);
        assert!(defaults.completion_enabled);
        assert!(defaults.permission_enabled);
        assert!(defaults.progress_enabled);
        assert_eq!(defaults.progress_interval_minutes, 5);

        let low =
            notification_settings_from_value(&json!({ "remoteHandoffProgressIntervalMinutes": 0 }));
        let high = notification_settings_from_value(
            &json!({ "remoteHandoffProgressIntervalMinutes": 600 }),
        );
        assert_eq!(low.progress_interval_minutes, 1);
        assert_eq!(high.progress_interval_minutes, 60);
        assert_eq!(task_stale_after(high), Duration::from_secs(65 * 60));
    }

    #[test]
    // 验证四种 Agent 的 Hook 事件只匹配对应接管归属。
    fn hook_event_must_match_the_handoff_owner() {
        for (agent, source) in [
            (CcConnectAgent::Claude, "claude"),
            (CcConnectAgent::Codex, "codex"),
            (CcConnectAgent::Pi, "pi"),
            (CcConnectAgent::Opencode, "opencode"),
        ] {
            let mut record = record();
            record.agent = agent;
            let event = RemoteHookEvent::from_payload(&json!({
                "tabId": "local-session",
                "source": source,
                "event": "Stop",
                "sessionId": "cli-session"
            }))
            .unwrap();
            assert!(event.belongs_to(&record));
        }

        let record = record();
        for payload in [
            json!({ "tabId": "other", "source": "codex", "event": "Stop", "sessionId": "cli-session" }),
            json!({ "tabId": "local-session", "source": "claude", "event": "Stop", "sessionId": "cli-session" }),
            json!({ "tabId": "local-session", "source": "codex", "event": "Stop", "sessionId": "other" }),
        ] {
            assert!(!RemoteHookEvent::from_payload(&payload)
                .unwrap()
                .belongs_to(&record));
        }
    }

    #[test]
    // 验证审批按指纹或短时间窗口去重。
    fn permission_events_are_deduplicated_without_storing_message_content() {
        let record = record();
        let now = Instant::now();
        let mut state = TaskState::new(&record, now);
        state.last_permission_fingerprint = Some(42);
        state.last_permission_at = Some(now);
        assert!(state.is_duplicate_permission(Some(42), now));
        assert!(!state.is_duplicate_permission(Some(99), now));
        assert!(state.is_duplicate_permission(None, now));
        assert!(!state.is_duplicate_permission(None, now + PERMISSION_DEDUP_WINDOW));
    }

    #[test]
    // 验证未知状态提示不会阻止随后进入完成终态。
    fn completed_event_remains_terminal_after_status_unknown_reminder() {
        let record = record();
        let mut state = TaskState::new(&record, Instant::now());
        assert!(state.mark_status_unknown_enqueued());
        assert_ne!(state.phase, TaskPhase::Terminal);
        assert!(state.mark_terminal(NotificationKind::Completed));
        assert_eq!(state.phase, TaskPhase::Terminal);
        assert_eq!(state.terminal_kind, Some(NotificationKind::Completed));
    }

    #[test]
    // 验证未知状态提示不会阻止随后进入失败终态。
    fn failed_event_remains_terminal_after_status_unknown_reminder() {
        let record = record();
        let mut state = TaskState::new(&record, Instant::now());
        assert!(state.mark_status_unknown_enqueued());
        assert_ne!(state.phase, TaskPhase::Terminal);
        assert!(state.mark_terminal(NotificationKind::Failed));
        assert_eq!(state.phase, TaskPhase::Terminal);
        assert_eq!(state.terminal_kind, Some(NotificationKind::Failed));
    }

    #[test]
    // 验证重试间接管取消后不再发送。
    fn notification_retry_stops_when_handoff_is_cancelled() {
        let checks = Cell::new(0usize);
        let sends = Cell::new(0usize);
        let waits = Cell::new(0usize);
        let outcome = retry_delivery(
            4,
            || {
                let check = checks.get();
                checks.set(check + 1);
                check == 0
            },
            || {
                sends.set(sends.get() + 1);
                Err(HandoffNotificationSendError {
                    code: "send_exit_nonzero",
                    detail: "not ready".to_string(),
                })
            },
            || waits.set(waits.get() + 1),
        );
        assert_eq!(outcome, DeliveryAttemptOutcome::Stale);
        assert_eq!(checks.get(), 2);
        assert_eq!(sends.get(), 1);
        assert_eq!(waits.get(), 1);
    }

    #[test]
    // 验证任一接管身份字段变化都会使旧任务失效。
    fn replacement_invalidates_every_handoff_identity_field() {
        let original = record();
        let identity = HandoffIdentity::from_record(&original);
        let mut replacements = Vec::new();

        let mut changed = original.clone();
        changed.agent = CcConnectAgent::Claude;
        replacements.push(changed);
        let mut changed = original.clone();
        changed.local_session_id = "other-local".to_string();
        replacements.push(changed);
        let mut changed = original.clone();
        changed.cli_session_id = "other-cli".to_string();
        replacements.push(changed);
        let mut changed = original.clone();
        changed.platform = CcConnectPlatform::Feishu;
        replacements.push(changed);
        let mut changed = original.clone();
        changed.platform_session_key = "feishu:other".to_string();
        replacements.push(changed);
        let mut changed = original;
        changed.started_at_ms += 1;
        replacements.push(changed);

        assert!(replacements
            .iter()
            .all(|replacement| !identity.matches_record(replacement)));
    }

    #[test]
    // 验证已知秘密和敏感关键词均不会泄露到投递错误。
    fn notification_errors_redact_known_and_pattern_credentials() {
        let secrets = vec![
            "telegram-credential".to_string(),
            "feishu-app-secret".to_string(),
            "weixin-token-value".to_string(),
            "wecom-bot-secret".to_string(),
            "provider-api-key".to_string(),
            "daemon-notify-token".to_string(),
        ];
        for secret in &secrets {
            let detail =
                redact_delivery_detail(&format!("cc-connect failed with {secret}"), &secrets);
            assert!(!detail.contains(secret));
            assert!(detail.contains("[REDACTED]"));
        }
        assert_eq!(
            redact_delivery_detail("authorization: Bearer unlisted-value", &[]),
            "[sensitive output redacted]"
        );
        assert_eq!(
            safe_delivery_error_code("token=must-not-be-persisted"),
            "delivery_failed"
        );
    }

    #[test]
    // 验证各平台审批通知包含预期接管元数据且无工具输入。
    fn formatted_messages_use_safe_handoff_metadata_for_every_platform() {
        for platform in [
            CcConnectPlatform::Telegram,
            CcConnectPlatform::Feishu,
            CcConnectPlatform::Weixin,
            CcConnectPlatform::Wecom,
        ] {
            let mut record = record();
            record.platform = platform;
            let message = format_notification(
                &record,
                NotificationKind::Permission,
                CcConnectLanguage::Zh,
                Duration::from_secs(90),
            );
            assert!(message.contains("cli-session"));
            assert!(message.contains("Provider One"));
            assert!(message.contains("需要审批"));
            assert!(!message.contains("tool_input"));
        }
    }

    #[test]
    // 验证 Hook 环境绑定本地会话及 daemon 端口令牌。
    fn hook_environment_targets_the_daemon_and_local_session() {
        let record = record();
        let info = DaemonInfo {
            port: 1,
            ws_port: 2,
            hook_port: 3,
            token: "secret-token".to_string(),
            pid: 4,
            version: "test".to_string(),
            protocol_version: 1,
            binary_protocol_version: 1,
            features: Vec::new(),
        };
        assert_eq!(
            hook_environment_values(&record, &info),
            [
                ("CLI_MANAGER_TAB_ID", "local-session".to_string()),
                ("CLI_MANAGER_NOTIFY_PORT", "3".to_string()),
                ("CLI_MANAGER_NOTIFY_TOKEN", "secret-token".to_string()),
            ]
        );
    }
}
