use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const CLAUDE_APPROVAL_SCRIPT_NAME: &str = "notify-cli-manager-approval.ps1";
const CLAUDE_FINISHED_SCRIPT_NAME: &str = "notify-cli-manager-finished.ps1";
const CODEX_ATTENTION_SCRIPT_NAME: &str = "notify-cli-manager-codex-attention.ps1";
const CODEX_FINISHED_SCRIPT_NAME: &str = "notify-cli-manager-codex-finished.ps1";
const CLAUDE_SETTINGS_FILE_NAME: &str = "settings.json";
const CODEX_HOOKS_FILE_NAME: &str = "hooks.json";
const CODEX_CONFIG_FILE_NAME: &str = "config.toml";

const CLAUDE_APPROVAL_SCRIPT: &str = r#"param(
    [ValidateSet("Notification")]
    [string]$Event = "Notification"
)

$ErrorActionPreference = "Stop"

try {
    $tabId = $env:CLI_MANAGER_TAB_ID
    $port = $env:CLI_MANAGER_NOTIFY_PORT
    $token = $env:CLI_MANAGER_NOTIFY_TOKEN

    if ([string]::IsNullOrWhiteSpace($tabId) -or [string]::IsNullOrWhiteSpace($port) -or [string]::IsNullOrWhiteSpace($token)) {
        exit 0
    }

    $stdin = [Console]::In.ReadToEnd()
    $hookInput = $null
    if (-not [string]::IsNullOrWhiteSpace($stdin)) {
        try {
            $hookInput = $stdin | ConvertFrom-Json
        } catch {
            $hookInput = $null
        }
    }

    $message = $null
    if ($hookInput -and $hookInput.PSObject.Properties.Name -contains "message") {
        $message = [string]$hookInput.message
    } elseif ($hookInput -and $hookInput.PSObject.Properties.Name -contains "notification") {
        $message = [string]$hookInput.notification
    }

    $payload = @{
        tabId = $tabId
        source = "claude"
        event = $Event
        title = "Claude Code needs attention"
        message = $message
        sessionId = if ($hookInput -and $hookInput.PSObject.Properties.Name -contains "session_id") { [string]$hookInput.session_id } else { $null }
        cwd = (Get-Location).Path
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }

    $body = $payload | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:$port/api/claude-hook" `
        -Headers @{ Authorization = "Bearer $token" } `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 2 `
        | Out-Null
} catch {
    exit 0
}

exit 0
"#;

const CLAUDE_FINISHED_SCRIPT: &str = r#"param(
    [ValidateSet("Stop", "StopFailure")]
    [string]$Event = "Stop"
)

$ErrorActionPreference = "Stop"

try {
    $tabId = $env:CLI_MANAGER_TAB_ID
    $port = $env:CLI_MANAGER_NOTIFY_PORT
    $token = $env:CLI_MANAGER_NOTIFY_TOKEN

    if ([string]::IsNullOrWhiteSpace($tabId) -or [string]::IsNullOrWhiteSpace($port) -or [string]::IsNullOrWhiteSpace($token)) {
        exit 0
    }

    $stdin = [Console]::In.ReadToEnd()
    $hookInput = $null
    if (-not [string]::IsNullOrWhiteSpace($stdin)) {
        try {
            $hookInput = $stdin | ConvertFrom-Json
        } catch {
            $hookInput = $null
        }
    }

    $message = $null
    if ($hookInput -and $hookInput.PSObject.Properties.Name -contains "message") {
        $message = [string]$hookInput.message
    } elseif ($hookInput -and $hookInput.PSObject.Properties.Name -contains "notification") {
        $message = [string]$hookInput.notification
    }

    $title = switch ($Event) {
        "StopFailure" { "Claude Code failed" }
        default { "Claude Code done" }
    }

    $payload = @{
        tabId = $tabId
        source = "claude"
        event = $Event
        title = $title
        message = $message
        sessionId = if ($hookInput -and $hookInput.PSObject.Properties.Name -contains "session_id") { [string]$hookInput.session_id } else { $null }
        cwd = (Get-Location).Path
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }

    $body = $payload | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:$port/api/claude-hook" `
        -Headers @{ Authorization = "Bearer $token" } `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 2 `
        | Out-Null
} catch {
    exit 0
}

