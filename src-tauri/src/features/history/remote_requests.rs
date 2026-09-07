use super::{DAEMON_READY_WAIT_ATTEMPTS, DAEMON_READY_WAIT_INTERVAL};
use crate::daemon::client::DaemonBridge;
use crate::ssh_launch::SshLaunchPlan;
use cli_manager_history_core::RemoteHistorySyncResult;
use serde_json::{json, Value};

pub(super) fn validate_remote_history_plan(
    plan: &SshLaunchPlan,
    source: &str,
) -> Result<(), String> {
    if !matches!(source, "claude" | "codex")
        || plan.host_id.trim().is_empty()
        || plan.agent_path.trim().is_empty()
        || plan.agent_installation_id.trim().is_empty()
        || plan.agent_remote_machine_id.trim().is_empty()
        || plan.client_instance_id.trim().is_empty()
        || (!plan.tool_source.is_empty() && plan.tool_source != source)
    {
        return Err("history_remote_plan_invalid".to_string());
    }
    Ok(())
}

pub(super) fn remote_scope_payload(
    source: &str,
    configured_config_root: &str,
    project_paths: Vec<String>,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Value {
    json!({
        "source": source,
        "configuredConfigRoot": configured_config_root,
        "projectPaths": project_paths,
        "cursor": cursor.unwrap_or_default(),
        "limit": limit.unwrap_or(200).clamp(1, 1000),
    })
}

pub(super) fn remote_history_get_payload(
    source: &str,
    configured_config_root: &str,
    project_paths: Vec<String>,
    source_session_id: String,
    remote_transcript_ref: Option<String>,
) -> Value {
    let mut payload =
        remote_scope_payload(source, configured_config_root, project_paths, None, Some(1));
    payload["sourceSessionId"] = Value::String(source_session_id);
    payload["remoteTranscriptRef"] = Value::String(remote_transcript_ref.unwrap_or_default());
    payload
}

pub(super) fn remote_error_code(error: &str) -> &str {
    error
        .split([':', ' '])
        .find(|value| !value.is_empty())
        .unwrap_or("history_remote_unavailable")
}

pub(super) async fn wait_for_history_daemon(
    daemon_bridge: &DaemonBridge,
) -> Option<std::sync::Arc<crate::daemon::client::DaemonClient>> {
    for attempt in 0..DAEMON_READY_WAIT_ATTEMPTS {
        if let Some(client) = daemon_bridge.get() {
            return Some(client);
        }
        if attempt + 1 < DAEMON_READY_WAIT_ATTEMPTS {
            tokio::time::sleep(DAEMON_READY_WAIT_INTERVAL).await;
        }
    }
    None
}

pub(super) fn validate_remote_history_sync_result(
    plan: &SshLaunchPlan,
    source: &str,
    configured_config_root: &str,
    expected_source_instance_id: Option<&str>,
    result: &RemoteHistorySyncResult,
) -> Result<(), String> {
    if result.source != source
        || result.installation_id != plan.agent_installation_id
        || result.remote_machine_id != plan.agent_remote_machine_id
        || result.configured_config_root != configured_config_root.trim()
        || (!plan.username.trim().is_empty() && result.ssh_user != plan.username.trim())
        || expected_source_instance_id
            .filter(|value| !value.trim().is_empty())
            .is_some_and(|expected| result.source_instance_id != expected)
        || result.sessions.iter().any(|summary| {
            summary.session_ref.source_instance_id != result.source_instance_id
                || summary.session_ref.source_id != source
                || summary.session_ref.transport_kind != "ssh"
        })
    {
        return Err("history_remote_identity_changed".to_string());
    }
    Ok(())
}
