use gpui::{div, prelude::*, px, ScrollDelta, ScrollEvent};
use gpui_component::input::{Editor, EditorState};
use gpui_component::scroll::ScrollableElement;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc::{self, UnboundedReceiver};

mod diff_highlight;
mod view;
pub use diff_highlight::{
    highlight_diff, highlight_diff_for_path, styled_diff_line, DiffLineKind, HighlightedDiffLine,
};
pub use view::{checkout_prompt, commit_prompt, diff_view, discard_prompt, view};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitEntry {
    pub index: char,
    pub worktree: char,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitRef {
    pub kind: GitRefKind,
    pub name: String,
    pub commit: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitRefKind {
    Branch,
    Tag,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<GitEntry>,
    pub refs: Vec<GitRef>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct BranchMetadata {
    branch: Option<String>,
    ahead: u32,
    behind: u32,
}

impl GitStatus {
    pub fn merge_paths(&mut self, refreshed: GitStatus, paths: &[String]) {
        self.branch = refreshed.branch;
        self.ahead = refreshed.ahead;
        self.behind = refreshed.behind;
        let in_scope = |path: &str| {
            paths.iter().any(|scope| {
                let scope = scope.trim_end_matches('/');
                path == scope
                    || path
                        .strip_prefix(scope)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
        };
        self.entries.retain(|entry| !in_scope(&entry.path));
        self.entries.extend(
            refreshed
                .entries
                .into_iter()
                .filter(|entry| in_scope(&entry.path)),
        );
        self.entries
            .sort_by(|left, right| left.path.cmp(&right.path));
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GitState {
    Empty,
    Loading,
    Ready(GitStatus),
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitAction {
    Stage,
    Unstage,
    Discard,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiffState {
    Empty,
    Loading,
    Ready { path: String, text: String },
    Failed(String),
}

#[derive(Default)]
pub struct DiffCache {
    pub text: std::collections::HashMap<String, String>,
    pub highlight: std::collections::HashMap<String, Vec<HighlightedDiffLine>>,
    pub blob_id: Option<String>,
}

impl DiffCache {
    pub fn clear(&mut self) {
        self.text.clear();
        self.highlight.clear();
        self.blob_id = None;
    }
}

pub const VISIBLE_GIT_ENTRIES: usize = 200;
pub const VISIBLE_DIFF_LINES: usize = 240;

pub fn visible_entry_range(total: usize, offset: usize) -> (usize, usize) {
    let start = offset.min(total.saturating_sub(VISIBLE_GIT_ENTRIES));
    (start, (start + VISIBLE_GIT_ENTRIES).min(total))
}

pub fn visible_diff_range(total: usize, offset: usize) -> (usize, usize) {
    let start = offset.min(total.saturating_sub(VISIBLE_DIFF_LINES));
    (start, (start + VISIBLE_DIFF_LINES).min(total))
}

struct GitWatcher {
    _watcher: RecommendedWatcher,
    events: UnboundedReceiver<notify::Result<Event>>,
    root: PathBuf,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct GitChanges {
    paths: HashSet<String>,
    full: bool,
}

impl GitChanges {
    fn collect(&mut self, root: &std::path::Path, event: Event) {
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        if matches!(event.kind, notify::EventKind::Other) || event.paths.is_empty() {
            self.full = true;
        }
        for path in event.paths {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.is_empty() {
                self.full = true;
            } else if relative == ".git/index"
                || relative == ".git/HEAD"
                || relative == ".git/packed-refs"
                || relative == ".git/config"
                || relative.starts_with(".git/refs/")
                || relative == ".git"
                || relative == ".gitignore"
                || relative.ends_with("/.gitignore")
            {
                self.full = true;
            } else if !relative.starts_with(".git/") {
                self.paths.insert(relative);
            }
        }
        self.full |= self.paths.len() > 200;
    }
}

impl GitWatcher {
    fn new(root: PathBuf) -> notify::Result<Self> {
        let root = root.canonicalize().unwrap_or(root);
        let (sender, events) = mpsc::unbounded_channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            events,
            root,
        })
    }

    async fn next_paths(&mut self) -> io::Result<GitChanges> {
        let first = self
            .events
            .recv()
            .await
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "git_watcher_closed"))?;
        let mut paths = GitChanges::default();
        self.collect_event(first, &mut paths)?;
        while let Ok(event) = self.events.try_recv() {
            self.collect_event(event, &mut paths)?;
        }
        Ok(paths)
    }

    fn collect_event(
        &self,
        event: notify::Result<Event>,
        paths: &mut GitChanges,
    ) -> io::Result<()> {
        let event = event.map_err(|error| io::Error::other(error.to_string()))?;
        paths.collect(&self.root, event);
        Ok(())
    }
}

impl Default for DiffState {
    fn default() -> Self {
        Self::Empty
    }
}

impl Default for GitState {
    fn default() -> Self {
        Self::Empty
    }
}

pub fn load(root: PathBuf) -> Result<GitStatus, String> {
    let mut status = query_status(&root, &[])?;
    status.refs = load_refs(&root)?;
    Ok(status)
}

pub fn load_paths(root: PathBuf, paths: &[String]) -> Result<GitStatus, String> {
    for path in paths {
        validate_relative_path(path)?;
    }
    if paths.is_empty() {
        return load(root);
    }
    query_status(&root, paths)
}

fn query_status(root: &std::path::Path, paths: &[String]) -> Result<GitStatus, String> {
    // WSL UNC 的元数据查询继续沿用 CLI，不尝试通过 Windows libgit2 打开。
    let normalized = root
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let metadata =
        if normalized.starts_with("//wsl$/") || normalized.starts_with("//wsl.localhost/") {
            None
        } else {
            load_branch_metadata(root).ok()
        };
    let mut command = std::process::Command::new("git");
    command
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args([
            "--literal-pathspecs",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ]);
    if metadata.is_none() {
        command.arg("--branch");
    }
    command.arg("--").args(paths);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let mut status = if metadata.is_some() {
        // parse_status 使用统一的带头格式；本地分支信息由 git2 填入。
        let mut records = b"## HEAD\0".to_vec();
        records.extend_from_slice(&output.stdout);
        parse_status(&records)?
    } else {
        parse_status(&output.stdout)?
    };
    if let Some(metadata) = metadata {
        apply_branch_metadata(&mut status, metadata);
    }
    Ok(status)
}

fn load_branch_metadata(root: &std::path::Path) -> Result<BranchMetadata, String> {
    let repo = git2::Repository::open(root).map_err(|error| error.to_string())?;
    let head = match repo.head() {
        Ok(head) => head,
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => {
            let head = repo
                .find_reference("HEAD")
                .map_err(|error| error.to_string())?;
            let branch = head
                .symbolic_target()
                .unwrap_or("refs/heads/HEAD")
                .strip_prefix("refs/heads/")
                .unwrap_or("HEAD");
            return Ok(BranchMetadata {
                branch: Some(format!("No commits yet on {branch}")),
                ..Default::default()
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    if repo.head_detached().unwrap_or(false) {
        return Ok(BranchMetadata::default());
    }
    let Some(branch) = head.shorthand().map(str::to_owned) else {
        return Ok(BranchMetadata::default());
    };
    let mut metadata = BranchMetadata {
        branch: Some(branch.clone()),
        ..Default::default()
    };
    if let Ok(local_branch) = repo.find_branch(&branch, git2::BranchType::Local) {
        if let Ok(upstream) = local_branch.upstream() {
            if let (Some(local), Some(remote)) = (head.target(), upstream.get().target()) {
                if let Ok((ahead, behind)) = repo.graph_ahead_behind(local, remote) {
                    metadata.ahead = ahead as u32;
                    metadata.behind = behind as u32;
                }
            }
        }
    }
    Ok(metadata)
}

fn apply_branch_metadata(status: &mut GitStatus, metadata: BranchMetadata) {
    if let Some(branch) = metadata.branch {
        status.branch = branch;
        status.ahead = metadata.ahead;
        status.behind = metadata.behind;
    } else {
        status.branch = "HEAD".into();
        status.ahead = 0;
        status.behind = 0;
    }
}

pub fn load_refs(root: &std::path::Path) -> Result<Vec<GitRef>, String> {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args([
            "for-each-ref",
            "--format=%(refname)\t%(objectname:short)",
            "--sort=-committerdate",
            "refs/heads",
            "refs/tags",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    parse_refs(&output.stdout)
}

pub async fn load_async(root: PathBuf) -> (PathBuf, Result<GitStatus, String>) {
    let expected = root.clone();
    let result = tokio::task::spawn_blocking(move || load(root))
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    (expected, result)
}

pub async fn load_paths_async(
    root: PathBuf,
    paths: Vec<String>,
) -> (Vec<String>, Result<GitStatus, String>) {
    let expected = paths.clone();
    let result = tokio::task::spawn_blocking(move || load_paths(root, &paths))
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    (expected, result)
}

pub async fn action_async(root: PathBuf, path: String, action: GitAction) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_relative_path(&path)?;
        let mut command = std::process::Command::new("git");
        command.current_dir(root);
        match action {
            GitAction::Stage => {
                command.args(["add", "--", &path]);
            }
            GitAction::Unstage => {
                command.args(["restore", "--staged", "--", &path]);
            }
            GitAction::Discard => {
                command.args([
                    "restore",
                    "--source=HEAD",
                    "--staged",
                    "--worktree",
                    "--",
                    &path,
                ]);
            }
        }
        let output = command.output().map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
        }
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()))
}

pub async fn commit_async(root: PathBuf, message: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let message = message.trim();
        if message.is_empty() {
            return Err("empty_commit_message".into());
        }
        if message.len() > 4096 {
            return Err("commit_message_too_long".into());
        }
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(["commit", "-m", message])
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
        }
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()))
}

pub async fn checkout_async(root: PathBuf, reference: GitRef) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let full_name = match reference.kind {
            GitRefKind::Branch => format!("refs/heads/{}", reference.name),
            GitRefKind::Tag => format!("refs/tags/{}", reference.name),
        };
        let check = std::process::Command::new("git")
            .current_dir(&root)
            .args(["check-ref-format", &full_name])
            .output()
            .map_err(|error| error.to_string())?;
        if !check.status.success() {
            return Err("invalid_ref".into());
        }
        let mut command = std::process::Command::new("git");
        command.current_dir(root);
        match reference.kind {
            GitRefKind::Branch => {
                command.args(["switch", "--", &reference.name]);
            }
            GitRefKind::Tag => {
                command.args(["switch", "--detach", &reference.name]);
            }
        }
        let output = command.output().map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
        }
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()))
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    let path = std::path::Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("invalid_path".into());
    }
    Ok(())
}

