use std::io;
use std::net::TcpListener;

use super::route_http::RouteHttpServer;

pub(crate) const FALLBACK_PORT_START: u16 = 15_721;
pub(crate) const FALLBACK_PORT_END: u16 = 15_799;
pub(crate) const MIN_PORT: u16 = 1_024;

#[derive(Debug)]
pub(crate) struct RoutingListenerLease {
    listeners: Vec<BoundListener>,
    pub(crate) actual_port: u16,
}

#[derive(Debug)]
struct BoundListener {
    address: String,
    listener: TcpListener,
}

pub(crate) struct RoutingRuntime {
    lease: Option<RoutingListenerLease>,
    http_server: Option<RouteHttpServer>,
    listen_addresses: Vec<String>,
    preferred_port: u16,
    actual_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoutingRuntimeSnapshot {
    pub(crate) status: String,
    pub(crate) listen_addresses: Vec<String>,
    pub(crate) preferred_port: u16,
    pub(crate) actual_port: Option<u16>,
}

impl RoutingRuntime {
    pub(crate) fn new() -> Self {
        Self {
            lease: None,
            http_server: None,
            listen_addresses: Vec::new(),
            preferred_port: FALLBACK_PORT_START,
            actual_port: None,
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        self.lease.is_some()
    }

    pub(crate) fn snapshot(&self) -> RoutingRuntimeSnapshot {
        RoutingRuntimeSnapshot {
            status: if self.is_running() {
                "running".to_string()
            } else {
                "stopped".to_string()
            },
            listen_addresses: self.listen_addresses.clone(),
            preferred_port: self.preferred_port,
            actual_port: self.actual_port,
        }
    }

    pub(crate) fn start(
        &mut self,
        listen_addresses: &[String],
        preferred_port: u16,
        last_actual_port: Option<u16>,
    ) -> Result<RoutingRuntimeSnapshot, String> {
        if self.is_running() {
            return Ok(self.snapshot());
        }
        let lease = PortAllocator::bind(listen_addresses, preferred_port, last_actual_port)?;
        let http_server = RouteHttpServer::start(&lease.cloned_listeners()?)?;
        self.listen_addresses = normalize_listener_addresses(listen_addresses)?;
        self.preferred_port = preferred_port;
        self.actual_port = Some(lease.actual_port);
        self.lease = Some(lease);
        self.http_server = Some(http_server);
        Ok(self.snapshot())
    }

    pub(crate) fn rebind(
        &mut self,
        listen_addresses: &[String],
        preferred_port: u16,
        last_actual_port: Option<u16>,
    ) -> Result<RoutingRuntimeSnapshot, String> {
        let normalized_addresses = normalize_listener_addresses(listen_addresses)?;
        let Some(previous) = self.lease.as_ref() else {
            return self.start(&normalized_addresses, preferred_port, last_actual_port);
        };
        let lease = PortAllocator::rebind(
            &normalized_addresses,
            preferred_port,
            last_actual_port,
            previous,
        )?;
        let state = self.http_server.as_ref().map(RouteHttpServer::shared_state);
        let http_server = RouteHttpServer::start_with_state(&lease.cloned_listeners()?, state)?;
        drop(self.http_server.take());
        self.listen_addresses = normalized_addresses;
        self.preferred_port = preferred_port;
        self.actual_port = Some(lease.actual_port);
        self.lease = Some(lease);
        self.http_server = Some(http_server);
        Ok(self.snapshot())
    }

    pub(crate) fn stop(&mut self) -> RoutingRuntimeSnapshot {
        drop(self.http_server.take());
        self.lease = None;
        self.snapshot()
    }

    pub(crate) fn circuit_snapshots(&self) -> Vec<super::circuit::CircuitSnapshot> {
        self.http_server
            .as_ref()
            .map(RouteHttpServer::circuit_snapshots)
            .unwrap_or_default()
    }

    pub(crate) fn reset_circuit(&self, app_type: &str, provider_id: &str) {
        if let Some(server) = self.http_server.as_ref() {
            server.reset_circuit(app_type, provider_id);
        }
    }
}

impl RoutingListenerLease {
    fn cloned_listeners(&self) -> Result<Vec<TcpListener>, String> {
        self.listeners
            .iter()
            .map(|bound| {
                bound
                    .listener
                    .try_clone()
                    .map_err(|_| "routing_listener_clone_failed".to_string())
            })
            .collect()
    }
}

pub(crate) struct PortAllocator;

impl PortAllocator {
    pub(crate) fn validate_addresses(listen_addresses: &[String]) -> Result<Vec<String>, String> {
        normalize_listener_addresses(listen_addresses)
    }

