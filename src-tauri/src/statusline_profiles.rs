use crate::{app_paths, codex_statusline, statusline};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const LIBRARY_VERSION: u32 = 1;
const LIBRARY_FILE: &str = "profiles.json";
const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024;
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatuslineProfileTool {
    Claude,
    Codex,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineProfile {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub payload: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolProfiles {
    active_profile_id: String,
    profiles: Vec<StatuslineProfile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileLibrary {
    version: u32,
    revision: u64,
    claude: ToolProfiles,
    codex: ToolProfiles,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineProfileState {
    pub revision: u64,
    pub active_profile_id: String,
    pub profiles: Vec<StatuslineProfile>,
    pub external_payload: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDecision {
    pub tool: StatuslineProfileTool,
    pub profile_id: String,
    pub action: String,
    pub new_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportConflict {
    pub tool: StatuslineProfileTool,
    pub profile_id: String,
    pub name: String,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAnalysis {
    pub revision: u64,
    pub conflicts: Vec<ImportConflict>,
    pub claude_count: usize,
    pub codex_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportLibrary {
    version: u32,
    claude: Vec<StatuslineProfile>,
    codex: Vec<StatuslineProfile>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_id() -> String {
    format!(
        "profile-{}-{}-{}",
        std::process::id(),
        now_millis(),
        ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn library_path() -> Result<PathBuf, String> {
    Ok(app_paths::cli_manager_data_dir()?
        .join("statusline")
        .join(LIBRARY_FILE))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "statusline_profiles_invalid_path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("statusline_profiles_create_dir_failed: {err}"))?;
    let temp = parent.join(format!(".{LIBRARY_FILE}.{}.tmp", now_millis()));
    fs::write(&temp, bytes).map_err(|err| format!("statusline_profiles_write_failed: {err}"))?;
    if let Err(error) = fs::rename(&temp, path) {
        #[cfg(target_os = "windows")]
        if path.exists() {
            fs::remove_file(path)
                .map_err(|err| format!("statusline_profiles_replace_failed: {err}"))?;
            fs::rename(&temp, path)
                .map_err(|err| format!("statusline_profiles_replace_failed: {err}"))?;
            return Ok(());
        }
        let _ = fs::remove_file(&temp);
        return Err(format!("statusline_profiles_replace_failed: {error}"));
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("statusline_profile_invalid_name".to_string());
    }
    Ok(name.to_string())
}

fn validate_payload(tool: StatuslineProfileTool, payload: &Value) -> Result<(), String> {
    match tool {
        StatuslineProfileTool::Claude => {
            let settings =
                serde_json::from_value::<statusline::StatuslineSettings>(payload.clone())
                    .map_err(|_| "statusline_profile_invalid_claude".to_string())?;
            statusline::validate_settings(&settings)?;
        }
        StatuslineProfileTool::Codex => {
            let items = serde_json::from_value::<Vec<String>>(payload.clone())
                .map_err(|_| "statusline_profile_invalid_codex".to_string())?;
            codex_statusline::validate_items(&items)?;
        }
    }
    Ok(())
}

fn actual_payload(
    tool: StatuslineProfileTool,
    config_dir: Option<String>,
) -> Result<Value, String> {
    match tool {
        StatuslineProfileTool::Claude => {
            let settings = if statusline::settings_path()?.exists() {
                statusline::load_settings()?
            } else {
                statusline::load_legacy_settings()?.unwrap_or_default()
            };
            serde_json::to_value(settings)
                .map_err(|err| format!("statusline_profile_serialize_failed: {err}"))
        }
        StatuslineProfileTool::Codex => {
            serde_json::to_value(codex_statusline::codex_statusline_load(config_dir)?.items)
                .map_err(|err| format!("statusline_profile_serialize_failed: {err}"))
        }
    }
}

fn apply_payload(
    tool: StatuslineProfileTool,
    payload: &Value,
    config_dir: Option<String>,
) -> Result<(), String> {
    validate_payload(tool, payload)?;
    match tool {
        StatuslineProfileTool::Claude => {
            let settings =
                serde_json::from_value::<statusline::StatuslineSettings>(payload.clone())
                    .map_err(|_| "statusline_profile_invalid_claude".to_string())?;
            statusline::save_settings(&settings)
        }
        StatuslineProfileTool::Codex => {
            let items = serde_json::from_value::<Vec<String>>(payload.clone())
                .map_err(|_| "statusline_profile_invalid_codex".to_string())?;
            codex_statusline::codex_statusline_save(config_dir, items).map(|_| ())
        }
    }
}

fn initial_profile(
    tool: StatuslineProfileTool,
    config_dir: Option<String>,
) -> Result<ToolProfiles, String> {
    let payload = actual_payload(tool, config_dir)?;
    validate_payload(tool, &payload)?;
    let now = now_millis();
    let id = new_id();
    Ok(ToolProfiles {
        active_profile_id: id.clone(),
        profiles: vec![StatuslineProfile {
            id,
            name: "__current__".to_string(),
            created_at: now,
            updated_at: now,
            payload,
        }],
    })
}

fn load_library(config_dir: Option<String>) -> Result<ProfileLibrary, String> {
    let path = library_path()?;
    if !path.exists() {
        let library = ProfileLibrary {
            version: LIBRARY_VERSION,
            revision: 1,
            claude: initial_profile(StatuslineProfileTool::Claude, None)?,
            codex: initial_profile(StatuslineProfileTool::Codex, config_dir)?,
        };
        save_library(&library)?;
        return Ok(library);
    }
    let library: ProfileLibrary = serde_json::from_str(
        &fs::read_to_string(path)
            .map_err(|err| format!("statusline_profiles_read_failed: {err}"))?,
    )
    .map_err(|_| "statusline_profiles_invalid_json".to_string())?;
    if library.version != LIBRARY_VERSION {
        return Err("statusline_profiles_unsupported_version".to_string());
    }
    validate_library(&library)?;
    Ok(library)
}

fn validate_library(library: &ProfileLibrary) -> Result<(), String> {
    for (tool, section) in [
        (StatuslineProfileTool::Claude, &library.claude),
        (StatuslineProfileTool::Codex, &library.codex),
    ] {
        if section.profiles.is_empty()
            || !section
                .profiles
                .iter()
                .any(|profile| profile.id == section.active_profile_id)
        {
            return Err("statusline_profiles_invalid_active".to_string());
        }
        for profile in &section.profiles {
            validate_name(&profile.name)?;
            validate_payload(tool, &profile.payload)?;
        }
    }
    Ok(())
}

fn save_library(library: &ProfileLibrary) -> Result<(), String> {
    validate_library(library)?;
    let bytes = serde_json::to_vec_pretty(library)
        .map_err(|err| format!("statusline_profiles_serialize_failed: {err}"))?;
    atomic_write(&library_path()?, &bytes)
}

fn section(library: &ProfileLibrary, tool: StatuslineProfileTool) -> &ToolProfiles {
    match tool {
        StatuslineProfileTool::Claude => &library.claude,
        StatuslineProfileTool::Codex => &library.codex,
    }
}

fn section_mut(library: &mut ProfileLibrary, tool: StatuslineProfileTool) -> &mut ToolProfiles {
    match tool {
        StatuslineProfileTool::Claude => &mut library.claude,
        StatuslineProfileTool::Codex => &mut library.codex,
    }
}

fn state(
    library: &ProfileLibrary,
    tool: StatuslineProfileTool,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    let section = section(library, tool);
    let active = section
        .profiles
        .iter()
        .find(|profile| profile.id == section.active_profile_id)
        .ok_or_else(|| "statusline_profiles_invalid_active".to_string())?;
    let actual = actual_payload(tool, config_dir)?;
    Ok(StatuslineProfileState {
        revision: library.revision,
        active_profile_id: section.active_profile_id.clone(),
        profiles: section.profiles.clone(),
        external_payload: (actual != active.payload).then_some(actual),
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineBackupBundle {
    settings: statusline::StatuslineSettings,
    profiles: ProfileLibrary,
}

#[tauri::command]
pub fn statusline_backup_export() -> Result<StatuslineBackupBundle, String> {
    let settings = if statusline::settings_path()?.exists() {
        statusline::load_settings()?
    } else {
        statusline::StatuslineSettings::default()
    };
    statusline::validate_settings(&settings)?;
    let profiles = load_library(None)?;
    validate_library(&profiles)?;
    Ok(StatuslineBackupBundle { settings, profiles })
}

#[tauri::command]
pub fn statusline_backup_restore(bundle: StatuslineBackupBundle) -> Result<(), String> {
    statusline::validate_settings(&bundle.settings)?;
    validate_library(&bundle.profiles)?;
    let settings_bytes = serde_json::to_vec_pretty(&bundle.settings)
        .map_err(|error| format!("statusline_profiles_serialize_failed: {error}"))?;
    let profiles_bytes = serde_json::to_vec_pretty(&bundle.profiles)
        .map_err(|error| format!("statusline_profiles_serialize_failed: {error}"))?;
    atomic_write(&statusline::settings_path()?, &settings_bytes)?;
    atomic_write(&library_path()?, &profiles_bytes)
}

#[tauri::command]
pub fn statusline_profiles_load(
    tool: StatuslineProfileTool,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    let library = load_library(config_dir.clone())?;
    state(&library, tool, config_dir)
}

#[tauri::command]
pub fn statusline_profiles_create(
    tool: StatuslineProfileTool,
    name: String,
    payload: Value,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    let name = validate_name(&name)?;
    validate_payload(tool, &payload)?;
    let mut library = load_library(config_dir.clone())?;
    if section(&library, tool)
        .profiles
        .iter()
        .any(|profile| profile.name.eq_ignore_ascii_case(&name))
    {
        return Err("statusline_profile_duplicate_name".to_string());
    }
    apply_payload(tool, &payload, config_dir.clone())?;
    let now = now_millis();
    let id = new_id();
    let target = section_mut(&mut library, tool);
    target.profiles.push(StatuslineProfile {
        id: id.clone(),
        name,
        created_at: now,
        updated_at: now,
        payload,
    });
    target.active_profile_id = id;
    library.revision += 1;
    save_library(&library)?;
    state(&library, tool, config_dir)
}

#[tauri::command]
pub fn statusline_profiles_save(
    tool: StatuslineProfileTool,
    profile_id: String,
    payload: Value,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    validate_payload(tool, &payload)?;
    let mut library = load_library(config_dir.clone())?;
    if section(&library, tool).active_profile_id != profile_id {
        return Err("statusline_profile_not_active".to_string());
    }
    apply_payload(tool, &payload, config_dir.clone())?;
    let profile = section_mut(&mut library, tool)
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "statusline_profile_not_found".to_string())?;
    profile.payload = payload;
    profile.updated_at = now_millis();
    library.revision += 1;
    save_library(&library)?;
    state(&library, tool, config_dir)
}

#[tauri::command]
pub fn statusline_profiles_switch(
    tool: StatuslineProfileTool,
    profile_id: String,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    let mut library = load_library(config_dir.clone())?;
    let payload = section(&library, tool)
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .map(|profile| profile.payload.clone())
        .ok_or_else(|| "statusline_profile_not_found".to_string())?;
    apply_payload(tool, &payload, config_dir.clone())?;
    section_mut(&mut library, tool).active_profile_id = profile_id;
    library.revision += 1;
    save_library(&library)?;
    state(&library, tool, config_dir)
}

#[tauri::command]
pub fn statusline_profiles_rename(
    tool: StatuslineProfileTool,
    profile_id: String,
    name: String,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    let name = validate_name(&name)?;
    let mut library = load_library(config_dir.clone())?;
    let target = section_mut(&mut library, tool);
    if target
        .profiles
        .iter()
        .any(|profile| profile.id != profile_id && profile.name.eq_ignore_ascii_case(&name))
    {
        return Err("statusline_profile_duplicate_name".to_string());
    }
    let profile = target
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "statusline_profile_not_found".to_string())?;
    profile.name = name;
    profile.updated_at = now_millis();
    library.revision += 1;
    save_library(&library)?;
    state(&library, tool, config_dir)
}

#[tauri::command]
pub fn statusline_profiles_duplicate(
    tool: StatuslineProfileTool,
    profile_id: String,
    name: String,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    let name = validate_name(&name)?;
    let mut library = load_library(config_dir.clone())?;
    if section(&library, tool)
        .profiles
        .iter()
        .any(|profile| profile.name.eq_ignore_ascii_case(&name))
    {
        return Err("statusline_profile_duplicate_name".to_string());
    }
    let payload = section(&library, tool)
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .map(|profile| profile.payload.clone())
        .ok_or_else(|| "statusline_profile_not_found".to_string())?;
    apply_payload(tool, &payload, config_dir.clone())?;
    let now = now_millis();
    let id = new_id();
    let target = section_mut(&mut library, tool);
    target.profiles.push(StatuslineProfile {
        id: id.clone(),
        name,
        created_at: now,
        updated_at: now,
        payload,
    });
    target.active_profile_id = id;
    library.revision += 1;
    save_library(&library)?;
    state(&library, tool, config_dir)
}

#[tauri::command]
pub fn statusline_profiles_delete(
    tool: StatuslineProfileTool,
    profile_id: String,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    let mut library = load_library(config_dir.clone())?;
    let target = section_mut(&mut library, tool);
    if target.active_profile_id == profile_id {
        return Err("statusline_profile_active_delete_forbidden".to_string());
    }
    let before = target.profiles.len();
    target.profiles.retain(|profile| profile.id != profile_id);
    if target.profiles.len() == before {
        return Err("statusline_profile_not_found".to_string());
    }
    library.revision += 1;
    save_library(&library)?;
    state(&library, tool, config_dir)
}

#[tauri::command]
pub fn statusline_profiles_capture_external(
    tool: StatuslineProfileTool,
    name: String,
    config_dir: Option<String>,
) -> Result<StatuslineProfileState, String> {
    let payload = actual_payload(tool, config_dir.clone())?;
    statusline_profiles_create(tool, name, payload, config_dir)
}

fn validate_transfer_path(path: &str, must_exist: bool) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("json"))
        != Some(true)
    {
        return Err("statusline_profiles_unsupported_format".to_string());
    }
    if must_exist {
        let metadata = fs::metadata(&path)
            .map_err(|err| format!("statusline_profiles_import_read_failed: {err}"))?;
        if !metadata.is_file() || metadata.len() > MAX_IMPORT_BYTES {
            return Err("statusline_profiles_import_too_large".to_string());
        }
    }
    Ok(path)
}

fn read_export(path: &str) -> Result<ExportLibrary, String> {
    let path = validate_transfer_path(path, true)?;
    let value: ExportLibrary = serde_json::from_str(
        &fs::read_to_string(path)
            .map_err(|err| format!("statusline_profiles_import_read_failed: {err}"))?,
    )
    .map_err(|_| "statusline_profiles_import_invalid_json".to_string())?;
    if value.version != LIBRARY_VERSION {
        return Err("statusline_profiles_unsupported_version".to_string());
    }
    for profile in &value.claude {
        validate_name(&profile.name)?;
        validate_payload(StatuslineProfileTool::Claude, &profile.payload)?;
    }
    for profile in &value.codex {
        validate_name(&profile.name)?;
        validate_payload(StatuslineProfileTool::Codex, &profile.payload)?;
    }
    Ok(value)
}

#[tauri::command]
pub fn statusline_profiles_export(path: String, config_dir: Option<String>) -> Result<(), String> {
    let library = load_library(config_dir)?;
    let export = ExportLibrary {
        version: LIBRARY_VERSION,
        claude: library.claude.profiles,
        codex: library.codex.profiles,
    };
    let bytes = serde_json::to_vec_pretty(&export)
        .map_err(|err| format!("statusline_profiles_serialize_failed: {err}"))?;
    atomic_write(&validate_transfer_path(&path, false)?, &bytes)
}

#[tauri::command]
pub fn statusline_profiles_analyze_import(
    path: String,
    config_dir: Option<String>,
) -> Result<ImportAnalysis, String> {
    let import = read_export(&path)?;
    let library = load_library(config_dir)?;
    let mut conflicts = Vec::new();
    for (tool, incoming, local) in [
        (
            StatuslineProfileTool::Claude,
            &import.claude,
            &library.claude,
        ),
        (StatuslineProfileTool::Codex, &import.codex, &library.codex),
    ] {
        for profile in incoming {
            if let Some(existing) = local
                .profiles
                .iter()
                .find(|item| item.name.eq_ignore_ascii_case(&profile.name))
            {
                conflicts.push(ImportConflict {
                    tool,
                    profile_id: profile.id.clone(),
                    name: profile.name.clone(),
                    active: existing.id == local.active_profile_id,
                });
            }
        }
    }
    Ok(ImportAnalysis {
        revision: library.revision,
        conflicts,
        claude_count: import.claude.len(),
        codex_count: import.codex.len(),
    })
}

#[tauri::command]
pub fn statusline_profiles_commit_import(
    path: String,
    revision: u64,
    decisions: Vec<ImportDecision>,
    config_dir: Option<String>,
) -> Result<(), String> {
    let import = read_export(&path)?;
    let mut library = load_library(config_dir)?;
    if library.revision != revision {
        return Err("statusline_profiles_revision_changed".to_string());
    }
    for (tool, profiles) in [
        (StatuslineProfileTool::Claude, import.claude),
        (StatuslineProfileTool::Codex, import.codex),
    ] {
        for mut incoming in profiles {
            validate_payload(tool, &incoming.payload)?;
            let existing = section(&library, tool)
                .profiles
                .iter()
                .find(|item| item.name.eq_ignore_ascii_case(&incoming.name))
                .cloned();
            if let Some(existing) = existing {
                let decision = decisions
                    .iter()
                    .find(|item| item.tool == tool && item.profile_id == incoming.id)
                    .ok_or_else(|| "statusline_profiles_missing_decision".to_string())?;
                match decision.action.as_str() {
                    "skip" => continue,
                    "rename" => {
                        incoming.name =
                            validate_name(decision.new_name.as_deref().unwrap_or_default())?
                    }
                    "overwrite" => {
                        if existing.id == section(&library, tool).active_profile_id {
                            return Err(
                                "statusline_profiles_active_overwrite_forbidden".to_string()
                            );
                        }
                        incoming.id = existing.id.clone();
                        let target = section_mut(&mut library, tool);
                        if let Some(index) = target
                            .profiles
                            .iter()
                            .position(|item| item.id == existing.id)
                        {
                            incoming.created_at = target.profiles[index].created_at;
                            incoming.updated_at = now_millis();
                            target.profiles[index] = incoming;
                            continue;
                        }
                    }
                    _ => return Err("statusline_profiles_invalid_decision".to_string()),
                }
            }
            let target = section_mut(&mut library, tool);
            if target
                .profiles
                .iter()
                .any(|item| item.name.eq_ignore_ascii_case(&incoming.name))
            {
                return Err("statusline_profile_duplicate_name".to_string());
            }
            incoming.id = new_id();
            incoming.created_at = now_millis();
            incoming.updated_at = incoming.created_at;
            target.profiles.push(incoming);
        }
    }
    library.revision += 1;
    save_library(&library)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_profile_name() {
        assert_eq!(
            validate_name(" ").unwrap_err(),
            "statusline_profile_invalid_name"
        );
    }

    #[test]
    fn rejects_non_json_transfer_path() {
        assert_eq!(
            validate_transfer_path("profiles.txt", false).unwrap_err(),
            "statusline_profiles_unsupported_format"
        );
    }

    #[test]
    fn rejects_unknown_codex_item() {
        assert_eq!(
            validate_payload(
                StatuslineProfileTool::Codex,
                &serde_json::json!(["unknown-item"])
            )
            .unwrap_err(),
            "codex_statusline_unknown_item"
        );
    }

    #[test]
    fn rejects_invalid_claude_line_count() {
        let mut settings = statusline::StatuslineSettings::default();
        settings.lines.clear();
        assert_eq!(
            validate_payload(
                StatuslineProfileTool::Claude,
                &serde_json::to_value(settings).unwrap()
            )
            .unwrap_err(),
            "statusline_invalid_line_count"
        );
    }
}
