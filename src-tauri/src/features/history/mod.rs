mod diagnostics;
use diagnostics::{
    log_history_detail_oom_diagnostic,
    log_history_stats_oom_diagnostic,
};
mod scan_state;
pub(super) use scan_state::CodexThreadNameIndex;
use scan_state::{
    remote_history_detail_cache, CachedHistoryStatsAggregation, CachedHistoryStatsDailyIndex,
    CachedSessionComputation, CachedSessionFiles, CachedSessionProjectCacheEntry,
    CachedWslSessionFingerprint, CursorSessionMetadata, HistoryIndexEntry, HistorySessionIndex,
    HistoryStatsAggregationCache, HistoryStatsDailyIndexCache, HistoryStatsSessionFact,
    OpenCodeParsedSession, SessionDetailParts, SessionFilesCache,
    SessionProjectCache, SessionProjectScan, SessionStatsScan, SessionSummaryScan,
    SessionUsageEventScan, WslSessionFileHit, WslSessionFingerprintCache,
    CODEX_THREAD_NAME_INDEX_MAX_BYTES, DAY_MS, HISTORY_SESSION_INDEX, HISTORY_SESSION_INDEX_TTL_MS,
    HISTORY_STATS_AGGREGATION_CACHE, HISTORY_STATS_AGGREGATION_CACHE_MAX,
    HISTORY_STATS_DAILY_INDEX_CACHE, HISTORY_STATS_DAILY_INDEX_CACHE_MAX, HOUR_MS,
    MAX_STATS_RANGE_DAYS, SESSION_FILES_CACHE, SESSION_PROJECT_CACHE,
    WSL_SESSION_FINGERPRINT_CACHE,
};
pub(crate) use scan_state::{HistoryRoots, SessionFileFingerprint, SessionFileRef};
mod types;
use types::{
    CodexThreadRegistration, DayStatsAggregate, HourStatsAggregate, StatsTimeBounds,
    UsageStatsScan, UsageTokenScan,
};
pub use types::{
    HistoryConversionMatrixItem, HistoryConversionResult, HistoryFileChangeOperation,
    HistoryFileChangeSummary, HistoryIndexStatus, HistoryIndexV2AdapterSession,
    HistoryIndexV2MessageRef, HistoryIndexV2RawPointer, HistoryIndexV2SessionRef,
    HistoryIndexV2SourceInstanceInput, HistoryIndexV2Status, HistoryIndexV2TableStatus,
    HistoryMessage, HistoryMessagePart, HistoryPromptItem, HistorySearchResult,
    HistorySessionDetail, HistorySessionSummary, HistorySessionUsage, HistoryStatsDailySeriesItem,
    HistoryStatsDataQuality, HistoryStatsHeatmapDay, HistoryStatsHourlyActivityItem,
    HistoryStatsModelItem, HistoryStatsProjectEfficiencyItem, HistoryStatsProjectItem,
    HistoryStatsResponse, HistoryStatsSourceItem, HistoryTokenTrendPoint, HistoryToolCount,
    HistoryToolEvent,
};
mod legacy_listing;
use legacy_listing::history_list_sessions_legacy;
mod opencode_detail;
use opencode_detail::build_opencode_session_detail;
mod scope;
pub(crate) use scope::validate_session_file_ref;
use scope::{
    codex_runtime_path, history_source_base, path_within_history_scope, should_register_codex_state_db,
    validate_session_file_ref_for_conversion,
};
mod remote_requests;
use remote_requests::{
    remote_error_code, remote_history_get_payload, remote_scope_payload,
    validate_remote_history_plan, validate_remote_history_sync_result, wait_for_history_daemon,
};
mod remote_detail;
use remote_detail::remote_detail_value;
mod stats;
use stats::{
    build_history_stats_daily_index, build_history_stats_response, get_stats_aggregation_cache,
    get_stats_daily_index_cache, history_stats_session_key,
    make_history_stats_aggregation_cache_key, make_history_stats_daily_index_cache_key,
    normalize_history_stats_project_paths, opencode_cwd_matches_project_path,
    opencode_list_prompts, opencode_stats_facts, opencode_stats_generation,
    opencode_summary_from_parsed, reprice_usage_stats, resolve_stats_time_bounds, source_includes,
    stats_aggregation_cache_get, stats_aggregation_cache_set, stats_daily_index_cache_get,
    stats_daily_index_cache_set, stats_day_start_offset, stats_day_start_with_offset,
    stats_usage_events_or_fallback,
};
mod index_cache;
pub use index_cache::set_history_index_cache_dir;
use index_cache::{
    can_reuse_session_scan, get_files_cache,
    get_project_cache, get_wsl_session_fingerprint_cache, history_index_snapshot_for_stats, load_persisted_history_index, refresh_history_index, refresh_history_index_snapshot, scan_session_computation, scan_session_computation_with_messages, summary_from_computation,
    HISTORY_INDEX_CACHE_DIR,
};
pub(crate) use index_cache::{
    invalidate_history_caches, invalidate_history_stats_caches, session_file_fingerprint,
};
mod session_detail;
pub(crate) use session_detail::build_session_detail;
use session_detail::{
    build_session_detail_with_roots, build_v2_adapter_session, build_v2_adapter_session_from_parts,
    collect_subtask_session_file_refs,
    scan_session_detail_parts_with_thread_names, v2_fingerprint_value,
};
mod conversion;
pub(crate) use conversion::now_rfc3339;
use conversion::{
    build_codex_thread_registration, convert_history_session, delete_session_tree, register_codex_thread,
};
mod roots;
use roots::{
    apply_codex_thread_name, codex_thread_name_index, list_subagent_transcript_files,
    normalize_config_dir, resolve_antigravity_history_root,
    resolve_claude_history_root, resolve_cline_history_roots, resolve_codex_config_root,
    resolve_codex_history_root, resolve_codex_state_db_path, resolve_copilot_history_root,
    resolve_cursor_global_storage_root, resolve_cursor_history_root, resolve_gemini_history_root,
    resolve_grok_history_root, resolve_kiro_history_root, resolve_pi_history_root,
    scan_session_detail_parts, scan_session_detail_parts_for_roots,
};
pub(crate) use roots::{history_roots, is_subagent_transcript_path};
mod opencode;
use opencode::{
    delete_opencode_session_from_locator,
    opencode_catalog_sessions, opencode_locator_in_default_scope,
    parse_opencode_database, parse_opencode_session_locator,
    path_equals_lenient, resolve_opencode_database_path, timestamp_millis_to_rfc3339,
};
mod codex_config;
use codex_config::{
    codex_config_string, expand_codex_config_path,
};
mod discovery;
use discovery::{collect_session_files, collect_session_files_with_force};
mod wsl_discovery;
use wsl_discovery::{
    collect_wsl_claude_session_files, collect_wsl_codex_session_files,
    remember_wsl_session_fingerprint, wsl_command_output, wsl_command_text, wsl_find_session_files,
    wsl_session_fingerprint,
};
mod source_files;
use source_files::{
    collect_antigravity_session_files, collect_claude_session_files, collect_cline_session_files,
    collect_codex_session_files, collect_copilot_session_files, collect_cursor_session_files,
    collect_gemini_session_files, collect_grok_session_files, collect_kiro_session_files,
    collect_pi_session_files, delete_grok_session_tree, find_exact_grok_session_in_root,
};
mod source_metadata;
use source_metadata::{
    antigravity_path_parts, antigravity_workspace_from_path, apply_cursor_metadata_to_computation, cline_api_message_values, cline_model_from_path,
    cline_project_key_from_path, cline_session_id_from_path, cline_title_from_path,
    cline_ui_timestamps, cline_workspace_from_path,
    cursor_metadata_from_path,
    cursor_project_key_from_path, cursor_project_slug_from_path, cursor_session_id_from_path, grok_project_key_from_path, grok_session_id_from_path,
    grok_string_by_paths, grok_summary_value, grok_workspace_from_path,
    load_antigravity_workspace_map, looks_like_antigravity_transcript_file,
    looks_like_cline_session_file, looks_like_copilot_events_file,
    looks_like_cursor_agent_transcript_file, looks_like_gemini_session_file,
    looks_like_grok_updates_file, looks_like_kiro_session_file, looks_like_pi_session_file, pi_project_key_from_path,
    pi_session_id_from_path, pi_string_by_keys, pi_workspace_from_path,
};
mod project_paths;
use project_paths::{
    claude_project_key_from_path, codex_project_key_from_path, codex_project_key_from_session,
    collect_files_recursive, copilot_project_key_from_path, cwd_matches_target, detect_home_dir,
    extract_cwd, extract_session_meta_id, gemini_project_key_from_path,
    get_or_scan_session_project, is_codex_rollout_session_path, is_json, is_jsonl,
    kiro_project_key_from_path, normalize_history_path, path_to_key, project_key_from_cwd,
    read_dir_entries, session_matches_project_path,
};
mod route_usage;
use route_usage::{
    load_history_stats_data_quality, merge_route_usage_into_history_stats,
};
mod scanner;
use scanner::scan_session_inner;
mod copilot_parser;
use copilot_parser::{
    copilot_message_from_event, copilot_tool_id, copilot_tool_name,
    copilot_tool_result_text, scan_copilot_jsonl_session,
};
mod grok_parser;
use grok_parser::{
    grok_event_timestamp, grok_tool_call_id, grok_tool_input,
    grok_tool_name, grok_tool_output, grok_tool_status, grok_update_value, scan_grok_jsonl_session,
};
mod pi_parser;
use pi_parser::{
    scan_pi_jsonl_session,
    scan_pi_tool_events,
};
mod transcript_parsers;
use transcript_parsers::{
    empty_session_scan, scan_antigravity_jsonl_session,
    scan_cursor_jsonl_session,
};
mod json_parsers;
use json_parsers::{
    json_content_text, json_history_message,
    json_session_scan_result, normalize_json_role, scan_json_session,
};
mod file_changes;
use file_changes::{
    scan_file_changes, scan_session_combined, scan_session_detail,
    scan_tool_events,
    summarize_file_change_operations,
};
mod message_stream;
use message_stream::{
    extract_codex_context_info, extract_codex_token_count, extract_context_window, extract_usage_tokens, iter_session_messages,
    CodexCumulativeUsage,
};
mod tool_observations;
mod native_tool_records;
mod nested_tools;
mod tool_events;
use tool_events::{
    collect_tool_calls, collect_tool_events_from_value, extract_command_name,
    extract_tool_duration_ms, make_tool_event, mark_tool_event_seen, sorted_tool_counts,
    summarize_json_value, update_tool_event_output,
};
mod usage;
use usage::{
    backfill_latest_assistant_message_usage, build_usage_event_key, calculate_usage_cost,
    codex_usage_delta, extract_model, extract_positive_u64, extract_reasoning_effort, extract_u64_by_keys,
    extract_usage_dedup_key, extract_usage_tokens_from_value,
    history_stats_total_tokens, is_synthetic_model, positive_usage_token, qualify_model_with_reasoning_effort,
    usage_stats_total_tokens, usage_total_tokens, usage_trend_point,
};
mod time;
use time::{
    calc_heat_level, day_start_utc, hour_of_day_for_stats, is_tool_result_message,
    now_millis,
};
mod message_content;
use message_content::{
    excerpt, extract_branch, extract_content,
    extract_simple_tag_block, extract_text_from_value, extract_timestamp_millis,
    fallback_history_message_part, fallback_message_part_kind, is_injected_prompt_content, looks_like_patch, message_title_candidate, normalize_text,
    normalize_unix_timestamp_millis, parse_timestamp_millis_str, parse_timestamp_millis_value, system_time_to_millis,
    update_timestamp_bounds,
};
pub(crate) use message_content::{extract_editable_text, extract_timestamp, parse_message};

