use super::*;

pub fn view<F, G, H, I, J, K, L, M>(
    state: &GitState,
    title: String,
    loading: String,
    empty: String,
    failed: String,
    refs_title: String,
    branch_label: String,
    tag_label: String,
    refs_empty: String,
    checkout_label: String,
    commit_label: String,
    stage_label: String,
    unstage_label: String,
    discard_label: String,
    diff_label: String,
    entry_offset: usize,
    on_checkout: F,
    on_commit: G,
    on_file: H,
    on_stage: I,
    on_unstage: J,
    on_discard: K,
    on_diff: L,
    on_scroll: M,
) -> impl IntoElement
where
    F: Fn(GitRef, &mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    H: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
    I: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
    J: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
    K: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
    L: Fn(String, &mut gpui::Window, &mut gpui::App) + 'static,
    M: Fn(i32, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
{
    let body = match state {
        GitState::Empty => div().child(empty),
        GitState::Loading => div().child(loading),
        GitState::Failed(reason) => div().child(format!("{failed}: {reason}")),
        GitState::Ready(status) => {
            let summary = format!(
                "{} · +{} -{} · {}",
                status.branch,
                status.ahead,
                status.behind,
                status.entries.len()
            );
            let commit: Arc<dyn Fn(&mut gpui::Window, &mut gpui::App)> = Arc::new(on_commit);
            let callback = Arc::new(on_file);
            let stage: Arc<dyn Fn(String, &mut gpui::Window, &mut gpui::App)> = Arc::new(on_stage);
            let unstage: Arc<dyn Fn(String, &mut gpui::Window, &mut gpui::App)> =
                Arc::new(on_unstage);
            let discard: Arc<dyn Fn(String, &mut gpui::Window, &mut gpui::App)> =
                Arc::new(on_discard);
            let diff: Arc<dyn Fn(String, &mut gpui::Window, &mut gpui::App)> = Arc::new(on_diff);
            let has_staged = status
                .entries
                .iter()
                .any(|entry| entry.index != ' ' && entry.index != '?');
            let refs = refs_view(
                &status.refs,
                refs_title,
                branch_label,
                tag_label,
                refs_empty,
                checkout_label,
                on_checkout,
            );
            let (start, end) = visible_entry_range(status.entries.len(), entry_offset);
            let rows = status.entries[start..end].iter().map(|entry| {
                let path = entry.path.clone();
                let callback = callback.clone();
                let action_callback = if entry.index == ' ' {
                    stage.clone()
                } else {
                    unstage.clone()
                };
                let discard_callback = discard.clone();
                let diff_callback = diff.clone();
                let action_path = entry.path.clone();
                let discard_path = entry.path.clone();
                let diff_path = entry.path.clone();
                let action = if entry.index == ' ' {
                    stage_label.clone()
                } else {
                    unstage_label.clone()
                };
                div()
                    .id(gpui::ElementId::Name(format!("git-status-{}", path).into()))
                    .px(px(6.))
                    .py(px(3.))
                    .cursor_pointer()
                    .on_click(move |_, window, app| callback(path.clone(), window, app))
                    .child(format!("{}{} {}", entry.index, entry.worktree, entry.path))
                    .child(
                        div()
                            .id(gpui::ElementId::Name(
                                format!("git-action-{}", action_path).into(),
                            ))
                            .px(px(4.))
                            .py(px(2.))
                            .on_click(move |_, window, app| {
                                action_callback(action_path.clone(), window, app)
                            })
                            .child(action),
                    )
                    .when(entry.index != '?' || entry.worktree != '?', |element| {
                        element.child(
                            div()
                                .id(gpui::ElementId::Name(
                                    format!("git-discard-{}", discard_path).into(),
                                ))
                                .px(px(4.))
                                .py(px(2.))
                                .on_click(move |_, window, app| {
                                    discard_callback(discard_path.clone(), window, app)
                                })
                                .child(discard_label.clone()),
                        )
                    })
                    .child(
                        div()
                            .id(gpui::ElementId::Name(
                                format!("git-diff-{}", diff_path).into(),
                            ))
                            .px(px(4.))
                            .py(px(2.))
                            .on_click(move |_, window, app| {
                                diff_callback(diff_path.clone(), window, app)
                            })
                            .child(diff_label.clone()),
                    )
            });
            let scroll_handler = on_scroll.clone();
            let scroll_input =
                move |event: &ScrollEvent, window: &mut gpui::Window, app: &mut gpui::App| {
                    let lines = match event.delta {
                        ScrollDelta::Lines(delta) => delta.y.round() as i32,
                        ScrollDelta::Pixels(delta) => (delta.y.as_f32() / 28.0).round() as i32,
                    };
                    if lines != 0 {
                        scroll_handler(-lines.saturating_mul(8), window, app);
                    }
                };
            let list = div()
                .flex()
                .flex_col()
                .min_h(px(0.))
                .overflow_y_scrollbar()
                .on_scroll(scroll_input)
                .child(div().h(px(start as f32 * 28.)))
                .children(rows)
                .child(div().h(px((status.entries.len().saturating_sub(end)) as f32 * 28.)));
            div()
                .flex()
                .flex_col()
                .gap(px(3.))
                .child(summary)
                .child(refs)
                .child(list)
                .when(has_staged, |element| {
                    element.child(
                        div()
                            .id("git-commit")
                            .px(px(6.))
                            .py(px(3.))
                            .cursor_pointer()
                            .on_click(move |_, window, app| commit(window, app))
                            .child(commit_label),
                    )
                })
        }
    };
    div().flex().flex_col().gap(px(5.)).child(title).child(body)
}

pub fn checkout_prompt(
    reference: Option<&GitRef>,
    title: String,
    message: String,
    confirm: String,
    cancel: String,
    on_confirm: impl Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    on_cancel: impl Fn(&mut gpui::Window, &mut gpui::App) + 'static,
) -> impl IntoElement {
    let Some(reference) = reference else {
        return div();
    };
    div()
        .flex()
        .flex_col()
        .gap(px(5.))
        .bg(gpui::rgb(0x252c36))
        .px(px(8.))
        .py(px(8.))
        .child(title)
        .child(format!("{message}: {}", reference.name))
        .child(
            div()
                .flex()
                .gap(px(6.))
                .child(
                    div()
                        .id("git-checkout-confirm")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_confirm(window, app))
                        .child(confirm),
                )
                .child(
                    div()
                        .id("git-checkout-cancel")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_cancel(window, app))
                        .child(cancel),
                ),
        )
}

