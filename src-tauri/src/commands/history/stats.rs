use super::{
    calc_heat_level, calculate_usage_cost, cwd_matches_target, day_start_utc,
    history_stats_total_tokens, hour_of_day_for_stats, normalize_history_path, normalize_text,
    now_millis, opencode_catalog_sessions, resolve_opencode_database_path,
    session_file_fingerprint, session_matches_project_path, summary_from_computation,
    usage_stats_total_tokens, CachedHistoryStatsAggregation, CachedHistoryStatsDailyIndex,
    DayStatsAggregate, HistoryIndexEntry, HistoryPromptItem, HistoryRoots, HistorySessionSummary,
    HistoryStatsAggregationCache, HistoryStatsDailyIndexCache, HistoryStatsDailySeriesItem,
    HistoryStatsDataQuality, HistoryStatsHeatmapDay, HistoryStatsHourlyActivityItem,
    HistoryStatsModelItem, HistoryStatsProjectEfficiencyItem, HistoryStatsProjectItem,
    HistoryStatsResponse, HistoryStatsSessionFact, HistoryStatsSourceItem, HourStatsAggregate,
    OpenCodeParsedSession, SessionStatsScan, SessionUsageEventScan, StatsTimeBounds,
    UsageStatsScan, UsageTokenScan, DAY_MS, HISTORY_STATS_AGGREGATION_CACHE,
    HISTORY_STATS_AGGREGATION_CACHE_MAX, HISTORY_STATS_DAILY_INDEX_CACHE,
    HISTORY_STATS_DAILY_INDEX_CACHE_MAX, HOUR_MS, MAX_STATS_RANGE_DAYS,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

pub(super) fn normalize_history_stats_project_paths(
    project_path: Option<String>,
    project_paths: Option<Vec<String>>,
) -> Vec<String> {
    let mut normalized = project_paths.unwrap_or_default();
    if let Some(project_path) = project_path {
        normalized.push(project_path);
    }
    let mut normalized = normalized
        .into_iter()
        .map(|path| normalize_history_path(&path))
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized.dedup();
    normalized
}

pub(super) fn history_stats_project_paths_cache_key(project_paths: &[String]) -> String {
    if project_paths.is_empty() {
        return "__all__".to_string();
    }
    serde_json::to_string(project_paths).unwrap_or_else(|_| project_paths.join("\u{1f}"))
}

pub(super) fn source_includes(source: &Option<String>, target: &str) -> bool {
    source
        .as_deref()
        .map(|value| {
            let value = value.trim();
            value.is_empty()
                || value.eq_ignore_ascii_case("all")
                || value.eq_ignore_ascii_case(target)
        })
        .unwrap_or(true)
}

pub(super) async fn opencode_list_prompts(
    scope: Option<String>,
    project_key: Option<String>,
    file_path: Option<String>,
    query: Option<String>,
    limit: usize,
) -> Result<Vec<HistoryPromptItem>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let scope = scope
        .as_deref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "global".to_string());
    let target_project = project_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let target_file = file_path
        .map(|value| normalize_history_path(&value))
        .filter(|value| !value.is_empty());
    let normalized_query = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let mut prompts = Vec::new();

    for parsed in opencode_catalog_sessions().await?.unwrap_or_default() {
        if target_project
            .as_deref()
            .is_some_and(|project| parsed.file_ref.project_key != project)
        {
            continue;
        }
        if scope == "session" {
            let Some(target) = target_file.as_ref() else {
                continue;
            };
            if normalize_history_path(&parsed.file_ref.path.to_string_lossy()) != *target {
                continue;
            }
        }
        let title_lower = parsed.computed.title.to_lowercase();
        for (message_index, message) in parsed.messages.into_iter().enumerate() {
            if message.role != "user" {
                continue;
            }
            let prompt = normalize_text(&message.content);
            if prompt.is_empty() {
                continue;
            }
            if let Some(query) = &normalized_query {
                let prompt_lower = prompt.to_lowercase();
                if !prompt_lower.contains(query) && !title_lower.contains(query) {
                    continue;
                }
            }
            prompts.push(HistoryPromptItem {
                session_id: parsed.computed.session_id.clone(),
                source: "opencode".to_string(),
                project_key: parsed.file_ref.project_key.clone(),
                file_path: parsed.file_ref.path.to_string_lossy().to_string(),
                session_title: parsed.computed.title.clone(),
                updated_at: parsed.computed.updated_at,
                message_index,
                prompt,
                timestamp: message.timestamp,
            });
            if prompts.len() >= limit {
                return Ok(prompts);
            }
        }
    }
    Ok(prompts)
}

