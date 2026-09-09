use super::ClaudeHookRequest;
use crate::codex_goal::{CodexGoalMetadata, CodexGoalStatus};

// 旧 Hook 进程可能没有 goal 字段；仅在本机按精确 session 命中 goal 后补全。
// 接收进程无法确认旧客户端的自定义 CODEX_HOME，因此无行不能证明没有 goal。
pub(super) fn enrich(
    payload: &mut ClaudeHookRequest,
    lookup: impl FnOnce(&str) -> CodexGoalMetadata,
) {
    if payload.source.as_deref() != Some("codex")
        || payload.event != "Stop"
        || payload.goal_status.is_some()
        || payload
            .environment_type
            .as_deref()
            .is_some_and(|kind| kind != "local")
        || payload.wsl_distro_name.is_some()
        || payload.remote_host_id.is_some()
        || payload.remote_transcript_ref.is_some()
        || payload.cwd.as_deref().is_some_and(|cwd| {
            crate::wsl::is_wsl_config_dir(cwd) || (cfg!(windows) && cwd.starts_with('/'))
        })
    {
        return;
    }
    let Some(session_id) = payload
        .session_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
    else {
        return;
    };
    let metadata = lookup(session_id);
    let metadata = if metadata.status == CodexGoalStatus::None {
        CodexGoalMetadata::unknown("legacy_goal_root_unconfirmed")
    } else {
        metadata
    };
    log::debug!(
        "legacy codex Stop resolved: status={}",
        metadata.status.wire_name()
    );
    payload.goal_status = Some(metadata.status.wire_name().to_string());
    payload.goal_id = metadata.goal_id;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 模拟旧二进制的无字段/空字段载荷，验证状态与 goal ID 一起进入转发协议。
    #[test]
    fn legacy_goal_states_survive_serialization() {
        for status in [
            CodexGoalStatus::Active,
            CodexGoalStatus::Complete,
            CodexGoalStatus::Blocked,
            CodexGoalStatus::Paused,
            CodexGoalStatus::BudgetLimited,
            CodexGoalStatus::UsageLimited,
        ] {
            let mut payload: ClaudeHookRequest = serde_json::from_value(json!({
                "tabId": "tab-1", "source": "codex", "event": "Stop", "sessionId": "session-1",
                "goalStatus": null, "goalId": null
            }))
            .unwrap();
            enrich(&mut payload, |session| {
                assert_eq!(session, "session-1");
                CodexGoalMetadata {
                    status,
                    goal_id: Some("goal-1".into()),
                    diagnostic: None,
                }
            });
            let wire = serde_json::to_value(payload).unwrap();
            assert_eq!(wire["goalStatus"], status.wire_name());
            assert_eq!(wire["goalId"], "goal-1");
        }
    }

    // 新客户端、非 Stop、其他 CLI、远程及 WSL 事件不能触发接收端本机数据库查询。
    #[test]
    fn existing_metadata_and_foreign_environments_never_query() {
        for overrides in [
            json!({"goalStatus":"active"}),
            json!({"event":"UserPromptSubmit"}),
            json!({"source":"claude"}),
            json!({"environmentType":"ssh"}),
            json!({"environmentType":"wsl"}),
            json!({"wslDistroName":"Ubuntu"}),
            json!({"remoteHostId":"host-1"}),
            json!({"sessionId":null}),
            json!({"cwd":"\\\\wsl.localhost\\Ubuntu\\home\\me"}),
        ] {
            let mut wire =
                json!({"tabId":"tab-1","source":"codex","event":"Stop","sessionId":"session-1"});
            wire.as_object_mut()
                .unwrap()
                .extend(overrides.as_object().unwrap().clone());
            let mut payload: ClaudeHookRequest = serde_json::from_value(wire).unwrap();
            let before = serde_json::to_value(&payload).unwrap();
            enrich(&mut payload, |_| panic!("must not query host database"));
            assert_eq!(serde_json::to_value(payload).unwrap(), before);
        }
    }

    // 接收端查无行或读取失败都保持 unknown，不能凭默认 Home 给旧客户端报完成。
    #[test]
    fn unconfirmed_database_never_means_completed() {
        for metadata in [
            CodexGoalMetadata::none(),
            CodexGoalMetadata::unknown("goal_db_missing"),
        ] {
            let mut payload: ClaudeHookRequest = serde_json::from_value(json!({
                "tabId":"tab-1","source":"codex","event":"Stop","sessionId":"session-1"
            }))
            .unwrap();
            enrich(&mut payload, |_| metadata);
            assert_eq!(payload.goal_status.as_deref(), Some("unknown"));
            assert!(payload.goal_id.is_none());
        }
    }
}
