use serde::{Deserialize, Serialize};
use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;
use url::Url;

const CONFIG_FILE: &str = "web-server.json";
const PASSWORD_ACCOUNT: &str = "web-server-admin-password";
const DEFAULT_BIND: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8787;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerConfig {
    #[serde(default)]
    pub trusted_network: bool,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_admin_username")]
    pub admin_username: String,
    #[serde(default)]
    pub allowed_origin: Option<String>,
}

impl Default for WebServerConfig {
    fn default() -> Self {
        Self {
            trusted_network: false,
            auto_start: false,
            bind: default_bind(),
            port: default_port(),
            admin_username: default_admin_username(),
            allowed_origin: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerStatus {
    pub trusted_network: bool,
    pub local_device_url: String,
    pub interfaces: Vec<(String, String)>,
    pub configured: bool,
    pub running: bool,
    pub stopping: bool,
    pub auto_start: bool,
    pub bind: String,
    pub port: u16,
    pub url: String,
    pub allowed_origin: Option<String>,
    pub network_exposed: bool,
    pub last_error: Option<String>,
}

struct Runtime {
    stopping: Option<oneshot::Sender<()>>,
    running: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

pub struct WebServerManager {
    lifecycle: Mutex<()>,
    runtime: Mutex<Option<Runtime>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl Default for WebServerManager {
    fn default() -> Self {
        Self {
            lifecycle: Mutex::new(()),
            runtime: Mutex::new(None),
            last_error: Arc::new(Mutex::new(None)),
        }
    }
}

fn default_bind() -> String {
    DEFAULT_BIND.to_string()
}
fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_admin_username() -> String {
    "admin".to_string()
}

fn config_path() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?.join(CONFIG_FILE))
}

fn load_config() -> Result<WebServerConfig, String> {
    let path = config_path()?;
    if !path.is_file() {
        return Ok(WebServerConfig::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("read Web server config failed: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("parse Web server config failed: {error}"))
}

fn save_config(config: &WebServerConfig) -> Result<(), String> {
    validate_config(config)?;
    let path = config_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "invalid Web server config path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create Web server config directory failed: {error}"))?;
    let temporary = parent.join(format!(".{CONFIG_FILE}.tmp"));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write Web server config failed: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("replace Web server config failed: {error}"))?;
    }
    fs::rename(temporary, path).map_err(|error| format!("commit Web server config failed: {error}"))
}

fn normalize_origin(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = Url::parse(value)
        .map_err(|_| "Allowed Origin must be a valid HTTP or HTTPS origin".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(
            "Allowed Origin must contain only an HTTP or HTTPS scheme, host, and optional port"
                .to_string(),
        );
    }
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err("Allowed Origin is not a valid network origin".to_string());
    }
    Ok(Some(origin))
}

fn is_local_bind_address(ip: IpAddr) -> Result<bool, String> {
    if ip.is_loopback() || ip.is_unspecified() {
        return Ok(true);
    }
    let interfaces = local_ip_address::list_afinet_netifas()
        .map_err(|error| format!("list local network interfaces failed: {error}"))?;
    Ok(address_is_present(
        ip,
        interfaces.into_iter().map(|(_, address)| address),
    ))
}

fn address_is_present(ip: IpAddr, addresses: impl IntoIterator<Item = IpAddr>) -> bool {
    addresses.into_iter().any(|address| address == ip)
}

fn validate_config(config: &WebServerConfig) -> Result<(), String> {
    let ip = config
        .bind
        .trim()
        .parse::<IpAddr>()
        .map_err(|_| "Web server bind address must be a valid IP address".to_string())?;
    if !is_local_bind_address(ip)? {
        return Err(
            "Web server bind address is not assigned to a local network interface".to_string(),
        );
    }
    if config.port == 0 {
        return Err("Web server port must be between 1 and 65535".to_string());
    }
    if ip.is_unspecified() && normalize_origin(config.allowed_origin.as_deref())?.is_none() {
        return Err(
            "Allowed Origin is required when listening on all network interfaces".to_string(),
        );
    }
    let origin = normalize_origin(config.allowed_origin.as_deref())?;
    if !ip.is_loopback() && !config.trusted_network
        && !origin.as_deref().is_some_and(|value| value.starts_with("https://")) {
        return Err("Enable trusted network HTTP explicitly, or configure an HTTPS browser origin".into());
    }
    Ok(())
}

fn default_origin(ip: IpAddr, port: u16) -> String {
    format!("http://{}", SocketAddr::new(ip, port))
}

fn status(manager: &WebServerManager) -> Result<WebServerStatus, String> {
    let config = load_config()?;
    let ip = config
        .bind
        .parse::<IpAddr>()
        .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    let allowed_origin = normalize_origin(config.allowed_origin.as_deref())?;
    let runtime = manager
        .runtime
        .lock()
        .map_err(|_| "Web server state lock poisoned")?;
    let stopping = runtime
        .as_ref()
        .is_some_and(|runtime| runtime.stopping.is_none());
    let running = runtime.as_ref().is_some_and(|runtime| {
        runtime.running.load(Ordering::SeqCst)
            && runtime
                .thread
                .as_ref()
                .is_some_and(|thread| !thread.is_finished())
    }) && !stopping;
    drop(runtime);
    let last_error = manager
        .last_error
        .lock()
        .map_err(|_| "Web server error lock poisoned")?
        .clone();
    Ok(WebServerStatus {
        trusted_network: config.trusted_network,
        local_device_url: format!("ws://{}/ws/device", SocketAddr::new(if ip.is_ipv6() && (ip.is_loopback() || ip.is_unspecified()) { IpAddr::V6(std::net::Ipv6Addr::LOCALHOST) } else { IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) }, config.port)),
        interfaces: local_ip_address::list_afinet_netifas().unwrap_or_default().into_iter().map(|(name, ip)| (name, ip.to_string())).collect(),
        configured: credential_exists()?,
        running,
        stopping,
        auto_start: config.auto_start,
        bind: config.bind.clone(),
        port: config.port,
        url: allowed_origin
            .clone()
            .unwrap_or_else(|| default_origin(ip, config.port)),
        allowed_origin,
        network_exposed: !ip.is_loopback(),
        last_error,
    })
}

