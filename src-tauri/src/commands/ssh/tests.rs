use super::{
    available_release_preview, build_agent_install_script, build_agent_management_script,
    build_agent_probe_script, effective_ssh_user_command, hook_request, host_key_fingerprint,
    install_action, is_authenticated_log, parse_agent_environment, parse_agent_operation,
    parse_agent_probe_stdout, parse_effective_ssh_user, posix_quote, read_bounded,
    result_from_agent_report, ssh_password_account, ssh_probe_command, validate_agent_hook_report,
    validate_remote_path, validate_spec, AgentDoctorProbe, AgentVersionProbe, ParsedAgentProbe,
    RemoteAgentEnvironment, SshConnectionSpec, MAX_AGENT_HOOK_ENTRIES,
};
use cli_manager_hook_schema::{
    HookConfigChange, HookConfigFile, HookConfigReport, HookHistorySourceCandidate,
    HookInstallationFile, HookInstallationRecord,
};

fn spec() -> SshConnectionSpec {
    SshConnectionSpec {
        host: "example.com".to_string(),
        port: 2222,
        username: "dev".to_string(),
        config_alias: String::new(),
        config_file: String::new(),
        auth_mode: "identity_file".to_string(),
        identity_file: "/home/dev/.ssh/id_ed25519".to_string(),
        credential_ref: String::new(),
        jump_target: "bastion".to_string(),
        proxy_type: "none".to_string(),
        proxy_host: String::new(),
        proxy_port: 0,
        proxy_command: String::new(),
        connect_timeout_sec: 12,
        server_alive_interval_sec: 30,
        server_alive_count_max: 3,
    }
}

#[test]
fn builds_safe_structured_probe_arguments() {
    let spec = spec();
    validate_spec(&spec).unwrap();
    assert_eq!(spec.target(), "dev@example.com");
    let command = ssh_probe_command(&spec, false).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
    assert!(args.windows(2).any(|pair| pair == ["-J", "bastion"]));
    assert!(args.iter().any(|arg| arg == "BatchMode=yes"));
    assert_eq!(args.last().map(String::as_str), Some("true"));
}

#[test]
fn parses_effective_user_from_openssh_config_output() {
    assert_eq!(
        parse_effective_ssh_user(b"host example.com\nuser remote-dev\nport 22\n"),
        Some("remote-dev".to_string())
    );
    assert_eq!(parse_effective_ssh_user(b"hostname example.com\n"), None);
    assert_eq!(parse_effective_ssh_user(b"user\n"), None);
    assert_eq!(parse_effective_ssh_user(b"user root extra\n"), None);
}

#[test]
fn config_alias_user_resolution_uses_openssh_effective_config() {
    let mut value = spec();
    value.host.clear();
    value.username.clear();
    value.config_alias = "production".to_string();
    value.auth_mode = "ssh_config".to_string();
    value.identity_file.clear();
    value.jump_target.clear();
    let command = effective_ssh_user_command(&value).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args, ["-G", "production"]);
}

#[test]
fn direct_address_probe_ignores_the_default_ssh_config() {
    let mut value = spec();
    value.jump_target.clear();
    let command = ssh_probe_command(&value, false).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(args.windows(2).any(|pair| pair == ["-F", "none"]));
}

#[test]
fn agent_probe_script_rejects_unsafe_explicit_paths() {
    assert_eq!(
        build_agent_probe_script(Some("$HOME/agent")).unwrap_err(),
        "ssh_agent_path_invalid"
    );
    assert_eq!(
        build_agent_probe_script(Some("~/../agent")).unwrap_err(),
        "ssh_agent_path_parent_forbidden"
    );
    let script = build_agent_probe_script(Some("~/bin/cli-manager-ssh-agent")).unwrap();
    assert!(script.contains("agent=\"${HOME}\"/'bin/cli-manager-ssh-agent'"));
}

