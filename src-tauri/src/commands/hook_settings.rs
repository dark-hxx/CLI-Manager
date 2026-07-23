use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const CLAUDE_APPROVAL_SCRIPT_NAME: &str = "notify-cli-manager-approval.ps1";
const CLAUDE_FINISHED_SCRIPT_NAME: &str = "notify-cli-manager-finished.ps1";
const CODEX_ATTENTION_SCRIPT_NAME: &str = "notify-cli-manager-codex-attention.ps1";
const CODEX_FINISHED_SCRIPT_NAME: &str = "notify-cli-manager-codex-finished.ps1";
const CLAUDE_SETTINGS_FILE_NAME: &str = "settings.json";
const CODEX_HOOKS_FILE_NAME: &str = "hooks.json";
const CODEX_CONFIG_FILE_NAME: &str = "config.toml";
const GROK_HOOKS_FILE_NAME: &str = "cli-manager.json";
const GROK_CONFIG_FILE_NAME: &str = "config.toml";

const HOOK_COMMAND_MARKER: &str = "__hook";
const CODEX_COMMON_CONFIG_HOOKS_MARKER: &str = "# CLI-Manager hook protection";
const CCSWITCH_COMMON_CONFIG_CLAUDE_KEY: &str = "common_config_claude";
const CCSWITCH_COMMON_CONFIG_CODEX_KEY: &str = "common_config_codex";
const CLAUDE_HOOK_EVENTS: [&str; 9] = [
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreToolUse",
    "PostToolUse",
];
const CODEX_HOOK_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Stop",
    "SubagentStart",
    "SubagentStop",
];
const CLAUDE_LEGACY_SCRIPTS: [&str; 2] = [CLAUDE_APPROVAL_SCRIPT_NAME, CLAUDE_FINISHED_SCRIPT_NAME];
const CODEX_LEGACY_SCRIPTS: [&str; 2] = [CODEX_ATTENTION_SCRIPT_NAME, CODEX_FINISHED_SCRIPT_NAME];
const PI_EXTENSION_DIR_NAME: &str = "extensions";
const PI_EXTENSION_FILE_NAME: &str = "cli-manager-hook.ts";
const PI_EXTENSION_MARKER: &str = "__CLI_MANAGER_PI_HOOK__";
const PI_MODULE_SESSION_START: &str = "CLI_MANAGER_MODULE:sessionStart";
const PI_MODULE_RUNNING: &str = "CLI_MANAGER_MODULE:running";
const PI_MODULE_STOP: &str = "CLI_MANAGER_MODULE:stop";
const PI_EXTENSION_CONFLICT_ERROR: &str = "pi_extension_conflict";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSettingsStatus {
    claude: ToolHookSettingsStatus,
    codex: ToolHookSettingsStatus,
    pi: ToolHookSettingsStatus,
    grok: ToolHookSettingsStatus,
    cc_switch: CcSwitchHookProtectionStatus,
    claude_auto_repaired: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHookSettingsStatus {
    config_dir: Option<String>,
    hooks_dir: Option<String>,
    config_path: Option<String>,
    feature_config_path: Option<String>,
    status: HookInstallStatus,
    attention_script_installed: bool,
    finished_script_installed: bool,
    session_start_hook_installed: bool,
    running_hook_installed: bool,
    attention_hook_installed: bool,
    stop_hook_installed: bool,
    failure_hook_installed: bool,
    subagent_start_hook_installed: bool,
    hooks_feature_installed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum HookInstallStatus {
    DirectoryMissing,
    NotInstalled,
    PartialInstalled,
    Installed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchHookProtectionStatus {
    pub state: CcSwitchHookProtectionState,
    pub db_path: Option<String>,
    pub message: Option<String>,
    pub wsl_mismatch: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CcSwitchHookProtectionState {
    NotDetected,
    NotSynced,
    Synced,
    InvalidDb,
    Unavailable,
    SyncFailed,
}

#[derive(Clone, Copy)]
enum CcSwitchSyncMode {
    Install,
    Uninstall,
}

#[derive(Clone, Copy)]
enum CommonConfigTool {
    Claude,
    Codex,
}

#[derive(Clone, Copy)]
enum ClaudeHookModule {
    SessionStart,
    Running,
    Attention,
    Stop,
    Failure,
    Subagent,
}

#[derive(Clone, Copy)]
enum CodexHookModule {
    SessionStart,
    Running,
    Attention,
    Stop,
    Subagent,
    HooksFeature,
}

#[derive(Clone, Copy)]
enum PiHookModule {
    SessionStart,
    Running,
    Stop,
}

#[tauri::command]
pub async fn hook_settings_get_status(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    auto_repair: Option<bool>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let mut claude_auto_repaired = false;

    if auto_repair.unwrap_or(false) {
        if let Some(dir) = claude_dir.as_ref() {
            let current = build_claude_status(Some(dir.clone()))?;
            if !matches!(current.status, HookInstallStatus::Installed) {
                install_claude_hooks(dir)?;
                sync_ccswitch_tool_common_config(
                    &app,
                    cc_switch_db_path.clone(),
                    dir,
                    CommonConfigTool::Claude,
                    CcSwitchSyncMode::Install,
                )
                .await;
                claude_auto_repaired = true;
            }
        }
    }

    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status(codex_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        claude_dir.as_deref(),
        codex_dir.as_deref(),
        &claude,
        &codex,
    )
    .await;

    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired,
    })
}

#[tauri::command]
pub async fn hook_settings_install(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
    sync_cc_switch_common_config: Option<bool>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, true)?
        .ok_or_else(|| "请先选择 Claude 配置目录".to_string())?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_claude_hook_module(module)?;
    if let Some(module) = requested_module {
        install_claude_hook_module(&claude_dir, module)?;
    } else {
        install_claude_hooks(&claude_dir)?;
    }
    let claude = build_claude_status(Some(claude_dir.clone()))?;
    if sync_cc_switch_common_config.unwrap_or(true) {
        if requested_module.is_some() {
            sync_ccswitch_for_tool_status(
                &app,
                cc_switch_db_path.clone(),
                &claude_dir,
                CommonConfigTool::Claude,
                &claude,
            )
            .await;
        } else {
            sync_ccswitch_tool_common_config(
                &app,
                cc_switch_db_path.clone(),
                &claude_dir,
                CommonConfigTool::Claude,
                CcSwitchSyncMode::Install,
            )
            .await;
            if let Some(codex_dir) = codex_dir.as_ref() {
                let codex_status = build_codex_status(Some(codex_dir.clone()))?;
                if hook_status_has_hooks(&codex_status) {
                    sync_ccswitch_tool_common_config(
                        &app,
                        cc_switch_db_path.clone(),
                        codex_dir,
                        CommonConfigTool::Codex,
                        CcSwitchSyncMode::Install,
                    )
                    .await;
                }
            }
        }
    }
    let codex = build_codex_status(codex_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        Some(&claude_dir),
        codex_dir.as_deref(),
        &claude,
        &codex,
    )
    .await;
    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
    sync_cc_switch_common_config: Option<bool>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, true)?
        .ok_or_else(|| "请先选择 Claude 配置目录".to_string())?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_claude_hook_module(module)?;
    if let Some(module) = requested_module {
        uninstall_claude_hook_module(&claude_dir, module)?;
    } else {
        uninstall_claude_hooks(&claude_dir)?;
    }
    let claude = build_claude_status(Some(claude_dir.clone()))?;
    if sync_cc_switch_common_config.unwrap_or(true) {
        if requested_module.is_some() {
            sync_ccswitch_for_tool_status(
                &app,
                cc_switch_db_path.clone(),
                &claude_dir,
                CommonConfigTool::Claude,
                &claude,
            )
            .await;
        } else {
            sync_ccswitch_tool_common_config(
                &app,
                cc_switch_db_path.clone(),
                &claude_dir,
                CommonConfigTool::Claude,
                CcSwitchSyncMode::Uninstall,
            )
            .await;
        }
    }
    let codex = build_codex_status(codex_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        Some(&claude_dir),
        codex_dir.as_deref(),
        &claude,
        &codex,
    )
    .await;
    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_install_codex(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
    sync_cc_switch_common_config: Option<bool>,
) -> Result<HookSettingsStatus, String> {
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?
        .ok_or_else(|| "请先选择 Codex 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_codex_hook_module(module)?;
    if let Some(module) = requested_module {
        install_codex_hook_module(&codex_dir, module)?;
    } else {
        install_codex_hooks(&codex_dir)?;
    }
    let codex = build_codex_status(Some(codex_dir.clone()))?;
    if sync_cc_switch_common_config.unwrap_or(true) {
        if requested_module.is_some() {
            sync_ccswitch_for_tool_status(
                &app,
                cc_switch_db_path.clone(),
                &codex_dir,
                CommonConfigTool::Codex,
                &codex,
            )
            .await;
        } else {
            sync_ccswitch_tool_common_config(
                &app,
                cc_switch_db_path.clone(),
                &codex_dir,
                CommonConfigTool::Codex,
                CcSwitchSyncMode::Install,
            )
            .await;
            if let Some(claude_dir) = claude_dir.as_ref() {
                let claude_status = build_claude_status(Some(claude_dir.clone()))?;
                if hook_status_has_hooks(&claude_status) {
                    sync_ccswitch_tool_common_config(
                        &app,
                        cc_switch_db_path.clone(),
                        claude_dir,
                        CommonConfigTool::Claude,
                        CcSwitchSyncMode::Install,
                    )
                    .await;
                }
            }
        }
    }
    let claude = build_claude_status(claude_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        claude_dir.as_deref(),
        Some(&codex_dir),
        &claude,
        &codex,
    )
    .await;
    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall_codex(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
    sync_cc_switch_common_config: Option<bool>,
) -> Result<HookSettingsStatus, String> {
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?
        .ok_or_else(|| "未找到 Codex 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_codex_hook_module(module)?;
    if let Some(module) = requested_module {
        uninstall_codex_hook_module(&codex_dir, module)?;
    } else {
        uninstall_codex_hooks(&codex_dir)?;
    }
    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status(Some(codex_dir.clone()))?;
    if sync_cc_switch_common_config.unwrap_or(true) {
        if requested_module.is_some() {
            sync_ccswitch_for_tool_status(
                &app,
                cc_switch_db_path.clone(),
                &codex_dir,
                CommonConfigTool::Codex,
                &codex,
            )
            .await;
        } else {
            sync_ccswitch_tool_common_config(
                &app,
                cc_switch_db_path.clone(),
                &codex_dir,
                CommonConfigTool::Codex,
                CcSwitchSyncMode::Uninstall,
            )
            .await;
        }
    }
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        claude_dir.as_deref(),
        Some(&codex_dir),
        &claude,
        &codex,
    )
    .await;
    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_install_pi(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let pi_dir = resolve_pi_dir(pi_selected_dir, true)?
        .ok_or_else(|| "请先选择 Pi 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_pi_hook_module(module)?;
    if let Some(module) = requested_module {
        install_pi_hook_module(&pi_dir, module)?;
    } else {
        install_pi_hooks(&pi_dir)?;
    }
    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status(codex_dir.clone())?;
    let pi = build_pi_status(Some(pi_dir.clone()))?;
    let grok = build_grok_status(grok_dir.clone())?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        claude_dir.as_deref(),
        codex_dir.as_deref(),
        &claude,
        &codex,
    )
    .await;
    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall_pi(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?
        .ok_or_else(|| "未找到 Pi 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_pi_hook_module(module)?;
    if let Some(module) = requested_module {
        uninstall_pi_hook_module(&pi_dir, module)?;
    } else {
        uninstall_pi_hooks(&pi_dir)?;
    }
    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status(codex_dir.clone())?;
    let pi = build_pi_status(Some(pi_dir.clone()))?;
    let grok = build_grok_status(grok_dir.clone())?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        claude_dir.as_deref(),
        codex_dir.as_deref(),
        &claude,
        &codex,
    )
    .await;
    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired: false,
    })
}


#[tauri::command]
pub async fn hook_settings_install_grok(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let grok_dir = resolve_grok_dir(grok_selected_dir, true)?
        .ok_or_else(|| "请先选择 Grok 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let requested_module = parse_claude_hook_module(module)?;
    if let Some(module) = requested_module {
        install_grok_hook_module(&grok_dir, module)?;
    } else {
        install_grok_hooks(&grok_dir)?;
    }
    // Always enforce cross-vendor hook isolation on install (full or module).
    disable_grok_cross_vendor_hooks(&grok_dir)?;
    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status(codex_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(Some(grok_dir.clone()))?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        claude_dir.as_deref(),
        codex_dir.as_deref(),
        &claude,
        &codex,
    )
    .await;
    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall_grok(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?
        .ok_or_else(|| "未找到 Grok 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let requested_module = parse_claude_hook_module(module)?;
    if let Some(module) = requested_module {
        uninstall_grok_hook_module(&grok_dir, module)?;
    } else {
        uninstall_grok_hooks(&grok_dir)?;
    }
    // Do not re-enable compat.*.hooks on uninstall (product decision).
    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status(codex_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(Some(grok_dir.clone()))?;
    let cc_switch = inspect_ccswitch_hook_protection(
        &app,
        cc_switch_db_path,
        claude_dir.as_deref(),
        codex_dir.as_deref(),
        &claude,
        &codex,
    )
    .await;
    Ok(HookSettingsStatus {
        claude,
        codex,
        pi,
        grok,
        cc_switch,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_select_dir(

    app: AppHandle,
    title: Option<String>,
) -> Result<Option<String>, String> {
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

fn cc_switch_not_detected() -> CcSwitchHookProtectionStatus {
    CcSwitchHookProtectionStatus {
        state: CcSwitchHookProtectionState::NotDetected,
        db_path: None,
        message: None,
        wsl_mismatch: false,
    }
}

fn cc_switch_status(
    state: CcSwitchHookProtectionState,
    db_path: Option<&Path>,
    message: Option<String>,
    _claude_dir: &Path,
) -> CcSwitchHookProtectionStatus {
    CcSwitchHookProtectionStatus {
        state,
        db_path: db_path.map(path_to_string),
        message,
        wsl_mismatch: false,
    }
}

fn explicit_db_path(db_path: &Option<String>) -> Option<String> {
    db_path
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn derive_wsl_ccswitch_db_path(claude_dir: &Path) -> Option<PathBuf> {
    let claude_dir = path_to_string(claude_dir);
    let (distro, linux_path) = crate::wsl::parse_wsl_unc_path(&claude_dir)?;
    let home_path = linux_path.strip_suffix("/.claude")?;
    Some(PathBuf::from(crate::wsl::linux_to_unc_wsl_path(
        &format!("{home_path}/.cc-switch/cc-switch.db"),
        &distro,
    )))
}

fn resolve_ccswitch_db_path_for_hook(
    app: &AppHandle,
    db_path: Option<String>,
    claude_dir: &Path,
) -> Result<PathBuf, CcSwitchHookProtectionStatus> {
    let explicit = explicit_db_path(&db_path);
    if explicit.is_none() {
        if let Some(candidate) = derive_wsl_ccswitch_db_path(claude_dir) {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    match super::ccswitch::resolve_db_path(app, db_path) {
        Ok(path) => Ok(path),
        Err(err) if explicit.is_none() && err == "db_not_found" => Err(cc_switch_not_detected()),
        Err(err) if explicit.is_some() => Err(CcSwitchHookProtectionStatus {
            state: CcSwitchHookProtectionState::InvalidDb,
            db_path: explicit,
            message: Some(err),
            wsl_mismatch: false,
        }),
        Err(err) => Err(CcSwitchHookProtectionStatus {
            state: CcSwitchHookProtectionState::SyncFailed,
            db_path: None,
            message: Some(err),
            wsl_mismatch: false,
        }),
    }
}

async fn open_db_readwrite(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("db_open_failed: {err}"))
}

async fn open_db_readonly(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("db_open_failed: {err}"))
}

impl CommonConfigTool {
    fn key(self) -> &'static str {
        match self {
            CommonConfigTool::Claude => CCSWITCH_COMMON_CONFIG_CLAUDE_KEY,
            CommonConfigTool::Codex => CCSWITCH_COMMON_CONFIG_CODEX_KEY,
        }
    }

    fn config_name(self) -> &'static str {
        match self {
            CommonConfigTool::Claude => "common_config_claude",
            CommonConfigTool::Codex => "common_config_codex",
        }
    }

    fn legacy_scripts(self) -> &'static [&'static str] {
        match self {
            CommonConfigTool::Claude => &CLAUDE_LEGACY_SCRIPTS,
            CommonConfigTool::Codex => &CODEX_LEGACY_SCRIPTS,
        }
    }

    fn events(self) -> &'static [&'static str] {
        match self {
            CommonConfigTool::Claude => &CLAUDE_HOOK_EVENTS,
            CommonConfigTool::Codex => &CODEX_HOOK_EVENTS,
        }
    }
}

const ALL_CLAUDE_HOOK_MODULES: [ClaudeHookModule; 6] = [
    ClaudeHookModule::SessionStart,
    ClaudeHookModule::Running,
    ClaudeHookModule::Attention,
    ClaudeHookModule::Stop,
    ClaudeHookModule::Failure,
    ClaudeHookModule::Subagent,
];

const ALL_CODEX_HOOK_COMMAND_MODULES: [CodexHookModule; 5] = [
    CodexHookModule::SessionStart,
    CodexHookModule::Running,
    CodexHookModule::Attention,
    CodexHookModule::Stop,
    CodexHookModule::Subagent,
];

const ALL_PI_HOOK_MODULES: [PiHookModule; 3] = [
    PiHookModule::SessionStart,
    PiHookModule::Running,
    PiHookModule::Stop,
];

fn parse_claude_hook_module(module: Option<String>) -> Result<Option<ClaudeHookModule>, String> {
    module
        .map(|value| match value.as_str() {
            "sessionStart" => Ok(ClaudeHookModule::SessionStart),
            "running" => Ok(ClaudeHookModule::Running),
            "attention" => Ok(ClaudeHookModule::Attention),
            "stop" => Ok(ClaudeHookModule::Stop),
            "failure" => Ok(ClaudeHookModule::Failure),
            "subagent" => Ok(ClaudeHookModule::Subagent),
            "hooksFeature" => Err("Claude 不支持 hooksFeature 模块".to_string()),
            other => Err(format!("未知的 Claude Hook 模块: {other}")),
        })
        .transpose()
}

fn parse_codex_hook_module(module: Option<String>) -> Result<Option<CodexHookModule>, String> {
    module
        .map(|value| match value.as_str() {
            "sessionStart" => Ok(CodexHookModule::SessionStart),
            "running" => Ok(CodexHookModule::Running),
            "attention" => Ok(CodexHookModule::Attention),
            "stop" => Ok(CodexHookModule::Stop),
            "subagent" => Ok(CodexHookModule::Subagent),
            "hooksFeature" => Ok(CodexHookModule::HooksFeature),
            "failure" => Err("Codex 不支持 failure 模块".to_string()),
            other => Err(format!("未知的 Codex Hook 模块: {other}")),
        })
        .transpose()
}

fn parse_pi_hook_module(module: Option<String>) -> Result<Option<PiHookModule>, String> {
    module
        .map(|value| match value.as_str() {
            "sessionStart" => Ok(PiHookModule::SessionStart),
            "running" => Ok(PiHookModule::Running),
            "stop" => Ok(PiHookModule::Stop),
            other => Err(format!("未知的 Pi Hook 模块: {other}")),
        })
        .transpose()
}

fn apply_claude_hook_commands(settings: &mut Value, exe: &str) {
    remove_hook_commands(settings, &CLAUDE_HOOK_EVENTS, &CLAUDE_LEGACY_SCRIPTS);
    for module in ALL_CLAUDE_HOOK_MODULES {
        apply_claude_hook_module(settings, exe, module);
    }
}

fn apply_claude_hook_module(settings: &mut Value, exe: &str, module: ClaudeHookModule) {
    match module {
        ClaudeHookModule::SessionStart => add_hook_command(
            settings,
            "SessionStart",
            build_command(exe, "claude", "SessionStart"),
        ),
        ClaudeHookModule::Running => add_hook_command(
            settings,
            "UserPromptSubmit",
            build_command(exe, "claude", "UserPromptSubmit"),
        ),
        ClaudeHookModule::Attention => add_hook_command_with_matcher(
            settings,
            "Notification",
            "permission_prompt|idle_prompt",
            build_command(exe, "claude", "Notification"),
        ),
        ClaudeHookModule::Stop => {
            add_hook_command(settings, "Stop", build_command(exe, "claude", "Stop"))
        }
        ClaudeHookModule::Failure => add_hook_command(
            settings,
            "StopFailure",
            build_command(exe, "claude", "StopFailure"),
        ),
        ClaudeHookModule::Subagent => {
            add_hook_command(
                settings,
                "SubagentStart",
                build_command(exe, "claude", "SubagentStart"),
            );
            add_hook_command(
                settings,
                "SubagentStop",
                build_command(exe, "claude", "SubagentStop"),
            );
            add_hook_command_with_matcher(
                settings,
                "PreToolUse",
                "Agent|Task",
                build_command(exe, "claude", "AgentToolStart"),
            );
            add_hook_command_with_matcher(
                settings,
                "PostToolUse",
                "Agent|Task",
                build_command(exe, "claude", "AgentToolStop"),
            );
            add_hook_command(
                settings,
                "PreToolUse",
                build_command(exe, "claude", "ToolStart"),
            );
            add_hook_command(
                settings,
                "PostToolUse",
                build_command(exe, "claude", "ToolStop"),
            );
        }
    }
}

fn remove_claude_hook_module(settings: &mut Value, module: ClaudeHookModule) {
    match module {
        ClaudeHookModule::SessionStart => {
            remove_hook_commands(settings, &["SessionStart"], &CLAUDE_LEGACY_SCRIPTS)
        }
        ClaudeHookModule::Running => {
            remove_hook_commands(settings, &["UserPromptSubmit"], &CLAUDE_LEGACY_SCRIPTS)
        }
        ClaudeHookModule::Attention => {
            remove_hook_commands(settings, &["Notification"], &CLAUDE_LEGACY_SCRIPTS)
        }
        ClaudeHookModule::Stop => remove_hook_commands(settings, &["Stop"], &CLAUDE_LEGACY_SCRIPTS),
        ClaudeHookModule::Failure => {
            remove_hook_commands(settings, &["StopFailure"], &CLAUDE_LEGACY_SCRIPTS)
        }
        ClaudeHookModule::Subagent => remove_hook_commands(
            settings,
            &["SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse"],
            &CLAUDE_LEGACY_SCRIPTS,
        ),
    }
}

fn apply_codex_hook_module(settings: &mut Value, exe: &str, module: CodexHookModule) {
    match module {
        CodexHookModule::SessionStart => add_hook_command(
            settings,
            "SessionStart",
            build_command(exe, "codex", "SessionStart"),
        ),
        CodexHookModule::Running => add_hook_command(
            settings,
            "UserPromptSubmit",
            build_command(exe, "codex", "UserPromptSubmit"),
        ),
        CodexHookModule::Attention => add_hook_command(
            settings,
            "PermissionRequest",
            build_command(exe, "codex", "PermissionRequest"),
        ),
        CodexHookModule::Stop => {
            add_hook_command(settings, "Stop", build_command(exe, "codex", "Stop"))
        }
        CodexHookModule::Subagent => {
            add_hook_command(
                settings,
                "SubagentStart",
                build_command(exe, "codex", "SubagentStart"),
            );
            add_hook_command(
                settings,
                "SubagentStop",
                build_command(exe, "codex", "SubagentStop"),
            );
        }
        CodexHookModule::HooksFeature => {}
    }
}

fn remove_codex_hook_module(settings: &mut Value, module: CodexHookModule) {
    match module {
        CodexHookModule::SessionStart => {
            remove_hook_commands(settings, &["SessionStart"], &CODEX_LEGACY_SCRIPTS)
        }
        CodexHookModule::Running => {
            remove_hook_commands(settings, &["UserPromptSubmit"], &CODEX_LEGACY_SCRIPTS)
        }
        CodexHookModule::Attention => {
            remove_hook_commands(settings, &["PermissionRequest"], &CODEX_LEGACY_SCRIPTS)
        }
        CodexHookModule::Stop => remove_hook_commands(settings, &["Stop"], &CODEX_LEGACY_SCRIPTS),
        CodexHookModule::Subagent => remove_hook_commands(
            settings,
            &["SubagentStart", "SubagentStop"],
            &CODEX_LEGACY_SCRIPTS,
        ),
        CodexHookModule::HooksFeature => {}
    }
}

fn merge_common_config_hooks(
    existing: Option<&str>,
    exe: &str,
    tool: CommonConfigTool,
    codex_hook_state_blocks: &[Vec<String>],
) -> Result<String, String> {
    if matches!(tool, CommonConfigTool::Codex) {
        return Ok(merge_codex_common_config_toml(
            existing,
            codex_hook_state_blocks,
        ));
    }

    let mut settings: Value = match existing {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(raw).map_err(|_| "common_config_parse_failed".to_string())?
        }
        _ => Value::Object(Map::new()),
    };
    ensure_root_object(&settings, tool.config_name())?;
    apply_claude_hook_commands(&mut settings, exe);
    let mut text = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("common_config_serialize_failed: {err}"))?;
    text.push('\n');
    Ok(text)
}

#[cfg(test)]
fn merge_claude_common_config_hooks(existing: Option<&str>, exe: &str) -> Result<String, String> {
    merge_common_config_hooks(existing, exe, CommonConfigTool::Claude, &[])
}

#[cfg(test)]
fn merge_codex_common_config_hooks(existing: Option<&str>, exe: &str) -> Result<String, String> {
    merge_common_config_hooks(existing, exe, CommonConfigTool::Codex, &[])
}

fn strip_common_config_hooks(
    existing: Option<&str>,
    tool: CommonConfigTool,
) -> Result<Option<String>, String> {
    let Some(raw) = existing.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    if matches!(tool, CommonConfigTool::Codex) {
        return Ok(strip_codex_common_config_toml(raw));
    }

    let mut settings: Value =
        serde_json::from_str(raw).map_err(|_| "common_config_parse_failed".to_string())?;
    ensure_root_object(&settings, tool.config_name())?;
    remove_hook_commands(&mut settings, tool.events(), tool.legacy_scripts());
    let mut text = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("common_config_serialize_failed: {err}"))?;
    text.push('\n');
    Ok(Some(text))
}

fn merge_common_config_statusline(
    existing: Option<&str>,
    status_line: Value,
) -> Result<String, String> {
    let mut settings: Value = match existing {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(raw).map_err(|_| "common_config_parse_failed".to_string())?
        }
        _ => Value::Object(Map::new()),
    };
    ensure_root_object(&settings, CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)?;
    settings
        .as_object_mut()
        .expect("validated object")
        .insert("statusLine".to_string(), status_line);
    let mut text = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("common_config_serialize_failed: {err}"))?;
    text.push('\n');
    Ok(text)
}

fn strip_common_config_statusline(existing: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = existing.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let mut settings: Value =
        serde_json::from_str(raw).map_err(|_| "common_config_parse_failed".to_string())?;
    ensure_root_object(&settings, CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)?;
    let owned = settings
        .get("statusLine")
        .and_then(Value::as_object)
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains("__statusline"));
    if !owned {
        return Ok(None);
    }
    settings
        .as_object_mut()
        .expect("validated object")
        .remove("statusLine");
    let mut text = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("common_config_serialize_failed: {err}"))?;
    text.push('\n');
    Ok(Some(text))
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn codex_status_line_assignment(items: &[String]) -> String {
    format!(
        "status_line = [{}]",
        items
            .iter()
            .map(|item| toml_string(item))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn merge_common_config_codex_statusline(existing: Option<&str>, items: &[String]) -> String {
    let mut lines: Vec<String> = existing
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.lines().map(ToString::to_string).collect())
        .unwrap_or_default();
    let assignment = codex_status_line_assignment(items);
    let mut tui_header_index = None;
    for (index, line) in lines.iter().enumerate() {
        if line.trim() == "[tui]" {
            tui_header_index = Some(index);
            break;
        }
    }

    if let Some(header_index) = tui_header_index {
        let mut insert_index = lines.len();
        for index in header_index + 1..lines.len() {
            if is_toml_table_header(&lines[index]) {
                insert_index = index;
                break;
            }
            if lines[index]
                .trim()
                .split_once('=')
                .is_some_and(|(key, _)| key.trim() == "status_line")
            {
                lines[index] = assignment;
                return format!("{}\n", lines.join("\n"));
            }
        }
        lines.insert(insert_index, assignment);
        return format!("{}\n", lines.join("\n"));
    }

    let insert_index = first_toml_table_header_index(&lines).unwrap_or(lines.len());
    let mut block = Vec::new();
    if insert_index > 0 && !lines[insert_index - 1].trim().is_empty() {
        block.push(String::new());
    }
    block.push("[tui]".to_string());
    block.push(assignment);
    if insert_index < lines.len() {
        block.push(String::new());
    }
    lines.splice(insert_index..insert_index, block);
    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
fn strip_claude_common_config_hooks(existing: Option<&str>) -> Result<Option<String>, String> {
    strip_common_config_hooks(existing, CommonConfigTool::Claude)
}

#[cfg(test)]
fn strip_codex_common_config_hooks(existing: Option<&str>) -> Result<Option<String>, String> {
    strip_common_config_hooks(existing, CommonConfigTool::Codex)
}

fn common_config_has_hooks(
    raw: Option<&str>,
    exe: &str,
    tool: CommonConfigTool,
) -> Result<bool, String> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(false);
    };
    match tool {
        CommonConfigTool::Claude => {
            let settings: Value =
                serde_json::from_str(raw).map_err(|_| "common_config_parse_failed".to_string())?;
            Ok(exact_command_registered(
                &settings,
                "SessionStart",
                &build_command(exe, "claude", "SessionStart"),
            ) && exact_command_registered(
                &settings,
                "UserPromptSubmit",
                &build_command(exe, "claude", "UserPromptSubmit"),
            ) && exact_command_registered(
                &settings,
                "Notification",
                &build_command(exe, "claude", "Notification"),
            ) && exact_command_registered(
                &settings,
                "Stop",
                &build_command(exe, "claude", "Stop"),
            ) && exact_command_registered(
                &settings,
                "StopFailure",
                &build_command(exe, "claude", "StopFailure"),
            ) && exact_command_registered(
                &settings,
                "SubagentStart",
                &build_command(exe, "claude", "SubagentStart"),
            ) && exact_command_registered(
                &settings,
                "SubagentStop",
                &build_command(exe, "claude", "SubagentStop"),
            ) && registered_exact_command(
                &settings,
                Some(exe),
                "PreToolUse",
                "claude",
                "AgentToolStart",
            ) && registered_exact_command(
                &settings,
                Some(exe),
                "PostToolUse",
                "claude",
                "AgentToolStop",
            ) && registered_exact_command(
                &settings,
                Some(exe),
                "PreToolUse",
                "claude",
                "ToolStart",
            ) && registered_exact_command(
                &settings,
                Some(exe),
                "PostToolUse",
                "claude",
                "ToolStop",
            ))
        }
        CommonConfigTool::Codex => Ok(toml_features_hooks_enabled(raw)),
    }
}

#[cfg(test)]
fn claude_common_config_has_hooks(raw: Option<&str>, exe: &str) -> Result<bool, String> {
    common_config_has_hooks(raw, exe, CommonConfigTool::Claude)
}

#[cfg(test)]
fn codex_common_config_has_hooks(raw: Option<&str>, exe: &str) -> Result<bool, String> {
    common_config_has_hooks(raw, exe, CommonConfigTool::Codex)
}

async fn read_common_config_value(
    conn: &mut SqliteConnection,
    key: &str,
) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(conn)
        .await
        .map_err(|err| format!("db_query_failed: {err}"))?;
    row.map(|row| {
        row.try_get::<Option<String>, _>("value")
            .map_err(|err| format!("db_query_failed: {err}"))
    })
    .transpose()
    .map(Option::flatten)
}

async fn settings_table_exists(conn: &mut SqliteConnection) -> Result<bool, String> {
    sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
        .fetch_optional(conn)
        .await
        .map(|row| row.is_some())
        .map_err(|err| format!("db_query_failed: {err}"))
}

async fn sync_common_config_at_path(
    db_path: &Path,
    exe: &str,
    tool: CommonConfigTool,
    mode: CcSwitchSyncMode,
    codex_hook_state_blocks: &[Vec<String>],
) -> Result<CcSwitchHookProtectionState, String> {
    if crate::wsl::is_wsl_config_dir(&path_to_string(db_path)) {
        let prepared_path = crate::ccswitch_db::prepare_read_path(db_path).await?;
        let mut conn = open_db_readonly(prepared_path.path()).await?;
        if !settings_table_exists(&mut conn).await? {
            return Ok(CcSwitchHookProtectionState::Unavailable);
        }
        let key = tool.key();
        let existing = read_common_config_value(&mut conn, key).await?;
        drop(conn);
        let (next, upsert, state) = match mode {
            CcSwitchSyncMode::Install => (
                merge_common_config_hooks(existing.as_deref(), exe, tool, codex_hook_state_blocks)?,
                true,
                CcSwitchHookProtectionState::Synced,
            ),
            CcSwitchSyncMode::Uninstall => {
                let Some(next) = strip_common_config_hooks(existing.as_deref(), tool)? else {
                    return Ok(CcSwitchHookProtectionState::NotSynced);
                };
                (next, false, CcSwitchHookProtectionState::NotSynced)
            }
        };
        let available =
            crate::ccswitch_db::write_wsl_setting(db_path, key, existing.as_deref(), &next, upsert)
                .await?;
        return Ok(if available {
            state
        } else {
            CcSwitchHookProtectionState::Unavailable
        });
    }

    let mut conn = open_db_readwrite(db_path).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut conn)
        .await
        .map_err(|err| format!("db_write_failed: {err}"))?;

    let result = async {
        if !settings_table_exists(&mut conn).await? {
            return Ok(CcSwitchHookProtectionState::Unavailable);
        }

        let key = tool.key();
        let existing = read_common_config_value(&mut conn, key).await?;
        match mode {
            CcSwitchSyncMode::Install => {
                let next = merge_common_config_hooks(
                    existing.as_deref(),
                    exe,
                    tool,
                    codex_hook_state_blocks,
                )?;
                sqlx::query(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(key)
                .bind(next)
                .execute(&mut conn)
                .await
                .map_err(|err| format!("db_write_failed: {err}"))?;
                Ok(CcSwitchHookProtectionState::Synced)
            }
            CcSwitchSyncMode::Uninstall => {
                if let Some(next) = strip_common_config_hooks(existing.as_deref(), tool)? {
                    sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
                        .bind(next)
                        .bind(key)
                        .execute(&mut conn)
                        .await
                        .map_err(|err| format!("db_write_failed: {err}"))?;
                }
                Ok(CcSwitchHookProtectionState::NotSynced)
            }
        }
    }
    .await;

    match result {
        Ok(state) => {
            sqlx::query("COMMIT")
                .execute(&mut conn)
                .await
                .map_err(|err| format!("db_write_failed: {err}"))?;
            Ok(state)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
            Err(err)
        }
    }
}

pub(crate) async fn sync_ccswitch_claude_statusline(
    app: &AppHandle,
    db_path: Option<String>,
    claude_dir: &Path,
    status_line: Option<Value>,
) -> CcSwitchHookProtectionStatus {
    let path = match resolve_ccswitch_db_path_for_hook(app, db_path, claude_dir) {
        Ok(path) => path,
        Err(status) => return status,
    };
    let result = async {
        if crate::wsl::is_wsl_config_dir(&path_to_string(&path)) {
            let prepared_path = crate::ccswitch_db::prepare_read_path(&path).await?;
            let mut conn = open_db_readonly(prepared_path.path()).await?;
            if !settings_table_exists(&mut conn).await? {
                return Ok(CcSwitchHookProtectionState::Unavailable);
            }
            let existing =
                read_common_config_value(&mut conn, CCSWITCH_COMMON_CONFIG_CLAUDE_KEY).await?;
            drop(conn);
            let (next, upsert, state) = if let Some(status_line) = status_line {
                (
                    merge_common_config_statusline(existing.as_deref(), status_line)?,
                    true,
                    CcSwitchHookProtectionState::Synced,
                )
            } else {
                let Some(next) = strip_common_config_statusline(existing.as_deref())? else {
                    return Ok(CcSwitchHookProtectionState::NotSynced);
                };
                (next, false, CcSwitchHookProtectionState::NotSynced)
            };
            let available = crate::ccswitch_db::write_wsl_setting(
                &path,
                CCSWITCH_COMMON_CONFIG_CLAUDE_KEY,
                existing.as_deref(),
                &next,
                upsert,
            )
            .await?;
            return Ok(if available {
                state
            } else {
                CcSwitchHookProtectionState::Unavailable
            });
        }

        let mut conn = open_db_readwrite(&path).await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut conn)
            .await
            .map_err(|err| format!("db_write_failed: {err}"))?;
        let update = async {
            if !settings_table_exists(&mut conn).await? {
                return Ok(CcSwitchHookProtectionState::Unavailable);
            }
            let existing =
                read_common_config_value(&mut conn, CCSWITCH_COMMON_CONFIG_CLAUDE_KEY).await?;
            if let Some(status_line) = status_line {
                let next = merge_common_config_statusline(existing.as_deref(), status_line)?;
                sqlx::query(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)
                .bind(next)
                .execute(&mut conn)
                .await
                .map_err(|err| format!("db_write_failed: {err}"))?;
                Ok(CcSwitchHookProtectionState::Synced)
            } else {
                if let Some(next) = strip_common_config_statusline(existing.as_deref())? {
                    sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
                        .bind(next)
                        .bind(CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)
                        .execute(&mut conn)
                        .await
                        .map_err(|err| format!("db_write_failed: {err}"))?;
                }
                Ok(CcSwitchHookProtectionState::NotSynced)
            }
        }
        .await;
        match update {
            Ok(state) => {
                sqlx::query("COMMIT")
                    .execute(&mut conn)
                    .await
                    .map_err(|err| format!("db_write_failed: {err}"))?;
                Ok(state)
            }
            Err(err) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
                Err(err)
            }
        }
    }
    .await;
    match result {
        Ok(state) => cc_switch_status(state, Some(&path), None, claude_dir),
        Err(err) => cc_switch_status(
            CcSwitchHookProtectionState::SyncFailed,
            Some(&path),
            Some(err),
            claude_dir,
        ),
    }
}

