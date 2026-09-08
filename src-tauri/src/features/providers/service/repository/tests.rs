use super::documents::merge_json_documents;
use super::dto::ClaudeConfigInput;
use super::keys::{activate_key_in_transaction, delete_key_in_transaction};
use super::support::{
    apply_claude_config_fields, apply_claude_meta, apply_config_fields,
    claude_config_from_settings, config_summary, duplicate_settings_config, normalize_app_type,
    project_key_into_settings, redact_settings_config, strip_json_secrets,
};
use crate::provider::database;
use serde_json::Map;
use serde_json::Value;
use sqlx::{Connection, SqliteConnection};
use tempfile::tempdir;

#[test]
// 验证两个公开 Grok 别名规范化为 grokbuild，未支持的 Gemini 类型被拒绝。
fn normalizes_public_grok_aliases() {
    assert_eq!(normalize_app_type("grok").unwrap(), "grokbuild");
    assert_eq!(normalize_app_type("grok-build").unwrap(), "grokbuild");
    assert!(normalize_app_type("gemini").is_err());
}

#[test]
// 验证样例嵌套认证值被脱敏，端点保留，并返回包含敏感值且配置有效的标记。
fn redacts_nested_secret_values_without_changing_non_secrets() {
    let raw = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret-token","ANTHROPIC_BASE_URL":"https://example.test"}}"#;
    let (redacted, has_secret, valid) = redact_settings_config(raw);
    assert!(has_secret);
    assert!(valid);
    assert!(!redacted.contains("secret-token"));
    assert!(redacted.contains("https://example.test"));
}

#[test]
fn redacts_and_strips_secrets_from_every_json_array_entry() {
    let raw = r#"{"providers":[{"api_key":"first-secret"},{"api_key":"second-secret"}]}"#;
    let (redacted, has_secret, valid) = redact_settings_config(raw);
    assert!(valid);
    assert!(has_secret);
    assert!(!redacted.contains("first-secret"));
    assert!(!redacted.contains("second-secret"));

    let mut value: Value = serde_json::from_str(raw).unwrap();
    assert!(strip_json_secrets(&mut value));
    assert!(value["providers"][0].get("api_key").is_none());
    assert!(value["providers"][1].get("api_key").is_none());
}

#[test]
// 验证复制配置时移除样例投影凭据，保留端点和模型。
fn duplicate_config_drops_projected_credentials() {
    let duplicate = duplicate_settings_config(
        r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret-token","ANTHROPIC_BASE_URL":"https://example.test"},"model":"x"}"#,
    );
    assert!(!duplicate.contains("secret-token"));
    assert!(duplicate.contains("https://example.test"));
    assert!(duplicate.contains("\"model\":\"x\""));
}

