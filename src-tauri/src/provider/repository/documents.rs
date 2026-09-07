use super::catalog::get_provider;
use super::dto::{ProviderDetail, ProviderDocument, ProviderDocumentUpdateInput};
use super::support::{
    error, is_secret_key, load_provider, map_database_error, normalize_app_type, redact_json,
    redact_settings_config,
};
use crate::provider::database;
use serde_json::{Map, Value as JsonValue};
use toml_edit::{DocumentMut, Item, Table, Value as TomlValue};

const CLAUDE_SETTINGS_DOCUMENT: &str = "claude.settings";
const CODEX_AUTH_DOCUMENT: &str = "codex.auth";
const CODEX_CONFIG_DOCUMENT: &str = "codex.config";
const GROK_CONFIG_DOCUMENT: &str = "grokbuild.config";

pub(crate) fn documents_from_settings(app_type: &str, raw: &str) -> Vec<ProviderDocument> {
    match app_type {
        "claude" => {
            let (value, has_secret, valid) = redact_settings_config(raw);
            vec![ProviderDocument {
                kind: CLAUDE_SETTINGS_DOCUMENT.to_string(),
                format: "json".to_string(),
                value,
                has_secret,
                valid,
            }]
        }
        "codex" => {
            let Ok(settings) = serde_json::from_str::<JsonValue>(raw) else {
                return vec![invalid_document(CODEX_AUTH_DOCUMENT, "json", raw)];
            };
            let auth = settings
                .get("auth")
                .cloned()
                .unwrap_or_else(|| JsonValue::Object(Map::new()));
            let (auth, auth_has_secret) = redact_json_value(auth);
            let auth_value =
                serde_json::to_string_pretty(&auth).unwrap_or_else(|_| "{}".to_string());
            let config = settings
                .get("config")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            let (config_value, config_has_secret, config_valid) = redact_toml_document(config);
            vec![
                ProviderDocument {
                    kind: CODEX_AUTH_DOCUMENT.to_string(),
                    format: "json".to_string(),
                    value: auth_value,
                    has_secret: auth_has_secret,
                    valid: auth.is_object(),
                },
                ProviderDocument {
                    kind: CODEX_CONFIG_DOCUMENT.to_string(),
                    format: "toml".to_string(),
                    value: config_value,
                    has_secret: config_has_secret,
                    valid: config_valid,
                },
            ]
        }
        "grokbuild" => {
            let Ok(settings) = serde_json::from_str::<JsonValue>(raw) else {
                return vec![invalid_document(GROK_CONFIG_DOCUMENT, "toml", raw)];
            };
            let config = settings
                .get("config")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            let (value, has_secret, valid) = redact_toml_document(config);
            vec![ProviderDocument {
                kind: GROK_CONFIG_DOCUMENT.to_string(),
                format: "toml".to_string(),
                value,
                has_secret,
                valid,
            }]
        }
        _ => Vec::new(),
    }
}

fn invalid_document(kind: &str, format: &str, raw: &str) -> ProviderDocument {
    let has_secret = [
        "token",
        "key",
        "secret",
        "password",
        "credential",
        "authorization",
    ]
    .iter()
    .any(|marker| raw.to_ascii_lowercase().contains(marker));
    ProviderDocument {
        kind: kind.to_string(),
        format: format.to_string(),
        value: "[INVALID CONFIG DOCUMENT]".to_string(),
        has_secret,
        valid: false,
    }
}

fn redact_json_value(mut value: JsonValue) -> (JsonValue, bool) {
    let has_secret = redact_json(&mut value);
    (value, has_secret)
}

pub(crate) fn redact_toml_document(raw: &str) -> (String, bool, bool) {
    if raw.trim().is_empty() {
        return (String::new(), false, true);
    }
    let Ok(mut document) = raw.parse::<DocumentMut>() else {
        let lower = raw.to_ascii_lowercase();
        let has_secret = [
            "token",
            "key",
            "secret",
            "password",
            "credential",
            "authorization",
        ]
        .iter()
        .any(|marker| lower.contains(marker));
        return (
            if has_secret {
                "[REDACTED TOML CONFIG]".to_string()
            } else {
                raw.to_string()
            },
            has_secret,
            false,
        );
    };
    let has_secret = redact_toml_item(document.as_item_mut());
    (document.to_string(), has_secret, true)
}