pub fn request_discard(
    shell: &mut crate::DesktopShell,
    path: String,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let tracked = match &shell.git_status {
        GitState::Ready(status) => status
            .entries
            .iter()
            .find(|entry| entry.path == path)
            .is_some_and(|entry| entry.index != '?' || entry.worktree != '?'),
        _ => false,
    };
    if tracked {
        shell.git_revert_prompt = Some(path);
        cx.notify();
    }
}

pub fn cancel_discard(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    shell.git_revert_prompt = None;
    cx.notify();
}

pub fn begin_commit(
    shell: &mut crate::DesktopShell,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    shell
        .file_operation_editor
        .update(cx, |editor, cx| editor.set_value("", window, cx));
    shell.git_commit_prompt = true;
    shell.file_operation_error = None;
    cx.notify();
}

pub fn cancel_commit(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    shell.git_commit_prompt = false;
    shell.file_operation_error = None;
    cx.notify();
}

pub fn request_checkout(
    shell: &mut crate::DesktopShell,
    reference: GitRef,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    shell.git_checkout_prompt = Some(reference);
    cx.notify();
}

pub fn cancel_checkout(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    shell.git_checkout_prompt = None;
    cx.notify();
}

pub fn confirm_checkout(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(reference) = shell.git_checkout_prompt.take() else {
        return;
    };
    let Some(root) = (match &shell.file_tree {
        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let Some(project_id) = shell.selected_project.clone() else {
        return;
    };
    shell.git_status = GitState::Loading;
    let task = shell._runtime.spawn(checkout_async(root, reference));
    cx.spawn(async move |this, cx| {
        let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
        let _ = this.update(cx, |this, cx| {
            if this.selected_project.as_deref() != Some(project_id.as_str()) {
                return;
            }
            match result {
                Ok(()) => {
                    let root = match &this.file_tree {
                        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
                        _ => None,
                    };
                    if let Some(root) = root {
                        crate::files::refresh_tree(this, cx);
                        start_load(this, &project_id, root, cx);
                    }
                }
                Err(error) => {
                    this.git_status = GitState::Failed(error);
                    cx.notify();
                }
            }
        });
    })
    .detach();
}

pub fn confirm_commit(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let message = shell
        .file_operation_editor
        .read(cx)
        .value()
        .trim()
        .to_owned();
    if message.is_empty() {
        shell.file_operation_error = Some(shell.message("git.commit.messageRequired"));
        cx.notify();
        return;
    }
    let Some(root) = (match &shell.file_tree {
        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let Some(project_id) = shell.selected_project.clone() else {
        return;
    };
    shell.git_status = GitState::Loading;
    let task = shell._runtime.spawn(commit_async(root, message));
    cx.spawn(async move |this, cx| {
        let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
        let _ = this.update(cx, |this, cx| {
            if this.selected_project.as_deref() != Some(project_id.as_str()) {
                return;
            }
            match result {
                Ok(()) => {
                    this.git_commit_prompt = false;
                    this.file_operation_error = None;
                    if let crate::files::FileTreeState::Ready { root, .. } = &this.file_tree {
                        start_load(this, &project_id, root.clone(), cx);
                    }
                }
                Err(error) => {
                    this.git_status = GitState::Failed(error);
                    this.file_operation_error = Some(this.message("git.commit.failed"));
                    cx.notify();
                }
            }
        });
    })
    .detach();
}

pub fn confirm_discard(
    shell: &mut crate::DesktopShell,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(path) = shell.git_revert_prompt.take() else {
        return;
    };
    let Some(root) = (match &shell.file_tree {
        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let Some(project_id) = shell.selected_project.clone() else {
        return;
    };
    shell.git_status = GitState::Loading;
    let task = shell
        ._runtime
        .spawn(action_async(root, path, GitAction::Discard));
    cx.spawn(async move |this, cx| {
        let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
        let _ = this.update(cx, |this, cx| {
            if this.selected_project.as_deref() == Some(project_id.as_str()) {
                if let Err(error) = result {
                    this.git_status = GitState::Failed(error);
                }
                if let crate::files::FileTreeState::Ready { root, .. } = &this.file_tree {
                    start_load(this, &project_id, root.clone(), cx);
                }
            }
        });
    })
    .detach();
}

pub async fn diff_async(root: PathBuf, path: String) -> (String, Result<String, String>) {
    let expected = path.clone();
    let fallback_root = root.clone();
    let result = tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(["diff", "HEAD", "--", &path])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        let mut text = String::from_utf8(output.stdout).map_err(|_| "binary_diff".to_owned())?;
        if text.is_empty() {
            text = untracked_diff(&fallback_root, &path)?;
        }
        if text.len() > 768 * 1024 || text.lines().count() > 20_000 {
            return Err("diff_too_large".into());
        }
        Ok(text)
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    (expected, result)
}

fn worktree_blob_id(root: &std::path::Path, path: &str) -> Result<Option<String>, String> {
    validate_relative_path(path)?;
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(["hash-object", "--", path])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Ok(None);
    }
    let id = String::from_utf8(output.stdout)
        .map_err(|_| "invalid_blob_id".to_owned())?
        .trim()
        .to_owned();
    Ok((!id.is_empty()).then_some(id))
}

pub async fn blob_id_async(
    root: PathBuf,
    path: String,
) -> (String, Result<Option<String>, String>) {
    let expected = path.clone();
    let result = tokio::task::spawn_blocking(move || worktree_blob_id(&root, &path))
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    (expected, result)
}

fn untracked_diff(root: &std::path::Path, relative_path: &str) -> Result<String, String> {
    if relative_path.is_empty()
        || std::path::Path::new(relative_path).is_absolute()
        || relative_path
            .split(['/', '\\'])
            .any(|part| part == ".." || part == ".git")
    {
        return Ok(String::new());
    }
    let path = root.join(relative_path);
    if !path.is_file() {
        return Ok(String::new());
    }
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    let content = String::from_utf8(bytes).map_err(|_| "binary_diff".to_owned())?;
    let mut diff = format!("diff --git a/{relative_path} b/{relative_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{relative_path}\n@@ -0,0 +1,{} @@\n", content.lines().count().max(1));
    for line in content.lines() {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    Ok(diff)
}

pub fn start_diff(
    shell: &mut crate::DesktopShell,
    path: String,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(root) = (match &shell.file_tree {
        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    shell.git_offsets.1 = 0;
    shell.git_diff = DiffState::Loading;
    let key_task = shell
        ._runtime
        .spawn(blob_id_async(root.clone(), path.clone()));
    cx.spawn(async move |this, cx| {
        let (path, key) = key_task
            .await
            .unwrap_or_else(|error| (String::new(), Err(error.to_string())));
        let key = key.ok().flatten();
        let cached = this
            .update(cx, |this, _| {
                key.as_ref()
                    .and_then(|key| this.git_diff_cache.text.get(key).cloned())
            })
            .unwrap_or(None);
        if let Some(text) = cached {
            let _ = this.update(cx, |this, cx| {
                if let Some(key) = key.as_ref() {
                    if !this.git_diff_cache.highlight.contains_key(key) {
                        if this.git_diff_cache.highlight.len() >= 64 {
                            if let Some(oldest) =
                                this.git_diff_cache.highlight.keys().next().cloned()
                            {
                                this.git_diff_cache.highlight.remove(&oldest);
                            }
                        }
                        this.git_diff_cache
                            .highlight
                            .insert(key.clone(), highlight_diff_for_path(&path, &text));
                    }
                    this.git_diff_cache.blob_id = Some(key.clone());
                }
                this.git_diff = DiffState::Ready { path, text };
                cx.notify();
            });
            return;
        }
        let (_, result) = diff_async(root, path.clone()).await;
        let _ = this.update(cx, |this, cx| {
            match result {
                Ok(text) => {
                    if let Some(key) = key {
                        if this.git_diff_cache.text.len() >= 64 {
                            if let Some(oldest) = this.git_diff_cache.text.keys().next().cloned() {
                                this.git_diff_cache.text.remove(&oldest);
                            }
                        }
                        this.git_diff_cache.text.insert(key.clone(), text.clone());
                        if this.git_diff_cache.highlight.len() >= 64 {
                            if let Some(oldest) =
                                this.git_diff_cache.highlight.keys().next().cloned()
                            {
                                this.git_diff_cache.highlight.remove(&oldest);
                            }
                        }
                        this.git_diff_cache
                            .highlight
                            .insert(key.clone(), highlight_diff_for_path(&path, &text));
                        this.git_diff_cache.blob_id = Some(key);
                    }
                    this.git_diff = DiffState::Ready { path, text };
                }
                Err(error) => this.git_diff = DiffState::Failed(error),
            }
            cx.notify();
        });
    })
    .detach();
}

pub fn scroll_diff(
    shell: &mut crate::DesktopShell,
    delta: i32,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let total = match &shell.git_diff {
        DiffState::Ready { text, .. } => text.lines().count(),
        _ => 0,
    };
    let max_offset = total.saturating_sub(VISIBLE_DIFF_LINES);
    shell.git_offsets.1 = if delta >= 0 {
        shell
            .git_offsets
            .1
            .saturating_add(delta as usize)
            .min(max_offset)
    } else {
        shell
            .git_offsets
            .1
            .saturating_sub(delta.unsigned_abs() as usize)
    };
    cx.notify();
}

pub fn start_action(
    shell: &mut crate::DesktopShell,
    path: String,
    action: GitAction,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(root) = (match &shell.file_tree {
        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let Some(project_id) = shell.selected_project.clone() else {
        return;
    };
    let refresh_path = path.clone();
    let task = shell._runtime.spawn(action_async(root, path, action));
    cx.spawn(async move |this, cx| {
        let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
        let _ = this.update(cx, |this, cx| {
            if this.selected_project.as_deref() == Some(project_id.as_str()) {
                if let crate::files::FileTreeState::Ready { root, .. } = &this.file_tree {
                    if result.is_ok() {
                        start_path_load(this, &project_id, root.clone(), vec![refresh_path], cx);
                    } else {
                        start_load(this, &project_id, root.clone(), cx);
                    }
                }
            }
        });
    })
    .detach();
}

fn start_path_load(
    shell: &mut crate::DesktopShell,
    project_id: &str,
    root: PathBuf,
    paths: Vec<String>,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    if paths.is_empty() || !matches!(shell.git_status, GitState::Ready(_)) {
        start_load(shell, project_id, root, cx);
        return;
    }
    let generation = shell.git_watch_generation;
    let task = shell._runtime.spawn(load_paths_async(root, paths));
    let expected_project = project_id.to_owned();
    cx.spawn(async move |this, cx| {
        let (paths, result) = task
            .await
            .unwrap_or_else(|error| (Vec::new(), Err(error.to_string())));
        let _ = this.update(cx, |this, cx| {
            if this.git_watch_generation != generation
                || this.selected_project.as_deref() != Some(expected_project.as_str())
            {
                return;
            }
            match result {
                Ok(refreshed) => {
                    if let GitState::Ready(status) = &mut this.git_status {
                        status.merge_paths(refreshed, &paths);
                    }
                    cx.notify();
                }
                Err(_) => {
                    if let crate::files::FileTreeState::Ready { root, .. } = &this.file_tree {
                        start_load(this, &expected_project, root.clone(), cx);
                    }
                }
            }
        });
    })
    .detach();
}

async fn watch_git_paths(
    root: PathBuf,
    sender: tokio::sync::mpsc::UnboundedSender<Vec<String>>,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) {
    if !git_watcher_supported(&root) {
        eprintln!(
            "[git] watcher degraded for remote or WSL path; using 15s polling: {}",
            root.display()
        );
        watch_git_polling(cancel, sender).await;
        return;
    }
    let mut watcher = match GitWatcher::new(root) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!("[git] watcher unavailable; using 15s polling: {error}");
            watch_git_polling(cancel, sender).await;
            return;
        }
    };
    loop {
        tokio::select! {
            _ = &mut cancel => break,
            result = watcher.next_paths() => match result {
                Ok(changes) if changes.full || !changes.paths.is_empty() => {
                    let paths = if changes.full { Vec::new() } else { changes.paths.into_iter().collect() };
                    if sender.send(paths).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("[git] watcher stopped; using 15s polling: {error}");
                    watch_git_polling(cancel, sender).await;
                    break;
                }
            }
        }
    }
}

const GIT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

async fn watch_git_polling(
    cancel: tokio::sync::oneshot::Receiver<()>,
    sender: tokio::sync::mpsc::UnboundedSender<Vec<String>>,
) {
    watch_git_polling_with_interval(cancel, sender, GIT_POLL_INTERVAL).await;
}

async fn watch_git_polling_with_interval(
    mut cancel: tokio::sync::oneshot::Receiver<()>,
    sender: tokio::sync::mpsc::UnboundedSender<Vec<String>>,
    interval: std::time::Duration,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.tick().await;
    loop {
        tokio::select! {
            _ = &mut cancel => break,
            _ = ticker.tick() => {
                if sender.send(Vec::new()).is_err() {
                    break;
                }
            }
        }
    }
}

fn git_watcher_supported(root: &std::path::Path) -> bool {
    let normalized = root
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    !normalized.starts_with("//")
}

fn start_git_watcher(
    shell: &mut crate::DesktopShell,
    project_id: &str,
    root: PathBuf,
    generation: u64,
    cancel: tokio::sync::oneshot::Receiver<()>,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    shell
        ._runtime
        .spawn(watch_git_paths(root.clone(), sender, cancel));
    let expected_project = project_id.to_owned();
    cx.spawn(async move |this, cx| {
        while let Some(paths) = receiver.recv().await {
            let update = this.update(cx, |this, cx| {
                if this.git_watch_generation == generation
                    && this.selected_project.as_deref() == Some(expected_project.as_str())
                {
                    start_path_load(this, &expected_project, root.clone(), paths, cx);
                    true
                } else {
                    false
                }
            });
            if update.is_err() || !update.unwrap_or(false) {
                break;
            }
        }
    })
    .detach();
}

pub fn start_load(
    shell: &mut crate::DesktopShell,
    project_id: &str,
    root: PathBuf,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    if let Some(cancel) = shell.git_watch_cancel.take() {
        let _ = cancel.send(());
    }
    shell.git_watch_generation = shell.git_watch_generation.wrapping_add(1);
    let generation = shell.git_watch_generation;
    let (cancel, cancel_receiver) = tokio::sync::oneshot::channel();
    shell.git_watch_cancel = Some(cancel);
    shell.git_status = GitState::Loading;
    start_git_watcher(
        shell,
        project_id,
        root.clone(),
        generation,
        cancel_receiver,
        cx,
    );
    let task = shell._runtime.spawn(load_async(root));
    let expected_project = project_id.to_owned();
    cx.spawn(async move |this, cx| {
        let (_root, result) = task
            .await
            .unwrap_or_else(|error| (PathBuf::new(), Err(error.to_string())));
        let _ = this.update(cx, |this, cx| {
            if this.git_watch_generation == generation
                && this.selected_project.as_deref() == Some(expected_project.as_str())
            {
                this.git_status = result.map(GitState::Ready).unwrap_or_else(GitState::Failed);
                cx.notify();
            }
        });
    })
    .detach();
}

pub fn scroll_entries(
    shell: &mut crate::DesktopShell,
    delta: i32,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let total = match &shell.git_status {
        GitState::Ready(status) => status.entries.len(),
        _ => 0,
    };
    let max_offset = total.saturating_sub(VISIBLE_GIT_ENTRIES);
    shell.git_offsets.0 = if delta >= 0 {
        shell
            .git_offsets
            .0
            .saturating_add(delta as usize)
            .min(max_offset)
    } else {
        shell
            .git_offsets
            .0
            .saturating_sub(delta.unsigned_abs() as usize)
    };
    cx.notify();
}

pub fn parse_status(bytes: &[u8]) -> Result<GitStatus, String> {
    let records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let Some(header) = records.first() else {
        return Ok(GitStatus::default());
    };
    let header = String::from_utf8_lossy(header);
    let branch_part = header.strip_prefix("## ").unwrap_or(header.as_ref());
    let branch = branch_part
        .split("...")
        .next()
        .unwrap_or(branch_part)
        .to_owned();
    let ahead = marker_value(&header, "ahead ");
    let behind = marker_value(&header, "behind ");
    let mut entries = Vec::new();
    for record in records.into_iter().skip(1) {
        if record.len() < 3 {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        let mut chars = text.chars();
        let index = chars.next().unwrap_or(' ');
        let worktree = chars.next().unwrap_or(' ');
        if chars.next() != Some(' ') {
            continue;
        }
        let path = chars.collect::<String>();
        entries.push(GitEntry {
            index,
            worktree,
            path,
        });
    }
    Ok(GitStatus {
        branch,
        ahead,
        behind,
        entries,
        refs: Vec::new(),
    })
}

pub fn parse_refs(bytes: &[u8]) -> Result<Vec<GitRef>, String> {
    let mut refs = Vec::new();
    for line in String::from_utf8_lossy(bytes).lines() {
        let Some((full_name, commit)) = line.split_once('\t') else {
            continue;
        };
        let (kind, name) = if let Some(name) = full_name.strip_prefix("refs/heads/") {
            (GitRefKind::Branch, name)
        } else if let Some(name) = full_name.strip_prefix("refs/tags/") {
            (GitRefKind::Tag, name)
        } else {
            continue;
        };
        if !name.is_empty() && !commit.is_empty() {
            refs.push(GitRef {
                kind,
                name: name.to_owned(),
                commit: commit.to_owned(),
            });
        }
    }
    Ok(refs)
}

fn marker_value(header: &str, marker: &str) -> u32 {
    header
        .split(marker)
        .nth(1)
        .and_then(|value| {
            value
                .split(|character: char| !character.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata_commit(
        repo: &git2::Repository,
        parent: Option<git2::Oid>,
        message: &str,
    ) -> git2::Oid {
        let mut index = repo.index().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let parent = parent.map(|oid| repo.find_commit(oid).unwrap());
        let parents = parent.iter().collect::<Vec<_>>();
        repo.commit(None, &signature, &signature, message, &tree, &parents)
            .unwrap()
    }

    #[test]
    fn metadata_covers_unborn_detached_and_diverged_upstream() {
        let directory = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(directory.path()).unwrap();
        repo.set_head("refs/heads/main").unwrap();
        assert_eq!(
            load_branch_metadata(directory.path())
                .unwrap()
                .branch
                .as_deref(),
            Some("No commits yet on main")
        );
        let base = metadata_commit(&repo, None, "base");
        repo.reference("refs/heads/main", base, true, "test")
            .unwrap();
        let metadata = load_branch_metadata(directory.path()).unwrap();
        assert_eq!(metadata.branch.as_deref(), Some("main"));
        assert_eq!((metadata.ahead, metadata.behind), (0, 0));
        let local = metadata_commit(&repo, Some(base), "local");
        let remote = metadata_commit(&repo, Some(base), "remote");
        repo.reference("refs/heads/main", local, true, "test")
            .unwrap();
        repo.reference("refs/heads/upstream", remote, true, "test")
            .unwrap();
        repo.find_branch("main", git2::BranchType::Local)
            .unwrap()
            .set_upstream(Some("upstream"))
            .unwrap();
        let metadata = load_branch_metadata(directory.path()).unwrap();
        assert_eq!((metadata.ahead, metadata.behind), (1, 1));
        repo.set_head_detached(base).unwrap();
        let metadata = load_branch_metadata(directory.path()).unwrap();
        assert_eq!(metadata, BranchMetadata::default());
        let mut status = GitStatus {
            branch: "old-branch".into(),
            ahead: 8,
            behind: 9,
            ..Default::default()
        };
        apply_branch_metadata(&mut status, metadata);
        assert_eq!(
            (status.branch.as_str(), status.ahead, status.behind),
            ("HEAD", 0, 0)
        );
    }

    #[test]
    fn incremental_merge_removes_clean_paths_and_refreshes_metadata() {
        let mut status = parse_status(b"## main\0 M a.txt\0 M b.txt\0").unwrap();
        let updated = GitStatus {
            branch: "feature".into(),
            ahead: 2,
            behind: 1,
            ..Default::default()
        };
        status.merge_paths(updated, &["a.txt".into()]);
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "b.txt");
        assert_eq!(
            (status.branch.as_str(), status.ahead, status.behind),
            ("feature", 2, 1)
        );
    }

    #[test]
    fn large_git_status_uses_a_bounded_visible_window() {
        assert_eq!(visible_entry_range(0, 0), (0, 0));
        assert_eq!(visible_entry_range(5_000, 0), (0, VISIBLE_GIT_ENTRIES));
        assert_eq!(visible_entry_range(5_000, 4_950), (4_800, 5_000));
        assert_eq!(visible_entry_range(5_000, 50_000), (4_800, 5_000));
    }

    #[test]
    fn large_diff_uses_a_bounded_visible_window() {
        assert_eq!(visible_diff_range(0, 0), (0, 0));
        assert_eq!(visible_diff_range(20_000, 0), (0, VISIBLE_DIFF_LINES));
        assert_eq!(visible_diff_range(20_000, 19_950), (19_760, 20_000));
        assert_eq!(visible_diff_range(20_000, 50_000), (19_760, 20_000));
    }

    #[test]
    fn highlights_diff_lines_by_structural_kind() {
        let lines = highlight_diff("diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n context");
        assert_eq!(
            lines.iter().map(|line| line.kind).collect::<Vec<_>>(),
            vec![
                DiffLineKind::Header,
                DiffLineKind::Hunk,
                DiffLineKind::Removed,
                DiffLineKind::Added,
                DiffLineKind::Context
            ]
        );
        let tokens = highlight_diff("+let count = 42; // changed")[0]
            .tokens
            .clone();
        assert!(tokens.iter().any(|token| token.color == 0xc586c0));
        assert!(tokens.iter().any(|token| token.color == 0xb5cea8));
        assert!(tokens.iter().any(|token| token.color == 0x7f9f7f));
    }

    #[test]
    fn watcher_classifies_metadata_ignore_rules_and_event_overflow() {
        let root = PathBuf::from("repository");
        for path in [
            ".git/index",
            ".git/HEAD",
            ".git/refs/heads/main",
            ".git/packed-refs",
            ".git/config",
            "nested/.gitignore",
        ] {
            let mut changes = GitChanges::default();
            changes.collect(
                &root,
                Event::new(notify::EventKind::Any).add_path(root.join(path)),
            );
            assert!(changes.full, "missing full refresh for {path}");
        }
        let mut changes = GitChanges::default();
        changes.collect(
            &root,
            Event::new(notify::EventKind::Access(notify::event::AccessKind::Any))
                .add_path(root.join("note.txt")),
        );
        changes.collect(
            &root,
            Event::new(notify::EventKind::Any).add_path(root.join(".git/index.lock")),
        );
        assert_eq!(changes, GitChanges::default());
        changes.collect(&root, Event::new(notify::EventKind::Other));
        assert!(changes.full);
        let mut changes = GitChanges::default();
        for index in 0..201 {
            changes.collect(
                &root,
                Event::new(notify::EventKind::Any).add_path(root.join(format!("file-{index}"))),
            );
        }
        assert!(changes.full);
    }

    #[test]
    fn watcher_keeps_both_rename_paths_and_directory_merge_preserves_siblings() {
        let root = PathBuf::from("repository");
        let mut changes = GitChanges::default();
        let event = Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Both,
        )))
        .add_path(root.join("src/old.txt"))
        .add_path(root.join("src/new.txt"));
        changes.collect(&root, event);
        assert_eq!(changes.paths.len(), 2);
        assert!(!changes.full);
        let mut status =
            parse_status(b"## main\0 M src/old.txt\0 M src/saved.txt\0 M src-other/keep.txt\0")
                .unwrap();
        let refreshed = parse_status(b"## main\0?? src/new.txt\0").unwrap();
        status.merge_paths(refreshed, &["src".into()]);
        assert_eq!(
            status
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src-other/keep.txt", "src/new.txt"]
        );
    }

    #[test]
    fn real_watcher_detects_external_index_update() {
        let directory = tempfile::tempdir().unwrap();
        let _repo = git2::Repository::init(directory.path()).unwrap();
        std::fs::write(directory.path().join("note.txt"), "hello\n").unwrap();
        let mut watcher = GitWatcher::new(directory.path().to_owned()).unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(directory.path())
            .args(["add", "--", "note.txt"])
            .output()
            .unwrap()
            .status
            .success());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    if watcher.next_paths().await.unwrap().full {
                        break;
                    }
                }
            })
            .await
            .expect("external index write did not reach watcher");
        });
    }

    #[test]
    fn git_watcher_uses_polling_for_remote_paths_and_stops_on_cancel() {
        assert!(!git_watcher_supported(std::path::Path::new(
            r"\\server\share\repo"
        )));
        assert!(!git_watcher_supported(std::path::Path::new(
            r"\\wsl.localhost\Ubuntu\repo"
        )));
        assert!(git_watcher_supported(std::path::Path::new(r"C:\repo")));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let task = tokio::spawn(watch_git_polling_with_interval(
                cancel_receiver,
                sender,
                std::time::Duration::from_millis(10),
            ));
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
                    .await
                    .expect("git polling should trigger a refresh")
                    .is_some()
            );
            cancel_sender.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .expect("git polling should stop after cancellation")
                .unwrap();
        });
    }

    #[test]
    fn incremental_status_handles_five_thousand_untracked_files_without_full_scan() {
        let directory = tempfile::tempdir().unwrap();
        git2::Repository::init(directory.path()).unwrap();
        for index in 0..5_000 {
            std::fs::write(
                directory.path().join(format!("file-{index:04}.txt")),
                "content\n",
            )
            .unwrap();
        }
        let mut current = GitStatus {
            entries: (0..5_000)
                .map(|index| GitEntry {
                    index: ' ',
                    worktree: 'M',
                    path: format!("file-{index:04}.txt"),
                })
                .collect(),
            ..Default::default()
        };
        let started = std::time::Instant::now();
        let status = load_paths(directory.path().to_owned(), &["file-0042.txt".into()]).unwrap();
        current.merge_paths(status, &["file-0042.txt".into()]);
        let (start, end) = visible_entry_range(current.entries.len(), 2_500);
        assert_eq!(end - start, VISIBLE_GIT_ENTRIES);
        assert_eq!(
            current
                .entries
                .iter()
                .filter(|entry| entry.path == "file-0042.txt")
                .count(),
            1
        );
        let elapsed = started.elapsed();
        eprintln!("5,000-file incremental status + merge + visible window: {elapsed:?}");
        assert!(
            elapsed < std::time::Duration::from_millis(200),
            "incremental status exceeded 200ms: {:?}",
            elapsed
        );
    }

    #[test]
    fn parses_branch_and_porcelain_entries() {
        let bytes = b"## feature/demo...origin/feature/demo [ahead 2, behind 1]\0 M src/main.rs\0A  new.txt\0";
        let status = parse_status(bytes).unwrap();
        assert_eq!(status.branch, "feature/demo");
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(
            status.entries,
            vec![
                GitEntry {
                    index: ' ',
                    worktree: 'M',
                    path: "src/main.rs".into()
                },
                GitEntry {
                    index: 'A',
                    worktree: ' ',
                    path: "new.txt".into()
                },
            ]
        );
    }

    #[test]
    fn parses_unborn_branch_without_changes() {
        let status = parse_status(b"## No commits yet on main\0").unwrap();
        assert_eq!(status.branch, "No commits yet on main");
        assert!(status.entries.is_empty());
    }

    #[test]
    fn parses_local_branches_and_tags() {
        let refs = parse_refs(
            b"refs/heads/main\tabc123\nrefs/tags/v1.0\tdef456\nrefs/remotes/origin/main\t999999\n",
        )
        .unwrap();
        assert_eq!(
            refs,
            vec![
                GitRef {
                    kind: GitRefKind::Branch,
                    name: "main".into(),
                    commit: "abc123".into()
                },
                GitRef {
                    kind: GitRefKind::Tag,
                    name: "v1.0".into(),
                    commit: "def456".into()
                },
            ]
        );
    }

    #[test]
    fn checks_out_a_local_branch_and_rejects_invalid_refs() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let root = tempfile::tempdir().unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            assert!(std::process::Command::new("git")
                .current_dir(root.path())
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        std::fs::write(root.path().join("note.txt"), "hello").unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(root.path())
            .args(["add", "note.txt"])
            .status()
            .unwrap()
            .success());
        runtime
            .block_on(commit_async(root.path().to_owned(), "initial".into()))
            .unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(root.path())
            .args(["branch", "feature"])
            .status()
            .unwrap()
            .success());
        runtime
            .block_on(checkout_async(
                root.path().to_owned(),
                GitRef {
                    kind: GitRefKind::Branch,
                    name: "feature".into(),
                    commit: String::new(),
                },
            ))
            .unwrap();
        let current = std::process::Command::new("git")
            .current_dir(root.path())
            .args(["branch", "--show-current"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "feature");
        let invalid = runtime.block_on(checkout_async(
            root.path().to_owned(),
            GitRef {
                kind: GitRefKind::Branch,
                name: "../outside".into(),
                commit: String::new(),
            },
        ));
        assert_eq!(invalid, Err("invalid_ref".into()));
    }

    #[test]
    fn builds_a_new_file_diff_for_untracked_text() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/new.txt"), "one\ntwo\n").unwrap();
        let diff = untracked_diff(root.path(), "src/new.txt").unwrap();
        assert!(diff.contains("new file mode 100644"));
        assert!(diff.contains("+one"));
        assert!(diff.contains("+two"));
        assert!(untracked_diff(root.path(), "../outside.txt")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn computes_a_stable_blob_id_for_diff_cache_keys() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "same content\n").unwrap();
        let first = worktree_blob_id(root.path(), "note.txt").unwrap();
        let second = worktree_blob_id(root.path(), "note.txt").unwrap();
        assert_eq!(first, second);
        assert!(first.is_some());
        assert!(worktree_blob_id(root.path(), "../outside.txt").is_err());
    }

    #[test]
    fn rejects_unsafe_git_action_paths() {
        assert!(validate_relative_path("../outside.txt").is_err());
        assert!(validate_relative_path("C:/outside.txt").is_err());
        assert!(validate_relative_path("src/main.rs").is_ok());
    }

    #[test]
    fn merges_only_refreshed_paths_into_existing_status() {
        let mut current = GitStatus {
            entries: vec![
                GitEntry {
                    index: ' ',
                    worktree: 'M',
                    path: "a.txt".into(),
                },
                GitEntry {
                    index: ' ',
                    worktree: 'M',
                    path: "b.txt".into(),
                },
            ],
            ..Default::default()
        };
        current.merge_paths(
            GitStatus {
                entries: vec![GitEntry {
                    index: 'A',
                    worktree: ' ',
                    path: "a.txt".into(),
                }],
                ..Default::default()
            },
            &["a.txt".into()],
        );
        assert_eq!(
            current.entries,
            vec![
                GitEntry {
                    index: 'A',
                    worktree: ' ',
                    path: "a.txt".into()
                },
                GitEntry {
                    index: ' ',
                    worktree: 'M',
                    path: "b.txt".into()
                },
            ]
        );
    }

    #[test]
    fn loads_status_for_selected_paths_from_a_real_repository() {
        let root = tempfile::tempdir().unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            assert!(std::process::Command::new("git")
                .current_dir(root.path())
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        std::fs::write(root.path().join("a.txt"), "a\n").unwrap();
        std::fs::write(root.path().join("b.txt"), "b\n").unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(root.path())
            .args(["add", "."])
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .current_dir(root.path())
            .args(["commit", "-m", "initial"])
            .status()
            .unwrap()
            .success());
        std::fs::write(root.path().join("a.txt"), "changed\n").unwrap();
        std::fs::write(root.path().join("b.txt"), "changed\n").unwrap();
        let status = load_paths(root.path().to_owned(), &["a.txt".into()]).unwrap();
        assert_eq!(
            status
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt"]
        );
    }

    #[test]
    fn commits_staged_changes_with_a_message() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let root = tempfile::tempdir().unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            assert!(std::process::Command::new("git")
                .current_dir(root.path())
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        std::fs::write(root.path().join("note.txt"), "hello").unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(root.path())
            .args(["add", "--", "note.txt"])
            .status()
            .unwrap()
            .success());
        runtime
            .block_on(commit_async(root.path().to_owned(), "Add note".into()))
            .unwrap();
        let log = std::process::Command::new("git")
            .current_dir(root.path())
            .args(["log", "-1", "--pretty=%s"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&log.stdout).trim(), "Add note");
    }

    #[test]
    fn rejects_empty_commit_messages() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            runtime.block_on(commit_async(root.path().to_owned(), "  ".into())),
            Err("empty_commit_message".into())
        );
    }
}
