use std::collections::BTreeSet;

use serde_json::Value;

const PROTOCOL_MATRIX: &str = include_str!("fixtures/routing/protocol_matrix.json");
const STREAM_COMMIT: &str = include_str!("fixtures/routing/stream_commit.json");
const MODEL_MAPPING: &str = include_str!("fixtures/routing/model_mapping.json");
const RECTIFIER_ERRORS: &str = include_str!("fixtures/routing/rectifier_errors.json");
const REDACTED_REQUEST_LOGS: &str = include_str!("fixtures/routing/redacted_request_logs.json");

fn parse_fixture(raw: &str) -> Value {
    serde_json::from_str(raw).expect("routing fixture must be valid JSON")
}

fn resolve_generic_model(case: &Value) -> String {
    let requested_model = case["requestedModel"].as_str().expect("requested model");
    if !case["routeEnabled"].as_bool().expect("route state") {
        return requested_model.to_string();
    }

    let mapping = &case["mapping"];
    let source = mapping.get("source").and_then(Value::as_str).map(str::trim);
    let target = mapping.get("target").and_then(Value::as_str).map(str::trim);
    if source == Some(requested_model) {
        return target.expect("mapping target").to_string();
    }

    case["bodyOverrideModel"]
        .as_str()
        .unwrap_or(requested_model)
        .to_string()
}

