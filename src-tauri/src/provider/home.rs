use crate::{app_paths, shell_resolver, wsl};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LOCAL_ENVIRONMENT_ID: &str = "host";
const WSL_HOME_DETECT_TIMEOUT: Duration = Duration::from_secs(30);
const WSL_HOME_VALIDATION_TIMEOUT: Duration = Duration::from_secs(5);
const WSL_DISTRO_LIST_TIMEOUT: Duration = Duration::from_secs(5);
const ACTIVE_HOME_IDENTITY_SETTING: &str = "active_provider_home_identity";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeSelectInput {
    pub environment_kind: String,
    pub environment_id: Option<String>,
    pub mode: String,
    pub home_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeIdentity {
    pub environment_kind: String,
    pub environment_id: String,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DerivedCliTargets {
    pub home_path: String,
    pub claude_config_dir: String,
    pub claude_history_root: String,
    pub codex_config_dir: String,
    pub codex_history_root: String,
    pub grok_config_dir: String,
    pub grok_history_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHomeState {
    pub identity: HomeIdentity,
    pub mode: String,
    pub home_path: String,
    pub source: String,
    pub targets: DerivedCliTargets,
}

#[derive(Debug, Clone)]
struct NormalizedHomeInput {
    environment_kind: String,
    environment_id: String,
    mode: String,
    home_path: Option<String>,
}

static HOME_CACHE: OnceLock<RwLock<HashMap<String, ProviderHomeState>>> = OnceLock::new();
static ACTIVE_HOME_IDENTITY: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn cache() -> &'static RwLock<HashMap<String, ProviderHomeState>> {
    HOME_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn active_home_identity() -> &'static RwLock<Option<String>> {
    ACTIVE_HOME_IDENTITY.get_or_init(|| RwLock::new(None))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn parse_default_wsl_context(stdout: &[u8]) -> Result<(String, String), String> {
    let stdout = String::from_utf8_lossy(stdout);
    let mut lines = stdout.lines();
    let distro = lines.next().map(str::trim).unwrap_or_default();
    let home = lines.next().map(str::trim).unwrap_or_default();
    if distro.is_empty() || !is_valid_linux_home_path(home) {
        return Err("provider_wsl_probe_failed".to_string());
    }
    Ok((distro.to_string(), home.to_string()))
}

fn default_wsl_context() -> Result<(String, String), String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command.args([
        "--exec",
        "sh",
        "-lc",
        r#"printf '%s\n%s' "$WSL_DISTRO_NAME" "$HOME""#,
    ]);
    let output = shell_resolver::output_with_timeout(command, WSL_HOME_DETECT_TIMEOUT)
        .map_err(|_| "provider_wsl_probe_failed".to_string())?;
    if !output.status.success() {
        return Err("provider_wsl_probe_failed".to_string());
    }
    parse_default_wsl_context(&output.stdout)
}

fn decode_wsl_output(stdout: &[u8]) -> String {
    let is_utf16le = stdout.starts_with(&[0xff, 0xfe])
        || (stdout.len() >= 4 && stdout.chunks_exact(2).all(|chunk| chunk[1] == 0));
    if !is_utf16le {
        return String::from_utf8_lossy(stdout).into_owned();
    }

    let bytes = stdout.strip_prefix(&[0xff, 0xfe]).unwrap_or(stdout);
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
    String::from_utf16_lossy(&units.collect::<Vec<_>>())
}

fn parse_wsl_distros(stdout: &[u8]) -> Vec<String> {
    decode_wsl_output(stdout)
        .lines()
        .filter_map(|line| {
            let distro = line
                .trim()
                .trim_start_matches('\u{feff}')
                .trim_start_matches("* ")
                .trim();
            if distro.is_empty()
                || distro.eq_ignore_ascii_case("windows subsystem for linux distributions:")
            {
                None
            } else {
                Some(distro.to_string())
            }
        })
        .collect()
}

pub(crate) fn list_wsl_distros() -> Result<Vec<String>, String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command.args(["-l", "-q"]);
    let output = shell_resolver::output_with_timeout(command, WSL_DISTRO_LIST_TIMEOUT)
        .map_err(|_| "provider_wsl_list_failed".to_string())?;
    if !output.status.success() {
        return Err("provider_wsl_list_failed".to_string());
    }
    Ok(parse_wsl_distros(&output.stdout))
}

fn resolve_wsl_environment_id(input: &HomeSelectInput) -> Result<String, String> {
    let requested = input.environment_id.as_deref().unwrap_or_default().trim();
    if !requested.is_empty() && !requested.eq_ignore_ascii_case(LOCAL_ENVIRONMENT_ID) {
        return Ok(requested.to_string());
    }
    if let Some((distro, _)) = input.home_path.as_deref().and_then(wsl::parse_wsl_unc_path) {
        return Ok(distro);
    }
    default_wsl_context().map(|(distro, _)| distro)
}

fn normalize_input(input: HomeSelectInput) -> Result<NormalizedHomeInput, String> {
    let environment_kind = input.environment_kind.trim().to_ascii_lowercase();
    if environment_kind != "local" && environment_kind != "wsl" {
        return Err("provider_environment_invalid".to_string());
    }
    let environment_id = if environment_kind == "local" {
        LOCAL_ENVIRONMENT_ID.to_string()
    } else {
        resolve_wsl_environment_id(&input)?
    };
    if environment_id.is_empty() {
        return Err("provider_environment_id_required".to_string());
    }
    let mode = input.mode.trim().to_ascii_lowercase();
    if mode != "auto" && mode != "manual" {
        return Err("provider_home_mode_invalid".to_string());
    }
    let home_path = input
        .home_path
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string());
    if mode == "manual" && home_path.is_none() {
        return Err("provider_home_path_required".to_string());
    }
    Ok(NormalizedHomeInput {
        environment_kind,
        environment_id,
        mode,
        home_path,
    })
}

