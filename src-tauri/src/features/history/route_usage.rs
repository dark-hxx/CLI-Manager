use super::{
    build_history_stats_response, calculate_usage_cost, history_stats_total_tokens,
    reprice_usage_stats, session_matches_project_path, HistoryStatsDataQuality,
    HistoryStatsModelItem, HistoryStatsResponse, HistoryStatsSessionFact, HistoryStatsSourceItem,
    SessionFileRef, StatsTimeBounds, UsageStatsScan, UsageTokenScan,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

// 按时间与来源查询用量记录质量计数，不按项目或来源实例过滤。
pub(super) async fn load_history_stats_data_quality(
    bounds: StatsTimeBounds,
    source_filter: Option<&str>,
) -> Result<HistoryStatsDataQuality, String> {
    let mut connection = crate::usage_schema::open_usage_database().await?;
    let row = sqlx::query(
        "SELECT
            SUM(CASE WHEN data_source = 'route' THEN 1 ELSE 0 END) AS route_records,
            SUM(CASE WHEN data_source = 'session_log' THEN 1 ELSE 0 END) AS session_fallback_records,
            SUM(CASE WHEN data_source = 'route' AND attribution_status <> 'resolved' THEN 1 ELSE 0 END) AS unattributed_records,
            SUM(CASE WHEN usage_status IN ('missing', 'invalid') THEN 1 ELSE 0 END) AS missing_usage_records
         FROM usage_records
         WHERE started_at_ms BETWEEN ?1 AND ?2
           AND (?3 IS NULL OR source = ?3)",
    )
    .bind(bounds.start_at)
    .bind(bounds.end_at)
    .bind(source_filter)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| format!("usage_quality_query_failed: {err}"))?;
    Ok(HistoryStatsDataQuality {
        route_records: row.try_get::<i64, _>("route_records").unwrap_or(0).max(0) as usize,
        session_fallback_records: row
            .try_get::<i64, _>("session_fallback_records")
            .unwrap_or(0)
            .max(0) as usize,
        unattributed_records: row
            .try_get::<i64, _>("unattributed_records")
            .unwrap_or(0)
            .max(0) as usize,
        missing_usage_records: row
            .try_get::<i64, _>("missing_usage_records")
            .unwrap_or(0)
            .max(0) as usize,
    })
}