#[test]
// 验证三种 CLI 的密钥投影输出包含各自预期认证字段，不验证真实服务鉴权。
fn projects_active_key_into_app_specific_json_fields() {
    let claude = project_key_into_settings("claude", r#"{"env":{}}"#, "sk-claude").unwrap();
    assert!(claude.contains("ANTHROPIC_AUTH_TOKEN"));
    let codex = project_key_into_settings("codex", r#"{}"#, "sk-codex").unwrap();
    assert!(codex.contains("OPENAI_API_KEY"));
    let grok = project_key_into_settings("grokbuild", r#"{}"#, "sk-grok").unwrap();
    assert!(grok.contains("api_key"));
}

#[test]
// 验证选用 ANTHROPIC_API_KEY 时写入新凭据并移除旧 AUTH_TOKEN 字段。
fn projects_claude_key_into_selected_auth_field() {
    let projected = project_key_into_settings(
        "claude",
        r#"{"env":{"ANTHROPIC_API_KEY":"","ANTHROPIC_AUTH_TOKEN":"old"}}"#,
        "sk-selected",
    )
    .unwrap();
    let value: Value = serde_json::from_str(&projected).unwrap();
    assert_eq!(value["env"]["ANTHROPIC_API_KEY"], "sk-selected");
    assert!(value["env"]["ANTHROPIC_AUTH_TOKEN"].is_null());
}

#[test]
// 验证更新可见端点、模型及协议字段时保留既有凭据和其他环境项。
fn applies_visible_config_fields_without_overwriting_credentials() {
    let updated = apply_config_fields(
        "claude",
        r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret","OTHER":"keep"}}"#,
        Some("https://api.example.test"),
        Some("claude-test"),
        Some("anthropic"),
    )
    .unwrap();
    let value: Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
    assert_eq!(value["env"]["OTHER"], "keep");
    assert_eq!(
        value["env"]["ANTHROPIC_BASE_URL"],
        "https://api.example.test"
    );
    assert_eq!(value["env"]["ANTHROPIC_MODEL"], "claude-test");
    assert_eq!(value["api_format"], "anthropic");
}

#[test]
// 验证 Claude 高级配置在 settings 与 meta 间往返，切换认证字段时保留凭据并移除旧字段。
fn claude_advanced_fields_round_trip_to_settings_and_meta() {
    let input = ClaudeConfigInput {
        api_format: Some("openai_chat".to_string()),
        api_key_field: Some("ANTHROPIC_API_KEY".to_string()),
        is_full_url: Some(true),
        model: Some("fallback[1M]".to_string()),
        default_haiku_model: Some("haiku".to_string()),
        default_haiku_model_name: Some("Haiku".to_string()),
        default_sonnet_model: Some("sonnet[1M]".to_string()),
        default_sonnet_model_name: Some("Sonnet".to_string()),
        default_opus_model: Some("opus".to_string()),
        default_opus_model_name: Some("Opus".to_string()),
        default_fable_model: Some("fable[1M]".to_string()),
        default_fable_model_name: Some("Fable".to_string()),
        subagent_model: Some("subagent[1M]".to_string()),
    };
    let raw = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"existing"}}"#;
    let updated = apply_claude_config_fields(raw, Some(&input)).unwrap();
    let value: Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(value["api_format"], "openai_chat");
    assert_eq!(value["env"]["ANTHROPIC_API_KEY"], "existing");
    assert!(value["env"]["ANTHROPIC_AUTH_TOKEN"].is_null());
    assert_eq!(value["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"], "fable[1M]");
    assert_eq!(value["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "subagent[1M]");

    let mut meta = Map::new();
    apply_claude_meta(&mut meta, Some(&input));
    let config = claude_config_from_settings(&updated, &meta);
    assert_eq!(config.api_format, "openai_chat");
    assert_eq!(config.api_key_field, "ANTHROPIC_API_KEY");
    assert!(config.is_full_url);
    assert_eq!(config.default_sonnet_model, "sonnet[1M]");
    assert_eq!(config.default_fable_model_name, "Fable");
}

#[test]
// 验证 Claude 高级字段拒绝未知 API 格式并给出稳定错误。
fn claude_advanced_fields_reject_unknown_api_format() {
    let input = ClaudeConfigInput {
        api_format: Some("unknown".to_string()),
        ..ClaudeConfigInput::default()
    };
    let result = apply_claude_config_fields(r#"{"env":{}}"#, Some(&input));
    assert_eq!(
        result.unwrap_err(),
        "provider_claude_api_format_invalid:unknown"
    );
}

#[test]
// 验证嵌套公共配置合并时供应商值优先，同时保留未被覆盖的公共环境项。
fn common_config_merge_keeps_provider_override() {
    let merged = merge_json_documents(
        r#"{"env":{"A":"common","B":"common"},"timeout":1}"#,
        r#"{"env":{"A":"provider"},"timeout":2}"#,
    )
    .unwrap();
    let value: Value = serde_json::from_str(&merged).unwrap();
    assert_eq!(value["env"]["A"], "provider");
    assert_eq!(value["env"]["B"], "common");
    assert_eq!(value["timeout"], 2);
}

#[test]
// 验证配置摘要能从内嵌 TOML 提取端点和模型。
fn config_summary_reads_nested_toml_document_fields() {
    let summary = config_summary(
        "codex",
        r##"{"config":"# provider\nmodel = \"gpt-test\"\n[model_providers.custom]\nbase_url = \"https://api.example.test\"\n"}"##,
    );
    assert_eq!(summary.0.as_deref(), Some("https://api.example.test"));
    assert_eq!(summary.1.as_deref(), Some("gpt-test"));
}

#[tokio::test]
// 在内存数据库验证引用统计只计匹配类型与 ID 的项目及活动 Worktree，排除旧格式、损坏值和缺失 Worktree。
async fn lifecycle_reference_count_uses_project_and_active_worktree_overrides() {
    let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE projects (provider_overrides TEXT NOT NULL)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE worktrees (provider_overrides TEXT NOT NULL, status TEXT NOT NULL)")
        .execute(&mut connection)
        .await
        .unwrap();

    let claude_reference = r#"{"claude":{"schemaVersion":2,"source":"cli-manager","appType":"claude","providerId":"provider-a"}}"#;
    let codex_reference = r#"{"codex":{"schemaVersion":2,"source":"cli-manager","appType":"codex","providerId":"provider-a"}}"#;
    let legacy_claude_reference =
        r#"{"claude":{"providerId":"ccs-provider-a","settingsPath":"old"}}"#;
    let malformed_claude_reference = "not-json";
    sqlx::query("INSERT INTO projects (provider_overrides) VALUES (?1), (?2), (?3), (?4)")
        .bind(claude_reference)
        .bind(codex_reference)
        .bind(legacy_claude_reference)
        .bind(malformed_claude_reference)
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO worktrees (provider_overrides, status) VALUES (?1, 'active'), (?1, 'missing')",
    )
    .bind(claude_reference)
    .execute(&mut connection)
    .await
    .unwrap();

    assert_eq!(
        super::catalog::provider_reference_count_in_app_database(
            &mut connection,
            "claude",
            "provider-a",
        )
        .await
        .unwrap(),
        2,
    );
    assert_eq!(
        super::catalog::provider_reference_count_in_app_database(
            &mut connection,
            "claude",
            "provider-b",
        )
        .await
        .unwrap(),
        0,
    );
}

#[tokio::test]
// 在临时独立数据库激活 Claude 测试密钥，验证供应商配置投影和列表摘要遮罩，不访问 CCS。
async fn catalog_and_key_projection_round_trip_without_ccs() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("providers.db");
    database::open_connection_at(path.clone()).await.unwrap();

    let mut connection = database::open_connection_at(path).await.unwrap();
    let provider_id = "p1";
    sqlx::query(
        "INSERT INTO providers
         (id, app_type, name, settings_config, created_at, meta)
         VALUES (?1, 'claude', 'Claude', '{\"env\":{}}', 1, '{\"enabled\":true}')",
    )
    .bind(provider_id)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO provider_api_keys
         (id, provider_id, app_type, label, api_key, enabled, created_at, updated_at)
         VALUES ('k1', ?1, 'claude', 'Primary', 'sk-secret', 1, 1, 1)",
    )
    .bind(provider_id)
    .execute(&mut connection)
    .await
    .unwrap();
    let mut transaction = connection.begin().await.unwrap();
    activate_key_in_transaction(&mut transaction, provider_id, "claude", "k1")
        .await
        .unwrap();
    transaction.commit().await.unwrap();

    let settings: String = sqlx::query_scalar(
        "SELECT settings_config FROM providers WHERE id = ?1 AND app_type = 'claude'",
    )
    .bind(provider_id)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert!(settings.contains("ANTHROPIC_AUTH_TOKEN"));
    assert!(settings.contains("sk-secret"));
    let rows = super::support::list_keys_for_provider(&mut connection, "claude", provider_id)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].masked_api_key.contains("sk-secret"));
}