pub(crate) async fn sync_ccswitch_codex_statusline(
    app: &AppHandle,
    db_path: Option<String>,
    codex_dir: &Path,
    items: &[String],
) -> CcSwitchHookProtectionStatus {
    let path = match resolve_ccswitch_db_path_for_hook(app, db_path, codex_dir) {
        Ok(path) => path,
        Err(status) => return status,
    };
    let result = async {
        if crate::wsl::is_wsl_config_dir(&path_to_string(&path)) {
            let prepared_path = crate::ccswitch_db::prepare_read_path(&path).await?;
            let mut conn = open_db_readonly(prepared_path.path()).await?;
            if !settings_table_exists(&mut conn).await? {
                return Ok(CcSwitchHookProtectionState::Unavailable);
            }
            let existing =
                read_common_config_value(&mut conn, CCSWITCH_COMMON_CONFIG_CODEX_KEY).await?;
            drop(conn);
            let next = merge_common_config_codex_statusline(existing.as_deref(), items);
            let available = crate::ccswitch_db::write_wsl_setting(
                &path,
                CCSWITCH_COMMON_CONFIG_CODEX_KEY,
                existing.as_deref(),
                &next,
                true,
            )
            .await?;
            return Ok(if available {
                CcSwitchHookProtectionState::Synced
            } else {
                CcSwitchHookProtectionState::Unavailable
            });
        }

        let mut conn = open_db_readwrite(&path).await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut conn)
            .await
            .map_err(|err| format!("db_write_failed: {err}"))?;
        let update = async {
            if !settings_table_exists(&mut conn).await? {
                return Ok(CcSwitchHookProtectionState::Unavailable);
            }
            let existing =
                read_common_config_value(&mut conn, CCSWITCH_COMMON_CONFIG_CODEX_KEY).await?;
            let next = merge_common_config_codex_statusline(existing.as_deref(), items);
            sqlx::query(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(CCSWITCH_COMMON_CONFIG_CODEX_KEY)
            .bind(next)
            .execute(&mut conn)
            .await
            .map_err(|err| format!("db_write_failed: {err}"))?;
            Ok(CcSwitchHookProtectionState::Synced)
        }
        .await;
        match update {
            Ok(state) => {
                sqlx::query("COMMIT")
                    .execute(&mut conn)
                    .await
                    .map_err(|err| format!("db_write_failed: {err}"))?;
                Ok(state)
            }
            Err(err) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
                Err(err)
            }
        }
    }
    .await;
    match result {
        Ok(state) => cc_switch_status(state, Some(&path), None, codex_dir),
        Err(err) => cc_switch_status(
            CcSwitchHookProtectionState::SyncFailed,
            Some(&path),
            Some(err),
            codex_dir,
        ),
    }
}

