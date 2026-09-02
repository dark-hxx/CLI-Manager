use super::dto::{
    ClaudeConfig, ClaudeConfigInput, ProviderCard, ProviderKeySummary, ProviderRecord,
};
use crate::provider::grok;
use serde_json::{Map, Value};
use sqlx::{Row, SqliteConnection};
use std::time::{SystemTime, UNIX_EPOCH};

const SECRET_KEY_MARKERS: [&str; 6] = [
    "token",
    "key",
    "secret",
    "password",
    "credential",
    "authorization",
];

pub(crate) fn error(code: &str, detail: impl AsRef<str>) -> String {
    let detail = detail.as_ref().trim();
    if detail.is_empty() {
        code.to_string()
    } else {
        format!("{code}:{detail}")
    }
}

pub(crate) fn map_database_error(context: &str, err: sqlx::Error) -> String {
    let text = err.to_string().to_ascii_lowercase();
    if text.contains("idx_providers_one_current") {
        return error("provider_current_conflict", context);
    }
    if text.contains("idx_provider_api_keys_one_active") {
        return error("provider_key_active_conflict", context);
    }
    if text.contains("unique constraint") && text.contains("label") {
        return error("provider_key_label_conflict", context);
    }
    error("provider_database_error", context)
}

pub(crate) fn normalize_app_type(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "claude" => Ok("claude".to_string()),
        "codex" => Ok("codex".to_string()),
        "grok" | "grokbuild" | "grok-build" | "grok_build" => Ok("grokbuild".to_string()),
        _ => Err(error("provider_invalid_app_type", value)),
    }
}

pub(crate) fn required_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(error("provider_name_required", "name"));
    }
    if value.chars().count() > 120 {
        return Err(error("provider_name_too_long", "name"));
    }
    Ok(value.to_string())
}

pub(crate) fn optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

pub(crate) fn optional_text_value(value: String) -> Option<String> {
    optional_text(Some(value))
}

pub(crate) fn normalize_settings_config(value: Option<String>) -> Result<String, String> {
    let value = value.unwrap_or_else(|| "{}".to_string());
    let trimmed = value.trim();
    let parsed: Value = serde_json::from_str(trimmed)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    if !parsed.is_object() {
        return Err(error("provider_settings_must_be_object", "settings_config"));
    }
    serde_json::to_string(&parsed).map_err(|_| error("provider_settings_serialize_failed", ""))
}

fn set_optional_json_string(object: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    let Some(value) = value.map(str::trim) else {
        return;
    };
    if value.is_empty() {
        object.remove(key);
    } else {
        object.insert(key.to_string(), Value::String(value.to_string()));
    }
}

const CLAUDE_API_FORMATS: [&str; 4] = [
    "anthropic",
    "openai_chat",
    "openai_responses",
    "gemini_native",
];

const CLAUDE_AUTH_FIELDS: [&str; 2] = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

fn claude_text(env: &Map<String, Value>, key: &str) -> Option<String> {
    env.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn selected_claude_auth_field(env: &Map<String, Value>) -> &'static str {
    let has_auth_token = env.contains_key("ANTHROPIC_AUTH_TOKEN");
    let has_api_key = env.contains_key("ANTHROPIC_API_KEY");
    match (has_auth_token, has_api_key) {
        (true, true) if claude_text(env, "ANTHROPIC_AUTH_TOKEN").is_none() => {
            "ANTHROPIC_AUTH_TOKEN"
        }
        (true, true) if claude_text(env, "ANTHROPIC_API_KEY").is_none() => "ANTHROPIC_API_KEY",
        (false, true) => "ANTHROPIC_API_KEY",
        _ => "ANTHROPIC_AUTH_TOKEN",
    }
}

