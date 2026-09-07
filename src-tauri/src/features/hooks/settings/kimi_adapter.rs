use super::HOOK_COMMAND_MARKER;
use super::{
    create_live_dir_all, escape_posix_single_quoted, escape_powershell_single_quoted, home_dir,
    hook_exe_for_dir, is_windows_native_exe_path, live_is_dir, missing_status,
    normalize_selected_dir, path_to_string, read_text_if_exists, status_from_checks,
    HookInstallStatus, ToolChecks, ToolHookSettingsStatus, KIMI_CONFIG_FILE_NAME,
};
use cli_manager_hook_schema::kimi::{
    self, KimiHookModule, KimiPlanAction, ALL_MODULES as ALL_KIMI_HOOK_MODULES,
};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(super) fn resolve_kimi_dir(selected_dir: Option<String>) -> Result<Option<PathBuf>, String> {
    let explicit = selected_dir.and_then(|value| normalize_selected_dir(&value));
    let default = env::var_os("KIMI_CODE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".kimi-code")));
    let Some(dir) = explicit.or(default) else {
        return Ok(None);
    };
    Ok(Some(dir))
}

pub(super) fn build_kimi_commands(kimi_dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let executable = hook_exe_for_dir(kimi_dir)?;
    Ok(kimi::DEFINITIONS
        .iter()
        .map(|definition| {
            (
                definition.bridge_event.to_string(),
                build_kimi_command(&executable, definition.bridge_event),
            )
        })
        .collect())
}

pub(super) fn build_kimi_command(executable: &str, event: &str) -> String {
    if is_windows_native_exe_path(executable) {
        let executable = escape_powershell_single_quoted(executable);
        return format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '{executable}' {HOOK_COMMAND_MARKER} --source kimi --event {event} --owner {}\"",
            kimi::LOCAL_OWNER
        );
    }
    format!(
        "{} {HOOK_COMMAND_MARKER} --source kimi --event {event} --owner {}",
        escape_posix_single_quoted(executable),
        kimi::LOCAL_OWNER
    )
}

pub(super) fn build_kimi_status(
    kimi_dir: Option<PathBuf>,
) -> Result<ToolHookSettingsStatus, String> {
    let Some(kimi_dir) = kimi_dir else {
        return missing_status();
    };
    let config_path = kimi_dir.join(KIMI_CONFIG_FILE_NAME);
    let content = read_text_if_exists(&config_path)?.unwrap_or_default();
    let commands = build_kimi_commands(&kimi_dir)?;
    let plan = kimi::plan(
        &content,
        &commands,
        &ALL_KIMI_HOOK_MODULES,
        KimiPlanAction::Inspect,
    )?;
    let installed = |event: &str| plan.installed_bridge_events.contains(event);
    let has_managed_hooks = !plan.installed_bridge_events.is_empty();
    let checks = ToolChecks {
        attention_script_installed: has_managed_hooks,
        finished_script_installed: has_managed_hooks,
        session_start_hook_installed: installed("SessionStart"),
        running_hook_installed: installed("UserPromptSubmit"),
        attention_hook_installed: installed("PermissionRequest") && installed("PermissionResult"),
        attention_hook_required: true,
        stop_hook_installed: installed("Stop") && installed("Interrupt"),
        failure_hook_installed: installed("StopFailure"),
        failure_hook_required: true,
        subagent_start_hook_installed: installed("SubagentStart") && installed("SubagentStop"),
        subagent_start_hook_required: true,
        hooks_feature_installed: has_managed_hooks,
        hooks_trusted: has_managed_hooks,
    };
    let mut status = status_from_checks(Some(kimi_dir), None, Some(config_path), None, checks);
    if plan.outdated || plan.conflict {
        status.status = HookInstallStatus::PartialInstalled;
    }
    Ok(status)
}

pub(super) fn install_kimi_hooks(
    kimi_dir: &Path,
    modules: &[KimiHookModule],
) -> Result<(), String> {
    if !live_is_dir(kimi_dir) {
        create_live_dir_all(kimi_dir, "kimi_config_dir_create_failed")?;
    }
    change_kimi_hooks(kimi_dir, modules, KimiPlanAction::Install)
}

pub(super) fn uninstall_kimi_hooks(
    kimi_dir: &Path,
    modules: &[KimiHookModule],
) -> Result<(), String> {
    change_kimi_hooks(kimi_dir, modules, KimiPlanAction::Uninstall)
}

pub(super) fn change_kimi_hooks(
    kimi_dir: &Path,
    modules: &[KimiHookModule],
    action: KimiPlanAction,
) -> Result<(), String> {
    let config_path = kimi_dir.join(KIMI_CONFIG_FILE_NAME);
    reject_kimi_config_symlink(&config_path)?;
    let original = read_text_if_exists(&config_path)?;
    let commands = build_kimi_commands(kimi_dir)?;
    let plan = kimi::plan(
        original.as_deref().unwrap_or_default(),
        &commands,
        modules,
        action,
    )?;
    if plan.content == original.as_deref().unwrap_or_default() {
        return Ok(());
    }
    replace_kimi_config(&config_path, original, &plan.content)
}

pub(super) fn reject_kimi_config_symlink(config_path: &Path) -> Result<(), String> {
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path_to_string(config_path))
    {
        let wsl = crate::wsl::find_wsl_exe().ok_or_else(|| "kimi_code_unsupported".to_string())?;
        let mut command = crate::shell_resolver::silent_command(wsl.to_string_lossy().as_ref());
        command
            .arg("-d")
            .arg(distro)
            .arg("--exec")
            .arg("test")
            .arg("-L")
            .arg(linux_path);
        let output = crate::shell_resolver::output_with_timeout(command, Duration::from_secs(5))
            .map_err(|_| "kimi_config_metadata_failed".to_string())?;
        if output.status.success() {
            return Err("kimi_config_symlink_unsupported".to_string());
        }
        return Ok(());
    }
    match fs::symlink_metadata(config_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("kimi_config_symlink_unsupported".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("kimi_config_metadata_failed".to_string()),
    }
}

pub(super) fn replace_kimi_config(
    config_path: &Path,
    original: Option<String>,
    content: &str,
) -> Result<(), String> {
    replace_kimi_config_with_stage_hook(config_path, original, content, || Ok(()))
}

pub(super) fn replace_kimi_config_with_stage_hook(
    config_path: &Path,
    original: Option<String>,
    content: &str,
    after_stage: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let parent = config_path
        .parent()
        .ok_or_else(|| "kimi_config_path_invalid".to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let candidate = parent.join(format!(
        ".{KIMI_CONFIG_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        stamp
    ));
    let candidate_text = path_to_string(&candidate);
    crate::provider::global::write_live(&candidate_text, content.as_bytes())
        .map_err(|_| "kimi_config_candidate_write_failed".to_string())?;
    let operation = (|| {
        after_stage()?;
        let current = read_text_if_exists(config_path)?;
        if current != original {
            return Err("kimi_config_changed".to_string());
        }
        if current.as_deref() == Some(content) {
            return Ok(false);
        }
        crate::provider::global::replace_live_from_stage(
            &path_to_string(config_path),
            &candidate_text,
        )
        .map_err(|_| "kimi_config_replace_failed".to_string())?;
        Ok(true)
    })();
    if !matches!(&operation, Ok(true)) {
        let _ = crate::provider::global::remove_live(&candidate_text);
    }
    operation.map(|_| ())
}