pub(super) async fn opencode_stats_facts(
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_paths: &[String],
    bounds: StatsTimeBounds,
) -> Result<Vec<HistoryStatsSessionFact>, String> {
    if source_filter.is_some_and(|source| source != "opencode") {
        return Ok(Vec::new());
    }
    let mut facts = Vec::new();
    for parsed in opencode_catalog_sessions().await?.unwrap_or_default() {
        if target_project.is_some_and(|project| parsed.file_ref.project_key != project) {
            continue;
        }
        if !target_project_paths.is_empty()
            && !target_project_paths.iter().any(|project_path| {
                parsed
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| opencode_cwd_matches_project_path(cwd, project_path))
            })
        {
            continue;
        }
        let summary = opencode_summary_from_parsed(&parsed);
        for event in stats_usage_events_or_fallback(&summary, &parsed.computed.stats) {
            let occurred_at = event.timestamp_ms.unwrap_or(summary.updated_at);
            if occurred_at < bounds.start_at || occurred_at > bounds.end_at {
                continue;
            }
            facts.push(HistoryStatsSessionFact {
                summary: summary.clone(),
                occurred_at,
                stats: reprice_usage_stats(event.model.as_deref(), event.usage),
                model: event.model,
            });
        }
    }
    Ok(facts)
}

pub(super) fn opencode_stats_generation() -> String {
    let database_path = resolve_opencode_database_path();
    let wal_path = PathBuf::from(format!("{}-wal", database_path.to_string_lossy()));
    let database = session_file_fingerprint(&database_path);
    let wal = session_file_fingerprint(&wal_path);
    format!(
        "db={}:{}:{}|wal={}:{}:{}",
        database.created_at,
        database.updated_at,
        database.size,
        wal.created_at,
        wal.updated_at,
        wal.size
    )
}

pub(super) fn opencode_summary_from_parsed(
    parsed: &OpenCodeParsedSession,
) -> HistorySessionSummary {
    HistorySessionSummary {
        session_id: parsed.computed.session_id.clone(),
        parent_session_id: parsed.computed.parent_session_id.clone(),
        source: "opencode".to_string(),
        project_key: parsed.file_ref.project_key.clone(),
        title: parsed.computed.title.clone(),
        file_path: parsed.file_ref.path.to_string_lossy().to_string(),
        cwd: parsed.cwd.clone(),
        created_at: parsed.computed.created_at,
        updated_at: parsed.computed.updated_at,
        message_count: parsed.computed.message_count,
        branch: None,
    }
}

pub(super) fn opencode_cwd_matches_project_path(cwd: &str, target_project_path: &str) -> bool {
    let cwd = normalize_history_path(cwd);
    cwd_matches_target(&cwd, target_project_path)
        || crate::wsl::windows_path_to_wsl(target_project_path)
            .as_deref()
            .is_some_and(|target| cwd_matches_target(&cwd, target))
        || crate::wsl::parse_wsl_unc_path(target_project_path)
            .map(|(_, target)| cwd_matches_target(&cwd, &target))
            .unwrap_or(false)
}