fn credential_exists() -> Result<bool, String> {
    Ok(crate::credential_store::get(PASSWORD_ACCOUNT)?
        .is_some_and(|value| !value.trim().is_empty()))
}

fn server_config(
    app: &AppHandle,
    config: &WebServerConfig,
) -> Result<cli_manager_web_server::config::Config, String> {
    let ip = config
        .bind
        .parse::<IpAddr>()
        .map_err(|_| "invalid Web server bind address".to_string())?;
    validate_config(config)?;
    let allowed_origin = normalize_origin(config.allowed_origin.as_deref())?
        .or_else(|| (!ip.is_loopback()).then(|| default_origin(ip, config.port)));
    let cookie_secure = allowed_origin
        .as_deref()
        .is_some_and(|origin| origin.starts_with("https://"));
    let data_dir = crate::app_paths::cli_manager_data_dir()?;
    let web_dist = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../apps/web/dist")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| format!("resolve Web server resources failed: {error}"))?
            .join("apps/web/dist")
    };
    let password = crate::credential_store::get(PASSWORD_ACCOUNT)?
        .ok_or_else(|| "Web server admin password is not configured".to_string())?;
    Ok(cli_manager_web_server::config::Config {
        trusted_network: config.trusted_network,
        bind: SocketAddr::new(ip, config.port),
        database_path: data_dir.join("web-server.db"),
        web_dist,
        admin_username: config.admin_username.clone(),
        admin_password: password,
        cookie_secure,
        allowed_origin,
    })
}

pub fn start(app: &AppHandle, manager: &WebServerManager) -> Result<WebServerStatus, String> {
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Web server lifecycle lock poisoned")?;
    start_locked(app, manager)
}