fn refs_view<F>(
    refs: &[GitRef],
    title: String,
    branch_label: String,
    tag_label: String,
    empty: String,
    checkout_label: String,
    on_checkout: F,
) -> impl IntoElement
where
    F: Fn(GitRef, &mut gpui::Window, &mut gpui::App) + 'static,
{
    let checkout = Arc::new(on_checkout);
    let body = if refs.is_empty() {
        div().child(empty)
    } else {
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .children(refs.iter().map(|reference| {
                let kind = match reference.kind {
                    GitRefKind::Branch => branch_label.clone(),
                    GitRefKind::Tag => tag_label.clone(),
                };
                let reference = reference.clone();
                let callback = checkout.clone();
                div()
                    .flex()
                    .gap(px(4.))
                    .child(format!("{kind} {} · {}", reference.name, reference.commit))
                    .child(
                        div()
                            .id(gpui::ElementId::Name(
                                format!("git-checkout-{}", reference.name).into(),
                            ))
                            .px(px(4.))
                            .py(px(2.))
                            .cursor_pointer()
                            .on_click(move |_, window, app| {
                                callback(reference.clone(), window, app)
                            })
                            .child(checkout_label.clone()),
                    )
            }))
    };
    div().flex().flex_col().gap(px(2.)).child(title).child(body)
}

