/// The merged tab status priority shared by Hook and shell runtime events.
/// Higher values win, matching the existing terminal store contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum TabStatus {
    None,
    Done,
    Running,
    Failed,
    Attention,
}

impl TabStatus {
    pub const fn priority(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Done => 1,
            Self::Running => 2,
            Self::Failed => 3,
            Self::Attention => 4,
        }
    }

    pub const fn is_running(self) -> bool {
        matches!(self, Self::Running)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TabStatusSources {
    pub hook: TabStatus,
    pub shell: TabStatus,
}

impl TabStatusSources {
    pub const fn merged(self) -> TabStatus {
        if self.hook.priority() >= self.shell.priority() {
            self.hook
        } else {
            self.shell
        }
    }

    pub const fn update_hook(self, status: TabStatus) -> Self {
        Self {
            hook: status,
            shell: self.shell,
        }
    }

    pub const fn update_shell(self, status: TabStatus) -> Self {
        Self {
            hook: self.hook,
            shell: status,
        }
    }
}

impl Default for TabStatusSources {
    fn default() -> Self {
        Self {
            hook: TabStatus::None,
            shell: TabStatus::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_sources_using_contract_priority() {
        let cases = [
            (TabStatus::None, TabStatus::Done, TabStatus::Done),
            (TabStatus::Running, TabStatus::Done, TabStatus::Running),
            (TabStatus::Failed, TabStatus::Running, TabStatus::Failed),
            (
                TabStatus::Attention,
                TabStatus::Failed,
                TabStatus::Attention,
            ),
        ];
        for (hook, shell, expected) in cases {
            assert_eq!(TabStatusSources { hook, shell }.merged(), expected);
        }
    }

    #[test]
    fn source_updates_do_not_clear_the_other_source() {
        let sources = TabStatusSources::default()
            .update_hook(TabStatus::Running)
            .update_shell(TabStatus::Attention);
        assert_eq!(
            sources,
            TabStatusSources {
                hook: TabStatus::Running,
                shell: TabStatus::Attention
            }
        );
        assert_eq!(sources.merged(), TabStatus::Attention);
    }

    #[test]
    fn only_running_is_selected_for_default_exit_guard() {
        assert!(TabStatus::Running.is_running());
        assert!(!TabStatus::Attention.is_running());
        assert!(!TabStatus::Done.is_running());
        assert!(!TabStatus::Failed.is_running());
    }
}
