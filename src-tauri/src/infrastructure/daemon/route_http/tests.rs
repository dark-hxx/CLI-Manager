use super::*;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;

#[test]
fn route_matrix_is_fixed_and_rejects_connect() {
    assert_eq!(
        classify_route(&Method::POST, "/v1/messages"),
        Ok(RouteKind::ClaudeMessages)
    );
    assert_eq!(
        classify_route(&Method::POST, "/v1/responses"),
        Ok(RouteKind::CodexResponses)
    );
    assert_eq!(
        classify_route(&Method::POST, "/v1/chat/completions"),
        Ok(RouteKind::CodexChatCompletions)
    );
    assert_eq!(
        classify_route(&Method::POST, "/grokbuild/v1/chat/completions"),
        Ok(RouteKind::Grok)
    );
    assert_eq!(
        classify_route(&Method::CONNECT, "/v1/messages"),
        Err((StatusCode::METHOD_NOT_ALLOWED, "routing_method_not_allowed"))
    );
    assert_eq!(
        classify_route(&Method::POST, "/v1/anything"),
        Err((StatusCode::NOT_FOUND, "routing_path_not_found"))
    );
}

#[test]
fn failover_protocol_matrix_covers_all_supported_apps() {
    let cases = [
        (RouteKind::ClaudeMessages, "/v1/messages", "claude"),
        (RouteKind::CodexResponses, "/v1/responses", "codex"),
        (
            RouteKind::CodexChatCompletions,
            "/v1/chat/completions",
            "codex",
        ),
        (
            RouteKind::Grok,
            "/grokbuild/v1/chat/completions",
            "grokbuild",
        ),
    ];

    for (route, path, app_type) in cases {
        assert_eq!(classify_route(&Method::POST, path), Ok(route));
        assert_eq!(route_app_type(route), app_type);
        assert!(upstream_url("https://upstream.example/v1", route, path).is_ok());

        let kind = if route == RouteKind::CodexResponses {
            StreamCommitKind::ResponsesSse
        } else {
            StreamCommitKind::GenericSse
        };
        let mut tracker = StreamCommitTracker::new(kind);
        assert_eq!(
            tracker.observe(&Bytes::from_static(b": keepalive\n\n")),
            StreamCommitOutcome::None
        );
        let event = if kind == StreamCommitKind::ResponsesSse {
            b"data: {\"type\":\"response.completed\"}\n\n".as_slice()
        } else {
            b"data: {\"type\":\"message_start\"}\n\n".as_slice()
        };
        assert_eq!(
            tracker.observe(&Bytes::from_static(event)),
            StreamCommitOutcome::Success
        );
    }
}

#[test]
fn automatic_failover_hot_switch_uses_provider_identity_not_candidate_index() {
    let cases = [
        (
            "non-current first candidate",
            0usize,
            true,
            false,
            StatusCode::OK,
            true,
        ),
        (
            "current first candidate",
            0usize,
            true,
            true,
            StatusCode::OK,
            false,
        ),
        (
            "non-current later candidate",
            1usize,
            true,
            false,
            StatusCode::OK,
            true,
        ),
        (
            "automatic failover disabled",
            0usize,
            false,
            false,
            StatusCode::OK,
            false,
        ),
        (
            "non-current provider returned failure",
            0usize,
            true,
            false,
            StatusCode::BAD_GATEWAY,
            false,
        ),
    ];

    for (case, candidate_index, auto_failover_enabled, is_current, status, expected) in cases {
        assert_eq!(
            should_hot_switch_provider(auto_failover_enabled, is_current, status),
            expected,
            "{case} at candidate index {candidate_index}"
        );
    }
}

#[test]
fn upstream_error_classifier_separates_key_and_provider_failures() {
    assert_eq!(
        classify_upstream_status(StatusCode::UNAUTHORIZED),
        UpstreamErrorClass::Key
    );
    assert_eq!(
        classify_upstream_status(StatusCode::TOO_MANY_REQUESTS),
        UpstreamErrorClass::Key
    );
    assert_eq!(
        classify_upstream_status(StatusCode::BAD_GATEWAY),
        UpstreamErrorClass::Provider
    );
    assert_eq!(
        classify_upstream_status(StatusCode::UNPROCESSABLE_ENTITY),
        UpstreamErrorClass::Provider
    );
    assert_eq!(
        classify_upstream_status(StatusCode::BAD_REQUEST),
        UpstreamErrorClass::Provider
    );
    assert_eq!(
        classify_upstream_status(StatusCode::NOT_FOUND),
        UpstreamErrorClass::Provider
    );
    assert_eq!(
        classify_upstream_status(StatusCode::OK),
        UpstreamErrorClass::Success
    );
}

