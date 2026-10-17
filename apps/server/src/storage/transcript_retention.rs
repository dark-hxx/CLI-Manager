//! 對話轉錄 operation 的保留期。
//!
//! 轉錄結果只是當下畫面的快照，瀏覽器拿到後就沒有用了；對話頁開著時每一兩秒就會有一筆。
//! 已結束超過保留期的轉錄 operation 連同它的 `operation.updated` 事件一起刪除，
//! 避免資料庫隨輪詢持續變大，也不讓工具輸出這類內容長期留在伺服器上。

use super::Storage;
use crate::error::AppError;
use std::sync::atomic::Ordering;

/// 會被輪詢的轉錄 operation 種類（舊版純文字與新版事件）。
const TRANSCRIPT_OPERATION_KINDS: [&str; 2] = ["terminal.transcript", "terminal.transcript_events"];
/// 結束後保留兩分鐘：瀏覽器最多等 60 秒，保留期內仍能用 GET 補拿結果。
const RETENTION_MS: i64 = 120_000;
/// 兩次清理至少間隔 30 秒，輪詢再頻繁也不會每次都掃資料表。
const PRUNE_INTERVAL_MS: i64 = 30_000;

/// 這個 operation 的結果是否屬於會被定期清掉的轉錄快照。
pub fn is_transcript_operation(kind: &str) -> bool {
    TRANSCRIPT_OPERATION_KINDS.contains(&kind)
}