fn assert_sanitized(value: &Value) {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                assert!(!matches!(
                    key.as_str(),
                    "api_key" | "access_token" | "authorization" | "password" | "proxy_password"
                ));
                assert_sanitized(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                assert_sanitized(item);
            }
        }
        Value::String(text) => {
            assert!(!text.contains("sk-"));
            assert!(!text.starts_with("Bearer "));
            assert!(!text.contains("-----BEGIN"));
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[test]
fn protocol_fixture_matrix_covers_supported_formats_and_semantics() {
    let manifest = parse_fixture(PROTOCOL_MATRIX);
    assert_eq!(manifest["schemaVersion"], 1);

    let cases = manifest["cases"].as_array().expect("protocol cases");
    assert_eq!(cases.len(), 10);

    let expected_formats = BTreeSet::from([
        ("claude", "anthropic"),
        ("claude", "openai_chat"),
        ("claude", "openai_responses"),
        ("claude", "gemini_native"),
        ("codex", "responses"),
        ("codex", "chat_completions"),
        ("codex", "anthropic_messages"),
        ("grokbuild", "responses"),
        ("grokbuild", "chat_completions"),
        ("grokbuild", "anthropic_messages"),
    ]);
    let actual_formats = cases
        .iter()
        .map(|case| {
            (
                case["app"].as_str().expect("protocol app"),
                case["format"].as_str().expect("protocol format"),
            )
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(actual_formats, expected_formats);

    let mut format_transports = BTreeSet::new();
    let mut features = BTreeSet::new();
    for case in cases {
        assert_sanitized(case);
        assert!(case["request"].is_object());
        assert!(case["response"].is_object());
        let app = case["app"].as_str().expect("protocol app");
        let format = case["format"].as_str().expect("protocol format");
        if app == "grokbuild" {
            assert_eq!(case["publicApp"], "grok");
        }
        format_transports.insert((
            app,
            format,
            case["transport"].as_str().expect("protocol transport"),
        ));
        let alternate = &case["alternateTransport"];
        assert!(alternate["requestPatch"].is_object());
        assert!(alternate["response"].is_object());
        format_transports.insert((
            app,
            format,
            alternate["transport"]
                .as_str()
                .expect("alternate transport"),
        ));
        for feature in case["features"].as_array().expect("protocol features") {
            features.insert(feature.as_str().expect("protocol feature"));
        }

        let serialized = [
            serde_json::to_string(&case["request"]).expect("serialize protocol request"),
            serde_json::to_string(&case["response"]).expect("serialize protocol response"),
            serde_json::to_string(&alternate["response"]).expect("serialize alternate response"),
        ]
        .concat();
        let case_features = case["features"].as_array().expect("protocol features");
        if case_features.iter().any(|feature| feature == "tool_call") {
            assert!(serialized.contains("tool"));
        }
        if case_features.iter().any(|feature| feature == "reasoning") {
            assert!(serialized.contains("reasoning"));
        }
        if case_features.iter().any(|feature| feature == "thinking") {
            assert!(serialized.contains("thinking") || serialized.contains("thought"));
        }
        if case_features.iter().any(|feature| feature == "media") {
            assert!(serialized.contains("image") || serialized.contains("file"));
        }
        if case_features.iter().any(|feature| feature == "usage") {
            assert!(serialized.contains("usage"));
        }
    }

    for (app, format) in expected_formats {
        assert!(format_transports.contains(&(app, format, "json")));
        assert!(format_transports.contains(&(app, format, "sse")));
    }
    assert_eq!(
        features,
        BTreeSet::from(["media", "reasoning", "thinking", "tool_call", "usage"])
    );
}

#[test]
fn stream_fixture_defines_response_commit_boundary() {
    let manifest = parse_fixture(STREAM_COMMIT);
    assert_eq!(manifest["schemaVersion"], 1);

    let cases = manifest["cases"].as_array().expect("stream cases");
    assert_eq!(cases.len(), 5);
    for case in cases {
        assert_sanitized(case);
        let events = case["events"].as_array().expect("stream events");
        let commit_index = case["commitIndex"].as_u64().expect("commit index") as usize;
        assert!(commit_index < events.len());
        assert_eq!(events[commit_index]["semantic"], true);
        assert_eq!(case["failoverAfterCommit"], false);
        for event in &events[..commit_index] {
            assert_eq!(event["semantic"], false);
        }
    }

    let ordinary = cases
        .iter()
        .find(|case| case["id"] == "ordinary-sse-first-parseable")
        .expect("ordinary SSE fixture");
    let ordinary_events = ordinary["events"].as_array().expect("ordinary events");
    let first_data = ordinary_events
        .iter()
        .position(|event| event["kind"] == "data")
        .expect("ordinary SSE data event");
    assert_eq!(
        first_data,
        ordinary["commitIndex"].as_u64().unwrap() as usize
    );

    let responses_keepalive = cases
        .iter()
        .find(|case| case["id"] == "responses-sse-keepalive-before-output")
        .expect("Responses keepalive fixture");
    let keepalive_events = responses_keepalive["events"]
        .as_array()
        .expect("keepalive events");
    let keepalive_index = responses_keepalive["commitIndex"].as_u64().unwrap() as usize;
    assert!(keepalive_events[..keepalive_index]
        .iter()
        .all(|event| event["semantic"] == false));
    assert_eq!(
        keepalive_events[keepalive_index]["event"],
        "response.output_text.delta"
    );

    let post_commit_error = cases
        .iter()
        .find(|case| case["id"] == "responses-sse-error-after-output")
        .expect("post-commit error fixture");
    let post_commit_events = post_commit_error["events"]
        .as_array()
        .expect("post-commit events");
    assert_eq!(post_commit_events[1]["event"], "response.error");
    assert_eq!(post_commit_events[1]["semantic"], false);

    let ordinary_post_commit_error = cases
        .iter()
        .find(|case| case["id"] == "ordinary-sse-error-after-data")
        .expect("ordinary post-commit error fixture");
    assert_eq!(ordinary_post_commit_error["commitIndex"], 0);
    assert_eq!(ordinary_post_commit_error["events"][1]["event"], "error");
    assert_eq!(ordinary_post_commit_error["failoverAfterCommit"], false);
}

#[test]
fn model_mapping_fixture_preserves_route_boundaries_and_final_pin() {
    let manifest = parse_fixture(MODEL_MAPPING);
    assert_eq!(manifest["schemaVersion"], 1);

    let generic_cases = manifest["generic"].as_array().expect("generic mappings");
    for case in generic_cases {
        assert_sanitized(case);
        if case["id"] == "failover-recomputes-from-original" {
            continue;
        }
        let requested_model = case["requestedModel"].as_str().expect("requested model");
        let expected_direct = case["expectedDirectModel"].as_str().expect("direct model");
        let expected_route = case["expectedRouteModel"].as_str().expect("route model");
        assert_eq!(expected_direct, requested_model);
        assert_eq!(resolve_generic_model(case), expected_route);

        if case["id"] == "exact-source-maps-to-target" {
            assert_eq!(expected_route, "b");
            assert_eq!(case["bodyOverrideModel"], "override-model");
        }
        if case["id"] == "source-is-case-sensitive" {
            assert_eq!(requested_model, "A");
            assert_eq!(expected_route, "A");
        }
        if case["id"] == "route-off-does-not-map" {
            assert_eq!(case["routeEnabled"], false);
            assert_eq!(expected_route, "a");
        }
    }

    let failover = generic_cases
        .iter()
        .find(|case| case["id"] == "failover-recomputes-from-original")
        .expect("failover mapping fixture");
    let providers = failover["providers"]
        .as_array()
        .expect("failover providers");
    assert_eq!(providers.len(), 2);
    assert_eq!(providers[0]["mapping"]["source"], "a");
    assert_eq!(providers[0]["expectedRouteModel"], "targetA");
    assert_eq!(providers[1]["mapping"]["source"], "a");
    assert_eq!(providers[1]["expectedRouteModel"], "targetB");
    let original_requested_model = failover["requestedModel"].as_str().unwrap();
    for provider in providers {
        let mapping_source = provider["mapping"]["source"]
            .as_str()
            .expect("provider mapping source")
            .trim();
        let mapping_target = provider["mapping"]["target"]
            .as_str()
            .expect("provider mapping target")
            .trim();
        let resolved_model = if mapping_source == original_requested_model {
            mapping_target
        } else {
            original_requested_model
        };
        assert_eq!(provider["expectedRouteModel"], resolved_model);
    }
    assert_ne!(
        failover["bodyOverrideModel"],
        providers[0]["expectedRouteModel"]
    );

    let validation_cases = manifest["validation"]
        .as_array()
        .expect("mapping validation");
    for case in validation_cases {
        let mappings = case["mappings"].as_array().expect("mapping entries");
        let sources = mappings
            .iter()
            .map(|mapping| mapping["source"].as_str().expect("mapping source"))
            .collect::<Vec<_>>();
        let unique_sources = sources
            .iter()
            .map(|source| source.trim())
            .collect::<BTreeSet<_>>();
        let has_empty_source = sources.iter().any(|source| source.trim().is_empty());
        let has_empty_target = mappings.iter().any(|mapping| {
            mapping["target"]
                .as_str()
                .expect("mapping target")
                .trim()
                .is_empty()
        });
        let expected_valid =
            !has_empty_source && !has_empty_target && unique_sources.len() == sources.len();
        assert_eq!(case["valid"], expected_valid);
    }

    let roles = manifest["claudeRoles"].as_array().expect("Claude roles");
    assert_eq!(roles.len(), 6);
    assert!(roles
        .iter()
        .any(|role| role["id"] == "fable-falls-back-to-opus"));
    assert!(roles
        .iter()
        .any(|role| role["id"] == "subagent-exact-model"));
    assert!(roles.iter().all(|role| role["expectedModel"].is_string()));

    let catalog = &manifest["catalogFallback"];
    assert_eq!(catalog["requestedCatalogModel"], "catalog-upstream-fixture");
    assert_eq!(catalog["expectedCatalogModel"], "catalog-upstream-fixture");
    assert_eq!(catalog["requestedDisplayName"], catalog["displayName"]);
    assert_eq!(
        catalog["expectedDisplayNameModel"],
        "provider-upstream-fixture"
    );
    assert_eq!(catalog["expectedUnknownModel"], "provider-upstream-fixture");
}

#[test]
fn rectifier_fixture_covers_exact_rules_and_route_scope() {
    let manifest = parse_fixture(RECTIFIER_ERRORS);
    assert_eq!(manifest["schemaVersion"], 1);

    let cases = manifest["cases"].as_array().expect("rectifier cases");
    assert_eq!(cases.len(), 12);
    for case in cases {
        assert_sanitized(case);
        let route_enabled = case["routeEnabled"].as_bool().expect("route state");
        let retry_once = case["expected"]["retryOnce"]
            .as_bool()
            .expect("retry state");
        if !route_enabled || case["rule"] == "none" {
            assert!(!retry_once);
        }
    }

    let signature = cases
        .iter()
        .find(|case| case["id"] == "thinking-signature-invalid")
        .expect("signature fixture");
    assert_eq!(signature["expected"]["retryOnce"], true);
    assert_eq!(signature["expected"]["removeInvalidThinking"], true);

    let budget = cases
        .iter()
        .find(|case| case["id"] == "thinking-budget-constraint")
        .expect("budget fixture");
    assert_eq!(budget["expected"]["budgetTokens"], 32000);
    assert_eq!(budget["expected"]["maxTokens"], 64000);
    let adaptive_budget = cases
        .iter()
        .find(|case| case["id"] == "thinking-budget-adaptive-is-not-mutated")
        .expect("adaptive budget fixture");
    assert_eq!(adaptive_budget["expected"]["retryOnce"], false);
    assert_eq!(adaptive_budget["expected"]["thinkingType"], "adaptive");

    let media = cases
        .iter()
        .filter(|case| case["rule"] == "media_fallback")
        .collect::<Vec<_>>();
    assert_eq!(media.len(), 3);
    assert!(media.iter().all(|case| {
        case["expected"]["retryOnce"] == true
            && case["expected"]["replacementText"] == "[Unsupported Image]"
            && case["expected"]["logsOriginalMedia"]
                .as_bool()
                .unwrap_or(false)
                == false
    }));
    for case in &media {
        let serialized_request = serde_json::to_string(&case["request"]).unwrap();
        assert!(
            serialized_request.contains("image")
                || serialized_request.contains("file")
                || serialized_request.contains("mcp")
        );
        assert!(!case["expected"]["replacementText"]
            .as_str()
            .unwrap()
            .contains("fixture-image-url"));
    }
    let heuristic_case = media
        .iter()
        .find(|case| case["id"] == "media-heuristic-disabled-still-keeps-explicit-fallback")
        .expect("heuristic fixture");
    assert_eq!(heuristic_case["heuristicEnabled"], false);
    assert_eq!(heuristic_case["expected"]["heuristicPreflight"], false);

    let bedrock = cases
        .iter()
        .find(|case| case["id"] == "bedrock-thinking-optimizer")
        .expect("Bedrock fixture");
    assert_eq!(bedrock["effectiveEnv"]["CLAUDE_CODE_USE_BEDROCK"], "1");
    assert_eq!(bedrock["modelGeneration"], "legacy");
    assert_eq!(bedrock["expected"]["addsBeta"], true);

    let bedrock_cache = cases
        .iter()
        .find(|case| case["id"] == "bedrock-cache-injection-preserves-existing-breakpoints")
        .expect("Bedrock cache fixture");
    assert_eq!(bedrock_cache["expected"]["maxBreakpoints"], 4);
    assert_eq!(bedrock_cache["expected"]["preserveExisting"], true);

    let non_bedrock = cases
        .iter()
        .find(|case| case["id"] == "bedrock-fields-do-not-leak-to-non-bedrock")
        .expect("non-Bedrock fixture");
    assert_eq!(non_bedrock["effectiveEnv"]["CLAUDE_CODE_USE_BEDROCK"], "0");
    assert_eq!(non_bedrock["expected"]["addsBeta"], false);
    assert_eq!(non_bedrock["expected"]["thinkingType"], Value::Null);

    let non_anthropic_signature = cases
        .iter()
        .find(|case| case["id"] == "signature-error-on-non-anthropic-provider-is-not-rectified")
        .expect("non-Anthropic signature fixture");
    assert_eq!(non_anthropic_signature["expected"]["retryOnce"], false);
}

#[test]
fn route_request_log_fixture_excludes_sensitive_payload_fields() {
    let manifest = parse_fixture(REDACTED_REQUEST_LOGS);
    assert_eq!(manifest["schemaVersion"], 1);

    let forbidden_fields = manifest["forbiddenFields"]
        .as_array()
        .expect("forbidden log fields")
        .iter()
        .map(|field| field.as_str().expect("forbidden field"))
        .collect::<BTreeSet<_>>();
    let entries = manifest["entries"].as_array().expect("request log entries");
    assert_eq!(entries.len(), 2);
    let expected_fields = BTreeSet::from([
        "request_id",
        "app_type",
        "provider_id",
        "provider_name",
        "requested_model",
        "upstream_model",
        "started_at_ms",
        "duration_ms",
        "status_code",
        "outcome",
        "degraded",
        "attempt_count",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
        "rectifier_flags",
        "error_code",
        "created_at_ms",
    ]);
    for entry in entries {
        assert_sanitized(entry);
        let fields = entry.as_object().expect("request log entry object");
        assert!(fields
            .keys()
            .all(|key| !forbidden_fields.contains(key.as_str())));
        assert_eq!(
            fields.keys().map(String::as_str).collect::<BTreeSet<_>>(),
            expected_fields
        );
        assert!(entry["requested_model"].is_string());
        assert!(entry["upstream_model"].is_string());
        assert!(entry["duration_ms"].as_i64().unwrap() >= 0);
        assert!(entry["attempt_count"].as_i64().unwrap() >= 1);
        assert!(entry["degraded"].as_i64().unwrap() <= 1);
        assert!(entry["rectifier_flags"].is_string());
        assert!(entry["app_type"] == "claude" || entry["app_type"] == "codex");
    }

    let runtime_attempts = manifest["runtimeKeyAttempts"]
        .as_array()
        .expect("runtime key attempts");
    assert_eq!(runtime_attempts.len(), 1);
    assert_sanitized(&runtime_attempts[0]);
    assert_eq!(runtime_attempts[0]["key_id"], "key-fixture-1");
    assert_eq!(runtime_attempts[0]["key_label"], "Fixture key …0001");
}