#[test]
fn provider_error_body_capture_uses_sanitized_error_details() {
    let capture = capture_upstream_error_body(
        br#"{"type":"error","error":{"message":"provider rejected token=private-token"},"request":"must not persist"}"#,
    );

    assert!(capture.failed);
    assert_eq!(
        capture.error_detail.as_deref(),
        Some("provider rejected token=<redacted>")
    );
}

#[test]
fn max_attempts_is_initial_attempt_plus_retry_budget() {
    assert_eq!(max_attempts(0), 1);
    assert_eq!(max_attempts(3), 4);
    assert_eq!(max_attempts(u32::MAX), u32::MAX);
}

#[test]
fn outbound_attempt_reservation_counts_each_send_and_stops_at_budget() {
    let mut actual_attempts = 0usize;

    assert_eq!(reserve_provider_attempt(&mut actual_attempts, 2), Some(0));
    assert_eq!(reserve_provider_attempt(&mut actual_attempts, 2), Some(1));
    assert_eq!(reserve_provider_attempt(&mut actual_attempts, 2), None);
    assert_eq!(actual_attempts, 2);
}

#[test]
fn stream_failure_policy_opens_after_one_failure() {
    let registry = CircuitRegistry::default();
    let policy = CircuitPolicy {
        failure_threshold: 8,
        success_threshold: 2,
        timeout: Duration::from_secs(60),
        error_rate_threshold: 0.5,
        min_requests: 4,
    };
    let permit = registry.acquire("codex", "provider-a", policy).unwrap();
    registry.record_failure(permit, stream_failure_policy(policy));
    assert!(registry.acquire("codex", "provider-a", policy).is_err());
}

#[test]
fn signature_classifier_requires_explicit_signature_error_language() {
    assert!(is_thinking_signature_error(
        br#"{"error":"invalid thinking signature"}"#
    ));
    assert!(is_thinking_signature_error(
        br#"{"error":"missing signature"}"#
    ));
    assert!(!is_thinking_signature_error(
        br#"{"error":"invalid JSON body"}"#
    ));
    assert!(!is_thinking_signature_error(
        br#"{"error":"signature is valid"}"#
    ));
}

#[test]
fn signature_rectifier_removes_only_thinking_blocks_and_preserves_request_data() {
    let mut request = serde_json::json!({
        "model": "fixture",
        "messages": [{
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "secret reasoning", "signature": "bad"},
                {"type": "text", "text": "keep this"},
                {"type": "redacted_thinking", "data": "opaque"}
            ]
        }]
    });
    remove_invalid_thinking_blocks(&mut request);
    assert_eq!(request["model"], "fixture");
    assert_eq!(
        request["messages"][0]["content"].as_array().unwrap().len(),
        1
    );
    assert_eq!(request["messages"][0]["content"][0]["text"], "keep this");
}

#[test]
fn upstream_url_does_not_duplicate_v1_and_rejects_non_http() {
    assert_eq!(
        upstream_url(
            "https://example.test/v1",
            RouteKind::CodexResponses,
            "/v1/responses",
        )
        .unwrap(),
        "https://example.test/v1/responses"
    );
    assert_eq!(
        upstream_url(
            "https://example.test",
            RouteKind::ClaudeMessages,
            "/v1/messages",
        )
        .unwrap(),
        "https://example.test/v1/messages"
    );
    assert!(upstream_url("file:///secret", RouteKind::ClaudeMessages, "/v1/messages").is_err());
    assert_eq!(
        upstream_url(
            "https://example.test",
            RouteKind::Grok,
            "/grokbuild/v1/chat/completions",
        )
        .unwrap(),
        "https://example.test/grokbuild/v1/chat/completions"
    );
}

