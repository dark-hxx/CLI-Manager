use super::global;
use super::global::HomeIdentityInput;
use super::home::{self, ProviderHomeState};
use crate::{shell_resolver, wsl};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentInspectInput {
    pub app_type: Option<String>,
    pub home_identity: HomeIdentityInput,
    pub home_input: Option<super::home::HomeSelectInput>,
    pub configured_roots: Option<EnvironmentRootOverrides>,
    pub history_roots: Option<EnvironmentRootOverrides>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentRootOverrides {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub grok: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliEnvironmentStatus {
    pub name: String,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetEnvironmentStatus {
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub readable: bool,
    pub writable: bool,
    pub syntax: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentConflict {
    pub variable: String,
    pub present: bool,
    pub matches_home: bool,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurrentProviderStatus {
    pub provider_id: Option<String>,
    pub provider_name: Option<String>,
    pub present: bool,
    pub active_key_present: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeAlignmentStatus {
    pub source: String,
    pub claude_history_root: String,
    pub codex_history_root: String,
    pub grok_history_root: String,
    pub claude_hook_root: String,
    pub codex_hook_root: String,
    pub grok_hook_root: String,
    pub explicit_roots: Vec<String>,
    pub automatic_roots_aligned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentReport {
    pub home: ProviderHomeState,
    pub cli: Vec<CliEnvironmentStatus>,
    pub targets: Vec<TargetEnvironmentStatus>,
    pub current_provider: CurrentProviderStatus,
    pub conflicts: Vec<EnvironmentConflict>,
    pub alignment: HomeAlignmentStatus,
    pub pending_recovery: bool,
}

fn normalize_type(value: Option<&str>) -> Result<Option<String>, String> {
    value
        .map(crate::provider::repository::normalize_app_type)
        .transpose()
}

fn mask_fingerprint(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

fn command_output(command: Command) -> Option<std::process::Output> {
    shell_resolver::output_with_timeout(command, PROBE_TIMEOUT).ok()
}

#[cfg(target_os = "windows")]
fn wsl_target_test(distro: &str, test: &str, linux_path: &str) -> Result<bool, String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command.args(["-d", distro, "--exec", "test", test, linux_path]);
    shell_resolver::output_with_timeout(command, PROBE_TIMEOUT)
        .map(|output| output.status.success())
        .map_err(|_| "provider_environment_open_failed".to_string())
}

#[cfg(target_os = "windows")]
fn open_wsl_target(
    path: &str,
    distro: &str,
    linux_path: &str,
    open_file: bool,
) -> Result<(), String> {
    if !wsl_target_test(distro, "-e", linux_path)? {
        return Err("provider_environment_open_failed".to_string());
    }
    let is_file = wsl_target_test(distro, "-f", linux_path)?;
    let normalized = wsl::normalize_wsl_unc_path(path);
    let mut command = Command::new("explorer.exe");
    if is_file && !open_file {
        command.args(["/select,", &normalized]);
    } else {
        command.arg(&normalized);
    }
    command
        .spawn()
        .map_err(|_| "provider_environment_open_failed".to_string())?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn open_wsl_target(
    _path: &str,
    _distro: &str,
    _linux_path: &str,
    _open_file: bool,
) -> Result<(), String> {
    Err("provider_environment_open_failed".to_string())
}

pub(crate) async fn open_target(path: String, open_file: Option<bool>) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("provider_environment_open_failed".to_string());
    }
    if let Some((distro, linux_path)) = wsl::parse_wsl_unc_path(path) {
        return open_wsl_target(path, &distro, &linux_path, open_file.unwrap_or(false));
    }
    crate::commands::shell::open_folder_in_explorer(path.to_string(), open_file).await
}

fn local_cli(name: &str) -> CliEnvironmentStatus {
    let mut where_command =
        shell_resolver::silent_command(if cfg!(windows) { "where.exe" } else { "which" });
    where_command.arg(name);
    let executable = command_output(where_command)
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string)
        });
    let version = executable.as_deref().and_then(|path| {
        let mut command = shell_resolver::silent_command(path);
        command.arg("--version");
        command_output(command)
            .filter(|output| output.status.success())
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .map(str::to_string)
            })
    });
    CliEnvironmentStatus {
        name: name.to_string(),
        available: executable.is_some(),
        executable,
        version,
    }
}

fn wsl_cli(name: &str, distro: &str) -> CliEnvironmentStatus {
    let probe = wsl::find_wsl_exe().and_then(|exe| {
        let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
        let script = format!("command -v {name}; {name} --version 2>/dev/null | head -n 1");
        command.args(["-d", distro, "--exec", "sh", "-lc", &script]);
        command_output(command).and_then(|output| {
            if !output.status.success() {
                return None;
            }
            let output_text = String::from_utf8_lossy(&output.stdout);
            let mut lines = output_text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty());
            let executable = lines.next()?.to_string();
            let version = lines.next().map(str::to_string);
            Some((executable, version))
        })
    });
    CliEnvironmentStatus {
        name: name.to_string(),
        available: probe.is_some(),
        executable: probe.as_ref().map(|(value, _)| value.clone()),
        version: probe.and_then(|(_, version)| version),
    }
}

