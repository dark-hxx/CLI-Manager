use super::{
    apply_codex_thread_name, apply_cursor_metadata_to_computation, catalog,
    codex_thread_name_index, collect_session_files_with_force, cursor_metadata_from_path, excerpt,
    get_or_scan_session_project, get_stats_aggregation_cache, get_stats_daily_index_cache,
    grok_string_by_paths, grok_summary_value, is_codex_rollout_session_path, is_jsonl, kimi,
    looks_like_antigravity_transcript_file, looks_like_copilot_events_file,
    looks_like_cursor_agent_transcript_file, looks_like_grok_updates_file,
    looks_like_pi_session_file, now_millis, path_to_key, scan_session_combined,
    scan_session_detail, system_time_to_millis, wsl_session_fingerprint, CachedSessionComputation,
    HistoryIndexEntry, HistoryMessage, HistoryRoots, HistorySessionIndex, HistorySessionSummary,
    SessionFileFingerprint, SessionFileRef, SessionFilesCache, SessionProjectCache,
    SessionStatsScan, SessionSummaryScan, WslSessionFingerprintCache, HISTORY_SESSION_INDEX,
    HISTORY_SESSION_INDEX_TTL_MS, SESSION_FILES_CACHE, SESSION_FILES_TTL_MS, SESSION_PROJECT_CACHE,
    WSL_SESSION_FINGERPRINT_CACHE,
};
use chrono::DateTime;
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};

pub(super) fn get_project_cache() -> &'static Mutex<SessionProjectCache> {
    SESSION_PROJECT_CACHE.get_or_init(|| Mutex::new(SessionProjectCache::default()))
}

pub(super) fn get_files_cache() -> &'static Mutex<SessionFilesCache> {
    SESSION_FILES_CACHE.get_or_init(|| Mutex::new(SessionFilesCache::default()))
}

pub(super) fn get_wsl_session_fingerprint_cache() -> &'static Mutex<WslSessionFingerprintCache> {
    WSL_SESSION_FINGERPRINT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn get_history_index() -> &'static RwLock<HistorySessionIndex> {
    HISTORY_SESSION_INDEX.get_or_init(|| RwLock::new(HistorySessionIndex::default()))
}

pub(crate) fn invalidate_history_caches() {
    catalog::mark_dirty();
    if let Ok(mut cache) = get_files_cache().lock() {
        cache.by_source.clear();
    }
    if let Ok(mut cache) = get_project_cache().lock() {
        cache.entries.clear();
    }
    invalidate_history_stats_caches();
    if let Ok(mut cache) = get_wsl_session_fingerprint_cache().lock() {
        cache.clear();
    }
    if let Ok(mut index) = get_history_index().write() {
        *index = HistorySessionIndex::default();
    }
    clear_persisted_history_index();
}

pub(crate) fn invalidate_history_stats_caches() {
    if let Ok(mut cache) = get_stats_aggregation_cache().lock() {
        cache.entries.clear();
    }
    if let Ok(mut cache) = get_stats_daily_index_cache().lock() {
        cache.entries.clear();
    }
}

// ===== 历史索引磁盘持久化 =====
// 内存索引（HISTORY_SESSION_INDEX）每次 App 启动后为空，首个 history_get_stats 必须
// 全量解析所有 JSONL（可能上千个），冷启动耗时不可接受。这里把 per-file 解析结果落盘，
// 重启后载入作为 build_history_index 的 previous，按 fingerprint 仅重解析变更文件。
pub(super) const HISTORY_INDEX_CACHE_VERSION: u32 = 13;
pub(super) const HISTORY_INDEX_CACHE_FILE: &str = "history-index-cache.json";

pub(super) static HISTORY_INDEX_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
pub(super) static HISTORY_INDEX_DISK_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
// roots_key -> 已落盘的 generation，内容未变时跳过重复写盘。
pub(super) static HISTORY_INDEX_PERSISTED_GEN: OnceLock<Mutex<HashMap<String, u64>>> =
    OnceLock::new();

#[derive(Serialize, Deserialize)]
pub(super) struct PersistedHistoryIndex {
    pub(super) version: u32,
    pub(super) roots_key: String,
    pub(super) generation: u64,
    pub(super) entries: Vec<HistoryIndexEntry>,
}

/// App 启动时注入 appLocalData 目录（见 lib.rs setup）。未设置时持久化静默关闭。
pub fn set_history_index_cache_dir(dir: PathBuf) {
    let _ = HISTORY_INDEX_CACHE_DIR.set(dir);
}