#[test]
fn budget_classifier_requires_explicit_budget_or_thinking_constraint() {
    assert!(is_thinking_budget_error(
        br#"{"error":"budget_tokens must be less than max_tokens"}"#
    ));
    assert!(is_thinking_budget_error(
        br#"{"error":"thinking budget constraint"}"#
    ));
    assert!(!is_thinking_budget_error(
        br#"{"error":"invalid JSON body"}"#
    ));
    assert!(!is_thinking_budget_error(
        br#"{"error":"model is unavailable"}"#
    ));
}

#[test]
fn budget_rectifier_sets_safe_values_and_keeps_adaptive_thinking() {
    let mut request = serde_json::json!({
        "thinking": {"type": "enabled", "budget_tokens": 65536, "effort": "max"},
        "max_tokens": 1024
    });
    assert!(rectify_thinking_budget(&mut request));
    assert_eq!(request["thinking"]["type"], "enabled");
    assert_eq!(request["thinking"]["budget_tokens"], 32000);
    assert_eq!(request["thinking"]["effort"], "max");
    assert_eq!(request["max_tokens"], 64000);

    let mut adaptive = serde_json::json!({
        "thinking": {"type": "adaptive"},
        "max_tokens": 4096
    });
    assert!(!rectify_thinking_budget(&mut adaptive));
    assert_eq!(adaptive["thinking"]["type"], "adaptive");
    assert_eq!(adaptive["max_tokens"], 4096);
}

#[test]
fn media_classifier_requires_explicit_unsupported_media_language() {
    assert!(is_media_capability_error(
        br#"{"error":"image input is not supported"}"#
    ));
    assert!(is_media_capability_error(
        br#"{"error":"nested image content unsupported"}"#
    ));
    assert!(!is_media_capability_error(
        br#"{"error":"invalid JSON body"}"#
    ));
    assert!(!is_media_capability_error(
        br#"{"error":"image generated successfully"}"#
    ));
}

#[test]
fn media_fallback_replaces_claude_codex_tool_and_mcp_blocks_without_media_leakage() {
    let mut request = serde_json::json!({
        "model": "fixture",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "url", "url": "secret-image-url"}},
                {"type": "text", "text": "keep this"},
                {"type": "tool_result", "content": [
                    {"type": "mcp_image", "data": "secret-image-bytes"},
                    {"type": "input_file", "file_id": "secret-file-id"},
                    {"type": "file_search_call", "id": "keep-tool-call"}
                ]}
            ]
        }],
        "input": [{"type": "input_image", "image_url": "secret-input-url"}],
        "nested": {"content": {"type": "image", "source": {"data": "secret-nested-image"}}}
    });
    assert!(replace_unsupported_media(&mut request));
    let serialized = serde_json::to_string(&request).unwrap();
    assert!(!serialized.contains("secret-image-url"));
    assert!(!serialized.contains("secret-image-bytes"));
    assert!(!serialized.contains("secret-file-id"));
    assert!(!serialized.contains("secret-input-url"));
    assert!(!serialized.contains("secret-nested-image"));
    assert_eq!(request["messages"][0]["content"][1]["text"], "keep this");
    assert_eq!(
        request["messages"][0]["content"][0]["text"],
        UNSUPPORTED_MEDIA_PLACEHOLDER
    );
    assert_eq!(
        request["messages"][0]["content"][2]["content"][0]["text"],
        UNSUPPORTED_MEDIA_PLACEHOLDER
    );
    assert_eq!(
        request["messages"][0]["content"][2]["content"][2]["id"],
        "keep-tool-call"
    );
    assert_eq!(request["input"][0]["text"], UNSUPPORTED_MEDIA_PLACEHOLDER);
    assert_eq!(
        request["nested"]["content"]["text"],
        UNSUPPORTED_MEDIA_PLACEHOLDER
    );
}

#[test]
fn media_preflight_keeps_explicit_capability_when_heuristic_is_disabled() {
    let mut config = crate::provider::routing::RoutingRectifierConfig {
        schema_version: 1,
        enabled: true,
        request_thinking_signature: true,
        request_thinking_budget: true,
        request_media_fallback: true,
        request_media_heuristic: false,
    };
    assert!(should_preflight_media_fallback(
        &config,
        MediaCapability::TextOnly,
        Some("provider-custom-model")
    ));
    assert!(!should_preflight_media_fallback(
        &config,
        MediaCapability::Unknown,
        Some("provider-custom-model")
    ));
    config.request_media_heuristic = true;
    assert!(should_preflight_media_fallback(
        &config,
        MediaCapability::Unknown,
        Some("text-only-fixture")
    ));
}