pub(super) fn build_history_stats_daily_index(
    entries: Vec<HistoryIndexEntry>,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_paths: &[String],
    bounds: StatsTimeBounds,
) -> CachedHistoryStatsDailyIndex {
    let mut days: BTreeMap<i64, Vec<HistoryStatsSessionFact>> = BTreeMap::new();
    let day_offset = stats_day_start_offset(bounds);

    for entry in entries {
        if let Some(filter) = source_filter {
            if entry.file_ref.source != filter {
                continue;
            }
        }
        if let Some(project) = target_project {
            if entry.file_ref.project_key != project {
                continue;
            }
        }
        if !target_project_paths.is_empty()
            && !target_project_paths
                .iter()
                .any(|project_path| session_matches_project_path(&entry.file_ref, project_path))
        {
            continue;
        }

        let computed = entry.computed;
        let summary = summary_from_computation(&entry.file_ref, &computed);
        let usage_events = stats_usage_events_or_fallback(&summary, &computed.stats);
        for event in usage_events {
            let occurred_at = event.timestamp_ms.unwrap_or(summary.updated_at);
            let repriced_stats = reprice_usage_stats(event.model.as_deref(), event.usage);
            let day_start = stats_day_start_with_offset(occurred_at, day_offset);
            days.entry(day_start)
                .or_default()
                .push(HistoryStatsSessionFact {
                    summary: summary.clone(),
                    occurred_at,
                    stats: repriced_stats,
                    model: event.model,
                });
        }
    }

    CachedHistoryStatsDailyIndex {
        days,
        cached_at: now_millis(),
    }
}

