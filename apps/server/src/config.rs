use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_path: PathBuf,
    pub web_dist: PathBuf,
    pub admin_username: String,
    pub admin_password: String,
    pub cookie_secure: bool,
    pub allowed_origin: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let bind = std::env::var("CLI_MANAGER_WEB_BIND")
            .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
            .parse()
            .map_err(|err| format!("invalid CLI_MANAGER_WEB_BIND: {err}"))?;
        let data_dir = std::env::var_os("CLI_MANAGER_WEB_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("./data"));
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
        let config = Self {
            bind,
            database_path: data_dir.join("cli-manager-web.db"),
            web_dist,
            admin_username,
            admin_password,
            cookie_secure,
            allowed_origin,
        };
        if !config.bind.ip().is_loopback() && !config.cookie_secure {
            return Err(
                "CLI_MANAGER_COOKIE_SECURE must be enabled when binding outside loopback"
                    .to_string(),
            );
        }
        Ok(config)
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
            allowed_origin: None,
        }
    }
}