// 用匹配路由事实替换本地用量并重建统计，将未匹配路由追加到总量、模型与来源维度。
pub(super) async fn merge_route_usage_into_history_stats(
    response: &mut HistoryStatsResponse,
    _days: &mut BTreeMap<i64, Vec<HistoryStatsSessionFact>>,
    bounds: StatsTimeBounds,
    source_filter: Option<&str>,
    target_project: Option<&str>,
    target_project_paths: &[String],
) -> Result<(), String> {
    let route_records =
        crate::usage::load_route_usage_records(bounds.start_at, bounds.end_at).await?;
    if route_records.is_empty() {
        return Ok(());
    }
    let selected_records = route_records
        .into_iter()
        .filter(|record| {
            source_filter.is_none_or(|source| source == record.source)
                && target_project
                    .is_none_or(|project| record.project_key.as_deref() == Some(project))
                && (target_project_paths.is_empty()
                    || record.session_id.as_deref().is_some_and(|session_id| {
                        _days.values().flatten().any(|fact| {
                            fact.summary.session_id == session_id
                                && target_project_paths.iter().any(|path| {
                                    session_matches_project_path(
                                        &SessionFileRef {
                                            source: fact.summary.source.clone(),
                                            project_key: fact.summary.project_key.clone(),
                                            path: PathBuf::from(&fact.summary.file_path),
                                        },
                                        path,
                                    )
                                })
                        })
                    }))
                && (record.usage_status == "complete" || record.usage_status == "partial")
        })
        .collect::<Vec<_>>();
    if selected_records.is_empty() {
        return Ok(());
    }
    let mut matched_route_records = HashSet::new();
    if !selected_records.is_empty() {
        for facts in _days.values_mut() {
            for fact in facts.iter_mut() {
                if let Some((index, record)) =
                    selected_records.iter().enumerate().find(|(index, record)| {
                        !matched_route_records.contains(index)
                            && route_record_matches_fact(record, fact)
                    })
                {
                    matched_route_records.insert(index);
                    fact.stats = reprice_usage_stats(
                        record.model.as_deref(),
                        UsageStatsScan {
                            input_tokens: record.usage.input_tokens,
                            output_tokens: record.usage.output_tokens,
                            cache_read_tokens: record.usage.cache_read_tokens,
                            cache_creation_tokens: record.usage.cache_creation_tokens,
                            total_cost_usd: 0.0,
                            unpriced_tokens: 0,
                        },
                    );
                    fact.model = record.model.clone();
                }
            }
        }
        // Rebuild all dimensions from the original session facts with only the matched
        // usage fields replaced by route truth.
        *response = build_history_stats_response(_days, bounds);
    }
    let mut route_total = UsageStatsScan::default();
    let mut route_models: HashMap<String, UsageStatsScan> = HashMap::new();
    let mut route_sources: HashMap<String, UsageStatsScan> = HashMap::new();
    for (index, record) in selected_records.into_iter().enumerate() {
        if matched_route_records.contains(&index) {
            continue;
        }
        let usage = UsageTokenScan {
            input_tokens: record.usage.input_tokens,
            output_tokens: record.usage.output_tokens,
            cache_read_tokens: record.usage.cache_read_tokens,
            cache_creation_tokens: record.usage.cache_creation_tokens,
            explicit_cost_usd: None,
        };
        let priced = calculate_usage_cost(record.model.as_deref(), usage);
        route_total.input_tokens = route_total.input_tokens.saturating_add(priced.input_tokens);
        route_total.output_tokens = route_total
            .output_tokens
            .saturating_add(priced.output_tokens);
        route_total.cache_read_tokens = route_total
            .cache_read_tokens
            .saturating_add(priced.cache_read_tokens);
        route_total.cache_creation_tokens = route_total
            .cache_creation_tokens
            .saturating_add(priced.cache_creation_tokens);
        route_total.total_cost_usd += priced.total_cost_usd;
        route_total.unpriced_tokens = route_total
            .unpriced_tokens
            .saturating_add(priced.unpriced_tokens);
        if let Some(model) = record.model.clone() {
            let entry = route_models.entry(model).or_default();
            entry.input_tokens = entry.input_tokens.saturating_add(priced.input_tokens);
            entry.output_tokens = entry.output_tokens.saturating_add(priced.output_tokens);
            entry.cache_read_tokens = entry
                .cache_read_tokens
                .saturating_add(priced.cache_read_tokens);
            entry.cache_creation_tokens = entry
                .cache_creation_tokens
                .saturating_add(priced.cache_creation_tokens);
            entry.total_cost_usd += priced.total_cost_usd;
            entry.unpriced_tokens = entry.unpriced_tokens.saturating_add(priced.unpriced_tokens);
        }
        let entry = route_sources.entry(record.source).or_default();
        entry.input_tokens = entry.input_tokens.saturating_add(priced.input_tokens);
        entry.output_tokens = entry.output_tokens.saturating_add(priced.output_tokens);
        entry.cache_read_tokens = entry
            .cache_read_tokens
            .saturating_add(priced.cache_read_tokens);
        entry.cache_creation_tokens = entry
            .cache_creation_tokens
            .saturating_add(priced.cache_creation_tokens);
        entry.total_cost_usd += priced.total_cost_usd;
        entry.unpriced_tokens = entry.unpriced_tokens.saturating_add(priced.unpriced_tokens);
    }
    response.total_input_tokens = response
        .total_input_tokens
        .saturating_add(route_total.input_tokens);
    response.total_output_tokens = response
        .total_output_tokens
        .saturating_add(route_total.output_tokens);
    response.total_cache_read_tokens = response
        .total_cache_read_tokens
        .saturating_add(route_total.cache_read_tokens);
    response.total_cache_creation_tokens = response
        .total_cache_creation_tokens
        .saturating_add(route_total.cache_creation_tokens);
    response.total_cost_usd += route_total.total_cost_usd;
    response.total_unpriced_tokens = response
        .total_unpriced_tokens
        .saturating_add(route_total.unpriced_tokens);
    for (model, usage) in route_models {
        if let Some(item) = response
            .model_distribution
            .iter_mut()
            .find(|item| item.model == model)
        {
            item.input_tokens = item.input_tokens.saturating_add(usage.input_tokens);
            item.output_tokens = item.output_tokens.saturating_add(usage.output_tokens);
            item.cache_read_tokens = item
                .cache_read_tokens
                .saturating_add(usage.cache_read_tokens);
            item.cache_creation_tokens = item
                .cache_creation_tokens
                .saturating_add(usage.cache_creation_tokens);
            item.total_cost_usd += usage.total_cost_usd;
            item.unpriced_tokens = item.unpriced_tokens.saturating_add(usage.unpriced_tokens);
        } else {
            response.model_distribution.push(HistoryStatsModelItem {
                model,
                sessions: 0,
                ratio: 0.0,
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_creation_tokens: usage.cache_creation_tokens,
                total_cost_usd: usage.total_cost_usd,
                unpriced_tokens: usage.unpriced_tokens,
            });
        }
    }
    response.model_distribution.sort_by(|left, right| {
        history_stats_total_tokens(right)
            .cmp(&history_stats_total_tokens(left))
            .then(left.model.cmp(&right.model))
    });
    for (source, usage) in route_sources {
        if let Some(item) = response
            .source_distribution
            .iter_mut()
            .find(|item| item.source == source)
        {
            item.input_tokens = item.input_tokens.saturating_add(usage.input_tokens);
            item.output_tokens = item.output_tokens.saturating_add(usage.output_tokens);
            item.cache_read_tokens = item
                .cache_read_tokens
                .saturating_add(usage.cache_read_tokens);
            item.cache_creation_tokens = item
                .cache_creation_tokens
                .saturating_add(usage.cache_creation_tokens);
            item.total_cost_usd += usage.total_cost_usd;
            item.unpriced_tokens = item.unpriced_tokens.saturating_add(usage.unpriced_tokens);
        } else {
            response.source_distribution.push(HistoryStatsSourceItem {
                source,
                sessions: 0,
                messages: 0,
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_creation_tokens: usage.cache_creation_tokens,
                total_cost_usd: usage.total_cost_usd,
                unpriced_tokens: usage.unpriced_tokens,
            });
        }
    }
    Ok(())
}