pub(super) fn build_history_stats_response(
    daily_index: &BTreeMap<i64, Vec<HistoryStatsSessionFact>>,
    bounds: StatsTimeBounds,
) -> HistoryStatsResponse {
    let mut total_sessions = 0usize;
    let mut total_messages = 0usize;
    let mut total_input_tokens = 0u64;
    let mut total_output_tokens = 0u64;
    let mut total_cache_read_tokens = 0u64;
    let mut total_cache_creation_tokens = 0u64;
    let mut total_cost_usd = 0.0f64;
    let mut total_unpriced_tokens = 0u64;
    let mut project_map: HashMap<String, HistoryStatsProjectItem> = HashMap::new();
    let mut model_map: HashMap<String, HistoryStatsModelItem> = HashMap::new();
    let mut source_map: HashMap<String, HistoryStatsSourceItem> = HashMap::new();
    let mut day_map: BTreeMap<i64, DayStatsAggregate> = BTreeMap::new();
    let mut hourly_map: Vec<HourStatsAggregate> = vec![HourStatsAggregate::default(); 24];
    let mut seen_total_sessions: HashSet<String> = HashSet::new();
    let mut seen_project_sessions: HashSet<String> = HashSet::new();
    let mut seen_source_sessions: HashSet<String> = HashSet::new();
    let mut seen_model_sessions: HashSet<String> = HashSet::new();
    let mut seen_day_sessions: HashSet<String> = HashSet::new();
    let mut seen_hour_sessions: Vec<HashSet<String>> = (0..24).map(|_| HashSet::new()).collect();

    for day_idx in 0..bounds.range_days {
        let day_start = bounds.start_day + day_idx as i64 * DAY_MS;
        let Some(facts) = daily_index.get(&day_start) else {
            continue;
        };

        for fact in facts {
            if fact.occurred_at < bounds.start_at || fact.occurred_at > bounds.end_at {
                continue;
            }

            let summary = &fact.summary;
            let stats = &fact.stats;
            let session_key = history_stats_session_key(summary);

            if seen_total_sessions.insert(session_key.clone()) {
                total_sessions += 1;
                total_messages += summary.message_count;
            }
            total_input_tokens = total_input_tokens.saturating_add(stats.input_tokens);
            total_output_tokens = total_output_tokens.saturating_add(stats.output_tokens);
            total_cache_read_tokens =
                total_cache_read_tokens.saturating_add(stats.cache_read_tokens);
            total_cache_creation_tokens =
                total_cache_creation_tokens.saturating_add(stats.cache_creation_tokens);
            total_cost_usd += stats.total_cost_usd;
            total_unpriced_tokens = total_unpriced_tokens.saturating_add(stats.unpriced_tokens);

            let hour = hour_of_day_for_stats(fact.occurred_at, bounds);
            let hour_session_key = format!("{hour}|{session_key}");
            if seen_hour_sessions[hour].insert(hour_session_key) {
                hourly_map[hour].sessions += 1;
                hourly_map[hour].messages += summary.message_count;
                hourly_map[hour].session_refs.push(summary.clone());
            }
            hourly_map[hour].input_tokens = hourly_map[hour]
                .input_tokens
                .saturating_add(stats.input_tokens);
            hourly_map[hour].output_tokens = hourly_map[hour]
                .output_tokens
                .saturating_add(stats.output_tokens);
            hourly_map[hour].cache_read_tokens = hourly_map[hour]
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            hourly_map[hour].cache_creation_tokens = hourly_map[hour]
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            hourly_map[hour].total_cost_usd += stats.total_cost_usd;
            hourly_map[hour].unpriced_tokens = hourly_map[hour]
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);

            let project_entry =
                project_map
                    .entry(summary.project_key.clone())
                    .or_insert(HistoryStatsProjectItem {
                        project_key: summary.project_key.clone(),
                        sessions: 0,
                        messages: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        total_cost_usd: 0.0,
                        unpriced_tokens: 0,
                    });
            let project_session_key = format!("{}|{}", summary.project_key, session_key);
            if seen_project_sessions.insert(project_session_key) {
                project_entry.sessions += 1;
                project_entry.messages += summary.message_count;
            }
            project_entry.input_tokens = project_entry
                .input_tokens
                .saturating_add(stats.input_tokens);
            project_entry.output_tokens = project_entry
                .output_tokens
                .saturating_add(stats.output_tokens);
            project_entry.cache_read_tokens = project_entry
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            project_entry.cache_creation_tokens = project_entry
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            project_entry.total_cost_usd += stats.total_cost_usd;
            project_entry.unpriced_tokens = project_entry
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);

            let source_entry =
                source_map
                    .entry(summary.source.clone())
                    .or_insert(HistoryStatsSourceItem {
                        source: summary.source.clone(),
                        sessions: 0,
                        messages: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        total_cost_usd: 0.0,
                        unpriced_tokens: 0,
                    });
            let source_session_key = format!("{}|{}", summary.source, session_key);
            if seen_source_sessions.insert(source_session_key) {
                source_entry.sessions += 1;
                source_entry.messages += summary.message_count;
            }
            source_entry.input_tokens =
                source_entry.input_tokens.saturating_add(stats.input_tokens);
            source_entry.output_tokens = source_entry
                .output_tokens
                .saturating_add(stats.output_tokens);
            source_entry.cache_read_tokens = source_entry
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            source_entry.cache_creation_tokens = source_entry
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            source_entry.total_cost_usd += stats.total_cost_usd;
            source_entry.unpriced_tokens = source_entry
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);

            let model_name = fact.model.clone().unwrap_or_else(|| "unknown".to_string());
            let model_entry =
                model_map
                    .entry(model_name.clone())
                    .or_insert(HistoryStatsModelItem {
                        model: model_name,
                        sessions: 0,
                        ratio: 0.0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        total_cost_usd: 0.0,
                        unpriced_tokens: 0,
                    });
            let model_session_key = format!("{}|{}", model_entry.model, session_key);
            if seen_model_sessions.insert(model_session_key) {
                model_entry.sessions += 1;
            }
            model_entry.input_tokens = model_entry.input_tokens.saturating_add(stats.input_tokens);
            model_entry.output_tokens = model_entry
                .output_tokens
                .saturating_add(stats.output_tokens);
            model_entry.cache_read_tokens = model_entry
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            model_entry.cache_creation_tokens = model_entry
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            model_entry.total_cost_usd += stats.total_cost_usd;
            model_entry.unpriced_tokens = model_entry
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);

            let day_entry = day_map.entry(day_start).or_insert(DayStatsAggregate {
                sessions: 0,
                messages: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                total_cost_usd: 0.0,
                unpriced_tokens: 0,
                session_refs: Vec::new(),
            });
            let day_session_key = format!("{day_start}|{session_key}");
            if seen_day_sessions.insert(day_session_key) {
                day_entry.sessions += 1;
                day_entry.messages += summary.message_count;
                day_entry.session_refs.push(summary.clone());
            }
            day_entry.input_tokens = day_entry.input_tokens.saturating_add(stats.input_tokens);
            day_entry.output_tokens = day_entry.output_tokens.saturating_add(stats.output_tokens);
            day_entry.cache_read_tokens = day_entry
                .cache_read_tokens
                .saturating_add(stats.cache_read_tokens);
            day_entry.cache_creation_tokens = day_entry
                .cache_creation_tokens
                .saturating_add(stats.cache_creation_tokens);
            day_entry.total_cost_usd += stats.total_cost_usd;
            day_entry.unpriced_tokens = day_entry
                .unpriced_tokens
                .saturating_add(stats.unpriced_tokens);
        }
    }

    let mut project_ranking: Vec<HistoryStatsProjectItem> = project_map.into_values().collect();
    project_ranking.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then(b.messages.cmp(&a.messages))
            .then(a.project_key.cmp(&b.project_key))
    });

    let mut model_distribution: Vec<HistoryStatsModelItem> = model_map
        .into_values()
        .map(|mut item| {
            item.ratio = if total_sessions == 0 {
                0.0
            } else {
                item.sessions as f64 / total_sessions as f64
            };
            item
        })
        .collect();
    model_distribution.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then_with(|| history_stats_total_tokens(b).cmp(&history_stats_total_tokens(a)))
            .then(a.model.cmp(&b.model))
    });

    let mut source_distribution: Vec<HistoryStatsSourceItem> = source_map.into_values().collect();
    source_distribution.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then(b.messages.cmp(&a.messages))
            .then(a.source.cmp(&b.source))
    });

    let mut project_efficiency: Vec<HistoryStatsProjectEfficiencyItem> = project_ranking
        .iter()
        .map(|item| HistoryStatsProjectEfficiencyItem {
            project_key: item.project_key.clone(),
            sessions: item.sessions,
            messages: item.messages,
            input_tokens: item.input_tokens,
            output_tokens: item.output_tokens,
            cache_read_tokens: item.cache_read_tokens,
            cache_creation_tokens: item.cache_creation_tokens,
            total_cost_usd: item.total_cost_usd,
            unpriced_tokens: item.unpriced_tokens,
            avg_messages_per_session: if item.sessions == 0 {
                0.0
            } else {
                item.messages as f64 / item.sessions as f64
            },
        })
        .collect();
    project_efficiency.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then_with(|| {
                b.avg_messages_per_session
                    .total_cmp(&a.avg_messages_per_session)
            })
            .then(a.project_key.cmp(&b.project_key))
    });

    let max_hour_sessions = hourly_map
        .iter()
        .map(|item| item.sessions)
        .max()
        .unwrap_or(0);
    let hourly_activity: Vec<HistoryStatsHourlyActivityItem> = hourly_map
        .into_iter()
        .enumerate()
        .map(|(hour, mut agg)| {
            agg.session_refs.sort_by(|a, b| {
                b.updated_at
                    .cmp(&a.updated_at)
                    .then(a.session_id.cmp(&b.session_id))
            });
            HistoryStatsHourlyActivityItem {
                hour: hour as u8,
                hour_start_utc: bounds.start_day + hour as i64 * HOUR_MS,
                sessions: agg.sessions,
                messages: agg.messages,
                level: calc_heat_level(agg.sessions, max_hour_sessions),
                input_tokens: agg.input_tokens,
                output_tokens: agg.output_tokens,
                cache_read_tokens: agg.cache_read_tokens,
                cache_creation_tokens: agg.cache_creation_tokens,
                total_cost_usd: agg.total_cost_usd,
                unpriced_tokens: agg.unpriced_tokens,
                session_refs: agg.session_refs,
            }
        })
        .collect();

    let max_day_sessions = day_map
        .values()
        .map(|item| item.sessions)
        .max()
        .unwrap_or(0);
    let mut heatmap = Vec::with_capacity(bounds.range_days);
    let mut daily_series = Vec::with_capacity(bounds.range_days);
    for day_idx in 0..bounds.range_days {
        let day_start = bounds.start_day + day_idx as i64 * DAY_MS;
        if let Some(mut day) = day_map.remove(&day_start) {
            day.session_refs.sort_by(|a, b| {
                b.updated_at
                    .cmp(&a.updated_at)
                    .then(a.session_id.cmp(&b.session_id))
            });
            let level = calc_heat_level(day.sessions, max_day_sessions);
            heatmap.push(HistoryStatsHeatmapDay {
                day_start_utc: day_start,
                sessions: day.sessions,
                messages: day.messages,
                level,
                session_refs: day.session_refs,
            });
            daily_series.push(HistoryStatsDailySeriesItem {
                day_start_utc: day_start,
                sessions: day.sessions,
                messages: day.messages,
                input_tokens: day.input_tokens,
                output_tokens: day.output_tokens,
                cache_read_tokens: day.cache_read_tokens,
                cache_creation_tokens: day.cache_creation_tokens,
                total_cost_usd: day.total_cost_usd,
                unpriced_tokens: day.unpriced_tokens,
            });
        } else {
            heatmap.push(HistoryStatsHeatmapDay {
                day_start_utc: day_start,
                sessions: 0,
                messages: 0,
                level: 0,
                session_refs: Vec::new(),
            });
            daily_series.push(HistoryStatsDailySeriesItem {
                day_start_utc: day_start,
                sessions: 0,
                messages: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                total_cost_usd: 0.0,
                unpriced_tokens: 0,
            });
        }
    }

    HistoryStatsResponse {
        range_days: bounds.range_days,
        total_sessions,
        total_messages,
        total_input_tokens,
        total_output_tokens,
        total_cache_read_tokens,
        total_cache_creation_tokens,
        total_cost_usd,
        total_unpriced_tokens,
        project_ranking,
        model_distribution,
        heatmap,
        daily_series,
        source_distribution,
        project_efficiency,
        hourly_activity,
        data_quality: HistoryStatsDataQuality::default(),
    }
}

