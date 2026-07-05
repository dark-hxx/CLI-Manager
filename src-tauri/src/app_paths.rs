use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

const APP_HOME_DIR_NAME: &str = ".cli-manager";
const DB_FILE_NAME: &str = "cli-manager.db";
const STORE_FILES: [&str; 3] = ["settings.json", "sessions.json", "sync-config.json"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliManagerDataPaths {
    pub data_dir: String,
    pub db_path: String,
    pub db_url: String,
    pub settings_store_path: String,
    pub sessions_store_path: String,
    pub sync_store_path: String,
    pub logs_dir: String,
    pub codex_providers_dir: String,
    pub claude_providers_dir: String,
}

fn home_dir_from_env() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return Ok(home);
    }
    if let Some(home) = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return Ok(home);
    }
    Err("home_dir_unavailable".to_string())
}

pub fn cli_manager_data_dir() -> Result<PathBuf, String> {
    Ok(home_dir_from_env()?.join(APP_HOME_DIR_NAME))
}

pub fn logs_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("logs"))
}

pub fn providers_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("providers"))
}

pub fn codex_providers_dir() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("codex"))
}

pub fn claude_providers_dir() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("claude"))
}

pub fn db_path() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join(DB_FILE_NAME))
}

pub fn db_url() -> Result<String, String> {
    Ok(format!("sqlite:{}", db_path()?.to_string_lossy()))
}

pub fn data_paths() -> Result<CliManagerDataPaths, String> {
    let data_dir = cli_manager_data_dir()?;
    let db_path = db_path()?;
    let logs_dir = logs_dir()?;
    let codex_providers_dir = codex_providers_dir()?;
    let claude_providers_dir = claude_providers_dir()?;
    Ok(CliManagerDataPaths {
        data_dir: data_dir.to_string_lossy().into_owned(),
        db_path: db_path.to_string_lossy().into_owned(),
        db_url: format!("sqlite:{}", db_path.to_string_lossy()),
        settings_store_path: data_dir
            .join("settings.json")
            .to_string_lossy()
            .into_owned(),
        sessions_store_path: data_dir
            .join("sessions.json")
            .to_string_lossy()
            .into_owned(),
        sync_store_path: data_dir
            .join("sync-config.json")
            .to_string_lossy()
            .into_owned(),
        logs_dir: logs_dir.to_string_lossy().into_owned(),
        codex_providers_dir: codex_providers_dir.to_string_lossy().into_owned(),
        claude_providers_dir: claude_providers_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn app_get_data_paths() -> Result<CliManagerDataPaths, String> {
    data_paths()
}

fn copy_if_missing(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_file() || target.exists() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("data_migration_failed: {err}"))?;
    }
    fs::copy(source, target).map_err(|err| format!("data_migration_failed: {err}"))?;
    Ok(())
}

fn ensure_dirs() -> Result<(), String> {
    for dir in [
        cli_manager_data_dir()?,
        logs_dir()?,
        codex_providers_dir()?,
        claude_providers_dir()?,
        cli_manager_data_dir()?.join("backups"),
        cli_manager_data_dir()?.join("history-cache"),
    ] {
        fs::create_dir_all(dir).map_err(|err| format!("data_dir_create_failed: {err}"))?;
    }
    Ok(())
}

pub fn migrate_legacy_app_files<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    ensure_dirs()?;

    if let Ok(old_db_dir) = app.path().app_config_dir() {
        copy_if_missing(&old_db_dir.join(DB_FILE_NAME), &db_path()?)?;
    }

    if let Ok(old_store_dir) = app.path().app_data_dir() {
        let data_dir = cli_manager_data_dir()?;
        for file_name in STORE_FILES {
            copy_if_missing(&old_store_dir.join(file_name), &data_dir.join(file_name))?;
        }
    }

    Ok(())
}

pub fn history_cache_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("history-cache"))
}