#[test]
fn declared_text_only_capability_is_explicit_and_model_heuristic_is_bounded() {
    assert_eq!(
        declared_media_capability(r#"{"advanced":{"supportsImages":false}}"#),
        MediaCapability::TextOnly
    );
    assert_eq!(
        declared_media_capability(r#"{"capabilities":{"inputModalities":["text"]}}"#),
        MediaCapability::TextOnly
    );
    assert_eq!(
        declared_media_capability(r#"{"advanced":{"supportsImages":true}}"#),
        MediaCapability::Unknown
    );
    assert!(is_text_only_model("text-davinci-003"));
    assert!(is_text_only_model("vendor/text-only-fixture"));
    assert!(!is_text_only_model("claude-3-5-sonnet"));
}

fn optimizer_config() -> crate::provider::routing::RoutingOptimizerConfig {
    crate::provider::routing::RoutingOptimizerConfig {
        schema_version: 1,
        enabled: true,
        thinking_optimizer: true,
        cache_injection: true,
    }
}

#[test]
fn bedrock_detection_uses_effective_env_only() {
    assert!(effective_bedrock_enabled(
        r#"{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}"#
    ));
    assert!(!effective_bedrock_enabled(
        r#"{"env":{"CLAUDE_CODE_USE_BEDROCK":"0"}}"#
    ));
    assert!(!effective_bedrock_enabled(
        r#"{"name":"bedrock","baseUrl":"https://bedrock.example","env":{}}"#
    ));
}

#[test]
fn bedrock_thinking_optimizer_applies_generation_rules_without_cross_provider_fields() {
    let config = optimizer_config();
    assert_eq!(
        bedrock_model_generation(Some("us.anthropic.claude-3-5-sonnet")),
        BedrockModelGeneration::Legacy
    );
    assert_eq!(
        bedrock_model_generation(Some("us.anthropic.claude-3-7-sonnet")),
        BedrockModelGeneration::Adaptive
    );
    assert_eq!(
        bedrock_model_generation(Some("us.anthropic.claude-3-haiku")),
        BedrockModelGeneration::Haiku
    );

    let mut legacy = serde_json::json!({
        "model": "us.anthropic.claude-3-5-sonnet",
        "max_tokens": 4096,
        "thinking": {"type": "adaptive", "effort": "max", "fixture": true}
    });
    assert!(apply_bedrock_optimizations(
        &mut legacy,
        &config,
        true,
        Some("us.anthropic.claude-3-5-sonnet")
    ));
    assert_eq!(legacy["thinking"]["type"], "enabled");
    assert_eq!(legacy["thinking"]["budget_tokens"], 4095);
    assert_eq!(legacy["thinking"]["fixture"], true);
    assert!(legacy["thinking"]["effort"].is_null());

    let mut missing_max_tokens = serde_json::json!({
        "model": "us.anthropic.claude-3-5-sonnet",
        "thinking": {"type": "adaptive"}
    });
    assert!(!apply_bedrock_optimizations(
        &mut missing_max_tokens,
        &config,
        true,
        Some("us.anthropic.claude-3-5-sonnet")
    ));
    assert_eq!(missing_max_tokens["thinking"]["type"], "adaptive");

    let mut adaptive = serde_json::json!({
        "model": "us.anthropic.claude-3-7-sonnet",
        "thinking": {"type": "enabled", "budget_tokens": 1024}
    });
    assert!(!apply_bedrock_optimizations(
        &mut adaptive,
        &config,
        true,
        Some("us.anthropic.claude-3-7-sonnet")
    ));
    assert_eq!(adaptive["thinking"]["type"], "adaptive");
    assert_eq!(adaptive["thinking"]["effort"], "max");
    assert!(adaptive["thinking"]["budget_tokens"].is_null());

    let mut haiku = serde_json::json!({
        "model": "us.anthropic.claude-3-haiku",
        "thinking": {"type": "enabled", "budget_tokens": 1024}
    });
    let before = haiku.clone();
    apply_bedrock_optimizations(
        &mut haiku,
        &config,
        true,
        Some("us.anthropic.claude-3-haiku"),
    );
    assert_eq!(haiku["thinking"], before["thinking"]);
}

#[test]
fn bedrock_cache_injection_preserves_existing_and_caps_at_four_breakpoints() {
    let config = optimizer_config();
    let mut request = serde_json::json!({
        "tools": [{"name": "lookup"}],
        "system": [{"type": "text", "text": "system", "cache_control": {"type": "ephemeral"}}],
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "old"}]},
            {"role": "user", "content": [{"type": "text", "text": "latest"}]}
        ]
    });
    assert!(!apply_bedrock_optimizations(
        &mut request,
        &config,
        true,
        Some("us.anthropic.claude-3-7-sonnet")
    ));
    assert_eq!(cache_breakpoint_count(&request), 4);
    assert_eq!(request["system"][0]["cache_control"]["type"], "ephemeral");
    assert_eq!(
        request["system"][0]["cache_control"]["ttl"],
        serde_json::Value::Null
    );

    let mut capped = request.clone();
    assert!(!inject_bedrock_cache_breakpoints(&mut capped));
    assert_eq!(cache_breakpoint_count(&capped), 4);
}