pub fn commit_prompt<F, G>(
    visible: bool,
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
    if !visible {
        return div();
    }
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .bg(gpui::rgb(0x252c36))
        .px(px(8.))
        .py(px(8.))
        .child(title)
        .child(Editor::new(input).h(px(50.)))
        .when_some(error.map(str::to_owned), |element, error| {
            element.child(error)
        })
        .child(
            div()
                .flex()
                .gap(px(6.))
                .child(
                    div()
                        .id("git-commit-confirm")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_confirm(window, app))
                        .child(confirm),
                )
                .child(
                    div()
                        .id("git-commit-cancel")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_cancel(window, app))
                        .child(cancel),
                ),
        )
}

pub fn discard_prompt<F, G>(
    path: Option<&str>,
    title: String,
    message: String,
    confirm: String,
    cancel: String,
    on_confirm: F,
    on_cancel: G,
) -> impl IntoElement
where
    F: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
    G: Fn(&mut gpui::Window, &mut gpui::App) + 'static,
{
    let Some(path) = path else {
        return div();
    };
    div()
        .flex()
        .flex_col()
        .gap(px(5.))
        .child(title)
        .child(format!("{message}: {path}"))
        .child(
            div()
                .flex()
                .gap(px(6.))
                .child(
                    div()
                        .id("git-revert-confirm")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_confirm(window, app))
                        .child(confirm),
                )
                .child(
                    div()
                        .id("git-revert-cancel")
                        .px(px(8.))
                        .py(px(4.))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_cancel(window, app))
                        .child(cancel),
                ),
        )
}

pub fn diff_view(
    state: &DiffState,
    highlighted_lines: Option<&[HighlightedDiffLine]>,
    title: String,
    loading: String,
    empty: String,
    failed: String,
    line_offset: usize,
    on_scroll: impl Fn(i32, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
) -> impl IntoElement {
    let body = match state {
        DiffState::Empty => div().child(empty),
        DiffState::Loading => div().child(loading),
        DiffState::Failed(reason) => div().child(format!("{failed}: {reason}")),
        DiffState::Ready { path, text } => {
            let lines = highlighted_lines
                .map(|lines| lines.to_vec())
                .unwrap_or_else(|| highlight_diff(text));
            let (start, end) = visible_diff_range(lines.len(), line_offset);
            let scroll_handler = on_scroll.clone();
            let scroll_input =
                move |event: &ScrollEvent, window: &mut gpui::Window, app: &mut gpui::App| {
                    let lines = match event.delta {
                        ScrollDelta::Lines(delta) => delta.y.round() as i32,
                        ScrollDelta::Pixels(delta) => (delta.y.as_f32() / 20.0).round() as i32,
                    };
                    if lines != 0 {
                        scroll_handler(-lines.saturating_mul(8), window, app);
                    }
                };
            let list = div()
                .flex()
                .flex_col()
                .min_h(px(0.))
                .overflow_y_scrollbar()
                .on_scroll(scroll_input)
                .child(div().h(px(start as f32 * 20.)))
                .children(lines[start..end].iter().map(|line| {
                    let color = match line.kind {
                        DiffLineKind::Added => 0x7bd88f,
                        DiffLineKind::Removed => 0xff8b8b,
                        DiffLineKind::Header => 0x9db7ff,
                        DiffLineKind::Hunk => 0xd7b7ff,
                        DiffLineKind::Context => 0xe8edf4,
                    };
                    div()
                        .text_color(gpui::rgb(color))
                        .child(styled_diff_line(line, color))
                }))
                .child(div().h(px((lines.len().saturating_sub(end)) as f32 * 20.)));
            div()
                .flex()
                .flex_col()
                .gap(px(1.))
                .child(path.clone())
                .child(list)
        }
    };
    div().flex().flex_col().gap(px(5.)).child(title).child(body)
}
