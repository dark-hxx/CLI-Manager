use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackgroundSession {
    pub session_id: String,
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub alive: bool,
    pub task_status: Option<String>,
    pub task_updated_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub replay_available: bool,
}

impl BackgroundSession {
    fn from_value(value: &Value) -> Result<Self, String> {
        let session_id = value["sessionId"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "daemon session metadata missing sessionId".to_string())?
            .to_owned();
        Ok(Self {
            session_id,
            cwd: value["cwd"].as_str().map(str::to_owned),
            shell: value["shell"].as_str().map(str::to_owned),
            alive: value["alive"].as_bool().unwrap_or(false),
            task_status: value["taskStatus"].as_str().map(str::to_owned),
            task_updated_at_ms: value["taskUpdatedAtMs"].as_u64(),
            created_at_ms: value["createdAtMs"].as_u64().unwrap_or_default(),
            replay_available: value["replayAvailable"].as_bool().unwrap_or(false),
        })
    }

    pub(crate) fn is_finished(&self) -> bool {
        !self.alive
            || matches!(
                self.task_status.as_deref(),
                Some("done" | "failed" | "exited")
            )
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct BackgroundSessionStore {
    sessions: BTreeMap<String, BackgroundSession>,
}

impl BackgroundSessionStore {
    pub(crate) fn replace_from_listing(&mut self, listing: &Value) -> Result<(), String> {
        let values = listing["sessions"]
            .as_array()
            .ok_or_else(|| "daemon session listing missing sessions".to_string())?;
        let mut next = BTreeMap::new();
        for value in values {
            let session = BackgroundSession::from_value(value)?;
            next.insert(session.session_id.clone(), session);
        }
        self.sessions = next;
        Ok(())
    }

    pub(crate) fn apply_status(&mut self, value: &Value) -> bool {
        if value["type"] != "session_status" {
            return false;
        }
        let Some(session_id) = value["session_id"].as_str() else {
            return false;
        };
        let Some(session) = self.sessions.get_mut(session_id) else {
            return false;
        };
        if let Some(status) = value["status"].as_str() {
            session.task_status = Some(status.to_owned());
            session.alive = !matches!(status, "exited" | "error" | "failed");
        }
        true
    }

    pub(crate) fn get(&self, session_id: &str) -> Option<&BackgroundSession> {
        self.sessions.get(session_id)
    }

    pub(crate) fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub(crate) fn visible(
        &self,
        include_finished: bool,
    ) -> impl Iterator<Item = &BackgroundSession> {
        self.sessions
            .values()
            .filter(move |session| include_finished || !session.is_finished())
    }

    pub(crate) fn all(&self) -> impl Iterator<Item = &BackgroundSession> {
        self.sessions.values()
    }

    pub(crate) fn remove(&mut self, session_id: &str) -> Option<BackgroundSession> {
        self.sessions.remove(session_id)
    }

    pub(crate) fn len(&self) -> usize {
        self.sessions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing() -> Value {
        serde_json::json!({
            "type": "sessions",
            "sessions": [
                {
                    "sessionId": "running",
                    "cwd": "C:/project",
                    "shell": "pwsh",
                    "alive": true,
                    "taskStatus": "running",
                    "taskUpdatedAtMs": 10,
                    "createdAtMs": 1,
                    "replayAvailable": true
                },
                {
                    "sessionId": "done",
                    "cwd": "C:/project",
                    "alive": false,
                    "taskStatus": "done",
                    "createdAtMs": 2
                }
            ]
        })
    }

    #[test]
    fn listing_is_replaced_and_finished_sessions_filter_without_polling() {
        let mut store = BackgroundSessionStore::default();
        store.replace_from_listing(&listing()).unwrap();
        assert_eq!(store.len(), 2);
        assert_eq!(
            store
                .visible(false)
                .map(|item| item.session_id.as_str())
                .collect::<Vec<_>>(),
            ["running"]
        );
        assert_eq!(store.visible(true).count(), 2);
    }

    #[test]
    fn session_status_updates_existing_session_and_ignores_unknown_values() {
        let mut store = BackgroundSessionStore::default();
        store.replace_from_listing(&listing()).unwrap();
        assert!(store.apply_status(&serde_json::json!({
            "type": "session_status",
            "session_id": "running",
            "status": "exited"
        })));
        assert!(store.get("running").unwrap().is_finished());
        assert!(!store.apply_status(&serde_json::json!({
            "type": "session_status",
            "session_id": "missing",
            "status": "running"
        })));
    }
    #[test]
    fn orphan_reconcile_is_event_driven_and_visible_fallback_is_sixty_seconds() {
        let start = Instant::now();
        let mut last = None;
        assert!(should_reconcile_on_event(&mut last, start));
        assert!(!should_reconcile_on_tick(
            true,
            last,
            start + Duration::from_secs(59)
        ));
        assert!(should_reconcile_on_tick(
            true,
            last,
            start + Duration::from_secs(60)
        ));
        assert!(!should_reconcile_on_tick(
            false,
            last,
            start + Duration::from_secs(600)
        ));
    }
}

use crate::{daemon_bootstrap, paths};
use cli_manager_pty_client::{Client, Event};
use std::path::PathBuf;
use tokio::{runtime::Runtime, sync::mpsc};

#[derive(Debug)]
pub(crate) enum MonitorEvent {
    Snapshot(serde_json::Value),
    Status(serde_json::Value),
    Error(String),
}

#[derive(Debug)]
enum MonitorCommand {
    Close(String),
    Reconcile {
        active_session_ids: Vec<String>,
        visible: bool,
    },
    Stop,
}

#[derive(Clone)]
pub(crate) struct MonitorHandle {
    commands: mpsc::UnboundedSender<MonitorCommand>,
}

impl MonitorHandle {
    pub(crate) fn close(&self, session_id: impl Into<String>) -> bool {
        self.commands
            .send(MonitorCommand::Close(session_id.into()))
            .is_ok()
    }

    pub(crate) fn reconcile(&self, active_session_ids: Vec<String>, visible: bool) -> bool {
        self.commands
            .send(MonitorCommand::Reconcile {
                active_session_ids,
                visible,
            })
            .is_ok()
    }
}

impl Drop for MonitorHandle {
    fn drop(&mut self) {
        let _ = self.commands.send(MonitorCommand::Stop);
    }
}

pub(crate) fn spawn_monitor(
    runtime: &Runtime,
) -> (MonitorHandle, mpsc::UnboundedReceiver<MonitorEvent>) {
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let _ = runtime.spawn(run_monitor(event_tx, command_rx));
    (
        MonitorHandle {
            commands: command_tx,
        },
        event_rx,
    )
}

async fn run_monitor(
    events: mpsc::UnboundedSender<MonitorEvent>,
    mut commands: mpsc::UnboundedReceiver<MonitorCommand>,
) {
    let mut retry_delay = std::time::Duration::from_millis(250);
    loop {
        let database = match paths::database_path() {
            Ok(path) => path,
            Err(error) => {
                let _ = events.send(MonitorEvent::Error(error));
                if wait_for_retry(&mut commands, retry_delay).await {
                    return;
                }
                retry_delay = (retry_delay * 2).min(std::time::Duration::from_secs(5));
                continue;
            }
        };
        let Some(data_root) = database.parent().map(PathBuf::from) else {
            let _ = events.send(MonitorEvent::Error("daemon data root unavailable".into()));
            if wait_for_retry(&mut commands, retry_delay).await {
                return;
            }
            retry_delay = (retry_delay * 2).min(std::time::Duration::from_secs(5));
            continue;
        };
        let endpoint = match daemon_bootstrap::endpoint_or_start(&data_root) {
            Ok(endpoint) => endpoint,
            Err(error) => {
                let _ = events.send(MonitorEvent::Error(error));
                if wait_for_retry(&mut commands, retry_delay).await {
                    return;
                }
                retry_delay = (retry_delay * 2).min(std::time::Duration::from_secs(5));
                continue;
            }
        };
        let (client, mut stream) = match Client::connect(endpoint, Default::default()).await {
            Ok(connection) => connection,
            Err(error) => {
                let _ = events.send(MonitorEvent::Error(error));
                if wait_for_retry(&mut commands, retry_delay).await {
                    return;
                }
                retry_delay = (retry_delay * 2).min(std::time::Duration::from_secs(5));
                continue;
            }
        };
        retry_delay = std::time::Duration::from_millis(250);
        let mut active_session_ids = Vec::new();
        let mut monitor_visible = false;
        let mut last_reconcile = None;
        let mut reconcile_tick = tokio::time::interval(Duration::from_secs(60));
        reconcile_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let listing = match client.list().await {
            Ok(listing) => listing,
            Err(error) => {
                let _ = events.send(MonitorEvent::Error(error));
                continue;
            }
        };
        let _ = events.send(MonitorEvent::Snapshot(listing.clone()));
        if should_reconcile_on_event(&mut last_reconcile, Instant::now()) {
            if let Err(error) = client.reconcile(&active_session_ids).await {
                let _ = events.send(MonitorEvent::Error(format!(
                    "daemon reconcile failed: {error}"
                )));
            }
        }
        if let Some(sessions) = listing["sessions"].as_array() {
            for session in sessions {
                if session["alive"].as_bool() == Some(true) {
                    if let Some(session_id) = session["sessionId"].as_str() {
                        let _ = client.attach(session_id, None).await;
                    }
                }
            }
        }
        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    Some(MonitorCommand::Close(session_id)) => {
                        let _ = client.close(&session_id).await;
                        if let Ok(listing) = client.list().await {
                            let _ = events.send(MonitorEvent::Snapshot(listing));
                        }
                        if should_reconcile_on_event(&mut last_reconcile, Instant::now()) {
                            if let Err(error) = client.reconcile(&active_session_ids).await {
                                let _ = events.send(MonitorEvent::Error(format!("daemon reconcile failed: {error}")));
                            }
                        }
                    }
                    Some(MonitorCommand::Reconcile { active_session_ids: ids, visible }) => {
                        active_session_ids = ids;
                        monitor_visible = visible;
                        if should_reconcile_on_event(&mut last_reconcile, Instant::now()) {
                            if let Err(error) = client.reconcile(&active_session_ids).await {
                                let _ = events.send(MonitorEvent::Error(format!("daemon reconcile failed: {error}")));
                            }
                        }
                    }
                    Some(MonitorCommand::Stop) | None => return,
                },
                _ = reconcile_tick.tick(), if monitor_visible => {
                    let now = Instant::now();
                    if should_reconcile_on_tick(monitor_visible, last_reconcile, now) {
                        if let Err(error) = client.reconcile(&active_session_ids).await {
                            let _ = events.send(MonitorEvent::Error(format!("daemon reconcile failed: {error}")));
                        } else {
                            last_reconcile = Some(now);
                        }
                    }
                }
                event = stream.recv() => match event {
                    Some(Event::Output(output)) => {
                        let _ = client.commit(&output).await;
                    }
                    Some(Event::Control(value)) if value["type"] == "session_status" => {
                        let _ = events.send(MonitorEvent::Status(value));
                        if should_reconcile_on_event(&mut last_reconcile, Instant::now()) {
                            if let Err(error) = client.reconcile(&active_session_ids).await {
                                let _ = events.send(MonitorEvent::Error(format!("daemon reconcile failed: {error}")));
                            }
                        }
                    }
                    Some(Event::Control(_)) => {}
                    Some(Event::Disconnected) | None => break,
                },
            }
        }
        let _ = events.send(MonitorEvent::Error("daemon monitor disconnected".into()));
    }
}

const ORPHAN_RECONCILE_INTERVAL: Duration = Duration::from_secs(60);

fn should_reconcile_on_event(last_reconcile: &mut Option<Instant>, now: Instant) -> bool {
    *last_reconcile = Some(now);
    true
}

fn should_reconcile_on_tick(visible: bool, last_reconcile: Option<Instant>, now: Instant) -> bool {
    visible
        && last_reconcile
            .map(|last| now.duration_since(last) >= ORPHAN_RECONCILE_INTERVAL)
            .unwrap_or(true)
}

async fn wait_for_retry(
    commands: &mut mpsc::UnboundedReceiver<MonitorCommand>,
    delay: std::time::Duration,
) -> bool {
    tokio::select! {
        command = commands.recv() => matches!(command, Some(MonitorCommand::Stop) | None),
        _ = tokio::time::sleep(delay) => false,
    }
}
