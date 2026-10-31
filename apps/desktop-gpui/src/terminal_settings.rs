use crate::DesktopShell;
use cli_manager_core_prefs::{
    settings::Settings,
    terminal::{CursorStyle, TerminalPreferences},
    PrefsFile, PrefsStore,
};
use gpui::{div, prelude::*, px, Context, Div, Entity, Window};
use gpui_component::{
    button::Button,
    input::{Editor, EditorState},
    Disableable,
};

pub(crate) struct TerminalSettingsState {
    pub(crate) value: TerminalPreferences,
    font_editor: Option<Entity<EditorState>>,
    pending: bool,
    error: Option<&'static str>,
}

impl TerminalSettingsState {
    pub(crate) fn new(value: TerminalPreferences) -> Self {
        Self {
            value,
            font_editor: None,
            pending: false,
            error: None,
        }
    }
}

#[derive(Clone, Copy)]
enum Change {
    Font,
    Size(f64),
    Height(f64),
    History(i32),
    ToggleHistory,
    Cursor,
}

impl DesktopShell {
    fn change_terminal_settings(&mut self, change: Change, cx: &mut Context<Self>) {
        if self.terminal_settings.pending {
            return;
        }
        let mut next = self.terminal_settings.value.clone();
        match change {
            Change::Font => {
                let Some(editor) = &self.terminal_settings.font_editor else {
                    return;
                };
                let family = editor.read(cx).value().trim().to_owned();
                if family.is_empty() || family.len() > 1024 || family.chars().any(char::is_control)
                {
                    self.terminal_settings.error = Some("shell.terminal.invalidFont");
                    cx.notify();
                    return;
                }
                next.font_family = family;
            }
            Change::Size(delta) => next.font_size = (next.font_size + delta).clamp(8., 32.),
            Change::Height(delta) => {
                next.line_height = (((next.line_height + delta) * 10.).round() / 10.).clamp(1., 2.)
            }
            Change::History(delta) => {
                let current = next.effective_scrollback();
                next.scrollback_custom = true;
                next.scrollback_rows = (current as i32 + delta).clamp(1000, 50_000) as usize;
            }
            Change::ToggleHistory => next.scrollback_custom = !next.scrollback_custom,
            Change::Cursor => {
                next.cursor_style = match next.cursor_style {
                    CursorStyle::Bar => CursorStyle::Block,
                    CursorStyle::Block => CursorStyle::Underline,
                    CursorStyle::Underline => CursorStyle::Bar,
                }
            }
        }
        let database = self.preferences_database.clone();
        let desired = next.clone();
        self.terminal_settings.pending = true;
        self.terminal_settings.error = None;
        let task = self._runtime.spawn_blocking(move || {
            let database = match database {
                Some(path) => path,
                None => crate::paths::database_path()?,
            };
            let root = database.parent().ok_or("settings data root unavailable")?;
            PrefsStore::new(root)
                .update::<Settings, _>(PrefsFile::SETTINGS, |settings| desired.write_to(settings))
                .map_err(|error| error.to_string())
        });
        cx.spawn(async move |this, cx| {
            let saved = matches!(task.await, Ok(Ok(())));
            let _ = this.update(cx, |this, cx| {
                this.terminal_settings.pending = false;
                if saved {
                    for session_id in this.sessions.session_ids() {
                        if let Some(handle) = this.sessions.get(&session_id) {
                            if let Ok(mut model) = handle.model.lock() {
                                model.configure_preferences(&next);
                            }
                        }
                    }
                    this.terminal_settings.value = next;
                    this.terminal_sizes.clear();
                    this.terminal_size = None;
                    this.terminal_selection_anchor = None;
                    this.terminal_selection_end = None;
                    this.terminal_selection_dragging = false;
                } else {
                    this.terminal_settings.error = Some("shell.terminal.saveFailed");
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn terminal_settings_view(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let value = self.terminal_settings.value.clone();
        let editor = self
            .terminal_settings
            .font_editor
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    EditorState::new(window, cx)
                        .language("plaintext")
                        .default_value(value.font_family.clone())
                })
            })
            .clone();
        let pending = self.terminal_settings.pending;
        let mut view = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(self.message("shell.terminal.fontFamily"))
            .child(Editor::new(&editor).h(px(36.)))
            .child(
                Button::new("terminal-font-apply")
                    .label(self.message("shell.terminal.applyFont"))
                    .disabled(pending)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.change_terminal_settings(Change::Font, cx)
                    })),
            );
        for (id, key, current, decrease, increase) in [
            (
                "size",
                "shell.terminal.fontSize",
                format!("{}", value.font_size),
                Change::Size(-1.),
                Change::Size(1.),
            ),
            (
                "height",
                "shell.terminal.lineHeight",
                format!("{:.1}", value.line_height),
                Change::Height(-0.1),
                Change::Height(0.1),
            ),
            (
                "history",
                "shell.terminal.scrollback",
                format!("{}", value.effective_scrollback()),
                Change::History(-1000),
                Change::History(1000),
            ),
        ] {
            view = view.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .child(format!("{}: {}", self.message(key), current)),
                    )
                    .child(
                        Button::new(format!("terminal-{id}-decrease"))
                            .label(self.message("shell.terminal.decrease"))
                            .disabled(pending)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.change_terminal_settings(decrease, cx)
                            })),
                    )
                    .child(
                        Button::new(format!("terminal-{id}-increase"))
                            .label(self.message("shell.terminal.increase"))
                            .disabled(pending)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.change_terminal_settings(increase, cx)
                            })),
                    ),
            );
        }
        let cursor_key = match value.cursor_style {
            CursorStyle::Bar => "shell.terminal.cursorBar",
            CursorStyle::Block => "shell.terminal.cursorBlock",
            CursorStyle::Underline => "shell.terminal.cursorUnderline",
        };
        view = view
            .child(
                Button::new("terminal-scrollback-default")
                    .label(self.message(if value.scrollback_custom {
                        "shell.terminal.useDefaultHistory"
                    } else {
                        "shell.terminal.useCustomHistory"
                    }))
                    .disabled(pending)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.change_terminal_settings(Change::ToggleHistory, cx)
                    })),
            )
            .child(
                Button::new("terminal-cursor-style")
                    .label(format!(
                        "{}: {}",
                        self.message("shell.terminal.cursorStyle"),
                        self.message(cursor_key)
                    ))
                    .disabled(pending)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.change_terminal_settings(Change::Cursor, cx)
                    })),
            );
        if pending {
            view = view.child(self.message("shell.terminal.saving"));
        }
        if let Some(key) = self.terminal_settings.error {
            view = view.child(self.message(key));
        }
        view
    }
}