#[test]
fn agent_environment_parser_ignores_only_bounded_banner() {
    let stdout = b"Welcome\nCLI_MANAGER_SSH_AGENT_ENV/1 found\nlinux-aarch64\n/home/dev/.local/share/cli-manager-ssh-agent\n/home/dev/.local/state/cli-manager-ssh-agent\n/home/dev/.local/bin/cli-manager-ssh-agent\n";
    let environment = parse_agent_environment(stdout).unwrap();
    assert_eq!(environment.target, "linux-aarch64");
    assert_eq!(
        environment.install_root,
        "/home/dev/.local/share/cli-manager-ssh-agent"
    );
    assert!(parse_agent_environment(
        b"CLI_MANAGER_SSH_AGENT_ENV/1 found\nlinux-x86_64\nrelative\n/state\n/bin\n"
    )
    .is_err());
}

#[test]
fn agent_install_script_quotes_remote_values() {
    let environment = RemoteAgentEnvironment {
        target: "linux-x86_64".into(),
        install_root: "/home/dev/.local/share/cli-manager-ssh-agent".into(),
        state_dir: "/home/dev/state dir".into(),
        install_path: "/home/dev/.local/bin/cli-manager-ssh-agent".into(),
    };
    let script = build_agent_install_script(
        &environment,
        "/opt/agent root",
        "https://example.com/agent's.json",
        &"a".repeat(64),
        true,
    );
    assert!(script.contains("--install-dir '/opt/agent root'"));
    assert!(script.contains("agent'\\''s.json"));
    assert!(script.contains("--allow-downgrade"));
}

#[test]
fn agent_management_allows_only_fixed_commands() {
    assert!(build_agent_management_script(None, "rollback", false).is_ok());
    assert!(build_agent_management_script(None, "uninstall", true).is_ok());
    assert_eq!(
        build_agent_management_script(None, "shell", false).unwrap_err(),
        "ssh_agent_operation_invalid"
    );
}

#[test]
fn agent_operation_parser_rejects_trailing_output() {
    let report = parse_agent_operation(
        b"banner\nCLI_MANAGER_SSH_AGENT_OPERATION/1 result\n{\"action\":\"uninstalled\",\"installation\":null}\n",
    )
    .unwrap();
    assert_eq!(report.action, "uninstalled");
    assert!(parse_agent_operation(
        b"CLI_MANAGER_SSH_AGENT_OPERATION/1 result\n{\"action\":\"uninstalled\",\"installation\":null}\nnoise"
    )
    .is_err());
    assert!(parse_agent_operation(
        b"CLI_MANAGER_SSH_AGENT_OPERATION/1 forged\n{\"action\":\"uninstalled\",\"installation\":null}\n"
    )
    .is_err());
    assert!(parse_agent_operation(
        b"CLI_MANAGER_SSH_AGENT_OPERATION/1 result\n{\"action\":\"unknown\",\"installation\":null}\n"
    )
    .is_err());
}

#[test]
fn install_preview_uses_semantic_version_order() {
    assert_eq!(install_action(None, "1.0.0"), "install");
    assert_eq!(install_action(Some("1.0.0"), "1.0.1"), "upgrade");
    assert_eq!(install_action(Some("1.0.0"), "1.0.0"), "reinstall");
    assert_eq!(install_action(Some("2.0.0"), "1.0.0"), "downgrade");
}

fn available_release_sample(
    version: &str,
    current_version: Option<&str>,
) -> super::SshAgentAvailableRelease {
    available_release_preview(
        "https://example.com/ssh-agent-release-manifest.json".into(),
        "stable".into(),
        version.into(),
        1,
        11,
        "2026-08-19T00:00:00Z".into(),
        "bundled".into(),
        current_version,
    )
}

#[test]
fn available_release_marks_upgrade_without_remote_target() {
    let preview = available_release_sample("0.1.9", Some("0.1.7"));
    assert_eq!(preview.action, "upgrade");
    assert_eq!(preview.version, "0.1.9");
    assert_eq!(preview.current_version, "0.1.7");
    assert_eq!(preview.distribution_source, "bundled");
}

#[test]
fn available_release_treats_missing_current_as_install() {
    let preview = available_release_sample("0.1.9", None);
    assert_eq!(preview.action, "install");
    assert_eq!(preview.current_version, "");
}

#[test]
fn available_release_does_not_prompt_downgrade_as_upgrade() {
    let preview = available_release_sample("0.1.8", Some("0.1.9"));
    assert_eq!(preview.action, "downgrade");
    assert_ne!(preview.action, "upgrade");
}

