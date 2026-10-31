use cli_manager_history_core::{claude_project_key, parse_detail, TranscriptWatcher};
use gpui::{div, prelude::*, px, rgb, App, Div, Entity, ScrollDelta, ScrollEvent, Window};
use gpui_component::{
    input::{Editor, EditorState},
    scroll::ScrollableElement,
};
use std::cmp::Reverse;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::UNIX_EPOCH;

const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const VISIBLE_ROWS: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRow {
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub title: String,
    pub file_path: PathBuf,
    pub updated_at: i64,
    pub message_count: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryDetail {
    pub session_id: String,
    pub title: String,
    pub messages: Vec<HistoryMessage>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HistoryMeta {
    pub alias: String,
    pub starred: bool,
    pub tags_json: String,
}

struct HistoryDelta {
    changed: Vec<(HistoryRow, Option<HistoryDetail>)>,
    removed: Vec<PathBuf>,
}

struct HistoryWatch {
    watcher: TranscriptWatcher,
    sources: HashMap<PathBuf, &'static str>,
}

#[derive(Clone, Debug, Default)]
pub struct HistoryPage {
    pub rows: Vec<HistoryRow>,
    pub first_detail: Option<HistoryDetail>,
}

fn snapshot_detail(
    snapshot: &cli_manager_core_db::projects::FavoriteSnapshot,
) -> Option<HistoryDetail> {
    let value: serde_json::Value = serde_json::from_str(&snapshot.detail_json).ok()?;
    let messages = value
        .get("messages")?
        .as_array()?
        .iter()
        .filter_map(|message| {
            Some(HistoryMessage {
                role: message.get("role")?.as_str()?.to_owned(),
                content: message.get("content")?.as_str()?.to_owned(),
                timestamp: message
                    .get("timestamp")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned),
            })
        })
        .collect::<Vec<_>>();
    Some(HistoryDetail {
        session_id: snapshot.session_id.clone(),
        title: snapshot.title.clone(),
        messages,
    })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SourceFilter {
    #[default]
    All,
    Claude,
    Codex,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TimeFilter {
    #[default]
    All,
    Recent7,
    Recent30,
}

#[derive(Clone, Debug, Default)]
pub enum HistoryLoad {
    #[default]
    Empty,
    Loading,
    Ready,
    Failed,
}

#[derive(Debug, Default)]
pub struct HistoryState {
    pub load: HistoryLoad,
    pub rows: Vec<HistoryRow>,
    pub source: SourceFilter,
    pub favorite_only: bool,
    pub time_filter: TimeFilter,
    pub query: String,
    pub list_offset: usize,
    pub selected: Option<String>,
    pub project_path: Option<PathBuf>,
    pub detail: Option<HistoryDetail>,
    pub metadata: HashMap<String, HistoryMeta>,
    pub snapshot_details: HashMap<String, HistoryDetail>,
    pub database: Option<PathBuf>,
    pub last_refresh_ms: u128,
    pub refresh_batches: u64,
    watch_generation: u64,
    watch_cancel: Option<tokio::sync::oneshot::Sender<()>>,
}

impl HistoryState {
    pub fn begin(&mut self, project_path: PathBuf) -> bool {
        if self.project_path.as_ref() == Some(&project_path)
            && matches!(self.load, HistoryLoad::Loading | HistoryLoad::Ready)
        {
            return false;
        }
        self.project_path = Some(project_path);
        self.rows.clear();
        self.metadata.clear();
        self.snapshot_details.clear();
        self.selected = None;
        self.detail = None;
        self.load = HistoryLoad::Loading;
        true
    }

    pub fn stop_watcher(&mut self) {
        if let Some(cancel) = self.watch_cancel.take() {
            let _ = cancel.send(());
        }
        self.watch_generation = self.watch_generation.wrapping_add(1);
    }

    fn start_watcher(&mut self) -> (u64, tokio::sync::oneshot::Receiver<()>) {
        self.stop_watcher();
        let (cancel, receiver) = tokio::sync::oneshot::channel();
        self.watch_cancel = Some(cancel);
        (self.watch_generation, receiver)
    }

    pub fn finish(&mut self, page: Result<HistoryPage, String>) {
        match page {
            Ok(page) => {
                self.selected = page.rows.first().map(|row| row.session_id.clone());
                self.detail = page.first_detail;
                self.rows = page.rows;
                self.list_offset = 0;
                self.load = HistoryLoad::Ready;
            }
            Err(_) => {
                self.rows.clear();
                self.metadata.clear();
                self.detail = None;
                self.load = HistoryLoad::Failed;
            }
        }
    }

    fn apply_metadata(&mut self, metadata: Vec<cli_manager_core_db::projects::SessionMeta>) {
        self.metadata = metadata
            .into_iter()
            .map(|item| {
                (
                    history_meta_key(&item.source, &item.session_id, &item.file_path),
                    HistoryMeta {
                        alias: item.alias,
                        starred: item.starred != 0,
                        tags_json: item.tags_json,
                    },
                )
            })
            .collect();
        self.rows.sort_by_key(|row| {
            let starred = self
                .metadata
                .get(&history_meta_key(
                    &row.source,
                    &row.session_id,
                    &row.file_path,
                ))
                .is_some_and(|meta| meta.starred);
            (!starred, Reverse(row.updated_at))
        });
    }

    fn apply_snapshots(&mut self, snapshots: Vec<cli_manager_core_db::projects::FavoriteSnapshot>) {
        for snapshot in snapshots {
            if self
                .project_path
                .as_ref()
                .is_some_and(|path| normalize_path(path) != normalize_text(&snapshot.project_key))
            {
                continue;
            }
            let key = history_meta_key(&snapshot.source, &snapshot.session_id, &snapshot.file_path);
            if !self
                .rows
                .iter()
                .any(|row| history_meta_key(&row.source, &row.session_id, &row.file_path) == key)
            {
                self.rows.push(HistoryRow {
                    session_id: snapshot.session_id.clone(),
                    source: snapshot.source.clone(),
                    project_key: snapshot.project_key.clone(),
                    title: snapshot.title.clone(),
                    file_path: PathBuf::from(&snapshot.file_path),
                    updated_at: snapshot.updated_at,
                    message_count: snapshot.message_count.max(0) as usize,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                });
            }
            if let Some(detail) = snapshot_detail(&snapshot) {
                self.snapshot_details.insert(key, detail);
            }
        }
        self.rows.sort_by_key(|row| {
            let starred = self
                .metadata
                .get(&history_meta_key(
                    &row.source,
                    &row.session_id,
                    &row.file_path,
                ))
                .is_some_and(|meta| meta.starred);
            (!starred, Reverse(row.updated_at))
        });
        if self.selected.is_none() {
            self.selected = self.rows.first().map(|row| row.session_id.clone());
        }
    }

    fn apply_delta(&mut self, delta: HistoryDelta, elapsed_ms: u128) {
        for path in delta.removed {
            self.rows.retain(|row| row.file_path != path);
        }
        for (row, detail) in delta.changed {
            if let Some(index) = self.rows.iter().position(|current| {
                current.file_path == row.file_path || current.session_id == row.session_id
            }) {
                self.rows[index] = row.clone();
            } else {
                self.rows.push(row.clone());
            }
            if self.selected.as_deref() == Some(row.session_id.as_str()) {
                self.detail = detail;
            }
        }
        self.rows.sort_by_key(|row| Reverse(row.updated_at));
        if self.selected.is_none() {
            self.selected = self.rows.first().map(|row| row.session_id.clone());
        }
        self.load = HistoryLoad::Ready;
        self.last_refresh_ms = elapsed_ms;
        self.refresh_batches = self.refresh_batches.saturating_add(1);
    }

    pub fn set_source(&mut self, source: SourceFilter) {
        self.source = source;
        self.selected = None;
        self.list_offset = 0;
    }

    pub fn set_favorite_only(&mut self, favorite_only: bool) {
        self.favorite_only = favorite_only;
        self.selected = None;
        self.list_offset = 0;
    }

    pub fn set_time_filter(&mut self, time_filter: TimeFilter) {
        self.time_filter = time_filter;
        self.selected = None;
        self.list_offset = 0;
    }

    pub fn set_query(&mut self, query: String) {
        self.query = query;
        self.list_offset = 0;
    }

    pub fn visible_rows(&self) -> Vec<&HistoryRow> {
        self.filtered_rows()
            .into_iter()
            .skip(self.list_offset)
            .take(VISIBLE_ROWS)
            .collect()
    }

    pub fn scroll_by(&mut self, delta: i32) {
        let max_offset = self.filtered_rows().len().saturating_sub(VISIBLE_ROWS);
        self.list_offset = self
            .list_offset
            .saturating_add_signed(delta as isize)
            .min(max_offset);
    }

    fn filtered_rows(&self) -> Vec<&HistoryRow> {
        let query = self.query.trim().to_ascii_lowercase();
        let cutoff = match self.time_filter {
            TimeFilter::All => None,
            TimeFilter::Recent7 => Some(7 * 24 * 60 * 60 * 1000),
            TimeFilter::Recent30 => Some(30 * 24 * 60 * 60 * 1000),
        }
        .map(|duration| {
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .saturating_sub(duration) as i64
        });
        self.rows
            .iter()
            .filter(|row| match self.source {
                SourceFilter::All => true,
                SourceFilter::Claude => row.source == "claude",
                SourceFilter::Codex => row.source == "codex",
            })
            .filter(|row| {
                !self.favorite_only
                    || self
                        .metadata
                        .get(&history_meta_key(
                            &row.source,
                            &row.session_id,
                            &row.file_path,
                        ))
                        .is_some_and(|meta| meta.starred)
            })
            .filter(|row| cutoff.is_none_or(|cutoff| row.updated_at >= cutoff))
            .filter(|row| {
                let alias = self
                    .metadata
                    .get(&history_meta_key(
                        &row.source,
                        &row.session_id,
                        &row.file_path,
                    ))
                    .map(|meta| meta.alias.as_str())
                    .unwrap_or_default();
                query.is_empty()
                    || row.title.to_ascii_lowercase().contains(&query)
                    || alias.to_ascii_lowercase().contains(&query)
                    || row.session_id.to_ascii_lowercase().contains(&query)
                    || row.project_key.to_ascii_lowercase().contains(&query)
            })
            .collect()
    }
}

pub fn open(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    shell.history_open = true;
    shell.settings_open = false;
    let Some(project_id) = shell.selected_project.clone() else {
        return;
    };
    let Some(project_path) = (match &shell.projects {
        crate::projects::ProjectLoad::Ready(loaded) => loaded
            .snapshot
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| loaded.snapshot.project_path(project).to_owned()),
        _ => None,
    }) else {
        return;
    };
    let project_path = shell.active_project_path(&project_path);
    if !shell.history.begin(project_path.clone()) {
        return;
    }
    let (generation, mut cancel) = shell.history.start_watcher();
    let runtime = shell._runtime.clone();
    let initial_path = project_path.clone();
    let initial = runtime.spawn_blocking(move || load_for_project(initial_path));
    let metadata_path = shell
        .preferences_database
        .clone()
        .or_else(|| crate::paths::database_path().ok());
    shell.history.database = metadata_path.clone();
    let metadata = runtime.spawn(async move {
        let Some(path) = metadata_path else {
            return Vec::new();
        };
        crate::projects::load_session_meta(path)
            .await
            .unwrap_or_default()
    });
    let snapshots_path = shell.history.database.clone();
    let snapshots = runtime.spawn(async move {
        let Some(path) = snapshots_path else {
            return Vec::new();
        };
        crate::projects::load_favorite_snapshots(path)
            .await
            .unwrap_or_default()
    });
    let watcher = runtime.spawn_blocking(watch_project_paths);
    cx.spawn(async move |this, cx| {
        let result = initial.await.unwrap_or_else(|error| Err(error.to_string()));
        let metadata = metadata.await.unwrap_or_default();
        let snapshots = snapshots.await.unwrap_or_default();
        let _ = this.update(cx, |this, cx| {
            if this.history.watch_generation == generation {
                this.history.finish(result);
                this.history.apply_metadata(metadata);
                this.history.apply_snapshots(snapshots);
                cx.notify();
            }
        });
        let Ok(Ok(mut watcher)) = watcher.await else { return; };
        loop {
            tokio::select! {
                _ = &mut cancel => break,
                changed = watcher.watcher.next_changed_paths() => {
                    let Ok(paths) = changed else { break; };
                    if paths.is_empty() { continue; }
                    let sources = watcher.sources.clone();
                    let project_key = normalize_path(&project_path);
                    let started = std::time::Instant::now();
                    let result = runtime.spawn_blocking(move || load_changed_rows(paths, sources, project_key)).await.unwrap_or_else(|error| Err(error.to_string()));
                    let elapsed_ms = started.elapsed().as_millis();
                    let _ = this.update(cx, |this, cx| {
                        if this.history.watch_generation == generation && this.history.project_path.as_ref() == Some(&project_path) {
                            match result {
                                Ok(delta) => this.history.apply_delta(delta, elapsed_ms),
                                Err(_) => this.history.load = HistoryLoad::Failed,
                            }
                            cx.notify();
                        }
                    });
                }
            }
        }
    }).detach();
}

pub fn toggle_star(
    shell: &mut crate::DesktopShell,
    session_id: String,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(row) = shell
        .history
        .rows
        .iter()
        .find(|row| row.session_id == session_id)
        .cloned()
    else {
        return;
    };
    let key = history_meta_key(&row.source, &row.session_id, &row.file_path);
    let previous = shell
        .history
        .metadata
        .get(&key)
        .cloned()
        .unwrap_or_default();
    let next = HistoryMeta {
        alias: previous.alias.clone(),
        starred: !previous.starred,
        tags_json: previous.tags_json.clone(),
    };
    shell.history.metadata.insert(key.clone(), next.clone());
    shell.history.rows.sort_by_key(|item| {
        let starred = shell
            .history
            .metadata
            .get(&history_meta_key(
                &item.source,
                &item.session_id,
                &item.file_path,
            ))
            .is_some_and(|meta| meta.starred);
        (!starred, Reverse(item.updated_at))
    });
    let Some(database) = shell.history.database.clone() else {
        cx.notify();
        return;
    };
    let runtime = shell._runtime.clone();
    let detail_runtime = runtime.clone();
    let detail = shell
        .history
        .detail
        .clone()
        .filter(|detail| detail.session_id == row.session_id);
    let load_row = row.clone();
    let task = runtime.spawn(async move {
        if next.starred {
            let snapshot_detail = if let Some(detail) = detail {
                Ok(detail)
            } else {
                detail_runtime
                    .spawn_blocking(move || load_detail(load_row))
                    .await
                    .map_err(|error| error.to_string())?
            }?;
            let detail_json = serde_json::json!({
                "session_id": snapshot_detail.session_id,
                "source": row.source,
                "project_key": row.project_key,
                "file_path": row.file_path.to_string_lossy(),
                "title": snapshot_detail.title,
                "messages": snapshot_detail.messages.iter().map(|message| serde_json::json!({
                    "role": message.role,
                    "content": message.content,
                    "timestamp": message.timestamp,
                })).collect::<Vec<_>>(),
            })
            .to_string();
            cli_manager_core_db::history::upsert_favorite_snapshot(
                database.clone(),
                cli_manager_core_db::history::FavoriteSnapshotPatch {
                    session_key: format!(
                        "{}:{}:{}",
                        row.source,
                        row.session_id,
                        row.file_path.to_string_lossy()
                    ),
                    session_id: row.session_id.clone(),
                    source: row.source.clone(),
                    project_key: row.project_key.clone(),
                    file_path: row.file_path.to_string_lossy().into_owned(),
                    title: snapshot_detail.title.clone(),
                    created_at: row.updated_at,
                    updated_at: row.updated_at,
                    message_count: snapshot_detail.messages.len() as i64,
                    branch: None,
                    detail_json,
                    snapshot_at: std::time::SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                        .to_string(),
                },
            )
            .await?;
        } else {
            cli_manager_core_db::history::delete_favorite_snapshot(
                database.clone(),
                format!(
                    "{}:{}:{}",
                    row.source,
                    row.session_id,
                    row.file_path.to_string_lossy()
                ),
            )
            .await?;
        }
        cli_manager_core_db::history::update_session_meta(
            database,
            cli_manager_core_db::history::SessionMetaPatch {
                session_key: format!(
                    "{}:{}:{}",
                    row.source,
                    row.session_id,
                    row.file_path.to_string_lossy()
                ),
                session_id: row.session_id,
                source: row.source,
                project_key: row.project_key,
                file_path: row.file_path.to_string_lossy().into_owned(),
                alias: next.alias,
                starred: next.starred,
                tags_json: next.tags_json,
                updated_at: std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .to_string(),
            },
        )
        .await
    });
    cx.spawn(async move |this, cx| {
        if task
            .await
            .unwrap_or_else(|error| Err(error.to_string()))
            .is_err()
        {
            let _ = this.update(cx, |this, cx| {
                this.history.metadata.insert(key, previous);
                cx.notify();
            });
        }
    })
    .detach();
    cx.notify();
}

pub fn save_alias(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    let Some(session_id) = shell.history.selected.clone() else {
        return;
    };
    let Some(row) = shell
        .history
        .rows
        .iter()
        .find(|row| row.session_id == session_id)
        .cloned()
    else {
        return;
    };
    let alias = shell
        .file_operation_editor
        .read(cx)
        .value()
        .trim()
        .to_owned();
    let key = metadata_key_for_row(&row);
    let previous = shell
        .history
        .metadata
        .get(&key)
        .cloned()
        .unwrap_or_default();
    let next = HistoryMeta {
        alias,
        starred: previous.starred,
        tags_json: previous.tags_json.clone(),
    };
    shell.history.metadata.insert(key.clone(), next.clone());
    let Some(database) = shell.history.database.clone() else {
        cx.notify();
        return;
    };
    let patch = cli_manager_core_db::history::SessionMetaPatch {
        session_key: format!(
            "{}:{}:{}",
            row.source,
            row.session_id,
            row.file_path.to_string_lossy()
        ),
        session_id: row.session_id.clone(),
        source: row.source.clone(),
        project_key: row.project_key.clone(),
        file_path: row.file_path.to_string_lossy().into_owned(),
        alias: next.alias.clone(),
        starred: next.starred,
        tags_json: next.tags_json.clone(),
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string(),
    };
    let task = shell
        ._runtime
        .spawn(cli_manager_core_db::history::update_session_meta(
            database, patch,
        ));
    cx.spawn(async move |this, cx| {
        if task
            .await
            .unwrap_or_else(|error| Err(error.to_string()))
            .is_err()
        {
            let _ = this.update(cx, |this, cx| {
                this.history.metadata.insert(key, previous);
                cx.notify();
            });
        }
    })
    .detach();
    cx.notify();
}

fn watch_project_paths() -> Result<HistoryWatch, String> {
    let mut watcher = TranscriptWatcher::new().map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    for (source, root) in history_roots() {
        collect_jsonl(&root, &mut files, source, MAX_FILES);
    }
    let mut sources = HashMap::new();
    for (source, path) in files {
        let normalized = path.canonicalize().unwrap_or(path);
        watcher
            .watch_path(&normalized)
            .map_err(|error| error.to_string())?;
        sources.insert(normalized, source);
    }
    Ok(HistoryWatch { watcher, sources })
}

fn load_changed_rows(
    paths: Vec<PathBuf>,
    sources: HashMap<PathBuf, &'static str>,
    project_key: String,
) -> Result<HistoryDelta, String> {
    let sources = sources
        .into_iter()
        .map(|(path, source)| (path.canonicalize().unwrap_or(path), source))
        .collect::<HashMap<_, _>>();
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    for path in paths {
        let path = path.canonicalize().unwrap_or(path);
        let Some(source) = sources.get(&path).copied() else {
            continue;
        };
        if let Some(row) = parse_row(source, &path, Some(Path::new(&project_key)), &project_key) {
            changed.push(row);
        } else {
            removed.push(path);
        }
    }
    Ok(HistoryDelta { changed, removed })
}

pub fn load_for_project(project_path: PathBuf) -> Result<HistoryPage, String> {
    load_for_scope(Some(project_path))
}

pub fn load_for_all_projects() -> Result<HistoryPage, String> {
    load_for_scope(None)
}

fn load_for_scope(project_path: Option<PathBuf>) -> Result<HistoryPage, String> {
    let project_key = project_path
        .as_deref()
        .map(normalize_path)
        .unwrap_or_default();
    let mut files = Vec::new();
    for (source, root) in history_roots() {
        collect_jsonl(&root, &mut files, source, MAX_FILES);
    }
    let mut parsed = parse_rows_bounded(files, project_path.as_deref(), &project_key);
    parsed.sort_by_key(|(row, _)| Reverse(row.updated_at));
    let first_detail = parsed.first().and_then(|(_, detail)| detail.clone());
    let rows = parsed.into_iter().map(|(row, _)| row).collect();
    Ok(HistoryPage { rows, first_detail })
}

fn parse_rows_bounded(
    files: Vec<(&'static str, PathBuf)>,
    project_path: Option<&Path>,
    project_key: &str,
) -> Vec<(HistoryRow, Option<HistoryDetail>)> {
    if files.is_empty() {
        return Vec::new();
    }
    let workers = scan_worker_count(files.len());
    let chunk_size = (files.len() + workers - 1) / workers;
    thread::scope(|scope| {
        let jobs = files.chunks(chunk_size).map(|chunk| {
            scope.spawn(move || {
                chunk
                    .iter()
                    .filter_map(|(source, path)| parse_row(source, path, project_path, project_key))
                    .collect::<Vec<_>>()
            })
        });
        jobs.map(|job| job.join().expect("history scan worker panicked"))
            .flatten()
            .collect()
    })
}

fn scan_worker_count(file_count: usize) -> usize {
    if file_count == 0 {
        return 1;
    }
    let cpu_count = thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1);
    worker_limit_for_cpu(cpu_count).min(file_count).max(1)
}

fn worker_limit_for_cpu(cpu_count: usize) -> usize {
    if cpu_count <= 1 {
        1
    } else {
        cpu_count / 2
    }
}

fn history_roots() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
    else {
        return Vec::new();
    };
    vec![
        ("claude", home.join(".claude").join("projects")),
        ("codex", home.join(".codex").join("sessions")),
    ]
}

fn collect_jsonl(
    root: &Path,
    output: &mut Vec<(&'static str, PathBuf)>,
    source: &'static str,
    limit: usize,
) {
    if output.len() >= limit || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if output.len() >= limit {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, output, source, limit);
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            output.push((source, path));
        }
    }
}

