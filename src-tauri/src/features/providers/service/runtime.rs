use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;

use super::{global, open_connection, repository};
use std::fs;
use std::path::Path;
use toml_edit::DocumentMut;

pub(crate) struct CodexProviderProfile {
    pub(crate) profile_name: String,
    pub(crate) model_provider: String,
    pub(crate) profile_text: String,
}

impl CodexProviderProfile {
    pub(crate) fn with_env_key(&self, env_key: &str) -> Result<Self, String> {
        let mut document = self
            .profile_text
            .parse::<DocumentMut>()
            .map_err(|_| "provider_config_invalid".to_string())?;
        set_profile_env_key(&mut document, &self.model_provider, env_key)?;
        Ok(Self {
            profile_name: self.profile_name.clone(),
            model_provider: self.model_provider.clone(),
            profile_text: document.to_string(),
        })
    }
}

pub(crate) struct CodexProviderRuntimeConfig {
    pub(crate) profile: CodexProviderProfile,
    pub(crate) env_key: String,
    pub(crate) secret_value: String,
    pub(crate) base_url: String,
    pub(crate) model: Option<String>,
    pub(crate) wire_api: Option<String>,
}

pub(crate) async fn load_codex_runtime_config(
    provider_id: &str,
) -> Result<CodexProviderRuntimeConfig, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("provider_not_found".to_string());
    }

    let mut connection = open_connection().await?;
    let row = sqlx::query(
        "SELECT name, settings_config, meta
         FROM providers WHERE id = ?1 AND app_type = 'codex'",
    )
    .bind(provider_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .ok_or_else(|| "provider_not_found".to_string())?;
    let settings_config: String = row
        .try_get("settings_config")
        .map_err(|_| "provider_database_error".to_string())?;
    let meta: String = row
        .try_get("meta")
        .map_err(|_| "provider_database_error".to_string())?;
    let meta = repository::parse_meta(&meta);
    if !repository::meta_enabled(&meta) {
        return Err("provider_not_ready".to_string());
    }

    let api_key = sqlx::query_scalar::<_, String>(
        "SELECT api_key FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = 'codex'
           AND is_active = 1 AND enabled = 1
         LIMIT 1",
    )
    .bind(provider_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| "provider_key_not_active".to_string())?;
    let common = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'common_config_codex'",
    )
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .unwrap_or_default();

    let merged = if repository::meta_common_config_enabled(&meta) {
        repository::merge_common_into_settings("codex", &common, &settings_config)?
    } else {
        settings_config
    };
    let projected = repository::project_key_into_settings("codex", &merged, &api_key)?;
    parse_runtime_config(provider_id, &projected)
}

pub(crate) fn parse_runtime_config(
    provider_id: &str,
    settings_config: &str,
) -> Result<CodexProviderRuntimeConfig, String> {
    let parsed: Value =
        serde_json::from_str(settings_config).map_err(|_| "provider_config_invalid".to_string())?;
    let env = parsed.get("env").and_then(Value::as_object);
    let config_text = parsed.get("config").and_then(Value::as_str);
    let auth = parsed.get("auth").and_then(Value::as_object);
    let base_url = env
        .and_then(|env| {
            find_env_by_exact_or_suffix(
                env,
                &[
                    "OPENAI_BASE_URL",
                    "OPENAI_API_BASE",
                    "CODEX_BASE_URL",
                    "BASE_URL",
                    "API_BASE",
                    "ENDPOINT",
                ],
                &["_BASE_URL", "_API_BASE", "_ENDPOINT"],
            )
        })
        .or_else(|| {
            find_text_by_key_patterns(
                &parsed,
                &[
                    "openai_base_url",
                    "chatgpt_base_url",
                    "base_url",
                    "api_base",
                    "endpoint",
                    "url",
                ],
                &["_BASE_URL", "_API_BASE", "_ENDPOINT"],
            )
        })
        .or_else(|| {
            config_text.and_then(|config| {
                find_codex_toml_provider_base_url(config).or_else(|| {
                    find_toml_value_by_key_patterns(
                        config,
                        &[
                            "openai_base_url",
                            "chatgpt_base_url",
                            "base_url",
                            "api_base",
                            "endpoint",
                        ],
                        &["_BASE_URL", "_API_BASE", "_ENDPOINT"],
                    )
                })
            })
        })
        .ok_or_else(|| "provider_config_invalid: missing_codex_base_url".to_string())?;
    let model = env
        .and_then(|env| {
            find_env_by_exact_or_suffix(env, &["OPENAI_MODEL", "CODEX_MODEL", "MODEL"], &["_MODEL"])
        })
        .or_else(|| find_text_by_key_patterns(&parsed, &["model"], &["_MODEL"]))
        .or_else(|| {
            config_text
                .and_then(|config| find_toml_value_by_key_patterns(config, &["model"], &["_MODEL"]))
        });
    let wire_api = find_text_by_key_patterns(&parsed, &["wire_api"], &[]).or_else(|| {
        config_text.and_then(|config| find_toml_value_by_key_patterns(config, &["wire_api"], &[]))
    });
    let secret_value = env
        .and_then(find_codex_secret_value)
        .or_else(|| auth.and_then(find_codex_secret_value))
        .or_else(|| find_codex_secret_value_in_value(&parsed))
        .ok_or_else(|| "provider_config_invalid: missing_codex_api_key".to_string())?;
    let generated_env_key = codex_secret_env_key(provider_id);
    let env_key = config_text
        .and_then(|config| find_selected_provider_env_key(config, &secret_value))
        .unwrap_or(generated_env_key);

    let profile = materialize_codex_profile(
        provider_id,
        &parsed,
        &env_key,
        &base_url,
        model.as_deref(),
        wire_api.as_deref(),
    )?;

    Ok(CodexProviderRuntimeConfig {
        profile,
        env_key,
        secret_value,
        base_url,
        model,
        wire_api,
    })
}

