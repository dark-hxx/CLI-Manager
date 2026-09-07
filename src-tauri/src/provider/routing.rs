use crate::provider::database;
use crate::provider::home::HomeIdentity;
use crate::provider::repository::{
    list_failover_providers, meta_enabled, normalize_app_type, parse_meta, set_failover_queue,
};
use crate::{shell_resolver, wsl};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows_sys::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
#[cfg(windows)]
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_INCLUDE_PREFIX, IP_ADAPTER_ADDRESSES_LH,
};
#[cfg(windows)]
use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

pub(crate) const SERVICE_SETTINGS_KEY: &str = "routing.service.v1";
pub(crate) const TAKEOVERS_SETTINGS_KEY: &str = "routing.takeovers.v1";
pub(crate) const RECTIFIER_SETTINGS_KEY: &str = "routing.rectifier.v1";
pub(crate) const OPTIMIZER_SETTINGS_KEY: &str = "routing.optimizer.v1";
const FAILOVER_SETTINGS_PREFIX: &str = "routing.app.";
#[allow(dead_code)]
pub(crate) const DEFAULT_LISTEN_ADDRESS: &str = "127.0.0.1";
#[allow(dead_code)]
pub(crate) const DEFAULT_PREFERRED_PORT: u16 = 15_721;
const MIN_PORT: u16 = 1_024;
#[allow(dead_code)]
const ROUTING_LOG_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
#[allow(dead_code)]
const ROUTING_LOG_MAX_ROWS: i64 = 100_000;
const WSL_MIRRORED_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const WSL_PROBE_CACHE_TTL: Duration = Duration::from_millis(1_500);

#[derive(Debug, Clone)]
struct WslProbeCacheEntry {
    host: String,
    port: u16,
    checked_at: Instant,
}

