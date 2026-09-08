use super::*;

#[cfg(unix)]
#[test]
// 验证 Unix PATH 解析跳过托管包装器并选取真实程序。
fn unix_codex_launcher_resolution_skips_the_managed_wrapper() {
    let directory = tempfile::tempdir().unwrap();
    let wrapper_dir = directory.path().join("managed");
    let launcher_dir = directory.path().join("real");
    fs::create_dir_all(&wrapper_dir).unwrap();
    fs::create_dir_all(&launcher_dir).unwrap();
    let wrapper = wrapper_dir.join("codex");
    let launcher = launcher_dir.join("codex");
    write_executable_file_atomically_if_changed(&wrapper, b"#!/bin/sh\nexit 0\n", "wrapper")
        .unwrap();
    write_executable_file_atomically_if_changed(&launcher, b"#!/bin/sh\nexit 0\n", "launcher")
        .unwrap();
    let path_value = env::join_paths([&wrapper_dir, &launcher_dir]).unwrap();

    let resolved = resolve_codex_launcher_from_path(&wrapper_dir, &path_value).unwrap();

    assert_eq!(resolved, launcher.canonicalize().unwrap());
}

#[test]
// 验证 app-server 帮助必须同时声明 stdio 传输。
fn codex_app_server_help_requires_stdio_transport() {
    assert!(codex_app_server_help_supported(
        "Usage: codex app-server [OPTIONS]\n--listen <URL>\n[default: stdio://]"
    ));
    assert!(!codex_app_server_help_supported(
        "Usage: codex app-server [OPTIONS]\n--listen <URL>"
    ));
}

#[test]
// 验证 Codex 配置仅引用 Provider 密钥环境且不持久化秘密。
fn managed_codex_config_forwards_provider_key_without_persisting_secret() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.agent = CcConnectAgent::Codex;
    let launch = sample_remote_codex_launch(true);
    let raw = toml::to_string_pretty(
        &build_managed_config_with_codex(
            &profile,
            Path::new(r"C:\Users\test\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            Some(&launch),
        )
        .unwrap(),
    )
    .unwrap();
    let config = toml::from_str::<toml::Value>(&raw).unwrap();
    let agent = &config["projects"][0]["agent"];
    assert_eq!(agent["options"]["model"].as_str(), Some("gpt-5.4"));
    assert_eq!(
        agent["options"]["codex_home"].as_str(),
        Some("C:/Users/test/.codex")
    );
    assert!(!agent["options"]
        .as_table()
        .unwrap()
        .contains_key("provider"));
    assert!(!agent.as_table().unwrap().contains_key("providers"));
    assert_eq!(
        agent["options"]["env"]["CLI_MANAGER_CODEX_PROVIDER_API_KEY"].as_str(),
        Some("${CLI_MANAGER_CODEX_PROVIDER_API_KEY}")
    );
    for secret in [
        "sk-provider-secret",
        "https://provider.example.com/v1",
        "Project Provider",
    ] {
        assert!(!raw.contains(secret));
    }
}

#[test]
// 验证隔离模型目录包含完整回退能力但不含凭据。
fn codex_model_discovery_catalog_is_isolated_and_contains_no_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let launch = sample_remote_codex_launch(true);
    let provider = launch.provider.as_ref().unwrap();
    write_codex_model_discovery_home(directory.path(), None, provider).unwrap();

    let config = fs::read_to_string(directory.path().join(CONFIG_FILE_NAME)).unwrap();
    let config = toml::from_str::<toml::Value>(&config).unwrap();
    assert_eq!(
        config["model_catalog_json"].as_str(),
        Some(CODEX_MODEL_CATALOG_FILE_NAME)
    );
    let profile = fs::read_to_string(
        directory
            .path()
            .join("cli-manager-project-provider-123.config.toml"),
    )
    .unwrap();
    assert!(profile.contains("service_tier = \"fast\""));
    assert!(!profile.contains("sk-provider-secret"));
    let raw_catalog =
        fs::read_to_string(directory.path().join(CODEX_MODEL_CATALOG_FILE_NAME)).unwrap();
    let catalog = serde_json::from_str::<serde_json::Value>(&raw_catalog).unwrap();
    assert_eq!(catalog["models"][0]["slug"], "gpt-5.4");
    assert_eq!(catalog["models"][1]["slug"], "gpt-5.3-codex");
    assert_eq!(catalog["models"][0]["description"], "Project Provider");
    assert_eq!(catalog["models"][0]["visibility"], "list");
    assert_eq!(catalog["models"][0]["supported_in_api"], true);
    assert_eq!(catalog["models"][0]["default_reasoning_level"], "medium");
    assert!(catalog["models"][0]["supported_reasoning_levels"]
        .as_array()
        .is_some_and(|levels| !levels.is_empty()));
    assert_eq!(catalog["models"][0]["shell_type"], "shell_command");
    assert!(catalog["models"][0]["base_instructions"]
        .as_str()
        .is_some_and(|instructions| !instructions.is_empty()));
    assert_eq!(catalog["models"][0]["input_modalities"][0], "text");
    for secret in [
        "sk-provider-secret",
        "https://provider.example.com/v1",
        "CLI_MANAGER_CODEX_PROVIDER_API_KEY",
    ] {
        assert!(!raw_catalog.contains(secret));
    }
}

