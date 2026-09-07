use super::database;
use super::repository;
use crate::{app_paths, ccswitch_db, wsl};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{Connection, Row};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use toml_edit::{DocumentMut, Item, Table, Value as TomlValue};
use uuid::Uuid;

const SOURCE_KIND: &str = "ccswitch";
const IMPORTED_KEY_LABEL: &str = "Imported from CC Switch";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportSourceInput {
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCommitInput {
    pub source_path: Option<String>,
    pub expected_fingerprint: String,
    pub allow_secrets: bool,
    pub allow_updates: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportSchemaReport {
    pub providers_table: bool,
    pub settings_table: bool,
    pub multi_key_table: bool,
    pub provider_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportKeyPreview {
    pub label: String,
    pub tags: Vec<String>,
    pub notes: String,
    pub enabled: bool,
    pub sort_index: i64,
    pub is_active: bool,
    pub has_secret: bool,
    pub masked_api_key: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportProviderPreview {
    pub source_id: String,
    pub app_type: String,
    pub name: String,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub sort_index: i64,
    pub is_current: bool,
    pub settings_valid: bool,
    pub settings_preview: String,
    pub settings_has_secret: bool,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub keys: Vec<ImportKeyPreview>,
    pub action: String,
    pub native_provider_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCommonPreview {
    pub app_type: String,
    pub format: String,
    pub has_secret: bool,
    pub fingerprint: String,
    pub sanitized_value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportScopePreview {
    pub scope_kind: String,
    pub scope_id: String,
    pub app_type: String,
    pub source_provider_id: String,
    pub native_provider_id: Option<String>,
    pub action: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreview {
    pub source_kind: String,
    pub source_identity: String,
    pub source_path: String,
    pub source_fingerprint: String,
    pub schema: ImportSchemaReport,
    pub providers: Vec<ImportProviderPreview>,
    pub common_configs: Vec<ImportCommonPreview>,
    pub scopes: Vec<ImportScopePreview>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    pub source_kind: String,
    pub source_identity: String,
    pub source_fingerprint: String,
    pub imported: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub keys_imported: usize,
    pub current_candidates: usize,
    pub migrated_scopes: usize,
    pub repair_issues: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportIssue {
    pub id: String,
    pub scope_kind: String,
    pub scope_id: String,
    pub app_type: String,
    pub source_provider_id: String,
    pub reason: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportIssueResolveInput {
    pub issue_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone)]
struct SourceKey {
    label: String,
    api_key: Option<String>,
    tags: Vec<String>,
    notes: String,
    enabled: bool,
    sort_index: i64,
    is_active: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
struct SourceProvider {
    source_id: String,
    source_app_type: String,
    app_type: Option<String>,
    name: String,
    settings_config: String,
    website_url: Option<String>,
    category: Option<String>,
    notes: Option<String>,
    sort_index: i64,
    created_at: i64,
    meta: String,
    is_current: bool,
    settings_valid: bool,
    base_url: Option<String>,
    model: Option<String>,
    api_format: Option<String>,
    keys: Vec<SourceKey>,
}

#[derive(Debug, Clone)]
struct SourceCommon {
    app_type: String,
    value: String,
    format: String,
}

#[derive(Debug, Clone)]
struct LegacyScope {
    scope_kind: String,
    scope_id: String,
    app_type: String,
    source_provider_id: String,
}

struct SourceSnapshot {
    source_path: PathBuf,
    fingerprint: String,
    schema: ImportSchemaReport,
    providers: Vec<SourceProvider>,
    common_configs: Vec<SourceCommon>,
    legacy_scopes: Vec<LegacyScope>,
}

fn source_path(input: Option<String>) -> Result<PathBuf, String> {
    let path = input
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            app_paths::home_dir_from_env()
                .unwrap_or_default()
                .join(".cc-switch")
                .join("cc-switch.db")
        });
    if path.extension().and_then(|value| value.to_str()) != Some("db") {
        return Err("provider_import_source_invalid:unsupported_format".to_string());
    }
    Ok(path)
}

fn row_string(row: &SqliteRow, column: &str) -> Option<String> {
    row.try_get::<String, _>(column)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn row_i64(row: &SqliteRow, column: &str) -> Option<i64> {
    row.try_get::<i64, _>(column).ok()
}

fn row_bool(row: &SqliteRow, column: &str, default: bool) -> bool {
    row_i64(row, column)
        .map(|value| value != 0)
        .unwrap_or(default)
}

fn row_json_object(row: &SqliteRow, column: &str) -> Map<String, Value> {
    row_string(row, column)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn normalize_source_app_type(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude-code" => Some("claude".to_string()),
        "codex" => Some("codex".to_string()),
        "grok" | "grokbuild" | "grok-build" => Some("grokbuild".to_string()),
        _ => None,
    }
}

fn is_credential_key(app_type: &str, key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    if normalized.contains("access_token")
        || normalized.contains("refresh_token")
        || normalized.contains("oauth")
        || normalized == "auth"
    {
        return false;
    }
    match app_type {
        "claude" => matches!(
            normalized.as_str(),
            "anthropic_api_key" | "anthropic_auth_token" | "api_key" | "apikey" | "token"
        ),
        "codex" => matches!(
            normalized.as_str(),
            "openai_api_key" | "openai_auth_token" | "api_key" | "apikey" | "token"
        ),
        "grokbuild" => matches!(
            normalized.as_str(),
            "xai_api_key" | "api_key" | "apikey" | "token"
        ),
        _ => false,
    }
}

fn is_sensitive_key(app_type: &str, key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    is_credential_key(app_type, key)
        || matches!(
            normalized.as_str(),
            "access_token"
                | "refresh_token"
                | "oauth_token"
                | "oauth2_token"
                | "authorization"
                | "auth_header"
                | "bearer"
                | "password"
                | "passwd"
                | "secret"
                | "client_secret"
                | "clientsecret"
                | "api_key"
                | "apikey"
        )
        || normalized.ends_with("_token")
        || normalized.ends_with("token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("secret")
        || normalized.ends_with("_password")
        || normalized.ends_with("password")
        || normalized.ends_with("_api_key")
        || normalized.ends_with("apikey")
}

fn usable_secret(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && !value.starts_with("${")
        && !value.eq_ignore_ascii_case("oauth")
        && !value.eq_ignore_ascii_case("oauth2")
        && !value.eq_ignore_ascii_case("placeholder")
}

fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 12 {
        return "***".to_string();
    }
    format!(
        "{}…{}",
        chars[..4].iter().collect::<String>(),
        chars[chars.len() - 4..].iter().collect::<String>()
    )
}

fn secret_candidates_from_json(value: &Value, app_type: &str, output: &mut Vec<(String, String)>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if is_credential_key(app_type, key) && child.as_str().is_some_and(usable_secret) {
                    output.push((key.clone(), child.as_str().unwrap_or_default().to_string()));
                }
                secret_candidates_from_json(child, app_type, output);
            }
        }
        Value::Array(items) => {
            for item in items {
                secret_candidates_from_json(item, app_type, output);
            }
        }
        Value::String(text) if text.contains('=') => {
            for (key, value) in toml_secret_candidates(text, app_type) {
                output.push((key, value));
            }
        }
        _ => {}
    }
}

fn toml_secret_candidates(text: &str, app_type: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let (key, raw_value) = line.split_once('=')?;
            let key = key.trim().trim_matches(['"', '\'']);
            if !is_credential_key(app_type, key) {
                return None;
            }
            let value = raw_value
                .split_once('#')
                .map(|(value, _)| value)
                .unwrap_or(raw_value)
                .trim()
                .trim_matches(['"', '\''])
                .trim();
            usable_secret(value).then(|| (key.to_string(), value.to_string()))
        })
        .collect()
}

fn secret_candidates(raw: &str, app_type: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    secret_candidates_from_json(&value, app_type, &mut candidates);
    let mut seen = HashSet::new();
    candidates.retain(|(key, value)| seen.insert((key.clone(), value.clone())));
    candidates
}

fn sanitize_toml(text: &str, app_type: &str) -> String {
    let Ok(mut document) = text.parse::<DocumentMut>() else {
        return "[INVALID TOML DOCUMENT]".to_string();
    };
    sanitize_toml_item(document.as_item_mut(), app_type);
    document.to_string()
}

fn sanitize_toml_item(item: &mut Item, app_type: &str) -> bool {
    match item {
        Item::Table(table) => sanitize_toml_table(table, app_type),
        Item::ArrayOfTables(tables) => {
            let mut found_secret = false;
            for table in tables.iter_mut() {
                found_secret |= sanitize_toml_table(table, app_type);
            }
            found_secret
        }
        Item::Value(value) => sanitize_toml_value(value, app_type),
        Item::None => false,
    }
}

fn sanitize_toml_table(table: &mut Table, app_type: &str) -> bool {
    let mut found_secret = false;
    for (key, item) in table.iter_mut() {
        if is_sensitive_key(app_type, key.get()) {
            *item = Item::Value(TomlValue::from("[REDACTED]"));
            found_secret = true;
        } else if sanitize_toml_item(item, app_type) {
            found_secret = true;
        }
    }
    found_secret
}

fn sanitize_toml_value(value: &mut TomlValue, app_type: &str) -> bool {
    let mut found_secret = false;
    if let Some(table) = value.as_inline_table_mut() {
        for (key, child) in table.iter_mut() {
            if is_sensitive_key(app_type, key.get()) {
                *child = TomlValue::from("[REDACTED]");
                found_secret = true;
            } else if sanitize_toml_value(child, app_type) {
                found_secret = true;
            }
        }
    }
    if let Some(array) = value.as_array_mut() {
        for child in array.iter_mut() {
            if sanitize_toml_value(child, app_type) {
                found_secret = true;
            }
        }
    }
    found_secret
}

fn sanitize_json(value: &mut Value, app_type: &str) -> bool {
    match value {
        Value::Object(object) => {
            let keys = object
                .keys()
                .filter(|key| is_sensitive_key(app_type, key))
                .cloned()
                .collect::<Vec<_>>();
            let mut removed = !keys.is_empty();
            for key in keys {
                object.remove(&key);
            }
            for (key, child) in object.iter_mut() {
                if key.eq_ignore_ascii_case("config") {
                    if let Value::String(text) = child {
                        let sanitized = sanitize_toml(text, app_type);
                        removed |= sanitized != *text;
                        *text = sanitized;
                    }
                }
                removed |= sanitize_json(child, app_type);
            }
            removed
        }
        Value::Array(items) => {
            let mut removed = false;
            for item in items.iter_mut() {
                removed |= sanitize_json(item, app_type);
            }
            removed
        }
        _ => false,
    }
}

fn sanitized_settings(raw: &str, app_type: &str) -> (String, bool, bool) {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return ("{}".to_string(), false, false);
    };
    if !value.is_object() {
        return ("{}".to_string(), false, false);
    }
    let had_secret = sanitize_json(&mut value, app_type);
    (
        serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string()),
        had_secret,
        true,
    )
}

fn config_summary(
    raw: &str,
    app_type: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    if app_type.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "grok" | "grokbuild" | "grok-build"
        )
    }) {
        return crate::provider::grok::summary(raw);
    }
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (None, None, None);
    };
    fn find(value: &Value, keys: &[&str]) -> Option<String> {
        match value {
            Value::Object(object) => {
                for key in keys {
                    if let Some(found) = object
                        .get(*key)
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                    {
                        return Some(found.to_string());
                    }
                }
                object.values().find_map(|child| find(child, keys))
            }
            Value::Array(items) => items.iter().find_map(|child| find(child, keys)),
            Value::String(text) if text.contains('=') => text.lines().find_map(|line| {
                let (key, value) = line.split_once('=')?;
                if keys
                    .iter()
                    .any(|candidate| key.trim().eq_ignore_ascii_case(candidate))
                {
                    Some(value.trim().trim_matches(['"', '\'']).to_string())
                } else {
                    None
                }
            }),
            _ => None,
        }
    }
    (
        find(
            &value,
            &[
                "ANTHROPIC_BASE_URL",
                "OPENAI_BASE_URL",
                "XAI_BASE_URL",
                "base_url",
                "baseUrl",
                "endpoint",
            ],
        ),
        find(
            &value,
            &[
                "ANTHROPIC_MODEL",
                "GROK_DEFAULT_MODEL",
                "default_model",
                "defaultModel",
                "model",
                "model_name",
            ],
        ),
        find(&value, &["api_format", "apiFormat", "format"]),
    )
}

