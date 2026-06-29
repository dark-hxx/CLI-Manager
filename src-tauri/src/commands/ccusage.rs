use crate::shell_resolver::silent_command;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Output;
use std::time::{SystemTime, UNIX_EPOCH};

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

#[derive(Clone, PartialEq, Eq)]
enum RuntimeTarget {
    Host,
    Wsl { distro: String },
}

#[derive(Clone)]
struct ConfigDir {
    runtime: RuntimeTarget,
    path: String,
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

fn base_envs() -> Vec<(&'static str, String)> {
    vec![
        ("NPM_CONFIG_REGISTRY", REGISTRY_MIRROR.to_string()),
        ("npm_config_registry", REGISTRY_MIRROR.to_string()),
    ]
}

fn host_command_output(
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
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

    command
        .output()
        .map_err(|err| format!("执行 {program} 失败: {err}"))
}

fn wsl_command_output(
    distro: &str,
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
) -> Result<Output, String> {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let mut command = silent_command(&wsl_exe.to_string_lossy());
    command.args(["-d", distro, "--exec", "env"]);
    for (key, value) in envs {
        command.arg(format!("{key}={value}"));
    }
    command.arg(program);
    command.args(args);
    command
        .output()
        .map_err(|err| format!("执行 wsl.exe -d {distro} --exec {program} 失败: {err}"))
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn wsl_command_with_bun_path_output(
    distro: &str,
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
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
    wsl_command_output(distro, "sh", &["-lc", &script], &[])
}

fn command_output(
    target: &RuntimeTarget,
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
) -> Result<Output, String> {
    match target {
        RuntimeTarget::Host => host_command_output(program, args, envs),
        RuntimeTarget::Wsl { distro } if program == "bun" || program == "bunx" => {
            wsl_command_with_bun_path_output(distro, program, args, envs)
        }
        RuntimeTarget::Wsl { distro } => wsl_command_output(distro, program, args, envs),
    }
}

fn version_of(target: &RuntimeTarget, program: &str) -> Option<String> {
    let output = command_output(target, program, &["--version"], &[]).ok()?;
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
        return Ok(None);
    };
    let raw = path.to_string_lossy().into_owned();
    if use_wsl && crate::wsl::is_wsl_config_dir(&raw) {
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

fn resolve_runtime_for_source(
    source: &str,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    use_wsl: bool,
) -> Result<(RuntimeTarget, Vec<(&'static str, String)>), String> {
    let claude = resolve_config_dir_for_runtime(claude_config_dir, "Claude", use_wsl)?;
    let codex = resolve_config_dir_for_runtime(codex_config_dir, "Codex", use_wsl)?;
    let mut envs = base_envs();

    if source != "codex" {
        if let Some(path) = claude.as_ref() {
            envs.push(("CLAUDE_CONFIG_DIR", path.path.clone()));
        }
    }
    if source != "claude" {
        if let Some(path) = codex.as_ref() {
            envs.push(("CODEX_HOME", path.path.clone()));
        }
    }

    let target = match source {
        "claude" => claude
            .as_ref()
            .map(|config| config.runtime.clone())
            .unwrap_or(RuntimeTarget::Host),
        "codex" => codex
            .as_ref()
            .map(|config| config.runtime.clone())
            .unwrap_or(RuntimeTarget::Host),
        "all" => {
            let mut has_host = false;
            let mut wsl_distros = Vec::new();
            for config in [claude.as_ref(), codex.as_ref()].into_iter().flatten() {
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
                return Err(
                    "当前“全部”来源暂不支持混合 Windows / WSL 环境，请切换到 Claude 或 Codex 单独刷新".to_string(),
                );
            }
            if wsl_distros.len() > 1 {
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

    Ok((target, envs))
}

fn ccusage_report_payload(
    target: &RuntimeTarget,
    source: &str,
    report_kind: &str,
    envs: &[(&str, String)],
    include_breakdown: bool,
) -> Result<Value, String> {
    let mut args = vec!["ccusage"];
    if source == "claude" || source == "codex" {
        args.push(source);
    }
    args.extend([report_kind, "--json", "--offline"]);
    if include_breakdown {
        args.push("--breakdown");
    }

    let output = command_output(target, "bunx", &args, envs)?;
    if !output.status.success() {
        return Err(format!(
            "运行 ccusage {report_kind} 失败: {}",
            output_text(&output)
        ));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("解析 ccusage {report_kind} JSON 失败: {err}"))
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
        let source = normalize_source(source)?;
        let (target, envs) =
            resolve_runtime_for_source(&source, claude_config_dir, codex_config_dir, use_wsl)?;
        let daily_payload =
            ccusage_report_payload(&target, &source, DAILY_REPORT_KIND, &envs, true)?;
        let session_payload =
            ccusage_report_payload(&target, &source, SESSION_REPORT_KIND, &envs, false)?;
        let blocks_payload =
            ccusage_report_payload(&target, &source, BLOCKS_REPORT_KIND, &envs, false)?;

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
