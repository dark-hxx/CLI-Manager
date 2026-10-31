use crate::history::{HistoryState, SourceFilter, TimeFilter};
use gpui::{div, prelude::*, px, rgb, Div, Entity};
use gpui_component::input::{Editor, EditorState};

#[derive(Debug, Default)]
pub(crate) struct StatsState {
    pub(crate) request_log_summary: cli_manager_core_db::projects::RequestLogSummary,
    pub(crate) request_log_breakdown: Vec<cli_manager_core_db::projects::RequestLogBreakdown>,
    pub(crate) request_log_entries: Vec<cli_manager_core_db::projects::RequestLogEntry>,
    pub(crate) project_efficiency: cli_manager_core_db::projects::ProjectEfficiency,
    pub(crate) source_filter: SourceFilter,
    pub(crate) time_filter: TimeFilter,
    pub(crate) history_rows: Vec<crate::history::HistoryRow>,
    pub(crate) project_filter: Option<String>,
    pub(crate) extensions: Vec<cli_manager_core_db::extensions::ExtensionOverview>,
    pub(crate) extensions_loading: bool,
    pub(crate) extensions_error: Option<String>,
    pub(crate) extension_load_generation: u64,
    pub(crate) extension_delete_pending: Option<String>,
    pub(crate) extension_rename_draft: Option<(String, String)>,
    pub(crate) extension_rename_error: Option<String>,
    pub(crate) extension_rename_editor: Option<Entity<EditorState>>,
}

impl StatsState {
    pub(crate) fn rename_editor(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<crate::DesktopShell>,
    ) -> Entity<EditorState> {
        self.extension_rename_editor
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    EditorState::new(window, cx)
                        .language("plaintext")
                        .default_value("")
                })
            })
            .clone()
    }
}

