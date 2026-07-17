use crate::commands::ccswitch::{
    apply_codex_provider_launch_env, refresh_claude_provider_launch_settings,
    ClaudeProviderLaunchConfig, CodexProviderLaunchConfig,
};
use crate::daemon::client::{DaemonBridge, DaemonClient};
use crate::daemon::protocol::{SessionMeta, BINARY_PROTOCOL_VERSION};
use crate::pty::manager::{PtyOrphanCleanupSummary, PtyProcessStatus};
use log::{debug, info};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use uuid::Uuid;

const DAEMON_READY_WAIT_ATTEMPTS: usize = 60;
const DAEMON_READY_WAIT_INTERVAL: Duration = Duration::from_millis(100);

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
) -> Result<PreparedPtyCreate, String> {
    let session_id = Uuid::new_v4().to_string();
    let mut env_vars = env_vars.unwrap_or_default();
    refresh_claude_provider_launch_settings(&app_handle, claude_provider).await?;
    apply_codex_provider_launch_env(&app_handle, codex_provider, shell.as_deref(), &mut env_vars)
        .await?;
    env_vars.insert("CLI_MANAGER_TAB_ID".to_string(), session_id.clone());

    let daemon_client = wait_for_daemon(&daemon_bridge)
        .await
        .ok_or_else(|| "PtyHost daemon unavailable".to_string())?;
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
    info!(
        "pty_prepare_create requested: session_id={}, cwd={:?}, shell={:?}, env_vars={}, daemon={}",
        session_id, cwd, shell, env_count, true
    );

    Ok(PreparedPtyCreate {
        session_id,
        cwd,
        env_vars,
        shell,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPtyCreate {
    pub session_id: String,
    pub cwd: Option<String>,
    pub env_vars: HashMap<String, String>,
    pub shell: Option<String>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyHostEndpoint {
    pub url: String,
    pub token: String,
    pub protocol_version: u8,
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
    if info.ws_port == 0 {
        return Ok(None);
    }
    Ok(Some(PtyHostEndpoint {
        url: format!("ws://127.0.0.1:{}/pty", info.ws_port),
        token: info.token.clone(),
        protocol_version: BINARY_PROTOCOL_VERSION,
        daemon_version: info.version.clone(),
    }))
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
            info!(
                "pty_daemon_sessions requested: count={}, alive_count={}",
                sessions.len(),
                alive_count
            );
            Ok(sessions)
        }
        None => {
            info!("pty_daemon_sessions requested: daemon unavailable");
            Ok(Vec::new())
        }
    }
}
