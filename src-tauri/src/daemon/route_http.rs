use super::circuit::{CircuitPermit, CircuitPolicy, CircuitRegistry, CircuitSnapshot};
use crate::usage::{self, RouteUsageContext, SseUsageCollector};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderName, HeaderValue, ALLOW, CONTENT_TYPE, HOST};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use reqwest::header::{
    AUTHORIZATION, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE as REQ_CONTENT_TYPE,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::error::Error;
use std::net::TcpListener;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_DIAGNOSTIC_BODY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const KEY_COOLDOWN_DEFAULT: Duration = Duration::from_secs(30);
const KEY_COOLDOWN_MAX: Duration = Duration::from_secs(60);

type BoxError = Box<dyn Error + Send + Sync>;
type RouteBody = http_body_util::combinators::BoxBody<Bytes, BoxError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteKind {
    ClaudeMessages,
    CodexResponses,
    CodexChatCompletions,
    Grok,
}

const UNSUPPORTED_MEDIA_PLACEHOLDER: &str = "[Unsupported Image]";
const TEXT_ONLY_MODEL_IDS: &[&str] = &[
    "text-davinci-002",
    "text-davinci-003",
    "gpt-3.5-turbo-instruct",
    "claude-2",
    "claude-2.0",
    "claude-2.1",
    "claude-instant-1.2",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaCapability {
    Unknown,
    TextOnly,
}

#[derive(Debug, Clone)]
struct ProviderSnapshot {
    app_type: &'static str,
    provider_id: String,
    provider_name: String,
    is_current: bool,
    base_url: String,
    claude_api_key_field: Option<String>,
    claude_api_format: Option<String>,
    pool_id: String,
    key_candidates: Vec<KeyCandidate>,
    model_mappings: Vec<ModelMapping>,
    media_capability: MediaCapability,
    bedrock_enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpstreamErrorClass {
    Success,
    Key,
    Provider,
    Client,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpstreamSendFailure {
    Timeout,
    Request,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum KeySelection {
    Ready(KeyCandidate),
    CoolingDown,
    Unavailable,
}

enum ProviderAttemptOutcome {
    Response(reqwest::Response, usize),
    Failure(StatusCode, &'static str),
    KeyExhausted,
}

#[derive(Debug, Clone, Copy)]
enum BodyTimeoutMode {
    Streaming {
        first_byte: Duration,
        idle: Duration,
        received_first: bool,
    },
    NonStreaming {
        deadline: Instant,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamCommitKind {
    GenericSse,
    ResponsesSse,
}

#[derive(Debug)]
struct StreamCommitTracker {
    kind: StreamCommitKind,
    buffer: String,
    settled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamCommitOutcome {
    None,
    Success,
    Failure,
}

impl StreamCommitTracker {
    fn new(kind: StreamCommitKind) -> Self {
        Self {
            kind,
            buffer: String::new(),
            settled: false,
        }
    }

    fn observe(&mut self, chunk: &Bytes) -> StreamCommitOutcome {
        if self.settled {
            return StreamCommitOutcome::None;
        }
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        while let Some(end) = self.buffer.find("\n\n") {
            let event = self.buffer[..end].to_string();
            self.buffer.drain(..end + 2);
            let outcome = self.event_outcome(&event);
            if outcome != StreamCommitOutcome::None {
                self.settled = true;
                return outcome;
            }
        }
        StreamCommitOutcome::None
    }

    fn event_outcome(&self, event: &str) -> StreamCommitOutcome {
        let mut event_name = None;
        let mut data = String::new();
        for line in event.lines() {
            let line = line.trim_end_matches('\r');
            if line.starts_with(':') {
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event_name = Some(value.trim());
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim_start());
            }
        }
        if data.is_empty() {
            return StreamCommitOutcome::None;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) else {
            return StreamCommitOutcome::None;
        };
        let semantic_type = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .or(event_name)
            .unwrap_or_default();
        match self.kind {
            StreamCommitKind::GenericSse => StreamCommitOutcome::Success,
            StreamCommitKind::ResponsesSse => {
                if semantic_type == "error" || semantic_type == "response.failed" {
                    StreamCommitOutcome::Failure
                } else if semantic_type == "response.completed" {
                    StreamCommitOutcome::Success
                } else {
                    StreamCommitOutcome::None
                }
            }
        }
    }
}

struct CircuitCommit {
    state: Arc<RouteState>,
    permit: Option<CircuitPermit>,
    policy: CircuitPolicy,
    app_type: &'static str,
    provider_id: String,
    provider_name: String,
    hot_switch: Option<HotSwitchCommit>,
}

struct HotSwitchCommit {
    app_type: &'static str,
    provider_id: String,
}

struct UsageCommit {
    context: RouteUsageContext,
    status_code: Option<u16>,
    initial_error_code: Option<&'static str>,
}

struct TimedBodyState<S> {
    stream: Pin<Box<S>>,
    mode: BodyTimeoutMode,
    tracker: Option<StreamCommitTracker>,
    circuit: Option<CircuitCommit>,
    usage_collector: Option<SseUsageCollector>,
    usage_commit: Option<UsageCommit>,
}

impl<S> Drop for TimedBodyState<S> {
    fn drop(&mut self) {
        finish_usage_commit(self, Some("routing_client_cancelled"));
        if let Some(circuit) = self.circuit.take() {
            if let Some(permit) = circuit.permit {
                circuit.state.circuits.release(permit);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelMapping {
    source: String,
    target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct KeyCandidate {
    id: String,
    api_key: String,
}

#[derive(Debug)]
struct KeyPool {
    generation: u64,
    candidates: Vec<KeyCandidate>,
    cursor: usize,
    cooldowns: HashMap<String, Instant>,
}

#[derive(Debug, Default)]
pub(crate) struct RouteState {
    pools: Mutex<HashMap<String, KeyPool>>,
    circuits: CircuitRegistry,
}

impl RouteState {
    fn select_key_status(
        &self,
        pool_id: &str,
        candidates: Vec<KeyCandidate>,
    ) -> Result<KeySelection, String> {
        let mut pools = self
            .pools
            .lock()
            .map_err(|_| "routing_key_pool_unavailable".to_string())?;
        let pool = pools.entry(pool_id.to_string()).or_insert_with(|| KeyPool {
            generation: 1,
            candidates: candidates.clone(),
            cursor: 0,
            cooldowns: HashMap::new(),
        });
        if pool.candidates != candidates {
            pool.generation = pool.generation.saturating_add(1);
            pool.candidates = candidates;
            pool.cursor = 0;
            pool.cooldowns.clear();
        }
        Ok(pool.next_key_status(&HashSet::new()))
    }

    #[cfg(test)]
    fn select_key(
        &self,
        pool_id: &str,
        candidates: Vec<KeyCandidate>,
    ) -> Result<KeyCandidate, String> {
        match self.select_key_status(pool_id, candidates)? {
            KeySelection::Ready(key) => Ok(key),
            KeySelection::CoolingDown => Err("routing_provider_keys_cooling_down".to_string()),
            KeySelection::Unavailable => Err("routing_provider_keys_unavailable".to_string()),
        }
    }

    fn next_key(&self, pool_id: &str, used: &HashSet<String>) -> Option<KeyCandidate> {
        let mut pools = self.pools.lock().ok()?;
        pools.get_mut(pool_id)?.next_key(used)
    }

    fn mark_cooldown(
        &self,
        pool_id: &str,
        key_id: &str,
        status: u16,
        headers: &reqwest::header::HeaderMap,
    ) {
        let Ok(mut pools) = self.pools.lock() else {
            return;
        };
        let Some(pool) = pools.get_mut(pool_id) else {
            return;
        };
        let duration = retry_cooldown(status, headers);
        pool.cooldowns
            .insert(key_id.to_string(), Instant::now() + duration);
    }
}

impl KeyPool {
    fn next_key(&mut self, used: &HashSet<String>) -> Option<KeyCandidate> {
        match self.next_key_status(used) {
            KeySelection::Ready(candidate) => Some(candidate),
            KeySelection::CoolingDown | KeySelection::Unavailable => None,
        }
    }

    fn next_key_status(&mut self, used: &HashSet<String>) -> KeySelection {
        let now = Instant::now();
        self.cooldowns.retain(|_, deadline| *deadline > now);
        if self.candidates.is_empty() {
            return KeySelection::Unavailable;
        }
        let mut has_unused = false;
        for _ in 0..self.candidates.len() {
            let index = self.cursor % self.candidates.len();
            self.cursor = (self.cursor + 1) % self.candidates.len();
            let candidate = &self.candidates[index];
            if used.contains(&candidate.id) {
                continue;
            }
            has_unused = true;
            if !self.cooldowns.contains_key(&candidate.id) {
                return KeySelection::Ready(candidate.clone());
            }
        }
        if has_unused {
            KeySelection::CoolingDown
        } else {
            KeySelection::Unavailable
        }
    }
}

pub(crate) struct RouteHttpServer {
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
    state: Arc<RouteState>,
}

impl RouteHttpServer {
    pub(crate) fn start(listeners: &[TcpListener]) -> Result<Self, String> {
        Self::start_with_state(listeners, None)
    }

    pub(crate) fn start_with_state(
        listeners: &[TcpListener],
        existing_state: Option<Arc<RouteState>>,
    ) -> Result<Self, String> {
        if listeners.is_empty() {
            return Err("routing_listener_missing".to_string());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let state = existing_state.unwrap_or_default();
        let mut workers = Vec::with_capacity(listeners.len());
        for source in listeners {
            let listener = match source.try_clone() {
                Ok(listener) => listener,
                Err(_) => {
                    stop_workers(&stop, &mut workers);
                    return Err("routing_listener_clone_failed".to_string());
                }
            };
            if listener.set_nonblocking(true).is_err() {
                stop_workers(&stop, &mut workers);
                return Err("routing_listener_nonblocking_failed".to_string());
            }
            let worker_stop = Arc::clone(&stop);
            let worker_state = Arc::clone(&state);
            let worker = thread::Builder::new()
                .name("cli-manager-route-http".to_string())
                .spawn(move || {
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_io()
                        .enable_time()
                        .build()
                    {
                        Ok(runtime) => runtime,
                        Err(_) => return,
                    };
                    let local = tokio::task::LocalSet::new();
                    local.block_on(
                        &runtime,
                        serve_listener(listener, worker_stop, Arc::clone(&worker_state)),
                    );
                })
                .map_err(|_| "routing_listener_worker_failed".to_string());
            match worker {
                Ok(worker) => workers.push(worker),
                Err(error) => {
                    stop_workers(&stop, &mut workers);
                    return Err(error);
                }
            }
        }
        Ok(Self {
            stop,
            workers,
            state,
        })
    }

    pub(crate) fn circuit_snapshots(&self) -> Vec<CircuitSnapshot> {
        self.state.circuits.snapshots()
    }

    pub(crate) fn shared_state(&self) -> Arc<RouteState> {
        Arc::clone(&self.state)
    }

    pub(crate) fn reset_circuit(&self, app_type: &str, provider_id: &str) {
        self.state.circuits.reset(app_type, provider_id);
    }
}

fn stop_workers(stop: &Arc<AtomicBool>, workers: &mut Vec<JoinHandle<()>>) {
    stop.store(true, Ordering::Release);
    for worker in workers.drain(..) {
        let _ = worker.join();
    }
}

impl Drop for RouteHttpServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

async fn serve_listener(listener: TcpListener, stop: Arc<AtomicBool>, state: Arc<RouteState>) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        return;
    };
    while !stop.load(Ordering::Acquire) {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {},
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let connection_state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let io = TokioIo::new(stream);
                    let service = service_fn(move |request| {
                        handle_request(request, Arc::clone(&connection_state))
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await;
                });
            }
        }
    }
}

async fn handle_request(
    request: Request<Incoming>,
    state: Arc<RouteState>,
) -> Result<Response<RouteBody>, Infallible> {
    Ok(match forward_request(request, state).await {
        Ok(response) => response,
        Err((status, message)) => error_response(status, message),
    })
}

async fn forward_request(
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
                let error_body = match response.bytes().await {
                    Ok(body) => body,
                    Err(_) => {
                        record_failed_attempt(
                            &snapshot,
                            actual_attempt_index,
                            Some(StatusCode::BAD_GATEWAY),
                            "routing_upstream_body_failed",
                            usage::UsageCapture::default(),
                        );
                        break ProviderAttemptOutcome::Failure(
                            StatusCode::BAD_GATEWAY,
                            "routing_upstream_body_failed",
                        );
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
            response.bytes(),
        )
        .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                return Err((StatusCode::BAD_GATEWAY, "routing_upstream_body_failed"));
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

fn classify_route(method: &Method, path: &str) -> Result<RouteKind, (StatusCode, &'static str)> {
    if *method != Method::POST {
        let known = matches!(
            path,
            "/v1/messages" | "/v1/responses" | "/v1/chat/completions"
        ) || path.starts_with("/grokbuild/v1/");
        return Err(if known {
            (StatusCode::METHOD_NOT_ALLOWED, "routing_method_not_allowed")
        } else {
            (StatusCode::NOT_FOUND, "routing_path_not_found")
        });
    }
    match path {
        "/v1/messages" => Ok(RouteKind::ClaudeMessages),
        "/v1/responses" => Ok(RouteKind::CodexResponses),
        "/v1/chat/completions" => Ok(RouteKind::CodexChatCompletions),
        path if path.starts_with("/grokbuild/v1/") && path.len() > "/grokbuild/v1/".len() => {
            Ok(RouteKind::Grok)
        }
        _ => Err((StatusCode::NOT_FOUND, "routing_path_not_found")),
    }
}

fn route_app_type(route: RouteKind) -> &'static str {
    match route {
        RouteKind::ClaudeMessages => "claude",
        RouteKind::CodexResponses | RouteKind::CodexChatCompletions => "codex",
        RouteKind::Grok => "grokbuild",
    }
}

fn route_path(route: RouteKind) -> &'static str {
    match route {
        RouteKind::ClaudeMessages => "/v1/messages",
        RouteKind::CodexResponses => "/v1/responses",
        RouteKind::CodexChatCompletions => "/v1/chat/completions",
        RouteKind::Grok => "/grokbuild/v1/",
    }
}

async fn load_provider_snapshot(route: RouteKind) -> Result<ProviderSnapshot, String> {
    let app_type = route_app_type(route);
    let providers = crate::provider::repository::list_providers(Some(app_type.to_string())).await?;
    let card = providers
        .into_iter()
        .find(|provider| provider.is_current && provider.enabled)
        .ok_or_else(|| "routing_provider_not_ready".to_string())?;
    load_provider_snapshot_for_provider(route, &card.id).await
}

async fn load_provider_snapshot_for_provider(
    route: RouteKind,
    provider_id: &str,
) -> Result<ProviderSnapshot, String> {
    let app_type = route_app_type(route);
    let detail =
        crate::provider::repository::get_provider(app_type.to_string(), provider_id.to_string())
            .await?;
    let mut keys = detail
        .keys
        .into_iter()
        .filter(|key| key.enabled)
        .collect::<Vec<_>>();
    keys.sort_by(|left, right| {
        left.sort_index
            .cmp(&right.sort_index)
            .then_with(|| left.id.cmp(&right.id))
    });
    if let Some(active_index) = keys.iter().position(|key| key.is_active) {
        let active = keys.remove(active_index);
        keys.insert(0, active);
    }
    if keys.is_empty() {
        return Err("routing_provider_key_not_active".to_string());
    }
    let provider_id = detail.card.id.clone();
    let mut candidates = Vec::with_capacity(keys.len());
    for key in keys {
        let api_key = crate::provider::repository::reveal_key(
            app_type.to_string(),
            provider_id.clone(),
            key.id.clone(),
        )
        .await?;
        candidates.push(KeyCandidate {
            id: key.id,
            api_key,
        });
    }
    let pool_id = format!("{app_type}:{provider_id}");
    let model_mappings = if app_type == "claude" {
        let config = detail
            .claude_config
            .as_ref()
            .ok_or_else(|| "provider_config_invalid".to_string())?;
        let fallback = |value: &str, fallback: &str| {
            if value.trim().is_empty() {
                fallback.to_string()
            } else {
                value.trim().to_string()
            }
        };
        let opus = fallback(&config.default_opus_model, &config.model);
        let sonnet = fallback(&config.default_sonnet_model, &config.model);
        let haiku = fallback(&config.default_haiku_model, &sonnet);
        let fable = fallback(&config.default_fable_model, &opus);
        let mut mappings = Vec::with_capacity(8);
        add_claude_model_mapping(
            &mut mappings,
            "sonnet",
            &sonnet,
            &config.default_sonnet_model_name,
        );
        add_claude_model_mapping(
            &mut mappings,
            "opus",
            &opus,
            &config.default_opus_model_name,
        );
        add_claude_model_mapping(
            &mut mappings,
            "haiku",
            &haiku,
            &config.default_haiku_model_name,
        );
        add_claude_model_mapping(
            &mut mappings,
            "fable",
            &fable,
            &config.default_fable_model_name,
        );
        mappings
    } else {
        parse_model_mappings(app_type, &detail.settings_config)?
    };
    let base_url = detail
        .card
        .base_url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "routing_provider_endpoint_missing".to_string())?;
    Ok(ProviderSnapshot {
        app_type,
        provider_id: detail.card.id,
        provider_name: detail.card.name,
        is_current: detail.card.is_current,
        base_url,
        claude_api_key_field: detail
            .claude_config
            .as_ref()
            .map(|config| config.api_key_field.clone()),
        claude_api_format: detail.claude_config.map(|config| config.api_format),
        pool_id,
        key_candidates: candidates,
        model_mappings,
        media_capability: declared_media_capability(&detail.settings_config),
        bedrock_enabled: app_type == "claude"
            && effective_bedrock_enabled(&detail.effective_settings_config),
    })
}

fn should_hot_switch_provider(
    auto_failover_enabled: bool,
    selected_provider_is_current: bool,
    status: StatusCode,
) -> bool {
    auto_failover_enabled
        && !selected_provider_is_current
        && classify_upstream_status(status) == UpstreamErrorClass::Success
}

async fn load_provider_snapshots(
    route: RouteKind,
    auto_failover_enabled: bool,
) -> Result<Vec<ProviderSnapshot>, String> {
    let app_type = route_app_type(route);
    if !auto_failover_enabled {
        return Ok(vec![load_provider_snapshot(route).await?]);
    }
    let provider_ids =
        crate::provider::routing::load_failover_provider_ids_for_daemon(app_type).await?;
    if provider_ids.is_empty() {
        return Err("routing_provider_not_ready".to_string());
    }
    log::info!(
        "routing queue order: app_type={} provider_ids={}",
        app_type,
        provider_ids.join(" -> "),
    );
    let mut snapshots = Vec::with_capacity(provider_ids.len());
    let mut last_error = None;
    for provider_id in provider_ids {
        match load_provider_snapshot_for_provider(route, &provider_id).await {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(error) => {
                log::warn!(
                    "routing candidate skipped before request: app_type={} provider_id={} reason={}",
                    app_type,
                    provider_id,
                    error,
                );
                last_error = Some(error);
            }
        }
    }
    if snapshots.is_empty() {
        return Err(last_error.unwrap_or_else(|| "routing_provider_not_ready".to_string()));
    }
    Ok(snapshots)
}

fn add_claude_model_mapping(
    mappings: &mut Vec<ModelMapping>,
    role: &str,
    target: &str,
    display_name: &str,
) {
    mappings.push(ModelMapping {
        source: role.to_string(),
        target: target.to_string(),
    });
    let display_name = display_name.trim();
    if !display_name.is_empty() && display_name != role && display_name != target {
        mappings.push(ModelMapping {
            source: display_name.to_string(),
            target: target.to_string(),
        });
        if display_name.len() > 4
            && display_name[display_name.len() - 4..].eq_ignore_ascii_case("[1m]")
        {
            let base_name = display_name[..display_name.len() - 4].trim_end();
            if !base_name.is_empty() && base_name != role && base_name != target {
                mappings.push(ModelMapping {
                    source: base_name.to_string(),
                    target: target.to_string(),
                });
            }
        }
    }
}

fn parse_model_mappings(
    app_type: &str,
    settings_config: &str,
) -> Result<Vec<ModelMapping>, String> {
    if app_type == "claude" {
        return Ok(Vec::new());
    }
    let settings = serde_json::from_str::<serde_json::Value>(settings_config)
        .map_err(|_| "provider_config_invalid".to_string())?;
    let Some(mappings) = settings
        .get("advanced")
        .and_then(|advanced| advanced.get("modelMappings"))
    else {
        return Ok(Vec::new());
    };
    let mappings = mappings
        .as_array()
        .ok_or_else(|| "provider_model_mapping_invalid".to_string())?;
    let mut result = Vec::with_capacity(mappings.len());
    let mut sources = HashSet::new();
    for mapping in mappings {
        let source = mapping
            .get("source")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "provider_model_mapping_source_required".to_string())?;
        let target = mapping
            .get("target")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "provider_model_mapping_target_required".to_string())?;
        if !sources.insert(source.to_string()) {
            return Err("provider_model_mapping_duplicate_source".to_string());
        }
        result.push(ModelMapping {
            source: source.to_string(),
            target: target.to_string(),
        });
    }
    Ok(result)
}

fn apply_model_mapping(
    request: &serde_json::Value,
    mappings: &[ModelMapping],
) -> Result<Vec<u8>, String> {
    let mut request = request.clone();
    let Some(object) = request.as_object_mut() else {
        return Err("routing_request_body_must_be_object".to_string());
    };
    let Some(model) = object.get("model").and_then(serde_json::Value::as_str) else {
        return serde_json::to_vec(&request)
            .map_err(|_| "routing_request_serialize_failed".to_string());
    };
    if let Some(mapping) = mappings.iter().find(|mapping| mapping.source == model) {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(mapping.target.clone()),
        );
    }
    serde_json::to_vec(&request).map_err(|_| "routing_request_serialize_failed".to_string())
}

fn effective_model_for_request(
    request: &serde_json::Value,
    mappings: &[ModelMapping],
) -> Option<String> {
    let model = request.get("model")?.as_str()?;
    mappings
        .iter()
        .find(|mapping| mapping.source == model)
        .map(|mapping| mapping.target.clone())
        .or_else(|| Some(model.to_string()))
}

fn should_preflight_media_fallback(
    config: &crate::provider::routing::RoutingRectifierConfig,
    capability: MediaCapability,
    model: Option<&str>,
) -> bool {
    capability == MediaCapability::TextOnly
        || (config.request_media_heuristic && model.is_some_and(is_text_only_model))
}

fn declared_media_capability(settings_config: &str) -> MediaCapability {
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(settings_config) else {
        return MediaCapability::Unknown;
    };
    if contains_explicit_text_only_declaration(&settings) {
        MediaCapability::TextOnly
    } else {
        MediaCapability::Unknown
    }
}

fn contains_explicit_text_only_declaration(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            let explicitly_text_only = object
                .get("textOnly")
                .or_else(|| object.get("text_only"))
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            let images_disabled = object
                .get("supportsImages")
                .or_else(|| object.get("supports_images"))
                .and_then(serde_json::Value::as_bool)
                == Some(false);
            let modalities_are_text_only = object
                .get("inputModalities")
                .or_else(|| object.get("input_modalities"))
                .and_then(serde_json::Value::as_array)
                .is_some_and(|modalities| {
                    !modalities.is_empty()
                        && modalities.iter().all(|modality| {
                            modality
                                .as_str()
                                .is_some_and(|value| value.eq_ignore_ascii_case("text"))
                        })
                });
            explicitly_text_only
                || images_disabled
                || modalities_are_text_only
                || object.values().any(contains_explicit_text_only_declaration)
        }
        serde_json::Value::Array(items) => {
            items.iter().any(contains_explicit_text_only_declaration)
        }
        _ => false,
    }
}

fn is_text_only_model(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    TEXT_ONLY_MODEL_IDS
        .iter()
        .any(|candidate| *candidate == normalized)
        || normalized.contains("text-only")
        || normalized.contains("text_only")
}

fn is_media_capability_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_REQUEST
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
            | StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::NOT_IMPLEMENTED
    )
}

fn is_media_capability_error(body: &[u8]) -> bool {
    let body = String::from_utf8_lossy(body).to_ascii_lowercase();
    let mentions_media = ["image", "picture", "photo", "vision", "media", "file"]
        .iter()
        .any(|term| body.contains(term));
    let rejects_media = [
        "not supported",
        "unsupported",
        "does not support",
        "cannot support",
        "can't support",
        "invalid input modality",
        "not available",
    ]
    .iter()
    .any(|term| body.contains(term));
    mentions_media && rejects_media
}

fn replace_unsupported_media(value: &mut serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(items) => {
            let mut replaced = false;
            for item in items {
                if is_media_block(item) {
                    *item = serde_json::json!({
                        "type": "text",
                        "text": UNSUPPORTED_MEDIA_PLACEHOLDER
                    });
                    replaced = true;
                } else {
                    replaced |= replace_unsupported_media(item);
                }
            }
            replaced
        }
        serde_json::Value::Object(object) => {
            let mut replaced = false;
            for item in object.values_mut() {
                if is_media_block(item) {
                    *item = serde_json::json!({
                        "type": "text",
                        "text": UNSUPPORTED_MEDIA_PLACEHOLDER
                    });
                    replaced = true;
                } else {
                    replaced |= replace_unsupported_media(item);
                }
            }
            replaced
        }
        _ => false,
    }
}

fn is_media_block(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let type_name = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .map(str::to_ascii_lowercase);
    if type_name.as_deref().is_some_and(|value| {
        matches!(
            value,
            "image"
                | "input_image"
                | "image_url"
                | "input_file"
                | "file"
                | "document"
                | "mcp_image"
                | "mcp_file"
        ) || (value.starts_with("input_") && value.contains("image"))
            || (value.starts_with("mcp_") && value.contains("image"))
            || (value.starts_with("input_") && value.contains("file"))
            || (value.starts_with("mcp_") && value.contains("file"))
    }) {
        return true;
    }
    ["image_url", "image_data", "file_data", "file_id"]
        .iter()
        .any(|key| object.contains_key(*key))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BedrockModelGeneration {
    Haiku,
    Adaptive,
    Legacy,
}

const BEDROCK_BETA: &str = "interleaved-thinking-2025-05-14";
const BEDROCK_CACHE_TTL: &str = "5m";
const MAX_BEDROCK_CACHE_BREAKPOINTS: usize = 4;

fn effective_bedrock_enabled(settings_config: &str) -> bool {
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(settings_config) else {
        return false;
    };
    settings
        .get("env")
        .and_then(serde_json::Value::as_object)
        .and_then(|env| env.get("CLAUDE_CODE_USE_BEDROCK"))
        .and_then(serde_json::Value::as_str)
        == Some("1")
}

fn bedrock_model_generation(model: Option<&str>) -> BedrockModelGeneration {
    let normalized = model.unwrap_or_default().trim().to_ascii_lowercase();
    if normalized.contains("haiku") {
        BedrockModelGeneration::Haiku
    } else if normalized.contains("claude-3-7")
        || normalized.contains("claude-3.7")
        || normalized.contains("claude-4")
        || normalized.contains("claude-sonnet-4")
        || normalized.contains("claude-opus-4")
    {
        BedrockModelGeneration::Adaptive
    } else {
        BedrockModelGeneration::Legacy
    }
}

fn apply_bedrock_optimizations(
    request: &mut serde_json::Value,
    config: &crate::provider::routing::RoutingOptimizerConfig,
    bedrock_enabled: bool,
    model: Option<&str>,
) -> bool {
    if !config.enabled || !bedrock_enabled {
        return false;
    }
    let mut adds_beta = false;
    if config.thinking_optimizer {
        match bedrock_model_generation(model) {
            BedrockModelGeneration::Haiku => {}
            BedrockModelGeneration::Adaptive => {
                set_thinking_object(request, "adaptive", None, Some("max"));
            }
            BedrockModelGeneration::Legacy => {
                if let Some(max_tokens) = request
                    .get("max_tokens")
                    .and_then(serde_json::Value::as_u64)
                    .filter(|value| *value > 0)
                {
                    set_thinking_object(
                        request,
                        "enabled",
                        Some(max_tokens.saturating_sub(1).max(1)),
                        None,
                    );
                    adds_beta = true;
                }
            }
        }
    }
    if config.cache_injection {
        inject_bedrock_cache_breakpoints(request);
    }
    adds_beta
}

fn set_thinking_object(
    request: &mut serde_json::Value,
    thinking_type: &str,
    budget_tokens: Option<u64>,
    effort: Option<&str>,
) {
    let Some(object) = request.as_object_mut() else {
        return;
    };
    let thinking = object
        .entry("thinking")
        .or_insert_with(|| serde_json::json!({}));
    let Some(thinking) = thinking.as_object_mut() else {
        *thinking = serde_json::json!({});
        let Some(thinking) = thinking.as_object_mut() else {
            return;
        };
        thinking.insert("type".to_string(), serde_json::json!(thinking_type));
        if let Some(budget_tokens) = budget_tokens {
            thinking.insert(
                "budget_tokens".to_string(),
                serde_json::json!(budget_tokens),
            );
            thinking.remove("effort");
        } else {
            thinking.remove("budget_tokens");
        }
        if let Some(effort) = effort {
            thinking.insert("effort".to_string(), serde_json::json!(effort));
        }
        return;
    };
    thinking.insert("type".to_string(), serde_json::json!(thinking_type));
    if let Some(budget_tokens) = budget_tokens {
        thinking.insert(
            "budget_tokens".to_string(),
            serde_json::json!(budget_tokens),
        );
        thinking.remove("effort");
    } else {
        thinking.remove("budget_tokens");
    }
    if let Some(effort) = effort {
        thinking.insert("effort".to_string(), serde_json::json!(effort));
    }
}

fn add_bedrock_beta_header(headers: &mut Vec<(HeaderName, HeaderValue)>) {
    if headers
        .iter()
        .any(|(name, _)| name.as_str().eq_ignore_ascii_case("anthropic-beta"))
    {
        return;
    }
    headers.push((
        HeaderName::from_static("anthropic-beta"),
        HeaderValue::from_static(BEDROCK_BETA),
    ));
}

fn inject_bedrock_cache_breakpoints(request: &mut serde_json::Value) -> bool {
    let mut remaining =
        MAX_BEDROCK_CACHE_BREAKPOINTS.saturating_sub(cache_breakpoint_count(request));
    if remaining == 0 {
        return false;
    }
    let mut changed = false;
    if let Some(tools) = request.get_mut("tools") {
        if add_cache_to_last_array_item(tools) {
            remaining -= 1;
            changed = true;
        }
    }
    if remaining > 0 {
        if let Some(system) = request.get_mut("system") {
            if add_cache_to_last_array_item(system) || add_cache_to_block(system) {
                remaining -= 1;
                changed = true;
            }
        }
    }
    if remaining > 0 {
        if let Some(messages) = request.get_mut("messages") {
            if let Some(messages) = messages.as_array_mut() {
                let latest = messages.len().checked_sub(1);
                if let Some(index) = latest {
                    if add_cache_to_message(&mut messages[index]) {
                        remaining -= 1;
                        changed = true;
                    }
                }
                if remaining > 0 {
                    if let Some(index) = messages.iter().enumerate().position(|(index, message)| {
                        message.get("role").and_then(serde_json::Value::as_str) == Some("user")
                            && Some(index) != latest
                    }) {
                        if add_cache_to_message(&mut messages[index]) {
                            changed = true;
                        }
                    }
                }
            }
        }
    }
    changed
}

fn cache_breakpoint_count(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Object(object) => {
            let current = usize::from(object.get("cache_control").is_some());
            current + object.values().map(cache_breakpoint_count).sum::<usize>()
        }
        serde_json::Value::Array(items) => items.iter().map(cache_breakpoint_count).sum(),
        _ => 0,
    }
}

fn add_cache_to_last_array_item(value: &mut serde_json::Value) -> bool {
    value
        .as_array_mut()
        .and_then(|items| items.last_mut())
        .is_some_and(add_cache_to_block)
}

fn add_cache_to_message(message: &mut serde_json::Value) -> bool {
    let Some(content) = message.get_mut("content") else {
        return false;
    };
    if let Some(items) = content.as_array_mut() {
        return items.last_mut().is_some_and(add_cache_to_block);
    }
    add_cache_to_block(content)
}

fn add_cache_to_block(value: &mut serde_json::Value) -> bool {
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    if object.contains_key("cache_control") {
        return false;
    }
    object.insert(
        "cache_control".to_string(),
        serde_json::json!({"type": "ephemeral", "ttl": BEDROCK_CACHE_TTL}),
    );
    true
}

fn is_thinking_signature_error(body: &[u8]) -> bool {
    let body = String::from_utf8_lossy(body).to_ascii_lowercase();
    body.contains("signature")
        && (body.contains("invalid")
            || body.contains("missing")
            || body.contains("extra")
            || body.contains("modified")
            || body.contains("altered"))
}

fn is_thinking_budget_error(body: &[u8]) -> bool {
    let body = String::from_utf8_lossy(body).to_ascii_lowercase();
    let mentions_budget = body.contains("budget")
        || body.contains("max_tokens")
        || body.contains("max token")
        || body.contains("thinking");
    mentions_budget
        && (body.contains("constraint")
            || body.contains("less than")
            || body.contains("must be")
            || body.contains("invalid")
            || body.contains("too small")
            || body.contains("too large"))
}

fn rectify_thinking_budget(request: &mut serde_json::Value) -> bool {
    let Some(object) = request.as_object_mut() else {
        return false;
    };
    if object
        .get("thinking")
        .and_then(serde_json::Value::as_object)
        .and_then(|thinking| thinking.get("type"))
        .and_then(serde_json::Value::as_str)
        == Some("adaptive")
    {
        return false;
    }
    match object.get_mut("thinking") {
        Some(serde_json::Value::Object(thinking)) => {
            thinking.insert("type".to_string(), serde_json::json!("enabled"));
            thinking.insert("budget_tokens".to_string(), serde_json::json!(32000));
        }
        _ => {
            object.insert(
                "thinking".to_string(),
                serde_json::json!({"type":"enabled", "budget_tokens":32000}),
            );
        }
    }
    let max_tokens_too_small = object
        .get("max_tokens")
        .and_then(serde_json::Value::as_u64)
        .is_none_or(|value| value < 64_000);
    if max_tokens_too_small {
        object.insert("max_tokens".to_string(), serde_json::json!(64_000));
    }
    true
}

fn remove_invalid_thinking_blocks(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            items.retain(|item| {
                !matches!(
                    item.get("type").and_then(serde_json::Value::as_str),
                    Some("thinking" | "redacted_thinking")
                )
            });
            for item in items {
                remove_invalid_thinking_blocks(item);
            }
        }
        serde_json::Value::Object(object) => {
            for item in object.values_mut() {
                remove_invalid_thinking_blocks(item);
            }
        }
        _ => {}
    }
}