fn identity(kind: &str, id: &str) -> HomeIdentity {
    HomeIdentity {
        environment_kind: kind.to_string(),
        environment_id: id.to_string(),
        identity: format!("{kind}:{id}"),
    }
}

fn reject_cli_subdirectory(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(name.as_str(), ".claude" | ".codex" | ".grok") {
        return Err("provider_home_must_be_parent_directory".to_string());
    }
    Ok(())
}

fn validate_local_home(raw: &str) -> Result<PathBuf, String> {
    if wsl::parse_wsl_unc_path(raw).is_some() {
        return Err("provider_home_environment_mismatch".to_string());
    }
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err("provider_home_invalid".to_string());
    }
    reject_cli_subdirectory(&path)?;
    if !path.is_dir() {
        return Err("provider_home_invalid".to_string());
    }
    let probe = path.join(format!(".cli-manager-home-probe-{}", now_millis()));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| "provider_home_not_writable".to_string())?;
    fs::remove_file(probe).map_err(|_| "provider_home_not_writable".to_string())?;
    Ok(path)
}

fn wsl_command(
    distro: &str,
    program: &str,
    args: &[&str],
) -> Result<std::process::Command, String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg(program)
        .args(args);
    Ok(command)
}

fn run_wsl(distro: &str, program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let command = wsl_command(distro, program, args)?;
    shell_resolver::output_with_timeout(command, WSL_HOME_VALIDATION_TIMEOUT)
        .map_err(|_| "provider_wsl_probe_failed".to_string())
}

fn probe_wsl_home(distro: &str) -> Result<std::process::Output, String> {
    let command = wsl_command(distro, "sh", &["-lc", "printf '%s' \"$HOME\""])?;
    shell_resolver::output_with_timeout(command, WSL_HOME_DETECT_TIMEOUT)
        .map_err(|_| "provider_wsl_probe_failed".to_string())
}

fn is_valid_linux_home_path(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() || path == "/" || !path.starts_with('/') {
        return false;
    }
    if path.contains('\0') || path.contains('\r') || path.contains('\n') {
        return false;
    }
    !path
        .split('/')
        .filter(|component| !component.is_empty())
        .any(|component| matches!(component, "." | ".."))
}