exit 0
"#;

const CODEX_ATTENTION_SCRIPT: &str = r#"param(
    [ValidateSet("PermissionRequest")]
    [string]$Event = "PermissionRequest"
)

$ErrorActionPreference = "Stop"

try {
    $tabId = $env:CLI_MANAGER_TAB_ID
    $port = $env:CLI_MANAGER_NOTIFY_PORT
    $token = $env:CLI_MANAGER_NOTIFY_TOKEN

    if ([string]::IsNullOrWhiteSpace($tabId) -or [string]::IsNullOrWhiteSpace($port) -or [string]::IsNullOrWhiteSpace($token)) {
        exit 0
    }

    $stdin = [Console]::In.ReadToEnd()
    $hookInput = $null
    if (-not [string]::IsNullOrWhiteSpace($stdin)) {
        try {
            $hookInput = $stdin | ConvertFrom-Json
        } catch {
            $hookInput = $null
        }
    }

    $message = $null
    if ($hookInput -and $hookInput.PSObject.Properties.Name -contains "message") {
        $message = [string]$hookInput.message
    } elseif ($hookInput -and $hookInput.PSObject.Properties.Name -contains "reason") {
        $message = [string]$hookInput.reason
    }

    $payload = @{
        tabId = $tabId
        source = "codex"
        event = $Event
        title = "Codex CLI needs attention"
        message = $message
        sessionId = if ($hookInput -and $hookInput.PSObject.Properties.Name -contains "session_id") { [string]$hookInput.session_id } else { $null }
        cwd = (Get-Location).Path
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }

    $body = $payload | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:$port/api/claude-hook" `
        -Headers @{ Authorization = "Bearer $token" } `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 2 `
        | Out-Null
} catch {
    exit 0
}

exit 0
"#;

const CODEX_FINISHED_SCRIPT: &str = r#"param(
    [ValidateSet("Stop")]
    [string]$Event = "Stop"
)

$ErrorActionPreference = "Stop"

try {
    $tabId = $env:CLI_MANAGER_TAB_ID
    $port = $env:CLI_MANAGER_NOTIFY_PORT
    $token = $env:CLI_MANAGER_NOTIFY_TOKEN

    if ([string]::IsNullOrWhiteSpace($tabId) -or [string]::IsNullOrWhiteSpace($port) -or [string]::IsNullOrWhiteSpace($token)) {
        exit 0
    }

    $stdin = [Console]::In.ReadToEnd()
    $hookInput = $null
    if (-not [string]::IsNullOrWhiteSpace($stdin)) {
        try {
            $hookInput = $stdin | ConvertFrom-Json
        } catch {
            $hookInput = $null
        }
    }

    $message = $null
    if ($hookInput -and $hookInput.PSObject.Properties.Name -contains "message") {
        $message = [string]$hookInput.message
    }

    $payload = @{
        tabId = $tabId
        source = "codex"
        event = $Event
        title = "Codex CLI done"
        message = $message
        sessionId = if ($hookInput -and $hookInput.PSObject.Properties.Name -contains "session_id") { [string]$hookInput.session_id } else { $null }
        cwd = (Get-Location).Path
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }

    $body = $payload | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:$port/api/claude-hook" `
        -Headers @{ Authorization = "Bearer $token" } `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 2 `
        | Out-Null
} catch {
    exit 0
}

