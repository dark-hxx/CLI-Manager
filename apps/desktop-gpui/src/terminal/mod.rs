mod model;
pub(crate) mod appearance;
pub(crate) mod clipboard;
pub(crate) mod fonts;
pub(crate) mod path_drop;
pub mod render;

pub use model::TerminalModel;

use cli_manager_pty_client::{Client, ConnectionOptions, Endpoint, Event};
use futures_util::{future::BoxFuture, stream::FuturesUnordered, FutureExt, StreamExt};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionStatus {
    Connecting,
    Running,
    Done,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HookStatus {
    None,
    Running,
    Attention,
    Done,
    Failed,
}

/// Cancels one project attach generation without affecting other sessions.
pub struct AttachCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

/// Current transport handle for one terminal generation. The UI can submit
/// input without owning the websocket task; reconnect replaces the handle.
pub struct TerminalConnection {
    client: Mutex<Option<Client>>,
    status: std::sync::atomic::AtomicU8,
    hook_status: std::sync::atomic::AtomicU8,
}

impl TerminalConnection {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            status: std::sync::atomic::AtomicU8::new(0),
            hook_status: std::sync::atomic::AtomicU8::new(0),
        }
    }

    fn set(&self, client: Client) {
        if let Ok(mut current) = self.client.lock() {
            *current = Some(client);
        }
    }

    fn clear(&self) {
        if let Ok(mut current) = self.client.lock() {
            *current = None;
        }
    }

    pub fn client(&self) -> Option<Client> {
        self.client.lock().ok().and_then(|client| client.clone())
    }

    pub fn status(&self) -> ConnectionStatus {
        match self.status.load(Ordering::Acquire) {
            1 => ConnectionStatus::Running,
            2 => ConnectionStatus::Done,
            3 => ConnectionStatus::Failed,
            _ => ConnectionStatus::Connecting,
        }
    }

    pub fn hook_status(&self) -> HookStatus {
        match self.hook_status.load(Ordering::Acquire) {
            1 => HookStatus::Running,
            2 => HookStatus::Attention,
            3 => HookStatus::Done,
            4 => HookStatus::Failed,
            _ => HookStatus::None,
        }
    }

    fn set_status(&self, status: ConnectionStatus) {
        let value = match status {
            ConnectionStatus::Connecting => 0,
            ConnectionStatus::Running => 1,
            ConnectionStatus::Done => 2,
            ConnectionStatus::Failed => 3,
        };
        self.status.store(value, Ordering::Release);
    }

    fn set_hook_status(&self, status: HookStatus) {
        let value = match status {
            HookStatus::None => 0,
            HookStatus::Running => 1,
            HookStatus::Attention => 2,
            HookStatus::Done => 3,
            HookStatus::Failed => 4,
        };
        self.hook_status.store(value, Ordering::Release);
    }
}

#[derive(Clone)]
pub struct SessionHandle {
    pub model: Arc<Mutex<TerminalModel>>,
    pub cancellation: Arc<AttachCancellation>,
    pub connection: Arc<TerminalConnection>,
}

impl SessionHandle {
    pub fn new(
        model: Arc<Mutex<TerminalModel>>,
        cancellation: Arc<AttachCancellation>,
        connection: Arc<TerminalConnection>,
    ) -> Self {
        Self {
            model,
            cancellation,
            connection,
        }
    }
}

