use super::adapters;
use super::http::{build_client, execute, host_for_log};
use super::model::{
    HookNotificationJob, HookNotificationMessage, NotificationError, TestSendResult,
    ThirdPartyTarget,
};
use crate::app_paths;
use chrono::{DateTime, Local, Utc};
use log::{debug, warn};
use reqwest::Client;
use serde_json::Value;
use std::path::Path;
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::thread;
use tokio::task::JoinSet;
use uuid::Uuid;

const QUEUE_CAPACITY: usize = 64;
const MAX_TARGETS_PER_JOB: usize = 20;
const MAX_CONCURRENCY: usize = 4;

#[derive(Clone)]
pub struct DispatcherHandle {
    sender: SyncSender<HookNotificationJob>,
}

impl DispatcherHandle {
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
            while let Ok(job) = receiver.recv() {
                runtime.block_on(process_job(label, client.clone(), job));
            }
        });
        Self { sender }
    }

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

pub async fn test_send(target: ThirdPartyTarget) -> Result<TestSendResult, String> {
    let client = build_client().map_err(|err| err.message)?;
    let message = sample_message();
    Ok(send_one(client, target, message).await)
}

async fn process_job(label: &'static str, client: Client, job: HookNotificationJob) {
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

fn message_from_job(job: HookNotificationJob) -> Option<HookNotificationMessage> {
    if !super::model::is_supported_event(&job.event) {
        return None;
    }
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
    let event_label = event_label(&job.event);
    let summary = event_summary(&job.event, &source, &project);
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

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn local_time_text(value: Option<&str>) -> String {
    value
        .and_then(parse_time)
        .map(|time| time.with_timezone(&Local))
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn normalize_source(value: &str) -> String {
    match value {
        "codex" => "Codex".to_string(),
        "claude" => "Claude Code".to_string(),
        other if !other.trim().is_empty() => other.trim().to_string(),
        _ => "CLI".to_string(),
    }
}

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

    #[test]
    fn message_uses_cwd_basename_only() {
        let message = message_from_job(HookNotificationJob {
            source: "codex".to_string(),
            event: "Stop".to_string(),
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
    fn stop_failure_uses_actionable_event_label() {
        let message = message_from_job(HookNotificationJob {
            source: "claude".to_string(),
            event: "StopFailure".to_string(),
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

    #[test]
    fn permission_request_mentions_approval_action() {
        let message = message_from_job(HookNotificationJob {
            source: "claude".to_string(),
            event: "PermissionRequest".to_string(),
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
    fn message_prefers_safe_project_label_when_cwd_is_redacted() {
        let message = message_from_job(HookNotificationJob {
            source: "codex".to_string(),
            event: "Stop".to_string(),
            cwd: None,
            project: Some("remote-demo".to_string()),
            timestamp: None,
        })
        .unwrap();
        assert_eq!(message.project, "remote-demo");
        assert!(message.body.contains("Codex - remote-demo"));
    }

    #[test]
    fn unsupported_event_is_ignored() {
        assert!(message_from_job(HookNotificationJob {
            source: "claude".to_string(),
            event: "ToolStart".to_string(),
            cwd: None,
            project: None,
            timestamp: None,
        })
        .is_none());
    }
}