fn validate_wsl_home(raw: &str, distro: &str) -> Result<String, String> {
    if raw.contains('\0') || raw.contains('\r') || raw.contains('\n') {
        return Err("provider_home_invalid".to_string());
    }
    let (parsed_distro, linux_path) =
        wsl::parse_wsl_unc_path(raw).ok_or_else(|| "provider_home_invalid".to_string())?;
    if !parsed_distro.eq_ignore_ascii_case(distro) {
        return Err("provider_home_environment_mismatch".to_string());
    }
    if !is_valid_linux_home_path(&linux_path) {
        return Err("provider_home_invalid".to_string());
    }
    let file_name = linux_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(file_name.as_str(), ".claude" | ".codex" | ".grok") {
        return Err("provider_home_must_be_parent_directory".to_string());
    }
    let validation = run_wsl(
        distro,
        "sh",
        &[
            "-lc",
            "if [ ! -d \"$1\" ]; then exit 1; elif [ ! -r \"$1\" ]; then exit 2; elif [ ! -w \"$1\" ]; then exit 3; fi",
            "--",
            &linux_path,
        ],
    )
    .map_err(|_| "provider_wsl_probe_failed".to_string())?;
    match validation.status.code() {
        Some(0) => {}
        Some(1) => return Err("provider_home_invalid".to_string()),
        Some(2) => return Err("provider_home_not_readable".to_string()),
        Some(3) => return Err("provider_home_not_writable".to_string()),
        _ => return Err("provider_home_invalid".to_string()),
    }
    Ok(wsl::normalize_wsl_unc_path(raw))
}

fn auto_local_home() -> Result<PathBuf, String> {
    app_paths::home_dir_from_env()
}

fn auto_wsl_home(distro: &str) -> Result<String, String> {
    let output = probe_wsl_home(distro)?;
    if !output.status.success() {
        return Err("provider_home_invalid".to_string());
    }
    let linux_home = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if linux_home.is_empty() || !linux_home.starts_with('/') {
        return Err("provider_home_invalid".to_string());
    }
    Ok(wsl::linux_to_unc_wsl_path(&linux_home, distro))
}

fn build_targets(home_path: &str) -> DerivedCliTargets {
    let home = PathBuf::from(home_path);
    let claude = home.join(".claude");
    let codex = home.join(".codex");
    let grok = home.join(".grok");
    DerivedCliTargets {
        home_path: home_path.to_string(),
        claude_config_dir: claude.to_string_lossy().into_owned(),
        claude_history_root: claude.join("projects").to_string_lossy().into_owned(),
        codex_config_dir: codex.to_string_lossy().into_owned(),
        codex_history_root: codex.join("sessions").to_string_lossy().into_owned(),
        grok_config_dir: grok.to_string_lossy().into_owned(),
        grok_history_root: grok.join("sessions").to_string_lossy().into_owned(),
    }
}

fn resolve_home(input: &NormalizedHomeInput) -> Result<(String, String), String> {
    if input.environment_kind == "local" {
        let path = match input.mode.as_str() {
            "auto" => auto_local_home()?.to_string_lossy().into_owned(),
            _ => input.home_path.clone().unwrap_or_default(),
        };
        let validated = validate_local_home(&path)?;
        return Ok((validated.to_string_lossy().into_owned(), input.mode.clone()));
    }

    let path = match input.mode.as_str() {
        "auto" => auto_wsl_home(&input.environment_id)?,
        _ => input.home_path.clone().unwrap_or_default(),
    };
    Ok((
        validate_wsl_home(&path, &input.environment_id)?,
        input.mode.clone(),
    ))
}

fn state_from_input(input: &NormalizedHomeInput) -> Result<ProviderHomeState, String> {
    let (home_path, mode) = resolve_home(input)?;
    Ok(ProviderHomeState {
        identity: identity(&input.environment_kind, &input.environment_id),
        mode,
        source: if input.mode == "auto" {
            "auto".to_string()
        } else {
            "manual".to_string()
        },
        targets: build_targets(&home_path),
        home_path,
    })
}

async fn load_preference(
    environment_kind: &str,
    environment_id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT mode, home_path FROM provider_home_preferences
         WHERE environment_kind = ?1 AND environment_id = ?2",
    )
    .bind(environment_kind)
    .bind(environment_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_home_preference_read_failed".to_string())?;
    Ok(row.map(|row| {
        (
            row.try_get::<String, _>("mode")
                .unwrap_or_else(|_| "auto".to_string()),
            row.try_get::<Option<String>, _>("home_path")
                .unwrap_or(None),
        )
    }))
}