fn merge_json_values(common: &mut JsonValue, provider: JsonValue) {
    if let (Some(common_object), Some(provider_object)) =
        (common.as_object_mut(), provider.as_object())
    {
        for (key, value) in provider_object {
            if let Some(existing) = common_object.get_mut(key) {
                merge_json_values(existing, value.clone());
            } else {
                common_object.insert(key.clone(), value.clone());
            }
        }
    } else {
        *common = provider;
    }
}

#[cfg(test)]
pub(crate) fn merge_json_documents(common: &str, provider: &str) -> Result<String, String> {
    let mut common = serde_json::from_str::<JsonValue>(common)
        .map_err(|_| error("provider_common_config_invalid_json", "common"))?;
    let provider = serde_json::from_str::<JsonValue>(provider)
        .map_err(|_| error("provider_settings_invalid_json", "provider"))?;
    merge_json_values(&mut common, provider);
    serde_json::to_string_pretty(&common).map_err(|_| error("provider_config_merge_failed", ""))
}

fn merge_toml_items(common: &mut Item, provider: Item) {
    if let (Some(common_table), Some(provider_table)) = (common.as_table_mut(), provider.as_table())
    {
        let entries = provider_table
            .iter()
            .map(|(key, item)| (key.to_string(), item.clone()))
            .collect::<Vec<_>>();
        for (key, item) in entries {
            if let Some(existing) = common_table.get_mut(&key) {
                merge_toml_items(existing, item);
            } else {
                common_table.insert(&key, item);
            }
        }
    } else {
        *common = provider;
    }
}

fn parse_toml_document(raw: &str, kind: &str) -> Result<DocumentMut, String> {
    if raw.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    raw.parse::<DocumentMut>()
        .map_err(|_| error("provider_common_config_invalid_toml", kind))
}

pub(crate) fn is_valid_toml_document(raw: &str) -> bool {
    parse_toml_document(raw, "value").is_ok()
}

pub(crate) fn merge_common_into_settings(
    app_type: &str,
    common: &str,
    provider: &str,
) -> Result<String, String> {
    let mut settings = serde_json::from_str::<JsonValue>(provider)
        .map_err(|_| error("provider_settings_invalid_json", "provider"))?;
    if !settings.is_object() {
        return Err(error("provider_settings_must_be_object", "provider"));
    }
    if app_type == "claude" {
        let mut common = serde_json::from_str::<JsonValue>(common)
            .map_err(|_| error("provider_common_config_invalid_json", "common"))?;
        let provider = settings.clone();
        merge_json_values(&mut common, provider);
        return serde_json::to_string_pretty(&common)
            .map_err(|_| error("provider_config_merge_failed", app_type));
    }

    let mut common = parse_toml_document(common, "common")?;
    let provider_config = settings
        .get("config")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let provider_config = parse_toml_document(provider_config, "provider")?;
    merge_toml_items(common.as_item_mut(), provider_config.into_item());
    settings
        .as_object_mut()
        .expect("validated settings object")
        .insert("config".to_string(), JsonValue::String(common.to_string()));
    serde_json::to_string_pretty(&settings)
        .map_err(|_| error("provider_config_merge_failed", app_type))
}

fn redact_toml_item(item: &mut Item) -> bool {
    match item {
        Item::Table(table) => redact_toml_table(table),
        Item::ArrayOfTables(tables) => tables.iter_mut().any(redact_toml_table),
        Item::Value(value) => redact_toml_value(value),
        Item::None => false,
    }
}