fn strip_claude_one_m_marker(value: &str) -> String {
    let trimmed = value.trim_end();
    if trimmed
        .get(trimmed.len().saturating_sub(4)..)
        .map(|marker| marker.eq_ignore_ascii_case("[1m]"))
        .unwrap_or(false)
    {
        return trimmed[..trimmed.len() - 4].trim_end().to_string();
    }
    trimmed.to_string()
}

fn apply_claude_env_field(env: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    set_optional_json_string(env, key, value);
}

pub(crate) fn apply_claude_config_fields(
    raw: &str,
    input: Option<&ClaudeConfigInput>,
) -> Result<String, String> {
    let Some(input) = input else {
        return Ok(raw.to_string());
    };
    let mut value = serde_json::from_str::<Value>(raw)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| error("provider_settings_must_be_object", "settings_config"))?;
    if let Some(api_format) = input.api_format.as_deref().map(str::trim) {
        if !CLAUDE_API_FORMATS.contains(&api_format) {
            return Err(error("provider_claude_api_format_invalid", api_format));
        }
        set_optional_json_string(object, "api_format", Some(api_format));
    }
    let env = object
        .entry("env")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| error("provider_settings_env_invalid", "env"))?;

    for (key, field_value) in [
        ("ANTHROPIC_MODEL", input.model.as_deref()),
        (
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            input.default_haiku_model.as_deref(),
        ),
        (
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            input.default_haiku_model_name.as_deref(),
        ),
        (
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            input.default_sonnet_model.as_deref(),
        ),
        (
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            input.default_sonnet_model_name.as_deref(),
        ),
        (
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            input.default_opus_model.as_deref(),
        ),
        (
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            input.default_opus_model_name.as_deref(),
        ),
        (
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            input.default_fable_model.as_deref(),
        ),
        (
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
            input.default_fable_model_name.as_deref(),
        ),
        (
            "CLAUDE_CODE_SUBAGENT_MODEL",
            input.subagent_model.as_deref(),
        ),
    ] {
        apply_claude_env_field(env, key, field_value);
    }

    if let Some(api_key_field) = input.api_key_field.as_deref().map(str::trim) {
        if !CLAUDE_AUTH_FIELDS.contains(&api_key_field) {
            return Err(error("provider_claude_auth_field_invalid", api_key_field));
        }
        let other = if api_key_field == "ANTHROPIC_API_KEY" {
            "ANTHROPIC_AUTH_TOKEN"
        } else {
            "ANTHROPIC_API_KEY"
        };
        let existing_secret = claude_text(env, api_key_field).or_else(|| claude_text(env, other));
        env.remove(other);
        env.insert(
            api_key_field.to_string(),
            Value::String(existing_secret.unwrap_or_default()),
        );
    }

    serde_json::to_string(&value).map_err(|_| error("provider_settings_serialize_failed", ""))
}

pub(crate) fn apply_claude_meta(meta: &mut Map<String, Value>, input: Option<&ClaudeConfigInput>) {
    if let Some(is_full_url) = input.and_then(|value| value.is_full_url) {
        meta.insert("claudeIsFullUrl".to_string(), Value::Bool(is_full_url));
    }
}