fn upstream_url(base_url: &str, route: RouteKind, request_path: &str) -> Result<String, ()> {
    let mut url = reqwest::Url::parse(base_url.trim()).map_err(|_| ())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(());
    }
    let base_path = url.path().trim_end_matches('/');
    let route_path = if route == RouteKind::Grok {
        request_path
    } else {
        route_path(route)
    };
    let path = if route == RouteKind::Grok {
        format!("{base_path}{route_path}")
    } else if base_path.ends_with("/v1") && route_path.starts_with("/v1/") {
        format!("{base_path}{}", &route_path[3..])
    } else {
        format!("{base_path}{route_path}")
    };
    url.set_path(if path.is_empty() { "/" } else { &path });
    url.set_query(None);
    Ok(url.to_string())
}

fn classify_upstream_status(status: StatusCode) -> UpstreamErrorClass {
    match status.as_u16() {
        401 | 403 | 429 => UpstreamErrorClass::Key,
        400..=599 => UpstreamErrorClass::Provider,
        _ if status.is_success() => UpstreamErrorClass::Success,
        _ => UpstreamErrorClass::Client,
    }
}

fn capture_upstream_error_body(body: &[u8]) -> usage::UsageCapture {
    serde_json::from_slice::<serde_json::Value>(body)
        .map(|value| usage::parse_response_json(&value))
        .unwrap_or_default()
}

