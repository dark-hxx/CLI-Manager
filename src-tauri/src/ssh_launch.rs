use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshLaunchPlan {
    pub host_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub config_alias: String,
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
    pub remote_path: String,
    #[serde(default)]
    pub environment_overrides: HashMap<String, String>,
    #[serde(default)]
    pub initialization_command: Option<String>,
    pub startup_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshProcessLaunch {
    pub executable: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

impl SshLaunchPlan {
    pub fn build_process_launch(&self) -> Result<SshProcessLaunch, String> {
        self.validate()?;
        let mut args = vec![
            "-tt".to_string(),
            "-o".to_string(),
            format!("ConnectTimeout={}", self.connect_timeout_sec),
            "-o".to_string(),
            format!("ServerAliveInterval={}", self.server_alive_interval_sec),
            "-o".to_string(),
            format!("ServerAliveCountMax={}", self.server_alive_count_max),
        ];
        if self.config_alias.trim().is_empty() {
            args.extend(["-p".to_string(), self.port.to_string()]);
        }
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
            "password_prompt" | "credential_ref" => args.extend([
                "-o".to_string(),
                "PubkeyAuthentication=no".to_string(),
                "-o".to_string(),
                "PasswordAuthentication=yes".to_string(),
                "-o".to_string(),
                "KbdInteractiveAuthentication=yes".to_string(),
                "-o".to_string(),
                "PreferredAuthentications=password,keyboard-interactive".to_string(),
            ]),
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
        args.push(self.target());
        args.push(self.remote_command());
        let env = if self.auth_mode == "credential_ref" {
            crate::ssh_askpass::prepare(&self.credential_ref)?
        } else {
            HashMap::new()
        };
        Ok(SshProcessLaunch {
            executable: "ssh".to_string(),
            args,
            env,
        })
    }

    fn validate(&self) -> Result<(), String> {
        if self.host_id.trim().is_empty() {
            return Err("ssh_host_not_found".to_string());
        }
        if self.config_alias.trim().is_empty() && self.host.trim().is_empty() {
            return Err("ssh_host_address_required".to_string());
        }
        if self.config_alias.trim().is_empty() && self.port == 0 {
            return Err("ssh_host_port_invalid".to_string());
        }
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
        validate_remote_path(&self.remote_path)?;
        if self
            .environment_overrides
            .keys()
            .any(|key| !is_valid_environment_key(key))
        {
            return Err("ssh_environment_key_invalid".to_string());
        }
        for key in ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] {
            if let Some(value) = self.environment_overrides.get(key) {
                validate_tool_config_root(value)?;
            }
        }
        if self
            .environment_overrides
            .values()
            .any(|value| value.contains('\0'))
        {
            return Err("ssh_environment_value_invalid".to_string());
        }
        if self
            .initialization_command
            .as_deref()
            .is_some_and(|command| command.contains('\0'))
            || self
                .startup_command
                .as_deref()
                .is_some_and(|command| command.contains('\0'))
        {
            return Err("ssh_startup_command_invalid".to_string());
        }
        Ok(())
    }

    fn target(&self) -> String {
        if !self.config_alias.trim().is_empty() {
            return self.config_alias.trim().to_string();
        }
        if self.username.trim().is_empty() {
            self.host.trim().to_string()
        } else {
            format!("{}@{}", self.username.trim(), self.host.trim())
        }
    }

    fn remote_command(&self) -> String {
        let mut setup = vec![
            format!("cd -- {}", posix_quote(self.remote_path.trim())),
            "printf '\\033]777;cli-manager-ssh=connected\\007'".to_string(),
        ];
        let mut environment: Vec<_> = self.environment_overrides.iter().collect();
        environment.sort_by(|left, right| left.0.cmp(right.0));
        setup.extend(environment.into_iter().map(|(key, value)| {
            let formatted_value = if matches!(key.as_str(), "CLAUDE_CONFIG_DIR" | "CODEX_HOME") {
                format_tool_config_root(value)
            } else {
                posix_quote(value)
            };
            format!("export {key}={formatted_value}")
        }));
        let setup = setup.join(" && ");
        let mut shell_commands = Vec::new();
        if let Some(command) = self
            .initialization_command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            shell_commands.push(command);
        }
        if let Some(command) = self
            .startup_command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            shell_commands.push(command);
        }
        if shell_commands.is_empty() {
            format!("{setup} && exec \"${{SHELL:-/bin/sh}}\" -l")
        } else {
            let mut command_then_shell = shell_commands.join("\n");
            command_then_shell.push_str("\nexec \"${SHELL:-/bin/sh}\" -i");
            format!(
                "{setup} && exec \"${{SHELL:-/bin/sh}}\" -lic {}",
                posix_quote(&command_then_shell)
            )
        }
    }
}