use crate::daemon::client::DaemonBridge;
use crate::ssh_launch::SshLaunchPlan;
use crate::ssh_transport::posix_quote;
use cli_manager_history_core::{
    RemoteHistorySearchHit, RemoteHistorySessionDetail, RemoteHistorySyncResult,
};
use log::{debug, warn};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use uuid::Uuid;

mod catalog;
mod kimi;
pub(crate) mod request_logs;

use super::history_backup::ensure_source_mutation_unlocked;

/// BufReader 容量；默认 8KB 对几 MB 的 jsonl 文件 syscall 次数偏多。
const READ_BUF_CAPACITY: usize = 64 * 1024;
/// collect_session_files 的 TTL：避免分析看板/搜索短时间内反复全树扫盘。
const SESSION_FILES_TTL_MS: i64 = 60_000;
const OOM_HISTORY_DETAIL_WARN_BYTES: usize = 10 * 1024 * 1024;
const OOM_HISTORY_STATS_WARN_BYTES: usize = 5 * 1024 * 1024;
const OOM_HISTORY_MESSAGES_WARN_COUNT: usize = 2_000;
const CODEX_HISTORY_INDEX_TEXT_MAX_CHARS: usize = 4_000;
const HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION: i64 = 6;
const HISTORY_INDEX_V2_ADAPTER_MODEL_VERSION: i64 = 1;
const OPENCODE_SESSION_LOCATOR_MARKER: &str = "#session=";
const DAEMON_READY_WAIT_ATTEMPTS: usize = 60;
const DAEMON_READY_WAIT_INTERVAL: Duration = Duration::from_millis(100);

