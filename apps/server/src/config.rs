use std::net::SocketAddr;
use std::path::PathBuf;

use serde::Deserialize;

const DEFAULT_BIND: &str = "127.0.0.1:8787";
const BIND_ENV: &str = "CLI_MANAGER_WEB_BIND";
const PORT_ENV: &str = "CLI_MANAGER_WEB_PORT";
const BIND_FILE_ENV: &str = "CLI_MANAGER_WEB_BIND_FILE";
const DEFAULT_BIND_FILE: &str = "web-server.toml";

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    bind: Option<String>,
    port: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_path: PathBuf,
    pub web_dist: PathBuf,
    pub admin_username: String,
    pub admin_password: String,
    pub cookie_secure: bool,
    pub trusted_network: bool,
    pub allowed_origin: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let data_dir = std::env::var_os("CLI_MANAGER_WEB_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("./data"));
        let file_config = load_file_config(&data_dir)?;
        let bind = resolve_bind(&file_config, std::env::args_os())?;
        let web_dist = std::env::var_os("CLI_MANAGER_WEB_DIST")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/dist"));
        let admin_username =
            std::env::var("CLI_MANAGER_ADMIN_USERNAME").unwrap_or_else(|_| "admin".to_string());
        let admin_password = std::env::var("CLI_MANAGER_ADMIN_PASSWORD").map_err(|_| {
            "CLI_MANAGER_ADMIN_PASSWORD is required; no default password is provided".to_string()
        })?;
        let cookie_secure = std::env::var("CLI_MANAGER_COOKIE_SECURE")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let allowed_origin = std::env::var("CLI_MANAGER_WEB_ALLOWED_ORIGIN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let mut config = Self {
            bind,
            database_path: data_dir.join("cli-manager-web.db"),
            web_dist,
            admin_username,
            admin_password,
            cookie_secure,
            trusted_network: std::env::var("CLI_MANAGER_WEB_TRUSTED_NETWORK")
                .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
            allowed_origin,
        };
        config.validate_network()?;
        Ok(config)
    }

    /// Configured browser origin is authoritative, including behind TLS proxies.
    /// Client-provided forwarding headers never establish transport trust.
    pub fn validate_network(&mut self) -> Result<(), String> {
        if let Some(origin) = self.allowed_origin.as_mut() {
            let uri: axum::http::Uri = origin.trim().parse()
                .map_err(|_| "invalid Web browser origin".to_string())?;
            let scheme = uri.scheme_str().unwrap_or("");
            let authority = uri.authority().ok_or("Web browser origin requires a host")?;
            if !matches!(scheme, "http" | "https") || authority.as_str().contains('@')
                || uri.query().is_some() || !matches!(uri.path(), "" | "/") {
                return Err("Web browser origin must be an HTTP(S) origin without credentials, path or query".into());
            }
            let host = authority.host().trim_matches(['[', ']']);
            let loopback = host.eq_ignore_ascii_case("localhost")
                || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
            if scheme == "http" && !loopback && !self.trusted_network {
                return Err("HTTP browser access outside loopback requires trusted network mode".into());
            }
            self.cookie_secure = scheme == "https";
            *origin = format!("{scheme}://{authority}");
        }
        if !self.bind.ip().is_loopback() && self.allowed_origin.is_none() {
            return Err("An exact Web browser origin is required when listening outside loopback".into());
        }
        if !self.bind.ip().is_loopback() && !self.cookie_secure && !self.trusted_network {
            return Err("Listening outside loopback requires HTTPS or explicit trusted network mode".into());
        }
        Ok(())
    }

    pub fn allows_browser_origin(&self, origin: &str, host: Option<&str>) -> bool {
        if let Some(allowed) = self.allowed_origin.as_deref() {
            origin == allowed
        } else {
            let scheme = if self.cookie_secure { "https" } else { "http" };
            host.is_some_and(|host| origin == format!("{scheme}://{host}"))
        }
    }

    #[cfg(test)]
    fn from_sources<I, S>(
        args: I,
        env_bind: Option<&str>,
        env_port: Option<&str>,
        file: Option<FileConfig>,
    ) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: Into<std::ffi::OsString>,
    {
        let args = collect_args(args);
        let bind = resolve_bind_from_values(&args, env_bind, env_port, file.as_ref())?;
        Ok(Self {
            bind,
            database_path: PathBuf::from("./data/cli-manager-web.db"),
            web_dist: PathBuf::from("web/dist"),
            admin_username: "admin".to_string(),
            admin_password: "test-password".to_string(),
            cookie_secure: false,
            trusted_network: false,
            allowed_origin: None,
        })
    }

    #[cfg(test)]
    pub fn test(database_path: PathBuf) -> Self {
        Self {
            bind: SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0),
            database_path,
            web_dist: PathBuf::from("missing-dist"),
            admin_username: "admin".to_string(),
            admin_password: "test-password".to_string(),
            cookie_secure: false,
            trusted_network: false,
            allowed_origin: None,
        }
    }
}