#[cfg(target_os = "windows")]
fn wsl_environment_value(distro: &str, variable: &str) -> Option<String> {
    let exe = wsl::find_wsl_exe()?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command.args(["-d", distro, "--exec", "printenv", variable]);
    command_output(command)
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "windows"))]
fn wsl_environment_value(_distro: &str, _variable: &str) -> Option<String> {
    None
}

fn json_syntax(bytes: Option<&[u8]>) -> String {
    let Some(bytes) = bytes else {
        return "missing".to_string();
    };
    match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(value) if value.is_object() => "valid".to_string(),
        Ok(_) => "invalid_root".to_string(),
        Err(_) => "invalid".to_string(),
    }
}

fn toml_syntax(bytes: Option<&[u8]>) -> String {
    let Some(bytes) = bytes else {
        return "missing".to_string();
    };
    let Ok(raw) = std::str::from_utf8(bytes) else {
        return "invalid".to_string();
    };
    if raw.trim().is_empty() {
        "valid".to_string()
    } else if raw.parse::<toml_edit::DocumentMut>().is_ok() {
        "valid".to_string()
    } else {
        "invalid".to_string()
    }
}

fn target_status(name: &str, path: &str, is_toml: bool) -> TargetEnvironmentStatus {
    match global::read_live(path) {
        Ok(bytes) => TargetEnvironmentStatus {
            name: name.to_string(),
            path: path.to_string(),
            exists: bytes.is_some(),
            readable: bytes.is_some(),
            writable: global::target_writable(path),
            syntax: if is_toml {
                toml_syntax(bytes.as_deref())
            } else {
                json_syntax(bytes.as_deref())
            },
            fingerprint: bytes
                .as_deref()
                .map(|bytes| format!("sha256:{:x}", Sha256::digest(bytes)))
                .unwrap_or_else(|| "missing".to_string()),
        },
        Err(_) => TargetEnvironmentStatus {
            name: name.to_string(),
            path: path.to_string(),
            exists: true,
            readable: false,
            writable: global::target_writable(path),
            syntax: "unreadable".to_string(),
            fingerprint: "unavailable".to_string(),
        },
    }
}

async fn current_provider(app_type: Option<&str>) -> Result<CurrentProviderStatus, String> {
    let Some(app_type) = app_type else {
        return Ok(CurrentProviderStatus {
            provider_id: None,
            provider_name: None,
            present: false,
            active_key_present: false,
        });
    };
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, name FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1",
    )
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    let Some(row) = row else {
        return Ok(CurrentProviderStatus {
            provider_id: None,
            provider_name: None,
            present: false,
            active_key_present: false,
        });
    };
    let provider_id = row
        .try_get::<String, _>("id")
        .map_err(|_| "provider_database_error".to_string())?;
    let provider_name = row
        .try_get::<String, _>("name")
        .map_err(|_| "provider_database_error".to_string())?;
    let key_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2 AND is_active = 1 AND enabled = 1",
    )
    .bind(&provider_id)
    .bind(app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    Ok(CurrentProviderStatus {
        provider_id: Some(provider_id),
        provider_name: Some(provider_name),
        present: true,
        active_key_present: key_count > 0,
    })
}