async fn capture_upstream_error_response(
    response: reqwest::Response,
    timeout: Duration,
) -> usage::UsageCapture {
    let read = async move {
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                break;
            };
            let remaining = MAX_ERROR_DIAGNOSTIC_BODY_BYTES.saturating_sub(body.len());
            if remaining == 0 {
                break;
            }
            let take = chunk.len().min(remaining);
            body.extend_from_slice(&chunk[..take]);
            if take < chunk.len() {
                break;
            }
        }
        capture_upstream_error_body(&body)
    };
    tokio::time::timeout(timeout, read)
        .await
        .unwrap_or_default()
}

fn record_circuit_success(
    state: &RouteState,
    permit: &mut Option<CircuitPermit>,
    policy: CircuitPolicy,
) {
    if let Some(permit) = permit.take() {
        state.circuits.record_success(permit, policy);
    }
}

fn record_circuit_failure(
    state: &RouteState,
    permit: &mut Option<CircuitPermit>,
    policy: CircuitPolicy,
) {
    if let Some(permit) = permit.take() {
        state.circuits.record_failure(permit, policy);
    }
}

fn max_attempts(max_retries: u32) -> u32 {
    max_retries.saturating_add(1)
}

fn reserve_provider_attempt(actual_attempts: &mut usize, max_attempts: usize) -> Option<usize> {
    if *actual_attempts >= max_attempts {
        return None;
    }
    let attempt_index = *actual_attempts;
    *actual_attempts = actual_attempts.saturating_add(1);
    Some(attempt_index)
}

