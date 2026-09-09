use super::adapters;
use super::http::{build_client, execute, host_for_log};
use super::model::{
    HookNotificationJob, HookNotificationMessage, NotificationError, TestSendResult,
    ThirdPartyTarget,
};
use crate::app_paths;
use crate::codex_goal::{parse_wire_status, CodexGoalStatus};
use chrono::{DateTime, Local, Utc};
use log::{debug, warn};
use reqwest::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::thread;
use std::time::{Duration, Instant};
use tokio::task::JoinSet;
use uuid::Uuid;

const QUEUE_CAPACITY: usize = 64;
const MAX_TARGETS_PER_JOB: usize = 20;
const MAX_CONCURRENCY: usize = 4;
const GOAL_NOTIFICATION_TTL: Duration = Duration::from_secs(30 * 60);
const GOAL_NOTIFICATION_CACHE_LIMIT: usize = 256;

#[derive(Clone)]
pub struct DispatcherHandle {
    sender: SyncSender<HookNotificationJob>,
}

impl DispatcherHandle {
    // 创建容量 64 的队列和后台线程，以单线程异步运行时顺序处理任务；初始化失败后接收端关闭。
    pub fn start(label: &'static str) -> Self {
        let (sender, receiver) = sync_channel::<HookNotificationJob>(QUEUE_CAPACITY);
        thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    warn!("third-party notification runtime init failed: {err}");
                    return;
                }
            };
            let mut goal_notifications = GoalNotificationDeduper::default();
            while let Ok(job) = receiver.recv() {
                runtime.block_on(process_job(label, job, &mut goal_notifications));
            }
        });
        Self { sender }
    }

    // 非阻塞尝试入队，队列满或已断开时记录警告并丢弃任务，不重试。
    pub fn try_enqueue(&self, job: HookNotificationJob) {
        match self.sender.try_send(job) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                warn!("third-party notification queue full, dropping hook job");
            }
            Err(TrySendError::Disconnected(_)) => {
                warn!("third-party notification queue disconnected, dropping hook job");
            }
        }
    }
}

// 创建客户端并向指定目标实际发送示例通知，不检查全局开关或目标 enabled/events 筛选。
pub async fn test_send(target: ThirdPartyTarget) -> Result<TestSendResult, String> {
    let client = build_client().map_err(|err| err.message)?;
    let message = sample_message();
    Ok(send_one(client, target, message).await)
}

// 构造消息并读取当前设置，筛选已启用事件目标，以最多四路并发发送；仅记录失败，不重试。
async fn process_job(
    label: &'static str,
    job: HookNotificationJob,
    goal_notifications: &mut GoalNotificationDeduper,
) {
    let goal_notification_key = goal_notification_key(&job);
    let Some(message) = message_from_job(job) else {
        return;
    };
    let settings = read_settings();
    if !settings.enabled {
        return;
    }
    let targets = settings
        .targets
        .into_iter()
        .filter(|target| target.enabled)
        .filter(|target| target.events.get(&message.event).copied().unwrap_or(false))
        .take(MAX_TARGETS_PER_JOB)
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return;
    }
    if let Some(key) = goal_notification_key {
        if !goal_notifications.claim(key) {
            return;
        }
    }

    let client = match build_client() {
        Ok(client) => client,
        Err(err) => {
            warn!(
                "third-party notification http client init failed: {}",
                err.code
            );
            return;
        }
    };

    let mut set = JoinSet::new();
    let mut iter = targets.into_iter();
    loop {
        while set.len() < MAX_CONCURRENCY {
            let Some(target) = iter.next() else {
                break;
            };
            let client = client.clone();
            let message = message.clone();
            set.spawn(async move { send_one(client, target, message).await });
        }
        if set.is_empty() {
            break;
        }
        match set.join_next().await {
            Some(Ok(result)) => {
                if !result.accepted {
                    debug!(
                        "third-party notification failed: label={} provider={} target={} code={:?}",
                        label, result.provider, result.target_id, result.error_code
                    );
                }
            }
            Some(Err(err)) => warn!("third-party notification task join failed: {err}"),
            None => break,
        }
    }
}

// 为已知 Codex goal 关注/终态构造有界去重键；普通 Codex Stop 不改变既有通知语义。
fn goal_notification_key(job: &HookNotificationJob) -> Option<String> {
    if job.source != "codex" || job.event != "Stop" {
        return None;
    }
    let status = parse_wire_status(job.goal_status.as_deref())?;
    if matches!(status, CodexGoalStatus::None | CodexGoalStatus::Active | CodexGoalStatus::Unknown)
    {
        return None;
    }
    let identity = job
        .goal_id
        .as_deref()
        .or(job.session_id.as_deref())
        .unwrap_or("unknown");
    Some(format!("codex|{identity}|{}", status.wire_name()))
}

