use super::{
    agent_from_launcher_program, config_path_value, parse_registered_command, remote_manager_dir,
    CcConnectAgent, RegisteredProject, ResolvedAgentLauncher, FEISHU_APP_ID_ENV,
    FEISHU_APP_SECRET_ENV, MAX_REGISTERED_LAUNCHER_ARGS, PROXY_ENV_KEYS, TELEGRAM_TOKEN_ENV,
    WECOM_BOT_ID_ENV, WECOM_BOT_SECRET_ENV, WEIXIN_TOKEN_ENV,
};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self};
use std::path::{Path, PathBuf};

// 优先取非空 USERPROFILE，再回退 HOME 作为用户目录。
pub(super) fn user_home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("HOME").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

// 返回对应 Agent 的默认可执行命令名。
pub(super) fn default_agent_command(agent: CcConnectAgent) -> &'static str {
    match agent {
        CcConnectAgent::Claude => "claude",
        CcConnectAgent::Codex => "codex",
        CcConnectAgent::Pi => "pi",
        CcConnectAgent::Opencode => "opencode",
    }
}

// 比较原路径或规范路径是否指向同一目录。
pub(super) fn directory_matches(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

// 搜索 PATH 中可用启动程序并跳过指定托管包装目录。
pub(super) fn resolve_program_from_path(
    program: &str,
    path_value: &std::ffi::OsStr,
    skip_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    for directory in env::split_paths(path_value) {
        if skip_dir.is_some_and(|wrapper| directory_matches(&directory, wrapper)) {
            continue;
        }
        #[cfg(target_os = "windows")]
        let candidates = if Path::new(program).extension().is_some() {
            vec![program.to_string()]
        } else {
            vec![
                format!("{program}.exe"),
                format!("{program}.cmd"),
                format!("{program}.bat"),
                format!("{program}.com"),
                format!("{program}.ps1"),
            ]
        };
        #[cfg(not(target_os = "windows"))]
        let candidates = vec![program.to_string()];
        for candidate in candidates {
            let candidate = directory.join(candidate);
            #[cfg(not(target_os = "windows"))]
            {
                use std::os::unix::fs::PermissionsExt;
                let Ok(metadata) = candidate.metadata() else {
                    continue;
                };
                if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            #[cfg(target_os = "windows")]
            if !candidate.is_file() {
                continue;
            }
            if let Ok(canonical) = candidate.canonicalize() {
                return Ok(canonical);
            }
        }
    }
    Err("handoff_agent_unavailable".to_string())
}

#[cfg(all(test, unix))]
// 在 Unix 测试中解析包装目录之外的 Codex 启动程序。
pub(super) fn resolve_codex_launcher_from_path(
    wrapper_dir: &Path,
    path_value: impl AsRef<std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    resolve_program_from_path("codex", path_value.as_ref(), Some(wrapper_dir))
}

// 按工作目录解析显式程序路径，否则搜索 PATH 并避开 Codex 包装器。
pub(super) fn resolve_local_agent_program(
    program: &str,
    work_dir: &Path,
) -> Result<PathBuf, String> {
    let configured = Path::new(program);
    if configured.is_absolute() || program.contains(['/', '\\']) {
        let candidate = if configured.is_absolute() {
            configured.to_path_buf()
        } else {
            work_dir.join(configured)
        };
        let candidate = candidate
            .canonicalize()
            .map_err(|_| "handoff_agent_unavailable".to_string())?;
        return candidate
            .is_file()
            .then_some(candidate)
            .ok_or_else(|| "handoff_agent_unavailable".to_string());
    }

    let path_value = env::var_os("PATH").ok_or_else(|| "handoff_agent_unavailable".to_string())?;
    let skip_wrapper = (program == "codex" || program.eq_ignore_ascii_case("codex.exe"))
        .then(|| remote_manager_dir().ok().map(|dir| dir.join("bin")))
        .flatten();
    resolve_program_from_path(program, &path_value, skip_wrapper.as_deref())
}

// 识别各 Agent 的恢复、继续及会话选择参数。
pub(super) fn has_handoff_session_argument(agent: CcConnectAgent, argument: &str) -> bool {
    let option = argument
        .split_once('=')
        .map(|(name, _)| name)
        .unwrap_or(argument)
        .to_ascii_lowercase();
    let common = matches!(
        option.as_str(),
        "--resume" | "--continue" | "--last" | "--session" | "--session-id" | "--fork" | "-r"
    );
    common
        || matches!(agent, CcConnectAgent::Codex) && option == "resume"
        || matches!(agent, CcConnectAgent::Claude) && option == "-c"
        || matches!(agent, CcConnectAgent::Pi) && option == "-c"
        || matches!(agent, CcConnectAgent::Opencode) && matches!(option.as_str(), "-c" | "-s")
}

// 识别需要独立值的 Codex 选项，排除等号和组合短参数。
pub(super) fn codex_resume_option_takes_value(argument: &str) -> bool {
    if argument.contains('=')
        || argument
            .strip_prefix('-')
            .is_some_and(|value| !value.starts_with('-') && value.len() > 1)
    {
        return false;
    }
    let option = argument.to_ascii_lowercase();
    matches!(
        option.as_str(),
        "-a" | "--add-dir"
            | "--ask-for-approval"
            | "-c"
            | "--cd"
            | "--config"
            | "--disable"
            | "--enable"
            | "-i"
            | "--image"
            | "--local-provider"
            | "-m"
            | "--model"
            | "-p"
            | "--profile"
            | "--remote"
            | "--remote-auth-token-env"
            | "-s"
            | "--sandbox"
    )
}

// 判定各 Agent 会话选择参数是否消费后续值。
pub(super) fn handoff_session_argument_takes_value(agent: CcConnectAgent, argument: &str) -> bool {
    let option = argument
        .split_once('=')
        .map(|(name, _)| name)
        .unwrap_or(argument)
        .to_ascii_lowercase();
    match agent {
        CcConnectAgent::Claude => matches!(
            option.as_str(),
            "-c" | "-r" | "--continue" | "--resume" | "--session" | "--session-id" | "--fork"
        ),
        CcConnectAgent::Codex => matches!(
            option.as_str(),
            "--continue" | "--resume" | "--session" | "--session-id" | "--fork" | "-r"
        ),
        CcConnectAgent::Pi => matches!(
            option.as_str(),
            "-c" | "-r" | "--continue" | "--resume" | "--session" | "--session-id" | "--fork"
        ),
        CcConnectAgent::Opencode => matches!(
            option.as_str(),
            "-c" | "-s" | "--continue" | "--session" | "--fork"
        ),
    }
}

// 移除注册命令中的会话目标，同时保留 Codex 配置选项和值。
pub(super) fn strip_registered_launcher_session_arguments(
    agent: CcConnectAgent,
    args: Vec<String>,
) -> Vec<String> {
    let mut kept = Vec::with_capacity(args.len());
    let mut index = 0;
    let mut in_codex_resume = false;

    while index < args.len() {
        let argument = &args[index];
        let option = argument
            .split_once('=')
            .map(|(name, _)| name)
            .unwrap_or(argument)
            .to_ascii_lowercase();

        if agent == CcConnectAgent::Codex && !in_codex_resume && option == "resume" {
            in_codex_resume = true;
            index += 1;
            continue;
        }

        if has_handoff_session_argument(agent, argument) {
            if !argument.contains('=')
                && handoff_session_argument_takes_value(agent, argument)
                && args
                    .get(index + 1)
                    .is_some_and(|next| !next.starts_with('-'))
            {
                index += 1;
            }
            index += 1;
            continue;
        }

        if in_codex_resume {
            if argument == "--"
                || matches!(
                    option.as_str(),
                    "--all" | "--include-non-interactive" | "--no-alt-screen"
                )
                || !argument.starts_with('-')
            {
                index += 1;
                continue;
            }
        }

        kept.push(argument.clone());
        if agent == CcConnectAgent::Codex && codex_resume_option_takes_value(argument) {
            if let Some(value) = args.get(index + 1) {
                kept.push(value.clone());
                index += 1;
            }
        }
        index += 1;
    }

    kept
}

// 拒绝残留会话选择参数及与托管 Provider 冲突的选项。
pub(super) fn validate_registered_launcher_arguments(
    agent: CcConnectAgent,
    args: &[String],
) -> Result<(), String> {
    if args
        .iter()
        .any(|argument| has_handoff_session_argument(agent, argument))
    {
        return Err("handoff_agent_launcher_session_arg".to_string());
    }
    let has_provider_override = args.iter().any(|argument| {
        let option = argument
            .split_once('=')
            .map(|(name, _)| name)
            .unwrap_or(argument)
            .to_ascii_lowercase();
        matches!(
            (agent, option.as_str()),
            (CcConnectAgent::Claude, "--settings") | (CcConnectAgent::Codex, "--profile" | "-p")
        )
    });
    if has_provider_override {
        return Err("handoff_agent_launcher_provider_arg".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
// 对 Windows 脚本启动路径和参数拒绝命令解释器元字符。
pub(super) fn validate_windows_script_launcher(
    executable: &Path,
    args: &[String],
) -> Result<(), String> {
    let is_script = executable
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd")
                || extension.eq_ignore_ascii_case("bat")
                || extension.eq_ignore_ascii_case("ps1")
        });
    let executable = executable.to_string_lossy();
    if is_script
        && std::iter::once(executable.as_ref())
            .chain(args.iter().map(String::as_str))
            .any(|value| value.contains(['&', '|', '<', '>', '^', '%', '!']))
    {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    Ok(())
}

// 校验注册 Agent 身份、清理会话参数并解析可用启动程序。
pub(super) fn ensure_local_agent_available(
    project: &RegisteredProject,
) -> Result<ResolvedAgentLauncher, String> {
    let mut command = if project.cli_tool.trim().is_empty() {
        vec![default_agent_command(project.agent).to_string()]
    } else {
        parse_registered_command(&project.cli_tool)?
    };
    let program = command.remove(0);
    if agent_from_launcher_program(&program) != Some(project.agent) {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    if !project.cli_args.trim().is_empty() {
        command.extend(parse_registered_command(&project.cli_args)?);
    }
    if command.len() > MAX_REGISTERED_LAUNCHER_ARGS {
        return Err("handoff_agent_launcher_invalid".to_string());
    }
    command = strip_registered_launcher_session_arguments(project.agent, command);
    validate_registered_launcher_arguments(project.agent, &command)?;
    let executable = resolve_local_agent_program(&program, Path::new(&project.path))?;
    #[cfg(target_os = "windows")]
    validate_windows_script_launcher(&executable, &command)?;
    Ok(ResolvedAgentLauncher {
        executable,
        args: command,
    })
}

// 组合结构化启动参数，Windows PowerShell 脚本使用 -File 入口。
pub(super) fn managed_agent_command(launcher: &ResolvedAgentLauncher) -> Vec<String> {
    let executable = config_path_value(&launcher.executable);
    #[cfg(target_os = "windows")]
    if launcher
        .executable
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ps1"))
    {
        let mut command = vec![
            "powershell.exe".to_string(),
            "-NoProfile".to_string(),
            "-File".to_string(),
            executable,
        ];
        command.extend(launcher.args.clone());
        return command;
    }
    let mut command = vec![executable];
    command.extend(launcher.args.clone());
    command
}

// 仅为 Pi/OpenCode 提取受限项目环境，并分离占位符与进程明文。
pub(super) fn managed_project_environment(
    project: &RegisteredProject,
) -> (BTreeMap<String, String>, Vec<(String, String)>) {
    if !matches!(project.agent, CcConnectAgent::Pi | CcConnectAgent::Opencode) {
        return (BTreeMap::new(), Vec::new());
    }
    let Ok(serde_json::Value::Object(values)) = serde_json::from_str(&project.env_vars) else {
        return (BTreeMap::new(), Vec::new());
    };
    let reserved = [
        TELEGRAM_TOKEN_ENV,
        FEISHU_APP_ID_ENV,
        FEISHU_APP_SECRET_ENV,
        WEIXIN_TOKEN_ENV,
        WECOM_BOT_ID_ENV,
        WECOM_BOT_SECRET_ENV,
    ];
    let mut config = BTreeMap::new();
    let mut process = Vec::new();
    for (key, value) in values.into_iter().take(128) {
        let Some(value) = value.as_str() else {
            continue;
        };
        let valid_key = key.len() <= 128
            && key
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let upper = key.to_ascii_uppercase();
        if !valid_key
            || value.len() > 32 * 1024
            || value.contains('\0')
            || upper.starts_with("CLI_MANAGER_")
            || upper.starts_with("CC_CONNECT_")
            || reserved.contains(&upper.as_str())
            || PROXY_ENV_KEYS
                .iter()
                .any(|reserved_key| reserved_key.eq_ignore_ascii_case(&key))
        {
            continue;
        }
        config.insert(key.clone(), format!("${{{key}}}"));
        process.push((key, value.to_string()));
    }
    (config, process)
}
