use super::*;

impl Render for DesktopShell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_preview_airspace(window);
        self.sync_terminal_size(window, cx);
        let palette = self.palette();
        let file_tree_entity = cx.entity();
        let history_entity = file_tree_entity.clone();
        let history_source_entity = file_tree_entity.clone();
        let history_query_entity = file_tree_entity.clone();
        let history_scroll_entity = file_tree_entity.clone();
        let history_toggle_star_entity = file_tree_entity.clone();
        let history_alias_entity = history_entity.clone();
        let history_favorite_entity = file_tree_entity.clone();
        let history_time_entity = file_tree_entity.clone();
        let extension_entity = file_tree_entity.clone();
        let extension_delete_entity = file_tree_entity.clone();
        let extension_cancel_delete_entity = file_tree_entity.clone();
        let extension_toggle_entity = file_tree_entity.clone();
        let extension_rename_entity = file_tree_entity.clone();
        let extension_save_rename_entity = file_tree_entity.clone();
        let extension_cancel_rename_entity = file_tree_entity.clone();
        let file_tree_file_entity = file_tree_entity.clone();
        let file_operation_file_entity = file_tree_entity.clone();
        let file_operation_directory_entity = file_tree_entity.clone();
        let file_operation_rename_entity = file_tree_entity.clone();
        let file_operation_confirm_entity = file_tree_entity.clone();
        let file_operation_cancel_entity = file_tree_entity.clone();
        let git_file_entity = file_tree_entity.clone();
        let git_stage_entity = file_tree_entity.clone();
        let git_unstage_entity = file_tree_entity.clone();
        let git_discard_entity = file_tree_entity.clone();
        let git_diff_entity = file_tree_entity.clone();
        let git_scroll_entity = file_tree_entity.clone();
        let git_diff_scroll_entity = file_tree_entity.clone();
        let conflict_take_entity = file_tree_entity.clone();
        let conflict_resolve_entity = file_tree_entity.clone();
        let conflict_close_entity = file_tree_entity.clone();
        let conflict_select_entity = file_tree_entity.clone();
        let git_revert_confirm_entity = file_tree_entity.clone();
        let git_revert_cancel_entity = file_tree_entity.clone();
        let git_commit_entity = file_tree_entity.clone();
        let git_commit_confirm_entity = file_tree_entity.clone();
        let git_commit_cancel_entity = file_tree_entity.clone();
        let git_checkout_entity = file_tree_entity.clone();
        let git_checkout_confirm_entity = file_tree_entity.clone();
        let git_checkout_cancel_entity = file_tree_entity.clone();
        let worktree_create_entity = file_tree_entity.clone();
        let worktree_remove_entity = file_tree_entity.clone();
        let worktree_select_entity = file_tree_entity.clone();
        let worktree_confirm_entity = file_tree_entity.clone();
        let worktree_cancel_entity = file_tree_entity.clone();
        let file_editor_entity = file_tree_entity.clone();
        let file_delete_entity = file_tree_entity.clone();
        let file_delete_confirm_entity = file_tree_entity.clone();
        let file_delete_cancel_entity = file_tree_entity.clone();
        let file_external_entity = file_tree_entity.clone();
        let preview_slot_entity = file_tree_entity.clone();
        let file_dirty = match &self.file_preview {
            files::PreviewState::Ready { content, .. } => {
                self.file_editor.read(cx).value().as_ref() != content
            }
            _ => false,
        };
        let file_tab_select_entity = file_tree_entity.clone();
        let file_tab_close_entity = file_tree_entity.clone();
        let file_tab_group_entity = file_tree_entity.clone();
        let file_close_save_entity = file_tree_entity.clone();
        let file_close_discard_entity = file_tree_entity.clone();
        let file_close_cancel_entity = file_tree_entity.clone();
        let title = "CLI-Manager";
        let sidebar = [
            self.message("sidebar.projects"),
            self.message("settings.tabs.terminal.label"),
            self.message("git.view.history"),
            self.message("shell.background.title"),
            self.message("sidebar.stats"),
            self.message("sidebar.extensions"),
            self.message("sidebar.settings"),
        ];
        let project_rows = match &self.projects {
            ProjectLoad::Ready(loaded) => loaded
                .rows
                .iter()
                .scan(None, |hidden_depth, row| {
                    if hidden_depth.is_some_and(|depth| row.depth <= depth) {
                        *hidden_depth = None;
                    }
                    let visible = hidden_depth.is_none();
                    if visible && row.group && self.collapsed_groups.contains(&row.id) {
                        *hidden_depth = Some(row.depth);
                    }
                    Some((row, visible))
                })
                .filter_map(|(row, visible)| visible.then_some(row))
                .map(|row| {
                    let id = row.id.clone();
                    let group = row.group;
                    let icon = if group {
                        loaded
                            .snapshot
                            .groups
                            .iter()
                            .find(|item| item.id == id)
                            .map(|item| item.icon.trim())
                            .filter(|icon| !icon.is_empty())
                    } else {
                        loaded
                            .snapshot
                            .projects
                            .iter()
                            .find(|item| item.id == id)
                            .map(|item| item.icon.trim())
                            .filter(|icon| !icon.is_empty())
                    };
                    let color = if group {
                        loaded
                            .snapshot
                            .groups
                            .iter()
                            .find(|item| item.id == id)
                            .and_then(|item| parse_project_color(&item.color))
                    } else {
                        loaded
                            .snapshot
                            .projects
                            .iter()
                            .find(|item| item.id == id)
                            .and_then(|item| parse_project_color(&item.color))
                    };
                    let collapsed = self.collapsed_groups.contains(&id);
                    let selected = !row.group && self.selected_project.as_ref() == Some(&id);
                    div()
                        .id(gpui::ElementId::Name(
                            format!("{}-{id}", if group { "group" } else { "project" }).into(),
                        ))
                        .px(px(8. + row.depth as f32 * 12.))
                        .py(px(6.))
                        .when_some(color, |element, color| {
                            element.border_l_2().border_color(rgb(color))
                        })
                        .when(!row.group, |element| {
                            element.cursor_pointer().bg(rgb(if selected {
                                palette.selected
                            } else {
                                palette.panel
                            }))
                        })
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if group {
                                if !this.collapsed_groups.remove(&id) {
                                    this.collapsed_groups.insert(id.clone());
                                }
                            } else {
                                this.history_open = false;
                                this.history.stop_watcher();
                                this.selected_project = Some(id.clone());
                                let has_snapshot = this.restore_enabled
                                    && workspace::persistence::load(&id).ok().flatten().is_some();
                                if this.restore_enabled
                                    && this.restore_mode == preferences::RestoreMode::Ask
                                    && has_snapshot
                                {
                                    this.workspace_sessions = None;
                                    this.restore_prompt_project = Some(id.clone());
                                } else {
                                    if !this.restore_enabled {
                                        let _ = workspace::persistence::clear();
                                    }
                                    this.open_project_terminal_with_restore(&id, has_snapshot, cx);
                                }
                            }
                            cx.notify();
                        }))
                        .child(if row.group {
                            format!(
                                "{} {}{}",
                                if collapsed { "▸" } else { "▾" },
                                icon.map(|value| format!("{value} ")).unwrap_or_default(),
                                row.label
                            )
                        } else {
                            format!(
                                "{}{}",
                                icon.map(|value| format!("{value} ")).unwrap_or_default(),
                                row.label
                            )
                        })
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let terminal_previews = self.terminal_pane_previews(cx);
        let mut terminal_lines = terminal_previews.into_iter().collect::<HashMap<_, _>>();
        let pane_sessions = self
            .workspace_sessions
            .as_ref()
            .map(|workspace| {
                workspace
                    .all()
                    .map(|entry| (entry.pane_id, entry.session_id.clone()))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let search_count = self.terminal_search_count();
        let search_active = self.terminal_search_active;
        let search_query = self.terminal_search_query.clone();
        let search_label = self.message("terminal.search.label");
        let active_session_id = self.sessions.active_session_id().map(str::to_owned);
        let drop_preview = self.drop_preview.as_ref();
        let session_ids = self
            .workspace_sessions
            .as_ref()
            .map(|workspace| {
                workspace
                    .all()
                    .map(|entry| entry.session_id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let session_tabs = session_ids
            .into_iter()
            .map(|session_id| {
                let selected = active_session_id.as_deref() == Some(session_id.as_str());
                let label = session_id.clone();
                let status = self
                    .workspace_sessions
                    .as_ref()
                    .and_then(|workspace| {
                        workspace.all().find(|entry| entry.session_id == session_id)
                    })
                    .map(|entry| entry.status_sources.merged())
                    .unwrap_or(workspace::tab_status::TabStatus::None);
                let status_color = match status {
                    workspace::tab_status::TabStatus::Attention => 0xf0b45b,
                    workspace::tab_status::TabStatus::Failed => 0xe06c75,
                    workspace::tab_status::TabStatus::Running => 0x64d98b,
                    workspace::tab_status::TabStatus::Done => 0x8e9bb5,
                    workspace::tab_status::TabStatus::None => 0x536174,
                };
                div()
                    .id(gpui::ElementId::Name(
                        format!("gpui-session-{session_id}").into(),
                    ))
                    .px(px(8.))
                    .py(px(4.))
                    .bg(rgb(if selected {
                        palette.selected
                    } else {
                        palette.surface
                    }))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.sessions.set_active(&session_id);
                        if let Some(workspace) = this.workspace_sessions.as_mut() {
                            workspace.set_active_session(&session_id);
                        }
                        this.terminal_size = None;
                        this.terminal_selection_anchor = None;
                        this.terminal_selection_end = None;
                        cx.notify();
                    }))
                    .on_drag(label.clone(), |label, _, _, cx| {
                        cx.new(|_| drag_preview::SessionDragPreview {
                            label: label.clone(),
                        })
                    })
                    .on_drag_move(cx.listener(|this, event: &DragMoveEvent<String>, _, cx| {
                        this.update_drop_preview(event.event.position);
                        cx.notify();
                    }))
                    .child(div().text_color(rgb(status_color)).child("●"))
                    .child(label)
            })
            .collect::<Vec<_>>();
        let terminal_handle = self.sessions.active().cloned();
        let runtime = self._runtime.clone();
        let terminal_focus = self.terminal_focus_handle.clone();
        let terminal_view = cx.weak_entity();
        let pane_root = self
            .workspace_sessions
            .as_ref()
            .map(|workspace| workspace.panes().root().clone())
            .unwrap_or(workspace::pane_tree::PaneNode::Leaf(1));
        let pane_layout = Self::pane_element(
            &pane_root,
            &mut terminal_lines,
            &pane_sessions,
            active_session_id.as_deref(),
            drop_preview,
            1.0,
            terminal_view.clone(),
            cx.entity(),
            terminal_focus.clone(),
            palette,
            cx,
        );
        let terminal = div()
            .id("gpui-terminal-input")
            .w_full()
            .flex_1()
            .min_h(px(0.))
            .focusable()
            .track_focus(&terminal_focus)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::handle_mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::handle_mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::handle_mouse_down))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, event, _, _| this.handle_mouse_up(event)),
            )
            .on_mouse_up(
                MouseButton::Middle,
                cx.listener(|this, event, _, _| this.handle_mouse_up(event)),
            )
            .on_mouse_up(
                MouseButton::Right,
                cx.listener(|this, event, _, _| this.handle_mouse_up(event)),
            )
            .on_mouse_move(cx.listener(|this, event, _, cx| this.handle_mouse_move(event, cx)))
            .on_scroll(cx.listener(|this, event, _, _| this.handle_terminal_scroll(event)))
            .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _, cx| {
                if this
                    .keymap
                    .matches(event, keymap::Action::ToggleCommandPalette)
                {
                    this.toggle_command_palette();
                    cx.notify();
                    return;
                }
                if this.command_palette_open {
                    if event.keystroke.key.eq_ignore_ascii_case("escape") {
                        this.toggle_command_palette();
                    } else if event.keystroke.key.eq_ignore_ascii_case("enter") {
                        this.run_selected_command(cx);
                    } else if event.keystroke.key.eq_ignore_ascii_case("arrowup")
                        || event.keystroke.key.eq_ignore_ascii_case("up")
                    {
                        this.move_command_selection(-1);
                    } else if event.keystroke.key.eq_ignore_ascii_case("arrowdown")
                        || event.keystroke.key.eq_ignore_ascii_case("down")
                    {
                        this.move_command_selection(1);
                    } else if event.keystroke.key.eq_ignore_ascii_case("backspace") {
                        this.command_palette_query.pop();
                        this.command_palette_selected = 0;
                    } else if !event.keystroke.modifiers.control
                        && !event.keystroke.modifiers.alt
                        && !event.keystroke.modifiers.platform
                    {
                        if let Some(text) = event.keystroke.key_char.as_deref() {
                            this.command_palette_query.push_str(text);
                        }
                    }
                    cx.notify();
                    return;
                }
                if this.keymap.matches(event, keymap::Action::SplitPane) {
                    this.split_active_terminal(workspace::pane_tree::SplitDirection::Right);
                    cx.notify();
                    return;
                }
                if this.keymap.matches(event, keymap::Action::ClosePane) {
                    this.close_active_terminal();
                    cx.notify();
                    return;
                }
                if this.keymap.matches(event, keymap::Action::ResizeLeft)
                    || this.keymap.matches(event, keymap::Action::ResizeRight)
                    || this.keymap.matches(event, keymap::Action::ResizeUp)
                    || this.keymap.matches(event, keymap::Action::ResizeDown)
                {
                    let delta = if this.keymap.matches(event, keymap::Action::ResizeLeft)
                        || this.keymap.matches(event, keymap::Action::ResizeUp)
                    {
                        -500
                    } else {
                        500
                    };
                    if delta != 0 {
                        if let Some(workspace) = this.workspace_sessions.as_mut() {
                            workspace.panes_mut().resize_active(delta);
                        }
                        this.persist_workspace_snapshot();
                        this.terminal_size = None;
                        cx.notify();
                        return;
                    }
                }
                if this.keymap.matches(event, keymap::Action::SearchTerminal) {
                    this.terminal_search_active = true;
                    cx.notify();
                    return;
                }
                if this.terminal_search_active {
                    if event.keystroke.key.eq_ignore_ascii_case("escape") {
                        this.terminal_search_active = false;
                    } else if event.keystroke.key.eq_ignore_ascii_case("backspace") {
                        this.terminal_search_query.pop();
                    } else if !event.keystroke.modifiers.control
                        && !event.keystroke.modifiers.alt
                        && !event.keystroke.modifiers.platform
                    {
                        if let Some(text) = event.keystroke.key_char.as_deref() {
                            this.terminal_search_query.push_str(text);
                        }
                    }
                    cx.notify();
                    return;
                }
                if this.keymap.matches(event, keymap::Action::CopySelection) {
                    if let Some(text) = this.selected_terminal_text() {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                        return;
                    }
                }
                let Some(handle) = terminal_handle.clone() else {
                    return;
                };
                let Ok(model_guard) = handle.model.lock() else {
                    return;
                };
                let session = model_guard.session_id();
                let Some(bytes) = DesktopShell::terminal_key_bytes(event, model_guard.input_mode())
                else {
                    return;
                };
                let Some(client) = handle.connection.client() else {
                    return;
                };
                let _ = runtime.spawn(async move {
                    let _ = client.write_bytes(&session, &bytes).await;
                });
            }))
            .when(search_active, |element| {
                element.child(
                    div()
                        .h(px(30.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .bg(rgb(palette.raised))
                        .child(format!(
                            "{search_label}: {}  ({search_count})",
                            search_query
                        )),
                )
            })
            .when(!session_tabs.is_empty(), |element| {
                element.child(
                    div()
                        .flex()
                        .gap(px(4.))
                        .px(px(4.))
                        .py(px(4.))
                        .bg(rgb(palette.surface))
                        .children(session_tabs),
                )
            })
            .children(self.terminal_input_error.map(|key| {
                div().px(px(8.)).py(px(4.)).child(self.message(key))
            }))
            .child(pane_layout);
        let content = if self.command_palette_open {
            let commands = self.filtered_command_items();
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .w(px(520.))
                .p(px(16.))
                .bg(rgb(palette.surface))
                .border(px(1.))
                .border_color(rgb(palette.selected))
                .child(self.message("shell.commandPalette.title"))
                .child(format!(
                    "{}: {}",
                    self.message("shell.commandPalette.query"),
                    self.command_palette_query
                ))
                .children(
                    commands
                        .into_iter()
                        .enumerate()
                        .map(|(index, (label, command))| {
                            div()
                                .id(gpui::ElementId::Name(format!("command-{}", command).into()))
                                .px(px(10.))
                                .py(px(8.))
                                .bg(rgb(if index == self.command_palette_selected {
                                    palette.selected
                                } else {
                                    palette.raised
                                }))
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.run_command(&command, cx);
                                    cx.notify();
                                }))
                                .child(label)
                        }),
                )
        } else if self.settings_open {
            let restore_value = if self.restore_enabled {
                self.message("shell.settings.enabled")
            } else {
                self.message("shell.settings.disabled")
            };
            let restore_mode = match self.restore_mode {
                preferences::RestoreMode::Ask => self.message("shell.settings.restoreAsk"),
                preferences::RestoreMode::Auto => self.message("shell.settings.restoreAuto"),
            };
            let exit_behavior = match self.exit_behavior {
                ExitBehavior::Ask => self.message("shell.settings.exitAsk"),
                ExitBehavior::Background => self.message("shell.settings.exitBackground"),
                ExitBehavior::Minimize => self.message("shell.settings.exitMinimize"),
                ExitBehavior::Discard => self.message("shell.settings.exitDiscard"),
            };
            let finished_value = if self.background_include_finished {
                self.message("shell.settings.enabled")
            } else {
                self.message("shell.settings.disabled")
            };
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .w(px(560.))
                .p(px(18.))
                .bg(rgb(palette.surface))
                .border(px(1.))
                .border_color(rgb(palette.selected))
                .child(self.message("shell.settings.title"))
                .child(div().id("terminal-settings-scroll").max_h(px(window.bounds().size.height.as_f32() * 0.4))
                    .overflow_y_scroll().child(self.terminal_settings_view(window, cx)))
                .child(
                    div()
                        .id("settings-restore-enabled")
                        .px(px(10.))
                        .py(px(8.))
                        .bg(rgb(palette.raised))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.toggle_restore_enabled();
                            cx.notify();
                        }))
                        .child(format!(
                            "{}: {restore_value}",
                            self.message("shell.settings.restoreEnabled")
                        )),
                )
                .child(
                    div()
                        .id("settings-restore-mode")
                        .px(px(10.))
                        .py(px(8.))
                        .bg(rgb(palette.raised))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.toggle_restore_mode();
                            cx.notify();
                        }))
                        .child(format!(
                            "{}: {restore_mode}",
                            self.message("shell.settings.restoreMode")
                        )),
                )
                .child(
                    div()
                        .id("settings-exit-behavior")
                        .px(px(10.))
                        .py(px(8.))
                        .bg(rgb(palette.raised))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.cycle_exit_behavior();
                            cx.notify();
                        }))
                        .child(format!(
                            "{}: {exit_behavior}",
                            self.message("shell.settings.exitBehavior")
                        )),
                )
                .child(
                    div()
                        .id("settings-include-finished")
                        .px(px(10.))
                        .py(px(8.))
                        .bg(rgb(palette.raised))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.toggle_background_include_finished();
                            cx.notify();
                        }))
                        .child(format!(
                            "{}: {finished_value}",
                            self.message("shell.settings.includeFinished")
                        )),
                )
        } else if self.exit_prompt {
            div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(self.message("terminal.exit.title"))
                .child(self.message("terminal.exit.description"))
                .child(
                    div().flex().gap(px(8.)).children(
                        [
                            ("terminal.exit.background", ExitBehavior::Background),
                            ("terminal.exit.minimize", ExitBehavior::Minimize),
                            ("terminal.exit.discard", ExitBehavior::Discard),
                            ("terminal.exit.cancel", ExitBehavior::Ask),
                        ]
                        .into_iter()
                        .map(|(key, behavior)| {
                            let is_cancel = behavior == ExitBehavior::Ask;
                            div()
                                .id(key)
                                .px(px(10.))
                                .py(px(6.))
                                .bg(if is_cancel {
                                    rgb(palette.raised)
                                } else {
                                    rgb(palette.selected)
                                })
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if is_cancel {
                                        this.exit_prompt = false;
                                    } else if behavior == ExitBehavior::Minimize {
                                        this.exit_prompt = false;
                                        window.minimize_window();
                                    } else {
                                        this.exit_prompt = false;
                                        this.exit_override = Some(behavior);
                                        window.remove_window();
                                    }
                                    cx.notify();
                                }))
                                .child(self.message(key))
                        }),
                    ),
                )
        } else if self.background_open {
            let sessions = self
                .background_sessions
                .visible(self.background_include_finished)
                .cloned()
                .collect::<Vec<_>>();
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .w(px(640.))
                .p(px(18.))
                .bg(rgb(palette.surface))
                .border(px(1.))
                .border_color(rgb(palette.selected))
                .child(self.message("shell.background.title"))
                .when(sessions.is_empty(), |element| {
                    element.child(self.message("shell.background.empty"))
                })
                .children(sessions.into_iter().map(|session| {
                    let session_id = session.session_id.clone();
                    let attach_id = session_id.clone();
                    let close_id = session_id.clone();
                    div()
                        .id(gpui::ElementId::Name(
                            format!("background-session-{session_id}").into(),
                        ))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .p(px(8.))
                        .bg(rgb(palette.raised))
                        .child(format!(
                            "{} · {} · {}",
                            session_id,
                            session.cwd.unwrap_or_default(),
                            session.task_status.unwrap_or_default()
                        ))
                        .child(
                            div()
                                .id(gpui::ElementId::Name(
                                    format!("background-attach-{attach_id}").into(),
                                ))
                                .px(px(8.))
                                .py(px(4.))
                                .bg(rgb(palette.selected))
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.attach_background_session(&attach_id, cx);
                                    cx.notify();
                                }))
                                .child(self.message("shell.background.attach")),
                        )
                        .child(
                            div()
                                .id(gpui::ElementId::Name(
                                    format!("background-end-{close_id}").into(),
                                ))
                                .px(px(8.))
                                .py(px(4.))
                                .bg(rgb(palette.selected))
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.close_background_session(&close_id);
                                    cx.notify();
                                }))
                                .child(self.message("shell.background.end")),
                        )
                }))
        } else if self.extensions_open {
            let extension_rename_editor = self.stats.rename_editor(window, cx);
            stats::extension_view(
                &self.stats.extensions,
                self.message("extensions.title"),
                self.message("extensions.empty"),
                self.stats.extensions_loading,
                self.message("extensions.loading"),
                self.stats.extensions_error.clone(),
                self.message("extensions.kind.mcp"),
                self.message("extensions.kind.skill"),
                self.message("extensions.kind.installation"),
                self.message("extensions.status.managed"),
                self.message("extensions.status.owned"),
                self.message("extensions.status.externalModified"),
                self.message("extensions.status.unowned"),
                self.message("common.delete"),
                self.message("extensions.mcp.deleteConfirmShort"),
                self.message("common.cancel"),
                [
                    self.message("extensions.mcp.cliClaude"),
                    self.message("extensions.mcp.cliCodex"),
                    self.message("extensions.mcp.cliGrok"),
                ],
                self.stats.extension_delete_pending.as_deref(),
                move |resource_id, _window, app| {
                    let _ = extension_entity.update(app, |this, cx| {
                        this.stats.extension_delete_pending = Some(resource_id);
                        cx.notify();
                    });
                },
                move |resource_id, window, app| {
                    let _ = extension_delete_entity.update(app, |this, cx| {
                        this.confirm_delete_mcp_extension(resource_id, window, cx);
                    });
                },
                move |_window, app| {
                    let _ = extension_cancel_delete_entity.update(app, |this, cx| {
                        this.stats.extension_delete_pending = None;
                        cx.notify();
                    });
                },
                move |resource_id, cli, enabled, window, app| {
                    let _ = extension_toggle_entity.update(app, |this, cx| {
                        this.toggle_mcp_extension(resource_id, cli, enabled, window, cx);
                    });
                },
                self.stats.extension_rename_draft.as_ref(),
                self.stats.extension_rename_error.as_deref(),
                self.message("extensions.mcp.edit"),
                self.message("common.save"),
                move |resource_id, name, window, app| {
                    let _ = extension_rename_entity.update(app, |this, cx| {
                        this.begin_mcp_rename(resource_id, name, window, cx);
                    });
                },
                move |resource_id, window, app| {
                    let _ = extension_save_rename_entity.update(app, |this, cx| {
                        this.save_mcp_rename(resource_id, window, cx);
                    });
                },
                move |_window, app| {
                    let _ = extension_cancel_rename_entity.update(app, |this, cx| {
                        this.stats.extension_rename_draft = None;
                        this.stats.extension_rename_error = None;
                        cx.notify();
                    });
                },
                &extension_rename_editor,
                palette.surface,
                palette.raised,
                palette.text,
            )
        } else if self.stats_open {
            let stats_entity = file_tree_entity.clone();
            let stats_time_entity = file_tree_entity.clone();
            let stats_project_entity = file_tree_entity.clone();
            let project_filters = match &self.projects {
                ProjectLoad::Ready(loaded) => {
                    std::iter::once((self.message("shell.stats.projectAll"), None))
                        .chain(loaded.snapshot.projects.iter().map(|project| {
                            (
                                project.name.clone(),
                                Some(loaded.snapshot.project_path(project).to_owned()),
                            )
                        }))
                        .collect::<Vec<_>>()
                }
                _ => vec![(self.message("shell.stats.projectAll"), None)],
            };
            let stats_history = if self.stats.history_rows.is_empty() {
                &self.history.rows
            } else {
                &self.stats.history_rows
            };
            stats::view(
                stats::StatsSummary::from_rows(
                    stats_history,
                    &self.history.metadata,
                    self.stats.source_filter,
                    self.stats.time_filter,
                ),
                self.message("shell.stats.title"),
                self.message("shell.stats.sessions"),
                self.message("shell.stats.messages"),
                self.message("shell.stats.claude"),
                self.message("shell.stats.codex"),
                self.message("shell.stats.starred"),
                self.message("shell.stats.activity"),
                self.message("shell.stats.source"),
                self.message("shell.stats.claudePercent"),
                self.message("shell.stats.codexPercent"),
                self.message("shell.stats.inputTokens"),
                self.message("shell.stats.outputTokens"),
                self.message("shell.stats.cachedTokens"),
                self.message("shell.stats.requests"),
                self.stats.request_log_summary.request_count.max(0) as usize,
                &self.stats.request_log_breakdown,
                &self.stats.request_log_entries,
                self.message("shell.stats.requestEntries"),
                self.stats.project_efficiency,
                self.message("shell.stats.efficiency"),
                self.message("shell.stats.requestsShort"),
                self.message("shell.stats.completed"),
                self.message("shell.stats.tokensShort"),
                self.message("shell.stats.durationShort"),
                self.stats.source_filter,
                self.stats.time_filter,
                self.stats.project_filter.as_deref(),
                project_filters,
                move |filter, _window, app| {
                    let _ = stats_project_entity.update(app, |this, cx| {
                        this.stats.project_filter = filter;
                        this.reload_stats(cx);
                        cx.notify();
                    });
                },
                [
                    (
                        self.message("shell.stats.filterAll"),
                        history::SourceFilter::All,
                    ),
                    (
                        self.message("shell.stats.filterClaude"),
                        history::SourceFilter::Claude,
                    ),
                    (
                        self.message("shell.stats.filterCodex"),
                        history::SourceFilter::Codex,
                    ),
                ],
                [
                    (
                        self.message("shell.stats.rangeAll"),
                        history::TimeFilter::All,
                    ),
                    (
                        self.message("shell.stats.range7"),
                        history::TimeFilter::Recent7,
                    ),
                    (
                        self.message("shell.stats.range30"),
                        history::TimeFilter::Recent30,
                    ),
                ],
                move |filter, _window, app| {
                    let _ = stats_entity.update(app, |this, cx| {
                        this.stats.source_filter = filter;
                        this.reload_stats(cx);
                        cx.notify();
                    });
                },
                move |filter, _window, app| {
                    let _ = stats_time_entity.update(app, |this, cx| {
                        this.stats.time_filter = filter;
                        this.reload_stats(cx);
                        cx.notify();
                    });
                },
                self.message("shell.stats.tokenActivity"),
                self.message("shell.stats.inputTrend"),
                self.message("shell.stats.outputTrend"),
                [
                    self.message("shell.stats.today"),
                    self.message("shell.stats.day1"),
                    self.message("shell.stats.day2"),
                    self.message("shell.stats.day3"),
                    self.message("shell.stats.day4"),
                    self.message("shell.stats.day5"),
                    self.message("shell.stats.day6"),
                ],
                palette.surface,
                palette.raised,
                palette.text,
            )
        } else if self.history_open {
            history::view(
                &self.history,
                self.message("shell.history.title"),
                self.message("shell.history.loading"),
                self.message("shell.history.empty"),
                self.message("shell.history.failed"),
                [
                    (
                        self.message("shell.history.sourceAll"),
                        history::SourceFilter::All,
                    ),
                    (
                        self.message("shell.history.sourceClaude"),
                        history::SourceFilter::Claude,
                    ),
                    (
                        self.message("shell.history.sourceCodex"),
                        history::SourceFilter::Codex,
                    ),
                ],
                palette.selected,
                palette.surface,
                palette.text,
                move |session_id, _window, app| {
                    let _ = history_entity.update(app, |this, cx| {
                        this.select_history(&session_id, _window, cx)
                    });
                },
                move |source, _window, app| {
                    let _ = history_source_entity.update(app, |this, cx| {
                        this.history.set_source(source);
                        cx.notify();
                    });
                },
                self.message("history.search.globalPlaceholder"),
                move |query, _window, app| {
                    let _ = history_query_entity.update(app, |this, cx| {
                        this.history.set_query(query);
                        cx.notify();
                    });
                },
                move |delta, _window, app| {
                    let _ = history_scroll_entity.update(app, |this, cx| {
                        this.history.scroll_by(delta);
                        cx.notify();
                    });
                },
                move |session_id, _window, app| {
                    let _ = history_toggle_star_entity
                        .update(app, |this, cx| history::toggle_star(this, session_id, cx));
                },
                self.message(if self.history.favorite_only {
                    "history.favoriteFilter.showAll"
                } else {
                    "history.favoriteFilter.showOnly"
                }),
                move |favorite_only, _window, app| {
                    let _ = history_favorite_entity.update(app, |this, cx| {
                        this.history.set_favorite_only(favorite_only);
                        cx.notify();
                    });
                },
                [
                    (
                        self.message("history.timeFilter.all"),
                        history::TimeFilter::All,
                    ),
                    (
                        self.message("history.timeFilter.recent7"),
                        history::TimeFilter::Recent7,
                    ),
                    (
                        self.message("history.timeFilter.recent30"),
                        history::TimeFilter::Recent30,
                    ),
                ],
                move |time_filter, _window, app| {
                    let _ = history_time_entity.update(app, |this, cx| {
                        this.history.set_time_filter(time_filter);
                        cx.notify();
                    });
                },
                &self.file_operation_editor,
                self.message("history.meta.alias"),
                self.message("common.save"),
                move |_window, app| {
                    let _ =
                        history_alias_entity.update(app, |this, cx| history::save_alias(this, cx));
                },
            )
        } else {
            match &self.projects {
                ProjectLoad::Loading => div().child(self.message("app.init.loadingProjects")),
                ProjectLoad::Failed => div().child(self.message("sidebar.tree.loadFailed")),
                ProjectLoad::Ready(loaded) => {
                    let snapshot = &loaded.snapshot;
                    if let Some(project) = snapshot
                        .projects
                        .iter()
                        .find(|p| Some(&p.id) == self.selected_project.as_ref())
                    {
                        let main_path = snapshot.project_path(project).to_owned();
                        let main_kind =
                            workspace::worktree::classify(std::path::Path::new(&main_path));
                        let worktree_rows = workspace::worktree::rows(
                            project.name.clone(),
                            main_path.clone(),
                            &self.worktree_entries,
                            self.message(main_kind.label_key()),
                            self.message("shell.worktree.linked"),
                            self.message("shell.worktree.deleted"),
                            self.message("shell.worktree.unknown"),
                            self.message("shell.worktree.title"),
                            self.message("shell.worktree.create"),
                            self.message("shell.worktree.remove"),
                            palette.raised,
                            self.active_worktree_path.clone(),
                            palette.selected,
                            move |window, app| {
                                let _ = worktree_create_entity.update(app, |this, cx| {
                                    workspace::worktree::begin_create(this, window, cx)
                                });
                            },
                            move |path, _window, app| {
                                let _ = worktree_remove_entity.update(app, |this, cx| {
                                    workspace::worktree::request_remove(this, path, cx)
                                });
                            },
                            move |path, _window, app| {
                                let _ = worktree_select_entity
                                    .update(app, |this, cx| this.select_worktree(path, cx));
                            },
                        );
                        if self.restore_prompt_project.as_deref() == Some(project.id.as_str()) {
                            let project_id = project.id.clone();
                            let confirm_id = project_id.clone();
                            let skip_id = project_id.clone();
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(12.))
                                .child(project.name.clone())
                                .child(self.message("terminal.restore.title"))
                                .child(
                                    div()
                                        .flex()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .id("restore-session-confirm")
                                                .px(px(10.))
                                                .py(px(6.))
                                                .bg(rgb(palette.selected))
                                                .cursor_pointer()
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_project_terminal_with_restore(
                                                        &confirm_id,
                                                        true,
                                                        cx,
                                                    );
                                                    cx.notify();
                                                }))
                                                .child(self.message("terminal.restore.confirm")),
                                        )
                                        .child(
                                            div()
                                                .id("restore-session-skip")
                                                .px(px(10.))
                                                .py(px(6.))
                                                .bg(rgb(palette.raised))
                                                .cursor_pointer()
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    let _ =
                                                        workspace::persistence::remove(&skip_id);
                                                    this.open_project_terminal_with_restore(
                                                        &skip_id, false, cx,
                                                    );
                                                    cx.notify();
                                                }))
                                                .child(self.message("terminal.restore.skip")),
                                        ),
                                )
                        } else {
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(12.))
                                .child(project.name.clone())
                                .child(snapshot.project_path(project).to_owned())
                                .child(project.shell.clone())
                                .child(files::file_actions(
                                    self.message("shell.files.newFile"),
                                    self.message("shell.files.newDirectory"),
                                    self.message("shell.files.rename"),
                                    move |window, app| {
                                        let _ =
                                            file_operation_file_entity.update(app, |this, cx| {
                                                files::begin_operation(
                                                    this,
                                                    files::FileOperation::CreateFile,
                                                    window,
                                                    cx,
                                                )
                                            });
                                    },
                                    move |window, app| {
                                        let _ = file_operation_directory_entity.update(
                                            app,
                                            |this, cx| {
                                                files::begin_operation(
                                                    this,
                                                    files::FileOperation::CreateDirectory,
                                                    window,
                                                    cx,
                                                )
                                            },
                                        );
                                    },
                                    move |window, app| {
                                        let _ = file_operation_rename_entity
                                            .update(app, |this, cx| {
                                                files::begin_rename(this, window, cx)
                                            });
                                    },
                                ))
                                .child(files::view(
                                    &self.file_tree,
                                    palette.raised,
                                    self.message("shell.files.title"),
                                    self.message("shell.files.loading"),
                                    self.message("shell.files.empty"),
                                    self.message("shell.files.failed"),
                                    move |path, _window, app| {
                                        let _ = file_tree_entity.update(app, |this, cx| {
                                            this.toggle_file_directory(&path, cx);
                                        });
                                    },
                                    move |path, window, app| {
                                        let _ = file_tree_file_entity.update(app, |this, cx| {
                                            if let files::FileTreeState::Ready { root, .. } =
                                                &this.file_tree
                                            {
                                                cx.write_to_clipboard(ClipboardItem::new_string(
                                                    root.join(&path).to_string_lossy().into_owned(),
                                                ));
                                            }
                                            files::open_file(this, path, window, cx);
                                        });
                                    },
                                ))
                                .child(git::view(
                                    &self.git_status,
                                    self.message("git.view.changes"),
                                    self.message("common.loading"),
                                    self.message("git.empty.noChanges"),
                                    self.message("git.empty.notRepoTitle"),
                                    self.message("git.refs.title"),
                                    self.message("git.refs.branch"),
                                    self.message("git.refs.tag"),
                                    self.message("git.refs.empty"),
                                    self.message("git.refs.checkout"),
                                    self.message("git.commit.action"),
                                    self.message("git.tree.stageFile"),
                                    self.message("git.tree.unstageFile"),
                                    self.message("git.diff.revertFile"),
                                    self.message("git.diff.openSource"),
                                    self.git_offsets.0,
                                    move |reference, _window, app| {
                                        let _ = git_checkout_entity.update(app, |this, cx| {
                                            git::request_checkout(this, reference, cx)
                                        });
                                    },
                                    move |window, app| {
                                        let _ = git_commit_entity.update(app, |this, cx| {
                                            git::begin_commit(this, window, cx)
                                        });
                                    },
                                    move |path, window, app| {
                                        let _ = git_file_entity.update(app, |this, cx| {
                                            let conflicted = matches!(
                                                &this.git_status,
                                                git::GitState::Ready(status)
                                                    if status.entries.iter().any(|entry| {
                                                        entry.path == path
                                                            && workspace::conflicts::is_conflict_code(
                                                                entry.index,
                                                                entry.worktree,
                                                            )
                                                    })
                                            );
                                            if conflicted {
                                                workspace::conflicts::open(this, path, window, cx);
                                            } else {
                                                files::open_file(this, path, window, cx);
                                            }
                                        });
                                    },
                                    move |path, _window, app| {
                                        let _ = git_stage_entity.update(app, |this, cx| {
                                            git::start_action(this, path, git::GitAction::Stage, cx)
                                        });
                                    },
                                    move |path, _window, app| {
                                        let _ = git_unstage_entity.update(app, |this, cx| {
                                            git::start_action(
                                                this,
                                                path,
                                                git::GitAction::Unstage,
                                                cx,
                                            )
                                        });
                                    },
                                    move |path, _window, app| {
                                        let _ = git_discard_entity.update(app, |this, cx| {
                                            git::request_discard(this, path, cx)
                                        });
                                    },
                                    move |path, _window, app| {
                                        let _ = git_diff_entity.update(app, |this, cx| {
                                            git::start_diff(this, path, cx)
                                        });
                                    },
                                    move |delta, _window, app| {
                                        let _ = git_scroll_entity.update(app, |this, cx| {
                                            git::scroll_entries(this, delta, cx)
                                        });
                                    },
                                ))
                                .child(git::diff_view(
                                    &self.git_diff,
                                    self.git_diff_cache
                                        .blob_id
                                        .as_ref()
                                        .and_then(|key| self.git_diff_cache.highlight.get(key))
                                        .map(Vec::as_slice),
                                    self.message("git.diff.reviewDialog"),
                                    self.message("git.diff.loading"),
                                    self.message("git.diff.noContent"),
                                    self.message("git.diff.transportFailed"),
                                    self.git_offsets.1,
                                    move |delta, _window, app| {
                                        let _ = git_diff_scroll_entity.update(app, |this, cx| {
                                            git::scroll_diff(this, delta, cx)
                                        });
                                    },
                                ))
                                .when(self.conflicts.document.is_some() || self.conflicts.error.is_some(), |element| {
                                    element.child(workspace::conflicts::view(
                                        &self.conflicts,
                                        &self.file_editor,
                                        self.message("git.conflict.title"),
                                        self.message("git.conflict.error"),
                                        self.message("git.conflict.base"),
                                        self.message("git.conflict.ours"),
                                        self.message("git.conflict.theirs"),
                                        self.message("git.conflict.merged"),
                                        self.message("git.conflict.resolve"),
                                        self.message("common.cancel"),
                                        move |side, window, app| {
                                            let _ = conflict_take_entity.update(app, |this, cx| {
                                                workspace::conflicts::take_side(this, side, window, cx)
                                            });
                                        },
                                        move |window, app| {
                                            let _ = conflict_resolve_entity.update(app, |this, cx| {
                                                workspace::conflicts::resolve(this, window, cx)
                                            });
                                        },
                                        move |_window, app| {
                                            let _ = conflict_close_entity.update(app, |this, cx| {
                                                this.conflicts.clear();
                                                cx.notify();
                                            });
                                        },
                                        move |path, window, app| {
                                            let _ = conflict_select_entity.update(app, |this, cx| {
                                                workspace::conflicts::open(this, path, window, cx)
                                            });
                                        },
                                    ))
                                })
                                .child(files::tabs_view(
                                    &self.file_tabs,
                                    palette.raised,
                                    self.message("files.editor.closeOthers"),
                                    self.message("files.editor.closeLeft"),
                                    self.message("files.editor.closeRight"),
                                    move |path, window, app| {
                                        let _ = file_tab_select_entity.update(app, |this, cx| {
                                            files::select_tab(this, path, window, cx)
                                        });
                                    },
                                    move |path, window, app| {
                                        let _ = file_tab_close_entity.update(app, |this, cx| {
                                            files::close_tab(this, path, window, cx)
                                        });
                                    },
                                    move |group, window, app| {
                                        let _ = file_tab_group_entity.update(app, |this, cx| {
                                            files::close_group(this, group, window, cx)
                                        });
                                    },
                                ))
                                .when(self.file_close_prompt.is_some(), |element| {
                                    element.child(files::close_prompt_for_shell(
                                        self,
                                        file_close_save_entity,
                                        file_close_discard_entity,
                                        file_close_cancel_entity,
                                    ))
                                })
                                .when(self.file_delete_prompt.is_some(), |element| {
                                    element.child(files::delete_prompt_view(
                                        self.file_delete_prompt.as_deref(),
                                        self.message("files.confirm.deleteTitle"),
                                        self.message("files.confirm.deleteMessage"),
                                        self.message("common.delete"),
                                        self.message("common.cancel"),
                                        move |window, app| {
                                            let _ = file_delete_confirm_entity
                                                .update(app, |this, cx| {
                                                    files::confirm_delete(this, window, cx)
                                                });
                                        },
                                        move |_window, app| {
                                            let _ = file_delete_cancel_entity
                                                .update(app, |this, cx| {
                                                    files::cancel_delete(this, cx)
                                                });
                                        },
                                    ))
                                })
                                .when(self.file_operation_prompt.is_some(), |element| {
                                    element.child(files::operation_prompt(
                                        self.file_operation_prompt.as_ref(),
                                        &self.file_operation_editor,
                                        self.message("shell.files.operationTitle"),
                                        self.message("common.confirm"),
                                        self.message("common.cancel"),
                                        self.file_operation_error.as_deref(),
                                        move |_window, app| {
                                            let _ = file_operation_confirm_entity
                                                .update(app, |this, cx| {
                                                    files::confirm_operation(this, cx)
                                                });
                                        },
                                        move |_window, app| {
                                            let _ = file_operation_cancel_entity
                                                .update(app, |this, cx| {
                                                    files::cancel_operation(this, cx)
                                                });
                                        },
                                    ))
                                })
                                .when(self.git_revert_prompt.is_some(), |element| {
                                    element.child(git::discard_prompt(
                                        self.git_revert_prompt.as_deref(),
                                        self.message("git.diff.revertFileTitle"),
                                        self.message("git.confirm.revertMessage"),
                                        self.message("git.confirm.revert"),
                                        self.message("common.cancel"),
                                        move |_window, app| {
                                            let _ = git_revert_confirm_entity
                                                .update(app, |this, cx| {
                                                    git::confirm_discard(this, cx)
                                                });
                                        },
                                        move |_window, app| {
                                            let _ = git_revert_cancel_entity
                                                .update(app, |this, cx| {
                                                    git::cancel_discard(this, cx)
                                                });
                                        },
                                    ))
                                })
                                .when(self.git_commit_prompt, |element| {
                                    element.child(git::commit_prompt(
                                        self.git_commit_prompt,
                                        &self.file_operation_editor,
                                        self.message("git.commit.title"),
                                        self.message("common.confirm"),
                                        self.message("common.cancel"),
                                        self.file_operation_error.as_deref(),
                                        move |_window, app| {
                                            let _ = git_commit_confirm_entity
                                                .update(app, |this, cx| {
                                                    git::confirm_commit(this, cx)
                                                });
                                        },
                                        move |_window, app| {
                                            let _ = git_commit_cancel_entity
                                                .update(app, |this, cx| {
                                                    git::cancel_commit(this, cx)
                                                });
                                        },
                                    ))
                                })
                                .when(self.git_checkout_prompt.is_some(), |element| {
                                    element.child(git::checkout_prompt(
                                        self.git_checkout_prompt.as_ref(),
                                        self.message("git.refs.checkoutTitle"),
                                        self.message("git.refs.checkoutMessage"),
                                        self.message("common.confirm"),
                                        self.message("common.cancel"),
                                        move |_window, app| {
                                            let _ = git_checkout_confirm_entity
                                                .update(app, |this, cx| {
                                                    git::confirm_checkout(this, cx)
                                                });
                                        },
                                        move |_window, app| {
                                            let _ = git_checkout_cancel_entity
                                                .update(app, |this, cx| {
                                                    git::cancel_checkout(this, cx)
                                                });
                                        },
                                    ))
                                })
                                .when(self.worktree_prompt.is_some(), |element| {
                                    element.child(workspace::worktree::prompt_view(
                                        self.worktree_prompt.as_ref(),
                                        &self.file_operation_editor,
                                        self.message("shell.worktree.operationTitle"),
                                        self.message("shell.worktree.createPrompt"),
                                        self.message("shell.worktree.removeMessage"),
                                        self.message("common.confirm"),
                                        self.message("common.cancel"),
                                        self.worktree_error.as_deref(),
                                        move |_window, app| {
                                            let _ = worktree_confirm_entity
                                                .update(app, |this, cx| {
                                                    workspace::worktree::confirm(this, cx)
                                                });
                                        },
                                        move |_window, app| {
                                            let _ = worktree_cancel_entity
                                                .update(app, |this, cx| {
                                                    workspace::worktree::cancel(this, cx)
                                                });
                                        },
                                    ))
                                })
                                .child(
                                    div()
                                        .w_full()
                                        .on_children_prepainted(
                                            move |bounds, window, app| {
                                                if let Some(bounds) = bounds.first().copied() {
                                                    let _ = preview_slot_entity.update(
                                                        app,
                                                        |this, _| {
                                                            this.set_preview_slot_bounds(
                                                                bounds, window,
                                                            )
                                                        },
                                                    );
                                                }
                                            },
                                        )
                                        .id("file-preview-slot")
                                        .child(files::preview_view(
                                            &self.file_preview,
                                            palette.raised,
                                            self.message("shell.files.preview"),
                                            self.message("shell.files.previewLoading"),
                                            self.message("shell.files.previewFailed"),
                                            self.message("shell.files.pdfFallback"),
                                            self.message("shell.files.openExternal"),
                                            move |_window, app| {
                                                let _ = file_external_entity.update(app, |this, cx| {
                                                    files::open_external_preview(this, cx)
                                                });
                                            },
                                        )),
                                )
                                .when(
                                    matches!(&self.file_preview, files::PreviewState::Ready { .. }),
                                    |element| {
                                        element
                                            .child(files::editor_toolbar(
                                                file_dirty,
                                                &self.file_save_state,
                                                self.message("shell.files.save"),
                                                self.message("shell.files.dirty"),
                                                self.message("shell.files.saved"),
                                                self.message("shell.files.saving"),
                                                self.message("shell.files.saveFailed"),
                                                move |window, app| {
                                                    let _ = file_editor_entity
                                                        .update(app, |this, cx| {
                                                            this.save_file(window, cx)
                                                        });
                                                },
                                            ))
                                            .child(files::delete_button(
                                                self.message("common.delete"),
                                                move |_window, app| {
                                                    let _ = file_delete_entity
                                                        .update(app, |this, cx| {
                                                            files::request_delete(this, cx)
                                                        });
                                                },
                                            ))
                                    },
                                )
                                .when(
                                    matches!(&self.file_preview, files::PreviewState::Ready { .. }),
                                    |element| {
                                        element.child(Editor::new(&self.file_editor).h(px(360.)))
                                    },
                                )
                                .child(worktree_rows)
                                .child(terminal)
                        }
                    } else {
                        div().child(self.message("terminal.empty.title"))
                    }
                }
            }
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(palette.window))
            .text_color(rgb(palette.text))
            .child(
                div()
                    .h(px(42.))
                    .px(px(16.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(title)
                    .child(
                        div()
                            .id("toggle-language")
                            .px(px(8.))
                            .py(px(4.))
                            .bg(rgb(palette.raised))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.toggle_language();
                                cx.notify();
                            }))
                            .child(self.language_toggle_label()),
                    )
                    .child(
                        div()
                            .id("toggle-theme")
                            .px(px(8.))
                            .py(px(4.))
                            .bg(rgb(palette.raised))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.toggle_theme();
                                cx.notify();
                            }))
                            .child(self.message("shell.theme.toggle")),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("window-minimize")
                            .px(px(10.))
                            .py(px(6.))
                            .cursor_pointer()
                            .aria_label(self.message("shell.titlebar.minimize"))
                            .on_click(|_, window, _| window.minimize_window())
                            .child("—"),
                    )
                    .child(
                        div()
                            .id("window-maximize")
                            .px(px(10.))
                            .py(px(6.))
                            .cursor_pointer()
                            .aria_label(self.message("shell.titlebar.maximize"))
                            .on_click(|_, window, _| window.zoom_window())
                            .child("□"),
                    )
                    .child(
                        div()
                            .id("window-close")
                            .px(px(10.))
                            .py(px(6.))
                            .cursor_pointer()
                            .aria_label(self.message("shell.titlebar.close"))
                            .on_click(|_, window, _| window.remove_window())
                            .child("×"),
                    )
                    .on_mouse_down(MouseButton::Left, |event, window, _| {
                        if event.click_count == 1 {
                            window.start_window_move();
                        }
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .flex()
                    .child(
                        div()
                            .w(px(190.))
                            .flex()
                            .flex_col()
                            .p(px(12.))
                            .gap(px(8.))
                            .bg(rgb(palette.panel))
                            .children(sidebar.into_iter().enumerate().map(|(index, item)| {
                                div()
                                    .id(gpui::ElementId::Name(
                                        format!("sidebar-item-{index}").into(),
                                    ))
                                    .h(px(30.))
                                    .px(px(8.))
                                    .flex()
                                    .items_center()
                                    .cursor_pointer()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if index == 6 {
                                            this.toggle_settings();
                                        } else if index == 3 {
                                            this.open_history(cx);
                                        } else if index == 2 {
                                            this.open_background_sessions();
                                        } else if index == 4 {
                                            this.open_stats(cx);
                                        } else if index == 5 {
                                            this.open_extensions(cx);
                                        } else {
                                            this.settings_open = false;
                                            this.stats_open = false;
                                            this.extensions_open = false;
                                            this.history_open = false;
                                            this.background_open = false;
                                            this.history.stop_watcher();
                                        }
                                        cx.notify();
                                    }))
                                    .child(item)
                            }))
                            .child(
                                div()
                                    .id("project-list")
                                    .flex_1()
                                    .min_h(px(0.))
                                    .overflow_y_scroll()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .children(project_rows),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .p(px(24.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(content),
                    ),
            )
    }
}

fn parse_project_color(value: &str) -> Option<u32> {
    let value = value.trim().strip_prefix('#').unwrap_or(value.trim());
    (value.len() == 6)
        .then(|| u32::from_str_radix(value, 16).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::parse_project_color;

    #[test]
    fn parses_shared_project_hex_colors() {
        assert_eq!(parse_project_color("#12abEF"), Some(0x12abef));
        assert_eq!(parse_project_color(" 12abef "), Some(0x12abef));
        assert_eq!(parse_project_color("red"), None);
        assert_eq!(parse_project_color("#123"), None);
    }
}
