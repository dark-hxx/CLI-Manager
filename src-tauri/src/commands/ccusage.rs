use crate::shell_resolver::{output_with_timeout, silent_command};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Output;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REGISTRY_MIRROR: &str = "https://registry.npmmirror.com";
const DAILY_REPORT_KIND: &str = "daily";
const SESSION_REPORT_KIND: &str = "session";
const BLOCKS_REPORT_KIND: &str = "blocks";
const REPORT_KIND: &str = "daily+session+blocks";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcusageRuntimeStatus {
    bun_available: bool,
    bunx_available: bool,
    bun_version: Option<String>,
    bunx_version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcusageWslToolStatus {
    distro: String,
    bun_available: bool,
    bunx_available: bool,
    bun_version: Option<String>,
    bunx_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcusageToolStatus {
    host: CcusageRuntimeStatus,
    wsl: Option<CcusageWslToolStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcusageReportResponse {
    source: String,
    report_kind: String,
    payload: Value,
    refreshed_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RuntimeTarget {
    Host,
    Wsl { distro: String },
}

#[derive(Clone)]
struct ConfigDir {
    runtime: RuntimeTarget,
    path: String,
}

#[derive(Clone)]
struct DefaultWslContext {
    distro: String,
    home: String,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn output_text(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn truncate_for_log(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    let mut result = String::new();
    for (index, ch) in trimmed.chars().enumerate() {
        if index >= max_chars {
            result.push_str("...");
            return result;
        }
        result.push(ch);
    }
    result
}

fn target_label(target: &RuntimeTarget) -> String {
    match target {
        RuntimeTarget::Host => "host".to_string(),
        RuntimeTarget::Wsl { distro } => format!("wsl:{distro}"),
    }
}

fn format_command_for_log(program: &str, args: &[&str]) -> String {
    if args.is_empty() {
        program.to_string()
    } else {
        format!("{program} {}", args.join(" "))
    }
}

fn ccusage_envs_for_log(envs: &[(&str, String)]) -> String {
    let items = envs
        .iter()
        .filter_map(|(key, value)| match *key {
            "CLAUDE_CONFIG_DIR" | "CODEX_HOME" => {
                Some(format!("{key}={}", truncate_for_log(value, 240)))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        "(none)".to_string()
    } else {
        items.join(", ")
    }
}

fn should_log_wsl_flow(use_wsl: bool, target: &RuntimeTarget) -> bool {
    use_wsl || matches!(target, RuntimeTarget::Wsl { .. })
}

fn base_envs() -> Vec<(&'static str, String)> {
    vec![
        ("NPM_CONFIG_REGISTRY", REGISTRY_MIRROR.to_string()),
        ("npm_config_registry", REGISTRY_MIRROR.to_string()),
    ]
}

fn config_value_present(value: Option<&String>) -> bool {
    value.map(|item| !item.trim().is_empty()).unwrap_or(false)
}

// 子进程超时按用途区分：探测类必须快速失败（WSL 服务损坏时 wsl.exe 会挂起
// 约 60s，通用设置页每次进入都会触发，连环探测会让页面"卡死几分钟"）；
// 报告与安装类首跑可能要下载依赖包，给足余量。
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const WSL_DETECT_TIMEOUT: Duration = Duration::from_secs(15);
const REPORT_TIMEOUT: Duration = Duration::from_secs(180);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

fn host_command_output(
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = if cfg!(windows) {
        let mut command = silent_command("cmd");
        command.arg("/C").arg(program);
        command
    } else {
        silent_command(program)
    };

    command.args(args);
    for (key, value) in envs {
        command.env(key, value);
    }

    output_with_timeout(command, timeout).map_err(|err| format!("执行 {program} 失败: {err}"))
}

fn wsl_command_output(
    distro: &str,
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
    timeout: Duration,
) -> Result<Output, String> {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let started = Instant::now();
    log::debug!(
        "[ccusage:wsl] 启动 wsl.exe: distro={} program={} args_count={} env_count={}",
        distro,
        program,
        args.len(),
        envs.len()
    );
    let mut command = silent_command(&wsl_exe.to_string_lossy());
    command.args(["-d", distro, "--exec", "env"]);
    for (key, value) in envs {
        command.arg(format!("{key}={value}"));
    }
    command.arg(program);
    command.args(args);
    let output = output_with_timeout(command, timeout).map_err(|err| {
        log::warn!(
            "[ccusage:wsl] wsl.exe 启动失败: distro={} program={} elapsed_ms={} error={}",
            distro,
            program,
            started.elapsed().as_millis(),
            err
        );
        format!("执行 wsl.exe -d {distro} --exec {program} 失败: {err}")
    })?;
    log::debug!(
        "[ccusage:wsl] wsl.exe 结束: distro={} program={} status={} elapsed_ms={}",
        distro,
        program,
        output.status,
        started.elapsed().as_millis()
    );
    Ok(output)
}

fn detect_default_wsl_context() -> Result<Option<DefaultWslContext>, String> {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let mut command = silent_command(&wsl_exe.to_string_lossy());
    command.args([
        "--exec",
        "sh",
        "-lc",
        r#"printf '%s\n%s' "$WSL_DISTRO_NAME" "$HOME""#,
    ]);
    let started = Instant::now();
    log::info!("[ccusage:wsl] 开始探测默认 WSL 发行版");
    let output = output_with_timeout(command, WSL_DETECT_TIMEOUT).map_err(|err| {
        log::warn!(
            "[ccusage:wsl] 默认 WSL 发行版探测启动失败: elapsed_ms={} error={}",
            started.elapsed().as_millis(),
            err
        );
        format!("执行 wsl.exe 探测默认发行版失败: {err}")
    })?;
    if !output.status.success() {
        log::warn!(
            "[ccusage:wsl] 默认 WSL 发行版探测失败: status={} elapsed_ms={} output={}",
            output.status,
            started.elapsed().as_millis(),
            truncate_for_log(&output_text(&output), 300)
        );
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let distro = lines.next().map(str::trim).unwrap_or_default();
    let home = lines.next().map(str::trim).unwrap_or_default();
    if distro.is_empty() || home.is_empty() {
        log::warn!(
            "[ccusage:wsl] 默认 WSL 发行版探测结果为空: elapsed_ms={} stdout={}",
            started.elapsed().as_millis(),
            truncate_for_log(&stdout, 300)
        );
        return Ok(None);
    }

    log::info!(
        "[ccusage:wsl] 默认 WSL 发行版探测成功: distro={} home={} elapsed_ms={}",
        distro,
        home,
        started.elapsed().as_millis()
    );
    Ok(Some(DefaultWslContext {
        distro: distro.to_string(),
        home: home.to_string(),
    }))
}

fn default_wsl_config_dir(context: &DefaultWslContext, leaf: &str) -> ConfigDir {
    let home = context.home.trim_end_matches('/');
    let leaf = leaf.trim_start_matches('/');
    ConfigDir {
        runtime: RuntimeTarget::Wsl {
            distro: context.distro.clone(),
        },
        path: format!("{home}/{leaf}"),
    }
}

fn fallback_default_wsl_context(
    claude_config_dir: Option<&String>,
    codex_config_dir: Option<&String>,
    use_wsl: bool,
) -> Result<Option<DefaultWslContext>, String> {
    if !use_wsl {
        return Ok(None);
    }
    if config_value_present(claude_config_dir) || config_value_present(codex_config_dir) {
        log::debug!("[ccusage:wsl] 跳过默认 WSL fallback: 已显式配置 Claude/Codex 目录");
        return Ok(None);
    }
    log::info!("[ccusage:wsl] Claude/Codex 配置目录为空，尝试使用默认 WSL fallback");
    detect_default_wsl_context()
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn wsl_command_with_bun_path_output(
    distro: &str,
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
    timeout: Duration,
) -> Result<Output, String> {
    let mut script_parts = vec![
        r#"export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}""#.to_string(),
        r#"export PATH="$BUN_INSTALL/bin:$PATH""#.to_string(),
    ];
    for (key, value) in envs {
        script_parts.push(format!("export {key}={}", shell_escape(value)));
    }
    let mut command = vec![shell_escape(program)];
    command.extend(args.iter().map(|arg| shell_escape(arg)));
    script_parts.push(format!("exec {}", command.join(" ")));
    let script = script_parts.join("; ");
    log::info!(
        "[ccusage:wsl] 准备执行 Bun 命令: distro={} command={} envs={}",
        distro,
        format_command_for_log(program, args),
        ccusage_envs_for_log(envs)
    );
    log::debug!(
        "[ccusage:wsl] Bun shell script: distro={} script={}",
        distro,
        script
    );
    wsl_command_output(distro, "sh", &["-lc", &script], &[], timeout)
}

fn command_output(
    target: &RuntimeTarget,
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
    timeout: Duration,
) -> Result<Output, String> {
    match target {
        RuntimeTarget::Host => host_command_output(program, args, envs, timeout),
        RuntimeTarget::Wsl { distro } if program == "bun" || program == "bunx" => {
            wsl_command_with_bun_path_output(distro, program, args, envs, timeout)
        }
        RuntimeTarget::Wsl { distro } => wsl_command_output(distro, program, args, envs, timeout),
    }
}

fn version_of(target: &RuntimeTarget, program: &str) -> Option<String> {
    let output = command_output(target, program, &["--version"], &[], PROBE_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn runtime_status(target: &RuntimeTarget) -> CcusageRuntimeStatus {
    let bun_version = version_of(target, "bun");
    let bunx_version = version_of(target, "bunx");
    CcusageRuntimeStatus {
        bun_available: bun_version.is_some(),
        bunx_available: bunx_version.is_some(),
        bun_version,
        bunx_version,
    }
}

fn wsl_tool_status(distro: String) -> CcusageWslToolStatus {
    let status = runtime_status(&RuntimeTarget::Wsl {
        distro: distro.clone(),
    });
    CcusageWslToolStatus {
        distro,
        bun_available: status.bun_available,
        bunx_available: status.bunx_available,
        bun_version: status.bun_version,
        bunx_version: status.bunx_version,
    }
}

fn tool_status(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<CcusageToolStatus, String> {
    let host = runtime_status(&RuntimeTarget::Host);
    let default_wsl =
        fallback_default_wsl_context(claude_config_dir.as_ref(), codex_config_dir.as_ref(), true)?;
    let claude = resolve_config_dir(claude_config_dir, "Claude")?;
    let codex = resolve_config_dir(codex_config_dir, "Codex")?;
    let mut distros = Vec::new();
    for config in [claude.as_ref(), codex.as_ref()].into_iter().flatten() {
        if let RuntimeTarget::Wsl { distro } = &config.runtime {
            if !distros.iter().any(|item| item == distro) {
                distros.push(distro.clone());
            }
        }
    }
    let wsl = if distros.len() == 1 {
        distros.into_iter().next().map(wsl_tool_status)
    } else if distros.is_empty() {
        default_wsl.map(|context| wsl_tool_status(context.distro))
    } else {
        None
    };
    Ok(CcusageToolStatus { host, wsl })
}

fn normalize_source(source: String) -> Result<String, String> {
    match source.trim().to_lowercase().as_str() {
        "all" => Ok("all".to_string()),
        "claude" => Ok("claude".to_string()),
        "codex" => Ok("codex".to_string()),
        _ => Err("不支持的 ccusage 来源".to_string()),
    }
}

fn existing_dir(value: Option<String>, label: &str) -> Result<Option<PathBuf>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(format!("选择的 {label} 配置目录不存在"));
    }
    Ok(Some(path))
}

fn resolve_config_dir(value: Option<String>, label: &str) -> Result<Option<ConfigDir>, String> {
    let Some(path) = existing_dir(value, label)? else {
        return Ok(None);
    };
    let raw = path.to_string_lossy().into_owned();
    if crate::wsl::is_wsl_config_dir(&raw) {
        let (distro, linux_path) = crate::wsl::parse_wsl_unc_path(&raw)
            .ok_or_else(|| format!("无法解析 {label} 的 WSL 配置目录"))?;
        return Ok(Some(ConfigDir {
            runtime: RuntimeTarget::Wsl { distro },
            path: linux_path,
        }));
    }
    Ok(Some(ConfigDir {
        runtime: RuntimeTarget::Host,
        path: raw,
    }))
}

fn resolve_config_dir_for_runtime(
    value: Option<String>,
    label: &str,
    use_wsl: bool,
) -> Result<Option<ConfigDir>, String> {
    let Some(path) = existing_dir(value, label)? else {
        if use_wsl {
            log::debug!("[ccusage:wsl] {label} 配置目录未设置");
        }
        return Ok(None);
    };
    let raw = path.to_string_lossy().into_owned();
    if use_wsl && crate::wsl::is_wsl_config_dir(&raw) {
        let (distro, linux_path) = match crate::wsl::parse_wsl_unc_path(&raw) {
            Some(result) => result,
            None => {
                log::warn!("[ccusage:wsl] 无法解析 {label} 的 WSL 配置目录: path={raw}");
                return Err(format!("无法解析 {label} 的 WSL 配置目录"));
            }
        };
        log::info!(
            "[ccusage:wsl] {label} 配置目录解析为 WSL: distro={} linux_path={}",
            distro,
            linux_path
        );
        return Ok(Some(ConfigDir {
            runtime: RuntimeTarget::Wsl { distro },
            path: linux_path,
        }));
    }
    if use_wsl {
        log::info!("[ccusage:wsl] {label} 配置目录按 host 处理: path={raw}");
    }
    Ok(Some(ConfigDir {
        runtime: RuntimeTarget::Host,
        path: raw,
    }))
}

fn resolve_runtime_for_source(
    source: &str,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    use_wsl: bool,
) -> Result<(RuntimeTarget, Vec<(&'static str, String)>), String> {
    if use_wsl {
        log::info!("[ccusage:wsl] 开始解析 ccusage runtime: source={source}");
    }
    let default_wsl = fallback_default_wsl_context(
        claude_config_dir.as_ref(),
        codex_config_dir.as_ref(),
        use_wsl,
    )?;
    let claude = resolve_config_dir_for_runtime(claude_config_dir, "Claude", use_wsl)?;
    let codex = resolve_config_dir_for_runtime(codex_config_dir, "Codex", use_wsl)?;
    let fallback_claude = default_wsl
        .as_ref()
        .map(|context| default_wsl_config_dir(context, ".claude"));
    let fallback_codex = default_wsl
        .as_ref()
        .map(|context| default_wsl_config_dir(context, ".codex"));
    let mut envs = base_envs();

    if source != "codex" {
        if let Some(path) = claude.as_ref().or(fallback_claude.as_ref()) {
            envs.push(("CLAUDE_CONFIG_DIR", path.path.clone()));
        }
    }
    if source != "claude" {
        if let Some(path) = codex.as_ref().or(fallback_codex.as_ref()) {
            envs.push(("CODEX_HOME", path.path.clone()));
        }
    }

    let target = match source {
        "claude" => claude
            .as_ref()
            .or(fallback_claude.as_ref())
            .map(|config| config.runtime.clone())
            .unwrap_or(RuntimeTarget::Host),
        "codex" => codex
            .as_ref()
            .or(fallback_codex.as_ref())
            .map(|config| config.runtime.clone())
            .unwrap_or(RuntimeTarget::Host),
        "all" => {
            let mut has_host = false;
            let mut wsl_distros = Vec::new();
            for config in [
                claude.as_ref().or(fallback_claude.as_ref()),
                codex.as_ref().or(fallback_codex.as_ref()),
            ]
            .into_iter()
            .flatten()
            {
                match &config.runtime {
                    RuntimeTarget::Host => has_host = true,
                    RuntimeTarget::Wsl { distro } => {
                        if !wsl_distros.iter().any(|item| item == distro) {
                            wsl_distros.push(distro.clone());
                        }
                    }
                }
            }

            if has_host && !wsl_distros.is_empty() {
                log::warn!(
                    "[ccusage:wsl] runtime 冲突: source=all has_host=true wsl_distros={}",
                    wsl_distros.join(",")
                );
                return Err(
                    "当前“全部”来源暂不支持混合 Windows / WSL 环境，请切换到 Claude 或 Codex 单独刷新".to_string(),
                );
            }
            if wsl_distros.len() > 1 {
                log::warn!(
                    "[ccusage:wsl] runtime 冲突: source=all multi_wsl_distros={}",
                    wsl_distros.join(",")
                );
                return Err(
                    "当前“全部”来源检测到多个 WSL 发行版，请切换到 Claude 或 Codex 单独刷新"
                        .to_string(),
                );
            }
            if let Some(distro) = wsl_distros.into_iter().next() {
                RuntimeTarget::Wsl { distro }
            } else {
                RuntimeTarget::Host
            }
        }
        _ => RuntimeTarget::Host,
    };

    if should_log_wsl_flow(use_wsl, &target) {
        log::info!(
            "[ccusage:wsl] ccusage runtime 解析完成: source={} target={} envs={}",
            source,
            target_label(&target),
            ccusage_envs_for_log(&envs)
        );
    }
    Ok((target, envs))
}

fn ccusage_report_payload(
    target: &RuntimeTarget,
    source: &str,
    report_kind: &str,
    envs: &[(&str, String)],
    include_breakdown: bool,
) -> Result<Value, String> {
    let (program, args) = ccusage_command(source, report_kind, include_breakdown);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let should_log = matches!(target, RuntimeTarget::Wsl { .. });
    let started = Instant::now();
    if should_log {
        log::info!(
            "[ccusage:wsl] 开始执行 ccusage report: source={} report={} target={} command={} breakdown={} envs={}",
            source,
            report_kind,
            target_label(target),
            format_command_for_log(program, &arg_refs),
            include_breakdown,
            ccusage_envs_for_log(envs)
        );
    }
    let output = command_output(target, program, &arg_refs, envs, REPORT_TIMEOUT)?;
    if !output.status.success() {
        let output_text = output_text(&output);
        if should_log {
            log::warn!(
                "[ccusage:wsl] ccusage report 执行失败: source={} report={} target={} status={} elapsed_ms={} output={}",
                source,
                report_kind,
                target_label(target),
                output.status,
                started.elapsed().as_millis(),
                truncate_for_log(&output_text, 500)
            );
        }
        return Err(format!("运行 ccusage {report_kind} 失败: {}", output_text));
    }

    if should_log {
        log::info!(
            "[ccusage:wsl] ccusage report 执行成功: source={} report={} target={} elapsed_ms={} stdout_bytes={}",
            source,
            report_kind,
            target_label(target),
            started.elapsed().as_millis(),
            output.stdout.len()
        );
    }
    serde_json::from_slice(&output.stdout).map_err(|err| {
        if should_log {
            log::warn!(
                "[ccusage:wsl] ccusage report JSON 解析失败: source={} report={} target={} elapsed_ms={} error={}",
                source,
                report_kind,
                target_label(target),
                started.elapsed().as_millis(),
                err
            );
        }
        format!("解析 ccusage {report_kind} JSON 失败: {err}")
    })
}

fn source_supports_blocks_report(source: &str) -> bool {
    source != "codex"
}

fn ccusage_command(
    source: &str,
    report_kind: &str,
    include_breakdown: bool,
) -> (&'static str, Vec<String>) {
    let mut args = vec!["x".to_string(), "ccusage".to_string()];
    if source == "claude" || source == "codex" {
        args.push(source.to_string());
    }
    args.extend([
        report_kind.to_string(),
        "--json".to_string(),
        "--offline".to_string(),
    ]);
    if include_breakdown {
        args.push("--breakdown".to_string());
    }
    ("bun", args)
}

#[tauri::command]
pub async fn ccusage_get_status(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<CcusageToolStatus, String> {
    tauri::async_runtime::spawn_blocking(move || tool_status(claude_config_dir, codex_config_dir))
        .await
        .map_err(|err| format!("检查 ccusage 工具状态失败: {err}"))?
}

#[tauri::command]
pub async fn ccusage_install_tools(
    target: String,
    _distro: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<CcusageToolStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = match target.trim().to_lowercase().as_str() {
            "host" => command_output(
                &RuntimeTarget::Host,
                "npm",
                &["install", "-g", "bun", "--registry", REGISTRY_MIRROR],
                &base_envs(),
                INSTALL_TIMEOUT,
            )?,
            "wsl" => {
                return Err(
                    "WSL 环境不再支持应用内自动安装，请在 设置 -> 通用设置 -> 用量分析 中按提示手动安装 Bun 和 ccusage"
                        .to_string(),
                )
            }
            _ => return Err("不支持的安装目标".to_string()),
        };
        if !output.status.success() {
            return Err(format!("安装 Bun/bunx 失败: {}", output_text(&output)));
        }
        tool_status(claude_config_dir, codex_config_dir)
    })
    .await
    .map_err(|err| format!("安装 Bun/bunx 失败: {err}"))?
}

#[tauri::command]
pub async fn ccusage_refresh_report(
    source: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    use_wsl: bool,
) -> Result<CcusageReportResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refresh_started = Instant::now();
        let source = match normalize_source(source) {
            Ok(source) => source,
            Err(err) => {
                if use_wsl {
                    log::warn!("[ccusage:wsl] 刷新请求来源无效: error={err}");
                }
                return Err(err);
            }
        };
        if use_wsl {
            log::info!(
                "[ccusage:wsl] 开始刷新 ccusage 报告: source={} use_wsl=true",
                source
            );
        }
        let (target, envs) =
            resolve_runtime_for_source(&source, claude_config_dir, codex_config_dir, use_wsl)?;
        let should_log = should_log_wsl_flow(use_wsl, &target);
        if should_log {
            log::info!(
                "[ccusage:wsl] 刷新目标已确定: source={} target={} envs={}",
                source,
                target_label(&target),
                ccusage_envs_for_log(&envs)
            );
        }
        let daily_payload =
            ccusage_report_payload(&target, &source, DAILY_REPORT_KIND, &envs, true)?;
        let session_payload =
            ccusage_report_payload(&target, &source, SESSION_REPORT_KIND, &envs, false)?;
        let blocks_payload = if source_supports_blocks_report(&source) {
            ccusage_report_payload(&target, &source, BLOCKS_REPORT_KIND, &envs, false)?
        } else {
            Value::Null
        };

        if should_log {
            log::info!(
                "[ccusage:wsl] ccusage 报告刷新完成: source={} target={} elapsed_ms={}",
                source,
                target_label(&target),
                refresh_started.elapsed().as_millis()
            );
        }
        Ok(CcusageReportResponse {
            source,
            report_kind: REPORT_KIND.to_string(),
            payload: json!({
                "dailyPayload": daily_payload,
                "sessionPayload": session_payload,
                "blocksPayload": blocks_payload,
            }),
            refreshed_at: now_millis(),
        })
    })
    .await
    .map_err(|err| format!("刷新 ccusage 报告失败: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_value_present_only_accepts_non_empty_text() {
        assert!(!config_value_present(None));
        assert!(!config_value_present(Some(&"   ".to_string())));
        assert!(config_value_present(Some(&"value".to_string())));
    }

    #[test]
    fn default_wsl_config_dir_joins_home_and_leaf() {
        let context = DefaultWslContext {
            distro: "Ubuntu".to_string(),
            home: "/home/silver/".to_string(),
        };

        let claude = default_wsl_config_dir(&context, ".claude");
        let codex = default_wsl_config_dir(&context, "/.codex");

        assert_eq!(claude.path, "/home/silver/.claude");
        assert_eq!(codex.path, "/home/silver/.codex");
        assert_eq!(
            claude.runtime,
            RuntimeTarget::Wsl {
                distro: "Ubuntu".to_string()
            }
        );
    }

    #[test]
    fn ccusage_command_uses_bun_x_with_optional_source_and_breakdown() {
        let (program, args) = ccusage_command("codex", DAILY_REPORT_KIND, true);

        assert_eq!(program, "bun");
        assert_eq!(
            args,
            vec![
                "x".to_string(),
                "ccusage".to_string(),
                "codex".to_string(),
                DAILY_REPORT_KIND.to_string(),
                "--json".to_string(),
                "--offline".to_string(),
                "--breakdown".to_string(),
            ]
        );
    }

    #[test]
    fn codex_source_does_not_request_blocks_report() {
        assert!(!source_supports_blocks_report("codex"));
        assert!(source_supports_blocks_report("claude"));
        assert!(source_supports_blocks_report("all"));
    }
}
