use crate::exit::ExitBehavior;
use crate::{history, preferences, workspace, DesktopShell, ProjectLoad, ThemePalette};
use gpui::Context;

impl DesktopShell {
    pub(crate) fn toggle_restore_enabled(&mut self) {
        self.restore_enabled = !self.restore_enabled;
        self.persist_runtime_settings();
    }

    pub(crate) fn toggle_restore_mode(&mut self) {
        self.restore_mode = match self.restore_mode {
            preferences::RestoreMode::Ask => preferences::RestoreMode::Auto,
            preferences::RestoreMode::Auto => preferences::RestoreMode::Ask,
        };
        self.persist_runtime_settings();
    }

    pub(crate) fn cycle_exit_behavior(&mut self) {
        self.exit_behavior = match self.exit_behavior {
            ExitBehavior::Ask => ExitBehavior::Background,
            ExitBehavior::Background => ExitBehavior::Minimize,
            ExitBehavior::Minimize => ExitBehavior::Discard,
            ExitBehavior::Discard => ExitBehavior::Ask,
        };
        self.persist_runtime_settings();
    }

    pub(crate) fn toggle_background_include_finished(&mut self) {
        self.background_include_finished = !self.background_include_finished;
        self.persist_runtime_settings();
    }

    pub(crate) fn toggle_command_palette(&mut self) {
        self.command_palette_open = !self.command_palette_open;
        self.command_palette_selected = 0;
        if !self.command_palette_open {
            self.command_palette_query.clear();
        }
    }

    pub(crate) fn command_items(&self) -> Vec<(String, String)> {
        let mut commands = vec![
            (
                self.message("shell.command.toggleLanguage"),
                "language".to_owned(),
            ),
            (
                self.message("shell.command.toggleTheme"),
                "theme".to_owned(),
            ),
            (
                self.message("shell.command.closePane"),
                "close-pane".to_owned(),
            ),
            (
                self.message("shell.command.backgroundSessions"),
                "background-sessions".to_owned(),
            ),
            (
                self.message("shell.history.sourceAll"),
                "history-source:all".to_owned(),
            ),
            (
                self.message("shell.history.sourceClaude"),
                "history-source:claude".to_owned(),
            ),
            (
                self.message("shell.history.sourceCodex"),
                "history-source:codex".to_owned(),
            ),
        ];
        if let ProjectLoad::Ready(loaded) = &self.projects {
            commands.extend(
                loaded
                    .snapshot
                    .projects
                    .iter()
                    .map(|project| (project.name.clone(), format!("project:{}", project.id))),
            );
        }
        commands
    }

    pub(crate) fn filtered_command_items(&self) -> Vec<(String, String)> {
        let query = self.command_palette_query.to_ascii_lowercase();
        self.command_items()
            .into_iter()
            .filter(|(label, _)| query.is_empty() || label.to_ascii_lowercase().contains(&query))
            .collect()
    }

    pub(crate) fn move_command_selection(&mut self, delta: isize) {
        let count = self.filtered_command_items().len();
        if count == 0 {
            self.command_palette_selected = 0;
            return;
        }
        self.command_palette_selected =
            (self.command_palette_selected as isize + delta).rem_euclid(count as isize) as usize;
    }

    pub(crate) fn run_selected_command(&mut self, cx: &mut Context<Self>) {
        let commands = self.filtered_command_items();
        if let Some((_, command)) = commands.get(self.command_palette_selected) {
            self.run_command(command, cx);
        }
    }

    pub(crate) fn run_command(&mut self, command: &str, cx: &mut Context<Self>) {
        match command {
            "language" => self.toggle_language(),
            "theme" => self.toggle_theme(),
            "close-pane" => self.close_active_terminal(),
            "background-sessions" => self.open_background_sessions(),
            "history-source:all" => {
                self.history.set_source(history::SourceFilter::All);
                self.open_history(cx);
            }
            "history-source:claude" => {
                self.history.set_source(history::SourceFilter::Claude);
                self.open_history(cx);
            }
            "history-source:codex" => {
                self.history.set_source(history::SourceFilter::Codex);
                self.open_history(cx);
            }
            _ if command.starts_with("project:") => {
                let project_id = &command[8..];
                let has_snapshot = self.restore_enabled
                    && workspace::persistence::load(project_id)
                        .ok()
                        .flatten()
                        .is_some();
                self.selected_project = Some(project_id.to_owned());
                self.open_project_terminal_with_restore(project_id, has_snapshot, cx);
            }
            _ => {}
        }
        self.command_palette_open = false;
        self.command_palette_query.clear();
    }

    pub(crate) fn palette(&self) -> ThemePalette {
        match self.theme {
            preferences::AppTheme::Dark => ThemePalette::DARK,
            preferences::AppTheme::Light => ThemePalette::LIGHT,
        }
    }
}
