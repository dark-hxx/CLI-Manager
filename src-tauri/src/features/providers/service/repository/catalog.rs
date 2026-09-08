use super::common::get_common_config_value;
use super::documents::merge_common_into_settings;
use super::documents::{documents_from_settings, preserve_toml_secrets};
use super::dto::{ProviderCard, ProviderCreateInput, ProviderDetail, ProviderUpdateInput};
use super::support::{
    apply_claude_config_fields, apply_claude_meta, apply_config_fields,
    card_from_record_with_connection, claude_config_from_settings, duplicate_settings_config,
    error, is_secret_key, load_provider, map_database_error, meta_common_config_enabled,
    normalize_app_type, normalize_settings_config, optional_text, optional_text_value, parse_meta,
    provider_from_row, serialize_meta, unix_timestamp_millis,
};
use crate::app_paths;
use crate::provider::database;
use serde_json::{Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::Connection;
use std::time::Duration;
use uuid::Uuid;

// 按可选规范化类型筛选并排序供应商，再用同一连接逐个补齐卡片信息；多次查询不构成事务快照。
pub(crate) async fn list_providers(app_type: Option<String>) -> Result<Vec<ProviderCard>, String> {
    let normalized_type = app_type.as_deref().map(normalize_app_type).transpose()?;
    let mut connection = database::open_connection().await?;
    let rows = sqlx::query(
        "SELECT id, app_type, name, settings_config, website_url, category,
                created_at, sort_index, notes, icon, icon_color, meta, is_current
         FROM providers
         WHERE (?1 IS NULL OR app_type = ?1)
         ORDER BY app_type, sort_index, name COLLATE NOCASE",
    )
    .bind(normalized_type.as_deref())
    .fetch_all(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_list_failed", err))?;

    let mut providers = Vec::with_capacity(rows.len());
    for row in &rows {
        let record = provider_from_row(row)?;
        providers.push(card_from_record_with_connection(&mut connection, &record).await?);
    }
    Ok(providers)
}

// 汇总供应商卡片、密钥摘要和配置文档；有效配置合并失败时回退原脱敏设置，再对展示配置执行脱敏。
pub(crate) async fn get_provider(
    app_type: String,
    provider_id: String,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let record = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    let card = card_from_record_with_connection(&mut connection, &record).await?;
    let keys =
        super::support::list_keys_for_provider(&mut connection, &app_type, &record.id).await?;
    let (settings_config, settings_has_secret, _) =
        super::support::redact_settings_config(&record.settings_config);
    let common = get_common_config_value(&mut connection, &app_type).await?;
    let effective_settings_config = if card.common_config_enabled {
        merge_common_into_settings(&app_type, &common, &record.settings_config)
            .unwrap_or_else(|_| settings_config.clone())
    } else {
        settings_config.clone()
    };
    let (effective_settings_config, _, _) =
        super::support::redact_settings_config(&effective_settings_config);
    let claude_config = (app_type == "claude")
        .then(|| claude_config_from_settings(&record.settings_config, &parse_meta(&record.meta)));
    Ok(ProviderDetail {
        card,
        settings_config,
        effective_settings_config,
        settings_has_secret,
        claude_config,
        documents: documents_from_settings(&app_type, &record.settings_config),
        keys,
    })
}

// 以已有对象的敏感键覆盖传入值，非敏感节点按对象或数组对应位置递归；不补回整个缺失父节点，也不拦截新增敏感键。
fn preserve_json_secrets(existing: &Value, incoming: &mut Value) {
    match (existing, incoming) {
        (Value::Object(existing), Value::Object(incoming)) => {
            for (key, existing_value) in existing {
                if is_secret_key(key) {
                    incoming.insert(key.clone(), existing_value.clone());
                } else if let Some(incoming_value) = incoming.get_mut(key) {
                    preserve_json_secrets(existing_value, incoming_value);
                }
            }
        }
        (Value::Array(existing), Value::Array(incoming)) => {
            for (existing_value, incoming_value) in existing.iter().zip(incoming.iter_mut()) {
                preserve_json_secrets(existing_value, incoming_value);
            }
        }
        _ => {}
    }
}

// 要求传入设置为 JSON 对象并恢复可遍历的旧敏感值；非 Claude 另按 TOML 保留规则处理 config，缺失 config 时沿用旧值。
fn merge_settings_config_update(
    app_type: &str,
    existing_raw: &str,
    incoming_raw: &str,
) -> Result<String, String> {
    let existing = serde_json::from_str::<Value>(existing_raw)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    let mut incoming = serde_json::from_str::<Value>(incoming_raw)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    if !incoming.is_object() {
        return Err(error("provider_settings_must_be_object", "settings_config"));
    }
    preserve_json_secrets(&existing, &mut incoming);

    if app_type != "claude" {
        let existing_config = existing
            .get("config")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let incoming_config = incoming
            .get("config")
            .and_then(Value::as_str)
            .unwrap_or(existing_config);
        let mut config = incoming_config
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| error("provider_config_invalid", "config"))?;
        preserve_toml_secrets(existing_config, &mut config)?;
        incoming
            .as_object_mut()
            .expect("validated settings object")
            .insert("config".to_string(), Value::String(config.to_string()));
    }

    serde_json::to_string(&incoming).map_err(|_| error("provider_settings_serialize_failed", ""))
}

// 校验并投影配置后创建启用、非当前的新供应商，排序追加到末尾，再另读详情；不创建密钥记录或写 CLI Home。
pub(crate) async fn create_provider(input: ProviderCreateInput) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let name = super::support::required_name(&input.name)?;
    let normalized_settings = normalize_settings_config(input.settings_config)?;
    let settings_config = apply_config_fields(
        &app_type,
        &normalized_settings,
        input.base_url.as_deref(),
        input.model.as_deref(),
        input.api_format.as_deref(),
    )?;
    let settings_config =
        apply_claude_config_fields(&settings_config, input.claude_config.as_ref())?;
    let common_config_enabled = input.common_config_enabled.unwrap_or(true);
    let mut meta = Map::new();
    meta.insert("enabled".to_string(), Value::Bool(true));
    meta.insert(
        "commonConfigEnabled".to_string(),
        Value::Bool(common_config_enabled),
    );
    if app_type == "claude" {
        apply_claude_meta(&mut meta, input.claude_config.as_ref());
    }
    let now = unix_timestamp_millis();
    let id = Uuid::new_v4().to_string();
    let mut connection = database::open_connection().await?;
    let sort_index: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM providers WHERE app_type = ?1",
    )
    .bind(&app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_sort_index_failed", err))?;
    sqlx::query(
        "INSERT INTO providers
         (id, app_type, name, settings_config, website_url, category, created_at,
          sort_index, notes, icon, icon_color, meta, is_current)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)",
    )
    .bind(&id)
    .bind(&app_type)
    .bind(name)
    .bind(settings_config)
    .bind(optional_text(input.website_url))
    .bind(optional_text(input.category))
    .bind(now)
    .bind(sort_index)
    .bind(optional_text(input.notes))
    .bind(optional_text(input.icon))
    .bind(optional_text(input.icon_color))
    .bind(serialize_meta(meta)?)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_create_failed", err))?;
    get_provider(app_type, id).await
}