#[test]
fn agent_probe_parser_allows_bounded_login_banner() {
    let stdout = b"Welcome to server\nCLI_MANAGER_SSH_AGENT_PROBE/1 found\n/usr/bin/cli-manager-ssh-agent\n{\"version\":{\"agentName\":\"cli-manager-ssh-agent\",\"agentVersion\":\"0.1.0\",\"protocolMajor\":1,\"protocolMinor\":6,\"targetOs\":\"linux\",\"targetArch\":\"x86_64\"},\"supported\":true,\"code\":\"ok\"}\n";
    let ParsedAgentProbe::Report {
        install_path,
        report,
    } = parse_agent_probe_stdout(stdout).unwrap()
    else {
        panic!("expected report");
    };
    assert_eq!(install_path, "/usr/bin/cli-manager-ssh-agent");
    let result = result_from_agent_report(install_path, report);
    assert_eq!(result.status, "installed");
    assert_eq!(result.protocol_version, "1.6");
    assert_eq!(result.target, "linux/x86_64");
}

#[test]
fn agent_probe_parser_rejects_banner_over_limit() {
    let mut stdout = vec![b'x'; super::MAX_AGENT_PROBE_BANNER_BYTES + 1];
    stdout.extend_from_slice(b"CLI_MANAGER_SSH_AGENT_PROBE/1 notInstalled\n");
    assert_eq!(
        parse_agent_probe_stdout(&stdout).unwrap_err(),
        "ssh_agent_probe_banner_too_large"
    );
}

#[test]
fn agent_probe_classifies_protocol_mismatch() {
    let result = result_from_agent_report(
        "/opt/agent".into(),
        AgentDoctorProbe {
            version: AgentVersionProbe {
                agent_name: "cli-manager-ssh-agent".into(),
                agent_version: "2.0.0".into(),
                protocol_major: 2,
                protocol_minor: 0,
                target_os: "linux".into(),
                target_arch: "aarch64".into(),
            },
            supported: true,
            code: "ok".into(),
            installation: None,
        },
    );
    assert_eq!(result.status, "incompatible");
    assert_eq!(result.code, "ssh_agent_protocol_incompatible");
    assert!(!result.supported);
}

#[test]
fn agent_probe_requires_the_bridge_runtime_minor() {
    let result = result_from_agent_report(
        "/opt/agent".into(),
        AgentDoctorProbe {
            version: AgentVersionProbe {
                agent_name: "cli-manager-ssh-agent".into(),
                agent_version: "0.1.0".into(),
                protocol_major: 1,
                protocol_minor: 0,
                target_os: "linux".into(),
                target_arch: "x86_64".into(),
            },
            supported: true,
            code: "ok".into(),
            installation: None,
        },
    );
    assert_eq!(result.status, "incompatible");
    assert_eq!(result.code, "ssh_agent_protocol_incompatible");
    assert!(!result.supported);
}

#[test]
fn agent_probe_does_not_mark_failed_doctor_as_usable() {
    let result = result_from_agent_report(
        "/opt/agent".into(),
        AgentDoctorProbe {
            version: AgentVersionProbe {
                agent_name: "cli-manager-ssh-agent".into(),
                agent_version: "0.1.0".into(),
                protocol_major: 1,
                protocol_minor: 0,
                target_os: "linux".into(),
                target_arch: "x86_64".into(),
            },
            supported: true,
            code: "home_directory_unavailable".into(),
            installation: None,
        },
    );
    assert_eq!(result.status, "corrupt");
    assert_eq!(result.code, "home_directory_unavailable");
    assert!(!result.supported);
}

#[test]
fn bounded_probe_reader_drains_without_growing_past_the_limit() {
    let input = vec![b'x'; 128];
    let (output, truncated) = read_bounded(std::io::Cursor::new(input), 32);
    assert_eq!(output.len(), 32);
    assert!(truncated);
}

