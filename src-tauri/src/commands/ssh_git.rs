use crate::daemon::client::DaemonBridge;
use crate::ssh_launch::SshLaunchPlan;
use serde_json::{json, Value};

fn validate_plan(plan: &SshLaunchPlan) -> Result<(), String> {
    if plan.host_id.trim().is_empty()
        || plan.agent_path.trim().is_empty()
        || plan.agent_installation_id.trim().is_empty()
        || plan.agent_remote_machine_id.trim().is_empty()
        || plan.client_instance_id.trim().is_empty()
        || plan.remote_path.trim().is_empty()
    {
        return Err("remote_git_plan_invalid".to_string());
    }
    Ok(())
}

fn validate_root_binding(remote_path: &str, payload: &Value) -> Result<(), String> {
    let root_path = payload
        .get("rootPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote_git_request_invalid".to_string())?;
    if root_path != remote_path {
        return Err("remote_git_root_mismatch".to_string());
    }
    Ok(())
}

async fn request(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    kind: &str,
    payload: Value,
) -> Result<Value, String> {
    validate_plan(&ssh_launch)?;
    let client = daemon_bridge
        .get()
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    let kind = kind.to_string();
    tokio::task::spawn_blocking(move || {
        client.ssh_agent_request(consumer_id, ssh_launch, kind, payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn ssh_remote_git_request(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    kind: String,
    payload: Value,
) -> Result<Value, String> {
    let kind = match kind.as_str() {
        "gitListRepositories" => "gitListRepositories",
        "gitChanges" => "gitChanges",
        "gitDiff" => "gitDiff",
        "gitBranchStatus" => "gitBranchStatus",
        "gitBranches" => "gitBranches",
        "gitStage" | "gitUnstage" | "gitStageAll" | "gitUnstageAll" | "gitDiscardFile"
        | "gitDeleteUntracked" | "gitRevertHunk" | "gitRevertLines" | "gitCommit"
        | "gitCommitPaths" | "gitFetch" | "gitPush" | "gitCheckout" | "gitSmartCheckout"
        | "gitCreateBranch" | "gitPull" | "gitPullAbort" | "gitRebaseContinue" => kind.as_str(),
        _ => return Err("remote_git_kind_invalid".to_string()),
    };
    let object = payload
        .as_object()
        .ok_or_else(|| "remote_git_request_invalid".to_string())?;
    validate_root_binding(&ssh_launch.remote_path, &payload)?;
    if kind != "gitListRepositories" && object.get("repoPath").and_then(Value::as_str).is_none() {
        return Err("remote_git_request_invalid".to_string());
    }
    request(daemon_bridge, consumer_id, ssh_launch, kind, json!(payload)).await
}

#[cfg(test)]
mod tests {
    use super::validate_root_binding;
    use serde_json::json;

    #[test]
    fn git_root_must_match_launch_plan() {
        assert!(
            validate_root_binding("/srv/project", &json!({ "rootPath": "/srv/project" })).is_ok()
        );
        assert_eq!(
            validate_root_binding("/srv/project", &json!({ "rootPath": "/srv/other" }))
                .unwrap_err(),
            "remote_git_root_mismatch"
        );
        assert_eq!(
            validate_root_binding("/srv/project", &json!({})).unwrap_err(),
            "remote_git_request_invalid"
        );
    }
}
