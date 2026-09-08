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

// 优先使用合法显式代理，否则按端口探测本机代理候选。
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

// 代理开关关闭时不解析地址也不进行端口探测。
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

// 按顺序 TCP 连接回环端口，将首个可连端口视为 HTTP 代理。
pub(super) fn detect_local_proxy_on_ports(ports: &[u16]) -> Option<String> {
    ports.iter().find_map(|port| {
        let address = SocketAddr::from(([127, 0, 0, 1], *port));
        TcpStream::connect_timeout(&address, LOCAL_PROXY_CONNECT_TIMEOUT)
            .ok()
            .map(|_| format!("http://127.0.0.1:{port}/"))
    })
}

// 生成大小写代理变量及回环绕过清单。
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

// 关闭代理时移除继承变量，否则注入已解析代理设置。
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

// 将本地路径转为配置格式后生成临时 Git 信任环境。
pub(super) fn git_safe_directory_environment(
    project_path: &Path,
    inherited_count: Option<&str>,
) -> Vec<(String, String)> {
    git_safe_directory_environment_for_value(&config_path_value(project_path), inherited_count)
}

// 在合法继承配置计数后追加一个指定路径的 safe.directory 条目。
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

// 读取继承 Git 配置计数并向子进程追加项目目录信任。
pub(super) fn apply_git_safe_directory_environment(command: &mut Command, project_path: &Path) {
    let inherited_count = env::var("GIT_CONFIG_COUNT").ok();
    for (key, value) in git_safe_directory_environment(project_path, inherited_count.as_deref()) {
        command.env(key, value);
    }
}
