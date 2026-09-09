use super::{now_ms, DaemonHost};
use crate::codex_goal::{classify_codex_stop, codex_goal_status_is_terminal, CodexGoalHookState};

impl DaemonHost {
    // 按 Hook 事件映射更新会话的任务状态和本机接收时间。
    pub(super) fn update_task_status_from_hook(&self, payload: &serde_json::Value) {
        let Some(session_id) = payload
            .get("tabId")
            .or_else(|| payload.get("tab_id"))
            .and_then(|value| value.as_str())
        else {
            return;
        };
        let Some(event) = payload.get("event").and_then(|value| value.as_str()) else {
            return;
        };
        let source = payload
            .get("source")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let goal_status = payload.get("goalStatus").and_then(|value| value.as_str());
        let Some(task_status) = map_hook_event_to_task_status_for_payload(
            source,
            event,
            goal_status,
        ) else {
            return;
        };
        let updated_at_ms = now_ms();
        if let Some(session) = self.get_session(session_id) {
            if let Ok(mut entry) = session.lock() {
                if event == "UserPromptSubmit" || event == "SessionStart" {
                    entry.hook_goal_key = None;
                    entry.hook_goal_status = None;
                }
                if source == "codex" && event == "Stop" {
                    let goal_key = payload
                        .get("goalId")
                        .or_else(|| payload.get("sessionId"))
                        .and_then(|value| value.as_str())
                        .unwrap_or(session_id)
                        .to_string();
                    if entry.hook_goal_key.as_deref() == Some(goal_key.as_str())
                        && codex_goal_status_is_terminal(entry.hook_goal_status.as_deref())
                        && entry.hook_goal_status.as_deref() != goal_status
                    {
                        return;
                    }
                    entry.hook_goal_key = Some(goal_key);
                    entry.hook_goal_status = goal_status.map(str::to_string);
                }
                entry.meta.task_status = Some(task_status.to_string());
                entry.meta.task_updated_at_ms = Some(updated_at_ms);
                log::debug!(
                    "daemon task status updated: session_id={}, event={}, status={}",
                    session_id,
                    event,
                    task_status
                );
            }
        }
    }
}

// 将支持的 Hook 事件映射为 running、attention、done 或 failed。
pub(super) fn map_hook_event_to_task_status(event: &str) -> Option<&'static str> {
    match event {
        "UserPromptSubmit" => Some("running"),
        "Notification" | "PermissionRequest" => Some("attention"),
        "Stop" => Some("done"),
        "StopFailure" => Some("failed"),
        _ => None,
    }
}

// 将来源和可选 Codex goal 状态合并为 daemon 对外的会话任务状态。
pub(super) fn map_hook_event_to_task_status_for_payload(
    source: &str,
    event: &str,
    goal_status: Option<&str>,
) -> Option<&'static str> {
    if source == "codex" && event == "Stop" {
        return Some(match classify_codex_stop(goal_status) {
            CodexGoalHookState::Running => "running",
            CodexGoalHookState::Attention => "attention",
            CodexGoalHookState::Completed => "done",
            CodexGoalHookState::Failed => "failed",
        });
    }
    map_hook_event_to_task_status(event)
}
