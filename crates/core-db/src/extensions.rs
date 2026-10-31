use std::path::Path;

use sqlx::{FromRow, SqlitePool};

use crate::pool::DbPool;

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct ExtensionOverview {
    pub kind: String,
    pub item_id: String,
    pub name: String,
    pub status: String,
    pub source: String,
    pub updated_at: i64,
    enabled_by_cli_json: String,
}

impl ExtensionOverview {
    pub fn is_installation(&self) -> bool {
        self.kind == "skill-installation"
    }

    pub fn is_mcp(&self) -> bool {
        self.kind == "mcp"
    }

    pub fn enabled_for(&self, cli: &str) -> bool {
        serde_json::from_str::<serde_json::Value>(&self.enabled_by_cli_json)
            .ok()
            .and_then(|value| value.get(cli).and_then(serde_json::Value::as_bool))
            .unwrap_or(true)
    }
}

pub async fn list_extension_overview(
    reader: &SqlitePool,
) -> Result<Vec<ExtensionOverview>, sqlx::Error> {
    sqlx::query_as::<_, ExtensionOverview>(
        "SELECT kind, item_id, name, status, source, updated_at, enabled_by_cli_json
         FROM (
             SELECT 'mcp' AS kind, resource_id AS item_id, name,
                    'managed' AS status, source_kind AS source, updated_at,
                    CASE WHEN json_valid(definition_json)
                         THEN COALESCE(json_extract(definition_json, '$.enabledByCli'), '{}')
                         ELSE '{}' END AS enabled_by_cli_json
             FROM extension_mcp_resources
             UNION ALL
             SELECT 'skill' AS kind, package_id AS item_id, name,
                    'managed' AS status, source_kind AS source, updated_at,
                    '{}' AS enabled_by_cli_json
             FROM extension_skill_packages
             UNION ALL
             SELECT 'skill-installation' AS kind, installation_id AS item_id,
                    cli || ' · ' || environment_kind AS name,
                    CASE WHEN external_modified = 1 THEN 'externalModified'
                         WHEN owned = 1 THEN 'owned' ELSE 'unowned' END AS status,
                    environment_id AS source, updated_at,
                    '{}' AS enabled_by_cli_json
             FROM extension_skill_installations
         )
         ORDER BY updated_at DESC, item_id ASC",
    )
    .fetch_all(reader)
    .await
}

/// 原子更新受管 MCP 的单个 CLI 开关，保留 canonical JSON 中的其他字段和秘密。
pub async fn set_mcp_enabled(
    path: impl AsRef<Path>,
    resource_id: String,
    cli: String,
    enabled: bool,
) -> Result<(), String> {
    if !["claude", "codex", "grok"].contains(&cli.as_str()) {
        return Err("extensions_mcp_cli_invalid".into());
    }
    let path = path.as_ref();
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Err("extensions_database_missing".into());
    }
    let pool = DbPool::open_existing(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        let mut transaction = pool
            .writer()
            .begin()
            .await
            .map_err(|error| error.to_string())?;
        let json: String = sqlx::query_scalar(
            "SELECT definition_json FROM extension_mcp_resources WHERE resource_id = ?1",
        )
        .bind(&resource_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "extensions_mcp_not_found".to_string())?;
        let mut value: serde_json::Value =
            serde_json::from_str(&json).map_err(|_| "extensions_storage_corrupt".to_string())?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| "extensions_storage_corrupt".to_string())?;
        let switches = object
            .entry("enabledByCli")
            .or_insert_with(|| serde_json::json!({}));
        let switches = switches
            .as_object_mut()
            .ok_or_else(|| "extensions_storage_corrupt".to_string())?;
        switches.insert(cli, serde_json::Value::Bool(enabled));
        let updated = serde_json::to_string(&value)
            .map_err(|_| "extensions_definition_serialize_failed".to_string())?;
        sqlx::query(
            "UPDATE extension_mcp_resources
             SET definition_json = ?1, updated_at = ?2, revision = revision + 1
             WHERE resource_id = ?3",
        )
        .bind(updated)
        .bind(now_ms())
        .bind(resource_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;
    pool.close().await;
    result
}

/// 原子更新受管 MCP 名称，同时同步列表列和 canonical JSON 的 name 字段。
pub async fn rename_mcp_resource(
    path: impl AsRef<Path>,
    resource_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 16 * 1024 {
        return Err("extensions_mcp_name_invalid".into());
    }
    let path = path.as_ref();
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Err("extensions_database_missing".into());
    }
    let pool = DbPool::open_existing(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        let mut transaction = pool
            .writer()
            .begin()
            .await
            .map_err(|error| error.to_string())?;
        let json: String = sqlx::query_scalar(
            "SELECT definition_json FROM extension_mcp_resources WHERE resource_id = ?1",
        )
        .bind(&resource_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "extensions_mcp_not_found".to_string())?;
        let mut value: serde_json::Value =
            serde_json::from_str(&json).map_err(|_| "extensions_storage_corrupt".to_string())?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| "extensions_storage_corrupt".to_string())?;
        object.insert("name".into(), serde_json::Value::String(name.clone()));
        let updated = serde_json::to_string(&value)
            .map_err(|_| "extensions_definition_serialize_failed".to_string())?;
        let affected = sqlx::query(
            "UPDATE extension_mcp_resources
             SET name = ?1, definition_json = ?2, updated_at = ?3, revision = revision + 1
             WHERE resource_id = ?4",
        )
        .bind(name)
        .bind(updated)
        .bind(now_ms())
        .bind(resource_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?
        .rows_affected();
        if affected != 1 {
            return Err("extensions_mcp_not_found".into());
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;
    pool.close().await;
    result
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 删除受管 MCP canonical 记录；不会触碰任何 CLI 原生配置文件。
pub async fn delete_mcp_resource(path: impl AsRef<Path>, resource_id: String) -> Result<(), String> {
    let path = path.as_ref();
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Err("extensions_database_missing".into());
    }
    let pool = DbPool::open_existing(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        let mut transaction = pool
            .writer()
            .begin()
            .await
            .map_err(|error| error.to_string())?;
        let affected = sqlx::query("DELETE FROM extension_mcp_resources WHERE resource_id = ?1")
            .bind(resource_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?
            .rows_affected();
        if affected != 1 {
            return Err("extensions_mcp_not_found".into());
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;
    pool.close().await;
    result
}
