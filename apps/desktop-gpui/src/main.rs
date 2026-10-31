use cli_manager_term_engine::input::{
    encode as encode_key, encode_mouse, InputMode, Key, Modifiers,
    MouseButton as TerminalMouseButton, MouseEvent, MouseEventKind, MouseInputMode,
};
use exit::ExitBehavior;
use gpui::{
    div, prelude::*, px, rgb, size, App, Bounds, ClipboardItem, Context, DragMoveEvent,
    ElementInputHandler, FocusHandle, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    Pixels, Point, ScrollDelta, ScrollEvent, TitlebarOptions, Window, WindowBounds, WindowOptions,
};
use gpui_component::{
    input::{Editor, EditorState},
    Root,
};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};
mod background_sessions;
mod daemon_bootstrap;
mod drag_preview;
mod exit;
mod files;
mod git;
mod history;
mod i18n;
mod ime;
mod keymap;
mod overlay;
mod paths;
mod preferences;
mod preview;
mod preview_host;
mod projects;
mod render;
mod routing_bootstrap;
mod settings_host;
mod shell_controls;
mod stats;
mod terminal;
mod terminal_input;
mod terminal_settings;
mod workspace;
use projects::ProjectLoad;
const ZH: &str = include_str!("../assets/i18n/zh-CN.json");
const EN: &str = include_str!("../assets/i18n/en-US.json");
struct DesktopShell {
    terminal_settings: terminal_settings::TerminalSettingsState,
    messages: std::collections::HashMap<String, String>,
    language: preferences::InterfaceLanguage,
    theme: preferences::AppTheme,
    keymap: keymap::Keymap,
    file_tree: files::FileTreeState,
    file_watch_generation: u64,
    file_watch_cancel: Option<tokio::sync::oneshot::Sender<()>>,
    file_preview: files::PreviewState,
    file_tabs: files::FileTabs,
    file_editor: gpui::Entity<EditorState>,
    file_operation_editor: gpui::Entity<EditorState>,
    file_operation_prompt: Option<files::FileOperation>,
    file_operation_error: Option<String>,
    git_commit_prompt: bool,
    file_save_state: files::SaveState,
    file_close_prompt: Option<String>,
    file_close_group_pending: Option<Vec<String>>,
    file_delete_prompt: Option<String>,
    git_revert_prompt: Option<String>,
    git_checkout_prompt: Option<git::GitRef>,
    git_status: git::GitState,
    git_watch_generation: u64,
    git_watch_cancel: Option<tokio::sync::oneshot::Sender<()>>,
    git_diff: git::DiffState,
    git_diff_cache: git::DiffCache,
    git_offsets: (usize, usize),
    conflicts: workspace::conflicts::ConflictState,
    worktree_entries: Vec<workspace::worktree::GitWorktree>,
    worktree_prompt: Option<workspace::worktree::Prompt>,
    worktree_error: Option<String>,
    worktree_load_generation: u64,
    active_worktree_path: Option<PathBuf>,
    file_tree_loading: std::collections::HashSet<String>,
    preferences_database: Option<PathBuf>,
    projects: ProjectLoad,
    selected_project: Option<String>,
    collapsed_groups: std::collections::HashSet<String>,
    _runtime: Arc<tokio::runtime::Runtime>,
    sessions: terminal::SessionRegistry,
    terminal_size: Option<(u16, u16)>,
    terminal_input_error: Option<&'static str>,
    terminal_sizes: HashMap<String, (u16, u16)>,
    terminal_cell_size: (f32, f32),
    pane_bounds: HashMap<String, Bounds<Pixels>>,
    terminal_selection_anchor: Option<(usize, usize)>,
    terminal_selection_end: Option<(usize, usize)>,
    terminal_selection_dragging: bool,
    divider_drag: Option<(workspace::pane_tree::DividerAxis, Point<Pixels>)>,
    drop_preview: Option<(String, workspace::pane_tree::DropZone)>,
    terminal_search_active: bool,
    terminal_search_query: String,
    command_palette_open: bool,
    command_palette_query: String,
    command_palette_selected: usize,
    settings_open: bool,
    background_open: bool,
    stats_open: bool,
    extensions_open: bool,
    stats: stats::StatsState,
    history_open: bool,
    history: history::HistoryState,
    low_power: bool,
    activation_subscription: Option<gpui::Subscription>,
    workspace_sessions: Option<workspace::session::WorkspaceSessions>,
    terminal_revision: u64,
    terminal_focus_handle: FocusHandle,
    ime_marked_text: String,
    restore_enabled: bool,
    restore_mode: preferences::RestoreMode,
    restore_prompt_project: Option<String>,
    restore_handled: bool,
    snapshot_writer: workspace::persistence::SnapshotWriter,
    exit_prompt: bool,
    exit_override: Option<ExitBehavior>,
    exit_behavior: ExitBehavior,
    background_include_finished: bool,
    background_sessions: background_sessions::BackgroundSessionStore,
    background_monitor: Option<background_sessions::MonitorHandle>,
    preview_controller: cli_manager_preview::PreviewController,
    preview_assets: cli_manager_preview::protocol::AssetRegistry,
    preview_webview: Option<cli_manager_preview::platform::native::NativeWebView>,
    preview_slot_bounds: Option<Bounds<Pixels>>,
    overlay_registry: overlay::OverlayRegistry,
    preview_occluded: bool,
    preview_bounds_subscription: Option<gpui::Subscription>,
    preview_visibility_subscription: Option<gpui::Subscription>,
    preview_display_subscription: Option<gpui::Subscription>,
}
#[derive(Clone, Copy)]
struct ThemePalette {
    window: u32,
    panel: u32,
    surface: u32,
    raised: u32,
    selected: u32,
    text: u32,
}
impl ThemePalette {
    const DARK: Self = Self {
        window: 0x12161d,
        panel: 0x1a2029,
        surface: 0x171c24,
        raised: 0x252c36,
        selected: 0x30425c,
        text: 0xe8edf4,
    };
    const LIGHT: Self = Self {
        window: 0xf4f6f8,
        panel: 0xe6eaf0,
        surface: 0xffffff,
        raised: 0xd9e0e8,
        selected: 0xc5d8ef,
        text: 0x1b2430,
    };
}
fn should_use_low_power_mode(window_active: bool) -> bool {
    !window_active
}