fn validate_single_line(value: &str) -> Result<(), String> {
    if value.contains(['\0', '\r', '\n']) {
        return Err("ssh_launch_argument_invalid".to_string());
    }
    Ok(())
}

fn validate_remote_path(path: &str) -> Result<(), String> {
    let path = path.trim();
    if !path.starts_with('/') || path.contains(['\0', '\r', '\n']) {
        return Err("ssh_remote_path_invalid".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("ssh_remote_path_parent_forbidden".to_string());
    }
    Ok(())
}

fn validate_tool_config_root(path: &str) -> Result<(), String> {
    if path.contains(['\0', '\r', '\n', '\\', '$', '`'])
        || !(path.starts_with('/') || path == "~" || path.starts_with("~/"))
    {
        return Err("ssh_tool_config_root_invalid".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("ssh_tool_config_root_parent_forbidden".to_string());
    }
    Ok(())
}

fn format_tool_config_root(path: &str) -> String {
    if path == "~" {
        return "\"${HOME}\"".to_string();
    }
    if let Some(suffix) = path.strip_prefix("~/") {
        return format!("\"${{HOME}}\"/{}", posix_quote(suffix));
    }
    posix_quote(path)
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_valid_environment_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|ch| matches!(ch, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
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
    use super::SshLaunchPlan;

    fn plan() -> SshLaunchPlan {
        SshLaunchPlan {
            host_id: "host-1".into(),
            host: "example.com".into(),
            port: 2222,
            username: "dev".into(),
            config_alias: String::new(),
            auth_mode: "identity_file".into(),
            identity_file: "C:/Users/dev/.ssh/id key".into(),
            credential_ref: String::new(),
            jump_target: "bastion".into(),
            proxy_type: "none".into(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_command: String::new(),
            connect_timeout_sec: 15,
            server_alive_interval_sec: 30,
            server_alive_count_max: 3,
            remote_path: "/srv/project name/开发".into(),
            environment_overrides: [("APP_MODE".to_string(), "remote dev".to_string())].into(),
            initialization_command: None,
            startup_command: Some("printf '%s\\n' \"it's ready\"".into()),
        }
    }

    #[test]
    fn builds_structured_ssh_arguments_and_quotes_remote_values() {
        let launch = plan().build_process_launch().unwrap();
        assert_eq!(launch.executable, "ssh");
        assert!(launch.args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(launch
            .args
            .windows(2)
            .any(|pair| pair == ["-i", "C:/Users/dev/.ssh/id key"]));
        assert!(launch.args.windows(2).any(|pair| pair == ["-J", "bastion"]));
        assert!(launch.args.iter().any(|arg| arg == "IdentitiesOnly=yes"));
        assert_eq!(launch.args[launch.args.len() - 2], "dev@example.com");
        assert_eq!(launch.args.last().unwrap(), "cd -- '/srv/project name/开发' && printf '\\033]777;cli-manager-ssh=connected\\007' && export APP_MODE='remote dev' && exec \"${SHELL:-/bin/sh}\" -lic 'printf '\\''%s\\n'\\'' \"it'\\''s ready\"\nexec \"${SHELL:-/bin/sh}\" -i'");
    }

    #[test]
    fn startup_command_returns_to_interactive_shell_without_second_login() {
        let command = plan().remote_command();
        assert!(command.contains("exec \"${SHELL:-/bin/sh}\" -lic"));
        assert!(command.contains("\nexec \"${SHELL:-/bin/sh}\" -i"));
        assert!(!command.contains("\nexec \"${SHELL:-/bin/sh}\" -l"));
    }

    #[test]
    fn config_alias_owns_host_and_port_resolution() {
        let mut value = plan();
        value.config_alias = "prod".into();
        value.host.clear();
        value.port = 0;
        value.auth_mode = "ssh_config".into();
        let launch = value.build_process_launch().unwrap();
        assert!(!launch.args.iter().any(|arg| arg == "-p"));
        assert!(!launch.args.iter().any(|arg| arg == "-i"));
        assert_eq!(launch.args[launch.args.len() - 2], "prod");
    }

    #[test]
    fn interactive_shell_is_started_when_no_startup_command_exists() {
        let mut value = plan();
        value.startup_command = None;
        assert_eq!(value.build_process_launch().unwrap().args.last().unwrap(), "cd -- '/srv/project name/开发' && printf '\\033]777;cli-manager-ssh=connected\\007' && export APP_MODE='remote dev' && exec \"${SHELL:-/bin/sh}\" -l");
    }

    #[test]
    fn tool_config_roots_are_exported_with_safe_home_expansion() {
        let mut value = plan();
        value.environment_overrides = [
            (
                "CLAUDE_CONFIG_DIR".to_string(),
                "~/claude state".to_string(),
            ),
            ("CODEX_HOME".to_string(), "/srv/codex state".to_string()),
        ]
        .into();
        let command = value.build_process_launch().unwrap().args.pop().unwrap();
        assert!(command.contains("export CLAUDE_CONFIG_DIR=\"${HOME}\"/'claude state'"));
        assert!(command.contains("export CODEX_HOME='/srv/codex state'"));
    }

    #[test]
    fn tool_config_root_accepts_home_itself() {
        let mut value = plan();
        value.environment_overrides = [("CODEX_HOME".to_string(), "~".to_string())].into();
        let command = value.build_process_launch().unwrap().args.pop().unwrap();
        assert!(command.contains("export CODEX_HOME=\"${HOME}\""));
    }

    #[test]
    fn tool_config_root_rejects_traversal_and_shell_expansion() {
        for invalid in [
            "~/../secret",
            "$HOME/.claude",
            "~/bad`command",
            "relative/path",
            "~/bad\\path",
            "~/bad\npath",
            "~/bad\rpath",
            "~/bad\0path",
        ] {
            let mut value = plan();
            value.environment_overrides =
                [("CLAUDE_CONFIG_DIR".to_string(), invalid.to_string())].into();
            assert!(matches!(
                value.build_process_launch().unwrap_err().as_str(),
                "ssh_tool_config_root_invalid" | "ssh_tool_config_root_parent_forbidden"
            ));
        }
    }

    #[test]
    fn direct_proxy_takes_precedence_over_jump_host() {
        let mut value = plan();
        value.proxy_type = "socks5".into();
        value.proxy_host = "127.0.0.1".into();
        value.proxy_port = 1080;
        let launch = value.build_process_launch().unwrap();
        assert!(!launch.args.iter().any(|arg| arg == "-J"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg.contains("ProxyCommand=") && arg.contains("__ssh_proxy --type socks5")));
    }

    #[test]
    fn rejects_parent_traversal_and_multiline_arguments() {
        let mut value = plan();
        value.remote_path = "/srv/../root".into();
        assert_eq!(
            value.build_process_launch().unwrap_err(),
            "ssh_remote_path_parent_forbidden"
        );
        let mut value = plan();
        value.jump_target = "host\n-o BatchMode=yes".into();
        assert_eq!(
            value.build_process_launch().unwrap_err(),
            "ssh_launch_argument_invalid"
        );
    }

    #[test]
    fn password_mode_supports_password_and_keyboard_interactive() {
        let mut value = plan();
        value.auth_mode = "password_prompt".into();
        let launch = value.build_process_launch().unwrap();
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "PubkeyAuthentication=no"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "KbdInteractiveAuthentication=yes"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "PreferredAuthentications=password,keyboard-interactive"));
        assert!(!launch.args.iter().any(|arg| arg == "-i"));
    }

    #[test]
    fn interactive_mode_does_not_use_stale_identity_file() {
        let mut value = plan();
        value.auth_mode = "interactive".into();
        let launch = value.build_process_launch().unwrap();
        assert!(!launch.args.iter().any(|arg| arg == "-i"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "PreferredAuthentications=keyboard-interactive"));
    }

    #[test]
    fn agent_mode_does_not_use_stale_identity_file() {
        let mut value = plan();
        value.auth_mode = "agent".into();
        let launch = value.build_process_launch().unwrap();
        assert!(!launch.args.iter().any(|arg| arg == "-i"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "PreferredAuthentications=publickey"));
    }
}