async fn inspect_common_config_at_path(
    db_path: &Path,
    exe: &str,
    tool: CommonConfigTool,
) -> Result<CcSwitchHookProtectionState, String> {
    let mut conn = open_db_readonly(db_path).await?;
    if !settings_table_exists(&mut conn).await? {
        return Ok(CcSwitchHookProtectionState::Unavailable);
    }
    let existing = read_common_config_value(&mut conn, tool.key()).await?;
    if common_config_has_hooks(existing.as_deref(), exe, tool)? {
        Ok(CcSwitchHookProtectionState::Synced)
    } else {
        Ok(CcSwitchHookProtectionState::NotSynced)
    }
}

async fn sync_ccswitch_tool_common_config(
    app: &AppHandle,
    db_path: Option<String>,
    config_dir: &Path,
    tool: CommonConfigTool,
    mode: CcSwitchSyncMode,
) -> CcSwitchHookProtectionStatus {
    let path = match resolve_ccswitch_db_path_for_hook(app, db_path, config_dir) {
        Ok(path) => path,
        Err(status) => return status,
    };
    let exe = match hook_exe_for_dir(config_dir) {
        Ok(exe) => exe,
        Err(err) => {
            return cc_switch_status(
                CcSwitchHookProtectionState::SyncFailed,
                Some(&path),
                Some(err),
                config_dir,
            );
        }
    };
    let codex_hook_state_blocks =
        if matches!(tool, CommonConfigTool::Codex) && matches!(mode, CcSwitchSyncMode::Install) {
            match read_codex_cli_manager_hook_state_blocks(config_dir) {
                Ok(blocks) => blocks,
                Err(err) => {
                    return cc_switch_status(
                        CcSwitchHookProtectionState::SyncFailed,
                        Some(&path),
                        Some(err),
                        config_dir,
                    );
                }
            }
        } else {
            Vec::new()
        };
    match sync_common_config_at_path(&path, &exe, tool, mode, &codex_hook_state_blocks).await {
        Ok(state) => cc_switch_status(state, Some(&path), None, config_dir),
        Err(err) => cc_switch_status(
            CcSwitchHookProtectionState::SyncFailed,
            Some(&path),
            Some(err),
            config_dir,
        ),
    }
}

async fn sync_ccswitch_for_tool_status(
    app: &AppHandle,
    db_path: Option<String>,
    config_dir: &Path,
    tool: CommonConfigTool,
    status: &ToolHookSettingsStatus,
) {
    let mode = if tool_status_is_fully_installed(status, tool) {
        CcSwitchSyncMode::Install
    } else {
        CcSwitchSyncMode::Uninstall
    };
    sync_ccswitch_tool_common_config(app, db_path, config_dir, tool, mode).await;
}

fn hook_status_has_hooks(status: &ToolHookSettingsStatus) -> bool {
    status.session_start_hook_installed
        || status.running_hook_installed
        || status.attention_hook_installed
        || status.stop_hook_installed
        || status.failure_hook_installed
        || status.subagent_start_hook_installed
        || status.hooks_feature_installed
}

fn tool_status_is_fully_installed(status: &ToolHookSettingsStatus, tool: CommonConfigTool) -> bool {
    match tool {
        CommonConfigTool::Claude => {
            status.session_start_hook_installed
                && status.running_hook_installed
                && status.attention_hook_installed
                && status.stop_hook_installed
                && status.failure_hook_installed
                && status.subagent_start_hook_installed
        }
        CommonConfigTool::Codex => {
            status.session_start_hook_installed
                && status.running_hook_installed
                && status.attention_hook_installed
                && status.stop_hook_installed
                && status.subagent_start_hook_installed
                && status.hooks_feature_installed
        }
    }
}

fn combine_cc_switch_statuses(
    statuses: Vec<CcSwitchHookProtectionStatus>,
) -> CcSwitchHookProtectionStatus {
    let Some(first) = statuses.first().cloned() else {
        return cc_switch_not_detected();
    };

    let state_priority = [
        CcSwitchHookProtectionState::InvalidDb,
        CcSwitchHookProtectionState::SyncFailed,
        CcSwitchHookProtectionState::Unavailable,
        CcSwitchHookProtectionState::NotSynced,
        CcSwitchHookProtectionState::NotDetected,
    ];
    let state = state_priority
        .iter()
        .find(|state| statuses.iter().any(|status| status.state == **state))
        .cloned()
        .unwrap_or(CcSwitchHookProtectionState::Synced);

    CcSwitchHookProtectionStatus {
        state,
        db_path: statuses
            .iter()
            .find_map(|status| status.db_path.clone())
            .or(first.db_path),
        message: statuses
            .iter()
            .find_map(|status| status.message.clone())
            .or(first.message),
        wsl_mismatch: statuses.iter().any(|status| status.wsl_mismatch),
    }
}

async fn inspect_tool_common_config_at_path(
    db_path: &Path,
    config_dir: &Path,
    tool: CommonConfigTool,
) -> CcSwitchHookProtectionStatus {
    let exe = match hook_exe_for_dir(config_dir) {
        Ok(exe) => exe,
        Err(err) => {
            return cc_switch_status(
                CcSwitchHookProtectionState::SyncFailed,
                Some(db_path),
                Some(err),
                config_dir,
            );
        }
    };
    let prepared_path = match crate::ccswitch_db::prepare_read_path(db_path).await {
        Ok(path) => path,
        Err(err) => {
            return cc_switch_status(
                CcSwitchHookProtectionState::SyncFailed,
                Some(db_path),
                Some(err),
                config_dir,
            );
        }
    };
    match inspect_common_config_at_path(prepared_path.path(), &exe, tool).await {
        Ok(state) => cc_switch_status(state, Some(db_path), None, config_dir),
        Err(err) => cc_switch_status(
            CcSwitchHookProtectionState::SyncFailed,
            Some(db_path),
            Some(err),
            config_dir,
        ),
    }
}

async fn inspect_ccswitch_hook_protection(
    app: &AppHandle,
    db_path: Option<String>,
    claude_dir: Option<&Path>,
    codex_dir: Option<&Path>,
    claude: &ToolHookSettingsStatus,
    codex: &ToolHookSettingsStatus,
) -> CcSwitchHookProtectionStatus {
    let mut targets = Vec::new();
    if hook_status_has_hooks(claude) {
        if let Some(dir) = claude_dir {
            targets.push((dir, CommonConfigTool::Claude));
        }
    }
    if hook_status_has_hooks(codex) {
        if let Some(dir) = codex_dir {
            targets.push((dir, CommonConfigTool::Codex));
        }
    }
    if targets.is_empty() {
        if let Some(dir) = claude_dir {
            targets.push((dir, CommonConfigTool::Claude));
        } else if let Some(dir) = codex_dir {
            targets.push((dir, CommonConfigTool::Codex));
        }
    }

    let Some((reference_dir, _)) = targets.first().copied() else {
        return cc_switch_not_detected();
    };

    let path = match resolve_ccswitch_db_path_for_hook(app, db_path, reference_dir) {
        Ok(path) => path,
        Err(status) => return status,
    };
    let mut statuses = Vec::new();
    for (config_dir, tool) in targets {
        statuses.push(inspect_tool_common_config_at_path(&path, config_dir, tool).await);
    }
    combine_cc_switch_statuses(statuses)
}

fn install_claude_hooks(claude_dir: &Path) -> Result<(), String> {
    let exe = hook_exe_for_dir(claude_dir)?;
    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let mut settings = read_json(&settings_path)?;
    ensure_root_object(&settings, "settings.json")?;
    // 先清掉旧版本注册的条目（含历史 .ps1 命令与本应用 __hook 命令），保证安装即升级
    remove_hook_commands(
        &mut settings,
        &[
            "SessionStart",
            "UserPromptSubmit",
            "Notification",
            "Stop",
            "StopFailure",
            "SubagentStart",
            "SubagentStop",
            "PreToolUse",
            "PostToolUse",
        ],
        &CLAUDE_LEGACY_SCRIPTS,
    );
    for module in ALL_CLAUDE_HOOK_MODULES {
        apply_claude_hook_module(&mut settings, &exe, module);
    }
    // 清理历史 .ps1 脚本文件（若存在），新方案不再依赖脚本文件
    cleanup_legacy_scripts(&claude_dir.join("hooks"), &CLAUDE_LEGACY_SCRIPTS);
    write_json(&settings_path, &settings)
}

fn install_claude_hook_module(claude_dir: &Path, module: ClaudeHookModule) -> Result<(), String> {
    let exe = hook_exe_for_dir(claude_dir)?;
    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let mut settings = read_json(&settings_path)?;
    ensure_root_object(&settings, "settings.json")?;
    apply_claude_hook_module(&mut settings, &exe, module);
    cleanup_legacy_scripts(&claude_dir.join("hooks"), &CLAUDE_LEGACY_SCRIPTS);
    write_json(&settings_path, &settings)
}

fn uninstall_claude_hooks(claude_dir: &Path) -> Result<(), String> {
    cleanup_legacy_scripts(&claude_dir.join("hooks"), &CLAUDE_LEGACY_SCRIPTS);

    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let mut settings = read_json(&settings_path)?;
    ensure_root_object(&settings, "settings.json")?;
    remove_hook_commands(
        &mut settings,
        &[
            "SessionStart",
            "UserPromptSubmit",
            "Notification",
            "Stop",
            "StopFailure",
            "SubagentStart",
            "SubagentStop",
            "PreToolUse",
            "PostToolUse",
        ],
        &CLAUDE_LEGACY_SCRIPTS,
    );
    write_json(&settings_path, &settings)
}

