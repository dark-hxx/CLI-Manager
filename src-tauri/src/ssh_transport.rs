use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTransportSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub config_alias: String,
    #[serde(default)]
    pub config_file: String,
    pub auth_mode: String,
    pub identity_file: String,
    #[serde(default)]
    pub credential_ref: String,
    pub jump_target: String,
    #[serde(default)]
    pub proxy_type: String,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_command: String,
    pub connect_timeout_sec: u64,
    pub server_alive_interval_sec: u64,
    pub server_alive_count_max: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SshOneShotOptions {
    pub verbose: bool,
    pub accept_new_host_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTransportLaunch {
    pub executable: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshRemoteHomePathError {
    Invalid,
    ParentTraversal,
}

pub fn validate_remote_home_path(path: &str) -> Result<(), SshRemoteHomePathError> {
    if path.contains(['\0', '\r', '\n', '\\', '$', '`'])
        || !(path.starts_with('/') || path == "~" || path.starts_with("~/"))
    {
        return Err(SshRemoteHomePathError::Invalid);
    }
    if path.split('/').any(|part| part == "..") {
        return Err(SshRemoteHomePathError::ParentTraversal);
    }
    Ok(())
}

pub fn format_remote_home_path(path: &str) -> String {
    if path == "~" {
        return "\"${HOME}\"".to_string();
    }
    if let Some(suffix) = path.strip_prefix("~/") {
        return format!("\"${{HOME}}\"/{}", posix_quote(suffix));
    }
    posix_quote(path)
}

pub fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl SshTransportSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.config_alias.trim().is_empty() && self.host.trim().is_empty() {
            return Err("ssh_host_address_required".to_string());
        }
        if self.config_alias.trim().is_empty() && self.port == 0 {
            return Err("ssh_host_port_invalid".to_string());
        }
        validate_config_file(&self.config_file)?;
        if self.connect_timeout_sec == 0 || self.connect_timeout_sec > 300 {
            return Err("ssh_connect_timeout_invalid".to_string());
        }
        if self.server_alive_count_max > 100 {
            return Err("ssh_server_alive_count_invalid".to_string());
        }
        if !matches!(
            self.auth_mode.as_str(),
            "ssh_config"
                | "agent"
                | "identity_file"
                | "password_prompt"
                | "interactive"
                | "credential_ref"
        ) {
            return Err("ssh_auth_mode_invalid".to_string());
        }
        if self.auth_mode == "identity_file" && self.identity_file.trim().is_empty() {
            return Err("ssh_identity_file_required".to_string());
        }
        if self.auth_mode == "credential_ref" && self.credential_ref.trim().is_empty() {
            return Err("ssh_credential_ref_required".to_string());
        }
        for value in [
            &self.config_alias,
            &self.config_file,
            &self.host,
            &self.username,
            &self.identity_file,
            &self.credential_ref,
            &self.jump_target,
            &self.proxy_type,
            &self.proxy_host,
            &self.proxy_command,
        ] {
            validate_single_line(value)?;
        }
        if contains_url_credentials(&self.proxy_command) {
            return Err("ssh_proxy_credentials_forbidden".to_string());
        }
        crate::ssh_proxy::build_proxy_command(
            &self.proxy_type,
            &self.proxy_host,
            self.proxy_port,
            &self.proxy_command,
        )?;
        Ok(())
    }

    pub fn target(&self) -> String {
        if !self.config_alias.trim().is_empty() {
            return self.config_alias.trim().to_string();
        }
        if self.username.trim().is_empty() {
            self.host.trim().to_string()
        } else {
            format!("{}@{}", self.username.trim(), self.host.trim())
        }
    }

    pub fn build_interactive_launch(
        &self,
        remote_command: String,
    ) -> Result<SshTransportLaunch, String> {
        self.validate()?;
        let mut args = vec!["-tt".to_string()];
        self.append_connection_args(&mut args, false);
        self.append_auth_args(&mut args, false);
        self.append_route_args(&mut args)?;
        args.push(self.target());
        args.push(remote_command);
        Ok(SshTransportLaunch {
            executable: "ssh".to_string(),
            args,
            env: self.askpass_environment()?,
        })
    }

    pub fn build_one_shot_launch(
        &self,
        remote_command: String,
        options: SshOneShotOptions,
    ) -> Result<SshTransportLaunch, String> {
        self.validate()?;
        let mut args = vec!["-T".to_string()];
        if options.verbose {
            args.push("-v".to_string());
        }
        if options.accept_new_host_key {
            args.extend([
                "-o".to_string(),
                "StrictHostKeyChecking=accept-new".to_string(),
            ]);
        }
        args.extend([
            "-o".to_string(),
            if self.auth_mode == "credential_ref" {
                "BatchMode=no".to_string()
            } else {
                "BatchMode=yes".to_string()
            },
        ]);
        self.append_connection_args(&mut args, true);
        self.append_auth_args(&mut args, true);
        self.append_route_args(&mut args)?;
        args.push(self.target());
        args.push(remote_command);
        Ok(SshTransportLaunch {
            executable: "ssh".to_string(),
            args,
            env: self.askpass_environment()?,
        })
    }

    fn append_connection_args(&self, args: &mut Vec<String>, one_shot: bool) {
        if !self.config_file.trim().is_empty() {
            args.extend(["-F".to_string(), self.config_file.trim().to_string()]);
        }
        args.extend([
            "-o".to_string(),
            format!("ConnectTimeout={}", self.connect_timeout_sec),
            "-o".to_string(),
            format!("ServerAliveInterval={}", self.server_alive_interval_sec),
            "-o".to_string(),
            format!("ServerAliveCountMax={}", self.server_alive_count_max),
        ]);
        if one_shot {
            args.extend(["-o".to_string(), "ConnectionAttempts=1".to_string()]);
        }
        if self.config_alias.trim().is_empty() {
            args.extend(["-p".to_string(), self.port.to_string()]);
        }
    }

    fn append_auth_args(&self, args: &mut Vec<String>, one_shot: bool) {
        if self.auth_mode == "identity_file" && !self.identity_file.trim().is_empty() {
            args.extend(["-i".to_string(), self.identity_file.trim().to_string()]);
        }
        match self.auth_mode.as_str() {
            "agent" => args.extend([
                "-o".to_string(),
                "PubkeyAuthentication=yes".to_string(),
                "-o".to_string(),
                "PreferredAuthentications=publickey".to_string(),
            ]),
            "identity_file" => args.extend([
                "-o".to_string(),
                "IdentitiesOnly=yes".to_string(),
                "-o".to_string(),
                "PreferredAuthentications=publickey".to_string(),
            ]),
            "password_prompt" | "credential_ref" => {
                args.extend([
                    "-o".to_string(),
                    "PubkeyAuthentication=no".to_string(),
                    "-o".to_string(),
                    "PasswordAuthentication=yes".to_string(),
                    "-o".to_string(),
                    "KbdInteractiveAuthentication=yes".to_string(),
                    "-o".to_string(),
                    "PreferredAuthentications=password,keyboard-interactive".to_string(),
                ]);
                if one_shot {
                    args.extend(["-o".to_string(), "NumberOfPasswordPrompts=1".to_string()]);
                }
            }
            "interactive" => args.extend([
                "-o".to_string(),
                "PubkeyAuthentication=no".to_string(),
                "-o".to_string(),
                "PasswordAuthentication=no".to_string(),
                "-o".to_string(),
                "KbdInteractiveAuthentication=yes".to_string(),
                "-o".to_string(),
                "PreferredAuthentications=keyboard-interactive".to_string(),
            ]),
            _ => {}
        }
    }

    fn append_route_args(&self, args: &mut Vec<String>) -> Result<(), String> {
        let proxy_command = crate::ssh_proxy::build_proxy_command(
            &self.proxy_type,
            &self.proxy_host,
            self.proxy_port,
            &self.proxy_command,
        )?;
        if proxy_command.is_empty() && !self.jump_target.trim().is_empty() {
            args.extend(["-J".to_string(), self.jump_target.trim().to_string()]);
        }
        if !proxy_command.is_empty() {
            args.extend(["-o".to_string(), format!("ProxyCommand={proxy_command}")]);
        }
        Ok(())
    }

    fn askpass_environment(&self) -> Result<HashMap<String, String>, String> {
        if self.auth_mode == "credential_ref" {
            crate::ssh_askpass::prepare(&self.credential_ref)
        } else {
            Ok(HashMap::new())
        }
    }
}

