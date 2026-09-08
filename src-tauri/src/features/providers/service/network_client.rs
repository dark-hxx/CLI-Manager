use super::routing::RoutingGlobalProxyRuntimeConfig;
use reqwest::{Client, ClientBuilder, Proxy};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

const DEFAULT_CLIENT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetworkConfig {
    pub normalized_proxy: Option<String>,
    pub credential_ref: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub bypass_system_proxy: bool,
    pub generation: u64,
}

struct NetworkClientState {
    config: NetworkConfig,
    client: Client,
}

static STATE: OnceLock<RwLock<Option<NetworkClientState>>> = OnceLock::new();

// 惰性初始化共享网络状态锁，初始没有客户端或已加载配置。
fn state() -> &'static RwLock<Option<NetworkClientState>> {
    STATE.get_or_init(|| RwLock::new(None))
}

// 返回零代次、无显式代理及凭据的默认配置；不绕过系统代理，并非强制直连。
fn default_config() -> NetworkConfig {
    NetworkConfig {
        normalized_proxy: None,
        credential_ref: None,
        username: None,
        password: None,
        bypass_system_proxy: false,
        generation: 0,
    }
}

// 有显式代理时应用全协议代理及成对认证信息，否则按标志决定是否禁用系统代理。
fn configure(builder: ClientBuilder, config: &NetworkConfig) -> Result<ClientBuilder, String> {
    let Some(proxy_url) = config.normalized_proxy.as_deref() else {
        return Ok(if config.bypass_system_proxy {
            builder.no_proxy()
        } else {
            builder
        });
    };
    let mut proxy = Proxy::all(proxy_url).map_err(|_| "routing_proxy_url_invalid".to_string())?;
    if let (Some(username), Some(password)) = (&config.username, &config.password) {
        proxy = proxy.basic_auth(username, password);
    }
    Ok(builder.proxy(proxy))
}

// 按配置构造默认 30 秒超时的客户端，将构建失败映射为稳定错误。
fn build_client(config: &NetworkConfig) -> Result<Client, String> {
    configure(Client::builder().timeout(DEFAULT_CLIENT_TIMEOUT), config)?
        .build()
        .map_err(|_| "routing_global_proxy_client_failed".to_string())
}

// 在读锁下复制当前配置，未初始化时返回默认值；锁中毒返回错误。
fn current_config() -> Result<NetworkConfig, String> {
    let guard = state()
        .read()
        .map_err(|_| "routing_global_proxy_client_unavailable".to_string())?;
    Ok(guard
        .as_ref()
        .map(|current| current.config.clone())
        .unwrap_or_else(default_config))
}

// 克隆缓存客户端，缺省时构建并以双重检查写入；锁中毒仍取内部状态，构建失败回退 Client::new。
pub(crate) fn current_client() -> Client {
    {
        let guard = state()
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(current) = guard.as_ref() {
            return current.client.clone();
        }
    }

    let config = default_config();
    let client = build_client(&config).unwrap_or_else(|_| Client::new());
    let mut guard = state()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(current) = guard.as_ref() {
        return current.client.clone();
    }
    *guard = Some(NetworkClientState {
        config,
        client: client.clone(),
    });
    client
}

// 把当前内存代理配置应用到调用方 builder，不加载持久化设置或统一覆盖其超时。
pub(crate) fn configure_builder(builder: ClientBuilder) -> Result<ClientBuilder, String> {
    configure(builder, &current_config()?)
}

// 先构建客户端，再持写锁替换配置与缓存，代次按旧值饱和递增；既有客户端克隆不被更新。
pub(crate) fn reload(config: NetworkConfig) -> Result<u64, String> {
    let client = build_client(&config)?;
    let mut guard = state()
        .write()
        .map_err(|_| "routing_global_proxy_client_unavailable".to_string())?;
    let generation = guard
        .as_ref()
        .map(|current| current.config.generation.saturating_add(1))
        .unwrap_or(1);
    let mut config = config;
    config.generation = generation;
    *guard = Some(NetworkClientState { config, client });
    Ok(generation)
}

// 转换已解析的路由代理配置并将代次置零，实际代次由 reload 分配。
fn from_routing_config(config: RoutingGlobalProxyRuntimeConfig) -> NetworkConfig {
    NetworkConfig {
        normalized_proxy: config.url,
        credential_ref: config.credential_ref,
        username: config.username,
        password: config.password,
        bypass_system_proxy: config.bypass_system_proxy,
        generation: 0,
    }
}

// 异步读取持久化全局代理运行配置，再构建并替换共享客户端；错误直接传播。
pub(crate) async fn reload_from_persisted() -> Result<u64, String> {
    let config = super::routing::load_global_proxy_runtime_config().await?;
    reload(from_routing_config(config))
}

// 缓存存在则直接克隆，否则加载持久化配置；并发首次调用可能分别触发重载。
pub(crate) async fn current_client_from_persisted() -> Result<Client, String> {
    {
        let guard = state()
            .read()
            .map_err(|_| "routing_global_proxy_client_unavailable".to_string())?;
        if let Some(current) = guard.as_ref() {
            return Ok(current.client.clone());
        }
    }
    reload_from_persisted().await?;
    Ok(current_client())
}

#[cfg(test)]
mod tests {
    use super::{configure, default_config, reload, NetworkConfig};
    use reqwest::Client;

    #[test]
    // 验证默认无显式代理、未绕过系统代理且代次为零；不发请求证明实际直连。
    fn default_client_config_is_direct_and_generation_zero() {
        let config = default_config();
        assert_eq!(config.normalized_proxy, None);
        assert!(!config.bypass_system_proxy);
        assert_eq!(config.generation, 0);
        assert!(configure(Client::builder(), &config).is_ok());
    }

    #[test]
    // 在测试进程重载默认配置，验证正代次及空凭据字段；未使用真实凭据或验证网络传输。
    fn reload_increments_generation_without_exposing_credentials() {
        let generation = reload(default_config()).unwrap();
        assert!(generation >= 1);
        let config = super::current_config().unwrap();
        assert_eq!(config.normalized_proxy, None);
        assert_eq!(config.credential_ref, None);
        assert_eq!(config.username, None);
        assert_eq!(config.password, None);
    }

    #[test]
    // 验证显式代理与 bypass 标志同时存在时 builder 配置可成功，不发起代理连接。
    fn system_proxy_bypass_is_ignored_when_explicit_proxy_is_configured() {
        let config = NetworkConfig {
            normalized_proxy: Some("http://proxy.example:8080".to_string()),
            credential_ref: None,
            username: None,
            password: None,
            bypass_system_proxy: true,
            generation: 0,
        };
        assert!(configure(Client::builder(), &config).is_ok());
    }

    #[test]
    // 验证没有显式代理时可配置绕过系统代理，仅检查 builder 构造结果。
    fn system_proxy_bypass_can_be_applied_without_explicit_proxy() {
        let mut config = default_config();
        config.bypass_system_proxy = true;
        assert!(configure(Client::builder(), &config).is_ok());
    }
}