fn load_file_config(data_dir: &PathBuf) -> Result<Option<FileConfig>, String> {
    let path = std::env::var_os(BIND_FILE_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join(DEFAULT_BIND_FILE));
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("read Web server config failed ({}): {err}", path.display()))?;
    toml::from_str(&text)
        .map(Some)
        .map_err(|err| format!("parse Web server config failed ({}): {err}", path.display()))
}

fn resolve_bind<I, S>(file_config: &Option<FileConfig>, args: I) -> Result<SocketAddr, String>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    let args = collect_args(args);
    resolve_bind_from_values(
        &args,
        std::env::var(BIND_ENV).ok().as_deref(),
        std::env::var(PORT_ENV).ok().as_deref(),
        file_config.as_ref(),
    )
}

fn resolve_bind_from_values(
    args: &[String],
    env_bind: Option<&str>,
    env_port: Option<&str>,
    file_config: Option<&FileConfig>,
) -> Result<SocketAddr, String> {
    let cli = parse_cli_bind(args)?;
    let cli_port = cli_port(args)?;
    let base = cli
        .as_deref()
        .or(env_bind)
        .or_else(|| file_config.and_then(|config| config.bind.as_deref()))
        .unwrap_or(DEFAULT_BIND);
    let mut address = base
        .parse::<SocketAddr>()
        .map_err(|err| format!("invalid Web server bind address '{base}': {err}"))?;
    // A full `--bind host:port` value is already the highest-precedence
    // address. Do not let a lower-precedence environment/file port replace
    // the port the caller explicitly supplied in that address.
    let port = if cli_port.is_some() {
        cli_port
    } else if cli.is_some() {
        None
    } else if let Some(value) = env_port {
        Some(parse_port(value)?)
    } else if env_bind.is_some() {
        None
    } else {
        file_config.and_then(|config| config.port)
    };
    if let Some(port) = port {
        if port == 0 {
            return Err("Web server port must be between 1 and 65535".to_string());
        }
        address.set_port(port);
    }
    Ok(address)
}

fn collect_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    args.into_iter()
        .map(Into::into)
        .map(|value| value.to_string_lossy().into_owned())
        .collect()
}

fn parse_cli_bind(values: &[String]) -> Result<Option<String>, String> {
    let mut bind = None;
    let mut index = 1;
    while index < values.len() {
        match values[index].as_str() {
            "--bind" => {
                let value = values
                    .get(index + 1)
                    .ok_or_else(|| "--bind requires host:port".to_string())?;
                bind = Some(value.clone());
                index += 2;
            }
            value if value.starts_with("--bind=") => {
                let bind_value = value.trim_start_matches("--bind=").trim();
                if bind_value.is_empty() {
                    return Err("--bind requires host:port".to_string());
                }
                bind = Some(bind_value.to_string());
                index += 1;
            }
            _ => index += 1,
        }
    }
    Ok(bind)
}