impl DesktopShell {
    fn new(
        language_override: Option<&str>,
        database: Option<PathBuf>,
        runtime: Arc<tokio::runtime::Runtime>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let shell_started = Instant::now();
        let startup_preferences = preferences::load(database.as_deref());
        eprintln!(
            "[gpui-startup] phase=preferences duration_ms={}",
            shell_started.elapsed().as_millis()
        );
        let language = match language_override {
            Some("en-US") => preferences::InterfaceLanguage::EnUs,
            Some("zh-TW") => preferences::InterfaceLanguage::ZhTw,
            _ => startup_preferences.language,
        };
        let projects = {
            let project_started = Instant::now();
            let (frame_ready, frame_received) = tokio::sync::oneshot::channel();
            window.on_next_frame(move |_, _| {
                let _ = frame_ready.send(());
            });
            let task = runtime.spawn(projects::load_current(database.clone()));
            cx.spawn(async move |this, cx| {
                let result = task.await;
                eprintln!(
                    "[gpui-startup] phase=project-snapshot duration_ms={}",
                    project_started.elapsed().as_millis()
                );
                if frame_received.await.is_err() {
                    return;
                }
                let _ = this.update(cx, |this, cx| {
                    this.projects = match result {
                        Ok(Ok(snapshot)) => ProjectLoad::Ready(snapshot),
                        error => {
                            eprintln!("GPUI project loading failed: {error:?}");
                            ProjectLoad::Failed
                        }
                    };
                    let project_ids = match &this.projects {
                        ProjectLoad::Ready(loaded) => loaded
                            .snapshot
                            .projects
                            .iter()
                            .map(|project| project.id.clone())
                            .collect::<Vec<_>>(),
                        _ => Vec::new(),
                    };
                    eprintln!(
                        "[gpui-startup] phase=project-restore-start elapsed_ms={}",
                        project_started.elapsed().as_millis()
                    );
                    this.maybe_restore_on_startup(project_ids, cx);
                    cx.notify();
                });
            })
            .detach();
            ProjectLoad::Loading
        };
        cx.spawn(async move |this, cx| loop {
            let delay = this
                .update(cx, |this, _| if this.low_power { 500 } else { 100 })
                .unwrap_or(500);
            cx.background_executor()
                .timer(std::time::Duration::from_millis(delay))
                .await;
            let update = this.update(cx, |this, cx| {
                let revision = this
                    .sessions
                    .active()
                    .and_then(|handle| handle.model.lock().ok().map(|model| model.revision))
                    .unwrap_or(0);
                if revision != this.terminal_revision {
                    this.terminal_revision = revision;
                    cx.notify();
                }
                let statuses = this
                    .sessions
                    .session_ids()
                    .into_iter()
                    .filter_map(|session_id| {
                        let handle = this.sessions.get(&session_id)?;
                        Some((
                            session_id,
                            handle.connection.status(),
                            handle.connection.hook_status(),
                        ))
                    })
                    .collect::<Vec<_>>();
                let mut status_changed = false;
                if let Some(workspace) = this.workspace_sessions.as_mut() {
                    for (session_id, status, hook_status) in statuses {
                        let shell_status = match status {
                            terminal::ConnectionStatus::Done => {
                                workspace::tab_status::TabStatus::Done
                            }
                            terminal::ConnectionStatus::Failed => {
                                workspace::tab_status::TabStatus::Failed
                            }
                            terminal::ConnectionStatus::Connecting
                            | terminal::ConnectionStatus::Running => {
                                workspace::tab_status::TabStatus::Running
                            }
                        };
                        let hook_status = match hook_status {
                            terminal::HookStatus::None => workspace::tab_status::TabStatus::None,
                            terminal::HookStatus::Running => {
                                workspace::tab_status::TabStatus::Running
                            }
                            terminal::HookStatus::Attention => {
                                workspace::tab_status::TabStatus::Attention
                            }
                            terminal::HookStatus::Done => workspace::tab_status::TabStatus::Done,
                            terminal::HookStatus::Failed => {
                                workspace::tab_status::TabStatus::Failed
                            }
                        };
                        status_changed |= workspace.update_shell_status(&session_id, shell_status);
                        status_changed |= workspace.update_hook_status(&session_id, hook_status);
                    }
                }
                if status_changed {
                    cx.notify();
                }
            });
            if update.is_err() {
                break;
            }
        })
        .detach();
        Self {
            language,
            terminal_settings: terminal_settings::TerminalSettingsState::new(startup_preferences.terminal),
            theme: startup_preferences.theme,
            keymap: startup_preferences.keymap,
            file_tree: files::FileTreeState::Empty,
            file_watch_generation: 0,
            file_watch_cancel: None,
            file_preview: files::PreviewState::Empty,
            file_tabs: files::FileTabs::default(),
            file_operation_editor: cx.new(|cx| {
                EditorState::new(window, cx)
                    .language("plaintext")
                    .default_value("")
            }),
            file_operation_prompt: None,
            file_operation_error: None,
            git_commit_prompt: false,
            file_save_state: files::SaveState::Idle,
            file_close_prompt: None,
            file_close_group_pending: None,
            file_delete_prompt: None,
            git_revert_prompt: None,
            git_checkout_prompt: None,
            git_status: git::GitState::Empty,
            git_watch_generation: 0,
            git_watch_cancel: None,
            git_diff: git::DiffState::Empty,
            git_diff_cache: git::DiffCache::default(),
            git_offsets: (0, 0),
            conflicts: workspace::conflicts::ConflictState::default(),
            worktree_entries: Vec::new(),
            worktree_prompt: None,
            worktree_error: None,
            worktree_load_generation: 0,
            active_worktree_path: None,
            file_editor: cx.new(|cx| {
                EditorState::new(window, cx)
                    .language("plaintext")
                    .default_value("")
            }),
            file_tree_loading: Default::default(),
            preferences_database: database.clone(),
            messages: load_messages(language),
            projects,
            selected_project: None,
            collapsed_groups: Default::default(),
            _runtime: runtime.clone(),
            sessions: terminal::SessionRegistry::new(),
            terminal_size: None,
            terminal_input_error: None,
            terminal_sizes: HashMap::new(),
            terminal_cell_size: (8.0, 16.0),
            pane_bounds: HashMap::new(),
            terminal_selection_anchor: None,
            terminal_selection_end: None,
            terminal_selection_dragging: false,
            divider_drag: None,
            drop_preview: None,
            terminal_search_active: false,
            terminal_search_query: String::new(),
            command_palette_open: false,
            command_palette_query: String::new(),
            command_palette_selected: 0,
            settings_open: false,
            background_open: false,
            stats_open: false,
            extensions_open: false,
            stats: Default::default(),
            history_open: false,
            history: history::HistoryState::default(),
            low_power: true,
            activation_subscription: None,
            workspace_sessions: None,
            terminal_revision: 0,
            terminal_focus_handle: cx.focus_handle(),
            ime_marked_text: String::new(),
            restore_enabled: startup_preferences.restore_enabled,
            restore_mode: startup_preferences.restore_mode,
            restore_prompt_project: None,
            restore_handled: false,
            snapshot_writer: workspace::persistence::SnapshotWriter::new(),
            exit_prompt: false,
            exit_override: None,
            exit_behavior: startup_preferences.exit_behavior,
            background_include_finished: startup_preferences.background_include_finished,
            background_sessions: background_sessions::BackgroundSessionStore::default(),
            background_monitor: None,
            preview_controller: cli_manager_preview::PreviewController::new(
                cli_manager_preview::probe::Probe::from_environment(),
                cli_manager_preview::PreviewHost::default(),
            ),
            preview_assets: cli_manager_preview::protocol::AssetRegistry::default(),
            preview_webview: None,
            preview_slot_bounds: None,
            overlay_registry: overlay::OverlayRegistry::default(),
            preview_occluded: false,
            preview_bounds_subscription: None,
            preview_visibility_subscription: None,
            preview_display_subscription: None,
        }
    }
    fn open_background_sessions(&mut self) {
        self.background_open = true;
        self.settings_open = false;
        self.stats_open = false;
        self.extensions_open = false;
        self.history_open = false;
        self.history.stop_watcher();
        if let Some(monitor) = &self.background_monitor {
            let _ = monitor.reconcile(self.sessions.session_ids(), true);
        }
    }