#[tauri::command]
// 按筛选分页读取目录会话，必要时刷新索引并回退到旧扫描路径。
pub async fn history_list_sessions(
    app: tauri::AppHandle,
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
    let roots = history_roots(
        claude_config_dir.clone(),
        codex_config_dir.clone(),
        grok_session_root.clone(),
    )
    .with_kimi_config_dir(kimi_config_dir.clone());
    let targeted_query = query
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    if catalog::is_dirty() || targeted_query {
        // Mutations invalidate the V2 catalog. Complete that refresh before
        // reading so a successful edit/delete is visible immediately. A
        // query also waits for refresh so a newly changed Codex thread name
        // participates in SQL filtering during the same request.
        let _ = catalog::ensure_refresh(app.clone(), roots.clone(), false, true).await;
    }
    match catalog::list_sessions(
        &roots,
        source.clone(),
        project_path.clone(),
        query.clone(),
        limit,
        offset,
    )
    .await
    {
        Ok(mut sessions) => {
            if sessions.is_empty()
                && source
                    .as_deref()
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case("grok"))
                && query
                    .as_deref()
                    .is_some_and(|value| Uuid::parse_str(value.trim()).is_ok())
                && limit == Some(1)
                && offset.unwrap_or(0) == 0
            {
                let session_id = query
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string();
                let target_project_path = project_path.clone();
                let grok_history_root = resolve_grok_history_root(&roots);
                let direct = tokio::task::spawn_blocking(move || {
                    find_exact_grok_session_in_root(
                        &grok_history_root,
                        &session_id,
                        target_project_path.as_deref(),
                    )
                })
                .await
                .map_err(|err| err.to_string())?;
                if let Some(session) = direct {
                    debug!(
                        "history_list_sessions direct Grok hit: session_id={} path={}",
                        session.session_id, session.file_path
                    );
                    sessions.push(session);
                }
            }
            if sessions.is_empty()
                && source
                    .as_deref()
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case("kimi"))
                && query
                    .as_deref()
                    .is_some_and(|value| kimi::is_valid_kimi_session_id(value))
                && limit == Some(1)
                && offset.unwrap_or(0) == 0
            {
                let session_id = query
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string();
                let target_project_path = project_path.clone();
                let kimi_history_root = kimi::resolve_kimi_history_root(&roots);
                let direct = tokio::task::spawn_blocking(move || {
                    kimi::find_exact_kimi_session_in_root(
                        &kimi_history_root,
                        &session_id,
                        target_project_path.as_deref(),
                    )
                })
                .await
                .map_err(|err| err.to_string())?;
                if let Some(session) = direct {
                    debug!(
                        "history_list_sessions direct Kimi hit: session_id={} path={}",
                        session.session_id, session.file_path
                    );
                    sessions.push(session);
                }
            }
            let targeted_lookup = query
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
                && limit == Some(1)
                && offset.unwrap_or(0) == 0;
            if targeted_lookup {
                if let Some(session) = sessions.first_mut() {
                    let path = PathBuf::from(&session.file_path);
                    let fingerprint =
                        tokio::task::spawn_blocking(move || session_file_fingerprint(&path))
                            .await
                            .map_err(|err| err.to_string())?;
                    session.created_at = fingerprint.created_at;
                    session.updated_at = fingerprint.updated_at;
                }
            }
            let _ = catalog::ensure_refresh(app, roots, false, false).await;
            Ok(sessions)
        }
        Err(err) => {
            warn!("history catalog list fallback: {err}");
            history_list_sessions_legacy(
                source,
                claude_config_dir,
                codex_config_dir,
                grok_session_root,
                kimi_config_dir,
                project_path,
                query,
                limit,
                offset,
            )
            .await
        }
    }
}