async fn open_source_connection(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "provider_import_source_invalid:corrupt_database".to_string())
}

async fn table_exists(connection: &mut SqliteConnection, name: &str) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
    )
    .bind(name)
    .fetch_one(&mut *connection)
    .await
    .map(|count| count > 0)
    .map_err(|_| "provider_import_source_invalid:corrupt_database".to_string())
}

async fn table_columns(
    connection: &mut SqliteConnection,
    table: &str,
) -> Result<Vec<String>, String> {
    let query = format!("PRAGMA table_info('{}')", table.replace('\'', "''"));
    let rows = sqlx::query(&query)
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| "provider_import_source_invalid:corrupt_database".to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect())
}

async fn read_source_keys(
    connection: &mut SqliteConnection,
    has_key_table: bool,
) -> Result<HashMap<(String, String), Vec<SourceKey>>, String> {
    let mut result: HashMap<(String, String), Vec<SourceKey>> = HashMap::new();
    if !has_key_table {
        return Ok(result);
    }
    let rows = sqlx::query("SELECT * FROM provider_api_keys")
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| "provider_import_source_invalid:unsupported_multi_key_schema".to_string())?;
    for row in rows {
        let Some(provider_id) = row_string(&row, "provider_id") else {
            continue;
        };
        let Some(source_app_type) = row_string(&row, "app_type") else {
            continue;
        };
        let api_key = row_string(&row, "api_key").filter(|value| usable_secret(value));
        let reason = if api_key.is_none() {
            Some("empty_or_oauth_credential".to_string())
        } else {
            None
        };
        let tags = row_string(&row, "tags")
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.as_str().map(str::trim).map(str::to_string))
            .filter(|item| !item.is_empty())
            .collect();
        result
            .entry((source_app_type, provider_id))
            .or_default()
            .push(SourceKey {
                label: row_string(&row, "label").unwrap_or_else(|| IMPORTED_KEY_LABEL.to_string()),
                api_key,
                tags,
                notes: row_string(&row, "notes").unwrap_or_default(),
                enabled: row_bool(&row, "enabled", true),
                sort_index: row_i64(&row, "sort_index").unwrap_or(0),
                is_active: row_bool(&row, "is_active", false),
                reason,
            });
    }
    Ok(result)
}