pub(crate) fn claude_config_from_settings(raw: &str, meta: &Map<String, Value>) -> ClaudeConfig {
    let value = serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::Object(Map::new()));
    let object = value.as_object();
    let env = object
        .and_then(|root| root.get("env"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let model = claude_text(&env, "ANTHROPIC_MODEL").unwrap_or_default();
    let sonnet =
        claude_text(&env, "ANTHROPIC_DEFAULT_SONNET_MODEL").unwrap_or_else(|| model.clone());
    let opus = claude_text(&env, "ANTHROPIC_DEFAULT_OPUS_MODEL").unwrap_or_else(|| model.clone());
    let fable = claude_text(&env, "ANTHROPIC_DEFAULT_FABLE_MODEL").unwrap_or_else(|| opus.clone());
    let haiku = claude_text(&env, "ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .or_else(|| claude_text(&env, "ANTHROPIC_SMALL_FAST_MODEL"))
        .unwrap_or_else(|| model.clone());
    let text_or_model = |key: &str, fallback: &str| {
        claude_text(&env, key).unwrap_or_else(|| strip_claude_one_m_marker(fallback))
    };
    let api_format = object
        .and_then(|root| root.get("api_format"))
        .and_then(Value::as_str)
        .filter(|value| CLAUDE_API_FORMATS.contains(value))
        .unwrap_or("anthropic")
        .to_string();
    let api_key_field = selected_claude_auth_field(&env);
    ClaudeConfig {
        api_format,
        api_key_field: api_key_field.to_string(),
        is_full_url: meta
            .get("claudeIsFullUrl")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        model: model.clone(),
        default_haiku_model: haiku.clone(),
        default_haiku_model_name: text_or_model("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", &haiku),
        default_sonnet_model: sonnet.clone(),
        default_sonnet_model_name: text_or_model("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", &sonnet),
        default_opus_model: opus.clone(),
        default_opus_model_name: text_or_model("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", &opus),
        default_fable_model: fable.clone(),
        default_fable_model_name: text_or_model("ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", &fable),
        subagent_model: claude_text(&env, "CLAUDE_CODE_SUBAGENT_MODEL").unwrap_or_default(),
    }
}

pub(crate) fn apply_config_fields(
    app_type: &str,
    raw: &str,
    base_url: Option<&str>,
    model: Option<&str>,
    api_format: Option<&str>,
) -> Result<String, String> {
    if base_url.is_none() && model.is_none() && api_format.is_none() {
        return Ok(raw.to_string());
    }

    if app_type == "grokbuild" {
        return grok::apply_typed_fields(raw, base_url, model, api_format);
    }

    let mut value = serde_json::from_str::<Value>(raw)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| error("provider_settings_must_be_object", "settings_config"))?;

    match app_type {
        "claude" => {
            let env = object
                .entry("env")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| error("provider_settings_env_invalid", "env"))?;
            set_optional_json_string(env, "ANTHROPIC_BASE_URL", base_url);
            set_optional_json_string(env, "ANTHROPIC_MODEL", model);
            set_optional_json_string(object, "api_format", api_format);
        }
        "codex" | "grokbuild" => {
            set_optional_json_string(object, "base_url", base_url);
            set_optional_json_string(object, "model", model);
            set_optional_json_string(object, "api_format", api_format);
        }
        _ => return Err(error("provider_invalid_app_type", app_type)),
    }

    serde_json::to_string(&value).map_err(|_| error("provider_settings_serialize_failed", ""))
}

pub(crate) fn unix_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

pub(crate) fn parse_meta(raw: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

pub(crate) fn meta_enabled(meta: &Map<String, Value>) -> bool {
    meta.get("enabled").and_then(Value::as_bool).unwrap_or(true)
}

pub(crate) fn meta_common_config_enabled(meta: &Map<String, Value>) -> bool {
    meta.get("commonConfigEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub(crate) fn serialize_meta(meta: Map<String, Value>) -> Result<String, String> {
    serde_json::to_string(&Value::Object(meta))
        .map_err(|_| error("provider_meta_serialize_failed", ""))
}

pub(crate) fn is_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    SECRET_KEY_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
}

pub(crate) fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 12 {
        return "***".to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

pub(crate) fn redact_json(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => {
            let mut found_secret = false;
            for (key, child) in object.iter_mut() {
                if is_secret_key(key) {
                    let replacement = match child {
                        Value::String(value) => Value::String(mask_secret(value)),
                        _ => Value::String("[REDACTED]".to_string()),
                    };
                    *child = replacement;
                    found_secret = true;
                } else if redact_json(child) {
                    found_secret = true;
                }
            }
            found_secret
        }
        Value::Array(items) => items.iter_mut().any(redact_json),
        _ => false,
    }
}

pub(crate) fn redact_settings_config(raw: &str) -> (String, bool, bool) {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        let has_secret = SECRET_KEY_MARKERS
            .iter()
            .any(|marker| raw.to_ascii_lowercase().contains(marker));
        return (
            if has_secret {
                "[REDACTED SETTINGS CONFIG]".to_string()
            } else {
                raw.to_string()
            },
            has_secret,
            false,
        );
    };
    let has_secret = redact_json(&mut value);
    let redacted = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string());
    (redacted, has_secret, true)
}