exit 0
"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSettingsStatus {
    claude: ToolHookSettingsStatus,
    codex: ToolHookSettingsStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHookSettingsStatus {
    config_dir: Option<String>,
    hooks_dir: Option<String>,
    config_path: Option<String>,
    status: HookInstallStatus,
    attention_script_installed: bool,
    finished_script_installed: bool,
    attention_hook_installed: bool,
    stop_hook_installed: bool,
    failure_hook_installed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum HookInstallStatus {
    DirectoryMissing,
    NotInstalled,
    PartialInstalled,
    Installed,
}

#[tauri::command]
pub async fn hook_settings_get_status(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String> {
    Ok(HookSettingsStatus {
        claude: build_claude_status(resolve_claude_dir(selected_dir, false)?)?,
        codex: build_codex_status(resolve_codex_dir(codex_selected_dir, false)?)?,
    })
}

#[tauri::command]
pub async fn hook_settings_install(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, true)?
        .ok_or_else(|| "请先选择 Claude 配置目录".to_string())?;
    install_claude_hooks(&claude_dir)?;
    Ok(HookSettingsStatus {
        claude: build_claude_status(Some(claude_dir))?,
        codex: build_codex_status(resolve_codex_dir(codex_selected_dir, false)?)?,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, true)?
        .ok_or_else(|| "请先选择 Claude 配置目录".to_string())?;
    uninstall_claude_hooks(&claude_dir)?;
    Ok(HookSettingsStatus {
        claude: build_claude_status(Some(claude_dir))?,
        codex: build_codex_status(resolve_codex_dir(codex_selected_dir, false)?)?,
    })
}

#[tauri::command]
pub async fn hook_settings_install_codex(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let codex_dir = resolve_codex_dir(codex_selected_dir, true)?
        .ok_or_else(|| "未找到用户目录，无法创建 Codex 配置目录".to_string())?;
    install_codex_hooks(&codex_dir)?;
    Ok(HookSettingsStatus {
        claude: build_claude_status(resolve_claude_dir(selected_dir, false)?)?,
        codex: build_codex_status(Some(codex_dir))?,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall_codex(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?.ok_or_else(|| "未找到 Codex 配置目录".to_string())?;
    uninstall_codex_hooks(&codex_dir)?;
    Ok(HookSettingsStatus {
        claude: build_claude_status(resolve_claude_dir(selected_dir, false)?)?,
        codex: build_codex_status(Some(codex_dir))?,
    })
}

#[tauri::command]
pub async fn hook_settings_select_dir(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title(title.as_deref().unwrap_or("Select config directory"))
        .blocking_pick_folder();

    selected
        .map(|file_path| {
            file_path
                .into_path()
                .map(|path| path_to_string(&path))
                .map_err(|e| format!("选择目录失败: {e}"))
        })
        .transpose()
}

fn install_claude_hooks(claude_dir: &Path) -> Result<(), String> {
    let hooks_dir = claude_dir.join("hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| format!("创建 hooks 目录失败: {e}"))?;
    fs::write(
        hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME),
        CLAUDE_APPROVAL_SCRIPT,
    )
    .map_err(|e| format!("写入 approval hook 脚本失败: {e}"))?;
    fs::write(
        hooks_dir.join(CLAUDE_FINISHED_SCRIPT_NAME),
        CLAUDE_FINISHED_SCRIPT,
    )
    .map_err(|e| format!("写入 finished hook 脚本失败: {e}"))?;

    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let mut settings = read_json(&settings_path)?;
    ensure_root_object(&settings, "settings.json")?;
    add_hook_command(
        &mut settings,
        "Notification",
        build_command(&hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME), "Notification"),
    );
    add_hook_command(
        &mut settings,
        "Stop",
        build_command(&hooks_dir.join(CLAUDE_FINISHED_SCRIPT_NAME), "Stop"),
    );
    add_hook_command(
        &mut settings,
        "StopFailure",
        build_command(&hooks_dir.join(CLAUDE_FINISHED_SCRIPT_NAME), "StopFailure"),
    );
    write_json(&settings_path, &settings)
}

fn uninstall_claude_hooks(claude_dir: &Path) -> Result<(), String> {
    let hooks_dir = claude_dir.join("hooks");
    remove_file_if_exists(&hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME))?;
    remove_file_if_exists(&hooks_dir.join(CLAUDE_FINISHED_SCRIPT_NAME))?;

    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let mut settings = read_json(&settings_path)?;
    ensure_root_object(&settings, "settings.json")?;
    remove_hook_commands(
        &mut settings,
        &["Notification", "Stop", "StopFailure"],
        &[CLAUDE_APPROVAL_SCRIPT_NAME, CLAUDE_FINISHED_SCRIPT_NAME],
    );
    write_json(&settings_path, &settings)
}

fn install_codex_hooks(codex_dir: &Path) -> Result<(), String> {
    let hooks_dir = codex_dir.join("hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| format!("创建 Codex hooks 目录失败: {e}"))?;
    fs::write(
        hooks_dir.join(CODEX_ATTENTION_SCRIPT_NAME),
        CODEX_ATTENTION_SCRIPT,
    )
    .map_err(|e| format!("写入 Codex attention hook 脚本失败: {e}"))?;
    fs::write(
        hooks_dir.join(CODEX_FINISHED_SCRIPT_NAME),
        CODEX_FINISHED_SCRIPT,
    )
    .map_err(|e| format!("写入 Codex finished hook 脚本失败: {e}"))?;

    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    add_hook_command(
        &mut settings,
        "PermissionRequest",
        build_command(
            &hooks_dir.join(CODEX_ATTENTION_SCRIPT_NAME),
            "PermissionRequest",
        ),
    );
    add_hook_command(
        &mut settings,
        "Stop",
        build_command(&hooks_dir.join(CODEX_FINISHED_SCRIPT_NAME), "Stop"),
    );
    ensure_codex_hooks_feature(codex_dir)?;
    write_json(&hooks_path, &settings)
}

fn ensure_codex_hooks_feature(codex_dir: &Path) -> Result<(), String> {
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let content = match fs::read_to_string(&config_path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path_to_string(&config_path))),
    };
    let next_content = set_toml_feature_hooks(&content);
    fs::write(&config_path, next_content)
        .map_err(|e| format!("写入 {} 失败: {e}", path_to_string(&config_path)))
}

fn set_toml_feature_hooks(content: &str) -> String {
    let mut lines: Vec<String> = content.lines().map(ToString::to_string).collect();
    let mut features_header_index = None;
    for (index, line) in lines.iter().enumerate() {
        if line.trim() == "[features]" {
            features_header_index = Some(index);
            break;
        }
    }

    let Some(header_index) = features_header_index else {
        if !lines.is_empty() && lines.last().is_some_and(|line| !line.trim().is_empty()) {
            lines.push(String::new());
        }
        lines.push("[features]".to_string());
        lines.push("hooks = true".to_string());
        return format!("{}\n", lines.join("\n"));
    };

    let mut insert_index = lines.len();
    for index in header_index + 1..lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            insert_index = index;
            break;
        }
        if trimmed.split_once('=').is_some_and(|(key, _)| key.trim() == "hooks") {
            lines[index] = "hooks = true".to_string();
            return format!("{}\n", lines.join("\n"));
        }
    }

    lines.insert(insert_index, "hooks = true".to_string());
    format!("{}\n", lines.join("\n"))
}