#[derive(Default)]
struct GoalNotificationDeduper {
    seen: HashMap<String, Instant>,
}

impl GoalNotificationDeduper {
    // 在有界 TTL 缓存中只允许同一 goal 终态/关注状态通知一次。
    fn claim(&mut self, key: String) -> bool {
        let now = Instant::now();
        self.seen
            .retain(|_, seen_at| now.duration_since(*seen_at) <= GOAL_NOTIFICATION_TTL);
        if self.seen.contains_key(&key) {
            return false;
        }
        if self.seen.len() >= GOAL_NOTIFICATION_CACHE_LIMIT {
            if let Some(oldest) = self
                .seen
                .iter()
                .min_by_key(|(_, seen_at)| **seen_at)
                .map(|(key, _)| key.clone())
            {
                self.seen.remove(&oldest);
            }
        }
        self.seen.insert(key, now);
        true
    }
}

// 构建供应商请求并实际发送，再由适配器判定接受状态；网络失败与供应商拒绝都包装为结果。
async fn send_one(
    client: Client,
    target: ThirdPartyTarget,
    message: HookNotificationMessage,
) -> TestSendResult {
    let provider = target.provider.clone();
    let target_id = target.id.clone();
    let _target_name = target.name.as_str();
    let started = std::time::Instant::now();
    let spec = match adapters::build_request(&target, &message, Utc::now()) {
        Ok(spec) => spec,
        Err(err) => {
            return failed(
                provider,
                target_id,
                started.elapsed().as_millis(),
                None,
                err,
            )
        }
    };
    let host = host_for_log(&spec.url);
    let response = match execute(&client, spec).await {
        Ok(response) => response,
        Err(err) => {
            debug!(
                "third-party notification http failed: provider={} target={} host={} code={}",
                provider, target_id, host, err.code
            );
            return failed(
                provider,
                target_id,
                started.elapsed().as_millis(),
                None,
                err,
            );
        }
    };
    let elapsed_ms = response.elapsed_ms;
    let http_status = Some(response.status);
    match adapters::parse_response(&target, &response) {
        Ok(accepted) => TestSendResult {
            accepted: true,
            provider,
            target_id,
            elapsed_ms,
            http_status,
            code: accepted.code,
            message: accepted.message,
            delivery_id: accepted.delivery_id,
            error_code: None,
        },
        Err(err) => failed(provider, target_id, elapsed_ms, http_status, err),
    }
}

// 构造未接受结果并截取错误消息前 160 字符；截断不等于脱敏。
fn failed(
    provider: String,
    target_id: String,
    elapsed_ms: u128,
    http_status: Option<u16>,
    err: NotificationError,
) -> TestSendResult {
    TestSendResult {
        accepted: false,
        provider,
        target_id,
        elapsed_ms,
        http_status,
        code: None,
        message: Some(err.message.chars().take(160).collect()),
        delivery_id: None,
        error_code: Some(err.code.to_string()),
    }
}

struct DispatcherSettings {
    enabled: bool,
    targets: Vec<ThirdPartyTarget>,
}

// 每任务同步读取设置，读取/解析失败按禁用处理；先取前 20 个可解析目标，再由分发阶段过滤。
fn read_settings() -> DispatcherSettings {
    let path = match app_paths::data_paths() {
        Ok(paths) => paths.settings_store_path,
        Err(err) => {
            warn!("third-party notification settings path unavailable: {err}");
            return DispatcherSettings {
                enabled: false,
                targets: Vec::new(),
            };
        }
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => {
            return DispatcherSettings {
                enabled: false,
                targets: Vec::new(),
            };
        }
    };
    let value = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(err) => {
            warn!("third-party notification settings parse failed: {err}");
            return DispatcherSettings {
                enabled: false,
                targets: Vec::new(),
            };
        }
    };
    let enabled = value
        .get("thirdPartyHookNotificationsEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let targets = value
        .get("thirdPartyHookTargets")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value::<ThirdPartyTarget>(item.clone()).ok())
                .take(MAX_TARGETS_PER_JOB)
                .collect()
        })
        .unwrap_or_default();
    DispatcherSettings { enabled, targets }
}