#[tauri::command]
// 优先复用会话详情缓存，按来源读取详情并处理子代理聚合与强制刷新。
pub async fn history_get_session(
    app: tauri::AppHandle,
    file_path: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    source: String,
    project_key: String,
    aggregate_subtasks: Option<bool>,
    fresh: Option<bool>,
) -> Result<HistorySessionDetail, String> {
    let source_normalized = source.trim().to_lowercase();
    let aggregate_subtasks = aggregate_subtasks.unwrap_or(false);
    let fresh = fresh.unwrap_or(false);
    if !aggregate_subtasks && !fresh {
        let started_at = Instant::now();
        let roots = history_roots(
            claude_config_dir.clone(),
            codex_config_dir.clone(),
            grok_session_root.clone(),
        )
        .with_kimi_config_dir(kimi_config_dir.clone());
        if catalog::is_dirty() {
            let _ = catalog::ensure_refresh(app.clone(), roots.clone(), false, true).await;
        }
        match catalog::get_session_detail_from_v2(
            &roots,
            &file_path,
            &source_normalized,
            &project_key,
        )
        .await
        {
            Ok(Some(detail)) => {
                log_history_detail_oom_diagnostic(
                    "history_get_session_v2",
                    &detail,
                    started_at.elapsed().as_millis(),
                );
                return Ok(detail);
            }
            Ok(None) => {}
            Err(err) => warn!("history v2 detail fallback: {err}"),
        }
    }
    if source_normalized == "opencode" {
        let started_at = Instant::now();
        let roots = history_roots(
            claude_config_dir,
            codex_config_dir,
            grok_session_root.clone(),
        )
        .with_kimi_config_dir(kimi_config_dir.clone());
        let summary =
            catalog::get_session_by_file_path(&roots, &file_path, "opencode", &project_key)
                .await?
                .ok_or_else(|| "session_file_not_indexed".to_string())?;
        let detail = build_opencode_session_detail(&file_path, summary).await?;
        log_history_detail_oom_diagnostic(
            "history_get_session",
            &detail,
            started_at.elapsed().as_millis(),
        );
        return Ok(detail);
    }
    tokio::task::spawn_blocking(move || {
        let started_at = Instant::now();
        let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root).with_kimi_config_dir(kimi_config_dir);
        debug!(
            "history_get_session request: source={}, project_key={}, file_path={}, claude_root={}, codex_root={}",
            source,
            project_key,
            file_path,
            resolve_claude_history_root(&roots).to_string_lossy(),
            resolve_codex_history_root(&roots).to_string_lossy()
        );
        let file_ref = validate_session_file_ref(&file_path, &source, &project_key, &roots)?;
        debug!(
            "history_get_session reading file: source={}, project_key={}, path={}, aggregate_subtasks={}, fresh={}",
            file_ref.source,
            file_ref.project_key,
            file_ref.path.to_string_lossy(),
            aggregate_subtasks,
            fresh
        );
        let detail = build_session_detail_with_roots(&file_ref, aggregate_subtasks, &roots)?;
        log_history_detail_oom_diagnostic(
            "history_get_session",
            &detail,
            started_at.elapsed().as_millis(),
        );
        Ok(detail)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
// 校验会话与目标写入状态，执行原生格式转换并更新索引状态。
pub async fn history_convert_session(
    file_path: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    source: String,
    project_key: String,
    target_source: String,
) -> Result<HistoryConversionResult, String> {
    let (result, codex_registration) = tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
            .with_kimi_config_dir(kimi_config_dir);
        let file_ref =
            validate_session_file_ref_for_conversion(&file_path, &source, &project_key, &roots)?;
        ensure_source_mutation_unlocked(&target_source)?;
        if is_subagent_transcript_path(&file_ref.path) {
            return Err("history_subagent_mutation_not_allowed".to_string());
        }
        let target_source = target_source.trim().to_lowercase();
        let detail = build_session_detail_with_roots(&file_ref, false, &roots)?;
        let result = convert_history_session(&detail, &target_source, &roots)?;
        let codex_registration = if target_source == "codex" {
            Some(build_codex_thread_registration(&roots, &detail, &result))
        } else {
            None
        };
        Ok::<_, String>((result, codex_registration))
    })
    .await
    .map_err(|err| err.to_string())??;

    if let Some(registration) = codex_registration {
        register_codex_thread(&registration).await?;
    }
    invalidate_history_caches();
    Ok(result)
}