#[test]
fn bedrock_beta_header_is_added_once_and_optimizer_is_route_local() {
    let mut headers = Vec::new();
    add_bedrock_beta_header(&mut headers);
    add_bedrock_beta_header(&mut headers);
    assert_eq!(headers.len(), 1);
    assert_eq!(headers[0].1, HeaderValue::from_static(BEDROCK_BETA));

    let config = optimizer_config();
    let mut non_bedrock = serde_json::json!({"model":"claude-sonnet-4","max_tokens":4096});
    assert!(!apply_bedrock_optimizations(
        &mut non_bedrock,
        &config,
        false,
        Some("claude-sonnet-4")
    ));
    assert!(non_bedrock.get("thinking").is_none());
    assert!(non_bedrock.get("tools").is_none());
}

#[test]
fn hop_by_hop_headers_are_not_forwarded() {
    assert!(is_hop_by_hop("Connection"));
    assert!(is_hop_by_hop("Content-Length"));
    assert!(!is_hop_by_hop("anthropic-version"));
}

fn candidate(id: &str) -> KeyCandidate {
    KeyCandidate {
        id: id.to_string(),
        api_key: format!("secret-{id}"),
    }
}

#[test]
fn key_pool_is_active_first_then_round_robin_without_duplicate_attempts() {
    let state = RouteState::default();
    let candidates = vec![candidate("active"), candidate("second"), candidate("third")];
    assert_eq!(
        state.select_key("claude:provider", candidates).unwrap().id,
        "active"
    );
    let used = HashSet::from(["active".to_string()]);
    assert_eq!(
        state.next_key("claude:provider", &used).unwrap().id,
        "second"
    );
    let used = HashSet::from(["active".to_string(), "second".to_string()]);
    assert_eq!(
        state.next_key("claude:provider", &used).unwrap().id,
        "third"
    );
    let used = HashSet::from([
        "active".to_string(),
        "second".to_string(),
        "third".to_string(),
    ]);
    assert!(state.next_key("claude:provider", &used).is_none());
}

#[test]
fn key_pool_reload_resets_cursor_and_generation() {
    let state = RouteState::default();
    state
        .select_key(
            "codex:provider",
            vec![candidate("active"), candidate("second")],
        )
        .unwrap();
    assert_eq!(state.pools.lock().unwrap()["codex:provider"].generation, 1);
    assert_eq!(
        state
            .select_key(
                "codex:provider",
                vec![candidate("second"), candidate("active")]
            )
            .unwrap()
            .id,
        "second"
    );
    assert_eq!(state.pools.lock().unwrap()["codex:provider"].generation, 2);
}

#[test]
fn key_pool_cooldown_skips_key_and_bounds_retry_after() {
    let state = RouteState::default();
    state
        .select_key(
            "grokbuild:provider",
            vec![candidate("one"), candidate("two")],
        )
        .unwrap();
    let headers = reqwest::header::HeaderMap::new();
    state.mark_cooldown("grokbuild:provider", "one", 401, &headers);
    assert_eq!(
        state
            .next_key("grokbuild:provider", &HashSet::new())
            .unwrap()
            .id,
        "two"
    );
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("retry-after", HeaderValue::from_static("999"));
    assert_eq!(retry_cooldown(429, &headers), KEY_COOLDOWN_MAX);
}

