use crate::{load_messages, DesktopShell};

impl DesktopShell {
    pub(crate) fn reload_stats(&mut self, cx: &mut gpui::Context<Self>) {
        let Some(database) = self.preferences_database.clone() else {
            return;
        };
        let runtime = self._runtime.clone();
        let history_scope = self.stats.project_filter.clone();
        let history_task = runtime.spawn_blocking(move || {
            match history_scope {
                Some(path) => crate::history::load_for_project(std::path::PathBuf::from(path)),
                None => crate::history::load_for_all_projects(),
            }
        });
        let task = runtime.spawn(crate::projects::load_request_log_filtered(
            database,
            self.stats.project_filter.clone().unwrap_or_default(),
            self.stats.source_filter,
            self.stats.time_filter,
        ));
        cx.spawn(async move |this, cx| {
            let history = history_task.await.ok().and_then(Result::ok);
            if let Ok(Ok((summary, breakdown, entries, efficiency))) = task.await {
                let _ = this.update(cx, |this, cx| {
                    this.stats.request_log_summary = summary;
                    this.stats.request_log_breakdown = breakdown;
                    this.stats.request_log_entries = entries;
                    this.stats.project_efficiency = efficiency;
                    if let Some(history) = history {
                        this.stats.history_rows = history.rows;
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub(crate) fn open_history(&mut self, cx: &mut gpui::Context<Self>) {
        self.stats_open = false;
        self.extensions_open = false;
        crate::history::open(self, cx);
    }

    pub(crate) fn open_extensions(&mut self, cx: &mut gpui::Context<Self>) {
        self.stats.extension_load_generation = self.stats.extension_load_generation.wrapping_add(1);
        let generation = self.stats.extension_load_generation;
        self.extensions_open = true;
        self.settings_open = false;
        self.stats_open = false;
        self.history_open = false;
        self.stats.extensions_loading = true;
        self.stats.extensions_error = None;
        let Some(database) = self.preferences_database.clone() else {
            self.stats.extensions_loading = false;
            self.stats.extensions_error = Some(self.message("extensions.unavailable"));
            return;
        };
        let runtime = self._runtime.clone();
        let task = runtime.spawn(crate::projects::load_extension_overview(database));
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.stats.extension_load_generation != generation || !this.extensions_open {
                    return;
                }
                this.stats.extensions_loading = false;
                match result {
                    Ok(Ok(items)) => {
                        this.stats.extensions = items;
                        this.stats.extensions_error = None;
                    }
                    Ok(Err(error)) => {
                        this.stats.extensions.clear();
                        this.stats.extensions_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.loadFailed"),
                            error
                        ));
                    }
                    Err(error) => {
                        this.stats.extensions.clear();
                        this.stats.extensions_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.loadFailed"),
                            error
                        ));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn confirm_delete_mcp_extension(
        &mut self,
        resource_id: String,
        _window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) {
        if self.stats.extension_rename_draft.is_some() || self.stats.extensions_loading {
            return;
        }
        let Some(database) = self.preferences_database.clone() else {
            self.stats.extension_delete_pending = None;
            self.stats.extensions_error = Some(self.message("extensions.unavailable"));
            cx.notify();
            return;
        };
        self.stats.extension_delete_pending = None;
        self.stats.extensions_loading = true;
        self.stats.extensions_error = None;
        self.stats.extension_load_generation = self.stats.extension_load_generation.wrapping_add(1);
        let generation = self.stats.extension_load_generation;
        let runtime = self._runtime.clone();
        let task = runtime.spawn(crate::projects::delete_mcp_extension(database, resource_id));
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.stats.extension_load_generation != generation || !this.extensions_open {
                    return;
                }
                match result {
                    Ok(Ok(())) => {
                        this.stats.extensions_error = None;
                        this.reload_extensions(cx);
                    }
                    Ok(Err(error)) => {
                        this.stats.extensions_loading = false;
                        this.stats.extensions_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.mcp.deleteFailed"),
                            error
                        ));
                        cx.notify();
                    }
                    Err(error) => {
                        this.stats.extensions_loading = false;
                        this.stats.extensions_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.mcp.deleteFailed"),
                            error
                        ));
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    pub(crate) fn toggle_mcp_extension(
        &mut self,
        resource_id: String,
        cli: String,
        enabled: bool,
        _window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) {
        if self.stats.extension_rename_draft.is_some() || self.stats.extensions_loading {
            return;
        }
        let Some(database) = self.preferences_database.clone() else {
            self.stats.extensions_error = Some(self.message("extensions.unavailable"));
            cx.notify();
            return;
        };
        self.stats.extensions_loading = true;
        self.stats.extensions_error = None;
        self.stats.extension_load_generation = self.stats.extension_load_generation.wrapping_add(1);
        let generation = self.stats.extension_load_generation;
        let runtime = self._runtime.clone();
        let task = runtime.spawn(crate::projects::set_mcp_extension_enabled(
            database,
            resource_id,
            cli,
            enabled,
        ));
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.stats.extension_load_generation != generation || !this.extensions_open {
                    return;
                }
                match result {
                    Ok(Ok(())) => this.reload_extensions(cx),
                    Ok(Err(error)) => {
                        this.stats.extensions_loading = false;
                        this.stats.extensions_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.mcp.toggleFailed"),
                            error
                        ));
                        cx.notify();
                    }
                    Err(error) => {
                        this.stats.extensions_loading = false;
                        this.stats.extensions_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.mcp.toggleFailed"),
                            error
                        ));
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    pub(crate) fn begin_mcp_rename(
        &mut self,
        resource_id: String,
        current_name: String,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) {
        if self.stats.extensions_loading || self.stats.extension_delete_pending.is_some() {
            return;
        }
        let editor = self.stats.rename_editor(window, cx);
        editor.update(cx, |editor, cx| {
            editor.set_value(current_name.clone(), window, cx);
        });
        self.stats.extension_rename_draft = Some((resource_id, current_name));
        self.stats.extension_rename_error = None;
        cx.notify();
    }

    pub(crate) fn save_mcp_rename(
        &mut self,
        resource_id: String,
        _window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) {
        if self.stats.extensions_loading {
            return;
        }
        let Some((draft_id, _)) = self.stats.extension_rename_draft.as_ref() else {
            return;
        };
        if draft_id != &resource_id {
            return;
        }
        let name = self
            .stats
            .extension_rename_editor
            .as_ref()
            .map(|editor| editor.read(cx).value().to_string())
            .unwrap_or_default();
        let Some(database) = self.preferences_database.clone() else {
            self.stats.extension_rename_error = Some(self.message("extensions.unavailable"));
            cx.notify();
            return;
        };
        self.stats.extensions_loading = true;
        self.stats.extension_rename_error = None;
        self.stats.extension_load_generation = self.stats.extension_load_generation.wrapping_add(1);
        let generation = self.stats.extension_load_generation;
        let runtime = self._runtime.clone();
        let task = runtime.spawn(crate::projects::rename_mcp_extension(
            database,
            resource_id,
            name,
        ));
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.stats.extension_load_generation != generation || !this.extensions_open {
                    return;
                }
                match result {
                    Ok(Ok(())) => {
                        this.stats.extension_rename_draft = None;
                        this.stats.extension_rename_error = None;
                        this.reload_extensions(cx);
                    }
                    Ok(Err(error)) => {
                        this.stats.extensions_loading = false;
                        this.stats.extension_rename_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.mcp.renameFailed"),
                            error
                        ));
                        cx.notify();
                    }
                    Err(error) => {
                        this.stats.extensions_loading = false;
                        this.stats.extension_rename_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.mcp.renameFailed"),
                            error
                        ));
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    fn reload_extensions(&mut self, cx: &mut gpui::Context<Self>) {
        let Some(database) = self.preferences_database.clone() else {
            self.stats.extensions_loading = false;
            self.stats.extensions_error = Some(self.message("extensions.unavailable"));
            cx.notify();
            return;
        };
        let runtime = self._runtime.clone();
        let generation = self.stats.extension_load_generation;
        let task = runtime.spawn(crate::projects::load_extension_overview(database));
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if !this.extensions_open || this.stats.extension_load_generation != generation {
                    return;
                }
                this.stats.extensions_loading = false;
                match result {
                    Ok(Ok(items)) => {
                        this.stats.extensions = items;
                        this.stats.extensions_error = None;
                    }
                    Ok(Err(error)) => {
                        this.stats.extensions.clear();
                        this.stats.extensions_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.loadFailed"),
                            error
                        ));
                    }
                    Err(error) => {
                        this.stats.extensions.clear();
                        this.stats.extensions_error = Some(format!(
                            "{}: {}",
                            this.message("extensions.loadFailed"),
                            error
                        ));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn open_stats(&mut self, cx: &mut gpui::Context<Self>) {
        self.stats_open = true;
        self.extensions_open = false;
        self.stats.source_filter = crate::history::SourceFilter::All;
        self.stats.time_filter = crate::history::TimeFilter::All;
        self.stats.project_filter = None;
        self.settings_open = false;
        self.history_open = false;
        crate::history::open(self, cx);
        self.history_open = false;
        self.reload_stats(cx);
    }

    pub(crate) fn toggle_language(&mut self) {
        self.language = match self.language {
            crate::preferences::InterfaceLanguage::ZhCn => {
                crate::preferences::InterfaceLanguage::ZhTw
            }
            crate::preferences::InterfaceLanguage::ZhTw => {
                crate::preferences::InterfaceLanguage::EnUs
            }
            crate::preferences::InterfaceLanguage::EnUs => {
                crate::preferences::InterfaceLanguage::ZhCn
            }
        };
        self.messages = load_messages(self.language);
        if let Err(error) =
            crate::preferences::save_language(self.preferences_database.as_deref(), self.language)
        {
            eprintln!("GPUI language preference save failed: {error}");
        }
    }

    pub(crate) fn toggle_theme(&mut self) {
        self.theme = match self.theme {
            crate::preferences::AppTheme::Dark => crate::preferences::AppTheme::Light,
            crate::preferences::AppTheme::Light => crate::preferences::AppTheme::Dark,
        };
        if let Err(error) =
            crate::preferences::save_theme(self.preferences_database.as_deref(), self.theme)
        {
            eprintln!("GPUI theme preference save failed: {error}");
        }
    }

    pub(crate) fn persist_runtime_settings(&self) {
        if let Err(error) = crate::preferences::save_runtime_settings(
            self.preferences_database.as_deref(),
            self.restore_enabled,
            self.restore_mode,
            self.exit_behavior,
            self.background_include_finished,
        ) {
            eprintln!("GPUI runtime settings save failed: {error}");
        }
    }
}