fn stream_failure_policy(policy: CircuitPolicy) -> CircuitPolicy {
    CircuitPolicy {
        failure_threshold: 1,
        ..policy
    }
}

fn finish_stream_circuit<S>(state: &mut TimedBodyState<S>) {
    let Some(circuit) = state.circuit.take() else {
        return;
    };
    if state
        .tracker
        .as_ref()
        .is_some_and(|tracker| !tracker.settled)
    {
        log::warn!(
            "routing provider stream failure: app_type={} provider={} provider_id={} reason=incomplete_stream",
            circuit.app_type,
            circuit.provider_name,
            circuit.provider_id,
        );
        if let Some(permit) = circuit.permit {
            circuit
                .state
                .circuits
                .record_failure(permit, stream_failure_policy(circuit.policy));
        }
    } else if let Some(permit) = circuit.permit {
        circuit.state.circuits.release(permit);
    }
}

fn timed_body_stream<S>(
    stream: S,
    mode: BodyTimeoutMode,
    tracker: Option<StreamCommitTracker>,
    circuit: Option<CircuitCommit>,
    usage_collector: Option<SseUsageCollector>,
    usage_commit: Option<UsageCommit>,
) -> impl Stream<Item = Result<Frame<Bytes>, BoxError>>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
    futures_util::stream::unfold(
        Some(TimedBodyState {
            stream: Box::pin(stream),
            mode,
            tracker,
            circuit,
            usage_collector,
            usage_commit,
        }),
        |state| async move {
            let mut state = state?;
            let timeout = match state.mode {
                BodyTimeoutMode::Streaming {
                    first_byte,
                    idle,
                    received_first,
                } => {
                    if received_first {
                        idle
                    } else {
                        first_byte
                    }
                }
                BodyTimeoutMode::NonStreaming { deadline } => {
                    deadline.saturating_duration_since(Instant::now())
                }
            };
            match tokio::time::timeout(timeout, state.stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    if let BodyTimeoutMode::Streaming {
                        ref mut received_first,
                        ..
                    } = state.mode
                    {
                        *received_first |= !chunk.is_empty();
                    }
                    let outcome = state
                        .tracker
                        .as_mut()
                        .map(|tracker| tracker.observe(&chunk))
                        .unwrap_or(StreamCommitOutcome::None);
                    if let Some(collector) = state.usage_collector.as_mut() {
                        collector.observe(&chunk);
                    }
                    match outcome {
                        StreamCommitOutcome::Success => {
                            if let Some(circuit) = state.circuit.as_mut() {
                                log::info!(
                                    "routing provider stream completed: app_type={} provider={} provider_id={}",
                                    circuit.app_type,
                                    circuit.provider_name,
                                    circuit.provider_id,
                                );
                                if let Some(permit) = circuit.permit.take() {
                                    circuit
                                        .state
                                        .circuits
                                        .record_success(permit, circuit.policy);
                                }
                                if let Some(hot_switch) = circuit.hot_switch.take() {
                                    tokio::task::spawn_local(async move {
                                        if let Err(error) = crate::provider::routing::apply_hot_switch_for_active_homes(
                                            hot_switch.app_type,
                                            &hot_switch.provider_id,
                                        )
                                        .await
                                        {
                                            log::warn!("routing hot switch failed: {error}");
                                        }
                                    });
                                }
                            }
                        }
                        StreamCommitOutcome::Failure => {
                            if let Some(circuit) = state.circuit.as_mut() {
                                log::warn!(
                                    "routing provider stream failure: app_type={} provider={} provider_id={} reason=error_event",
                                    circuit.app_type,
                                    circuit.provider_name,
                                    circuit.provider_id,
                                );
                                if let Some(permit) = circuit.permit.take() {
                                    circuit.state.circuits.record_failure(
                                        permit,
                                        stream_failure_policy(circuit.policy),
                                    );
                                }
                            }
                        }
                        StreamCommitOutcome::None => {}
                    }
                    Some((
                        Ok::<Frame<Bytes>, BoxError>(Frame::data(chunk)),
                        Some(state),
                    ))
                }
                Ok(Some(Err(error))) => {
                    finish_stream_circuit(&mut state);
                    finish_usage_commit(&mut state, Some("routing_upstream_stream_error"));
                    Some((Err::<Frame<Bytes>, BoxError>(Box::new(error)), None))
                }
                Ok(None) => {
                    finish_stream_circuit(&mut state);
                    finish_usage_commit(&mut state, None);
                    None
                }
                Err(_) => {
                    finish_stream_circuit(&mut state);
                    finish_usage_commit(&mut state, Some("routing_upstream_stream_timeout"));
                    Some((
                        Err::<Frame<Bytes>, BoxError>(Box::new(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "routing_upstream_stream_timeout",
                        ))),
                        None,
                    ))
                }
            }
        },
    )
}

