use super::*;

#[test]
fn managed_config_preserves_supported_turn_time_boundaries() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());

    for expected in [0, MAX_TURN_TIME_MINS] {
        profile.max_turn_time_mins = expected;
        let config = build_managed_config(
            &profile,
            Path::new(r"C:\Users\test\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
        )
        .unwrap();

        assert_eq!(config.max_turn_time_mins, expected);
    }
}

#[test]
fn managed_config_is_safe() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.max_turn_time_mins = 60;
    let raw = toml::to_string(
        &build_managed_config(
            &profile,
            Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-switch.ps1"),
        )
        .unwrap(),
    )
    .unwrap();
    let value = toml::from_str::<toml::Value>(&raw).unwrap();
    assert_eq!(value["management"]["enabled"].as_bool(), Some(false));
    assert_eq!(value["max_turn_time_mins"].as_integer(), Some(60));
    assert_eq!(value["bridge"]["enabled"].as_bool(), Some(false));
    assert_eq!(value["webhook"]["enabled"].as_bool(), Some(false));
    assert_eq!(
        value["projects"][0]["agent"]["type"].as_str(),
        Some("claudecode")
    );
    assert_eq!(
        value["projects"][0]["agent"]["options"]["mode"].as_str(),
        Some("default")
    );
    let agent_options = value["projects"][0]["agent"]["options"].as_table().unwrap();
    assert!(!agent_options.contains_key("backend"));
    assert!(!agent_options.contains_key("app_server_url"));
    assert_eq!(
        value["projects"][0]["agent"]["options"]["env"][TELEGRAM_TOKEN_ENV].as_str(),
        Some("")
    );
    assert_eq!(
        value["projects"][0]["admin_from"].as_str(),
        Some("123456789")
    );
    let disabled = value["projects"][0]["disabled_commands"]
        .as_array()
        .unwrap();
    assert!(disabled.iter().any(|item| item.as_str() == Some("mode")));
    assert!(disabled.iter().any(|item| item.as_str() == Some("config")));
    assert!(disabled.iter().any(|item| item.as_str() == Some("dir")));
    assert!(disabled.iter().any(|item| item.as_str() == Some("shell")));
    assert!(!disabled.iter().any(|item| item.as_str() == Some("new")));
    assert_eq!(
        value["commands"][0]["name"].as_str(),
        Some("cli_manager_list")
    );
    assert_eq!(
        value["commands"][1]["name"].as_str(),
        Some("cli_manager_switch")
    );
    assert_eq!(value["commands"].as_array().unwrap().len(), 2);
    assert!(value["aliases"].as_array().unwrap().is_empty());
    let switch_exec = value["commands"][1]["exec"].as_str().unwrap();
    assert!(switch_exec.contains("cli-manager-switch.ps1"));
    assert!(switch_exec.contains("$raw=@'\n{{args:}}\n'@"));
    assert!(switch_exec.contains("ToBase64String"));
    assert!(!switch_exec.contains(&path_string(project.path())));
}