// 按来源、会话、两分钟事件窗口及兼容模型和 token 口径判断路由事实是否重复。
pub(super) fn route_record_matches_fact(
    record: &crate::usage::RouteUsageRecord,
    fact: &HistoryStatsSessionFact,
) -> bool {
    let Some(session_id) = record.session_id.as_deref() else {
        return false;
    };
    if session_id.trim().is_empty()
        || record.source != fact.summary.source
        || fact.summary.session_id != session_id
    {
        return false;
    }
    let route_event_at = record.completed_at_ms.unwrap_or(record.timestamp_ms);
    if (route_event_at - fact.occurred_at).unsigned_abs() > 120_000 {
        return false;
    }
    if record
        .model
        .as_deref()
        .zip(fact.model.as_deref())
        .is_some_and(|(route_model, session_model)| {
            !route_model.eq_ignore_ascii_case("unknown")
                && !session_model.eq_ignore_ascii_case("unknown")
                && !route_model.eq_ignore_ascii_case(session_model)
        })
    {
        return false;
    }
    let session_total_input = fact
        .stats
        .input_tokens
        .saturating_add(fact.stats.cache_read_tokens)
        .saturating_add(fact.stats.cache_creation_tokens);
    let route_total_input = record
        .usage
        .input_tokens
        .saturating_add(record.usage.cache_read_tokens)
        .saturating_add(record.usage.cache_creation_tokens);
    record.usage.output_tokens == fact.stats.output_tokens
        && (record.usage.input_tokens == fact.stats.input_tokens
            || record.usage.input_tokens == session_total_input
            || route_total_input == fact.stats.input_tokens)
}
use sqlx::Row;
