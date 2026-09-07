use super::*;

#[test]
fn route_usage_matches_cache_split_session_fact_at_completion_time() {
    let fact = request_log_dedup_fixture(
        "codex",
        "session-a",
        30_100,
        "gpt-test",
        UsageStatsScan {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 900,
            cache_creation_tokens: 0,
            total_cost_usd: 0.0,
            unpriced_tokens: 0,
        },
    );
    let record = crate::usage::RouteUsageRecord {
        source: "codex".to_string(),
        session_id: Some("session-a".to_string()),
        project_key: Some("project".to_string()),
        file_path: Some("session.jsonl".to_string()),
        timestamp_ms: 10_000,
        completed_at_ms: Some(30_000),
        model: Some("gpt-test".to_string()),
        usage: crate::usage::UsageTokens {
            input_tokens: 1_000,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
        },
        usage_status: "complete".to_string(),
    };

    assert!(route_record_matches_fact(&record, &fact));
}

#[test]
fn route_usage_does_not_replace_another_source_or_token_event() {
    let fact = request_log_dedup_fixture(
        "claude",
        "session-a",
        30_100,
        "gpt-test",
        UsageStatsScan {
            input_tokens: 100,
            output_tokens: 21,
            cache_read_tokens: 900,
            cache_creation_tokens: 0,
            total_cost_usd: 0.0,
            unpriced_tokens: 0,
        },
    );
    let record = crate::usage::RouteUsageRecord {
        source: "codex".to_string(),
        session_id: Some("session-a".to_string()),
        project_key: Some("project".to_string()),
        file_path: Some("session.jsonl".to_string()),
        timestamp_ms: 10_000,
        completed_at_ms: Some(30_000),
        model: Some("gpt-test".to_string()),
        usage: crate::usage::UsageTokens {
            input_tokens: 1_000,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
        },
        usage_status: "complete".to_string(),
    };

    assert!(!route_record_matches_fact(&record, &fact));
}

#[test]
fn resolve_stats_time_bounds_accepts_full_year_range() {
    let start_at = DAY_MS;
    let full_year_end_at = start_at + 366 * DAY_MS - 1;
    let too_large_end_at = start_at + 367 * DAY_MS - 1;

    let bounds = resolve_stats_time_bounds(None, Some(start_at), Some(full_year_end_at)).unwrap();
    let err = expect_string_err(resolve_stats_time_bounds(
        None,
        Some(start_at),
        Some(too_large_end_at),
    ));

    assert_eq!(bounds.range_days, 366);
    assert_eq!(err, "date_range_too_large");
}

#[test]
fn hour_of_day_for_stats_uses_explicit_range_anchor() {
    let local_day_start_at_utc_plus_8 = 16 * HOUR_MS;
    let local_10_am = local_day_start_at_utc_plus_8 + 10 * HOUR_MS;
    let bounds = StatsTimeBounds {
        start_at: local_day_start_at_utc_plus_8,
        end_at: local_day_start_at_utc_plus_8 + DAY_MS - 1,
        start_day: local_day_start_at_utc_plus_8,
        range_days: 1,
        explicit: true,
    };

    assert_eq!(hour_of_day_utc(local_10_am), 2);
    assert_eq!(hour_of_day_for_stats(local_10_am, bounds), 10);
}

#[test]
fn history_stats_project_paths_are_normalized_for_stable_cache_keys() {
    let paths = normalize_history_stats_project_paths(
        None,
        Some(vec![
            "/repo/worktree/".to_string(),
            "/repo/main".to_string(),
            "/repo/main/".to_string(),
        ]),
    );
    let reordered = normalize_history_stats_project_paths(
        Some("/repo/main".to_string()),
        Some(vec!["/repo/worktree".to_string()]),
    );

    assert_eq!(
        paths,
        vec!["/repo/main".to_string(), "/repo/worktree".to_string()]
    );
    assert_eq!(paths, reordered);
    assert_eq!(
        history_stats_project_paths_cache_key(&paths),
        history_stats_project_paths_cache_key(&reordered)
    );
}

