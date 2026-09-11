use crate::{
    auth,
    error::AppError,
    state::AppState,
    storage::{now_ms, Storage},
};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use cli_manager_web_protocol::{
    BrowserEventPayload, BrowserSocketFrame, ConversationEvent, HistorySessionSummary,
};
use serde::Deserialize;
use sqlx::Row;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationQuery {
    device_id: String,
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ConversationQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = auth::require_user(&state, &headers).await?;
    auth::require_device_scope(&state, &headers, &query.device_id).await?;
    state
        .storage
        .device_for_user(&user.id, &query.device_id)
        .await?
        .ok_or_else(|| AppError::not_found("device_not_found", "device not found"))?;
    let session_ids = state
        .storage
        .established_conversation_session_ids(&user.id, &query.device_id)
        .await?;
    let mut sessions = Vec::new();
    for session_id in session_ids {
        let events = state
            .storage
            .conversation_events(&user.id, &query.device_id, &session_id)
            .await?;
        if let (Some(first), Some(last)) = (events.first(), events.last()) {
            let title = events
                .iter()
                .find(|e| e.kind == "user_message")
                .and_then(|e| e.text.as_deref())
                .unwrap_or("Conversation")
                .chars()
                .take(160)
                .collect();
            sessions.push(HistorySessionSummary {
                session_id: first.session_id.clone(),
                device_id: query.device_id.clone(),
                source: first.source.clone(),
                project_key: first.project_id.clone(),
                project_id: Some(first.project_id.clone()),
                worktree_id: first.worktree_id.clone(),
                title,
                cwd: None,
                created_at: first.occurred_at,
                updated_at: last.occurred_at,
                message_count: events
                    .iter()
                    .filter(|e| matches!(e.kind.as_str(), "user_message" | "assistant_done"))
                    .count() as u64,
                branch: None,
                freshness: "cached".into(),
            });
        }
    }
    Ok(Json(serde_json::json!({"sessions": sessions})))
}

pub async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<ConversationQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = auth::require_user(&state, &headers).await?;
    auth::require_device_scope(&state, &headers, &query.device_id).await?;
    state
        .storage
        .device_for_user(&user.id, &query.device_id)
        .await?
        .ok_or_else(|| AppError::not_found("device_not_found", "device not found"))?;
    Ok(Json(
        serde_json::json!({"events":state.storage.conversation_events(&user.id, &query.device_id, &session_id).await?}),
    ))
}