fn finish_usage_commit<S>(state: &mut TimedBodyState<S>, error_code: Option<&'static str>) {
    let Some(commit) = state.usage_commit.take() else {
        return;
    };
    let capture = state
        .usage_collector
        .take()
        .map(SseUsageCollector::finish)
        .unwrap_or_default();
    let error_code = error_code
        .or(commit.initial_error_code)
        .or(if capture.failed {
            Some("routing_upstream_stream_error")
        } else {
            None
        });
    let outcome = if error_code.is_some() {
        "error"
    } else {
        "success"
    };
    let duration_ms =
        crate::provider::routing::now_millis().saturating_sub(commit.context.started_at_ms);
    tokio::spawn(async move {
        usage::record_route_usage_best_effort(
            commit.context,
            capture,
            commit.status_code,
            outcome,
            error_code,
            duration_ms,
        )
        .await;
    });
}

fn is_key_retryable(status: reqwest::StatusCode) -> bool {
    classify_upstream_status(status) == UpstreamErrorClass::Key
}

fn retry_cooldown(status: u16, headers: &reqwest::header::HeaderMap) -> Duration {
    if let Some(seconds) = headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        return Duration::from_secs(seconds.min(KEY_COOLDOWN_MAX.as_secs()));
    }
    if status == 429 {
        Duration::from_secs(5)
    } else {
        KEY_COOLDOWN_DEFAULT
    }
}