pub(super) fn resolve_stats_time_bounds(
    range_days: Option<usize>,
    start_at: Option<i64>,
    end_at: Option<i64>,
) -> Result<StatsTimeBounds, String> {
    if let (Some(start_at), Some(end_at)) = (start_at, end_at) {
        if start_at <= 0 || end_at <= 0 || end_at < start_at {
            return Err("invalid_date_range".to_string());
        }
        let span_ms = end_at.saturating_sub(start_at);
        let range_days = (span_ms / DAY_MS).saturating_add(1) as usize;
        if range_days == 0 || range_days > MAX_STATS_RANGE_DAYS {
            return Err("date_range_too_large".to_string());
        }
        return Ok(StatsTimeBounds {
            start_at,
            end_at,
            start_day: start_at,
            range_days,
            explicit: true,
        });
    }
    if start_at.is_some() || end_at.is_some() {
        return Err("invalid_date_range".to_string());
    }

    let range_days = range_days.unwrap_or(30).clamp(1, MAX_STATS_RANGE_DAYS);
    let end_day = day_start_utc(now_millis());
    let start_day = end_day - (range_days as i64 - 1) * DAY_MS;
    Ok(StatsTimeBounds {
        start_at: start_day,
        end_at: end_day + DAY_MS - 1,
        start_day,
        range_days,
        explicit: false,
    })
}