#[test]
fn hook_request_validates_expected_canonical_root() {
    let request = hook_request(
        "claude".to_string(),
        "~/.claude".to_string(),
        Some("/home/dev/.claude".to_string()),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(
        request.expected_canonical_root.as_deref(),
        Some("/home/dev/.claude")
    );
    assert_eq!(
        hook_request(
            "claude".to_string(),
            "~/.claude".to_string(),
            Some("/home/dev/../other".to_string()),
            Vec::new(),
        )
        .unwrap_err(),
        "hook_config_root_invalid"
    );
}

#[test]
fn hook_report_must_match_expected_canonical_root() {
    let fingerprint = "a".repeat(64);
    let report = HookConfigReport {
        action: "previewUninstall".to_string(),
        status: "installed".to_string(),
        source: "claude".to_string(),
        installation_id: "00000000-0000-4000-8000-000000000001".to_string(),
        remote_machine_id: "machine".to_string(),
        configured_config_root: "~/.claude".to_string(),
        canonical_config_root: "/home/dev/.claude".to_string(),
        config_root_hash: "b".repeat(64),
        config_root_exists: true,
        will_create_config_root: false,
        config_files: vec![HookConfigFile {
            role: "claudeSettings".to_string(),
            canonical_path: "/home/dev/.claude/settings.json".to_string(),
            fingerprint: fingerprint.clone(),
            exists: true,
        }],
        managed_entries: 12,
        required_entries: 12,
        changes: vec![HookConfigChange {
            role: "claudeSettings".to_string(),
            canonical_path: "/home/dev/.claude/settings.json".to_string(),
            before_fingerprint: fingerprint.clone(),
            after_fingerprint: fingerprint,
            action: "unchanged".to_string(),
        }],
        installation: None,
    };
    assert!(validate_agent_hook_report(
        &report,
        "previewUninstall",
        "claude",
        "00000000-0000-4000-8000-000000000001",
        "machine",
        "~/.claude",
        Some("/home/dev/.claude"),
    )
    .is_ok());
    let mut invalid_count = report.clone();
    invalid_count.required_entries = 0;
    assert_eq!(
        validate_agent_hook_report(
            &invalid_count,
            "previewUninstall",
            "claude",
            "00000000-0000-4000-8000-000000000001",
            "machine",
            "~/.claude",
            Some("/home/dev/.claude"),
        )
        .unwrap_err(),
        "ssh_agent_hook_count_invalid"
    );
    invalid_count.required_entries = MAX_AGENT_HOOK_ENTRIES + 1;
    assert_eq!(
        validate_agent_hook_report(
            &invalid_count,
            "previewUninstall",
            "claude",
            "00000000-0000-4000-8000-000000000001",
            "machine",
            "~/.claude",
            Some("/home/dev/.claude"),
        )
        .unwrap_err(),
        "ssh_agent_hook_count_invalid"
    );
    invalid_count.required_entries = 12;
    invalid_count.managed_entries = 13;
    assert_eq!(
        validate_agent_hook_report(
            &invalid_count,
            "previewUninstall",
            "claude",
            "00000000-0000-4000-8000-000000000001",
            "machine",
            "~/.claude",
            Some("/home/dev/.claude"),
        )
        .unwrap_err(),
        "ssh_agent_hook_count_invalid"
    );
    assert_eq!(
        validate_agent_hook_report(
            &report,
            "previewUninstall",
            "claude",
            "00000000-0000-4000-8000-000000000001",
            "machine",
            "~/.claude",
            Some("/home/dev/other"),
        )
        .unwrap_err(),
        "hook_config_root_changed"
    );
}

#[test]
fn kimi_hook_report_accepts_optional_history_candidate_as_absent() {
    let installation_id = "00000000-0000-4000-8000-000000000001";
    let config_path = "/home/dev/.kimi-code/config.toml";
    let fingerprint = "a".repeat(64);
    let report = HookConfigReport {
        action: "installed".to_string(),
        status: "installed".to_string(),
        source: "kimi".to_string(),
        installation_id: installation_id.to_string(),
        remote_machine_id: "machine".to_string(),
        configured_config_root: "~/.kimi-code".to_string(),
        canonical_config_root: "/home/dev/.kimi-code".to_string(),
        config_root_hash: "b".repeat(64),
        config_root_exists: true,
        will_create_config_root: false,
        config_files: vec![HookConfigFile {
            role: "kimiConfig".to_string(),
            canonical_path: config_path.to_string(),
            fingerprint: fingerprint.clone(),
            exists: true,
        }],
        managed_entries: 9,
        required_entries: 9,
        changes: vec![HookConfigChange {
            role: "kimiConfig".to_string(),
            canonical_path: config_path.to_string(),
            before_fingerprint: "missing".to_string(),
            after_fingerprint: fingerprint.clone(),
            action: "create".to_string(),
        }],
        installation: Some(HookInstallationRecord {
            source: "kimi".to_string(),
            installation_id: installation_id.to_string(),
            owner_id: format!("cli-manager-ssh-agent:{installation_id}"),
            configured_config_root: "~/.kimi-code".to_string(),
            canonical_config_root: "/home/dev/.kimi-code".to_string(),
            config_files: vec![HookInstallationFile {
                role: "kimiConfig".to_string(),
                canonical_path: config_path.to_string(),
                before_fingerprint: "missing".to_string(),
                after_fingerprint: fingerprint,
            }],
            managed_entries: 9,
            adapter_version: 1,
            installed_at: 1,
            history_source_candidate: None,
        }),
    };
    assert!(validate_agent_hook_report(
        &report,
        "installed",
        "kimi",
        installation_id,
        "machine",
        "~/.kimi-code",
        Some("/home/dev/.kimi-code"),
    )
    .is_ok());

    let mut invalid = report;
    invalid
        .installation
        .as_mut()
        .unwrap()
        .history_source_candidate = Some(HookHistorySourceCandidate {
        source: "kimi".to_string(),
        canonical_config_root: "/home/dev/.kimi-code".to_string(),
        config_root_hash: "b".repeat(64),
    });
    assert_eq!(
        validate_agent_hook_report(
            &invalid,
            "installed",
            "kimi",
            installation_id,
            "machine",
            "~/.kimi-code",
            None,
        )
        .unwrap_err(),
        "ssh_agent_hook_record_invalid"
    );
}

#[test]
fn grok_hook_report_accepts_optional_history_candidate_as_absent() {
    let installation_id = "00000000-0000-4000-8000-000000000001";
    let hooks_path = "/home/dev/.grok/hooks/cli-manager.json";
    let config_path = "/home/dev/.grok/config.toml";
    let hooks_fingerprint = "a".repeat(64);
    let config_fingerprint = "c".repeat(64);
    let report = HookConfigReport {
        action: "installed".to_string(),
        status: "installed".to_string(),
        source: "grok".to_string(),
        installation_id: installation_id.to_string(),
        remote_machine_id: "machine".to_string(),
        configured_config_root: "~/.grok".to_string(),
        canonical_config_root: "/home/dev/.grok".to_string(),
        config_root_hash: "b".repeat(64),
        config_root_exists: true,
        will_create_config_root: false,
        config_files: vec![
            HookConfigFile {
                role: "grokHooks".to_string(),
                canonical_path: hooks_path.to_string(),
                fingerprint: hooks_fingerprint.clone(),
                exists: true,
            },
            HookConfigFile {
                role: "grokCompat".to_string(),
                canonical_path: config_path.to_string(),
                fingerprint: config_fingerprint.clone(),
                exists: true,
            },
        ],
        managed_entries: 11,
        required_entries: 11,
        changes: vec![
            HookConfigChange {
                role: "grokHooks".to_string(),
                canonical_path: hooks_path.to_string(),
                before_fingerprint: "missing".to_string(),
                after_fingerprint: hooks_fingerprint.clone(),
                action: "create".to_string(),
            },
            HookConfigChange {
                role: "grokCompat".to_string(),
                canonical_path: config_path.to_string(),
                before_fingerprint: "missing".to_string(),
                after_fingerprint: config_fingerprint.clone(),
                action: "create".to_string(),
            },
        ],
        installation: Some(HookInstallationRecord {
            source: "grok".to_string(),
            installation_id: installation_id.to_string(),
            owner_id: format!("cli-manager-ssh-agent:{installation_id}"),
            configured_config_root: "~/.grok".to_string(),
            canonical_config_root: "/home/dev/.grok".to_string(),
            config_files: vec![
                HookInstallationFile {
                    role: "grokHooks".to_string(),
                    canonical_path: hooks_path.to_string(),
                    before_fingerprint: "missing".to_string(),
                    after_fingerprint: hooks_fingerprint,
                },
                HookInstallationFile {
                    role: "grokCompat".to_string(),
                    canonical_path: config_path.to_string(),
                    before_fingerprint: "missing".to_string(),
                    after_fingerprint: config_fingerprint,
                },
            ],
            managed_entries: 11,
            adapter_version: 1,
            installed_at: 1,
            history_source_candidate: None,
        }),
    };
    validate_agent_hook_report(
        &report,
        "installed",
        "grok",
        installation_id,
        "machine",
        "~/.grok",
        Some("/home/dev/.grok"),
    )
    .unwrap();

    let mut invalid = report.clone();
    invalid
        .installation
        .as_mut()
        .unwrap()
        .history_source_candidate = Some(HookHistorySourceCandidate {
        source: "grok".to_string(),
        canonical_config_root: "/home/dev/.grok".to_string(),
        config_root_hash: "b".repeat(64),
    });
    assert_eq!(
        validate_agent_hook_report(
            &invalid,
            "installed",
            "grok",
            installation_id,
            "machine",
            "~/.grok",
            None,
        )
        .unwrap_err(),
        "ssh_agent_hook_record_invalid"
    );
}

#[test]
fn hook_installation_record_requires_each_config_file_once() {
    let hooks_path = "/home/dev/.codex/hooks.json";
    let feature_path = "/home/dev/.codex/config.toml";
    let hooks_fingerprint = "a".repeat(64);
    let feature_fingerprint = "b".repeat(64);
    let duplicate = HookInstallationFile {
        role: "codexHooks".to_string(),
        canonical_path: hooks_path.to_string(),
        before_fingerprint: "missing".to_string(),
        after_fingerprint: hooks_fingerprint.clone(),
    };
    let report = HookConfigReport {
        action: "installed".to_string(),
        status: "installed".to_string(),
        source: "codex".to_string(),
        installation_id: "00000000-0000-4000-8000-000000000001".to_string(),
        remote_machine_id: "machine".to_string(),
        configured_config_root: "~/.codex".to_string(),
        canonical_config_root: "/home/dev/.codex".to_string(),
        config_root_hash: "c".repeat(64),
        config_root_exists: true,
        will_create_config_root: false,
        config_files: vec![
            HookConfigFile {
                role: "codexHooks".to_string(),
                canonical_path: hooks_path.to_string(),
                fingerprint: hooks_fingerprint.clone(),
                exists: true,
            },
            HookConfigFile {
                role: "codexFeature".to_string(),
                canonical_path: feature_path.to_string(),
                fingerprint: feature_fingerprint.clone(),
                exists: true,
            },
        ],
        managed_entries: 7,
        required_entries: 7,
        changes: vec![
            HookConfigChange {
                role: "codexHooks".to_string(),
                canonical_path: hooks_path.to_string(),
                before_fingerprint: "missing".to_string(),
                after_fingerprint: hooks_fingerprint,
                action: "create".to_string(),
            },
            HookConfigChange {
                role: "codexFeature".to_string(),
                canonical_path: feature_path.to_string(),
                before_fingerprint: "missing".to_string(),
                after_fingerprint: feature_fingerprint,
                action: "create".to_string(),
            },
        ],
        installation: Some(HookInstallationRecord {
            source: "codex".to_string(),
            installation_id: "00000000-0000-4000-8000-000000000001".to_string(),
            owner_id: "cli-manager-ssh-agent:00000000-0000-4000-8000-000000000001".to_string(),
            configured_config_root: "~/.codex".to_string(),
            canonical_config_root: "/home/dev/.codex".to_string(),
            config_files: vec![duplicate.clone(), duplicate],
            managed_entries: 7,
            adapter_version: 1,
            installed_at: 1,
            history_source_candidate: Some(HookHistorySourceCandidate {
                source: "codex".to_string(),
                canonical_config_root: "/home/dev/.codex".to_string(),
                config_root_hash: "c".repeat(64),
            }),
        }),
    };
    assert_eq!(
        validate_agent_hook_report(
            &report,
            "installed",
            "codex",
            "00000000-0000-4000-8000-000000000001",
            "machine",
            "~/.codex",
            None,
        )
        .unwrap_err(),
        "ssh_agent_hook_record_invalid"
    );
}

#[test]
fn config_alias_owns_address_and_port_resolution() {
    let mut spec = spec();
    spec.config_alias = "gpu-dev".to_string();
    spec.host.clear();
    spec.port = 0;
    spec.auth_mode = "ssh_config".to_string();
    validate_spec(&spec).unwrap();
    assert_eq!(spec.target(), "gpu-dev");
    let command = ssh_probe_command(&spec, false).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(!args.iter().any(|arg| arg == "-p"));
    assert!(!args.iter().any(|arg| arg == "-i"));
}

#[test]
fn custom_config_file_is_forwarded_to_probe() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    let mut spec = spec();
    spec.config_alias = "gpu-dev".to_string();
    spec.config_file = temp.path().to_string_lossy().into_owned();
    spec.auth_mode = "ssh_config".to_string();

    validate_spec(&spec).unwrap();
    let command = ssh_probe_command(&spec, false).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();

    assert!(args
        .windows(2)
        .any(|pair| pair == ["-F", spec.config_file.as_str()]));
}

