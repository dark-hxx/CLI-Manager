use super::Storage;
use std::sync::atomic::Ordering;

impl Storage {
    /// last_seen_at is display metadata, never an authentication/expiry check.
    /// At most one optional writer may wait; successful reads do not await it.
    pub(super) fn schedule_session_activity(&self, token_hash: String, now: i64) {
        if self
            .activity_update_pending
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let storage = self.clone();
        tokio::spawn(async move {
            let result = sqlx::query(
                "UPDATE browser_sessions SET last_seen_at = ?1 WHERE token_hash = ?2
                 AND device_scope IS NOT NULL AND expires_at > ?1
                 AND (last_seen_at IS NULL OR last_seen_at < ?3)",
            )
            .bind(now)
            .bind(token_hash)
            .bind(now - 60_000)
            .execute(&storage.pool)
            .await;
            storage
                .activity_update_pending
                .store(false, Ordering::Release);
            if let Err(error) = result {
                tracing::warn!(%error, "optional mobile session activity update failed");
            }
        });
    }
}