/// Keeps transport handles independent from whichever Pane is currently visible.
pub struct SessionRegistry {
    sessions: BTreeMap<String, SessionHandle>,
    active: Option<String>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: BTreeMap::new(),
            active: None,
        }
    }
    pub fn insert(&mut self, session_id: String, handle: SessionHandle) {
        self.active = Some(session_id.clone());
        self.sessions.insert(session_id, handle);
    }
    pub fn active(&self) -> Option<&SessionHandle> {
        self.active.as_ref().and_then(|id| self.sessions.get(id))
    }
    pub fn get(&self, session_id: &str) -> Option<&SessionHandle> {
        self.sessions.get(session_id)
    }
    pub fn active_session_id(&self) -> Option<&str> {
        self.active.as_deref()
    }
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }
    pub fn clients(&self) -> Vec<Client> {
        self.sessions
            .values()
            .filter_map(|handle| handle.connection.client())
            .collect()
    }
    #[allow(dead_code)]
    pub fn set_active(&mut self, session_id: &str) -> bool {
        if self.sessions.contains_key(session_id) {
            self.active = Some(session_id.to_owned());
            true
        } else {
            false
        }
    }
    pub fn remove(&mut self, session_id: &str) -> Option<SessionHandle> {
        let handle = self.sessions.remove(session_id)?;
        handle.cancellation.cancel();
        if self.active.as_deref() == Some(session_id) {
            self.active = self.sessions.keys().next_back().cloned();
        }
        Some(handle)
    }
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.sessions.len()
    }
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_reports_map_to_tab_status_and_match_session() {
        let running = serde_json::json!({
            "type": "hook_report",
            "payload": { "tabId": "session", "event": "UserPromptSubmit", "source": "claude" }
        });
        assert_eq!(hook_session_id(&running), Some("session"));
        assert_eq!(hook_status(&running), Some(HookStatus::Running));

        let attention = serde_json::json!({
            "type": "hook_report",
            "payload": { "tab_id": "session", "event": "PermissionRequest", "source": "codex" }
        });
        assert_eq!(hook_status(&attention), Some(HookStatus::Attention));

        let done = serde_json::json!({
            "type": "hook_report",
            "payload": { "tabId": "session", "event": "Stop", "source": "claude" }
        });
        assert_eq!(hook_status(&done), Some(HookStatus::Done));
    }

    #[test]
    fn removing_active_session_cancels_it_and_selects_a_remaining_session() {
        let first = model("first".to_owned()).unwrap();
        let second = model("second".to_owned()).unwrap();
        let first_cancel = Arc::new(AttachCancellation::new());
        let second_cancel = Arc::new(AttachCancellation::new());
        let mut registry = SessionRegistry::new();
        registry.insert(
            "first".to_owned(),
            SessionHandle::new(
                first,
                first_cancel.clone(),
                Arc::new(TerminalConnection::new()),
            ),
        );
        registry.insert(
            "second".to_owned(),
            SessionHandle::new(
                second,
                second_cancel.clone(),
                Arc::new(TerminalConnection::new()),
            ),
        );

        assert!(registry.remove("second").is_some());
        assert!(second_cancel.is_cancelled());
        assert_eq!(registry.active_session_id(), Some("first"));
        assert_eq!(registry.session_ids(), vec!["first".to_owned()]);
        assert!(!first_cancel.is_cancelled());
    }
}

impl AttachCancellation {
    pub fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn wait(&self) {
        let notified = self.notify.notified();
        if !self.is_cancelled() {
            notified.await;
        }
    }
}

/// Creates or probes a project session before attaching. The stable session ID
/// makes a lost create response recoverable without launching a second PTY.
pub async fn attach_existing_session(
    model: Arc<Mutex<TerminalModel>>,
    cancellation: Arc<AttachCancellation>,
    connection: Arc<TerminalConnection>,
) -> Result<(), String> {
    attach_with_reconnect(model, None, cancellation, connection).await
}

pub async fn attach_project_from_environment(
    model: Arc<Mutex<TerminalModel>>,
    cwd: String,
    shell: Option<String>,
    cancellation: Arc<AttachCancellation>,
    connection: Arc<TerminalConnection>,
) -> Result<(), String> {
    attach_with_reconnect(model, Some((cwd, shell)), cancellation, connection).await
}

