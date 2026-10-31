use crate::pool::DbPool;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMetaPatch {
    pub session_key: String,
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub file_path: String,
    pub alias: String,
    pub starred: bool,
    pub tags_json: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FavoriteSnapshotPatch {
    pub session_key: String,
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub file_path: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
    pub branch: Option<String>,
    pub detail_json: String,
    pub snapshot_at: String,
}

pub async fn update_session_meta(
    path: impl AsRef<Path>,
    patch: SessionMetaPatch,
) -> Result<(), String> {
    let path = path.as_ref();
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Err("history_database_missing".into());
    }
    let pool = DbPool::open(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = sqlx::query(
        "INSERT INTO session_meta (session_key, session_id, source, project_key, file_path, alias, starred, tags_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(session_key) DO UPDATE SET alias = excluded.alias, starred = excluded.starred, tags_json = excluded.tags_json, updated_at = excluded.updated_at",
    )
    .bind(patch.session_key)
    .bind(patch.session_id)
    .bind(patch.source)
    .bind(patch.project_key)
    .bind(patch.file_path)
    .bind(patch.alias)
    .bind(if patch.starred { 1_i64 } else { 0_i64 })
    .bind(patch.tags_json)
    .bind(patch.updated_at)
    .execute(pool.writer())
    .await
    .map_err(|error| error.to_string());
    pool.close().await;
    result.map(|_| ())
}

pub async fn upsert_favorite_snapshot(
    path: impl AsRef<Path>,
    patch: FavoriteSnapshotPatch,
) -> Result<(), String> {
    let path = path.as_ref();
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Err("history_database_missing".into());
    }
    let pool = DbPool::open(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = sqlx::query(
        "INSERT INTO session_favorite_snapshots (
            session_key, session_id, source, project_key, file_path, title,
            created_at, updated_at, message_count, branch, detail_json, snapshot_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(session_key) DO UPDATE SET
            session_id = excluded.session_id,
            source = excluded.source,
            project_key = excluded.project_key,
            file_path = excluded.file_path,
            title = excluded.title,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            message_count = excluded.message_count,
            branch = excluded.branch,
            detail_json = excluded.detail_json,
            snapshot_at = excluded.snapshot_at",
    )
    .bind(patch.session_key)
    .bind(patch.session_id)
    .bind(patch.source)
    .bind(patch.project_key)
    .bind(patch.file_path)
    .bind(patch.title)
    .bind(patch.created_at)
    .bind(patch.updated_at)
    .bind(patch.message_count)
    .bind(patch.branch)
    .bind(patch.detail_json)
    .bind(patch.snapshot_at)
    .execute(pool.writer())
    .await
    .map_err(|error| error.to_string());
    pool.close().await;
    result.map(|_| ())
}

pub async fn delete_favorite_snapshot(
    path: impl AsRef<Path>,
    session_key: String,
) -> Result<(), String> {
    let path = path.as_ref();
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Err("history_database_missing".into());
    }
    let pool = DbPool::open(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = sqlx::query("DELETE FROM session_favorite_snapshots WHERE session_key = ?1")
        .bind(session_key)
        .execute(pool.writer())
        .await
        .map_err(|error| error.to_string());
    pool.close().await;
    result.map(|_| ())
}