#[test]
// 验证模型目录复用临时本机缓存模板的能力字段。
fn codex_model_discovery_reuses_installed_catalog_capabilities() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let mut cached_model = fallback_codex_model_catalog_entry();
    cached_model["slug"] = "gpt-5.4".into();
    cached_model["display_name"] = "gpt-5.4".into();
    cached_model["description"] = "Installed model".into();
    cached_model["base_instructions"] = "installed Codex instructions".into();
    cached_model["context_window"] = 123_456.into();
    fs::write(
        source.path().join(CODEX_MODELS_CACHE_FILE_NAME),
        serde_json::to_vec(&serde_json::json!({ "models": [cached_model] })).unwrap(),
    )
    .unwrap();

    let launch = sample_remote_codex_launch(true);
    let provider = launch.provider.as_ref().unwrap();
    write_codex_model_discovery_home(destination.path(), Some(source.path()), provider).unwrap();
    let catalog = serde_json::from_slice::<serde_json::Value>(
        &fs::read(destination.path().join(CODEX_MODEL_CATALOG_FILE_NAME)).unwrap(),
    )
    .unwrap();

    assert_eq!(catalog["models"][0]["slug"], "gpt-5.4");
    assert_eq!(catalog["models"][1]["slug"], "gpt-5.3-codex");
    assert_eq!(
        catalog["models"][0]["base_instructions"],
        "installed Codex instructions"
    );
    assert_eq!(
        catalog["models"][1]["base_instructions"],
        "installed Codex instructions"
    );
    assert_eq!(catalog["models"][1]["context_window"], 123_456);
    assert_eq!(catalog["models"][0]["priority"], 0);
    assert_eq!(catalog["models"][1]["priority"], 1);
}

#[test]
// 验证模型端点、响应解析、非聊天过滤及去重顺序。
fn codex_model_discovery_parses_filters_and_deduplicates_models() {
    assert_eq!(
        codex_models_endpoint("https://provider.example.com/v1")
            .unwrap()
            .as_str(),
        "https://provider.example.com/v1/models"
    );
    let discovered = parse_codex_models_response(
            br#"{"data":[{"id":"gpt-5.4"},{"id":"text-embedding-3-large"},{"id":"deepseek-r1"},{"model":"gpt-5.3-codex"},{"id":"gpt-5.4"}]}"#,
        );
    assert_eq!(
        normalize_managed_codex_models(Some("gpt-5.4"), discovered),
        vec![
            "gpt-5.4".to_string(),
            "deepseek-r1".to_string(),
            "gpt-5.3-codex".to_string(),
        ]
    );
}

#[cfg(windows)]
#[test]
// 验证启动环境保留真实 Home 和覆盖信息而不内嵌密钥。
fn codex_launch_environment_forces_provider_without_embedding_secrets() {
    let mut command = Command::new("cc-connect");
    let mut launch = sample_remote_codex_launch(true);
    launch.protocol_trace_path = Some(PathBuf::from(
        r"C:\Users\test\.cli-manager\logs\cc-connect.log",
    ));
    apply_remote_codex_launch_environment(&mut command, &launch).unwrap();
    let environment = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().to_string(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        environment.get(CODEX_BASE_URL_OVERRIDE_ENV),
        Some(&Some(
            "model_providers.custom.base_url=https://provider.example.com/v1".to_string()
        ))
    );
    assert_eq!(
        environment.get(CODEX_PROFILE_NAME_ENV),
        Some(&Some("cli-manager-project-provider-123".to_string()))
    );
    assert_eq!(
        environment.get(CODEX_MODEL_PROVIDER_ENV),
        Some(&Some("custom".to_string()))
    );
    assert_eq!(
        environment.get(CODEX_PROVIDER_NAME_OVERRIDE_ENV),
        Some(&Some(
            "model_providers.custom.name=CLI-Manager remote".to_string()
        ))
    );
    assert_eq!(
        environment.get(CODEX_MODEL_OVERRIDE_ENV),
        Some(&Some("model=gpt-5.4".to_string()))
    );
    assert_eq!(
        environment.get("CODEX_HOME"),
        Some(&Some(r"C:\Users\test\.codex".to_string()))
    );
    assert_eq!(
        environment.get(CODEX_MODEL_CATALOG_OVERRIDE_ENV),
        Some(&Some(
            codex_model_catalog_override(launch.discovery_codex_home.as_deref().unwrap()).unwrap()
        ))
    );
    assert_eq!(
        launch.codex_home.as_deref(),
        Some(Path::new(r"C:\Users\test\.codex"))
    );
    assert_eq!(
        environment.get(EXPECTED_SESSION_ID_ENV),
        Some(&Some("thread-original".to_string()))
    );
    assert_eq!(
        environment.get(CODEX_PROTOCOL_TRACE_PATH_ENV),
        Some(&Some(
            r"C:\Users\test\.cli-manager\logs\cc-connect.log".to_string()
        ))
    );
    assert_eq!(
        environment.get(CODEX_LAUNCHER_ARGS_ENV),
        Some(&Some(serde_json::to_string(&launch.launcher_args).unwrap()))
    );
    assert!(!environment
        .values()
        .flatten()
        .any(|value| value == "sk-provider-secret"));
}