fn uninstall_claude_hook_module(claude_dir: &Path, module: ClaudeHookModule) -> Result<(), String> {
    cleanup_legacy_scripts(&claude_dir.join("hooks"), &CLAUDE_LEGACY_SCRIPTS);
    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let mut settings = read_json(&settings_path)?;
    ensure_root_object(&settings, "settings.json")?;
    remove_claude_hook_module(&mut settings, module);
    write_json(&settings_path, &settings)
}

fn install_codex_hooks(codex_dir: &Path) -> Result<(), String> {
    let exe = hook_exe_for_dir(codex_dir)?;
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    // 先清掉旧版本注册的条目（含历史 .ps1 命令与本应用 __hook 命令），保证安装即升级
    remove_hook_commands(
        &mut settings,
        &[
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "Stop",
            "SubagentStart",
            "SubagentStop",
        ],
        &CODEX_LEGACY_SCRIPTS,
    );
    for module in ALL_CODEX_HOOK_COMMAND_MODULES {
        apply_codex_hook_module(&mut settings, &exe, module);
    }
    ensure_codex_hooks_feature(codex_dir)?;
    // 清理历史 .ps1 脚本文件（若存在），新方案不再依赖脚本文件
    cleanup_legacy_scripts(&codex_dir.join("hooks"), &CODEX_LEGACY_SCRIPTS);
    write_json(&hooks_path, &settings)
}

fn install_codex_hook_module(codex_dir: &Path, module: CodexHookModule) -> Result<(), String> {
    if matches!(module, CodexHookModule::HooksFeature) {
        return ensure_codex_hooks_feature(codex_dir);
    }
    let exe = hook_exe_for_dir(codex_dir)?;
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    apply_codex_hook_module(&mut settings, &exe, module);
    cleanup_legacy_scripts(&codex_dir.join("hooks"), &CODEX_LEGACY_SCRIPTS);
    write_json(&hooks_path, &settings)
}

fn ensure_codex_hooks_feature(codex_dir: &Path) -> Result<(), String> {
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let content = match fs::read_to_string(&config_path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path_to_string(&config_path))),
    };
    let next_content = set_toml_feature_hooks_enabled(&content, true);
    fs::write(&config_path, next_content)
        .map_err(|e| format!("写入 {} 失败: {e}", path_to_string(&config_path)))
}

fn set_toml_feature_hooks_enabled(content: &str, enabled: bool) -> String {
    let mut lines: Vec<String> = content.lines().map(ToString::to_string).collect();
    let mut features_header_index = None;
    for (index, line) in lines.iter().enumerate() {
        if line.trim() == "[features]" {
            features_header_index = Some(index);
            break;
        }
    }

    let Some(header_index) = features_header_index else {
        if !enabled {
            return if content.ends_with('\n') {
                content.to_string()
            } else if content.is_empty() {
                String::new()
            } else {
                format!("{content}\n")
            };
        }
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
        if is_toml_table_header(&lines[index]) {
            insert_index = index;
            break;
        }
        if trimmed
            .split_once('=')
            .is_some_and(|(key, _)| key.trim() == "hooks")
        {
            lines[index] = format!("hooks = {}", if enabled { "true" } else { "false" });
            return format!("{}\n", lines.join("\n"));
        }
    }

    if !enabled {
        return format!("{}\n", lines.join("\n"));
    }

    lines.insert(insert_index, "hooks = true".to_string());
    format!("{}\n", lines.join("\n"))
}

fn merge_codex_common_config_toml(
    existing: Option<&str>,
    hook_state_blocks: &[Vec<String>],
) -> String {
    let Some(raw) = existing.filter(|value| !value.trim().is_empty()) else {
        let mut lines = vec![
            "[features]".to_string(),
            format!("hooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}"),
        ];
        merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
        return format!("{}\n", lines.join("\n"));
    };

    let mut lines: Vec<String> = raw.lines().map(ToString::to_string).collect();
    let mut features_header_index = None;
    for (index, line) in lines.iter().enumerate() {
        if line.trim() == "[features]" {
            features_header_index = Some(index);
            break;
        }
    }

    let Some(header_index) = features_header_index else {
        let insert_index = first_toml_table_header_index(&lines).unwrap_or(lines.len());
        let mut block = Vec::new();
        if insert_index > 0 && !lines[insert_index - 1].trim().is_empty() {
            block.push(String::new());
        }
        block.push("[features]".to_string());
        block.push(format!("hooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}"));
        if insert_index < lines.len() {
            block.push(String::new());
        }
        lines.splice(insert_index..insert_index, block);
        merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
        return format!("{}\n", lines.join("\n"));
    };

    let mut insert_index = lines.len();
    for index in header_index + 1..lines.len() {
        let trimmed = lines[index].trim();
        if is_toml_table_header(&lines[index]) {
            insert_index = index;
            break;
        }
        if trimmed.split_once('=').is_some_and(|(key, value)| {
            key.trim() == "hooks" && toml_bool_value(value) == Some(true)
        }) {
            merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
            return format!("{}\n", lines.join("\n"));
        }
        if trimmed
            .split_once('=')
            .is_some_and(|(key, _)| key.trim() == "hooks")
        {
            lines[index] = format!("hooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}");
            merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
            return format!("{}\n", lines.join("\n"));
        }
    }

    lines.insert(
        insert_index,
        format!("hooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}"),
    );
    merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
    format!("{}\n", lines.join("\n"))
}

fn first_toml_table_header_index(lines: &[String]) -> Option<usize> {
    lines.iter().position(|line| is_toml_table_header(line))
}

fn is_toml_table_header(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('[') && trimmed.ends_with(']')
}

fn merge_codex_common_config_hook_state_blocks(
    lines: &mut Vec<String>,
    hook_state_blocks: &[Vec<String>],
) {
    let hook_state_keys: Vec<String> = hook_state_blocks
        .iter()
        .filter_map(|block| block.first())
        .filter_map(|line| toml_hooks_state_key(line))
        .map(str::to_string)
        .collect();

    remove_marker_owned_codex_hook_state_blocks(lines);
    remove_codex_hook_state_blocks(lines, &hook_state_keys);
    trim_empty_lines(lines);

    if hook_state_blocks.is_empty() {
        return;
    }

    let insert_index = codex_hook_state_insert_index(lines);
    let mut block = Vec::new();
    if insert_index > 0 && !lines[insert_index - 1].trim().is_empty() {
        block.push(String::new());
    }
    for state_block in hook_state_blocks {
        block.push(CODEX_COMMON_CONFIG_HOOKS_MARKER.to_string());
        block.extend(state_block.iter().cloned());
        block.push(String::new());
    }
    if insert_index < lines.len() && block.last().is_some_and(|line| !line.trim().is_empty()) {
        block.push(String::new());
    }
    lines.splice(insert_index..insert_index, block);
    trim_empty_lines(lines);
}

fn codex_hook_state_insert_index(lines: &[String]) -> usize {
    let Some(features_index) = lines.iter().position(|line| line.trim() == "[features]") else {
        return first_toml_table_header_index(lines).unwrap_or(lines.len());
    };
    for index in features_index + 1..lines.len() {
        if is_toml_table_header(&lines[index]) {
            return index;
        }
    }
    lines.len()
}

fn remove_marker_owned_codex_hook_state_blocks(lines: &mut Vec<String>) {
    let mut next = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if lines[index].trim() == CODEX_COMMON_CONFIG_HOOKS_MARKER
            && lines
                .get(index + 1)
                .and_then(|line| toml_hooks_state_key(line))
                .is_some()
        {
            index += 2;
            while index < lines.len() && !is_toml_table_header(&lines[index]) {
                index += 1;
            }
            continue;
        }
        next.push(lines[index].clone());
        index += 1;
    }
    *lines = next;
}

fn remove_codex_hook_state_blocks(lines: &mut Vec<String>, hook_state_keys: &[String]) {
    if hook_state_keys.is_empty() {
        return;
    }

    let mut next = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let remove_block = toml_hooks_state_key(&lines[index])
            .is_some_and(|key| hook_state_keys.iter().any(|expected| expected == key));
        if remove_block {
            if next
                .last()
                .is_some_and(|line: &String| line.trim() == CODEX_COMMON_CONFIG_HOOKS_MARKER)
            {
                next.pop();
            }
            index += 1;
            while index < lines.len() && !is_toml_table_header(&lines[index]) {
                index += 1;
            }
            continue;
        }
        next.push(lines[index].clone());
        index += 1;
    }
    *lines = next;
}

fn trim_empty_lines(lines: &mut Vec<String>) {
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
}

fn read_codex_cli_manager_hook_state_blocks(codex_dir: &Path) -> Result<Vec<Vec<String>>, String> {
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let hooks = read_json_if_exists(&hooks_path)?;
    let expected_keys = codex_cli_manager_hook_state_keys(&hooks, &hooks_path);
    if expected_keys.is_empty() {
        return Ok(Vec::new());
    }

    let content = match fs::read_to_string(&config_path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("读取 {} 失败: {err}", path_to_string(&config_path))),
    };
    Ok(extract_codex_hook_state_blocks(&content, &expected_keys))
}

fn codex_cli_manager_hook_state_keys(settings: &Value, hooks_path: &Path) -> Vec<String> {
    let hooks_path = toml_escape_basic_string(&path_to_string(hooks_path));
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    for event in CODEX_HOOK_EVENTS {
        let Some(event_name) = codex_hook_state_event_name(event) else {
            continue;
        };
        let Some(entries) = hooks.get(event).and_then(Value::as_array) else {
            continue;
        };
        for (entry_index, entry) in entries.iter().enumerate() {
            let Some(commands) = entry.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for (hook_index, hook) in commands.iter().enumerate() {
                if is_cli_manager_command(hook, &CODEX_LEGACY_SCRIPTS) {
                    keys.push(format!(
                        "{hooks_path}:{event_name}:{entry_index}:{hook_index}"
                    ));
                }
            }
        }
    }
    keys
}

fn codex_hook_state_event_name(event: &str) -> Option<&'static str> {
    match event {
        "PermissionRequest" => Some("permission_request"),
        "SessionStart" => Some("session_start"),
        "UserPromptSubmit" => Some("user_prompt_submit"),
        "Stop" => Some("stop"),
        "SubagentStart" => Some("subagent_start"),
        "SubagentStop" => Some("subagent_stop"),
        _ => None,
    }
}

fn codex_cli_manager_hooks_trusted(
    settings: &Value,
    hooks_path: &Path,
    config_path: &Path,
) -> Result<bool, String> {
    let config = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("读取 {} 失败: {err}", path_to_string(config_path))),
    };
    let config: toml::Value = toml::from_str(&config)
        .map_err(|err| format!("解析 {} 失败: {err}", path_to_string(config_path)))?;
    let state = config
        .get("hooks")
        .and_then(|value| value.get("state"))
        .and_then(toml::Value::as_table);
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return Ok(false);
    };

    let mut found = false;
    for event in CODEX_HOOK_EVENTS {
        let Some(event_name) = codex_hook_state_event_name(event) else {
            continue;
        };
        let Some(entries) = hooks.get(event).and_then(Value::as_array) else {
            continue;
        };
        for (entry_index, entry) in entries.iter().enumerate() {
            let Some(commands) = entry.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for (hook_index, hook) in commands.iter().enumerate() {
                if !is_cli_manager_command(hook, &CODEX_LEGACY_SCRIPTS) {
                    continue;
                }
                found = true;
                let key = format!(
                    "{}:{event_name}:{entry_index}:{hook_index}",
                    path_to_string(hooks_path)
                );
                let Some(entry_state) = state.and_then(|state| state.get(&key)) else {
                    return Ok(false);
                };
                if entry_state.get("enabled").and_then(toml::Value::as_bool) == Some(false) {
                    return Ok(false);
                }
                let trusted_hash = entry_state
                    .get("trusted_hash")
                    .and_then(toml::Value::as_str);
                if trusted_hash != Some(codex_hook_trusted_hash(event, entry, hook)?.as_str()) {
                    return Ok(false);
                }
            }
        }
    }
    Ok(found)
}

fn codex_hook_trusted_hash(event: &str, group: &Value, hook: &Value) -> Result<String, String> {
    let mut normalized_hook = serde_json::Map::new();
    normalized_hook.insert("type".to_string(), json!("command"));
    normalized_hook.insert(
        "command".to_string(),
        hook.get("command").cloned().unwrap_or(Value::Null),
    );
    let timeout = hook
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .max(1);
    normalized_hook.insert("timeout".to_string(), json!(timeout));
    normalized_hook.insert(
        "async".to_string(),
        json!(hook.get("async").and_then(Value::as_bool).unwrap_or(false)),
    );
    if let Some(status_message) = hook.get("statusMessage") {
        normalized_hook.insert("statusMessage".to_string(), status_message.clone());
    }

    let mut normalized_group = serde_json::Map::new();
    normalized_group.insert(
        "event_name".to_string(),
        json!(codex_hook_state_event_name(event)),
    );
    if matches!(
        event,
        "PermissionRequest" | "SessionStart" | "SubagentStart" | "SubagentStop"
    ) {
        if let Some(matcher) = group.get("matcher") {
            normalized_group.insert("matcher".to_string(), matcher.clone());
        }
    }
    normalized_group.insert(
        "hooks".to_string(),
        Value::Array(vec![Value::Object(normalized_hook)]),
    );
    let canonical = serde_json::to_vec(&Value::Object(normalized_group))
        .map_err(|err| format!("序列化 Codex hook 信任数据失败: {err}"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

fn extract_codex_hook_state_blocks(config: &str, expected_keys: &[String]) -> Vec<Vec<String>> {
    let lines: Vec<&str> = config.lines().collect();
    let mut blocks = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let key = toml_hooks_state_key(lines[index]);
        if key.is_some_and(|key| expected_keys.iter().any(|expected| expected == key)) {
            let mut block = vec![lines[index].to_string()];
            index += 1;
            while index < lines.len() && !is_toml_table_header(lines[index]) {
                block.push(lines[index].to_string());
                index += 1;
            }
            blocks.push(block);
            continue;
        }
        index += 1;
    }
    blocks
}

fn toml_hooks_state_key(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    trimmed
        .strip_prefix("[hooks.state.\"")
        .and_then(|tail| tail.strip_suffix("\"]"))
}

fn toml_escape_basic_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn strip_codex_common_config_toml(raw: &str) -> Option<String> {
    let mut source_lines: Vec<String> = raw.lines().map(ToString::to_string).collect();
    let before_state_strip = source_lines.len();
    remove_marker_owned_codex_hook_state_blocks(&mut source_lines);
    let removed_state_blocks = source_lines.len() != before_state_strip;

    let mut lines = Vec::new();
    let mut removed = false;
    for line in &source_lines {
        let trimmed = line.trim();
        let is_owned_hooks_line = trimmed.contains(CODEX_COMMON_CONFIG_HOOKS_MARKER)
            && trimmed
                .split_once('=')
                .is_some_and(|(key, _)| key.trim() == "hooks");
        if is_owned_hooks_line {
            removed = true;
            continue;
        }
        lines.push(line.to_string());
    }

    if !removed && !removed_state_blocks {
        return Some(format!("{}\n", raw.trim_end()));
    }

    trim_empty_toml_features_section(&mut lines);
    let text = lines.join("\n").trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(format!("{text}\n"))
    }
}

fn trim_empty_toml_features_section(lines: &mut Vec<String>) {
    let Some(header_index) = lines.iter().position(|line| line.trim() == "[features]") else {
        return;
    };
    let mut end_index = lines.len();
    for (index, line) in lines.iter().enumerate().skip(header_index + 1) {
        let trimmed = line.trim();
        if is_toml_table_header(line) {
            end_index = index;
            break;
        }
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            return;
        }
    }
    lines.drain(header_index..end_index);
}

fn toml_features_hooks_enabled(raw: &str) -> bool {
    let mut in_features = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if is_toml_table_header(line) {
            in_features = trimmed == "[features]";
            continue;
        }
        if in_features
            && trimmed.split_once('=').is_some_and(|(key, value)| {
                key.trim() == "hooks" && toml_bool_value(value) == Some(true)
            })
        {
            return true;
        }
    }
    false
}