fn validate_single_line(value: &str) -> Result<(), String> {
    if value.contains(['\0', '\r', '\n']) {
        return Err("ssh_launch_argument_invalid".to_string());
    }
    Ok(())
}

fn validate_config_file(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.contains(['\0', '\r', '\n']) || !std::path::Path::new(trimmed).is_absolute() {
        return Err("ssh_config_file_invalid".to_string());
    }
    if !std::path::Path::new(trimmed).is_file() {
        return Err("ssh_config_file_not_found".to_string());
    }
    Ok(())
}

fn contains_url_credentials(value: &str) -> bool {
    value.split_whitespace().any(|token| {
        let Some((_, remainder)) = token.split_once("://") else {
            return false;
        };
        let authority = remainder.split('/').next().unwrap_or(remainder);
        authority
            .split_once('@')
            .is_some_and(|(userinfo, _)| userinfo.contains(':'))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        format_remote_home_path, validate_remote_home_path, SshOneShotOptions,
        SshRemoteHomePathError, SshTransportSpec,
    };

    fn spec(auth_mode: &str) -> SshTransportSpec {
        SshTransportSpec {
            host: "example.com".into(),
            port: 2222,
            username: "dev".into(),
            config_alias: String::new(),
            config_file: String::new(),
            auth_mode: auth_mode.into(),
            identity_file: "/home/dev/.ssh/id key".into(),
            credential_ref: String::new(),
            jump_target: "bastion".into(),
            proxy_type: "none".into(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_command: String::new(),
            connect_timeout_sec: 12,
            server_alive_interval_sec: 30,
            server_alive_count_max: 3,
        }
    }

    #[test]
    fn interactive_and_one_shot_share_connection_routing() {
        let value = spec("identity_file");
        let interactive = value.build_interactive_launch("shell".into()).unwrap();
        let one_shot = value
            .build_one_shot_launch("true".into(), SshOneShotOptions::default())
            .unwrap();
        for expected in [
            "ConnectTimeout=12",
            "ServerAliveInterval=30",
            "-J",
            "bastion",
        ] {
            assert!(interactive.args.iter().any(|arg| arg == expected));
            assert!(one_shot.args.iter().any(|arg| arg == expected));
        }
        assert_eq!(interactive.args.first().map(String::as_str), Some("-tt"));
        assert_eq!(one_shot.args.first().map(String::as_str), Some("-T"));
        assert!(one_shot
            .args
            .iter()
            .any(|arg| arg == "ConnectionAttempts=1"));
    }

    #[test]
    fn auth_modes_do_not_leak_stale_identity_arguments() {
        for mode in ["ssh_config", "agent", "password_prompt", "interactive"] {
            let launch = spec(mode).build_interactive_launch("shell".into()).unwrap();
            assert!(!launch.args.iter().any(|arg| arg == "-i"), "mode={mode}");
        }
        let identity = spec("identity_file")
            .build_interactive_launch("shell".into())
            .unwrap();
        assert!(identity.args.iter().any(|arg| arg == "-i"));
    }

    #[test]
    fn credential_mode_uses_password_auth_and_one_prompt() {
        let mut value = spec("credential_ref");
        assert_eq!(value.validate().unwrap_err(), "ssh_credential_ref_required");
        value.credential_ref = "credential-ref".into();
        let mut args = Vec::new();
        value.append_auth_args(&mut args, true);
        assert!(args.iter().any(|arg| arg == "PasswordAuthentication=yes"));
        assert!(args
            .iter()
            .any(|arg| arg == "KbdInteractiveAuthentication=yes"));
        assert!(args.iter().any(|arg| arg == "NumberOfPasswordPrompts=1"));
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-i").count(), 0);
    }

    #[test]
    fn config_alias_owns_host_and_port_resolution() {
        let mut value = spec("ssh_config");
        value.config_alias = "prod".into();
        value.host.clear();
        value.port = 0;
        let launch = value
            .build_one_shot_launch("true".into(), SshOneShotOptions::default())
            .unwrap();
        assert!(!launch.args.iter().any(|arg| arg == "-p"));
        assert_eq!(launch.args[launch.args.len() - 2], "prod");
    }

    #[test]
    fn custom_config_file_is_shared_by_interactive_and_one_shot_launches() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let mut value = spec("ssh_config");
        value.config_file = temp.path().to_string_lossy().into_owned();
        for launch in [
            value.build_interactive_launch("shell".into()).unwrap(),
            value
                .build_one_shot_launch("true".into(), SshOneShotOptions::default())
                .unwrap(),
        ] {
            assert!(launch
                .args
                .windows(2)
                .any(|pair| pair == ["-F", value.config_file.as_str()]));
        }
    }

    #[test]
    fn direct_proxy_takes_precedence_over_jump_host() {
        let mut value = spec("agent");
        value.proxy_type = "socks5".into();
        value.proxy_host = "127.0.0.1".into();
        value.proxy_port = 1080;
        let launch = value
            .build_one_shot_launch("true".into(), SshOneShotOptions::default())
            .unwrap();
        assert!(!launch.args.iter().any(|arg| arg == "-J"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg.contains("ProxyCommand=") && arg.contains("__ssh_proxy --type socks5")));
    }

    #[test]
    fn remote_home_paths_expand_only_the_supported_shorthand() {
        assert_eq!(format_remote_home_path("~"), "\"${HOME}\"");
        assert_eq!(
            format_remote_home_path("~/agent path"),
            "\"${HOME}\"/'agent path'"
        );
        assert_eq!(format_remote_home_path("/opt/agent"), "'/opt/agent'");
        assert_eq!(
            validate_remote_home_path("~/../secret"),
            Err(SshRemoteHomePathError::ParentTraversal)
        );
        assert_eq!(
            validate_remote_home_path("$HOME/agent"),
            Err(SshRemoteHomePathError::Invalid)
        );
    }
}