pub(super) fn history_index_disk_lock() -> &'static Mutex<()> {
    HISTORY_INDEX_DISK_LOCK.get_or_init(|| Mutex::new(()))
}

pub(super) fn history_index_persisted_gen() -> &'static Mutex<HashMap<String, u64>> {
    HISTORY_INDEX_PERSISTED_GEN.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn history_index_cache_file() -> Option<PathBuf> {
    HISTORY_INDEX_CACHE_DIR
        .get()
        .map(|dir| dir.join(HISTORY_INDEX_CACHE_FILE))
}

pub(super) fn persisted_generation(roots_key: &str) -> Option<u64> {
    history_index_persisted_gen()
        .lock()
        .ok()
        .and_then(|map| map.get(roots_key).copied())
}

pub(super) fn set_persisted_generation(roots_key: &str, generation: u64) {
    if let Ok(mut map) = history_index_persisted_gen().lock() {
        map.insert(roots_key.to_string(), generation);
    }
}

pub(super) fn load_persisted_history_index(roots: &HistoryRoots) -> Option<HistorySessionIndex> {
    let path = history_index_cache_file()?;
    let bytes = {
        let _guard = history_index_disk_lock().lock().ok()?;
        std::fs::read(&path).ok()?
    };
    let persisted: PersistedHistoryIndex = serde_json::from_slice(&bytes).ok()?;
    if persisted.version != HISTORY_INDEX_CACHE_VERSION {
        return None;
    }
    let roots_key = roots.cache_key();
    if persisted.roots_key != roots_key {
        return None;
    }
    let entries = persisted.entries;
    set_persisted_generation(&roots_key, persisted.generation);
    Some(HistorySessionIndex {
        roots: roots.clone(),
        entries,
        // refreshed_at=0 → 刷新逻辑视为已过期，会重建并按 fingerprint 复用磁盘 computed。
        refreshed_at: 0,
        generation: persisted.generation,
    })
}

