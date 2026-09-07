use super::super::grok::{self, CredentialProjection};
use super::{
    CLAUDE_OWNED_ENV_KEYS, CODEX_DEFAULT_PROVIDER_NAME, CODEX_OWNED_AUTH_KEYS,
    CODEX_OWNED_CONFIG_KEYS,
};
use serde_json::{Map, Value};
use toml_edit::{DocumentMut, Item, Table, Value as TomlValue};

pub(super) fn parse_json_object(bytes: Option<&[u8]>) -> Result<Map<String, Value>, String> {
    let Some(bytes) = bytes else {
        return Ok(Map::new());
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    let value = serde_json::from_slice::<Value>(bytes)
        .map_err(|_| "provider_config_invalid".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "provider_config_invalid".to_string())
}

pub(super) fn json_bytes(object: Map<String, Value>) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(object))
        .map_err(|_| "provider_config_invalid".to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub(super) fn toml_document(bytes: Option<&[u8]>) -> Result<DocumentMut, String> {
    let Some(bytes) = bytes else {
        return Ok(DocumentMut::new());
    };
    let raw = std::str::from_utf8(bytes).map_err(|_| "provider_config_invalid".to_string())?;
    if raw.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    raw.parse::<DocumentMut>()
        .map_err(|_| "provider_config_invalid".to_string())
}

pub(super) fn settings_config(value: &str) -> Result<Value, String> {
    let settings =
        serde_json::from_str::<Value>(value).map_err(|_| "provider_config_invalid".to_string())?;
    if settings.is_object() {
        Ok(settings)
    } else {
        Err("provider_config_invalid".to_string())
    }
}

pub(super) fn provider_owned_env(
    effective: &Value,
    secret: &str,
) -> Result<Map<String, Value>, String> {
    let env = effective
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut desired = Map::new();
    for key in CLAUDE_OWNED_ENV_KEYS {
        if let Some(value) = env.get(key) {
            desired.insert(key.to_string(), value.clone());
        }
    }
    let credential_key = match (
        env.contains_key("ANTHROPIC_AUTH_TOKEN"),
        env.contains_key("ANTHROPIC_API_KEY"),
    ) {
        (true, true) => {
            let auth_token_non_empty = env
                .get("ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            let api_key_non_empty = env
                .get("ANTHROPIC_API_KEY")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            if !auth_token_non_empty && api_key_non_empty {
                "ANTHROPIC_AUTH_TOKEN"
            } else if auth_token_non_empty && !api_key_non_empty {
                "ANTHROPIC_API_KEY"
            } else {
                "ANTHROPIC_AUTH_TOKEN"
            }
        }
        (false, true) => "ANTHROPIC_API_KEY",
        _ => "ANTHROPIC_AUTH_TOKEN",
    };
    desired.insert(
        credential_key.to_string(),
        Value::String(secret.to_string()),
    );
    desired.remove(if credential_key == "ANTHROPIC_API_KEY" {
        "ANTHROPIC_AUTH_TOKEN"
    } else {
        "ANTHROPIC_API_KEY"
    });
    Ok(desired)
}

pub(crate) fn materialize_claude(
    before: Option<&[u8]>,
    effective: &Value,
    secret: &str,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let mut root = parse_json_object(before)?;
    let mut env = root
        .remove("env")
        .unwrap_or_else(|| Value::Object(Map::new()))
        .as_object()
        .cloned()
        .ok_or_else(|| "provider_config_invalid".to_string())?;
    let desired = provider_owned_env(effective, secret)?;
    for key in CLAUDE_OWNED_ENV_KEYS {
        if let Some(value) = desired.get(key) {
            env.insert(key.to_string(), value.clone());
        } else {
            env.remove(key);
        }
    }
    root.insert("env".to_string(), Value::Object(env));
    Ok((
        json_bytes(root)?,
        CLAUDE_OWNED_ENV_KEYS
            .iter()
            .map(|key| key.to_string())
            .collect(),
    ))
}

pub(crate) fn materialize_codex_auth(
    before: Option<&[u8]>,
    _effective: &Value,
    secret: &str,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let mut root = parse_json_object(before)?;
    for key in CODEX_OWNED_AUTH_KEYS {
        root.remove(key);
    }
    root.remove("auth");
    root.insert(
        "OPENAI_API_KEY".to_string(),
        Value::String(secret.to_string()),
    );
    Ok((
        json_bytes(root)?,
        CODEX_OWNED_AUTH_KEYS
            .iter()
            .map(|key| key.to_string())
            .collect(),
    ))
}

pub(super) fn copy_toml_owned(
    source: &DocumentMut,
    target: &mut DocumentMut,
    keys: &[&str],
) -> Vec<String> {
    for key in keys {
        if let Some(item) = source.get(key) {
            target[key] = item.clone();
        } else {
            target.remove(key);
        }
    }
    keys.iter().map(|key| (*key).to_string()).collect()
}

pub(crate) fn materialize_codex_config(
    before: Option<&[u8]>,
    effective: &Value,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let source_raw = effective
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = if source_raw.trim().is_empty() {
        DocumentMut::new()
    } else {
        source_raw
            .parse::<DocumentMut>()
            .map_err(|_| "provider_config_invalid".to_string())?
    };
    let mut target = toml_document(before)?;
    let owned = copy_toml_owned(&source, &mut target, &CODEX_OWNED_CONFIG_KEYS);
    for key in ["base_url", "wire_api", "requires_openai_auth", "env_key"] {
        target.remove(key);
    }
    let provider_name = source
        .get("model_provider")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            let table = source.get("model_providers")?.as_table()?;
            let mut entries = table.iter();
            let (name, _) = entries.next()?;
            entries.next().is_none().then(|| name.to_string())
        })
        .unwrap_or_else(|| CODEX_DEFAULT_PROVIDER_NAME.to_string());
    let base_url = effective.get("base_url").and_then(Value::as_str);
    let model = effective.get("model").and_then(Value::as_str);
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        target["model"] = toml_edit::value(model);
    }
    if base_url.is_some() {
        target["model_provider"] = toml_edit::value(provider_name.as_str());
        ensure_codex_provider_mapping(&mut target, &provider_name, base_url)?;
    }
    sanitize_codex_model_providers(&mut target);
    Ok((target.to_string().into_bytes(), owned))
}

