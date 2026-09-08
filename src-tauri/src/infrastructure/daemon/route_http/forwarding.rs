use super::super::circuit::CircuitPolicy;
use super::{
    add_bedrock_beta_header, apply_bedrock_optimizations, apply_model_mapping,
    capture_upstream_error_body, capture_upstream_error_response, classify_route,
    classify_upstream_status, effective_model_for_request, header_bytes, is_hop_by_hop,
    is_key_retryable, is_media_capability_error, is_media_capability_status,
    is_thinking_budget_error, is_thinking_signature_error, load_provider_snapshots, max_attempts,
    record_circuit_failure, record_circuit_success, rectify_thinking_budget,
    remove_invalid_thinking_blocks, replace_unsupported_media, request_headers,
    reserve_provider_attempt, route_app_type, should_hot_switch_provider,
    should_preflight_media_fallback, timed_body_stream, upstream_url, use_claude_api_key_header,
    BodyTimeoutMode, CircuitCommit, HotSwitchCommit, KeySelection, ProviderAttemptOutcome,
    ProviderSnapshot, RouteBody, RouteKind, RouteState, StreamCommitKind, StreamCommitTracker,
    UpstreamErrorClass, UpstreamSendFailure, UsageCommit, MAX_BODY_BYTES, MAX_HEADER_BYTES,
};
use crate::usage::{self, RouteUsageContext, SseUsageCollector};
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE as REQ_CONTENT_TYPE};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

async fn response_bytes_limited(
    mut response: reqwest::Response,
) -> Result<bytes::Bytes, &'static str> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY_BYTES as u64)
    {
        return Err("routing_upstream_body_too_large");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "routing_upstream_body_failed")?
    {
        if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err("routing_upstream_body_too_large");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.into())
}

