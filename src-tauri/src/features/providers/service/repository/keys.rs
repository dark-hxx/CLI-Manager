use super::dto::{ProviderKeyCreateInput, ProviderKeySummary, ProviderKeyUpdateInput};
use super::support::{
    error, key_from_row, list_keys_for_provider, load_provider, map_database_error,
    normalize_app_type, normalize_tags, optional_text, project_key_into_settings, required_name,
    unix_timestamp_millis,
};
use crate::provider::database;
use sqlx::{Connection, Row};
use uuid::Uuid;

pub(crate) async fn activate_key_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    provider_id: &str,
    app_type: &str,
    key_id: &str,
) -> Result<(), String> {
    let key = sqlx::query(
        "SELECT api_key, enabled FROM provider_api_keys
         WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id)
    .bind(provider_id)
    .bind(app_type)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", key_id))?;
    let enabled: i64 = key
        .try_get("enabled")
        .map_err(|_| error("provider_key_row_invalid", "enabled"))?;
    if enabled == 0 {
        return Err(error("provider_key_disabled_cannot_activate", key_id));
    }
    let api_key: String = key
        .try_get("api_key")
        .map_err(|_| error("provider_key_row_invalid", "api_key"))?;
    sqlx::query(
        "UPDATE provider_api_keys SET is_active = 0
         WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .execute(&mut **transaction)
    .await
    .map_err(|err| map_database_error("provider_key_clear_active_failed", err))?;
    sqlx::query(
        "UPDATE provider_api_keys SET is_active = 1, updated_at = ?1
         WHERE id = ?2 AND provider_id = ?3 AND app_type = ?4",
    )
    .bind(unix_timestamp_millis())
    .bind(key_id)
    .bind(provider_id)
    .bind(app_type)
    .execute(&mut **transaction)
    .await
    .map_err(|err| map_database_error("provider_key_set_active_failed", err))?;
    let provider =
        sqlx::query("SELECT settings_config FROM providers WHERE id = ?1 AND app_type = ?2")
            .bind(provider_id)
            .bind(app_type)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|err| map_database_error("provider_load_failed", err))?
            .ok_or_else(|| error("provider_not_found", provider_id))?;
    let settings_config: String = provider
        .try_get("settings_config")
        .map_err(|_| error("provider_row_invalid", "settings_config"))?;
    let projected = project_key_into_settings(app_type, &settings_config, &api_key)?;
    sqlx::query("UPDATE providers SET settings_config = ?1 WHERE id = ?2 AND app_type = ?3")
        .bind(projected)
        .bind(provider_id)
        .bind(app_type)
        .execute(&mut **transaction)
        .await
        .map_err(|err| map_database_error("provider_key_projection_failed", err))?;
    Ok(())
}

pub(crate) async fn list_keys(
    app_type: String,
    provider_id: String,
) -> Result<Vec<ProviderKeySummary>, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let _ = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    list_keys_for_provider(&mut connection, &app_type, provider_id.trim()).await
}

pub(crate) async fn create_key(
    input: ProviderKeyCreateInput,
) -> Result<ProviderKeySummary, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let provider_id = input.provider_id.trim();
    let label = required_name(&input.label)?;
    let api_key = input.api_key.trim();
    if api_key.is_empty() {
        return Err(error("provider_key_required", "apiKey"));
    }
    let tags = normalize_tags(input.tags)?;
    let enabled = input.enabled.unwrap_or(true);
    if input.activate.unwrap_or(false) && !enabled {
        return Err(error("provider_key_disabled_cannot_activate", "apiKey"));
    }
    let now = unix_timestamp_millis();
    let key_id = Uuid::new_v4().to_string();
    let mut connection = database::open_connection().await?;
    let _ = load_provider(&mut connection, &app_type, provider_id).await?;
    let sort_index: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(&app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_sort_index_failed", err))?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_create_begin_failed", err))?;
    sqlx::query(
        "INSERT INTO provider_api_keys
         (id, provider_id, app_type, label, api_key, tags, notes, enabled,
          sort_index, is_active, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
    )
    .bind(&key_id)
    .bind(provider_id)
    .bind(&app_type)
    .bind(label)
    .bind(api_key)
    .bind(tags)
    .bind(optional_text(input.notes).unwrap_or_default())
    .bind(if enabled { 1 } else { 0 })
    .bind(sort_index)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|err| map_database_error("provider_key_create_failed", err))?;
    if input.activate.unwrap_or(false) {
        activate_key_in_transaction(&mut transaction, provider_id, &app_type, &key_id).await?;
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_create_commit_failed", err))?;
    drop(connection);
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys WHERE id = ?1",
    )
    .bind(key_id)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?;
    key_from_row(&row)
}

