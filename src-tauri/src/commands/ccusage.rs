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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcusageToolStatus {
    bun_available: bool,
    bunx_available: bool,
    bun_version: Option<String>,
    bunx_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcusageReportResponse {
    source: String,
    report_kind: String,
    payload: Value,
    refreshed_at: i64,
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

fn command_output(program: &str, args: &[&str], envs: &[(&str, String)]) -> Result<Output, String> {
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

fn version_of(program: &str) -> Option<String> {
    let output = command_output(program, &["--version"], &[]).ok()?;
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

fn tool_status() -> CcusageToolStatus {
    let bun_version = version_of("bun");
    let bunx_version = version_of("bunx");
    CcusageToolStatus {
        bun_available: bun_version.is_some(),
        bunx_available: bunx_version.is_some(),
        bun_version,
        bunx_version,
    }
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

fn ccusage_envs(
    source: &str,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<Vec<(&'static str, String)>, String> {
    let mut envs = vec![
        ("NPM_CONFIG_REGISTRY", REGISTRY_MIRROR.to_string()),
        ("npm_config_registry", REGISTRY_MIRROR.to_string()),
    ];

    if source != "codex" {
        if let Some(path) = existing_dir(claude_config_dir, "Claude")? {
            envs.push(("CLAUDE_CONFIG_DIR", path.to_string_lossy().into_owned()));
        }
    }
    if source != "claude" {
        if let Some(path) = existing_dir(codex_config_dir, "Codex")? {
            envs.push(("CODEX_HOME", path.to_string_lossy().into_owned()));
        }
    }

    Ok(envs)
}

fn ccusage_report_payload(
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

    let output = command_output("bunx", &args, envs)?;
    if !output.status.success() {
        return Err(format!("运行 ccusage {report_kind} 失败: {}", output_text(&output)));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("解析 ccusage {report_kind} JSON 失败: {err}"))
}

#[tauri::command]
pub async fn ccusage_get_status() -> Result<CcusageToolStatus, String> {
    tauri::async_runtime::spawn_blocking(tool_status)
        .await
        .map_err(|err| format!("检查 ccusage 工具状态失败: {err}"))
}

#[tauri::command]
pub async fn ccusage_install_tools() -> Result<CcusageToolStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = command_output(
            "npm",
            &["install", "-g", "bun", "--registry", REGISTRY_MIRROR],
            &[],
        )?;
        if !output.status.success() {
            return Err(format!("安装 Bun/bunx 失败: {}", output_text(&output)));
        }
        Ok(tool_status())
    })
    .await
    .map_err(|err| format!("安装 Bun/bunx 失败: {err}"))?
}

#[tauri::command]
pub async fn ccusage_refresh_report(
    source: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<CcusageReportResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = normalize_source(source)?;
        let envs = ccusage_envs(&source, claude_config_dir, codex_config_dir)?;
        let daily_payload = ccusage_report_payload(&source, DAILY_REPORT_KIND, &envs, true)?;
        let session_payload = ccusage_report_payload(&source, SESSION_REPORT_KIND, &envs, false)?;
        let blocks_payload = ccusage_report_payload(&source, BLOCKS_REPORT_KIND, &envs, false)?;

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