async fn persist_preference(input: &NormalizedHomeInput) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_home_preference_write_failed".to_string())?;
    sqlx::query(
        "INSERT INTO provider_home_preferences
         (environment_kind, environment_id, mode, home_path, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(environment_kind, environment_id) DO UPDATE SET
           mode = excluded.mode, home_path = excluded.home_path,
           updated_at = excluded.updated_at",
    )
    .bind(&input.environment_kind)
    .bind(&input.environment_id)
    .bind(&input.mode)
    .bind(if input.mode == "manual" {
        input.home_path.as_deref()
    } else {
        None
    })
    .bind(now_millis())
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_home_preference_write_failed".to_string())?;

    let identity = format!("{}:{}", input.environment_kind, input.environment_id);
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(ACTIVE_HOME_IDENTITY_SETTING)
    .bind(identity)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_home_preference_write_failed".to_string())?;

    transaction
        .commit()
        .await
        .map_err(|_| "provider_home_preference_write_failed".to_string())?;
    Ok(())
}

async fn load_active_identity() -> Result<Option<String>, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(ACTIVE_HOME_IDENTITY_SETTING)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_home_preference_read_failed".to_string())
}

fn parse_identity(value: &str) -> Option<(String, String)> {
    let (kind, id) = value.split_once(':')?;
    let kind = kind.trim().to_ascii_lowercase();
    let id = id.trim().to_string();
    if id.is_empty() || (kind != "local" && kind != "wsl") {
        return None;
    }
    if kind == "local" && id != LOCAL_ENVIRONMENT_ID {
        return None;
    }
    Some((kind, id))
}

fn set_active_state(state: &ProviderHomeState) -> Result<(), String> {
    cache()
        .write()
        .map_err(|_| "provider_home_cache_unavailable".to_string())?
        .insert(state.identity.identity.clone(), state.clone());
    *active_home_identity()
        .write()
        .map_err(|_| "provider_home_cache_unavailable".to_string())? =
        Some(state.identity.identity.clone());
    Ok(())
}

async fn state_for(
    environment_kind: String,
    environment_id: String,
) -> Result<ProviderHomeState, String> {
    if let Some((mode, home_path)) = load_preference(&environment_kind, &environment_id).await? {
        return state_from_input(&NormalizedHomeInput {
            environment_kind,
            environment_id,
            mode,
            home_path,
        });
    }
    state_from_input(&NormalizedHomeInput {
        environment_kind,
        environment_id,
        mode: "auto".to_string(),
        home_path: None,
    })
}

pub(crate) async fn initialize_cache() -> Result<(), String> {
    let local = state_for("local".to_string(), LOCAL_ENVIRONMENT_ID.to_string()).await?;
    let active = match load_active_identity()
        .await?
        .as_deref()
        .and_then(parse_identity)
    {
        Some((kind, id)) if kind == "local" && id == LOCAL_ENVIRONMENT_ID => Some(local.clone()),
        Some((kind, id)) => state_for(kind, id).await.ok(),
        None => None,
    }
    .unwrap_or_else(|| local.clone());
    cache()
        .write()
        .map_err(|_| "provider_home_cache_unavailable".to_string())?
        .insert(local.identity.identity.clone(), local);
    set_active_state(&active)
}

pub(crate) async fn get(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    let normalized = normalize_input(input)?;
    if let Some(state) = cached_state(&normalized.environment_kind, &normalized.environment_id) {
        return Ok(state);
    }
    let state = state_for(
        normalized.environment_kind.clone(),
        normalized.environment_id.clone(),
    )
    .await?;
    cache()
        .write()
        .map_err(|_| "provider_home_cache_unavailable".to_string())?
        .insert(state.identity.identity.clone(), state.clone());
    Ok(state)
}

pub(crate) async fn preview(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    let normalized = normalize_input(input)?;
    state_from_input(&normalized)
}

pub(crate) async fn select(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    let normalized = normalize_input(input)?;
    let state = state_from_input(&normalized)?;
    persist_preference(&normalized).await?;
    set_active_state(&state)?;
    Ok(state)
}

pub(crate) async fn reset(
    environment_kind: String,
    environment_id: Option<String>,
) -> Result<ProviderHomeState, String> {
    select(HomeSelectInput {
        environment_kind,
        environment_id,
        mode: "auto".to_string(),
        home_path: None,
    })
    .await
}

pub(crate) fn cached_state(kind: &str, id: &str) -> Option<ProviderHomeState> {
    cache()
        .read()
        .ok()
        .and_then(|values| values.get(&format!("{kind}:{id}")).cloned())
}