fn legacy_provider_ids(raw: &str) -> Vec<(String, String)> {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    ["claude", "codex", "grokbuild", "grok"]
        .into_iter()
        .filter_map(|key| {
            let value = root.get(key)?.as_object()?;
            let provider_id = value
                .get("providerId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let app_type = normalize_source_app_type(key)?;
            let native = value.get("schemaVersion").and_then(Value::as_i64) == Some(2)
                && value.get("source").and_then(Value::as_str) == Some("cli-manager")
                && value.get("appType").and_then(Value::as_str) == Some(app_type.as_str());
            (!native).then(|| (app_type, provider_id.to_string()))
        })
        .collect()
}

async fn read_legacy_scopes() -> Result<Vec<LegacyScope>, String> {
    let path = app_paths::db_path()?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "provider_import_application_database_error".to_string())?;
    let mut scopes = Vec::new();
    for (table, scope_kind) in [("projects", "project"), ("worktrees", "worktree")] {
        if !table_exists(&mut connection, table).await? {
            continue;
        }
        let query = format!("SELECT id, provider_overrides FROM {table}");
        let rows = sqlx::query(&query)
            .fetch_all(&mut connection)
            .await
            .map_err(|_| "provider_import_application_database_error".to_string())?;
        for row in rows {
            let Some(scope_id) = row_string(&row, "id") else {
                continue;
            };
            let Some(raw) = row_string(&row, "provider_overrides") else {
                continue;
            };
            for (app_type, source_provider_id) in legacy_provider_ids(&raw) {
                scopes.push(LegacyScope {
                    scope_kind: scope_kind.to_string(),
                    scope_id: scope_id.clone(),
                    app_type,
                    source_provider_id,
                });
            }
        }
    }
    Ok(scopes)
}

fn source_keys_for(
    raw_settings: &str,
    app_type: &str,
    from_table: Vec<SourceKey>,
) -> Vec<SourceKey> {
    let mut keys = from_table;
    let candidates = secret_candidates(raw_settings, app_type);
    if keys.is_empty() {
        for (index, (name, value)) in candidates.into_iter().enumerate() {
            keys.push(SourceKey {
                label: if index == 0 {
                    IMPORTED_KEY_LABEL.to_string()
                } else {
                    format!("Imported {name}")
                },
                api_key: Some(value),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: index as i64,
                is_active: index == 0,
                reason: None,
            });
        }
    }
    keys.sort_by(|left, right| {
        left.sort_index
            .cmp(&right.sort_index)
            .then_with(|| left.label.cmp(&right.label))
            .then_with(|| source_key_digest(left).cmp(&source_key_digest(right)))
    });
    let mut seen = HashSet::new();
    keys.retain(|key| {
        let identity = (key.label.clone(), source_key_digest(key));
        seen.insert(identity)
    });
    let mut used_labels = HashSet::new();
    for key in &mut keys {
        let base_label = if key.label.trim().is_empty() {
            IMPORTED_KEY_LABEL.to_string()
        } else {
            key.label.trim().to_string()
        };
        let mut label = base_label.clone();
        let mut suffix = 2;
        while !used_labels.insert(label.clone()) {
            label = format!("{base_label} ({suffix})");
            suffix += 1;
        }
        key.label = label;
    }
    keys
}

fn source_key_digest(key: &SourceKey) -> Option<String> {
    key.api_key
        .as_deref()
        .map(|value| format!("{:x}", Sha256::digest(value.as_bytes())))
}

async fn scan_source(input: ImportSourceInput) -> Result<SourceSnapshot, String> {
    let source_path = source_path(input.source_path)?;
    let exists = if wsl::is_wsl_config_dir(&source_path.to_string_lossy()) {
        ccswitch_db::wsl_file_exists(&source_path)?
    } else {
        source_path.is_file()
    };
    if !exists {
        return Err("provider_import_source_invalid:source_missing".to_string());
    }
    let prepared_path = ccswitch_db::prepare_read_path(&source_path).await?;
    let bytes = fs::read(prepared_path.path())
        .map_err(|_| "provider_import_source_invalid:source_unreadable".to_string())?;
    let fingerprint = format!("sha256:{:x}", Sha256::digest(bytes));
    let mut connection = open_source_connection(prepared_path.path()).await?;
    let providers_table = table_exists(&mut connection, "providers").await?;
    let settings_table = table_exists(&mut connection, "settings").await?;
    let multi_key_table = table_exists(&mut connection, "provider_api_keys").await?;
    if !providers_table {
        return Err("provider_import_source_invalid:empty_schema".to_string());
    }
    let provider_columns = table_columns(&mut connection, "providers").await?;
    let key_rows = read_source_keys(&mut connection, multi_key_table).await?;
    let rows = sqlx::query("SELECT * FROM providers")
        .fetch_all(&mut connection)
        .await
        .map_err(|_| "provider_import_source_invalid:providers_query_failed".to_string())?;
    let mut providers = Vec::new();
    for row in rows {
        let Some(source_id) = row_string(&row, "id") else {
            continue;
        };
        let source_app_type = row_string(&row, "app_type").unwrap_or_default();
        let settings_config =
            row_string(&row, "settings_config").unwrap_or_else(|| "{}".to_string());
        let app_type = normalize_source_app_type(&source_app_type);
        let (base_url, model, api_format) = config_summary(&settings_config, app_type.as_deref());
        let (_, _, settings_valid) =
            sanitized_settings(&settings_config, app_type.as_deref().unwrap_or("unknown"));
        let keys = app_type
            .as_deref()
            .map(|value| {
                source_keys_for(
                    &settings_config,
                    value,
                    key_rows
                        .get(&(source_app_type.clone(), source_id.clone()))
                        .cloned()
                        .unwrap_or_default(),
                )
            })
            .unwrap_or_default();
        providers.push(SourceProvider {
            source_id,
            source_app_type,
            app_type,
            name: row_string(&row, "name").unwrap_or_else(|| "Imported provider".to_string()),
            settings_config,
            website_url: row_string(&row, "website_url"),
            category: row_string(&row, "category"),
            notes: row_string(&row, "notes"),
            sort_index: row_i64(&row, "sort_index").unwrap_or(0),
            created_at: row_i64(&row, "created_at").unwrap_or(0),
            meta: serde_json::to_string(&Value::Object(row_json_object(&row, "meta")))
                .unwrap_or_else(|_| "{}".to_string()),
            is_current: row_bool(&row, "is_current", false),
            settings_valid,
            base_url,
            model,
            api_format,
            keys,
        });
    }

    let mut common_configs = Vec::new();
    if settings_table {
        let rows = sqlx::query("SELECT key, value FROM settings")
            .fetch_all(&mut connection)
            .await
            .map_err(|_| "provider_import_source_invalid:settings_query_failed".to_string())?;
        for row in rows {
            let Some(key) = row_string(&row, "key") else {
                continue;
            };
            let Some(app_type) = key
                .strip_prefix("common_config_")
                .and_then(normalize_source_app_type)
            else {
                continue;
            };
            let value = row_string(&row, "value").unwrap_or_default();
            common_configs.push(SourceCommon {
                app_type,
                format: if value.trim_start().starts_with('{') {
                    "json".to_string()
                } else {
                    "toml".to_string()
                },
                value,
            });
        }
    }
    let legacy_scopes = read_legacy_scopes().await?;
    drop(connection);
    Ok(SourceSnapshot {
        source_path,
        fingerprint,
        schema: ImportSchemaReport {
            providers_table,
            settings_table,
            multi_key_table,
            provider_columns,
        },
        providers,
        common_configs,
        legacy_scopes,
    })
}