#[test]
fn history_stats_aggregation_cache_key_tracks_opencode_generation() {
    let roots = history_roots(None, None, None);
    let bounds = StatsTimeBounds {
        start_at: DAY_MS,
        end_at: 2 * DAY_MS - 1,
        start_day: DAY_MS,
        range_days: 1,
        explicit: true,
    };
    let first = make_history_stats_aggregation_cache_key(
        &roots,
        None,
        None,
        &[],
        None,
        bounds,
        7,
        Some("db=1|wal=2"),
        11,
    );
    let second = make_history_stats_aggregation_cache_key(
        &roots,
        None,
        None,
        &[],
        None,
        bounds,
        7,
        Some("db=1|wal=3"),
        11,
    );

    assert_ne!(first, second);
    assert!(first.contains("opencode_gen=db=1|wal=2"));
}

#[test]
fn history_stats_buckets_usage_by_event_timestamp() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    let line_a = r#"{"type":"assistant","timestamp":"1970-01-02T01:00:00Z","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":10}}}"#;
    let line_b = r#"{"type":"assistant","timestamp":"1970-01-03T02:00:00Z","requestId":"req_2","message":{"id":"msg_2","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"world"}],"usage":{"input_tokens":200,"output_tokens":20}}}"#;
    write_text(&file, &format!("{line_a}\n{line_b}\n"));

    let computed = scan_session_computation(&file, DAY_MS, 4 * DAY_MS);
    let entry = HistoryIndexEntry {
        file_ref: SessionFileRef {
            source: "claude".to_string(),
            project_key: "project-a".to_string(),
            path: file.clone(),
        },
        fingerprint: SessionFileFingerprint {
            created_at: DAY_MS,
            updated_at: 4 * DAY_MS,
            size: 1,
        },
        computed,
    };
    let bounds = StatsTimeBounds {
        start_at: DAY_MS,
        end_at: 3 * DAY_MS - 1,
        start_day: DAY_MS,
        range_days: 2,
        explicit: true,
    };

    let daily_index = build_history_stats_daily_index(vec![entry], None, None, &[], bounds);
    let response = build_history_stats_response(&daily_index.days, bounds);

    assert_eq!(response.total_sessions, 1);
    assert_eq!(response.total_messages, 2);
    assert_eq!(response.total_input_tokens, 300);
    assert_eq!(response.total_output_tokens, 30);
    assert_eq!(response.daily_series.len(), 2);
    assert_eq!(response.daily_series[0].input_tokens, 100);
    assert_eq!(response.daily_series[1].input_tokens, 200);
    assert_eq!(response.project_ranking[0].sessions, 1);
    assert_eq!(response.source_distribution[0].sessions, 1);
    assert_eq!(response.model_distribution[0].sessions, 1);
}

#[test]
fn history_stats_multi_path_filter_counts_overlapping_session_once() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("nested-worktree-session.jsonl");
    let line = r#"{"type":"assistant","cwd":"/repo/main/worktrees/task","timestamp":"1970-01-02T01:00:00Z","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":10}}}"#;
    write_text(&file, &format!("{line}\n"));

    let computed = scan_session_computation(&file, DAY_MS, 2 * DAY_MS);
    let entry = HistoryIndexEntry {
        file_ref: SessionFileRef {
            source: "claude".to_string(),
            project_key: "nested-worktree".to_string(),
            path: file,
        },
        fingerprint: SessionFileFingerprint {
            created_at: DAY_MS,
            updated_at: 2 * DAY_MS,
            size: 1,
        },
        computed,
    };
    let bounds = StatsTimeBounds {
        start_at: DAY_MS,
        end_at: 2 * DAY_MS - 1,
        start_day: DAY_MS,
        range_days: 1,
        explicit: true,
    };
    let project_paths = normalize_history_stats_project_paths(
        Some("/repo/main".to_string()),
        Some(vec!["/repo/main/worktrees/task".to_string()]),
    );

    let daily_index =
        build_history_stats_daily_index(vec![entry], None, None, &project_paths, bounds);
    let response = build_history_stats_response(&daily_index.days, bounds);

    assert_eq!(response.total_sessions, 1);
    assert_eq!(response.total_messages, 1);
    assert_eq!(response.total_input_tokens, 100);
    assert_eq!(response.total_output_tokens, 10);
}

