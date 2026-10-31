use gpui::{div, prelude::*, px, rgb};
use gpui_component::input::{Editor, EditorState};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitWorktree {
    pub path: PathBuf,
    pub branch: String,
    pub commit: String,
    pub bare: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Prompt {
    Create,
    Remove(PathBuf),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorktreeKind {
    MainRepository,
    LinkedWorktree,
    DeletedWorktree,
    Unknown,
}

pub fn session_namespace(project_id: &str, worktree_path: Option<&Path>) -> String {
    let base = format!("gpui-project-{project_id}");
    let Some(path) = worktree_path else {
        return base;
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy()
        .to_ascii_lowercase()
        .hash(&mut hasher);
    format!("{base}-wt-{:016x}", hasher.finish())
}

impl WorktreeKind {
    pub fn label_key(self) -> &'static str {
        match self {
            Self::MainRepository => "shell.worktree.main",
            Self::LinkedWorktree => "shell.worktree.linked",
            Self::DeletedWorktree => "shell.worktree.deleted",
            Self::Unknown => "shell.worktree.unknown",
        }
    }
}

pub fn classify(path: &Path) -> WorktreeKind {
    if !path.exists() {
        return WorktreeKind::DeletedWorktree;
    }
    let metadata = path.join(".git");
    if metadata.is_file() {
        WorktreeKind::LinkedWorktree
    } else if metadata.is_dir() {
        WorktreeKind::MainRepository
    } else {
        WorktreeKind::Unknown
    }
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 || name.starts_with('-') || name.ends_with('.') {
        return Err("invalid_worktree_name".into());
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err("invalid_worktree_name".into());
    }
    if ["CON", "PRN", "AUX", "NUL"].contains(&name.to_ascii_uppercase().as_str()) {
        return Err("invalid_worktree_name".into());
    }
    Ok(())
}

pub fn default_root(project_path: &Path) -> Result<PathBuf, String> {
    let parent = project_path
        .parent()
        .ok_or_else(|| "invalid_project_path".to_owned())?;
    let name = project_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "invalid_project_path".to_owned())?;
    Ok(parent.join(format!("{name}-worktrees")))
}

pub fn list(project_path: &Path) -> Result<Vec<GitWorktree>, String> {
    let output = std::process::Command::new("git")
        .current_dir(project_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    parse_list(&String::from_utf8_lossy(&output.stdout))
}

pub async fn list_async(project_path: PathBuf) -> Result<Vec<GitWorktree>, String> {
    tokio::task::spawn_blocking(move || list(&project_path))
        .await
        .unwrap_or_else(|error| Err(error.to_string()))
}

pub fn create(
    project_path: &Path,
    root: &Path,
    name: &str,
    base_branch: Option<&str>,
) -> Result<GitWorktree, String> {
    validate_name(name)?;
    let root = if root.as_os_str().is_empty() {
        default_root(project_path)?
    } else {
        root.to_owned()
    };
    let target = root.join(name);
    if target.exists() {
        return Err("worktree_path_exists".into());
    }
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let branch = name.to_owned();
    let check = std::process::Command::new("git")
        .current_dir(project_path)
        .args(["check-ref-format", "--branch", &branch])
        .output()
        .map_err(|error| error.to_string())?;
    if !check.status.success() {
        return Err("invalid_worktree_branch".into());
    }
    let base = base_branch
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("HEAD");
    let output = std::process::Command::new("git")
        .current_dir(project_path)
        .args([
            "worktree",
            "add",
            "-b",
            &branch,
            &target.to_string_lossy(),
            base,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(GitWorktree {
        path: target,
        branch,
        commit: String::new(),
        bare: false,
    })
}

pub async fn create_async(
    project_path: PathBuf,
    root: PathBuf,
    name: String,
    base_branch: Option<String>,
) -> Result<GitWorktree, String> {
    tokio::task::spawn_blocking(move || create(&project_path, &root, &name, base_branch.as_deref()))
        .await
        .unwrap_or_else(|error| Err(error.to_string()))
}

pub fn remove(project_path: &Path, target: &Path) -> Result<(), String> {
    let entries = list(project_path)?;
    let target = target.canonicalize().map_err(|error| error.to_string())?;
    if !entries.iter().any(|entry| {
        entry.path.canonicalize().ok().as_ref() == Some(&target)
            && !entry.bare
            && entry.path != project_path
    }) {
        return Err("worktree_not_registered".into());
    }
    let output = std::process::Command::new("git")
        .current_dir(project_path)
        .args(["worktree", "remove", "--", &target.to_string_lossy()])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

pub async fn remove_async(project_path: PathBuf, target: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || remove(&project_path, &target))
        .await
        .unwrap_or_else(|error| Err(error.to_string()))
}

pub fn start_load(
    shell: &mut crate::DesktopShell,
    project_path: PathBuf,
    generation: u64,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let task = shell._runtime.spawn(list_async(project_path));
    cx.spawn(async move |this, cx| {
        let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
        let _ = this.update(cx, |this, cx| {
            if this.worktree_load_generation != generation {
                return;
            }
            this.worktree_entries = result.unwrap_or_default();
            cx.notify();
        });
    })
    .detach();
}

pub fn begin_create(
    shell: &mut crate::DesktopShell,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    shell
        .file_operation_editor
        .update(cx, |editor, cx| editor.set_value("", window, cx));
    shell.worktree_prompt = Some(Prompt::Create);
    shell.worktree_error = None;
    cx.notify();
}

pub fn request_remove(
    shell: &mut crate::DesktopShell,
    target: PathBuf,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    shell.worktree_prompt = Some(Prompt::Remove(target));
    shell.worktree_error = None;
    cx.notify();
}

pub fn cancel(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    shell.worktree_prompt = None;
    shell.worktree_error = None;
    cx.notify();
}

pub fn confirm(shell: &mut crate::DesktopShell, cx: &mut gpui::Context<crate::DesktopShell>) {
    let Some(prompt) = shell.worktree_prompt.clone() else {
        return;
    };
    let Some(project_path) = (match &shell.file_tree {
        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let refresh_path = project_path.clone();
    let task = match prompt {
        Prompt::Create => {
            let name = shell
                .file_operation_editor
                .read(cx)
                .value()
                .trim()
                .to_owned();
            if name.is_empty() {
                shell.worktree_error = Some(shell.message("shell.worktree.nameRequired"));
                cx.notify();
                return;
            }
            shell._runtime.spawn(async move {
                create_async(project_path, PathBuf::new(), name, None)
                    .await
                    .map(|_| ())
            })
        }
        Prompt::Remove(target) => shell._runtime.spawn(remove_async(project_path, target)),
    };
    cx.spawn(async move |this, cx| {
        let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
        let _ = this.update(cx, |this, cx| match result {
            Ok(_) => {
                this.worktree_prompt = None;
                this.worktree_error = None;
                this.worktree_load_generation = this.worktree_load_generation.wrapping_add(1);
                start_load(this, refresh_path, this.worktree_load_generation, cx);
            }
            Err(error) => {
                this.worktree_error = Some(error);
                cx.notify();
            }
        });
    })
    .detach();
}

pub fn prompt_view<F, G>(
    prompt: Option<&Prompt>,
    input: &gpui::Entity<EditorState>,
    title: String,
    create_title: String,
    remove_message: String,
    confirm_label: String,
    cancel_label: String,
    error: Option<&str>,
    on_confirm: F,
    on_cancel: G,
) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
{
    let Some(prompt) = prompt else {
        return div();
    };
    let body = match prompt {
        Prompt::Create => div()
            .child(create_title)
            .child(Editor::new(input).h(px(36.))),
        Prompt::Remove(target) => div().child(format!("{remove_message}: {}", target.display())),
    };
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .bg(rgb(0x252c36))
        .px(px(8.))
        .py(px(8.))
        .child(title)
        .child(body)
        .when_some(error.map(str::to_owned), |element, error| {
            element.child(error)
        })
        .child(
            div()
                .flex()
                .gap(px(6.))
                .child(
                    div()
                        .id("worktree-confirm")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_confirm(window, app))
                        .child(confirm_label),
                )
                .child(
                    div()
                        .id("worktree-cancel")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_cancel(window, app))
                        .child(cancel_label),
                ),
        )
}

pub fn rows<F, G, H>(
    project_name: String,
    project_path: String,
    entries: &[GitWorktree],
    main_label: String,
    linked_label: String,
    deleted_label: String,
    unknown_label: String,
    title: String,
    create_label: String,
    remove_label: String,
    raised: u32,
    selected: Option<PathBuf>,
    selected_color: u32,
    on_create: F,
    on_remove: G,
    on_select: H,
) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(PathBuf, &mut gpui::Window, &mut gpui::App) + 'static,
    H: Fn(Option<PathBuf>, &mut gpui::Window, &mut gpui::App) + 'static,
{
    let remove = Arc::new(on_remove);
    let select = Arc::new(on_select);
    let body = div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child({
            let selected_main = selected
                .as_deref()
                .is_some_and(|path| path == Path::new(&project_path));
            let select_main = select.clone();
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .px(px(8.))
                .py(px(5.))
                .bg(rgb(if selected_main {
                    selected_color
                } else {
                    raised
                }))
                .id("worktree-main")
                .cursor_pointer()
                .on_click(move |_, window, app| select_main(None, window, app))
                .child(format!("{} · {}", project_name, main_label))
                .child(project_path)
        })
        .children(entries.iter().filter(|entry| !entry.bare).map(|entry| {
            let selected_entry = selected
                .as_deref()
                .is_some_and(|selected| selected == entry.path.as_path());
            let select_callback = select.clone();
            let select_path = entry.path.clone();
            let remove_callback = remove.clone();
            let remove_path = entry.path.clone();
            let kind = classify(&entry.path);
            let kind_label = match kind {
                WorktreeKind::MainRepository => &main_label,
                WorktreeKind::LinkedWorktree => &linked_label,
                WorktreeKind::DeletedWorktree => &deleted_label,
                WorktreeKind::Unknown => &unknown_label,
            };
            let name = entry
                .path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("worktree");
            let mut card = div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .px(px(8.))
                .py(px(5.))
                .bg(rgb(if selected_entry {
                    selected_color
                } else {
                    raised
                }))
                .id(gpui::ElementId::Name(
                    format!("worktree-select-{}", name).into(),
                ))
                .cursor_pointer()
                .on_click(move |_, window, app| {
                    select_callback(Some(select_path.clone()), window, app)
                })
                .child(format!("{} · {}", name, kind_label))
                .child(format!("{} · {}", entry.branch, entry.path.display()));
            if kind == WorktreeKind::LinkedWorktree {
                card = card.child(
                    div()
                        .id(gpui::ElementId::Name(
                            format!("worktree-remove-{}", name).into(),
                        ))
                        .px(px(4.))
                        .py(px(2.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| {
                            remove_callback(remove_path.clone(), window, app)
                        })
                        .child(remove_label.clone()),
                );
            }
            card
        }))
        .child(
            div()
                .id("worktree-create")
                .px(px(8.))
                .py(px(4.))
                .cursor_pointer()
                .on_click(move |_, window, app| on_create(window, app))
                .child(create_label),
        );
    div().flex().flex_col().gap(px(5.)).child(title).child(body)
}

pub fn parse_list(text: &str) -> Result<Vec<GitWorktree>, String> {
    let mut entries = Vec::new();
    let mut current: Option<GitWorktree> = None;
    let flush = |entries: &mut Vec<GitWorktree>, current: &mut Option<GitWorktree>| {
        if let Some(entry) = current.take() {
            entries.push(entry);
        }
    };
    for line in text.lines() {
        if line.is_empty() {
            flush(&mut entries, &mut current);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut entries, &mut current);
            current = Some(GitWorktree {
                path: PathBuf::from(path),
                branch: String::new(),
                commit: String::new(),
                bare: false,
            });
        } else if let Some(commit) = line.strip_prefix("HEAD ") {
            if let Some(entry) = current.as_mut() {
                entry.commit = commit.to_owned();
            }
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(entry) = current.as_mut() {
                entry.branch = branch.to_owned();
            }
        } else if line == "bare" {
            if let Some(entry) = current.as_mut() {
                entry.bare = true;
            }
        }
    }
    flush(&mut entries, &mut current);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn classifies_main_linked_deleted_and_unknown_paths() {
        let root = tempdir().unwrap();
        let main = root.path().join("main");
        let linked = root.path().join("linked");
        let unknown = root.path().join("unknown");
        fs::create_dir_all(main.join(".git")).unwrap();
        fs::create_dir_all(&linked).unwrap();
        fs::write(
            linked.join(".git"),
            "gitdir: ../main/.git/worktrees/linked\n",
        )
        .unwrap();
        fs::create_dir_all(&unknown).unwrap();
        assert_eq!(classify(&main), WorktreeKind::MainRepository);
        assert_eq!(classify(&linked), WorktreeKind::LinkedWorktree);
        assert_eq!(
            classify(&root.path().join("deleted")),
            WorktreeKind::DeletedWorktree
        );
        assert_eq!(classify(&unknown), WorktreeKind::Unknown);
    }

    #[test]
    fn validates_names_and_parses_git_worktree_list() {
        assert!(validate_name("task-1").is_ok());
        assert!(validate_name("../escape").is_err());
        assert!(validate_name("CON").is_err());
        let entries = parse_list("worktree C:/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree C:/repo-task\nHEAD def456\nbranch refs/heads/task\n").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].branch, "task");
        assert_eq!(entries[1].commit, "def456");
    }

    #[test]
    fn session_namespace_is_stable_and_separates_worktrees() {
        let main = session_namespace("project", None);
        let first = session_namespace("project", Some(Path::new("C:/repo-task")));
        let same = session_namespace("project", Some(Path::new("c:/REPO-TASK")));
        let second = session_namespace("project", Some(Path::new("C:/repo-other")));
        assert_eq!(main, "gpui-project-project");
        assert_eq!(first, same);
        assert_ne!(first, second);
        assert!(first.starts_with("gpui-project-project-wt-"));
    }

    #[test]
    fn creates_and_removes_a_real_worktree() {
        let root = tempdir().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            assert!(std::process::Command::new("git")
                .current_dir(&repo)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        fs::write(repo.join("note.txt"), "hello").unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(&repo)
            .args(["add", "note.txt"])
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .current_dir(&repo)
            .args(["commit", "-m", "initial"])
            .status()
            .unwrap()
            .success());
        let worktree_root = root.path().join("worktrees");
        let created = create(&repo, &worktree_root, "task-1", None).unwrap();
        assert!(created.path.is_dir());
        assert!(list(&repo)
            .unwrap()
            .iter()
            .any(|entry| entry.branch == "task-1"));
        remove(&repo, &created.path).unwrap();
        assert!(!created.path.exists());
    }
}