impl Storage {
    /// 刪除已結束超過保留期的轉錄 operation 與對應事件，回傳刪掉的 operation 數；
    /// 距離上次清理不到間隔時直接略過。只清已結束的，仍在等待或執行中的不動。
    pub async fn prune_transcript_operations(&self, now: i64) -> Result<u64, AppError> {
        let last = self.transcript_pruned_at.load(Ordering::Relaxed);
        if now - last < PRUNE_INTERVAL_MS
            || self
                .transcript_pruned_at
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
        {
            return Ok(0);
        }
        let cutoff = now - RETENTION_MS;
        let mut tx = self.pool.begin().await?;
        let removed = sqlx::query(
            "DELETE FROM operations
             WHERE kind IN ('terminal.transcript', 'terminal.transcript_events')
               AND status IN ('succeeded', 'failed', 'rejected', 'timed_out', 'canceled')
               AND updated_at < ?1",
        )
        .bind(cutoff)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        sqlx::query(
            "DELETE FROM browser_events
             WHERE occurred_at < ?1
               AND json_extract(payload_json, '$.type') = 'operation.updated'
               AND json_extract(payload_json, '$.operation.kind')
                   IN ('terminal.transcript', 'terminal.transcript_events')",
        )
        .bind(cutoff)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::now_ms;
    use cli_manager_web_protocol::{BrowserEventPayload, OperationStatus, OperationView};
    use serde_json::json;

    async fn storage_with_device() -> (Storage, String) {
        let storage = Storage::open_memory().await.unwrap();
        storage.ensure_single_user("admin", "hash").await.unwrap();
        let user = storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap();
        storage
            .upsert_device_hello(
                "device-1",
                "PC",
                "windows",
                "1.0",
                &[],
                Some("machine-1"),
                Some("development"),
                None,
                None,
            )
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET user_id = ?1 WHERE id = 'device-1'")
            .bind(&user.id)
            .execute(storage.pool())
            .await
            .unwrap();
        (storage, user.id)
    }

    /// 建立一個 operation，並把狀態與更新時間直接改成指定值。
    async fn operation(
        storage: &Storage,
        user_id: &str,
        kind: &str,
        key: &str,
        status: &str,
        updated_at: i64,
    ) -> OperationView {
        let created = storage
            .create_operation(
                user_id,
                "device-1",
                kind,
                key,
                &json!({"projectId": "p1", "sessionId": "pty-1"}),
                OperationStatus::Submitted,
            )
            .await
            .unwrap();
        sqlx::query("UPDATE operations SET status = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(status)
            .bind(updated_at)
            .bind(&created.id)
            .execute(storage.pool())
            .await
            .unwrap();
        created
    }

    async fn event(storage: &Storage, user_id: &str, operation: OperationView, occurred_at: i64) {
        let frame = storage
            .append_browser_event(user_id, BrowserEventPayload::OperationUpdated { operation })
            .await
            .unwrap();
        let cli_manager_web_protocol::BrowserSocketFrame::Event { sequence, .. } = frame else {
            panic!("append_browser_event must return an event frame");
        };
        sqlx::query("UPDATE browser_events SET occurred_at = ?1 WHERE sequence = ?2")
            .bind(occurred_at)
            .bind(sequence)
            .execute(storage.pool())
            .await
            .unwrap();
    }

    async fn remaining(storage: &Storage, sql: &str) -> Vec<String> {
        sqlx::query_scalar(sql)
            .fetch_all(storage.pool())
            .await
            .unwrap()
    }

    #[test]
    fn only_transcript_kinds_are_pruned() {
        assert!(is_transcript_operation("terminal.transcript"));
        assert!(is_transcript_operation("terminal.transcript_events"));
        assert!(!is_transcript_operation("terminal.attach_image"));
        assert!(!is_transcript_operation("git.status"));
    }

    #[tokio::test]
    async fn finished_transcripts_past_retention_are_removed_with_their_events() {
        let (storage, user_id) = storage_with_device().await;
        let now = now_ms();
        let old = now - RETENTION_MS - 1_000;
        let stale = operation(
            &storage,
            &user_id,
            "terminal.transcript_events",
            "a",
            "succeeded",
            old,
        )
        .await;
        let legacy = operation(
            &storage,
            &user_id,
            "terminal.transcript",
            "b",
            "failed",
            old,
        )
        .await;
        let fresh = operation(
            &storage,
            &user_id,
            "terminal.transcript_events",
            "c",
            "succeeded",
            now - 1_000,
        )
        .await;
        let pending = operation(
            &storage,
            &user_id,
            "terminal.transcript_events",
            "d",
            "running",
            old,
        )
        .await;
        let other = operation(&storage, &user_id, "git.status", "e", "succeeded", old).await;
        event(&storage, &user_id, stale.clone(), old).await;
        event(&storage, &user_id, fresh.clone(), now - 1_000).await;
        event(&storage, &user_id, other.clone(), old).await;

        assert_eq!(storage.prune_transcript_operations(now).await.unwrap(), 2);

        let mut kept = remaining(&storage, "SELECT id FROM operations").await;
        kept.sort();
        let mut expected = vec![fresh.id.clone(), pending.id.clone(), other.id.clone()];
        expected.sort();
        assert_eq!(kept, expected);
        assert!(!kept.contains(&legacy.id));
        let events = remaining(
            &storage,
            "SELECT json_extract(payload_json, '$.operation.id') FROM browser_events
             WHERE json_extract(payload_json, '$.type') = 'operation.updated'",
        )
        .await;
        assert!(!events.contains(&stale.id));
        assert!(events.contains(&fresh.id));
        assert!(events.contains(&other.id));
    }

    #[tokio::test]
    async fn pruning_is_throttled_between_runs() {
        let (storage, user_id) = storage_with_device().await;
        let now = now_ms();
        assert_eq!(storage.prune_transcript_operations(now).await.unwrap(), 0);
        let old = now - RETENTION_MS - 1_000;
        operation(
            &storage,
            &user_id,
            "terminal.transcript_events",
            "a",
            "succeeded",
            old,
        )
        .await;

        assert_eq!(
            storage
                .prune_transcript_operations(now + 1_000)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            storage
                .prune_transcript_operations(now + PRUNE_INTERVAL_MS)
                .await
                .unwrap(),
            1
        );
    }
}