pub(crate) fn cached(
    environment_kind: String,
    environment_id: Option<String>,
) -> Option<ProviderHomeState> {
    let kind = environment_kind.trim().to_ascii_lowercase();
    let id = environment_id
        .unwrap_or_else(|| LOCAL_ENVIRONMENT_ID.to_string())
        .trim()
        .to_string();
    if (kind != "local" && kind != "wsl") || id.is_empty() {
        return None;
    }
    if kind == "local" && id != LOCAL_ENVIRONMENT_ID {
        return None;
    }
    cached_state(&kind, &id)
}

pub(crate) fn active() -> Result<ProviderHomeState, String> {
    active_state().ok_or_else(|| "provider_home_active_unavailable".to_string())
}

fn fallback_local_state() -> Option<ProviderHomeState> {
    let home = auto_local_home().ok()?.to_string_lossy().into_owned();
    Some(ProviderHomeState {
        identity: identity("local", LOCAL_ENVIRONMENT_ID),
        mode: "auto".to_string(),
        home_path: home.clone(),
        source: "auto".to_string(),
        targets: build_targets(&home),
    })
}

pub(crate) fn default_config_root(app_type: &str) -> Option<PathBuf> {
    let state = active_state()
        .or_else(|| cached_state("local", LOCAL_ENVIRONMENT_ID).or_else(fallback_local_state))?;
    match app_type.trim().to_ascii_lowercase().as_str() {
        "claude" => Some(PathBuf::from(state.targets.claude_config_dir)),
        "codex" => Some(PathBuf::from(state.targets.codex_config_dir)),
        "grok" | "grokbuild" => Some(PathBuf::from(state.targets.grok_config_dir)),
        _ => None,
    }
}

pub(crate) fn default_history_root(app_type: &str) -> Option<PathBuf> {
    let state = active_state()
        .or_else(|| cached_state("local", LOCAL_ENVIRONMENT_ID).or_else(fallback_local_state))?;
    match app_type.trim().to_ascii_lowercase().as_str() {
        "claude" => Some(PathBuf::from(state.targets.claude_history_root)),
        "codex" => Some(PathBuf::from(state.targets.codex_history_root)),
        "grok" | "grokbuild" => Some(PathBuf::from(state.targets.grok_history_root)),
        _ => None,
    }
}