#[test]
fn history_stats_model_distribution_preserves_codex_reasoning_effort() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}"#,
            "\n",
            r#"{"type":"event_msg","timestamp":"1970-01-02T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":100,"output_tokens":100,"total_tokens":1100}}}}"#,
            "\n",
        ),
    );
    let computed = scan_session_computation(&file, DAY_MS, 2 * DAY_MS);
    let entry = HistoryIndexEntry {
        file_ref: SessionFileRef {
            source: "codex".to_string(),
            project_key: "project-a".to_string(),
            path: file,
        },
        fingerprint: SessionFileFingerprint {
            created_at: DAY_MS,
            updated_at: 2 * DAY_MS,
            size: 1,
        },
        computed,
    };
    let bounds = StatsTimeBounds {
        start_at: DAY_MS,
        end_at: 2 * DAY_MS - 1,
        start_day: DAY_MS,
        range_days: 1,
        explicit: true,
    };

    let daily_index = build_history_stats_daily_index(vec![entry], None, None, &[], bounds);
    let response = build_history_stats_response(&daily_index.days, bounds);

    assert_eq!(response.model_distribution.len(), 1);
    assert_eq!(response.model_distribution[0].model, "gpt-5.4(high)");
}

#[test]
fn history_stats_reprices_cached_usage_events_with_current_model_prices() {
    crate::commands::model_pricing::model_prices_set_cache(vec![
        crate::commands::model_pricing::ModelPriceEntry {
            model: "priced-model".to_string(),
            input_per_1m: 2.5,
            output_per_1m: 15.0,
            cache_read_per_1m: 0.25,
            cache_creation_per_1m: 0.0,
            source: "manual".to_string(),
            source_model_id: Some("priced-model".to_string()),
            raw_json: None,
            updated_at_ms: 1,
            synced_at_ms: None,
        },
    ])
    .unwrap();

    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    write_text(&file, "{}");

    let usage = UsageStatsScan {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_tokens: 10_000_000,
        cache_creation_tokens: 0,
        total_cost_usd: 1.23,
        unpriced_tokens: 11_100_000,
    };
    let entry = HistoryIndexEntry {
        file_ref: SessionFileRef {
            source: "codex".to_string(),
            project_key: "CLI-Manager".to_string(),
            path: file,
        },
        fingerprint: SessionFileFingerprint {
            created_at: DAY_MS,
            updated_at: DAY_MS,
            size: 2,
        },
        computed: CachedSessionComputation {
            created_at: DAY_MS,
            updated_at: DAY_MS,
            session_id: "session-1".to_string(),
            parent_session_id: None,
            title: "priced session".to_string(),
            message_count: 1,
            branch: None,
            stats: SessionStatsScan {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_creation_tokens: usage.cache_creation_tokens,
                total_cost_usd: usage.total_cost_usd,
                unpriced_tokens: usage.unpriced_tokens,
                dominant_model: Some("priced-model".to_string()),
                current_model: Some("priced-model".to_string()),
                model_usage: HashMap::new(),
                context_window: None,
                last_context_tokens: None,
                reasoning_effort: None,
                token_trend: vec![usage_trend_point(
                    UsageTokenScan {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        cache_read_tokens: usage.cache_read_tokens,
                        cache_creation_tokens: usage.cache_creation_tokens,
                        explicit_cost_usd: None,
                    },
                    Some("priced-model".to_string()),
                )],
                usage_events: vec![SessionUsageEventScan {
                    event_key: "test:event".to_string(),
                    event_index: 0,
                    timestamp_ms: Some(DAY_MS),
                    model: Some("priced-model".to_string()),
                    usage,
                }],
                tool_call_count: 0,
                mcp_calls: HashMap::new(),
                skill_calls: HashMap::new(),
                builtin_calls: HashMap::new(),
            },
        },
    };
    let bounds = StatsTimeBounds {
        start_at: DAY_MS,
        end_at: 2 * DAY_MS - 1,
        start_day: DAY_MS,
        range_days: 1,
        explicit: true,
    };

    let daily_index = build_history_stats_daily_index(vec![entry], None, None, &[], bounds);
    let response = build_history_stats_response(&daily_index.days, bounds);

    assert_eq!(response.total_input_tokens, 1_000_000);
    assert_eq!(response.total_output_tokens, 100_000);
    assert_eq!(response.total_cache_read_tokens, 10_000_000);
    assert!((response.total_cost_usd - 6.5).abs() < 1e-9);
    assert_eq!(response.total_unpriced_tokens, 0);
    assert!((response.daily_series[0].total_cost_usd - 6.5).abs() < 1e-9);
    assert_eq!(response.model_distribution[0].unpriced_tokens, 0);
}

