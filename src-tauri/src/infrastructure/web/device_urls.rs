//! Web device and public browser URL validation and normalization.
//! The explicit trusted-network opt-in is shared by desktop and daemon callers.

use std::net::IpAddr;

#[cfg(test)]
fn normalize_server_url(raw: &str) -> Result<String, String> {
    normalize_device_url(raw, false)
}

pub(crate) fn normalize_device_url(raw: &str, trusted_network: bool) -> Result<String, String> {
    let parsed = reqwest::Url::parse(raw.trim()).map_err(|_| "invalid web device server URL")?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("web device URL must not contain credentials, query, or fragment".into());
    }
    let uri = raw
        .trim()
        .parse::<tungstenite::http::Uri>()
        .map_err(|_| "invalid web device server URL".to_string())?;
    let scheme = uri
        .scheme_str()
        .ok_or_else(|| "web device server URL requires a scheme".to_string())?;
    let host = uri
        .host()
        .ok_or_else(|| "web device server URL requires a host".to_string())?;
    let secure = matches!(scheme, "https" | "wss");
    if !secure && !matches!(scheme, "http" | "ws") {
        return Err("web device server URL must use http, https, ws, or wss".into());
    }
    if !secure && !is_loopback_host(host) && !trusted_network {
        return Err("remote web device server must use TLS".into());
    }
    let authority = uri
        .authority()
        .ok_or_else(|| "web device server URL requires an authority".to_string())?;
    Ok(format!(
        "{}://{}/ws/device",
        if secure { "wss" } else { "ws" },
        authority
    ))
}

pub(crate) fn normalize_public_url(raw: &str, trusted_network: bool) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Ok(String::new());
    }
    let mut url = reqwest::Url::parse(raw.trim()).map_err(|_| "invalid public access URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "public access URL must be an HTTP(S) origin without credentials or path".into(),
        );
    }
    if url.scheme() == "http" && !is_loopback_host(url.host_str().unwrap_or("")) && !trusted_network
    {
        return Err("public access URL requires HTTPS or explicit trusted network mode".into());
    }
    url.set_path("/");
    Ok(url.to_string())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_network_requires_explicit_opt_in_for_ip_and_domain() {
        for endpoint in [
            "http://192.168.1.20:9090",
            "ws://100.95.251.17:9090",
            "http://desktop.internal:9090",
            "http://[fd00::1]:9090",
        ] {
            assert!(normalize_device_url(endpoint, false).is_err(), "{endpoint}");
            assert!(normalize_device_url(endpoint, true)
                .unwrap()
                .ends_with("/ws/device"));
        }
        assert_eq!(
            normalize_device_url("http://[::1]:9090", false).unwrap(),
            "ws://[::1]:9090/ws/device"
        );
        assert_eq!(
            normalize_device_url("https://cli.example.com", false).unwrap(),
            "wss://cli.example.com/ws/device"
        );
        for endpoint in [
            "ftp://example.com",
            "http://user:secret@example.com",
            "http://example.com?token=secret",
            "http://example.com/#secret",
        ] {
            assert!(normalize_device_url(endpoint, true).is_err());
        }
    }

    #[test]
    fn public_browser_origin_is_independent_and_bounded() {
        assert_eq!(
            normalize_public_url("https://cli.example.com", false).unwrap(),
            "https://cli.example.com/"
        );
        assert_eq!(
            normalize_public_url("http://desktop.internal:9090", true).unwrap(),
            "http://desktop.internal:9090/"
        );
        assert!(normalize_public_url("http://desktop.internal:9090", false).is_err());
        for endpoint in [
            "ws://example.com",
            "https://example.com/path",
            "https://example.com?x=1",
            "https://user:pass@example.com",
            "https://example.com/#secret",
        ] {
            assert!(normalize_public_url(endpoint, true).is_err());
        }
        assert_eq!(normalize_public_url("", false).unwrap(), "");
    }

    #[test]
    fn remote_plaintext_urls_are_rejected() {
        assert_eq!(
            normalize_server_url("http://localhost:8787").unwrap(),
            "ws://localhost:8787/ws/device"
        );
        assert!(normalize_server_url("http://example.com").is_err());
        assert_eq!(
            normalize_server_url("https://example.com").unwrap(),
            "wss://example.com/ws/device"
        );
    }
}