    fn attach_background_session(&mut self, session_id: &str, cx: &mut Context<Self>) {
        if self.sessions.set_active(session_id) {
            if let Some(workspace) = self.workspace_sessions.as_mut() {
                workspace.set_active_session(session_id);
            }
            self.background_open = false;
            self.terminal_size = None;
            if let Some(monitor) = &self.background_monitor {
                let _ = monitor.reconcile(self.sessions.session_ids(), false);
            }
            return;
        }
        let Some(metadata) = self.background_sessions.get(session_id).cloned() else {
            return;
        };
        let Some(cwd) = metadata.cwd.clone() else {
            eprintln!("GPUI background session has no cwd: {session_id}");
            return;
        };
        let Some(project_id) = self.project_id_for_path(&cwd) else {
            eprintln!("GPUI background session cwd is outside configured projects: {cwd}");
            return;
        };
        if self.selected_project.as_deref() != Some(project_id.as_str())
            || self.workspace_sessions.is_none()
        {
            self.open_project_terminal_with_restore(&project_id, false, cx);
        }
        let Some(workspace) = self.workspace_sessions.as_mut() else {
            return;
        };
        if workspace.set_active_session(session_id) {
            self.sessions.set_active(session_id);
            self.background_open = false;
            return;
        }
        let pane_id = workspace.panes().next_pane_id();
        workspace.split_active(
            session_id.to_owned(),
            workspace::pane_tree::SplitDirection::Right,
            workspace::session::SessionKind::RealPty,
        );
        let Ok(model) = terminal::model(session_id.to_owned()) else {
            let _ = workspace.close_active();
            return;
        };
        let cancellation = Arc::new(terminal::AttachCancellation::new());
        let connection = Arc::new(terminal::TerminalConnection::new());
        let _ = self._runtime.spawn(terminal::attach_existing_session(
            model.clone(),
            cancellation.clone(),
            connection.clone(),
        ));
        self.sessions.insert(
            session_id.to_owned(),
            terminal::SessionHandle::new(model, cancellation, connection),
        );
        let _ = workspace.set_active_pane(pane_id);
        self.persist_workspace_snapshot();
        self.background_open = false;
        self.terminal_size = None;
        if let Some(monitor) = &self.background_monitor {
            let _ = monitor.reconcile(self.sessions.session_ids(), false);
        }
    }