fn conflicts(home: &ProviderHomeState) -> Vec<EnvironmentConflict> {
    let expected = [
        ("CLAUDE_CONFIG_DIR", &home.targets.claude_config_dir),
        ("CODEX_HOME", &home.targets.codex_config_dir),
        ("GROK_HOME", &home.targets.grok_config_dir),
    ];
    if home.identity.environment_kind == "wsl" {
        return expected
            .into_iter()
            .filter_map(|(variable, expected)| {
                let (_, expected_linux) = wsl::parse_wsl_unc_path(expected)?;
                let value = wsl_environment_value(&home.identity.environment_id, variable);
                let present = value.is_some();
                let matches_home = value
                    .as_deref()
                    .map(|value| value.trim() == expected_linux)
                    .unwrap_or(true);
                Some(EnvironmentConflict {
                    variable: variable.to_string(),
                    present,
                    matches_home,
                    fingerprint: value.as_deref().map(mask_fingerprint),
                })
            })
            .collect();
    }
    expected
        .into_iter()
        .map(|(variable, expected)| {
            let value = std::env::var(variable).ok();
            let matches_home = value
                .as_deref()
                .map(|value| value.trim().eq_ignore_ascii_case(expected))
                .unwrap_or(true);
            EnvironmentConflict {
                variable: variable.to_string(),
                present: value.is_some(),
                matches_home,
                fingerprint: value.as_deref().map(mask_fingerprint),
            }
        })
        .collect()
}