#[test]
fn scan_session_combined_dedups_streamed_usage_lines() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    let line_a = r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}"#;
    let line_b = r#"{"type":"assistant","requestId":"req_2","message":{"id":"msg_2","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"world"}],"usage":{"input_tokens":200,"output_tokens":80,"cache_read_input_tokens":20,"cache_creation_input_tokens":0}}}"#;
    // line_a 重复两次，模拟 Claude Code 同一条消息的多个流式行
    write_text(&file, &format!("{line_a}\n{line_a}\n{line_b}\n"));

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.input_tokens, 300);
    assert_eq!(stats.output_tokens, 130);
    assert_eq!(stats.cache_read_tokens, 30);
    assert_eq!(stats.cache_creation_tokens, 5);
    assert_eq!(stats.unpriced_tokens, 465);
    assert_eq!(stats.dominant_model.as_deref(), Some("claude-sonnet-4-5"));
    assert_eq!(stats.token_trend.len(), 2);
    assert_eq!(stats.token_trend[0].total_tokens, 165);
    assert_eq!(stats.token_trend[1].total_tokens, 300);
}

#[test]
fn scan_session_combined_diffs_codex_cumulative_token_count() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"turn_context","payload":{"model":"gpt-5.4"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100}}}}"#,
            "\n",
            // 重复累计事件：差分为 0，不应重复计数
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100}}}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":1600,"output_tokens":300,"total_tokens":3300}}}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    // input 不含缓存命中：(1000-400) + (2000-1200) = 1400
    assert_eq!(stats.input_tokens, 1400);
    assert_eq!(stats.cache_read_tokens, 1600);
    assert_eq!(stats.output_tokens, 300);
    // token_count 事件不带 model，应回退归因到 turn_context 的模型；未加载模型价格缓存时只记未定价。
    assert_eq!(stats.unpriced_tokens, 3300);
    assert!(stats.model_usage.contains_key("gpt-5.4"));
    assert_eq!(stats.total_cost_usd, 0.0);
    assert_eq!(stats.token_trend.len(), 2);
    assert_eq!(stats.token_trend[0].input_tokens, 600);
    assert_eq!(stats.token_trend[0].cache_read_tokens, 400);
    assert_eq!(stats.token_trend[0].output_tokens, 100);
    assert_eq!(stats.token_trend[0].total_tokens, 1100);
    assert_eq!(stats.token_trend[1].input_tokens, 800);
    assert_eq!(stats.token_trend[1].cache_read_tokens, 1200);
    assert_eq!(stats.token_trend[1].output_tokens, 200);
    assert_eq!(stats.token_trend[1].total_tokens, 2200);
}

