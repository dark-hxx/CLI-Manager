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
    // 创建尚未持有监听器和 HTTP 服务的路由运行态，首选端口使用默认回退起点。
    pub(crate) fn new() -> Self {
        Self {
            lease: None,
            http_server: None,
            listen_addresses: Vec::new(),
            preferred_port: FALLBACK_PORT_START,
            actual_port: None,
        }
    }

    // 以是否持有监听租约判断运行状态，不主动探测 HTTP 线程健康。
    pub(crate) fn is_running(&self) -> bool {
        self.lease.is_some()
    }

    // 复制运行标志、监听地址及端口配置；停止后仍可包含上一次实际端口。
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

    // 已运行时直接返回现状，否则分配监听器并启动 HTTP 服务，成功后记录配置与租约。
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

    // 先准备新租约及共享原状态的 HTTP 服务，再替换旧服务；准备失败时保留旧运行态。
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

    // 释放 HTTP 服务与监听租约，但保留地址和端口记录供状态展示及后续重启参考。
    pub(crate) fn stop(&mut self) -> RoutingRuntimeSnapshot {
        drop(self.http_server.take());
        self.lease = None;
        self.snapshot()
    }

    // 从当前 HTTP 服务获取熔断快照，未启动服务时返回空列表。
    pub(crate) fn circuit_snapshots(&self) -> Vec<super::circuit::CircuitSnapshot> {
        self.http_server
            .as_ref()
            .map(RouteHttpServer::circuit_snapshots)
            .unwrap_or_default()
    }

    // 将指定应用和供应商的熔断重置委派给 HTTP 服务，未启动时不执行操作。
    pub(crate) fn reset_circuit(&self, app_type: &str, provider_id: &str) {
        if let Some(server) = self.http_server.as_ref() {
            server.reset_circuit(app_type, provider_id);
        }
    }
}

impl RoutingListenerLease {
    // 逐个克隆底层监听器句柄供 HTTP 服务使用；任一克隆失败即返回稳定错误。
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
    // 校验并去重监听地址，复用路由分配器的统一地址规则。
    pub(crate) fn validate_addresses(listen_addresses: &[String]) -> Result<Vec<String>, String> {
        normalize_listener_addresses(listen_addresses)
    }

    // 使用真实 TCP 绑定逐个尝试候选端口，直到所有指定地址能共用一个端口。
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

    // 尝试分配新租约，同地址且同实际端口的监听器优先从旧租约克隆复用。
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
    // 向测试暴露候选端口顺序与参数校验结果，不执行绑定。
    fn candidates(preferred_port: u16, last_actual_port: Option<u16>) -> Result<Vec<u16>, String> {
        candidate_ports(preferred_port, last_actual_port)
    }
}

// 拒绝特权端口，按上次实际端口、首选端口、固定回退范围的顺序生成去重候选。
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

// 裁剪并去重地址，只接受回环名称/地址或系统枚举出的本机 IPv4 单播地址；拒绝空列表。
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

// 用可注入绑定函数尝试各候选端口；任一地址失败即释放本轮已绑定监听器并继续。
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

// 逐个候选端口复用匹配的旧监听器并绑定新增地址；本轮失败只释放新租约持有的句柄。
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
    // 验证上次实际端口优先于首选及回退端口，且重复候选只出现一次。
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
    // 占用一个临时回环端口，验证分配器改用其他候选端口。
    fn preferred_port_occupied_falls_back_to_next_candidate() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = occupied.local_addr().unwrap().port();
        let lease = PortAllocator::bind(&["127.0.0.1".to_string()], preferred, None).unwrap();
        assert_ne!(lease.actual_port, preferred);
    }

    #[test]
    // 验证端口零在创建监听器前被拒绝，并返回稳定参数错误。
    fn invalid_port_is_rejected_before_bind() {
        assert_eq!(
            PortAllocator::bind(&["127.0.0.1".to_string()], 0, None).unwrap_err(),
            "routing_port_invalid"
        );
    }

    #[test]
    // 注入始终端口占用的绑定函数，验证候选耗尽时的统一错误。
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
    // 验证通配地址及测试指定的非本机局域网地址被拒绝；该局域网断言依赖机器地址配置。
    fn wildcard_and_lan_addresses_are_rejected_before_bind() {
        for address in ["0.0.0.0", "::", "192.168.1.4"] {
            assert_eq!(
                PortAllocator::bind(&[address.to_string()], FALLBACK_PORT_START, None).unwrap_err(),
                "routing_listen_address_invalid"
            );
        }
    }

    #[test]
    // 用回环监听验证停止保留实际端口，并能在新运行态中优先复用该端口。
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
    // 以非法监听地址触发重绑定失败，验证旧租约及实际端口不变。
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
    // 验证相同地址重绑定时复用旧实际端口，同时更新记录中的首选端口。
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