pub(crate) fn extension_view(
    items: &[cli_manager_core_db::extensions::ExtensionOverview],
    title: String,
    empty: String,
    loading: bool,
    loading_label: String,
    error: Option<String>,
    mcp_label: String,
    skill_label: String,
    installation_label: String,
    managed_label: String,
    owned_label: String,
    external_modified_label: String,
    unowned_label: String,
    delete_label: String,
    confirm_delete_label: String,
    cancel_label: String,
    cli_labels: [String; 3],
    pending_delete: Option<&str>,
    on_delete: impl Fn(String, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    on_confirm_delete: impl Fn(String, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    on_cancel_delete: impl Fn(&mut gpui::Window, &mut gpui::App) + Clone + 'static,
    on_toggle_cli: impl Fn(String, String, bool, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    rename_draft: Option<&(String, String)>,
    rename_error: Option<&str>,
    rename_label: String,
    save_label: String,
    on_rename: impl Fn(String, String, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    on_save_rename: impl Fn(String, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    on_cancel_rename: impl Fn(&mut gpui::Window, &mut gpui::App) + Clone + 'static,
    rename_editor: &Entity<EditorState>,
    surface: u32,
    raised: u32,
    text: u32,
) -> Div {
    let body = if items.is_empty() && !loading && error.is_none() {
        div().child(empty)
    } else {
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .children(items.iter().map(|item| {
                let kind = match item.kind.as_str() {
                    "mcp" => mcp_label.clone(),
                    "skill" => skill_label.clone(),
                    "skill-installation" => installation_label.clone(),
                    _ => item.kind.clone(),
                };
                let status = match item.status.as_str() {
                    "managed" => managed_label.clone(),
                    "owned" => owned_label.clone(),
                    "externalModified" => external_modified_label.clone(),
                    "unowned" => unowned_label.clone(),
                    _ => item.status.clone(),
                };
                let confirm_id = item.item_id.clone();
                let delete_id = item.item_id.clone();
                let item_id = item.item_id.clone();
                let on_delete = on_delete.clone();
                let on_confirm_delete = on_confirm_delete.clone();
                let on_cancel_delete = on_cancel_delete.clone();
                let on_rename = on_rename.clone();
                let on_save_rename = on_save_rename.clone();
                let on_cancel_rename = on_cancel_rename.clone();
                let is_pending = pending_delete == Some(item.item_id.as_str());
                let row_is_renaming = rename_draft.is_some_and(|(id, _)| id == &item.item_id);
                let rename_controls = if item.kind == "mcp" && row_is_renaming {
                    let (id, _) = rename_draft.expect("checked above");
                    let id = id.clone();
                    let cancel_label = cancel_label.clone();
                    let save_label = save_label.clone();
                    let rename_editor = rename_editor.clone();
                    let on_save_enter = on_save_rename.clone();
                    div()
                        .flex()
                        .gap(px(5.))
                        .child(Editor::new(&rename_editor).h(px(36.)))
                        .child(
                            div()
                                .id(gpui::ElementId::Name(
                                    format!("extension-rename-save-{id}").into(),
                                ))
                                .cursor_pointer()
                                .on_click({
                                    let id = id.clone();
                                    let on_save_enter = on_save_enter.clone();
                                    move |_, window, app| on_save_enter(id.clone(), window, app)
                                })
                                .child(save_label),
                        )
                        .child(
                            div()
                                .id(gpui::ElementId::Name(
                                    format!("extension-rename-cancel-{id}").into(),
                                ))
                                .cursor_pointer()
                                .on_click(move |_, window, app| on_cancel_rename(window, app))
                                .child(cancel_label),
                        )
                } else if item.kind == "mcp" {
                    let id = item.item_id.clone();
                    let name = item.name.clone();
                    let rename_label = rename_label.clone();
                    let on_rename = on_rename.clone();
                    div().child(
                        div()
                            .id(gpui::ElementId::Name(
                                format!("extension-rename-{id}").into(),
                            ))
                            .cursor_pointer()
                            .on_click(move |_, window, app| {
                                on_rename(id.clone(), name.clone(), window, app)
                            })
                            .child(rename_label),
                    )
                } else {
                    div()
                };
                let actions = if item.kind == "mcp" {
                    let toggle_buttons = ["claude", "codex", "grok"]
                        .into_iter()
                        .zip(cli_labels.iter().cloned())
                        .map(|(cli, label)| {
                            let on_toggle_cli = on_toggle_cli.clone();
                            let resource_id = item.item_id.clone();
                            let enabled = item.enabled_for(cli);
                            div()
                                .id(gpui::ElementId::Name(
                                    format!("extension-toggle-{cli}-{}", item.item_id).into(),
                                ))
                                .cursor_pointer()
                                .child(format!("{} {}", label, if enabled { "✓" } else { "○" }))
                                .on_click(move |_, window, app| {
                                    on_toggle_cli(
                                        resource_id.clone(),
                                        cli.to_string(),
                                        !enabled,
                                        window,
                                        app,
                                    )
                                })
                        })
                        .collect::<Vec<_>>();
                    if is_pending {
                        let confirm_label = confirm_delete_label.clone();
                        let cancel_label = cancel_label.clone();
                        div()
                            .flex()
                            .gap(px(6.))
                            .child(div().flex().gap(px(6.)).children(toggle_buttons))
                            .child(
                                div()
                                    .id(gpui::ElementId::Name(
                                        format!("extension-confirm-{confirm_id}").into(),
                                    ))
                                    .cursor_pointer()
                                    .on_click(move |_, window, app| {
                                        on_confirm_delete(confirm_id.clone(), window, app)
                                    })
                                    .child(confirm_label),
                            )
                            .child(
                                div()
                                    .id(gpui::ElementId::Name(
                                        format!("extension-cancel-{item_id}").into(),
                                    ))
                                    .cursor_pointer()
                                    .on_click(move |_, window, app| on_cancel_delete(window, app))
                                    .child(cancel_label),
                            )
                    } else {
                        let delete_label = delete_label.clone();
                        div()
                            .flex()
                            .gap(px(6.))
                            .child(div().flex().gap(px(6.)).children(toggle_buttons))
                            .child(
                                div()
                                    .id(gpui::ElementId::Name(
                                        format!("extension-delete-{delete_id}").into(),
                                    ))
                                    .cursor_pointer()
                                    .on_click(move |_, window, app| {
                                        on_delete(delete_id.clone(), window, app)
                                    })
                                    .child(delete_label),
                            )
                    }
                } else {
                    div()
                };
                div()
                    .flex()
                    .justify_between()
                    .px(px(10.))
                    .py(px(8.))
                    .bg(rgb(surface))
                    .border(px(1.))
                    .border_color(rgb(raised))
                    .text_color(rgb(text))
                    .child(format!("{} · {}", kind, item.name))
                    .child(format!("{} · {}", status, item.source))
                    .child(rename_controls)
                    .child(actions)
            }))
            .children(
                error
                    .into_iter()
                    .chain(rename_error.map(str::to_owned))
                    .chain(loading.then_some(loading_label))
                    .map(|message| div().child(message)),
            )
    };
    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .w(px(560.))
        .p(px(18.))
        .bg(rgb(surface))
        .text_color(rgb(text))
        .border(px(1.))
        .border_color(rgb(raised))
        .child(title)
        .child(body)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct StatsSummary {
    pub(crate) sessions: usize,
    pub(crate) messages: usize,
    pub(crate) claude: usize,
    pub(crate) codex: usize,
    pub(crate) starred: usize,
    pub(crate) activity: [usize; 7],
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cached_tokens: u64,
    pub(crate) input_activity: [u64; 7],
    pub(crate) output_activity: [u64; 7],
}

impl StatsSummary {
    pub(crate) fn from_history(history: &HistoryState) -> Self {
        Self::from_history_filtered(history, SourceFilter::All, TimeFilter::All)
    }

    pub(crate) fn from_history_filtered(
        history: &HistoryState,
        source_filter: SourceFilter,
        time_filter: TimeFilter,
    ) -> Self {
        Self::from_rows(&history.rows, &history.metadata, source_filter, time_filter)
    }

    pub(crate) fn from_rows(
        rows: &[crate::history::HistoryRow],
        metadata: &std::collections::HashMap<String, crate::history::HistoryMeta>,
        source_filter: SourceFilter,
        time_filter: TimeFilter,
    ) -> Self {
        let mut summary = Self::default();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        for row in rows {
            if !source_matches(row.source.as_str(), source_filter)
                || !time_matches(now_ms, row.updated_at, time_filter)
            {
                continue;
            }
            summary.sessions += 1;
            summary.messages = summary.messages.saturating_add(row.message_count);
            summary.input_tokens = summary.input_tokens.saturating_add(row.input_tokens);
            summary.output_tokens = summary.output_tokens.saturating_add(row.output_tokens);
            summary.cached_tokens = summary
                .cached_tokens
                .saturating_add(row.cache_read_tokens)
                .saturating_add(row.cache_creation_tokens);
            match row.source.as_str() {
                "claude" => summary.claude += 1,
                "codex" => summary.codex += 1,
                _ => {}
            }
            if metadata
                .get(&crate::history::metadata_key_for_row(row))
                .is_some_and(|meta| meta.starred)
            {
                summary.starred += 1;
            }
            if let Some(age_days) = activity_bucket(now_ms, row.updated_at) {
                summary.activity[age_days] += 1;
                summary.input_activity[age_days] =
                    summary.input_activity[age_days].saturating_add(row.input_tokens);
                summary.output_activity[age_days] =
                    summary.output_activity[age_days].saturating_add(row.output_tokens);
            }
        }
        summary
    }
}

pub(crate) fn view(
    summary: StatsSummary,
    title: String,
    sessions: String,
    messages: String,
    claude: String,
    codex: String,
    starred: String,
    activity_label: String,
    source_label: String,
    claude_percent_label: String,
    codex_percent_label: String,
    input_tokens_label: String,
    output_tokens_label: String,
    cached_tokens_label: String,
    requests_label: String,
    request_count: usize,
    request_breakdown: &[cli_manager_core_db::projects::RequestLogBreakdown],
    request_entries: &[cli_manager_core_db::projects::RequestLogEntry],
    request_entries_label: String,
    efficiency: cli_manager_core_db::projects::ProjectEfficiency,
    efficiency_label: String,
    requests_short_label: String,
    completed_label: String,
    tokens_short_label: String,
    duration_short_label: String,
    source_filter: SourceFilter,
    time_filter: TimeFilter,
    project_filter: Option<&str>,
    project_filters: Vec<(String, Option<String>)>,
    on_project_filter: impl Fn(Option<String>, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    source_filters: [(String, SourceFilter); 3],
    time_filters: [(String, TimeFilter); 3],
    on_source_filter: impl Fn(SourceFilter, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    on_time_filter: impl Fn(TimeFilter, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
    token_activity_label: String,
    input_trend_label: String,
    output_trend_label: String,
    day_labels: [String; 7],
    surface: u32,
    raised: u32,
    text: u32,
) -> Div {
    let max_activity = summary.activity.iter().copied().max().unwrap_or(0).max(1);
    let total_sources = summary.claude + summary.codex;
    let claude_ratio = if total_sources == 0 {
        0.0
    } else {
        summary.claude as f32 / total_sources as f32
    };
    let max_tokens = summary
        .input_activity
        .iter()
        .chain(summary.output_activity.iter())
        .copied()
        .max()
        .unwrap_or(0)
        .max(1);
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .w(px(560.))
        .p(px(18.))
        .bg(rgb(surface))
        .text_color(rgb(text))
        .border(px(1.))
        .border_color(rgb(raised))
        .child(title)
        .children([
            card(sessions, summary.sessions, raised),
            card(messages, summary.messages, raised),
            card(claude, summary.claude, raised),
            card(codex, summary.codex, raised),
            card(starred, summary.starred, raised),
            card(
                input_tokens_label.clone(),
                summary.input_tokens as usize,
                raised,
            ),
            card(
                output_tokens_label.clone(),
                summary.output_tokens as usize,
                raised,
            ),
            card(cached_tokens_label, summary.cached_tokens as usize, raised),
            card(requests_label.clone(), request_count, raised),
        ])
        .children(request_breakdown.iter().take(6).map(|item| {
            card(
                format!(
                    "{} {} · {} {} · {} {} · {} {}",
                    item.source,
                    if item.model.is_empty() {
                        "(unknown)"
                    } else {
                        item.model.as_str()
                    },
                    requests_label.clone(),
                    item.request_count.max(0) as usize,
                    input_tokens_label.clone(),
                    item.input_tokens.max(0) as usize,
                    output_tokens_label.clone(),
                    item.output_tokens.max(0) as usize,
                ),
                item.request_count.max(0) as usize,
                raised,
            )
        }))
        .child(
            div()
                .flex()
                .gap(px(6.))
                .children(source_filters.into_iter().map(|(label, filter)| {
                    let on_source_filter = on_source_filter.clone();
                    div()
                        .id(gpui::ElementId::Name(
                            format!("stats-source-{filter:?}").into(),
                        ))
                        .px(px(8.))
                        .py(px(5.))
                        .bg(rgb(if source_filter == filter {
                            raised
                        } else {
                            surface
                        }))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_source_filter(filter, window, app))
                        .child(label)
                }))
                .children(project_filters.into_iter().map(|(label, filter)| {
                    let on_project_filter = on_project_filter.clone();
                    let selected = project_filter == filter.as_deref();
                    div()
                        .id(gpui::ElementId::Name(
                            format!("stats-project-{label}").into(),
                        ))
                        .px(px(8.))
                        .py(px(5.))
                        .bg(rgb(if selected { raised } else { surface }))
                        .cursor_pointer()
                        .on_click(move |_, window, app| {
                            on_project_filter(filter.clone(), window, app)
                        })
                        .child(label)
                }))
                .children(time_filters.into_iter().map(|(label, filter)| {
                    let on_time_filter = on_time_filter.clone();
                    div()
                        .id(gpui::ElementId::Name(
                            format!("stats-time-{filter:?}").into(),
                        ))
                        .px(px(8.))
                        .py(px(5.))
                        .bg(rgb(if time_filter == filter {
                            raised
                        } else {
                            surface
                        }))
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_time_filter(filter, window, app))
                        .child(label)
                })),
        )
        .child(request_entries_label)
        .children(
            request_entries
                .iter()
                .filter(|item| {
                    source_matches(item.source.as_str(), source_filter)
                        && time_matches(current_time_ms(), item.timestamp_ms, time_filter)
                })
                .take(12)
                .map(|item| {
                    card(
                        format!(
                            "{} · {} · in {} · out {}",
                            item.source,
                            item.model.as_deref().unwrap_or("(unknown)"),
                            item.input_tokens.max(0),
                            item.output_tokens.max(0),
                        ),
                        item.timestamp_ms.max(0) as usize,
                        raised,
                    )
                }),
        )
        .child(format!(
            "{} · {} {} · {} {} · {} {} · {} {}",
            efficiency_label,
            requests_short_label,
            efficiency.request_count.max(0),
            completed_label,
            efficiency.completed_count.max(0),
            tokens_short_label,
            efficiency.total_tokens.max(0),
            duration_short_label,
            efficiency.average_duration_ms.max(0),
        ))
        .child(activity_label)
        .child(
            div().flex().items_end().gap(px(6.)).h(px(90.)).children(
                summary
                    .activity
                    .into_iter()
                    .enumerate()
                    .map(|(index, count)| {
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(3.))
                            .child(
                                div()
                                    .w(px(28.))
                                    .h(px(8. + 62. * count as f32 / max_activity as f32))
                                    .bg(rgb(0x5d8bd3)),
                            )
                            .child(day_labels[index].clone())
                    }),
            ),
        )
        .child(source_label)
        .child(
            div()
                .flex()
                .h(px(18.))
                .w_full()
                .bg(rgb(raised))
                .child(div().w(px(520. * claude_ratio)).h_full().bg(rgb(0x6b9ee8)))
                .child(div().flex_1().h_full().bg(rgb(0x8a6fc4))),
        )
        .child(format!(
            "{} {}% / {} {}%",
            claude_percent_label,
            (claude_ratio * 100.0) as usize,
            codex_percent_label,
            ((1.0 - claude_ratio) * 100.0) as usize
        ))
        .child(token_activity_label)
        .child(token_row(
            input_trend_label,
            summary.input_activity,
            max_tokens,
            0x6b9ee8,
            day_labels.clone(),
        ))
        .child(token_row(
            output_trend_label,
            summary.output_activity,
            max_tokens,
            0x8a6fc4,
            day_labels,
        ))
}

fn source_matches(source: &str, filter: SourceFilter) -> bool {
    match filter {
        SourceFilter::All => true,
        SourceFilter::Claude => source == "claude",
        SourceFilter::Codex => source == "codex",
    }
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn time_matches(now_ms: i64, updated_at: i64, filter: TimeFilter) -> bool {
    let Some(max_age_days) = (match filter {
        TimeFilter::All => None,
        TimeFilter::Recent7 => Some(7),
        TimeFilter::Recent30 => Some(30),
    }) else {
        return updated_at <= now_ms;
    };
    updated_at <= now_ms && now_ms.saturating_sub(updated_at) < max_age_days * 24 * 60 * 60 * 1000
}

fn token_row(
    label: String,
    values: [u64; 7],
    maximum: u64,
    color: u32,
    day_labels: [String; 7],
) -> Div {
    div()
        .flex()
        .items_end()
        .gap(px(6.))
        .h(px(72.))
        .child(label)
        .children(values.into_iter().enumerate().map(|(index, value)| {
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(2.))
                .child(
                    div()
                        .w(px(20.))
                        .h(px(6. + 48. * value as f32 / maximum as f32))
                        .bg(rgb(color)),
                )
                .child(day_labels[index].clone())
        }))
}

fn activity_bucket(now_ms: i64, updated_at: i64) -> Option<usize> {
    if updated_at > now_ms {
        return None;
    }
    let age_days = now_ms
        .checked_sub(updated_at)?
        .div_euclid(24 * 60 * 60 * 1000);
    (0..7).contains(&age_days).then_some(age_days as usize)
}

fn card(label: String, value: usize, background: u32) -> Div {
    div()
        .flex()
        .justify_between()
        .px(px(12.))
        .py(px(10.))
        .bg(rgb(background))
        .child(label)
        .child(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::StatsSummary;
    use crate::history::{HistoryMeta, HistoryRow, HistoryState};
    use std::path::PathBuf;

    #[test]
    fn summarizes_history_rows_and_metadata() {
        let mut history = HistoryState::default();
        history.rows = vec![
            HistoryRow {
                session_id: "a".into(),
                source: "claude".into(),
                project_key: "p".into(),
                title: "A".into(),
                file_path: PathBuf::from("a.jsonl"),
                updated_at: 1,
                message_count: 3,
                input_tokens: 10,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_creation_tokens: 1,
            },
            HistoryRow {
                session_id: "b".into(),
                source: "codex".into(),
                project_key: "p".into(),
                title: "B".into(),
                file_path: PathBuf::from("b.jsonl"),
                updated_at: 2,
                message_count: 4,
                input_tokens: 20,
                output_tokens: 4,
                cache_read_tokens: 5,
                cache_creation_tokens: 2,
            },
        ];
        history.metadata.insert(
            crate::history::metadata_key_for_row(&history.rows[0]),
            HistoryMeta {
                starred: true,
                ..HistoryMeta::default()
            },
        );
        let summary = StatsSummary::from_history(&history);
        assert_eq!(
            (
                summary.sessions,
                summary.messages,
                summary.claude,
                summary.codex,
                summary.starred
            ),
            (2, 7, 1, 1, 1)
        );
        assert_eq!(
            (
                summary.input_tokens,
                summary.output_tokens,
                summary.cached_tokens
            ),
            (30, 6, 11)
        );
    }

    #[test]
    fn activity_bucket_excludes_future_and_old_sessions() {
        let day = 24 * 60 * 60 * 1000;
        assert_eq!(super::activity_bucket(10 * day, 10 * day), Some(0));
        assert_eq!(super::activity_bucket(10 * day, 9 * day), Some(1));
        assert_eq!(super::activity_bucket(10 * day, 3 * day), None);
        assert_eq!(super::activity_bucket(10 * day, 11 * day), None);
    }
}