pub(crate) fn strip_json_secrets(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => {
            let secret_keys = object
                .keys()
                .filter(|key| is_secret_key(key))
                .cloned()
                .collect::<Vec<_>>();
            let mut found_secret = !secret_keys.is_empty();
            for key in secret_keys {
                object.remove(&key);
            }
            for (key, child) in object.iter_mut() {
                if key.eq_ignore_ascii_case("config") {
                    if let Value::String(text) = child {
                        let lower = text.to_ascii_lowercase();
                        if SECRET_KEY_MARKERS
                            .iter()
                            .any(|marker| lower.contains(marker))
                        {
                            *child = Value::String(String::new());
                            found_secret = true;
                            continue;
                        }
                    }
                }
                if strip_json_secrets(child) {
                    found_secret = true;
                }
            }
            found_secret
        }
        Value::Array(items) => items.iter_mut().any(strip_json_secrets),
        _ => false,
    }
}

pub(crate) fn duplicate_settings_config(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return "{}".to_string();
    };
    strip_json_secrets(&mut value);
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

fn first_json_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(found) = object
                    .get(*key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    return Some(found.to_string());
                }
            }
            object
                .values()
                .find_map(|child| first_json_string(child, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| first_json_string(child, keys)),
        _ => None,
    }
}

fn first_toml_edit_string(item: &toml_edit::Item, keys: &[&str]) -> Option<String> {
    match item {
        toml_edit::Item::Table(table) => {
            for key in keys {
                if let Some(found) = table
                    .get(key)
                    .and_then(toml_edit::Item::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    return Some(found.to_string());
                }
            }
            table
                .iter()
                .find_map(|(_, child)| first_toml_edit_string(child, keys))
        }
        toml_edit::Item::Value(value) => value.as_inline_table().and_then(|table| {
            table.iter().find_map(|(key, child)| {
                if keys.iter().any(|candidate| *candidate == key) {
                    child
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                } else {
                    None
                }
            })
        }),
        _ => None,
    }
}

pub(crate) fn config_summary(
    app_type: &str,
    raw: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    if app_type == "grokbuild" {
        return grok::summary(raw);
    }
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (None, None, None);
    };
    let mut base_url = first_json_string(
        &value,
        &[
            "ANTHROPIC_BASE_URL",
            "OPENAI_BASE_URL",
            "base_url",
            "baseUrl",
            "api_base_url",
            "apiBaseUrl",
            "endpoint",
        ],
    );
    let mut model = first_json_string(
        &value,
        &[
            "ANTHROPIC_MODEL",
            "GROK_DEFAULT_MODEL",
            "default_model",
            "defaultModel",
            "model",
            "model_name",
            "modelName",
        ],
    );
    if let Some(config) = value.get("config").and_then(Value::as_str) {
        if let Ok(toml_value) = config.parse::<toml_edit::DocumentMut>() {
            base_url = base_url.or_else(|| {
                first_toml_edit_string(toml_value.as_item(), &["base_url", "baseUrl", "endpoint"])
            });
            model = model.or_else(|| {
                first_toml_edit_string(
                    toml_value.as_item(),
                    &["model", "default_model", "model_provider"],
                )
            });
        }
    }
    let api_format = first_json_string(&value, &["api_format", "apiFormat", "format"]);
    let _ = app_type;
    (base_url, model, api_format)
}

