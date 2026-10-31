use super::session::WorkspaceSessions;
use cli_manager_core_prefs::{PrefsFile, PrefsStore};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const SESSIONS_FILE: &str = "sessions.json";
const SNAPSHOT_FLUSH_INTERVAL: Duration = Duration::from_secs(10);

struct PendingSnapshot {
    project_id: String,
    workspace: WorkspaceSessions,
}

struct SnapshotWriterState {
    pending: Option<PendingSnapshot>,
    worker_generation: u64,
    worker_active: bool,
    last_saved: Option<Instant>,
}

/// 合并短时间内的布局变化，避免每次键盘调整或分屏操作都写一次 JSON。
/// 同一 writer 只允许一个后台写入 worker，关闭时可取消延迟 worker 并同步刷出最新值。
pub struct SnapshotWriter {
    state: Arc<Mutex<SnapshotWriterState>>,
}

impl SnapshotWriter {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(SnapshotWriterState {
                pending: None,
                worker_generation: 0,
                worker_active: false,
                last_saved: None,
            })),
        }
    }

    pub fn request(&self, project_id: String, workspace: WorkspaceSessions) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.pending = Some(PendingSnapshot {
            project_id,
            workspace,
        });
        if state.worker_active {
            return;
        }
        state.worker_active = true;
        let generation = state.worker_generation;
        let wait = state
            .last_saved
            .and_then(|saved| SNAPSHOT_FLUSH_INTERVAL.checked_sub(saved.elapsed()))
            .unwrap_or_default();
        let shared = Arc::clone(&self.state);
        thread::spawn(move || {
            if !wait.is_zero() {
                thread::sleep(wait);
            }
            flush_worker(shared, generation);
        });
    }

    pub fn flush_now(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.worker_generation = state.worker_generation.wrapping_add(1);
        state.worker_active = false;
        save_pending(&mut state);
    }
}

impl Default for SnapshotWriter {
    fn default() -> Self {
        Self::new()
    }
}

fn flush_worker(shared: Arc<Mutex<SnapshotWriterState>>, generation: u64) {
    let Ok(mut state) = shared.lock() else {
        return;
    };
    if state.worker_generation != generation {
        return;
    }
    save_pending(&mut state);
    state.worker_active = false;
}

fn save_pending(state: &mut SnapshotWriterState) {
    let Some(pending) = state.pending.take() else {
        return;
    };
    if let Err(error) = save(&pending.project_id, &pending.workspace) {
        eprintln!("GPUI workspace snapshot save failed: {error}");
        state.pending = Some(pending);
        return;
    }
    state.last_saved = Some(Instant::now());
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct StoredWorkspaces {
    #[serde(default)]
    workspaces: BTreeMap<String, WorkspaceSessions>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn store() -> io::Result<PrefsStore> {
    let database = std::env::var_os("CLI_MANAGER_GPUI_DATABASE")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(crate::paths::database_path)
        .map_err(io::Error::other)?;
    let root = database.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "workspace data root unavailable")
    })?;
    Ok(PrefsStore::new(root))
}

fn file() -> io::Result<PrefsFile> {
    PrefsFile::new(SESSIONS_FILE)
}

pub fn load(project_id: &str) -> io::Result<Option<WorkspaceSessions>> {
    if project_id.trim().is_empty() {
        return Ok(None);
    }
    let saved = store()?.load::<StoredWorkspaces>(file()?)?;
    Ok(saved.workspaces.get(project_id).cloned())
}

pub fn save(project_id: &str, workspace: &WorkspaceSessions) -> io::Result<()> {
    if project_id.trim().is_empty() {
        return Ok(());
    }
    store()?.update::<StoredWorkspaces, _>(file()?, |saved| {
        saved
            .workspaces
            .insert(project_id.to_owned(), workspace.clone());
    })
}

pub fn remove(project_id: &str) -> io::Result<()> {
    if project_id.trim().is_empty() {
        return Ok(());
    }
    store()?.update::<StoredWorkspaces, _>(file()?, |saved| {
        saved.workspaces.remove(project_id);
    })
}

pub fn clear() -> io::Result<()> {
    store()?.update::<StoredWorkspaces, _>(file()?, |saved| {
        saved.workspaces.clear();
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_workspaces_round_trip_preserves_layout_and_metadata() {
        let mut workspace = WorkspaceSessions::new("first");
        workspace.split_active(
            "second",
            super::super::pane_tree::SplitDirection::Right,
            super::super::session::SessionKind::RealPty,
        );
        let mut saved = StoredWorkspaces::default();
        saved.workspaces.insert("project".into(), workspace.clone());
        saved.extra.insert("futureFlag".into(), Value::Bool(true));
        let value = serde_json::to_value(&saved).unwrap();
        let restored: StoredWorkspaces = serde_json::from_value(value).unwrap();
        assert_eq!(restored.workspaces["project"], workspace);
        assert_eq!(restored.extra["futureFlag"], true);
    }

    #[test]
    fn snapshot_writer_coalesces_pending_state_until_forced_flush() {
        let writer = SnapshotWriter::new();
        writer.request("project".into(), WorkspaceSessions::new("first"));
        let mut latest = WorkspaceSessions::new("latest");
        latest.split_active(
            "second",
            super::super::pane_tree::SplitDirection::Right,
            super::super::session::SessionKind::RealPty,
        );
        writer.request("project".into(), latest.clone());
        let state = writer.state.lock().unwrap();
        if let Some(pending) = state.pending.as_ref() {
            assert_eq!(pending.project_id, "project");
            assert_eq!(pending.workspace.active_session_id(), Some("second"));
        }
        drop(state);
        writer.flush_now();
        assert!(writer.state.lock().unwrap().pending.is_none());
    }
}