fn toml_bool_value(value: &str) -> Option<bool> {
    match value.split('#').next().unwrap_or("").trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn codex_hooks_feature_installed(config_path: &Path) -> Result<bool, String> {
    let content = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path_to_string(config_path))),
    };
    let mut in_features = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if is_toml_table_header(line) {
            in_features = trimmed == "[features]";
            continue;
        }
        if in_features
            && trimmed
                .split_once('=')
                .is_some_and(|(key, value)| key.trim() == "hooks" && value.trim() == "true")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn uninstall_codex_hooks(codex_dir: &Path) -> Result<(), String> {
    cleanup_legacy_scripts(&codex_dir.join("hooks"), &CODEX_LEGACY_SCRIPTS);

    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    remove_hook_commands(
        &mut settings,
        &[
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "Stop",
            "SubagentStart",
            "SubagentStop",
        ],
        &CODEX_LEGACY_SCRIPTS,
    );
    write_json(&hooks_path, &settings)
}

fn uninstall_codex_hook_module(codex_dir: &Path, module: CodexHookModule) -> Result<(), String> {
    if matches!(module, CodexHookModule::HooksFeature) {
        return disable_codex_hooks_feature(codex_dir);
    }
    cleanup_legacy_scripts(&codex_dir.join("hooks"), &CODEX_LEGACY_SCRIPTS);
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    remove_codex_hook_module(&mut settings, module);
    write_json(&hooks_path, &settings)
}

fn disable_codex_hooks_feature(codex_dir: &Path) -> Result<(), String> {
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let content = match fs::read_to_string(&config_path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path_to_string(&config_path))),
    };
    let next_content = set_toml_feature_hooks_enabled(&content, false);
    fs::write(&config_path, next_content)
        .map_err(|e| format!("写入 {} 失败: {e}", path_to_string(&config_path)))
}



fn resolve_grok_dir(
    selected_dir: Option<String>,
    create_if_missing: bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(dir) = selected_dir.and_then(|value| normalize_selected_dir(&value)) {
        if dir.is_dir() {
            return Ok(Some(dir));
        }
        if create_if_missing {
            fs::create_dir_all(&dir).map_err(|e| format!("创建 Grok 配置目录失败: {e}"))?;
            return Ok(Some(dir));
        }
        return Err("选择的 Grok 配置目录不存在".to_string());
    }

    let Some(home) = home_dir() else {
        return Ok(None);
    };
    let default_dir = env::var_os("GROK_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".grok"));
    if default_dir.is_dir() {
        Ok(Some(default_dir))
    } else if create_if_missing {
        fs::create_dir_all(&default_dir).map_err(|e| format!("创建 Grok 配置目录失败: {e}"))?;
        Ok(Some(default_dir))
    } else {
        Ok(None)
    }
}

fn grok_hooks_path(grok_dir: &Path) -> PathBuf {
    grok_dir.join("hooks").join(GROK_HOOKS_FILE_NAME)
}

fn grok_config_path(grok_dir: &Path) -> PathBuf {
    grok_dir.join(GROK_CONFIG_FILE_NAME)
}

fn install_grok_hooks(grok_dir: &Path) -> Result<(), String> {
    let exe = hook_exe_for_dir(grok_dir)?;
    let hooks_path = grok_hooks_path(grok_dir);
    if let Some(parent) = hooks_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 Grok hooks 目录失败: {e}"))?;
    }
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, GROK_HOOKS_FILE_NAME)?;
    remove_hook_commands(&mut settings, &CLAUDE_HOOK_EVENTS, &[]);
    for module in ALL_CLAUDE_HOOK_MODULES {
        apply_named_hook_module(&mut settings, &exe, "grok", module);
    }
    write_json(&hooks_path, &settings)?;
    verify_grok_hooks_file(&hooks_path, &exe)?;
    disable_grok_cross_vendor_hooks(grok_dir)?;
    verify_grok_cross_vendor_isolation(grok_dir)?;
    Ok(())
}

fn install_grok_hook_module(grok_dir: &Path, module: ClaudeHookModule) -> Result<(), String> {
    let exe = hook_exe_for_dir(grok_dir)?;
    let hooks_path = grok_hooks_path(grok_dir);
    if let Some(parent) = hooks_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 Grok hooks 目录失败: {e}"))?;
    }
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, GROK_HOOKS_FILE_NAME)?;
    if let ClaudeHookModule::Attention = module {
        remove_named_hook_module(&mut settings, "grok", module);
    }
    apply_named_hook_module(&mut settings, &exe, "grok", module);
    write_json(&hooks_path, &settings)?;
    // Module install still enforces isolation so partial installs cannot leave foreign hooks active.
    disable_grok_cross_vendor_hooks(grok_dir)?;
    Ok(())
}

fn verify_grok_hooks_file(hooks_path: &Path, exe: &str) -> Result<(), String> {
    if !hooks_path.is_file() {
        return Err(format!(
            "Grok Hook 写入失败：文件不存在 {}",
            path_to_string(hooks_path)
        ));
    }
    let settings = read_json(hooks_path)?;
    let expected = build_command(exe, "grok", "SessionStart");
    if !exact_command_registered(&settings, "SessionStart", &expected) {
        return Err(format!(
            "Grok Hook 写入校验失败：未在 {} 找到 SessionStart 命令",
            path_to_string(hooks_path)
        ));
    }
    if !settings
        .get("hooks")
        .and_then(Value::as_object)
        .is_some_and(|hooks| !hooks.is_empty())
    {
        return Err(format!(
            "Grok Hook 写入校验失败：{} 中 hooks 为空",
            path_to_string(hooks_path)
        ));
    }
    Ok(())
}

fn verify_grok_cross_vendor_isolation(grok_dir: &Path) -> Result<(), String> {
    let config_path = grok_config_path(grok_dir);
    if !grok_cross_vendor_hooks_disabled(&config_path)? {
        return Err(format!(
            "Grok 跨工具 Hook 隔离写入失败：请检查 {} 中 compat.claude.hooks / compat.cursor.hooks",
            path_to_string(&config_path)
        ));
    }
    Ok(())
}

fn uninstall_grok_hooks(grok_dir: &Path) -> Result<(), String> {
    let hooks_path = grok_hooks_path(grok_dir);
    if !hooks_path.is_file() {
        return Ok(());
    }
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, GROK_HOOKS_FILE_NAME)?;
    remove_hook_commands(&mut settings, &CLAUDE_HOOK_EVENTS, &[]);
    if settings.get("hooks").is_none() {
        let _ = fs::remove_file(&hooks_path);
        return Ok(());
    }
    write_json(&hooks_path, &settings)
}

fn uninstall_grok_hook_module(grok_dir: &Path, module: ClaudeHookModule) -> Result<(), String> {
    let hooks_path = grok_hooks_path(grok_dir);
    if !hooks_path.is_file() {
        return Ok(());
    }
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, GROK_HOOKS_FILE_NAME)?;
    remove_named_hook_module(&mut settings, "grok", module);
    if settings.get("hooks").is_none() {
        let _ = fs::remove_file(&hooks_path);
        return Ok(());
    }
    write_json(&hooks_path, &settings)
}

fn disable_grok_cross_vendor_hooks(grok_dir: &Path) -> Result<(), String> {
    let config_path = grok_config_path(grok_dir);
    let content = match fs::read_to_string(&config_path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path_to_string(&config_path))),
    };
    let mut next = set_toml_table_bool(&content, "compat.claude", "hooks", false);
    next = set_toml_table_bool(&next, "compat.cursor", "hooks", false);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 Grok 配置目录失败: {e}"))?;
    }
    fs::write(&config_path, next)
        .map_err(|e| format!("写入 {} 失败: {e}", path_to_string(&config_path)))
}

/// Set `key = bool` under a dotted table header like `compat.claude`.
/// Creates the table if missing. Preserves unrelated lines.
fn set_toml_table_bool(content: &str, table: &str, key: &str, value: bool) -> String {
    let header = format!("[{table}]");
    let value_text = if value { "true" } else { "false" };
    let assignment = format!("{key} = {value_text}");
    let mut lines: Vec<String> = content.lines().map(ToString::to_string).collect();

    let header_index = lines.iter().position(|line| line.trim() == header);
    let Some(header_index) = header_index else {
        if !lines.is_empty() && !lines.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        lines.push(header);
        lines.push(assignment);
        lines.push(String::new());
        return format_toml_lines(&lines);
    };

    let mut insert_index = lines.len();
    let mut key_line = None;
    for index in header_index + 1..lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            insert_index = index;
            break;
        }
        if trimmed.split_once('=').is_some_and(|(k, _)| k.trim() == key) {
            key_line = Some(index);
            break;
        }
    }
    if let Some(index) = key_line {
        lines[index] = assignment;
    } else {
        lines.insert(insert_index, assignment);
    }
    format_toml_lines(&lines)
}

fn format_toml_lines(lines: &[String]) -> String {
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn grok_cross_vendor_hooks_disabled(config_path: &Path) -> Result<bool, String> {
    let content = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path_to_string(config_path))),
    };
    Ok(
        toml_table_bool(&content, "compat.claude", "hooks") == Some(false)
            && toml_table_bool(&content, "compat.cursor", "hooks") == Some(false)
    )
}

fn toml_table_bool(content: &str, table: &str, key: &str) -> Option<bool> {
    let header = format!("[{table}]");
    let mut in_table = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_table = trimmed == header;
            continue;
        }
        if !in_table {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == key {
                let value = v.split('#').next().unwrap_or("").trim();
                return match value {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => None,
                };
            }
        }
    }
    None
}

fn apply_named_hook_module(
    settings: &mut Value,
    exe: &str,
    source: &str,
    module: ClaudeHookModule,
) {
    match module {
        ClaudeHookModule::SessionStart => add_hook_command(
            settings,
            "SessionStart",
            build_command(exe, source, "SessionStart"),
        ),
        ClaudeHookModule::Running => add_hook_command(
            settings,
            "UserPromptSubmit",
            build_command(exe, source, "UserPromptSubmit"),
        ),
        ClaudeHookModule::Attention => add_hook_command_with_matcher(
            settings,
            "PreToolUse",
            "Bash|Edit|Write|MultiEdit",
            build_command(exe, source, "PermissionRequest"),
        ),
        ClaudeHookModule::Stop => {
            add_hook_command(settings, "Stop", build_command(exe, source, "Stop"))
        }
        ClaudeHookModule::Failure => add_hook_command(
            settings,
            "StopFailure",
            build_command(exe, source, "StopFailure"),
        ),
        ClaudeHookModule::Subagent => {
            add_hook_command(
                settings,
                "SubagentStart",
                build_command(exe, source, "SubagentStart"),
            );
            add_hook_command(
                settings,
                "SubagentStop",
                build_command(exe, source, "SubagentStop"),
            );
            add_hook_command_with_matcher(
                settings,
                "PreToolUse",
                "Agent|Task",
                build_command(exe, source, "AgentToolStart"),
            );
            add_hook_command_with_matcher(
                settings,
                "PostToolUse",
                "Agent|Task",
                build_command(exe, source, "AgentToolStop"),
            );
            add_hook_command(
                settings,
                "PreToolUse",
                build_command(exe, source, "ToolStart"),
            );
            add_hook_command(
                settings,
                "PostToolUse",
                build_command(exe, source, "ToolStop"),
            );
        }
    }
}

fn remove_named_hook_module(settings: &mut Value, source: &str, module: ClaudeHookModule) {
    match module {
        ClaudeHookModule::SessionStart => {
            remove_named_hook_command(settings, "SessionStart", source, "SessionStart")
        }
        ClaudeHookModule::Running => {
            remove_named_hook_command(settings, "UserPromptSubmit", source, "UserPromptSubmit")
        }
        ClaudeHookModule::Attention => {
            // Remove the obsolete Grok Notification registration during module upgrades.
            remove_named_hook_command(settings, "Notification", source, "Notification");
            remove_named_hook_command(settings, "PreToolUse", source, "PermissionRequest");
        }
        ClaudeHookModule::Stop => remove_named_hook_command(settings, "Stop", source, "Stop"),
        ClaudeHookModule::Failure => {
            remove_named_hook_command(settings, "StopFailure", source, "StopFailure")
        }
        ClaudeHookModule::Subagent => {
            for (hook_event, command_event) in [
                ("SubagentStart", "SubagentStart"),
                ("SubagentStop", "SubagentStop"),
                ("PreToolUse", "AgentToolStart"),
                ("PostToolUse", "AgentToolStop"),
                ("PreToolUse", "ToolStart"),
                ("PostToolUse", "ToolStop"),
            ] {
                remove_named_hook_command(settings, hook_event, source, command_event);
            }
        }
    }
}

fn build_grok_status(grok_dir: Option<PathBuf>) -> Result<ToolHookSettingsStatus, String> {
    let Some(grok_dir) = grok_dir else {
        return missing_status();
    };

    let hooks_dir = grok_dir.join("hooks");
    let hooks_path = grok_hooks_path(&grok_dir);
    let config_path = grok_config_path(&grok_dir);
    let exe = hook_exe_for_dir(&grok_dir).ok();
    let settings = read_json_if_exists(&hooks_path)?;
    let registered = |event: &str| {
        exe.as_deref().is_some_and(|exe| {
            exact_command_registered(&settings, event, &build_command(exe, "grok", event))
        })
    };
    let isolation_ok = grok_cross_vendor_hooks_disabled(&config_path)?;
    let checks = ToolChecks {
        attention_script_installed: exe.is_some(),
        finished_script_installed: exe.is_some(),
        session_start_hook_installed: registered("SessionStart"),
        running_hook_installed: registered("UserPromptSubmit"),
        attention_hook_installed: registered_exact_command(
            &settings,
            exe.as_deref(),
            "PreToolUse",
            "grok",
            "PermissionRequest",
        ),
        attention_hook_required: true,
        stop_hook_installed: registered("Stop"),
        failure_hook_installed: registered("StopFailure"),
        failure_hook_required: true,
        subagent_start_hook_installed: registered("SubagentStart")
            && registered("SubagentStop")
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "grok",
                "AgentToolStart",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PostToolUse",
                "grok",
                "AgentToolStop",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "grok",
                "ToolStart",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PostToolUse",
                "grok",
                "ToolStop",
            ),
        subagent_start_hook_required: true,
        // Reuse hooks_feature_installed to mean "cross-vendor hook isolation enabled".
        hooks_feature_installed: isolation_ok,
    };

    Ok(status_from_checks(
        Some(grok_dir),
        Some(hooks_dir),
        Some(hooks_path),
        Some(config_path),
        checks,
    ))
}


fn resolve_pi_dir(
    selected_dir: Option<String>,
    create_if_missing: bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(dir) = selected_dir.and_then(|value| normalize_selected_dir(&value)) {
        if dir.is_dir() {
            return Ok(Some(dir));
        }
        if create_if_missing {
            fs::create_dir_all(&dir).map_err(|e| format!("创建 Pi 配置目录失败: {e}"))?;
            return Ok(Some(dir));
        }
        return Err("选择的 Pi 配置目录不存在".to_string());
    }

    let Some(home_dir) = home_dir() else {
        return Ok(None);
    };
    let default_dir = home_dir.join(".pi").join("agent");
    if default_dir.is_dir() {
        Ok(Some(default_dir))
    } else if create_if_missing {
        fs::create_dir_all(&default_dir).map_err(|e| format!("创建 Pi 配置目录失败: {e}"))?;
        Ok(Some(default_dir))
    } else {
        Ok(None)
    }
}

fn pi_extension_path(pi_dir: &Path) -> PathBuf {
    pi_dir.join(PI_EXTENSION_DIR_NAME).join(PI_EXTENSION_FILE_NAME)
}

fn pi_module_marker(module: PiHookModule) -> &'static str {
    match module {
        PiHookModule::SessionStart => PI_MODULE_SESSION_START,
        PiHookModule::Running => PI_MODULE_RUNNING,
        PiHookModule::Stop => PI_MODULE_STOP,
    }
}