fn configured_root(overrides: Option<&EnvironmentRootOverrides>, app_type: &str) -> Option<String> {
    let value = match app_type {
        "claude" => overrides.and_then(|value| value.claude.as_deref()),
        "codex" => overrides.and_then(|value| value.codex.as_deref()),
        "grokbuild" => overrides.and_then(|value| value.grok.as_deref()),
        _ => None,
    }?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn history_root(config_root: &str, app_type: &str) -> String {
    PathBuf::from(config_root)
        .join(match app_type {
            "claude" => "projects",
            "codex" => "sessions",
            "grokbuild" => "sessions",
            _ => "history",
        })
        .to_string_lossy()
        .into_owned()
}

fn paths_match(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn explicit_or_default(
    overrides: Option<&EnvironmentRootOverrides>,
    app_type: &str,
    default: &str,
    history: bool,
    explicit_roots: &mut Vec<String>,
    root_name: &str,
) -> String {
    let Some(config_root) = configured_root(overrides, app_type) else {
        return default.to_string();
    };
    explicit_roots.push(root_name.to_string());
    if history {
        history_root(&config_root, app_type)
    } else {
        config_root
    }
}

fn configured_matches(
    overrides: Option<&EnvironmentRootOverrides>,
    app_type: &str,
    expected: &str,
) -> bool {
    configured_root(overrides, app_type)
        .map(|value| paths_match(&value, expected))
        .unwrap_or(true)
}

fn configured_history_root(
    overrides: Option<&EnvironmentRootOverrides>,
    app_type: &str,
) -> Option<String> {
    let value = configured_root(overrides, app_type)?;
    if app_type == "grokbuild" {
        Some(value)
    } else {
        Some(history_root(&value, app_type))
    }
}

fn history_matches(
    overrides: Option<&EnvironmentRootOverrides>,
    app_type: &str,
    expected: &str,
) -> bool {
    configured_history_root(overrides, app_type)
        .map(|value| paths_match(&value, expected))
        .unwrap_or(true)
}

fn alignment(
    home: &ProviderHomeState,
    configured_roots: Option<&EnvironmentRootOverrides>,
    history_roots: Option<&EnvironmentRootOverrides>,
) -> HomeAlignmentStatus {
    let mut explicit_roots = Vec::new();
    let claude_hook_root = explicit_or_default(
        configured_roots,
        "claude",
        &home.targets.claude_config_dir,
        false,
        &mut explicit_roots,
        "claudeHook",
    );
    let codex_hook_root = explicit_or_default(
        configured_roots,
        "codex",
        &home.targets.codex_config_dir,
        false,
        &mut explicit_roots,
        "codexHook",
    );
    let grok_hook_root = explicit_or_default(
        configured_roots,
        "grokbuild",
        &home.targets.grok_config_dir,
        false,
        &mut explicit_roots,
        "grokHook",
    );
    let claude_history_root = explicit_or_default(
        history_roots,
        "claude",
        &home.targets.claude_history_root,
        true,
        &mut explicit_roots,
        "claudeHistory",
    );
    let codex_history_root = explicit_or_default(
        history_roots,
        "codex",
        &home.targets.codex_history_root,
        true,
        &mut explicit_roots,
        "codexHistory",
    );
    let grok_history_root = configured_history_root(history_roots, "grokbuild")
        .map(|value| {
            explicit_roots.push("grokHistory".to_string());
            value
        })
        .unwrap_or_else(|| home.targets.grok_history_root.clone());
    HomeAlignmentStatus {
        source: home.source.clone(),
        claude_history_root,
        codex_history_root,
        grok_history_root,
        claude_hook_root,
        codex_hook_root,
        grok_hook_root,
        explicit_roots,
        automatic_roots_aligned: configured_matches(
            configured_roots,
            "claude",
            &home.targets.claude_config_dir,
        ) && configured_matches(
            configured_roots,
            "codex",
            &home.targets.codex_config_dir,
        ) && configured_matches(
            configured_roots,
            "grokbuild",
            &home.targets.grok_config_dir,
        ) && history_matches(
            history_roots,
            "claude",
            &home.targets.claude_history_root,
        ) && history_matches(
            history_roots,
            "codex",
            &home.targets.codex_history_root,
        ) && history_matches(
            history_roots,
            "grokbuild",
            &home.targets.grok_history_root,
        ),
    }
}

pub(crate) async fn inspect(input: EnvironmentInspectInput) -> Result<EnvironmentReport, String> {
    let home = match input.home_input {
        Some(home_input) => home::preview(home_input).await?,
        None => {
            home::get(home::HomeSelectInput {
                environment_kind: input.home_identity.environment_kind.clone(),
                environment_id: input.home_identity.environment_id.clone(),
                mode: "auto".to_string(),
                home_path: None,
            })
            .await?
        }
    };
    let app_type = normalize_type(input.app_type.as_deref())?;
    let cli_names = ["claude", "codex", "grok"];
    let cli = if home.identity.environment_kind == "wsl" {
        cli_names
            .iter()
            .map(|name| wsl_cli(name, &home.identity.environment_id))
            .collect()
    } else {
        cli_names.iter().map(|name| local_cli(name)).collect()
    };
    let mut targets = Vec::new();
    if app_type.as_deref().is_none() || app_type.as_deref() == Some("claude") {
        let path = format!("{}\\settings.json", home.targets.claude_config_dir);
        targets.push(target_status("claude.settings", &path, false));
    }
    if app_type.as_deref().is_none() || app_type.as_deref() == Some("codex") {
        let auth = format!("{}\\auth.json", home.targets.codex_config_dir);
        let config = format!("{}\\config.toml", home.targets.codex_config_dir);
        targets.push(target_status("codex.auth", &auth, false));
        targets.push(target_status("codex.config", &config, true));
    }
    if app_type.as_deref().is_none() || app_type.as_deref() == Some("grokbuild") {
        let path = format!("{}\\config.toml", home.targets.grok_config_dir);
        targets.push(target_status("grokbuild.config", &path, true));
    }
    let current = current_provider(app_type.as_deref()).await?;
    let pending_recovery = if let Some(app_type) = app_type.as_deref() {
        global::pending_journal(app_type, &home.identity.identity).await?
    } else {
        false
    };
    let conflicts = conflicts(&home);
    Ok(EnvironmentReport {
        alignment: alignment(
            &home,
            input.configured_roots.as_ref(),
            input.history_roots.as_ref(),
        ),
        home,
        cli,
        targets,
        current_provider: current,
        conflicts,
        pending_recovery,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_home() -> ProviderHomeState {
        let home = PathBuf::from(r"C:\Users\tester");
        let claude = home.join(".claude");
        let codex = home.join(".codex");
        let grok = home.join(".grok");
        ProviderHomeState {
            identity: super::home::HomeIdentity {
                environment_kind: "local".to_string(),
                environment_id: "host".to_string(),
                identity: "local:host".to_string(),
            },
            mode: "auto".to_string(),
            home_path: home.to_string_lossy().into_owned(),
            source: "auto".to_string(),
            targets: super::home::DerivedCliTargets {
                home_path: home.to_string_lossy().into_owned(),
                claude_config_dir: claude.to_string_lossy().into_owned(),
                claude_history_root: claude.join("projects").to_string_lossy().into_owned(),
                codex_config_dir: codex.to_string_lossy().into_owned(),
                codex_history_root: codex.join("sessions").to_string_lossy().into_owned(),
                grok_config_dir: grok.to_string_lossy().into_owned(),
                grok_history_root: grok.join("sessions").to_string_lossy().into_owned(),
            },
        }
    }

    #[test]
    fn normalize_type_rejects_unknown_app_type() {
        let error = normalize_type(Some("unknown")).unwrap_err();
        assert_eq!(error, "provider_invalid_app_type:unknown");
    }

    #[test]
    fn normalize_type_keeps_unfiltered_inspection_explicit() {
        assert_eq!(normalize_type(None).unwrap(), None);
        assert_eq!(
            normalize_type(Some("grok")).unwrap(),
            Some("grokbuild".to_string())
        );
    }

    #[test]
    fn alignment_defaults_to_selected_home_targets() {
        let home = sample_home();
        let result = alignment(&home, None, None);

        assert_eq!(result.claude_hook_root, home.targets.claude_config_dir);
        assert_eq!(result.codex_hook_root, home.targets.codex_config_dir);
        assert_eq!(result.grok_hook_root, home.targets.grok_config_dir);
        assert_eq!(result.claude_history_root, home.targets.claude_history_root);
        assert_eq!(result.codex_history_root, home.targets.codex_history_root);
        assert_eq!(result.grok_history_root, home.targets.grok_history_root);
        assert!(result.explicit_roots.is_empty());
        assert!(result.automatic_roots_aligned);
    }

    #[test]
    fn alignment_keeps_explicit_hook_and_history_roots_independent() {
        let home = sample_home();
        let configured_roots = EnvironmentRootOverrides {
            claude: Some(r"C:\legacy\.claude".to_string()),
            codex: None,
            grok: None,
        };
        let history_roots = EnvironmentRootOverrides {
            claude: Some(r"C:\legacy\.claude".to_string()),
            codex: None,
            grok: Some(r"C:\legacy\.grok\sessions".to_string()),
        };

        let result = alignment(&home, Some(&configured_roots), Some(&history_roots));

        assert_eq!(result.claude_hook_root, r"C:\legacy\.claude");
        assert_eq!(
            result.claude_history_root,
            PathBuf::from(r"C:\legacy\.claude")
                .join("projects")
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(result.grok_history_root, r"C:\legacy\.grok\sessions");
        assert!(result
            .explicit_roots
            .iter()
            .any(|root| root == "claudeHook"));
        assert!(result
            .explicit_roots
            .iter()
            .any(|root| root == "claudeHistory"));
        assert!(result
            .explicit_roots
            .iter()
            .any(|root| root == "grokHistory"));
        assert!(!result.automatic_roots_aligned);
    }
}
