use serde::Serialize;
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use url::Url;

const DEFAULT_PROXY_TEST_TIMEOUT_MS: u64 = 3_000;
const MIN_PROXY_TEST_TIMEOUT_MS: u64 = 500;
const MAX_PROXY_TEST_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub scheme: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub error_code: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedProxyEndpoint {
    scheme: String,
    host: String,
    port: u16,
}

fn error_result(
    parsed: Option<&ParsedProxyEndpoint>,
    error_code: &str,
    detail: Option<String>,
) -> ProxyTestResult {
    ProxyTestResult {
        ok: false,
        latency_ms: None,
        scheme: parsed.map(|item| item.scheme.clone()),
        host: parsed.map(|item| item.host.clone()),
        port: parsed.map(|item| item.port),
        error_code: Some(error_code.to_string()),
        detail,
    }
}

fn parse_proxy_endpoint(raw: &str) -> Result<ParsedProxyEndpoint, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("proxy_url_empty");
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("proxy_url_invalid");
    }
    let parsed = Url::parse(trimmed).map_err(|_| "proxy_url_invalid")?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "socks5" | "socks5h") {
        return Err("proxy_scheme_unsupported");
    }
    let host = parsed
        .host_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("proxy_host_missing")?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = parsed
        .port()
        .or_else(|| match scheme.as_str() {
            "http" => Some(80),
            "https" => Some(443),
            "socks5" | "socks5h" => Some(1080),
            _ => None,
        })
        .ok_or("proxy_url_invalid")?;
    if port == 0 {
        return Err("proxy_url_invalid");
    }
    Ok(ParsedProxyEndpoint { scheme, host, port })
}

async fn test_parsed_endpoint(endpoint: &ParsedProxyEndpoint, timeout: Duration) -> ProxyTestResult {
    let started = Instant::now();
    let connect_future = async {
        if let Ok(ip) = endpoint.host.parse::<std::net::IpAddr>() {
            TcpStream::connect(SocketAddr::new(ip, endpoint.port)).await
        } else {
            TcpStream::connect((endpoint.host.as_str(), endpoint.port)).await
        }
    };

    match tokio::time::timeout(timeout, connect_future).await {
        Ok(Ok(_stream)) => ProxyTestResult {
            ok: true,
            latency_ms: Some(started.elapsed().as_millis() as u64),
            scheme: Some(endpoint.scheme.clone()),
            host: Some(endpoint.host.clone()),
            port: Some(endpoint.port),
            error_code: None,
            detail: None,
        },
        Ok(Err(err)) => {
            let error_code = match err.kind() {
                std::io::ErrorKind::ConnectionRefused => "proxy_connect_refused",
                std::io::ErrorKind::TimedOut => "proxy_connect_timeout",
                _ => "proxy_connect_failed",
            };
            error_result(Some(endpoint), error_code, Some(err.kind().to_string()))
        }
        Err(_) => error_result(Some(endpoint), "proxy_connect_timeout", None),
    }
}

#[tauri::command]
pub async fn proxy_test_connection(
    proxy_url: String,
    timeout_ms: Option<u64>,
) -> Result<ProxyTestResult, String> {
    let endpoint = match parse_proxy_endpoint(&proxy_url) {
        Ok(endpoint) => endpoint,
        Err(code) => return Ok(error_result(None, code, None)),
    };
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_PROXY_TEST_TIMEOUT_MS)
            .clamp(MIN_PROXY_TEST_TIMEOUT_MS, MAX_PROXY_TEST_TIMEOUT_MS),
    );
    Ok(test_parsed_endpoint(&endpoint, timeout).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn validates_proxy_schemes_and_strips_credentials_from_result() {
        let parsed = parse_proxy_endpoint("socks5://alice:secret@127.0.0.1:7897").unwrap();
        assert_eq!(parsed.scheme, "socks5");
        assert_eq!(parsed.host, "127.0.0.1");
        assert_eq!(parsed.port, 7897);

        let ipv6 = parse_proxy_endpoint("http://[::1]:8080").unwrap();
        assert_eq!(ipv6.host, "::1");
        assert_eq!(ipv6.port, 8080);

        assert_eq!(parse_proxy_endpoint("").unwrap_err(), "proxy_url_empty");
        assert_eq!(
            parse_proxy_endpoint("ftp://127.0.0.1:21").unwrap_err(),
            "proxy_scheme_unsupported"
        );
        assert_eq!(
            parse_proxy_endpoint("http://127.0.0.1:7897 bad").unwrap_err(),
            "proxy_url_invalid"
        );
    }

    #[tokio::test]
    async fn reports_reachable_local_listener_without_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://alice:secret@127.0.0.1:{port}");
        let result = proxy_test_connection(url, Some(1500)).await.unwrap();

        assert!(result.ok);
        assert!(result.latency_ms.is_some());
        assert_eq!(result.scheme.as_deref(), Some("http"));
        assert_eq!(result.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(result.port, Some(port));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("alice"));
        assert!(!serialized.contains("secret"));
    }

    #[tokio::test]
    async fn reports_connection_refused_for_closed_port() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let result = proxy_test_connection(format!("http://127.0.0.1:{port}"), Some(1000))
            .await
            .unwrap();
        assert!(!result.ok);
        assert!(matches!(
            result.error_code.as_deref(),
            Some("proxy_connect_refused" | "proxy_connect_failed" | "proxy_connect_timeout")
        ));
    }
}
