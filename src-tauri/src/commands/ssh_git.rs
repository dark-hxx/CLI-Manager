use crate::daemon::client::DaemonBridge;
use crate::ssh_launch::SshLaunchPlan;
use serde_json::{json, Value};

fn validate_plan(plan: &SshLaunchPlan) -> Result<(), String> {
    if plan.host_id.trim().is_empty()
        || plan.agent_path.trim().is_empty()
        || plan.agent_installation_id.trim().is_empty()
        || plan.agent_remote_machine_id.trim().is_empty()
        || plan.client_instance_id.trim().is_empty()
    {
        return Err("remote_git_plan_invalid".to_string());
    }
    Ok(())
}

async fn request(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    kind: &'static str,
    payload: Value,
) -> Result<Value, String> {
    validate_plan(&ssh_launch)?;
    let client = daemon_bridge
        .get()
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    tokio::task::spawn_blocking(move || {
        client.ssh_agent_request(consumer_id, ssh_launch, kind.to_string(), payload)
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
    root_path: String,
    repo_path: String,
    relative_path: String,
) -> Result<Value, String> {
    let kind = match kind.as_str() {
        "gitListRepositories" => "gitListRepositories",
        "gitChanges" => "gitChanges",
        "gitDiff" => "gitDiff",
        "gitBranchStatus" => "gitBranchStatus",
        "gitBranches" => "gitBranches",
        _ => return Err("remote_git_kind_invalid".to_string()),
    };
    request(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        kind,
        json!({ "rootPath": root_path, "repoPath": repo_path, "relativePath": relative_path }),
    )
    .await
}
