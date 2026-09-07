use super::catalog::list_providers;
use super::dto::ProviderCard;
use super::support::normalize_app_type;
use crate::provider::database;
use sqlx::{Connection, Row};
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub(crate) struct FailoverProviderRecord {
    pub card: ProviderCard,
    pub ready: bool,
    pub in_failover_queue: bool,
}

pub(crate) async fn list_failover_providers(
    app_type: &str,
) -> Result<Vec<FailoverProviderRecord>, String> {
    let app_type = normalize_app_type(app_type)?;
    let cards = list_providers(Some(app_type.clone())).await?;
    let mut connection = database::open_connection().await?;
    let rows = sqlx::query(
        "SELECT id, in_failover_queue
         FROM providers
         WHERE app_type = ?1
         ORDER BY sort_index, id",
    )
    .bind(&app_type)
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "routing_provider_read_failed".to_string())?;

    let mut queue_flags = std::collections::HashMap::with_capacity(rows.len());
    for row in rows {
        let id: String = row
            .try_get("id")
            .map_err(|_| "routing_provider_read_failed".to_string())?;
        let in_failover_queue: i64 = row
            .try_get("in_failover_queue")
            .map_err(|_| "routing_provider_read_failed".to_string())?;
        queue_flags.insert(id, in_failover_queue != 0);
    }

    Ok(cards
        .into_iter()
        .map(|card| {
            let ready = card.enabled && card.settings_valid && card.active_key_label.is_some();
            let in_failover_queue = queue_flags.get(&card.id).copied().unwrap_or(false);
            FailoverProviderRecord {
                card,
                ready,
                in_failover_queue,
            }
        })
        .collect())
}

pub(crate) async fn set_failover_queue(
    app_type: &str,
    provider_ids: &[String],
) -> Result<(), String> {
    let app_type = normalize_app_type(app_type)?;
    let mut normalized_ids = Vec::with_capacity(provider_ids.len());
    let mut seen = HashSet::with_capacity(provider_ids.len());
    for provider_id in provider_ids {
        let provider_id = provider_id.trim();
        if provider_id.is_empty() || !seen.insert(provider_id.to_string()) {
            return Err("routing_failover_queue_invalid".to_string());
        }
        normalized_ids.push(provider_id.to_string());
    }

    let providers = list_failover_providers(&app_type).await?;
    for provider_id in &normalized_ids {
        let provider = providers
            .iter()
            .find(|item| item.card.id == *provider_id)
            .ok_or_else(|| "routing_provider_not_found".to_string())?;
        if !provider.ready {
            return Err("routing_provider_not_ready".to_string());
        }
    }

    let mut connection = database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "routing_failover_queue_write_failed".to_string())?;
    sqlx::query("UPDATE providers SET in_failover_queue = 0 WHERE app_type = ?1")
        .bind(&app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "routing_failover_queue_write_failed".to_string())?;
    for provider_id in normalized_ids {
        sqlx::query(
            "UPDATE providers SET in_failover_queue = 1
             WHERE app_type = ?1 AND id = ?2",
        )
        .bind(&app_type)
        .bind(provider_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "routing_failover_queue_write_failed".to_string())?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| "routing_failover_queue_write_failed".to_string())?;
    Ok(())
}
