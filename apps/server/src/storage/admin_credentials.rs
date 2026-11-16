use super::{AuthUser, Storage};
use crate::{auth, error::AppError};
use sqlx::Row;

impl Storage {
    /// Standalone servers retain bootstrap-only credentials; the managed listener
    /// reconciles its native credential without replacing the user or devices.
    pub async fn configure_admin(
        &self,
        username: &str,
        password: &str,
        sync_existing: bool,
    ) -> Result<(), AppError> {
        if username.trim().is_empty()
            || username.len() > 128
            || password.is_empty()
            || password.len() > 1024
        {
            return Err(AppError::bad_request(
                "invalid_credentials",
                "invalid admin credential length",
            ));
        }
        let rows = sqlx::query(
            "SELECT id, username, password_hash FROM users ORDER BY created_at LIMIT 2",
        )
        .fetch_all(&self.pool)
        .await?;
        if !sync_existing && !rows.is_empty() {
            return Ok(());
        }
        if rows.len() > 1 {
            return Err(AppError::Internal(
                "managed Web server requires a single admin account".into(),
            ));
        }
        let previous = rows.first().map(|row| AuthUser {
            id: row.get("id"),
            username: row.get("username"),
            password_hash: row.get("password_hash"),
        });
        let old_hash = previous.as_ref().map(|user| user.password_hash.clone());
        let password = password.to_string();
        // Verify before hashing: a restart with unchanged credentials must not
        // generate a new salted hash or revoke perfectly valid sessions.
        let changed_hash = tokio::task::spawn_blocking(move || {
            if old_hash
                .as_deref()
                .is_some_and(|hash| auth::verify_password(&password, hash))
            {
                Ok(None)
            } else {
                auth::hash_password(&password).map(Some)
            }
        })
        .await
        .map_err(|_| AppError::Internal("admin credential worker failed".into()))??;
        let Some(previous) = previous else {
            return self
                .ensure_single_user(
                    username,
                    &changed_hash.expect("new account requires a hash"),
                )
                .await;
        };
        if changed_hash.is_none() && previous.username == username {
            return Ok(());
        }
        let hash = changed_hash.as_deref().unwrap_or(&previous.password_hash);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed = sqlx::query(
            "UPDATE users SET username = ?1, password_hash = ?2
             WHERE id = ?3 AND username = ?4 AND password_hash = ?5",
        )
        .bind(username)
        .bind(hash)
        .bind(&previous.id)
        .bind(&previous.username)
        .bind(&previous.password_hash)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed != 1 {
            return Err(AppError::conflict(
                "admin_changed",
                "admin changed during configuration",
            ));
        }
        sqlx::query("DELETE FROM browser_sessions WHERE user_id = ?1")
            .bind(&previous.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM mobile_tickets WHERE user_id = ?1")
            .bind(&previous.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}