pub(super) fn ensure_codex_provider_mapping(
    target: &mut DocumentMut,
    provider_name: &str,
    base_url: Option<&str>,
) -> Result<(), String> {
    if target.get("model_providers").is_none() {
        target["model_providers"] = toml_edit::table();
    }
    let providers = target
        .get_mut("model_providers")
        .and_then(|item| item.as_table_mut())
        .ok_or_else(|| "provider_config_invalid".to_string())?;
    let provider = providers
        .entry(provider_name)
        .or_insert(toml_edit::table())
        .as_table_mut()
        .ok_or_else(|| "provider_config_invalid".to_string())?;
    if provider.get("name").is_none() {
        provider.insert("name", toml_edit::value("CLI-Manager"));
    }
    if let Some(base_url) = base_url {
        provider.insert("base_url", toml_edit::value(base_url));
    }
    Ok(())
}

pub(super) fn is_toml_secret_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    matches!(
        normalized.as_str(),
        "access_token"
            | "refresh_token"
            | "oauth_token"
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
    ) || normalized.ends_with("_token")
        || normalized.ends_with("token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("secret")
        || normalized.ends_with("_password")
        || normalized.ends_with("password")
        || normalized.ends_with("_api_key")
        || normalized.ends_with("apikey")
}

pub(super) fn remove_toml_secret_fields(item: &mut Item) -> bool {
    match item {
        Item::Table(table) => remove_toml_secret_table(table),
        Item::ArrayOfTables(tables) => {
            let mut removed = false;
            for table in tables.iter_mut() {
                removed |= remove_toml_secret_table(table);
            }
            removed
        }
        Item::Value(value) => remove_toml_secret_value(value),
        Item::None => false,
    }
}

pub(super) fn remove_toml_secret_table(table: &mut Table) -> bool {
    let secret_keys = table
        .iter()
        .filter(|(key, _)| is_toml_secret_key(key))
        .map(|(key, _)| key.to_string())
        .collect::<Vec<_>>();
    let mut removed = false;
    for key in secret_keys {
        removed |= table.remove(&key).is_some();
    }
    for (_, child) in table.iter_mut() {
        removed |= remove_toml_secret_fields(child);
    }
    removed
}

pub(super) fn remove_toml_secret_value(value: &mut TomlValue) -> bool {
    let mut removed = false;
    if let Some(table) = value.as_inline_table_mut() {
        let secret_keys = table
            .iter()
            .filter(|(key, _)| is_toml_secret_key(key))
            .map(|(key, _)| key.to_string())
            .collect::<Vec<_>>();
        for key in secret_keys {
            removed |= table.remove(&key).is_some();
        }
        for (_, child) in table.iter_mut() {
            removed |= remove_toml_secret_value(child);
        }
    }
    if let Some(array) = value.as_array_mut() {
        for child in array.iter_mut() {
            removed |= remove_toml_secret_value(child);
        }
    }
    removed
}

pub(super) fn sanitize_codex_model_providers(target: &mut DocumentMut) {
    let Some(item) = target.get_mut("model_providers") else {
        return;
    };
    let Some(table) = item.as_table_mut() else {
        return;
    };
    for (_, provider) in table.iter_mut() {
        remove_toml_secret_fields(provider);
        let Some(provider_table) = provider.as_table_mut() else {
            continue;
        };
        provider_table.remove("env_key");
    }
}

pub(crate) fn materialize_grok_global_config(
    before: Option<&[u8]>,
    effective: &Value,
    secret: &str,
) -> Result<(Vec<u8>, Vec<String>), String> {
    grok::materialize(before, effective, CredentialProjection::Inline(secret))
}