#[test]
fn missing_custom_config_file_is_rejected() {
    let mut spec = spec();
    spec.config_file = std::env::temp_dir()
        .join("cli-manager-missing-ssh-config")
        .to_string_lossy()
        .into_owned();

    assert_eq!(
        validate_spec(&spec).unwrap_err(),
        "ssh_config_file_not_found"
    );
}

#[test]
fn quotes_remote_paths_and_rejects_parent_traversal() {
    assert_eq!(posix_quote("/srv/team's app"), "'/srv/team'\\''s app'");
    assert_eq!(validate_remote_path("/srv/app").unwrap(), "/srv/app");
    assert!(validate_remote_path("srv/app").is_err());
    assert!(validate_remote_path("/srv/../etc").is_err());
}

#[test]
fn password_probe_does_not_include_stale_identity_file() {
    let mut spec = spec();
    spec.auth_mode = "password_prompt".to_string();
    let command = ssh_probe_command(&spec, false).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(!args.iter().any(|arg| arg == "-i"));
    assert!(args
        .iter()
        .any(|arg| arg == "PreferredAuthentications=password,keyboard-interactive"));
    assert!(args.iter().any(|arg| arg == "NumberOfPasswordPrompts=1"));
}

#[test]
fn interactive_probe_does_not_include_stale_identity_file() {
    let mut spec = spec();
    spec.auth_mode = "interactive".to_string();
    let command = ssh_probe_command(&spec, false).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(!args.iter().any(|arg| arg == "-i"));
    assert!(args
        .iter()
        .any(|arg| arg == "PreferredAuthentications=keyboard-interactive"));
}

#[test]
fn credential_account_is_scoped_to_valid_host_uuid() {
    assert_eq!(
        ssh_password_account("550e8400-e29b-41d4-a716-446655440000").unwrap(),
        "ssh:550e8400-e29b-41d4-a716-446655440000:password"
    );
    assert!(ssh_password_account("../webdav").is_err());
}

#[test]
fn accept_new_probe_never_disables_changed_host_protection() {
    let command = ssh_probe_command(&spec(), true).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-o", "StrictHostKeyChecking=accept-new"]));
    assert!(!args.iter().any(|arg| arg == "StrictHostKeyChecking=no"));
}

#[test]
fn extracts_server_host_key_fingerprint_from_verbose_output() {
    let stderr = "debug1: Connecting\ndebug1: Server host key: ssh-ed25519 SHA256:abc123";
    assert_eq!(
        host_key_fingerprint(stderr).as_deref(),
        Some("ssh-ed25519 SHA256:abc123")
    );
}

#[test]
fn detects_openssh_authenticated_verbose_output() {
    assert!(is_authenticated_log(
        "debug1: Authenticated to example.com ([203.0.113.10]:22) using \"password\"."
    ));
    assert!(!is_authenticated_log(
        "debug1: Authentication succeeded (password)."
    ));
}
