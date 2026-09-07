use super::*;

pub(super) fn sample_profile(project_path: &Path) -> CcConnectProfile {
    CcConnectProfile {
        auto_start: false,
        executable_path: None,
        project_id: "project-1".to_string(),
        project_name: "Example".to_string(),
        project_path: path_string(project_path),
        agent: CcConnectAgent::Claude,
        runtime_project_id: None,
        platform: CcConnectPlatform::Telegram,
        allow_from: "123456789".to_string(),
        platforms: Vec::new(),
        yolo_enabled: false,
        max_turn_time_mins: DEFAULT_MAX_TURN_TIME_MINS,
        proxy_enabled: true,
        proxy_url: None,
        logging_enabled: false,
        language: CcConnectLanguage::Zh,
        cc_switch_db_path: None,
        codex_config_dir: None,
    }
}

pub(super) fn sample_registered_project(
    id: &str,
    name: &str,
    project_path: &Path,
) -> RegisteredProject {
    RegisteredProject {
        id: id.to_string(),
        name: name.to_string(),
        path: path_string(project_path),
        agent: CcConnectAgent::Claude,
        cli_tool: "claude".to_string(),
        cli_args: String::new(),
        group_path: Vec::new(),
        provider_id: None,
        codex_provider_id: None,
        provider_name: None,
        provider_is_global: true,
        environment_type: "local".to_string(),
        ssh_host_id: None,
        remote_path: String::new(),
        cli_config_root: String::new(),
        env_vars: "{}".to_string(),
    }
}

pub(super) fn sample_group(
    id: &str,
    name: &str,
    parent_id: Option<&str>,
    sort_order: i64,
) -> RegisteredGroup {
    RegisteredGroup {
        id: id.to_string(),
        name: name.to_string(),
        parent_id: parent_id.map(str::to_string),
        sort_order,
    }
}

pub(super) fn sample_project_row(
    id: &str,
    name: &str,
    project_path: &Path,
    agent: CcConnectAgent,
    group_id: Option<&str>,
    sort_order: i64,
    provider_overrides: &str,
) -> RegisteredProjectRow {
    RegisteredProjectRow {
        id: id.to_string(),
        name: name.to_string(),
        path: path_string(project_path),
        agent,
        cli_tool: default_agent_command(agent).to_string(),
        cli_args: String::new(),
        group_id: group_id.map(str::to_string),
        sort_order,
        provider_overrides: provider_overrides.to_string(),
        environment_type: "local".to_string(),
        ssh_host_id: None,
        remote_path: String::new(),
        cli_config_root: String::new(),
        host_codex_config_root: String::new(),
        env_vars: "{}".to_string(),
    }
}

pub(super) fn sample_remote_codex_launch(provider: bool) -> RemoteCodexLaunch {
    let provider = provider.then(|| RemoteCodexProviderLaunch {
            name: "Project Provider".to_string(),
            profile_name: "cli-manager-project-provider-123".to_string(),
            profile_text: "model_provider = \"custom\"\nservice_tier = \"fast\"\n\n[model_providers.custom]\nname = \"Project Provider\"\nbase_url = \"https://provider.example.com/v1\"\nenv_key = \"CLI_MANAGER_CODEX_PROVIDER_API_KEY\"\nwire_api = \"responses\"\n".to_string(),
            model_provider: "custom".to_string(),
            provider_name_override: "model_providers.custom.name=CLI-Manager remote".to_string(),
            model: Some("gpt-5.4".to_string()),
            models: vec!["gpt-5.4".to_string(), "gpt-5.3-codex".to_string()],
            base_url_override: "model_providers.custom.base_url=https://provider.example.com/v1"
                .to_string(),
            env_key_override: "model_providers.custom.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY"
                .to_string(),
            model_override: Some("model=gpt-5.4".to_string()),
            wire_api_override: "model_providers.custom.wire_api=responses".to_string(),
            env_key: "CLI_MANAGER_CODEX_PROVIDER_API_KEY".to_string(),
            secret: "sk-provider-secret".to_string(),
        });
    RemoteCodexLaunch {
        wrapper_dir: PathBuf::from(r"C:\Users\test\.cli-manager\remote-manager\bin"),
        launcher: Some(PathBuf::from(r"D:\npm\codex.cmd")),
        launcher_args: vec![
            "--config".to_string(),
            "model_reasoning_effort=high".to_string(),
        ],
        proxy_executable: PathBuf::from(r"C:\Program Files\CLI-Manager\cli-manager.exe"),
        expected_session_id: Some("thread-original".to_string()),
        codex_home: Some(PathBuf::from(r"C:\Users\test\.codex")),
        discovery_codex_home: provider.is_some().then(|| {
            PathBuf::from(r"C:\Users\test\.cli-manager\remote-manager\codex-model-discovery")
        }),
        protocol_trace_path: None,
        provider,
        ssh_launch: None,
    }
}
