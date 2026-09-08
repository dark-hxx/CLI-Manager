mod live_files;
pub(crate) use live_files::{create_live_dir_all, live_is_dir, live_is_file};
pub(crate) use live_files::{read_live, remove_live, target_writable, write_live};
use live_files::{read_live_many, run_wsl, target_writable_many, write_live_many};
mod materialize;
use materialize::{
    ensure_codex_provider_mapping, json_bytes, parse_json_object, settings_config, toml_document,
};
pub(crate) use materialize::{
    materialize_claude, materialize_codex_auth, materialize_codex_config,
    materialize_grok_global_config,
};

use super::home::{self, HomeIdentity, HomeSelectInput, ProviderHomeState};
use crate::{app_paths, wsl};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use toml_edit::Item;
use uuid::Uuid;

const WSL_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const CLAUDE_SETTINGS_FILE: &str = "settings.json";
const CODEX_AUTH_FILE: &str = "auth.json";
const CODEX_CONFIG_FILE: &str = "config.toml";
const GROK_CONFIG_FILE: &str = "config.toml";
const CODEX_DEFAULT_PROVIDER_NAME: &str = "cli_manager";

const CLAUDE_OWNED_ENV_KEYS: [&str; 14] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];
const CODEX_OWNED_AUTH_KEYS: [&str; 2] = ["OPENAI_API_KEY", "api_key"];
const CODEX_OWNED_CONFIG_KEYS: [&str; 3] = ["model", "model_provider", "model_providers"];
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeIdentityInput {
    pub environment_kind: String,
    pub environment_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalPreviewInput {
    pub app_type: String,
    pub provider_id: String,
    pub home_identity: HomeIdentityInput,
    #[serde(default)]
    pub projection: Option<LocalRouteProjection>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalApplyInput {
    pub app_type: String,
    pub provider_id: String,
    pub home_identity: HomeIdentityInput,
    pub preview_fingerprint: String,
    #[serde(default)]
    pub projection: Option<LocalRouteProjection>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalRouteProjection {
    pub endpoint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProjectionMode {
    Direct,
    LocalRoute(LocalRouteProjection),
}

fn projection_mode(projection: Option<&LocalRouteProjection>) -> ProjectionMode {
    projection.map_or(ProjectionMode::Direct, |value| {
        ProjectionMode::LocalRoute(value.clone())
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalCurrentInput {
    pub app_type: String,
    pub home_identity: HomeIdentityInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalTargetPreview {
    pub target: String,
    pub path: String,
    pub exists: bool,
    pub live_fingerprint: String,
    pub desired_fingerprint: String,
    pub changed: bool,
    pub action: String,
    pub owned_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalPreview {
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    pub home: ProviderHomeState,
    pub fingerprint: String,
    pub targets: Vec<GlobalTargetPreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalApplyResult {
    pub app_type: String,
    pub provider_id: String,
    pub home_identity: HomeIdentity,
    pub journal_id: String,
    pub state: String,
    pub changed_targets: Vec<String>,
    pub verified_fingerprints: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalCurrent {
    pub app_type: String,
    pub home: ProviderHomeState,
    pub provider_id: Option<String>,
    pub provider_name: Option<String>,
    pub active_key_present: bool,
    pub state: String,
    pub pending_recovery: bool,
    pub targets: Vec<GlobalTargetPreview>,
}

#[derive(Debug, Clone)]
struct ProviderPlan {
    app_type: String,
    provider_id: String,
    provider_name: String,
    source_signature: String,
    home: ProviderHomeState,
    targets: Vec<PlannedTarget>,
}

#[derive(Debug, Clone)]
struct PreviewPlanCacheEntry {
    key: String,
    fingerprint: String,
    plan: ProviderPlan,
    created_at: Instant,
}

#[derive(Debug, Clone)]
struct CurrentCandidate {
    id: String,
    name: String,
    is_current: bool,
    active_key_present: bool,
}

#[derive(Debug, Clone)]
struct PlannedTarget {
    target: String,
    path: String,
    before: Option<Vec<u8>>,
    desired: Vec<u8>,
    owned_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalTarget {
    target: String,
    backup_path: Option<String>,
    stage_path: String,
    existed: bool,
}

struct ApplyLock {
    key: String,
}

static APPLY_LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static PREVIEW_PLAN_CACHE: OnceLock<Mutex<Vec<PreviewPlanCacheEntry>>> = OnceLock::new();
const PREVIEW_PLAN_CACHE_TTL: Duration = Duration::from_secs(30);

fn acquire_apply_lock(app_type: &str, home_identity: &str) -> Result<ApplyLock, String> {
    let locks = APPLY_LOCKS.get_or_init(|| Mutex::new(HashSet::new()));
    let key = format!("{app_type}:{home_identity}");
    let mut values = locks
        .lock()
        .map_err(|_| "provider_apply_lock_unavailable".to_string())?;
    if !values.insert(key.clone()) {
        return Err("provider_apply_busy".to_string());
    }
    Ok(ApplyLock { key })
}

impl Drop for ApplyLock {
    fn drop(&mut self) {
        if let Some(locks) = APPLY_LOCKS.get() {
            if let Ok(mut values) = locks.lock() {
                values.remove(&self.key);
            }
        }
    }
}

enum LivePath {
    Local(PathBuf),
    Wsl { distro: String, linux_path: String },
}

fn normalize_type(value: &str) -> Result<String, String> {
    crate::provider::repository::normalize_app_type(value)
}

fn home_input(identity: &HomeIdentityInput) -> HomeSelectInput {
    HomeSelectInput {
        environment_kind: identity.environment_kind.clone(),
        environment_id: identity.environment_id.clone(),
        mode: "auto".to_string(),
        home_path: None,
    }
}

fn target_path(home: &ProviderHomeState, app_type: &str, name: &str) -> String {
    let root = match app_type {
        "claude" => &home.targets.claude_config_dir,
        "codex" => &home.targets.codex_config_dir,
        _ => &home.targets.grok_config_dir,
    };
    PathBuf::from(root)
        .join(name)
        .to_string_lossy()
        .into_owned()
}

fn live_path(path: &str) -> LivePath {
    if let Some((distro, linux_path)) = wsl::parse_wsl_unc_path(path) {
        LivePath::Wsl { distro, linux_path }
    } else {
        LivePath::Local(PathBuf::from(path))
    }
}

fn fingerprint(bytes: Option<&[u8]>) -> String {
    let Some(bytes) = bytes else {
        return "missing".to_string();
    };
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn aggregate_fingerprint(values: &BTreeMap<String, String>) -> String {
    let raw = serde_json::to_vec(values).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(raw))
}

struct ProviderSource {
    id: String,
    name: String,
    settings_config: String,
    meta: String,
    active_key: String,
}

async fn load_source(app_type: &str, provider_id: &str) -> Result<ProviderSource, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, name, settings_config, meta
         FROM providers WHERE id = ?1 AND app_type = ?2",
    )
    .bind(provider_id.trim())
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .ok_or_else(|| "provider_not_found".to_string())?;

    let id = row
        .try_get::<String, _>("id")
        .map_err(|_| "provider_database_error".to_string())?;
    let name = row
        .try_get::<String, _>("name")
        .map_err(|_| "provider_database_error".to_string())?;
    let settings_config = row
        .try_get::<String, _>("settings_config")
        .map_err(|_| "provider_database_error".to_string())?;
    let meta = row
        .try_get::<String, _>("meta")
        .map_err(|_| "provider_database_error".to_string())?;
    if !crate::provider::repository::meta_enabled(&crate::provider::repository::parse_meta(&meta)) {
        return Err("provider_not_ready".to_string());
    }
    let active_key = sqlx::query(
        "SELECT api_key FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2 AND is_active = 1 AND enabled = 1
         LIMIT 1",
    )
    .bind(&id)
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .and_then(|row| row.try_get::<String, _>("api_key").ok())
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| "provider_key_not_active".to_string())?;

    Ok(ProviderSource {
        id,
        name,
        settings_config,
        meta,
        active_key,
    })
}

async fn effective_settings(
    connection: &mut sqlx::SqliteConnection,
    app_type: &str,
    source: &ProviderSource,
) -> Result<Value, String> {
    let common = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(format!("common_config_{app_type}"))
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| "provider_database_error".to_string())?
        .unwrap_or_default();
    let meta = crate::provider::repository::parse_meta(&source.meta);
    let merged = if crate::provider::repository::meta_common_config_enabled(&meta) {
        crate::provider::repository::merge_common_into_settings(
            app_type,
            &common,
            &source.settings_config,
        )?
    } else {
        source.settings_config.clone()
    };
    let projected = crate::provider::repository::project_key_into_settings(
        app_type,
        &merged,
        &source.active_key,
    )?;
    settings_config(&projected)
}

fn source_signature(source: &ProviderSource, effective: &Value) -> String {
    let raw = serde_json::to_vec(&(
        &source.id,
        &source.name,
        &source.settings_config,
        &source.meta,
        &source.active_key,
        effective,
    ))
    .unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(raw))
}

async fn build_plan(input: &GlobalPreviewInput) -> Result<ProviderPlan, String> {
    build_plan_with_mode(input, projection_mode(input.projection.as_ref())).await
}

async fn build_plan_with_mode(
    input: &GlobalPreviewInput,
    mode: ProjectionMode,
) -> Result<ProviderPlan, String> {
    let app_type = normalize_type(&input.app_type)?;
    let provider_id = input.provider_id.trim();
    if provider_id.is_empty() {
        return Err("provider_id_required".to_string());
    }
    let home = home::get(home_input(&input.home_identity)).await?;
    let source = load_source(&app_type, provider_id).await?;
    let mut connection = crate::provider::database::open_connection().await?;
    let effective = effective_settings(&mut connection, &app_type, &source).await?;

    let specs: Vec<(&str, &str)> = match app_type.as_str() {
        "claude" => vec![("claude.settings", CLAUDE_SETTINGS_FILE)],
        "codex" => vec![
            ("codex.auth", CODEX_AUTH_FILE),
            ("codex.config", CODEX_CONFIG_FILE),
        ],
        "grokbuild" => vec![("grokbuild.config", GROK_CONFIG_FILE)],
        _ => return Err("provider_invalid_app_type".to_string()),
    };
    let target_specs = specs
        .into_iter()
        .map(|(target, name)| (target.to_string(), target_path(&home, &app_type, name)))
        .collect::<Vec<_>>();
    let paths = target_specs
        .iter()
        .map(|(_, path)| path.clone())
        .collect::<Vec<_>>();
    let before_values = read_live_many(&paths)?;
    let mut targets = Vec::with_capacity(target_specs.len());
    for ((target, path), before) in target_specs.into_iter().zip(before_values) {
        let (desired, owned_fields) = match (app_type.as_str(), target.as_str()) {
            ("claude", _) => materialize_claude(before.as_deref(), &effective, &source.active_key)?,
            ("codex", "codex.auth") => {
                materialize_codex_auth(before.as_deref(), &effective, &source.active_key)?
            }
            ("codex", "codex.config") => materialize_codex_config(before.as_deref(), &effective)?,
            ("grokbuild", _) => {
                materialize_grok_global_config(before.as_deref(), &effective, &source.active_key)?
            }
            _ => return Err("provider_invalid_app_type".to_string()),
        };
        targets.push(PlannedTarget {
            target: target.to_string(),
            path,
            before,
            desired,
            owned_fields,
        });
    }
    let source_signature = source_signature(&source, &effective);
    let mut plan = ProviderPlan {
        app_type,
        provider_id: source.id,
        provider_name: source.name,
        source_signature,
        home,
        targets,
    };
    if let ProjectionMode::LocalRoute(projection) = mode {
        apply_local_route_projection(&mut plan, &projection)?;
    }
    Ok(plan)
}

const ROUTED_CREDENTIAL_SENTINEL: &str = "CLI_MANAGER_ROUTED";

fn route_endpoint_with_suffix(endpoint: &str, suffix: &str) -> Result<String, String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    let port = endpoint
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .filter(|port| *port >= 1_024)
        .ok_or_else(|| "routing_endpoint_invalid".to_string())?;
    let host = endpoint
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or_default();
    let is_loopback =
        host == "http://127.0.0.1" || host == "http://localhost" || host == "http://[::1]";
    let is_ipv4_gateway = host
        .strip_prefix("http://")
        .and_then(|value| value.parse::<std::net::Ipv4Addr>().ok())
        .is_some_and(|address| {
            !address.is_unspecified() && !address.is_loopback() && !address.is_multicast()
        });
    if !is_loopback && !is_ipv4_gateway {
        return Err("routing_endpoint_invalid".to_string());
    }
    Ok(format!("{host}:{port}{suffix}"))
}

fn apply_local_route_projection(
    plan: &mut ProviderPlan,
    projection: &LocalRouteProjection,
) -> Result<(), String> {
    let endpoint = route_endpoint_with_suffix(&projection.endpoint, "")?;
    let codex_endpoint = route_endpoint_with_suffix(&projection.endpoint, "/v1")?;
    for target in &mut plan.targets {
        target.desired = match target.target.as_str() {
            "claude.settings" => {
                let mut root = parse_json_object(Some(&target.desired))?;
                let mut env = root
                    .remove("env")
                    .unwrap_or_else(|| Value::Object(Map::new()))
                    .as_object()
                    .cloned()
                    .ok_or_else(|| "provider_config_invalid".to_string())?;
                env.insert(
                    "ANTHROPIC_BASE_URL".to_string(),
                    Value::String(endpoint.clone()),
                );
                env.insert(
                    "ANTHROPIC_API_KEY".to_string(),
                    Value::String(ROUTED_CREDENTIAL_SENTINEL.to_string()),
                );
                env.remove("ANTHROPIC_AUTH_TOKEN");
                root.insert("env".to_string(), Value::Object(env));
                json_bytes(root)?
            }
            "codex.auth" => {
                let mut root = parse_json_object(Some(&target.desired))?;
                for key in CODEX_OWNED_AUTH_KEYS {
                    root.remove(key);
                }
                root.insert(
                    "OPENAI_API_KEY".to_string(),
                    Value::String(ROUTED_CREDENTIAL_SENTINEL.to_string()),
                );
                json_bytes(root)?
            }
            "codex.config" => {
                let mut document = toml_document(Some(&target.desired))?;
                let provider_name = document
                    .get("model_provider")
                    .and_then(Item::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(CODEX_DEFAULT_PROVIDER_NAME)
                    .to_string();
                ensure_codex_provider_mapping(
                    &mut document,
                    &provider_name,
                    Some(&codex_endpoint),
                )?;
                document.to_string().into_bytes()
            }
            "grokbuild.config" => {
                let mut document = toml_document(Some(&target.desired))?;
                let profile = document
                    .get("models")
                    .and_then(Item::as_table)
                    .and_then(|models| models.get("default"))
                    .and_then(Item::as_str)
                    .unwrap_or("proxy")
                    .to_string();
                let model = document
                    .get_mut("model")
                    .and_then(Item::as_table_mut)
                    .ok_or_else(|| "provider_config_invalid".to_string())?;
                let selected = model
                    .entry(&profile)
                    .or_insert(toml_edit::table())
                    .as_table_mut()
                    .ok_or_else(|| "provider_config_invalid".to_string())?;
                selected.insert("base_url", toml_edit::value(endpoint.clone()));
                selected.insert("api_key", toml_edit::value(ROUTED_CREDENTIAL_SENTINEL));
                document.to_string().into_bytes()
            }
            _ => return Err("provider_invalid_app_type".to_string()),
        };
    }
    Ok(())
}

fn plan_preview(plan: &ProviderPlan) -> GlobalPreview {
    let mut snapshot = BTreeMap::new();
    snapshot.insert("plan.app_type".to_string(), plan.app_type.clone());
    snapshot.insert("plan.provider_id".to_string(), plan.provider_id.clone());
    snapshot.insert(
        "plan.home_identity".to_string(),
        plan.home.identity.identity.clone(),
    );
    let targets = plan
        .targets
        .iter()
        .map(|target| {
            let live_fingerprint = fingerprint(target.before.as_deref());
            let desired_fingerprint = fingerprint(Some(&target.desired));
            snapshot.insert(format!("live:{}", target.path), live_fingerprint.clone());
            snapshot.insert(
                format!("desired:{}", target.path),
                desired_fingerprint.clone(),
            );
            let changed = target.before.as_deref() != Some(target.desired.as_slice());
            GlobalTargetPreview {
                target: target.target.clone(),
                path: target.path.clone(),
                exists: target.before.is_some(),
                live_fingerprint,
                desired_fingerprint,
                changed,
                action: if !changed {
                    "unchanged".to_string()
                } else if target.before.is_some() {
                    "update".to_string()
                } else {
                    "create".to_string()
                },
                owned_fields: target.owned_fields.clone(),
            }
        })
        .collect();
    GlobalPreview {
        app_type: plan.app_type.clone(),
        provider_id: plan.provider_id.clone(),
        provider_name: plan.provider_name.clone(),
        home: plan.home.clone(),
        fingerprint: aggregate_fingerprint(&snapshot),
        targets,
    }
}

fn preview_plan_cache_key(
    app_type: &str,
    provider_id: &str,
    home_identity: &HomeIdentityInput,
    projection: Option<&LocalRouteProjection>,
) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        app_type.trim().to_ascii_lowercase(),
        provider_id.trim(),
        home_identity.environment_kind.trim().to_ascii_lowercase(),
        home_identity.environment_id.as_deref().unwrap_or_default(),
        projection
            .map(|value| value.endpoint.trim())
            .unwrap_or_default(),
    )
}

fn cache_preview_plan(input: &GlobalPreviewInput, plan: &ProviderPlan, fingerprint: &str) {
    let key = preview_plan_cache_key(
        &input.app_type,
        &input.provider_id,
        &input.home_identity,
        input.projection.as_ref(),
    );
    let cache = PREVIEW_PLAN_CACHE.get_or_init(|| Mutex::new(Vec::new()));
    let Ok(mut entries) = cache.lock() else {
        return;
    };
    let now = Instant::now();
    entries
        .retain(|entry| now.saturating_duration_since(entry.created_at) <= PREVIEW_PLAN_CACHE_TTL);
    entries.retain(|entry| entry.key != key);
    entries.push(PreviewPlanCacheEntry {
        key,
        fingerprint: fingerprint.to_string(),
        plan: plan.clone(),
        created_at: now,
    });
    if entries.len() > 16 {
        entries.remove(0);
    }
}

fn take_cached_preview_plan(input: &GlobalApplyInput) -> Option<ProviderPlan> {
    let key = preview_plan_cache_key(
        &input.app_type,
        &input.provider_id,
        &input.home_identity,
        input.projection.as_ref(),
    );
    let cache = PREVIEW_PLAN_CACHE.get()?;
    let mut entries = cache.lock().ok()?;
    let now = Instant::now();
    entries
        .retain(|entry| now.saturating_duration_since(entry.created_at) <= PREVIEW_PLAN_CACHE_TTL);
    let index = entries.iter().position(|entry| {
        entry.key == key && entry.fingerprint == input.preview_fingerprint.trim()
    })?;
    Some(entries.remove(index).plan)
}

async fn validate_cached_plan(plan: &ProviderPlan, input: &GlobalApplyInput) -> Result<(), String> {
    let current_home = home::get(home_input(&input.home_identity)).await?;
    if serde_json::to_vec(&current_home).ok() != serde_json::to_vec(&plan.home).ok() {
        return Err("provider_apply_conflict".to_string());
    }
    let source = load_source(&plan.app_type, &plan.provider_id).await?;
    let mut connection = crate::provider::database::open_connection().await?;
    let effective = effective_settings(&mut connection, &plan.app_type, &source).await?;
    if source_signature(&source, &effective) != plan.source_signature {
        return Err("provider_apply_conflict".to_string());
    }
    let paths = plan
        .targets
        .iter()
        .map(|target| target.path.clone())
        .collect::<Vec<_>>();
    let current = read_live_many(&paths)?;
    if current
        .iter()
        .zip(&plan.targets)
        .any(|(current, target)| current.as_deref() != target.before.as_deref())
    {
        return Err("provider_apply_conflict".to_string());
    }
    Ok(())
}

fn plan_matches_live(plan: &ProviderPlan) -> bool {
    !plan.targets.is_empty()
        && plan
            .targets
            .iter()
            .all(|target| target.before.as_deref() == Some(target.desired.as_slice()))
}

fn backup_root(journal_id: &str) -> Result<PathBuf, String> {
    Ok(app_paths::cli_manager_data_dir()?
        .join("backups")
        .join("providers")
        .join(journal_id))
}

fn journal_targets(plan: &ProviderPlan, journal_id: &str) -> Result<Vec<JournalTarget>, String> {
    let backup_root = backup_root(journal_id)?;
    plan.targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            Ok(JournalTarget {
                target: target.path.clone(),
                backup_path: target.before.as_ref().map(|_| {
                    backup_root
                        .join(format!("{index}.backup"))
                        .to_string_lossy()
                        .into_owned()
                }),
                stage_path: stage_path_for_target(&target.path, journal_id, index)?,
                existed: target.before.is_some(),
            })
        })
        .collect()
}

fn stage_path_for_target(path: &str, journal_id: &str, index: usize) -> Result<String, String> {
    match live_path(path) {
        LivePath::Local(path) => {
            let parent = path
                .parent()
                .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
            Ok(parent
                .join(format!(".{name}.{journal_id}.{index}.stage"))
                .to_string_lossy()
                .into_owned())
        }
        LivePath::Wsl { distro, linux_path } => {
            let (parent, name) = linux_path
                .rsplit_once('/')
                .filter(|(_, name)| !name.is_empty())
                .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
            let parent = if parent.is_empty() { "/" } else { parent };
            let stage = if parent == "/" {
                format!("/.{name}.{journal_id}.{index}.stage")
            } else {
                format!("{parent}/.{name}.{journal_id}.{index}.stage")
            };
            Ok(wsl::linux_to_unc_wsl_path(&stage, &distro))
        }
    }
}

fn replace_local_file(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err("provider_target_write_failed".to_string());
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    fs::rename(source, destination).map_err(|_| "provider_target_write_failed".to_string())
}

pub(crate) fn replace_live_from_stage(target_path: &str, stage_path: &str) -> Result<(), String> {
    match (live_path(stage_path), live_path(target_path)) {
        (LivePath::Local(stage), LivePath::Local(target)) => replace_local_file(&stage, &target),
        (
            LivePath::Wsl {
                distro: stage_distro,
                linux_path: stage_path,
            },
            LivePath::Wsl {
                distro: target_distro,
                linux_path: target_path,
            },
        ) if stage_distro.eq_ignore_ascii_case(&target_distro) => {
            let output = run_wsl(&target_distro, "mv", &["-f", &stage_path, &target_path])
                .map_err(|_| "provider_target_write_failed".to_string())?;
            if output.status.success() {
                Ok(())
            } else {
                Err("provider_target_write_failed".to_string())
            }
        }
        _ => Err("provider_target_write_failed".to_string()),
    }
}

fn stage_plan(plan: &ProviderPlan, journal_targets: &[JournalTarget]) -> Result<(), String> {
    let backup_parent = journal_targets
        .iter()
        .find_map(|target| target.backup_path.as_deref())
        .and_then(|path| PathBuf::from(path).parent().map(PathBuf::from));
    if let Some(backup_parent) = backup_parent {
        fs::create_dir_all(backup_parent)
            .map_err(|_| "provider_apply_backup_failed".to_string())?;
    }
    let stage_paths = journal_targets
        .iter()
        .map(|target| target.stage_path.clone())
        .collect::<Vec<_>>();
    let desired = plan
        .targets
        .iter()
        .map(|target| target.desired.clone())
        .collect::<Vec<_>>();
    write_live_many(&stage_paths, &desired)
        .map_err(|_| "provider_apply_stage_failed".to_string())?;
    let staged =
        read_live_many(&stage_paths).map_err(|_| "provider_apply_stage_failed".to_string())?;
    for (index, target) in plan.targets.iter().enumerate() {
        let journal_target = journal_targets
            .get(index)
            .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
        let staged = staged
            .get(index)
            .and_then(|bytes| bytes.as_deref())
            .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
        parse_staged_target(target, &staged)?;
        if let (Some(before), Some(backup_path)) = (&target.before, &journal_target.backup_path) {
            fs::write(backup_path, before)
                .map_err(|_| "provider_apply_backup_failed".to_string())?;
        }
    }
    Ok(())
}

fn parse_staged_target(target: &PlannedTarget, bytes: &[u8]) -> Result<(), String> {
    let result = match target.target.as_str() {
        "claude.settings" | "codex.auth" => parse_json_object(Some(bytes)).map(|_| ()),
        "codex.config" | "grokbuild.config" => toml_document(Some(bytes)).map(|_| ()),
        _ => Err("provider_apply_stage_failed".to_string()),
    };
    result.map_err(|_| "provider_apply_stage_failed".to_string())
}

fn cleanup_stage_files(journal_targets: &[JournalTarget]) {
    for target in journal_targets {
        let _ = remove_live(&target.stage_path);
    }
}

fn cleanup_backup_paths(paths: &[String], allowed_root: Option<&Path>) {
    let mut parents = HashSet::new();
    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        if let Some(root) = allowed_root {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let has_parent_escape = relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            });
            if has_parent_escape
                || path.parent() == Some(root)
                || path.extension().and_then(|value| value.to_str()) != Some("backup")
            {
                continue;
            }
        }
        let _ = fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            if let Some(root) = allowed_root {
                if !parent.starts_with(root) {
                    continue;
                }
            }
            parents.insert(parent.to_path_buf());
        }
    }
    for parent in parents {
        let _ = fs::remove_dir(parent);
    }
}