// 基于已读记录合并可选属性与配置并写库，再另读详情；无跨读取与写入的事务或版本校验。
pub(crate) async fn update_provider(input: ProviderUpdateInput) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let provider_id = input.provider_id.trim();
    if provider_id.is_empty() {
        return Err(error("provider_id_required", "providerId"));
    }
    let mut connection = database::open_connection().await?;
    let existing = load_provider(&mut connection, &app_type, provider_id).await?;
    let name = input
        .name
        .as_deref()
        .map(super::support::required_name)
        .transpose()?
        .unwrap_or(existing.name.clone());
    let normalized_settings = match input.settings_config {
        Some(value) => normalize_settings_config(Some(merge_settings_config_update(
            &app_type,
            &existing.settings_config,
            &value,
        )?))?,
        None => existing.settings_config.clone(),
    };
    let settings_config = apply_config_fields(
        &app_type,
        &normalized_settings,
        input.base_url.as_deref(),
        input.model.as_deref(),
        input.api_format.as_deref(),
    )?;
    let mut meta = parse_meta(&existing.meta);
    let settings_config =
        apply_claude_config_fields(&settings_config, input.claude_config.as_ref())?;
    if app_type == "claude" {
        apply_claude_meta(&mut meta, input.claude_config.as_ref());
    }
    if let Some(enabled) = input.common_config_enabled {
        meta.insert("commonConfigEnabled".to_string(), Value::Bool(enabled));
    }
    sqlx::query(
        "UPDATE providers SET name = ?1, settings_config = ?2, website_url = ?3,
         category = ?4, notes = ?5, icon = ?6, icon_color = ?7, meta = ?8
         WHERE id = ?9 AND app_type = ?10",
    )
    .bind(name)
    .bind(settings_config)
    .bind(
        input
            .website_url
            .map(optional_text_value)
            .unwrap_or(existing.website_url),
    )
    .bind(
        input
            .category
            .map(optional_text_value)
            .unwrap_or(existing.category),
    )
    .bind(
        input
            .notes
            .map(optional_text_value)
            .unwrap_or(existing.notes),
    )
    .bind(input.icon.map(optional_text_value).unwrap_or(existing.icon))
    .bind(
        input
            .icon_color
            .map(optional_text_value)
            .unwrap_or(existing.icon_color),
    )
    .bind(serialize_meta(meta)?)
    .bind(provider_id)
    .bind(&app_type)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_update_failed", err))?;
    get_provider(app_type, provider_id.to_string()).await
}

