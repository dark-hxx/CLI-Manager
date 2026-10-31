//! UI-free exit policy decisions for the GPUI window and future tray/dialog code.

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