fn cleanup_backup_files(journal_targets: &[JournalTarget]) {
    let paths = journal_targets
        .iter()
        .filter_map(|target| target.backup_path.clone())
        .collect::<Vec<_>>();
    cleanup_backup_paths(&paths, None);
}

fn cleanup_persisted_backup_paths(paths: &[String]) {
    let Ok(root) =
        app_paths::cli_manager_data_dir().map(|path| path.join("backups").join("providers"))
    else {
        return;
    };
    cleanup_backup_paths(paths, Some(&root));
}

async fn cleanup_finished_journal_backups() -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let rows = sqlx::query(
        "SELECT backup_paths_json
         FROM provider_apply_journal
         WHERE state IN ('committed', 'failed', 'recovered')",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "provider_journal_read_failed".to_string())?;
    for row in rows {
        let Ok(serialized) = row.try_get::<String, _>("backup_paths_json") else {
            continue;
        };
        let Ok(paths) = serde_json::from_str::<Vec<String>>(&serialized) else {
            continue;
        };
        cleanup_persisted_backup_paths(&paths);
    }
    Ok(())
}

pub(crate) async fn pending_journal(app_type: &str, home_identity: &str) -> Result<bool, String> {
    pending_journal_except(app_type, home_identity, None).await
}

async fn pending_journal_except(
    app_type: &str,
    home_identity: &str,
    excluded_journal_id: Option<&str>,
) -> Result<bool, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_apply_journal
         WHERE app_type = ?1 AND home_identity = ?2
           AND state IN ('staged', 'replacing', 'verifying', 'recovery_required')
           AND (?3 IS NULL OR id != ?3)",
    )
    .bind(app_type)
    .bind(home_identity)
    .bind(excluded_journal_id)
    .fetch_one(&mut connection)
    .await
    .map_err(|_| "provider_journal_read_failed".to_string())?;
    Ok(count > 0)
}

