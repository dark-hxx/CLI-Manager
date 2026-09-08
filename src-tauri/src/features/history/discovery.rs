use super::{
    collect_antigravity_session_files, collect_claude_session_files, collect_cline_session_files,
    collect_codex_session_files, collect_copilot_session_files, collect_cursor_session_files,
    collect_gemini_session_files, collect_grok_session_files, collect_kiro_session_files,
    collect_pi_session_files, get_files_cache, kimi, now_millis, resolve_antigravity_history_root,
    resolve_claude_history_root, resolve_cline_history_roots, resolve_codex_history_root,
    resolve_copilot_history_root, resolve_cursor_history_root, resolve_gemini_history_root,
    resolve_grok_history_root, resolve_kiro_history_root, resolve_pi_history_root,
    CachedSessionFiles, HistoryRoots, SessionFileRef, SESSION_FILES_TTL_MS,
};

// 按来源收集会话文件，允许复用有效期内的目录缓存。
pub(super) fn collect_session_files(
    source_filter: Option<&str>,
    roots: &HistoryRoots,
) -> Vec<SessionFileRef> {
    collect_session_files_with_force(source_filter, roots, false)
}

// 按来源和配置根目录复用目录缓存，强制或过期时重新扫描并缓存结果。
pub(super) fn collect_session_files_with_force(
    source_filter: Option<&str>,
    roots: &HistoryRoots,
    force: bool,
) -> Vec<SessionFileRef> {
    let cache_key = format!(
        "{}|{}",
        source_filter
            .map(|v| v.to_lowercase())
            .unwrap_or_else(|| "*".to_string()),
        roots.cache_key()
    );
    let now = now_millis();

    if !force {
        if let Ok(cache) = get_files_cache().lock() {
            if let Some(entry) = cache.by_source.get(&cache_key) {
                if now - entry.timestamp_ms < SESSION_FILES_TTL_MS {
                    return entry.files.clone();
                }
            }
        }
    }

    let files = scan_session_files(source_filter, roots);

    if let Ok(mut cache) = get_files_cache().lock() {
        cache.by_source.insert(
            cache_key,
            CachedSessionFiles {
                timestamp_ms: now,
                files: files.clone(),
            },
        );
    }

    files
}

// 按来源选择对应磁盘历史收集器，合并各配置根目录的会话引用。
pub(super) fn scan_session_files(
    source_filter: Option<&str>,
    roots: &HistoryRoots,
) -> Vec<SessionFileRef> {
    let mut files = Vec::new();
    let source_filter = source_filter.map(|v| v.to_lowercase());

    if source_filter
        .as_ref()
        .map(|v| v == "claude")
        .unwrap_or(true)
    {
        files.extend(collect_claude_session_files(&resolve_claude_history_root(
            roots,
        )));
    }
    if source_filter.as_ref().map(|v| v == "codex").unwrap_or(true) {
        files.extend(collect_codex_session_files(&resolve_codex_history_root(
            roots,
        )));
    }
    if source_filter
        .as_ref()
        .map(|v| v == "gemini")
        .unwrap_or(true)
    {
        files.extend(collect_gemini_session_files(&resolve_gemini_history_root()));
    }
    if source_filter
        .as_ref()
        .map(|v| v == "copilot")
        .unwrap_or(true)
    {
        files.extend(collect_copilot_session_files(
            &resolve_copilot_history_root(),
        ));
    }
    if source_filter
        .as_ref()
        .map(|v| v == "antigravity")
        .unwrap_or(true)
    {
        files.extend(collect_antigravity_session_files(
            &resolve_antigravity_history_root(),
        ));
    }
    if source_filter.as_ref().map(|v| v == "grok").unwrap_or(true) {
        files.extend(collect_grok_session_files(&resolve_grok_history_root(
            roots,
        )));
    }
    if source_filter.as_ref().map(|v| v == "kimi").unwrap_or(true) {
        files.extend(kimi::collect_kimi_session_files(
            &kimi::resolve_kimi_history_root(roots),
        ));
    }
    if source_filter.as_ref().map(|v| v == "pi").unwrap_or(true) {
        files.extend(collect_pi_session_files(&resolve_pi_history_root()));
    }
    if source_filter.as_ref().map(|v| v == "kiro").unwrap_or(true) {
        files.extend(collect_kiro_session_files(&resolve_kiro_history_root()));
    }
    if source_filter.as_ref().map(|v| v == "cline").unwrap_or(true) {
        for root in resolve_cline_history_roots() {
            files.extend(collect_cline_session_files(&root));
        }
    }
    if source_filter
        .as_ref()
        .map(|v| v == "cursor")
        .unwrap_or(true)
    {
        files.extend(collect_cursor_session_files(&resolve_cursor_history_root()));
    }

    files
}