pub(crate) fn provider_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ProviderRecord, String> {
    Ok(ProviderRecord {
        id: row
            .try_get("id")
            .map_err(|_| error("provider_row_invalid", "id"))?,
        app_type: row
            .try_get("app_type")
            .map_err(|_| error("provider_row_invalid", "app_type"))?,
        name: row
            .try_get("name")
            .map_err(|_| error("provider_row_invalid", "name"))?,
        settings_config: row
            .try_get("settings_config")
            .map_err(|_| error("provider_row_invalid", "settings_config"))?,
        website_url: row.try_get("website_url").ok(),
        category: row.try_get("category").ok(),
        created_at: row
            .try_get("created_at")
            .map_err(|_| error("provider_row_invalid", "created_at"))?,
        sort_index: row
            .try_get("sort_index")
            .map_err(|_| error("provider_row_invalid", "sort_index"))?,
        notes: row.try_get("notes").ok(),
        icon: row.try_get("icon").ok(),
        icon_color: row.try_get("icon_color").ok(),
        meta: row
            .try_get("meta")
            .map_err(|_| error("provider_row_invalid", "meta"))?,
        is_current: row
            .try_get::<i64, _>("is_current")
            .map_err(|_| error("provider_row_invalid", "is_current"))?
            != 0,
    })
}

pub(crate) async fn load_provider(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<ProviderRecord, String> {
    let row = sqlx::query(
        "SELECT id, app_type, name, settings_config, website_url, category,
                created_at, sort_index, notes, icon, icon_color, meta, is_current
         FROM providers WHERE id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_load_failed", err))?
    .ok_or_else(|| error("provider_not_found", provider_id))?;
    provider_from_row(&row)
}

pub(crate) async fn key_count(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_api_keys WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_one(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_key_count_failed", err))
}

pub(crate) async fn active_key_label(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<Option<String>, String> {
    sqlx::query_scalar(
        "SELECT label FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2 AND is_active = 1 AND enabled = 1
         LIMIT 1",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_active_key_failed", err))
}

pub(crate) fn card_from_record(
    record: &ProviderRecord,
    key_count: i64,
    active_key_label: Option<String>,
) -> ProviderCard {
    let meta = parse_meta(&record.meta);
    let (base_url, model, api_format) = config_summary(&record.app_type, &record.settings_config);
    let settings_valid = serde_json::from_str::<Value>(&record.settings_config)
        .map(|value| value.is_object())
        .unwrap_or(false);
    ProviderCard {
        id: record.id.clone(),
        app_type: record.app_type.clone(),
        name: record.name.clone(),
        website_url: record.website_url.clone(),
        category: record.category.clone(),
        notes: record.notes.clone(),
        icon: record.icon.clone(),
        icon_color: record.icon_color.clone(),
        sort_index: record.sort_index,
        created_at: record.created_at,
        is_current: record.is_current,
        enabled: meta_enabled(&meta),
        key_count,
        active_key_label,
        base_url,
        model,
        api_format,
        settings_valid,
        common_config_enabled: meta_common_config_enabled(&meta),
    }
}

pub(crate) async fn card_from_record_with_connection(
    connection: &mut SqliteConnection,
    record: &ProviderRecord,
) -> Result<ProviderCard, String> {
    let count = key_count(connection, &record.app_type, &record.id).await?;
    let active = active_key_label(connection, &record.app_type, &record.id).await?;
    Ok(card_from_record(record, count, active))
}

pub(crate) fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::trim).map(str::to_string))
        .filter(|value| !value.is_empty())
        .collect()
}

pub(crate) fn normalize_tags(tags: Option<Vec<String>>) -> Result<String, String> {
    let tags = tags
        .unwrap_or_default()
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    serde_json::to_string(&tags).map_err(|_| error("provider_key_tags_invalid", "tags"))
}

