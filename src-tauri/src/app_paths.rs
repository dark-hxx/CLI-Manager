use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

const APP_HOME_DIR_NAME: &str = ".cli-manager";
const DB_FILE_NAME: &str = "cli-manager.db";
const SETTINGS_STORE_FILE_NAME: &str = "settings.json";
const SESSIONS_STORE_FILE_NAME: &str = "sessions.json";
const DEV_SESSIONS_STORE_FILE_NAME: &str = "sessions.dev.json";
const SYNC_STORE_FILE_NAME: &str = "sync-config.json";
const EXTERNAL_SESSION_SYNC_STORE_FILE_NAME: &str = "external-session-sync.json";
const STORE_FILES: [&str; 4] = [
    SETTINGS_STORE_FILE_NAME,
    SESSIONS_STORE_FILE_NAME,
    SYNC_STORE_FILE_NAME,
    EXTERNAL_SESSION_SYNC_STORE_FILE_NAME,
];
const SYNC_STORE_LEGACY_IGNORED_KEYS: &[&str] = &["webdavPassword", "hasPassword"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliManagerDataPaths {
    pub data_dir: String,
    pub db_path: String,
    pub db_url: String,
    pub settings_store_path: String,
    pub sessions_store_path: String,
    pub sync_store_path: String,
    pub external_session_sync_store_path: String,
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

fn sessions_store_file_name(is_dev: bool) -> &'static str {
    if is_dev {
        DEV_SESSIONS_STORE_FILE_NAME
    } else {
        SESSIONS_STORE_FILE_NAME
    }
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
            .join(SETTINGS_STORE_FILE_NAME)
            .to_string_lossy()
            .into_owned(),
        sessions_store_path: data_dir
            .join(sessions_store_file_name(cfg!(dev)))
            .to_string_lossy()
            .into_owned(),
        sync_store_path: data_dir
            .join(SYNC_STORE_FILE_NAME)
            .to_string_lossy()
            .into_owned(),
        external_session_sync_store_path: data_dir
            .join(EXTERNAL_SESSION_SYNC_STORE_FILE_NAME)
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

fn backup_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("backup-{millis}")
}

fn backup_existing_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "data_migration_invalid_backup_path".to_string())?;
    let backup_path = path.with_file_name(format!("{file_name}.{}", backup_suffix()));
    fs::copy(path, backup_path).map_err(|err| format!("data_migration_backup_failed: {err}"))?;
    Ok(())
}

fn parse_json_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text =
        fs::read_to_string(path).map_err(|err| format!("data_migration_read_failed: {err}"))?;
    if text.trim().is_empty() {
        return Ok(Some(Map::new()));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Ok(Some(object)),
        Ok(_) | Err(_) => Ok(None),
    }
}

fn migrate_store_file(source: &Path, target: &Path) -> Result<(), String> {
    migrate_store_file_with_ignored_keys(source, target, &[])
}

fn migrate_sync_store_file(source: &Path, target: &Path) -> Result<(), String> {
    migrate_store_file_with_ignored_keys(source, target, SYNC_STORE_LEGACY_IGNORED_KEYS)
}

fn migrate_store_file_with_ignored_keys(
    source: &Path,
    target: &Path,
    ignored_keys: &[&str],
) -> Result<(), String> {
    if !source.is_file() {
        return Ok(());
    }
    if !target.exists() {
        if !ignored_keys.is_empty() {
            let Some(mut source_object) = parse_json_object(source)? else {
                return Ok(());
            };
            source_object.retain(|key, _| !ignored_keys.contains(&key.as_str()));
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("data_migration_failed: {err}"))?;
            }
            let bytes = serde_json::to_vec_pretty(&Value::Object(source_object))
                .map_err(|err| format!("data_migration_serialize_failed: {err}"))?;
            fs::write(target, bytes)
                .map_err(|err| format!("data_migration_write_failed: {err}"))?;
            return Ok(());
        }
        return copy_if_missing(source, target);
    }
    if !target.is_file() {
        return Ok(());
    }

    let Some(source_object) = parse_json_object(source)? else {
        return Ok(());
    };
    let Some(mut target_object) = parse_json_object(target)? else {
        return Ok(());
    };

    let mut changed = false;
    for (key, value) in source_object {
        if ignored_keys.contains(&key.as_str()) {
            continue;
        }
        if !target_object.contains_key(&key) {
            target_object.insert(key, value);
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }

    backup_existing_file(target)?;
    let bytes = serde_json::to_vec_pretty(&Value::Object(target_object))
        .map_err(|err| format!("data_migration_serialize_failed: {err}"))?;
    fs::write(target, bytes).map_err(|err| format!("data_migration_write_failed: {err}"))?;
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
            let source = old_store_dir.join(file_name);
            let target = data_dir.join(file_name);
            if file_name == SYNC_STORE_FILE_NAME {
                migrate_sync_store_file(&source, &target)?;
            } else {
                migrate_store_file(&source, &target)?;
            }
        }
    }

    Ok(())
}