#[test]
fn history_stats_buckets_codex_usage_by_event_day() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"event_msg","timestamp":"1970-01-02T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"total_tokens":110}}}}"#,
            "\n",
            r#"{"type":"event_msg","timestamp":"1970-01-03T15:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":0,"output_tokens":30,"total_tokens":330}}}}"#,
            "\n",
        ),
    );
    let computed = scan_session_computation(&file, DAY_MS, 3 * DAY_MS);
    let entry = HistoryIndexEntry {
        file_ref: SessionFileRef {
            source: "codex".to_string(),
            project_key: "project-a".to_string(),
            path: file,
        },
        fingerprint: SessionFileFingerprint {
            created_at: DAY_MS,
            updated_at: 3 * DAY_MS,
            size: 1,
        },
        computed,
    };
    let bounds = StatsTimeBounds {
        start_at: DAY_MS,
        end_at: 3 * DAY_MS - 1,
        start_day: DAY_MS,
        range_days: 2,
        explicit: true,
    };

    let daily_index = build_history_stats_daily_index(vec![entry], None, None, &[], bounds);
    let response = build_history_stats_response(&daily_index.days, bounds);

    assert_eq!(response.daily_series[0].input_tokens, 100);
    assert_eq!(response.daily_series[0].output_tokens, 10);
    assert_eq!(response.daily_series[1].input_tokens, 200);
    assert_eq!(response.daily_series[1].output_tokens, 20);
    assert_eq!(response.hourly_activity[1].input_tokens, 100);
    assert_eq!(response.hourly_activity[15].input_tokens, 200);
}

#[test]
fn scan_session_combined_ignores_codex_cumulative_stale_snapshots() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":3000,"output_tokens":500,"total_tokens":5500},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":100,"total_tokens":1100}}}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5100,"cached_input_tokens":3100,"output_tokens":400,"total_tokens":5500},"last_token_usage":{"input_tokens":100,"cached_input_tokens":100,"output_tokens":0,"total_tokens":100}}}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":4000,"cached_input_tokens":2000,"output_tokens":400,"total_tokens":4400},"last_token_usage":{"input_tokens":2000,"cached_input_tokens":1200,"output_tokens":200,"total_tokens":2200}}}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":7000,"cached_input_tokens":4200,"output_tokens":700,"total_tokens":7700},"last_token_usage":{"input_tokens":3000,"cached_input_tokens":1800,"output_tokens":300,"total_tokens":3300}}}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.input_tokens, 2_800);
    assert_eq!(stats.cache_read_tokens, 4_200);
    assert_eq!(stats.output_tokens, 700);
}

#[test]
fn scan_session_combined_extracts_codex_context_window() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100},"model_context_window":272000}}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":1600,"output_tokens":300,"total_tokens":3300},"last_token_usage":{"input_tokens":2000,"cached_input_tokens":1200,"output_tokens":200,"total_tokens":2200},"model_context_window":272000}}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.context_window, Some(272000));
    // 取最后一次 last_token_usage 的 total_tokens
    assert_eq!(stats.last_context_tokens, Some(2200));
}

#[test]
fn scan_session_combined_extracts_claude_explicit_context_window() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("claude-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"cache_read_input_tokens":90000,"cache_creation_input_tokens":5000,"output_tokens":200,"context_window":200000}}}"#,
            "\n",
            r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","model":"claude-sonnet-4-5","usage":{"input_tokens":20,"cache_read_input_tokens":95000,"cache_creation_input_tokens":1000,"output_tokens":300,"max_context_tokens":1000000}}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.context_window, Some(1_000_000));
    assert_eq!(stats.last_context_tokens, Some(96_020));
}

#[test]
fn scan_session_combined_tracks_current_model_separately_from_dominant_model() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("claude-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-old","usage":{"input_tokens":10,"output_tokens":20}}}"#,
            "\n",
            r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","model":"claude-old","usage":{"input_tokens":11,"output_tokens":21}}}"#,
            "\n",
            r#"{"type":"assistant","requestId":"r3","message":{"id":"m3","model":"claude-new","usage":{"input_tokens":12,"output_tokens":22,"context_window":300000}}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.dominant_model.as_deref(), Some("claude-old"));
    assert_eq!(stats.current_model.as_deref(), Some("claude-new"));
    assert_eq!(stats.context_window, Some(300_000));
    assert_eq!(stats.last_context_tokens, Some(12));
    assert_eq!(stats.token_trend.len(), 3);
    assert_eq!(stats.token_trend[0].model.as_deref(), Some("claude-old"));
    assert_eq!(stats.token_trend[1].model.as_deref(), Some("claude-old"));
    assert_eq!(stats.token_trend[2].model.as_deref(), Some("claude-new"));
}