pub(crate) async fn update_key(
    input: ProviderKeyUpdateInput,
) -> Result<ProviderKeySummary, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let provider_id = input.provider_id.trim();
    let mut connection = database::open_connection().await?;
    let _ = load_provider(&mut connection, &app_type, provider_id).await?;
    let existing = sqlx::query(
        "SELECT label, api_key, tags, notes, enabled, is_active
         FROM provider_api_keys WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(input.id.trim())
    .bind(provider_id)
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", input.id.trim()))?;
    let old_enabled: i64 = existing.try_get("enabled").unwrap_or(1);
    let active: i64 = existing.try_get("is_active").unwrap_or(0);
    let enabled = input.enabled.unwrap_or(old_enabled != 0);
    if active != 0 && !enabled {
        return Err(error("provider_key_active_cannot_disable", input.id.trim()));
    }
    let label = input
        .label
        .as_deref()
        .map(required_name)
        .transpose()?
        .unwrap_or_else(|| existing.try_get("label").unwrap_or_default());
    let api_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| existing.try_get("api_key").unwrap_or_default());
    if api_key.is_empty() {
        return Err(error("provider_key_required", "apiKey"));
    }
    let tags = match input.tags {
        Some(tags) => normalize_tags(Some(tags))?,
        None => existing
            .try_get("tags")
            .unwrap_or_else(|_| "[]".to_string()),
    };
    let notes = input
        .notes
        .map(|value| optional_text(Some(value)).unwrap_or_default())
        .unwrap_or_else(|| existing.try_get("notes").unwrap_or_default());
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_update_begin_failed", err))?;
    sqlx::query(
        "UPDATE provider_api_keys SET label = ?1, api_key = ?2, tags = ?3,
         notes = ?4, enabled = ?5, updated_at = ?6
         WHERE id = ?7 AND provider_id = ?8 AND app_type = ?9",
    )
    .bind(label)
    .bind(api_key)
    .bind(tags)
    .bind(notes)
    .bind(if enabled { 1 } else { 0 })
    .bind(unix_timestamp_millis())
    .bind(input.id.trim())
    .bind(provider_id)
    .bind(&app_type)
    .execute(&mut *transaction)
    .await
    .map_err(|err| map_database_error("provider_key_update_failed", err))?;
    if active != 0 {
        activate_key_in_transaction(&mut transaction, provider_id, &app_type, input.id.trim())
            .await?;
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_update_commit_failed", err))?;
    drop(connection);
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys WHERE id = ?1",
    )
    .bind(input.id.trim())
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?;
    key_from_row(&row)
}

pub(crate) async fn delete_key(
    app_type: String,
    provider_id: String,
    key_id: String,
    replacement_key_id: Option<String>,
) -> Result<(), String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let provider_id = provider_id.trim().to_string();
    let key_id = key_id.trim().to_string();
    let replacement_key_id = replacement_key_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_delete_begin_failed", err))?;
    delete_key_in_transaction(
        &mut transaction,
        &provider_id,
        &app_type,
        &key_id,
        replacement_key_id.as_deref(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_delete_commit_failed", err))?;
    Ok(())
}

pub(crate) async fn delete_key_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    provider_id: &str,
    app_type: &str,
    key_id: &str,
    replacement_key_id: Option<&str>,
) -> Result<(), String> {
    let row = sqlx::query(
        "SELECT is_active FROM provider_api_keys
         WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id)
    .bind(provider_id)
    .bind(app_type)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", key_id))?;
    let is_active = row.try_get::<i64, _>("is_active").unwrap_or(0) != 0;

    if is_active {
        let replacement_key_id = replacement_key_id
            .ok_or_else(|| error("provider_key_active_requires_replacement", key_id))?;
        if replacement_key_id == key_id {
            return Err(error("provider_key_replacement_invalid", key_id));
        }
        activate_key_in_transaction(transaction, provider_id, app_type, &replacement_key_id)
            .await?;
        sqlx::query(
            "DELETE FROM provider_api_keys
             WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
        )
        .bind(key_id)
        .bind(provider_id)
        .bind(app_type)
        .execute(&mut **transaction)
        .await
        .map_err(|err| map_database_error("provider_key_delete_failed", err))?;
    } else {
        sqlx::query(
            "DELETE FROM provider_api_keys
             WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
        )
        .bind(key_id)
        .bind(provider_id)
        .bind(app_type)
        .execute(&mut **transaction)
        .await
        .map_err(|err| map_database_error("provider_key_delete_failed", err))?;
    }
    Ok(())
}

