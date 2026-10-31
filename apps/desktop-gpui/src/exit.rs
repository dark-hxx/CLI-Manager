//! UI-free exit policy decisions for the GPUI window and future tray/dialog code.

use crate::DesktopShell;
use gpui::{Context, Window};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::runtime::Runtime;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitBehavior {
    Ask,
    Background,
    Minimize,
    Discard,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitAction {
    Confirm,
    DetachAndExit,
    HideAndKeep,
    CloseAllAndExit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExitCoordinator {
    daemon_available: bool,
}

impl ExitCoordinator {
    pub const fn new(daemon_available: bool) -> Self {
        Self { daemon_available }
    }

    pub const fn decide(self, behavior: ExitBehavior, has_running_tasks: bool) -> ExitAction {
        if !has_running_tasks {
            return ExitAction::CloseAllAndExit;
        }
        match behavior {
            ExitBehavior::Ask => ExitAction::Confirm,
            ExitBehavior::Background if self.daemon_available => ExitAction::DetachAndExit,
            ExitBehavior::Background | ExitBehavior::Minimize => ExitAction::HideAndKeep,
            ExitBehavior::Discard => ExitAction::CloseAllAndExit,
        }
    }
}

impl Default for ExitBehavior {
    fn default() -> Self {
        Self::Ask
    }
}

impl DesktopShell {
    pub(crate) fn install_close_handler(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        runtime: Arc<Runtime>,
    ) {
        let shell_handle = cx.entity().downgrade();
        let closing = Arc::new(AtomicBool::new(false));
        window.on_window_should_close(cx, move |_, app| {
            if closing.load(Ordering::Acquire) {
                return false;
            }
            let (clients, action) = shell_handle
                .update(app, |shell, _| {
                    shell.flush_workspace_snapshot();
                    let clients = shell.sessions.clients();
                    let has_running_tasks =
                        shell.workspace_sessions.as_ref().is_some_and(|workspace| {
                            workspace.has_exit_tasks(shell.background_include_finished)
                        });
                    let behavior = shell.exit_override.take().unwrap_or(shell.exit_behavior);
                    let action = ExitCoordinator::new(!clients.is_empty())
                        .decide(behavior, has_running_tasks);
                    if action == ExitAction::Confirm {
                        shell.exit_prompt = true;
                    }
                    (clients, action)
                })
                .ok()
                .unwrap_or_else(|| (Vec::new(), ExitAction::CloseAllAndExit));
            if action == ExitAction::Confirm {
                return false;
            }
            if clients.is_empty() {
                return true;
            }
            if closing
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return false;
            }
            let task = runtime.spawn(async move {
                let control = clients.first().cloned();
                for client in &clients {
                    if action == ExitAction::CloseAllAndExit {
                        let _ = client.close_all().await;
                    } else {
                        let _ = client.detach().await;
                    }
                }
                if action == ExitAction::CloseAllAndExit {
                    if let Some(client) = control {
                        let _ = client.shutdown_if_idle().await;
                    }
                }
            });
            let async_app = app.to_async();
            async_app
                .spawn(async move |cx| {
                    let _ = task.await;
                    cx.update(|cx| cx.quit());
                })
                .detach();
            false
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_running_tasks_can_exit_without_confirmation() {
        assert_eq!(
            ExitCoordinator::new(true).decide(ExitBehavior::Ask, false),
            ExitAction::CloseAllAndExit
        );
    }

    #[test]
    fn ask_requires_confirmation_for_running_tasks() {
        assert_eq!(
            ExitCoordinator::new(true).decide(ExitBehavior::Ask, true),
            ExitAction::Confirm
        );
    }

    #[test]
    fn background_detaches_when_daemon_is_available() {
        assert_eq!(
            ExitCoordinator::new(true).decide(ExitBehavior::Background, true),
            ExitAction::DetachAndExit
        );
    }

    #[test]
    fn background_degrades_to_hidden_window_without_daemon() {
        assert_eq!(
            ExitCoordinator::new(false).decide(ExitBehavior::Background, true),
            ExitAction::HideAndKeep
        );
    }

    #[test]
    fn minimize_and_discard_have_distinct_cleanup() {
        let coordinator = ExitCoordinator::new(true);
        assert_eq!(
            coordinator.decide(ExitBehavior::Minimize, true),
            ExitAction::HideAndKeep
        );
        assert_eq!(
            coordinator.decide(ExitBehavior::Discard, true),
            ExitAction::CloseAllAndExit
        );
    }
}