fn start_locked(app: &AppHandle, manager: &WebServerManager) -> Result<WebServerStatus, String> {
    let config = load_config()?;
    let server_config = server_config(app, &config)?;
    let mut runtime_slot = manager
        .runtime
        .lock()
        .map_err(|_| "Web server state lock poisoned")?;
    if runtime_slot
        .as_ref()
        .is_some_and(|runtime| runtime.stopping.is_none())
    {
        return Err("web_server_still_stopping".into());
    }
    if runtime_slot.as_ref().is_some_and(|runtime| {
        runtime.running.load(Ordering::SeqCst)
            && runtime
                .thread
                .as_ref()
                .is_some_and(|thread| !thread.is_finished())
    }) {
        drop(runtime_slot);
        return status(manager);
    }
    if let Some(mut stale) = runtime_slot.take() {
        if let Some(thread) = stale.thread.take() {
            let _ = thread.join();
        }
    }
    let (stop_tx, stop_rx) = oneshot::channel();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let running = Arc::new(AtomicBool::new(false));
    let running_thread = running.clone();
    let running_ready = running.clone();
    let last_error = manager.last_error.clone();
    if let Ok(mut error) = manager.last_error.lock() {
        *error = None;
    }
    let server_thread = thread::Builder::new()
        .name("cli-manager-web-server".into())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|error| format!("create Web server runtime failed: {error}"))
                .and_then(|runtime| {
                    runtime.block_on(cli_manager_web_server::run_with_shutdown_ready(
                        server_config,
                        async {
                            let _ = stop_rx.await;
                        },
                        Some(ready_tx),
                    ))
                });
            running_thread.store(false, Ordering::SeqCst);
            if let Err(error) = result {
                if let Ok(mut last) = last_error.lock() {
                    *last = Some(error.clone());
                }
                log::error!("managed Web server stopped: {error}");
            }
        })
        .map_err(|error| format!("spawn Web server thread failed: {error}"))?;
    *runtime_slot = Some(Runtime {
        stopping: Some(stop_tx),
        running,
        thread: Some(server_thread),
    });
    match ready_rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(())) => running_ready.store(true, Ordering::SeqCst),
        Ok(Err(error)) => {
            drop(runtime_slot);
            stop_locked(manager)?;
            return Err(error);
        }
        Err(error) => {
            drop(runtime_slot);
            stop_locked(manager)?;
            return Err(format!("Web server startup did not become ready: {error}"));
        }
    }
    drop(runtime_slot);
    Ok(status(manager)?)
}

pub fn stop(manager: &WebServerManager) -> Result<WebServerStatus, String> {
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Web server lifecycle lock poisoned")?;
    stop_locked(manager)
}

fn stop_locked(manager: &WebServerManager) -> Result<WebServerStatus, String> {
    let mut runtime_slot = manager
        .runtime
        .lock()
        .map_err(|_| "Web server state lock poisoned")?;
    if let Err(error) = stop_runtime(&mut runtime_slot, Duration::from_secs(5)) {
        if let Ok(mut last) = manager.last_error.lock() {
            *last = Some(error.clone());
        }
        return Err(error);
    }
    if let Ok(mut last) = manager.last_error.lock() {
        if last.as_deref() == Some("web_server_still_stopping") {
            *last = None;
        }
    }
    drop(runtime_slot);
    status(manager)
}

