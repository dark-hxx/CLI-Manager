use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const APPROVAL_SCRIPT_NAME: &str = "notify-cli-manager-approval.ps1";
const FINISHED_SCRIPT_NAME: &str = "notify-cli-manager-finished.ps1";
const SETTINGS_FILE_NAME: &str = "settings.json";

const APPROVAL_SCRIPT: &str = r#"param(
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

const FINISHED_SCRIPT: &str = r#"param(
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSettingsStatus {
    claude_dir: Option<String>,
    hooks_dir: Option<String>,
    settings_path: Option<String>,
    status: HookInstallStatus,
    approval_script_installed: bool,
    finished_script_installed: bool,
    notification_hook_installed: bool,
    stop_hook_installed: bool,
    stop_failure_hook_installed: bool,
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
) -> Result<HookSettingsStatus, String> {
    build_status(resolve_claude_dir(selected_dir, false)?)
}

#[tauri::command]
pub async fn hook_settings_install(
    selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, true)?
        .ok_or_else(|| "请先选择 Claude 配置目录".to_string())?;
    let hooks_dir = claude_dir.join("hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| format!("创建 hooks 目录失败: {e}"))?;

    fs::write(hooks_dir.join(APPROVAL_SCRIPT_NAME), APPROVAL_SCRIPT)
        .map_err(|e| format!("写入 approval hook 脚本失败: {e}"))?;
    fs::write(hooks_dir.join(FINISHED_SCRIPT_NAME), FINISHED_SCRIPT)
        .map_err(|e| format!("写入 finished hook 脚本失败: {e}"))?;

    let mut settings = read_settings_json(&claude_dir.join(SETTINGS_FILE_NAME))?;
    ensure_settings_root_object(&settings)?;
    add_hook_command(
        &mut settings,
        "Notification",
        build_command(&hooks_dir.join(APPROVAL_SCRIPT_NAME), "Notification"),
    );
    add_hook_command(
        &mut settings,
        "Stop",
        build_command(&hooks_dir.join(FINISHED_SCRIPT_NAME), "Stop"),
    );
    add_hook_command(
        &mut settings,
        "StopFailure",
        build_command(&hooks_dir.join(FINISHED_SCRIPT_NAME), "StopFailure"),
    );
    write_settings_json(&claude_dir.join(SETTINGS_FILE_NAME), &settings)?;

    build_status(Some(claude_dir))
}

#[tauri::command]
pub async fn hook_settings_uninstall(
    selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, true)?
        .ok_or_else(|| "请先选择 Claude 配置目录".to_string())?;
    let hooks_dir = claude_dir.join("hooks");

    remove_file_if_exists(&hooks_dir.join(APPROVAL_SCRIPT_NAME))?;
    remove_file_if_exists(&hooks_dir.join(FINISHED_SCRIPT_NAME))?;

    let settings_path = claude_dir.join(SETTINGS_FILE_NAME);
    let mut settings = read_settings_json(&settings_path)?;
    ensure_settings_root_object(&settings)?;
    remove_hook_commands(&mut settings);
    write_settings_json(&settings_path, &settings)?;

    build_status(Some(claude_dir))
}

#[tauri::command]
pub async fn hook_settings_select_dir(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Select Claude config directory")
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

fn build_status(claude_dir: Option<PathBuf>) -> Result<HookSettingsStatus, String> {
    let Some(claude_dir) = claude_dir else {
        return Ok(HookSettingsStatus {
            claude_dir: None,
            hooks_dir: None,
            settings_path: None,
            status: HookInstallStatus::DirectoryMissing,
            approval_script_installed: false,
            finished_script_installed: false,
            notification_hook_installed: false,
            stop_hook_installed: false,
            stop_failure_hook_installed: false,
        });
    };

    let hooks_dir = claude_dir.join("hooks");
    let settings_path = claude_dir.join(SETTINGS_FILE_NAME);
    let approval_script_installed = hooks_dir.join(APPROVAL_SCRIPT_NAME).is_file();
    let finished_script_installed = hooks_dir.join(FINISHED_SCRIPT_NAME).is_file();
    let settings = read_settings_json_if_exists(&settings_path)?;
    let notification_hook_installed = exact_command_registered(
        &settings,
        "Notification",
        &build_command(&hooks_dir.join(APPROVAL_SCRIPT_NAME), "Notification"),
    );
    let stop_hook_installed = exact_command_registered(
        &settings,
        "Stop",
        &build_command(&hooks_dir.join(FINISHED_SCRIPT_NAME), "Stop"),
    );
    let stop_failure_hook_installed = exact_command_registered(
        &settings,
        "StopFailure",
        &build_command(&hooks_dir.join(FINISHED_SCRIPT_NAME), "StopFailure"),
    );

    let checks = [
        approval_script_installed,
        finished_script_installed,
        notification_hook_installed,
        stop_hook_installed,
        stop_failure_hook_installed,
    ];
    let status = if checks.iter().all(|installed| *installed) {
        HookInstallStatus::Installed
    } else if checks.iter().any(|installed| *installed) {
        HookInstallStatus::PartialInstalled
    } else {
        HookInstallStatus::NotInstalled
    };

    Ok(HookSettingsStatus {
        claude_dir: Some(path_to_string(&claude_dir)),
        hooks_dir: Some(path_to_string(&hooks_dir)),
        settings_path: Some(path_to_string(&settings_path)),
        status,
        approval_script_installed,
        finished_script_installed,
        notification_hook_installed,
        stop_hook_installed,
        stop_failure_hook_installed,
    })
}

fn read_settings_json(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(content) => {
            if content.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(&content).map_err(|e| format!("解析 settings.json 失败: {e}"))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("读取 settings.json 失败: {e}")),
    }
}

fn read_settings_json_if_exists(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(content) => {
            if content.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(&content).map_err(|e| format!("解析 settings.json 失败: {e}"))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("读取 settings.json 失败: {e}")),
    }
}

fn ensure_settings_root_object(settings: &Value) -> Result<(), String> {
    if settings.is_object() {
        Ok(())
    } else {
        Err("settings.json 根节点必须是 JSON 对象".to_string())
    }
}

fn write_settings_json(path: &Path, settings: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("序列化 settings.json 失败: {e}"))?;
    fs::write(path, format!("{content}\n")).map_err(|e| format!("写入 settings.json 失败: {e}"))
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

fn remove_hook_commands(settings: &mut Value) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };

    let mut empty_events = Vec::new();
    for event in ["Notification", "Stop", "StopFailure"] {
        let Some(Value::Array(entries)) = hooks.get_mut(event) else {
            continue;
        };

        entries.retain_mut(|entry| {
            let Some(entry_object) = entry.as_object_mut() else {
                return true;
            };
            let Some(Value::Array(commands)) = entry_object.get_mut("hooks") else {
                return true;
            };
            commands.retain(|hook| !is_cli_manager_command(hook));
            !commands.is_empty()
        });

        if entries.is_empty() {
            empty_events.push(event.to_string());
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

fn is_cli_manager_command(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            command.contains(APPROVAL_SCRIPT_NAME) || command.contains(FINISHED_SCRIPT_NAME)
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