pub(super) async fn forward_request(
    request: Request<Incoming>,
    state: Arc<RouteState>,
) -> Result<Response<RouteBody>, (StatusCode, &'static str)> {
    let request_path = request.uri().path().to_string();
    let route = classify_route(request.method(), &request_path)?;
    let request_started_at = crate::provider::routing::now_millis();
    let request_id = usage::new_request_id();
    if header_bytes(request.headers()) > MAX_HEADER_BYTES {
        return Err((
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            "routing_headers_too_large",
        ));
    }
    let headers = request_headers(&request);
    let body = Limited::new(request.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "routing_body_too_large"))?
        .to_bytes();
    let request_json = serde_json::from_slice::<serde_json::Value>(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "routing_request_json_invalid"))?;
    if !request_json.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            "routing_request_body_must_be_object",
        ));
    }
    let app_type = route_app_type(route);
    let requested_model = request_json
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let header_pairs = headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect::<Vec<_>>();
    let session_id =
        usage::session_id_from_headers_and_body(app_type, &header_pairs, &request_json);
    let usage_logging_enabled = crate::provider::routing::usage_logging_enabled()
        .await
        .unwrap_or(true);
    let rectifier_config = crate::provider::routing::load_rectifier_config()
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "routing_rectifier_config_unavailable",
            )
        })?;
    let optimizer_config = crate::provider::routing::load_optimizer_config()
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "routing_optimizer_config_unavailable",
            )
        })?;
    let mut retry_context = crate::provider::routing::RoutingRetryContext::default();
    let failover_config =
        crate::provider::routing::load_failover_config_for_daemon(route_app_type(route))
            .await
            .map_err(|_| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "routing_failover_config_unavailable",
                )
            })?;
    let streaming = request_json
        .get("stream")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let error_capture_timeout = Duration::from_secs(if streaming {
        failover_config.streaming_idle_timeout
    } else {
        failover_config.non_streaming_timeout
    });
    let circuit_policy = CircuitPolicy {
        failure_threshold: failover_config.circuit_failure_threshold,
        success_threshold: failover_config.circuit_success_threshold,
        timeout: Duration::from_secs(failover_config.circuit_timeout_seconds),
        error_rate_threshold: failover_config.circuit_error_rate_threshold,
        min_requests: failover_config.circuit_min_requests,
    };
    let snapshots = load_provider_snapshots(route, failover_config.auto_failover_enabled)
        .await
        .map_err(|error| {
            log::warn!("routing provider snapshot unavailable: {error}");
            if error.starts_with("provider_model_mapping_") {
                (StatusCode::BAD_REQUEST, "routing_model_mapping_invalid")
            } else {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "routing_provider_unavailable",
                )
            }
        })?;
    log::info!(
        "routing candidates: app_type={} order={} max_attempts={} streaming={}",
        route_app_type(route),
        snapshots
            .iter()
            .map(|snapshot| format!("{}({})", snapshot.provider_name, snapshot.provider_id))
            .collect::<Vec<_>>()
            .join(" -> "),
        if failover_config.auto_failover_enabled {
            max_attempts(failover_config.max_retries)
        } else {
            1
        },
        streaming,
    );
    crate::provider::network_client::current_client_from_persisted()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_client_failed"))?;
    let mut client_builder =
        crate::provider::network_client::configure_builder(reqwest::Client::builder())
            .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_client_failed"))?;
    if !streaming {
        client_builder =
            client_builder.timeout(Duration::from_secs(failover_config.non_streaming_timeout));
    }
    let client = client_builder
        .build()
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_client_failed"))?;
    let max_provider_attempts = if failover_config.auto_failover_enabled {
        max_attempts(failover_config.max_retries) as usize
    } else {
        1
    };
    let mut provider_index = 0usize;
    let mut actual_provider_attempts = 0usize;
    let mut terminal_failure = None;
    let record_failed_attempt = |snapshot: &ProviderSnapshot,
                                 attempt_index: usize,
                                 status_code: Option<StatusCode>,
                                 error_code: &'static str,
                                 capture: usage::UsageCapture| {
        if !usage_logging_enabled {
            return;
        }
        let context = RouteUsageContext {
            request_id: format!("{}:attempt:{}", request_id, attempt_index + 1),
            logical_request_id: request_id.clone(),
            app_type: app_type.to_string(),
            session_id: session_id.clone(),
            requested_model: requested_model.clone(),
            outbound_model: effective_model_for_request(&request_json, &snapshot.model_mappings),
            provider_id: snapshot.provider_id.clone(),
            provider_name: snapshot.provider_name.clone(),
            started_at_ms: request_started_at,
            is_streaming: streaming,
            attempt_index: attempt_index as u32,
            attempt_count: attempt_index.saturating_add(1) as u32,
            degraded: attempt_index > 0,
        };
        tokio::task::spawn_local(async move {
            usage::record_route_usage_best_effort(
                context,
                capture,
                status_code.map(|status| status.as_u16()),
                "error",
                Some(error_code),
                crate::provider::routing::now_millis().saturating_sub(request_started_at),
            )
            .await;
        });
    };
    let record_skipped_attempt = |snapshot: &ProviderSnapshot,
                                  candidate_index: usize,
                                  actual_attempts: usize,
                                  status_code: Option<StatusCode>,
                                  error_code: &'static str| {
        if !usage_logging_enabled {
            return;
        }
        let context = RouteUsageContext {
            request_id: format!("{}:skip:{}", request_id, candidate_index + 1),
            logical_request_id: request_id.clone(),
            app_type: app_type.to_string(),
            session_id: session_id.clone(),
            requested_model: requested_model.clone(),
            outbound_model: effective_model_for_request(&request_json, &snapshot.model_mappings),
            provider_id: snapshot.provider_id.clone(),
            provider_name: snapshot.provider_name.clone(),
            started_at_ms: request_started_at,
            is_streaming: streaming,
            attempt_index: actual_attempts as u32,
            attempt_count: actual_attempts as u32,
            degraded: actual_attempts > 0,
        };
        tokio::task::spawn_local(async move {
            usage::record_route_usage_best_effort(
                context,
                usage::UsageCapture::default(),
                status_code.map(|status| status.as_u16()),
                "skipped",
                Some(error_code),
                crate::provider::routing::now_millis().saturating_sub(request_started_at),
            )
            .await;
        });
    };
    let selected = loop {
        if provider_index >= snapshots.len() || actual_provider_attempts >= max_provider_attempts {
            break None;
        }
        let snapshot = snapshots[provider_index].clone();
        log::info!(
            "routing provider candidate: app_type={} index={} provider={} provider_id={}",
            snapshot.app_type,
            provider_index + 1,
            snapshot.provider_name,
            snapshot.provider_id,
        );
        let mut circuit_permit = if failover_config.auto_failover_enabled {
            match state.circuits.acquire(
                route_app_type(route),
                &snapshot.provider_id,
                circuit_policy,
            ) {
                Ok(permit) => Some(permit),
                Err(_) => {
                    log::warn!(
                        "routing provider skipped: app_type={} provider={} provider_id={} reason=circuit_open",
                        snapshot.app_type,
                        snapshot.provider_name,
                        snapshot.provider_id,
                    );
                    record_skipped_attempt(
                        &snapshot,
                        provider_index,
                        actual_provider_attempts,
                        Some(StatusCode::SERVICE_UNAVAILABLE),
                        "routing_provider_circuit_open",
                    );
                    provider_index = provider_index.saturating_add(1);
                    continue;
                }
            }
        } else {
            None
        };
        let url = match upstream_url(&snapshot.base_url, route, &request_path) {
            Ok(url) => url,
            Err(_) => {
                if let Some(permit) = circuit_permit.take() {
                    state.circuits.release(permit);
                }
                record_skipped_attempt(
                    &snapshot,
                    provider_index,
                    actual_provider_attempts,
                    Some(StatusCode::BAD_GATEWAY),
                    "routing_provider_endpoint_invalid",
                );
                terminal_failure =
                    Some((StatusCode::BAD_GATEWAY, "routing_provider_endpoint_invalid"));
                provider_index = provider_index.saturating_add(1);
                continue;
            }
        };
        let mut selected_key =
            match state.select_key_status(&snapshot.pool_id, snapshot.key_candidates.clone()) {
                Ok(KeySelection::Ready(key)) => key,
                Ok(KeySelection::CoolingDown) => {
                    if !failover_config.auto_failover_enabled {
                        return Err((
                            StatusCode::SERVICE_UNAVAILABLE,
                            "routing_provider_unavailable",
                        ));
                    }
                    if let Some(permit) = circuit_permit.take() {
                        state.circuits.release(permit);
                    }
                    log::warn!(
                        "routing provider skipped: app_type={} provider_id={} reason=key_cooldown",
                        snapshot.app_type,
                        snapshot.provider_id
                    );
                    record_skipped_attempt(
                        &snapshot,
                        provider_index,
                        actual_provider_attempts,
                        None,
                        "routing_provider_keys_cooling_down",
                    );
                    provider_index = provider_index.saturating_add(1);
                    continue;
                }
                Ok(KeySelection::Unavailable) | Err(_) => {
                    if !failover_config.auto_failover_enabled {
                        return Err((
                            StatusCode::SERVICE_UNAVAILABLE,
                            "routing_provider_unavailable",
                        ));
                    }
                    log::warn!(
                        "routing provider key pool unavailable: app_type={} provider_id={}",
                        snapshot.app_type,
                        snapshot.provider_id
                    );
                    if let Some(permit) = circuit_permit.take() {
                        state.circuits.release(permit);
                    }
                    record_skipped_attempt(
                        &snapshot,
                        provider_index,
                        actual_provider_attempts,
                        None,
                        "routing_provider_keys_unavailable",
                    );
                    provider_index = provider_index.saturating_add(1);
                    continue;
                }
            };
        let mut used_keys = HashSet::from([selected_key.id.clone()]);
        let mut provider_request = request_json.clone();
        let mapped_model = effective_model_for_request(&provider_request, &snapshot.model_mappings);
        if retry_context.can_retry(
            &rectifier_config,
            crate::provider::routing::RoutingRectifierRule::MediaFallback,
        ) && should_preflight_media_fallback(
            &rectifier_config,
            snapshot.media_capability,
            mapped_model.as_deref(),
        ) && replace_unsupported_media(&mut provider_request)
        {
            retry_context.mark_used(crate::provider::routing::RoutingRectifierRule::MediaFallback);
        }
        let mut attempt_headers = headers.clone();
        if apply_bedrock_optimizations(
            &mut provider_request,
            &optimizer_config,
            snapshot.bedrock_enabled,
            mapped_model.as_deref(),
        ) {
            add_bedrock_beta_header(&mut attempt_headers);
        }
        let outcome = loop {
            let attempt_body = apply_model_mapping(&provider_request, &snapshot.model_mappings)
                .map_err(|_| (StatusCode::BAD_REQUEST, "routing_model_mapping_invalid"))?;
            let Some(actual_attempt_index) =
                reserve_provider_attempt(&mut actual_provider_attempts, max_provider_attempts)
            else {
                break ProviderAttemptOutcome::KeyExhausted;
            };
            let mut upstream = client.post(&url);
            for (name, value) in &attempt_headers {
                upstream = upstream.header(name, value);
            }
            if use_claude_api_key_header(&snapshot) {
                upstream = upstream.header("x-api-key", selected_key.api_key.clone());
            } else {
                upstream = upstream.header(
                    AUTHORIZATION.as_str(),
                    format!("Bearer {}", selected_key.api_key),
                );
            }
            let send_result = if streaming {
                match tokio::time::timeout(
                    Duration::from_secs(failover_config.streaming_first_byte_timeout),
                    upstream
                        .header(REQ_CONTENT_TYPE.as_str(), "application/json")
                        .body(attempt_body)
                        .send(),
                )
                .await
                {
                    Ok(result) => result.map_err(|error| {
                        if error.is_timeout() {
                            UpstreamSendFailure::Timeout
                        } else {
                            UpstreamSendFailure::Request
                        }
                    }),
                    Err(_) => Err(UpstreamSendFailure::Timeout),
                }
            } else {
                upstream
                    .header(REQ_CONTENT_TYPE.as_str(), "application/json")
                    .body(attempt_body)
                    .send()
                    .await
                    .map_err(|error| {
                        if error.is_timeout() {
                            UpstreamSendFailure::Timeout
                        } else {
                            UpstreamSendFailure::Request
                        }
                    })
            };
            let response = match send_result {
                Ok(response) => response,
                Err(UpstreamSendFailure::Timeout) => {
                    log::warn!(
                        "routing provider failed: app_type={} provider={} provider_id={} reason=timeout",
                        snapshot.app_type,
                        snapshot.provider_name,
                        snapshot.provider_id,
                    );
                    record_failed_attempt(
                        &snapshot,
                        actual_attempt_index,
                        Some(StatusCode::GATEWAY_TIMEOUT),
                        "routing_upstream_timeout",
                        usage::UsageCapture::default(),
                    );
                    break ProviderAttemptOutcome::Failure(
                        StatusCode::GATEWAY_TIMEOUT,
                        "routing_upstream_timeout",
                    );
                }
                Err(UpstreamSendFailure::Request) => {
                    log::warn!(
                        "routing provider failed: app_type={} provider={} provider_id={} reason=request_error",
                        snapshot.app_type,
                        snapshot.provider_name,
                        snapshot.provider_id,
                    );
                    record_failed_attempt(
                        &snapshot,
                        actual_attempt_index,
                        Some(StatusCode::BAD_GATEWAY),
                        "routing_upstream_request_failed",
                        usage::UsageCapture::default(),
                    );
                    break ProviderAttemptOutcome::Failure(
                        StatusCode::BAD_GATEWAY,
                        "routing_upstream_request_failed",
                    );
                }
            };
            log::info!(
                "routing provider response: app_type={} provider={} provider_id={} status={} class={:?}",
                snapshot.app_type,
                snapshot.provider_name,
                snapshot.provider_id,
                response.status().as_u16(),
                classify_upstream_status(response.status()),
            );
            let is_anthropic_provider = snapshot.app_type == "claude"
                && snapshot.claude_api_format.as_deref() == Some("anthropic");
            let is_media_status = is_media_capability_status(response.status());
            let can_signature = retry_context.can_retry(
                &rectifier_config,
                crate::provider::routing::RoutingRectifierRule::ThinkingSignature,
            );
            let can_budget = retry_context.can_retry(
                &rectifier_config,
                crate::provider::routing::RoutingRectifierRule::ThinkingBudget,
            );
            let can_media = retry_context.can_retry(
                &rectifier_config,
                crate::provider::routing::RoutingRectifierRule::MediaFallback,
            );
            let should_read_anthropic_client_error = !streaming
                && response.status() == StatusCode::BAD_REQUEST
                && is_anthropic_provider
                && (can_signature || can_budget || can_media);
            let should_read_media_error = !streaming
                && is_media_status
                && (!is_anthropic_provider || response.status() != StatusCode::BAD_REQUEST)
                && can_media;
            if should_read_anthropic_client_error || should_read_media_error {
                let response_status = response.status();
                let error_body = match response_bytes_limited(response).await {
                    Ok(body) => body,
                    Err(error_code) => {
                        record_failed_attempt(
                            &snapshot,
                            actual_attempt_index,
                            Some(StatusCode::BAD_GATEWAY),
                            error_code,
                            usage::UsageCapture::default(),
                        );
                        break ProviderAttemptOutcome::Failure(StatusCode::BAD_GATEWAY, error_code);
                    }
                };
                let error_capture = usage_logging_enabled
                    .then(|| capture_upstream_error_body(&error_body))
                    .unwrap_or_default();
                if should_read_anthropic_client_error {
                    if can_signature && is_thinking_signature_error(&error_body) {
                        remove_invalid_thinking_blocks(&mut provider_request);
                        retry_context.mark_used(
                            crate::provider::routing::RoutingRectifierRule::ThinkingSignature,
                        );
                        record_failed_attempt(
                            &snapshot,
                            actual_attempt_index,
                            Some(response_status),
                            "routing_upstream_rectifier_retry",
                            error_capture.clone(),
                        );
                        if actual_provider_attempts >= max_provider_attempts {
                            break ProviderAttemptOutcome::Failure(
                                StatusCode::BAD_GATEWAY,
                                "routing_upstream_provider_failed",
                            );
                        }
                        continue;
                    }
                    if can_budget
                        && is_thinking_budget_error(&error_body)
                        && rectify_thinking_budget(&mut provider_request)
                    {
                        retry_context.mark_used(
                            crate::provider::routing::RoutingRectifierRule::ThinkingBudget,
                        );
                        record_failed_attempt(
                            &snapshot,
                            actual_attempt_index,
                            Some(response_status),
                            "routing_upstream_rectifier_retry",
                            error_capture.clone(),
                        );
                        if actual_provider_attempts >= max_provider_attempts {
                            break ProviderAttemptOutcome::Failure(
                                StatusCode::BAD_GATEWAY,
                                "routing_upstream_provider_failed",
                            );
                        }
                        continue;
                    }
                }
                if can_media
                    && is_media_capability_error(&error_body)
                    && replace_unsupported_media(&mut provider_request)
                {
                    retry_context
                        .mark_used(crate::provider::routing::RoutingRectifierRule::MediaFallback);
                    record_failed_attempt(
                        &snapshot,
                        actual_attempt_index,
                        Some(response_status),
                        "routing_upstream_rectifier_retry",
                        error_capture.clone(),
                    );
                    if actual_provider_attempts >= max_provider_attempts {
                        break ProviderAttemptOutcome::Failure(
                            StatusCode::BAD_GATEWAY,
                            "routing_upstream_provider_failed",
                        );
                    }
                    continue;
                }
                if failover_config.auto_failover_enabled {
                    record_failed_attempt(
                        &snapshot,
                        actual_attempt_index,
                        Some(response_status),
                        "routing_upstream_provider_failed",
                        error_capture,
                    );
                    break ProviderAttemptOutcome::Failure(
                        StatusCode::BAD_GATEWAY,
                        "routing_upstream_provider_failed",
                    );
                }
                record_failed_attempt(
                    &snapshot,
                    actual_attempt_index,
                    Some(response_status),
                    "routing_upstream_client_error",
                    error_capture,
                );
                return Err((StatusCode::BAD_REQUEST, "routing_upstream_client_error"));
            }
            if classify_upstream_status(response.status()) == UpstreamErrorClass::Provider {
                let status = response.status();
                let capture = if usage_logging_enabled {
                    capture_upstream_error_response(response, error_capture_timeout).await
                } else {
                    usage::UsageCapture::default()
                };
                record_failed_attempt(
                    &snapshot,
                    actual_attempt_index,
                    Some(status),
                    "routing_upstream_provider_failed",
                    capture,
                );
                break ProviderAttemptOutcome::Failure(
                    StatusCode::BAD_GATEWAY,
                    "routing_upstream_provider_failed",
                );
            }
            if !is_key_retryable(response.status()) {
                break ProviderAttemptOutcome::Response(response, actual_attempt_index);
            }
            let response_status = response.status();
            state.mark_cooldown(
                &snapshot.pool_id,
                &selected_key.id,
                response_status.as_u16(),
                response.headers(),
            );
            let Some(next_key) = state.next_key(&snapshot.pool_id, &used_keys) else {
                break if failover_config.auto_failover_enabled {
                    let capture = if usage_logging_enabled {
                        capture_upstream_error_response(response, error_capture_timeout).await
                    } else {
                        usage::UsageCapture::default()
                    };
                    record_failed_attempt(
                        &snapshot,
                        actual_attempt_index,
                        Some(response_status),
                        "routing_provider_key_exhausted",
                        capture,
                    );
                    ProviderAttemptOutcome::KeyExhausted
                } else {
                    ProviderAttemptOutcome::Response(response, actual_attempt_index)
                };
            };
            if actual_provider_attempts >= max_provider_attempts {
                break if failover_config.auto_failover_enabled {
                    let capture = if usage_logging_enabled {
                        capture_upstream_error_response(response, error_capture_timeout).await
                    } else {
                        usage::UsageCapture::default()
                    };
                    record_failed_attempt(
                        &snapshot,
                        actual_attempt_index,
                        Some(response_status),
                        "routing_provider_key_exhausted",
                        capture,
                    );
                    ProviderAttemptOutcome::KeyExhausted
                } else {
                    ProviderAttemptOutcome::Response(response, actual_attempt_index)
                };
            }
            let capture = if usage_logging_enabled {
                capture_upstream_error_response(response, error_capture_timeout).await
            } else {
                usage::UsageCapture::default()
            };
            record_failed_attempt(
                &snapshot,
                actual_attempt_index,
                Some(response_status),
                "routing_upstream_key_retry",
                capture,
            );
            used_keys.insert(next_key.id.clone());
            selected_key = next_key;
        };
        match outcome {
            ProviderAttemptOutcome::Response(response, actual_attempt_index) => {
                log::info!(
                    "routing provider selected: app_type={} provider={} provider_id={} index={}",
                    snapshot.app_type,
                    snapshot.provider_name,
                    snapshot.provider_id,
                    actual_attempt_index + 1,
                );
                let outbound_model =
                    effective_model_for_request(&request_json, &snapshot.model_mappings);
                break Some((
                    response,
                    circuit_permit,
                    actual_attempt_index,
                    snapshot.provider_id,
                    snapshot.provider_name,
                    snapshot.is_current,
                    outbound_model,
                ));
            }
            ProviderAttemptOutcome::Failure(status, message) => {
                log::warn!(
                    "routing provider circuit failure: app_type={} provider={} provider_id={} status={} reason={}",
                    snapshot.app_type,
                    snapshot.provider_name,
                    snapshot.provider_id,
                    status.as_u16(),
                    message,
                );
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                terminal_failure = Some((status, message));
            }
            ProviderAttemptOutcome::KeyExhausted => {
                log::warn!(
                    "routing provider key pool exhausted: app_type={} provider_id={}",
                    snapshot.app_type,
                    snapshot.provider_id
                );
                log::warn!(
                    "routing provider circuit failure: app_type={} provider={} provider_id={} reason=key_exhausted",
                    snapshot.app_type,
                    snapshot.provider_name,
                    snapshot.provider_id,
                );
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                terminal_failure =
                    Some((StatusCode::BAD_GATEWAY, "routing_provider_key_exhausted"));
            }
        }
        provider_index = provider_index.saturating_add(1);
    };
    let Some((
        response,
        mut circuit_permit,
        selected_provider_index,
        selected_provider_id,
        selected_provider_name,
        selected_provider_is_current,
        selected_outbound_model,
    )) = selected
    else {
        log::warn!(
            "routing failover exhausted: app_type={} attempted={} loaded={} max_attempts={}",
            route_app_type(route),
            actual_provider_attempts,
            snapshots.len(),
            max_provider_attempts,
        );
        return Err(terminal_failure.unwrap_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "routing_provider_circuit_open",
        )));
    };
    let status = response.status();
    let should_hot_switch = should_hot_switch_provider(
        failover_config.auto_failover_enabled,
        selected_provider_is_current,
        status,
    );
    log::info!(
        "routing provider final response: app_type={} provider={} provider_id={} status={} index={}",
        route_app_type(route),
        selected_provider_name,
        selected_provider_id,
        status.as_u16(),
        selected_provider_index + 1,
    );
    let headers = response.headers().clone();
    let route_usage_context = |provider_id: String, provider_name: String| RouteUsageContext {
        request_id: format!("{}:attempt:{}", request_id, selected_provider_index + 1),
        logical_request_id: request_id.clone(),
        app_type: app_type.to_string(),
        session_id: session_id.clone(),
        requested_model: requested_model.clone(),
        outbound_model: selected_outbound_model.clone(),
        provider_id,
        provider_name,
        started_at_ms: request_started_at,
        is_streaming: streaming,
        attempt_index: selected_provider_index as u32,
        attempt_count: selected_provider_index.saturating_add(1) as u32,
        degraded: selected_provider_index > 0,
    };
    if !streaming {
        let body = match tokio::time::timeout(
            Duration::from_secs(failover_config.non_streaming_timeout),
            response_bytes_limited(response),
        )
        .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(error_code)) => {
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                return Err((StatusCode::BAD_GATEWAY, error_code));
            }
            Err(_) => {
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                return Err((StatusCode::GATEWAY_TIMEOUT, "routing_upstream_timeout"));
            }
        };
        if should_hot_switch {
            if let Err(error) = crate::provider::routing::apply_hot_switch_for_active_homes(
                route_app_type(route),
                &selected_provider_id,
            )
            .await
            {
                log::warn!("routing hot switch failed: {error}");
            }
        }
        let upstream_success = classify_upstream_status(status) == UpstreamErrorClass::Success;
        if upstream_success {
            record_circuit_success(&state, &mut circuit_permit, circuit_policy);
        } else if let Some(permit) = circuit_permit.take() {
            state.circuits.release(permit);
        }
        if usage_logging_enabled {
            let capture = serde_json::from_slice::<serde_json::Value>(&body)
                .map(|value| usage::parse_response_json(&value))
                .unwrap_or_default();
            let context =
                route_usage_context(selected_provider_id.clone(), selected_provider_name.clone());
            let duration_ms =
                crate::provider::routing::now_millis().saturating_sub(request_started_at);
            tokio::spawn(async move {
                usage::record_route_usage_best_effort(
                    context,
                    capture,
                    Some(status.as_u16()),
                    if upstream_success { "success" } else { "error" },
                    if upstream_success {
                        None
                    } else {
                        Some("routing_upstream_http_error")
                    },
                    duration_ms,
                )
                .await;
            });
        }
        let body = Full::new(body).map_err(|error| match error {}).boxed();
        let mut builder = Response::builder().status(status);
        for (name, value) in headers {
            let Some(name) = name else { continue };
            if is_hop_by_hop(name.as_str()) {
                continue;
            }
            builder = builder.header(name, value);
        }
        return builder
            .body(body)
            .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_response_build_failed"));
    }
    let timeout_mode = if streaming {
        BodyTimeoutMode::Streaming {
            first_byte: Duration::from_secs(failover_config.streaming_first_byte_timeout),
            idle: Duration::from_secs(failover_config.streaming_idle_timeout),
            received_first: false,
        }
    } else {
        BodyTimeoutMode::NonStreaming {
            deadline: Instant::now() + Duration::from_secs(failover_config.non_streaming_timeout),
        }
    };
    let commit_kind = if matches!(route, RouteKind::CodexResponses) {
        StreamCommitKind::ResponsesSse
    } else {
        StreamCommitKind::GenericSse
    };
    let stream = timed_body_stream(
        response.bytes_stream(),
        timeout_mode,
        Some(StreamCommitTracker::new(commit_kind)),
        circuit_permit.take().map(|permit| CircuitCommit {
            state: Arc::clone(&state),
            permit: Some(permit),
            policy: circuit_policy,
            app_type: route_app_type(route),
            provider_id: selected_provider_id.clone(),
            provider_name: selected_provider_name.clone(),
            hot_switch: should_hot_switch.then(|| HotSwitchCommit {
                app_type: route_app_type(route),
                provider_id: selected_provider_id.clone(),
            }),
        }),
        usage_logging_enabled.then(|| SseUsageCollector::default()),
        usage_logging_enabled.then(|| UsageCommit {
            context: route_usage_context(
                selected_provider_id.clone(),
                selected_provider_name.clone(),
            ),
            status_code: Some(status.as_u16()),
            initial_error_code: if classify_upstream_status(status) == UpstreamErrorClass::Success {
                None
            } else {
                Some("routing_upstream_http_error")
            },
        }),
    );
    let body = BodyExt::boxed(StreamBody::new(stream));
    let mut builder = Response::builder().status(status);
    for (name, value) in headers {
        let Some(name) = name else { continue };
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder
        .body(body)
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_response_build_failed"))
}
