use crate::error::AppError;
use cli_manager_web_protocol::{
    BrowserEventPayload, BrowserSocketFrame, DeviceHostInfo, DeviceStatus, DeviceView,
    HistorySessionSummary, OperationError, OperationStatus, OperationView, UserView,
};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub password_hash: String,
}

#[derive(Debug, Clone)]
pub struct PairingClaim {
    pub pairing_id: String,
    pub expires_at: i64,
    pub device: DeviceView,
}

pub struct DeviceWallpaper {
    pub bytes: Vec<u8>,
    pub revision: String,
}

#[derive(Clone)]
pub struct Storage {
    pool: SqlitePool,
}

impl Storage {
    pub async fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| AppError::Internal(format!("create data dir failed: {err}")))?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    #[cfg(test)]
    pub async fn open_memory() -> Result<Self, AppError> {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Memory)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn ensure_single_user(
        &self,
        username: &str,
        password_hash: &str,
    ) -> Result<(), AppError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&self.pool)
            .await?;
        if count == 0 {
            sqlx::query(
                "INSERT INTO users (id, username, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(username)
            .bind(password_hash)
            .bind(now_ms())
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    pub async fn find_user_by_username(
        &self,
        username: &str,
    ) -> Result<Option<AuthUser>, AppError> {
        let row = sqlx::query(
            "SELECT id, username, password_hash FROM users WHERE username = ?1 LIMIT 1",
        )
        .bind(username)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| AuthUser {
            id: row.get("id"),
            username: row.get("username"),
            password_hash: row.get("password_hash"),
        }))
    }

    pub async fn create_browser_session(
        &self,
        token_hash: &str,
        user_id: &str,
        expires_at: i64,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO browser_sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(token_hash)
        .bind(user_id)
        .bind(now_ms())
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn user_for_session(&self, token_hash: &str) -> Result<Option<UserView>, AppError> {
        let now = now_ms();
        let row = sqlx::query(
            "SELECT users.id, users.username
             FROM browser_sessions
             JOIN users ON users.id = browser_sessions.user_id
             WHERE browser_sessions.token_hash = ?1 AND browser_sessions.expires_at > ?2",
        )
        .bind(token_hash)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| UserView {
            id: row.get("id"),
            username: row.get("username"),
        }))
    }

    pub async fn delete_browser_session(&self, token_hash: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM browser_sessions WHERE token_hash = ?1")
            .bind(token_hash)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn upsert_device_hello(
        &self,
        device_id: &str,
        name: &str,
        platform: &str,
        app_version: &str,
        capabilities: &[String],
        host_info: Option<&DeviceHostInfo>,
        wallpaper: Option<(&[u8], &str)>,
    ) -> Result<DeviceView, AppError> {
        let now = now_ms();
        let capabilities_json = serde_json::to_string(capabilities)?;
        let host_info_json = host_info.map(serde_json::to_string).transpose()?;
        let (wallpaper_jpeg, wallpaper_revision) = wallpaper
            .map(|(bytes, revision)| (Some(bytes), Some(revision)))
            .unwrap_or((None, None));
        sqlx::query(
            "INSERT INTO devices
                (id, name, platform, app_version, status, capabilities_json, last_seen_at,
                 host_info_json, wallpaper_jpeg, wallpaper_revision)
             VALUES (?1, ?2, ?3, ?4, 'online', ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                platform = excluded.platform,
                app_version = excluded.app_version,
                status = 'online',
                capabilities_json = excluded.capabilities_json,
                last_seen_at = excluded.last_seen_at,
                host_info_json = COALESCE(excluded.host_info_json, devices.host_info_json),
                wallpaper_jpeg = COALESCE(excluded.wallpaper_jpeg, devices.wallpaper_jpeg),
                wallpaper_revision = COALESCE(excluded.wallpaper_revision, devices.wallpaper_revision)",
        )
        .bind(device_id)
        .bind(name)
        .bind(platform)
        .bind(app_version)
        .bind(capabilities_json)
        .bind(now)
        .bind(host_info_json)
        .bind(wallpaper_jpeg)
        .bind(wallpaper_revision)
        .execute(&self.pool)
        .await?;
        self.device_by_id(device_id)
            .await?
            .ok_or_else(|| AppError::Internal("device upsert returned no row".to_string()))
    }

    pub async fn verify_device_token(
        &self,
        device_id: &str,
        token_hash: &str,
    ) -> Result<bool, AppError> {
        let matched: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM devices
             WHERE id = ?1 AND user_id IS NOT NULL AND device_token_hash = ?2",
        )
        .bind(device_id)
        .bind(token_hash)
        .fetch_one(&self.pool)
        .await?;
        Ok(matched == 1)
    }

    pub async fn device_user_id(&self, device_id: &str) -> Result<Option<String>, AppError> {
        Ok(
            sqlx::query_scalar("SELECT user_id FROM devices WHERE id = ?1")
                .bind(device_id)
                .fetch_optional(&self.pool)
                .await?
                .flatten(),
        )
    }

    pub async fn mark_device_status(
        &self,
        device_id: &str,
        status: DeviceStatus,
    ) -> Result<Option<DeviceView>, AppError> {
        sqlx::query("UPDATE devices SET status = ?1, last_seen_at = ?2 WHERE id = ?3")
            .bind(status.as_str())
            .bind(now_ms())
            .bind(device_id)
            .execute(&self.pool)
            .await?;
        self.device_by_id(device_id).await
    }

    pub async fn mark_all_devices_offline(&self) -> Result<(), AppError> {
        sqlx::query("UPDATE devices SET status = 'offline'")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_devices(&self, user_id: &str) -> Result<Vec<DeviceView>, AppError> {
        let rows = sqlx::query(
            "SELECT id, name, platform, app_version, status, capabilities_json, paired_at,
                    last_seen_at, host_info_json, wallpaper_revision
             FROM devices WHERE user_id = ?1 ORDER BY last_seen_at DESC, id",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(device_from_row).collect()
    }

    pub async fn device_for_user(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<Option<DeviceView>, AppError> {
        let row = sqlx::query(
            "SELECT id, name, platform, app_version, status, capabilities_json, paired_at,
                    last_seen_at, host_info_json, wallpaper_revision
             FROM devices WHERE user_id = ?1 AND id = ?2",
        )
        .bind(user_id)
        .bind(device_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(device_from_row).transpose()
    }

    async fn device_by_id(&self, device_id: &str) -> Result<Option<DeviceView>, AppError> {
        let row = sqlx::query(
            "SELECT id, name, platform, app_version, status, capabilities_json, paired_at,
                    last_seen_at, host_info_json, wallpaper_revision
             FROM devices WHERE id = ?1",
        )
        .bind(device_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(device_from_row).transpose()
    }

    pub async fn device_wallpaper_for_user(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<Option<DeviceWallpaper>, AppError> {
        let row = sqlx::query(
            "SELECT wallpaper_jpeg, wallpaper_revision FROM devices
             WHERE user_id = ?1 AND id = ?2 AND wallpaper_jpeg IS NOT NULL",
        )
        .bind(user_id)
        .bind(device_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| DeviceWallpaper {
            bytes: row.get("wallpaper_jpeg"),
            revision: row.get("wallpaper_revision"),
        }))
    }

    pub async fn store_pairing_offer(
        &self,
        device_id: &str,
        code_hash: &str,
        expires_at: i64,
    ) -> Result<String, AppError> {
        let pairing_id = Uuid::new_v4().to_string();
        sqlx::query("DELETE FROM pairing_codes WHERE device_id = ?1 AND claimed_at IS NULL")
            .bind(device_id)
            .execute(&self.pool)
            .await?;
        sqlx::query(
            "INSERT INTO pairing_codes (id, code_hash, device_id, expires_at)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(&pairing_id)
        .bind(code_hash)
        .bind(device_id)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        Ok(pairing_id)
    }

    pub async fn claim_pairing(
        &self,
        code_hash: &str,
        user_id: &str,
        device_token_hash: &str,
    ) -> Result<PairingClaim, AppError> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT id, device_id, expires_at, claimed_at
             FROM pairing_codes WHERE code_hash = ?1 LIMIT 1",
        )
        .bind(code_hash)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::bad_request("invalid_pairing_code", "invalid pairing code"))?;
        let pairing_id: String = row.get("id");
        let device_id: String = row.get("device_id");
        let expires_at: i64 = row.get("expires_at");
        let claimed_at: Option<i64> = row.get("claimed_at");
        if claimed_at.is_some() {
            return Err(AppError::conflict(
                "pairing_code_used",
                "pairing code has already been used",
            ));
        }
        if expires_at <= now_ms() {
            return Err(AppError::bad_request(
                "pairing_code_expired",
                "pairing code has expired",
            ));
        }
        let now = now_ms();
        sqlx::query(
            "UPDATE devices SET user_id = ?1, device_token_hash = ?2, paired_at = ?3 WHERE id = ?4",
        )
        .bind(user_id)
        .bind(device_token_hash)
        .bind(now)
        .bind(&device_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE pairing_codes SET claimed_at = ?1, claimed_by_user_id = ?2 WHERE id = ?3",
        )
        .bind(now)
        .bind(user_id)
        .bind(&pairing_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        let device = self
            .device_for_user(user_id, &device_id)
            .await?
            .ok_or_else(|| AppError::Internal("paired device missing".to_string()))?;
        Ok(PairingClaim {
            pairing_id,
            expires_at,
            device,
        })
    }

    pub async fn rollback_pairing_claim(
        &self,
        pairing_id: &str,
        user_id: &str,
    ) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await?;
        let device_id: Option<String> = sqlx::query_scalar(
            "SELECT device_id FROM pairing_codes
             WHERE id = ?1 AND claimed_by_user_id = ?2",
        )
        .bind(pairing_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(device_id) = device_id {
            sqlx::query(
                "UPDATE devices SET user_id = NULL, device_token_hash = NULL, paired_at = NULL
                 WHERE id = ?1 AND user_id = ?2",
            )
            .bind(&device_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE pairing_codes
                 SET claimed_at = NULL, claimed_by_user_id = NULL
                 WHERE id = ?1 AND claimed_by_user_id = ?2",
            )
            .bind(pairing_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn accept_device_sequence(
        &self,
        device_id: &str,
        stream: &str,
        sequence: u64,
    ) -> Result<bool, AppError> {
        let sequence = i64::try_from(sequence).map_err(|_| {
            AppError::bad_request("invalid_sequence", "sequence exceeds supported range")
        })?;
        let result = sqlx::query(
            "INSERT INTO device_event_cursors (device_id, stream, last_sequence)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(device_id, stream) DO UPDATE SET last_sequence = excluded.last_sequence
             WHERE excluded.last_sequence > device_event_cursors.last_sequence",
        )
        .bind(device_id)
        .bind(stream)
        .bind(sequence)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn replace_history_snapshot(
        &self,
        device_id: &str,
        user_id: &str,
        sequence: u64,
        sessions: &[HistorySessionSummary],
    ) -> Result<bool, AppError> {
        let sequence = i64::try_from(sequence).map_err(|_| {
            AppError::bad_request("invalid_sequence", "sequence exceeds supported range")
        })?;
        let mut tx = self.pool.begin().await?;
        let last: Option<i64> = sqlx::query_scalar(
            "SELECT last_sequence FROM device_event_cursors WHERE device_id = ?1 AND stream = 'history'",
        )
        .bind(device_id)
        .fetch_optional(&mut *tx)
        .await?;
        if last.is_some_and(|last| sequence <= last) {
            return Ok(false);
        }
        sqlx::query("DELETE FROM history_sessions WHERE device_id = ?1")
            .bind(device_id)
            .execute(&mut *tx)
            .await?;
        for session in sessions {
            if session.device_id != device_id {
                return Err(AppError::bad_request(
                    "invalid_history_snapshot",
                    "history session deviceId does not match connection",
                ));
            }
            sqlx::query(
                "INSERT INTO history_sessions
                    (device_id, session_id, user_id, source, project_key, title, cwd,
                     created_at, updated_at, message_count, branch, freshness)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'live')
                 ON CONFLICT(device_id, session_id) DO UPDATE SET
                    user_id = excluded.user_id,
                    source = excluded.source,
                    project_key = excluded.project_key,
                    title = excluded.title,
                    cwd = excluded.cwd,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    message_count = excluded.message_count,
                    branch = excluded.branch,
                    freshness = 'live'",
            )
            .bind(device_id)
            .bind(&session.session_id)
            .bind(user_id)
            .bind(&session.source)
            .bind(&session.project_key)
            .bind(&session.title)
            .bind(&session.cwd)
            .bind(session.created_at)
            .bind(session.updated_at)
            .bind(session.message_count as i64)
            .bind(&session.branch)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            "INSERT INTO device_event_cursors (device_id, stream, last_sequence)
             VALUES (?1, 'history', ?2)
             ON CONFLICT(device_id, stream) DO UPDATE SET last_sequence = excluded.last_sequence",
        )
        .bind(device_id)
        .bind(sequence)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn list_history(
        &self,
        user_id: &str,
        device_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<HistorySessionSummary>, AppError> {
        let rows = if let Some(device_id) = device_id {
            sqlx::query(
                "SELECT device_id, session_id, source, project_key, title, cwd, created_at,
                        updated_at, message_count, branch, freshness
                 FROM history_sessions WHERE user_id = ?1 AND device_id = ?2
                 ORDER BY updated_at DESC, session_id LIMIT ?3 OFFSET ?4",
            )
            .bind(user_id)
            .bind(device_id)
            .bind(limit as i64)
            .bind(offset as i64)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT device_id, session_id, source, project_key, title, cwd, created_at,
                        updated_at, message_count, branch, freshness
                 FROM history_sessions WHERE user_id = ?1
                 ORDER BY updated_at DESC, session_id LIMIT ?2 OFFSET ?3",
            )
            .bind(user_id)
            .bind(limit as i64)
            .bind(offset as i64)
            .fetch_all(&self.pool)
            .await?
        };
        Ok(rows
            .into_iter()
            .map(|row| HistorySessionSummary {
                session_id: row.get("session_id"),
                device_id: row.get("device_id"),
                source: row.get("source"),
                project_key: row.get("project_key"),
                title: row.get("title"),
                cwd: row.get("cwd"),
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
                message_count: row.get::<i64, _>("message_count") as u64,
                branch: row.get("branch"),
                freshness: row.get("freshness"),
            })
            .collect())
    }

    pub async fn create_operation(
        &self,
        user_id: &str,
        device_id: &str,
        kind: &str,
        idempotency_key: &str,
        payload: &Value,
        status: OperationStatus,
    ) -> Result<OperationView, AppError> {
        if let Some(existing) = self
            .operation_by_idempotency(user_id, idempotency_key)
            .await?
        {
            return Ok(existing);
        }
        let operation_id = Uuid::new_v4().to_string();
        let now = now_ms();
        let result = sqlx::query(
            "INSERT INTO operations
                (id, user_id, device_id, kind, status, idempotency_key, payload_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        )
        .bind(&operation_id)
        .bind(user_id)
        .bind(device_id)
        .bind(kind)
        .bind(status.as_str())
        .bind(idempotency_key)
        .bind(serde_json::to_string(payload)?)
        .bind(now)
        .execute(&self.pool)
        .await;
        if let Err(sqlx::Error::Database(error)) = &result {
            if error.is_unique_violation() {
                return self
                    .operation_by_idempotency(user_id, idempotency_key)
                    .await?
                    .ok_or_else(|| AppError::Internal("idempotent operation missing".to_string()));
            }
        }
        result?;
        self.operation_for_user(user_id, &operation_id)
            .await?
            .ok_or_else(|| AppError::Internal("created operation missing".to_string()))
    }

    pub async fn operation_for_user(
        &self,
        user_id: &str,
        operation_id: &str,
    ) -> Result<Option<OperationView>, AppError> {
        let row = sqlx::query(
            "SELECT id, device_id, kind, status, idempotency_key, payload_json, result_json,
                    error_code, error_message, created_at, updated_at
             FROM operations WHERE user_id = ?1 AND id = ?2",
        )
        .bind(user_id)
        .bind(operation_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(operation_from_row).transpose()
    }

    pub async fn operation_for_device(
        &self,
        device_id: &str,
        operation_id: &str,
    ) -> Result<Option<(String, OperationView)>, AppError> {
        let row = sqlx::query(
            "SELECT user_id, id, device_id, kind, status, idempotency_key, payload_json, result_json,
                    error_code, error_message, created_at, updated_at
             FROM operations WHERE device_id = ?1 AND id = ?2",
        )
        .bind(device_id)
        .bind(operation_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            let user_id: String = row.get("user_id");
            Ok((user_id, operation_from_row(row)?))
        })
        .transpose()
    }

    pub async fn operation_by_idempotency(
        &self,
        user_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<OperationView>, AppError> {
        let row = sqlx::query(
            "SELECT id, device_id, kind, status, idempotency_key, payload_json, result_json,
                    error_code, error_message, created_at, updated_at
             FROM operations WHERE user_id = ?1 AND idempotency_key = ?2",
        )
        .bind(user_id)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        row.map(operation_from_row).transpose()
    }

    pub async fn pending_operations_for_device(
        &self,
        device_id: &str,
    ) -> Result<Vec<OperationView>, AppError> {
        let rows = sqlx::query(
            "SELECT id, device_id, kind, status, idempotency_key, payload_json, result_json,
                    error_code, error_message, created_at, updated_at
             FROM operations
             WHERE device_id = ?1 AND status IN ('submitted', 'waiting_device', 'accepted', 'running')
             ORDER BY created_at, id",
        )
        .bind(device_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(operation_from_row).collect()
    }

    pub async fn update_operation_status(
        &self,
        device_id: &str,
        operation_id: &str,
        next: OperationStatus,
        result: Option<&Value>,
        error: Option<&OperationError>,
    ) -> Result<Option<(String, OperationView)>, AppError> {
        let Some((user_id, current)) = self.operation_for_device(device_id, operation_id).await?
        else {
            return Ok(None);
        };
        if current.status == next {
            return Ok(Some((user_id, current)));
        }
        if current.status.is_terminal() || !valid_operation_transition(&current.status, &next) {
            return Err(AppError::conflict(
                "invalid_operation_transition",
                format!(
                    "cannot transition operation from {} to {}",
                    current.status.as_str(),
                    next.as_str()
                ),
            ));
        }
        sqlx::query(
            "UPDATE operations SET status = ?1, result_json = ?2, error_code = ?3,
                    error_message = ?4, updated_at = ?5 WHERE id = ?6 AND device_id = ?7",
        )
        .bind(next.as_str())
        .bind(result.map(serde_json::to_string).transpose()?)
        .bind(error.map(|value| value.code.as_str()))
        .bind(error.map(|value| value.message.as_str()))
        .bind(now_ms())
        .bind(operation_id)
        .bind(device_id)
        .execute(&self.pool)
        .await?;
        Ok(self
            .operation_for_user(&user_id, operation_id)
            .await?
            .map(|operation| (user_id, operation)))
    }

    pub async fn append_browser_event(
        &self,
        user_id: &str,
        payload: BrowserEventPayload,
    ) -> Result<BrowserSocketFrame, AppError> {
        let occurred_at = now_ms();
        let result = sqlx::query(
            "INSERT INTO browser_events (user_id, occurred_at, payload_json) VALUES (?1, ?2, ?3)",
        )
        .bind(user_id)
        .bind(occurred_at)
        .bind(serde_json::to_string(&payload)?)
        .execute(&self.pool)
        .await?;
        Ok(BrowserSocketFrame::Event {
            sequence: result.last_insert_rowid(),
            occurred_at,
            payload,
        })
    }

    pub async fn browser_events_after(
        &self,
        user_id: &str,
        after_sequence: i64,
    ) -> Result<Vec<BrowserSocketFrame>, AppError> {
        let rows = sqlx::query(
            "SELECT sequence, occurred_at, payload_json FROM browser_events
             WHERE user_id = ?1 AND sequence > ?2 ORDER BY sequence LIMIT 1000",
        )
        .bind(user_id)
        .bind(after_sequence.max(0))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(BrowserSocketFrame::Event {
                    sequence: row.get("sequence"),
                    occurred_at: row.get("occurred_at"),
                    payload: serde_json::from_str(row.get::<&str, _>("payload_json"))?,
                })
            })
            .collect()
    }

    pub async fn latest_browser_sequence(&self, user_id: &str) -> Result<i64, AppError> {
        Ok(sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence), 0) FROM browser_events WHERE user_id = ?1",
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?)
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn device_from_row(row: sqlx::sqlite::SqliteRow) -> Result<DeviceView, AppError> {
    let status: String = row.get("status");
    let host_info_json: Option<String> = row.get("host_info_json");
    Ok(DeviceView {
        id: row.get("id"),
        name: row.get("name"),
        platform: row.get("platform"),
        app_version: row.get("app_version"),
        status: if status == "online" {
            DeviceStatus::Online
        } else {
            DeviceStatus::Offline
        },
        last_seen_at: row.get("last_seen_at"),
        paired_at: row.get("paired_at"),
        capabilities: serde_json::from_str(row.get::<&str, _>("capabilities_json"))?,
        host_info: host_info_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?,
        wallpaper_revision: row.get("wallpaper_revision"),
    })
}

fn operation_from_row(row: sqlx::sqlite::SqliteRow) -> Result<OperationView, AppError> {
    let status: String = row.get("status");
    let result_json: Option<String> = row.get("result_json");
    let error_code: Option<String> = row.get("error_code");
    let error_message: Option<String> = row.get("error_message");
    Ok(OperationView {
        id: row.get("id"),
        device_id: row.get("device_id"),
        kind: row.get("kind"),
        status: parse_operation_status(&status)?,
        idempotency_key: row.get("idempotency_key"),
        payload: serde_json::from_str(row.get::<&str, _>("payload_json"))?,
        result: result_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?,
        error: match (error_code, error_message) {
            (Some(code), Some(message)) => Some(OperationError { code, message }),
            _ => None,
        },
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn parse_operation_status(value: &str) -> Result<OperationStatus, AppError> {
    match value {
        "submitted" => Ok(OperationStatus::Submitted),
        "waiting_device" => Ok(OperationStatus::WaitingDevice),
        "accepted" => Ok(OperationStatus::Accepted),
        "running" => Ok(OperationStatus::Running),
        "succeeded" => Ok(OperationStatus::Succeeded),
        "failed" => Ok(OperationStatus::Failed),
        "rejected" => Ok(OperationStatus::Rejected),
        "timed_out" => Ok(OperationStatus::TimedOut),
        "canceled" => Ok(OperationStatus::Canceled),
        other => Err(AppError::Internal(format!(
            "unknown operation status in database: {other}"
        ))),
    }
}

fn valid_operation_transition(current: &OperationStatus, next: &OperationStatus) -> bool {
    matches!(
        (current, next),
        (OperationStatus::Submitted, OperationStatus::WaitingDevice)
            | (OperationStatus::Submitted, OperationStatus::Accepted)
            | (OperationStatus::Submitted, OperationStatus::Rejected)
            | (OperationStatus::WaitingDevice, OperationStatus::Accepted)
            | (OperationStatus::WaitingDevice, OperationStatus::Rejected)
            | (OperationStatus::Accepted, OperationStatus::Running)
            | (OperationStatus::Running, OperationStatus::Succeeded)
            | (OperationStatus::Running, OperationStatus::Failed)
            | (OperationStatus::Running, OperationStatus::Rejected)
            | (_, OperationStatus::Canceled)
            | (_, OperationStatus::TimedOut)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn operation_never_reaches_success_without_device_update() {
        let storage = Storage::open_memory().await.unwrap();
        storage.ensure_single_user("admin", "hash").await.unwrap();
        let user = storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap();
        storage
            .upsert_device_hello("device-1", "PC", "windows", "1.0", &[], None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET user_id = ?1 WHERE id = 'device-1'")
            .bind(&user.id)
            .execute(storage.pool())
            .await
            .unwrap();
        let operation = storage
            .create_operation(
                &user.id,
                "device-1",
                "conversation.start",
                "key-1",
                &serde_json::json!({"prompt":"hello"}),
                OperationStatus::WaitingDevice,
            )
            .await
            .unwrap();
        assert_eq!(operation.status, OperationStatus::WaitingDevice);
        let fetched = storage
            .operation_for_user(&user.id, &operation.id)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(fetched.status, OperationStatus::Succeeded);
    }

    #[test]
    fn pre_execution_rejection_is_allowed_without_running() {
        assert!(valid_operation_transition(
            &OperationStatus::Submitted,
            &OperationStatus::Rejected
        ));
        assert!(valid_operation_transition(
            &OperationStatus::WaitingDevice,
            &OperationStatus::Rejected
        ));
        assert!(!valid_operation_transition(
            &OperationStatus::Submitted,
            &OperationStatus::Succeeded
        ));
    }

    #[tokio::test]
    async fn history_snapshot_removes_missing_sessions() {
        let storage = Storage::open_memory().await.unwrap();
        storage.ensure_single_user("admin", "hash").await.unwrap();
        let user = storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap();
        storage
            .upsert_device_hello("device-1", "PC", "windows", "1.0", &[], None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET user_id = ?1 WHERE id = 'device-1'")
            .bind(&user.id)
            .execute(storage.pool())
            .await
            .unwrap();
        let session = |session_id: &str| HistorySessionSummary {
            session_id: session_id.to_string(),
            device_id: "device-1".to_string(),
            source: "codex".to_string(),
            project_key: "project".to_string(),
            title: session_id.to_string(),
            cwd: None,
            created_at: 1,
            updated_at: 2,
            message_count: 1,
            branch: None,
            freshness: "live".to_string(),
        };
        storage
            .replace_history_snapshot(
                "device-1",
                &user.id,
                1,
                &[session("session-a"), session("session-b")],
            )
            .await
            .unwrap();
        storage
            .replace_history_snapshot("device-1", &user.id, 2, &[session("session-b")])
            .await
            .unwrap();
        let sessions = storage
            .list_history(&user.id, Some("device-1"), 50, 0)
            .await
            .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "session-b");
    }

    #[test]
    fn only_device_report_can_enter_terminal_state() {
        assert!(valid_operation_transition(
            &OperationStatus::Running,
            &OperationStatus::Succeeded
        ));
        assert!(!valid_operation_transition(
            &OperationStatus::Succeeded,
            &OperationStatus::Running
        ));
        assert!(!valid_operation_transition(
            &OperationStatus::Submitted,
            &OperationStatus::Succeeded
        ));
        assert!(!valid_operation_transition(
            &OperationStatus::WaitingDevice,
            &OperationStatus::Running
        ));
        assert!(valid_operation_transition(
            &OperationStatus::Accepted,
            &OperationStatus::TimedOut
        ));
    }
}