#[test]
fn key_selection_distinguishes_cooldown_from_missing_keys() {
    let state = RouteState::default();
    let candidates = vec![candidate("one"), candidate("two")];
    state
        .select_key_status("codex:provider", candidates.clone())
        .unwrap();
    let headers = reqwest::header::HeaderMap::new();
    state.mark_cooldown("codex:provider", "one", 401, &headers);
    state.mark_cooldown("codex:provider", "two", 401, &headers);
    assert_eq!(
        state
            .select_key_status("codex:provider", candidates)
            .unwrap(),
        KeySelection::CoolingDown
    );
    assert_eq!(
        state.select_key_status("codex:empty", Vec::new()).unwrap(),
        KeySelection::Unavailable
    );
}

#[test]
fn key_cooldown_is_runtime_only_and_reload_rebuilds_the_pool() {
    let state = RouteState::default();
    let candidates = vec![candidate("one"), candidate("two")];
    state
        .select_key("claude:provider", candidates.clone())
        .unwrap();
    state.mark_cooldown(
        "claude:provider",
        "one",
        401,
        &reqwest::header::HeaderMap::new(),
    );
    assert_eq!(
        state
            .next_key("claude:provider", &HashSet::new())
            .unwrap()
            .id,
        "two"
    );

    let restarted = RouteState::default();
    assert_eq!(
        restarted
            .select_key("claude:provider", candidates)
            .unwrap()
            .id,
        "one"
    );
}

#[test]
fn model_mapping_is_trimmed_exact_and_finally_pinned() {
    let mappings = parse_model_mappings(
        "codex",
        r#"{"advanced":{"modelMappings":[{"source":" a ","target":" b "}]}}"#,
    )
    .unwrap();
    let body = apply_model_mapping(
        &serde_json::json!({"model":"a","messages":[],"override":{"model":"c"}}),
        &mappings,
    )
    .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["model"], "b");
    assert_eq!(body["override"]["model"], "c");
    let unchanged = apply_model_mapping(&serde_json::json!({"model":"A"}), &mappings).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&unchanged).unwrap()["model"],
        "A"
    );
}

#[test]
fn claude_model_mapping_accepts_custom_display_name() {
    let mut mappings = Vec::new();
    add_claude_model_mapping(&mut mappings, "fable", "gpt-5.6-sol", "claude-fable-5[1m]");
    for model in ["claude-fable-5[1m]", "claude-fable-5"] {
        let body = apply_model_mapping(&serde_json::json!({"model": model}), &mappings).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["model"],
            "gpt-5.6-sol"
        );
    }
}

#[test]
fn claude_model_mapping_handles_non_ascii_display_name_suffixes() {
    let mut mappings = Vec::new();
    add_claude_model_mapping(&mut mappings, "fable", "gpt-5.6-sol", "模型甲[1m]");
    for model in ["模型甲[1m]", "模型甲"] {
        let body = apply_model_mapping(&serde_json::json!({"model": model}), &mappings).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["model"],
            "gpt-5.6-sol"
        );
    }
}

#[test]
fn model_mapping_rejects_empty_and_duplicate_sources() {
    assert_eq!(
        parse_model_mappings(
            "grokbuild",
            r#"{"advanced":{"modelMappings":[{"source":" ","target":"b"}]}}"#,
        )
        .unwrap_err(),
        "provider_model_mapping_source_required"
    );
    assert_eq!(
        parse_model_mappings(
            "grokbuild",
            r#"{"advanced":{"modelMappings":[{"source":"a","target":"b"},{"source":"a","target":"c"}]}}"#,
        )
        .unwrap_err(),
        "provider_model_mapping_duplicate_source"
    );
}

#[test]
fn failover_mapping_restarts_from_original_source_for_each_provider() {
    let request = serde_json::json!({"model":"a","messages":[]});
    let first = parse_model_mappings(
        "codex",
        r#"{"advanced":{"modelMappings":[{"source":"a","target":"targetA"}]}}"#,
    )
    .unwrap();
    let fallback = parse_model_mappings(
        "codex",
        r#"{"advanced":{"modelMappings":[{"source":"a","target":"targetB"}]}}"#,
    )
    .unwrap();
    let first_body: serde_json::Value =
        serde_json::from_slice(&apply_model_mapping(&request, &first).unwrap()).unwrap();
    assert_eq!(first_body["model"], "targetA");
    let fallback_body: serde_json::Value =
        serde_json::from_slice(&apply_model_mapping(&request, &fallback).unwrap()).unwrap();
    assert_eq!(fallback_body["model"], "targetB");
}