#[cfg(windows)]
#[test]
// 验证未选择 Provider 时清除所有旧 Provider 覆盖环境。
fn codex_launch_environment_clears_provider_overrides_when_unregistered() {
    let mut command = Command::new("cc-connect");
    let launch = sample_remote_codex_launch(false);
    apply_remote_codex_launch_environment(&mut command, &launch).unwrap();
    let environment = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().to_string(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for key in [
        CODEX_PROFILE_NAME_ENV,
        CODEX_MODEL_PROVIDER_ENV,
        CODEX_PROVIDER_NAME_OVERRIDE_ENV,
        CODEX_BASE_URL_OVERRIDE_ENV,
        CODEX_ENV_KEY_OVERRIDE_ENV,
        CODEX_MODEL_CATALOG_OVERRIDE_ENV,
        CODEX_MODEL_OVERRIDE_ENV,
        CODEX_WIRE_API_OVERRIDE_ENV,
        CODEX_PROTOCOL_TRACE_PATH_ENV,
    ] {
        assert_eq!(environment.get(key), Some(&None));
    }
    assert_eq!(
        environment.get(CODEX_LAUNCHER_ENV),
        Some(&Some(r"D:\npm\codex.cmd".to_string()))
    );
}

#[cfg(windows)]
#[test]
// 验证空注册启动参数不会写入代理参数环境。
fn codex_launch_environment_omits_empty_registered_launcher_args() {
    let mut command = Command::new("cc-connect");
    let mut launch = sample_remote_codex_launch(false);
    launch.launcher_args.clear();
    apply_remote_codex_launch_environment(&mut command, &launch).unwrap();
    let environment = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().to_string(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(environment.get(CODEX_LAUNCHER_ARGS_ENV), Some(&None));
}

#[cfg(target_os = "windows")]
#[test]
// 验证临时原生代理文件按内容变化复制和更新。
fn native_codex_proxy_is_copied_atomically_and_refreshed() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("cli-manager-codex-proxy.exe");
    let destination = directory.path().join("bin").join("codex.exe");
    fs::write(&source, b"proxy-v1").unwrap();
    copy_file_atomically_if_changed(&source, &destination, "test proxy").unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"proxy-v1");

    fs::write(&source, b"proxy-v2").unwrap();
    copy_file_atomically_if_changed(&source, &destination, "test proxy").unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"proxy-v2");
}

#[test]
// 验证 Provider 启动覆盖拒绝命令注入字符及非 HTTP 端点。
fn codex_app_server_overrides_reject_command_injection_characters() {
    assert_eq!(
        codex_base_url_override("custom", "https://provider.example.com/v1").unwrap(),
        "model_providers.custom.base_url=https://provider.example.com/v1"
    );
    assert!(
        codex_base_url_override("custom", "https://provider.example.com/v1?x=1&whoami").is_err()
    );
    assert!(codex_base_url_override("custom", "file:///tmp/provider").is_err());
    assert!(codex_env_key_override("custom", "OPENAI_API_KEY").is_ok());
    assert!(codex_env_key_override("custom", "OPENAI_API_KEY & whoami").is_err());
    assert_eq!(
        codex_wire_api_override("custom", None).unwrap(),
        "model_providers.custom.wire_api=responses"
    );
    assert_eq!(codex_model_override(None).unwrap(), None);
    assert!(codex_model_override(Some("gpt-5.4\" & whoami")).is_err());
}

#[test]
// 验证 Provider 探测诊断替换明文秘密。
fn codex_provider_probe_reports_startup_errors_without_leaking_secrets() {
    let detail = redact_remote_codex_probe_output(
        &sample_remote_codex_launch(true),
        b"",
        b"provider startup rejected sk-provider-secret",
    );
    assert!(detail.contains("provider startup rejected"));
    assert!(!detail.contains("sk-provider-secret"));
    assert!(detail.contains("[REDACTED]"));
}