pub(crate) async fn set_key_enabled(
    app_type: String,
    provider_id: String,
    key_id: String,
    enabled: bool,
) -> Result<ProviderKeySummary, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT is_active FROM provider_api_keys
         WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id.trim())
    .bind(provider_id.trim())
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", key_id.trim()))?;
    if !enabled && row.try_get::<i64, _>("is_active").unwrap_or(0) != 0 {
        return Err(error("provider_key_active_cannot_disable", key_id.trim()));
    }
    sqlx::query(
        "UPDATE provider_api_keys SET enabled = ?1, updated_at = ?2
         WHERE id = ?3 AND provider_id = ?4 AND app_type = ?5",
    )
    .bind(if enabled { 1 } else { 0 })
    .bind(unix_timestamp_millis())
    .bind(key_id.trim())
    .bind(provider_id.trim())
    .bind(&app_type)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_enabled_update_failed", err))?;
    drop(connection);
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys WHERE id = ?1",
    )
    .bind(key_id.trim())
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?;
    key_from_row(&row)
}

pub(crate) async fn activate_key(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<ProviderKeySummary, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let _ = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_activate_begin_failed", err))?;
    activate_key_in_transaction(
        &mut transaction,
        provider_id.trim(),
        &app_type,
        key_id.trim(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_activate_commit_failed", err))?;
    drop(connection);
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys WHERE id = ?1",
    )
    .bind(key_id.trim())
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?;
    key_from_row(&row)
}

pub(crate) async fn reorder_keys(
    app_type: String,
    provider_id: String,
    key_ids: Vec<String>,
) -> Result<Vec<ProviderKeySummary>, String> {
    let app_type = normalize_app_type(&app_type)?;
    if key_ids.is_empty() {
        return Err(error("provider_key_reorder_empty", "keyIds"));
    }
    let mut connection = database::open_connection().await?;
    let expected: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_api_keys WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id.trim())
    .bind(&app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_reorder_count_failed", err))?;
    let unique_count = key_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::HashSet<_>>()
        .len() as i64;
    if unique_count != expected || unique_count != key_ids.len() as i64 {
        return Err(error("provider_key_reorder_mismatch", "keyIds"));
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_reorder_begin_failed", err))?;
    for (sort_index, key_id) in key_ids.iter().enumerate() {
        let affected = sqlx::query(
            "UPDATE provider_api_keys SET sort_index = ?1, updated_at = ?2
             WHERE id = ?3 AND provider_id = ?4 AND app_type = ?5",
        )
        .bind(sort_index as i64)
        .bind(unix_timestamp_millis())
        .bind(key_id.trim())
        .bind(provider_id.trim())
        .bind(&app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|err| map_database_error("provider_key_reorder_update_failed", err))?
        .rows_affected();
        if affected != 1 {
            return Err(error("provider_key_not_found", key_id));
        }
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_reorder_commit_failed", err))?;
    drop(connection);
    list_keys(app_type, provider_id).await
}

pub(crate) async fn reveal_key(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<String, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    sqlx::query_scalar(
        "SELECT api_key FROM provider_api_keys
         WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id.trim())
    .bind(provider_id.trim())
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_reveal_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", key_id.trim()))
}