    pub(crate) fn bind(
        listen_addresses: &[String],
        preferred_port: u16,
        last_actual_port: Option<u16>,
    ) -> Result<RoutingListenerLease, String> {
        bind_with(
            listen_addresses,
            preferred_port,
            last_actual_port,
            |address, port| TcpListener::bind((address, port)),
        )
    }

    pub(crate) fn rebind(
        listen_addresses: &[String],
        preferred_port: u16,
        last_actual_port: Option<u16>,
        previous: &RoutingListenerLease,
    ) -> Result<RoutingListenerLease, String> {
        bind_with_reuse(
            listen_addresses,
            preferred_port,
            last_actual_port,
            previous,
            |address, port| TcpListener::bind((address, port)),
        )
    }

    #[cfg(test)]
    fn candidates(preferred_port: u16, last_actual_port: Option<u16>) -> Result<Vec<u16>, String> {
        candidate_ports(preferred_port, last_actual_port)
    }
}

fn candidate_ports(preferred_port: u16, last_actual_port: Option<u16>) -> Result<Vec<u16>, String> {
    if preferred_port < MIN_PORT {
        return Err("routing_port_invalid".to_string());
    }
    if last_actual_port.is_some_and(|port| port < MIN_PORT) {
        return Err("routing_port_invalid".to_string());
    }

    let mut candidates =
        Vec::with_capacity(2 + usize::from(FALLBACK_PORT_END - FALLBACK_PORT_START));
    let mut add = |port: u16| {
        if !candidates.contains(&port) {
            candidates.push(port);
        }
    };
    if let Some(port) = last_actual_port {
        add(port);
    }
    add(preferred_port);
    for port in FALLBACK_PORT_START..=FALLBACK_PORT_END {
        add(port);
    }
    Ok(candidates)
}

fn normalize_listener_addresses(listen_addresses: &[String]) -> Result<Vec<String>, String> {
    if listen_addresses.is_empty() {
        return Err("routing_listen_address_invalid".to_string());
    }
    let mut normalized = Vec::with_capacity(listen_addresses.len());
    for address in listen_addresses {
        let address = address.trim();
        if !matches!(address, "127.0.0.1" | "::1" | "localhost")
            && !crate::provider::routing::is_local_unicast_address(address)
        {
            return Err("routing_listen_address_invalid".to_string());
        }
        if !normalized.iter().any(|item| item == address) {
            normalized.push(address.to_string());
        }
    }
    Ok(normalized)
}

fn bind_with<F>(
    listen_addresses: &[String],
    preferred_port: u16,
    last_actual_port: Option<u16>,
    mut bind: F,
) -> Result<RoutingListenerLease, String>
where
    F: FnMut(&str, u16) -> io::Result<TcpListener>,
{
    let listen_addresses = normalize_listener_addresses(listen_addresses)?;
    let candidates = candidate_ports(preferred_port, last_actual_port)?;
    for port in candidates {
        let mut listeners = Vec::with_capacity(listen_addresses.len());
        let mut candidate_usable = true;
        for address in &listen_addresses {
            match bind(address, port) {
                Ok(listener) => listeners.push(listener),
                Err(_) => {
                    candidate_usable = false;
                    break;
                }
            }
        }
        if candidate_usable {
            return Ok(RoutingListenerLease {
                listeners: listeners
                    .into_iter()
                    .zip(listen_addresses.iter())
                    .map(|(listener, address)| BoundListener {
                        address: address.clone(),
                        listener,
                    })
                    .collect(),
                actual_port: port,
            });
        }
    }
    Err("routing_port_range_exhausted".to_string())
}

fn bind_with_reuse<F>(
    listen_addresses: &[String],
    preferred_port: u16,
    last_actual_port: Option<u16>,
    previous: &RoutingListenerLease,
    mut bind: F,
) -> Result<RoutingListenerLease, String>
where
    F: FnMut(&str, u16) -> io::Result<TcpListener>,
{
    let listen_addresses = normalize_listener_addresses(listen_addresses)?;
    let candidates = candidate_ports(preferred_port, last_actual_port)?;
    for port in candidates {
        let mut listeners = Vec::with_capacity(listen_addresses.len());
        let mut candidate_usable = true;
        for address in &listen_addresses {
            if port == previous.actual_port {
                if let Some(existing) = previous
                    .listeners
                    .iter()
                    .find(|listener| listener.address == *address)
                {
                    match existing.listener.try_clone() {
                        Ok(listener) => {
                            listeners.push(BoundListener {
                                address: address.clone(),
                                listener,
                            });
                            continue;
                        }
                        Err(_) => {
                            candidate_usable = false;
                            break;
                        }
                    }
                }
            }
            match bind(address, port) {
                Ok(listener) => listeners.push(BoundListener {
                    address: address.clone(),
                    listener,
                }),
                Err(_) => {
                    candidate_usable = false;
                    break;
                }
            }
        }
        if candidate_usable {
            return Ok(RoutingListenerLease {
                listeners,
                actual_port: port,
            });
        }
    }
    Err("routing_port_range_exhausted".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_order_is_last_actual_then_preferred_then_fallback_without_duplicates() {
        assert_eq!(
            PortAllocator::candidates(15_721, Some(15_722)).unwrap()[..4],
            [15_722, 15_721, 15_723, 15_724]
        );
        assert_eq!(
            PortAllocator::candidates(15_721, Some(15_721)).unwrap()[..3],
            [15_721, 15_722, 15_723]
        );
    }

    #[test]
    fn preferred_port_occupied_falls_back_to_next_candidate() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = occupied.local_addr().unwrap().port();
        let lease = PortAllocator::bind(&["127.0.0.1".to_string()], preferred, None).unwrap();
        assert_ne!(lease.actual_port, preferred);
    }

    #[test]
    fn invalid_port_is_rejected_before_bind() {
        assert_eq!(
            PortAllocator::bind(&["127.0.0.1".to_string()], 0, None).unwrap_err(),
            "routing_port_invalid"
        );
    }

    #[test]
    fn exhausted_candidates_return_stable_error() {
        let result = bind_with(
            &["127.0.0.1".to_string()],
            15_721,
            None,
            |_address, _port| Err(io::Error::new(io::ErrorKind::AddrInUse, "occupied")),
        );
        assert_eq!(result.unwrap_err(), "routing_port_range_exhausted");
    }

    #[test]
    fn wildcard_and_lan_addresses_are_rejected_before_bind() {
        for address in ["0.0.0.0", "::", "192.168.1.4"] {
            assert_eq!(
                PortAllocator::bind(&[address.to_string()], FALLBACK_PORT_START, None).unwrap_err(),
                "routing_listen_address_invalid"
            );
        }
    }

    #[test]
    fn stopping_keeps_actual_port_for_restart_reuse() {
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = probe.local_addr().unwrap().port();
        drop(probe);
        let mut runtime = RoutingRuntime::new();
        let running = runtime
            .start(&["127.0.0.1".to_string()], preferred, None)
            .unwrap();
        let actual = running.actual_port.expect("actual port");
        assert_eq!(runtime.stop().actual_port, Some(actual));
        assert_eq!(runtime.snapshot().actual_port, Some(actual));

        let mut restarted = RoutingRuntime::new();
        let reused = restarted
            .start(&["127.0.0.1".to_string()], preferred + 1, Some(actual))
            .unwrap();
        assert_eq!(reused.actual_port, Some(actual));
    }

    #[test]
    fn failed_rebind_keeps_old_lease_and_actual_port() {
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = probe.local_addr().unwrap().port();
        drop(probe);
        let mut runtime = RoutingRuntime::new();
        let running = runtime
            .start(&["127.0.0.1".to_string()], preferred, None)
            .unwrap();
        let actual = running.actual_port;
        let result = runtime.rebind(&["0.0.0.0".to_string()], preferred + 1, Some(preferred + 1));
        assert_eq!(result.unwrap_err(), "routing_listen_address_invalid");
        assert!(runtime.is_running());
        assert_eq!(runtime.snapshot().actual_port, actual);
    }

    #[test]
    fn rebind_reuses_unchanged_listener_on_same_actual_port() {
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = probe.local_addr().unwrap().port();
        drop(probe);
        let mut runtime = RoutingRuntime::new();
        let running = runtime
            .start(&["127.0.0.1".to_string()], preferred, None)
            .unwrap();
        let actual = running.actual_port;
        let rebound = runtime
            .rebind(
                &["127.0.0.1".to_string()],
                preferred + 1,
                Some(actual.expect("actual port")),
            )
            .unwrap();
        assert_eq!(rebound.actual_port, actual);
        assert_eq!(rebound.preferred_port, preferred + 1);
    }
}