fn parse_row(
    source: &str,
    path: &Path,
    scope_path: Option<&Path>,
    project_key: &str,
) -> Option<(HistoryRow, Option<HistoryDetail>)> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let fallback = path.file_stem()?.to_string_lossy().into_owned();
    let detail = parse_detail(
        source,
        "local",
        &path.to_string_lossy(),
        &fallback,
        project_key,
        modified_ms(&metadata),
        modified_ms(&metadata),
        0,
        raw.lines().map(str::to_owned),
    );
    let cwd = detail.summary.cwd.as_deref().map(normalize_text);
    let project_match = scope_path.is_none()
        || cwd
            .as_deref()
            .is_some_and(|cwd| same_or_child(cwd, project_key))
        || (source == "claude"
            && path
                .parent()
                .and_then(Path::file_name)
                .map(|name| {
                    name.to_string_lossy()
                        .eq_ignore_ascii_case(&claude_project_key(project_key))
                })
                .unwrap_or(false));
    let session_id = detail.summary.session_ref.source_session_id.clone();
    let title = detail.summary.title.clone();
    project_match.then(|| {
        (
            HistoryRow {
                session_id: session_id.clone(),
                source: source.to_owned(),
                project_key: if scope_path.is_none() {
                    cwd.clone().unwrap_or_else(|| project_key.to_owned())
                } else {
                    project_key.to_owned()
                },
                title: title.clone(),
                file_path: path.to_path_buf(),
                updated_at: modified_ms(&metadata),
                message_count: detail.summary.message_count,
                input_tokens: detail.summary.usage.input_tokens,
                output_tokens: detail.summary.usage.output_tokens,
                cache_read_tokens: detail.summary.usage.cache_read_tokens,
                cache_creation_tokens: detail.summary.usage.cache_creation_tokens,
            },
            Some(HistoryDetail {
                session_id,
                title,
                messages: detail
                    .messages
                    .into_iter()
                    .map(|message| HistoryMessage {
                        role: message.role,
                        content: message.content,
                        timestamp: message.timestamp,
                    })
                    .collect(),
            }),
        )
    })
}

fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

pub fn load_detail(row: HistoryRow) -> Result<HistoryDetail, String> {
    let metadata = fs::metadata(&row.file_path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err("history_file_too_large".into());
    }
    let raw = fs::read_to_string(&row.file_path).map_err(|error| error.to_string())?;
    let fallback = row
        .file_path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| row.session_id.clone());
    let parsed = parse_detail(
        &row.source,
        "local",
        &row.file_path.to_string_lossy(),
        &fallback,
        &row.project_key,
        modified_ms(&metadata),
        modified_ms(&metadata),
        0,
        raw.lines().map(str::to_owned),
    );
    Ok(HistoryDetail {
        session_id: row.session_id,
        title: parsed.summary.title,
        messages: parsed
            .messages
            .into_iter()
            .map(|message| HistoryMessage {
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
            })
            .collect(),
    })
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn normalize_text(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn history_meta_key(source: &str, session_id: &str, file_path: impl AsRef<Path>) -> String {
    let file_path = file_path.as_ref().to_string_lossy();
    format!(
        "{}:{}:{}",
        source.to_ascii_lowercase(),
        session_id,
        normalize_text(&file_path)
    )
}

pub fn metadata_key_for_row(row: &HistoryRow) -> String {
    history_meta_key(&row.source, &row.session_id, &row.file_path)
}

fn same_or_child(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

pub fn view<'a>(
    state: &'a HistoryState,
    title: String,
    loading: String,
    empty: String,
    failed: String,
    sources: [(String, SourceFilter); 3],
    selected_color: u32,
    surface_color: u32,
    text_color: u32,
    on_select: impl Fn(String, &mut Window, &mut App) + Clone + 'static,
    on_source: impl Fn(SourceFilter, &mut Window, &mut App) + Clone + 'static,
    query_label: String,
    on_query: impl Fn(String, &mut Window, &mut App) + Clone + 'static,
    on_scroll: impl Fn(i32, &mut Window, &mut App) + Clone + 'static,
    on_toggle_star: impl Fn(String, &mut Window, &mut App) + Clone + 'static,
    favorite_label: String,
    on_favorite_filter: impl Fn(bool, &mut Window, &mut App) + Clone + 'static,
    time_filters: [(String, TimeFilter); 3],
    on_time_filter: impl Fn(TimeFilter, &mut Window, &mut App) + Clone + 'static,
    alias_editor: &Entity<EditorState>,
    alias_label: String,
    alias_save_label: String,
    on_save_alias: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> Div {
    let rows = state.visible_rows();
    let current_query = state.query.clone();
    let favorite_only = state.favorite_only;
    let body = match state.load {
        HistoryLoad::Loading => div().child(loading),
        HistoryLoad::Failed => div().child(failed),
        HistoryLoad::Empty | HistoryLoad::Ready if rows.is_empty() => div().child(empty),
        HistoryLoad::Empty | HistoryLoad::Ready => {
            let list = div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .children(rows.into_iter().map(|row| {
                    let selected = state.selected.as_deref() == Some(row.session_id.as_str());
                    let session_id = row.session_id.clone();
                    let meta = state.metadata.get(&history_meta_key(
                        &row.source,
                        &row.session_id,
                        &row.file_path,
                    ));
                    let title = meta
                        .and_then(|meta| (!meta.alias.is_empty()).then_some(meta.alias.as_str()))
                        .unwrap_or(row.title.as_str());
                    let title = title.to_owned();
                    let on_select = on_select.clone();
                    let on_toggle_star = on_toggle_star.clone();
                    let starred = meta.is_some_and(|meta| meta.starred);
                    let star_session_id = row.session_id.clone();
                    div()
                        .id(gpui::ElementId::Name(
                            format!("history-row-{}", row.session_id).into(),
                        ))
                        .p(px(8.))
                        .bg(rgb(if selected {
                            selected_color
                        } else {
                            surface_color
                        }))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_select(session_id.clone(), window, app))
                        .child(
                            div()
                                .id(gpui::ElementId::Name(
                                    format!("history-star-{}", star_session_id).into(),
                                ))
                                .cursor_pointer()
                                .on_click(move |_, window, app| {
                                    on_toggle_star(star_session_id.clone(), window, app)
                                })
                                .child(if starred { "★" } else { "☆" }),
                        )
                        .child(title)
                        .child(div().text_color(rgb(0x8c98a8)).child(format!(
                            "{} · {} · {}",
                            row.source, row.message_count, row.session_id
                        )))
                }));
            if let Some(detail) = state.detail.as_ref() {
                let on_save_alias = on_save_alias.clone();
                list.child(
                    div()
                        .mt(px(12.))
                        .child(detail.title.clone())
                        .child(alias_label)
                        .child(Editor::new(alias_editor).h(px(36.)))
                        .child(
                            div()
                                .id("history-alias-save")
                                .px(px(8.))
                                .py(px(4.))
                                .cursor_pointer()
                                .on_click(move |_, window, app| on_save_alias(window, app))
                                .child(alias_save_label),
                        )
                        .children(detail.messages.iter().take(80).map(|message| {
                            div()
                                .p(px(6.))
                                .bg(rgb(surface_color))
                                .child(format!("{}: {}", message.role, message.content))
                        })),
                )
            } else {
                list
            }
        }
    };
    let query_handler = on_query.clone();
    let scroll_handler = on_scroll.clone();
    let favorite_filter_handler = on_favorite_filter.clone();
    let time_filter_handler = on_time_filter.clone();
    let query_input =
        div()
            .id("history-query-input")
            .focusable()
            .on_key_down(move |event, window, app| {
                let key = event.keystroke.key.as_str();
                let mut next_query = current_query.clone();
                if key.eq_ignore_ascii_case("backspace") {
                    next_query.pop();
                } else if !event.keystroke.modifiers.control
                    && !event.keystroke.modifiers.alt
                    && !event.keystroke.modifiers.platform
                {
                    if let Some(text) = event.keystroke.key_char.as_deref() {
                        next_query.push_str(text);
                    } else {
                        return;
                    }
                } else {
                    return;
                }
                query_handler(next_query, window, app);
            });
    let scroll_input = move |event: &ScrollEvent, window: &mut Window, app: &mut App| {
        let lines = match event.delta {
            ScrollDelta::Lines(delta) => delta.y.round() as i32,
            ScrollDelta::Pixels(delta) => (delta.y.as_f32() / 32.0).round() as i32,
        };
        if lines != 0 {
            scroll_handler(-lines.saturating_mul(8), window, app);
        }
    };
    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .w_full()
        .h_full()
        .p(px(18.))
        .bg(rgb(surface_color))
        .text_color(rgb(text_color))
        .child(title)
        .child(
            query_input
                .px(px(8.))
                .py(px(5.))
                .bg(rgb(selected_color))
                .child(format!("{query_label}: {}", state.query)),
        )
        .child(
            div()
                .flex()
                .gap(px(6.))
                .children(sources.into_iter().map(|(label, filter)| {
                    let on_source = on_source.clone();
                    div()
                        .id(gpui::ElementId::Name(
                            format!("history-source-{filter:?}").into(),
                        ))
                        .px(px(8.))
                        .py(px(5.))
                        .bg(rgb(if state.source == filter {
                            selected_color
                        } else {
                            surface_color
                        }))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_source(filter, window, app))
                        .child(label)
                }))
                .child(
                    div()
                        .id("history-favorite-filter")
                        .px(px(8.))
                        .py(px(5.))
                        .bg(rgb(if favorite_only {
                            selected_color
                        } else {
                            surface_color
                        }))
                        .cursor_pointer()
                        .on_click(move |_, window, app| {
                            favorite_filter_handler(!favorite_only, window, app)
                        })
                        .child(favorite_label),
                )
                .children(time_filters.into_iter().map(|(label, filter)| {
                    let time_filter_handler = time_filter_handler.clone();
                    div()
                        .id(gpui::ElementId::Name(
                            format!("history-time-{filter:?}").into(),
                        ))
                        .px(px(8.))
                        .py(px(5.))
                        .bg(rgb(if state.time_filter == filter {
                            selected_color
                        } else {
                            surface_color
                        }))
                        .cursor_pointer()
                        .on_click(move |_, window, app| time_filter_handler(filter, window, app))
                        .child(label)
                })),
        )
        .child(
            div()
                .flex_1()
                .min_h(px(0.))
                .overflow_y_scrollbar()
                .on_scroll(scroll_input)
                .child(body),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(source: &str, title: &str) -> HistoryRow {
        HistoryRow {
            session_id: title.into(),
            source: source.into(),
            project_key: "p".into(),
            title: title.into(),
            file_path: PathBuf::new(),
            updated_at: 0,
            message_count: 1,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
        }
    }

    #[test]
    fn filters_source_and_query_without_mutating_rows() {
        let mut state = HistoryState {
            load: HistoryLoad::Ready,
            rows: vec![row("claude", "Alpha"), row("codex", "Beta")],
            ..Default::default()
        };
        state.set_source(SourceFilter::Claude);
        assert_eq!(state.visible_rows().len(), 1);
        state.source = SourceFilter::All;
        state.query = "beta".into();
        assert_eq!(state.visible_rows()[0].title, "Beta");
        assert_eq!(state.rows.len(), 2);
        state.query.clear();
        state.metadata.insert(
            history_meta_key("claude", "Alpha", PathBuf::new()),
            HistoryMeta {
                starred: true,
                ..Default::default()
            },
        );
        state.set_favorite_only(true);
        assert_eq!(state.visible_rows().len(), 1);
        assert_eq!(state.visible_rows()[0].session_id, "Alpha");
    }

    #[test]
    fn time_filter_keeps_recent_rows_and_excludes_old_rows() {
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut recent = row("claude", "recent");
        recent.updated_at = now;
        let mut old = row("claude", "old");
        old.updated_at = now - 31 * 24 * 60 * 60 * 1000;
        let mut state = HistoryState {
            load: HistoryLoad::Ready,
            rows: vec![recent, old],
            ..Default::default()
        };
        state.set_time_filter(TimeFilter::Recent30);
        assert_eq!(
            state
                .visible_rows()
                .iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["recent"]
        );
    }

    #[test]
    fn shared_session_metadata_overrides_title_and_promotes_starred_rows() {
        let mut state = HistoryState {
            load: HistoryLoad::Ready,
            rows: vec![row("claude", "session-1"), row("claude", "session-2")],
            ..Default::default()
        };
        state.rows[0].file_path = PathBuf::from("C:/history/one.jsonl");
        state.rows[1].file_path = PathBuf::from("C:/history/two.jsonl");
        state.apply_metadata(vec![cli_manager_core_db::projects::SessionMeta {
            session_key: "claude:session-2:C:/history/two.jsonl".into(),
            session_id: "session-2".into(),
            source: "claude".into(),
            project_key: "p".into(),
            file_path: "C:/history/two.jsonl".into(),
            alias: "Pinned".into(),
            starred: 1,
            tags_json: "[]".into(),
            updated_at: "2".into(),
        }]);
        assert_eq!(state.rows[0].session_id, "session-2");
        assert_eq!(
            state.metadata["claude:session-2:c:/history/two.jsonl"].alias,
            "Pinned"
        );
    }

    #[test]
    fn favorite_snapshot_is_available_when_source_file_is_missing() {
        let mut state = HistoryState {
            load: HistoryLoad::Ready,
            project_path: Some(PathBuf::from("C:/project")),
            ..Default::default()
        };
        state.apply_metadata(vec![cli_manager_core_db::projects::SessionMeta {
            session_key: "claude:snapshot:C:/history/missing.jsonl".into(),
            session_id: "snapshot".into(),
            source: "claude".into(),
            project_key: "c:/project".into(),
            file_path: "C:/history/missing.jsonl".into(),
            alias: "Offline favorite".into(),
            starred: 1,
            tags_json: "[]".into(),
            updated_at: "2".into(),
        }]);
        state.apply_snapshots(vec![cli_manager_core_db::projects::FavoriteSnapshot {
            session_key: "claude:snapshot:C:/history/missing.jsonl".into(),
            session_id: "snapshot".into(),
            source: "claude".into(),
            project_key: "c:/project".into(),
            file_path: "C:/history/missing.jsonl".into(),
            title: "Original title".into(),
            created_at: 1,
            updated_at: 2,
            message_count: 1,
            branch: None,
            detail_json: "{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}".into(),
            snapshot_at: "2".into(),
        }]);
        assert_eq!(state.rows.len(), 1);
        assert_eq!(state.rows[0].session_id, "snapshot");
        assert_eq!(
            state.snapshot_details["claude:snapshot:c:/history/missing.jsonl"].messages[0].content,
            "hello"
        );
    }

    #[test]
    fn history_window_scrolls_without_rendering_all_rows() {
        let mut state = HistoryState {
            load: HistoryLoad::Ready,
            rows: (0..10_000)
                .map(|index| row("claude", &format!("session-{index:03}")))
                .collect(),
            ..Default::default()
        };
        assert_eq!(state.visible_rows().len(), VISIBLE_ROWS);
        assert_eq!(state.visible_rows()[0].session_id, "session-000");
        state.scroll_by(100);
        assert_eq!(state.visible_rows()[0].session_id, "session-100");
        state.scroll_by(100_000);
        assert_eq!(state.visible_rows()[0].session_id, "session-9800");
        state.scroll_by(-100_000);
        assert_eq!(state.visible_rows()[0].session_id, "session-000");
    }

    #[test]
    fn begin_reuses_same_project_while_loading() {
        let mut state = HistoryState::default();
        assert!(state.begin(PathBuf::from("C:/project")));
        assert!(!state.begin(PathBuf::from("C:/project")));
        assert!(state.begin(PathBuf::from("C:/other")));
    }

    #[test]
    fn bounded_scan_workers_use_at_most_half_the_cpu_count() {
        assert_eq!(worker_limit_for_cpu(1), 1);
        assert_eq!(worker_limit_for_cpu(2), 1);
        assert_eq!(worker_limit_for_cpu(8), 4);
        assert_eq!(
            scan_worker_count(2),
            2.min(worker_limit_for_cpu(
                std::thread::available_parallelism()
                    .map(|count| count.get())
                    .unwrap_or(1),
            ))
        );
    }

    #[test]
    fn parses_matching_transcript_into_row_and_native_detail() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        std::fs::write(
            &path,
            r#"{"type":"user","sessionId":"session-1","cwd":"C:/project","message":{"role":"user","content":"hello"}}
{"type":"assistant","message":{"role":"assistant","content":"world"}}
"#,
        )
        .unwrap();
        let (row, detail) =
            parse_row("claude", &path, Some(Path::new("c:/project")), "c:/project").unwrap();
        assert_eq!(row.session_id, "session-1");
        let detail = detail.unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[1].content, "world");
    }

    #[test]
    fn incremental_history_delta_updates_twenty_files_within_ui_budget() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let mut sources = HashMap::new();
        let mut paths = Vec::new();
        let project_text = project.to_string_lossy().replace('\\', "/");
        for index in 0..20 {
            let path = directory.path().join(format!("session-{index}.jsonl"));
            let content = format!(
                r#"{{"type":"user","sessionId":"session-{index}","cwd":"{}","message":{{"role":"user","content":"hello"}}}}"#,
                project_text
            );
            std::fs::write(&path, format!("{content}\n")).unwrap();
            sources.insert(path.clone(), "claude");
            paths.push(path);
        }
        assert!(parse_row(
            "claude",
            &paths[0],
            Some(project.as_path()),
            &normalize_path(&project)
        )
        .is_some());
        let started = std::time::Instant::now();
        let delta = load_changed_rows(paths, sources, normalize_path(&project)).unwrap();
        assert_eq!(delta.changed.len(), 20);
        let elapsed = started.elapsed();
        eprintln!("20-file incremental transcript refresh: {elapsed:?}");
        assert!(elapsed < std::time::Duration::from_millis(300));
        let mut state = HistoryState {
            load: HistoryLoad::Ready,
            ..Default::default()
        };
        state.apply_delta(delta, elapsed.as_millis());
        assert!(state.last_refresh_ms < 300);
        assert_eq!(state.refresh_batches, 1);
        assert_eq!(state.rows.len(), 20);
        assert!(state.selected.is_some());
    }
}