pub(super) fn stats_day_start_offset(bounds: StatsTimeBounds) -> i64 {
    if bounds.explicit {
        ((bounds.start_day % DAY_MS) + DAY_MS) % DAY_MS
    } else {
        0
    }
}

pub(super) fn stats_day_start_with_offset(ts: i64, day_offset: i64) -> i64 {
    if ts <= 0 {
        return day_offset;
    }
    ts - (((ts - day_offset) % DAY_MS) + DAY_MS) % DAY_MS
}

pub(super) fn stats_usage_events_or_fallback(
    summary: &HistorySessionSummary,
    stats: &SessionStatsScan,
) -> Vec<SessionUsageEventScan> {
    if !stats.usage_events.is_empty() {
        return stats.usage_events.clone();
    }

    let usage = UsageStatsScan {
        input_tokens: stats.input_tokens,
        output_tokens: stats.output_tokens,
        cache_read_tokens: stats.cache_read_tokens,
        cache_creation_tokens: stats.cache_creation_tokens,
        total_cost_usd: stats.total_cost_usd,
        unpriced_tokens: stats.unpriced_tokens,
    };
    if usage_stats_total_tokens(usage) == 0 {
        return Vec::new();
    }

    vec![SessionUsageEventScan {
        event_key: format!("fallback:{}:{}", summary.session_id, summary.updated_at),
        event_index: 0,
        timestamp_ms: Some(summary.updated_at),
        model: stats.dominant_model.clone(),
        usage,
    }]
}