async fn insert_journal(
    journal_id: &str,
    plan: &ProviderPlan,
    journal_targets: &[JournalTarget],
) -> Result<(), String> {
    let mut expected = BTreeMap::new();
    let mut desired = BTreeMap::new();
    let mut target_paths = Vec::with_capacity(plan.targets.len());
    let mut backup_paths = Vec::new();
    for target in &plan.targets {
        expected.insert(target.path.clone(), fingerprint(target.before.as_deref()));
        desired.insert(target.path.clone(), fingerprint(Some(&target.desired)));
        target_paths.push(target.path.clone());
    }
    for target in journal_targets {
        if let Some(path) = &target.backup_path {
            backup_paths.push(path.clone());
        }
    }
    let mut connection = crate::provider::database::open_connection().await?;
    sqlx::query(
        "INSERT INTO provider_apply_journal
         (id, app_type, provider_id, home_identity, operation, state,
          target_paths_json, backup_paths_json, expected_fingerprints_json,
          desired_fingerprints_json, started_at)
         VALUES (?1, ?2, ?3, ?4, 'global_apply', 'staged', ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(journal_id)
    .bind(&plan.app_type)
    .bind(&plan.provider_id)
    .bind(&plan.home.identity.identity)
    .bind(serde_json::to_string(journal_targets).unwrap_or_else(|_| "[]".to_string()))
    .bind(serde_json::to_string(&backup_paths).unwrap_or_else(|_| "[]".to_string()))
    .bind(serde_json::to_string(&expected).unwrap_or_else(|_| "{}".to_string()))
    .bind(serde_json::to_string(&desired).unwrap_or_else(|_| "{}".to_string()))
    .bind(crate::provider::repository::unix_timestamp_millis())
    .execute(&mut connection)
    .await
    .map_err(|_| "provider_journal_write_failed".to_string())?;
    Ok(())
}

async fn update_journal(
    journal_id: &str,
    state: &str,
    error_code: Option<&str>,
) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    sqlx::query(
        "UPDATE provider_apply_journal
         SET state = ?1, finished_at = ?2, error_code = ?3
         WHERE id = ?4",
    )
    .bind(state)
    .bind(if matches!(state, "committed" | "failed" | "recovered") {
        Some(crate::provider::repository::unix_timestamp_millis())
    } else {
        None
    })
    .bind(error_code)
    .bind(journal_id)
    .execute(&mut connection)
    .await
    .map_err(|_| "provider_journal_write_failed".to_string())?;
    Ok(())
}

async fn commit_current(plan: &ProviderPlan, journal_id: &str) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    sqlx::query("UPDATE providers SET is_current = 0 WHERE app_type = ?1")
        .bind(&plan.app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    let result = sqlx::query(
        "UPDATE providers SET is_current = 1
         WHERE id = ?1 AND app_type = ?2",
    )
    .bind(&plan.provider_id)
    .bind(&plan.app_type)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    if result.rows_affected() != 1 {
        return Err("provider_not_found".to_string());
    }
    sqlx::query(
        "UPDATE provider_apply_journal
         SET state = 'committed', finished_at = ?1, error_code = NULL
         WHERE id = ?2",
    )
    .bind(crate::provider::repository::unix_timestamp_millis())
    .bind(journal_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    transaction
        .commit()
        .await
        .map_err(|_| "provider_database_error".to_string())
}

fn restore_targets(plan: &ProviderPlan, changed_paths: &[String]) -> Result<(), String> {
    let mut first_error = None;
    for target in plan.targets.iter().rev() {
        if !changed_paths.iter().any(|path| path == &target.path) {
            continue;
        }
        let current = match read_live(&target.path) {
            Ok(bytes) => bytes,
            Err(error) => {
                first_error.get_or_insert(error);
                continue;
            }
        };
        if fingerprint(current.as_deref()) != fingerprint(Some(&target.desired)) {
            first_error.get_or_insert("provider_recovery_required".to_string());
            continue;
        }
        let result = if let Some(before) = &target.before {
            write_live(&target.path, before)
        } else {
            remove_live(&target.path)
        };
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(crate) async fn preview(input: GlobalPreviewInput) -> Result<GlobalPreview, String> {
    let plan = build_plan(&input).await?;
    let preview = plan_preview(&plan);
    cache_preview_plan(&input, &plan, &preview.fingerprint);
    Ok(preview)
}

pub(crate) async fn current(input: GlobalCurrentInput) -> Result<GlobalCurrent, String> {
    let app_type = normalize_type(&input.app_type)?;
    let home = home::get(home_input(&input.home_identity)).await?;
    let pending_recovery = pending_journal(&app_type, &home.identity.identity).await?;
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT p.id, p.name, p.is_current,
                CASE WHEN EXISTS (
                    SELECT 1 FROM provider_api_keys k
                    WHERE k.provider_id = p.id AND k.app_type = p.app_type
                      AND k.is_active = 1 AND k.enabled = 1
                ) THEN 1 ELSE 0 END AS active_key_present
         FROM providers p
         WHERE p.app_type = ?1
         ORDER BY p.is_current DESC, p.sort_index, p.name COLLATE NOCASE",
    )
    .bind(&app_type)
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?;

    let candidates = row
        .iter()
        .map(|row| {
            Ok(CurrentCandidate {
                id: row
                    .try_get("id")
                    .map_err(|_| "provider_database_error".to_string())?,
                name: row
                    .try_get("name")
                    .map_err(|_| "provider_database_error".to_string())?,
                is_current: row
                    .try_get::<i64, _>("is_current")
                    .map_err(|_| "provider_database_error".to_string())?
                    != 0,
                active_key_present: row
                    .try_get::<i64, _>("active_key_present")
                    .map_err(|_| "provider_database_error".to_string())?
                    != 0,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    drop(connection);

    let mut matched_plan: Option<(CurrentCandidate, ProviderPlan)> = None;
    let mut flagged_plan: Option<(CurrentCandidate, ProviderPlan)> = None;
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.active_key_present)
    {
        let Ok(plan) = build_plan(&GlobalPreviewInput {
            app_type: app_type.clone(),
            provider_id: candidate.id.clone(),
            home_identity: input.home_identity.clone(),
            projection: None,
        })
        .await
        else {
            continue;
        };
        if candidate.is_current && flagged_plan.is_none() {
            flagged_plan = Some((candidate.clone(), plan.clone()));
        }
        if plan_matches_live(&plan) && matched_plan.is_none() {
            matched_plan = Some((candidate.clone(), plan));
        }
    }

    let selected = matched_plan.or(flagged_plan);
    let Some((candidate, plan)) = selected.or_else(|| {
        candidates
            .iter()
            .find(|candidate| candidate.is_current)
            .cloned()
            .map(|candidate| {
                (
                    candidate,
                    ProviderPlan {
                        app_type: app_type.clone(),
                        provider_id: String::new(),
                        provider_name: String::new(),
                        source_signature: String::new(),
                        home: home.clone(),
                        targets: Vec::new(),
                    },
                )
            })
    }) else {
        return Ok(GlobalCurrent {
            app_type,
            home,
            provider_id: None,
            provider_name: None,
            active_key_present: false,
            state: if pending_recovery {
                "recovery_pending"
            } else {
                "not_set"
            }
            .to_string(),
            pending_recovery,
            targets: Vec::new(),
        });
    };
    let active_key_present = candidate.active_key_present;
    let targets = if plan.provider_id.is_empty() {
        Vec::new()
    } else {
        plan_preview(&plan).targets
    };
    let state = if pending_recovery {
        "recovery_pending"
    } else if !active_key_present {
        "key_missing"
    } else if targets.is_empty() {
        "unavailable"
    } else if targets.iter().all(|target| !target.changed) {
        "applied"
    } else {
        "drifted"
    };
    Ok(GlobalCurrent {
        app_type,
        home,
        provider_id: Some(candidate.id),
        provider_name: Some(candidate.name),
        active_key_present,
        state: state.to_string(),
        pending_recovery,
        targets,
    })
}

pub(crate) async fn apply(input: GlobalApplyInput) -> Result<GlobalApplyResult, String> {
    apply_internal(input, true, None).await
}

async fn apply_internal(
    input: GlobalApplyInput,
    commit_provider_current: bool,
    pending_journal_exemption: Option<&str>,
) -> Result<GlobalApplyResult, String> {
    let preview_fingerprint = input.preview_fingerprint.trim();
    if preview_fingerprint.is_empty() {
        return Err("provider_preview_fingerprint_required".to_string());
    }
    let preview_input = GlobalPreviewInput {
        app_type: input.app_type.clone(),
        provider_id: input.provider_id.clone(),
        home_identity: input.home_identity.clone(),
        projection: input.projection.clone(),
    };
    let cached_plan = take_cached_preview_plan(&input);
    let plan = if let Some(plan) = cached_plan {
        validate_cached_plan(&plan, &input).await?;
        plan
    } else {
        build_plan(&preview_input).await?
    };
    let _lock = acquire_apply_lock(&plan.app_type, &plan.home.identity.identity)?;
    if pending_journal_except(
        &plan.app_type,
        &plan.home.identity.identity,
        pending_journal_exemption,
    )
    .await?
    {
        return Err("provider_recovery_required".to_string());
    }
    let preview = plan_preview(&plan);
    if preview.fingerprint != preview_fingerprint {
        return Err("provider_apply_conflict".to_string());
    }

    let changed_paths = plan
        .targets
        .iter()
        .filter(|target| target.before.as_deref() != Some(target.desired.as_slice()))
        .map(|target| target.path.clone())
        .collect::<Vec<_>>();
    if target_writable_many(&changed_paths)
        .iter()
        .any(|writable| !writable)
    {
        return Err("provider_target_write_failed".to_string());
    }

    let journal_id = Uuid::new_v4().to_string();
    let journal_targets = journal_targets(&plan, &journal_id)?;
    if let Err(error) = insert_journal(&journal_id, &plan, &journal_targets).await {
        return Err(error);
    }
    if let Err(error) = stage_plan(&plan, &journal_targets) {
        cleanup_stage_files(&journal_targets);
        cleanup_backup_files(&journal_targets);
        if update_journal(&journal_id, "failed", Some(error.as_str()))
            .await
            .is_err()
        {
            return Err("provider_journal_write_failed".to_string());
        }
        return Err(error);
    }

    if let Err(error) = update_journal(&journal_id, "replacing", None).await {
        cleanup_stage_files(&journal_targets);
        return Err(error);
    }
    let mut replaced_paths = Vec::new();
    let replacement_result = (|| -> Result<(), String> {
        let current = read_live_many(&changed_paths)?;
        for (index, target) in plan.targets.iter().enumerate() {
            if !changed_paths.iter().any(|path| path == &target.path) {
                continue;
            }
            let changed_index = changed_paths
                .iter()
                .position(|path| path == &target.path)
                .ok_or_else(|| "provider_apply_conflict".to_string())?;
            if fingerprint(
                current
                    .get(changed_index)
                    .and_then(|value| value.as_deref()),
            ) != fingerprint(target.before.as_deref())
            {
                return Err("provider_apply_conflict".to_string());
            }
            let journal_target = journal_targets
                .get(index)
                .ok_or_else(|| "provider_target_write_failed".to_string())?;
            replace_live_from_stage(&target.path, &journal_target.stage_path)?;
            replaced_paths.push(target.path.clone());
        }
        Ok(())
    })();
    if let Err(_error) = replacement_result {
        let restore = restore_targets(&plan, &replaced_paths);
        cleanup_stage_files(&journal_targets);
        let conflict = _error == "provider_apply_conflict";
        let _ = update_journal(
            &journal_id,
            if restore.is_ok() {
                "failed"
            } else {
                "recovery_required"
            },
            Some(if !restore.is_ok() {
                "provider_recovery_required"
            } else if conflict {
                "provider_apply_conflict"
            } else {
                "provider_apply_failed"
            }),
        )
        .await;
        return Err(if !restore.is_ok() {
            "provider_recovery_required".to_string()
        } else if conflict {
            "provider_apply_conflict".to_string()
        } else {
            "provider_apply_failed".to_string()
        });
    }

    if let Err(error) = update_journal(&journal_id, "verifying", None).await {
        cleanup_stage_files(&journal_targets);
        return Err(error);
    }
    let mut verified = BTreeMap::new();
    let verification_result = (|| -> Result<(), String> {
        let paths = plan
            .targets
            .iter()
            .map(|target| target.path.clone())
            .collect::<Vec<_>>();
        let current = read_live_many(&paths)?;
        for (target, current) in plan.targets.iter().zip(current) {
            let actual = fingerprint(current.as_deref());
            let expected = fingerprint(Some(&target.desired));
            if actual != expected {
                return Err("provider_apply_failed".to_string());
            }
            verified.insert(target.path.clone(), actual);
        }
        Ok(())
    })();
    if verification_result.is_err() {
        let restore = restore_targets(&plan, &changed_paths);
        cleanup_stage_files(&journal_targets);
        let _ = update_journal(
            &journal_id,
            if restore.is_ok() {
                "failed"
            } else {
                "recovery_required"
            },
            Some(if restore.is_ok() {
                "provider_apply_failed"
            } else {
                "provider_recovery_required"
            }),
        )
        .await;
        return Err(if restore.is_ok() {
            "provider_apply_failed".to_string()
        } else {
            "provider_recovery_required".to_string()
        });
    }
    let commit_result = if commit_provider_current {
        commit_current(&plan, &journal_id).await
    } else {
        Ok(())
    };
    if commit_result.is_err() {
        let restore = restore_targets(&plan, &changed_paths);
        cleanup_stage_files(&journal_targets);
        let _ = update_journal(
            &journal_id,
            if restore.is_ok() {
                "failed"
            } else {
                "recovery_required"
            },
            Some(if restore.is_ok() {
                "provider_database_error"
            } else {
                "provider_recovery_required"
            }),
        )
        .await;
        return Err(if restore.is_ok() {
            "provider_database_error".to_string()
        } else {
            "provider_recovery_required".to_string()
        });
    }

    cleanup_stage_files(&journal_targets);
    if commit_provider_current {
        cleanup_backup_files(&journal_targets);
    }

    Ok(GlobalApplyResult {
        app_type: plan.app_type,
        provider_id: plan.provider_id,
        home_identity: plan.home.identity,
        journal_id,
        state: if commit_provider_current {
            "committed"
        } else {
            "verifying"
        }
        .to_string(),
        changed_targets: changed_paths,
        verified_fingerprints: verified,
    })
}

#[derive(Debug, Clone)]
pub(crate) struct HotSwitchTarget {
    pub home_identity: HomeIdentityInput,
    pub projection: LocalRouteProjection,
}

pub(crate) async fn apply_hot_switch(
    app_type: &str,
    previous_provider_id: &str,
    next_provider_id: &str,
    targets: &[HotSwitchTarget],
) -> Result<Vec<GlobalApplyResult>, String> {
    let app_type = normalize_type(app_type)?;
    if previous_provider_id.trim().is_empty() || next_provider_id.trim().is_empty() {
        return Err("routing_provider_required".to_string());
    }
    if targets.is_empty() {
        return Err("routing_hot_switch_targets_empty".to_string());
    }
    let mut identities = HashSet::with_capacity(targets.len());
    for target in targets {
        let identity = format!(
            "{}:{}",
            target.home_identity.environment_kind,
            target
                .home_identity
                .environment_id
                .as_deref()
                .unwrap_or_default()
        );
        if !identities.insert(identity) {
            return Err("routing_hot_switch_duplicate_home".to_string());
        }
    }
    let _app_lock = acquire_apply_lock(&app_type, "__routing_hot_switch__")?;
    let mut applied = Vec::with_capacity(targets.len());
    for target in targets {
        let preview_input = GlobalPreviewInput {
            app_type: app_type.clone(),
            provider_id: next_provider_id.to_string(),
            home_identity: target.home_identity.clone(),
            projection: Some(target.projection.clone()),
        };
        let preview = match preview(preview_input).await {
            Ok(preview) => preview,
            Err(_) => {
                let rollback =
                    rollback_hot_switch(&app_type, previous_provider_id, targets, &applied).await?;
                complete_hot_switch_rollback(&app_type, previous_provider_id, &applied, &rollback)
                    .await?;
                return Err("routing_hot_switch_failed".to_string());
            }
        };
        let result = apply_internal(
            GlobalApplyInput {
                app_type: app_type.clone(),
                provider_id: next_provider_id.to_string(),
                home_identity: target.home_identity.clone(),
                preview_fingerprint: preview.fingerprint,
                projection: Some(target.projection.clone()),
            },
            false,
            None,
        )
        .await;
        match result {
            Ok(result) => applied.push(result),
            Err(_) => {
                let rollback =
                    rollback_hot_switch(&app_type, previous_provider_id, targets, &applied).await?;
                complete_hot_switch_rollback(&app_type, previous_provider_id, &applied, &rollback)
                    .await?;
                return Err("routing_hot_switch_failed".to_string());
            }
        }
    }
    let journal_ids = applied
        .iter()
        .map(|result| result.journal_id.clone())
        .collect::<Vec<_>>();
    if commit_provider_current(&app_type, next_provider_id, &journal_ids)
        .await
        .is_err()
    {
        let rollback =
            rollback_hot_switch(&app_type, previous_provider_id, targets, &applied).await?;
        complete_hot_switch_rollback(&app_type, previous_provider_id, &applied, &rollback).await?;
        return Err("routing_hot_switch_failed".to_string());
    }
    let _ = cleanup_finished_journal_backups().await;
    Ok(applied)
}

async fn rollback_hot_switch(
    app_type: &str,
    previous_provider_id: &str,
    targets: &[HotSwitchTarget],
    applied: &[GlobalApplyResult],
) -> Result<Vec<GlobalApplyResult>, String> {
    let mut rollback_results = Vec::with_capacity(applied.len());
    for (target, original) in targets[..applied.len()].iter().zip(applied.iter()).rev() {
        let preview_input = GlobalPreviewInput {
            app_type: app_type.to_string(),
            provider_id: previous_provider_id.to_string(),
            home_identity: target.home_identity.clone(),
            projection: Some(target.projection.clone()),
        };
        let preview = preview(preview_input).await?;
        let result = apply_internal(
            GlobalApplyInput {
                app_type: app_type.to_string(),
                provider_id: previous_provider_id.to_string(),
                home_identity: target.home_identity.clone(),
                preview_fingerprint: preview.fingerprint,
                projection: Some(target.projection.clone()),
            },
            false,
            Some(&original.journal_id),
        )
        .await?;
        rollback_results.push(result);
    }
    Ok(rollback_results)
}

async fn commit_provider_current(
    app_type: &str,
    provider_id: &str,
    journal_ids: &[String],
) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    sqlx::query("UPDATE providers SET is_current = 0 WHERE app_type = ?1")
        .bind(app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    let result = sqlx::query(
        "UPDATE providers SET is_current = 1
         WHERE id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    if result.rows_affected() != 1 {
        return Err("provider_not_found".to_string());
    }
    for journal_id in journal_ids {
        sqlx::query(
            "UPDATE provider_apply_journal
             SET state = 'committed', finished_at = ?1, error_code = NULL
             WHERE id = ?2",
        )
        .bind(crate::provider::repository::unix_timestamp_millis())
        .bind(journal_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_journal_write_failed".to_string())?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| "provider_database_error".to_string())
}

async fn complete_hot_switch_rollback(
    app_type: &str,
    previous_provider_id: &str,
    applied: &[GlobalApplyResult],
    rollback: &[GlobalApplyResult],
) -> Result<(), String> {
    let rollback_ids = rollback
        .iter()
        .map(|result| result.journal_id.clone())
        .collect::<Vec<_>>();
    commit_provider_current(app_type, previous_provider_id, &rollback_ids).await?;
    for result in applied {
        update_journal(
            &result.journal_id,
            "failed",
            Some("routing_hot_switch_failed"),
        )
        .await?;
    }
    let _ = cleanup_finished_journal_backups().await;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryReport {
    pub recovered: usize,
    pub completed: usize,
    pub blocked: usize,
}

async fn complete_recovered_journal(
    journal_id: &str,
    app_type: &str,
    provider_id: &str,
) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    sqlx::query("UPDATE providers SET is_current = 0 WHERE app_type = ?1")
        .bind(app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    let result = sqlx::query(
        "UPDATE providers SET is_current = 1
         WHERE id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    if result.rows_affected() != 1 {
        return Err("provider_not_found".to_string());
    }
    sqlx::query(
        "UPDATE provider_apply_journal
         SET state = 'committed', finished_at = ?1, error_code = NULL
         WHERE id = ?2",
    )
    .bind(crate::provider::repository::unix_timestamp_millis())
    .bind(journal_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    transaction
        .commit()
        .await
        .map_err(|_| "provider_database_error".to_string())
}

async fn recover_one(
    id: String,
    app_type: String,
    provider_id: String,
    targets_json: String,
    expected_json: String,
    desired_json: String,
) -> Result<&'static str, String> {
    let targets = serde_json::from_str::<Vec<JournalTarget>>(&targets_json)
        .map_err(|_| "provider_recovery_required".to_string())?;
    let expected = serde_json::from_str::<BTreeMap<String, String>>(&expected_json)
        .map_err(|_| "provider_recovery_required".to_string())?;
    let desired = serde_json::from_str::<BTreeMap<String, String>>(&desired_json)
        .map_err(|_| "provider_recovery_required".to_string())?;
    let mut current = BTreeMap::new();
    for target in &targets {
        let bytes = match read_live(&target.target) {
            Ok(bytes) => bytes,
            Err(error) => {
                cleanup_stage_files(&targets);
                return Err(error);
            }
        };
        current.insert(target.target.clone(), fingerprint(bytes.as_deref()));
    }
    if current
        .iter()
        .any(|(path, value)| expected.get(path) != Some(value) && desired.get(path) != Some(value))
    {
        cleanup_stage_files(&targets);
        return Err("provider_recovery_required".to_string());
    }
    let all_desired = targets
        .iter()
        .all(|target| current.get(&target.target) == desired.get(&target.target));
    let all_expected = targets
        .iter()
        .all(|target| current.get(&target.target) == expected.get(&target.target));
    if all_desired {
        let result = complete_recovered_journal(&id, &app_type, &provider_id).await;
        result?;
        cleanup_stage_files(&targets);
        cleanup_backup_files(&targets);
        return Ok("completed");
    }
    if all_expected {
        let result = update_journal(&id, "recovered", Some("provider_recovery_completed")).await;
        result?;
        cleanup_stage_files(&targets);
        cleanup_backup_files(&targets);
        return Ok("recovered");
    }
    let mut restore_bytes = Vec::with_capacity(targets.len());
    for target in &targets {
        let bytes = match target.backup_path.as_deref() {
            Some(before) => fs::read(before)
                .map(Some)
                .map_err(|_| "provider_recovery_required".to_string())?,
            None => None,
        };
        if expected.get(&target.target) != Some(&fingerprint(bytes.as_deref())) {
            cleanup_stage_files(&targets);
            return Err("provider_recovery_required".to_string());
        }
        restore_bytes.push(bytes);
    }
    for (target, bytes) in targets.iter().zip(restore_bytes).rev() {
        let Some(bytes) = bytes else {
            if let Err(error) = remove_live(&target.target) {
                cleanup_stage_files(&targets);
                return Err(error);
            }
            continue;
        };
        if let Err(error) = write_live(&target.target, &bytes) {
            cleanup_stage_files(&targets);
            return Err(error);
        }
    }
    for target in &targets {
        let bytes = match read_live(&target.target) {
            Ok(bytes) => bytes,
            Err(error) => {
                cleanup_stage_files(&targets);
                return Err(error);
            }
        };
        if expected.get(&target.target) != Some(&fingerprint(bytes.as_deref())) {
            cleanup_stage_files(&targets);
            return Err("provider_recovery_required".to_string());
        }
    }
    let result = update_journal(&id, "recovered", Some("provider_recovery_completed")).await;
    result?;
    cleanup_stage_files(&targets);
    cleanup_backup_files(&targets);
    Ok("recovered")
}

pub(crate) async fn recover_pending() -> Result<RecoveryReport, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let rows = sqlx::query(
        "SELECT id, app_type, provider_id, home_identity, target_paths_json,
                expected_fingerprints_json, desired_fingerprints_json
         FROM provider_apply_journal
         WHERE state IN ('staged', 'replacing', 'verifying', 'recovery_required')
         ORDER BY started_at",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "provider_journal_read_failed".to_string())?;
    let mut report = RecoveryReport::default();
    for row in rows {
        let id = row
            .try_get::<String, _>("id")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let app_type = row
            .try_get::<String, _>("app_type")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let provider_id = row
            .try_get::<String, _>("provider_id")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let home_identity = row
            .try_get::<String, _>("home_identity")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let targets = row
            .try_get::<String, _>("target_paths_json")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let expected = row
            .try_get::<String, _>("expected_fingerprints_json")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let desired = row
            .try_get::<String, _>("desired_fingerprints_json")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let apply_lock = match acquire_apply_lock(&app_type, &home_identity) {
            Ok(lock) => lock,
            Err(error) if error == "provider_apply_busy" => {
                report.blocked += 1;
                continue;
            }
            Err(_) => {
                report.blocked += 1;
                let _ =
                    update_journal(&id, "recovery_required", Some("provider_recovery_required"))
                        .await;
                continue;
            }
        };
        let result = recover_one(
            id.clone(),
            app_type,
            provider_id,
            targets,
            expected,
            desired,
        )
        .await;
        drop(apply_lock);
        match result {
            Ok("completed") => report.completed += 1,
            Ok("recovered") => report.recovered += 1,
            Ok(_) | Err(_) => {
                report.blocked += 1;
                let _ =
                    update_journal(&id, "recovery_required", Some("provider_recovery_required"))
                        .await;
            }
        }
    }
    if let Err(error) = cleanup_finished_journal_backups().await {
        log::warn!("provider journal backup cleanup skipped: {error}");
    }
    Ok(report)
}

#[cfg(test)]
mod tests;
