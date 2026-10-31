use gpui::{div, prelude::*, px, rgb};
use gpui_component::input::{Editor, EditorState};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictSide {
    Base,
    Ours,
    Theirs,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictDocument {
    pub path: String,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub merged: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConflictState {
    pub document: Option<ConflictDocument>,
    pub files: Vec<String>,
    pub selected: Option<String>,
    pub drafts: HashMap<String, String>,
    pub error: Option<String>,
}

impl ConflictState {
    pub fn clear(&mut self) {
        self.document = None;
        self.files.clear();
        self.selected = None;
        self.drafts.clear();
        self.error = None;
    }
}

pub fn is_conflict_code(index: char, worktree: char) -> bool {
    matches!(
        (index, worktree),
        ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D')
    )
}

pub fn open(
    shell: &mut crate::DesktopShell,
    path: String,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    if let Some(document) = shell.conflicts.document.as_ref() {
        shell.conflicts.drafts.insert(
            document.path.clone(),
            shell.file_editor.read(cx).value().to_string(),
        );
    }
    let Some(root) = (match &shell.file_tree {
        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let drafts = shell.conflicts.drafts.clone();
    let selected_path = path.clone();
    let task = shell._runtime.spawn(async move {
        tokio::task::spawn_blocking(move || load_conflict(&root, &path, &drafts))
            .await
            .map_err(|error| error.to_string())?
    });
    let entity = cx.entity();
    window
        .spawn(cx, async move |cx| {
            let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
            let _ = cx.update(|window, cx| {
                let _ = entity.update(cx, |this, cx| {
                    match result {
                        Ok((files, document)) => {
                            this.file_editor.update(cx, |editor, cx| {
                                editor.set_value(document.merged.clone(), window, cx)
                            });
                            this.conflicts = ConflictState {
                                document: Some(document),
                                files,
                                selected: Some(selected_path),
                                drafts: this.conflicts.drafts.clone(),
                                error: None,
                            };
                        }
                        Err(error) => {
                            this.conflicts.document = None;
                            this.conflicts.files.clear();
                            this.conflicts.selected = None;
                            this.conflicts.error = Some(error);
                        }
                    }
                    cx.notify();
                });
            });
        })
        .detach();
}

pub fn take_side(
    shell: &mut crate::DesktopShell,
    side: ConflictSide,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(document) = shell.conflicts.document.as_mut() else {
        return;
    };
    document.merged = match side {
        ConflictSide::Base => document.base.clone(),
        ConflictSide::Ours => document.ours.clone(),
        ConflictSide::Theirs => document.theirs.clone(),
    };
    shell.file_editor.update(cx, |editor, cx| {
        editor.set_value(document.merged.clone(), window, cx)
    });
    cx.notify();
}

pub fn resolve(
    shell: &mut crate::DesktopShell,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let Some(mut document) = shell.conflicts.document.clone() else {
        return;
    };
    document.merged = shell.file_editor.read(cx).value().to_string();
    let Some(root) = (match &shell.file_tree {
        crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
        _ => None,
    }) else {
        return;
    };
    let project_id = shell.selected_project.clone();
    let resolved_path = document.path.clone();
    let drafts = shell.conflicts.drafts.clone();
    let task = shell._runtime.spawn(async move {
        tokio::task::spawn_blocking(move || {
            write_and_stage(&root, &document)?;
            let files = list_conflicts(&root)?;
            let next = files
                .first()
                .map(|path| load_conflict(&root, path, &drafts))
                .transpose()?;
            Ok::<_, String>((files, next))
        })
        .await
        .map_err(|error| error.to_string())?
    });
    let entity = cx.entity();
    window
        .spawn(cx, async move |cx| {
            let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
            let _ = cx.update(|window, cx| {
                let _ = entity.update(cx, |this, cx| {
                    match result {
                        Ok((files, Some((_, mut next)))) => {
                            this.conflicts.drafts.remove(&resolved_path);
                            let document = next.merged.clone();
                            this.file_editor
                                .update(cx, |editor, cx| editor.set_value(document, window, cx));
                            next.merged = this.file_editor.read(cx).value().to_string();
                            this.conflicts.document = Some(next);
                            this.conflicts.files = files;
                            this.conflicts.selected =
                                this.conflicts.document.as_ref().map(|doc| doc.path.clone());
                            this.conflicts.error = None;
                            if let (
                                Some(project_id),
                                crate::files::FileTreeState::Ready { root, .. },
                            ) = (project_id.as_deref(), &this.file_tree)
                            {
                                crate::git::start_load(this, project_id, root.clone(), cx);
                            }
                        }
                        Ok((files, None)) => {
                            this.conflicts.drafts.remove(&resolved_path);
                            this.conflicts.clear();
                            if let (
                                Some(project_id),
                                crate::files::FileTreeState::Ready { root, .. },
                            ) = (project_id.as_deref(), &this.file_tree)
                            {
                                crate::git::start_load(this, project_id, root.clone(), cx);
                            }
                            debug_assert!(files.is_empty());
                        }
                        Err(error) => this.conflicts.error = Some(error),
                    }
                    cx.notify();
                });
            });
        })
        .detach();
}

pub fn view<F, G, H, I>(
    state: &ConflictState,
    editor: &gpui::Entity<EditorState>,
    title: String,
    error_label: String,
    base_label: String,
    ours_label: String,
    theirs_label: String,
    merged_label: String,
    resolve_label: String,
    close_label: String,
    on_take: F,
    on_resolve: G,
    on_close: H,
    on_select: I,
) -> impl IntoElement
where
    F: Fn(ConflictSide, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    G: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    H: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    I: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
{
    let Some(document) = state.document.as_ref() else {
        return div().when_some(state.error.clone(), |element, error| {
            element.child(format!("{error_label}: {error}"))
        });
    };
    let take = Arc::new(on_take);
    let select = Arc::new(on_select);
    let side = |name: String, content: &str, conflict_side: ConflictSide| {
        let callback = take.clone();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w(px(0.))
            .gap(px(3.))
            .child(name.clone())
            .child(
                div()
                    .bg(rgb(0x171c24))
                    .px(px(5.))
                    .py(px(5.))
                    .child(preview(content)),
            )
            .child(
                div()
                    .id(gpui::ElementId::Name(
                        format!("conflict-take-{conflict_side:?}").into(),
                    ))
                    .px(px(5.))
                    .py(px(3.))
                    .cursor_pointer()
                    .on_click(move |_, window, app| callback(conflict_side, window, app))
                    .child(format!("{name} ✓")),
            )
    };
    let files = state.files.iter().map(|path| {
        let callback = select.clone();
        let selected = state.selected.as_deref() == Some(path.as_str());
        div()
            .id(gpui::ElementId::Name(
                format!("conflict-file-{path}").into(),
            ))
            .when(selected, |element| element.bg(rgb(0x2d3748)))
            .px(px(5.))
            .py(px(3.))
            .cursor_pointer()
            .on_click({
                let path = path.clone();
                move |_, window, app| callback(path.clone(), window, app)
            })
            .child(path.clone())
    });
    div()
        .flex()
        .gap(px(5.))
        .child(
            div()
                .flex()
                .flex_col()
                .w(px(220.))
                .gap(px(2.))
                .children(files),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .gap(px(5.))
                .child(format!("{title}: {}", document.path))
                .child(
                    div()
                        .flex()
                        .gap(px(5.))
                        .child(side(base_label, &document.base, ConflictSide::Base))
                        .child(side(ours_label, &document.ours, ConflictSide::Ours))
                        .child(side(theirs_label, &document.theirs, ConflictSide::Theirs)),
                )
                .child(merged_label)
                .child(
                    div()
                        .bg(rgb(0x202833))
                        .px(px(5.))
                        .py(px(5.))
                        .child(Editor::new(editor).h(px(180.))),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(5.))
                        .child(
                            div()
                                .id("conflict-resolve")
                                .px(px(6.))
                                .py(px(3.))
                                .cursor_pointer()
                                .on_click(move |_, window, app| on_resolve(window, app))
                                .child(resolve_label),
                        )
                        .child(
                            div()
                                .id("conflict-close")
                                .px(px(6.))
                                .py(px(3.))
                                .cursor_pointer()
                                .on_click(move |_, window, app| on_close(window, app))
                                .child(close_label),
                        ),
                ),
        )
}

fn preview(content: &str) -> String {
    const MAX_PREVIEW_BYTES: usize = 12 * 1024;
    if content.len() <= MAX_PREVIEW_BYTES {
        return content.to_owned();
    }
    let mut end = MAX_PREVIEW_BYTES;
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &content[..end])
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
        || relative == ".git"
        || relative.starts_with(".git/")
    {
        return Err("unsafe_conflict_path".into());
    }
    Ok(root.join(path))
}

fn git_blob(root: &Path, spec: &str, path: &str) -> Result<String, String> {
    let object = format!("{spec}:{path}");
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(["show", object.as_str()])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Ok(String::new());
    }
    String::from_utf8(output.stdout).map_err(|_| "conflict_binary_file".into())
}

fn load_document(root: &Path, path: &str) -> Result<ConflictDocument, String> {
    let path_on_disk = safe_path(root, path)?;
    let ours = git_blob(root, ":2", path)?;
    let theirs = git_blob(root, ":3", path)?;
    let base = git_blob(root, ":1", path)?;
    let merged = std::fs::read_to_string(path_on_disk).map_err(|error| error.to_string())?;
    Ok(ConflictDocument {
        path: path.into(),
        base,
        ours,
        theirs,
        merged,
    })
}

fn load_conflict(
    root: &Path,
    path: &str,
    drafts: &HashMap<String, String>,
) -> Result<(Vec<String>, ConflictDocument), String> {
    let files = list_conflicts(root)?;
    if !files.iter().any(|candidate| candidate == path) {
        return Err("conflict_file_not_found".into());
    }
    let mut document = load_document(root, path)?;
    if let Some(draft) = drafts.get(path) {
        document.merged = draft.clone();
    }
    Ok((files, document))
}

fn list_conflicts(root: &Path) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(["ls-files", "-u", "-z"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let mut files = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            record
                .iter()
                .position(|byte| *byte == b'\t')
                .map(|index| &record[index + 1..])
        })
        .map(|path| String::from_utf8(path.to_vec()).map_err(|_| "conflict_binary_file".to_owned()))
        .collect::<Result<Vec<_>, _>>()?;
    files.sort();
    files.dedup();
    Ok(files)
}

fn write_and_stage(root: &Path, document: &ConflictDocument) -> Result<(), String> {
    let path = safe_path(root, &document.path)?;
    std::fs::write(path, &document.merged).map_err(|error| error.to_string())?;
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(["add", "--", document.path.as_str()])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_codes_match_unmerged_git_entries() {
        assert!(is_conflict_code('U', 'U'));
        assert!(is_conflict_code('A', 'A'));
        assert!(is_conflict_code('D', 'D'));
        assert!(!is_conflict_code(' ', 'M'));
    }

    #[test]
    fn safe_paths_reject_metadata_and_parent_escape() {
        let root = Path::new("C:/repo");
        assert!(safe_path(root, "src/main.rs").is_ok());
        assert!(safe_path(root, "../outside.rs").is_err());
        assert!(safe_path(root, ".git/index").is_err());
    }

    #[test]
    fn preview_is_bounded_without_splitting_utf8() {
        let value = "界".repeat(10_000);
        assert!(preview(&value).len() <= 12 * 1024 + "\n…".len());
        assert!(preview(&value).ends_with("\n…"));
    }

    #[test]
    fn loads_three_stages_and_stages_a_resolved_file() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "test@example.com"]);
        run_git(root, &["config", "user.name", "Test"]);
        std::fs::write(root.join("conflict.txt"), "base\n").unwrap();
        run_git(root, &["add", "conflict.txt"]);
        run_git(root, &["commit", "-m", "base"]);
        run_git(root, &["switch", "-c", "incoming"]);
        std::fs::write(root.join("conflict.txt"), "incoming\n").unwrap();
        run_git(root, &["commit", "-am", "incoming"]);
        run_git(root, &["switch", "master"]);
        std::fs::write(root.join("conflict.txt"), "current\n").unwrap();
        run_git(root, &["commit", "-am", "current"]);
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(["merge", "incoming"])
            .output()
            .unwrap();
        assert!(!output.status.success());

        assert_eq!(list_conflicts(root).unwrap(), vec!["conflict.txt"]);
        let drafts = HashMap::from([(String::from("conflict.txt"), String::from("draft\n"))]);
        let (_, draft_document) = load_conflict(root, "conflict.txt", &drafts).unwrap();
        assert_eq!(draft_document.merged, "draft\n");
        let document = load_document(root, "conflict.txt").unwrap();
        assert_eq!(document.base, "base\n");
        assert_eq!(document.ours, "current\n");
        assert_eq!(document.theirs, "incoming\n");
        assert!(document.merged.contains("<<<<<<<"));

        let resolved = ConflictDocument {
            merged: "resolved\n".into(),
            ..document
        };
        write_and_stage(root, &resolved).unwrap();
        let staged = run_git(root, &["diff", "--cached", "--name-only"]);
        assert_eq!(staged.trim(), "conflict.txt");
    }

    #[test]
    fn stages_one_file_and_keeps_the_next_conflict_with_its_draft() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "test@example.com"]);
        run_git(root, &["config", "user.name", "Test"]);
        std::fs::write(root.join("a.txt"), "base-a\n").unwrap();
        std::fs::write(root.join("b.txt"), "base-b\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "base"]);
        run_git(root, &["switch", "-c", "incoming"]);
        std::fs::write(root.join("a.txt"), "incoming-a\n").unwrap();
        std::fs::write(root.join("b.txt"), "incoming-b\n").unwrap();
        run_git(root, &["commit", "-am", "incoming"]);
        run_git(root, &["switch", "master"]);
        std::fs::write(root.join("a.txt"), "current-a\n").unwrap();
        std::fs::write(root.join("b.txt"), "current-b\n").unwrap();
        run_git(root, &["commit", "-am", "current"]);
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(["merge", "incoming"])
            .output()
            .unwrap();
        assert!(!output.status.success());

        assert_eq!(list_conflicts(root).unwrap(), vec!["a.txt", "b.txt"]);
        let a = load_document(root, "a.txt").unwrap();
        write_and_stage(
            root,
            &ConflictDocument {
                merged: "resolved-a\n".into(),
                ..a
            },
        )
        .unwrap();
        let remaining = list_conflicts(root).unwrap();
        assert_eq!(remaining, vec!["b.txt"]);
        let drafts = HashMap::from([(String::from("b.txt"), String::from("draft-b\n"))]);
        let (_, next) = load_conflict(root, "b.txt", &drafts).unwrap();
        assert_eq!(next.merged, "draft-b\n");
    }

    fn run_git(root: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }
}