fn active_state() -> Option<ProviderHomeState> {
    let identity = active_home_identity().read().ok()?.clone()?;
    let (kind, id) = parse_identity(&identity)?;
    cached_state(&kind, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn derives_cli_targets_from_one_home() {
        let targets = build_targets(r"C:\Users\tester");
        assert_eq!(targets.claude_config_dir, r"C:\Users\tester\.claude");
        assert_eq!(
            targets.codex_history_root,
            r"C:\Users\tester\.codex\sessions"
        );
        assert_eq!(targets.grok_config_dir, r"C:\Users\tester\.grok");
        assert_eq!(targets.grok_history_root, r"C:\Users\tester\.grok\sessions");
    }

    #[cfg(windows)]
    #[test]
    fn derives_cli_targets_from_wsl_unc_home() {
        let targets = build_targets(r"\\wsl.localhost\Ubuntu\home\tester");
        assert_eq!(
            targets.claude_config_dir,
            r"\\wsl.localhost\Ubuntu\home\tester\.claude"
        );
        assert_eq!(
            targets.codex_history_root,
            r"\\wsl.localhost\Ubuntu\home\tester\.codex\sessions"
        );
        assert_eq!(
            targets.grok_history_root,
            r"\\wsl.localhost\Ubuntu\home\tester\.grok\sessions"
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_cli_subdirectories() {
        assert_eq!(
            reject_cli_subdirectory(Path::new(r"C:\Users\tester\.claude")),
            Err("provider_home_must_be_parent_directory".to_string())
        );
    }

    #[test]
    fn normalizes_local_auto_input() {
        let value = normalize_input(HomeSelectInput {
            environment_kind: "local".to_string(),
            environment_id: None,
            mode: "auto".to_string(),
            home_path: None,
        })
        .unwrap();
        assert_eq!(value.environment_id, LOCAL_ENVIRONMENT_ID);
        assert_eq!(value.mode, "auto");
    }

    #[test]
    fn local_environment_always_uses_host_identity() {
        let value = normalize_input(HomeSelectInput {
            environment_kind: "local".to_string(),
            environment_id: Some("Ubuntu".to_string()),
            mode: "auto".to_string(),
            home_path: None,
        })
        .unwrap();
        assert_eq!(value.environment_id, LOCAL_ENVIRONMENT_ID);
    }

    #[test]
    fn parses_default_wsl_context_from_probe_output() {
        let (distro, home) = parse_default_wsl_context(b"Ubuntu-22.04\n/home/tester").unwrap();
        assert_eq!(distro, "Ubuntu-22.04");
        assert_eq!(home, "/home/tester");
        assert_eq!(
            parse_default_wsl_context(b"Ubuntu-22.04\n/"),
            Err("provider_wsl_probe_failed".to_string())
        );
    }

    #[test]
    fn parses_wsl_distro_list_output() {
        assert_eq!(
            parse_wsl_distros(b"Ubuntu\r\nDebian\r\nUbuntu\r\n"),
            vec!["Ubuntu", "Debian", "Ubuntu"]
        );
    }

    #[test]
    fn parses_utf16_wsl_distro_list_output() {
        let mut output = vec![0xff, 0xfe];
        output.extend(
            "Ubuntu\r\nDebian\r\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        );
        assert_eq!(parse_wsl_distros(&output), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn keeps_cold_start_detection_separate_from_fast_validation() {
        assert!(WSL_HOME_DETECT_TIMEOUT >= Duration::from_secs(15));
        assert!(WSL_HOME_VALIDATION_TIMEOUT < WSL_HOME_DETECT_TIMEOUT);
    }

    #[test]
    fn infers_wsl_environment_from_manual_unc_home() {
        let value = normalize_input(HomeSelectInput {
            environment_kind: "wsl".to_string(),
            environment_id: Some(LOCAL_ENVIRONMENT_ID.to_string()),
            mode: "manual".to_string(),
            home_path: Some(r"\\wsl.localhost\Ubuntu-22.04\home\tester".to_string()),
        })
        .unwrap();
        assert_eq!(value.environment_id, "Ubuntu-22.04");
    }

    #[test]
    fn rejects_invalid_manual_home_inputs() {
        assert_eq!(
            normalize_input(HomeSelectInput {
                environment_kind: "local".to_string(),
                environment_id: None,
                mode: "manual".to_string(),
                home_path: Some("relative".to_string()),
            })
            .and_then(|input| resolve_home(&input).map(|_| ())),
            Err("provider_home_invalid".to_string())
        );
        assert_eq!(
            normalize_input(HomeSelectInput {
                environment_kind: "wsl".to_string(),
                environment_id: Some("Ubuntu".to_string()),
                mode: "manual".to_string(),
                home_path: Some(r"\\wsl.localhost\OtherDistro\home\tester".to_string(),),
            })
            .and_then(|input| resolve_home(&input).map(|_| ())),
            Err("provider_home_environment_mismatch".to_string())
        );
    }

    #[test]
    fn rejects_file_as_local_home() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("not-a-directory");
        fs::write(&file, b"x").unwrap();
        assert_eq!(
            validate_local_home(file.to_string_lossy().as_ref()),
            Err("provider_home_invalid".to_string())
        );
    }

    #[test]
    fn rejects_wsl_unc_path_as_local_home() {
        assert_eq!(
            validate_local_home(r"\\wsl.localhost\Ubuntu\home\tester"),
            Err("provider_home_environment_mismatch".to_string())
        );
    }

    #[test]
    fn validates_linux_home_paths_without_host_path_rules() {
        assert!(is_valid_linux_home_path("/home/tester"));
        assert!(!is_valid_linux_home_path("relative/home"));
        assert!(!is_valid_linux_home_path("/home/../root"));
        assert!(!is_valid_linux_home_path("/home/./tester"));
        assert!(!is_valid_linux_home_path("/home/te\nster"));
    }

    #[test]
    fn parses_only_supported_home_identities() {
        assert_eq!(
            parse_identity("local:host"),
            Some(("local".to_string(), "host".to_string()))
        );
        assert_eq!(
            parse_identity("wsl:Ubuntu"),
            Some(("wsl".to_string(), "Ubuntu".to_string()))
        );
        assert_eq!(parse_identity("local:other"), None);
        assert_eq!(parse_identity("unsupported:host"), None);
        assert_eq!(parse_identity("wsl:"), None);
    }
}