#[test]
// 验证仅有托管模型目录时启用严格配置探测参数。
fn codex_provider_probe_uses_strict_config_only_for_managed_catalog() {
    assert_eq!(
        codex_app_server_probe_args(true),
        vec!["app-server", "--strict-config", "--listen", "stdio://"]
    );
    assert_eq!(
        codex_app_server_probe_args(false),
        vec!["app-server", "--listen", "stdio://"]
    );
}

#[test]
// 验证 Codex 默认审批模式以及明确启用的 YOLO 行为。
fn codex_uses_app_server_approvals_and_yolo_is_explicit() {
    let project = tempfile::tempdir().unwrap();
    let render = |profile: &CcConnectProfile| {
        let raw = toml::to_string(
            &build_managed_config(
                profile,
                Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-projects.txt"),
                Path::new(r"C:\Users\test\AppData\Local\CLI-Manager\cli-manager-switch.ps1"),
            )
            .unwrap(),
        )
        .unwrap();
        toml::from_str::<toml::Value>(&raw).unwrap()
    };

    let mut profile = sample_profile(project.path());
    profile.agent = CcConnectAgent::Codex;
    let safe = render(&profile);
    let safe_options = safe["projects"][0]["agent"]["options"].as_table().unwrap();
    assert_eq!(safe_options["mode"].as_str(), Some("suggest"));
    assert_eq!(safe_options["backend"].as_str(), Some("app_server"));
    assert_eq!(safe_options["app_server_url"].as_str(), Some("stdio://"));

    profile.yolo_enabled = true;
    let codex_yolo = render(&profile);
    assert_eq!(
        codex_yolo["projects"][0]["agent"]["options"]["mode"].as_str(),
        Some("yolo")
    );

    profile.agent = CcConnectAgent::Claude;
    let claude_yolo = render(&profile);
    let claude_options = claude_yolo["projects"][0]["agent"]["options"]
        .as_table()
        .unwrap();
    assert_eq!(claude_options["mode"].as_str(), Some("bypassPermissions"));
    assert!(!claude_options.contains_key("backend"));
    assert!(!claude_options.contains_key("app_server_url"));
}

#[cfg(not(target_os = "windows"))]
#[test]
// 验证 Unix 包装器将自定义启动参数转交代理执行。
fn unix_codex_wrapper_routes_registered_launcher_args_through_proxy() {
    let payload = codex_profile_wrapper_payload();
    assert!(payload.contains(&format!("${{{CODEX_LAUNCHER_ARGS_ENV}:-}}")));
    assert_eq!(payload.matches(CODEX_PROXY_SUBCOMMAND).count(), 3);
}

#[test]
// 验证非 Codex Agent 复用结构化启动器并按需加入 Claude 快照。
fn managed_config_reuses_registered_launcher_for_non_codex_agents() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    let launcher = ResolvedAgentLauncher {
        executable: PathBuf::from(r"C:\Tools\claude.cmd"),
        args: vec!["--verbose".to_string()],
    };
    let settings_path = Path::new(r"C:\Users\test\.cli-manager\providers\settings.json");

    profile.agent = CcConnectAgent::Claude;
    let config = build_managed_config_with_agent_launch(
        &profile,
        Path::new(r"C:\Users\test\cli-manager-projects.txt"),
        Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
        None,
        Some(&launcher),
        Some(settings_path),
        &BTreeMap::new(),
    )
    .unwrap();
    let raw = toml::to_string_pretty(&config).unwrap();
    let config = toml::from_str::<toml::Value>(&raw).unwrap();
    assert_eq!(
        config["projects"][0]["agent"]["options"]["cmd"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(toml::Value::as_str)
            .collect::<Vec<_>>(),
        vec![
            "C:/Tools/claude.cmd",
            "--verbose",
            "--settings",
            "C:/Users/test/.cli-manager/providers/settings.json"
        ]
    );

    for agent in [CcConnectAgent::Pi, CcConnectAgent::Opencode] {
        profile.agent = agent;
        let config = build_managed_config_with_agent_launch(
            &profile,
            Path::new(r"C:\Users\test\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
            None,
            Some(&launcher),
            None,
            &BTreeMap::new(),
        )
        .unwrap();
        let raw = toml::to_string_pretty(&config).unwrap();
        let config = toml::from_str::<toml::Value>(&raw).unwrap();
        assert_eq!(
            config["projects"][0]["agent"]["options"]["cmd"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>(),
            vec!["C:/Tools/claude.cmd", "--verbose"]
        );
    }
}