#[tauri::command]
// 校验来源及写入锁后删除对应原生会话，并使历史索引失效。
pub async fn history_delete_session(
    file_path: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    source: String,
    project_key: String,
) -> Result<(), String> {
    let source = source.trim().to_lowercase();
    if source == "opencode" {
        return delete_opencode_session_from_locator(&file_path).await;
    }
    tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
            .with_kimi_config_dir(kimi_config_dir);
        if !matches!(source.as_str(), "claude" | "codex" | "kimi" | "grok") {
            return Err("unsupported_history_mutation_source".to_string());
        }
        let file_ref = validate_session_file_ref(&file_path, &source, &project_key, &roots)?;
        ensure_source_mutation_unlocked(&source)?;
        if source == "kimi" {
            kimi::delete_kimi_session_tree(&file_ref, &kimi::resolve_kimi_history_root(&roots))?;
        } else if source == "grok" {
            delete_grok_session_tree(&file_ref, &resolve_grok_history_root(&roots))?;
        } else {
            delete_session_tree(&file_ref)?;
        }
        invalidate_history_caches();
        Ok(())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
// 拒绝过短查询，刷新目录后执行全文检索。
pub async fn history_search(
    app: tauri::AppHandle,
    query: String,
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    project_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistorySearchResult>, String> {
    if query.trim().chars().count() < 3 {
        return Ok(Vec::new());
    }
    let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
        .with_kimi_config_dir(kimi_config_dir);
    // Search results include the current Codex thread_name, so complete any
    // pending registry refresh before querying the catalog.
    let _ = catalog::ensure_refresh(app.clone(), roots.clone(), false, true).await;
    let hits = catalog::search_sessions(&roots, &query, source, project_path, limit).await?;
    Ok(hits)
}

#[tauri::command]
// 触发非强制目录刷新并返回索引状态。
pub async fn history_get_index_status(
    app: tauri::AppHandle,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
) -> Result<HistoryIndexStatus, String> {
    let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
        .with_kimi_config_dir(kimi_config_dir);
    catalog::ensure_refresh(app, roots, false, false).await
}

#[tauri::command]
// 返回第二代历史目录的持久化索引状态。
pub async fn history_get_index_v2_status() -> Result<HistoryIndexV2Status, String> {
    catalog::get_v2_status().await
}

#[tauri::command]
// 扫描并筛选本地会话，返回受数量限制的第二代适配结果。
pub async fn history_index_v2_preview_adapter_sessions(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    source: Option<String>,
    project_key: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistoryIndexV2AdapterSession>, String> {
    tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
            .with_kimi_config_dir(kimi_config_dir);
        let source_filter = source
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty());
        let project_filter = project_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let max_sessions = limit.unwrap_or(20).clamp(1, 100);
        let mut entries = refresh_history_index(&roots);
        entries.sort_by(|left, right| {
            right
                .computed
                .updated_at
                .cmp(&left.computed.updated_at)
                .then_with(|| left.file_ref.path.cmp(&right.file_ref.path))
        });

        Ok(entries
            .into_iter()
            .filter(|entry| {
                source_filter
                    .as_deref()
                    .map(|source| entry.file_ref.source == source)
                    .unwrap_or(true)
            })
            .filter(|entry| {
                project_filter
                    .as_deref()
                    .map(|project| entry.file_ref.project_key == project)
                    .unwrap_or(true)
            })
            .take(max_sessions)
            .map(|entry| build_v2_adapter_session(&entry.file_ref, &roots))
            .collect())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
// 在第二代目录中新增或更新来源实例。
pub async fn history_index_v2_upsert_source_instance(
    input: HistoryIndexV2SourceInstanceInput,
) -> Result<HistoryIndexV2Status, String> {
    catalog::upsert_v2_source_instance(input).await
}

#[tauri::command]
// 将指定来源实例标记为停用。
pub async fn history_index_v2_deactivate_source_instance(
    source_id: String,
    instance_id: Option<String>,
) -> Result<HistoryIndexV2Status, String> {
    catalog::deactivate_v2_source_instance(source_id, instance_id).await
}

#[tauri::command]
// 请求远端历史同步，校验实例身份后应用结果并清理相关缓存。
pub async fn history_remote_sync(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    source: String,
    configured_config_root: String,
    project_paths: Vec<String>,
    source_instance_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    force_refresh: Option<bool>,
) -> Result<Value, String> {
    let source = source.trim().to_lowercase();
    validate_remote_history_plan(&ssh_launch, &source)?;
    let host_id = ssh_launch.host_id.clone();
    let mut payload = remote_scope_payload(
        &source,
        &configured_config_root,
        project_paths,
        cursor,
        limit,
    );
    payload["forceRefresh"] = Value::Bool(force_refresh.unwrap_or(false));
    let client = wait_for_history_daemon(&daemon_bridge)
        .await
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    let request_consumer_id = consumer_id.clone();
    let request_plan = ssh_launch.clone();
    let response = tokio::task::spawn_blocking(move || {
        client.ssh_agent_request(
            request_consumer_id,
            request_plan,
            "historySync".to_string(),
            payload,
        )
    })
    .await
    .map_err(|err| err.to_string())?;
    let response = match response {
        Ok(value) => value,
        Err(error) => {
            if let Some(instance_id) = source_instance_id.as_deref() {
                let _ = catalog::mark_remote_stale(instance_id, remote_error_code(&error)).await;
            }
            return Err(error);
        }
    };
    let result: RemoteHistorySyncResult = serde_json::from_value(response)
        .map_err(|_| "history_remote_response_invalid".to_string())?;
    validate_remote_history_sync_result(
        &ssh_launch,
        &source,
        &configured_config_root,
        source_instance_id.as_deref(),
        &result,
    )?;
    let applied = catalog::apply_remote_sync(&host_id, &result).await?;
    if applied {
        if let Ok(mut cache) = remote_history_detail_cache().lock() {
            cache.invalidate_instance(&result.source_instance_id);
        }
        invalidate_history_stats_caches();
    }
    let mut value = serde_json::to_value(result).map_err(|err| err.to_string())?;
    value["applied"] = Value::Bool(applied);
    Ok(value)
}

#[tauri::command]
// 按来源实例分页读取本地缓存的远程会话。
pub async fn history_remote_list_cached(
    source_instance_id: String,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<Value>, String> {
    catalog::list_remote_cached(
        source_instance_id.trim(),
        project_path.as_deref(),
        query.as_deref(),
        limit.unwrap_or(20).clamp(1, 1000),
        offset.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
// 经守护进程检索远端历史，并校验每个结果的来源身份。
pub async fn history_remote_search(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    source: String,
    configured_config_root: String,
    project_paths: Vec<String>,
    source_instance_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Value>, String> {
    let source = source.trim().to_lowercase();
    validate_remote_history_plan(&ssh_launch, &source)?;
    let normalized_query = query.trim();
    if normalized_query.chars().count() < 3 {
        return Ok(Vec::new());
    }
    let payload = {
        let mut payload =
            remote_scope_payload(&source, &configured_config_root, project_paths, None, limit);
        payload["query"] = Value::String(normalized_query.to_string());
        payload
    };
    let client = wait_for_history_daemon(&daemon_bridge)
        .await
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    let response = tokio::task::spawn_blocking(move || {
        client.ssh_agent_request(
            consumer_id,
            ssh_launch,
            "historySearch".to_string(),
            payload,
        )
    })
    .await
    .map_err(|err| err.to_string())?;
    let response = match response {
        Ok(value) => value,
        Err(error) => {
            let _ =
                catalog::mark_remote_stale(&source_instance_id, remote_error_code(&error)).await;
            return Err(error);
        }
    };
    let hits: Vec<RemoteHistorySearchHit> = serde_json::from_value(
        response
            .get("hits")
            .cloned()
            .ok_or_else(|| "history_remote_response_invalid".to_string())?,
    )
    .map_err(|_| "history_remote_response_invalid".to_string())?;
    if hits.iter().any(|hit| {
        hit.session_ref.source_instance_id != source_instance_id
            || hit.session_ref.source_id != source
            || hit.session_ref.transport_kind != "ssh"
    }) {
        return Err("history_remote_identity_changed".to_string());
    }
    Ok(hits
        .into_iter()
        .map(|hit| {
            json!({
                "sessionId": hit.session_ref.source_session_id,
                "source": hit.session_ref.source_id,
                "projectKey": hit.project_key,
                "title": hit.title,
                "filePath": "",
                "role": hit.role,
                "snippet": hit.snippet,
                "timestamp": hit.timestamp,
                "sessionRef": hit.session_ref,
                "readOnly": true,
            })
        })
        .collect())
}

#[tauri::command]
// 获取远程会话详情并校验身份，非直接文件请求可复用详情缓存。
pub async fn history_remote_get_session(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    source: String,
    configured_config_root: String,
    project_paths: Vec<String>,
    source_instance_id: String,
    source_session_id: String,
    remote_transcript_ref: Option<String>,
) -> Result<Value, String> {
    let source = source.trim().to_lowercase();
    validate_remote_history_plan(&ssh_launch, &source)?;
    let direct_transcript = remote_transcript_ref
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let cache_key = format!("{}:{}", source_instance_id.trim(), source_session_id.trim());
    if !direct_transcript {
        if let Ok(mut cache) = remote_history_detail_cache().lock() {
            if let Some(value) = cache.get(&cache_key) {
                return Ok(value);
            }
        }
    }
    let payload = remote_history_get_payload(
        &source,
        &configured_config_root,
        project_paths,
        source_session_id.clone(),
        remote_transcript_ref,
    );
    let client = wait_for_history_daemon(&daemon_bridge)
        .await
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    let response = tokio::task::spawn_blocking(move || {
        client.ssh_agent_request(consumer_id, ssh_launch, "historyGet".to_string(), payload)
    })
    .await
    .map_err(|err| err.to_string())?;
    let response = match response {
        Ok(value) => value,
        Err(error) => {
            if !source_instance_id.trim().is_empty() {
                let _ = catalog::mark_remote_stale(&source_instance_id, remote_error_code(&error))
                    .await;
            }
            return Err(error);
        }
    };
    let detail: RemoteHistorySessionDetail = serde_json::from_value(response)
        .map_err(|_| "history_remote_response_invalid".to_string())?;
    if (!source_instance_id.trim().is_empty()
        && detail.summary.session_ref.source_instance_id != source_instance_id)
        || detail.summary.session_ref.source_session_id != source_session_id
        || detail.summary.session_ref.source_id != source
        || detail.summary.session_ref.transport_kind != "ssh"
    {
        return Err("history_remote_identity_changed".to_string());
    }
    let value = remote_detail_value(detail);
    if !direct_transcript {
        if let Ok(mut cache) = remote_history_detail_cache().lock() {
            cache.insert(cache_key, value.clone());
        }
    }
    Ok(value)
}

#[tauri::command]
// 向远端预检恢复条件，严格校验身份、目录和参数后构造引用命令。
pub async fn history_remote_resume_preflight(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    source: String,
    configured_config_root: String,
    project_paths: Vec<String>,
    source_instance_id: String,
    source_session_id: String,
) -> Result<Value, String> {
    let source = source.trim().to_lowercase();
    validate_remote_history_plan(&ssh_launch, &source)?;
    let expected_installation_id = ssh_launch.agent_installation_id.clone();
    let expected_machine_id = ssh_launch.agent_remote_machine_id.clone();
    let expected_ssh_user = ssh_launch.username.clone();
    let source_session_id = source_session_id.trim().to_string();
    if source_session_id.is_empty() || source_session_id.len() > 512 {
        return Err("history_resume_session_id_invalid".to_string());
    }
    let mut payload = remote_scope_payload(
        &source,
        &configured_config_root,
        project_paths,
        None,
        Some(1),
    );
    payload["sourceSessionId"] = Value::String(source_session_id.clone());
    payload["expectedSourceInstanceId"] = Value::String(source_instance_id.clone());
    payload["expectedRemoteMachineId"] = Value::String(ssh_launch.agent_remote_machine_id.clone());
    payload["expectedSshUser"] = Value::String(ssh_launch.username.clone());
    let client = wait_for_history_daemon(&daemon_bridge)
        .await
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    let mut response = tokio::task::spawn_blocking(move || {
        client.ssh_agent_request(
            consumer_id,
            ssh_launch,
            "historyResumePreflight".to_string(),
            payload,
        )
    })
    .await
    .map_err(|err| err.to_string())??;
    let object = response
        .as_object()
        .ok_or_else(|| "history_resume_response_invalid".to_string())?;
    let string_field = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "history_resume_response_invalid".to_string())
    };
    if string_field("source")? != source
        || string_field("sourceSessionId")? != source_session_id
        || string_field("sourceInstanceId")? != source_instance_id
        || string_field("installationId")? != expected_installation_id
        || string_field("remoteMachineId")? != expected_machine_id
        || (!expected_ssh_user.trim().is_empty() && string_field("sshUser")? != expected_ssh_user)
    {
        return Err("history_remote_identity_changed".to_string());
    }
    let remote_cwd = string_field("remoteCwd")?;
    if !remote_cwd.starts_with('/')
        || remote_cwd.contains(['\0', '\r', '\n', '\\'])
        || remote_cwd.split('/').any(|part| part == "..")
    {
        return Err("history_resume_response_invalid".to_string());
    }
    let resume_args = object
        .get("resumeArgs")
        .and_then(Value::as_array)
        .filter(|args| args.len() == 3)
        .ok_or_else(|| "history_resume_response_invalid".to_string())?;
    if resume_args.iter().any(|arg| {
        arg.as_str().is_none_or(|value| {
            value.is_empty() || value.contains(['\0', '\r', '\n', ';', '|', '&'])
        })
    }) {
        return Err("history_resume_response_invalid".to_string());
    }
    let args = resume_args
        .iter()
        .map(|arg| arg.as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    let expected_prefix = if source == "claude" {
        ["claude", "--resume"]
    } else {
        ["codex", "resume"]
    };
    if args[0] != expected_prefix[0]
        || args[1] != expected_prefix[1]
        || args[2] != source_session_id
    {
        return Err("history_resume_response_invalid".to_string());
    }
    response["resumeCommand"] = Value::String(
        args.into_iter()
            .map(posix_quote)
            .collect::<Vec<_>>()
            .join(" "),
    );
    Ok(response)
}

#[tauri::command]
// 释放指定 SSH 主机上的历史访问消费者。
pub fn history_remote_close(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    host_id: String,
    consumer_id: String,
) -> Result<(), String> {
    let client = daemon_bridge
        .get()
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    client.ssh_agent_release(host_id, consumer_id)
}

#[tauri::command]
// 枚举来源转换能力矩阵，仅将 Claude 与 Codex 互转标为可写。
pub async fn history_get_conversion_matrix() -> Result<Vec<HistoryConversionMatrixItem>, String> {
    const SOURCES: [&str; 12] = [
        "claude",
        "codex",
        "gemini",
        "copilot",
        "antigravity",
        "grok",
        "kimi",
        "pi",
        "opencode",
        "kiro",
        "cursor",
        "cline",
    ];
    let mut items = Vec::new();
    for source in SOURCES {
        for target in SOURCES {
            if source == target {
                items.push(HistoryConversionMatrixItem {
                    source_id: source.to_string(),
                    target_id: target.to_string(),
                    state: "unsupported".to_string(),
                    loss_kind: "sameSource".to_string(),
                    writer_state: "unsupported".to_string(),
                    note: "same_source_conversion_is_not_a_mutation".to_string(),
                });
                continue;
            }
            let supported = matches!((source, target), ("claude", "codex") | ("codex", "claude"));
            items.push(HistoryConversionMatrixItem {
                source_id: source.to_string(),
                target_id: target.to_string(),
                state: if supported { "supported" } else { "planned" }.to_string(),
                loss_kind: if supported {
                    "lossyPotential"
                } else {
                    "unknown"
                }
                .to_string(),
                writer_state: if supported { "supported" } else { "planned" }.to_string(),
                note: if supported {
                    "current_native_writer"
                } else {
                    "requires_parser_promotion_and_native_writer"
                }
                .to_string(),
            });
        }
    }
    Ok(items)
}

#[tauri::command]
// 强制刷新指定历史根目录，按选项等待完成。
pub async fn history_refresh_index(
    app: tauri::AppHandle,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    wait: Option<bool>,
) -> Result<HistoryIndexStatus, String> {
    let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
        .with_kimi_config_dir(kimi_config_dir);
    catalog::ensure_refresh(app, roots, true, wait.unwrap_or(true)).await
}

#[tauri::command]
// 按作用域扫描用户提示词，补充 OpenCode 结果并按会话时间排序限量。
pub async fn history_list_prompts(
    scope: Option<String>,
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    project_key: Option<String>,
    file_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistoryPromptItem>, String> {
    let source_for_opencode = source.clone();
    let scope_for_opencode = scope.clone();
    let project_for_opencode = project_key.clone();
    let file_for_opencode = file_path.clone();
    let query_for_opencode = query.clone();
    let max_items = limit.unwrap_or(200).clamp(1, 2000);
    let mut prompts: Vec<HistoryPromptItem> = tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
            .with_kimi_config_dir(kimi_config_dir);
        let scope = scope
            .as_deref()
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "global".to_string());
        let source_filter = source.map(|v| v.to_lowercase());
        let target_project = project_key
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let target_file = file_path
            .map(|v| normalize_history_path(&v))
            .filter(|v| !v.is_empty());
        let normalized_query = query
            .map(|q| q.trim().to_lowercase())
            .filter(|q| !q.is_empty());
        let max_items = limit.unwrap_or(200).clamp(1, 2000);
        let mut prompts: Vec<HistoryPromptItem> = Vec::new();

        for entry in refresh_history_index(&roots) {
            if let Some(filter) = &source_filter {
                if &entry.file_ref.source != filter {
                    continue;
                }
            }
            let file_ref = entry.file_ref;
            let computed = entry.computed;
            if let Some(project) = &target_project {
                if &file_ref.project_key != project {
                    continue;
                }
            }

            if scope == "session" {
                let Some(target) = target_file.as_ref() else {
                    continue;
                };
                let current = normalize_history_path(&path_to_key(&file_ref.path));
                if &current != target {
                    continue;
                }
            }

            let session_id = computed.session_id.clone();
            let source_name = file_ref.source.clone();
            let project_key_owned = file_ref.project_key.clone();
            let file_path_str = file_ref.path.to_string_lossy().to_string();
            let session_title = computed.title.clone();
            let updated_at = computed.updated_at;
            let title_lower = session_title.to_lowercase();
            let mut local_full = false;

            let scan_result = iter_session_messages(&file_ref.path, |index, msg| {
                if msg.role != "user" {
                    return true;
                }
                let prompt = normalize_text(&msg.content);
                if prompt.is_empty() {
                    return true;
                }
                if let Some(q) = &normalized_query {
                    let prompt_lower = prompt.to_lowercase();
                    if !prompt_lower.contains(q) && !title_lower.contains(q) {
                        return true;
                    }
                }
                prompts.push(HistoryPromptItem {
                    session_id: session_id.clone(),
                    source: source_name.clone(),
                    project_key: project_key_owned.clone(),
                    file_path: file_path_str.clone(),
                    session_title: session_title.clone(),
                    updated_at,
                    message_index: index,
                    prompt,
                    timestamp: msg.timestamp,
                });
                if prompts.len() >= max_items {
                    local_full = true;
                    return false;
                }
                true
            });
            if let Err(err) = scan_result {
                debug!(
                    "history_list_prompts skip unreadable file: path={}, err={}",
                    file_ref.path.to_string_lossy(),
                    err
                );
                continue;
            }
            if local_full {
                break;
            }
        }

        prompts.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then(b.message_index.cmp(&a.message_index))
        });
        Ok::<Vec<HistoryPromptItem>, String>(prompts)
    })
    .await
    .map_err(|err| err.to_string())??;

    if source_includes(&source_for_opencode, "opencode") && prompts.len() < max_items {
        prompts.extend(
            opencode_list_prompts(
                scope_for_opencode,
                project_for_opencode,
                file_for_opencode,
                query_for_opencode,
                max_items.saturating_sub(prompts.len()),
            )
            .await?,
        );
        prompts.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then(b.message_index.cmp(&a.message_index))
        });
        prompts.truncate(max_items);
    }

    Ok(prompts)
}