fn pi_extension_source(modules: &[PiHookModule]) -> String {
    let session_start = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::SessionStart));
    let running = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::Running));
    let stop = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::Stop));

    let mut source = format!(
        r#"// {marker}
// Managed by CLI-Manager. Do not edit manually; reinstall from Hook settings.
// Bridges Pi Agent lifecycle events into CLI-Manager tab notifications / live stats.

import type {{ ExtensionAPI }} from "@earendil-works/pi-coding-agent";

const MARKER = "{marker}";
const ENABLED = {{
  sessionStart: {session_start},
  running: {running},
  stop: {stop},
}};

type NotifyEvent = "SessionStart" | "UserPromptSubmit" | "Stop";

function nonEmpty(value: string | undefined | null): string | null {{
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}}

async function postHookEvent(event: NotifyEvent, sessionId: string | null, message?: string | null) {{
  const tabId = nonEmpty(process.env.CLI_MANAGER_TAB_ID);
  const port = nonEmpty(process.env.CLI_MANAGER_NOTIFY_PORT);
  const token = nonEmpty(process.env.CLI_MANAGER_NOTIFY_TOKEN);
  if (!tabId || !port || !token) return;

  const payload = {{
    tabId,
    source: "pi",
    event,
    title: titleFor(event),
    message: message ?? null,
    sessionId,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  }};

  try {{
    await fetch(`http://127.0.0.1:${{port}}/api/claude-hook`, {{
      method: "POST",
      headers: {{
        Authorization: `Bearer ${{token}}`,
        "Content-Type": "application/json",
      }},
      body: JSON.stringify(payload),
    }});
  }} catch {{
    // Hook bridge failures must never interrupt Pi.
  }}
}}

function titleFor(event: NotifyEvent): string {{
  switch (event) {{
    case "SessionStart":
      return "Pi Agent session started";
    case "UserPromptSubmit":
      return "Pi Agent running";
    case "Stop":
      return "Pi Agent done";
  }}
}}

function readSessionId(ctx: {{ sessionManager?: {{ getSessionId?: () => string | undefined }} }}): string | null {{
  try {{
    return nonEmpty(ctx.sessionManager?.getSessionId?.() ?? null);
  }} catch {{
    return null;
  }}
}}

export default function (pi: ExtensionAPI) {{
  if (ENABLED.sessionStart) {{
    pi.on("session_start", async (_event, ctx) => {{
      await postHookEvent("SessionStart", readSessionId(ctx));
    }});
  }}

  if (ENABLED.running) {{
    pi.on("agent_start", async (_event, ctx) => {{
      await postHookEvent("UserPromptSubmit", readSessionId(ctx));
    }});
  }}

  if (ENABLED.stop) {{
    pi.on("agent_settled", async (_event, ctx) => {{
      await postHookEvent("Stop", readSessionId(ctx));
    }});
  }}

  void MARKER;
}}
"#,
        marker = PI_EXTENSION_MARKER,
        session_start = if session_start { "true" } else { "false" },
        running = if running { "true" } else { "false" },
        stop = if stop { "true" } else { "false" },
    );

    for module in modules {
        source.push_str(&format!("// {}\n", pi_module_marker(*module)));
    }
    source
}

fn read_pi_modules(content: &str) -> Vec<PiHookModule> {
    let mut modules = Vec::new();
    if content.contains(PI_MODULE_SESSION_START) || content.contains("sessionStart: true") {
        modules.push(PiHookModule::SessionStart);
    }
    if content.contains(PI_MODULE_RUNNING) || content.contains("running: true") {
        modules.push(PiHookModule::Running);
    }
    if content.contains(PI_MODULE_STOP) || content.contains("stop: true") {
        modules.push(PiHookModule::Stop);
    }
    if modules.is_empty()
        && content.contains(PI_EXTENSION_MARKER)
        && content.contains(r#"source: "pi""#)
    {
        modules.extend_from_slice(&ALL_PI_HOOK_MODULES);
    }
    modules
}

fn install_pi_hooks(pi_dir: &Path) -> Result<(), String> {
    install_pi_modules(pi_dir, &ALL_PI_HOOK_MODULES)
}

fn install_pi_hook_module(pi_dir: &Path, module: PiHookModule) -> Result<(), String> {
    let path = pi_extension_path(pi_dir);
    let mut modules = if path.is_file() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败: {e}", path_to_string(&path)))?;
        read_pi_modules(&content)
    } else {
        Vec::new()
    };
    if !modules
        .iter()
        .any(|item| std::mem::discriminant(item) == std::mem::discriminant(&module))
    {
        modules.push(module);
    }
    install_pi_modules(pi_dir, &modules)
}

fn uninstall_pi_hooks(pi_dir: &Path) -> Result<(), String> {
    let path = pi_extension_path(pi_dir);
    if path.is_file() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败: {e}", path_to_string(&path)))?;
        if content.contains(PI_EXTENSION_MARKER) {
            fs::remove_file(&path)
                .map_err(|e| format!("删除 {} 失败: {e}", path_to_string(&path)))?;
        }
    }
    Ok(())
}

fn uninstall_pi_hook_module(pi_dir: &Path, module: PiHookModule) -> Result<(), String> {
    let path = pi_extension_path(pi_dir);
    if !path.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("读取 {} 失败: {e}", path_to_string(&path)))?;
    if !content.contains(PI_EXTENSION_MARKER) {
        return Ok(());
    }
    let modules: Vec<PiHookModule> = read_pi_modules(&content)
        .into_iter()
        .filter(|item| std::mem::discriminant(item) != std::mem::discriminant(&module))
        .collect();
    if modules.is_empty() {
        fs::remove_file(&path).map_err(|e| format!("删除 {} 失败: {e}", path_to_string(&path)))?;
        return Ok(());
    }
    install_pi_modules(pi_dir, &modules)
}

fn install_pi_modules(pi_dir: &Path, modules: &[PiHookModule]) -> Result<(), String> {
    if modules.is_empty() {
        return uninstall_pi_hooks(pi_dir);
    }
    let extensions_dir = pi_dir.join(PI_EXTENSION_DIR_NAME);
    fs::create_dir_all(&extensions_dir)
        .map_err(|e| format!("创建 {} 失败: {e}", path_to_string(&extensions_dir)))?;
    let path = pi_extension_path(pi_dir);
    ensure_pi_extension_writable(&path)?;
    let source = pi_extension_source(modules);
    fs::write(&path, source).map_err(|e| format!("写入 {} 失败: {e}", path_to_string(&path)))?;
    Ok(())
}

fn ensure_pi_extension_writable(path: &Path) -> Result<(), String> {
    match fs::read_to_string(path) {
        Ok(content) if !content.contains(PI_EXTENSION_MARKER) => {
            Err(PI_EXTENSION_CONFLICT_ERROR.to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("读取 {} 失败: {error}", path_to_string(path))),
    }
}

fn build_pi_status(pi_dir: Option<PathBuf>) -> Result<ToolHookSettingsStatus, String> {
    let Some(pi_dir) = pi_dir else {
        return missing_status();
    };

    let extension_path = pi_extension_path(&pi_dir);
    let hooks_dir = pi_dir.join(PI_EXTENSION_DIR_NAME);
    let content = if extension_path.is_file() {
        fs::read_to_string(&extension_path)
            .map_err(|e| format!("读取 {} 失败: {e}", path_to_string(&extension_path)))?
    } else {
        String::new()
    };
    let owned = content.contains(PI_EXTENSION_MARKER);
    let modules = if owned {
        read_pi_modules(&content)
    } else {
        Vec::new()
    };
    let session_start = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::SessionStart));
    let running = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::Running));
    let stop = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::Stop));

    let checks = ToolChecks {
        attention_script_installed: owned,
        finished_script_installed: owned,
        session_start_hook_installed: session_start,
        running_hook_installed: running,
        attention_hook_installed: false,
        attention_hook_required: false,
        stop_hook_installed: stop,
        failure_hook_installed: false,
        failure_hook_required: false,
        subagent_start_hook_installed: false,
        subagent_start_hook_required: false,
        hooks_feature_installed: true,
        hooks_trusted: true,
    };

    Ok(status_from_checks(
        Some(pi_dir),
        Some(hooks_dir),
        Some(extension_path),
        None,
        checks,
    ))
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

fn resolve_codex_dir(
    selected_dir: Option<String>,
    create_if_missing: bool,
) -> Result<Option<PathBuf>, String> {
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
    #[cfg(target_os = "windows")]
    {
        env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .or_else(|| env::var_os("HOME").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
    }
}

fn build_claude_status(claude_dir: Option<PathBuf>) -> Result<ToolHookSettingsStatus, String> {
    let Some(claude_dir) = claude_dir else {
        return missing_status();
    };

    let hooks_dir = claude_dir.join("hooks");
    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    // 目标目录在 WSL 时，注册命令的 exe 须用 /mnt 形式，否则 Linux shell 执行报 not found
    let exe = hook_exe_for_dir(&claude_dir).ok();
    let settings = read_json_if_exists(&settings_path)?;
    let registered = |event: &str| {
        exe.as_deref().is_some_and(|exe| {
            exact_command_registered(&settings, event, &build_command(exe, "claude", event))
        })
    };
    let checks = ToolChecks {
        attention_script_installed: exe.is_some(),
        finished_script_installed: exe.is_some(),
        session_start_hook_installed: registered("SessionStart"),
        running_hook_installed: registered("UserPromptSubmit"),
        attention_hook_installed: registered("Notification"),
        attention_hook_required: true,
        stop_hook_installed: registered("Stop"),
        failure_hook_installed: registered("StopFailure"),
        failure_hook_required: true,
        subagent_start_hook_installed: registered("SubagentStart")
            && registered("SubagentStop")
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "claude",
                "AgentToolStart",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PostToolUse",
                "claude",
                "AgentToolStop",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "claude",
                "ToolStart",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PostToolUse",
                "claude",
                "ToolStop",
            ),
        subagent_start_hook_required: true,
        hooks_feature_installed: true,
        hooks_trusted: true,
    };

    Ok(status_from_checks(
        Some(claude_dir),
        Some(hooks_dir),
        Some(settings_path),
        None,
        checks,
    ))
}

fn build_codex_status(codex_dir: Option<PathBuf>) -> Result<ToolHookSettingsStatus, String> {
    let Some(codex_dir) = codex_dir else {
        return missing_status();
    };

    let hooks_dir = codex_dir.join("hooks");
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let exe = hook_exe_for_dir(&codex_dir).ok();
    let settings = read_json_if_exists(&hooks_path)?;
    let registered = |event: &str| {
        exe.as_deref().is_some_and(|exe| {
            exact_command_registered(&settings, event, &build_command(exe, "codex", event))
        })
    };
    let checks = ToolChecks {
        attention_script_installed: exe.is_some(),
        finished_script_installed: exe.is_some(),
        session_start_hook_installed: registered("SessionStart"),
        running_hook_installed: registered("UserPromptSubmit"),
        attention_hook_installed: registered("PermissionRequest"),
        attention_hook_required: true,
        stop_hook_installed: registered("Stop"),
        failure_hook_installed: false,
        failure_hook_required: false,
        subagent_start_hook_installed: registered("SubagentStart") && registered("SubagentStop"),
        subagent_start_hook_required: true,
        hooks_feature_installed: codex_hooks_feature_installed(&config_path)?,
        hooks_trusted: codex_cli_manager_hooks_trusted(&settings, &hooks_path, &config_path)?,
    };

    Ok(status_from_checks(
        Some(codex_dir),
        Some(hooks_dir),
        Some(hooks_path),
        Some(config_path),
        checks,
    ))
}

struct ToolChecks {
    attention_script_installed: bool,
    finished_script_installed: bool,
    session_start_hook_installed: bool,
    running_hook_installed: bool,
    attention_hook_installed: bool,
    attention_hook_required: bool,
    stop_hook_installed: bool,
    failure_hook_installed: bool,
    failure_hook_required: bool,
    subagent_start_hook_installed: bool,
    subagent_start_hook_required: bool,
    hooks_feature_installed: bool,
    hooks_trusted: bool,
}

fn missing_status() -> Result<ToolHookSettingsStatus, String> {
    Ok(ToolHookSettingsStatus {
        config_dir: None,
        hooks_dir: None,
        config_path: None,
        feature_config_path: None,
        status: HookInstallStatus::DirectoryMissing,
        attention_script_installed: false,
        finished_script_installed: false,
        session_start_hook_installed: false,
        running_hook_installed: false,
        attention_hook_installed: false,
        stop_hook_installed: false,
        failure_hook_installed: false,
        subagent_start_hook_installed: false,
        hooks_feature_installed: false,
    })
}

fn status_from_checks(
    config_dir: Option<PathBuf>,
    hooks_dir: Option<PathBuf>,
    config_path: Option<PathBuf>,
    feature_config_path: Option<PathBuf>,
    checks: ToolChecks,
) -> ToolHookSettingsStatus {
    let mut values = vec![
        checks.session_start_hook_installed,
        checks.running_hook_installed,
        checks.stop_hook_installed,
        checks.hooks_feature_installed,
        checks.hooks_trusted,
    ];
    if checks.attention_hook_required {
        values.push(checks.attention_hook_installed);
    }
    if checks.failure_hook_required {
        values.push(checks.failure_hook_installed);
    }
    if checks.subagent_start_hook_required {
        values.push(checks.subagent_start_hook_installed);
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
        feature_config_path: feature_config_path.as_deref().map(path_to_string),
        status,
        attention_script_installed: checks.attention_script_installed,
        finished_script_installed: checks.finished_script_installed,
        session_start_hook_installed: checks.session_start_hook_installed,
        running_hook_installed: checks.running_hook_installed,
        attention_hook_installed: checks.attention_hook_installed,
        stop_hook_installed: checks.stop_hook_installed,
        failure_hook_installed: checks.failure_hook_installed,
        subagent_start_hook_installed: checks.subagent_start_hook_installed,
        hooks_feature_installed: checks.hooks_feature_installed,
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
    add_hook_command_with_matcher(settings, event, "", command);
}

fn add_hook_command_with_matcher(
    settings: &mut Value,
    event: &str,
    matcher: &str,
    command: String,
) {
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
            "matcher": matcher,
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

fn remove_named_hook_command(
    settings: &mut Value,
    hook_event: &str,
    source: &str,
    command_event: &str,
) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(Value::Array(entries)) = hooks.get_mut(hook_event) else {
        return;
    };
    let source_arg = format!("--source {source}");
    let event_arg = format!("--event {command_event}");
    entries.retain_mut(|entry| {
        let Some(commands) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
            return true;
        };
        commands.retain(|hook| {
            !hook
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| {
                    command.contains(HOOK_COMMAND_MARKER)
                        && command.contains(&source_arg)
                        && command.contains(&event_arg)
                })
        });
        !commands.is_empty()
    });
    if entries.is_empty() {
        hooks.remove(hook_event);
    }
    if hooks.is_empty() {
        settings.as_object_mut().map(|root| root.remove("hooks"));
    }
}

fn registered_exact_command(
    settings: &Value,
    exe: Option<&str>,
    hook_event: &str,
    source: &str,
    command_event: &str,
) -> bool {
    exe.is_some_and(|exe| {
        exact_command_registered(
            settings,
            hook_event,
            &build_command(exe, source, command_event),
        )
    })
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

fn is_cli_manager_command(hook: &Value, legacy_scripts: &[&str]) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            // 新方案命令含 __hook 标志；同时兼容识别历史 .ps1 命令，便于安装即升级/卸载清理。
            command.contains(HOOK_COMMAND_MARKER)
                || legacy_scripts
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

fn build_command(exe: &str, source: &str, event: &str) -> String {
    if is_windows_native_exe_path(exe) {
        let exe = escape_powershell_single_quoted(exe);
        return format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '{exe}' {HOOK_COMMAND_MARKER} --source {source} --event {event}\""
        );
    }

    let exe = escape_posix_single_quoted(exe);
    format!("{exe} {HOOK_COMMAND_MARKER} --source {source} --event {event}")
}

fn is_windows_native_exe_path(exe: &str) -> bool {
    let bytes = exe.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || exe.starts_with(r"\\")
}

fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

fn escape_posix_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn cli_manager_exe() -> Result<String, String> {
    env::current_exe()
        .map(|path| path_to_string(&path))
        .map_err(|e| format!("获取程序路径失败: {e}"))
}

/// 返回写入 hook 命令时应使用的 exe 路径：目标配置目录在 WSL（`\\wsl.localhost\...`）时
/// 转成 `/mnt/<盘>/...` 形式，使 Linux shell 能执行；否则用原生 Windows 路径。
fn hook_exe_for_dir(config_dir: &Path) -> Result<String, String> {
    let exe = cli_manager_exe()?;
    if crate::wsl::is_wsl_config_dir(&path_to_string(config_dir)) {
        crate::wsl::windows_path_to_wsl(&exe)
            .ok_or_else(|| format!("无法将程序路径转换为 WSL 形式: {exe}"))
    } else {
        Ok(exe)
    }
}

