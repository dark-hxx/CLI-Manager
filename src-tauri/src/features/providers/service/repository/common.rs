use super::documents::is_valid_toml_document;
use super::dto::{CommonConfigDocument, CommonConfigSetInput};
use super::support::{error, map_database_error, normalize_app_type};
use crate::provider::database;
use serde_json::Value;
use sqlx::SqliteConnection;

pub(crate) async fn get_common_config_value(
    connection: &mut SqliteConnection,
    app_type: &str,
) -> Result<String, String> {
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(format!("common_config_{app_type}"))
        .fetch_optional(&mut *connection)
        .await
        .map_err(|err| map_database_error("provider_common_config_read_failed", err))?
        .ok_or_else(|| error("provider_common_config_not_found", app_type))?;
    if app_type != "claude" && value.trim() == "{}" {
        return Ok(String::new());
    }
    Ok(value)
}

pub(crate) async fn get_common_config(app_type: String) -> Result<CommonConfigDocument, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let value = get_common_config_value(&mut connection, &app_type).await?;
    // 通用配置编辑器必须无损回显：这里不做脱敏，否则字段名带 token/key 等字样的
    // 普通配置项（如 model_auto_compact_token_limit）会被替换成 [REDACTED]，
    // 用户再保存一次就把占位符写进了配置。
    let format = common_config_format(&app_type).to_string();
    Ok(CommonConfigDocument {
        app_type,
        value,
        format,
    })
}

pub(crate) fn validate_common_config(input: CommonConfigSetInput) -> Result<(), String> {
    validate_common_config_input(&input)
}

pub(crate) async fn set_common_config(
    input: CommonConfigSetInput,
) -> Result<CommonConfigDocument, String> {
    validate_common_config_input(&input)?;
    let app_type = normalize_app_type(&input.app_type)?;
    let value = input.value.trim().to_string();
    let format = common_config_format(&app_type).to_string();
    let mut connection = database::open_connection().await?;
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")
        .bind(format!("common_config_{app_type}"))
        .bind(&value)
        .execute(&mut connection)
        .await
        .map_err(|err| map_database_error("provider_common_config_write_failed", err))?;
    Ok(CommonConfigDocument {
        app_type,
        value,
        format,
    })
}

fn common_config_format(app_type: &str) -> &'static str {
    if app_type == "claude" {
        "json"
    } else {
        "toml"
    }
}

fn validate_common_config_input(input: &CommonConfigSetInput) -> Result<(), String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let value = input.value.trim();
    if value.is_empty() {
        return Err(error("provider_common_config_required", "value"));
    }
    let expected_format = common_config_format(&app_type);
    let format = input
        .format
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| expected_format.to_string());
    if format != expected_format {
        return Err(error(
            "provider_common_config_format_invalid",
            expected_format,
        ));
    }
    // 通用配置只校验格式，不再做敏感字段拦截：字段名的子串匹配（token/key/auth…）
    // 会把 model_auto_compact_token_limit、requires_openai_auth 这类普通配置项误判成
    // 密钥（issue #241）。密钥要不要写在通用配置里由用户自己决定。
    if app_type == "claude" {
        let parsed = serde_json::from_str::<Value>(value)
            .map_err(|_| error("provider_common_config_invalid_json", "value"))?;
        if !parsed.is_object() {
            return Err(error("provider_common_config_must_be_object", "value"));
        }
    } else if !is_valid_toml_document(value) {
        return Err(error("provider_common_config_invalid_toml", "value"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_common_config, CommonConfigSetInput};

    fn input(app_type: &str, value: &str, format: Option<&str>) -> CommonConfigSetInput {
        CommonConfigSetInput {
            app_type: app_type.to_string(),
            value: value.to_string(),
            format: format.map(str::to_string),
        }
    }

    #[test]
    fn validates_claude_json_object() {
        assert!(
            validate_common_config(input("claude", r#"{"model":"sonnet"}"#, Some("json"))).is_ok()
        );
    }

    #[test]
    fn rejects_claude_non_object() {
        assert_eq!(
            validate_common_config(input("claude", "[]", Some("json"))).unwrap_err(),
            "provider_common_config_must_be_object:value"
        );
    }

    #[test]
    fn validates_codex_toml() {
        assert!(validate_common_config(input("codex", "model = \"gpt-5\"", Some("toml"))).is_ok());
    }

    #[test]
    fn rejects_invalid_grok_toml() {
        assert_eq!(
            validate_common_config(input("grok", "model =", Some("toml"))).unwrap_err(),
            "provider_common_config_invalid_toml:value"
        );
    }

    #[test]
    fn accepts_codex_toml_with_secret_like_field_names() {
        // issue #241：字段名含 token / auth 子串的普通配置项不能被当成密钥拦截。
        let value = concat!(
            "model_provider = \"custom\"\n",
            "model_reasoning_effort = \"high\"\n",
            "model_context_window = 272000\n",
            "model_auto_compact_token_limit = 240000\n",
            "\n",
            "[model_providers.custom]\n",
            "name = \"OpenAI\"\n",
            "wire_api = \"responses\"\n",
            "requires_openai_auth = true\n",
            "supports_websockets = true\n",
        );
        assert!(validate_common_config(input("codex", value, Some("toml"))).is_ok());
    }

    #[test]
    fn accepts_common_config_carrying_real_secrets() {
        assert!(validate_common_config(input(
            "codex",
            "[model_providers.custom]\napi_key = \"sk-test\"\n",
            Some("toml")
        ))
        .is_ok());
        assert!(validate_common_config(input(
            "claude",
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test"}}"#,
            Some("json")
        ))
        .is_ok());
    }
}