pub(super) fn save_persisted_history_index(index: &HistorySessionIndex) {
    let Some(path) = history_index_cache_file() else {
        return;
    };
    let roots_key = index.roots.cache_key();
    // 内容（generation）未变则跳过写盘。
    if persisted_generation(&roots_key) == Some(index.generation) {
        return;
    }
    let persisted = PersistedHistoryIndex {
        version: HISTORY_INDEX_CACHE_VERSION,
        roots_key: roots_key.clone(),
        generation: index.generation,
        entries: index.entries.clone(),
    };
    let Ok(bytes) = serde_json::to_vec(&persisted) else {
        return;
    };
    let Ok(_guard) = history_index_disk_lock().lock() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 临时文件 + rename，避免崩溃时残留半截损坏文件。
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
        set_persisted_generation(&roots_key, index.generation);
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

pub(super) fn clear_persisted_history_index() {
    if let Ok(mut map) = history_index_persisted_gen().lock() {
        map.clear();
    }
    if let Some(path) = history_index_cache_file() {
        let _guard = history_index_disk_lock().lock();
        let _ = std::fs::remove_file(&path);
    }
}

pub(super) fn refresh_history_index(roots: &HistoryRoots) -> Vec<HistoryIndexEntry> {
    refresh_history_index_snapshot(roots, false).entries
}

pub(super) fn refresh_history_index_snapshot(
    roots: &HistoryRoots,
    force: bool,
) -> HistorySessionIndex {
    let now = now_millis();
    if !force {
        if let Ok(index) = get_history_index().read() {
            if index.roots.eq(roots)
                && index.refreshed_at > 0
                && now - index.refreshed_at < HISTORY_SESSION_INDEX_TTL_MS
            {
                return index.clone();
            }
        }
    }

    let mut previous = get_history_index()
        .read()
        .ok()
        .filter(|index| index.roots.eq(roots) && index.refreshed_at > 0)
        .map(|index| index.clone());
    // 冷启动（内存索引为空）时从磁盘载入，使 build 按 fingerprint 复用已解析结果，
    // 仅重解析变更/新增文件，避免每次重启全量解析全部 JSONL。
    if previous.is_none() {
        previous = load_persisted_history_index(roots);
    }
    let next = build_history_index(now, roots, previous, force);

    if let Ok(mut index) = get_history_index().write() {
        *index = next.clone();
    }
    save_persisted_history_index(&next);

    next
}

pub(super) fn history_index_snapshot_for_stats(
    roots: &HistoryRoots,
    force: bool,
) -> HistorySessionIndex {
    if force {
        return refresh_history_index_snapshot(roots, true);
    }
    if let Ok(index) = get_history_index().read() {
        if index.roots.eq(roots) && index.refreshed_at > 0 {
            return index.clone();
        }
    }
    if let Some(persisted) = load_persisted_history_index(roots) {
        return persisted;
    }
    refresh_history_index_snapshot(roots, false)
}

pub(super) fn build_history_index(
    now: i64,
    roots: &HistoryRoots,
    previous: Option<HistorySessionIndex>,
    force_file_scan: bool,
) -> HistorySessionIndex {
    let codex_thread_names = codex_thread_name_index(roots);
    let mut previous_entries: HashMap<String, HistoryIndexEntry> = previous
        .as_ref()
        .map(|index| {
            index
                .entries
                .iter()
                .cloned()
                .map(|entry| (path_to_key(&entry.file_ref.path), entry))
                .collect()
        })
        .unwrap_or_default();
    let previous_generation = previous.as_ref().map(|index| index.generation).unwrap_or(0);
    let files = collect_session_files_with_force(None, roots, force_file_scan);
    let mut entries: Vec<Option<HistoryIndexEntry>> = Vec::with_capacity(files.len());
    let mut pending: Vec<(usize, SessionFileRef, SessionFileFingerprint)> = Vec::new();

    for file_ref in files {
        let path_key = path_to_key(&file_ref.path);
        let fingerprint = session_file_fingerprint(&file_ref.path);
        if let Some(mut existing) = previous_entries.remove(&path_key) {
            if existing.file_ref.source == file_ref.source
                && existing.file_ref.project_key == file_ref.project_key
                && can_reuse_session_scan(existing.fingerprint, fingerprint)
            {
                existing.file_ref = file_ref;
                existing.fingerprint = fingerprint;
                if existing.file_ref.source == "cursor" {
                    if let Some(metadata) = cursor_metadata_from_path(&existing.file_ref.path) {
                        apply_cursor_metadata_to_computation(&mut existing.computed, &metadata);
                    }
                } else {
                    existing.computed.created_at = fingerprint.created_at;
                    existing.computed.updated_at = fingerprint.updated_at;
                }
                apply_codex_thread_name(
                    &existing.file_ref,
                    &codex_thread_names,
                    &mut existing.computed,
                );
                entries.push(Some(existing));
                continue;
            }
        }

        pending.push((entries.len(), file_ref, fingerprint));
        entries.push(None);
    }

    // 缓存未命中的文件需要全量解析（CPU+IO 密集），按核数并行扫描；
    // 首次构建索引时可能有上千个 jsonl，串行耗时不可接受。
    if !pending.is_empty() {
        let worker_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(pending.len());
        let next_job = AtomicUsize::new(0);
        let scanned: Mutex<Vec<(usize, HistoryIndexEntry)>> =
            Mutex::new(Vec::with_capacity(pending.len()));
        std::thread::scope(|scope| {
            for _ in 0..worker_count {
                scope.spawn(|| loop {
                    let job = next_job.fetch_add(1, Ordering::Relaxed);
                    let Some((slot, file_ref, fingerprint)) = pending.get(job) else {
                        break;
                    };
                    let mut computed = scan_session_computation(
                        &file_ref.path,
                        fingerprint.created_at,
                        fingerprint.updated_at,
                    );
                    apply_codex_thread_name(file_ref, &codex_thread_names, &mut computed);
                    let entry = HistoryIndexEntry {
                        file_ref: file_ref.clone(),
                        fingerprint: *fingerprint,
                        computed,
                    };
                    if let Ok(mut scanned) = scanned.lock() {
                        scanned.push((*slot, entry));
                    }
                });
            }
        });
        for (slot, entry) in scanned.into_inner().unwrap_or_default() {
            entries[slot] = Some(entry);
        }
    }

    let mut entries: Vec<HistoryIndexEntry> = entries.into_iter().flatten().collect();

    entries.sort_by(|a, b| b.computed.updated_at.cmp(&a.computed.updated_at));

    let changed = previous
        .as_ref()
        .map(|previous| !history_index_entries_match(&previous.entries, &entries))
        .unwrap_or(true);
    let generation = if changed {
        previous_generation.saturating_add(1)
    } else {
        previous_generation
    };

    HistorySessionIndex {
        roots: roots.clone(),
        entries,
        refreshed_at: now,
        generation,
    }
}

pub(super) fn history_index_entries_match(
    previous: &[HistoryIndexEntry],
    next: &[HistoryIndexEntry],
) -> bool {
    if previous.len() != next.len() {
        return false;
    }

    let previous_by_path: HashMap<String, (&str, &str, SessionFileFingerprint)> = previous
        .iter()
        .map(|entry| {
            (
                path_to_key(&entry.file_ref.path),
                (
                    entry.file_ref.source.as_str(),
                    entry.file_ref.project_key.as_str(),
                    entry.fingerprint,
                ),
            )
        })
        .collect();

    next.iter().all(|entry| {
        let path_key = path_to_key(&entry.file_ref.path);
        previous_by_path
            .get(&path_key)
            .map(|(source, project_key, fingerprint)| {
                *source == entry.file_ref.source.as_str()
                    && *project_key == entry.file_ref.project_key.as_str()
                    && *fingerprint == entry.fingerprint
            })
            .unwrap_or(false)
    })
}

pub(super) fn can_reuse_session_scan(
    previous: SessionFileFingerprint,
    current: SessionFileFingerprint,
) -> bool {
    previous.updated_at == current.updated_at && previous.size == current.size
}

pub(crate) fn session_file_fingerprint(path: &Path) -> SessionFileFingerprint {
    let path_str = path.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&path_str) {
        if let Ok(cache) = get_wsl_session_fingerprint_cache().lock() {
            if let Some(entry) = cache.get(&path_to_key(path)) {
                if now_millis() - entry.cached_at < SESSION_FILES_TTL_MS {
                    debug!(
                        "[wsl] fingerprint cache hit: path={} age_ms={}",
                        path_str,
                        now_millis().saturating_sub(entry.cached_at)
                    );
                    return entry.fingerprint;
                }
            }
        }
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path_str) {
            debug!("[wsl] fingerprint 使用 wsl stat: distro={distro} path={linux_path}");
            return wsl_session_fingerprint(&linux_path, &distro);
        }
        warn!("[wsl] fingerprint 解析 WSL UNC 失败: {path_str}, 回退 fs::metadata");
    }

    let metadata = fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(system_time_to_millis)
        .unwrap_or(0);
    let created_at = metadata
        .as_ref()
        .and_then(|m| m.created().ok())
        .map(system_time_to_millis)
        .unwrap_or(updated_at);
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

    SessionFileFingerprint {
        created_at,
        updated_at,
        size,
    }
}

