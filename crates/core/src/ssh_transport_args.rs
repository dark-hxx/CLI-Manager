/// 生成连接参数需要的只读配置，不包含凭据或宿主资源。
pub struct ConnectionOptions<'a> {
    pub config_file: &'a str,
    pub config_alias: &'a str,
    pub jump_target: &'a str,
    pub auth_mode: &'a str,
    pub port: u16,
    pub connect_timeout_sec: u64,
    pub server_alive_interval_sec: u64,
    pub server_alive_count_max: u32,
}

impl ConnectionOptions<'_> {
    /// 追加连接参数；调用方负责预先校验配置，此处不访问文件或网络。
    pub fn append_args(&self, args: &mut Vec<String>, one_shot: bool) {
        if !self.config_file.trim().is_empty() {
            args.extend(["-F".to_string(), self.config_file.trim().to_string()]);
        } else if self.config_alias.trim().is_empty()
            && self.jump_target.trim().is_empty()
            && matches!(
                self.auth_mode,
                "identity_file" | "password_prompt" | "credential_ref" | "interactive"
            )
        {
            // Agent 和 ssh_config 模式需要保留默认配置中的 IdentityAgent、Host * 等设置。
            args.extend(["-F".to_string(), "none".to_string()]);
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
}

/// 优先采用 SSH Config alias，否则生成去除首尾空白的 user@host 或 host。
pub fn connection_target(config_alias: &str, username: &str, host: &str) -> String {
    if !config_alias.trim().is_empty() {
        return config_alias.trim().to_string();
    }
    if username.trim().is_empty() {
        host.trim().to_string()
    } else {
        format!("{}@{}", username.trim(), host.trim())
    }
}

/// 仅生成认证参数；不读取凭据、启动 broker 或访问进程环境。
pub fn append_auth_args(
    args: &mut Vec<String>,
    auth_mode: &str,
    identity_file: &str,
    one_shot: bool,
) {
    if auth_mode == "identity_file" && !identity_file.trim().is_empty() {
        args.extend(["-i".to_string(), identity_file.trim().to_string()]);
    }
    let options: &[&str] = match auth_mode {
        "agent" => &[
            "PubkeyAuthentication=yes",
            "PreferredAuthentications=publickey",
        ],
        "identity_file" => &["IdentitiesOnly=yes", "PreferredAuthentications=publickey"],
        "password_prompt" | "credential_ref" => &[
            "PubkeyAuthentication=no",
            "PasswordAuthentication=yes",
            "KbdInteractiveAuthentication=yes",
            "PreferredAuthentications=password,keyboard-interactive",
        ],
        "interactive" => &[
            "PubkeyAuthentication=no",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=yes",
            "PreferredAuthentications=keyboard-interactive",
        ],
        _ => &[],
    };
    for option in options {
        args.extend(["-o".to_string(), (*option).to_string()]);
    }
    if one_shot && matches!(auth_mode, "password_prompt" | "credential_ref") {
        args.extend(["-o".to_string(), "NumberOfPasswordPrompts=1".to_string()]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_selection_respects_alias_jump_and_authentication_mode() {
        for mode in [
            "ssh_config",
            "agent",
            "identity_file",
            "password_prompt",
            "credential_ref",
            "interactive",
        ] {
            for alias in [" ", " prod "] {
                for jump in [" ", " bastion "] {
                    for config in [" ", " /config with spaces "] {
                        let options = ConnectionOptions {
                            config_file: config,
                            config_alias: alias,
                            jump_target: jump,
                            auth_mode: mode,
                            port: 2222,
                            connect_timeout_sec: 12,
                            server_alive_interval_sec: 30,
                            server_alive_count_max: 3,
                        };
                        let mut args = vec![];
                        options.append_args(&mut args, false);
                        let expected_config = if !config.trim().is_empty() {
                            Some("/config with spaces")
                        } else if alias.trim().is_empty()
                            && jump.trim().is_empty()
                            && !matches!(mode, "ssh_config" | "agent")
                        {
                            Some("none")
                        } else {
                            None
                        };
                        let actual_config = args
                            .windows(2)
                            .find(|pair| pair[0] == "-F")
                            .map(|pair| pair[1].as_str());
                        assert_eq!(
                            actual_config, expected_config,
                            "{mode} {alias} {jump} {config}"
                        );
                        assert_eq!(args.iter().any(|arg| arg == "-p"), alias.trim().is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn preserves_connection_option_order_and_one_shot_retry_limit() {
        let options = ConnectionOptions {
            config_file: "",
            config_alias: "",
            jump_target: "",
            auth_mode: "agent",
            port: 2222,
            connect_timeout_sec: 12,
            server_alive_interval_sec: 30,
            server_alive_count_max: 3,
        };
        for one_shot in [false, true] {
            let mut args = vec!["prefix".to_string()];
            options.append_args(&mut args, one_shot);
            let mut expected = vec![
                "prefix",
                "-o",
                "ConnectTimeout=12",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
            ];
            if one_shot {
                expected.extend(["-o", "ConnectionAttempts=1"]);
            }
            expected.extend(["-p", "2222"]);
            assert_eq!(args, expected);
        }
    }

    #[test]
    fn target_prefers_alias_and_trims_address_parts() {
        assert_eq!(connection_target(" prod ", " stale ", "old"), "prod");
        assert_eq!(connection_target(" ", " dev ", " host "), "dev@host");
        assert_eq!(connection_target("", " ", " host "), "host");
    }

    #[test]
    fn only_identity_mode_uses_the_supplied_key() {
        for mode in [
            "ssh_config",
            "agent",
            "password_prompt",
            "credential_ref",
            "interactive",
        ] {
            let mut args = vec![];
            append_auth_args(&mut args, mode, " stale key ", false);
            assert!(!args.iter().any(|arg| arg == "-i"), "mode={mode}");
        }
        let mut args = vec![];
        append_auth_args(&mut args, "identity_file", " /key with space ", false);
        assert_eq!(&args[..2], ["-i", "/key with space"]);
    }

    #[test]
    fn single_prompt_is_limited_to_one_shot_password_modes() {
        for mode in [
            "ssh_config",
            "agent",
            "identity_file",
            "password_prompt",
            "credential_ref",
            "interactive",
        ] {
            for one_shot in [false, true] {
                let mut args = vec![];
                append_auth_args(&mut args, mode, "", one_shot);
                assert_eq!(
                    args.iter().any(|arg| arg == "NumberOfPasswordPrompts=1"),
                    one_shot && matches!(mode, "password_prompt" | "credential_ref"),
                    "mode={mode} one_shot={one_shot}"
                );
                assert_eq!(args.len() % 2, 0);
            }
        }
    }
}