async fn attach_with_reconnect(
    model: Arc<Mutex<TerminalModel>>,
    bootstrap: Option<(String, Option<String>)>,
    cancellation: Arc<AttachCancellation>,
    connection: Arc<TerminalConnection>,
) -> Result<(), String> {
    connection.set_status(ConnectionStatus::Connecting);
    let mut delay = std::time::Duration::from_millis(250);
    loop {
        if cancellation.is_cancelled() {
            return Ok(());
        }
        let endpoint = match endpoint_from_environment_or_discovery() {
            Ok(endpoint) => endpoint,
            Err(error) => {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = cancellation.wait() => return Ok(()),
                }
                delay = (delay * 2).min(std::time::Duration::from_secs(5));
                eprintln!("GPUI terminal waiting for daemon endpoint: {error}");
                continue;
            }
        };
        let attempt = attach_once(
            model.clone(),
            endpoint,
            bootstrap.as_ref(),
            cancellation.clone(),
            connection.clone(),
        );
        let result = tokio::select! {
            result = attempt => result,
            _ = cancellation.wait() => return Ok(()),
        };
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                if error == "session not found"
                    || error.starts_with("session exited")
                    || error.starts_with("session error")
                    || error.starts_with("session failed")
                {
                    connection.set_status(if error.starts_with("session exited") {
                        ConnectionStatus::Done
                    } else {
                        ConnectionStatus::Failed
                    });
                    return Err(error);
                }
                connection.set_status(ConnectionStatus::Connecting);
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = cancellation.wait() => return Ok(()),
                }
                delay = (delay * 2).min(std::time::Duration::from_secs(5));
                eprintln!("GPUI terminal reconnecting after transport error: {error}");
            }
        }
    }
}

async fn attach_once(
    model: Arc<Mutex<TerminalModel>>,
    endpoint: Endpoint,
    bootstrap: Option<&(String, Option<String>)>,
    cancellation: Arc<AttachCancellation>,
    connection: Arc<TerminalConnection>,
) -> Result<(), String> {
    let (client, mut events) = Client::connect(endpoint, ConnectionOptions::default()).await?;
    if let Err(error) = crate::routing_bootstrap::reconcile_persisted_service().await {
        eprintln!("GPUI persisted routing reconciliation skipped: {error}");
    }
    connection.set(client.clone());
    let _connection_lease = ConnectionLease {
        connection: connection.clone(),
    };
    let (cursor, after) = {
        let model = model.lock().map_err(|_| "terminal model poisoned")?;
        (model.session_id(), model.after_sequence())
    };
    let mut requests: FuturesUnordered<BoxFuture<'static, Result<(), String>>> =
        FuturesUnordered::new();
    let mut attached_by_bootstrap = false;
    if let Some((cwd, shell)) = bootstrap {
        let response = client
            .attach_or_create(&cursor, after, Some(cwd), shell.as_deref())
            .await?;
        attached_by_bootstrap = response["type"] == "attached";
        connection.set_status(ConnectionStatus::Running);
    }
    if !attached_by_bootstrap {
        let attach_client = client.clone();
        let attach_session = cursor.clone();
        requests.push(
            async move {
                attach_client
                    .attach(&attach_session, after)
                    .await
                    .map(|_| ())
            }
            .boxed(),
        );
    }
    loop {
        tokio::select! {
            _ = cancellation.wait() => return Ok(()),
            result = requests.next(), if !requests.is_empty() => {
                result.ok_or("terminal request stream closed")??;
                connection.set_status(ConnectionStatus::Running);
            }
            event = events.recv() => match event {
                Some(Event::Output(output)) => {
                    let parse_model = model.clone();
                    let (output, ack, terminal_events, checkpoint) = tokio::task::spawn_blocking(move || {
                        let mut model = parse_model.lock().map_err(|_| "terminal model poisoned")?;
                        let ack = model.apply(&output)?;
                        let checkpoint = if ack && output.sequence > 0 && output.sequence % 128 == 0 {
                            Some(model.checkpoint_payload())
                        } else {
                            None
                        };
                        Ok::<_, String>((output, ack, model.events()?, checkpoint))
                    }).await.map_err(|_| "terminal parse worker failed")??;
                    let sequence = output.sequence;
                    if ack {
                        let client = client.clone();
                        requests.push(async move { client.commit(&output).await }.boxed());
                    }
                    if let Some((cols, rows, data)) = checkpoint {
                        let checkpoint_client = client.clone();
                        let checkpoint_session = cursor.clone();
                        requests.push(async move {
                            checkpoint_client
                                .checkpoint(&checkpoint_session, sequence, cols, rows, &data)
                                .await
                        }.boxed());
                    }
                    for event in terminal_events {
                        if let cli_manager_term_engine::Event::PtyWrite(data) = event {
                            let client = client.clone();
                            let session = cursor.clone();
                                requests.push(async move { client.write_bytes(&session, data.as_bytes()).await }.boxed());
                        }
                    }
                    if requests.len() > 256 { return Err("terminal control queue overflow".into()); }
                }
                Some(Event::Control(value)) => {
                    if matches!(value["type"].as_str(), Some("checkpoint_accepted" | "checkpoint_rejected")) {
                        eprintln!("GPUI terminal checkpoint response: {}", value["type"]);
                    }
                    if value["type"] == "session_status"
                        && value["session_id"].as_str() == Some(cursor.as_str())
                    {
                        let status = value["status"].as_str().unwrap_or("unknown");
                        if matches!(status, "exited" | "error" | "failed") {
                            connection.set_status(if status == "exited" {
                                ConnectionStatus::Done
                            } else {
                                ConnectionStatus::Failed
                            });
                            return Err(format!("session {status}"));
                        }
                    }
                    if value["type"] == "hook_report"
                        && hook_session_id(&value) == Some(cursor.as_str())
                    {
                        if let Some(status) = hook_status(&value) {
                            connection.set_hook_status(status);
                        }
                    }
                }
                Some(Event::Disconnected) | None => {
                    connection.set_status(ConnectionStatus::Failed);
                    return Err("daemon connection lost".into());
                }
            }
        }
    }
}