pub(crate) fn key_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ProviderKeySummary, String> {
    let api_key: String = row
        .try_get("api_key")
        .map_err(|_| error("provider_key_row_invalid", "api_key"))?;
    let enabled: i64 = row
        .try_get("enabled")
        .map_err(|_| error("provider_key_row_invalid", "enabled"))?;
    let is_active: i64 = row
        .try_get("is_active")
        .map_err(|_| error("provider_key_row_invalid", "is_active"))?;
    Ok(ProviderKeySummary {
        id: row
            .try_get("id")
            .map_err(|_| error("provider_key_row_invalid", "id"))?,
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| error("provider_key_row_invalid", "provider_id"))?,
        app_type: row
            .try_get("app_type")
            .map_err(|_| error("provider_key_row_invalid", "app_type"))?,
        label: row
            .try_get("label")
            .map_err(|_| error("provider_key_row_invalid", "label"))?,
        masked_api_key: mask_secret(&api_key),
        tags: parse_tags(
            &row.try_get::<String, _>("tags")
                .map_err(|_| error("provider_key_row_invalid", "tags"))?,
        ),
        notes: row
            .try_get("notes")
            .map_err(|_| error("provider_key_row_invalid", "notes"))?,
        enabled: enabled != 0,
        sort_index: row
            .try_get("sort_index")
            .map_err(|_| error("provider_key_row_invalid", "sort_index"))?,
        is_active: is_active != 0,
        created_at: row
            .try_get("created_at")
            .map_err(|_| error("provider_key_row_invalid", "created_at"))?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|_| error("provider_key_row_invalid", "updated_at"))?,
    })
}

pub(crate) async fn list_keys_for_provider(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<Vec<ProviderKeySummary>, String> {
    let rows = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2
         ORDER BY sort_index, created_at, label",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_all(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_key_list_failed", err))?;
    rows.iter().map(key_from_row).collect()
}

pub(crate) fn set_json_secret(
    value: &mut Value,
    app_type: &str,
    secret: &str,
) -> Result<(), String> {
    if app_type == "grokbuild" {
        let raw = serde_json::to_string(value)
            .map_err(|_| error("provider_settings_serialize_failed", ""))?;
        let projected = grok::project_key(&raw, secret)?;
        *value = serde_json::from_str(&projected)
            .map_err(|_| error("provider_settings_serialize_failed", ""))?;
        return Ok(());
    }
    let object = value
        .as_object_mut()
        .ok_or_else(|| error("provider_settings_must_be_object", "settings_config"))?;
    match app_type {
        "claude" => {
            let env = object
                .entry("env")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| error("provider_settings_env_invalid", "env"))?;
            let key = selected_claude_auth_field(env);
            let other = if key == "ANTHROPIC_API_KEY" {
                "ANTHROPIC_AUTH_TOKEN"
            } else {
                "ANTHROPIC_API_KEY"
            };
            env.remove(other);
            env.insert(key.to_string(), Value::String(secret.to_string()));
        }
        "codex" => {
            let auth = object
                .entry("auth")
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(auth_object) = auth.as_object_mut() {
                let key = if auth_object.contains_key("api_key") {
                    "api_key"
                } else if auth_object.contains_key("OPENAI_API_KEY") {
                    "OPENAI_API_KEY"
                } else {
                    "OPENAI_API_KEY"
                };
                auth_object.insert(key.to_string(), Value::String(secret.to_string()));
            } else {
                *auth = Value::String(secret.to_string());
            }
        }
        _ => return Err(error("provider_invalid_app_type", app_type)),
    }
    Ok(())
}

pub(crate) fn project_key_into_settings(
    app_type: &str,
    raw: &str,
    secret: &str,
) -> Result<String, String> {
    if app_type == "grokbuild" {
        return grok::project_key(raw, secret);
    }
    let mut value = serde_json::from_str::<Value>(raw)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    set_json_secret(&mut value, app_type, secret)?;
    serde_json::to_string(&value).map_err(|_| error("provider_settings_serialize_failed", ""))
}