fn cli_port(values: &[String]) -> Result<Option<u16>, String> {
    let mut port = None;
    let mut index = 1;
    while index < values.len() {
        let value = match values[index].as_str() {
            "--port" => {
                let next = values
                    .get(index + 1)
                    .ok_or_else(|| "--port requires a number".to_string())?;
                index += 2;
                Some(next.clone())
            }
            value if value.starts_with("--port=") => {
                let next = value.trim_start_matches("--port=").to_string();
                index += 1;
                Some(next)
            }
            _ => {
                index += 1;
                None
            }
        };
        if let Some(value) = value {
            let parsed = value
                .parse::<u16>()
                .map_err(|_| format!("invalid Web server port '{value}'"))?;
            if parsed == 0 {
                return Err("Web server port must be between 1 and 65535".to_string());
            }
            port = Some(parsed);
        }
    }
    Ok(port)
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| format!("invalid Web server port '{value}'"))?;
    if port == 0 {
        return Err("Web server port must be between 1 and 65535".to_string());
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_http_requires_explicit_opt_in_and_exact_origin() {
        for origin in ["http://192.168.1.5:9090", "http://100.95.251.17:9090",
            "http://cli.internal:9090", "http://[fd00::5]:9090"] {
            let mut config = Config::test("unused.db".into());
            config.bind = "0.0.0.0:9090".parse().unwrap();
            config.allowed_origin = Some(origin.into());
            assert!(config.validate_network().is_err());
            config.trusted_network = true;
            config.validate_network().unwrap();
            assert!(!config.cookie_secure);
            assert!(config.allows_browser_origin(origin, Some("127.0.0.1:9090")));
            assert!(!config.allows_browser_origin("http://evil.example", Some("evil.example")));
        }
        let mut config = Config::test("unused.db".into());
        config.bind = "0.0.0.0:9090".parse().unwrap();
        config.trusted_network = true;
        assert!(config.validate_network().is_err());
    }

    #[test]
    fn public_https_sets_secure_cookie_even_with_loopback_upstream() {
        let mut config = Config::test("unused.db".into());
        config.allowed_origin = Some("https://cli.example.com/".into());
        config.validate_network().unwrap();
        assert!(config.cookie_secure);
        assert_eq!(config.allowed_origin.as_deref(), Some("https://cli.example.com"));
        assert!(config.allows_browser_origin("https://cli.example.com", Some("127.0.0.1:9090")));
        assert!(!config.allows_browser_origin("http://cli.example.com", Some("cli.example.com")));
    }

    #[test]
    fn origin_rejects_credentials_paths_and_non_http_schemes() {
        for origin in ["https://user:password@cli.example.com", "https://cli.example.com/app",
            "https://cli.example.com/?q=1", "*", "ws://cli.example.com"] {
            let mut config = Config::test("unused.db".into());
            config.allowed_origin = Some(origin.into());
            assert!(config.validate_network().is_err(), "{origin}");
        }
    }

    fn args(values: &[&str]) -> Vec<std::ffi::OsString> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn defaults_to_loopback_port() {
        let config = Config::from_sources(args(&["server"]), None, None, None).unwrap();
        assert_eq!(config.bind, "127.0.0.1:8787".parse().unwrap());
    }

    #[test]
    fn environment_overrides_file_and_default() {
        let file = FileConfig {
            bind: Some("127.0.0.1:9000".into()),
            port: None,
        };
        let config =
            Config::from_sources(args(&["server"]), Some("127.0.0.1:9001"), None, Some(file))
                .unwrap();
        assert_eq!(config.bind, "127.0.0.1:9001".parse().unwrap());
    }

    #[test]
    fn file_port_overrides_default_without_replacing_bind_host() {
        let file = FileConfig {
            bind: Some("0.0.0.0:8787".into()),
            port: Some(9010),
        };
        let config = Config::from_sources(args(&["server"]), None, None, Some(file)).unwrap();
        assert_eq!(config.bind, "0.0.0.0:9010".parse().unwrap());
    }

    #[test]
    fn cli_port_overrides_environment_port() {
        let config = Config::from_sources(
            args(&["server", "--port=9200"]),
            Some("127.0.0.1:9001"),
            Some("9002"),
            None,
        )
        .unwrap();
        assert_eq!(config.bind, "127.0.0.1:9200".parse().unwrap());
    }

    #[test]
    fn cli_overrides_environment_and_port_keeps_host() {
        let config = Config::from_sources(
            args(&["server", "--bind", "0.0.0.0:9100", "--port", "9200"]),
            Some("127.0.0.1:9001"),
            Some("9002"),
            None,
        )
        .unwrap();
        assert_eq!(config.bind, "0.0.0.0:9200".parse().unwrap());
    }

    #[test]
    fn full_cli_bind_is_not_overridden_by_lower_precedence_port() {
        let config = Config::from_sources(
            args(&["server", "--bind", "0.0.0.0:9100"]),
            Some("127.0.0.1:9001"),
            Some("9002"),
            Some(FileConfig {
                bind: Some("127.0.0.1:9003".into()),
                port: Some(9004),
            }),
        )
        .unwrap();
        assert_eq!(config.bind, "0.0.0.0:9100".parse().unwrap());
    }

    #[test]
    fn full_environment_bind_is_not_overridden_by_file_port() {
        let config = Config::from_sources(
            args(&["server"]),
            Some("127.0.0.1:9100"),
            None,
            Some(FileConfig {
                bind: Some("127.0.0.1:9003".into()),
                port: Some(9004),
            }),
        )
        .unwrap();
        assert_eq!(config.bind, "127.0.0.1:9100".parse().unwrap());
    }

    #[test]
    fn invalid_port_is_rejected() {
        assert!(Config::from_sources(args(&["server"]), None, Some("0"), None).is_err());
        assert!(
            Config::from_sources(args(&["server", "--port", "nope"]), None, None, None).is_err()
        );
    }
}
