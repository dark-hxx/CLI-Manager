use super::pane_tree::{DropZone, PaneTree, SplitDirection};
use super::tab_status::{TabStatus, TabStatusSources};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SessionKind {
    RealPty,
    Pseudo,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SessionStatus {
    Running,
    Done,
    Failed,
    Exited,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionEntry {
    pub pane_id: u64,
    pub session_id: String,
    pub kind: SessionKind,
    pub status: SessionStatus,
    pub status_sources: TabStatusSources,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceSessions {
    panes: PaneTree,
    entries: BTreeMap<u64, SessionEntry>,
}

impl WorkspaceSessions {
    pub fn new(session_id: impl Into<String>) -> Self {
        let session_id = session_id.into();
        let mut entries = BTreeMap::new();
        entries.insert(
            1,
            SessionEntry {
                pane_id: 1,
                session_id,
                kind: SessionKind::RealPty,
                status: SessionStatus::Running,
                status_sources: TabStatusSources::default().update_shell(TabStatus::Running),
            },
        );
        Self {
            panes: PaneTree::new(1),
            entries,
        }
    }

    pub fn panes(&self) -> &PaneTree {
        &self.panes
    }
    pub fn panes_mut(&mut self) -> &mut PaneTree {
        &mut self.panes
    }

    pub fn active(&self) -> Option<&SessionEntry> {
        self.entries.get(&self.panes.active())
    }

    pub fn active_session_id(&self) -> Option<&str> {
        self.active().map(|entry| entry.session_id.as_str())
    }

    #[allow(dead_code)]
    pub fn set_active_pane(&mut self, pane_id: u64) -> bool {
        self.panes.set_active(pane_id)
    }

    pub fn set_active_session(&mut self, session_id: &str) -> bool {
        let Some(pane_id) = self
            .entries
            .values()
            .find(|entry| entry.session_id == session_id)
            .map(|entry| entry.pane_id)
        else {
            return false;
        };
        self.panes.set_active(pane_id)
    }

    pub fn split_active(
        &mut self,
        session_id: impl Into<String>,
        direction: SplitDirection,
        kind: SessionKind,
    ) -> u64 {
        let pane_id = self.panes.split_active(direction);
        self.entries.insert(
            pane_id,
            SessionEntry {
                pane_id,
                session_id: session_id.into(),
                kind,
                status: SessionStatus::Running,
                status_sources: TabStatusSources::default().update_shell(TabStatus::Running),
            },
        );
        pane_id
    }

    pub fn move_session(
        &mut self,
        source_session: &str,
        target_session: &str,
        zone: DropZone,
    ) -> bool {
        let Some(source) = self
            .entries
            .values()
            .find(|entry| entry.session_id == source_session)
            .map(|entry| entry.pane_id)
        else {
            return false;
        };
        let Some(target) = self
            .entries
            .values()
            .find(|entry| entry.session_id == target_session)
            .map(|entry| entry.pane_id)
        else {
            return false;
        };
        self.panes.move_pane(source, target, zone)
    }

    pub fn update_status(&mut self, session_id: &str, status: SessionStatus) -> bool {
        let Some(entry) = self
            .entries
            .values_mut()
            .find(|entry| entry.session_id == session_id)
        else {
            return false;
        };
        entry.status = status;
        entry.status_sources = entry.status_sources.update_hook(tab_status(status));
        true
    }

    pub fn update_hook_status(&mut self, session_id: &str, status: TabStatus) -> bool {
        self.update_source_status(session_id, |sources| sources.update_hook(status))
    }

    pub fn update_shell_status(&mut self, session_id: &str, status: TabStatus) -> bool {
        self.update_source_status(session_id, |sources| sources.update_shell(status))
    }

    pub fn close_active(&mut self) -> Option<SessionEntry> {
        let pane_id = self.panes.active();
        let entry = self.entries.get(&pane_id)?.clone();
        self.panes.close_active()?;
        self.entries.remove(&pane_id);
        Some(entry)
    }

    pub fn running_real_sessions(&self) -> Vec<String> {
        self.entries
            .values()
            .filter(|entry| {
                entry.kind == SessionKind::RealPty && entry.status_sources.merged().is_running()
            })
            .map(|entry| entry.session_id.clone())
            .collect()
    }

    pub fn has_exit_tasks(&self, include_finished: bool) -> bool {
        self.entries.values().any(|entry| {
            if entry.kind != SessionKind::RealPty {
                return false;
            }
            let status = entry.status_sources.merged();
            status.is_running() || (include_finished && status != TabStatus::None)
        })
    }

    #[allow(dead_code)]
    pub fn all(&self) -> impl Iterator<Item = &SessionEntry> {
        self.entries.values()
    }

    fn update_source_status(
        &mut self,
        session_id: &str,
        update: impl FnOnce(TabStatusSources) -> TabStatusSources,
    ) -> bool {
        let Some(entry) = self
            .entries
            .values_mut()
            .find(|entry| entry.session_id == session_id)
        else {
            return false;
        };
        let previous = entry.status_sources;
        let next = update(previous);
        if next == previous {
            return false;
        }
        entry.status_sources = next;
        entry.status = session_status(entry.status_sources.merged());
        true
    }
}

fn tab_status(status: SessionStatus) -> TabStatus {
    match status {
        SessionStatus::Running => TabStatus::Running,
        SessionStatus::Done => TabStatus::Done,
        SessionStatus::Failed => TabStatus::Failed,
        SessionStatus::Exited => TabStatus::Done,
    }
}

fn session_status(status: TabStatus) -> SessionStatus {
    match status {
        TabStatus::Running => SessionStatus::Running,
        TabStatus::Failed => SessionStatus::Failed,
        TabStatus::Done | TabStatus::None => SessionStatus::Done,
        TabStatus::Attention => SessionStatus::Running,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_creates_a_running_session_and_keeps_active_focus_on_it() {
        let mut workspace = WorkspaceSessions::new("first");
        let pane = workspace.split_active("second", SplitDirection::Right, SessionKind::RealPty);
        assert_eq!(
            workspace.active().map(|entry| entry.session_id.as_str()),
            Some("second")
        );
        assert_eq!(workspace.panes().leaves(), vec![1, pane]);
        assert_eq!(workspace.running_real_sessions(), vec!["first", "second"]);
    }

    #[test]
    fn pseudo_sessions_are_excluded_from_running_task_selection() {
        let mut workspace = WorkspaceSessions::new("real");
        workspace.split_active("preview", SplitDirection::Down, SessionKind::Pseudo);
        assert_eq!(workspace.running_real_sessions(), vec!["real"]);
    }

    #[test]
    fn terminal_status_updates_and_close_remove_the_same_entry() {
        let mut workspace = WorkspaceSessions::new("first");
        workspace.split_active("second", SplitDirection::Right, SessionKind::RealPty);
        assert!(workspace.update_status("second", SessionStatus::Failed));
        assert_eq!(workspace.running_real_sessions(), vec!["first"]);
        let closed = workspace.close_active().unwrap();
        assert_eq!(closed.session_id, "second");
        assert_eq!(
            workspace.active().map(|entry| entry.session_id.as_str()),
            Some("first")
        );
    }

    #[test]
    fn hook_and_shell_statuses_merge_without_losing_source_information() {
        let mut workspace = WorkspaceSessions::new("first");
        assert!(workspace.update_hook_status("first", TabStatus::Attention));
        assert_eq!(
            workspace.active().unwrap().status_sources.merged(),
            TabStatus::Attention
        );
        assert!(workspace.update_shell_status("first", TabStatus::Done));
        assert_eq!(
            workspace.active().unwrap().status_sources.hook,
            TabStatus::Attention
        );
        assert_eq!(workspace.running_real_sessions(), Vec::<String>::new());
    }
}