#[test]
fn generic_sse_commits_on_first_parseable_event_and_ignores_keepalive() {
    let mut tracker = StreamCommitTracker::new(StreamCommitKind::GenericSse);
    assert_eq!(
        tracker.observe(&Bytes::from_static(b": ping\n\n")),
        StreamCommitOutcome::None
    );
    assert_eq!(
        tracker.observe(&Bytes::from_static(b"data: {")),
        StreamCommitOutcome::None
    );
    assert_eq!(
        tracker.observe(&Bytes::from_static(b"\"type\":\"message_start\"}\n\n")),
        StreamCommitOutcome::Success
    );
    assert_eq!(
        tracker.observe(&Bytes::from_static(b"data: {\"later\":true}\n\n")),
        StreamCommitOutcome::None
    );
}

#[test]
fn stream_commit_tracker_accepts_crlf_and_split_utf8() {
    let mut tracker = StreamCommitTracker::new(StreamCommitKind::GenericSse);
    let payload = "data: {\"label\":\"你\",\"type\":\"message_start\"}\r\n\r\n".as_bytes();
    let split = payload.iter().position(|byte| *byte >= 0x80).unwrap() + 1;

    assert_eq!(
        tracker.observe(&Bytes::copy_from_slice(&payload[..split])),
        StreamCommitOutcome::None
    );
    assert_eq!(
        tracker.observe(&Bytes::copy_from_slice(&payload[split..])),
        StreamCommitOutcome::Success
    );
}

#[test]
fn stream_commit_tracker_caps_undecided_input() {
    let mut tracker = StreamCommitTracker::new(StreamCommitKind::GenericSse);
    assert_eq!(
        tracker.observe(&Bytes::from(vec![
            b'x';
            MAX_ERROR_DIAGNOSTIC_BODY_BYTES * 2
        ])),
        StreamCommitOutcome::None
    );
    assert_eq!(tracker.buffer.len(), MAX_ERROR_DIAGNOSTIC_BODY_BYTES);
}

#[test]
fn responses_sse_waits_for_completed_event() {
    let mut tracker = StreamCommitTracker::new(StreamCommitKind::ResponsesSse);
    assert_eq!(
        tracker.observe(&Bytes::from_static(b": keepalive\n\n")),
        StreamCommitOutcome::None
    );
    assert_eq!(
        tracker.observe(&Bytes::from_static(
            b"data: {\"type\":\"response.created\"}\n\n"
        )),
        StreamCommitOutcome::None
    );
    assert_eq!(
        tracker.observe(&Bytes::from_static(
            b"data: {\"type\":\"response.output_text.delta\"}\n\n"
        )),
        StreamCommitOutcome::None
    );
    assert_eq!(
        tracker.observe(&Bytes::from_static(
            b"data: {\"type\":\"response.completed\"}\n\n"
        )),
        StreamCommitOutcome::Success
    );
}

#[test]
fn responses_sse_error_is_a_commit_boundary() {
    let mut tracker = StreamCommitTracker::new(StreamCommitKind::ResponsesSse);
    assert_eq!(
        tracker.observe(&Bytes::from_static(
            b"event: error\ndata: {\"message\":\"upstream failed\"}\n\n"
        )),
        StreamCommitOutcome::Failure
    );
}

#[test]
fn listener_serves_fixed_router_errors_without_provider_data() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = RouteHttpServer::start(&[listener]).unwrap();
    let mut stream = None;
    for _ in 0..20 {
        if let Ok(candidate) = TcpStream::connect(address) {
            stream = Some(candidate);
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let mut stream = stream.expect("route listener should accept connections");
    stream
        .write_all(b"GET /not-registered HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut buffer = [0_u8; 4096];
    let size = stream.read(&mut buffer).unwrap();
    let response = String::from_utf8_lossy(&buffer[..size]);
    assert!(response.starts_with("HTTP/1.1 404"));
    assert!(response.contains("routing_path_not_found"));
    drop(stream);
    drop(server);
}