fn uninstall_codex_hooks(codex_dir: &Path) -> Result<(), String> {
    let hooks_dir = codex_dir.join("hooks");
    remove_file_if_exists(&hooks_dir.join(CODEX_ATTENTION_SCRIPT_NAME))?;
    remove_file_if_exists(&hooks_dir.join(CODEX_FINISHED_SCRIPT_NAME))?;

    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    remove_hook_commands(
        &mut settings,
        &["PermissionRequest", "Stop"],
        &[CODEX_ATTENTION_SCRIPT_NAME, CODEX_FINISHED_SCRIPT_NAME],
    );
    write_json(&hooks_path, &settings)
}

fn resolve_claude_dir(
    selected_dir: Option<String>,
    require_existing: bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(dir) = selected_dir.and_then(|value| normalize_selected_dir(&value)) {
        if !dir.is_dir() {
            return Err("选择的 Claude 配置目录不存在".to_string());
        }
        return Ok(Some(dir));
    }

    let Some(home_dir) = home_dir() else {
        return Ok(None);
    };
    let default_dir = home_dir.join(".claude");
    if default_dir.is_dir() {
        Ok(Some(default_dir))
    } else if require_existing {
        Err("未找到默认 Claude 配置目录，请手动选择目录".to_string())
    } else {
        Ok(None)
    }
}