/// 删除历史遗留的 PowerShell hook 脚本（若存在）；新方案不再写脚本文件。
fn cleanup_legacy_scripts(hooks_dir: &Path, scripts: &[&str]) {
    for name in scripts {
        let _ = fs::remove_file(hooks_dir.join(name));
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn trust_installed_codex_hooks(codex_dir: &Path) {
        let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
        let settings = read_json_if_exists(&hooks_path).unwrap();
        let hooks = settings.get("hooks").and_then(Value::as_object).unwrap();
        let mut blocks = Vec::new();
        for event in CODEX_HOOK_EVENTS {
            let event_name = codex_hook_state_event_name(event).unwrap();
            let Some(entries) = hooks.get(event).and_then(Value::as_array) else {
                continue;
            };
            for (entry_index, entry) in entries.iter().enumerate() {
                let commands = entry.get("hooks").and_then(Value::as_array).unwrap();
                for (hook_index, hook) in commands.iter().enumerate() {
                    if !is_cli_manager_command(hook, &CODEX_LEGACY_SCRIPTS) {
                        continue;
                    }
                    let key = toml_escape_basic_string(&format!(
                        "{}:{event_name}:{entry_index}:{hook_index}",
                        path_to_string(&hooks_path)
                    ));
                    let hash = codex_hook_trusted_hash(event, entry, hook).unwrap();
                    blocks.push(format!(
                        "[hooks.state.\"{key}\"]\ntrusted_hash = \"{hash}\""
                    ));
                }
            }
        }
        let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
        let mut config = fs::read_to_string(&config_path).unwrap();
        config.push('\n');
        config.push_str(&blocks.join("\n\n"));
        config.push('\n');
        fs::write(config_path, config).unwrap();
    }

    #[tokio::test]
    async fn install_codex_rejects_missing_selected_dir_without_creating_it() {
        let tmp = TempDir::new().unwrap();
        let missing_codex_dir = tmp.path().join("missing-codex");

        let err = resolve_codex_dir(Some(path_to_string(&missing_codex_dir)), false).unwrap_err();

        assert_eq!(err, "选择的 Codex 配置目录不存在");
        assert!(!missing_codex_dir.exists());
    }

    #[tokio::test]
    async fn install_codex_allows_existing_selected_dir() {
        let tmp = TempDir::new().unwrap();
        let claude_dir = tmp.path().join("claude");
        let codex_dir = tmp.path().join("codex");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::create_dir_all(&codex_dir).unwrap();

        install_codex_hooks(&codex_dir).unwrap();
        let untrusted_status = build_codex_status(Some(codex_dir.clone())).unwrap();
        assert!(matches!(
            untrusted_status.status,
            HookInstallStatus::PartialInstalled
        ));
        trust_installed_codex_hooks(&codex_dir);
        let status = build_codex_status(Some(codex_dir.clone())).unwrap();

        assert!(matches!(status.status, HookInstallStatus::Installed));
        // 新方案不写脚本文件，改为校验 hooks.json 已注册指向二进制 __hook 的命令
        assert!(codex_dir.join(CODEX_HOOKS_FILE_NAME).is_file());
        assert!(codex_dir.join(CODEX_CONFIG_FILE_NAME).is_file());
        let hooks_json = fs::read_to_string(codex_dir.join(CODEX_HOOKS_FILE_NAME)).unwrap();
        assert!(hooks_json.contains(HOOK_COMMAND_MARKER));
        assert!(hooks_json.contains("--source codex"));
        assert!(hooks_json.contains("--event SubagentStart"));
        assert!(hooks_json.contains("--event SubagentStop"));
        assert!(!hooks_json.contains(".ps1"));
        assert!(!codex_dir
            .join("hooks")
            .join(CODEX_ATTENTION_SCRIPT_NAME)
            .is_file());
    }

    #[test]
    fn codex_hook_trusted_hash_matches_codex_canonical_format() {
        let group = json!({
            "matcher": "",
            "hooks": [{
                "type": "command",
                "command": "/tmp/cli-manager __hook --source codex --event SessionStart",
                "timeout": 15
            }]
        });
        let hook = &group["hooks"][0];

        assert_eq!(
            codex_hook_trusted_hash("SessionStart", &group, hook).unwrap(),
            "sha256:9e6b7860465f1ee644164253a9e2aee2b124b234b836f5a68330eeb99929dfb4"
        );
    }

    #[test]
    fn codex_status_rejects_disabled_or_stale_hook_trust() {
        let tmp = TempDir::new().unwrap();
        let codex_dir = tmp.path().join("codex");
        fs::create_dir_all(&codex_dir).unwrap();
        install_codex_hooks(&codex_dir).unwrap();
        trust_installed_codex_hooks(&codex_dir);
        let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
        let trusted = fs::read_to_string(&config_path).unwrap();

        fs::write(
            &config_path,
            trusted.replacen("trusted_hash =", "enabled = false\ntrusted_hash =", 1),
        )
        .unwrap();
        let disabled = build_codex_status(Some(codex_dir.clone())).unwrap();
        assert!(matches!(
            disabled.status,
            HookInstallStatus::PartialInstalled
        ));

        fs::write(
            &config_path,
            trusted.replacen("sha256:", "sha256:stale-", 1),
        )
        .unwrap();
        let stale = build_codex_status(Some(codex_dir)).unwrap();
        assert!(matches!(stale.status, HookInstallStatus::PartialInstalled));
    }

    #[tokio::test]
    async fn install_codex_registers_and_uninstall_removes_subagent_start() {
        let tmp = TempDir::new().unwrap();
        let claude_dir = tmp.path().join("claude");
        let codex_dir = tmp.path().join("codex");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::create_dir_all(&codex_dir).unwrap();

        install_codex_hooks(&codex_dir).unwrap();
        let status = build_codex_status(Some(codex_dir.clone())).unwrap();
        assert!(status.subagent_start_hook_installed);
        let after_install = fs::read_to_string(codex_dir.join(CODEX_HOOKS_FILE_NAME)).unwrap();
        assert!(after_install.contains("--event SubagentStart"));
        assert!(after_install.contains("--event SubagentStop"));

        uninstall_codex_hooks(&codex_dir).unwrap();
        let after_uninstall = fs::read_to_string(codex_dir.join(CODEX_HOOKS_FILE_NAME)).unwrap();
        assert!(!after_uninstall.contains("--event SubagentStart"));
        assert!(!after_uninstall.contains("--event SubagentStop"));
    }

    #[tokio::test]
    async fn install_then_uninstall_grok_writes_hooks_and_disables_compat() {
        let tmp = TempDir::new().unwrap();
        let grok_dir = tmp.path().join("grok");
        fs::create_dir_all(&grok_dir).unwrap();

        install_grok_hooks(&grok_dir).unwrap();
        let status = build_grok_status(Some(grok_dir.clone())).unwrap();
        assert!(matches!(status.status, HookInstallStatus::Installed));
        assert!(status.hooks_feature_installed);

        let hooks_json = fs::read_to_string(grok_hooks_path(&grok_dir)).unwrap();
        assert!(hooks_json.contains(HOOK_COMMAND_MARKER));
        assert!(hooks_json.contains("--source grok"));
        assert!(hooks_json.contains("--event SessionStart"));
        assert!(hooks_json.contains("--event PermissionRequest"));
        assert!(hooks_json.contains("Bash|Edit|Write|MultiEdit"));
        assert!(hooks_json.contains("--event ToolStart"));
        assert!(!hooks_json.contains("--event Notification"));

        let config = fs::read_to_string(grok_config_path(&grok_dir)).unwrap();
        assert!(config.contains("[compat.claude]"));
        assert!(config.contains("[compat.cursor]"));
        assert_eq!(
            toml_table_bool(&config, "compat.claude", "hooks"),
            Some(false)
        );
        assert_eq!(
            toml_table_bool(&config, "compat.cursor", "hooks"),
            Some(false)
        );

        uninstall_grok_hooks(&grok_dir).unwrap();
        let status = build_grok_status(Some(grok_dir.clone())).unwrap();
        assert!(!matches!(status.status, HookInstallStatus::Installed));
        // Uninstall must NOT re-enable foreign hooks.
        let config = fs::read_to_string(grok_config_path(&grok_dir)).unwrap();
        assert_eq!(
            toml_table_bool(&config, "compat.claude", "hooks"),
            Some(false)
        );
        assert_eq!(
            toml_table_bool(&config, "compat.cursor", "hooks"),
            Some(false)
        );
    }

    #[test]
    fn uninstall_grok_attention_preserves_tool_start_hook() {
        let tmp = TempDir::new().unwrap();
        let grok_dir = tmp.path().join("grok");
        fs::create_dir_all(&grok_dir).unwrap();

        install_grok_hooks(&grok_dir).unwrap();
        uninstall_grok_hook_module(&grok_dir, ClaudeHookModule::Attention).unwrap();

        let settings = read_json(&grok_hooks_path(&grok_dir)).unwrap();
        let exe = hook_exe_for_dir(&grok_dir).unwrap();
        assert!(!registered_exact_command(
            &settings,
            Some(&exe),
            "PreToolUse",
            "grok",
            "PermissionRequest",
        ));
        assert!(registered_exact_command(
            &settings,
            Some(&exe),
            "PreToolUse",
            "grok",
            "ToolStart",
        ));
    }

    #[test]
    fn install_grok_attention_upgrades_obsolete_notification_hook() {
        let tmp = TempDir::new().unwrap();
        let grok_dir = tmp.path().join("grok");
        fs::create_dir_all(&grok_dir).unwrap();
        let exe = hook_exe_for_dir(&grok_dir).unwrap();
        let hooks_path = grok_hooks_path(&grok_dir);
        let mut settings = json!({});
        add_hook_command_with_matcher(
            &mut settings,
            "Notification",
            "permission_prompt|idle_prompt",
            build_command(&exe, "grok", "Notification"),
        );
        fs::create_dir_all(hooks_path.parent().unwrap()).unwrap();
        write_json(&hooks_path, &settings).unwrap();

        install_grok_hook_module(&grok_dir, ClaudeHookModule::Attention).unwrap();

        let settings = read_json(&hooks_path).unwrap();
        assert!(!registered_exact_command(
            &settings,
            Some(&exe),
            "Notification",
            "grok",
            "Notification",
        ));
        assert!(registered_exact_command(
            &settings,
            Some(&exe),
            "PreToolUse",
            "grok",
            "PermissionRequest",
        ));
    }

    #[test]
    fn set_toml_table_bool_updates_existing_and_preserves_other_keys() {
        let input = r#"
[models]
default = "x"

[compat.claude]
skills = true
hooks = true

[ui]
yolo = false
"#;
        let out = set_toml_table_bool(input, "compat.claude", "hooks", false);
        assert_eq!(toml_table_bool(&out, "compat.claude", "hooks"), Some(false));
        assert!(out.contains("skills = true"));
        assert!(out.contains("[models]"));
        assert!(out.contains("[ui]"));
    }

    #[tokio::test]
    async fn install_then_uninstall_claude_removes_hook_commands() {
        let tmp = TempDir::new().unwrap();
        let claude_dir = tmp.path().join("claude");
        fs::create_dir_all(&claude_dir).unwrap();

        install_claude_hooks(&claude_dir).unwrap();
        let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
        let after_install = fs::read_to_string(&settings_path).unwrap();
        assert!(after_install.contains(HOOK_COMMAND_MARKER));
        assert!(after_install.contains("--source claude"));

        uninstall_claude_hooks(&claude_dir).unwrap();
        let after_uninstall = fs::read_to_string(&settings_path).unwrap();
        assert!(!after_uninstall.contains(HOOK_COMMAND_MARKER));
    }

    #[tokio::test]
    async fn install_claude_registers_and_uninstall_removes_subagent_start() {
        let tmp = TempDir::new().unwrap();
        let claude_dir = tmp.path().join("claude");
        fs::create_dir_all(&claude_dir).unwrap();

        install_claude_hooks(&claude_dir).unwrap();
        let status = build_claude_status(Some(claude_dir.clone())).unwrap();
        assert!(status.subagent_start_hook_installed);
        let after_install = fs::read_to_string(claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
        assert!(after_install.contains("--event SubagentStart"));
        assert!(after_install.contains("--event SubagentStop"));
        assert!(after_install.contains("PreToolUse"));
        assert!(after_install.contains("PostToolUse"));
        assert!(after_install.contains("--event AgentToolStart"));
        assert!(after_install.contains("--event AgentToolStop"));
        assert!(after_install.contains("--event ToolStart"));
        assert!(after_install.contains("--event ToolStop"));

        uninstall_claude_hooks(&claude_dir).unwrap();
        let after_uninstall =
            fs::read_to_string(claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
        assert!(!after_uninstall.contains("--event SubagentStart"));
        assert!(!after_uninstall.contains("--event SubagentStop"));
        assert!(!after_uninstall.contains("--event AgentToolStart"));
        assert!(!after_uninstall.contains("--event AgentToolStop"));
        assert!(!after_uninstall.contains("--event ToolStart"));
        assert!(!after_uninstall.contains("--event ToolStop"));
    }

    #[tokio::test]
    async fn install_claude_single_module_only_writes_requested_event() {
        let tmp = TempDir::new().unwrap();
        let claude_dir = tmp.path().join("claude");
        fs::create_dir_all(&claude_dir).unwrap();

        install_claude_hook_module(&claude_dir, ClaudeHookModule::Running).unwrap();

        let settings = fs::read_to_string(claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
        assert!(settings.contains("--event UserPromptSubmit"));
        assert!(!settings.contains("--event SessionStart"));
        assert!(!settings.contains("--event Stop"));
        assert!(!settings.contains("--event SubagentStart"));
    }

    #[tokio::test]
    async fn install_codex_hooks_feature_module_only_toggles_config() {
        let tmp = TempDir::new().unwrap();
        let codex_dir = tmp.path().join("codex");
        fs::create_dir_all(&codex_dir).unwrap();

        install_codex_hook_module(&codex_dir, CodexHookModule::HooksFeature).unwrap();
        let config_after_install =
            fs::read_to_string(codex_dir.join(CODEX_CONFIG_FILE_NAME)).unwrap();
        assert!(config_after_install.contains("hooks = true"));
        assert!(!codex_dir.join(CODEX_HOOKS_FILE_NAME).exists());

        uninstall_codex_hook_module(&codex_dir, CodexHookModule::HooksFeature).unwrap();
        let config_after_uninstall =
            fs::read_to_string(codex_dir.join(CODEX_CONFIG_FILE_NAME)).unwrap();
        assert!(config_after_uninstall.contains("hooks = false"));
        assert!(!codex_dir.join(CODEX_HOOKS_FILE_NAME).exists());
    }

    #[tokio::test]
    async fn empty_codex_status_is_not_installed() {
        let tmp = TempDir::new().unwrap();
        let codex_dir = tmp.path().join("codex");
        fs::create_dir_all(&codex_dir).unwrap();

        let status = build_codex_status(Some(codex_dir)).unwrap();

        assert!(matches!(status.status, HookInstallStatus::NotInstalled));
    }

    #[tokio::test]
    async fn install_claude_cleans_legacy_ps1_command() {
        let tmp = TempDir::new().unwrap();
        let claude_dir = tmp.path().join("claude");
        let hooks_dir = claude_dir.join("hooks");
        fs::create_dir_all(&hooks_dir).unwrap();
        // 预置旧版 .ps1 脚本文件与对应注册命令，验证安装即升级会清掉历史项
        fs::write(hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME), "old").unwrap();
        let legacy = json!({
            "hooks": {
                "Stop": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": format!("powershell -File \"{}\" -Event Stop", CLAUDE_APPROVAL_SCRIPT_NAME),
                        "timeout": 15
                    }]
                }]
            }
        });
        fs::write(
            claude_dir.join(CLAUDE_SETTINGS_FILE_NAME),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();

        install_claude_hooks(&claude_dir).unwrap();

        let settings = fs::read_to_string(claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
        assert!(!settings.contains(".ps1"));
        assert!(settings.contains(HOOK_COMMAND_MARKER));
        assert!(!hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME).is_file());
    }

    #[test]
    fn merge_claude_common_config_hooks_preserves_existing_fields_and_hooks() {
        let exe = "/tmp/cli-manager";
        let existing = serde_json::to_string(&json!({
            "env": {
                "FOO": "bar"
            },
            "hooks": {
                "Stop": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": "echo keep",
                        "timeout": 1
                    }]
                }]
            }
        }))
        .unwrap();

        let merged = merge_claude_common_config_hooks(Some(&existing), exe).unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();

        assert_eq!(value["env"]["FOO"].as_str(), Some("bar"));
        assert!(event_has_exact_command(
            &value["hooks"]["Stop"],
            "echo keep"
        ));
        assert!(exact_command_registered(
            &value,
            "Notification",
            &build_command(exe, "claude", "Notification")
        ));
        assert!(claude_common_config_has_hooks(Some(&merged), exe).unwrap());
    }

    #[test]
    fn strip_claude_common_config_hooks_keeps_non_cli_manager_hooks() {
        let exe = "/tmp/cli-manager";
        let existing = serde_json::to_string(&json!({
            "env": {
                "FOO": "bar"
            },
            "hooks": {
                "Stop": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": "echo keep",
                        "timeout": 1
                    }]
                }]
            }
        }))
        .unwrap();
        let merged = merge_claude_common_config_hooks(Some(&existing), exe).unwrap();

        let stripped = strip_claude_common_config_hooks(Some(&merged))
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(&stripped).unwrap();

        assert_eq!(value["env"]["FOO"].as_str(), Some("bar"));
        assert!(event_has_exact_command(
            &value["hooks"]["Stop"],
            "echo keep"
        ));
        assert!(!serde_json::to_string(&value)
            .unwrap()
            .contains(HOOK_COMMAND_MARKER));
    }

    #[test]
    fn merge_common_config_statusline_preserves_existing_fields_and_hooks() {
        let existing = serde_json::to_string(&json!({
            "env": { "FOO": "bar" },
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo keep" }] }] },
            "statusLine": { "type": "command", "command": "third-party" }
        }))
        .unwrap();
        let merged = merge_common_config_statusline(
            Some(&existing),
            json!({ "type": "command", "command": "cli-manager __statusline", "padding": 0 }),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();

        assert_eq!(value["env"]["FOO"].as_str(), Some("bar"));
        assert_eq!(
            value["hooks"]["Stop"][0]["hooks"][0]["command"].as_str(),
            Some("echo keep")
        );
        assert_eq!(
            value["statusLine"]["command"].as_str(),
            Some("cli-manager __statusline")
        );
    }

    #[test]
    fn strip_common_config_statusline_only_removes_cli_manager_statusline() {
        let managed = serde_json::to_string(&json!({
            "env": { "FOO": "bar" },
            "statusLine": { "type": "command", "command": "cli-manager __statusline" }
        }))
        .unwrap();
        let stripped = strip_common_config_statusline(Some(&managed))
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(value["env"]["FOO"].as_str(), Some("bar"));
        assert!(value.get("statusLine").is_none());

        let third_party = r#"{"statusLine":{"type":"command","command":"third-party"}}"#;
        assert!(strip_common_config_statusline(Some(third_party))
            .unwrap()
            .is_none());
    }

    #[test]
    fn merge_codex_statusline_preserves_existing_common_config() {
        let raw = r#"model_reasoning_effort = "xhigh"

[features]
hooks = true # CLI-Manager hook protection

[windows]
wsl = true
"#;
        let merged = merge_common_config_codex_statusline(
            Some(raw),
            &["model-with-reasoning".to_string(), "context-remaining".to_string()],
        );
        assert!(merged.contains("[tui]\nstatus_line = [\"model-with-reasoning\", \"context-remaining\"]"));
        assert!(merged.contains("[features]\nhooks = true # CLI-Manager hook protection"));
        assert!(merged.contains("[windows]\nwsl = true"));
        assert!(merged.find("[tui]").unwrap() < merged.find("[features]").unwrap());
    }

    #[test]
    fn merge_codex_statusline_replaces_existing_tui_status_line() {
        let raw = r#"[features]
hooks = true

[tui]
notifications = ["approval-requested"]
status_line = ["model"]
theme = "monokai"
"#;
        let merged = merge_common_config_codex_statusline(
            Some(raw),
            &["current-dir".to_string(), "status".to_string()],
        );
        assert!(merged.contains("notifications = [\"approval-requested\"]"));
        assert!(merged.contains("status_line = [\"current-dir\", \"status\"]"));
        assert!(merged.contains("theme = \"monokai\""));
        assert_eq!(merged.matches("status_line =").count(), 1);
    }

    #[test]
    fn claude_common_config_has_hooks_requires_notification_hook() {
        let exe = "/tmp/cli-manager";
        let merged = merge_claude_common_config_hooks(None, exe).unwrap();
        let mut value: Value = serde_json::from_str(&merged).unwrap();
        value
            .get_mut("hooks")
            .and_then(Value::as_object_mut)
            .unwrap()
            .remove("Notification");
        let without_notification = serde_json::to_string(&value).unwrap();

        assert!(!claude_common_config_has_hooks(Some(&without_notification), exe).unwrap());
    }

    #[test]
    fn merge_codex_common_config_hooks_writes_toml_feature_flag() {
        let exe = "/tmp/cli-manager";
        let existing = r#"model = "gpt-5"

        [features]
        experimental = true
        "#;

        let merged = merge_codex_common_config_hooks(Some(existing), exe).unwrap();

        assert!(merged.contains("model = \"gpt-5\""));
        assert!(merged.contains("experimental = true"));
        assert!(merged.contains("[features]"));
        assert!(merged.contains("hooks = true"));
        assert!(merged.contains(CODEX_COMMON_CONFIG_HOOKS_MARKER));
        assert!(codex_common_config_has_hooks(Some(&merged), exe).unwrap());
    }

    #[test]
    fn strip_codex_common_config_hooks_removes_only_marker_owned_toml_line() {
        let exe = "/tmp/cli-manager";
        let merged = merge_codex_common_config_hooks(None, exe).unwrap();

        let stripped = strip_codex_common_config_hooks(Some(&merged)).unwrap();

        assert!(stripped.is_none());

        let user_owned = "[features]\nhooks = true\n";
        let stripped_user_owned = strip_codex_common_config_hooks(Some(user_owned))
            .unwrap()
            .unwrap();
        assert_eq!(stripped_user_owned, user_owned);
        assert!(codex_common_config_has_hooks(Some(&stripped_user_owned), exe).unwrap());
    }

    #[tokio::test]
    async fn merge_codex_common_config_carries_cli_manager_hook_state() {
        let tmp = TempDir::new().unwrap();
        let codex_dir = tmp.path().join("codex");
        fs::create_dir_all(&codex_dir).unwrap();
        install_codex_hooks(&codex_dir).unwrap();

        let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
        let hooks_key = format!(
            "{}:permission_request:0:0",
            toml_escape_basic_string(&path_to_string(&hooks_path))
        );
        let project_hooks_key = format!(
            "{}:permission_request:0:0",
            toml_escape_basic_string(r"F:\github\CLI-Manager\.codex\hooks.json")
        );
        let config = format!(
            r#"[hooks.state."{hooks_key}"]
trusted_hash = "sha256:new"

[hooks.state."{project_hooks_key}"]
trusted_hash = "sha256:project"
"#
        );
        fs::write(codex_dir.join(CODEX_CONFIG_FILE_NAME), config).unwrap();
        let hook_state_blocks = read_codex_cli_manager_hook_state_blocks(&codex_dir).unwrap();
        assert_eq!(hook_state_blocks.len(), 1);

        let existing = format!(
            r#"model_reasoning_effort = "xhigh"

[features]
hooks = true # CLI-Manager hook protection

{CODEX_COMMON_CONFIG_HOOKS_MARKER}
[hooks.state."{hooks_key}"]
trusted_hash = "sha256:old"

[projects.'\\?\F:\idea-work\business-center']
trust_level = "trusted"
"#
        );
        let merged = merge_common_config_hooks(
            Some(&existing),
            "/tmp/cli-manager",
            CommonConfigTool::Codex,
            &hook_state_blocks,
        )
        .unwrap();

        assert!(merged.contains(&format!(r#"[hooks.state."{hooks_key}"]"#)));
        assert!(merged.contains(r#"trusted_hash = "sha256:new""#));
        assert!(!merged.contains("sha256:old"));
        assert!(!merged.contains("sha256:project"));
        assert!(merged.find("[features]").unwrap() < merged.find("[hooks.state.").unwrap());
        assert!(
            merged.find("[hooks.state.").unwrap()
                < merged
                    .find(r#"[projects.'\\?\F:\idea-work\business-center']"#)
                    .unwrap()
        );
    }

    #[test]
    fn strip_codex_common_config_hooks_removes_marker_owned_hook_state_blocks() {
        let raw = format!(
            r#"[features]
hooks = true # CLI-Manager hook protection

{CODEX_COMMON_CONFIG_HOOKS_MARKER}
[hooks.state."C:\\Users\\1\\.codex\\hooks.json:permission_request:0:0"]
trusted_hash = "sha256:owned"
"#
        );

        let stripped = strip_codex_common_config_hooks(Some(&raw)).unwrap();

        assert!(stripped.is_none());
    }

    #[tokio::test]
    async fn sync_codex_common_config_writes_codex_key_without_touching_claude_key() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("cc-switch.db");
        fs::File::create(&db_path).unwrap();
        let exe = "/tmp/cli-manager";
        let existing_claude = r#"{"env":{"KEEP":"1"}}"#;

        let mut conn = open_db_readwrite(&db_path).await.unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES (?1, ?2)")
            .bind(CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)
            .bind(existing_claude)
            .execute(&mut conn)
            .await
            .unwrap();
        drop(conn);

        let state = sync_common_config_at_path(
            &db_path,
            exe,
            CommonConfigTool::Codex,
            CcSwitchSyncMode::Install,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(state, CcSwitchHookProtectionState::Synced);

        let mut conn = open_db_readwrite(&db_path).await.unwrap();
        let codex_common_config =
            read_common_config_value(&mut conn, CCSWITCH_COMMON_CONFIG_CODEX_KEY)
                .await
                .unwrap()
                .unwrap();
        let claude_common_config =
            read_common_config_value(&mut conn, CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)
                .await
                .unwrap()
                .unwrap();

        assert!(codex_common_config_has_hooks(Some(&codex_common_config), exe).unwrap());
        assert!(codex_common_config.contains("[features]"));
        assert!(codex_common_config.contains("hooks = true"));
        assert!(codex_common_config.contains(CODEX_COMMON_CONFIG_HOOKS_MARKER));
        assert_eq!(claude_common_config, existing_claude);
    }

    #[tokio::test]
    async fn sync_codex_common_config_preserves_real_ccswitch_toml_shape() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("cc-switch.db");
        fs::File::create(&db_path).unwrap();
        let exe = "/tmp/cli-manager";
        let existing_codex = r#"model_reasoning_effort = "xhigh"
disable_response_storage = true
personality = "pragmatic"

approval_policy = "never"
sandbox_mode = "danger-full-access"
alternate_screen = "never"

[projects.'\\?\F:\idea-work\business-center']
trust_level = "trusted"

[windows]
sandbox = "unelevated"

[tui]
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]

model_instructions_file = "./instruction.md"
"#;

        let mut conn = open_db_readwrite(&db_path).await.unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES (?1, ?2)")
            .bind(CCSWITCH_COMMON_CONFIG_CODEX_KEY)
            .bind(existing_codex)
            .execute(&mut conn)
            .await
            .unwrap();
        drop(conn);

        let state = sync_common_config_at_path(
            &db_path,
            exe,
            CommonConfigTool::Codex,
            CcSwitchSyncMode::Install,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(state, CcSwitchHookProtectionState::Synced);

        let mut conn = open_db_readwrite(&db_path).await.unwrap();
        let codex_common_config =
            read_common_config_value(&mut conn, CCSWITCH_COMMON_CONFIG_CODEX_KEY)
                .await
                .unwrap()
                .unwrap();

        let features_index = codex_common_config.find("[features]").unwrap();
        let projects_index = codex_common_config
            .find(r#"[projects.'\\?\F:\idea-work\business-center']"#)
            .unwrap();
        assert!(features_index < projects_index);
        assert!(codex_common_config.contains(r#"[projects.'\\?\F:\idea-work\business-center']"#));
        assert!(codex_common_config.contains("[windows]"));
        assert!(codex_common_config.contains("[tui]"));
        assert!(codex_common_config.contains(
            "status_line = [\"model-with-reasoning\", \"context-remaining\", \"current-dir\"]"
        ));
        assert!(codex_common_config.contains("[features]"));
        assert!(codex_common_config.contains("hooks = true"));
        assert!(codex_common_config.contains(CODEX_COMMON_CONFIG_HOOKS_MARKER));
        assert!(codex_common_config_has_hooks(Some(&codex_common_config), exe).unwrap());
    }

    #[tokio::test]
    async fn sync_codex_common_config_treats_null_setting_value_as_missing() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("cc-switch.db");
        fs::File::create(&db_path).unwrap();
        let exe = "/tmp/cli-manager";

        let mut conn = open_db_readwrite(&db_path).await.unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES (?1, NULL)")
            .bind(CCSWITCH_COMMON_CONFIG_CODEX_KEY)
            .execute(&mut conn)
            .await
            .unwrap();
        drop(conn);

        let state = sync_common_config_at_path(
            &db_path,
            exe,
            CommonConfigTool::Codex,
            CcSwitchSyncMode::Install,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(state, CcSwitchHookProtectionState::Synced);

        let mut conn = open_db_readwrite(&db_path).await.unwrap();
        let codex_common_config =
            read_common_config_value(&mut conn, CCSWITCH_COMMON_CONFIG_CODEX_KEY)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            codex_common_config,
            format!("[features]\nhooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}\n")
        );
    }

    #[test]
    fn claude_common_config_rejects_invalid_json() {
        assert_eq!(
            merge_claude_common_config_hooks(Some("{bad json"), "/tmp/cli-manager").unwrap_err(),
            "common_config_parse_failed"
        );
        assert_eq!(
            strip_claude_common_config_hooks(Some("{bad json")).unwrap_err(),
            "common_config_parse_failed"
        );
    }

    #[test]
    fn build_command_wraps_windows_native_path_for_powershell() {
        let command = build_command(
            r"D:\Program Files\CLI-Manager\cli-manager.exe",
            "codex",
            "SessionStart",
        );

        assert_eq!(
            command,
            r#"powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'D:\Program Files\CLI-Manager\cli-manager.exe' __hook --source codex --event SessionStart""#
        );
    }

    #[test]
    fn build_command_escapes_powershell_single_quote_in_windows_path() {
        let command = build_command(
            r"D:\Program Files\CLI-Manager's\cli-manager.exe",
            "claude",
            "Stop",
        );

        assert_eq!(
            command,
            r#"powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'D:\Program Files\CLI-Manager''s\cli-manager.exe' __hook --source claude --event Stop""#
        );
    }

    #[test]
    fn build_command_keeps_wsl_mnt_path_shell_format() {
        let command = build_command(
            "/mnt/d/Program Files/CLI-Manager/cli-manager.exe",
            "codex",
            "SessionStart",
        );

        assert_eq!(
            command,
            "'/mnt/d/Program Files/CLI-Manager/cli-manager.exe' __hook --source codex --event SessionStart"
        );
    }

    #[test]
    fn build_command_escapes_posix_single_quote() {
        let command = build_command("/Users/me/CLI-Manager's/cli-manager", "claude", "Stop");

        assert_eq!(
            command,
            "'/Users/me/CLI-Manager'\\''s/cli-manager' __hook --source claude --event Stop"
        );
    }
    #[tokio::test]
    async fn install_then_uninstall_pi_extension() {
        let tmp = TempDir::new().unwrap();
        let pi_dir = tmp.path().join("pi-agent");
        fs::create_dir_all(&pi_dir).unwrap();

        install_pi_hooks(&pi_dir).unwrap();
        let status = build_pi_status(Some(pi_dir.clone())).unwrap();
        assert!(matches!(status.status, HookInstallStatus::Installed));
        assert!(status.session_start_hook_installed);
        assert!(status.running_hook_installed);
        assert!(status.stop_hook_installed);
        let extension = fs::read_to_string(pi_extension_path(&pi_dir)).unwrap();
        assert!(extension.contains(PI_EXTENSION_MARKER));
        assert!(extension.contains(r#"source: "pi""#));
        assert!(extension.contains("session_start"));
        assert!(extension.contains("agent_start"));
        assert!(extension.contains("agent_settled"));
        assert!(!extension.contains("before_agent_start"));

        uninstall_pi_hooks(&pi_dir).unwrap();
        let after = build_pi_status(Some(pi_dir.clone())).unwrap();
        assert!(matches!(after.status, HookInstallStatus::NotInstalled));
        assert!(!pi_extension_path(&pi_dir).is_file());
    }

    #[tokio::test]
    async fn install_pi_single_module_only_enables_requested_event() {
        let tmp = TempDir::new().unwrap();
        let pi_dir = tmp.path().join("pi-agent");
        fs::create_dir_all(&pi_dir).unwrap();

        install_pi_hook_module(&pi_dir, PiHookModule::SessionStart).unwrap();
        let status = build_pi_status(Some(pi_dir.clone())).unwrap();
        assert!(matches!(status.status, HookInstallStatus::PartialInstalled));
        assert!(status.session_start_hook_installed);
        assert!(!status.running_hook_installed);
        assert!(!status.stop_hook_installed);
    }

    #[test]
    fn install_pi_preserves_unmanaged_extension() {
        let tmp = TempDir::new().unwrap();
        let pi_dir = tmp.path().join("pi-agent");
        let extensions_dir = pi_dir.join(PI_EXTENSION_DIR_NAME);
        fs::create_dir_all(&extensions_dir).unwrap();
        let extension_path = pi_extension_path(&pi_dir);
        let user_content = "export default function userExtension() {}\n";
        fs::write(&extension_path, user_content).unwrap();

        let error = install_pi_hooks(&pi_dir).unwrap_err();

        assert_eq!(error, PI_EXTENSION_CONFLICT_ERROR);
        assert_eq!(fs::read_to_string(extension_path).unwrap(), user_content);
    }


    #[cfg(windows)]
    #[test]
    fn hook_exe_for_dir_uses_mnt_form_for_wsl_target() {
        let native = cli_manager_exe().unwrap();
        // WSL/UNC 目标：exe 转 /mnt 形式
        let wsl_exe =
            hook_exe_for_dir(Path::new(r"\\wsl.localhost\Ubuntu-22.04\home\me\.claude")).unwrap();
        assert!(wsl_exe.starts_with("/mnt/"), "got {wsl_exe}");
        // 普通 Windows 目标：保持原生路径
        assert_eq!(
            hook_exe_for_dir(Path::new(r"C:\Users\me\.claude")).unwrap(),
            native
        );
    }
}