#[tauri::command]
// 合并本地历史与 OpenCode 的非空项目键并排序去重。
pub async fn history_list_stats_projects(
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
) -> Result<Vec<String>, String> {
    let source_for_opencode = source.clone();
    let mut projects: Vec<String> = tokio::task::spawn_blocking(move || {
        let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
            .with_kimi_config_dir(kimi_config_dir);
        let source_filter = source.map(|v| v.to_lowercase());
        let mut projects = BTreeSet::new();

        for entry in refresh_history_index(&roots) {
            if let Some(filter) = &source_filter {
                if &entry.file_ref.source != filter {
                    continue;
                }
            }
            if !entry.file_ref.project_key.trim().is_empty() {
                projects.insert(entry.file_ref.project_key);
            }
        }

        Ok::<Vec<String>, String>(projects.into_iter().collect())
    })
    .await
    .map_err(|err| err.to_string())??;

    if source_includes(&source_for_opencode, "opencode") {
        let mut merged: BTreeSet<String> = projects.into_iter().collect();
        for parsed in opencode_catalog_sessions().await?.unwrap_or_default() {
            if !parsed.file_ref.project_key.trim().is_empty() {
                merged.insert(parsed.file_ref.project_key);
            }
        }
        projects = merged.into_iter().collect();
    }

    Ok(projects)
}

