use super::{config_path_value, normalize_proxy_url, LOCAL_PROXY_CONNECT_TIMEOUT, PROXY_ENV_KEYS};
use std::env;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProxySource {
    Configured,
    AutoDetected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ResolvedProxy {
    pub(super) url: String,
    pub(super) source: ProxySource,
}

pub(super) fn resolve_proxy_url(
    configured: Option<&str>,
    local_ports: &[u16],
) -> Result<Option<ResolvedProxy>, String> {
    if let Some(url) = normalize_proxy_url(configured)? {
        return Ok(Some(ResolvedProxy {
            url,
            source: ProxySource::Configured,
        }));
    }
    Ok(
        detect_local_proxy_on_ports(local_ports).map(|url| ResolvedProxy {
            url,
            source: ProxySource::AutoDetected,
        }),
    )
}

pub(super) fn resolve_proxy_url_if_enabled(
    enabled: bool,
    configured: Option<&str>,
    local_ports: &[u16],
) -> Result<Option<ResolvedProxy>, String> {
    if !enabled {
        return Ok(None);
    }
    resolve_proxy_url(configured, local_ports)
}

pub(super) fn detect_local_proxy_on_ports(ports: &[u16]) -> Option<String> {
    ports.iter().find_map(|port| {
        let address = SocketAddr::from(([127, 0, 0, 1], *port));
        TcpStream::connect_timeout(&address, LOCAL_PROXY_CONNECT_TIMEOUT)
            .ok()
            .map(|_| format!("http://127.0.0.1:{port}/"))
    })
}

pub(super) fn proxy_environment(proxy_url: &str) -> Vec<(String, String)> {
    PROXY_ENV_KEYS
        .into_iter()
        .map(|key| (key.to_string(), proxy_url.to_string()))
        .chain([
            (
                "NO_PROXY".to_string(),
                "localhost,127.0.0.1,[::1]".to_string(),
            ),
            (
                "no_proxy".to_string(),
                "localhost,127.0.0.1,[::1]".to_string(),
            ),
        ])
        .collect()
}

pub(super) fn apply_proxy_environment(
    command: &mut Command,
    proxy_enabled: bool,
    proxy: Option<&ResolvedProxy>,
) {
    if !proxy_enabled {
        for key in PROXY_ENV_KEYS {
            command.env_remove(key);
        }
        command.env("NO_PROXY", "*").env("no_proxy", "*");
        return;
    }
    if let Some(proxy) = proxy {
        for (key, value) in proxy_environment(&proxy.url) {
            command.env(key, value);
        }
    }
}

pub(super) fn git_safe_directory_environment(
    project_path: &Path,
    inherited_count: Option<&str>,
) -> Vec<(String, String)> {
    git_safe_directory_environment_for_value(&config_path_value(project_path), inherited_count)
}

pub(super) fn git_safe_directory_environment_for_value(
    project_path: &str,
    inherited_count: Option<&str>,
) -> Vec<(String, String)> {
    let index = inherited_count
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value < 1_024)
        .unwrap_or(0);
    vec![
        ("GIT_CONFIG_COUNT".to_string(), (index + 1).to_string()),
        (
            format!("GIT_CONFIG_KEY_{index}"),
            "safe.directory".to_string(),
        ),
        (
            format!("GIT_CONFIG_VALUE_{index}"),
            project_path.to_string(),
        ),
    ]
}

pub(super) fn apply_git_safe_directory_environment(command: &mut Command, project_path: &Path) {
    let inherited_count = env::var("GIT_CONFIG_COUNT").ok();
    for (key, value) in git_safe_directory_environment(project_path, inherited_count.as_deref()) {
        command.env(key, value);
    }
}