fn materialize_codex_profile(
    provider_id: &str,
    effective: &Value,
    env_key: &str,
    base_url: &str,
    model: Option<&str>,
    wire_api: Option<&str>,
) -> Result<CodexProviderProfile, String> {
    let mut normalized = effective.clone();
    let root = normalized
        .as_object_mut()
        .ok_or_else(|| "provider_config_invalid".to_string())?;
    root.insert("base_url".to_string(), Value::String(base_url.to_string()));
    if let Some(model) = model {
        root.insert("model".to_string(), Value::String(model.to_string()));
    }
    let (bytes, _) = global::materialize_codex_config(None, &normalized)?;
    let mut document = String::from_utf8(bytes)
        .map_err(|_| "provider_config_invalid".to_string())?
        .parse::<DocumentMut>()
        .map_err(|_| "provider_config_invalid".to_string())?;
    let model_provider = document
        .get("model_provider")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider_config_invalid: missing_codex_model_provider".to_string())?
        .to_string();
    set_profile_env_key(&mut document, &model_provider, env_key)?;
    if let Some(wire_api) = wire_api.map(str::trim).filter(|value| !value.is_empty()) {
        let provider = document
            .get_mut("model_providers")
            .and_then(|value| value.as_table_mut())
            .and_then(|providers| providers.get_mut(&model_provider))
            .and_then(|value| value.as_table_mut())
            .ok_or_else(|| "provider_config_invalid: missing_codex_model_provider".to_string())?;
        provider.insert("wire_api", toml_edit::value(wire_api));
    }

    Ok(CodexProviderProfile {
        profile_name: codex_profile_name(provider_id),
        model_provider,
        profile_text: document.to_string(),
    })
}

fn set_profile_env_key(
    document: &mut DocumentMut,
    model_provider: &str,
    env_key: &str,
) -> Result<(), String> {
    let provider = document
        .get_mut("model_providers")
        .and_then(|value| value.as_table_mut())
        .and_then(|providers| providers.get_mut(model_provider))
        .and_then(|value| value.as_table_mut())
        .ok_or_else(|| "provider_config_invalid: missing_codex_model_provider".to_string())?;
    provider.insert("env_key", toml_edit::value(env_key));
    Ok(())
}

pub(crate) fn write_codex_profile_to_dir(
    codex_dir: &Path,
    profile: &CodexProviderProfile,
) -> Result<(), String> {
    fs::create_dir_all(codex_dir).map_err(|err| format!("profile_write_failed: {err}"))?;
    fs::write(
        codex_dir.join(format!("{}.config.toml", profile.profile_name)),
        &profile.profile_text,
    )
    .map_err(|err| format!("profile_write_failed: {err}"))
}