#[tauri::command]
// 按来源、项目和时间聚合历史及路由用量，复用分层缓存并补充数据质量信息。
pub async fn history_get_stats(
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    kimi_config_dir: Option<String>,
    project_key: Option<String>,
    project_path: Option<String>,
    project_paths: Option<Vec<String>>,
    source_instance_id: Option<String>,
    range_days: Option<usize>,
    start_at: Option<i64>,
    end_at: Option<i64>,
    force: Option<bool>,
) -> Result<HistoryStatsResponse, String> {
    let started_at = Instant::now();
    let roots = history_roots(claude_config_dir, codex_config_dir, grok_session_root)
        .with_kimi_config_dir(kimi_config_dir);
    let source_filter = source.map(|v| v.to_lowercase());
    let target_project = project_key
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let target_project_paths = normalize_history_stats_project_paths(project_path, project_paths);
    let target_source_instance = source_instance_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if target_source_instance
        .as_ref()
        .is_some_and(|value| value.len() > 512 || value.contains(['\0', '\r', '\n']))
    {
        return Err("history_source_instance_invalid".to_string());
    }
    let bounds = resolve_stats_time_bounds(range_days, start_at, end_at)?;
    let force = force.unwrap_or(false);
    let include_opencode = target_source_instance.is_none()
        && source_filter
            .as_deref()
            .map(|source| source == "opencode")
            .unwrap_or(true);
    let index = if target_source_instance.is_some() {
        None
    } else {
        Some(history_index_snapshot_for_stats(&roots, force))
    };
    let index_generation = index.as_ref().map(|index| index.generation).unwrap_or(0);
    let opencode_generation = include_opencode.then(opencode_stats_generation);
    let cache_key = make_history_stats_aggregation_cache_key(
        &roots,
        source_filter.as_deref(),
        target_project.as_deref(),
        &target_project_paths,
        target_source_instance.as_deref(),
        bounds,
        index_generation,
        opencode_generation.as_deref(),
        crate::usage::route_usage_generation(),
    );

    if !force {
        if let Some(response) = stats_aggregation_cache_get(&cache_key) {
            log_history_stats_oom_diagnostic(
                "history_get_stats_cache_hit",
                &response,
                started_at.elapsed().as_millis(),
            );
            return Ok(response);
        }
    }

    let mut days = if target_source_instance.is_some() {
        BTreeMap::new()
    } else {
        let index = index.expect("local stats require a history index");
        let daily_index_key = make_history_stats_daily_index_cache_key(
            &roots,
            source_filter.as_deref(),
            target_project.as_deref(),
            &target_project_paths,
            target_source_instance.as_deref(),
            bounds,
            index_generation,
        );
        let daily_index = if !force {
            stats_daily_index_cache_get(&daily_index_key).unwrap_or_else(|| {
                let daily_index = build_history_stats_daily_index(
                    index.entries,
                    source_filter.as_deref(),
                    target_project.as_deref(),
                    &target_project_paths,
                    bounds,
                );
                stats_daily_index_cache_set(daily_index_key, daily_index.clone());
                daily_index
            })
        } else {
            let daily_index = build_history_stats_daily_index(
                index.entries,
                source_filter.as_deref(),
                target_project.as_deref(),
                &target_project_paths,
                bounds,
            );
            stats_daily_index_cache_set(daily_index_key, daily_index.clone());
            daily_index
        };
        daily_index.days
    };
    if include_opencode {
        for fact in opencode_stats_facts(
            source_filter.as_deref(),
            target_project.as_deref(),
            &target_project_paths,
            bounds,
        )
        .await?
        {
            let day_start =
                stats_day_start_with_offset(fact.occurred_at, stats_day_start_offset(bounds));
            days.entry(day_start).or_default().push(fact);
        }
    }
    match catalog::stats_session_facts(
        &roots,
        source_filter.as_deref(),
        target_project.as_deref(),
        &target_project_paths,
        target_source_instance.as_deref(),
    )
    .await
    {
        Ok(v2_facts) if !v2_facts.is_empty() => {
            let v2_session_keys: HashSet<String> = v2_facts
                .iter()
                .map(|fact| history_stats_session_key(&fact.summary))
                .collect();
            for facts in days.values_mut() {
                facts.retain(|fact| {
                    !v2_session_keys.contains(&history_stats_session_key(&fact.summary))
                });
            }
            let day_offset = stats_day_start_offset(bounds);
            for fact in v2_facts {
                let day_start = stats_day_start_with_offset(fact.occurred_at, day_offset);
                days.entry(day_start).or_default().push(fact);
            }
        }
        Ok(_) => {}
        Err(err) => warn!("history v2 stats fallback: {err}"),
    }

    let mut response = build_history_stats_response(&days, bounds);
    if target_source_instance.is_none() {
        merge_route_usage_into_history_stats(
            &mut response,
            &mut days,
            bounds,
            source_filter.as_deref(),
            target_project.as_deref(),
            &target_project_paths,
        )
        .await?;
    }
    response.data_quality =
        load_history_stats_data_quality(bounds, source_filter.as_deref()).await?;
    log_history_stats_oom_diagnostic(
        "history_get_stats",
        &response,
        started_at.elapsed().as_millis(),
    );
    stats_aggregation_cache_set(cache_key, response.clone());
    Ok(response)
}

// ── WSL 路径感知的会话文件扫描 ───────────────────────────────────────────────
// 当 history root 指向 WSL UNC 路径（\\wsl.localhost\...）时，fs::read_dir 等
// Windows 原生文件 API 在 Plan 9 协议上不可靠。此时改用 wsl.exe 命令在 WSL 内部
// 完成目录枚举与元数据读取，绕过文件系统限制。

#[cfg(test)]
mod tests;