async fn existing_import_ref(
    connection: &mut SqliteConnection,
    source_identity: &str,
    app_type: &str,
    source_provider_id: &str,
) -> Result<Option<(String, String)>, String> {
    sqlx::query(
        "SELECT provider_id, source_fingerprint FROM provider_import_refs
         WHERE source_kind = ?1 AND source_identity = ?2
           AND source_app_type = ?3 AND source_provider_id = ?4",
    )
    .bind(SOURCE_KIND)
    .bind(source_identity)
    .bind(app_type)
    .bind(source_provider_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?
    .map(|row| {
        Ok((
            row.try_get("provider_id")
                .map_err(|_| "provider_import_database_error".to_string())?,
            row.try_get("source_fingerprint")
                .map_err(|_| "provider_import_database_error".to_string())?,
        ))
    })
    .transpose()
}

async fn preview_inner(input: ImportSourceInput) -> Result<ImportPreview, String> {
    let snapshot = scan_source(input).await?;
    let source_identity = snapshot.source_path.to_string_lossy().into_owned();
    let mut native = database::open_connection().await?;
    let mut providers = Vec::with_capacity(snapshot.providers.len());
    let mut native_mapping = HashMap::new();
    for provider in &snapshot.providers {
        let Some(app_type) = provider.app_type.as_deref() else {
            providers.push(ImportProviderPreview {
                source_id: provider.source_id.clone(),
                app_type: provider.source_app_type.clone(),
                name: provider.name.clone(),
                website_url: provider.website_url.clone(),
                category: provider.category.clone(),
                notes: provider.notes.clone(),
                sort_index: provider.sort_index,
                is_current: provider.is_current,
                settings_valid: provider.settings_valid,
                settings_preview: "{}".to_string(),
                settings_has_secret: false,
                base_url: provider.base_url.clone(),
                model: provider.model.clone(),
                api_format: provider.api_format.clone(),
                keys: Vec::new(),
                action: "skip".to_string(),
                native_provider_id: None,
                reason: Some("unsupported_app_type".to_string()),
            });
            continue;
        };
        let mapping =
            existing_import_ref(&mut native, &source_identity, app_type, &provider.source_id)
                .await?;
        let action = match mapping.as_ref() {
            Some((_, fingerprint)) if fingerprint == &snapshot.fingerprint => "unchanged",
            Some(_) => "update",
            None => "create",
        };
        if let Some((native_provider_id, _)) = mapping.as_ref() {
            native_mapping.insert(
                (app_type.to_string(), provider.source_id.clone()),
                native_provider_id.clone(),
            );
        }
        let (settings_preview, settings_has_secret, _) =
            sanitized_settings(&provider.settings_config, app_type);
        providers.push(ImportProviderPreview {
            source_id: provider.source_id.clone(),
            app_type: app_type.to_string(),
            name: provider.name.clone(),
            website_url: provider.website_url.clone(),
            category: provider.category.clone(),
            notes: provider.notes.clone(),
            sort_index: provider.sort_index,
            is_current: provider.is_current,
            settings_valid: provider.settings_valid,
            settings_preview,
            settings_has_secret,
            base_url: provider.base_url.clone(),
            model: provider.model.clone(),
            api_format: provider.api_format.clone(),
            keys: provider
                .keys
                .iter()
                .map(|key| ImportKeyPreview {
                    label: key.label.clone(),
                    tags: key.tags.clone(),
                    notes: key.notes.clone(),
                    enabled: key.enabled,
                    sort_index: key.sort_index,
                    is_active: key.is_active,
                    has_secret: key.api_key.is_some(),
                    masked_api_key: key.api_key.as_deref().map(mask_secret),
                    reason: key.reason.clone(),
                })
                .collect(),
            action: action.to_string(),
            native_provider_id: mapping.map(|(provider_id, _)| provider_id),
            reason: if !provider.settings_valid {
                Some("invalid_settings".to_string())
            } else if !provider.keys.iter().any(|key| key.api_key.is_some()) {
                Some("no_usable_credential".to_string())
            } else {
                None
            },
        });
    }
    let common_configs = snapshot
        .common_configs
        .iter()
        .map(|common| {
            let (sanitized_value, has_secret) = if common.format == "json" {
                let (value, had_secret, valid) =
                    sanitized_settings(&common.value, &common.app_type);
                (if valid { value } else { "{}".to_string() }, had_secret)
            } else {
                let value = sanitize_toml(&common.value, &common.app_type);
                let had_secret = value != common.value;
                (value, had_secret)
            };
            ImportCommonPreview {
                app_type: common.app_type.clone(),
                format: common.format.clone(),
                has_secret,
                fingerprint: format!("sha256:{:x}", Sha256::digest(common.value.as_bytes())),
                sanitized_value,
            }
        })
        .collect();
    let scopes = snapshot
        .legacy_scopes
        .iter()
        .map(|scope| {
            let native_provider_id = native_mapping
                .get(&(scope.app_type.clone(), scope.source_provider_id.clone()))
                .cloned();
            ImportScopePreview {
                scope_kind: scope.scope_kind.clone(),
                scope_id: scope.scope_id.clone(),
                app_type: scope.app_type.clone(),
                source_provider_id: scope.source_provider_id.clone(),
                native_provider_id,
                action: if native_mapping
                    .contains_key(&(scope.app_type.clone(), scope.source_provider_id.clone()))
                {
                    "migrate".to_string()
                } else {
                    "repair".to_string()
                },
                reason: (!native_mapping
                    .contains_key(&(scope.app_type.clone(), scope.source_provider_id.clone())))
                .then_some("unmapped_provider".to_string()),
            }
        })
        .collect();
    Ok(ImportPreview {
        source_kind: SOURCE_KIND.to_string(),
        source_identity: source_identity.clone(),
        source_path: source_identity,
        source_fingerprint: snapshot.fingerprint,
        schema: snapshot.schema,
        providers,
        common_configs,
        scopes,
        warnings: Vec::new(),
    })
}

pub(crate) async fn preview(input: ImportSourceInput) -> Result<ImportPreview, String> {
    preview_inner(input).await
}

fn source_meta(raw: &str, app_type: &str) -> Map<String, Value> {
    let mut value = serde_json::from_str::<Value>(raw)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()));
    sanitize_json(&mut value, app_type);
    let mut meta = value.as_object().cloned().unwrap_or_default();
    meta.entry("enabled".to_string())
        .or_insert(Value::Bool(true));
    meta.entry("commonConfigEnabled".to_string())
        .or_insert(Value::Bool(true));
    meta.insert(
        "importSource".to_string(),
        Value::String(SOURCE_KIND.to_string()),
    );
    meta
}