pub(crate) fn codex_profile_name(provider_id: &str) -> String {
    let mut slug = provider_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    slug = slug.trim_matches('-').chars().take(40).collect();
    if slug.is_empty() {
        slug = "provider".to_string();
    }
    let digest = Sha256::digest(provider_id.as_bytes());
    let hash = format!("{digest:x}");
    format!("cli-manager-{}-{}", slug, &hash[..10])
}

fn env_value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn env_text(env: &Map<String, Value>, key: &str) -> Option<String> {
    env.get(key).map(env_value_text)
}

fn value_text_if_scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Number(_) | Value::Bool(_) => {
            let text = env_value_text(value);
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn normalize_config_key(key: &str) -> String {
    key.replace(['-', '.'], "_").to_ascii_uppercase()
}

fn find_env_by_exact_or_suffix(
    env: &Map<String, Value>,
    exact: &[&str],
    suffixes: &[&str],
) -> Option<String> {
    for key in exact {
        if let Some(value) = env_text(env, key).filter(|value| !value.trim().is_empty()) {
            return Some(value);
        }
    }
    env.iter().find_map(|(key, value)| {
        let upper = key.to_ascii_uppercase();
        if suffixes.iter().any(|suffix| upper.ends_with(suffix)) {
            let text = env_value_text(value);
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
        None
    })
}

fn find_text_by_key_patterns(value: &Value, exact: &[&str], suffixes: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized = normalize_config_key(key);
                let exact_match = exact
                    .iter()
                    .any(|candidate| normalized == normalize_config_key(candidate));
                if exact_match || suffixes.iter().any(|suffix| normalized.ends_with(suffix)) {
                    if let Some(text) = value_text_if_scalar(child) {
                        return Some(text);
                    }
                }
            }
            map.values()
                .find_map(|child| find_text_by_key_patterns(child, exact, suffixes))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| find_text_by_key_patterns(child, exact, suffixes)),
        _ => None,
    }
}

fn strip_toml_inline_comment(value: &str) -> &str {
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        match ch {
            '\\' if in_string => escaped = !escaped,
            '"' if !escaped => in_string = !in_string,
            '#' if !in_string => return &value[..index],
            _ => escaped = false,
        }
    }
    value
}

fn parse_toml_scalar(value: &str) -> Option<String> {
    let value = strip_toml_inline_comment(value).trim();
    if value.is_empty() {
        return None;
    }
    if let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
        let mut output = String::new();
        let mut chars = inner.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                match chars.next() {
                    Some('n') => output.push('\n'),
                    Some('r') => output.push('\r'),
                    Some('t') => output.push('\t'),
                    Some('"') => output.push('"'),
                    Some('\\') => output.push('\\'),
                    Some(other) => output.push(other),
                    None => output.push('\\'),
                }
            } else {
                output.push(ch);
            }
        }
        return (!output.trim().is_empty()).then_some(output);
    }
    if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
        return (!inner.trim().is_empty()).then_some(inner.to_string());
    }
    Some(value.to_string())
}

fn toml_table_name(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with("[[") || !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return None;
    }
    Some(
        trimmed
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim()
            .to_string(),
    )
}

fn toml_assignment(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
        return None;
    }
    let (key, value) = trimmed.split_once('=')?;
    Some((
        key.trim().trim_matches('"').trim_matches('\'').to_string(),
        value.trim().to_string(),
    ))
}

fn find_toml_value_by_key_patterns(raw: &str, exact: &[&str], suffixes: &[&str]) -> Option<String> {
    raw.lines()
        .filter_map(toml_assignment)
        .find_map(|(key, value)| {
            let normalized = normalize_config_key(&key);
            let exact_match = exact
                .iter()
                .any(|candidate| normalized == normalize_config_key(candidate));
            if exact_match || suffixes.iter().any(|suffix| normalized.ends_with(suffix)) {
                parse_toml_scalar(&value)
            } else {
                None
            }
        })
}

fn find_codex_toml_provider_base_url(raw: &str) -> Option<String> {
    let selected_provider = find_toml_value_by_key_patterns(raw, &["model_provider"], &[]);
    let mut current_table: Option<String> = None;
    let mut fallback_base_url = None;
    for line in raw.lines() {
        if let Some(table) = toml_table_name(line) {
            current_table = Some(table);
            continue;
        }
        let Some((key, value)) = toml_assignment(line) else {
            continue;
        };
        if normalize_config_key(&key) != "BASE_URL" {
            continue;
        }
        let table = current_table.as_deref().unwrap_or_default();
        if !table.starts_with("model_providers.") {
            continue;
        }
        let Some(base_url) = parse_toml_scalar(&value) else {
            continue;
        };
        if selected_provider.as_deref().is_some_and(|provider| {
            table
                .trim_start_matches("model_providers.")
                .trim_matches('"')
                == provider
        }) {
            return Some(base_url);
        }
        fallback_base_url.get_or_insert(base_url);
    }
    fallback_base_url
}