#[test]
fn scan_session_combined_extracts_codex_reasoning_effort() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"medium"}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.reasoning_effort.as_deref(), Some("high"));
}

#[test]
fn scan_session_combined_qualifies_codex_model_with_reasoning_effort() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("rollout-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}"#,
            "\n",
            r#"{"type":"event_msg","timestamp":"2026-07-06T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":100,"output_tokens":100,"total_tokens":1100}}}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6","effort":"xhigh"}}"#,
            "\n",
            r#"{"type":"event_msg","timestamp":"2026-07-06T01:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":500,"output_tokens":400,"total_tokens":3400}}}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{"model":"gpt-5.3-codex-spark","effort":"high"}}"#,
            "\n",
            r#"{"type":"event_msg","timestamp":"2026-07-06T01:02:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3600,"cached_input_tokens":600,"output_tokens":500,"total_tokens":4100}}}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.current_model.as_deref(), Some("gpt-5.3-codex-spark"));
    assert_eq!(stats.token_trend.len(), 3);
    assert_eq!(stats.token_trend[0].model.as_deref(), Some("gpt-5.4(high)"));
    assert_eq!(
        stats.token_trend[1].model.as_deref(),
        Some("gpt-5.6(xhigh)")
    );
    assert_eq!(
        stats.token_trend[2].model.as_deref(),
        Some("gpt-5.3-codex-spark")
    );
    assert!(stats.model_usage.contains_key("gpt-5.4(high)"));
    assert!(stats.model_usage.contains_key("gpt-5.6(xhigh)"));
    assert!(stats.model_usage.contains_key("gpt-5.3-codex-spark"));
    assert!(!stats.model_usage.contains_key("gpt-5.3-codex-spark(high)"));
}

#[test]
fn qualify_model_normalizes_embedded_reasoning_effort_suffix() {
    assert_eq!(
        qualify_model_with_reasoning_effort("gpt-5.6-xhigh".to_string(), None),
        "gpt-5.6(xhigh)"
    );
    assert_eq!(
        qualify_model_with_reasoning_effort("gpt-5.4(high)".to_string(), Some("medium")),
        "gpt-5.4(high)"
    );
    assert_eq!(
        qualify_model_with_reasoning_effort("gpt-5.6".to_string(), Some("High")),
        "gpt-5.6(high)"
    );
    assert_eq!(
        qualify_model_with_reasoning_effort("gpt-5.3-codex-spark".to_string(), Some("high")),
        "gpt-5.3-codex-spark"
    );
    assert_eq!(
        qualify_model_with_reasoning_effort("gpt-5.3-codex-spark(high)".to_string(), None),
        "gpt-5.3-codex-spark"
    );
    assert_eq!(
        qualify_model_with_reasoning_effort("gpt-5.3-codex-spark-high".to_string(), None),
        "gpt-5.3-codex-spark"
    );
}

#[test]
fn scan_session_combined_tracks_claude_last_context_tokens() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("claude-session.jsonl");
    write_text(
        &file,
        concat!(
            r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"cache_read_input_tokens":90000,"cache_creation_input_tokens":5000,"output_tokens":200}}}"#,
            "\n",
            r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","model":"claude-sonnet-4-5","usage":{"input_tokens":20,"cache_read_input_tokens":95000,"cache_creation_input_tokens":1000,"output_tokens":300}}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    // 最近一条请求的上下文占用 = input + 缓存读 + 缓存写
    assert_eq!(stats.last_context_tokens, Some(96020));
    // Claude 行不带 model_context_window
    assert_eq!(stats.context_window, None);
}