impl Storage {
    pub async fn established_conversation_session_ids(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<Vec<String>, AppError> {
        let rows = sqlx::query(
            "SELECT e.session_id, MAX(e.id) last_id
             FROM conversation_events e
             JOIN operations o ON o.id = e.operation_id
             JOIN devices d ON d.id = e.device_id AND d.user_id = o.user_id
             WHERE e.device_id = ? AND o.user_id = ?
               AND EXISTS (
                    SELECT 1
                    FROM conversation_events established
                    WHERE established.device_id = e.device_id
                      AND established.session_id = e.session_id
                      AND json_extract(established.event_json, '$.kind') = 'session_started'
               )
             GROUP BY e.session_id
             ORDER BY last_id DESC
             LIMIT 100",
        )
        .bind(device_id)
        .bind(user_id)
        .fetch_all(self.pool())
        .await?;
        Ok(rows.into_iter().map(|row| row.get("session_id")).collect())
    }

    pub async fn conversation_events(
        &self,
        user_id: &str,
        device_id: &str,
        session_id: &str,
    ) -> Result<Vec<ConversationEvent>, AppError> {
        let rows = sqlx::query("SELECT e.event_json FROM conversation_events e JOIN operations o ON o.id = e.operation_id JOIN devices d ON d.id = e.device_id AND d.user_id = o.user_id WHERE e.device_id = ? AND e.session_id = ? AND o.user_id = ? ORDER BY o.created_at, o.id, e.sequence")
            .bind(device_id).bind(session_id).bind(user_id).fetch_all(self.pool()).await?;
        rows.into_iter()
            .map(|row| Ok(serde_json::from_str(row.get("event_json"))?))
            .collect()
    }

    pub async fn ingest_conversation_event(
        &self,
        device_id: &str,
        event: &ConversationEvent,
    ) -> Result<Option<(String, BrowserSocketFrame)>, AppError> {
        let invalid = || {
            AppError::bad_request(
                "invalid_conversation_event",
                "conversation event was rejected",
            )
        };
        if event.sequence == 0
            || event.sequence > i64::MAX as u64
            || event.session_id.is_empty()
            || event.session_id.len() > 256
            || event.project_id.is_empty()
            || event.project_id.len() > 128
            || event.message_id.as_ref().is_some_and(|s| s.len() > 256)
            || event.text.as_ref().is_some_and(|s| s.len() > 128 * 1024)
            || ![
                "session_started",
                "turn_started",
                "user_message",
                "assistant_delta",
                "assistant_done",
                "tool_status",
                "approval_required",
                "turn_completed",
                "turn_failed",
            ]
            .contains(&event.kind.as_str())
        {
            return Err(invalid());
        }
        let (user_id, operation) = self
            .operation_for_device(device_id, &event.operation_id)
            .await?
            .ok_or_else(invalid)?;
        if self.device_user_id(device_id).await?.as_deref() != Some(user_id.as_str()) {
            return Err(invalid());
        }
        if !matches!(
            operation.kind.as_str(),
            "conversation.start" | "conversation.prompt" | "conversation.history"
        ) || operation.payload.get("source").and_then(|v| v.as_str())
            != Some(event.source.as_str())
            || operation.payload.get("projectId").and_then(|v| v.as_str())
                != Some(event.project_id.as_str())
            || operation.payload.get("worktreeId").and_then(|v| v.as_str())
                != event.worktree_id.as_deref()
            || operation
                .payload
                .get("sessionId")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s != event.session_id)
        {
            return Err(invalid());
        }
        let encoded = serde_json::to_string(event)?;
        // Reserve SQLite's single writer before the validation reads. A deferred transaction can
        // otherwise be invalidated by a concurrent operation-status write and fail immediately
        // with SQLITE_BUSY_SNAPSHOT when it is upgraded to a writer.
        let mut tx = self.pool().begin_with("BEGIN IMMEDIATE").await?;
        let previous: Option<String> = sqlx::query_scalar("SELECT event_json FROM conversation_events WHERE device_id = ? AND operation_id = ? AND sequence = ?")
            .bind(device_id).bind(&event.operation_id).bind(event.sequence as i64).fetch_optional(&mut *tx).await?;
        if let Some(previous) = previous {
            if previous != encoded {
                return Err(invalid());
            }
            return Ok(None);
        }
        // All events for a turn must stay in its first established session/context.
        let prior: Option<String> = sqlx::query_scalar("SELECT session_id FROM conversation_events WHERE device_id = ? AND operation_id = ? LIMIT 1")
            .bind(device_id).bind(&event.operation_id).fetch_optional(&mut *tx).await?;
        if prior.is_some_and(|s| s != event.session_id) {
            return Err(invalid());
        }
        let existing: Option<String> = sqlx::query_scalar("SELECT event_json FROM conversation_events WHERE device_id = ? AND session_id = ? LIMIT 1")
            .bind(device_id).bind(&event.session_id).fetch_optional(&mut *tx).await?;
        if let Some(existing) = existing {
            let existing: ConversationEvent = serde_json::from_str(&existing)?;
            if existing.source != event.source
                || existing.project_id != event.project_id
                || existing.worktree_id != event.worktree_id
            {
                return Err(invalid());
            }
        }
        sqlx::query("INSERT INTO conversation_events (device_id, operation_id, session_id, sequence, event_json) VALUES (?, ?, ?, ?, ?)")
            .bind(device_id).bind(&event.operation_id).bind(&event.session_id).bind(event.sequence as i64).bind(encoded).execute(&mut *tx).await?;
        let payload = BrowserEventPayload::ConversationUpdated {
            device_id: device_id.into(),
            event: event.clone(),
        };
        let occurred_at = now_ms();
        let inserted = sqlx::query(
            "INSERT INTO browser_events (user_id, occurred_at, payload_json) VALUES (?, ?, ?)",
        )
        .bind(&user_id)
        .bind(occurred_at)
        .bind(serde_json::to_string(&payload)?)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some((
            user_id,
            BrowserSocketFrame::Event {
                sequence: inserted.last_insert_rowid(),
                occurred_at,
                payload,
            },
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cli_manager_web_protocol::OperationStatus;

    #[tokio::test]
    async fn events_are_persistent_deduplicated_and_bound_to_operation_context() {
        let storage = Storage::open_memory().await.unwrap();
        storage.ensure_single_user("admin", "unused").await.unwrap();
        let user = storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap();
        storage
            .upsert_device_hello("device", "PC", "windows", "1", &[], None, None, None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET user_id = ? WHERE id = 'device'")
            .bind(&user.id)
            .execute(storage.pool())
            .await
            .unwrap();
        let operation = storage
            .create_operation(
                &user.id,
                "device",
                "conversation.start",
                "key",
                &serde_json::json!({"source":"codex","projectId":"project"}),
                OperationStatus::Running,
            )
            .await
            .unwrap();
        let mut event = ConversationEvent {
            operation_id: operation.id,
            session_id: "session".into(),
            source: "codex".into(),
            project_id: "project".into(),
            worktree_id: None,
            sequence: 1,
            kind: "assistant_delta".into(),
            message_id: Some("message".into()),
            text: Some("Hello".into()),
            occurred_at: now_ms(),
        };
        assert!(storage
            .ingest_conversation_event("device", &event)
            .await
            .unwrap()
            .is_some());
        assert!(storage
            .ingest_conversation_event("device", &event)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            storage
                .browser_events_after(&user.id, 0)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            storage
                .conversation_events(&user.id, "device", "session")
                .await
                .unwrap()[0]
                .text
                .as_deref(),
            Some("Hello")
        );
        assert!(storage
            .conversation_events(&user.id, "other-device", "session")
            .await
            .unwrap()
            .is_empty());
        assert!(storage
            .ingest_conversation_event("other-device", &event)
            .await
            .is_err());
        event.text = Some("Altered duplicate".into());
        assert!(storage
            .ingest_conversation_event("device", &event)
            .await
            .is_err());
        event.sequence = 2;
        event.project_id = "other-project".into();
        assert!(storage
            .ingest_conversation_event("device", &event)
            .await
            .is_err());
        event.project_id = "project".into();
        event.session_id = "other-session".into();
        assert!(storage
            .ingest_conversation_event("device", &event)
            .await
            .is_err());
        sqlx::query("UPDATE devices SET user_id = NULL WHERE id = 'device'")
            .execute(storage.pool())
            .await
            .unwrap();
        assert!(storage
            .conversation_events(&user.id, "device", "session")
            .await
            .unwrap()
            .is_empty());
        event.session_id = "session".into();
        assert!(storage
            .ingest_conversation_event("device", &event)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn event_write_waits_for_a_concurrent_sqlite_writer() {
        let database_path = std::env::temp_dir().join(format!(
            "cli-manager-web-conversation-{}.db",
            uuid::Uuid::new_v4()
        ));
        let storage = Storage::open(&database_path).await.unwrap();
        storage.ensure_single_user("admin", "unused").await.unwrap();
        let user = storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap();
        storage
            .upsert_device_hello("device", "PC", "windows", "1", &[], None, None, None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET user_id = ? WHERE id = 'device'")
            .bind(&user.id)
            .execute(storage.pool())
            .await
            .unwrap();
        let operation = storage
            .create_operation(
                &user.id,
                "device",
                "conversation.prompt",
                "concurrent-key",
                &serde_json::json!({"source":"codex","projectId":"project","sessionId":"session"}),
                OperationStatus::Running,
            )
            .await
            .unwrap();
        let event = ConversationEvent {
            operation_id: operation.id,
            session_id: "session".into(),
            source: "codex".into(),
            project_id: "project".into(),
            worktree_id: None,
            sequence: 1,
            kind: "assistant_done".into(),
            message_id: Some("message".into()),
            text: Some("done".into()),
            occurred_at: now_ms(),
        };

        let mut blocker = storage.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("UPDATE devices SET last_seen_at = ? WHERE id = 'device'")
            .bind(now_ms())
            .execute(&mut *blocker)
            .await
            .unwrap();
        let writer_storage = storage.clone();
        let writer = tokio::spawn(async move {
            writer_storage
                .ingest_conversation_event("device", &event)
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        blocker.commit().await.unwrap();
        assert!(writer.await.unwrap().unwrap().is_some());

        storage.pool().close().await;
        for path in [
            database_path.clone(),
            database_path.with_extension("db-wal"),
            database_path.with_extension("db-shm"),
        ] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[tokio::test]
    async fn failed_start_is_not_listed_until_a_session_is_established() {
        let storage = Storage::open_memory().await.unwrap();
        storage.ensure_single_user("admin", "unused").await.unwrap();
        let user = storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap();
        storage
            .upsert_device_hello("device", "PC", "windows", "1", &[], None, None, None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET user_id = ? WHERE id = 'device'")
            .bind(&user.id)
            .execute(storage.pool())
            .await
            .unwrap();
        let operation = storage
            .create_operation(
                &user.id,
                "device",
                "conversation.start",
                "failed-start",
                &serde_json::json!({"source":"codex","projectId":"project"}),
                OperationStatus::Running,
            )
            .await
            .unwrap();
        let mut event = ConversationEvent {
            operation_id: operation.id,
            session_id: "temporary-operation-id".into(),
            source: "codex".into(),
            project_id: "project".into(),
            worktree_id: None,
            sequence: 1,
            kind: "turn_failed".into(),
            message_id: None,
            text: Some("cli_exited:initialize".into()),
            occurred_at: now_ms(),
        };
        storage
            .ingest_conversation_event("device", &event)
            .await
            .unwrap();
        assert!(storage
            .established_conversation_session_ids(&user.id, "device")
            .await
            .unwrap()
            .is_empty());

        event.sequence = 2;
        event.kind = "session_started".into();
        event.text = None;
        storage
            .ingest_conversation_event("device", &event)
            .await
            .unwrap();
        assert_eq!(
            storage
                .established_conversation_session_ids(&user.id, "device")
                .await
                .unwrap(),
            vec!["temporary-operation-id"]
        );
    }
}
