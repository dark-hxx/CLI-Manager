use crate::commands::ccswitch::{
    apply_codex_provider_launch_env, refresh_claude_provider_launch_settings,
    ClaudeProviderLaunchConfig, CodexProviderLaunchConfig,
};
use crate::daemon::client::{DaemonBridge, DaemonClient};
use crate::daemon::protocol::{ClientFrame, SessionMeta, FEATURE_WS_BINARY_OUTPUT};
use crate::pty::manager::{PtyOrphanCleanupSummary, PtyProcessStatus};
use crate::ssh_launch::SshLaunchPlan;
use log::{debug, warn};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use uuid::Uuid;

const DAEMON_READY_WAIT_ATTEMPTS: usize = 60;
const DAEMON_READY_WAIT_INTERVAL: Duration = Duration::from_millis(100);

fn provider_launch_configs(
    is_ssh: bool,
    claude: Option<ClaudeProviderLaunchConfig>,
    codex: Option<CodexProviderLaunchConfig>,
) -> (
    Option<ClaudeProviderLaunchConfig>,
    Option<CodexProviderLaunchConfig>,
) {
    if is_ssh {
        (None, None)
    } else {
        (claude, codex)
    }
}

async fn wait_for_daemon(daemon_bridge: &DaemonBridge) -> Option<Arc<DaemonClient>> {
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

#[tauri::command]
pub async fn pty_prepare_create(
    app_handle: AppHandle,
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    cwd: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    shell: Option<String>,
    hook_env_enabled: Option<bool>,
    claude_provider: Option<ClaudeProviderLaunchConfig>,
    codex_provider: Option<CodexProviderLaunchConfig>,
    ssh_launch: Option<SshLaunchPlan>,
) -> Result<PreparedPtyCreate, String> {
    let session_id = Uuid::new_v4().to_string();
    let mut env_vars = env_vars.unwrap_or_default();
    let (claude_provider, codex_provider) =
        provider_launch_configs(ssh_launch.is_some(), claude_provider, codex_provider);
    refresh_claude_provider_launch_settings(&app_handle, claude_provider).await?;
    apply_codex_provider_launch_env(&app_handle, codex_provider, shell.as_deref(), &mut env_vars)
        .await?;
    env_vars.insert("CLI_MANAGER_TAB_ID".to_string(), session_id.clone());
    let mut ssh_launch = ssh_launch;
    if let Some(plan) = ssh_launch.as_mut() {
        for key in [
            "CLI_MANAGER_SSH_HOST_ID",
            "CLI_MANAGER_SSH_CLIENT_INSTANCE_ID",
            "CLI_MANAGER_PROJECT_ID",
            "CLI_MANAGER_TAB_ID",
            "CLI_MANAGER_BRIDGE_EPOCH",
        ] {
            plan.environment_overrides.remove(key);
        }
        plan.environment_overrides
            .insert("CLI_MANAGER_SSH_HOST_ID".to_string(), plan.host_id.clone());
        plan.environment_overrides
            .insert("CLI_MANAGER_TAB_ID".to_string(), session_id.clone());
        if !plan.client_instance_id.is_empty() {
            plan.environment_overrides.insert(
                "CLI_MANAGER_SSH_CLIENT_INSTANCE_ID".to_string(),
                plan.client_instance_id.clone(),
            );
        }
        if !plan.project_id.is_empty() {
            plan.environment_overrides.insert(
                "CLI_MANAGER_PROJECT_ID".to_string(),
                plan.project_id.clone(),
            );
        }
        if !plan.bridge_epoch.is_empty() {
            plan.environment_overrides.insert(
                "CLI_MANAGER_BRIDGE_EPOCH".to_string(),
                plan.bridge_epoch.clone(),
            );
        }
    }

    // Hook 上报指向 daemon 的稳定端口，确保 app 重启后仍然有效。
    let daemon_client = wait_for_daemon(&daemon_bridge)
        .await
        .ok_or_else(|| "PtyHost daemon unavailable".to_string())?;
    if ssh_launch.is_some() && daemon_client.info().version != env!("CARGO_PKG_VERSION") {
        warn!(
            "SSH launch rejected for stale daemon: daemon_version={}, app_version={}",
            daemon_client.info().version,
            env!("CARGO_PKG_VERSION")
        );
        return Err("SSH launch requires the current PtyHost daemon".to_string());
    }
    if hook_env_enabled.unwrap_or(false) {
        let info = daemon_client.info();
        if info.hook_port > 0 {
            env_vars.insert(
                "CLI_MANAGER_NOTIFY_PORT".to_string(),
                info.hook_port.to_string(),
            );
            env_vars.insert("CLI_MANAGER_NOTIFY_TOKEN".to_string(), info.token.clone());
        }
    }

    let env_count = env_vars.len();
    debug!(
        "pty_prepare_create requested: session_id={}, cwd={:?}, shell={:?}, env_vars={}, daemon={}",
        session_id, cwd, shell, env_count, true
    );

    Ok(PreparedPtyCreate {
        session_id,
        cwd,
        env_vars,
        shell,
        ssh_launch,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPtyCreate {
    pub session_id: String,
    pub cwd: Option<String>,
    pub env_vars: HashMap<String, String>,
    pub shell: Option<String>,
    pub ssh_launch: Option<SshLaunchPlan>,
}

#[tauri::command]
pub async fn pty_reconcile_active_sessions(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    active_session_ids: Vec<String>,
) -> Result<PtyOrphanCleanupSummary, String> {
    debug!(
        "pty_reconcile_active_sessions requested: active_count={}",
        active_session_ids.len()
    );
    let summary = daemon_bridge
        .get()
        .ok_or_else(|| "PtyHost daemon unavailable".to_string())?
        .reconcile(active_session_ids)?;
    serde_json::from_value(summary)
        .map_err(|err| format!("daemon reconcile summary parse failed: {err}"))
}

#[tauri::command]
pub async fn pty_status(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<HashMap<String, PtyProcessStatus>, String> {
    debug!("pty_status requested");
    daemon_bridge
        .get()
        .ok_or_else(|| "PtyHost daemon unavailable".to_string())?
        .status_all()
}

/// daemon 是否可用（前端"转入后台=真退出"分支判定）。
#[tauri::command]
pub async fn pty_daemon_active(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<bool, String> {
    Ok(daemon_bridge.get().is_some())
}

#[tauri::command]
pub async fn pty_daemon_shutdown_if_idle(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<bool, String> {
    let Some(client) = daemon_bridge.get() else {
        return Ok(false);
    };
    client.shutdown_if_idle()?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyHostEndpoint {
    pub transport_mode: String,
    pub url: Option<String>,
    pub token: Option<String>,
    pub protocol_version: u16,
    pub binary_protocol_version: u8,
    pub features: Vec<String>,
    pub daemon_version: String,
}

/// WebView 只通过低频 Tauri command 获取本机 PtyHost 地址与短期鉴权信息。
#[tauri::command]
pub async fn pty_host_get_endpoint(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<Option<PtyHostEndpoint>, String> {
    let Some(client) = wait_for_daemon(&daemon_bridge).await else {
        return Ok(None);
    };
    let info = client.info();
    let websocket_available = info.ws_port > 0
        && info.protocol_version > 0
        && info
            .features
            .iter()
            .any(|feature| feature == FEATURE_WS_BINARY_OUTPUT);
    Ok(Some(PtyHostEndpoint {
        transport_mode: if websocket_available {
            "websocket".to_string()
        } else {
            "legacy".to_string()
        },
        url: websocket_available.then(|| format!("ws://127.0.0.1:{}/pty", info.ws_port)),
        token: websocket_available.then(|| info.token.clone()),
        protocol_version: info.protocol_version,
        binary_protocol_version: info.binary_protocol_version,
        features: info.features.clone(),
        daemon_version: info.version.clone(),
    }))
}

fn client_frame_id(frame: &ClientFrame) -> Option<u64> {
    match frame {
        ClientFrame::Auth { .. } => None,
        ClientFrame::Ping { id }
        | ClientFrame::List { id }
        | ClientFrame::Create { id, .. }
        | ClientFrame::SetTerminalColors { id, .. }
        | ClientFrame::Write { id, .. }
        | ClientFrame::Ack { id, .. }
        | ClientFrame::Resize { id, .. }
        | ClientFrame::Close { id, .. }
        | ClientFrame::CloseAll { id }
        | ClientFrame::Attach { id, .. }
        | ClientFrame::Detach { id }
        | ClientFrame::Reconcile { id, .. }
        | ClientFrame::Status { id }
        | ClientFrame::SshAgentRequest { id, .. }
        | ClientFrame::SshAgentRelease { id, .. }
        | ClientFrame::Shutdown { id } => Some(*id),
    }
}

/// 旧 daemon 的兼容 transport。只复用已鉴权的主进程 NDJSON 连接，
/// WebView 不接触 daemon token，也不能绕过 daemon 自身的参数校验。
#[tauri::command]
pub async fn pty_legacy_request(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    frame: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let frame: ClientFrame = serde_json::from_value(frame)
        .map_err(|err| format!("invalid legacy PtyHost request: {err}"))?;
    let id = client_frame_id(&frame).ok_or_else(|| "legacy auth is not allowed".to_string())?;
    let client = wait_for_daemon(&daemon_bridge)
        .await
        .ok_or_else(|| "PtyHost daemon unavailable".to_string())?;
    let reply = client.request(id, &frame)?;
    serde_json::to_value(reply).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn pty_daemon_upgrade_if_idle(
    app_handle: AppHandle,
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<bool, String> {
    let Some(client) = daemon_bridge.get() else {
        return Ok(false);
    };
    if client
        .info()
        .features
        .iter()
        .any(|feature| feature == FEATURE_WS_BINARY_OUTPUT)
    {
        return Ok(true);
    }
    if client.list()?.iter().any(|session| session.alive) {
        return Ok(false);
    }
    client.shutdown_if_idle()?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let data_dir = crate::app_paths::cli_manager_data_dir()?;
    let client =
        crate::daemon::client::connect_or_spawn(app_handle, &data_dir, cfg!(debug_assertions))?;
    daemon_bridge.set(client);
    Ok(true)
}

/// daemon 中的会话列表（启动恢复时优先 attach 的依据）。
#[tauri::command]
pub async fn pty_daemon_sessions(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<Vec<SessionMeta>, String> {
    match wait_for_daemon(&daemon_bridge).await {
        Some(client) => {
            let sessions = client.list()?;
            let alive_count = sessions.iter().filter(|session| session.alive).count();
            debug!(
                "pty_daemon_sessions requested: count={}, alive_count={}",
                sessions.len(),
                alive_count
            );
            Ok(sessions)
        }
        None => {
            debug!("pty_daemon_sessions requested: daemon unavailable");
            Ok(Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{provider_launch_configs, ClaudeProviderLaunchConfig, CodexProviderLaunchConfig};

    fn configs() -> (
        Option<ClaudeProviderLaunchConfig>,
        Option<CodexProviderLaunchConfig>,
    ) {
        (
            Some(ClaudeProviderLaunchConfig {
                project_id: "project".to_string(),
                provider_id: "claude-provider".to_string(),
                db_path: Some("provider.db".to_string()),
            }),
            Some(CodexProviderLaunchConfig {
                provider_id: "codex-provider".to_string(),
                db_path: Some("provider.db".to_string()),
                codex_config_dir: Some("codex".to_string()),
            }),
        )
    }

    #[test]
    fn ssh_launch_discards_provider_configs() {
        let (claude, codex) = configs();
        let (claude, codex) = provider_launch_configs(true, claude, codex);
        assert!(claude.is_none());
        assert!(codex.is_none());

        let (claude, codex) = configs();
        let (claude, codex) = provider_launch_configs(false, claude, codex);
        assert!(claude.is_some());
        assert!(codex.is_some());
    }
}