// 复制供应商属性与清理凭据后的配置，生成新 ID 并设为启用、非当前；不复制密钥表记录，随后读取新详情。
pub(crate) async fn duplicate_provider(
    app_type: String,
    provider_id: String,
    name: Option<String>,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let existing = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    let new_name = name
        .as_deref()
        .map(super::support::required_name)
        .transpose()?
        .unwrap_or_else(|| format!("{} Copy", existing.name));
    let new_id = Uuid::new_v4().to_string();
    let sort_index: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM providers WHERE app_type = ?1",
    )
    .bind(&app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_sort_index_failed", err))?;
    let mut meta = parse_meta(&existing.meta);
    meta.insert("enabled".to_string(), Value::Bool(true));
    meta.insert(
        "commonConfigEnabled".to_string(),
        Value::Bool(meta_common_config_enabled(&meta)),
    );
    sqlx::query(
        "INSERT INTO providers
         (id, app_type, name, settings_config, website_url, category, created_at,
          sort_index, notes, icon, icon_color, meta, is_current)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)",
    )
    .bind(&new_id)
    .bind(&app_type)
    .bind(new_name)
    .bind(duplicate_settings_config(&existing.settings_config))
    .bind(existing.website_url)
    .bind(existing.category)
    .bind(unix_timestamp_millis())
    .bind(sort_index)
    .bind(existing.notes)
    .bind(existing.icon)
    .bind(existing.icon_color)
    .bind(serialize_meta(meta)?)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_duplicate_failed", err))?;
    get_provider(app_type, new_id).await
}

// 只读打开应用主数据库统计引用，文件不存在时返回零；与供应商数据库的后续修改不构成跨库事务。
async fn provider_reference_count(app_type: &str, provider_id: &str) -> Result<i64, String> {
    let path =
        app_paths::db_path().map_err(|_| error("provider_reference_check_failed", "database"))?;
    if !path.is_file() {
        return Ok(0);
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| map_database_error("provider_reference_check_failed", err))?;
    provider_reference_count_in_app_database(&mut connection, app_type, provider_id).await
}

