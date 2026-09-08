use super::{
    build_remote_project_commands, config_path_value, data_dir, enabled_platforms,
    hydrate_profile_platforms, managed_agent_command, normalize_allow_from, weixin_authorization_dir, CcConnectAgent,
    CcConnectLanguage, CcConnectPlatform, CcConnectPlatformProfile, CcConnectProfile,
    DisabledFeature, ManagedAgent, ManagedAgentOptions, ManagedConfig, ManagedLogConfig,
    ManagedPlatform, ManagedProject, ManagedQueueConfig, ManagedRateLimitConfig, RemoteCodexLaunch,
    ResolvedAgentLauncher, FEISHU_APP_ID_ENV, FEISHU_APP_SECRET_ENV, PROJECT_LIST_FILE_NAME,
    PROJECT_SWITCH_SCRIPT_FILE_NAME, TELEGRAM_TOKEN_ENV, WECOM_BOT_ID_ENV, WECOM_BOT_SECRET_ENV,
    WEIXIN_TOKEN_ENV,
};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self};
use std::path::Path;

// 返回消息平台在 cc-connect 配置中的类型名称。
pub(super) fn platform_type(platform: CcConnectPlatform) -> &'static str {
    match platform {
        CcConnectPlatform::Telegram => "telegram",
        CcConnectPlatform::Feishu => "feishu",
        CcConnectPlatform::Weixin => "weixin",
        CcConnectPlatform::Wecom => "wecom",
    }
}

// 构造平台选项、凭据环境占位符和经校验的白名单。
pub(super) fn build_managed_platform(
    profile: &CcConnectProfile,
    platform_profile: &CcConnectPlatformProfile,
) -> Result<(ManagedPlatform, String), String> {
    let allow_from = normalize_allow_from(platform_profile.platform, &platform_profile.allow_from)?;
    let mut options = BTreeMap::new();
    options.insert(
        "allow_from".to_string(),
        toml::Value::String(allow_from.clone()),
    );
    options.insert("group_reply_all".to_string(), toml::Value::Boolean(false));
    options.insert(
        "share_session_in_channel".to_string(),
        toml::Value::Boolean(false),
    );
    match platform_profile.platform {
        CcConnectPlatform::Telegram => {
            options.insert(
                "token".to_string(),
                toml::Value::String(format!("${{{}}}", TELEGRAM_TOKEN_ENV)),
            );
            options.insert("enable_reactions".to_string(), toml::Value::Boolean(false));
            options.insert(
                "progress_style".to_string(),
                toml::Value::String("compact".to_string()),
            );
        }
        CcConnectPlatform::Feishu => {
            options.insert(
                "app_id".to_string(),
                toml::Value::String(format!("${{{}}}", FEISHU_APP_ID_ENV)),
            );
            options.insert(
                "app_secret".to_string(),
                toml::Value::String(format!("${{{}}}", FEISHU_APP_SECRET_ENV)),
            );
            options.insert("group_only".to_string(), toml::Value::Boolean(false));
            options.insert("thread_isolation".to_string(), toml::Value::Boolean(false));
            options.insert("reply_to_trigger".to_string(), toml::Value::Boolean(true));
        }
        CcConnectPlatform::Weixin => {
            options.insert(
                "token".to_string(),
                toml::Value::String(format!("${{{}}}", WEIXIN_TOKEN_ENV)),
            );
            options.insert(
                "account_id".to_string(),
                toml::Value::String(profile.project_id.clone()),
            );
        }
        CcConnectPlatform::Wecom => {
            options.insert(
                "mode".to_string(),
                toml::Value::String("websocket".to_string()),
            );
            options.insert(
                "bot_id".to_string(),
                toml::Value::String(format!("${{{}}}", WECOM_BOT_ID_ENV)),
            );
            options.insert(
                "bot_secret".to_string(),
                toml::Value::String(format!("${{{}}}", WECOM_BOT_SECRET_ENV)),
            );
        }
    }
    Ok((
        ManagedPlatform {
            kind: platform_type(platform_profile.platform).to_string(),
            options,
        },
        allow_from,
    ))
}

// 以无 Codex 启动覆盖构造托管配置。
pub(super) fn build_managed_config(
    profile: &CcConnectProfile,
    project_list_path: &Path,
    project_switch_script_path: &Path,
) -> Result<ManagedConfig, String> {
    build_managed_config_with_codex(profile, project_list_path, project_switch_script_path, None)
}

// 将可选 Codex 启动信息转交完整配置构造入口。
pub(super) fn build_managed_config_with_codex(
    profile: &CcConnectProfile,
    project_list_path: &Path,
    project_switch_script_path: &Path,
    codex_launch: Option<&RemoteCodexLaunch>,
) -> Result<ManagedConfig, String> {
    build_managed_config_with_agent_launch(
        profile,
        project_list_path,
        project_switch_script_path,
        codex_launch,
        None,
        None,
        &BTreeMap::new(),
    )
}