// 忽略未知事件，优先使用显式项目名否则取 cwd 末段，生成 UUID 和本地时间的中文通知；不脱敏显式名称。
fn message_from_job(job: HookNotificationJob) -> Option<HookNotificationMessage> {
    if !super::model::is_supported_event(&job.event) {
        return None;
    }
    let goal_status = if job.source == "codex" && job.event == "Stop" {
        let status = parse_wire_status(job.goal_status.as_deref())?;
        if matches!(status, CodexGoalStatus::Active | CodexGoalStatus::Unknown) {
            return None;
        }
        Some(status)
    } else {
        None
    };
    let id = Uuid::new_v4().to_string();
    let source = normalize_source(&job.source);
    let project = job
        .project
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            job.cwd
                .as_deref()
                .and_then(|cwd| Path::new(cwd).file_name())
                .and_then(|name| name.to_str())
                .filter(|name| !name.trim().is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Unknown Project".to_string());
    let time = local_time_text(job.timestamp.as_deref());
    let event_label = match goal_status {
        Some(CodexGoalStatus::Paused | CodexGoalStatus::Blocked) => "🔔 需要关注",
        Some(CodexGoalStatus::BudgetLimited | CodexGoalStatus::UsageLimited) => "❌ 执行错误",
        _ => event_label(&job.event),
    };
    let summary = match goal_status {
        Some(CodexGoalStatus::Paused | CodexGoalStatus::Blocked) => {
            format!("{source} - {project} 需要关注")
        }
        Some(CodexGoalStatus::BudgetLimited | CodexGoalStatus::UsageLimited) => {
            format!("{source} - {project} 执行失败")
        }
        _ => event_summary(&job.event, &source, &project),
    };
    let title = format!("CLI-Manager {event_label}");
    let body = format!(
        "🏷️ 类型：{event_label}\n🧰 CLI：{source}\n📁 项目：{project}\n🕒 时间：{time}\n🆔 通知：{id}\n📌 内容：{summary}"
    );
    Some(HookNotificationMessage {
        id,
        title,
        body,
        event: job.event,
        source,
        project,
        time,
    })
}

// 生成带随机 ID 和当前本地时间的固定中文示例消息；内容中的成功文案不表示已经发送成功。
fn sample_message() -> HookNotificationMessage {
    let id = Uuid::new_v4().to_string();
    let time = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    HookNotificationMessage {
        id: id.clone(),
        title: "CLI-Manager ✅ 测试通知".to_string(),
        body: format!(
            "🏷️ 类型：✅ 测试通知\n🧰 CLI：Codex\n📁 项目：demo-project\n🕒 时间：{time}\n🆔 通知：{id}\n📌 内容：✅ Codex - demo-project 测试通知发送成功"
        ),
        event: "Stop".to_string(),
        source: "Codex".to_string(),
        project: "demo-project".to_string(),
        time,
    }
}

// 尝试解析 RFC3339 时间并转换为 UTC，失败返回空值。
fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

// 将可解析时间转成本地 24 小时格式，缺失或无效时使用当前本地时间。
fn local_time_text(value: Option<&str>) -> String {
    value
        .and_then(parse_time)
        .map(|time| time.with_timezone(&Local))
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

// 映射已知 CLI 来源显示名，其他非空来源裁剪后保留，空值回退 CLI。
fn normalize_source(value: &str) -> String {
    match value {
        "codex" => "Codex".to_string(),
        "claude" => "Claude Code".to_string(),
        "kimi" => "Kimi Code".to_string(),
        "grok" => "Grok Build".to_string(),
        other if !other.trim().is_empty() => other.trim().to_string(),
        _ => "CLI".to_string(),
    }
}

// 返回固定中文事件标签及图标，未知事件使用通用 Hook 标签。
fn event_label(event: &str) -> &'static str {
    match event {
        "SessionStart" => "🚀 会话开始",
        "UserPromptSubmit" => "⌨️ 新请求",
        "Notification" => "🔔 需要关注",
        "Stop" => "✅ 已完成",
        "StopFailure" => "❌ 执行错误",
        "PermissionRequest" => "🛡️ 待审批",
        _ => "🔔 Hook 通知",
    }
}

// 按事件选择中文动作，将来源和项目名拼成摘要，不进行转义或长度限制。
fn event_summary(event: &str, source: &str, project: &str) -> String {
    let action = match event {
        "SessionStart" => "会话已启动",
        "UserPromptSubmit" => "已提交新请求",
        "Notification" => "需要关注",
        "Stop" => "执行完毕",
        "StopFailure" => "执行失败",
        "PermissionRequest" => "需要你的审批",
        _ => "收到 Hook 通知",
    };
    format!("{source} - {project} {action}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    // 在 Windows 验证通知只采用 cwd 末段及本地时间，并包含预期完成摘要。
    fn message_uses_cwd_basename_only() {
        let message = message_from_job(HookNotificationJob {
            source: "codex".to_string(),
            event: "Stop".to_string(),
            session_id: Some("session-1".to_string()),
            goal_id: Some("goal-1".to_string()),
            goal_status: Some("none".to_string()),
            cwd: Some("C:\\work\\secret\\demo".to_string()),
            project: None,
            timestamp: Some("2026-07-14T10:00:00Z".to_string()),
        })
        .unwrap();
        assert_eq!(message.project, "demo");
        assert!(!message.body.contains("secret"));
        assert!(!message.body.contains("UTC"));
        assert!(message.body.contains("✅"));
        assert!(message.body.contains("📌 内容：Codex - demo 执行完毕"));
        assert!(message.body.contains("🏷️ 类型：✅ 已完成"));
        assert!(message.body.ends_with("📌 内容：Codex - demo 执行完毕"));
    }

    #[test]
    // 验证失败事件显示错误标签，并在缺少项目信息时使用默认项目名。
    fn stop_failure_uses_actionable_event_label() {
        let message = message_from_job(HookNotificationJob {
            source: "claude".to_string(),
            event: "StopFailure".to_string(),
            session_id: None,
            goal_id: None,
            goal_status: None,
            cwd: None,
            project: None,
            timestamp: Some("2026-07-14T11:35:35Z".to_string()),
        })
        .unwrap();
        assert!(message.title.contains("❌ 执行错误"));
        assert!(message
            .body
            .contains("📌 内容：Claude Code - Unknown Project 执行失败"));
        assert!(message.body.contains("🏷️ 类型：❌ 执行错误"));
        assert!(message
            .body
            .ends_with("📌 内容：Claude Code - Unknown Project 执行失败"));
    }

    #[cfg(windows)]
    #[test]
    // 在 Windows 验证审批请求标签和项目摘要明确提示需要审批。
    fn permission_request_mentions_approval_action() {
        let message = message_from_job(HookNotificationJob {
            source: "claude".to_string(),
            event: "PermissionRequest".to_string(),
            session_id: None,
            goal_id: None,
            goal_status: None,
            cwd: Some("C:\\work\\law-promotion".to_string()),
            project: None,
            timestamp: None,
        })
        .unwrap();
        assert!(message.title.contains("🛡️ 待审批"));
        assert!(message
            .body
            .contains("📌 内容：Claude Code - law-promotion 需要你的审批"));
        assert!(message
            .body
            .ends_with("📌 内容：Claude Code - law-promotion 需要你的审批"));
    }

    #[test]
    // 验证 cwd 缺失时采用提供的项目标签；此测试不证明任意标签经过脱敏。
    fn message_prefers_safe_project_label_when_cwd_is_redacted() {
        let message = message_from_job(HookNotificationJob {
            source: "codex".to_string(),
            event: "Stop".to_string(),
            session_id: Some("session-1".to_string()),
            goal_id: Some("goal-1".to_string()),
            goal_status: Some("none".to_string()),
            cwd: None,
            project: Some("remote-demo".to_string()),
            timestamp: None,
        })
        .unwrap();
        assert_eq!(message.project, "remote-demo");
        assert!(message.body.contains("Codex - remote-demo"));
    }

    #[test]
    // 验证未支持的 ToolStart 事件不生成通知消息。
    fn unsupported_event_is_ignored() {
        assert!(message_from_job(HookNotificationJob {
            source: "claude".to_string(),
            event: "ToolStart".to_string(),
            session_id: None,
            goal_id: None,
            goal_status: None,
            cwd: None,
            project: None,
            timestamp: None,
        })
        .is_none());
    }

    #[test]
    // 验证 Codex goal 尚未完成或状态不明时，第三方完成通知不会误发。
    fn codex_goal_stop_requires_a_terminal_status_for_notification() {
        for status in [None, Some("active".to_string()), Some("unknown".to_string())] {
            assert!(message_from_job(HookNotificationJob {
                source: "codex".to_string(),
                event: "Stop".to_string(),
                session_id: Some("session-1".to_string()),
                goal_id: Some("goal-1".to_string()),
                goal_status: status,
                cwd: None,
                project: Some("demo".to_string()),
                timestamp: None,
            })
            .is_none());
        }
    }

    #[test]
    // 验证同一 goal 的已知终态和关注态在第三方队列内只领取一次。
    fn codex_goal_notifications_are_bounded_and_deduplicated() {
        let mut deduper = GoalNotificationDeduper::default();
        assert!(deduper.claim("codex|goal-1|complete".to_string()));
        assert!(!deduper.claim("codex|goal-1|complete".to_string()));
        assert!(deduper.claim("codex|goal-1|blocked".to_string()));
    }
}