    fn project_id_for_path(&self, cwd: &str) -> Option<String> {
        let path = std::path::Path::new(cwd);
        let ProjectLoad::Ready(loaded) = &self.projects else {
            return None;
        };
        loaded.snapshot.projects.iter().find_map(|project| {
            let project_path = std::path::Path::new(loaded.snapshot.project_path(project));
            path.starts_with(project_path).then(|| project.id.clone())
        })
    }
    fn start_background_monitor(&mut self, cx: &mut Context<Self>) {
        if self.background_monitor.is_some() {
            return;
        }
        let (handle, mut events) = background_sessions::spawn_monitor(&self._runtime);
        let _ = handle.reconcile(self.sessions.session_ids(), false);
        self.background_monitor = Some(handle);
        cx.spawn(async move |this, cx| {
            while let Some(event) = events.recv().await {
                let _ = this.update(cx, |shell, cx| {
                    match event {
                        background_sessions::MonitorEvent::Snapshot(listing) => {
                            if let Err(error) =
                                shell.background_sessions.replace_from_listing(&listing)
                            {
                                eprintln!("GPUI background session listing ignored: {error}");
                            }
                        }
                        background_sessions::MonitorEvent::Status(status) => {
                            shell.background_sessions.apply_status(&status);
                        }
                        background_sessions::MonitorEvent::Error(error) => {
                            eprintln!("GPUI background session monitor: {error}");
                        }
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn close_background_session(&self, session_id: &str) {
        if let Some(monitor) = &self.background_monitor {
            let _ = monitor.close(session_id.to_owned());
        }
    }
    fn toggle_settings(&mut self) {
        self.background_open = false;
        self.settings_open = !self.settings_open;
        if self.settings_open {
            self.command_palette_open = false;
            self.restore_prompt_project = None;
            self.stats_open = false;
            self.extensions_open = false;
            self.history_open = false;
            self.history.stop_watcher();
        }
    }
    fn active_project_path(&self, main_path: &str) -> PathBuf {
        self.active_worktree_path
            .clone()
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| PathBuf::from(main_path))
    }
    fn session_namespace(&self, project_id: &str) -> String {
        workspace::worktree::session_namespace(project_id, self.active_worktree_path.as_deref())
    }
    fn select_worktree(&mut self, path: Option<PathBuf>, cx: &mut Context<Self>) {
        let Some(project_id) = self.selected_project.clone() else {
            return;
        };
        let next = path.filter(|candidate| candidate.is_dir());
        if self.active_worktree_path == next {
            return;
        }
        self.flush_workspace_snapshot();
        let clients = self.sessions.clients();
        for session_id in self.sessions.session_ids() {
            let _ = self.sessions.remove(&session_id);
        }
        self.workspace_sessions = None;
        self.pane_bounds.clear();
        self.terminal_sizes.clear();
        self.active_worktree_path = next;
        if !clients.is_empty() {
            let runtime = self._runtime.clone();
            runtime.spawn(async move {
                for client in &clients {
                    let _ = client.close_all().await;
                }
                if let Some(client) = clients.first() {
                    let _ = client.shutdown_if_idle().await;
                }
            });
        }
        self.open_project_terminal_with_restore(&project_id, false, cx);
    }
    fn select_history(&mut self, session_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self
            .history
            .rows
            .iter()
            .find(|row| row.session_id == session_id)
            .cloned()
        else {
            return;
        };
        self.history.selected = Some(row.session_id.clone());
        let key = history::metadata_key_for_row(&row);
        let alias = self
            .history
            .metadata
            .get(&key)
            .map(|meta| meta.alias.clone())
            .unwrap_or_default();
        self.file_operation_editor
            .update(cx, |editor, cx| editor.set_value(alias, window, cx));
        let snapshot = self.history.snapshot_details.get(&key).cloned();
        let task = self._runtime.spawn_blocking(move || {
            snapshot
                .map(Ok)
                .unwrap_or_else(|| history::load_detail(row))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
            let _ = this.update(cx, |this, cx| {
                if let Ok(detail) = result {
                    this.history.detail = Some(detail);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn maybe_restore_on_startup(&mut self, project_ids: Vec<String>, cx: &mut Context<Self>) {
        if self.restore_handled || self.selected_project.is_some() {
            return;
        }
        self.restore_handled = true;
        if !self.restore_enabled {
            if let Err(error) = workspace::persistence::clear() {
                eprintln!("GPUI workspace snapshot cleanup failed: {error}");
            }
            return;
        }
        let Some(project_id) = project_ids.into_iter().find(|project_id| {
            workspace::persistence::load(project_id)
                .ok()
                .flatten()
                .is_some()
        }) else {
            return;
        };
        self.selected_project = Some(project_id.clone());
        match self.restore_mode {
            preferences::RestoreMode::Auto => {
                self.open_project_terminal_with_restore(&project_id, true, cx)
            }
            preferences::RestoreMode::Ask => self.restore_prompt_project = Some(project_id),
        }
    }
    fn open_project_terminal_with_restore(
        &mut self,
        project_id: &str,
        restore: bool,
        cx: &mut Context<Self>,
    ) {
        self.restore_prompt_project = None;
        self.flush_workspace_snapshot();
        let ProjectLoad::Ready(loaded) = &self.projects else {
            return;
        };
        let Some(project) = loaded
            .snapshot
            .projects
            .iter()
            .find(|project| project.id == project_id)
        else {
            return;
        };
        if self.selected_project.as_deref() != Some(project_id) {
            self.active_worktree_path = None;
        }
        let default_session_id = self.session_namespace(project_id);
        let workspace_is_for_project = self.workspace_sessions.as_ref().is_some_and(|workspace| {
            workspace
                .all()
                .all(|entry| entry.session_id.starts_with(&default_session_id))
        });
        if self.selected_project.as_deref() == Some(project_id) && workspace_is_for_project {
            return;
        }
        self.selected_project = Some(project_id.to_owned());
        let cwd = self.active_project_path(loaded.snapshot.project_path(project));
        let shell = (!project.shell.trim().is_empty()).then(|| project.shell.clone());
        self.load_file_tree(project_id, PathBuf::from(&cwd), cx);
        let restored = restore
            .then(|| workspace::persistence::load(project_id).ok().flatten())
            .flatten();
        let mut workspace = restored
            .unwrap_or_else(|| workspace::session::WorkspaceSessions::new(&default_session_id));
        if workspace.all().next().is_none() {
            workspace = workspace::session::WorkspaceSessions::new(&default_session_id);
        }
        let session_ids = workspace
            .all()
            .map(|entry| entry.session_id.clone())
            .collect::<Vec<_>>();
        let active_session_id = workspace.active_session_id().map(str::to_owned);
        self.workspace_sessions = Some(workspace);
        for session_id in session_ids {
            if self.sessions.get(&session_id).is_some() {
                continue;
            }
            let Ok(model) = terminal::model(session_id.clone()) else {
                continue;
            };
            let cancellation = Arc::new(terminal::AttachCancellation::new());
            let connection = Arc::new(terminal::TerminalConnection::new());
            let _ = self
                ._runtime
                .spawn(terminal::attach_project_from_environment(
                    model.clone(),
                    cwd.to_string_lossy().into_owned(),
                    shell.clone(),
                    cancellation.clone(),
                    connection.clone(),
                ));
            self.sessions.insert(
                session_id,
                terminal::SessionHandle::new(model, cancellation, connection),
            );
        }
        if let Some(active_session_id) = active_session_id {
            self.sessions.set_active(&active_session_id);
        }
        self.persist_workspace_snapshot();
        self.terminal_size = None;
        self.terminal_sizes.clear();
        self.terminal_selection_anchor = None;
        self.terminal_selection_end = None;
        self.terminal_selection_dragging = false;
        self.divider_drag = None;
    }
    fn load_file_tree(&mut self, project_id: &str, path: PathBuf, cx: &mut Context<Self>) {
        if let Some(cancel) = self.file_watch_cancel.take() {
            let _ = cancel.send(());
        }
        self.file_watch_generation = self.file_watch_generation.wrapping_add(1);
        files::start_file_watcher(self, project_id, &path, self.file_watch_generation, cx);
        self.file_tree = files::FileTreeState::Loading {
            project_id: project_id.to_owned(),
        };
        self.preview_controller.close();
        self.file_preview = files::PreviewState::Empty;
        self.file_tabs = files::FileTabs::default();
        self.file_operation_prompt = None;
        self.file_operation_error = None;
        self.git_commit_prompt = false;
        self.file_save_state = files::SaveState::Idle;
        self.file_close_prompt = None;
        self.file_close_group_pending = None;
        self.file_delete_prompt = None;
        self.git_revert_prompt = None;
        self.git_checkout_prompt = None;
        self.git_diff = git::DiffState::Empty;
        self.git_diff_cache.clear();
        self.git_offsets = (0, 0);
        self.conflicts.clear();
        self.worktree_entries.clear();
        self.worktree_prompt = None;
        self.worktree_error = None;
        self.worktree_load_generation = self.worktree_load_generation.wrapping_add(1);
        self.file_tree_loading.clear();
        git::start_load(self, project_id, path.clone(), cx);
        workspace::worktree::start_load(self, path.clone(), self.worktree_load_generation, cx);
        let expected_project = project_id.to_owned();
        let task = self._runtime.spawn(files::load_root_async(path));
        cx.spawn(async move |this, cx| {
            let (root, result) = task
                .await
                .unwrap_or_else(|error| (PathBuf::new(), Err(error.to_string())));
            let _ = this.update(cx, |this, cx| {
                if files::finish_root_load(
                    &mut this.file_tree,
                    this.selected_project.as_deref(),
                    &expected_project,
                    root,
                    result,
                ) {
                    cx.notify();
                }
            });
        })
        .detach();
    }
    fn toggle_file_directory(&mut self, relative_path: &str, cx: &mut Context<Self>) {
        let Some(action) = files::toggle_directory(
            &mut self.file_tree,
            &mut self.file_tree_loading,
            relative_path,
        ) else {
            return;
        };
        let files::ToggleDirectory::Load {
            project_id,
            root,
            path,
            depth,
        } = action
        else {
            cx.notify();
            return;
        };
        let load_path = path.clone();
        let task = self._runtime.spawn(async move {
            tokio::task::spawn_blocking(move || {
                files::load_directory_with_root(
                    &root.join(&load_path),
                    &load_path,
                    depth + 1,
                    &root,
                )
            })
            .await
            .unwrap_or_else(|error| Err(error.to_string()))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
            let _ = this.update(cx, |this, cx| {
                if files::finish_directory_load(
                    &mut this.file_tree,
                    &mut this.file_tree_loading,
                    &project_id,
                    &path,
                    result,
                ) {
                    cx.notify();
                }
            });
        })
        .detach();
    }
    fn save_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (root, path) = match &self.file_tree {
            files::FileTreeState::Ready { root, .. } => match &self.file_preview {
                files::PreviewState::Ready { relative_path, .. } => {
                    (root.clone(), relative_path.clone())
                }
                _ => return,
            },
            _ => return,
        };
        if self.file_save_state == files::SaveState::Saving {
            return;
        }
        let content = self.file_editor.read(cx).value().to_string();
        if matches!(&self.file_preview, files::PreviewState::Ready { content: saved, .. } if saved == &content)
        {
            return;
        }
        self.file_save_state = files::SaveState::Saving;
        let task =
            self._runtime
                .spawn(files::write_text_async(root, path.clone(), content.clone()));
        let entity = cx.entity();
        window
            .spawn(cx, async move |cx| {
                let (saved_path, result) = task
                    .await
                    .unwrap_or_else(|error| (path.clone(), Err(error.to_string())));
                let _ = cx.update(|_, cx| {
                    let _ = entity.update(cx, |this, cx| {
                        if result.is_ok() {
                            this.file_preview = files::PreviewState::Ready {
                                relative_path: saved_path.clone(),
                                content: content.clone(),
                            };
                            this.file_tabs.mark_saved(&saved_path, content.clone());
                            this.file_save_state = files::SaveState::Saved;
                        } else {
                            this.file_save_state = files::SaveState::Failed;
                        }
                        cx.notify();
                    });
                });
            })
            .detach();
    }
    fn split_active_terminal(&mut self, direction: workspace::pane_tree::SplitDirection) {
        let ProjectLoad::Ready(loaded) = &self.projects else {
            return;
        };
        let Some(project_id) = self.selected_project.clone() else {
            return;
        };
        let Some(project) = loaded
            .snapshot
            .projects
            .iter()
            .find(|project| project.id == project_id)
        else {
            return;
        };
        let cwd = self.active_project_path(loaded.snapshot.project_path(project));
        let shell = (!project.shell.trim().is_empty()).then(|| project.shell.clone());
        let Some(workspace) = self.workspace_sessions.as_mut() else {
            return;
        };
        let pane_id = workspace.panes().next_pane_id();
        let session_id = format!("gpui-project-{project_id}-pane-{pane_id}");
        let _created_pane_id = workspace.split_active(
            session_id.clone(),
            direction,
            workspace::session::SessionKind::RealPty,
        );
        let Ok(model) = terminal::model(session_id.clone()) else {
            let _ = workspace.close_active();
            return;
        };
        let cancellation = Arc::new(terminal::AttachCancellation::new());
        let connection = Arc::new(terminal::TerminalConnection::new());
        let _ = self
            ._runtime
            .spawn(terminal::attach_project_from_environment(
                model.clone(),
                cwd.to_string_lossy().into_owned(),
                shell,
                cancellation.clone(),
                connection.clone(),
            ));
        self.sessions.insert(
            session_id,
            terminal::SessionHandle::new(model, cancellation, connection),
        );
        self.persist_workspace_snapshot();
        self.terminal_size = None;
        self.terminal_selection_anchor = None;
        self.terminal_selection_end = None;
        self.terminal_selection_dragging = false;
        self.divider_drag = None;
    }
    fn close_active_terminal(&mut self) {
        let Some(workspace) = self.workspace_sessions.as_mut() else {
            return;
        };
        let Some(entry) = workspace.close_active() else {
            return;
        };
        let session_id = entry.session_id;
        let _ = self.sessions.remove(&session_id);
        self.pane_bounds.remove(&session_id);
        self.terminal_sizes.remove(&session_id);
        self.terminal_size = None;
        self.terminal_selection_anchor = None;
        self.terminal_selection_end = None;
        self.terminal_selection_dragging = false;
        self.divider_drag = None;
        self.persist_workspace_snapshot();
    }
    fn persist_workspace_snapshot(&self) {
        let Some(project_id) = self.selected_project.clone() else {
            return;
        };
        let Some(workspace) = self.workspace_sessions.clone() else {
            return;
        };
        self.snapshot_writer.request(project_id, workspace);
    }
    fn flush_workspace_snapshot(&self) {
        self.snapshot_writer.flush_now();
    }
    fn message(&self, key: &str) -> String {
        self.messages
            .get(key)
            .cloned()
            .unwrap_or_else(|| key.to_owned())
    }
    fn language_toggle_label(&self) -> String {
        match self.language {
            preferences::InterfaceLanguage::ZhCn => self.message("shell.language.toTraditional"),
            preferences::InterfaceLanguage::ZhTw => self.message("shell.language.toEnglish"),
            preferences::InterfaceLanguage::EnUs => self.message("shell.language.toSimplified"),
        }
    }
    fn terminal_pane_previews(&mut self, cx: &mut Context<Self>) -> Vec<(String, Vec<gpui::AnyElement>)> {
        let cache = terminal::row_cache::shared(cx);
        let mut cache = cache.borrow_mut();
        let active = self.sessions.active_session_id().map(str::to_owned);
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
        session_ids
            .into_iter()
            .filter_map(|session_id| {
                if active.as_deref() == Some(session_id.as_str())
                    && self
                        .workspace_sessions
                        .as_ref()
                        .and_then(|sessions| sessions.active())
                        .is_some_and(|entry| entry.session_id != session_id)
                {
                    return None;
                }
                let handle = self.sessions.get(&session_id)?;
                let mut model = handle.model.lock().ok()?;
                let selection = (active.as_deref() == Some(session_id.as_str()))
                    .then(|| self.terminal_selection())
                    .flatten();
                Some((
                    session_id,
                    model.styled_lines(selection, &self.terminal_search_query, &self.terminal_settings.value, self.terminal_cell_size, &mut cache),
                ))
            })
            .collect()
    }
    fn terminal_search_count(&mut self) -> usize {
        self.sessions
            .active()
            .and_then(|handle| {
                handle
                    .model
                    .lock()
                    .ok()
                    .map(|mut model| model.search_matches(&self.terminal_search_query).len())
            })
            .unwrap_or(0)
    }
    fn terminal_selection(&self) -> Option<((usize, usize), (usize, usize))> {
        self.terminal_selection_anchor
            .zip(self.terminal_selection_end)
    }
    fn selected_terminal_text(&mut self) -> Option<String> {
        let selection = self.terminal_selection()?;
        (selection.0 != selection.1).then(|| {
            self.sessions
                .active()
                .and_then(|handle| {
                    handle
                        .model
                        .lock()
                        .ok()
                        .map(|mut model| model.selected_text(selection))
                })
                .unwrap_or_default()
        })
    }
    fn terminal_key_bytes(event: &gpui::KeyDownEvent, mode: InputMode) -> Option<Vec<u8>> {
        let keystroke = &event.keystroke;
        if keystroke.modifiers.platform || keystroke.modifiers.function {
            return None;
        }
        let modifiers = Modifiers {
            ctrl: keystroke.modifiers.control,
            alt: keystroke.modifiers.alt,
            shift: keystroke.modifiers.shift,
        };
        let key = match keystroke.key.to_ascii_lowercase().as_str() {
            "enter" | "return" => Key::Enter,
            "tab" => Key::Tab,
            "backspace" => Key::Backspace,
            "escape" | "esc" => Key::Escape,
            "up" | "arrowup" => Key::Up,
            "down" | "arrowdown" => Key::Down,
            "left" | "arrowleft" => Key::Left,
            "right" | "arrowright" => Key::Right,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" | "page_up" => Key::PageUp,
            "pagedown" | "page_down" => Key::PageDown,
            "insert" => Key::Insert,
            "delete" | "del" => Key::Delete,
            key if key
                .strip_prefix('f')
                .and_then(|value| value.parse::<u8>().ok())
                .is_some() =>
            {
                Key::Function(key[1..].parse().ok()?)
            }
            _ => {
                let character = keystroke
                    .key_char
                    .as_deref()
                    .or_else(|| {
                        (keystroke.key.chars().count() == 1).then_some(keystroke.key.as_str())
                    })?
                    .chars()
                    .next()?;
                Key::Char(character)
            }
        };
        Some(encode_key(key, modifiers, mode))
    }
    fn send_terminal_bytes(&self, data: Vec<u8>) {
        let Some(session_id) = self.sessions.active_session_id().map(str::to_owned) else {
            return;
        };
        self.send_terminal_bytes_to(&session_id, data);
    }
    fn send_terminal_bytes_to(&self, session_id: &str, data: Vec<u8>) {
        let Some(handle) = self.sessions.get(session_id).cloned() else {
            return;
        };
        let Ok(model) = handle.model.lock() else {
            return;
        };
        let session = model.session_id();
        let Some(client) = handle.connection.client() else {
            return;
        };
        let runtime = self._runtime.clone();
        let _ = runtime.spawn(async move {
            let _ = client.write_bytes(&session, &data).await;
        });
    }
    fn sync_terminal_size(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.sessions.len() == 0 {
            return;
        }
        let bounds = window.bounds();
        let settings = &self.terminal_settings.value;
        let (cell_width, natural_height) = terminal::fonts::cell_metrics(
            terminal::appearance::font_descriptor(settings), px(settings.font_size as f32), window, cx);
        let cell_height = natural_height * settings.line_height as f32;
        self.terminal_cell_size = (cell_width, cell_height);
        let pane_sizes = self
            .pane_bounds
            .iter()
            .map(|(session_id, pane)| {
                (
                    session_id.clone(),
                    pane.size.width.as_f32(),
                    pane.size.height.as_f32(),
                )
            })
            .collect::<Vec<_>>();
        if pane_sizes.is_empty() {
            let size = terminal_grid_size(
                bounds.size.width.as_f32(),
                bounds.size.height.as_f32(),
                cell_width,
                cell_height,
            );
            if let Some(session_id) = self.sessions.active_session_id().map(str::to_owned) {
                self.sync_session_size(&session_id, size);
            }
            self.terminal_size = Some(size);
        } else {
            for (session_id, width, height) in pane_sizes {
                self.sync_session_size(
                    &session_id,
                    terminal_grid_size_for_pane(width, height, cell_width, cell_height),
                );
            }
            if let Some(active) = self.sessions.active_session_id() {
                self.terminal_size = self.terminal_sizes.get(active).copied();
            }
        }
    }
    fn sync_session_size(&mut self, session_id: &str, size: (u16, u16)) {
        if self.terminal_sizes.get(session_id).copied() == Some(size) {
            return;
        }
        let Some(handle) = self.sessions.get(session_id).cloned() else {
            return;
        };
        let Some(client) = handle.connection.client() else {
            return;
        };
        let Ok(model) = handle.model.lock() else {
            return;
        };
        let session = model.session_id();
        self.terminal_sizes.insert(session_id.to_owned(), size);
        let runtime = self._runtime.clone();
        let _ = runtime.spawn(async move {
            let _ = client.resize(&session, size.0, size.1).await;
        });
    }
    fn terminal_mouse_bytes(
        position: Point<Pixels>,
        button: Option<MouseButton>,
        kind: MouseEventKind,
        modifiers: gpui::Modifiers,
        mode: MouseInputMode,
        cell_size: (f32, f32),
        origin: Point<Pixels>,
    ) -> Option<Vec<u8>> {
        let button = match button {
            Some(MouseButton::Left) => TerminalMouseButton::Left,
            Some(MouseButton::Middle) => TerminalMouseButton::Middle,
            Some(MouseButton::Right) => TerminalMouseButton::Right,
            _ if matches!(
                kind,
                MouseEventKind::Motion | MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
            ) =>
            {
                TerminalMouseButton::None
            }
            _ => return None,
        };
        let position = position - origin;
        let column = (position.x.as_f32() / cell_size.0.max(1.0)).floor() as u16 + 1;
        let row = (position.y.as_f32() / cell_size.1.max(1.0)).floor() as u16 + 1;
        encode_mouse(
            MouseEvent {
                button,
                kind,
                column,
                row,
                ctrl: modifiers.control,
                alt: modifiers.alt,
                shift: modifiers.shift,
            },
            mode,
        )
    }
    fn terminal_cell_position(
        position: Point<Pixels>,
        origin: Point<Pixels>,
        cell_size: (f32, f32),
    ) -> (usize, usize) {
        let position = position - origin;
        (
            (position.y.as_f32() / cell_size.1.max(1.0))
                .floor()
                .max(0.0) as usize,
            (position.x.as_f32() / cell_size.0.max(1.0))
                .floor()
                .max(0.0) as usize,
        )
    }
    fn pane_at(&self, position: Point<Pixels>) -> Option<(String, Bounds<Pixels>)> {
        self.pane_bounds
            .iter()
            .find(|(_, bounds)| {
                let right = bounds.origin.x.as_f32() + bounds.size.width.as_f32();
                let bottom = bounds.origin.y.as_f32() + bounds.size.height.as_f32();
                position.x.as_f32() >= bounds.origin.x.as_f32()
                    && position.x.as_f32() <= right
                    && position.y.as_f32() >= bounds.origin.y.as_f32()
                    && position.y.as_f32() <= bottom
            })
            .map(|(session_id, bounds)| (session_id.clone(), *bounds))
            .or_else(|| {
                self.sessions.active_session_id().and_then(|id| {
                    self.pane_bounds
                        .get(id)
                        .copied()
                        .map(|bounds| (id.to_owned(), bounds))
                })
            })
    }
    fn pane_root_bounds(&self) -> Option<Bounds<Pixels>> {
        let mut bounds = self.pane_bounds.values();
        let first = *bounds.next()?;
        let (left, top, right, bottom) = bounds.fold(
            (
                first.origin.x.as_f32(),
                first.origin.y.as_f32(),
                first.origin.x.as_f32() + first.size.width.as_f32(),
                first.origin.y.as_f32() + first.size.height.as_f32(),
            ),
            |(left, top, right, bottom), bound| {
                (
                    left.min(bound.origin.x.as_f32()),
                    top.min(bound.origin.y.as_f32()),
                    right.max(bound.origin.x.as_f32() + bound.size.width.as_f32()),
                    bottom.max(bound.origin.y.as_f32() + bound.size.height.as_f32()),
                )
            },
        );
        Some(Bounds {
            origin: Point {
                x: px(left),
                y: px(top),
            },
            size: gpui::size(px((right - left).max(1.)), px((bottom - top).max(1.))),
        })
    }
    fn pane_normalized_position(&self, position: Point<Pixels>) -> Option<(u16, u16)> {
        let root = self.pane_root_bounds()?;
        let x = ((position.x.as_f32() - root.origin.x.as_f32()) / root.size.width.as_f32()
            * 10_000.)
            .round()
            .clamp(0., 10_000.) as u16;
        let y = ((position.y.as_f32() - root.origin.y.as_f32()) / root.size.height.as_f32()
            * 10_000.)
            .round()
            .clamp(0., 10_000.) as u16;
        Some((x, y))
    }
    fn divider_at(&self, position: Point<Pixels>) -> Option<workspace::pane_tree::DividerAxis> {
        let (x, y) = self.pane_normalized_position(position)?;
        self.workspace_sessions
            .as_ref()
            .and_then(|workspace| workspace.panes().divider_at(x, y, 140))
    }
    fn drop_session_at(
        &mut self,
        source_session: &str,
        target_session: &str,
        position: Point<Pixels>,
    ) {
        let Some(target_bounds) = self.pane_bounds.get(target_session).copied() else {
            return;
        };
        let width = target_bounds.size.width.as_f32().max(1.);
        let height = target_bounds.size.height.as_f32().max(1.);
        let x = ((position.x.as_f32() - target_bounds.origin.x.as_f32()) / width).clamp(0., 1.);
        let y = ((position.y.as_f32() - target_bounds.origin.y.as_f32()) / height).clamp(0., 1.);
        let zone = workspace::pane_tree::DropZone::from_local_position(x, y);
        let Some(workspace) = self.workspace_sessions.as_mut() else {
            return;
        };
        if workspace.move_session(source_session, target_session, zone) {
            self.sessions.set_active(source_session);
            self.persist_workspace_snapshot();
            self.pane_bounds.clear();
            self.terminal_size = None;
            self.terminal_selection_anchor = None;
            self.terminal_selection_end = None;
            self.terminal_selection_dragging = false;
            self.divider_drag = None;
            self.drop_preview = None;
        }
    }
    fn update_drop_preview(&mut self, position: Point<Pixels>) {
        let Some((target_session, bounds)) = self.pane_at(position) else {
            self.drop_preview = None;
            return;
        };
        let x = ((position.x.as_f32() - bounds.origin.x.as_f32())
            / bounds.size.width.as_f32().max(1.))
        .clamp(0., 1.);
        let y = ((position.y.as_f32() - bounds.origin.y.as_f32())
            / bounds.size.height.as_f32().max(1.))
        .clamp(0., 1.);
        self.drop_preview = Some((
            target_session,
            workspace::pane_tree::DropZone::from_local_position(x, y),
        ));
    }
    fn activate_session(&mut self, session_id: &str) {
        if self.sessions.active_session_id() == Some(session_id) {
            return;
        }
        self.sessions.set_active(session_id);
        if let Some(workspace) = self.workspace_sessions.as_mut() {
            workspace.set_active_session(session_id);
        }
        self.terminal_size = None;
        self.terminal_selection_anchor = None;
        self.terminal_selection_end = None;
        self.terminal_selection_dragging = false;
        self.divider_drag = None;
    }
    fn mouse_mode(&self) -> MouseInputMode {
        self.sessions
            .active()
            .and_then(|handle| {
                handle
                    .model
                    .lock()
                    .ok()
                    .map(|model| model.mouse_input_mode())
            })
            .unwrap_or_default()
    }
    fn open_terminal_url(url: &str) {
        let valid = ["http://", "https://", "file://", "ssh://"]
            .iter()
            .any(|scheme| {
                url.get(..scheme.len())
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
            });
        if !valid || url.chars().any(|character| character.is_control()) {
            return;
        }
        #[cfg(windows)]
        let result = std::process::Command::new("explorer.exe").arg(url).spawn();
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("open").arg(url).spawn();
        #[cfg(all(unix, not(target_os = "macos")))]
        let result = std::process::Command::new("xdg-open").arg(url).spawn();
        if let Err(error) = result {
            eprintln!("GPUI failed to open terminal URL: {error}");
        }
    }
    fn handle_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.terminal_focus_handle.focus(window, cx);
        if event.button == MouseButton::Left {
            if let Some(axis) = self.divider_at(event.position) {
                self.divider_drag = Some((axis, event.position));
                cx.notify();
                return;
            }
        }
        let Some((session_id, bounds)) = self.pane_at(event.position) else {
            return;
        };
        self.activate_session(&session_id);
        if event.button == MouseButton::Left
            && !self.mouse_mode().click
            && !self.mouse_mode().drag
            && !self.mouse_mode().motion
        {
            let position = Self::terminal_cell_position(
                event.position,
                bounds.origin,
                self.terminal_cell_size,
            );
            if let Some(url) = self.sessions.get(&session_id).and_then(|handle| {
                handle
                    .model
                    .lock()
                    .ok()
                    .and_then(|mut model| model.url_at(position))
            }) {
                Self::open_terminal_url(&url);
                return;
            }
            self.terminal_selection_anchor = Some(position);
            self.terminal_selection_end = Some(position);
            self.terminal_selection_dragging = true;
            cx.notify();
            return;
        }
        if let Some(bytes) = Self::terminal_mouse_bytes(
            event.position,
            Some(event.button),
            MouseEventKind::Press,
            event.modifiers,
            self.mouse_mode(),
            self.terminal_cell_size,
            bounds.origin,
        ) {
            self.send_terminal_bytes_to(&session_id, bytes);
        }
    }
    fn handle_mouse_up(&mut self, event: &MouseUpEvent) {
        if self.divider_drag.take().is_some() {
            return;
        }
        let Some((session_id, bounds)) = self.pane_at(event.position) else {
            return;
        };
        self.activate_session(&session_id);
        if event.button == MouseButton::Left && self.terminal_selection_dragging {
            self.terminal_selection_end = Some(Self::terminal_cell_position(
                event.position,
                bounds.origin,
                self.terminal_cell_size,
            ));
            self.terminal_selection_dragging = false;
            return;
        }
        if let Some(bytes) = Self::terminal_mouse_bytes(
            event.position,
            Some(event.button),
            MouseEventKind::Release,
            event.modifiers,
            self.mouse_mode(),
            self.terminal_cell_size,
            bounds.origin,
        ) {
            self.send_terminal_bytes_to(&session_id, bytes);
        }
    }
    fn handle_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if let Some((axis, last)) = self.divider_drag {
            let Some(root) = self.pane_root_bounds() else {
                return;
            };
            let delta_pixels = match axis {
                workspace::pane_tree::DividerAxis::Horizontal => {
                    event.position.x.as_f32() - last.x.as_f32()
                }
                workspace::pane_tree::DividerAxis::Vertical => {
                    event.position.y.as_f32() - last.y.as_f32()
                }
            };
            let root_pixels = match axis {
                workspace::pane_tree::DividerAxis::Horizontal => root.size.width.as_f32(),
                workspace::pane_tree::DividerAxis::Vertical => root.size.height.as_f32(),
            }
            .max(1.);
            let delta_basis_points = (delta_pixels / root_pixels * 10_000.).round() as i16;
            if delta_basis_points != 0 {
                if let Some((x, y)) = self.pane_normalized_position(last) {
                    if let Some(workspace) = self.workspace_sessions.as_mut() {
                        if workspace
                            .panes_mut()
                            .resize_divider_at(x, y, delta_basis_points, 140)
                        {
                            self.persist_workspace_snapshot();
                            self.terminal_size = None;
                            cx.notify();
                        }
                    }
                }
            }
            self.divider_drag = Some((axis, event.position));
            return;
        }
        let Some((session_id, bounds)) = self.pane_at(event.position) else {
            return;
        };
        if self.terminal_selection_dragging && self.mouse_mode() == MouseInputMode::default() {
            self.terminal_selection_end = Some(Self::terminal_cell_position(
                event.position,
                bounds.origin,
                self.terminal_cell_size,
            ));
            cx.notify();
            return;
        }
        if let Some(bytes) = Self::terminal_mouse_bytes(
            event.position,
            event.pressed_button,
            MouseEventKind::Motion,
            event.modifiers,
            self.mouse_mode(),
            self.terminal_cell_size,
            bounds.origin,
        ) {
            self.send_terminal_bytes_to(&session_id, bytes);
        }
    }
    fn handle_terminal_scroll(&mut self, event: &ScrollEvent) {
        let Some((session_id, bounds)) = self.pane_at(event.position) else {
            return;
        };
        self.activate_session(&session_id);
        let lines = terminal_scroll_lines(event, self.terminal_cell_size.1);
        if lines == 0 {
            return;
        }
        let mode = self.mouse_mode();
        if mode.click || mode.drag || mode.motion {
            let kind = if lines > 0 {
                MouseEventKind::ScrollUp
            } else {
                MouseEventKind::ScrollDown
            };
            for _ in 0..lines.unsigned_abs().min(32) {
                if let Some(bytes) = Self::terminal_mouse_bytes(
                    event.position,
                    None,
                    kind,
                    event.modifiers,
                    mode,
                    self.terminal_cell_size,
                    bounds.origin,
                ) {
                    self.send_terminal_bytes_to(&session_id, bytes);
                }
            }
            return;
        }
        if let Some(handle) = self.sessions.active() {
            if let Ok(mut model) = handle.model.lock() {
                model.scroll(lines);
            }
        }
    }
    fn pane_element(
        node: &workspace::pane_tree::PaneNode,
        lines: &mut HashMap<String, Vec<gpui::AnyElement>>,
        pane_sessions: &HashMap<u64, String>,
        active_session_id: Option<&str>,
        drop_preview: Option<&(String, workspace::pane_tree::DropZone)>,
        grow: f32,
        terminal_view: gpui::WeakEntity<Self>,
        terminal_entity: gpui::Entity<Self>,
        terminal_focus: FocusHandle,
        palette: ThemePalette,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        use workspace::pane_tree::{PaneNode, SplitAxis};
        match node {
            PaneNode::Leaf(pane_id) => {
                let session_id = pane_sessions.get(pane_id).cloned();
                let Some(session_id) = session_id else {
                    return div().flex_grow(grow).into_any_element();
                };
                let selected = active_session_id == Some(session_id.as_str());
                let pane_session_id = session_id.clone();
                let callback_session_id = session_id.clone();
                let drop_target_session = session_id.clone();
                let file_drop_session = session_id.clone();
                let preview_zone = drop_preview
                    .and_then(|(target, zone)| (target == &session_id).then_some(*zone));
                let pane_lines = lines.remove(&session_id).unwrap_or_default();
                div()
                    .on_children_prepainted(move |bounds, window, app| {
                        window.handle_input(
                            &terminal_focus,
                            ElementInputHandler::new(window.bounds(), terminal_entity.clone()),
                            app,
                        );
                        let Some(first) = bounds.first() else {
                            return;
                        };
                        let origin = first.origin;
                        let right = bounds
                            .iter()
                            .map(|bound| bound.origin.x.as_f32() + bound.size.width.as_f32())
                            .fold(origin.x.as_f32(), f32::max);
                        let bottom = bounds
                            .iter()
                            .map(|bound| bound.origin.y.as_f32() + bound.size.height.as_f32())
                            .fold(origin.y.as_f32(), f32::max);
                        let size = gpui::size(
                            px((right - origin.x.as_f32()).max(1.)),
                            px((bottom - origin.y.as_f32()).max(1.)),
                        );
                        let _ = terminal_view.update(app, |this, _| {
                            this.pane_bounds
                                .insert(callback_session_id.clone(), Bounds { origin, size });
                            let grid_size = terminal_grid_size_for_pane(
                                size.width.as_f32(),
                                size.height.as_f32(),
                                this.terminal_cell_size.0,
                                this.terminal_cell_size.1,
                            );
                            this.sync_session_size(&callback_session_id, grid_size);
                        });
                    })
                    .id(gpui::ElementId::Name(
                        format!("gpui-pane-{session_id}").into(),
                    ))
                    .flex_grow(grow)
                    .flex_shrink_0()
                    .min_w(px(0.))
                    .min_h(px(0.))
                    .overflow_y_scroll()
                    .border(px(1.))
                    .border_color(rgb(match preview_zone {
                        Some(workspace::pane_tree::DropZone::Center) => 0x8e6dd8,
                        Some(workspace::pane_tree::DropZone::Left) => 0x4da3ff,
                        Some(workspace::pane_tree::DropZone::Right) => 0x4dd0e1,
                        Some(workspace::pane_tree::DropZone::Top) => 0x64d98b,
                        Some(workspace::pane_tree::DropZone::Bottom) => 0xf0b45b,
                        None if selected => 0x4b78a8,
                        None => palette.raised,
                    }))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.activate_session(&pane_session_id);
                            cx.notify();
                        }),
                    )
                    .on_drop(cx.listener(move |this, source: &String, window, cx| {
                        this.drop_session_at(source, &drop_target_session, window.mouse_position());
                        this.drop_preview = None;
                        cx.notify();
                    }))
                    .on_drop(cx.listener(move |this, paths: &gpui::ExternalPaths, window, cx| {
                        this.drop_terminal_paths(&file_drop_session, paths.paths(), window, cx);
                    }))
                    .children(
                        pane_lines
                            .into_iter()
                            .map(|line| div().w_full().child(line)),
                    )
                    .into_any_element()
            }
            PaneNode::Split {
                axis,
                ratio_basis_points,
                first,
                second,
            } => {
                let first_grow = (*ratio_basis_points as f32 / 10_000.).clamp(0.01, 0.99);
                let second_grow = (1. - first_grow).max(0.01);
                let first_element = Self::pane_element(
                    first,
                    lines,
                    pane_sessions,
                    active_session_id,
                    drop_preview,
                    grow * first_grow,
                    terminal_view.clone(),
                    terminal_entity.clone(),
                    terminal_focus.clone(),
                    palette,
                    cx,
                );
                let second_element = Self::pane_element(
                    second,
                    lines,
                    pane_sessions,
                    active_session_id,
                    drop_preview,
                    grow * second_grow,
                    terminal_view,
                    terminal_entity,
                    terminal_focus,
                    palette,
                    cx,
                );
                let container = div().flex().flex_grow(grow).min_w(px(0.)).min_h(px(0.));
                let container = match axis {
                    SplitAxis::Horizontal => container
                        .flex_row()
                        .child(first_element)
                        .child(second_element),
                    SplitAxis::Vertical => container
                        .flex_col()
                        .child(first_element)
                        .child(second_element),
                };
                container.into_any_element()
            }
        }
    }
}
fn load_messages(
    language: preferences::InterfaceLanguage,
) -> std::collections::HashMap<String, String> {
    let mut messages: std::collections::HashMap<String, String> =
        serde_json::from_str(if language == preferences::InterfaceLanguage::EnUs {
            EN
        } else {
            ZH
        })
        .expect("generated locale must be a string dictionary");
    if language == preferences::InterfaceLanguage::ZhTw {
        for value in messages.values_mut() {
            *value = i18n::to_traditional(value);
        }
    }
    messages
}
fn terminal_scroll_lines(event: &ScrollEvent, cell_height: f32) -> i32 {
    let delta = match event.delta {
        ScrollDelta::Lines(delta) => delta.y,
        ScrollDelta::Pixels(delta) => delta.y.as_f32() / cell_height.max(1.0),
    };
    let rounded = delta.round() as i32;
    if rounded != 0 {
        -rounded
    } else if delta > 0.0 {
        -1
    } else if delta < 0.0 {
        1
    } else {
        0
    }
}
fn terminal_grid_size(
    window_width: f32,
    window_height: f32,
    cell_width: f32,
    cell_height: f32,
) -> (u16, u16) {
    let width = (window_width - 238.0).max(cell_width * 2.0);
    let height = (window_height - 78.0).max(cell_height);
    terminal_grid_size_for_pane(width, height, cell_width, cell_height)
}
fn terminal_grid_size_for_pane(
    width: f32,
    height: f32,
    cell_width: f32,
    cell_height: f32,
) -> (u16, u16) {
    let width = width.max(cell_width * 2.0);
    let height = height.max(cell_height);
    (
        ((width / cell_width.max(1.0)).floor() as u16).max(2),
        ((height / cell_height.max(1.0)).floor() as u16).max(1),
    )
}
fn main() {
    let startup_started = Instant::now();
    let smoke = std::env::args().any(|arg| arg == "--smoke");
    if std::env::args().any(|arg| arg == "--check") {
        println!("cli-manager-gpui: shell contract compiled");
        return;
    }
    if std::env::args().any(|arg| arg == "--terminal-cache-benchmark") {
        if let Err(error) = terminal::cache_benchmark::run() {
            eprintln!("GPUI terminal cache benchmark: {error}");
            std::process::exit(1);
        }
        return;
    }
    let language_override = std::env::var("CLI_MANAGER_LANG").ok();
    let database = std::env::var_os("CLI_MANAGER_GPUI_DATABASE").map(PathBuf::from);
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(
                std::thread::available_parallelism()
                    .map(|count| count.get().min(4))
                    .unwrap_or(1),
            )
            .enable_all()
            .build()
            .expect("create GPUI services runtime"),
    );
    eprintln!(
        "[gpui-startup] phase=runtime-ready elapsed_ms={}",
        startup_started.elapsed().as_millis()
    );
    gpui_platform::application().run(move |cx: &mut App| {
        eprintln!(
            "[gpui-startup] phase=application-start elapsed_ms={}",
            startup_started.elapsed().as_millis()
        );
        gpui_component::init(cx);
        eprintln!(
            "[gpui-startup] phase=components-ready elapsed_ms={}",
            startup_started.elapsed().as_millis()
        );
        let bounds = Bounds::centered(None, size(px(1100.), px(720.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("CLI-Manager".into()),
                    appears_transparent: true,
                    traffic_light_position: None,
                }),
                ..Default::default()
            },
            move |window, cx| {
                let shell = cx.new(|cx| {
                    DesktopShell::new(
                        language_override.as_deref(),
                        database,
                        runtime.clone(),
                        window,
                        cx,
                    )
                });
                let (
                    activation_subscription,
                    preview_bounds_subscription,
                    preview_visibility_subscription,
                    preview_display_subscription,
                ) = shell.update(cx, |shell, cx| {
                    shell.sync_preview_bounds(window);
                    let bounds = cx.observe_window_bounds(window, |shell, window, _| {
                        shell.sync_preview_bounds(window);
                    });
                    let visibility =
                        cx.observe_window_visibility(window, |shell, visibility, window, _| {
                            shell.sync_preview_visibility(visibility, window)
                        });
                    let display = cx.observe_window_display(window, |shell, window, _| {
                        shell.sync_preview_bounds(window);
                    });
                    let activation = cx.observe_window_activation(window, |shell, window, cx| {
                        shell.low_power = should_use_low_power_mode(window.is_window_active());
                        cx.notify();
                    });
                    (activation, bounds, visibility, display)
                });
                shell.update(cx, |shell, _| {
                    shell.activation_subscription = Some(activation_subscription);
                    shell.preview_bounds_subscription = Some(preview_bounds_subscription);
                    shell.preview_visibility_subscription = Some(preview_visibility_subscription);
                    shell.preview_display_subscription = Some(preview_display_subscription);
                });
                shell.update(cx, |shell, cx| {
                    shell.install_close_handler(window, cx, runtime.clone());
                });
                let deferred_shell = shell.clone();
                window.on_next_frame(move |window, cx| {
                    eprintln!(
                        "[gpui-startup] phase=first-frame-rendered elapsed_ms={}",
                        startup_started.elapsed().as_millis()
                    );
                    deferred_shell.update(cx, |shell, cx| {
                        shell.start_preview_reaper(window, cx);
                        shell.start_background_monitor(cx);
                    });
                    eprintln!(
                        "[gpui-startup] phase=post-frame-services elapsed_ms={}",
                        startup_started.elapsed().as_millis()
                    );
                });
                let root = cx.new(|cx| Root::new(shell, window, cx));
                eprintln!(
                    "[gpui-startup] phase=root-created elapsed_ms={}",
                    startup_started.elapsed().as_millis()
                );
                root
            },
        )
        .expect("open GPUI desktop shell");
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
        if smoke {
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(3))
                    .await;
                let _ = cx.update(|cx| cx.quit());
            })
            .detach();
        }
    });
}
#[cfg(test)]
mod tests {
    include!("main_tests.rs");
}
