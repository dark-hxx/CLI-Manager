use crate::daemon::client::{DaemonBridge, DaemonClient};
use crate::daemon::protocol::{
    ensure_local_routing_capability, routing_control_id, ClientFrame, DaemonFrame,
    RoutingCircuitStatus, RoutingError, RoutingEvent, RoutingStatus,
};
use crate::provider::global::{
    self, GlobalApplyInput, GlobalPreviewInput, HomeIdentityInput, LocalRouteProjection,
};
use crate::provider::home::{self, HomeSelectInput};
use crate::provider::repository::normalize_app_type;
use crate::provider::routing::{
    self, RoutingFailoverConfig, RoutingFailoverState, RoutingGlobalProxyInput,
    RoutingGlobalProxyState, RoutingGlobalProxyTestInput, RoutingGlobalProxyTestResult,
    RoutingOptimizerConfig, RoutingPersistedState, RoutingProxyScanCandidate,
    RoutingRectifierConfig, RoutingServiceConfig, TakeoverKey,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::net::Ipv4Addr;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingQuickControlsInput {
    pub show_local_quick_control: bool,
    pub show_failover_quick_control: bool,
    pub usage_logging_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingTakeoverInput {
    pub app_type: String,
    pub home_identity: crate::provider::home::HomeIdentity,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingFailoverQueueInput {
    pub app_type: String,
    pub provider_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingFailoverConfigInput {
    pub app_type: String,
    pub config: RoutingFailoverConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDaemonState {
    pub status: String,
    pub connected: bool,
    pub capability_supported: bool,
    pub error: Option<RoutingError>,
    pub listener_addresses: Vec<String>,
    pub preferred_port: Option<u16>,
    pub actual_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingState {
    pub persisted: RoutingPersistedState,
    pub daemon: RoutingDaemonState,
}

fn command_error(code: &str, hint: &str) -> RoutingError {
    RoutingError {
        code: code.to_string(),
        params: BTreeMap::new(),
        hint: hint.to_string(),
    }
}

fn map_input_error(error: String) -> RoutingError {
    let code = error.split(':').next().unwrap_or("routing_input_invalid");
    command_error(code, "fix_input")
}

fn map_persistence_error(error: String) -> RoutingError {
    let code = error
        .split(':')
        .next()
        .unwrap_or("routing_persistence_failed");
    command_error(code, "retry_or_restart_daemon")
}

fn sanitize_runtime_status(kind: &str) -> String {
    match kind {
        "running" | "stopped" | "degraded" | "recovering" => kind.to_string(),
        _ => "unknown".to_string(),
    }
}

fn daemon_state(client: Option<Arc<DaemonClient>>) -> RoutingDaemonState {
    let Some(client) = client else {
        return RoutingDaemonState {
            status: "unavailable".to_string(),
            connected: false,
            capability_supported: false,
            error: Some(RoutingError::service_unavailable()),
            listener_addresses: Vec::new(),
            preferred_port: None,
            actual_port: None,
        };
    };
    if let Err(error) = ensure_local_routing_capability(&client.info().features) {
        return RoutingDaemonState {
            status: "unsupported".to_string(),
            connected: true,
            capability_supported: false,
            error: Some(error),
            listener_addresses: Vec::new(),
            preferred_port: None,
            actual_port: None,
        };
    }

    let id = client.next_request_id();
    match client.request(id, &ClientFrame::RoutingStatus { id }) {
        Ok(DaemonFrame::RoutingEvent { event }) => routing_event_state(event),
        Ok(DaemonFrame::Err { .. }) | Err(_) => RoutingDaemonState {
            status: "unavailable".to_string(),
            connected: true,
            capability_supported: true,
            error: Some(RoutingError::service_unavailable()),
            listener_addresses: Vec::new(),
            preferred_port: None,
            actual_port: None,
        },
        Ok(_) => RoutingDaemonState {
            status: "unknown".to_string(),
            connected: true,
            capability_supported: true,
            error: Some(command_error(
                "routing_daemon_response_invalid",
                "restart_daemon",
            )),
            listener_addresses: Vec::new(),
            preferred_port: None,
            actual_port: None,
        },
    }
}

fn routing_event_state(event: RoutingEvent) -> RoutingDaemonState {
    let status = event
        .error
        .as_ref()
        .map(|_| "unavailable".to_string())
        .unwrap_or_else(|| sanitize_runtime_status(&event.kind));
    RoutingDaemonState {
        status,
        connected: true,
        capability_supported: true,
        error: event.error,
        listener_addresses: event
            .status
            .as_ref()
            .map(|status| status.listener_addresses.clone())
            .unwrap_or_default(),
        preferred_port: event.status.as_ref().map(|status| status.preferred_port),
        actual_port: event.status.and_then(|status| status.actual_port),
    }
}

fn routing_status(event: RoutingEvent) -> Result<RoutingStatus, RoutingError> {
    event
        .status
        .ok_or_else(|| command_error("routing_daemon_response_invalid", "restart_daemon"))
}

fn local_route_endpoint(address: &str, port: u16) -> Result<String, RoutingError> {
    let host = match address.trim() {
        "127.0.0.1" | "localhost" => address.trim().to_string(),
        "::1" => "[::1]".to_string(),
        _ => return Err(command_error("routing_listen_address_invalid", "fix_input")),
    };
    if port < 1_024 {
        return Err(command_error("routing_port_invalid", "fix_input"));
    }
    Ok(format!("http://{host}:{port}"))
}

fn route_endpoint(address: &str, endpoint_mode: &str, port: u16) -> Result<String, RoutingError> {
    if endpoint_mode == "wsl_gateway" {
        let host = address
            .parse::<Ipv4Addr>()
            .map_err(|_| command_error("routing_wsl_gateway_invalid", "fix_input"))?;
        if host.is_unspecified() || host.is_loopback() || port < 1_024 {
            return Err(command_error("routing_wsl_gateway_invalid", "fix_input"));
        }
        return Ok(format!("http://{host}:{port}"));
    }
    local_route_endpoint(address, port)
}

fn add_listener_address(addresses: &mut Vec<String>, address: String) {
    if !addresses.iter().any(|item| item == &address) {
        addresses.push(address);
    }
}

fn persisted_listener_addresses(
    persisted: &RoutingPersistedState,
) -> Result<Vec<String>, RoutingError> {
    let mut addresses = vec![persisted.service.listen_address.clone()];
    for item in &persisted.takeovers {
        if item.home_identity.environment_kind != "wsl" {
            continue;
        }
        match item.endpoint_mode.as_str() {
            "wsl_mirrored" => add_listener_address(&mut addresses, "127.0.0.1".to_string()),
            "wsl_gateway" => {
                let gateway = routing::resolve_wsl_nat_gateway(&item.home_identity.environment_id)
                    .map_err(map_input_error)?;
                if gateway.address.to_string() != item.advertised_host {
                    return Err(command_error(
                        "routing_wsl_gateway_changed",
                        "reload_home_preferences",
                    ));
                }
                add_listener_address(&mut addresses, gateway.address.to_string());
            }
            _ => {}
        }
    }
    Ok(addresses)
}

fn reload_routing_listeners(
    client: Arc<DaemonClient>,
    status: &RoutingStatus,
    listener_addresses: Vec<String>,
) -> Result<RoutingStatus, RoutingError> {
    routing_status(request_control(
        Some(client.clone()),
        ClientFrame::RoutingReload {
            id: client.next_request_id(),
            listen_address: None,
            preferred_port: Some(status.preferred_port),
            last_actual_port: status.actual_port,
            listener_addresses,
        },
    )?)
}

fn restore_routing_listeners(
    client: Arc<DaemonClient>,
    status: &RoutingStatus,
    previous_listener_addresses: &[String],
    changed: bool,
) {
    if changed {
        let _ = reload_routing_listeners(client, status, previous_listener_addresses.to_vec());
    }
}

fn block_on<T>(future: impl Future<Output = Result<T, String>>) -> Result<T, RoutingError> {
    tauri::async_runtime::block_on(future).map_err(map_persistence_error)
}

fn state(client: Option<Arc<DaemonClient>>) -> Result<RoutingState, RoutingError> {
    let persisted = block_on(routing::load_persisted_state())?;
    Ok(RoutingState {
        persisted,
        daemon: daemon_state(client),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RoutingServiceRuntimeAction {
    None,
    Start,
    Stop,
}

fn routing_service_runtime_action(
    service_enabled: bool,
    daemon_status: &str,
) -> RoutingServiceRuntimeAction {
    match (service_enabled, daemon_status == "running") {
        (true, false) => RoutingServiceRuntimeAction::Start,
        (false, true) => RoutingServiceRuntimeAction::Stop,
        _ => RoutingServiceRuntimeAction::None,
    }
}

fn routing_service_needs_update(
    persisted_enabled: bool,
    requested_enabled: bool,
    daemon_status: &str,
) -> bool {
    persisted_enabled != requested_enabled
        || routing_service_runtime_action(requested_enabled, daemon_status)
            != RoutingServiceRuntimeAction::None
}

fn routing_service_control_frame(
    id: u64,
    enabled: bool,
    service: &RoutingServiceConfig,
    listener_addresses: Vec<String>,
) -> ClientFrame {
    if enabled {
        ClientFrame::RoutingStart {
            id,
            listen_address: Some(service.listen_address.clone()),
            preferred_port: Some(service.preferred_port),
            last_actual_port: service.actual_port,
            listener_addresses,
        }
    } else {
        ClientFrame::RoutingStop { id }
    }
}

fn set_service_enabled_with_client(
    client: Option<Arc<DaemonClient>>,
    mut persisted: RoutingPersistedState,
    enabled: bool,
) -> Result<RoutingState, RoutingError> {
    let current_daemon = daemon_state(client.clone());
    let runtime_action = routing_service_runtime_action(enabled, &current_daemon.status);
    if !routing_service_needs_update(
        persisted.service.service_enabled,
        enabled,
        &current_daemon.status,
    ) {
        return Ok(RoutingState {
            persisted,
            daemon: current_daemon,
        });
    }

    if runtime_action == RoutingServiceRuntimeAction::None {
        persisted.service.service_enabled = enabled;
        block_on(routing::save_service_config(&persisted.service))?;
        return Ok(RoutingState {
            persisted,
            daemon: current_daemon,
        });
    }

    let client_ref = client
        .as_ref()
        .ok_or_else(RoutingError::service_unavailable)?;
    let listener_addresses = if enabled {
        persisted_listener_addresses(&persisted)?
    } else if current_daemon.listener_addresses.is_empty() {
        vec![persisted.service.listen_address.clone()]
    } else {
        current_daemon.listener_addresses.clone()
    };
    let event = request_control(
        client.clone(),
        routing_service_control_frame(
            client_ref.next_request_id(),
            enabled,
            &persisted.service,
            listener_addresses.clone(),
        ),
    )?;
    let previous_service = persisted.service.clone();
    if enabled {
        let status = routing_status(event)?;
        persisted.service.actual_port = status.actual_port;
    }
    persisted.service.service_enabled = enabled;
    if let Err(error) = block_on(routing::save_service_config(&persisted.service)) {
        let rollback_frame = routing_service_control_frame(
            client_ref.next_request_id(),
            !enabled,
            &previous_service,
            listener_addresses,
        );
        let _ = request_control(client, rollback_frame);
        return Err(error);
    }
    Ok(RoutingState {
        persisted,
        daemon: daemon_state(client),
    })
}

pub(crate) fn reconcile_persisted_service(
    client: Arc<DaemonClient>,
) -> Result<RoutingState, RoutingError> {
    let persisted = block_on(routing::load_persisted_state())?;
    let service_enabled = persisted.service.service_enabled;
    set_service_enabled_with_client(Some(client), persisted, service_enabled)
}

fn request_control(
    client: Option<Arc<DaemonClient>>,
    frame: ClientFrame,
) -> Result<RoutingEvent, RoutingError> {
    let Some(client) = client else {
        return Err(RoutingError::service_unavailable());
    };
    ensure_local_routing_capability(&client.info().features)?;
    let id = routing_control_id(&frame)
        .ok_or_else(|| command_error("routing_daemon_request_invalid", "restart_daemon"))?;
    match client.request(id, &frame) {
        Ok(DaemonFrame::RoutingEvent { event }) => {
            if let Some(error) = event.error.clone() {
                Err(error)
            } else {
                Ok(event)
            }
        }
        Ok(DaemonFrame::Err { .. }) | Err(_) => Err(RoutingError::service_unavailable()),
        Ok(_) => Err(command_error(
            "routing_daemon_response_invalid",
            "restart_daemon",
        )),
    }
}

fn reset_all_daemon_circuits(
    client: Arc<DaemonClient>,
    app_type: &str,
) -> Result<(), RoutingError> {
    let event = request_control(
        Some(client.clone()),
        ClientFrame::RoutingResetCircuit {
            id: client.next_request_id(),
            app_type: app_type.to_string(),
            provider_id: String::new(),
        },
    )?;
    let _ = routing_status(event)?;
    Ok(())
}

fn merge_daemon_circuits(
    mut state: RoutingFailoverState,
    client: Option<Arc<DaemonClient>>,
    app_type: &str,
) -> RoutingFailoverState {
    let Some(client) = client else {
        return state;
    };
    let Ok(event) = request_control(
        Some(client.clone()),
        ClientFrame::RoutingStatus {
            id: client.next_request_id(),
        },
    ) else {
        return state;
    };
    let Ok(status) = routing_status(event) else {
        return state;
    };
    state.circuits = status
        .circuit_states
        .into_iter()
        .filter(|circuit| circuit.app_type == app_type)
        .map(circuit_state_from_daemon)
        .collect();
    if let Some(current_id) = state
        .providers
        .iter()
        .find(|provider| provider.is_current)
        .map(|provider| provider.id.as_str())
    {
        if let Some(current) = state
            .circuits
            .iter()
            .find(|circuit| circuit.provider_id == current_id)
        {
            state.circuit = current.clone();
        }
    }
    state
}

fn circuit_state_from_daemon(
    circuit: RoutingCircuitStatus,
) -> crate::provider::routing::RoutingCircuitState {
    crate::provider::routing::RoutingCircuitState {
        provider_id: circuit.provider_id,
        status: circuit.status,
        consecutive_failures: circuit.consecutive_failures,
        successful_probes: circuit.successful_probes,
    }
}

#[tauri::command]
pub fn routing_get_state(
    daemon_bridge: State<'_, DaemonBridge>,
) -> Result<RoutingState, RoutingError> {
    state(daemon_bridge.get())
}

#[tauri::command]
pub fn routing_get_failover_queue(
    daemon_bridge: State<'_, DaemonBridge>,
    app_type: String,
) -> Result<RoutingFailoverState, RoutingError> {
    let state = block_on(routing::load_failover_state(&app_type))?;
    Ok(merge_daemon_circuits(state, daemon_bridge.get(), &app_type))
}

#[tauri::command]
pub fn routing_set_failover_enabled(
    daemon_bridge: State<'_, DaemonBridge>,
    app_type: String,
    enabled: bool,
) -> Result<RoutingFailoverState, RoutingError> {
    let app_type = routing::normalize_routing_app_type(&app_type).map_err(map_input_error)?;
    let client = daemon_bridge.get();
    if let Some(client) = client.clone() {
        reset_all_daemon_circuits(client, &app_type)?;
    }
    let state = block_on(routing::set_failover_enabled(&app_type, enabled))?;
    Ok(merge_daemon_circuits(state, client, &app_type))
}

#[tauri::command]
pub fn routing_set_failover_queue(
    input: RoutingFailoverQueueInput,
) -> Result<RoutingFailoverState, RoutingError> {
    block_on(routing::set_failover_queue_and_load(
        &input.app_type,
        &input.provider_ids,
    ))
}

#[tauri::command]
pub fn routing_update_failover_config(
    input: RoutingFailoverConfigInput,
) -> Result<RoutingFailoverState, RoutingError> {
    block_on(async move {
        let current = routing::load_failover_state(&input.app_type).await?;
        if input.config.auto_failover_enabled != current.config.auto_failover_enabled {
            return Err("routing_failover_toggle_required".to_string());
        }
        routing::save_failover_config(&input.app_type, &input.config).await?;
        routing::load_failover_state(&input.app_type).await
    })
}

#[tauri::command]
pub fn routing_get_global_proxy() -> Result<RoutingGlobalProxyState, RoutingError> {
    block_on(routing::load_global_proxy())
}

#[tauri::command]
pub fn routing_set_global_proxy(
    input: RoutingGlobalProxyInput,
) -> Result<RoutingGlobalProxyState, RoutingError> {
    block_on(routing::save_global_proxy(input))
}

#[tauri::command]
pub fn routing_scan_global_proxy() -> Result<Vec<RoutingProxyScanCandidate>, RoutingError> {
    routing::scan_global_proxy().map_err(map_persistence_error)
}

#[tauri::command]
pub fn routing_test_global_proxy(
    input: RoutingGlobalProxyTestInput,
) -> Result<RoutingGlobalProxyTestResult, RoutingError> {
    block_on(routing::test_global_proxy(input))
}

#[tauri::command]
pub fn routing_get_rectifier_config() -> Result<RoutingRectifierConfig, RoutingError> {
    block_on(routing::load_rectifier_config())
}

#[tauri::command]
pub fn routing_set_rectifier_config(
    config: RoutingRectifierConfig,
) -> Result<RoutingRectifierConfig, RoutingError> {
    block_on(async move {
        routing::save_rectifier_config(&config).await?;
        routing::load_rectifier_config().await
    })
}

#[tauri::command]
pub fn routing_get_optimizer_config() -> Result<RoutingOptimizerConfig, RoutingError> {
    block_on(routing::load_optimizer_config())
}

#[tauri::command]
pub fn routing_set_optimizer_config(
    config: RoutingOptimizerConfig,
) -> Result<RoutingOptimizerConfig, RoutingError> {
    block_on(async move {
        routing::save_optimizer_config(&config).await?;
        routing::load_optimizer_config().await
    })
}

#[tauri::command]
pub fn routing_reset_circuit(
    daemon_bridge: State<'_, DaemonBridge>,
    app_type: String,
) -> Result<RoutingFailoverState, RoutingError> {
    let state = block_on(routing::load_failover_state(&app_type))?;
    let app_type = state.app_type.clone();
    let first_provider_id = state
        .providers
        .iter()
        .filter(|provider| provider.in_failover_queue && provider.ready)
        .min_by_key(|provider| provider.sort_index)
        .map(|provider| provider.id.clone());
    let client = daemon_bridge
        .get()
        .ok_or_else(RoutingError::service_unavailable)?;
    reset_all_daemon_circuits(client.clone(), &app_type)?;
    if let Some(first_provider_id) = first_provider_id {
        let current_provider_id = block_on(routing::current_provider_id(&app_type))?;
        if current_provider_id != first_provider_id {
            block_on(routing::apply_hot_switch_for_active_homes(
                &app_type,
                &first_provider_id,
            ))?;
        }
    }
    Ok(merge_daemon_circuits(state, Some(client), &app_type))
}

#[tauri::command]
pub fn routing_set_service_enabled(
    daemon_bridge: State<'_, DaemonBridge>,
    enabled: bool,
) -> Result<RoutingState, RoutingError> {
    let client = daemon_bridge.get();
    let persisted = block_on(routing::load_persisted_state())?;
    set_service_enabled_with_client(client, persisted, enabled)
}

#[tauri::command]
pub fn routing_set_preferred_port(
    daemon_bridge: State<'_, DaemonBridge>,
    port: u16,
) -> Result<RoutingState, RoutingError> {
    let client = daemon_bridge.get();
    let mut persisted = block_on(routing::load_persisted_state())?;
    if persisted.service.preferred_port == port {
        return Ok(RoutingState {
            persisted,
            daemon: daemon_state(client),
        });
    }
    if persisted.service.service_enabled {
        return Err(command_error(
            "routing_port_change_requires_service_disabled",
            "disable_local_routing_first",
        ));
    }
    if !persisted.takeovers.is_empty() {
        return Err(command_error(
            "routing_port_change_requires_takeover_disabled",
            "disable_takeover_first",
        ));
    }
    persisted.service.preferred_port = port;
    routing::validate_service_config(&persisted.service).map_err(|error| {
        let code = error.split(':').next().unwrap_or("routing_port_invalid");
        command_error(code, "fix_input")
    })?;
    block_on(routing::save_service_config(&persisted.service))?;
    Ok(RoutingState {
        persisted,
        daemon: daemon_state(client),
    })
}

#[tauri::command]
pub fn routing_set_quick_controls(
    daemon_bridge: State<'_, DaemonBridge>,
    input: RoutingQuickControlsInput,
) -> Result<RoutingState, RoutingError> {
    let client = daemon_bridge.get();
    let mut persisted = block_on(routing::load_persisted_state())?;
    persisted.service.show_local_quick_control = input.show_local_quick_control;
    persisted.service.show_failover_quick_control = input.show_failover_quick_control;
    persisted.service.usage_logging_enabled = input.usage_logging_enabled;
    block_on(routing::save_service_config(&persisted.service))?;
    Ok(RoutingState {
        persisted,
        daemon: daemon_state(client),
    })
}

#[tauri::command]
pub fn routing_set_takeover(
    daemon_bridge: State<'_, DaemonBridge>,
    input: RoutingTakeoverInput,
) -> Result<RoutingState, RoutingError> {
    let app_type = normalize_app_type(&input.app_type)
        .map_err(|_| command_error("routing_app_type_invalid", "fix_input"))?;
    let home = tauri::async_runtime::block_on(home::get(HomeSelectInput {
        environment_kind: input.home_identity.environment_kind.clone(),
        environment_id: Some(input.home_identity.environment_id.clone()),
        mode: "auto".to_string(),
        home_path: None,
    }))
    .map_err(map_input_error)?;
    if home.identity != input.home_identity {
        return Err(command_error(
            "routing_home_identity_mismatch",
            "reload_home_preferences",
        ));
    }
    let _key: TakeoverKey =
        routing::takeover_key(&app_type, &home.identity).map_err(map_input_error)?;
    if input.enabled {
        tauri::async_runtime::block_on(routing::ensure_current_provider_ready(&app_type))
            .map_err(map_input_error)?;
    }

    let client = daemon_bridge
        .get()
        .ok_or_else(RoutingError::service_unavailable)?;
    ensure_local_routing_capability(&client.info().features)?;

    if !matches!(
        input.home_identity.environment_kind.as_str(),
        "local" | "wsl"
    ) {
        return Err(command_error(
            "routing_home_environment_unsupported",
            "use_windows_local_or_wsl_home",
        ));
    }
    let persisted = block_on(routing::load_persisted_state())?;
    let current_provider_id = block_on(routing::current_provider_id(&app_type))?;
    let existing = persisted
        .takeovers
        .iter()
        .find(|item| item.app_type == app_type && item.home_identity == home.identity)
        .cloned();
    if !input.enabled {
        let failover = block_on(routing::load_failover_state(&app_type))?;
        if failover.config.auto_failover_enabled {
            block_on(routing::set_failover_enabled(&app_type, false))?;
        }
    }
    if !input.enabled && existing.is_none() {
        return state(Some(client));
    }

    let mut status = routing_status(request_control(
        Some(client.clone()),
        ClientFrame::RoutingStatus {
            id: client.next_request_id(),
        },
    )?)?;
    if input.enabled && status.status != "running" {
        return Err(RoutingError::service_unavailable());
    }
    let previous_listener_addresses = status.listener_addresses.clone();
    let mut actual_port = status.actual_port.or_else(|| {
        (!input.enabled)
            .then(|| existing.as_ref().map(|item| item.applied_port))
            .flatten()
    });
    let mut listeners_changed = false;
    let (endpoint_host, endpoint_mode) = if input.enabled && home.identity.environment_kind == "wsl"
    {
        let mut listener_addresses = persisted_listener_addresses(&persisted)?;
        add_listener_address(&mut listener_addresses, "127.0.0.1".to_string());
        status = match reload_routing_listeners(client.clone(), &status, listener_addresses.clone())
        {
            Ok(status) => {
                listeners_changed = status.listener_addresses != previous_listener_addresses;
                status
            }
            Err(error) => return Err(error),
        };
        let port = match status.actual_port {
            Some(port) => {
                actual_port = Some(port);
                port
            }
            None => {
                let _ = reload_routing_listeners(
                    client.clone(),
                    &status,
                    previous_listener_addresses.clone(),
                );
                return Err(RoutingError::service_unavailable());
            }
        };
        let mirrored_probe = routing::probe_wsl_mirrored(&home.identity.environment_id, port)
            .map_err(map_input_error);
        if mirrored_probe.is_ok() {
            ("127.0.0.1".to_string(), "wsl_mirrored")
        } else {
            let gateway = match routing::resolve_wsl_nat_gateway(&home.identity.environment_id) {
                Ok(gateway) => gateway,
                Err(error) => {
                    let _ = reload_routing_listeners(
                        client.clone(),
                        &status,
                        previous_listener_addresses.clone(),
                    );
                    return Err(map_input_error(error));
                }
            };
            add_listener_address(&mut listener_addresses, gateway.address.to_string());
            status = match reload_routing_listeners(client.clone(), &status, listener_addresses) {
                Ok(status) => {
                    listeners_changed = status.listener_addresses != previous_listener_addresses;
                    status
                }
                Err(error) => {
                    let _ = reload_routing_listeners(
                        client.clone(),
                        &status,
                        previous_listener_addresses.clone(),
                    );
                    return Err(error);
                }
            };
            let port = match status.actual_port {
                Some(port) => {
                    actual_port = Some(port);
                    port
                }
                None => {
                    let _ = reload_routing_listeners(
                        client.clone(),
                        &status,
                        previous_listener_addresses.clone(),
                    );
                    return Err(RoutingError::service_unavailable());
                }
            };
            if let Err(error) =
                routing::probe_wsl_gateway(&home.identity.environment_id, gateway.address, port)
            {
                let _ = reload_routing_listeners(
                    client.clone(),
                    &status,
                    previous_listener_addresses.clone(),
                );
                return Err(map_input_error(error));
            }
            (gateway.address.to_string(), "wsl_gateway")
        }
    } else if !input.enabled {
        let existing = existing
            .as_ref()
            .ok_or_else(|| RoutingError::service_unavailable())?;
        (
            existing.advertised_host.clone(),
            existing.endpoint_mode.as_str(),
        )
    } else {
        (persisted.service.listen_address.clone(), "loopback")
    };
    let actual_port = match actual_port {
        Some(port) => port,
        None => {
            restore_routing_listeners(
                client.clone(),
                &status,
                &previous_listener_addresses,
                listeners_changed,
            );
            return Err(RoutingError::service_unavailable());
        }
    };
    let endpoint = match route_endpoint(&endpoint_host, endpoint_mode, actual_port) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            restore_routing_listeners(
                client.clone(),
                &status,
                &previous_listener_addresses,
                listeners_changed,
            );
            return Err(error);
        }
    };
    let identity_input = HomeIdentityInput {
        environment_kind: home.identity.environment_kind.clone(),
        environment_id: Some(home.identity.environment_id.clone()),
    };
    let projection = LocalRouteProjection {
        endpoint: endpoint.clone(),
    };
    let preview_input = GlobalPreviewInput {
        app_type: app_type.clone(),
        provider_id: current_provider_id.clone(),
        home_identity: identity_input.clone(),
        projection: input.enabled.then(|| projection.clone()),
    };
    let preview = match block_on(global::preview(preview_input)) {
        Ok(preview) => preview,
        Err(error) => {
            restore_routing_listeners(
                client.clone(),
                &status,
                &previous_listener_addresses,
                listeners_changed,
            );
            return Err(error);
        }
    };
    let apply_input = GlobalApplyInput {
        app_type: app_type.clone(),
        provider_id: current_provider_id.clone(),
        home_identity: identity_input,
        preview_fingerprint: preview.fingerprint,
        projection: input.enabled.then_some(projection.clone()),
    };
    if let Err(error) = block_on(global::apply(apply_input)) {
        restore_routing_listeners(
            client.clone(),
            &status,
            &previous_listener_addresses,
            listeners_changed,
        );
        return Err(error);
    }

    let mut takeovers = persisted.takeovers;
    takeovers.retain(|item| !(item.app_type == app_type && item.home_identity == home.identity));
    if input.enabled {
        takeovers.push(routing::RoutingTakeoverItem {
            app_type: app_type.clone(),
            home_identity: home.identity.clone(),
            endpoint_mode: endpoint_mode.to_string(),
            advertised_host: endpoint_host,
            applied_port: actual_port,
        });
    }
    if let Err(error) = block_on(routing::save_takeovers(&takeovers)) {
        let rollback_projection = (!input.enabled).then_some(projection);
        let rollback_preview = GlobalPreviewInput {
            app_type: app_type.clone(),
            provider_id: current_provider_id.clone(),
            home_identity: HomeIdentityInput {
                environment_kind: home.identity.environment_kind.clone(),
                environment_id: Some(home.identity.environment_id.clone()),
            },
            projection: rollback_projection.clone(),
        };
        if let Ok(preview) = block_on(global::preview(rollback_preview)) {
            let _ = block_on(global::apply(GlobalApplyInput {
                app_type,
                provider_id: current_provider_id,
                home_identity: HomeIdentityInput {
                    environment_kind: home.identity.environment_kind,
                    environment_id: Some(home.identity.environment_id),
                },
                preview_fingerprint: preview.fingerprint,
                projection: rollback_projection,
            }));
        }
        restore_routing_listeners(
            client,
            &status,
            &previous_listener_addresses,
            listeners_changed,
        );
        return Err(error);
    }
    state(Some(client))
}

#[cfg(test)]
mod tests {
    use super::{
        routing_service_control_frame, routing_service_needs_update,
        routing_service_runtime_action, RoutingServiceRuntimeAction,
    };
    use crate::daemon::protocol::ClientFrame;
    use crate::provider::routing::RoutingServiceConfig;

    fn service_config() -> RoutingServiceConfig {
        RoutingServiceConfig {
            schema_version: 1,
            service_enabled: true,
            listen_address: "127.0.0.1".to_string(),
            preferred_port: 15_721,
            actual_port: Some(15_722),
            show_local_quick_control: true,
            show_failover_quick_control: true,
            usage_logging_enabled: true,
        }
    }

    #[test]
    fn persisted_service_intent_drives_runtime_reconciliation() {
        assert_eq!(
            routing_service_runtime_action(true, "stopped"),
            RoutingServiceRuntimeAction::Start
        );
        assert_eq!(
            routing_service_runtime_action(true, "running"),
            RoutingServiceRuntimeAction::None
        );
        assert_eq!(
            routing_service_runtime_action(false, "running"),
            RoutingServiceRuntimeAction::Stop
        );
        assert_eq!(
            routing_service_runtime_action(false, "stopped"),
            RoutingServiceRuntimeAction::None
        );

        assert!(routing_service_needs_update(false, true, "running"));
        assert!(routing_service_needs_update(true, false, "stopped"));
        assert!(!routing_service_needs_update(true, true, "running"));
        assert!(!routing_service_needs_update(false, false, "stopped"));
    }

    #[test]
    fn routing_start_frame_preserves_listener_and_port_state() {
        let listeners = vec!["127.0.0.1".to_string(), "172.20.0.1".to_string()];
        let frame = routing_service_control_frame(7, true, &service_config(), listeners.clone());
        assert_eq!(
            frame,
            ClientFrame::RoutingStart {
                id: 7,
                listen_address: Some("127.0.0.1".to_string()),
                preferred_port: Some(15_721),
                last_actual_port: Some(15_722),
                listener_addresses: listeners,
            }
        );
    }
}
