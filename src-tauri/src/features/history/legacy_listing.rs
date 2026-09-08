use super::{
    get_or_scan_session_project, history_roots, normalize_history_path, refresh_history_index,
    resolve_claude_history_root, resolve_codex_history_root, session_matches_project_path,
    summary_from_computation, HistoryIndexEntry, HistorySessionSummary,
};
use log::debug;

// 在阻塞线程中从旧索引按来源、项目及摘要文本过滤并分页返回会话。
pub(super) async fn history_list_sessions_legacy(
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root).with_kimi_config_dir(kimi_config_dir);
        let source_filter = source.map(|v| v.to_lowercase());
        let target_project_path = project_path
            .map(|v| normalize_history_path(&v))
            .filter(|v| !v.is_empty());
        let query_lower = query
            .map(|q| q.trim().to_lowercase())
            .filter(|q| !q.is_empty());
        let max_sessions = limit.unwrap_or(usize::MAX);
        let start_offset = offset.unwrap_or(0);
        let targeted_lookup = target_project_path.is_some() && max_sessions == 1 && start_offset == 0;
        debug!(
            "history_list_sessions request: source={:?}, claude_root={}, codex_root={}, project_path={:?}, query={:?}, limit={}, offset={}",
            source_filter,
            resolve_claude_history_root(&roots).to_string_lossy(),
            resolve_codex_history_root(&roots).to_string_lossy(),
            target_project_path,
            query_lower,
            max_sessions,
            start_offset
        );
        if targeted_lookup {
            debug!(
                "history_list_sessions targeted lookup: source={:?}, project_path={:?}, query={:?}, limit={}, offset={}",
                source_filter,
                target_project_path,
                query_lower,
                max_sessions,
                start_offset
            );
        }
        let mut sessions = Vec::new();
        if max_sessions == 0 {
            return Ok(sessions);
        }

        if query_lower.is_none() {
            let indexed_entries = refresh_history_index(&roots);
            let total_files = indexed_entries.len();
            let mut mismatch_samples = Vec::new();
            let mut matched_entries: Vec<HistoryIndexEntry> = indexed_entries
                .into_iter()
                .filter_map(|entry| {
                    let file_ref = &entry.file_ref;
                    if let Some(filter) = &source_filter {
                        if &file_ref.source != filter {
                            return None;
                        }
                    }
                    let matched = target_project_path
                        .as_ref()
                        .map(|project_path| session_matches_project_path(&file_ref, project_path))
                        .unwrap_or(true);
                    if !matched {
                        if targeted_lookup && mismatch_samples.len() < 5 {
                            let scan = get_or_scan_session_project(&file_ref.path);
                            mismatch_samples.push(format!(
                                "source={} project_key={} cwd={:?} file={}",
                                file_ref.source,
                                file_ref.project_key,
                                scan.cwd,
                                file_ref.path.to_string_lossy()
                            ));
                        }
                        return None;
                    }
                    Some(entry)
                })
                .collect();
            debug!(
                "history_list_sessions project candidates: source={:?}, project_path={:?}, total_files={}, matched_files={}, reused_index=true",
                source_filter,
                target_project_path,
                total_files,
                matched_entries.len(),
            );
            if targeted_lookup {
                debug!(
                    "history_list_sessions targeted candidates: source={:?}, project_path={:?}, total_files={}, matched_files={}, mismatch_samples={:?}",
                    source_filter,
                    target_project_path,
                    total_files,
                    matched_entries.len(),
                    mismatch_samples
                );
            }
            matched_entries.sort_by(|a, b| {
                b.computed
                    .updated_at
                    .cmp(&a.computed.updated_at)
                    .then_with(|| a.file_ref.path.cmp(&b.file_ref.path))
            });

            let mut matched = 0usize;
            for entry in matched_entries {
                if matched < start_offset {
                    matched += 1;
                    continue;
                }
                if sessions.len() >= max_sessions {
                    break;
                }
                matched += 1;
                let file_ref = entry.file_ref;
                let computed = entry.computed;
                debug!(
                    "history_list_sessions matched file: source={}, project_key={}, session_id={}, path={}",
                    file_ref.source,
                    file_ref.project_key,
                    computed.session_id,
                    file_ref.path.to_string_lossy()
                );
                if targeted_lookup && sessions.is_empty() {
                    debug!(
                        "history_list_sessions targeted hit: source={}, project_key={}, session_id={}, path={}",
                        file_ref.source,
                        file_ref.project_key,
                        computed.session_id,
                        file_ref.path.to_string_lossy()
                    );
                }
                sessions.push(summary_from_computation(&file_ref, &computed));
            }
            if sessions.is_empty() {
                debug!(
                    "history_list_sessions no project match: source={:?}, project_path={:?}, total_files={}, matched_files={}",
                    source_filter,
                    target_project_path,
                    total_files,
                    matched
                );
                if targeted_lookup {
                    debug!(
                        "history_list_sessions targeted miss: source={:?}, project_path={:?}, total_files={}, matched_files={}",
                        source_filter,
                        target_project_path,
                        total_files,
                        matched
                    );
                }
            }
            return Ok(sessions);
        }

        let mut scanned_entries = 0usize;
        for entry in refresh_history_index(&roots) {
            scanned_entries += 1;
            if let Some(filter) = &source_filter {
                if &entry.file_ref.source != filter {
                    continue;
                }
            }

            if let Some(project_path) = &target_project_path {
                if !session_matches_project_path(&entry.file_ref, project_path) {
                    continue;
                }
            }

            let summary = summary_from_computation(&entry.file_ref, &entry.computed);
            if let Some(q) = &query_lower {
                let title = summary.title.to_lowercase();
                let session_id = summary.session_id.to_lowercase();
                let project = summary.project_key.to_lowercase();
                let source_name = summary.source.to_lowercase();
                let branch = summary
                    .branch
                    .as_ref()
                    .map(|v| v.to_lowercase())
                    .unwrap_or_default();
                if !title.contains(q)
                    && !session_id.contains(q)
                    && !project.contains(q)
                    && !source_name.contains(q)
                    && !branch.contains(q)
                {
                    continue;
                }
            }

            debug!(
                "history_list_sessions indexed match: source={}, project_key={}, session_id={}, path={}",
                entry.file_ref.source,
                entry.file_ref.project_key,
                summary.session_id,
                entry.file_ref.path.to_string_lossy()
            );
            if targeted_lookup && sessions.is_empty() {
                debug!(
                    "history_list_sessions targeted indexed hit: source={}, project_key={}, session_id={}, path={}",
                    entry.file_ref.source,
                    entry.file_ref.project_key,
                    summary.session_id,
                    entry.file_ref.path.to_string_lossy()
                );
            }
            sessions.push(summary);
        }

        if sessions.is_empty() {
            debug!(
                "history_list_sessions no indexed match: source={:?}, project_path={:?}, query={:?}, scanned_entries={}",
                source_filter,
                target_project_path,
                query_lower,
                scanned_entries
            );
            if targeted_lookup {
                debug!(
                    "history_list_sessions targeted indexed miss: source={:?}, project_path={:?}, query={:?}, scanned_entries={}",
                    source_filter,
                    target_project_path,
                    query_lower,
                    scanned_entries
                );
            }
        }
        Ok(sessions.into_iter().skip(start_offset).take(max_sessions).collect())
    })
    .await
    .map_err(|err| err.to_string())?
}