#[tokio::test]
// 在临时数据库同一事务内替换并删除活动密钥，验证成功提交后仅剩新活动项且凭据重投影；不注入失败验证回滚。
async fn replacing_active_key_is_atomic_and_reprojects_credentials() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("providers.db");
    database::open_connection_at(path.clone()).await.unwrap();

    let mut connection = database::open_connection_at(path).await.unwrap();
    sqlx::query(
        "INSERT INTO providers
         (id, app_type, name, settings_config, created_at, meta)
         VALUES ('p1', 'codex', 'Codex', '{}', 1, '{\"enabled\":true}')",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    for (id, secret) in [("k1", "sk-old"), ("k2", "sk-new")] {
        sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, enabled, created_at, updated_at)
             VALUES (?1, 'p1', 'codex', ?1, ?2, 1, 1, 1)",
        )
        .bind(id)
        .bind(secret)
        .execute(&mut connection)
        .await
        .unwrap();
    }

    let mut transaction = connection.begin().await.unwrap();
    activate_key_in_transaction(&mut transaction, "p1", "codex", "k1")
        .await
        .unwrap();
    transaction.commit().await.unwrap();

    let mut transaction = connection.begin().await.unwrap();
    delete_key_in_transaction(&mut transaction, "p1", "codex", "k1", Some("k2"))
        .await
        .unwrap();
    transaction.commit().await.unwrap();

    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_api_keys WHERE provider_id = 'p1' AND app_type = 'codex'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    let active_id: String = sqlx::query_scalar(
        "SELECT id FROM provider_api_keys
         WHERE provider_id = 'p1' AND app_type = 'codex' AND is_active = 1",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    let settings: String = sqlx::query_scalar(
        "SELECT settings_config FROM providers WHERE id = 'p1' AND app_type = 'codex'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();

    assert_eq!(remaining, 1);
    assert_eq!(active_id, "k2");
    assert!(settings.contains("sk-new"));
    assert!(!settings.contains("sk-old"));
}