#[test]
fn managed_agent_config_maps_all_supported_handoff_agents() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    for (agent, kind, safe_mode, rpc) in [
        (CcConnectAgent::Claude, "claudecode", "default", None),
        (CcConnectAgent::Codex, "codex", "suggest", None),
        (CcConnectAgent::Pi, "pi", "default", Some(true)),
        (CcConnectAgent::Opencode, "opencode", "default", None),
    ] {
        profile.agent = agent;
        let raw = toml::to_string(
            &build_managed_config(
                &profile,
                Path::new(r"C:\Users\test\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            )
            .unwrap(),
        )
        .unwrap();
        let config = toml::from_str::<toml::Value>(&raw).unwrap();
        let managed_agent = &config["projects"][0]["agent"];
        assert_eq!(managed_agent["type"].as_str(), Some(kind));
        assert_eq!(managed_agent["options"]["mode"].as_str(), Some(safe_mode));
        assert_eq!(
            managed_agent["options"]
                .as_table()
                .unwrap()
                .get("rpc")
                .and_then(toml::Value::as_bool),
            rpc
        );
    }
}

#[test]
fn managed_claude_snapshot_uses_structured_cmd_without_persisting_project_secrets() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.agent = CcConnectAgent::Claude;
    let settings_path = Path::new(r"C:\Users\test\.cli-manager\providers\settings.json");
    let mut environment = BTreeMap::new();
    environment.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        "${ANTHROPIC_AUTH_TOKEN}".to_string(),
    );
    let raw = toml::to_string_pretty(
        &build_managed_config_with_agent_launch(
            &profile,
            Path::new(r"C:\Users\test\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            None,
            None,
            Some(settings_path),
            &environment,
        )
        .unwrap(),
    )
    .unwrap();
    let config = toml::from_str::<toml::Value>(&raw).unwrap();
    assert_eq!(
        config["projects"][0]["agent"]["options"]["cmd"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(toml::Value::as_str)
            .collect::<Vec<_>>(),
        vec![
            "claude",
            "--settings",
            "C:/Users/test/.cli-manager/providers/settings.json"
        ]
    );
    assert_eq!(
        config["projects"][0]["agent"]["options"]["env"]["ANTHROPIC_AUTH_TOKEN"].as_str(),
        Some("${ANTHROPIC_AUTH_TOKEN}")
    );
    assert!(!raw.contains("sk-secret"));
}

#[test]
fn pi_and_opencode_project_environment_uses_process_placeholders() {
    let project_dir = tempfile::tempdir().unwrap();
    let mut project = sample_registered_project("pi-project", "Pi", project_dir.path());
    project.agent = CcConnectAgent::Pi;
    project.env_vars = serde_json::json!({
        "PI_API_KEY": "sk-secret",
        "CLI_MANAGER_TAB_ID": "must-not-override",
        "HTTP_PROXY": "http://unmanaged-proxy"
    })
    .to_string();
    let (config, process) = managed_project_environment(&project);
    assert_eq!(
        config.get("PI_API_KEY").map(String::as_str),
        Some("${PI_API_KEY}")
    );
    assert_eq!(
        process,
        vec![("PI_API_KEY".to_string(), "sk-secret".to_string())]
    );
    assert!(!config.contains_key("CLI_MANAGER_TAB_ID"));
    assert!(!config.contains_key("HTTP_PROXY"));

    project.agent = CcConnectAgent::Claude;
    assert_eq!(
        managed_project_environment(&project),
        (BTreeMap::new(), Vec::new())
    );
}

#[test]
fn managed_config_matches_installed_cc_connect_when_requested() {
    let Ok(binary) = std::env::var("CLI_MANAGER_TEST_CC_CONNECT") else {
        return;
    };
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.agent = CcConnectAgent::Codex;
    let config_path = project.path().join("config.toml");
    for (platform, allow_from) in [
        (CcConnectPlatform::Telegram, "123456789"),
        (CcConnectPlatform::Feishu, "ou_owner"),
        (CcConnectPlatform::Weixin, "owner@im.wechat"),
        (CcConnectPlatform::Wecom, "zhangsan"),
    ] {
        profile.platform = platform;
        profile.allow_from = allow_from.to_string();
        let config = build_managed_config(
            &profile,
            Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-switch.ps1"),
        )
        .unwrap();
        fs::write(&config_path, toml::to_string_pretty(&config).unwrap()).unwrap();
        format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
    }
    profile.platforms = vec![
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Telegram,
            enabled: true,
            allow_from: "123456789".to_string(),
        },
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Feishu,
            enabled: true,
            allow_from: "ou_owner".to_string(),
        },
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Weixin,
            enabled: true,
            allow_from: "owner@im.wechat".to_string(),
        },
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Wecom,
            enabled: true,
            allow_from: "zhangsan".to_string(),
        },
    ];
    let config = build_managed_config(
        &profile,
        Path::new(r"C:Users	estAppDataLocalCLI-Managercli-manager-projects.txt"),
        Path::new(r"C:Users	estAppDataLocalCLI-Managercli-manager-switch.ps1"),
    )
    .unwrap();
    fs::write(&config_path, toml::to_string_pretty(&config).unwrap()).unwrap();
    format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
    let launch = sample_remote_codex_launch(true);
    let config = build_managed_config_with_codex(
        &profile,
        Path::new(r"C:\Users\test\cli-manager-projects.txt"),
        Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
        Some(&launch),
    )
    .unwrap();
    fs::write(&config_path, toml::to_string_pretty(&config).unwrap()).unwrap();
    format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
    let formatted = fs::read_to_string(&config_path).unwrap();
    assert!(formatted.contains("${CLI_MANAGER_CODEX_PROVIDER_API_KEY}"));
    assert!(!formatted.contains("sk-provider-secret"));

    for agent in [
        CcConnectAgent::Claude,
        CcConnectAgent::Pi,
        CcConnectAgent::Opencode,
    ] {
        profile.agent = agent;
        let settings_path = project.path().join("claude-settings.json");
        let environment = BTreeMap::from([(
            "AGENT_TEST_TOKEN".to_string(),
            "${AGENT_TEST_TOKEN}".to_string(),
        )]);
        let config = build_managed_config_with_agent_launch(
            &profile,
            Path::new(r"C:\Users\test\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            None,
            None,
            (agent == CcConnectAgent::Claude).then_some(settings_path.as_path()),
            &environment,
        )
        .unwrap();
        fs::write(&config_path, toml::to_string_pretty(&config).unwrap()).unwrap();
        format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
    }

    profile.platforms.clear();
    profile.agent = CcConnectAgent::Codex;
    profile.platform = CcConnectPlatform::Weixin;
    profile.allow_from = "authorization-pending@im.wechat".to_string();
    fs::write(
        &config_path,
        build_weixin_authorization_config(&profile).unwrap(),
    )
    .unwrap();
    format_and_check_config_syntax(Path::new(&binary), &config_path).unwrap();
}