fn source_key_json(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

async fn import_key(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    provider: &SourceProvider,
    native_provider_id: &str,
    key: &SourceKey,
    allow_secrets: bool,
) -> Result<bool, String> {
    let Some(api_key) = key.api_key.as_deref().filter(|value| usable_secret(value)) else {
        return Ok(false);
    };
    if !allow_secrets {
        return Ok(false);
    }
    let existing_id = sqlx::query_scalar::<_, String>(
        "SELECT id FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2 AND label = ?3",
    )
    .bind(native_provider_id)
    .bind(provider.app_type.as_deref().unwrap_or_default())
    .bind(&key.label)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?;
    let key_id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    sqlx::query(
        "INSERT INTO provider_api_keys
         (id, provider_id, app_type, label, api_key, tags, notes, enabled,
          sort_index, is_active, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)
         ON CONFLICT(provider_id, app_type, label) DO UPDATE SET
           api_key = excluded.api_key, tags = excluded.tags, notes = excluded.notes,
           enabled = excluded.enabled, sort_index = excluded.sort_index,
           updated_at = excluded.updated_at",
    )
    .bind(key_id)
    .bind(native_provider_id)
    .bind(provider.app_type.as_deref().unwrap_or_default())
    .bind(&key.label)
    .bind(api_key)
    .bind(source_key_json(&key.tags))
    .bind(&key.notes)
    .bind(if key.enabled { 1 } else { 0 })
    .bind(key.sort_index)
    .bind(repository::unix_timestamp_millis())
    .execute(&mut **transaction)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?;
    Ok(true)
}

fn selected_import_key(provider: &SourceProvider) -> Option<&SourceKey> {
    provider
        .keys
        .iter()
        .filter(|key| key.enabled && key.api_key.is_some())
        .find(|key| key.is_active)
        .or_else(|| {
            provider
                .keys
                .iter()
                .find(|key| key.enabled && key.api_key.is_some())
        })
}

async fn project_imported_active_key(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    provider: &SourceProvider,
    native_provider_id: &str,
    app_type: &str,
    settings_config: &str,
    allow_secrets: bool,
) -> Result<(String, bool), String> {
    let imported_secret = allow_secrets
        .then(|| selected_import_key(provider))
        .flatten()
        .and_then(|key| key.api_key.as_deref());
    let existing_secret = sqlx::query_scalar::<_, String>(
        "SELECT api_key FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2
           AND is_active = 1 AND enabled = 1
         LIMIT 1",
    )
    .bind(native_provider_id)
    .bind(app_type)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?
    .filter(|value| usable_secret(value));
    let Some(secret) = imported_secret.or(existing_secret.as_deref()) else {
        return Ok((settings_config.to_string(), false));
    };
    repository::project_key_into_settings(app_type, settings_config, secret)
        .map(|projected| (projected, true))
}

async fn set_imported_active_key(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    provider: &SourceProvider,
    native_provider_id: &str,
    allow_secrets: bool,
) -> Result<bool, String> {
    if !allow_secrets {
        return Ok(false);
    }
    let active = selected_import_key(provider);
    let Some(active) = active else {
        return Ok(false);
    };
    sqlx::query(
        "UPDATE provider_api_keys SET is_active = 0
         WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(native_provider_id)
    .bind(provider.app_type.as_deref().unwrap_or_default())
    .execute(&mut **transaction)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?;
    sqlx::query(
        "UPDATE provider_api_keys SET is_active = 1, updated_at = ?1
         WHERE provider_id = ?2 AND app_type = ?3 AND label = ?4 AND enabled = 1",
    )
    .bind(repository::unix_timestamp_millis())
    .bind(native_provider_id)
    .bind(provider.app_type.as_deref().unwrap_or_default())
    .bind(&active.label)
    .execute(&mut **transaction)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?;
    Ok(true)
}

#[derive(Debug, Clone)]
struct LegacyIssue {
    scope_kind: String,
    scope_id: String,
    app_type: String,
    legacy_payload: String,
    reason: String,
}

fn legacy_key(app_type: &str, root: &Map<String, Value>) -> Option<String> {
    if root.get(app_type).is_some() {
        return Some(app_type.to_string());
    }
    (app_type == "grokbuild" && root.get("grok").is_some()).then(|| "grok".to_string())
}

async fn migrate_legacy_scopes(
    scopes: &[LegacyScope],
    mapping: &HashMap<(String, String), (String, String)>,
) -> Result<(usize, Vec<LegacyIssue>), String> {
    let path = app_paths::db_path()?;
    if !path.is_file() || scopes.is_empty() {
        return Ok((0, Vec::new()));
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "provider_import_application_database_error".to_string())?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_import_application_database_error".to_string())?;
    let mut migrated = 0;
    let mut issues = Vec::new();
    for scope in scopes {
        let table = match scope.scope_kind.as_str() {
            "project" => "projects",
            "worktree" => "worktrees",
            _ => continue,
        };
        let query = format!("SELECT provider_overrides FROM {table} WHERE id = ?1");
        let Some(raw) = sqlx::query_scalar::<_, String>(&query)
            .bind(&scope.scope_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| "provider_import_application_database_error".to_string())?
        else {
            continue;
        };
        let Ok(Value::Object(mut root)) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(key) = legacy_key(&scope.app_type, &root) else {
            continue;
        };
        let Some(reference) = root.get(&key).and_then(Value::as_object) else {
            continue;
        };
        let Some(source_provider_id) = reference
            .get("providerId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| *value == scope.source_provider_id)
        else {
            continue;
        };
        let mapping_key = (scope.app_type.clone(), source_provider_id.to_string());
        let Some((native_provider_id, provider_name)) = mapping.get(&mapping_key) else {
            issues.push(LegacyIssue {
                scope_kind: scope.scope_kind.clone(),
                scope_id: scope.scope_id.clone(),
                app_type: scope.app_type.clone(),
                legacy_payload: serde_json::to_string(reference)
                    .unwrap_or_else(|_| "{}".to_string()),
                reason: "unmapped_provider".to_string(),
            });
            continue;
        };
        let next_reference = serde_json::json!({
            "schemaVersion": 2,
            "source": "cli-manager",
            "appType": scope.app_type.clone(),
            "providerId": native_provider_id,
            "providerName": provider_name,
        });
        root.insert(key, next_reference);
        let updated = serde_json::to_string(&Value::Object(root))
            .map_err(|_| "provider_import_application_database_error".to_string())?;
        let update = format!("UPDATE {table} SET provider_overrides = ?1 WHERE id = ?2");
        sqlx::query(&update)
            .bind(updated)
            .bind(&scope.scope_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| "provider_import_application_database_error".to_string())?;
        migrated += 1;
    }
    transaction
        .commit()
        .await
        .map_err(|_| "provider_import_application_database_error".to_string())?;
    Ok((migrated, issues))
}

async fn persist_migration_issues(
    issues: &[LegacyIssue],
    resolved_scopes: &[LegacyScope],
) -> Result<(), String> {
    if issues.is_empty() && resolved_scopes.is_empty() {
        return Ok(());
    }
    let mut connection = database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
    for issue in issues {
        let key = format!(
            "{}:{}:{}:{}",
            issue.scope_kind, issue.scope_id, issue.app_type, issue.legacy_payload
        );
        let id = format!("ccswitch-{:x}", Sha256::digest(key.as_bytes()));
        sqlx::query(
            "INSERT INTO provider_migration_issues
             (id, scope_kind, scope_id, app_type, legacy_payload, reason, created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
             ON CONFLICT(id) DO UPDATE SET legacy_payload = excluded.legacy_payload,
                 reason = excluded.reason, resolved_at = NULL",
        )
        .bind(id)
        .bind(&issue.scope_kind)
        .bind(&issue.scope_id)
        .bind(&issue.app_type)
        .bind(&issue.legacy_payload)
        .bind(&issue.reason)
        .bind(repository::unix_timestamp_millis())
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
    }
    for scope in resolved_scopes {
        sqlx::query(
            "UPDATE provider_migration_issues SET resolved_at = ?1
             WHERE scope_kind = ?2 AND scope_id = ?3 AND app_type = ?4
               AND resolved_at IS NULL",
        )
        .bind(repository::unix_timestamp_millis())
        .bind(&scope.scope_kind)
        .bind(&scope.scope_id)
        .bind(&scope.app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| "provider_import_database_error".to_string())
}

async fn commit_inner(input: ImportCommitInput) -> Result<ImportResult, String> {
    let expected_fingerprint = input.expected_fingerprint.trim().to_string();
    if expected_fingerprint.is_empty() {
        return Err("provider_import_preview_required".to_string());
    }
    let snapshot = scan_source(ImportSourceInput {
        source_path: input.source_path,
    })
    .await?;
    if snapshot.fingerprint != expected_fingerprint {
        return Err("provider_import_source_changed".to_string());
    }
    let source_identity = snapshot.source_path.to_string_lossy().into_owned();
    let mut connection = database::open_connection().await?;
    for provider in &snapshot.providers {
        let Some(app_type) = provider.app_type.as_deref() else {
            continue;
        };
        if let Some((_, fingerprint)) = existing_import_ref(
            &mut connection,
            &source_identity,
            app_type,
            &provider.source_id,
        )
        .await?
        {
            if fingerprint != snapshot.fingerprint && !input.allow_updates {
                return Err("provider_import_conflict".to_string());
            }
        }
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
    let mut imported = 0;
    let mut updated = 0;
    let mut unchanged = 0;
    let mut skipped = 0;
    let mut keys_imported = 0;
    let mut current_candidates = 0;
    let mut native_mapping: HashMap<(String, String), (String, String)> = HashMap::new();
    let now = repository::unix_timestamp_millis();
    for provider in &snapshot.providers {
        let Some(app_type) = provider.app_type.as_deref() else {
            skipped += 1;
            continue;
        };
        let existing = sqlx::query(
            "SELECT provider_id, source_fingerprint FROM provider_import_refs
             WHERE source_kind = ?1 AND source_identity = ?2
               AND source_app_type = ?3 AND source_provider_id = ?4",
        )
        .bind(SOURCE_KIND)
        .bind(&source_identity)
        .bind(app_type)
        .bind(&provider.source_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
        let (native_provider_id, previous_fingerprint) = match existing {
            Some(row) => (
                row.try_get::<String, _>("provider_id")
                    .map_err(|_| "provider_import_database_error".to_string())?,
                Some(
                    row.try_get::<String, _>("source_fingerprint")
                        .map_err(|_| "provider_import_database_error".to_string())?,
                ),
            ),
            None => (Uuid::new_v4().to_string(), None),
        };
        let (settings_config, _, settings_valid) =
            sanitized_settings(&provider.settings_config, app_type);
        if !settings_valid {
            skipped += 1;
            continue;
        }
        let (settings_config, has_projected_key) = project_imported_active_key(
            &mut transaction,
            provider,
            &native_provider_id,
            app_type,
            &settings_config,
            input.allow_secrets,
        )
        .await?;
        let mut meta_value = source_meta(&provider.meta, app_type);
        if !has_projected_key {
            meta_value.insert(
                "importStatus".to_string(),
                Value::String("draft".to_string()),
            );
        }
        let meta = serde_json::to_string(&Value::Object(meta_value))
            .map_err(|_| "provider_import_database_error".to_string())?;
        sqlx::query(
            "INSERT INTO providers
             (id, app_type, name, settings_config, website_url, category, created_at,
              sort_index, notes, icon, icon_color, meta, is_current)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, 0)
             ON CONFLICT(id, app_type) DO UPDATE SET
               name = excluded.name, settings_config = excluded.settings_config,
               website_url = excluded.website_url, category = excluded.category,
               sort_index = excluded.sort_index, notes = excluded.notes, meta = excluded.meta",
        )
        .bind(&native_provider_id)
        .bind(app_type)
        .bind(&provider.name)
        .bind(&settings_config)
        .bind(&provider.website_url)
        .bind(&provider.category)
        .bind(if provider.created_at > 0 {
            provider.created_at
        } else {
            now
        })
        .bind(provider.sort_index)
        .bind(&provider.notes)
        .bind(meta)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
        native_mapping.insert(
            (app_type.to_string(), provider.source_id.clone()),
            (native_provider_id.clone(), provider.name.clone()),
        );
        let mut provider_key_count = 0;
        for key in &provider.keys {
            if import_key(
                &mut transaction,
                provider,
                &native_provider_id,
                key,
                input.allow_secrets,
            )
            .await?
            {
                provider_key_count += 1;
            }
        }
        keys_imported += provider_key_count;
        let has_active_key = set_imported_active_key(
            &mut transaction,
            provider,
            &native_provider_id,
            input.allow_secrets,
        )
        .await?;
        if provider.is_current && has_active_key {
            current_candidates += 1;
        }
        sqlx::query(
            "INSERT INTO provider_import_refs
             (source_kind, source_identity, source_app_type, source_provider_id,
              source_fingerprint, provider_id, app_type, imported_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?3, ?7)
             ON CONFLICT(source_kind, source_identity, source_app_type, source_provider_id)
             DO UPDATE SET source_fingerprint = excluded.source_fingerprint,
                           provider_id = excluded.provider_id,
                           app_type = excluded.app_type,
                           imported_at = excluded.imported_at",
        )
        .bind(SOURCE_KIND)
        .bind(&source_identity)
        .bind(app_type)
        .bind(&provider.source_id)
        .bind(&snapshot.fingerprint)
        .bind(&native_provider_id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
        match previous_fingerprint {
            Some(fingerprint) if fingerprint == snapshot.fingerprint => unchanged += 1,
            Some(_) => updated += 1,
            None => imported += 1,
        }
    }
    for common in &snapshot.common_configs {
        let value = if common.format == "json" {
            let (value, _, valid) = sanitized_settings(&common.value, &common.app_type);
            if valid {
                value
            } else {
                "{}".to_string()
            }
        } else {
            sanitize_toml(&common.value, &common.app_type)
        };
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(format!("common_config_{}", common.app_type))
        .bind(value)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| "provider_import_database_error".to_string())?;
    let (migrated_scopes, issues) =
        migrate_legacy_scopes(&snapshot.legacy_scopes, &native_mapping).await?;
    let resolved_scopes = snapshot
        .legacy_scopes
        .iter()
        .filter(|scope| {
            native_mapping.contains_key(&(scope.app_type.clone(), scope.source_provider_id.clone()))
        })
        .cloned()
        .collect::<Vec<_>>();
    persist_migration_issues(&issues, &resolved_scopes).await?;
    Ok(ImportResult {
        source_kind: SOURCE_KIND.to_string(),
        source_identity: source_identity.clone(),
        source_fingerprint: snapshot.fingerprint,
        imported,
        updated,
        unchanged,
        skipped,
        keys_imported,
        current_candidates,
        migrated_scopes,
        repair_issues: issues.len(),
        warnings: if input.allow_secrets {
            Vec::new()
        } else {
            vec!["provider_import_keys_skipped_without_consent".to_string()]
        },
    })
}

pub(crate) async fn commit(input: ImportCommitInput) -> Result<ImportResult, String> {
    commit_inner(input).await
}

pub(crate) async fn list_issues() -> Result<Vec<ImportIssue>, String> {
    let mut connection = database::open_connection().await?;
    let rows = sqlx::query(
        "SELECT id, scope_kind, scope_id, app_type, legacy_payload, reason, created_at
         FROM provider_migration_issues WHERE resolved_at IS NULL
         ORDER BY created_at, scope_kind, scope_id",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?;
    rows.into_iter()
        .map(|row| {
            let legacy_payload: String = row
                .try_get("legacy_payload")
                .map_err(|_| "provider_import_database_error".to_string())?;
            let source_provider_id = serde_json::from_str::<Value>(&legacy_payload)
                .ok()
                .and_then(|value| {
                    value
                        .get("providerId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            Ok(ImportIssue {
                id: row
                    .try_get("id")
                    .map_err(|_| "provider_import_database_error".to_string())?,
                scope_kind: row
                    .try_get("scope_kind")
                    .map_err(|_| "provider_import_database_error".to_string())?,
                scope_id: row
                    .try_get("scope_id")
                    .map_err(|_| "provider_import_database_error".to_string())?,
                app_type: row
                    .try_get("app_type")
                    .map_err(|_| "provider_import_database_error".to_string())?,
                source_provider_id,
                reason: row
                    .try_get("reason")
                    .map_err(|_| "provider_import_database_error".to_string())?,
                created_at: row
                    .try_get("created_at")
                    .map_err(|_| "provider_import_database_error".to_string())?,
            })
        })
        .collect()
}

pub(crate) async fn resolve_issue(input: ImportIssueResolveInput) -> Result<(), String> {
    let issue_id = input.issue_id.trim();
    let provider_id = input.provider_id.trim();
    if issue_id.is_empty() || provider_id.is_empty() {
        return Err("provider_import_issue_input_invalid".to_string());
    }
    let mut native = database::open_connection().await?;
    let issue = sqlx::query(
        "SELECT scope_kind, scope_id, app_type FROM provider_migration_issues
         WHERE id = ?1 AND resolved_at IS NULL",
    )
    .bind(issue_id)
    .fetch_optional(&mut native)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?
    .ok_or_else(|| "provider_import_issue_not_found".to_string())?;
    let scope_kind: String = issue
        .try_get("scope_kind")
        .map_err(|_| "provider_import_database_error".to_string())?;
    let scope_id: String = issue
        .try_get("scope_id")
        .map_err(|_| "provider_import_database_error".to_string())?;
    let app_type: String = issue
        .try_get("app_type")
        .map_err(|_| "provider_import_database_error".to_string())?;
    let provider_name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM providers WHERE id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(&app_type)
    .fetch_optional(&mut native)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?
    .ok_or_else(|| "provider_not_found".to_string())?;
    drop(native);

    let path = app_paths::db_path()?;
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(5));
    let mut app_connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "provider_import_application_database_error".to_string())?;
    let table = match scope_kind.as_str() {
        "project" => "projects",
        "worktree" => "worktrees",
        _ => return Err("provider_import_issue_scope_invalid".to_string()),
    };
    let query = format!("SELECT provider_overrides FROM {table} WHERE id = ?1");
    let raw = sqlx::query_scalar::<_, String>(&query)
        .bind(&scope_id)
        .fetch_optional(&mut app_connection)
        .await
        .map_err(|_| "provider_import_application_database_error".to_string())?
        .ok_or_else(|| "provider_import_issue_scope_not_found".to_string())?;
    let mut root = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let key = legacy_key(&app_type, &root).unwrap_or_else(|| app_type.clone());
    root.insert(
        key,
        serde_json::json!({
            "schemaVersion": 2,
            "source": "cli-manager",
            "appType": app_type,
            "providerId": provider_id,
            "providerName": provider_name,
        }),
    );
    let updated = serde_json::to_string(&Value::Object(root))
        .map_err(|_| "provider_import_application_database_error".to_string())?;
    let update = format!("UPDATE {table} SET provider_overrides = ?1 WHERE id = ?2");
    sqlx::query(&update)
        .bind(updated)
        .bind(&scope_id)
        .execute(&mut app_connection)
        .await
        .map_err(|_| "provider_import_application_database_error".to_string())?;
    drop(app_connection);

    let mut native = database::open_connection().await?;
    sqlx::query(
        "UPDATE provider_migration_issues SET resolved_at = ?1
         WHERE id = ?2 AND resolved_at IS NULL",
    )
    .bind(repository::unix_timestamp_millis())
    .bind(issue_id)
    .execute(&mut native)
    .await
    .map_err(|_| "provider_import_database_error".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_app_type_aliases_are_normalized() {
        assert_eq!(
            normalize_source_app_type("grok"),
            Some("grokbuild".to_string())
        );
        assert_eq!(normalize_source_app_type("Claude Code"), None);
        assert_eq!(
            normalize_source_app_type("codex"),
            Some("codex".to_string())
        );
    }

    #[test]
    fn import_preview_never_returns_secret_values() {
        let raw = r#"{"env":{"ANTHROPIC_API_KEY":"sk-secret-value","ANTHROPIC_BASE_URL":"https://example.test"}}"#;
        let candidates = secret_candidates(raw, "claude");
        assert_eq!(candidates.len(), 1);
        assert_eq!(mask_secret(&candidates[0].1), "sk-s…alue");
        let (sanitized, had_secret, valid) = sanitized_settings(raw, "claude");
        assert!(had_secret && valid);
        assert!(!sanitized.contains("sk-secret-value"));
    }

    #[test]
    fn oauth_and_empty_credentials_are_not_imported_as_active_keys() {
        let raw = r#"{"auth":{"access_token":"oauth-value","ANTHROPIC_API_KEY":""}}"#;
        assert!(secret_candidates(raw, "claude").is_empty());
    }

    #[test]
    fn imported_metadata_is_redacted() {
        let meta = source_meta(
            r#"{"api_key":"secret","access_token":"oauth-secret","authorization":"Bearer secret-2","clientSecret":"secret-3","label":"provider","nested":{"token":"secret-4"}}"#,
            "claude",
        );
        assert!(!serde_json::to_string(&meta).unwrap().contains("secret"));
        assert_eq!(meta.get("label").and_then(Value::as_str), Some("provider"));
    }

    #[test]
    fn generic_sensitive_toml_fields_are_redacted() {
        let sanitized = sanitize_toml(
            "api_key = \"secret\"\nauthorization = \"Bearer secret\"\nprovider = { client_secret = \"nested-secret\" }\nmodel = \"keep\"\n",
            "codex",
        );
        assert!(!sanitized.contains("Bearer secret"));
        assert!(!sanitized.contains("nested-secret"));
        assert!(sanitized.contains("model = \"keep\""));
    }

    #[test]
    fn every_toml_array_of_tables_entry_is_redacted() {
        let sanitized = sanitize_toml(
            "[[profiles]]\napi_key = \"first-secret\"\nmodel = \"one\"\n\n[[profiles]]\napi_key = \"second-secret\"\nmodel = \"two\"\n",
            "codex",
        );
        assert!(!sanitized.contains("first-secret"));
        assert!(!sanitized.contains("second-secret"));
        assert!(sanitized.contains("model = \"one\""));
        assert!(sanitized.contains("model = \"two\""));
    }

    #[test]
    fn every_json_array_entry_is_redacted() {
        let (sanitized, had_secret, valid) = sanitized_settings(
            r#"{"profiles":[{"api_key":"first-secret"},{"api_key":"second-secret"}]}"#,
            "codex",
        );
        assert!(had_secret && valid);
        assert!(!sanitized.contains("first-secret"));
        assert!(!sanitized.contains("second-secret"));
    }

    #[test]
    fn selected_import_key_prefers_enabled_source_active_key() {
        let provider = SourceProvider {
            source_id: "source-1".to_string(),
            source_app_type: "codex".to_string(),
            app_type: Some("codex".to_string()),
            name: "Provider".to_string(),
            settings_config: "{}".to_string(),
            website_url: None,
            category: None,
            notes: None,
            sort_index: 0,
            created_at: 0,
            meta: "{}".to_string(),
            is_current: false,
            settings_valid: true,
            base_url: None,
            model: None,
            api_format: None,
            keys: vec![
                SourceKey {
                    label: "inactive".to_string(),
                    api_key: Some("sk-inactive".to_string()),
                    tags: Vec::new(),
                    notes: String::new(),
                    enabled: true,
                    sort_index: 0,
                    is_active: false,
                    reason: None,
                },
                SourceKey {
                    label: "active".to_string(),
                    api_key: Some("sk-active".to_string()),
                    tags: Vec::new(),
                    notes: String::new(),
                    enabled: true,
                    sort_index: 1,
                    is_active: true,
                    reason: None,
                },
            ],
        };

        assert_eq!(
            selected_import_key(&provider).map(|key| key.label.as_str()),
            Some("active")
        );
    }

    #[test]
    fn source_key_dedup_preserves_distinct_short_secrets() {
        let keys = source_keys_for(
            "{}",
            "claude",
            vec![
                SourceKey {
                    label: "Primary".to_string(),
                    api_key: Some("short-a".to_string()),
                    tags: Vec::new(),
                    notes: String::new(),
                    enabled: true,
                    sort_index: 0,
                    is_active: true,
                    reason: None,
                },
                SourceKey {
                    label: "Backup".to_string(),
                    api_key: Some("short-b".to_string()),
                    tags: Vec::new(),
                    notes: String::new(),
                    enabled: true,
                    sort_index: 1,
                    is_active: false,
                    reason: None,
                },
            ],
        );

        assert_eq!(keys.len(), 2);
    }

    #[test]
    fn source_key_labels_are_unique_when_source_reuses_a_label() {
        let keys = source_keys_for(
            "{}",
            "claude",
            vec![
                SourceKey {
                    label: "Primary".to_string(),
                    api_key: Some("secret-a".to_string()),
                    tags: Vec::new(),
                    notes: String::new(),
                    enabled: true,
                    sort_index: 0,
                    is_active: true,
                    reason: None,
                },
                SourceKey {
                    label: "Primary".to_string(),
                    api_key: Some("secret-b".to_string()),
                    tags: Vec::new(),
                    notes: String::new(),
                    enabled: true,
                    sort_index: 1,
                    is_active: false,
                    reason: None,
                },
            ],
        );

        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].label, "Primary");
        assert_eq!(keys[1].label, "Primary (2)");
        assert_eq!(keys[0].api_key.as_deref(), Some("secret-a"));
        assert_eq!(keys[1].api_key.as_deref(), Some("secret-b"));
    }

    #[test]
    fn source_keys_are_stably_sorted_by_source_order() {
        let keys = source_keys_for(
            "{}",
            "claude",
            vec![
                SourceKey {
                    label: "Later".to_string(),
                    api_key: Some("secret-b".to_string()),
                    tags: Vec::new(),
                    notes: String::new(),
                    enabled: true,
                    sort_index: 20,
                    is_active: false,
                    reason: None,
                },
                SourceKey {
                    label: "Earlier".to_string(),
                    api_key: Some("secret-a".to_string()),
                    tags: Vec::new(),
                    notes: String::new(),
                    enabled: true,
                    sort_index: 10,
                    is_active: true,
                    reason: None,
                },
            ],
        );

        assert_eq!(
            keys.iter()
                .map(|key| key.label.as_str())
                .collect::<Vec<_>>(),
            ["Earlier", "Later"]
        );
    }
}