pub(super) fn summary_from_computation(
    file_ref: &SessionFileRef,
    computed: &CachedSessionComputation,
) -> HistorySessionSummary {
    HistorySessionSummary {
        session_id: computed.session_id.clone(),
        parent_session_id: computed.parent_session_id.clone(),
        source: file_ref.source.clone(),
        project_key: file_ref.project_key.clone(),
        title: computed.title.clone(),
        file_path: file_ref.path.to_string_lossy().to_string(),
        cwd: get_or_scan_session_project(&file_ref.path).cwd,
        created_at: computed.created_at,
        updated_at: computed.updated_at,
        message_count: computed.message_count,
        branch: computed.branch.clone(),
    }
}

pub(super) fn scan_session_computation(
    path: &Path,
    created_at: i64,
    updated_at: i64,
) -> CachedSessionComputation {
    let (summary_scan, stats) = scan_session_combined(path);
    build_session_computation(path, created_at, updated_at, summary_scan, stats)
}

/// 单遍同时取得 computation 与完整消息列表，供 detail 复用同一次读取与解析。
pub(super) fn scan_session_computation_with_messages(
    path: &Path,
    created_at: i64,
    updated_at: i64,
) -> (CachedSessionComputation, Vec<HistoryMessage>) {
    let (summary_scan, stats, messages) = scan_session_detail(path);
    (
        build_session_computation(path, created_at, updated_at, summary_scan, stats),
        messages,
    )
}