fn stop_runtime(runtime_slot: &mut Option<Runtime>, timeout: Duration) -> Result<(), String> {
    if let Some(runtime) = runtime_slot.as_mut() {
        if let Some(stop) = runtime.stopping.take() {
            let _ = stop.send(());
        }
        // Keep ownership until the worker has actually exited. A timeout must
        // never turn a live listener into an untracked, supposedly stopped one.
        let deadline = Instant::now() + timeout;
        while runtime
            .thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
        {
            if Instant::now() >= deadline {
                return Err("web_server_still_stopping".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
        if let Some(thread) = runtime.thread.take() {
            thread
                .join()
                .map_err(|_| "Web server thread panicked while stopping".to_string())?;
        }
    }
    *runtime_slot = None;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWebServerConfigRequest {
    #[serde(default)]
    pub trusted_network: bool,
    pub auto_start: bool,
    pub bind: String,
    pub port: u16,
    pub admin_username: String,
    pub admin_password: Option<String>,
    pub allowed_origin: Option<String>,
}

#[tauri::command]
pub fn web_server_get_status(
    manager: State<'_, WebServerManager>,
) -> Result<WebServerStatus, String> {
    status(&manager)
}

#[tauri::command]
pub fn web_server_save_config(
    app: AppHandle,
    request: SaveWebServerConfigRequest,
    manager: State<'_, WebServerManager>,
) -> Result<WebServerStatus, String> {
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Web server lifecycle lock poisoned")?;
    let previous = load_config()?;
    let current = status(&manager)?;
    if current.stopping {
        return Err("web_server_still_stopping".into());
    }
    let was_running = current.running;
    let bind = request.bind.trim().to_string();
    let ip = bind
        .parse::<IpAddr>()
        .map_err(|_| "Web server bind address must be a valid IP address".to_string())?;
    let allowed_origin = normalize_origin(request.allowed_origin.as_deref())?
        .or_else(|| (!ip.is_unspecified() && !ip.is_loopback()).then(|| default_origin(ip, request.port)));
    let config = WebServerConfig {
        trusted_network: request.trusted_network,
        auto_start: request.auto_start,
        bind,
        port: request.port,
        admin_username: request.admin_username.trim().to_string(),
        allowed_origin,
    };
    if config.admin_username.is_empty() {
        return Err("Web server admin username cannot be empty".to_string());
    }
    save_config(&config)?;
    if let Some(password) = request
        .admin_password
        .filter(|value| !value.trim().is_empty())
    {
        crate::credential_store::set(PASSWORD_ACCOUNT, &password)?;
    }
    if was_running {
        stop_locked(&manager)?;
        if let Err(error) = start_locked(&app, &manager) {
            save_config(&previous)?;
            let rollback_error = start_locked(&app, &manager).err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "apply Web server configuration failed: {error}; restoring the previous listener also failed: {rollback_error}"
                ),
                None => format!(
                    "apply Web server configuration failed and the previous listener was restored: {error}"
                ),
            });
        }
    }
    status(&manager)
}

#[tauri::command]
pub fn web_server_start(
    app: AppHandle,
    manager: State<'_, WebServerManager>,
) -> Result<WebServerStatus, String> {
    start(&app, &manager)
}

#[tauri::command]
pub fn web_server_stop(manager: State<'_, WebServerManager>) -> Result<WebServerStatus, String> {
    stop(&manager)
}

#[tauri::command]
pub fn web_server_restart(
    app: AppHandle,
    manager: State<'_, WebServerManager>,
) -> Result<WebServerStatus, String> {
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Web server lifecycle lock poisoned")?;
    stop_locked(&manager)?;
    start_locked(&app, &manager)
}

pub fn auto_start(app: &AppHandle, manager: &WebServerManager) -> Result<(), String> {
    if load_config()?.auto_start {
        let _ = start(app, manager)?;
    }
    Ok(())
}

pub fn shutdown(manager: &WebServerManager) {
    let _ = stop(manager);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_timeout_retains_worker_until_a_successful_retry() {
        let (release, released) = std::sync::mpsc::channel();
        let (stopping, _stopped) = oneshot::channel();
        let worker = thread::spawn(move || {
            released.recv().unwrap();
        });
        let mut slot = Some(Runtime {
            stopping: Some(stopping),
            running: Arc::new(AtomicBool::new(true)),
            thread: Some(worker),
        });
        let result = stop_runtime(&mut slot, Duration::from_millis(10));
        // Release before asserting, so even a regression cannot leak this helper.
        release.send(()).unwrap();
        assert_eq!(result.unwrap_err(), "web_server_still_stopping");
        assert!(slot.as_ref().unwrap().stopping.is_none());
        assert!(slot.as_ref().unwrap().thread.is_some());
        stop_runtime(&mut slot, Duration::from_secs(2)).unwrap();
        assert!(slot.is_none());
    }

    fn config(bind: &str, allowed_origin: Option<&str>) -> WebServerConfig {
        WebServerConfig {
            bind: bind.to_string(),
            port: 8787,
            allowed_origin: allowed_origin.map(str::to_string),
            ..WebServerConfig::default()
        }
    }

    #[test]
    fn origin_normalization_accepts_exact_http_origins() {
        assert_eq!(
            normalize_origin(Some(" https://host.example:9443/ ")).unwrap(),
            Some("https://host.example:9443".to_string())
        );
        assert!(normalize_origin(Some("https://host.example/path")).is_err());
        assert!(normalize_origin(Some("file:///tmp/index.html")).is_err());
    }

    #[test]
    fn all_interfaces_require_an_explicit_origin() {
        assert!(validate_config(&config("0.0.0.0", None)).is_err());
        assert!(validate_config(&config("0.0.0.0", Some("http://100.64.0.10:8787"))).is_err());
        let mut trusted = config("0.0.0.0", Some("http://100.64.0.10:8787"));
        trusted.trusted_network = true;
        assert!(validate_config(&trusted).is_ok());
        assert!(validate_config(&config("0.0.0.0", Some("https://cli.example.com"))).is_ok());
        assert!(validate_config(&config("127.0.0.1", None)).is_ok());
    }

    #[test]
    fn interface_membership_requires_an_exact_address() {
        let expected: IpAddr = "100.64.0.10".parse().unwrap();
        let addresses = ["192.168.1.20".parse().unwrap(), expected];
        assert!(address_is_present(expected, addresses));
        assert!(!address_is_present(
            "100.64.0.11".parse().unwrap(),
            addresses
        ));
    }

    #[test]
    fn ipv6_default_origin_is_bracketed() {
        assert_eq!(
            default_origin("::1".parse().unwrap(), 8787),
            "http://[::1]:8787"
        );
    }
}