fn resolve_codex_dir(selected_dir: Option<String>, create_if_missing: bool) -> Result<Option<PathBuf>, String> {
    if let Some(dir) = selected_dir.and_then(|value| normalize_selected_dir(&value)) {
        if dir.is_dir() {
            return Ok(Some(dir));
        }
        if create_if_missing {
            fs::create_dir_all(&dir).map_err(|e| format!("创建 Codex 配置目录失败: {e}"))?;
            return Ok(Some(dir));
        }
        return Err("选择的 Codex 配置目录不存在".to_string());
    }

    let Some(home_dir) = home_dir() else {
        return Ok(None);
    };
    let default_dir = home_dir.join(".codex");
    if default_dir.is_dir() {
        Ok(Some(default_dir))
    } else if create_if_missing {
        fs::create_dir_all(&default_dir).map_err(|e| format!("创建 Codex 配置目录失败: {e}"))?;
        Ok(Some(default_dir))
    } else {
        Ok(None)
    }
}

fn normalize_selected_dir(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("HOME").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

fn build_claude_status(claude_dir: Option<PathBuf>) -> Result<ToolHookSettingsStatus, String> {
    let Some(claude_dir) = claude_dir else {
        return missing_status();
    };

    let hooks_dir = claude_dir.join("hooks");
    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let attention_command =
        build_command(&hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME), "Notification");
    let stop_command = build_command(&hooks_dir.join(CLAUDE_FINISHED_SCRIPT_NAME), "Stop");
    let failure_command =
        build_command(&hooks_dir.join(CLAUDE_FINISHED_SCRIPT_NAME), "StopFailure");
    let settings = read_json_if_exists(&settings_path)?;
    let checks = ToolChecks {
        attention_script_installed: hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME).is_file(),
        finished_script_installed: hooks_dir.join(CLAUDE_FINISHED_SCRIPT_NAME).is_file(),
        attention_hook_installed: exact_command_registered(
            &settings,
            "Notification",
            &attention_command,
        ),
        stop_hook_installed: exact_command_registered(&settings, "Stop", &stop_command),
        failure_hook_installed: exact_command_registered(
            &settings,
            "StopFailure",
            &failure_command,
        ),
        failure_hook_required: true,
    };

    Ok(status_from_checks(
        Some(claude_dir),
        Some(hooks_dir),
        Some(settings_path),
        checks,
    ))
}

fn build_codex_status(codex_dir: Option<PathBuf>) -> Result<ToolHookSettingsStatus, String> {
    let Some(codex_dir) = codex_dir else {
        return missing_status();
    };

    let hooks_dir = codex_dir.join("hooks");
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let attention_command = build_command(
        &hooks_dir.join(CODEX_ATTENTION_SCRIPT_NAME),
        "PermissionRequest",
    );
    let stop_command = build_command(&hooks_dir.join(CODEX_FINISHED_SCRIPT_NAME), "Stop");
    let settings = read_json_if_exists(&hooks_path)?;
    let checks = ToolChecks {
        attention_script_installed: hooks_dir.join(CODEX_ATTENTION_SCRIPT_NAME).is_file(),
        finished_script_installed: hooks_dir.join(CODEX_FINISHED_SCRIPT_NAME).is_file(),
        attention_hook_installed: exact_command_registered(
            &settings,
            "PermissionRequest",
            &attention_command,
        ),
        stop_hook_installed: exact_command_registered(&settings, "Stop", &stop_command),
        failure_hook_installed: false,
        failure_hook_required: false,
    };

    Ok(status_from_checks(
        Some(codex_dir),
        Some(hooks_dir),
        Some(hooks_path),
        checks,
    ))
}

struct ToolChecks {
    attention_script_installed: bool,
    finished_script_installed: bool,
    attention_hook_installed: bool,
    stop_hook_installed: bool,
    failure_hook_installed: bool,
    failure_hook_required: bool,
}

fn missing_status() -> Result<ToolHookSettingsStatus, String> {
    Ok(ToolHookSettingsStatus {
        config_dir: None,
        hooks_dir: None,
        config_path: None,
        status: HookInstallStatus::DirectoryMissing,
        attention_script_installed: false,
        finished_script_installed: false,
        attention_hook_installed: false,
        stop_hook_installed: false,
        failure_hook_installed: false,
    })
}