fn redact_toml_table(table: &mut Table) -> bool {
    let mut found_secret = false;
    for (key, item) in table.iter_mut() {
        if is_secret_key(key.get()) {
            *item = Item::Value(TomlValue::from("[REDACTED]"));
            found_secret = true;
        } else if redact_toml_item(item) {
            found_secret = true;
        }
    }
    found_secret
}

fn redact_toml_value(value: &mut TomlValue) -> bool {
    let mut found_secret = false;
    if let Some(table) = value.as_inline_table_mut() {
        for (key, child) in table.iter_mut() {
            if is_secret_key(key.get()) {
                *child = TomlValue::from("[REDACTED]");
                found_secret = true;
            } else if redact_toml_value(child) {
                found_secret = true;
            }
        }
    }
    if let Some(array) = value.as_array_mut() {
        for child in array.iter_mut() {
            if redact_toml_value(child) {
                found_secret = true;
            }
        }
    }
    found_secret
}

fn is_masked_secret(value: &JsonValue) -> bool {
    value
        .as_str()
        .map(|value| {
            value.is_empty() || value == "***" || value == "[REDACTED]" || value.contains('…')
        })
        .unwrap_or(false)
}

fn reject_new_json_secrets(
    existing: Option<&JsonValue>,
    incoming: &JsonValue,
    detail: &str,
) -> Result<(), String> {
    match incoming {
        JsonValue::Object(incoming_object) => {
            let existing_object = existing.and_then(JsonValue::as_object);
            for (key, value) in incoming_object {
                if is_secret_key(key) {
                    if existing_object.and_then(|object| object.get(key)).is_none() {
                        return Err(error(
                            "provider_document_secret_edit_requires_key_manager",
                            detail,
                        ));
                    }
                } else {
                    reject_new_json_secrets(
                        existing_object.and_then(|object| object.get(key)),
                        value,
                        detail,
                    )?;
                }
            }
        }
        JsonValue::Array(incoming_items) => {
            let existing_items = existing.and_then(JsonValue::as_array);
            for (index, value) in incoming_items.iter().enumerate() {
                reject_new_json_secrets(
                    existing_items.and_then(|items| items.get(index)),
                    value,
                    detail,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn preserve_json_secrets(existing: &JsonValue, incoming: &mut JsonValue) -> Result<(), String> {
    let (Some(existing_object), Some(incoming_object)) =
        (existing.as_object(), incoming.as_object_mut())
    else {
        return Ok(());
    };
    for (key, existing_value) in existing_object {
        if is_secret_key(key) {
            match incoming_object.get(key) {
                None => {
                    incoming_object.insert(key.clone(), existing_value.clone());
                }
                Some(value) if is_masked_secret(value) => {
                    incoming_object.insert(key.clone(), existing_value.clone());
                }
                Some(value) if value != existing_value => {
                    return Err(error(
                        "provider_document_secret_edit_requires_key_manager",
                        key,
                    ));
                }
                _ => {}
            }
        } else if let Some(incoming_value) = incoming_object.get_mut(key) {
            preserve_json_secrets(existing_value, incoming_value)?;
        }
    }
    Ok(())
}

fn patch_json_document(
    existing: &JsonValue,
    value: &str,
    detail: &str,
) -> Result<JsonValue, String> {
    let mut incoming = serde_json::from_str::<JsonValue>(value)
        .map_err(|_| error("provider_config_invalid", detail))?;
    if !incoming.is_object() {
        return Err(error("provider_config_must_be_object", detail));
    }
    reject_new_json_secrets(Some(existing), &incoming, detail)?;
    preserve_json_secrets(existing, &mut incoming)?;
    Ok(incoming)
}

pub(crate) fn preserve_toml_secrets(
    existing: &str,
    incoming: &mut DocumentMut,
) -> Result<(), String> {
    let Ok(existing_document) = existing.parse::<DocumentMut>() else {
        if !collect_toml_edit_secret_paths(incoming.as_item(), &[]).is_empty() {
            return Err(error(
                "provider_document_secret_edit_requires_key_manager",
                "toml",
            ));
        }
        return Ok(());
    };
    let existing_paths = collect_toml_edit_secret_paths(existing_document.as_item(), &[]);
    let incoming_paths = collect_toml_edit_secret_paths(incoming.as_item(), &[]);
    for (path, _) in incoming_paths {
        if !existing_paths
            .iter()
            .any(|(existing_path, _)| existing_path == &path)
        {
            return Err(error(
                "provider_document_secret_edit_requires_key_manager",
                path.join("."),
            ));
        }
    }
    for (path, secret) in existing_paths {
        let Some(item) = get_toml_item_mut(incoming.as_item_mut(), &path) else {
            continue;
        };
        *item = Item::Value(TomlValue::from(secret));
    }
    Ok(())
}

fn collect_toml_edit_secret_paths(item: &Item, parent: &[String]) -> Vec<(Vec<String>, String)> {
    match item {
        Item::Table(table) => table
            .iter()
            .flat_map(|(key, child)| {
                let mut path = parent.to_vec();
                path.push(key.to_string());
                if is_secret_key(key) {
                    child
                        .as_str()
                        .map(|secret| vec![(path, secret.to_string())])
                        .unwrap_or_default()
                } else {
                    collect_toml_edit_secret_paths(child, &path)
                }
            })
            .collect(),
        Item::ArrayOfTables(_) => Vec::new(),
        Item::Value(value) => value
            .as_inline_table()
            .map(|table| {
                table
                    .iter()
                    .filter_map(|(key, child)| {
                        if !is_secret_key(key) {
                            return None;
                        }
                        let mut path = parent.to_vec();
                        path.push(key.to_string());
                        child.as_str().map(|secret| (path, secret.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Item::None => Vec::new(),
    }
}

fn get_toml_item_mut<'a>(item: &'a mut Item, path: &[String]) -> Option<&'a mut Item> {
    let (head, tail) = path.split_first()?;
    let next = item.get_mut(head)?;
    if tail.is_empty() {
        Some(next)
    } else {
        get_toml_item_mut(next, tail)
    }
}

fn patch_settings_document(
    app_type: &str,
    raw_settings: &str,
    kind: &str,
    value: &str,
) -> Result<String, String> {
    let mut settings = serde_json::from_str::<JsonValue>(raw_settings)
        .map_err(|_| error("provider_config_invalid", "settings_config"))?;
    if !settings.is_object() {
        return Err(error("provider_config_must_be_object", "settings_config"));
    }
    match (app_type, kind) {
        ("claude", CLAUDE_SETTINGS_DOCUMENT) => {
            let existing = settings.clone();
            settings = patch_json_document(&existing, value, kind)?;
        }
        ("codex", CODEX_AUTH_DOCUMENT) => {
            let existing = settings
                .get("auth")
                .cloned()
                .unwrap_or_else(|| JsonValue::Object(Map::new()));
            let auth = patch_json_document(&existing, value, kind)?;
            settings
                .as_object_mut()
                .expect("validated settings object")
                .insert("auth".to_string(), auth);
        }
        ("codex", CODEX_CONFIG_DOCUMENT) | ("grokbuild", GROK_CONFIG_DOCUMENT) => {
            let mut config = value
                .parse::<DocumentMut>()
                .map_err(|_| error("provider_config_invalid", kind))?;
            let existing = settings
                .get("config")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            preserve_toml_secrets(existing, &mut config)?;
            settings
                .as_object_mut()
                .expect("validated settings object")
                .insert("config".to_string(), JsonValue::String(config.to_string()));
        }
        _ => return Err(error("provider_document_kind_invalid", kind)),
    }
    serde_json::to_string(&settings).map_err(|_| error("provider_config_serialize_failed", kind))
}

pub(crate) async fn update_provider_document(
    input: ProviderDocumentUpdateInput,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let mut connection = database::open_connection().await?;
    let provider = load_provider(&mut connection, &app_type, input.provider_id.trim()).await?;
    let settings_config = patch_settings_document(
        &app_type,
        &provider.settings_config,
        input.kind.trim(),
        &input.value,
    )?;
    sqlx::query(
        "UPDATE providers SET settings_config = ?1
         WHERE id = ?2 AND app_type = ?3",
    )
    .bind(settings_config)
    .bind(&provider.id)
    .bind(&app_type)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_document_update_failed", err))?;
    drop(connection);
    get_provider(app_type, provider.id).await
}

#[cfg(test)]
mod tests {
    use super::{documents_from_settings, patch_settings_document, redact_toml_document};
    use serde_json::Value;

    #[test]
    fn redacts_toml_secret_without_dropping_comments() {
        let raw = "# keep this comment\n[provider]\nbase_url = \"https://example.test\"\napi_key = \"sk-secret\"\n";
        let (redacted, has_secret, valid) = redact_toml_document(raw);
        assert!(valid);
        assert!(has_secret);
        assert!(redacted.contains("# keep this comment"));
        assert!(redacted.contains("https://example.test"));
        assert!(!redacted.contains("sk-secret"));
    }

    #[test]
    fn codex_document_patch_preserves_redacted_credentials() {
        let existing = r##"{
            "auth": {"OPENAI_API_KEY": "sk-secret"},
            "config": "# keep\nmodel = \"gpt-test\"\napi_key = \"toml-secret\"\n"
        }"##;
        let updated_auth = patch_settings_document(
            "codex",
            existing,
            "codex.auth",
            r#"{"OPENAI_API_KEY":"***"}"#,
        )
        .unwrap();
        let updated_auth: Value = serde_json::from_str(&updated_auth).unwrap();
        assert_eq!(updated_auth["auth"]["OPENAI_API_KEY"], "sk-secret");

        let updated_config = patch_settings_document(
            "codex",
            &updated_auth.to_string(),
            "codex.config",
            "# keep\nmodel = \"gpt-new\"\napi_key = \"[REDACTED]\"\n",
        )
        .unwrap();
        let updated_config: Value = serde_json::from_str(&updated_config).unwrap();
        assert!(updated_config["config"]
            .as_str()
            .unwrap()
            .contains("gpt-new"));
        assert!(updated_config["config"]
            .as_str()
            .unwrap()
            .contains("toml-secret"));
    }

    #[test]
    fn document_patch_rejects_new_secret_fields() {
        let json_error = patch_settings_document(
            "claude",
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.test"}}"#,
            "claude.settings",
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.test","ANTHROPIC_AUTH_TOKEN":"new-secret"}}"#,
        )
        .unwrap_err();
        assert!(json_error.contains("provider_document_secret_edit_requires_key_manager"));

        let toml_error = patch_settings_document(
            "codex",
            r#"{"config":"model = \"gpt-test\"\n"}"#,
            "codex.config",
            "model = \"gpt-test\"\napi_key = \"new-secret\"\n",
        )
        .unwrap_err();
        assert!(toml_error.contains("provider_document_secret_edit_requires_key_manager"));
    }

    #[test]
    fn document_listing_exposes_type_specific_documents() {
        let documents = documents_from_settings(
            "codex",
            r#"{"auth":{"OPENAI_API_KEY":"secret"},"config":"model = \"gpt-test\"\n"}"#,
        );
        assert_eq!(
            documents
                .iter()
                .map(|document| document.kind.as_str())
                .collect::<Vec<_>>(),
            ["codex.auth", "codex.config",]
        );
        assert!(documents[0].has_secret);
        assert!(documents[1].valid);
    }

    #[test]
    fn invalid_provider_document_never_returns_raw_content() {
        let documents = documents_from_settings(
            "codex",
            r#"{"auth":{"OPENAI_API_KEY":"secret"},"config":"not valid json""#,
        );
        assert_eq!(documents[0].value, "[INVALID CONFIG DOCUMENT]");
        assert!(documents[0].has_secret);
        assert!(!documents[0].value.contains("secret"));
    }
}