fn use_claude_api_key_header(snapshot: &ProviderSnapshot) -> bool {
    snapshot.app_type == "claude"
        && snapshot
            .claude_api_format
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("anthropic"))
        && snapshot
            .claude_api_key_field
            .as_deref()
            .is_some_and(|value| value == "ANTHROPIC_API_KEY")
}

fn request_headers(request: &Request<Incoming>) -> Vec<(HeaderName, HeaderValue)> {
    request
        .headers()
        .iter()
        .filter(|(name, _)| {
            !is_hop_by_hop(name.as_str())
                && *name != HOST
                && *name != AUTHORIZATION
                && *name != HeaderName::from_static("x-api-key")
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn header_bytes(headers: &hyper::HeaderMap) -> usize {
    headers
        .iter()
        .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
        .sum()
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    ) || name.eq_ignore_ascii_case(CONNECTION.as_str())
        || name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
}

fn error_response(status: StatusCode, message: &'static str) -> Response<RouteBody> {
    let body = Full::new(Bytes::from(json!({ "error": message }).to_string()))
        .map_err(|error| match error {})
        .boxed();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header(ALLOW, "POST")
        .body(body)
        .expect("static error response is valid")
}

#[cfg(test)]
mod tests {
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
            let body =
                apply_model_mapping(&serde_json::json!({"model": model}), &mappings).unwrap();
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
            .write_all(
                b"GET /not-registered HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
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
}