#[test]
fn scan_session_combined_counts_tool_mcp_and_skill_calls() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("claude-session.jsonl");
    write_text(
        &file,
        concat!(
            // 普通工具 + MCP 工具
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}},{"type":"tool_use","id":"t2","name":"mcp__exa__web_search_exa","input":{}}]}}"#,
            "\n",
            // 流式重复行：相同块 id，不应重复计数
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t2","name":"mcp__exa__web_search_exa","input":{}}]}}"#,
            "\n",
            // Skill 工具调用
            r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t3","name":"Skill","input":{"skill":"goal"}}]}}"#,
            "\n",
            // 斜杠命令标记
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/compact</command-name>"}}"#,
            "\n",
            // Codex function_call
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1"}}"#,
            "\n",
            // Codex MCP function_call：MCP server 在 namespace，不在 name
            r#"{"type":"response_item","payload":{"type":"function_call","name":"impact","namespace":"mcp__gitnexus","call_id":"c2"}}"#,
            "\n",
            // Codex MCP 结束事件：同 call_id 已在开始事件计数，不应重复
            r#"{"type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"c2","invocation":{"server":"gitnexus","tool":"impact","arguments":{}}}}"#,
            "\n",
            // Codex MCP 结束事件也可能单独出现，应能按 invocation.server 计数
            r#"{"type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"c3","invocation":{"server":"context7","tool":"query_docs","arguments":{}}}}"#,
            "\n",
        ),
    );

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.tool_call_count, 6);
    assert_eq!(stats.mcp_calls.get("exa"), Some(&1));
    assert_eq!(stats.mcp_calls.get("gitnexus"), Some(&1));
    assert_eq!(stats.mcp_calls.get("context7"), Some(&1));
    assert_eq!(stats.skill_calls.get("goal"), Some(&1));
    assert_eq!(stats.skill_calls.get("compact"), Some(&1));
    // 内置工具：Read (t1) + shell (c1)；Skill 工具本身不计入 builtin
    assert_eq!(stats.builtin_calls.get("Read"), Some(&1));
    assert_eq!(stats.builtin_calls.get("shell"), Some(&1));
    assert_eq!(stats.builtin_calls.len(), 2);
}

#[test]
fn codex_usage_delta_ignores_cumulative_shrinks() {
    let previous = CodexCumulativeUsage {
        input_tokens: 5000,
        cached_input_tokens: 2000,
        output_tokens: 500,
        total_tokens: 5500,
    };
    let current = CodexCumulativeUsage {
        input_tokens: 300,
        cached_input_tokens: 100,
        output_tokens: 30,
        total_tokens: 330,
    };

    let usage = codex_usage_delta(Some(previous), current);

    assert_eq!(usage.input_tokens, 0);
    assert_eq!(usage.cache_read_tokens, 0);
    assert_eq!(usage.output_tokens, 0);
}

#[test]
fn scan_session_combined_ignores_synthetic_model() {
    let temp_dir = TempDir::new().unwrap();
    let file = temp_dir.path().join("session.jsonl");
    write_text(
        &file,
        r#"{"type":"assistant","message":{"id":"e1","role":"assistant","model":"<synthetic>","content":"Prompt is too long","usage":{"input_tokens":1,"output_tokens":0}}}"#,
    );

    let (_, stats) = scan_session_combined(&file);

    assert_eq!(stats.dominant_model, None);
    assert!(stats.model_usage.is_empty());
}

#[test]
fn extract_usage_tokens_merges_top_level_cost_with_nested_tokens() {
    let value: Value = serde_json::from_str(
        r#"{"costUSD":0.5,"message":{"usage":{"input_tokens":100,"output_tokens":50}}}"#,
    )
    .unwrap();

    let usage = extract_usage_tokens(&value);

    assert_eq!(usage.input_tokens, 100);
    assert_eq!(usage.output_tokens, 50);
    assert_eq!(usage.explicit_cost_usd, Some(0.5));
}
