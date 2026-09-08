mod forwarding;
use forwarding::forward_request;

use super::circuit::{CircuitPermit, CircuitPolicy, CircuitRegistry, CircuitSnapshot};
use crate::usage::{self, RouteUsageContext, SseUsageCollector};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderName, HeaderValue, ALLOW, CONTENT_TYPE, HOST};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use reqwest::header::{AUTHORIZATION, CONNECTION, CONTENT_LENGTH};
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
    buffer: Vec<u8>,
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
            buffer: Vec::new(),
            settled: false,
        }
    }

    fn observe(&mut self, chunk: &Bytes) -> StreamCommitOutcome {
        if self.settled {
            return StreamCommitOutcome::None;
        }
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > MAX_ERROR_DIAGNOSTIC_BODY_BYTES {
            let excess = self.buffer.len() - MAX_ERROR_DIAGNOSTIC_BODY_BYTES;
            self.buffer.drain(..excess);
        }
        while let Some((end, delimiter_len)) = sse_byte_boundary(&self.buffer) {
            let event = String::from_utf8_lossy(&self.buffer[..end]).into_owned();
            self.buffer.drain(..end + delimiter_len);
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

fn sse_byte_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|end| (end, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|end| (end, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
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
        if let Some(base_name) = display_name.strip_suffix("[1m]") {
            let base_name = base_name.trim_end();
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
mod tests;