fn status_from_checks(
    config_dir: Option<PathBuf>,
    hooks_dir: Option<PathBuf>,
    config_path: Option<PathBuf>,
    checks: ToolChecks,
) -> ToolHookSettingsStatus {
    let mut values = vec![
        checks.attention_script_installed,
        checks.finished_script_installed,
        checks.attention_hook_installed,
        checks.stop_hook_installed,
    ];
    if checks.failure_hook_required {
        values.push(checks.failure_hook_installed);
    }
    let status = if values.iter().all(|installed| *installed) {
        HookInstallStatus::Installed
    } else if values.iter().any(|installed| *installed) {
        HookInstallStatus::PartialInstalled
    } else {
        HookInstallStatus::NotInstalled
    };

    ToolHookSettingsStatus {
        config_dir: config_dir.as_deref().map(path_to_string),
        hooks_dir: hooks_dir.as_deref().map(path_to_string),
        config_path: config_path.as_deref().map(path_to_string),
        status,
        attention_script_installed: checks.attention_script_installed,
        finished_script_installed: checks.finished_script_installed,
        attention_hook_installed: checks.attention_hook_installed,
        stop_hook_installed: checks.stop_hook_installed,
        failure_hook_installed: checks.failure_hook_installed,
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(content) => {
            if content.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(&content)
                    .map_err(|e| format!("解析 {} 失败: {e}", path_to_string(path)))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("读取 {} 失败: {e}", path_to_string(path))),
    }
}

fn read_json_if_exists(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(content) => {
            if content.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(&content)
                    .map_err(|e| format!("解析 {} 失败: {e}", path_to_string(path)))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("读取 {} 失败: {e}", path_to_string(path))),
    }
}

fn ensure_root_object(settings: &Value, file_name: &str) -> Result<(), String> {
    if settings.is_object() {
        Ok(())
    } else {
        Err(format!("{file_name} 根节点必须是 JSON 对象"))
    }
}

fn write_json(path: &Path, settings: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("序列化 {} 失败: {e}", path_to_string(path)))?;
    fs::write(path, format!("{content}\n"))
        .map_err(|e| format!("写入 {} 失败: {e}", path_to_string(path)))
}

fn add_hook_command(settings: &mut Value, event: &str, command: String) {
    let root = ensure_object(settings);
    let hooks = ensure_child_object(root, "hooks");
    let event_value = hooks
        .entry(event.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !event_value.is_array() {
        *event_value = Value::Array(Vec::new());
    }
    if event_has_exact_command(event_value, &command) {
        return;
    }
    if let Value::Array(entries) = event_value {
        entries.push(json!({
            "matcher": "",
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "timeout": 15
                }
            ]
        }));
    }
}

fn remove_hook_commands(settings: &mut Value, events: &[&str], script_names: &[&str]) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };

    let mut empty_events = Vec::new();
    for event in events {
        let Some(Value::Array(entries)) = hooks.get_mut(*event) else {
            continue;
        };

        entries.retain_mut(|entry| {
            let Some(entry_object) = entry.as_object_mut() else {
                return true;
            };
            let Some(Value::Array(commands)) = entry_object.get_mut("hooks") else {
                return true;
            };
            commands.retain(|hook| !is_cli_manager_command(hook, script_names));
            !commands.is_empty()
        });

        if entries.is_empty() {
            empty_events.push((*event).to_string());
        }
    }

    for event in empty_events {
        hooks.remove(&event);
    }

    if hooks.is_empty() {
        if let Some(root) = settings.as_object_mut() {
            root.remove("hooks");
        }
    }
}

fn exact_command_registered(settings: &Value, event: &str, command: &str) -> bool {
    settings
        .get("hooks")
        .and_then(|hooks| hooks.get(event))
        .is_some_and(|event_value| event_has_exact_command(event_value, command))
}

fn event_has_exact_command(event_value: &Value, command: &str) -> bool {
    event_value.as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry
                .get("hooks")
                .and_then(Value::as_array)
                .is_some_and(|hooks| {
                    hooks.iter().any(|hook| {
                        hook.get("command")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value == command)
                    })
                })
        })
    })
}

fn is_cli_manager_command(hook: &Value, script_names: &[&str]) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            script_names
                .iter()
                .any(|script_name| command.contains(script_name))
        })
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value was just made object")
}

fn ensure_child_object<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value was just made object")
}

fn build_command(script_path: &Path, event: &str) -> String {
    format!(
        "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\" -Event {}",
        path_to_string(script_path),
        event
    )
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除 {} 失败: {e}", path_to_string(path))),
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}
