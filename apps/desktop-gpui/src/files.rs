use gpui::{div, prelude::*, px, rgb};
use gpui_component::input::{Editor, EditorState};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[path = "files_watcher.rs"]
mod files_watcher;
pub use files_watcher::start_file_watcher;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub relative_path: String,
    pub directory: bool,
    pub depth: usize,
    pub expanded: bool,
    pub loaded: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileTreeState {
    Empty,
    Loading {
        project_id: String,
    },
    Ready {
        project_id: String,
        root: PathBuf,
        entries: Vec<FileEntry>,
    },
    Failed {
        project_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreviewState {
    Empty,
    Loading {
        relative_path: String,
    },
    Ready {
        relative_path: String,
        content: String,
    },
    External {
        relative_path: String,
    },
    Failed {
        relative_path: String,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveState {
    Idle,
    Saving,
    Saved,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileOperation {
    CreateFile,
    CreateDirectory,
    Rename { source: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileTab {
    pub relative_path: String,
    pub content: String,
    pub saved_content: String,
    pub dirty: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseTabDecision {
    Closed,
    NeedsSave,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseTabGroup {
    Others,
    Left,
    Right,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileTabs {
    tabs: Vec<FileTab>,
    active_path: Option<String>,
}

impl FileTabs {
    pub fn open(&mut self, relative_path: String, content: String) {
        if self
            .tabs
            .iter()
            .all(|tab| tab.relative_path != relative_path)
        {
            self.tabs.push(FileTab {
                relative_path: relative_path.clone(),
                saved_content: content.clone(),
                content,
                dirty: false,
            });
        }
        self.active_path = Some(relative_path);
    }

    pub fn active_path(&self) -> Option<&str> {
        self.active_path.as_deref()
    }

    pub fn tabs(&self) -> &[FileTab] {
        &self.tabs
    }

    pub fn active(&self) -> Option<&FileTab> {
        self.active_path
            .as_deref()
            .and_then(|path| self.tabs.iter().find(|tab| tab.relative_path == path))
    }

    pub fn get(&self, path: &str) -> Option<&FileTab> {
        self.tabs.iter().find(|tab| tab.relative_path == path)
    }

    pub fn select(&mut self, relative_path: &str) -> bool {
        if self
            .tabs
            .iter()
            .any(|tab| tab.relative_path == relative_path)
        {
            self.active_path = Some(relative_path.to_owned());
            true
        } else {
            false
        }
    }

    pub fn update_content(&mut self, relative_path: &str, content: String) -> bool {
        let Some(tab) = self
            .tabs
            .iter_mut()
            .find(|tab| tab.relative_path == relative_path)
        else {
            return false;
        };
        tab.dirty = tab.saved_content != content;
        tab.content = content;
        true
    }

    pub fn mark_saved(&mut self, relative_path: &str, content: String) -> bool {
        let Some(tab) = self
            .tabs
            .iter_mut()
            .find(|tab| tab.relative_path == relative_path)
        else {
            return false;
        };
        tab.content = content;
        tab.dirty = false;
        true
    }

    pub fn close(&mut self, relative_path: &str, force: bool) -> CloseTabDecision {
        let Some(index) = self
            .tabs
            .iter()
            .position(|tab| tab.relative_path == relative_path)
        else {
            return CloseTabDecision::Missing;
        };
        if self.tabs[index].dirty && !force {
            return CloseTabDecision::NeedsSave;
        }
        self.tabs.remove(index);
        if self.active_path.as_deref() == Some(relative_path) {
            self.active_path = self
                .tabs
                .get(index.min(self.tabs.len().saturating_sub(1)))
                .map(|tab| tab.relative_path.clone());
        }
        CloseTabDecision::Closed
    }

    pub fn group_paths(&self, group: CloseTabGroup) -> Vec<String> {
        let Some(active_index) = self
            .active_path
            .as_deref()
            .and_then(|path| self.tabs.iter().position(|tab| tab.relative_path == path))
        else {
            return Vec::new();
        };
        self.tabs
            .iter()
            .enumerate()
            .filter_map(|(index, tab)| {
                let selected = match group {
                    CloseTabGroup::Others => index != active_index,
                    CloseTabGroup::Left => index < active_index,
                    CloseTabGroup::Right => index > active_index,
                };
                selected.then(|| tab.relative_path.clone())
            })
            .collect()
    }

    pub fn close_many(&mut self, paths: &[String], force: bool) -> CloseTabDecision {
        if paths.is_empty() {
            return CloseTabDecision::Missing;
        }
        if !force
            && paths
                .iter()
                .any(|path| self.get(path).is_some_and(|tab| tab.dirty))
        {
            return CloseTabDecision::NeedsSave;
        }
        let active_index = self
            .active_path
            .as_deref()
            .and_then(|path| self.tabs.iter().position(|tab| tab.relative_path == path));
        let active_removed = self
            .active_path
            .as_deref()
            .is_some_and(|path| paths.iter().any(|candidate| candidate == path));
        let original_len = self.tabs.len();
        self.tabs
            .retain(|tab| !paths.iter().any(|path| path == &tab.relative_path));
        if self.tabs.len() == original_len {
            return CloseTabDecision::Missing;
        }
        if active_removed {
            self.active_path = active_index.and_then(|index| {
                self.tabs
                    .get(index.min(self.tabs.len().saturating_sub(1)))
                    .map(|tab| tab.relative_path.clone())
            });
        }
        CloseTabDecision::Closed
    }
}

const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

pub enum ToggleDirectory {
    Changed,
    Load {
        project_id: String,
        root: PathBuf,
        path: String,
        depth: usize,
    },
}

impl Default for FileTreeState {
    fn default() -> Self {
        Self::Empty
    }
}

pub fn load_root(path: PathBuf) -> Result<Vec<FileEntry>, String> {
    let rules = IgnoreRules::read(&path);
    load_directory_with_rules(&path, "", 0, &rules)
}

pub async fn load_root_async(path: PathBuf) -> (PathBuf, Result<Vec<FileEntry>, String>) {
    let root = path.clone();
    let result = tokio::task::spawn_blocking(move || load_root(path))
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    (root, result)
}

pub fn read_text(root: &Path, relative_path: &str) -> Result<String, String> {
    let path = safe_path(root, relative_path)?;
    if !path.is_file() {
        return Err("file_not_found".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("file_too_large".into());
    }
    String::from_utf8(std::fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|_| "binary_file".into())
}

pub fn write_text(root: &Path, relative_path: &str, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("file_too_large".into());
    }
    let path = safe_path(root, relative_path)?;
    if path.exists() && !path.is_file() {
        return Err("file_not_found".into());
    }
    std::fs::write(path, content).map_err(|error| error.to_string())
}

pub async fn write_text_async(
    root: PathBuf,
    relative_path: String,
    content: String,
) -> (String, Result<(), String>) {
    let expected = relative_path.clone();
    let result = tokio::task::spawn_blocking(move || write_text(&root, &relative_path, &content))
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    (expected, result)
}

pub async fn run_operation_async(
    root: PathBuf,
    operation: FileOperation,
    input: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match operation {
        FileOperation::CreateFile => create_file(&root, &input).map(|_| ()),
        FileOperation::CreateDirectory => create_directory(&root, &input).map(|_| ()),
        FileOperation::Rename { source } => rename(&root, &source, &input).map(|_| ()),
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()))
}

pub async fn delete_async(root: PathBuf, relative_path: String) -> (String, Result<(), String>) {
    let expected = relative_path.clone();
    let result = tokio::task::spawn_blocking(move || delete(&root, &relative_path))
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    (expected, result)
}

pub async fn read_text_async(
    root: PathBuf,
    relative_path: String,
) -> (String, Result<String, String>) {
    let expected = relative_path.clone();
    let result = tokio::task::spawn_blocking(move || read_text(&root, &relative_path))
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    (expected, result)
}

pub fn finish_preview(
    state: &mut PreviewState,
    expected_path: &str,
    result: Result<String, String>,
) -> bool {
    if !matches!(state, PreviewState::Loading { relative_path } if relative_path == expected_path) {
        return false;
    }
    *state = match result {
        Ok(content) => PreviewState::Ready {
            relative_path: expected_path.to_owned(),
            content,
        },
        Err(reason) => PreviewState::Failed {
            relative_path: expected_path.to_owned(),
            reason,
        },
    };
    true
}

pub fn finish_root_load(
    state: &mut FileTreeState,
    selected_project: Option<&str>,
    project_id: &str,
    root: PathBuf,
    result: Result<Vec<FileEntry>, String>,
) -> bool {
    if selected_project != Some(project_id) {
        return false;
    }
    *state = match result {
        Ok(entries) => FileTreeState::Ready {
            project_id: project_id.to_owned(),
            root,
            entries,
        },
        Err(_) => FileTreeState::Failed {
            project_id: project_id.to_owned(),
        },
    };
    true
}

pub fn load_directory_with_root(
    path: &Path,
    parent: &str,
    depth: usize,
    root: &Path,
) -> Result<Vec<FileEntry>, String> {
    let rules = IgnoreRules::read(root);
    load_directory_with_rules(path, parent, depth, &rules)
}

pub fn create_file(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let path = safe_path(root, relative_path)?;
    if path.exists() {
        return Err("file_already_exists".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::File::create(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub fn create_directory(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let path = safe_path(root, relative_path)?;
    if path.exists() {
        return Err("path_already_exists".into());
    }
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<PathBuf, String> {
    let source = safe_path(root, from)?;
    let target = safe_path(root, to)?;
    if !source.exists() {
        return Err("source_not_found".into());
    }
    if target.exists() {
        return Err("target_already_exists".into());
    }
    std::fs::rename(&source, &target).map_err(|error| error.to_string())?;
    Ok(target)
}

pub fn delete(root: &Path, relative_path: &str) -> Result<(), String> {
    let path = safe_path(root, relative_path)?;
    if relative_path.is_empty() || relative_path == ".git" || relative_path.starts_with(".git/") {
        return Err("protected_path".into());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        std::fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn safe_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("invalid_relative_path".into());
    }
    if relative
        .components()
        .any(|component| component.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err("protected_path".into());
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let candidate = canonical_root.join(relative);
    let mut existing = candidate.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or("invalid_relative_path")?;
    }
    let existing_parent = existing.canonicalize().map_err(|error| error.to_string())?;
    if !existing_parent.starts_with(&canonical_root) {
        return Err("path_outside_project".into());
    }
    Ok(candidate)
}

fn load_directory_with_rules(
    path: &Path,
    parent: &str,
    depth: usize,
    rules: &IgnoreRules,
) -> Result<Vec<FileEntry>, String> {
    let mut entries = std::fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if (name.starts_with('.') && name != ".gitignore") || name.eq_ignore_ascii_case(".git")
            {
                return None;
            }
            let directory = entry.file_type().ok()?.is_dir();
            let relative_path = if parent.is_empty() {
                name.clone()
            } else {
                format!("{parent}/{name}")
            };
            if name != ".gitignore" && rules.ignores(&relative_path, directory) {
                return None;
            }
            Some(FileEntry {
                relative_path,
                name,
                directory,
                depth,
                expanded: false,
                loaded: false,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .directory
            .cmp(&left.directory)
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

#[derive(Default)]
struct IgnoreRules(Vec<IgnoreRule>);

struct IgnoreRule {
    pattern: String,
    negated: bool,
    directory_only: bool,
}

impl IgnoreRules {
    fn read(root: &Path) -> Self {
        let Ok(contents) = std::fs::read_to_string(root.join(".gitignore")) else {
            return Self::default();
        };
        Self(contents.lines().filter_map(IgnoreRule::parse).collect())
    }

    fn ignores(&self, relative_path: &str, directory: bool) -> bool {
        let mut ignored = false;
        for rule in &self.0 {
            if rule.directory_only && !directory {
                continue;
            }
            if rule.matches(relative_path) {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

impl IgnoreRule {
    fn parse(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let negated = line.starts_with('!');
        let pattern = line
            .trim_start_matches('!')
            .trim_end_matches('/')
            .trim_start_matches('/');
        (!pattern.is_empty()).then_some(Self {
            pattern: pattern.to_owned(),
            negated,
            directory_only: line.ends_with('/'),
        })
    }

    fn matches(&self, relative_path: &str) -> bool {
        wildcard_match(&self.pattern, relative_path)
            || (!self.pattern.contains('/')
                && relative_path
                    .split('/')
                    .any(|part| wildcard_match(&self.pattern, part)))
    }
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let mut table = vec![vec![false; value.len() + 1]; pattern.len() + 1];
    table[0][0] = true;
    for index in 0..pattern.len() {
        for offset in 0..=value.len() {
            if !table[index][offset] {
                continue;
            }
            if pattern[index] == b'*' {
                table[index + 1][offset] = true;
                if offset < value.len() {
                    table[index][offset + 1] = true;
                }
            } else if offset < value.len()
                && (pattern[index] == b'?' || pattern[index] == value[offset])
            {
                table[index + 1][offset + 1] = true;
            }
        }
    }
    table[pattern.len()][value.len()]
}

pub fn toggle_directory(
    state: &mut FileTreeState,
    loading: &mut HashSet<String>,
    relative_path: &str,
) -> Option<ToggleDirectory> {
    let (project_id, root, index, depth, loaded, directory) = match state {
        FileTreeState::Ready {
            project_id,
            root,
            entries,
        } => {
            let (index, entry) = entries
                .iter()
                .enumerate()
                .find(|(_, entry)| entry.relative_path == relative_path)?;
            (
                project_id.clone(),
                root.clone(),
                index,
                entry.depth,
                entry.loaded,
                entry.directory,
            )
        }
        _ => return None,
    };
    if !directory {
        return None;
    }
    if loaded {
        if let FileTreeState::Ready { entries, .. } = state {
            entries[index].expanded = !entries[index].expanded;
        }
        return Some(ToggleDirectory::Changed);
    }
    if !loading.insert(relative_path.to_owned()) {
        return None;
    }
    Some(ToggleDirectory::Load {
        project_id,
        root,
        path: relative_path.to_owned(),
        depth,
    })
}

pub fn finish_directory_load(
    state: &mut FileTreeState,
    loading: &mut HashSet<String>,
    project_id: &str,
    relative_path: &str,
    result: Result<Vec<FileEntry>, String>,
) -> bool {
    loading.remove(relative_path);
    let FileTreeState::Ready {
        project_id: current_project,
        entries,
        ..
    } = state
    else {
        return false;
    };
    if current_project != project_id {
        return false;
    }
    let Some(index) = entries
        .iter()
        .position(|entry| entry.relative_path == relative_path)
    else {
        return false;
    };
    if let Ok(children) = result {
        let insert_at = index + 1;
        entries.splice(insert_at..insert_at, children);
        entries[index].loaded = true;
        entries[index].expanded = true;
    }
    true
}

pub fn view<F, G>(
    state: &FileTreeState,
    raised: u32,
    title: String,
    loading: String,
    empty: String,
    failed: String,
    on_directory: F,
    on_file: G,
) -> impl IntoElement
where
    F: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
{
    let on_directory = Arc::new(on_directory);
    let on_file = Arc::new(on_file);
    let body = match state {
        FileTreeState::Empty => div().child(empty),
        FileTreeState::Loading { .. } => div().child(loading),
        FileTreeState::Failed { .. } => div().child(failed),
        FileTreeState::Ready { entries, .. } => {
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .children(visible_entries(entries).map(|entry| {
                    let marker = if entry.directory && entry.expanded {
                        "▾ "
                    } else if entry.directory {
                        "▸ "
                    } else {
                        "  "
                    };
                    let item = div()
                        .id(gpui::ElementId::Name(
                            format!("file-{}", entry.relative_path).into(),
                        ))
                        .px(px(8.))
                        .py(px(4.))
                        .bg(rgb(raised));
                    let text = format!("{}{}{}", "  ".repeat(entry.depth), marker, entry.name);
                    if entry.directory {
                        let callback = on_directory.clone();
                        let path = entry.relative_path.clone();
                        item.cursor_pointer()
                            .on_click(move |_, window, app| callback(path.clone(), window, app))
                            .child(text)
                    } else {
                        let callback = on_file.clone();
                        let path = entry.relative_path.clone();
                        item.cursor_pointer()
                            .on_click(move |_, window, app| callback(path.clone(), window, app))
                            .child(text)
                    }
                }))
        }
    };
    div().flex().flex_col().gap(px(5.)).child(title).child(body)
}

pub fn file_actions<F, G, H>(
    new_file: String,
    new_directory: String,
    rename: String,
    on_new_file: F,
    on_new_directory: G,
    on_rename: H,
) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    H: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
{
    div()
        .flex()
        .gap(px(5.))
        .child(
            div()
                .id("file-new-file")
                .px(px(6.))
                .py(px(3.))
                .cursor_pointer()
                .on_click(move |_, window, app| on_new_file(window, app))
                .child(new_file),
        )
        .child(
            div()
                .id("file-new-directory")
                .px(px(6.))
                .py(px(3.))
                .cursor_pointer()
                .on_click(move |_, window, app| on_new_directory(window, app))
                .child(new_directory),
        )
        .child(
            div()
                .id("file-rename")
                .px(px(6.))
                .py(px(3.))
                .cursor_pointer()
                .on_click(move |_, window, app| on_rename(window, app))
                .child(rename),
        )
}

pub fn operation_prompt<F, G>(
    operation: Option<&FileOperation>,
    input: &gpui::Entity<EditorState>,
    title: String,
    confirm: String,
    cancel: String,
    error: Option<&str>,
    on_confirm: F,
    on_cancel: G,
) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
{
    let Some(operation) = operation else {
        return div();
    };
    let detail = match operation {
        FileOperation::CreateFile => title,
        FileOperation::CreateDirectory => title,
        FileOperation::Rename { source } => format!("{title}: {source}"),
    };
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .bg(rgb(0x252c36))
        .px(px(8.))
        .py(px(8.))
        .child(detail)
        .child(Editor::new(input).h(px(36.)))
        .when_some(error.map(str::to_owned), |element, error| {
            element.child(error)
        })
        .child(
            div()
                .flex()
                .gap(px(6.))
                .child(
                    div()
                        .id("file-operation-confirm")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_confirm(window, app))
                        .child(confirm),
                )
                .child(
                    div()
                        .id("file-operation-cancel")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_cancel(window, app))
                        .child(cancel),
                ),
        )
}

pub fn preview_view(
    state: &PreviewState,
    raised: u32,
    title: String,
    loading: String,
    failed: String,
    pdf_fallback: String,
    open_external: String,
    on_open_external: impl Fn(&mut gpui::Window, &mut gpui::App) + 'static,
) -> impl IntoElement {
    let open_external_handler = Arc::new(on_open_external);
    let body = match state {
        PreviewState::Empty => div(),
        PreviewState::Loading { relative_path } => {
            div().child(format!("{loading}: {relative_path}"))
        }
        PreviewState::Ready {
            relative_path,
            content,
        } => {
            let extension = Path::new(relative_path)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let body = if crate::preview::is_markdown(relative_path) {
                crate::preview::view(content, raised).into_any_element()
            } else if matches!(extension.as_str(), "html" | "htm") {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .bg(rgb(raised))
                    .px(px(8.))
                    .py(px(6.))
                    .child(content.clone())
                    .child({
                        let callback = open_external_handler.clone();
                        div()
                            .id("file-preview-open-html-external")
                            .px(px(8.))
                            .py(px(4.))
                            .cursor_pointer()
                            .on_click(move |_, window, app| callback(window, app))
                            .child(open_external.clone())
                    })
                    .into_any_element()
            } else if extension == "pdf" {
                let callback = open_external_handler.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .bg(rgb(raised))
                    .px(px(8.))
                    .py(px(6.))
                    .child(pdf_fallback)
                    .child(
                        div()
                            .id("file-preview-open-external")
                            .px(px(8.))
                            .py(px(4.))
                            .cursor_pointer()
                            .on_click(move |_, window, app| callback(window, app))
                            .child(open_external),
                    )
                    .into_any_element()
            } else {
                div()
                    .child(relative_path.clone())
                    .bg(rgb(raised))
                    .into_any_element()
            };
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(relative_path.clone())
                .child(body)
        }
        PreviewState::External { relative_path } => {
            let callback = open_external_handler.clone();
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(relative_path.clone())
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .bg(rgb(raised))
                        .px(px(8.))
                        .py(px(6.))
                        .child(pdf_fallback)
                        .child(
                            div()
                                .id("file-preview-open-external")
                                .px(px(8.))
                                .py(px(4.))
                                .cursor_pointer()
                                .on_click(move |_, window, app| callback(window, app))
                                .child(open_external),
                        ),
                )
        }
        PreviewState::Failed {
            relative_path,
            reason,
        } => div().child(format!("{failed}: {relative_path} ({reason})")),
    };
    div().flex().flex_col().gap(px(5.)).child(title).child(body)
}

pub fn open_external_preview(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(root) = (match &shell.file_tree {
        FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let Some(relative_path) = (match &shell.file_preview {
        PreviewState::Ready { relative_path, .. } | PreviewState::External { relative_path } => {
            Some(relative_path.clone())
        }
        _ => None,
    }) else {
        return;
    };
    if !supports_external_preview(&relative_path) {
        return;
    }
    let path = root.join(relative_path);
    let task = shell
        ._runtime
        .spawn(tokio::task::spawn_blocking(move || open_default(path)));
    cx.spawn(async move |this, cx| {
        let _ = task.await;
        let _ = this.update(cx, |_, cx| cx.notify());
    })
    .detach();
}

fn supports_external_preview(relative_path: &str) -> bool {
    matches!(
        Path::new(relative_path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "pdf" | "html" | "htm"
    )
}

pub fn open_file(
    shell: &mut crate::DesktopShell,
    relative_path: String,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(root) = (match &shell.file_tree {
        FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    shell.file_preview = PreviewState::Loading {
        relative_path: relative_path.clone(),
    };
    shell.file_save_state = SaveState::Idle;
    if Path::new(&relative_path)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        shell.file_preview = PreviewState::External { relative_path };
        let preview_path = match &shell.file_preview {
            PreviewState::External { relative_path } => relative_path.clone(),
            _ => unreachable!(),
        };
        shell.start_preview_host(&preview_path, "", window);
        cx.notify();
        return;
    }
    let task = shell
        ._runtime
        .spawn(read_text_async(root, relative_path.clone()));
    let entity = cx.entity();
    window
        .spawn(cx, async move |cx| {
            let (path, result) = task
                .await
                .unwrap_or_else(|error| (relative_path.clone(), Err(error.to_string())));
            let _ = cx.update(|window, cx| {
                let _ = entity.update(cx, |this, cx| {
                    if finish_preview(&mut this.file_preview, &path, result) {
                        let content = match &this.file_preview {
                            PreviewState::Ready { content, .. } => Some(content.clone()),
                            _ => None,
                        };
                        if let Some(content) = content {
                            this.start_preview_host(&path, &content, window);
                            this.file_tabs.open(path.clone(), content.clone());
                            this.file_editor
                                .update(cx, |editor, cx| editor.set_value(content, window, cx));
                        }
                        cx.notify();
                    }
                });
            });
        })
        .detach();
}

fn open_default(path: PathBuf) -> Result<(), String> {
    if !path.is_file() {
        return Err("preview_file_missing".into());
    }
    #[cfg(windows)]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", &path.to_string_lossy()])
        .status();
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&path).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(&path).status();
    status
        .map_err(|error| error.to_string())
        .and_then(|status| {
            status
                .success()
                .then_some(())
                .ok_or_else(|| "preview_external_open_failed".into())
        })
}

pub fn editor_toolbar<F>(
    dirty: bool,
    state: &SaveState,
    save_label: String,
    dirty_label: String,
    saved_label: String,
    saving_label: String,
    failed_label: String,
    on_save: F,
) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
{
    let status = match state {
        SaveState::Saving => saving_label,
        SaveState::Saved => saved_label,
        SaveState::Failed => failed_label,
        SaveState::Idle if dirty => dirty_label,
        SaveState::Idle => String::new(),
    };
    let button = div()
        .id("file-editor-save")
        .px(px(8.))
        .py(px(4.))
        .bg(rgb(0x30425c))
        .cursor_pointer()
        .when(!dirty || matches!(state, SaveState::Saving), |element| {
            element.opacity(0.55)
        })
        .on_click(move |_, window, app| on_save(window, app))
        .child(save_label);
    div().flex().gap(px(8.)).child(button).child(status)
}

pub fn delete_button<F>(label: String, on_delete: F) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
{
    div()
        .id("file-editor-delete")
        .px(px(8.))
        .py(px(4.))
        .bg(rgb(0x6a3038))
        .cursor_pointer()
        .on_click(move |_, window, app| on_delete(window, app))
        .child(label)
}

pub fn tabs_view<F, G, H>(
    tabs: &FileTabs,
    raised: u32,
    close_others: String,
    close_left: String,
    close_right: String,
    on_select: F,
    on_close: G,
    on_group: H,
) -> impl IntoElement
where
    F: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
    H: Fn(CloseTabGroup, &mut gpui::Window, &mut gpui::App) + 'static,
{
    let on_select = Arc::new(on_select);
    let on_close = Arc::new(on_close);
    let on_group = Arc::new(on_group);
    let group_button = |id: &'static str, label: String, group: CloseTabGroup, callback: Arc<H>| {
        div()
            .id(id)
            .px(px(6.))
            .py(px(4.))
            .cursor_pointer()
            .on_click(move |_, window, app| callback(group, window, app))
            .child(label)
    };
    div()
        .flex()
        .gap(px(4.))
        .children(tabs.tabs().iter().map(|tab| {
            let path = tab.relative_path.clone();
            let select_path = path.clone();
            let close_path = path.clone();
            let select = on_select.clone();
            let close = on_close.clone();
            div()
                .id(gpui::ElementId::Name(format!("file-tab-{}", path).into()))
                .px(px(8.))
                .py(px(4.))
                .bg(rgb(if tabs.active_path() == Some(path.as_str()) {
                    raised
                } else {
                    0x1a2029
                }))
                .cursor_pointer()
                .on_click(move |_, window, app| select(select_path.clone(), window, app))
                .child(format!(
                    "{}{}",
                    tab.dirty.then_some("● ").unwrap_or(""),
                    tab.relative_path
                ))
                .on_mouse_down(gpui::MouseButton::Middle, move |_, window, app| {
                    close(close_path.clone(), window, app)
                })
        }))
        .child(group_button(
            "file-tabs-close-others",
            close_others,
            CloseTabGroup::Others,
            on_group.clone(),
        ))
        .child(group_button(
            "file-tabs-close-left",
            close_left,
            CloseTabGroup::Left,
            on_group.clone(),
        ))
        .child(group_button(
            "file-tabs-close-right",
            close_right,
            CloseTabGroup::Right,
            on_group,
        ))
}

fn show_active_tab(
    shell: &mut crate::DesktopShell,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    if let Some(tab) = shell.file_tabs.active().cloned() {
        shell.file_preview = PreviewState::Ready {
            relative_path: tab.relative_path,
            content: tab.saved_content,
        };
        shell
            .file_editor
            .update(cx, |editor, cx| editor.set_value(tab.content, window, cx));
    } else {
        shell.file_preview = PreviewState::Empty;
    }
    shell.file_save_state = SaveState::Idle;
    cx.notify();
}

pub fn select_tab(
    shell: &mut crate::DesktopShell,
    path: String,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    sync_tab(shell, cx);
    if !shell.file_tabs.select(&path) {
        return;
    }
    show_active_tab(shell, window, cx);
}

pub fn close_tab(
    shell: &mut crate::DesktopShell,
    path: String,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    sync_tab(shell, cx);
    shell.file_close_group_pending = None;
    match shell.file_tabs.close(&path, false) {
        CloseTabDecision::Closed => show_active_tab(shell, window, cx),
        CloseTabDecision::NeedsSave => {
            shell.file_close_prompt = Some(path);
            cx.notify();
        }
        CloseTabDecision::Missing => {}
    }
}

fn continue_group_close(
    shell: &mut crate::DesktopShell,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(paths) = shell.file_close_group_pending.take() else {
        show_active_tab(shell, window, cx);
        return;
    };
    let remaining = paths
        .into_iter()
        .filter(|path| shell.file_tabs.get(path).is_some())
        .collect::<Vec<_>>();
    match shell.file_tabs.close_many(&remaining, false) {
        CloseTabDecision::Closed => show_active_tab(shell, window, cx),
        CloseTabDecision::NeedsSave => {
            shell.file_close_group_pending = Some(remaining.clone());
            shell.file_close_prompt = remaining
                .into_iter()
                .find(|path| shell.file_tabs.get(path).is_some_and(|tab| tab.dirty));
            cx.notify();
        }
        CloseTabDecision::Missing => show_active_tab(shell, window, cx),
    }
}

pub fn close_group(
    shell: &mut crate::DesktopShell,
    group: CloseTabGroup,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    sync_tab(shell, cx);
    let paths = shell.file_tabs.group_paths(group);
    shell.file_close_group_pending = Some(paths);
    continue_group_close(shell, window, cx);
}

pub fn discard_close(
    shell: &mut crate::DesktopShell,
    path: String,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    sync_tab(shell, cx);
    if shell.file_tabs.close(&path, true) == CloseTabDecision::Closed {
        shell.file_close_prompt = None;
        continue_group_close(shell, window, cx);
    }
}

pub fn cancel_close(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    shell.file_close_prompt = None;
    shell.file_close_group_pending = None;
    cx.notify();
}

pub fn request_delete(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    if let PreviewState::Ready { relative_path, .. } = &shell.file_preview {
        shell.file_delete_prompt = Some(relative_path.clone());
        cx.notify();
    }
}

pub fn cancel_delete(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    shell.file_delete_prompt = None;
    cx.notify();
}

pub fn confirm_delete(
    shell: &mut crate::DesktopShell,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(path) = shell.file_delete_prompt.clone() else {
        return;
    };
    let Some(root) = (match &shell.file_tree {
        FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    shell.file_save_state = SaveState::Saving;
    let task = shell._runtime.spawn(delete_async(root, path));
    let entity = cx.entity();
    window
        .spawn(cx, async move |cx| {
            let (deleted_path, result) = task
                .await
                .unwrap_or_else(|error| (String::new(), Err(error.to_string())));
            let _ = cx.update(|_, cx| {
                let _ = entity.update(cx, |this, cx| {
                    if result.is_ok() {
                        this.file_tabs.close(&deleted_path, true);
                        this.file_delete_prompt = None;
                        this.file_preview = PreviewState::Empty;
                        this.file_save_state = SaveState::Idle;
                        refresh_tree(this, cx);
                    } else {
                        this.file_save_state = SaveState::Failed;
                        cx.notify();
                    }
                });
            });
        })
        .detach();
}

pub fn refresh_tree(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    let FileTreeState::Ready {
        project_id, root, ..
    } = &shell.file_tree
    else {
        return;
    };
    let expected_project = project_id.clone();
    let task = shell._runtime.spawn(load_root_async(root.clone()));
    cx.spawn(async move |this, cx| {
        let (root, result) = task
            .await
            .unwrap_or_else(|error| (PathBuf::new(), Err(error.to_string())));
        let _ = this.update(cx, |this, cx| {
            if finish_root_load(
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

pub fn begin_operation(
    shell: &mut crate::DesktopShell,
    operation: FileOperation,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    shell
        .file_operation_editor
        .update(cx, |editor, cx| editor.set_value("", window, cx));
    shell.file_operation_prompt = Some(operation);
    shell.file_operation_error = None;
    cx.notify();
}

pub fn begin_rename(
    shell: &mut crate::DesktopShell,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let PreviewState::Ready { relative_path, .. } = shell.file_preview.clone() else {
        return;
    };
    begin_operation(
        shell,
        FileOperation::Rename {
            source: relative_path,
        },
        window,
        cx,
    );
}

pub fn cancel_operation(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    shell.file_operation_prompt = None;
    shell.file_operation_error = None;
    cx.notify();
}

pub fn confirm_operation(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(operation) = shell.file_operation_prompt.clone() else {
        return;
    };
    let input = shell
        .file_operation_editor
        .read(cx)
        .value()
        .trim()
        .to_owned();
    if input.is_empty() {
        shell.file_operation_error = Some(shell.message("shell.files.operationEmpty"));
        cx.notify();
        return;
    }
    let Some(root) = (match &shell.file_tree {
        FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let Some(project_id) = shell.selected_project.clone() else {
        return;
    };
    shell.file_save_state = SaveState::Saving;
    let task = shell
        ._runtime
        .spawn(run_operation_async(root, operation, input));
    cx.spawn(async move |this, cx| {
        let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
        let _ = this.update(cx, |this, cx| {
            if this.selected_project.as_deref() != Some(project_id.as_str()) {
                return;
            }
            match result {
                Ok(()) => {
                    this.file_operation_prompt = None;
                    this.file_operation_error = None;
                    this.file_save_state = SaveState::Idle;
                    refresh_tree(this, cx);
                }
                Err(error) => {
                    this.file_operation_error = Some(error);
                    this.file_save_state = SaveState::Failed;
                    cx.notify();
                }
            }
        });
    })
    .detach();
}

pub fn delete_prompt_view<F, G>(
    path: Option<&str>,
    title: String,
    message: String,
    delete_label: String,
    cancel_label: String,
    on_delete: F,
    on_cancel: G,
) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
{
    let path = path.unwrap_or_default();
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .bg(rgb(0x252c36))
        .px(px(8.))
        .py(px(8.))
        .child(title)
        .child(format!("{message}: {path}"))
        .child(
            div()
                .flex()
                .gap(px(6.))
                .child(
                    div()
                        .id("file-delete-confirm")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_delete(window, app))
                        .child(delete_label),
                )
                .child(
                    div()
                        .id("file-delete-cancel")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_cancel(window, app))
                        .child(cancel_label),
                ),
        )
}

pub fn save_and_close(
    shell: &mut crate::DesktopShell,
    path: String,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    sync_tab(shell, cx);
    let (root, content) = match (&shell.file_tree, shell.file_tabs.get(&path)) {
        (crate::files::FileTreeState::Ready { root, .. }, Some(tab)) => {
            (root.clone(), tab.content.clone())
        }
        _ => return,
    };
    if shell.file_save_state == SaveState::Saving {
        return;
    }
    shell.file_save_state = SaveState::Saving;
    let task = shell
        ._runtime
        .spawn(write_text_async(root, path.clone(), content.clone()));
    let entity = cx.entity();
    window
        .spawn(cx, async move |cx| {
            let (saved_path, result) = task
                .await
                .unwrap_or_else(|error| (path.clone(), Err(error.to_string())));
            let _ = cx.update(|window, cx| {
                let _ = entity.update(cx, |this, cx| {
                    if result.is_ok() {
                        this.file_tabs.mark_saved(&saved_path, content.clone());
                        this.file_save_state = SaveState::Saved;
                        this.file_close_prompt = None;
                        if this.file_tabs.close(&saved_path, true) == CloseTabDecision::Closed {
                            continue_group_close(this, window, cx);
                        }
                    } else {
                        this.file_save_state = SaveState::Failed;
                        cx.notify();
                    }
                });
            });
        })
        .detach();
}

pub fn close_prompt_view<F, G, H>(
    path: Option<&str>,
    title: String,
    message: String,
    save_label: String,
    discard_label: String,
    cancel_label: String,
    on_save: F,
    on_discard: G,
    on_cancel: H,
) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    H: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
{
    let path = path.unwrap_or_default();
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .bg(rgb(0x252c36))
        .px(px(8.))
        .py(px(8.))
        .child(title)
        .child(format!("{message}: {path}"))
        .child(
            div()
                .flex()
                .gap(px(6.))
                .child(
                    div()
                        .id("file-close-save")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_save(window, app))
                        .child(save_label),
                )
                .child(
                    div()
                        .id("file-close-discard")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_discard(window, app))
                        .child(discard_label),
                )
                .child(
                    div()
                        .id("file-close-cancel")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_cancel(window, app))
                        .child(cancel_label),
                ),
        )
}

pub fn close_prompt_for_shell(
    shell: &crate::DesktopShell,
    save_entity: gpui::Entity<crate::DesktopShell>,
    discard_entity: gpui::Entity<crate::DesktopShell>,
    cancel_entity: gpui::Entity<crate::DesktopShell>,
) -> impl IntoElement {
    close_prompt_view(
        shell.file_close_prompt.as_deref(),
        shell.message("files.editor.unsavedTitle"),
        shell.message("files.editor.unsavedOne"),
        shell.message("common.save"),
        shell.message("files.editor.discard"),
        shell.message("common.cancel"),
        move |window, app| {
            let _ = save_entity.update(app, |this, cx| {
                if let Some(path) = this.file_close_prompt.clone() {
                    save_and_close(this, path, window, cx);
                }
            });
        },
        move |window, app| {
            let _ = discard_entity.update(app, |this, cx| {
                if let Some(path) = this.file_close_prompt.clone() {
                    discard_close(this, path, window, cx);
                }
            });
        },
        move |_window, app| {
            let _ = cancel_entity.update(app, |this, cx| cancel_close(this, cx));
        },
    )
}

fn sync_tab(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    if let Some(path) = shell.file_tabs.active_path().map(str::to_owned) {
        let content = shell.file_editor.read(cx).value().to_string();
        shell.file_tabs.update_content(&path, content);
    }
}

fn visible_entries(entries: &[FileEntry]) -> impl Iterator<Item = &FileEntry> {
    let mut expanded = Vec::new();
    let mut visible = Vec::new();
    for entry in entries {
        expanded.truncate(entry.depth);
        if expanded.iter().all(|is_expanded| *is_expanded) {
            visible.push(entry);
        }
        if entry.directory {
            expanded.push(entry.expanded);
        }
    }
    visible.into_iter()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn root_scan_hides_dot_entries_and_sorts_directories_first() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("z-dir")).unwrap();
        fs::create_dir(root.path().join("a-dir")).unwrap();
        fs::write(root.path().join("b.txt"), b"b").unwrap();
        fs::write(root.path().join(".env"), b"secret").unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        let entries = load_root(root.path().to_owned()).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["a-dir", "z-dir", "b.txt"]
        );
        assert!(entries
            .iter()
            .all(|entry| entry.depth == 0 && !entry.loaded));
        assert!(entries.iter().all(|entry| !entry.name.starts_with('.')));
    }

    #[test]
    fn root_scan_reports_missing_path() {
        let error = load_root(PathBuf::from("this-path-should-not-exist-gpui"));
        assert!(error.is_err());
    }

    #[test]
    fn child_scan_preserves_relative_paths_and_depth() {
        let root = tempdir().unwrap();
        let child = root.path().join("src");
        fs::create_dir(&child).unwrap();
        fs::write(child.join("main.rs"), b"fn main() {}").unwrap();
        let entries = load_directory_with_root(&child, "src", 1, root.path()).unwrap();
        assert_eq!(entries[0].relative_path, "src/main.rs");
        assert_eq!(entries[0].depth, 1);
    }

    #[test]
    fn directory_toggle_loads_once_then_only_changes_expansion() {
        let mut state = FileTreeState::Ready {
            project_id: "p".into(),
            root: PathBuf::from("."),
            entries: vec![FileEntry {
                name: "src".into(),
                relative_path: "src".into(),
                directory: true,
                depth: 0,
                expanded: false,
                loaded: false,
            }],
        };
        let mut loading = HashSet::new();
        assert!(matches!(
            toggle_directory(&mut state, &mut loading, "src"),
            Some(ToggleDirectory::Load { .. })
        ));
        assert!(toggle_directory(&mut state, &mut loading, "src").is_none());
        let children = vec![FileEntry {
            name: "main.rs".into(),
            relative_path: "src/main.rs".into(),
            directory: false,
            depth: 1,
            expanded: false,
            loaded: false,
        }];
        assert!(finish_directory_load(
            &mut state,
            &mut loading,
            "p",
            "src",
            Ok(children)
        ));
        assert!(matches!(
            toggle_directory(&mut state, &mut loading, "src"),
            Some(ToggleDirectory::Changed)
        ));
    }

    #[test]
    fn root_scan_applies_gitignore_rules_and_keeps_gitignore_visible() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join(".gitignore"),
            "target/\n*.log\n!important.log\n",
        )
        .unwrap();
        fs::create_dir(root.path().join("target")).unwrap();
        fs::write(root.path().join("build.log"), b"ignored").unwrap();
        fs::write(root.path().join("important.log"), b"kept").unwrap();
        let entries = load_root(root.path().to_owned()).unwrap();
        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, [".gitignore", "important.log"]);
    }

    #[test]
    fn file_operations_create_rename_and_delete_with_nested_paths() {
        let root = tempdir().unwrap();
        let file = create_file(root.path(), "src/main.rs").unwrap();
        assert!(file.is_file());
        let directory = create_directory(root.path(), "assets/icons").unwrap();
        assert!(directory.is_dir());
        let renamed = rename(root.path(), "src/main.rs", "src/lib.rs").unwrap();
        assert_eq!(
            renamed,
            root.path().canonicalize().unwrap().join("src/lib.rs")
        );
        delete(root.path(), "src/lib.rs").unwrap();
        assert!(!renamed.exists());
    }

    #[test]
    fn async_file_operations_create_and_rename_paths() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let root = tempdir().unwrap();
        runtime
            .block_on(run_operation_async(
                root.path().to_owned(),
                FileOperation::CreateFile,
                "notes.txt".into(),
            ))
            .unwrap();
        runtime
            .block_on(run_operation_async(
                root.path().to_owned(),
                FileOperation::Rename {
                    source: "notes.txt".into(),
                },
                "renamed.txt".into(),
            ))
            .unwrap();
        assert!(root.path().join("renamed.txt").is_file());
    }

    #[test]
    fn file_operations_reject_escape_and_git_metadata_paths() {
        let root = tempdir().unwrap();
        for path in ["../outside.txt", ".git/config", "src/.git/objects"] {
            assert!(
                create_file(root.path(), path).is_err(),
                "path should be rejected: {path}"
            );
        }
        assert!(create_file(root.path(), "/absolute.txt").is_err());
        assert!(delete(root.path(), ".git").is_err());
    }

    #[test]
    fn text_preview_reads_utf8_and_rejects_binary_files() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("readme.md"), "# hello\n").unwrap();
        std::fs::write(root.path().join("image.bin"), [0, 159, 146, 150]).unwrap();
        assert_eq!(read_text(root.path(), "readme.md").unwrap(), "# hello\n");
        assert_eq!(
            read_text(root.path(), "image.bin"),
            Err("binary_file".into())
        );
    }

    #[test]
    fn html_and_pdf_support_external_preview_but_other_files_do_not() {
        assert!(supports_external_preview("docs/index.html"));
        assert!(supports_external_preview("docs/index.HTM"));
        assert!(supports_external_preview("docs/manual.pdf"));
        assert!(!supports_external_preview("docs/readme.md"));
        assert!(!supports_external_preview("docs/script.js"));
    }

    #[test]
    fn text_save_stays_inside_project_and_enforces_size_limit() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("notes.txt"), "old").unwrap();
        write_text(root.path(), "notes.txt", "new").unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("notes.txt")).unwrap(),
            "new"
        );
        assert!(write_text(root.path(), "../outside.txt", "bad").is_err());
        assert!(write_text(
            root.path(),
            "notes.txt",
            &"x".repeat((MAX_PREVIEW_BYTES + 1) as usize)
        )
        .is_err());
    }

    #[test]
    fn async_text_save_returns_the_original_relative_path() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let root = tempdir().unwrap();
        fs::write(root.path().join("notes.txt"), "old").unwrap();
        let (path, result) = runtime.block_on(write_text_async(
            root.path().to_owned(),
            "notes.txt".into(),
            "new".into(),
        ));
        assert_eq!(path, "notes.txt");
        assert!(result.is_ok());
        assert_eq!(
            fs::read_to_string(root.path().join("notes.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn file_tabs_reuse_paths_and_protect_dirty_close() {
        let mut tabs = FileTabs::default();
        tabs.open("src/main.rs".into(), "one".into());
        tabs.open("src/lib.rs".into(), "two".into());
        tabs.open("src/main.rs".into(), "ignored-reload".into());
        assert_eq!(tabs.tabs().len(), 2);
        assert_eq!(tabs.active_path(), Some("src/main.rs"));
        tabs.update_content("src/main.rs", "edited".into());
        assert_eq!(
            tabs.close("src/main.rs", false),
            CloseTabDecision::NeedsSave
        );
        assert_eq!(tabs.close("src/main.rs", true), CloseTabDecision::Closed);
        assert_eq!(tabs.active_path(), Some("src/lib.rs"));
    }

    #[test]
    fn file_tabs_track_saved_content_separately_and_close_groups() {
        let mut tabs = FileTabs::default();
        tabs.open("a.txt".into(), "a".into());
        tabs.open("b.txt".into(), "b".into());
        tabs.open("c.txt".into(), "c".into());
        tabs.select("b.txt");
        tabs.update_content("a.txt", "edited".into());
        assert!(tabs.get("a.txt").unwrap().dirty);
        assert_eq!(
            tabs.group_paths(CloseTabGroup::Others),
            vec!["a.txt", "c.txt"]
        );
        assert_eq!(tabs.group_paths(CloseTabGroup::Left), vec!["a.txt"]);
        assert_eq!(tabs.group_paths(CloseTabGroup::Right), vec!["c.txt"]);
        assert_eq!(
            tabs.close_many(&["a.txt".into(), "c.txt".into()], false),
            CloseTabDecision::NeedsSave
        );
        assert_eq!(
            tabs.close_many(&["a.txt".into(), "c.txt".into()], true),
            CloseTabDecision::Closed
        );
        assert_eq!(tabs.tabs().len(), 1);
        assert_eq!(tabs.active_path(), Some("b.txt"));
    }
}