pub fn history_cache_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("history-cache"))
}

/// 会话历史消息编辑前的整文件备份目录（首改备份 + 一键还原）。
pub fn history_backups_dir() -> Result<PathBuf, String> {
    Ok(cli_manager_data_dir()?.join("history-backups"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_development_and_installed_session_store_files() {
        assert_eq!(sessions_store_file_name(false), "sessions.json");
        assert_eq!(sessions_store_file_name(true), "sessions.dev.json");
    }

    #[test]
    fn migrates_missing_store_file_by_copying_legacy_file() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy.json");
        let target = temp.path().join("target.json");
        fs::write(&source, r#"{"theme":"dark"}"#).unwrap();

        migrate_store_file(&source, &target).unwrap();

        assert_eq!(fs::read_to_string(target).unwrap(), r#"{"theme":"dark"}"#);
    }

    #[test]
    fn merges_legacy_store_keys_without_overwriting_target_values() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy.json");
        let target = temp.path().join("target.json");
        fs::write(&source, r#"{"theme":"dark","fontSize":18}"#).unwrap();
        fs::write(&target, r#"{"theme":"light"}"#).unwrap();

        migrate_store_file(&source, &target).unwrap();

        let merged: Value = serde_json::from_str(&fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(merged.get("theme").and_then(Value::as_str), Some("light"));
        assert_eq!(merged.get("fontSize").and_then(Value::as_i64), Some(18));
        let backup_count = fs::read_dir(temp.path())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("target.json.backup-")
            })
            .count();
        assert_eq!(backup_count, 1);
    }

    #[test]
    fn leaves_target_store_unchanged_when_legacy_has_no_new_keys() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy.json");
        let target = temp.path().join("target.json");
        fs::write(&source, r#"{"theme":"dark"}"#).unwrap();
        fs::write(&target, r#"{"theme":"light"}"#).unwrap();

        migrate_store_file(&source, &target).unwrap();

        assert_eq!(fs::read_to_string(target).unwrap(), r#"{"theme":"light"}"#);
    }

    #[test]
    fn sync_store_migration_ignores_removed_password_keys() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy-sync.json");
        let target = temp.path().join("sync-config.json");
        fs::write(
            &source,
            r#"{"webdavUrl":"https://example.test","webdavPassword":"secret","hasPassword":true}"#,
        )
        .unwrap();
        fs::write(&target, r#"{"webdavUrl":"https://example.test"}"#).unwrap();

        migrate_sync_store_file(&source, &target).unwrap();

        assert_eq!(
            fs::read_to_string(target).unwrap(),
            r#"{"webdavUrl":"https://example.test"}"#
        );
        let backup_count = fs::read_dir(temp.path())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("sync-config.json.backup-")
            })
            .count();
        assert_eq!(backup_count, 0);
    }

    #[test]
    fn sync_store_copy_filters_removed_password_keys() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy-sync.json");
        let target = temp.path().join("sync-config.json");
        fs::write(
            &source,
            r#"{"webdavUrl":"https://example.test","webdavPassword":"secret","hasPassword":true}"#,
        )
        .unwrap();

        migrate_sync_store_file(&source, &target).unwrap();

        let migrated: Value = serde_json::from_str(&fs::read_to_string(target).unwrap()).unwrap();
        assert_eq!(
            migrated.get("webdavUrl").and_then(Value::as_str),
            Some("https://example.test")
        );
        assert!(migrated.get("webdavPassword").is_none());
        assert!(migrated.get("hasPassword").is_none());
    }
}