fn hook_session_id(value: &serde_json::Value) -> Option<&str> {
    value
        .get("payload")
        .and_then(|payload| payload.get("tabId").or_else(|| payload.get("tab_id")))
        .and_then(serde_json::Value::as_str)
}

fn hook_status(value: &serde_json::Value) -> Option<HookStatus> {
    let payload = value.get("payload")?;
    let event = payload.get("event")?.as_str()?;
    let source = payload
        .get("source")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let status = match event {
        "UserPromptSubmit" | "SessionStart" => HookStatus::Running,
        "Notification" | "PermissionRequest" => HookStatus::Attention,
        "StopFailure" => HookStatus::Failed,
        "Stop" if source == "codex" => match payload
            .get("goalStatus")
            .and_then(serde_json::Value::as_str)
        {
            Some("active" | "running" | "budgetLimited") => HookStatus::Running,
            Some("attention" | "needsInput" | "needsApproval") => HookStatus::Attention,
            Some("failed" | "error") => HookStatus::Failed,
            _ => HookStatus::Done,
        },
        "Stop" => HookStatus::Done,
        _ => return None,
    };
    Some(status)
}

struct ConnectionLease {
    connection: Arc<TerminalConnection>,
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        self.connection.clear();
    }
}

fn endpoint_from_environment_or_discovery() -> Result<Endpoint, String> {
    match (
        std::env::var("CLI_MANAGER_DAEMON_WS_PORT"),
        std::env::var("CLI_MANAGER_DAEMON_TOKEN"),
    ) {
        (Ok(port), Ok(token)) => {
            return Endpoint::new(
                port.parse::<u16>()
                    .map_err(|_| "invalid daemon endpoint port")?,
                token,
            )
        }
        (Err(_), Err(_)) => {}
        _ => return Err("daemon endpoint configuration is incomplete".into()),
    }
    let database = crate::paths::database_path()?;
    let root = database.parent().ok_or("daemon data root unavailable")?;
    crate::daemon_bootstrap::endpoint_or_start(root)
}

pub fn model(session_id: String) -> Result<Arc<Mutex<TerminalModel>>, String> {
    Ok(Arc::new(Mutex::new(TerminalModel::new(session_id)?)))
}
pub(crate) mod cache_benchmark;
mod cache_metrics;
pub(crate) mod row_cache;