static WSL_PROBE_CACHE: OnceLock<Mutex<HashMap<String, WslProbeCacheEntry>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingServiceConfig {
    pub schema_version: u32,
    pub service_enabled: bool,
    pub listen_address: String,
    pub preferred_port: u16,
    pub actual_port: Option<u16>,
    pub show_local_quick_control: bool,
    pub show_failover_quick_control: bool,
    pub usage_logging_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingTakeoverItem {
    pub app_type: String,
    pub home_identity: HomeIdentity,
    pub endpoint_mode: String,
    pub advertised_host: String,
    pub applied_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingTakeoversDocument {
    pub schema_version: u32,
    pub items: Vec<RoutingTakeoverItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct TakeoverKey {
    pub app_type: String,
    pub home_identity: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingPersistedState {
    pub service: RoutingServiceConfig,
    pub takeovers: Vec<RoutingTakeoverItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingFailoverConfig {
    pub schema_version: u32,
    pub auto_failover_enabled: bool,
    pub max_retries: u32,
    pub streaming_first_byte_timeout: u64,
    pub streaming_idle_timeout: u64,
    pub non_streaming_timeout: u64,
    pub circuit_failure_threshold: u32,
    pub circuit_success_threshold: u32,
    pub circuit_timeout_seconds: u64,
    pub circuit_error_rate_threshold: f64,
    pub circuit_min_requests: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingFailoverProvider {
    pub id: String,
    pub name: String,
    pub sort_index: i64,
    pub is_current: bool,
    pub enabled: bool,
    pub ready: bool,
    pub in_failover_queue: bool,
    pub key_count: i64,
    pub active_key_present: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingCircuitState {
    pub provider_id: String,
    pub status: String,
    pub consecutive_failures: u32,
    pub successful_probes: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingFailoverState {
    pub app_type: String,
    pub config: RoutingFailoverConfig,
    pub providers: Vec<RoutingFailoverProvider>,
    pub circuit: RoutingCircuitState,
    pub circuits: Vec<RoutingCircuitState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingRectifierConfig {
    pub schema_version: u32,
    pub enabled: bool,
    pub request_thinking_signature: bool,
    pub request_thinking_budget: bool,
    pub request_media_fallback: bool,
    pub request_media_heuristic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingOptimizerConfig {
    pub schema_version: u32,
    pub enabled: bool,
    pub thinking_optimizer: bool,
    pub cache_injection: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum RoutingRectifierRule {
    ThinkingSignature,
    ThinkingBudget,
    MediaFallback,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RoutingRetryContext {
    thinking_signature_used: bool,
    thinking_budget_used: bool,
    media_fallback_used: bool,
}

impl RoutingRetryContext {
    pub(crate) fn can_retry(
        &self,
        config: &RoutingRectifierConfig,
        rule: RoutingRectifierRule,
    ) -> bool {
        if !config.enabled {
            return false;
        }
        match rule {
            RoutingRectifierRule::ThinkingSignature => {
                config.request_thinking_signature && !self.thinking_signature_used
            }
            RoutingRectifierRule::ThinkingBudget => {
                config.request_thinking_budget && !self.thinking_budget_used
            }
            RoutingRectifierRule::MediaFallback => {
                config.request_media_fallback && !self.media_fallback_used
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) fn mark_used(&mut self, rule: RoutingRectifierRule) {
        match rule {
            RoutingRectifierRule::ThinkingSignature => self.thinking_signature_used = true,
            RoutingRectifierRule::ThinkingBudget => self.thinking_budget_used = true,
            RoutingRectifierRule::MediaFallback => self.media_fallback_used = true,
        }
    }
}

pub(crate) const GLOBAL_PROXY_SETTINGS_KEY: &str = "routing.global_proxy.v1";
const GLOBAL_PROXY_CREDENTIAL_ACCOUNT: &str = "routing-global-proxy-password";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RoutingGlobalProxyStored {
    schema_version: u32,
    url: Option<String>,
    username: Option<String>,
    password_credential_account: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RoutingGlobalProxyRuntimeConfig {
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub credential_ref: Option<String>,
    pub bypass_system_proxy: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingGlobalProxyState {
    pub schema_version: u32,
    pub url: Option<String>,
    pub username: Option<String>,
    pub has_password: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingGlobalProxyInput {
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub clear_password: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingGlobalProxyTestInput {
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingProxyScanCandidate {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingGlobalProxyTestResult {
    pub endpoint: String,
}

const GLOBAL_PROXY_SCAN_PORTS: [u16; 8] =
    [7_890, 7_891, 1_080, 8_080, 8_888, 3_128, 10_808, 10_809];
const GLOBAL_PROXY_SCAN_TIMEOUT: Duration = Duration::from_millis(250);
const GLOBAL_PROXY_TEST_TIMEOUT: Duration = Duration::from_secs(5);
const GLOBAL_PROXY_TEST_ENDPOINTS: [&str; 3] = [
    "https://httpbin.org/get",
    "https://www.google.com/generate_204",
    "https://api.anthropic.com/",
];

fn failover_settings_key(app_type: &str) -> String {
    format!("{FAILOVER_SETTINGS_PREFIX}{app_type}.v1")
}

fn default_circuit_state() -> RoutingCircuitState {
    RoutingCircuitState {
        provider_id: String::new(),
        status: "closed".to_string(),
        consecutive_failures: 0,
        successful_probes: 0,
    }
}

fn validate_failover_config(config: &RoutingFailoverConfig) -> Result<(), String> {
    if config.schema_version != 1
        || config.max_retries > 32
        || config.streaming_first_byte_timeout == 0
        || config.streaming_idle_timeout == 0
        || config.non_streaming_timeout == 0
        || config.circuit_failure_threshold == 0
        || config.circuit_success_threshold == 0
        || config.circuit_timeout_seconds == 0
        || !(0.0..=1.0).contains(&config.circuit_error_rate_threshold)
        || config.circuit_min_requests == 0
    {
        return Err("routing_failover_config_invalid".to_string());
    }
    Ok(())
}

fn validate_rectifier_config(config: &RoutingRectifierConfig) -> Result<(), String> {
    if config.schema_version != 1 {
        return Err("routing_rectifier_config_invalid".to_string());
    }
    Ok(())
}

fn validate_optimizer_config(config: &RoutingOptimizerConfig) -> Result<(), String> {
    if config.schema_version != 1 {
        return Err("routing_optimizer_config_invalid".to_string());
    }
    Ok(())
}

pub(crate) async fn load_rectifier_config() -> Result<RoutingRectifierConfig, String> {
    let mut connection = database::open_connection().await?;
    let raw = load_setting(&mut connection, RECTIFIER_SETTINGS_KEY).await?;
    let config = serde_json::from_str::<RoutingRectifierConfig>(&raw)
        .map_err(|_| format!("routing_settings_invalid:{RECTIFIER_SETTINGS_KEY}"))?;
    validate_rectifier_config(&config)?;
    Ok(config)
}

pub(crate) async fn save_rectifier_config(config: &RoutingRectifierConfig) -> Result<(), String> {
    validate_rectifier_config(config)?;
    let mut connection = database::open_connection().await?;
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(serialize_json(config, RECTIFIER_SETTINGS_KEY)?)
        .bind(RECTIFIER_SETTINGS_KEY)
        .execute(&mut connection)
        .await
        .map_err(|_| "routing_rectifier_config_write_failed".to_string())?;
    if result.rows_affected() != 1 {
        return Err(format!("routing_settings_missing:{RECTIFIER_SETTINGS_KEY}"));
    }
    Ok(())
}

pub(crate) async fn load_optimizer_config() -> Result<RoutingOptimizerConfig, String> {
    let mut connection = database::open_connection().await?;
    let raw = load_setting(&mut connection, OPTIMIZER_SETTINGS_KEY).await?;
    let config = serde_json::from_str::<RoutingOptimizerConfig>(&raw)
        .map_err(|_| format!("routing_settings_invalid:{OPTIMIZER_SETTINGS_KEY}"))?;
    validate_optimizer_config(&config)?;
    Ok(config)
}

pub(crate) async fn save_optimizer_config(config: &RoutingOptimizerConfig) -> Result<(), String> {
    validate_optimizer_config(config)?;
    let mut connection = database::open_connection().await?;
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(serialize_json(config, OPTIMIZER_SETTINGS_KEY)?)
        .bind(OPTIMIZER_SETTINGS_KEY)
        .execute(&mut connection)
        .await
        .map_err(|_| "routing_optimizer_config_write_failed".to_string())?;
    if result.rows_affected() != 1 {
        return Err(format!("routing_settings_missing:{OPTIMIZER_SETTINGS_KEY}"));
    }
    Ok(())
}

async fn load_failover_config(
    connection: &mut SqliteConnection,
    app_type: &str,
) -> Result<RoutingFailoverConfig, String> {
    let key = failover_settings_key(app_type);
    let raw = load_setting(connection, &key).await?;
    let config = serde_json::from_str::<RoutingFailoverConfig>(&raw)
        .map_err(|_| format!("routing_settings_invalid:{key}"))?;
    validate_failover_config(&config)?;
    Ok(config)
}

pub(crate) async fn load_failover_config_for_daemon(
    app_type: &str,
) -> Result<RoutingFailoverConfig, String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let mut connection = database::open_connection().await?;
    load_failover_config(&mut connection, &app_type).await
}

pub(crate) async fn save_failover_config(
    app_type: &str,
    config: &RoutingFailoverConfig,
) -> Result<(), String> {
    let app_type = normalize_routing_app_type(app_type)?;
    validate_failover_config(config)?;
    let key = failover_settings_key(&app_type);
    let mut connection = database::open_connection().await?;
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(serialize_json(config, &key)?)
        .bind(&key)
        .execute(&mut connection)
        .await
        .map_err(|_| "routing_failover_config_write_failed".to_string())?;
    if result.rows_affected() != 1 {
        return Err(format!("routing_settings_missing:{key}"));
    }
    Ok(())
}

fn parse_global_proxy_stored(raw: &str) -> Result<RoutingGlobalProxyStored, String> {
    let config = serde_json::from_str::<RoutingGlobalProxyStored>(raw)
        .map_err(|_| format!("routing_settings_invalid:{GLOBAL_PROXY_SETTINGS_KEY}"))?;
    if config.schema_version != 1
        || config.password_credential_account != GLOBAL_PROXY_CREDENTIAL_ACCOUNT
    {
        return Err(format!(
            "routing_settings_invalid:{GLOBAL_PROXY_SETTINGS_KEY}"
        ));
    }
    Ok(config)
}

async fn load_global_proxy_stored(
    connection: &mut SqliteConnection,
) -> Result<RoutingGlobalProxyStored, String> {
    let raw = load_setting(connection, GLOBAL_PROXY_SETTINGS_KEY).await?;
    parse_global_proxy_stored(&raw)
}

pub(crate) async fn load_global_proxy_runtime_config(
) -> Result<RoutingGlobalProxyRuntimeConfig, String> {
    let mut connection = database::open_connection().await?;
    let config = load_global_proxy_stored(&mut connection).await?;
    let password = if config.url.is_some() {
        read_global_proxy_password()?
    } else {
        None
    };
    drop(connection);
    let persisted = load_persisted_state().await?;
    Ok(RoutingGlobalProxyRuntimeConfig {
        url: config.url,
        username: config.username,
        password,
        credential_ref: Some(config.password_credential_account),
        bypass_system_proxy: system_proxy_should_bypass(&persisted),
    })
}

fn global_proxy_state(
    config: RoutingGlobalProxyStored,
    has_password: bool,
) -> RoutingGlobalProxyState {
    RoutingGlobalProxyState {
        schema_version: config.schema_version,
        url: config.url,
        username: config.username,
        has_password,
    }
}

pub(crate) fn normalize_global_proxy_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let url = reqwest::Url::parse(raw).map_err(|_| "routing_proxy_url_invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
        || url.host_str().is_none()
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("routing_proxy_url_invalid".to_string());
    }
    Ok(Some(url.to_string()))
}

fn normalize_global_proxy_username(raw: Option<String>) -> Option<String> {
    raw.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn global_proxy_matches_endpoint(
    host: &str,
    port: u16,
    advertised_host: &str,
    advertised_port: u16,
) -> bool {
    fn loopback_alias(value: &str) -> bool {
        let value = value.trim().trim_matches(['[', ']']).to_ascii_lowercase();
        matches!(value.as_str(), "localhost" | "127.0.0.1" | "::1")
    }

    port == advertised_port
        && ((loopback_alias(host) && loopback_alias(advertised_host))
            || host.eq_ignore_ascii_case(advertised_host))
}

const SYSTEM_PROXY_ENV_VARS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

fn proxy_endpoint(raw_url: &str) -> Option<(String, u16)> {
    let url = reqwest::Url::parse(raw_url.trim()).ok()?;
    let host = url.host_str()?.to_string();
    let port = url.port().or_else(|| match url.scheme() {
        "http" => Some(80),
        "https" => Some(443),
        "socks5" | "socks5h" => Some(1080),
        _ => None,
    })?;
    Some((host, port))
}

fn proxy_matches_persisted_state(raw_url: Option<&str>, persisted: &RoutingPersistedState) -> bool {
    let Some(raw_url) = raw_url else {
        return false;
    };
    let Some((host, port)) = proxy_endpoint(raw_url) else {
        return false;
    };
    persisted.service.actual_port.is_some_and(|actual_port| {
        global_proxy_matches_endpoint(&host, port, &persisted.service.listen_address, actual_port)
    }) || persisted.takeovers.iter().any(|takeover| {
        global_proxy_matches_endpoint(
            &host,
            port,
            &takeover.advertised_host,
            takeover.applied_port,
        )
    })
}

fn system_proxy_should_bypass(persisted: &RoutingPersistedState) -> bool {
    SYSTEM_PROXY_ENV_VARS.iter().any(|name| {
        std::env::var(name)
            .ok()
            .is_some_and(|value| proxy_matches_persisted_state(Some(&value), persisted))
    })
}

fn validate_global_proxy_for_state(
    raw_url: Option<&str>,
    persisted: &RoutingPersistedState,
) -> Result<(), String> {
    let Some(url) = normalize_global_proxy_url(raw_url)? else {
        return Ok(());
    };
    if proxy_matches_persisted_state(Some(&url), persisted) {
        return Err("routing_proxy_self_loop".to_string());
    }
    Ok(())
}

pub(crate) async fn validate_global_proxy_not_self_loop(
    raw_url: Option<&str>,
) -> Result<(), String> {
    let persisted = load_persisted_state().await?;
    validate_global_proxy_for_state(raw_url, &persisted)
}

fn read_global_proxy_password() -> Result<Option<String>, String> {
    crate::credential_store::get(GLOBAL_PROXY_CREDENTIAL_ACCOUNT)
        .map_err(|_| "routing_proxy_credential_read_failed".to_string())
}

fn write_global_proxy_password(password: Option<&str>) -> Result<(), String> {
    match password {
        Some(password) => crate::credential_store::set(GLOBAL_PROXY_CREDENTIAL_ACCOUNT, password)
            .map_err(|_| "routing_proxy_credential_write_failed".to_string()),
        None => crate::credential_store::delete(GLOBAL_PROXY_CREDENTIAL_ACCOUNT)
            .map_err(|_| "routing_proxy_credential_delete_failed".to_string()),
    }
}

async fn write_global_proxy_stored(
    connection: &mut SqliteConnection,
    config: &RoutingGlobalProxyStored,
) -> Result<(), String> {
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(serialize_json(config, GLOBAL_PROXY_SETTINGS_KEY)?)
        .bind(GLOBAL_PROXY_SETTINGS_KEY)
        .execute(&mut *connection)
        .await
        .map_err(|_| "routing_global_proxy_write_failed".to_string())?;
    if result.rows_affected() != 1 {
        return Err(format!(
            "routing_settings_missing:{GLOBAL_PROXY_SETTINGS_KEY}"
        ));
    }
    Ok(())
}

pub(crate) async fn load_global_proxy() -> Result<RoutingGlobalProxyState, String> {
    let mut connection = database::open_connection().await?;
    let config = load_global_proxy_stored(&mut connection).await?;
    let password = read_global_proxy_password()?;
    Ok(global_proxy_state(config, password.is_some()))
}

pub(crate) async fn save_global_proxy(
    input: RoutingGlobalProxyInput,
) -> Result<RoutingGlobalProxyState, String> {
    if input.clear_password
        && input
            .password
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    {
        return Err("routing_proxy_password_input_conflict".to_string());
    }
    let url = normalize_global_proxy_url(input.url.as_deref())?;
    validate_global_proxy_not_self_loop(input.url.as_deref()).await?;
    let username = normalize_global_proxy_username(input.username);
    let mut connection = database::open_connection().await?;
    let previous = load_global_proxy_stored(&mut connection).await?;
    let previous_password = read_global_proxy_password()?;
    let password_update = if input.clear_password {
        None
    } else if input
        .password
        .as_deref()
        .is_some_and(|password| !password.is_empty())
    {
        input.password.as_deref()
    } else {
        previous_password.as_deref()
    };
    let changed_password = input.clear_password
        || input
            .password
            .as_deref()
            .is_some_and(|value| !value.is_empty());

    if changed_password {
        write_global_proxy_password(password_update)?;
    }

    let next = RoutingGlobalProxyStored {
        schema_version: 1,
        url,
        username,
        password_credential_account: GLOBAL_PROXY_CREDENTIAL_ACCOUNT.to_string(),
    };
    if let Err(error) = write_global_proxy_stored(&mut connection, &next).await {
        if changed_password {
            let restore_result = write_global_proxy_password(previous_password.as_deref());
            if restore_result.is_err() {
                return Err("routing_global_proxy_recovery_required".to_string());
            }
        }
        return Err(error);
    }
    if let Err(error) = super::network_client::reload_from_persisted().await {
        let database_restore = write_global_proxy_stored(&mut connection, &previous).await;
        let credential_restore = if changed_password {
            write_global_proxy_password(previous_password.as_deref())
        } else {
            Ok(())
        };
        if database_restore.is_err() || credential_restore.is_err() {
            return Err("routing_global_proxy_recovery_required".to_string());
        }
        return Err(error);
    }
    let has_password = if changed_password {
        password_update.is_some()
    } else {
        previous_password.is_some()
    };
    drop(previous);
    Ok(global_proxy_state(next, has_password))
}

pub(crate) fn scan_global_proxy() -> Result<Vec<RoutingProxyScanCandidate>, String> {
    let mut candidates = Vec::new();
    for port in GLOBAL_PROXY_SCAN_PORTS {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if std::net::TcpStream::connect_timeout(&address, GLOBAL_PROXY_SCAN_TIMEOUT).is_ok() {
            candidates.push(RoutingProxyScanCandidate {
                host: "127.0.0.1".to_string(),
                port,
            });
        }
    }
    Ok(candidates)
}

pub(crate) async fn test_global_proxy(
    input: RoutingGlobalProxyTestInput,
) -> Result<RoutingGlobalProxyTestResult, String> {
    let mut connection = database::open_connection().await?;
    let stored = load_global_proxy_stored(&mut connection).await?;
    let url = normalize_global_proxy_url(input.url.as_deref().or(stored.url.as_deref()))?
        .ok_or_else(|| "routing_proxy_url_required".to_string())?;
    drop(connection);
    validate_global_proxy_not_self_loop(Some(&url)).await?;
    let username = normalize_global_proxy_username(input.username).or(stored.username);
    let password = if input
        .password
        .as_deref()
        .is_some_and(|password| !password.is_empty())
    {
        input.password
    } else {
        read_global_proxy_password()?
    };
    let mut proxy =
        reqwest::Proxy::all(&url).map_err(|_| "routing_proxy_url_invalid".to_string())?;
    if let (Some(username), Some(password)) = (username, password) {
        proxy = proxy.basic_auth(&username, &password);
    }
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(GLOBAL_PROXY_TEST_TIMEOUT)
        .build()
        .map_err(|_| "routing_proxy_test_client_failed".to_string())?;
    let test = async {
        for endpoint in GLOBAL_PROXY_TEST_ENDPOINTS {
            if let Ok(response) = client.get(endpoint).send().await {
                if response.status().as_u16() == 407 {
                    continue;
                }
                return Ok(RoutingGlobalProxyTestResult {
                    endpoint: endpoint.to_string(),
                });
            }
        }
        Err("routing_proxy_test_failed".to_string())
    };
    tokio::time::timeout(GLOBAL_PROXY_TEST_TIMEOUT, test)
        .await
        .unwrap_or_else(|_| Err("routing_proxy_test_failed".to_string()))
}

pub(crate) async fn load_failover_state(app_type: &str) -> Result<RoutingFailoverState, String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let mut connection = database::open_connection().await?;
    let config = load_failover_config(&mut connection, &app_type).await?;
    drop(connection);
    let providers = list_failover_providers(&app_type)
        .await?
        .into_iter()
        .map(|provider| RoutingFailoverProvider {
            id: provider.card.id,
            name: provider.card.name,
            sort_index: provider.card.sort_index,
            is_current: provider.card.is_current,
            enabled: provider.card.enabled,
            ready: provider.ready,
            in_failover_queue: provider.in_failover_queue,
            key_count: provider.card.key_count,
            active_key_present: provider.card.active_key_label.is_some(),
        })
        .collect();
    Ok(RoutingFailoverState {
        app_type,
        config,
        providers,
        circuit: default_circuit_state(),
        circuits: Vec::new(),
    })
}

pub(crate) async fn load_failover_provider_ids_for_daemon(
    app_type: &str,
) -> Result<Vec<String>, String> {
    let state = load_failover_state(app_type).await?;
    let mut provider_ids = eligible_failover_provider_ids(&state.providers);
    let current_id = state
        .providers
        .iter()
        .find(|provider| provider.is_current && provider.in_failover_queue && provider.ready)
        .map(|provider| provider.id.as_str());
    prioritize_current_provider(&mut provider_ids, current_id);
    Ok(provider_ids)
}

fn eligible_failover_provider_ids(providers: &[RoutingFailoverProvider]) -> Vec<String> {
    providers
        .iter()
        .filter(|provider| provider.in_failover_queue && provider.ready)
        .map(|provider| provider.id.clone())
        .collect()
}

fn prioritize_current_provider(provider_ids: &mut Vec<String>, current_id: Option<&str>) {
    let Some(current_id) = current_id else {
        return;
    };
    if let Some(index) = provider_ids.iter().position(|id| id == current_id) {
        let current = provider_ids.remove(index);
        provider_ids.insert(0, current);
    }
}

fn should_seed_failover_queue(enabled: bool, previous_ids: &[String]) -> bool {
    enabled && previous_ids.is_empty()
}

pub(crate) async fn set_failover_enabled(
    app_type: &str,
    enabled: bool,
) -> Result<RoutingFailoverState, String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let mut connection = database::open_connection().await?;
    let mut config = load_failover_config(&mut connection, &app_type).await?;
    drop(connection);
    let previous = load_failover_state(&app_type).await?;
    let previous_ids: Vec<String> = previous
        .providers
        .iter()
        .filter(|provider| provider.in_failover_queue)
        .map(|provider| provider.id.clone())
        .collect();

    if enabled {
        let persisted = load_persisted_state().await?;
        if !persisted
            .takeovers
            .iter()
            .any(|takeover| takeover.app_type == app_type)
        {
            return Err("routing_failover_requires_takeover".to_string());
        }
        ensure_current_provider_ready(&app_type).await?;
        if should_seed_failover_queue(enabled, &previous_ids) {
            let current_id = current_provider_id(&app_type).await?;
            set_failover_queue(&app_type, std::slice::from_ref(&current_id)).await?;
        }
    }
    config.auto_failover_enabled = enabled;
    if let Err(error) = save_failover_config(&app_type, &config).await {
        if should_seed_failover_queue(enabled, &previous_ids) {
            let _ = set_failover_queue(&app_type, &previous_ids).await;
        }
        return Err(error);
    }
    load_failover_state(&app_type).await
}

pub(crate) async fn set_failover_queue_and_load(
    app_type: &str,
    provider_ids: &[String],
) -> Result<RoutingFailoverState, String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let current = load_failover_state(&app_type).await?;
    if current.config.auto_failover_enabled && provider_ids.is_empty() {
        return Err("routing_failover_queue_empty".to_string());
    }
    if !current.config.auto_failover_enabled && provider_ids.len() != 1 {
        return Err("routing_failover_manual_queue_single".to_string());
    }
    let previous_provider_id = if current.config.auto_failover_enabled {
        None
    } else {
        Some(current_provider_id(&app_type).await?)
    };
    set_failover_queue(&app_type, provider_ids).await?;
    if let Some(previous_provider_id) = previous_provider_id {
        let next_provider_id = provider_ids[0].trim();
        if next_provider_id != previous_provider_id {
            if let Err(error) = apply_hot_switch_for_active_homes(&app_type, next_provider_id).await
            {
                let _ = set_failover_queue(&app_type, &[previous_provider_id]);
                return Err(error);
            }
        }
    }
    load_failover_state(&app_type).await
}

pub(crate) async fn load_persisted_state() -> Result<RoutingPersistedState, String> {
    let mut connection = database::open_connection().await?;
    let service = load_service_config(&mut connection).await?;
    let takeovers = load_takeovers(&mut connection).await?;
    Ok(RoutingPersistedState { service, takeovers })
}

pub(crate) async fn apply_hot_switch_for_active_homes(
    app_type: &str,
    next_provider_id: &str,
) -> Result<(), String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let persisted = load_persisted_state().await?;
    let targets = persisted
        .takeovers
        .iter()
        .filter(|item| item.app_type == app_type)
        .map(|item| {
            let host =
                if item.advertised_host.contains(':') && !item.advertised_host.starts_with('[') {
                    format!("[{}]", item.advertised_host)
                } else {
                    item.advertised_host.clone()
                };
            crate::provider::global::HotSwitchTarget {
                home_identity: crate::provider::global::HomeIdentityInput {
                    environment_kind: item.home_identity.environment_kind.clone(),
                    environment_id: Some(item.home_identity.environment_id.clone()),
                },
                projection: crate::provider::global::LocalRouteProjection {
                    endpoint: format!("http://{host}:{}", item.applied_port),
                },
            }
        })
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(());
    }
    let previous_provider_id = current_provider_id(&app_type).await?;
    crate::provider::global::apply_hot_switch(
        &app_type,
        &previous_provider_id,
        next_provider_id,
        &targets,
    )
    .await
    .map(|_| ())
}

pub(crate) async fn save_service_config(config: &RoutingServiceConfig) -> Result<(), String> {
    validate_service_config(config)?;
    let mut connection = database::open_connection().await?;
    let previous_raw = load_setting(&mut connection, SERVICE_SETTINGS_KEY).await?;
    let takeovers = load_takeovers(&mut connection).await?;
    let global_proxy = load_global_proxy_stored(&mut connection).await?;
    let candidate = RoutingPersistedState {
        service: config.clone(),
        takeovers,
    };
    validate_global_proxy_for_state(global_proxy.url.as_deref(), &candidate)?;
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(serialize_json(config, SERVICE_SETTINGS_KEY)?)
        .bind(SERVICE_SETTINGS_KEY)
        .execute(&mut connection)
        .await
        .map_err(|_| "routing_settings_write_failed:routing.service.v1".to_string())?;
    if result.rows_affected() != 1 {
        return Err("routing_settings_missing:routing.service.v1".to_string());
    }
    drop(connection);
    if let Err(error) = super::network_client::reload_from_persisted().await {
        if restore_setting(SERVICE_SETTINGS_KEY, &previous_raw)
            .await
            .is_err()
        {
            return Err("routing_global_proxy_recovery_required".to_string());
        }
        return Err(error);
    }
    Ok(())
}

pub(crate) async fn ensure_current_provider_ready(app_type: &str) -> Result<(), String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT p.meta, k.id AS active_key_id
         FROM providers p
         LEFT JOIN provider_api_keys k
           ON k.provider_id = p.id
          AND k.app_type = p.app_type
          AND k.is_active = 1
          AND k.enabled = 1
         WHERE p.app_type = ?1 AND p.is_current = 1
         LIMIT 1",
    )
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "routing_provider_read_failed".to_string())?
    .ok_or_else(|| "routing_provider_not_ready".to_string())?;

    let meta = row
        .try_get::<String, _>("meta")
        .map_err(|_| "routing_provider_read_failed".to_string())?;
    if !meta_enabled(&parse_meta(&meta)) {
        return Err("routing_provider_not_ready".to_string());
    }
    if row
        .try_get::<Option<String>, _>("active_key_id")
        .map_err(|_| "routing_provider_read_failed".to_string())?
        .is_none()
    {
        return Err("routing_provider_key_not_active".to_string());
    }
    Ok(())
}

pub(crate) async fn current_provider_id(app_type: &str) -> Result<String, String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let mut connection = database::open_connection().await?;
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1",
    )
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "routing_provider_read_failed".to_string())?
    .ok_or_else(|| "routing_provider_not_ready".to_string())
}

pub(crate) fn probe_wsl_mirrored(distro: &str, port: u16) -> Result<(), String> {
    probe_wsl_endpoint(distro, "127.0.0.1", port)
}

pub(crate) fn probe_wsl_gateway(distro: &str, gateway: Ipv4Addr, port: u16) -> Result<(), String> {
    probe_wsl_endpoint(distro, &gateway.to_string(), port)
}

fn probe_wsl_endpoint(distro: &str, host: &str, port: u16) -> Result<(), String> {
    let cache = WSL_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut entries) = cache.lock() {
        let now = Instant::now();
        entries.retain(|_, entry| {
            now.saturating_duration_since(entry.checked_at) <= WSL_PROBE_CACHE_TTL
        });
        if entries.get(distro).is_some_and(|entry| {
            entry.host == host
                && entry.port == port
                && now.saturating_duration_since(entry.checked_at) <= WSL_PROBE_CACHE_TTL
        }) {
            return Ok(());
        }
    }
    let exe =
        wsl::find_wsl_exe().ok_or_else(|| "routing_wsl_probe_tool_unavailable".to_string())?;
    let script = format!(
        "if command -v nc >/dev/null 2>&1; then nc -z -w 3 {host} {port}; elif command -v bash >/dev/null 2>&1; then exec bash -lc 'exec 3<>/dev/tcp/{host}/{port}'; elif command -v curl >/dev/null 2>&1; then curl --connect-timeout 3 --max-time 4 -fsS http://{host}:{port}/ >/dev/null; elif command -v wget >/dev/null 2>&1; then wget -q -T 3 -O /dev/null http://{host}:{port}/; else exit 127; fi"
    );
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("sh")
        .arg("-lc")
        .arg(script);
    let output = shell_resolver::output_with_timeout(command, WSL_MIRRORED_PROBE_TIMEOUT)
        .map_err(|_| "routing_wsl_probe_failed".to_string())?;
    if output.status.success() {
        if let Ok(mut entries) = cache.lock() {
            entries.insert(
                distro.to_string(),
                WslProbeCacheEntry {
                    host: host.to_string(),
                    port,
                    checked_at: Instant::now(),
                },
            );
        }
        Ok(())
    } else if output.status.code() == Some(127) {
        Err("routing_wsl_probe_tool_unavailable".to_string())
    } else {
        Err("routing_wsl_probe_failed".to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WslNatGateway {
    pub address: Ipv4Addr,
    pub network: Ipv4Addr,
    pub prefix_length: u8,
}

pub(crate) fn resolve_wsl_nat_gateway(distro: &str) -> Result<WslNatGateway, String> {
    let route_and_addresses = run_wsl_script_output(
        distro,
        r#"
route=$(ip -4 route show default) || exit 1
gateway=
device=
set -- $route
while [ "$#" -gt 0 ]; do
  case "$1" in
    via) gateway=$2; shift 2 ;;
    dev) device=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$gateway" ] && [ -n "$device" ] || exit 1
printf 'default via %s dev %s\n' "$gateway" "$device"
ip -4 addr show dev "$device" || exit 1
"#,
    )?;
    let (route, addresses) = route_and_addresses
        .split_once('\n')
        .ok_or_else(|| "routing_wsl_route_failed".to_string())?;
    let (gateway, _device) = parse_default_route(&route)?;
    let (network, prefix_length) = parse_interface_cidr(&addresses)?;
    if !ipv4_in_cidr(gateway, network, prefix_length) {
        return Err("routing_wsl_gateway_outside_interface".to_string());
    }
    if !is_local_unicast_address(&gateway.to_string()) {
        return Err("routing_wsl_gateway_not_local".to_string());
    }
    Ok(WslNatGateway {
        address: gateway,
        network,
        prefix_length,
    })
}

fn run_wsl_script_output(distro: &str, script: &str) -> Result<String, String> {
    let exe =
        wsl::find_wsl_exe().ok_or_else(|| "routing_wsl_route_tool_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("sh")
        .arg("-lc")
        .arg(script);
    let output = shell_resolver::output_with_timeout(command, WSL_MIRRORED_PROBE_TIMEOUT)
        .map_err(|_| "routing_wsl_route_failed".to_string())?;
    if !output.status.success() {
        return if output.status.code() == Some(127) {
            Err("routing_wsl_route_tool_unavailable".to_string())
        } else {
            Err("routing_wsl_route_failed".to_string())
        };
    }
    String::from_utf8(output.stdout).map_err(|_| "routing_wsl_route_failed".to_string())
}

fn parse_default_route(output: &str) -> Result<(Ipv4Addr, String), String> {
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.first() != Some(&"default") {
            continue;
        }
        let gateway = fields
            .windows(2)
            .find_map(|pair| (pair[0] == "via").then_some(pair[1]))
            .and_then(|value| value.parse::<Ipv4Addr>().ok())
            .ok_or_else(|| "routing_wsl_default_route_invalid".to_string())?;
        let device = fields
            .windows(2)
            .find_map(|pair| (pair[0] == "dev").then_some(pair[1]))
            .ok_or_else(|| "routing_wsl_default_route_invalid".to_string())?;
        if device.is_empty()
            || device.starts_with('-')
            || !device
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".:_-".contains(character))
        {
            return Err("routing_wsl_default_route_invalid".to_string());
        }
        return Ok((gateway, device.to_string()));
    }
    Err("routing_wsl_default_route_missing".to_string())
}

fn parse_interface_cidr(output: &str) -> Result<(Ipv4Addr, u8), String> {
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some(cidr) = fields
            .windows(2)
            .find_map(|pair| (pair[0] == "inet").then_some(pair[1]))
        else {
            continue;
        };
        let (address, prefix) = cidr
            .split_once('/')
            .ok_or_else(|| "routing_wsl_interface_cidr_invalid".to_string())?;
        let address = address
            .parse::<Ipv4Addr>()
            .map_err(|_| "routing_wsl_interface_cidr_invalid".to_string())?;
        let prefix_length = prefix
            .parse::<u8>()
            .ok()
            .filter(|prefix| *prefix <= 32)
            .ok_or_else(|| "routing_wsl_interface_cidr_invalid".to_string())?;
        return Ok((network_address(address, prefix_length), prefix_length));
    }
    Err("routing_wsl_interface_cidr_missing".to_string())
}

fn network_address(address: Ipv4Addr, prefix_length: u8) -> Ipv4Addr {
    let mask = if prefix_length == 0 {
        0
    } else {
        u32::MAX << (32 - prefix_length)
    };
    Ipv4Addr::from(u32::from(address) & mask)
}

fn ipv4_in_cidr(address: Ipv4Addr, network: Ipv4Addr, prefix_length: u8) -> bool {
    network_address(address, prefix_length) == network
}

pub(crate) fn is_local_unicast_address(address: &str) -> bool {
    let Ok(address) = address.parse::<Ipv4Addr>() else {
        return false;
    };
    local_ipv4_unicast_addresses()
        .map(|addresses| addresses.contains(&address))
        .unwrap_or(false)
}

#[cfg(windows)]
fn local_ipv4_unicast_addresses() -> Result<Vec<Ipv4Addr>, String> {
    let mut size = 15 * 1024u32;
    let mut resize_attempts = 0;
    loop {
        let mut buffer = vec![0u64; (size as usize).div_ceil(std::mem::size_of::<u64>())];
        let result = unsafe {
            GetAdaptersAddresses(
                AF_INET as u32,
                GAA_FLAG_INCLUDE_PREFIX,
                std::ptr::null(),
                buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            )
        };
        if result == ERROR_BUFFER_OVERFLOW {
            resize_attempts += 1;
            if resize_attempts > 3 {
                return Err("routing_windows_adapters_unavailable".to_string());
            }
            continue;
        }
        if result != 0 {
            return Err("routing_windows_adapters_unavailable".to_string());
        }

        let mut addresses = Vec::new();
        let mut adapter = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !adapter.is_null() {
            let mut unicast = unsafe { (*adapter).FirstUnicastAddress };
            while !unicast.is_null() {
                let socket_address = unsafe { (*unicast).Address };
                if !socket_address.lpSockaddr.is_null()
                    && unsafe { (*socket_address.lpSockaddr).sa_family } == AF_INET
                {
                    let address = unsafe {
                        let sockaddr = socket_address.lpSockaddr.cast::<SOCKADDR_IN>();
                        let bytes = (*sockaddr).sin_addr.S_un.S_un_b;
                        Ipv4Addr::new(bytes.s_b1, bytes.s_b2, bytes.s_b3, bytes.s_b4)
                    };
                    if !addresses.contains(&address) {
                        addresses.push(address);
                    }
                }
                unicast = unsafe { (*unicast).Next };
            }
            adapter = unsafe { (*adapter).Next };
        }
        return Ok(addresses);
    }
}

#[cfg(not(windows))]
fn local_ipv4_unicast_addresses() -> Result<Vec<Ipv4Addr>, String> {
    Err("routing_wsl_gateway_platform_unsupported".to_string())
}

pub(crate) fn takeover_key(
    app_type: &str,
    home_identity: &HomeIdentity,
) -> Result<TakeoverKey, String> {
    let app_type = normalize_routing_app_type(app_type)?;
    validate_home_identity(home_identity)?;
    Ok(TakeoverKey {
        app_type,
        home_identity: home_identity.identity.clone(),
    })
}

pub(crate) fn validate_service_config(config: &RoutingServiceConfig) -> Result<(), String> {
    if config.schema_version != 1 {
        return Err("routing_schema_version_unsupported:routing.service.v1".to_string());
    }
    if !matches!(
        config.listen_address.trim(),
        "127.0.0.1" | "::1" | "localhost"
    ) {
        return Err("routing_listen_address_invalid".to_string());
    }
    if config.preferred_port < MIN_PORT {
        return Err("routing_port_invalid".to_string());
    }
    if let Some(actual_port) = config.actual_port {
        if actual_port < MIN_PORT {
            return Err("routing_port_invalid".to_string());
        }
    }
    Ok(())
}

fn validate_home_identity(home_identity: &HomeIdentity) -> Result<(), String> {
    if !matches!(home_identity.environment_kind.as_str(), "local" | "wsl") {
        return Err("routing_home_invalid".to_string());
    }
    if home_identity.environment_id.trim().is_empty()
        || home_identity.identity.trim().is_empty()
        || home_identity.identity
            != format!(
                "{}:{}",
                home_identity.environment_kind, home_identity.environment_id
            )
    {
        return Err("routing_home_identity_mismatch".to_string());
    }
    if home_identity.environment_kind == "local" && home_identity.environment_id != "host" {
        return Err("routing_home_identity_mismatch".to_string());
    }
    Ok(())
}

async fn load_service_config(
    connection: &mut SqliteConnection,
) -> Result<RoutingServiceConfig, String> {
    let raw = load_setting(connection, SERVICE_SETTINGS_KEY).await?;
    let config = serde_json::from_str::<RoutingServiceConfig>(&raw)
        .map_err(|_| "routing_settings_invalid:routing.service.v1".to_string())?;
    validate_service_config(&config)?;
    Ok(config)
}

pub(crate) async fn usage_logging_enabled() -> Result<bool, String> {
    let mut connection = database::open_connection().await?;
    Ok(load_service_config(&mut connection)
        .await?
        .usage_logging_enabled)
}

async fn load_takeovers(
    connection: &mut SqliteConnection,
) -> Result<Vec<RoutingTakeoverItem>, String> {
    let raw = load_setting(connection, TAKEOVERS_SETTINGS_KEY).await?;
    let document = serde_json::from_str::<RoutingTakeoversDocument>(&raw)
        .map_err(|_| "routing_settings_invalid:routing.takeovers.v1".to_string())?;
    if document.schema_version != 1 {
        return Err("routing_schema_version_unsupported:routing.takeovers.v1".to_string());
    }

    let mut keys = HashSet::with_capacity(document.items.len());
    for item in &document.items {
        let normalized_app_type = normalize_routing_app_type(&item.app_type)?;
        if normalized_app_type != item.app_type {
            return Err("routing_app_type_invalid".to_string());
        }
        let key = takeover_key(&item.app_type, &item.home_identity)?;
        if !keys.insert(key) {
            return Err("routing_takeover_duplicate".to_string());
        }
        if !matches!(
            item.endpoint_mode.as_str(),
            "loopback" | "wsl_mirrored" | "wsl_gateway"
        ) || item.advertised_host.trim().is_empty()
            || !is_safe_advertised_host(&item.endpoint_mode, &item.advertised_host)
            || item.applied_port < MIN_PORT
        {
            return Err("routing_takeover_invalid".to_string());
        }
    }
    Ok(document.items)
}

pub(crate) async fn save_takeovers(items: &[RoutingTakeoverItem]) -> Result<(), String> {
    let mut keys = HashSet::with_capacity(items.len());
    for item in items {
        let normalized_app_type = normalize_routing_app_type(&item.app_type)?;
        if normalized_app_type != item.app_type {
            return Err("routing_app_type_invalid".to_string());
        }
        let key = takeover_key(&item.app_type, &item.home_identity)?;
        if !keys.insert(key)
            || !matches!(
                item.endpoint_mode.as_str(),
                "loopback" | "wsl_mirrored" | "wsl_gateway"
            )
            || item.advertised_host.trim().is_empty()
            || !is_safe_advertised_host(&item.endpoint_mode, &item.advertised_host)
            || item.applied_port < MIN_PORT
        {
            return Err("routing_takeover_invalid".to_string());
        }
    }
    let document = RoutingTakeoversDocument {
        schema_version: 1,
        items: items.to_vec(),
    };
    let mut connection = database::open_connection().await?;
    let previous_raw = load_setting(&mut connection, TAKEOVERS_SETTINGS_KEY).await?;
    let service = load_service_config(&mut connection).await?;
    let global_proxy = load_global_proxy_stored(&mut connection).await?;
    let candidate = RoutingPersistedState {
        service,
        takeovers: items.to_vec(),
    };
    validate_global_proxy_for_state(global_proxy.url.as_deref(), &candidate)?;
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(serialize_json(&document, TAKEOVERS_SETTINGS_KEY)?)
        .bind(TAKEOVERS_SETTINGS_KEY)
        .execute(&mut connection)
        .await
        .map_err(|_| "routing_settings_write_failed:routing.takeovers.v1".to_string())?;
    if result.rows_affected() != 1 {
        return Err("routing_settings_missing:routing.takeovers.v1".to_string());
    }
    drop(connection);
    if let Err(error) = super::network_client::reload_from_persisted().await {
        if restore_setting(TAKEOVERS_SETTINGS_KEY, &previous_raw)
            .await
            .is_err()
        {
            return Err("routing_global_proxy_recovery_required".to_string());
        }
        return Err(error);
    }
    Ok(())
}

fn is_safe_advertised_host(endpoint_mode: &str, host: &str) -> bool {
    let host = host.trim();
    if host
        .chars()
        .any(|ch| matches!(ch, '/' | '\\' | '\r' | '\n' | ' '))
        || matches!(host, "0.0.0.0" | "::" | "*")
    {
        return false;
    }
    if matches!(endpoint_mode, "loopback" | "wsl_mirrored") {
        matches!(host, "127.0.0.1" | "::1" | "localhost")
    } else {
        host.parse::<Ipv4Addr>().is_ok()
    }
}

pub(crate) fn normalize_routing_app_type(app_type: &str) -> Result<String, String> {
    normalize_app_type(app_type).map_err(|_| "routing_app_type_invalid".to_string())
}

async fn load_setting(connection: &mut SqliteConnection, key: &str) -> Result<String, String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| format!("routing_settings_read_failed:{key}"))?
        .ok_or_else(|| format!("routing_settings_missing:{key}"))
}

async fn restore_setting(key: &str, value: &str) -> Result<(), String> {
    let mut connection = database::open_connection().await?;
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(value)
        .bind(key)
        .execute(&mut connection)
        .await
        .map_err(|_| format!("routing_settings_restore_failed:{key}"))?;
    if result.rows_affected() != 1 {
        return Err(format!("routing_settings_restore_missing:{key}"));
    }
    Ok(())
}

fn serialize_json<T: Serialize>(value: &T, key: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| format!("routing_settings_serialize_failed:{key}"))
}

#[allow(dead_code)]
pub(crate) async fn cleanup_request_logs(
    connection: &mut SqliteConnection,
    now_ms: i64,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM routing_request_logs
         WHERE created_at_ms < ?1",
    )
    .bind(now_ms.saturating_sub(ROUTING_LOG_RETENTION_MS))
    .execute(&mut *connection)
    .await
    .map_err(|_| "routing_request_logs_cleanup_failed".to_string())?;

    sqlx::query(
        "DELETE FROM routing_request_logs
         WHERE request_id IN (
             SELECT request_id FROM routing_request_logs
             ORDER BY created_at_ms DESC, request_id DESC
             LIMIT -1 OFFSET ?1
         )",
    )
    .bind(ROUTING_LOG_MAX_ROWS)
    .execute(&mut *connection)
    .await
    .map_err(|_| "routing_request_logs_cleanup_failed".to_string())?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> RoutingServiceConfig {
        RoutingServiceConfig {
            schema_version: 1,
            service_enabled: false,
            listen_address: DEFAULT_LISTEN_ADDRESS.to_string(),
            preferred_port: DEFAULT_PREFERRED_PORT,
            actual_port: None,
            show_local_quick_control: false,
            show_failover_quick_control: false,
            usage_logging_enabled: true,
        }
    }

    fn home() -> HomeIdentity {
        HomeIdentity {
            environment_kind: "local".to_string(),
            environment_id: "host".to_string(),
            identity: "local:host".to_string(),
        }
    }

    fn persisted_state() -> RoutingPersistedState {
        let mut service = service();
        service.actual_port = Some(15_721);
        RoutingPersistedState {
            service,
            takeovers: vec![RoutingTakeoverItem {
                app_type: "codex".to_string(),
                home_identity: home(),
                endpoint_mode: "loopback".to_string(),
                advertised_host: "127.0.0.1".to_string(),
                applied_port: 15_722,
            }],
        }
    }

    #[test]
    fn service_config_accepts_loopback_and_rejects_wildcard() {
        assert!(validate_service_config(&service()).is_ok());
        let mut wildcard = service();
        wildcard.listen_address = "0.0.0.0".to_string();
        assert_eq!(
            validate_service_config(&wildcard).unwrap_err(),
            "routing_listen_address_invalid"
        );
        let mut invalid_port = service();
        invalid_port.preferred_port = 1_023;
        assert_eq!(
            validate_service_config(&invalid_port).unwrap_err(),
            "routing_port_invalid"
        );
    }

    fn failover_config() -> RoutingFailoverConfig {
        RoutingFailoverConfig {
            schema_version: 1,
            auto_failover_enabled: false,
            max_retries: 3,
            streaming_first_byte_timeout: 60,
            streaming_idle_timeout: 120,
            non_streaming_timeout: 600,
            circuit_failure_threshold: 4,
            circuit_success_threshold: 2,
            circuit_timeout_seconds: 60,
            circuit_error_rate_threshold: 0.6,
            circuit_min_requests: 10,
        }
    }

    fn rectifier_config() -> RoutingRectifierConfig {
        RoutingRectifierConfig {
            schema_version: 1,
            enabled: true,
            request_thinking_signature: true,
            request_thinking_budget: true,
            request_media_fallback: true,
            request_media_heuristic: true,
        }
    }

    #[test]
    fn rectifier_config_requires_schema_one() {
        assert!(validate_rectifier_config(&rectifier_config()).is_ok());
        let mut invalid = rectifier_config();
        invalid.schema_version = 2;
        assert_eq!(
            validate_rectifier_config(&invalid).unwrap_err(),
            "routing_rectifier_config_invalid"
        );
    }

    #[test]
    fn optimizer_config_requires_schema_one_and_preserves_switches() {
        let config = RoutingOptimizerConfig {
            schema_version: 1,
            enabled: false,
            thinking_optimizer: true,
            cache_injection: true,
        };
        assert!(validate_optimizer_config(&config).is_ok());
        let serialized = serde_json::to_value(&config).unwrap();
        assert_eq!(serialized["thinkingOptimizer"], true);
        assert_eq!(serialized["cacheInjection"], true);
        let mut invalid = config;
        invalid.schema_version = 2;
        assert_eq!(
            validate_optimizer_config(&invalid).unwrap_err(),
            "routing_optimizer_config_invalid"
        );
    }

    #[test]
    fn retry_context_allows_each_enabled_rule_once_and_respects_master_switch() {
        let config = rectifier_config();
        let mut context = RoutingRetryContext::default();
        for rule in [
            RoutingRectifierRule::ThinkingSignature,
            RoutingRectifierRule::ThinkingBudget,
            RoutingRectifierRule::MediaFallback,
        ] {
            assert!(context.can_retry(&config, rule));
            context.mark_used(rule);
            assert!(!context.can_retry(&config, rule));
        }

        let mut disabled = config.clone();
        disabled.enabled = false;
        assert!(!context.can_retry(&disabled, RoutingRectifierRule::ThinkingSignature));
    }

    #[test]
    fn failover_config_accepts_seeded_ranges() {
        assert!(validate_failover_config(&failover_config()).is_ok());
    }

    #[test]
    fn failover_config_rejects_invalid_ranges() {
        let mut invalid = failover_config();
        invalid.circuit_error_rate_threshold = 1.1;
        assert_eq!(
            validate_failover_config(&invalid).unwrap_err(),
            "routing_failover_config_invalid"
        );

        invalid = failover_config();
        invalid.max_retries = 33;
        assert_eq!(
            validate_failover_config(&invalid).unwrap_err(),
            "routing_failover_config_invalid"
        );
    }

    #[test]
    fn global_proxy_url_requires_supported_explicit_endpoint_without_credentials() {
        assert_eq!(
            normalize_global_proxy_url(Some(" http://proxy.example:8080 ")).unwrap(),
            Some("http://proxy.example:8080/".to_string())
        );
        assert_eq!(
            normalize_global_proxy_url(Some("socks5h://proxy.example:1080")).unwrap(),
            Some("socks5h://proxy.example:1080".to_string())
        );
        for value in [
            "ftp://proxy.example:21",
            "http://proxy.example",
            "http://user:password@proxy.example:8080",
        ] {
            assert_eq!(
                normalize_global_proxy_url(Some(value)).unwrap_err(),
                "routing_proxy_url_invalid"
            );
        }
        assert_eq!(normalize_global_proxy_url(Some("  ")).unwrap(), None);
    }

    #[test]
    fn global_proxy_state_serializes_presence_only_not_password_or_account() {
        let state = RoutingGlobalProxyState {
            schema_version: 1,
            url: Some("http://proxy.example:8080/".to_string()),
            username: Some("proxy-user".to_string()),
            has_password: true,
        };
        let value = serde_json::to_value(state).unwrap();
        assert_eq!(value["hasPassword"], true);
        assert!(value.get("password").is_none());
        assert!(value.get("passwordCredentialAccount").is_none());
    }

    #[test]
    fn global_proxy_self_loop_matches_loopback_aliases_only_at_the_same_port() {
        assert!(global_proxy_matches_endpoint(
            "localhost",
            15721,
            "127.0.0.1",
            15721
        ));
        assert!(global_proxy_matches_endpoint(
            "::1",
            15721,
            "localhost",
            15721
        ));
        assert!(!global_proxy_matches_endpoint(
            "localhost",
            15722,
            "127.0.0.1",
            15721
        ));
        assert!(!global_proxy_matches_endpoint(
            "127.0.0.1",
            15721,
            "172.20.0.1",
            15721
        ));
    }

    #[test]
    fn proxy_endpoint_uses_scheme_defaults_for_system_proxy_values() {
        assert_eq!(
            proxy_endpoint("http://localhost"),
            Some(("localhost".to_string(), 80))
        );
        assert_eq!(
            proxy_endpoint("socks5h://127.0.0.1"),
            Some(("127.0.0.1".to_string(), 1080))
        );
    }

    #[test]
    fn proxy_state_matches_service_and_takeover_endpoints() {
        let persisted = persisted_state();
        assert!(proxy_matches_persisted_state(
            Some("http://localhost:15721"),
            &persisted
        ));
        assert!(proxy_matches_persisted_state(
            Some("http://[::1]:15722"),
            &persisted
        ));
        assert!(!proxy_matches_persisted_state(
            Some("http://127.0.0.1:15723"),
            &persisted
        ));
    }

    #[test]
    fn explicit_proxy_is_rejected_when_route_state_would_self_loop() {
        let persisted = persisted_state();
        assert_eq!(
            validate_global_proxy_for_state(Some("http://localhost:15722"), &persisted)
                .unwrap_err(),
            "routing_proxy_self_loop"
        );
        assert!(
            validate_global_proxy_for_state(Some("http://proxy.example:8080"), &persisted).is_ok()
        );
    }

    #[test]
    fn global_proxy_scan_ports_are_fixed_and_unique() {
        let mut ports = GLOBAL_PROXY_SCAN_PORTS.to_vec();
        ports.sort_unstable();
        ports.dedup();
        assert_eq!(ports.len(), GLOBAL_PROXY_SCAN_PORTS.len());
        assert_eq!(
            GLOBAL_PROXY_SCAN_PORTS,
            [7_890, 7_891, 1_080, 8_080, 8_888, 3_128, 10_808, 10_809]
        );
    }

    #[test]
    fn failover_provider_selection_keeps_queue_order_and_ready_boundary() {
        let providers = vec![
            RoutingFailoverProvider {
                id: "a".to_string(),
                name: "A".to_string(),
                sort_index: 0,
                is_current: true,
                enabled: true,
                ready: true,
                in_failover_queue: true,
                key_count: 2,
                active_key_present: true,
            },
            RoutingFailoverProvider {
                id: "b".to_string(),
                name: "B".to_string(),
                sort_index: 1,
                is_current: false,
                enabled: true,
                ready: false,
                in_failover_queue: true,
                key_count: 1,
                active_key_present: true,
            },
            RoutingFailoverProvider {
                id: "c".to_string(),
                name: "C".to_string(),
                sort_index: 2,
                is_current: false,
                enabled: true,
                ready: true,
                in_failover_queue: true,
                key_count: 2,
                active_key_present: true,
            },
        ];
        assert_eq!(
            eligible_failover_provider_ids(&providers),
            vec!["a".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn failover_provider_selection_remembers_current_provider() {
        let mut provider_ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        prioritize_current_provider(&mut provider_ids, Some("c"));
        assert_eq!(provider_ids, vec!["c", "a", "b"]);
        prioritize_current_provider(&mut provider_ids, Some("missing"));
        assert_eq!(provider_ids, vec!["c", "a", "b"]);
    }

    #[test]
    fn disabling_failover_does_not_rewrite_existing_queue() {
        let previous_ids = vec!["provider-a".to_string(), "provider-b".to_string()];
        assert!(!should_seed_failover_queue(false, &previous_ids));
        assert!(!should_seed_failover_queue(true, &previous_ids));
        assert!(should_seed_failover_queue(true, &[]));
    }

    #[test]
    fn takeover_key_is_app_and_home_identity() {
        let key = takeover_key("grok", &home()).unwrap();
        assert_eq!(key.app_type, "grokbuild");
        assert_eq!(key.home_identity, "local:host");
    }

    #[test]
    fn malformed_home_identity_is_rejected() {
        let mut invalid = home();
        invalid.identity = "local:other".to_string();
        assert_eq!(
            takeover_key("claude", &invalid).unwrap_err(),
            "routing_home_identity_mismatch"
        );
    }

    #[test]
    fn advertised_host_rejects_wildcards_and_non_loopback_loopback_modes() {
        assert!(!is_safe_advertised_host("loopback", "0.0.0.0"));
        assert!(!is_safe_advertised_host("loopback", "192.168.1.4"));
        assert!(is_safe_advertised_host("wsl_mirrored", "127.0.0.1"));
        assert!(!is_safe_advertised_host("wsl_mirrored", "172.28.224.1"));
        assert!(is_safe_advertised_host("wsl_gateway", "172.28.224.1"));
    }

    #[test]
    fn wsl_home_identity_is_valid_for_takeover_storage() {
        let home = HomeIdentity {
            environment_kind: "wsl".to_string(),
            environment_id: "Ubuntu".to_string(),
            identity: "wsl:Ubuntu".to_string(),
        };
        assert!(takeover_key("claude", &home).is_ok());
    }

    #[test]
    fn parses_wsl_default_route_and_interface_cidr() {
        let (gateway, device) =
            parse_default_route("default via 172.28.224.1 dev eth0 proto kernel\n").unwrap();
        assert_eq!(gateway, Ipv4Addr::new(172, 28, 224, 1));
        assert_eq!(device, "eth0");

        let (network, prefix) = parse_interface_cidr(
            "2: eth0@if3: <BROADCAST>\n    inet 172.28.224.2/20 brd 172.28.239.255 scope global eth0\n",
        )
        .unwrap();
        assert_eq!(network, Ipv4Addr::new(172, 28, 224, 0));
        assert_eq!(prefix, 20);
        assert!(ipv4_in_cidr(gateway, network, prefix));
    }

    #[test]
    fn rejects_wsl_default_route_without_gateway_or_interface_cidr() {
        assert_eq!(
            parse_default_route("default dev eth0\n").unwrap_err(),
            "routing_wsl_default_route_invalid"
        );
        assert_eq!(
            parse_interface_cidr("2: eth0:\n").unwrap_err(),
            "routing_wsl_interface_cidr_missing"
        );
    }
}
