mod codex;
use codex::{
    codex_cli_manager_hook_state_keys, codex_cli_manager_hooks_trusted,
    codex_hook_state_event_name, codex_hook_trusted_hash, codex_hooks_feature_installed,
    deduplicate_codex_hook_state_blocks, install_codex_hook_module, install_codex_hooks,
    merge_codex_common_config_toml, remove_marker_owned_codex_hook_state_blocks,
    toml_escape_basic_string, trim_empty_lines, uninstall_codex_hook_module, uninstall_codex_hooks,
};
mod grok;
use grok::{
    build_grok_status, disable_grok_cross_vendor_hooks, install_grok_hook_module,
    install_grok_hooks, resolve_grok_dir, uninstall_grok_hook_module, uninstall_grok_hooks,
};
mod pi;
use pi::{
    build_pi_status, install_pi_hook_module, install_pi_hooks, resolve_pi_dir,
    uninstall_pi_hook_module, uninstall_pi_hooks,
};
mod kimi_adapter;
use kimi_adapter::{build_kimi_status, install_kimi_hooks, resolve_kimi_dir, uninstall_kimi_hooks};
mod json_hooks;
use json_hooks::{
    add_hook_command, add_hook_command_with_matcher, ensure_child_object, ensure_object,
    exact_command_registered, is_cli_manager_command, registered_exact_command,
    registered_exact_command_with_matcher, remove_hook_commands, remove_named_hook_command,
};

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cli_manager_hook_schema::kimi::{KimiHookModule, ALL_MODULES as ALL_KIMI_HOOK_MODULES};
use serde::Serialize;
use serde_json::{json, Value};
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
const KIMI_CONFIG_FILE_NAME: &str = "config.toml";

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
const CODEX_HOOK_EVENTS: [&str; 8] = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PreToolUse",
    "PostToolUse",
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
const CLAUDE_QUESTION_TOOL_NAME: &str = "AskUserQuestion";
const CODEX_QUESTION_TOOL_NAME: &str = "request_user_input";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSettingsStatus {
    claude: ToolHookSettingsStatus,
    codex: ToolHookSettingsStatus,
    kimi: ToolHookSettingsStatus,
    pi: ToolHookSettingsStatus,
    grok: ToolHookSettingsStatus,
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

#[derive(Clone, Copy)]
enum CommonConfigTool {
    Claude,
    Codex,
}

#[derive(Clone, Copy)]
enum CommonConfigSyncMode {
    Install,
    Uninstall,
}

#[tauri::command]
pub async fn hook_settings_get_status(
    _app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    auto_repair: Option<bool>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let mut claude_auto_repaired = false;

    if auto_repair.unwrap_or(false) {
        if let Some(dir) = claude_dir.as_ref() {
            let current = build_claude_status(Some(dir.clone()))?;
            if !matches!(current.status, HookInstallStatus::Installed) {
                install_claude_hooks(dir)?;
                sync_ccswitch_tool_common_config(
                    cc_switch_db_path.clone(),
                    dir,
                    CommonConfigTool::Claude,
                    CommonConfigSyncMode::Install,
                )
                .await;
                claude_auto_repaired = true;
            }
        }
    }

    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status_with_trust_repair(codex_dir.clone())?;
    let kimi = build_kimi_status(kimi_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;

    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
        claude_auto_repaired,
    })
}