pub(super) fn reprice_usage_stats(model: Option<&str>, usage: UsageStatsScan) -> UsageStatsScan {
    calculate_usage_cost(
        model,
        UsageTokenScan {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            explicit_cost_usd: None,
        },
    )
}

pub(super) fn history_stats_session_key(summary: &HistorySessionSummary) -> String {
    format!(
        "{}|{}|{}|{}",
        summary.source, summary.project_key, summary.session_id, summary.file_path
    )
}

pub(super) fn make_history_stats_daily_index_cache_key(
    roots: &HistoryRoots,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_paths: &[String],
    target_source_instance: Option<&str>,
    bounds: StatsTimeBounds,
    index_generation: u64,
) -> String {
    format!(
        "{}|source={}|project={}|project_paths={}|source_instance={}|day_offset={}|gen={}",
        roots.cache_key(),
        source_filter.unwrap_or("__all__"),
        target_project.unwrap_or("__all__"),
        history_stats_project_paths_cache_key(target_project_paths),
        target_source_instance.unwrap_or("__all__"),
        stats_day_start_offset(bounds),
        index_generation
    )
}

pub(super) fn make_history_stats_aggregation_cache_key(
    roots: &HistoryRoots,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_paths: &[String],
    target_source_instance: Option<&str>,
    bounds: StatsTimeBounds,
    index_generation: u64,
    opencode_generation: Option<&str>,
    route_usage_generation: u64,
) -> String {
    format!(
        "{}|source={}|project={}|project_paths={}|source_instance={}|start={}|end={}|gen={}|opencode_gen={}|route_gen={}",
        roots.cache_key(),
        source_filter.unwrap_or("__all__"),
        target_project.unwrap_or("__all__"),
        history_stats_project_paths_cache_key(target_project_paths),
        target_source_instance.unwrap_or("__all__"),
        bounds.start_at,
        bounds.end_at,
        index_generation,
        opencode_generation.unwrap_or("__excluded__"),
        route_usage_generation
    )
}

pub(super) fn get_stats_aggregation_cache() -> &'static Mutex<HistoryStatsAggregationCache> {
    HISTORY_STATS_AGGREGATION_CACHE
        .get_or_init(|| Mutex::new(HistoryStatsAggregationCache::default()))
}

pub(super) fn stats_aggregation_cache_get(key: &str) -> Option<HistoryStatsResponse> {
    let cache = get_stats_aggregation_cache().lock().ok()?;
    cache.entries.get(key).map(|entry| entry.response.clone())
}

pub(super) fn stats_aggregation_cache_set(key: String, response: HistoryStatsResponse) {
    if let Ok(mut cache) = get_stats_aggregation_cache().lock() {
        if !cache.entries.contains_key(&key)
            && cache.entries.len() >= HISTORY_STATS_AGGREGATION_CACHE_MAX
        {
            if let Some(oldest_key) = cache
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.cached_at)
                .map(|(key, _)| key.clone())
            {
                cache.entries.remove(&oldest_key);
            }
        }
        cache.entries.insert(
            key,
            CachedHistoryStatsAggregation {
                response,
                cached_at: now_millis(),
            },
        );
    }
}

pub(super) fn get_stats_daily_index_cache() -> &'static Mutex<HistoryStatsDailyIndexCache> {
    HISTORY_STATS_DAILY_INDEX_CACHE
        .get_or_init(|| Mutex::new(HistoryStatsDailyIndexCache::default()))
}

pub(super) fn stats_daily_index_cache_get(key: &str) -> Option<CachedHistoryStatsDailyIndex> {
    let cache = get_stats_daily_index_cache().lock().ok()?;
    cache.entries.get(key).cloned()
}

pub(super) fn stats_daily_index_cache_set(key: String, daily_index: CachedHistoryStatsDailyIndex) {
    if let Ok(mut cache) = get_stats_daily_index_cache().lock() {
        if !cache.entries.contains_key(&key)
            && cache.entries.len() >= HISTORY_STATS_DAILY_INDEX_CACHE_MAX
        {
            if let Some(oldest_key) = cache
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.cached_at)
                .map(|(key, _)| key.clone())
            {
                cache.entries.remove(&oldest_key);
            }
        }
        cache.entries.insert(key, daily_index);
    }
}