pub(super) fn build_session_computation(
    path: &Path,
    created_at: i64,
    updated_at: i64,
    summary_scan: SessionSummaryScan,
    stats: SessionStatsScan,
) -> CachedSessionComputation {
    let computed_created_at = summary_scan.first_timestamp_ms.unwrap_or(created_at);
    let computed_updated_at = summary_scan.last_timestamp_ms.unwrap_or(updated_at);
    let is_cursor_transcript = looks_like_cursor_agent_transcript_file(path);
    let cursor_metadata = if is_cursor_transcript {
        cursor_metadata_from_path(path)
    } else {
        None
    };
    let fallback_session_id = path
        .file_stem()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown-session".to_string());
    let session_id = if is_codex_rollout_session_path(path)
        || looks_like_copilot_events_file(path)
        || looks_like_antigravity_transcript_file(path)
        || looks_like_grok_updates_file(path)
        || kimi::looks_like_kimi_main_wire(path)
        || looks_like_pi_session_file(path)
        || is_cursor_transcript
        || !is_jsonl(path)
    {
        summary_scan
            .session_id
            .clone()
            .unwrap_or_else(|| fallback_session_id.clone())
    } else {
        fallback_session_id
    };
    let title = summary_scan
        .first_user_message
        .or(summary_scan.first_message)
        .map(|text| excerpt(&text, 80))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| session_id.clone());

    let mut computed = CachedSessionComputation {
        created_at: computed_created_at,
        updated_at: computed_updated_at.max(computed_created_at),
        session_id,
        parent_session_id: summary_scan.parent_session_id,
        title,
        message_count: summary_scan.message_count,
        branch: summary_scan.branch,
        stats,
    };
    if let Some(metadata) = cursor_metadata {
        apply_cursor_metadata_to_computation(&mut computed, &metadata);
    }
    if looks_like_grok_updates_file(path) {
        apply_grok_summary_metadata(path, &mut computed);
    }
    if kimi::looks_like_kimi_main_wire(path) {
        kimi::apply_kimi_state_metadata(path, &mut computed);
    }
    computed
}

/// Enrich list/detail summary fields from Grok `summary.json` so the history list
/// shows title, message count, timestamps, and branch instead of sparse parser-only data.
pub(super) fn apply_grok_summary_metadata(path: &Path, computed: &mut CachedSessionComputation) {
    let Some(summary) = grok_summary_value(path) else {
        return;
    };

    if let Some(title) = grok_string_by_paths(
        &summary,
        &[&["generated_title"], &["session_summary"], &["title"]],
    ) {
        let trimmed = title.trim();
        if !trimmed.is_empty()
            && (computed.title.is_empty()
                || computed.title == computed.session_id
                || computed.title.chars().count() < 4)
        {
            computed.title = excerpt(trimmed, 80);
        } else if !trimmed.is_empty() {
            // Prefer Grok's generated title when available (more readable than first user chunk).
            computed.title = excerpt(trimmed, 80);
        }
    }

    let summary_message_count = summary
        .get("num_chat_messages")
        .and_then(Value::as_u64)
        .or_else(|| summary.get("num_messages").and_then(Value::as_u64))
        .map(|value| value as usize)
        .unwrap_or(0);
    if summary_message_count > computed.message_count {
        computed.message_count = summary_message_count;
    }

    if let Some(branch) = grok_string_by_paths(&summary, &[&["head_branch"], &["branch"]]) {
        let trimmed = branch.trim();
        if !trimmed.is_empty() {
            computed.branch = Some(trimmed.to_string());
        }
    }

    if let Some(created) = grok_summary_timestamp_ms(&summary, &["created_at", "createdAt"]) {
        // Prefer summary creation time when file mtime is missing or later noise.
        if computed.created_at <= 0 || created < computed.created_at {
            computed.created_at = created;
        }
    }
    if let Some(updated) =
        grok_summary_timestamp_ms(&summary, &["last_active_at", "updated_at", "updatedAt"])
    {
        if updated > computed.updated_at {
            computed.updated_at = updated;
        }
    }

    if let Some(model) = grok_string_by_paths(
        &summary,
        &[&["current_model_id"], &["model"], &["selectedModel"]],
    ) {
        if computed.stats.current_model.is_none() {
            computed.stats.current_model = Some(model.clone());
        }
        if computed.stats.dominant_model.is_none() {
            computed.stats.dominant_model = Some(model);
        }
    }
}

pub(super) fn grok_summary_timestamp_ms(summary: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(value) = summary.get(*key) {
            if let Some(ms) = value.as_i64() {
                if ms > 0 {
                    return Some(ms);
                }
            }
            if let Some(text) = value.as_str() {
                if let Ok(parsed) = DateTime::parse_from_rfc3339(text.trim()) {
                    return Some(parsed.timestamp_millis());
                }
            }
        }
    }
    None
}
use std::fs;