#[tauri::command]
pub async fn hook_settings_install(
    _app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, true)?
        .ok_or_else(|| "请先选择 Claude 配置目录".to_string())?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_claude_hook_module(module)?;
    if let Some(module) = requested_module {
        install_claude_hook_module(&claude_dir, module)?;
    } else {
        install_claude_hooks(&claude_dir)?;
    }
    let claude = build_claude_status(Some(claude_dir.clone()))?;
    sync_ccswitch_for_tool_status(
        cc_switch_db_path,
        &claude_dir,
        CommonConfigTool::Claude,
        &claude,
        true,
    )
    .await;
    let codex = build_codex_status(codex_dir.clone())?;
    let kimi = build_kimi_status(kimi_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall(
    _app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let claude_dir = resolve_claude_dir(selected_dir, true)?
        .ok_or_else(|| "请先选择 Claude 配置目录".to_string())?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_claude_hook_module(module)?;
    if let Some(module) = requested_module {
        uninstall_claude_hook_module(&claude_dir, module)?;
    } else {
        uninstall_claude_hooks(&claude_dir)?;
    }
    let claude = build_claude_status(Some(claude_dir.clone()))?;
    sync_ccswitch_for_tool_status(
        cc_switch_db_path,
        &claude_dir,
        CommonConfigTool::Claude,
        &claude,
        requested_module.is_some(),
    )
    .await;
    let codex = build_codex_status(codex_dir.clone())?;
    let kimi = build_kimi_status(kimi_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_install_codex(
    _app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?
        .ok_or_else(|| "请先选择 Codex 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_codex_hook_module(module)?;
    if let Some(module) = requested_module {
        install_codex_hook_module(&codex_dir, module)?;
    } else {
        install_codex_hooks(&codex_dir)?;
    }
    let codex = build_codex_status(Some(codex_dir.clone()))?;
    sync_ccswitch_for_tool_status(
        cc_switch_db_path,
        &codex_dir,
        CommonConfigTool::Codex,
        &codex,
        true,
    )
    .await;
    let claude = build_claude_status(claude_dir.clone())?;
    let kimi = build_kimi_status(kimi_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall_codex(
    _app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?
        .ok_or_else(|| "未找到 Codex 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
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
    let kimi = build_kimi_status(kimi_dir.clone())?;
    sync_ccswitch_for_tool_status(
        cc_switch_db_path,
        &codex_dir,
        CommonConfigTool::Codex,
        &codex,
        requested_module.is_some(),
    )
    .await;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(grok_dir.clone())?;
    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_install_kimi(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    _cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?
        .ok_or_else(|| "kimi_config_dir_required".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let modules = selected_kimi_modules(module)?;
    install_kimi_hooks(&kimi_dir, &modules)?;
    Ok(HookSettingsStatus {
        claude: build_claude_status(claude_dir)?,
        codex: build_codex_status(codex_dir)?,
        kimi: build_kimi_status(Some(kimi_dir))?,
        pi: build_pi_status(pi_dir)?,
        grok: build_grok_status(grok_dir)?,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall_kimi(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    _cc_switch_db_path: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?
        .ok_or_else(|| "kimi_config_dir_missing".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let pi_dir = resolve_pi_dir(pi_selected_dir, false)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let modules = selected_kimi_modules(module)?;
    uninstall_kimi_hooks(&kimi_dir, &modules)?;
    Ok(HookSettingsStatus {
        claude: build_claude_status(claude_dir)?,
        codex: build_codex_status(codex_dir)?,
        kimi: build_kimi_status(Some(kimi_dir))?,
        pi: build_pi_status(pi_dir)?,
        grok: build_grok_status(grok_dir)?,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_install_pi(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let pi_dir =
        resolve_pi_dir(pi_selected_dir, true)?.ok_or_else(|| "请先选择 Pi 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_pi_hook_module(module)?;
    if let Some(module) = requested_module {
        install_pi_hook_module(&pi_dir, module)?;
    } else {
        install_pi_hooks(&pi_dir)?;
    }
    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status(codex_dir.clone())?;
    let kimi = build_kimi_status(kimi_dir.clone())?;
    let pi = build_pi_status(Some(pi_dir.clone()))?;
    let grok = build_grok_status(grok_dir.clone())?;
    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall_pi(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let pi_dir =
        resolve_pi_dir(pi_selected_dir, false)?.ok_or_else(|| "未找到 Pi 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?;
    let requested_module = parse_pi_hook_module(module)?;
    if let Some(module) = requested_module {
        uninstall_pi_hook_module(&pi_dir, module)?;
    } else {
        uninstall_pi_hooks(&pi_dir)?;
    }
    let claude = build_claude_status(claude_dir.clone())?;
    let codex = build_codex_status(codex_dir.clone())?;
    let kimi = build_kimi_status(kimi_dir.clone())?;
    let pi = build_pi_status(Some(pi_dir.clone()))?;
    let grok = build_grok_status(grok_dir.clone())?;
    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_install_grok(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let grok_dir = resolve_grok_dir(grok_selected_dir, true)?
        .ok_or_else(|| "请先选择 Grok 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
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
    let kimi = build_kimi_status(kimi_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(Some(grok_dir.clone()))?;
    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
        claude_auto_repaired: false,
    })
}

#[tauri::command]
pub async fn hook_settings_uninstall_grok(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    kimi_selected_dir: Option<String>,
    pi_selected_dir: Option<String>,
    grok_selected_dir: Option<String>,
    module: Option<String>,
) -> Result<HookSettingsStatus, String> {
    let grok_dir = resolve_grok_dir(grok_selected_dir, false)?
        .ok_or_else(|| "未找到 Grok 配置目录".to_string())?;
    let claude_dir = resolve_claude_dir(selected_dir, false)?;
    let codex_dir = resolve_codex_dir(codex_selected_dir, false)?;
    let kimi_dir = resolve_kimi_dir(kimi_selected_dir)?;
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
    let kimi = build_kimi_status(kimi_dir.clone())?;
    let pi = build_pi_status(pi_dir.clone())?;
    let grok = build_grok_status(Some(grok_dir.clone()))?;
    Ok(HookSettingsStatus {
        claude,
        codex,
        kimi,
        pi,
        grok,
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

fn explicit_ccswitch_db_path(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn cc_switch_db_exists(path: &Path) -> bool {
    if crate::wsl::parse_wsl_unc_path(&path_to_string(path)).is_some() {
        crate::ccswitch_db::wsl_file_exists(path).unwrap_or(false)
    } else {
        path.is_file()
    }
}

fn resolve_ccswitch_db_path(db_path: Option<String>, config_dir: &Path) -> Result<PathBuf, String> {
    let explicit = explicit_ccswitch_db_path(db_path);
    if let Some(path) = explicit {
        let path = PathBuf::from(&path);
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("db"))
        {
            return Err("unsupported_format".to_string());
        }
        if !cc_switch_db_exists(&path) {
            return Err("db_not_found".to_string());
        }
        return Ok(path);
    }

    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path_to_string(config_dir))
    {
        if let Some(home_path) = linux_path
            .strip_suffix("/.claude")
            .or_else(|| linux_path.strip_suffix("/.codex"))
        {
            let candidate = PathBuf::from(crate::wsl::linux_to_unc_wsl_path(
                &format!("{home_path}/.cc-switch/cc-switch.db"),
                &distro,
            ));
            if cc_switch_db_exists(&candidate) {
                return Ok(candidate);
            }
        }
    }

    let home = crate::app_paths::home_dir_from_env()?;
    let default_path = home.join(".cc-switch").join("cc-switch.db");
    if cc_switch_db_exists(&default_path) {
        Ok(default_path)
    } else {
        Err("db_not_found".to_string())
    }
}

async fn open_ccswitch_connection(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("db_open_failed: {error}"))
}

async fn settings_table_exists(connection: &mut SqliteConnection) -> Result<bool, String> {
    sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
        .fetch_optional(&mut *connection)
        .await
        .map(|row| row.is_some())
        .map_err(|error| format!("db_query_failed: {error}"))
}

async fn read_common_config_value(
    connection: &mut SqliteConnection,
    key: &str,
) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("db_query_failed: {error}"))?;
    row.map(|row| {
        row.try_get::<Option<String>, _>("value")
            .map_err(|error| format!("db_query_failed: {error}"))
    })
    .transpose()
    .map(|value| value.flatten())
}

fn common_config_key(tool: CommonConfigTool) -> &'static str {
    match tool {
        CommonConfigTool::Claude => CCSWITCH_COMMON_CONFIG_CLAUDE_KEY,
        CommonConfigTool::Codex => CCSWITCH_COMMON_CONFIG_CODEX_KEY,
    }
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

async fn sync_ccswitch_for_tool_status(
    db_path: Option<String>,
    config_dir: &Path,
    tool: CommonConfigTool,
    status: &ToolHookSettingsStatus,
    preserve_remaining: bool,
) {
    let mode = if preserve_remaining || tool_status_is_fully_installed(status, tool) {
        CommonConfigSyncMode::Install
    } else {
        CommonConfigSyncMode::Uninstall
    };
    sync_ccswitch_tool_common_config(db_path, config_dir, tool, mode).await;
}

async fn sync_ccswitch_tool_common_config(
    db_path: Option<String>,
    config_dir: &Path,
    tool: CommonConfigTool,
    mode: CommonConfigSyncMode,
) {
    let Ok(path) = resolve_ccswitch_db_path(db_path, config_dir) else {
        return;
    };
    let result = if crate::wsl::parse_wsl_unc_path(&path_to_string(&path)).is_some() {
        sync_ccswitch_wsl_common_config(&path, config_dir, tool, mode).await
    } else {
        sync_ccswitch_local_common_config(&path, config_dir, tool, mode).await
    };
    let _ = result;
}

async fn sync_ccswitch_local_common_config(
    path: &Path,
    config_dir: &Path,
    tool: CommonConfigTool,
    mode: CommonConfigSyncMode,
) -> Result<(), String> {
    let mut connection = open_ccswitch_connection(path).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("db_write_failed: {error}"))?;

    let result = async {
        if !settings_table_exists(&mut connection).await? {
            return Ok(());
        }
        let key = common_config_key(tool);
        let existing = read_common_config_value(&mut connection, key).await?;
        let next = match mode {
            CommonConfigSyncMode::Install => {
                let local = read_json(&config_dir.join(match tool {
                    CommonConfigTool::Claude => CLAUDE_SETTINGS_FILE_NAME,
                    CommonConfigTool::Codex => CODEX_HOOKS_FILE_NAME,
                }))?;
                merge_ccswitch_common_config(existing.as_deref(), &local, config_dir, tool)?
            }
            CommonConfigSyncMode::Uninstall => {
                strip_ccswitch_common_config(existing.as_deref(), tool)?
            }
        };
        match next {
            Some(value) => {
                sqlx::query(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)\
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(key)
                .bind(value)
                .execute(&mut connection)
                .await
                .map_err(|error| format!("db_write_failed: {error}"))?;
            }
            None => {
                sqlx::query("DELETE FROM settings WHERE key = ?1")
                    .bind(key)
                    .execute(&mut connection)
                    .await
                    .map_err(|error| format!("db_write_failed: {error}"))?;
            }
        }
        Ok::<(), String>(())
    }
    .await;

    match result {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("db_write_failed: {error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
            Err(error)
        }
    }
}

async fn sync_ccswitch_wsl_common_config(
    path: &Path,
    config_dir: &Path,
    tool: CommonConfigTool,
    mode: CommonConfigSyncMode,
) -> Result<(), String> {
    let prepared = crate::ccswitch_db::prepare_read_path(path).await?;
    let mut connection = open_ccswitch_connection(prepared.path()).await?;
    if !settings_table_exists(&mut connection).await? {
        return Ok(());
    }
    let key = common_config_key(tool);
    let existing = read_common_config_value(&mut connection, key).await?;
    drop(connection);
    let next = match mode {
        CommonConfigSyncMode::Install => {
            let local = read_json(&config_dir.join(match tool {
                CommonConfigTool::Claude => CLAUDE_SETTINGS_FILE_NAME,
                CommonConfigTool::Codex => CODEX_HOOKS_FILE_NAME,
            }))?;
            merge_ccswitch_common_config(existing.as_deref(), &local, config_dir, tool)?
        }
        CommonConfigSyncMode::Uninstall => strip_ccswitch_common_config(existing.as_deref(), tool)?,
    };
    let value = next.unwrap_or_default();
    let upsert = matches!(mode, CommonConfigSyncMode::Install) || existing.is_some();
    crate::ccswitch_db::write_wsl_setting(path, key, existing.as_deref(), &value, upsert).await?;
    Ok(())
}

fn merge_ccswitch_common_config(
    existing: Option<&str>,
    local: &Value,
    config_dir: &Path,
    tool: CommonConfigTool,
) -> Result<Option<String>, String> {
    match tool {
        CommonConfigTool::Claude => {
            let mut common = match existing.filter(|value| !value.trim().is_empty()) {
                Some(raw) => serde_json::from_str::<Value>(raw)
                    .map_err(|_| "common_config_parse_failed".to_string())?,
                None => json!({}),
            };
            ensure_root_object(&common, CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)?;
            remove_hook_commands(&mut common, &CLAUDE_HOOK_EVENTS, &CLAUDE_LEGACY_SCRIPTS);
            let common_hooks = ensure_child_object(ensure_object(&mut common), "hooks");
            if let Some(local_hooks) = local.get("hooks").and_then(Value::as_object) {
                for event in CLAUDE_HOOK_EVENTS {
                    let Some(entries) = local_hooks.get(event).and_then(Value::as_array) else {
                        continue;
                    };
                    for entry in entries {
                        let Some(commands) = entry.get("hooks").and_then(Value::as_array) else {
                            continue;
                        };
                        let owned = commands
                            .iter()
                            .filter(|hook| is_cli_manager_command(hook, &CLAUDE_LEGACY_SCRIPTS))
                            .cloned()
                            .collect::<Vec<_>>();
                        if owned.is_empty() {
                            continue;
                        }
                        let mut next_entry = entry.clone();
                        next_entry["hooks"] = Value::Array(owned);
                        common_hooks
                            .entry(event.to_string())
                            .or_insert_with(|| Value::Array(Vec::new()))
                            .as_array_mut()
                            .expect("hook event array")
                            .push(next_entry);
                    }
                }
            }
            let mut text = serde_json::to_string_pretty(&common)
                .map_err(|error| format!("common_config_serialize_failed: {error}"))?;
            text.push('\n');
            Ok(Some(text))
        }
        CommonConfigTool::Codex => {
            let existing = existing.filter(|value| !value.trim().is_empty());
            let blocks = read_codex_cli_manager_hook_state_blocks(config_dir)?;
            Ok(Some(merge_codex_common_config_toml(existing, &blocks)))
        }
    }
}

fn strip_ccswitch_common_config(
    existing: Option<&str>,
    tool: CommonConfigTool,
) -> Result<Option<String>, String> {
    let Some(raw) = existing.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    match tool {
        CommonConfigTool::Claude => {
            let mut common = serde_json::from_str::<Value>(raw)
                .map_err(|_| "common_config_parse_failed".to_string())?;
            ensure_root_object(&common, CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)?;
            remove_hook_commands(&mut common, &CLAUDE_HOOK_EVENTS, &CLAUDE_LEGACY_SCRIPTS);
            if common == json!({}) {
                return Ok(None);
            }
            let mut text = serde_json::to_string_pretty(&common)
                .map_err(|error| format!("common_config_serialize_failed: {error}"))?;
            text.push('\n');
            Ok(Some(text))
        }
        CommonConfigTool::Codex => Ok(strip_codex_common_config_toml(raw)),
    }
}

fn strip_codex_common_config_toml(raw: &str) -> Option<String> {
    let mut lines = raw.lines().map(ToString::to_string).collect::<Vec<_>>();
    remove_marker_owned_codex_hook_state_blocks(&mut lines);
    lines.retain(|line| {
        let trimmed = line.trim();
        !(trimmed.starts_with("hooks = true") && trimmed.contains(CODEX_COMMON_CONFIG_HOOKS_MARKER))
    });
    trim_empty_lines(&mut lines);
    if lines == ["[features]".to_string()] {
        return None;
    }
    (!lines.is_empty()).then(|| format!("{}\n", lines.join("\n")))
}

fn read_codex_cli_manager_hook_state_blocks(codex_dir: &Path) -> Result<Vec<Vec<String>>, String> {
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let settings = read_json_if_exists(&hooks_path)?;
    let mut blocks = Vec::new();
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return Ok(blocks);
    };
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
                let key = toml_escape_basic_string(&format!(
                    "{}:{event_name}:{entry_index}:{hook_index}",
                    path_to_string(&hooks_path)
                ));
                let hash = codex_hook_trusted_hash(event, entry, hook)?;
                blocks.push(vec![
                    format!("[hooks.state.\"{key}\"]"),
                    format!("trusted_hash = \"{hash}\""),
                ]);
            }
        }
    }
    Ok(blocks)
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

fn parse_kimi_hook_module(value: &str) -> Result<KimiHookModule, String> {
    match value {
        "sessionStart" => Ok(KimiHookModule::SessionStart),
        "running" => Ok(KimiHookModule::Running),
        "attention" => Ok(KimiHookModule::Attention),
        "stop" => Ok(KimiHookModule::Stop),
        "failure" => Ok(KimiHookModule::Failure),
        "subagent" => Ok(KimiHookModule::Subagent),
        "hooksFeature" => Err("Kimi Code 不支持 hooksFeature 模块".to_string()),
        other => Err(format!("未知的 Kimi Code Hook 模块: {other}")),
    }
}

fn selected_kimi_modules(module: Option<String>) -> Result<Vec<KimiHookModule>, String> {
    module
        .map(|value| parse_kimi_hook_module(&value).map(|module| vec![module]))
        .unwrap_or_else(|| Ok(ALL_KIMI_HOOK_MODULES.to_vec()))
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
        ClaudeHookModule::Attention => {
            add_hook_command_with_matcher(
                settings,
                "Notification",
                "permission_prompt|idle_prompt",
                build_command(exe, "claude", "Notification"),
            );
            remove_named_hook_command(settings, "PreToolUse", "claude", "Notification");
            add_hook_command_with_matcher(
                settings,
                "PreToolUse",
                CLAUDE_QUESTION_TOOL_NAME,
                build_command(exe, "claude", "Notification"),
            );
        }
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
            remove_hook_commands(settings, &["Notification"], &CLAUDE_LEGACY_SCRIPTS);
            remove_named_hook_command(settings, "PreToolUse", "claude", "Notification");
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
        CodexHookModule::Attention => {
            add_hook_command(
                settings,
                "PermissionRequest",
                build_command(exe, "codex", "PermissionRequest"),
            );
            remove_named_hook_command(settings, "PreToolUse", "codex", "Notification");
            add_hook_command_with_matcher(
                settings,
                "PreToolUse",
                CODEX_QUESTION_TOOL_NAME,
                build_command(exe, "codex", "Notification"),
            );
        }
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
            add_hook_command(
                settings,
                "PreToolUse",
                build_command(exe, "codex", "ToolStart"),
            );
            add_hook_command(
                settings,
                "PostToolUse",
                build_command(exe, "codex", "ToolStop"),
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
            remove_hook_commands(settings, &["PermissionRequest"], &CODEX_LEGACY_SCRIPTS);
            remove_named_hook_command(settings, "PreToolUse", "codex", "Notification");
        }
        CodexHookModule::Stop => remove_hook_commands(settings, &["Stop"], &CODEX_LEGACY_SCRIPTS),
        CodexHookModule::Subagent => {
            remove_hook_commands(
                settings,
                &["SubagentStart", "SubagentStop"],
                &CODEX_LEGACY_SCRIPTS,
            );
            remove_named_hook_command(settings, "PreToolUse", "codex", "ToolStart");
            remove_named_hook_command(settings, "PostToolUse", "codex", "ToolStop");
        }
        CodexHookModule::HooksFeature => {}
    }
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

fn resolve_claude_dir(
    selected_dir: Option<String>,
    require_existing: bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(dir) = selected_dir.and_then(|value| normalize_selected_dir(&value)) {
        if !live_is_dir(&dir) {
            return if require_existing {
                Err("选择的 Claude 配置目录不存在".to_string())
            } else {
                Ok(None)
            };
        }
        return Ok(Some(dir));
    }

    let default_dir = crate::provider::home::default_config_root("claude")
        .or_else(|| home_dir().map(|home| home.join(".claude")));
    let Some(default_dir) = default_dir else {
        return Ok(None);
    };
    if live_is_dir(&default_dir) {
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
        if live_is_dir(&dir) {
            return Ok(Some(dir));
        }
        if create_if_missing {
            create_live_dir_all(&dir, "创建 Codex 配置目录失败")?;
            return Ok(Some(dir));
        }
        return Ok(None);
    }

    let default_dir = crate::provider::home::default_config_root("codex")
        .or_else(|| home_dir().map(|home| home.join(".codex")));
    let Some(default_dir) = default_dir else {
        return Ok(None);
    };
    if live_is_dir(&default_dir) {
        Ok(Some(default_dir))
    } else if create_if_missing {
        create_live_dir_all(&default_dir, "创建 Codex 配置目录失败")?;
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
        attention_hook_installed: registered("Notification")
            && registered_exact_command_with_matcher(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "claude",
                "Notification",
                CLAUDE_QUESTION_TOOL_NAME,
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
        attention_hook_installed: registered("PermissionRequest")
            && registered_exact_command_with_matcher(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "codex",
                "Notification",
                CODEX_QUESTION_TOOL_NAME,
            ),
        attention_hook_required: true,
        stop_hook_installed: registered("Stop"),
        failure_hook_installed: false,
        failure_hook_required: false,
        subagent_start_hook_installed: registered("SubagentStart")
            && registered("SubagentStop")
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "codex",
                "ToolStart",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PostToolUse",
                "codex",
                "ToolStop",
            ),
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

fn build_codex_status_with_trust_repair(
    codex_dir: Option<PathBuf>,
) -> Result<ToolHookSettingsStatus, String> {
    if let Some(codex_dir) = codex_dir.as_deref() {
        repair_duplicate_codex_hook_state_blocks(codex_dir)?;
    }
    let status = build_codex_status(codex_dir.clone())?;
    let Some(codex_dir) = codex_dir else {
        return Ok(status);
    };
    if !matches!(status.status, HookInstallStatus::PartialInstalled)
        || !status.session_start_hook_installed
        || !status.running_hook_installed
        || !status.attention_hook_installed
        || !status.stop_hook_installed
        || !status.subagent_start_hook_installed
        || !status.hooks_feature_installed
    {
        return Ok(status);
    }

    repair_codex_hook_trust(&codex_dir)?;
    build_codex_status(Some(codex_dir))
}

fn repair_duplicate_codex_hook_state_blocks(codex_dir: &Path) -> Result<(), String> {
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let settings = read_json_if_exists(&hooks_path)?;
    let expected_keys = codex_cli_manager_hook_state_keys(&settings, &hooks_path);
    if expected_keys.is_empty() {
        return Ok(());
    }

    let Some(config) = read_text_if_exists(&config_path)? else {
        return Ok(());
    };
    let Some(next) = deduplicate_codex_hook_state_blocks(&config, &expected_keys) else {
        return Ok(());
    };
    write_text(&config_path, &next)
}

fn repair_codex_hook_trust(codex_dir: &Path) -> Result<(), String> {
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let settings = read_json_if_exists(&hooks_path)?;
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return Ok(());
    };
    let mut blocks = Vec::new();
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
                let key = toml_escape_basic_string(&format!(
                    "{}:{event_name}:{entry_index}:{hook_index}",
                    path_to_string(&hooks_path)
                ));
                let hash = codex_hook_trusted_hash(event, entry, hook)?;
                blocks.push(vec![
                    format!("[hooks.state.\"{key}\"]"),
                    format!("trusted_hash = \"{hash}\""),
                ]);
            }
        }
    }

    let config = read_text_if_exists(&config_path)?
        .ok_or_else(|| format!("读取 {} 失败: 文件不存在", path_to_string(&config_path)))?;
    let next = merge_codex_common_config_toml(Some(&config), &blocks);
    if next != config {
        write_text(&config_path, &next)?;
    }
    Ok(())
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

fn is_wsl_path(path: &Path) -> bool {
    crate::wsl::is_wsl_config_dir(&path_to_string(path))
}

fn live_is_file(path: &Path) -> bool {
    if is_wsl_path(path) {
        crate::provider::global::live_is_file(&path_to_string(path))
    } else {
        path.is_file()
    }
}

fn live_is_dir(path: &Path) -> bool {
    if is_wsl_path(path) {
        crate::provider::global::live_is_dir(&path_to_string(path))
    } else {
        path.is_dir()
    }
}

fn create_live_dir_all(path: &Path, error_prefix: &str) -> Result<(), String> {
    if is_wsl_path(path) {
        return crate::provider::global::create_live_dir_all(&path_to_string(path))
            .map_err(|error| format!("{error_prefix}: {error}"));
    }
    fs::create_dir_all(path).map_err(|error| format!("{error_prefix}: {error}"))
}

fn read_text_if_exists(path: &Path) -> Result<Option<String>, String> {
    if is_wsl_path(path) {
        let bytes = crate::provider::global::read_live(&path_to_string(path))
            .map_err(|error| format!("读取 {} 失败: {error}", path_to_string(path)))?;
        return bytes
            .map(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| format!("读取 {} 失败: {error}", path_to_string(path)))
            })
            .transpose();
    }

    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 {} 失败: {error}", path_to_string(path))),
    }
}

fn write_text(path: &Path, content: &str) -> Result<(), String> {
    if is_wsl_path(path) {
        return crate::provider::global::write_live(&path_to_string(path), content.as_bytes())
            .map_err(|error| format!("写入 {} 失败: {error}", path_to_string(path)));
    }
    fs::write(path, content).map_err(|error| format!("写入 {} 失败: {error}", path_to_string(path)))
}

fn remove_live_file(path: &Path) -> Result<(), String> {
    if is_wsl_path(path) {
        return crate::provider::global::remove_live(&path_to_string(path))
            .map_err(|error| format!("删除 {} 失败: {error}", path_to_string(path)));
    }
    fs::remove_file(path).map_err(|error| format!("删除 {} 失败: {error}", path_to_string(path)))
}

fn read_json(path: &Path) -> Result<Value, String> {
    match read_text_if_exists(path)? {
        Some(content) => {
            if content.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(&content)
                    .map_err(|e| format!("解析 {} 失败: {e}", path_to_string(path)))
            }
        }
        None => Ok(json!({})),
    }
}

fn read_json_if_exists(path: &Path) -> Result<Value, String> {
    match read_text_if_exists(path)? {
        Some(content) => {
            if content.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(&content)
                    .map_err(|e| format!("解析 {} 失败: {e}", path_to_string(path)))
            }
        }
        None => Ok(json!({})),
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
    write_text(path, &format!("{content}\n"))
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
        let _ = remove_live_file(&hooks_dir.join(name));
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests;