// 构造受限远程命令、启用平台及隔离密钥的 Agent 配置。
pub(super) fn build_managed_config_with_agent_launch(
    profile: &CcConnectProfile,
    project_list_path: &Path,
    project_switch_script_path: &Path,
    codex_launch: Option<&RemoteCodexLaunch>,
    agent_launcher: Option<&ResolvedAgentLauncher>,
    claude_settings_path: Option<&Path>,
    additional_agent_environment: &BTreeMap<String, String>,
) -> Result<ManagedConfig, String> {
    let configured_platforms = enabled_platforms(profile);
    if configured_platforms.is_empty() {
        return Err("at least one messaging platform must be enabled".to_string());
    }
    let mut platforms = Vec::with_capacity(configured_platforms.len());
    let mut admin_users = Vec::new();
    let mut seen_admin_users = HashSet::new();
    for platform_profile in &configured_platforms {
        let (platform, allow_from) = build_managed_platform(profile, platform_profile)?;
        for user in allow_from.split(',') {
            if seen_admin_users.insert(user.to_string()) {
                admin_users.push(user.to_string());
            }
        }
        platforms.push(platform);
    }
    let admin_from = admin_users.join(",");
    let (commands, aliases) =
        build_remote_project_commands(profile, project_list_path, project_switch_script_path)?;
    let codex_home = (profile.agent == CcConnectAgent::Codex)
        .then(|| codex_launch.and_then(|launch| launch.codex_home.as_ref()))
        .flatten()
        .map(|path| config_path_value(path));
    let active_model = (profile.agent == CcConnectAgent::Codex)
        .then(|| {
            codex_launch
                .and_then(|launch| launch.provider.as_ref())
                .and_then(|provider| provider.model.clone())
        })
        .flatten();
    let mut agent_environment = [
        (TELEGRAM_TOKEN_ENV.to_string(), String::new()),
        (FEISHU_APP_ID_ENV.to_string(), String::new()),
        (FEISHU_APP_SECRET_ENV.to_string(), String::new()),
        (WEIXIN_TOKEN_ENV.to_string(), String::new()),
        (WECOM_BOT_ID_ENV.to_string(), String::new()),
        (WECOM_BOT_SECRET_ENV.to_string(), String::new()),
    ]
    .into_iter()
    .collect::<BTreeMap<_, _>>();
    if let Some(provider) = codex_launch.and_then(|launch| launch.provider.as_ref()) {
        // cc-connect builds the Codex child environment from this map. Keep the
        // credential in the managed process environment and reference it here,
        // so the generated config never persists the secret itself.
        agent_environment.insert(
            provider.env_key.clone(),
            format!("${{{}}}", provider.env_key),
        );
    }
    agent_environment.extend(additional_agent_environment.clone());
    let managed_command = agent_launcher.map(managed_agent_command);
    let agent_command = match profile.agent {
        CcConnectAgent::Claude => {
            let mut command = managed_command.unwrap_or_else(|| vec!["claude".to_string()]);
            if let Some(settings_path) = claude_settings_path {
                command.extend(["--settings".to_string(), config_path_value(settings_path)]);
            }
            (agent_launcher.is_some() || claude_settings_path.is_some()).then_some(command)
        }
        CcConnectAgent::Pi | CcConnectAgent::Opencode => managed_command,
        CcConnectAgent::Codex => None,
    };
    Ok(ManagedConfig {
        data_dir: config_path_value(&data_dir()?),
        language: match profile.language {
            CcConnectLanguage::Zh => "zh",
            CcConnectLanguage::En => "en",
        }
        .to_string(),
        max_turn_time_mins: profile.max_turn_time_mins,
        queue: ManagedQueueConfig { max_depth: 2 },
        rate_limit: ManagedRateLimitConfig {
            max_messages: 10,
            window_secs: 60,
        },
        log: ManagedLogConfig {
            level: "info".to_string(),
        },
        webhook: DisabledFeature { enabled: false },
        bridge: DisabledFeature { enabled: false },
        management: DisabledFeature { enabled: false },
        commands,
        aliases,
        projects: vec![ManagedProject {
            name: profile.project_name.clone(),
            // Exec-backed CLI-Manager commands require cc-connect admin status.
            // Every other privileged built-in remains disabled below.
            admin_from,
            // Preserve basic session controls while blocking commands that can
            // change authorization, persistence, providers, workspaces, or files.
            disabled_commands: [
                "list",
                "switch",
                "name",
                "current",
                "history",
                "allow",
                "mode",
                "provider",
                "memory",
                "cron",
                "timer",
                "heartbeat",
                "commands",
                "skills",
                "config",
                "doctor",
                "upgrade",
                "restart",
                "alias",
                "delete",
                "bind",
                "search",
                "shell",
                "show",
                "dir",
                "tts",
                "workspace",
                "web",
                "diff",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            reset_on_idle_mins: 0,
            agent: ManagedAgent {
                kind: profile.agent.config_type().to_string(),
                options: ManagedAgentOptions {
                    work_dir: config_path_value(Path::new(&profile.project_path)),
                    mode: profile
                        .agent
                        .configured_mode(profile.yolo_enabled)
                        .to_string(),
                    cmd: agent_command,
                    backend: profile.agent.backend().map(str::to_string),
                    app_server_url: profile.agent.app_server_url().map(str::to_string),
                    model: active_model,
                    codex_home,
                    rpc: profile.agent.rpc(),
                    env: agent_environment,
                },
            },
            platforms,
        }],
    })
}

// 构造仅启用微信且清空授权凭据的临时 TOML。
pub(super) fn build_weixin_authorization_config(
    profile: &CcConnectProfile,
) -> Result<String, String> {
    let dir = weixin_authorization_dir()?;
    let mut authorization_profile = profile.clone();
    hydrate_profile_platforms(&mut authorization_profile);
    authorization_profile.platform = CcConnectPlatform::Weixin;
    for item in &mut authorization_profile.platforms {
        item.enabled = item.platform == CcConnectPlatform::Weixin;
    }
    authorization_profile.allow_from = authorization_profile
        .platforms
        .iter()
        .find(|item| item.platform == CcConnectPlatform::Weixin)
        .map(|item| item.allow_from.clone())
        .unwrap_or_default();
    let mut config = build_managed_config(
        &authorization_profile,
        &dir.join(PROJECT_LIST_FILE_NAME),
        &dir.join(PROJECT_SWITCH_SCRIPT_FILE_NAME),
    )?;
    let platform = config
        .projects
        .first_mut()
        .and_then(|project| {
            project
                .platforms
                .iter_mut()
                .find(|platform| platform.kind == "weixin")
        })
        .ok_or_else(|| "Weixin authorization platform is missing".to_string())?;
    platform
        .options
        .insert("token".to_string(), toml::Value::String(String::new()));
    platform
        .options
        .insert("allow_from".to_string(), toml::Value::String(String::new()));
    toml::to_string_pretty(&config)
        .map_err(|err| format!("serialize Weixin authorization config failed: {err}"))
}

#[derive(Debug)]
pub(super) struct WeixinAuthorizationResult {
    pub(super) token: String,
    pub(super) allow_from: String,
}

// 从指定项目的微信配置读取非空令牌及合法授权用户。
pub(super) fn parse_weixin_authorization_result(
    path: &Path,
    project_name: &str,
) -> Result<WeixinAuthorizationResult, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read Weixin authorization result failed: {err}"))?;
    let root: toml::Value = toml::from_str(&raw)
        .map_err(|err| format!("parse Weixin authorization result failed: {err}"))?;
    let projects = root
        .get("projects")
        .and_then(toml::Value::as_array)
        .ok_or_else(|| "Weixin authorization result has no projects".to_string())?;
    let project = projects
        .iter()
        .find(|project| {
            project
                .get("name")
                .and_then(toml::Value::as_str)
                .is_some_and(|name| name == project_name)
        })
        .ok_or_else(|| "Weixin authorization project is missing".to_string())?;
    let platform = project
        .get("platforms")
        .and_then(toml::Value::as_array)
        .and_then(|platforms| {
            platforms.iter().find(|platform| {
                platform
                    .get("type")
                    .and_then(toml::Value::as_str)
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("weixin"))
            })
        })
        .ok_or_else(|| "Weixin authorization platform is missing".to_string())?;
    let options = platform
        .get("options")
        .and_then(toml::Value::as_table)
        .ok_or_else(|| "Weixin authorization options are missing".to_string())?;
    let token = options
        .get("token")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Weixin authorization token is missing".to_string())?
        .to_string();
    let allow_from = options
        .get("allow_from")
        .and_then(toml::Value::as_str)
        .unwrap_or_default();
    let allow_from = normalize_allow_from(CcConnectPlatform::Weixin, allow_from)
        .map_err(|_| "Weixin authorization user ID is missing".to_string())?;
    Ok(WeixinAuthorizationResult { token, allow_from })
}

// 验证并按首次顺序合并已有和扫码微信用户名单。
pub(super) fn merge_weixin_allow_from(existing: &str, scanned: &str) -> Result<String, String> {
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for source in [existing, scanned] {
        let normalized = if source.trim().is_empty() {
            continue;
        } else {
            normalize_allow_from(CcConnectPlatform::Weixin, source)?
        };
        for value in normalized.split(',') {
            if seen.insert(value.to_string()) {
                values.push(value.to_string());
            }
        }
    }
    if values.is_empty() {
        Err("Weixin authorization user ID is missing".to_string())
    } else {
        Ok(values.join(","))
    }
}