fn find_codex_secret_value_in_value(value: &Value) -> Option<String> {
    find_text_by_key_patterns(
        value,
        &[
            "OPENAI_API_KEY",
            "OPENAI_AUTH_TOKEN",
            "CODEX_API_KEY",
            "CODEX_AUTH_TOKEN",
            "API_KEY",
            "AUTH_TOKEN",
        ],
        &["_API_KEY", "_AUTH_TOKEN", "_ACCESS_TOKEN", "_TOKEN"],
    )
}

fn find_codex_secret_value(env: &Map<String, Value>) -> Option<String> {
    find_codex_secret_value_in_value(&Value::Object(env.clone()))
}

fn find_selected_provider_env_key(raw: &str, secret_value: &str) -> Option<String> {
    if raw.trim().is_empty() || raw.contains(secret_value) {
        return None;
    }
    let selected_provider = find_toml_value_by_key_patterns(raw, &["model_provider"], &[])?;
    let target_table = format!("model_providers.{selected_provider}");
    let mut current_table = None;
    for line in raw.lines() {
        if let Some(table) = toml_table_name(line) {
            current_table = Some(table);
            continue;
        }
        if current_table.as_deref() != Some(target_table.as_str()) {
            continue;
        }
        let Some((key, value)) = toml_assignment(line) else {
            continue;
        };
        if normalize_config_key(&key) == "ENV_KEY" {
            return parse_toml_scalar(&value);
        }
    }
    None
}

fn codex_secret_env_key(provider_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(provider_id.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!(
        "CLI_MANAGER_CODEX_PROVIDER_{}_API_KEY",
        digest[..16].to_ascii_uppercase()
    )
}

#[cfg(test)]
mod tests {
    use super::parse_runtime_config;

    #[test]
    fn parses_projected_codex_runtime_fields() {
        let settings = r#"{
            "env": {
                "OPENAI_BASE_URL": "https://api.example.com/v1",
                "OPENAI_MODEL": "gpt-test",
                "OPENAI_API_KEY": "sk-secret"
            },
            "config": "model_provider = \"cloud\"\n\n[model_providers.cloud]\nbase_url = \"https://config.example.com\"\nenv_key = \"OPENAI_API_KEY\"\nwire_api = \"responses\""
        }"#;
        let runtime = parse_runtime_config("provider-1", settings).unwrap();

        assert_eq!(runtime.base_url, "https://api.example.com/v1");
        assert_eq!(runtime.model.as_deref(), Some("gpt-test"));
        assert_eq!(runtime.wire_api.as_deref(), Some("responses"));
        assert_eq!(runtime.env_key, "OPENAI_API_KEY");
        assert_eq!(runtime.secret_value, "sk-secret");
        assert_eq!(runtime.profile.model_provider, "cloud");
        assert!(runtime
            .profile
            .profile_text
            .contains("base_url = \"https://api.example.com/v1\""));
        assert!(runtime
            .profile
            .profile_text
            .contains("env_key = \"OPENAI_API_KEY\""));
        assert!(!runtime.profile.profile_text.contains("sk-secret"));
    }

    #[test]
    fn selects_codex_provider_base_url_from_toml() {
        let settings = r#"{
            "config": "model_provider = \"cloud\"\n\n[model_providers.cloud]\nbase_url = \"https://config.example.com\"\nmodel = \"gpt-config\"",
            "auth": {"OPENAI_API_KEY": "sk-secret"}
        }"#;
        let runtime = parse_runtime_config("provider-2", settings).unwrap();

        assert_eq!(runtime.base_url, "https://config.example.com");
        assert_eq!(runtime.model.as_deref(), Some("gpt-config"));
        assert!(runtime.env_key.starts_with("CLI_MANAGER_CODEX_PROVIDER_"));
        assert_eq!(runtime.profile.model_provider, "cloud");
        assert!(runtime
            .profile
            .profile_text
            .contains(&format!("env_key = \"{}\"", runtime.env_key)));
        assert!(!runtime.profile.profile_text.contains("sk-secret"));
    }
}