// 读取项目及活动 Worktree 的覆盖配置，按作用域解析器统计匹配类型和 ID 的原生引用，忽略无效或旧格式值。
pub(super) async fn provider_reference_count_in_app_database(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<i64, String> {
    let project_overrides =
        sqlx::query_scalar::<_, String>("SELECT provider_overrides FROM projects")
            .fetch_all(&mut *connection)
            .await
            .map_err(|err| map_database_error("provider_reference_check_failed", err))?;
    let worktree_overrides = sqlx::query_scalar::<_, String>(
        "SELECT provider_overrides FROM worktrees WHERE status = 'active'",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_reference_check_failed", err))?;

    let mut count = 0;
    for overrides in project_overrides.into_iter().chain(worktree_overrides) {
        // 只有当前原生目录可解析的 schema-v2 引用才会指向 providers.db。
        // 旧 CCS 引用已不能解析为原生供应商，不能阻塞其启停或删除。
        if matches!(
            crate::provider::scope::parse_provider_reference(Some(&overrides), app_type),
            Ok(Some(reference)) if reference == provider_id
        ) {
            count += 1;
        }
    }
    Ok(count)
}

// 拒绝当前或已被引用的供应商，再在事务内删除并登记内置项删除标记；引用检查发生在事务之前。
pub(crate) async fn delete_provider(app_type: String, provider_id: String) -> Result<(), String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let provider = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    if provider.is_current {
        return Err(error("provider_current_cannot_delete", "providerId"));
    }
    if provider_reference_count(&app_type, &provider.id).await? > 0 {
        return Err(error("provider_referenced_cannot_delete", "providerId"));
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_delete_failed", err))?;
    sqlx::query("DELETE FROM providers WHERE id = ?1 AND app_type = ?2")
        .bind(&provider.id)
        .bind(&app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|err| map_database_error("provider_delete_failed", err))?;
    // 内置供应商的种子在每次打开 providers.db 时都会跑一遍，所以删除必须同时登记
    // 退订，否则下一次查询就会用默认名称/URL/排序把它重新插回来（issue #242）。
    if database::is_builtin_provider(&app_type, &provider.id) {
        database::dismiss_builtin_provider(&mut transaction, &app_type, &provider.id).await?;
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_delete_failed", err))?;
    Ok(())
}

// 禁用前拒绝当前项及被引用项，更新元数据启用标记后另读详情；检查与更新不是同一事务。
pub(crate) async fn set_provider_enabled(
    app_type: String,
    provider_id: String,
    enabled: bool,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let provider = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    if !enabled && provider.is_current {
        return Err(error("provider_current_cannot_disable", "providerId"));
    }
    if !enabled && provider_reference_count(&app_type, &provider.id).await? > 0 {
        return Err(error("provider_referenced_cannot_disable", "providerId"));
    }
    let mut meta = parse_meta(&provider.meta);
    meta.insert("enabled".to_string(), Value::Bool(enabled));
    sqlx::query("UPDATE providers SET meta = ?1 WHERE id = ?2 AND app_type = ?3")
        .bind(serialize_meta(meta)?)
        .bind(&provider.id)
        .bind(&app_type)
        .execute(&mut connection)
        .await
        .map_err(|err| map_database_error("provider_enabled_update_failed", err))?;
    get_provider(app_type, provider.id).await
}

// 验证非空且唯一的完整 ID 列表，在事务内逐项验证归属并更新排序，提交后重新读取卡片列表。
pub(crate) async fn reorder_providers(
    app_type: String,
    provider_ids: Vec<String>,
) -> Result<Vec<ProviderCard>, String> {
    let app_type = normalize_app_type(&app_type)?;
    if provider_ids.is_empty() {
        return Err(error("provider_reorder_empty", "providerIds"));
    }
    let mut connection = database::open_connection().await?;
    let expected: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM providers WHERE app_type = ?1")
        .bind(&app_type)
        .fetch_one(&mut connection)
        .await
        .map_err(|err| map_database_error("provider_reorder_count_failed", err))?;
    let unique_count = provider_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::HashSet<_>>()
        .len() as i64;
    if unique_count != expected || unique_count != provider_ids.len() as i64 {
        return Err(error("provider_reorder_mismatch", "providerIds"));
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_reorder_begin_failed", err))?;
    for (sort_index, provider_id) in provider_ids.iter().enumerate() {
        let affected =
            sqlx::query("UPDATE providers SET sort_index = ?1 WHERE id = ?2 AND app_type = ?3")
                .bind(sort_index as i64)
                .bind(provider_id.trim())
                .bind(&app_type)
                .execute(&mut *transaction)
                .await
                .map_err(|err| map_database_error("provider_reorder_update_failed", err))?
                .rows_affected();
        if affected != 1 {
            return Err(error("provider_not_found", provider_id));
        }
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_reorder_commit_failed", err))?;
    drop(connection);
    list_providers(Some(app_type)).await
}

#[cfg(test)]
mod tests {
    use super::merge_settings_config_update;
    use serde_json::Value;

    #[test]
    // 验证 Codex 更新中的 JSON/TOML 遮罩值恢复为既有测试凭据，同时允许模型修改。
    fn provider_update_preserves_key_manager_owned_codex_secrets() {
        let existing = r#"{
            "auth": {"OPENAI_API_KEY": "sk-real"},
            "config": "api_key = \"toml-real\"\nmodel = \"old\"\n"
        }"#;
        let incoming = r#"{
            "auth": {"OPENAI_API_KEY": "***"},
            "config": "api_key = \"[REDACTED]\"\nmodel = \"new\"\n"
        }"#;
        let merged = merge_settings_config_update("codex", existing, incoming).unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["auth"]["OPENAI_API_KEY"], "sk-real");
        assert!(value["config"].as_str().unwrap().contains("toml-real"));
        assert!(value["config"]
            .as_str()
            .unwrap()
            .contains("model = \"new\""));
    }

    #[test]
    // 验证 Claude 更新保留已有认证值并接受新的模型字段。
    fn provider_update_preserves_key_manager_owned_claude_secrets() {
        let existing = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-real","ANTHROPIC_MODEL":"old"}}"#;
        let incoming = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"***","ANTHROPIC_MODEL":"new"}}"#;
        let merged = merge_settings_config_update("claude", existing, incoming).unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-real");
        assert_eq!(value["env"]["ANTHROPIC_MODEL"], "new");
    }
}
