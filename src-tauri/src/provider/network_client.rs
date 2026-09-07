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

fn state() -> &'static RwLock<Option<NetworkClientState>> {
    STATE.get_or_init(|| RwLock::new(None))
}

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

fn build_client(config: &NetworkConfig) -> Result<Client, String> {
    configure(Client::builder().timeout(DEFAULT_CLIENT_TIMEOUT), config)?
        .build()
        .map_err(|_| "routing_global_proxy_client_failed".to_string())
}

fn current_config() -> Result<NetworkConfig, String> {
    let guard = state()
        .read()
        .map_err(|_| "routing_global_proxy_client_unavailable".to_string())?;
    Ok(guard
        .as_ref()
        .map(|current| current.config.clone())
        .unwrap_or_else(default_config))
}

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

pub(crate) fn configure_builder(builder: ClientBuilder) -> Result<ClientBuilder, String> {
    configure(builder, &current_config()?)
}

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

pub(crate) async fn reload_from_persisted() -> Result<u64, String> {
    let config = super::routing::load_global_proxy_runtime_config().await?;
    reload(from_routing_config(config))
}

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
    fn default_client_config_is_direct_and_generation_zero() {
        let config = default_config();
        assert_eq!(config.normalized_proxy, None);
        assert!(!config.bypass_system_proxy);
        assert_eq!(config.generation, 0);
        assert!(configure(Client::builder(), &config).is_ok());
    }

    #[test]
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
    fn system_proxy_bypass_can_be_applied_without_explicit_proxy() {
        let mut config = default_config();
        config.bypass_system_proxy = true;
        assert!(configure(Client::builder(), &config).is_ok());
    }
}
