use super::{table_exists, APP_VERSION};
use serde_json::Value;
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection};
use std::fs;
use std::path::Path;

pub(super) const REPLAY_SNAPSHOT_PATCH_DIR: &str = "replay-snapshots";
pub(super) const REPLAY_SNAPSHOT_PATCH_STORAGE: &str = "file";
const REPLAY_SNAPSHOT_CLEANUP_MARKER_FILE: &str = "replay-snapshot-patch-cleanup.version";
pub(super) const REPLAY_SNAPSHOT_SLIM_MARKER_FILE: &str = "replay-snapshot-file-list-slim-v1.version";
// 与前端快照写入口径一致：仅保留前 20 个变更文件名，完整文件列表不再入库。
const REPLAY_SNAPSHOT_CHANGED_FILES_LIMIT: usize = 20;
const REPLAY_SNAPSHOT_SLIM_BATCH_SIZE: i64 = 100;
// 回放会话按最后活动时间保留 7 天，过期会话连同事件与补丁文件在启动修复时删除。
const REPLAY_SESSION_RETENTION_DAYS: i64 = 7;
// 主库空闲页同时超过字节与占比阈值才整理，避免每次启动清理少量会话都整库重写。
const CLI_MANAGER_DB_VACUUM_MIN_FREE_BYTES: i64 = 32 * 1024 * 1024;
const CLI_MANAGER_DB_VACUUM_MIN_FREE_PERCENT: i64 = 25;

// 查询内联快照补丁并在事务中迁出到文件，成功后尽力收缩数据库。
pub(super) async fn cleanup_replay_snapshot_inline_patches(
    conn: &mut SqliteConnection,
    data_dir: &Path,
) -> Result<usize, String> {
    if !table_exists(conn, "ai_replay_events").await? {
        return Ok(0);
    }

    let rows = sqlx::query(
        "SELECT id, session_key, event_index, payload_json
         FROM ai_replay_events
         WHERE kind = 'snapshot' AND payload_json LIKE ?1
         ORDER BY id",
    )
    .bind("%\"patch\"%")
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("replay_snapshot_cleanup_query_failed: {err}"))?;

    if rows.is_empty() {
        return Ok(0);
    }

    fs::create_dir_all(data_dir.join(REPLAY_SNAPSHOT_PATCH_DIR))
        .map_err(|err| format!("replay_snapshot_cleanup_dir_failed: {err}"))?;

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("replay_snapshot_cleanup_begin_failed: {err}"))?;

    let result = cleanup_replay_snapshot_inline_patches_in_transaction(conn, data_dir, &rows).await;
    if result.is_ok() {
        sqlx::query("COMMIT")
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("replay_snapshot_cleanup_commit_failed: {err}"))?;
    } else {
        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
    }

    let migrated = result?;
    if migrated > 0 {
        compact_cli_manager_db(conn, "Replay snapshot").await;
    }

    Ok(migrated)
}

// 截断 WAL 后 VACUUM 归还空闲页，失败只记录警告不阻断启动修复。
async fn compact_cli_manager_db(conn: &mut SqliteConnection, label: &str) {
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut *conn)
        .await;
    if let Err(err) = sqlx::query("VACUUM").execute(&mut *conn).await {
        log::warn!("{label} DB vacuum skipped: {err}");
    }
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut *conn)
        .await;
}

// 按应用版本标记控制内联快照补丁清理，成功后记录当前版本。
pub(super) async fn cleanup_replay_snapshot_inline_patches_for_current_version(
    conn: &mut SqliteConnection,
    data_dir: &Path,
) -> Result<usize, String> {
    if replay_snapshot_cleanup_marker_path(data_dir).is_file()
        && fs::read_to_string(replay_snapshot_cleanup_marker_path(data_dir))
            .map(|value| value.trim() == APP_VERSION)
            .unwrap_or(false)
    {
        return Ok(0);
    }

    let migrated = cleanup_replay_snapshot_inline_patches(conn, data_dir).await?;
    fs::create_dir_all(data_dir)
        .map_err(|err| format!("replay_snapshot_cleanup_marker_dir_failed: {err}"))?;
    fs::write(replay_snapshot_cleanup_marker_path(data_dir), APP_VERSION)
        .map_err(|err| format!("replay_snapshot_cleanup_marker_write_failed: {err}"))?;
    Ok(migrated)
}

// 返回快照补丁清理版本标记的应用数据路径。
pub(super) fn replay_snapshot_cleanup_marker_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(REPLAY_SNAPSHOT_CLEANUP_MARKER_FILE)
}

// 计算回放保留截止时间，格式与前端 toISOString 一致以便按字符串比较 updated_at。
pub(super) fn replay_retention_cutoff(now: chrono::DateTime<chrono::Utc>) -> String {
    (now - chrono::Duration::days(REPLAY_SESSION_RETENTION_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// 删除最后活动早于截止时间的回放会话及其事件，提交后再删补丁文件，空闲页较多时收缩主库。
pub(super) async fn prune_expired_replay_sessions(
    conn: &mut SqliteConnection,
    data_dir: &Path,
    cutoff: &str,
) -> Result<usize, String> {
    if !table_exists(conn, "ai_replay_sessions").await? {
        return Ok(0);
    }
    let has_events = table_exists(conn, "ai_replay_events").await?;
    let patch_paths: Vec<String> = if has_events {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT CASE WHEN json_valid(payload_json) THEN
                    CASE WHEN json_type(payload_json, '$.patchPath') = 'text'
                         THEN json_extract(payload_json, '$.patchPath') END
                    END AS patch_path
             FROM ai_replay_events
             WHERE kind = 'snapshot'
               AND session_key IN (SELECT session_key FROM ai_replay_sessions WHERE updated_at < ?1)",
        )
        .bind(cutoff)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("replay_retention_query_failed: {err}"))?
        .into_iter()
        .flatten()
        .collect()
    } else {
        Vec::new()
    };

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("replay_retention_begin_failed: {err}"))?;
    let result: Result<u64, String> = async {
        if has_events {
            sqlx::query(
                "DELETE FROM ai_replay_events
                 WHERE session_key IN (SELECT session_key FROM ai_replay_sessions WHERE updated_at < ?1)",
            )
            .bind(cutoff)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("replay_retention_events_delete_failed: {err}"))?;
        }
        let deleted = sqlx::query("DELETE FROM ai_replay_sessions WHERE updated_at < ?1")
            .bind(cutoff)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("replay_retention_sessions_delete_failed: {err}"))?;
        Ok(deleted.rows_affected())
    }
    .await;
    let pruned = match result {
        Ok(pruned) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("replay_retention_commit_failed: {err}"))?;
            pruned as usize
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(err);
        }
    };

    for patch_path in &patch_paths {
        remove_replay_patch_file(data_dir, patch_path);
    }
    if pruned > 0 {
        log::info!(
            "Replay retention pruned {pruned} sessions and {} patch files before {cutoff}",
            patch_paths.len()
        );
        compact_cli_manager_db_if_fragmented(conn, "Replay retention").await;
    }
    Ok(pruned)
}

// 仅删除数据目录 replay-snapshots 下的 .patch 文件并尝试移除变空的会话目录，失败只记录。
fn remove_replay_patch_file(data_dir: &Path, relative_path: &str) {
    let relative = Path::new(relative_path);
    let inside_patch_dir = relative.starts_with(REPLAY_SNAPSHOT_PATCH_DIR)
        && relative.extension().is_some_and(|ext| ext == "patch")
        && relative
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)));
    if !inside_patch_dir {
        log::warn!("Replay retention skipped unexpected patch path: {relative_path}");
        return;
    }
    let full_path = data_dir.join(relative);
    match fs::remove_file(&full_path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            log::warn!("Replay retention failed to remove {relative_path}: {err}");
            return;
        }
    }
    if let Some(parent) = full_path.parent() {
        if parent != data_dir.join(REPLAY_SNAPSHOT_PATCH_DIR) {
            let _ = fs::remove_dir(parent);
        }
    }
}

// 空闲页同时超过字节与占比阈值时才收缩主库。
async fn compact_cli_manager_db_if_fragmented(conn: &mut SqliteConnection, label: &str) {
    let mut pragmas = [0_i64; 3];
    for (value, pragma) in pragmas
        .iter_mut()
        .zip(["page_size", "page_count", "freelist_count"])
    {
        match sqlx::query_scalar::<_, i64>(&format!("PRAGMA {pragma}"))
            .fetch_one(&mut *conn)
            .await
        {
            Ok(read) => *value = read,
            Err(err) => {
                log::warn!("{label} DB fragmentation check skipped: {err}");
                return;
            }
        }
    }
    if cli_manager_db_needs_vacuum(pragmas[0], pragmas[1], pragmas[2]) {
        compact_cli_manager_db(conn, label).await;
    }
}

// 判断主库空闲页是否同时达到字节与占比阈值。
pub(super) fn cli_manager_db_needs_vacuum(page_size: i64, page_count: i64, freelist_count: i64) -> bool {
    if page_size <= 0 || page_count <= 0 || freelist_count <= 0 {
        return false;
    }
    freelist_count.saturating_mul(page_size) >= CLI_MANAGER_DB_VACUUM_MIN_FREE_BYTES
        && freelist_count.saturating_mul(100)
            >= page_count.saturating_mul(CLI_MANAGER_DB_VACUUM_MIN_FREE_PERCENT)
}

// 一次性瘦身历史快照载荷，完成后写入标记，后续启动不再全表扫描。
pub(super) async fn slim_replay_snapshot_payloads_once(
    conn: &mut SqliteConnection,
    data_dir: &Path,
) -> Result<usize, String> {
    let marker_path = data_dir.join(REPLAY_SNAPSHOT_SLIM_MARKER_FILE);
    if marker_path.is_file() {
        return Ok(0);
    }
    let slimmed = slim_replay_snapshot_payloads(conn).await?;
    fs::create_dir_all(data_dir)
        .map_err(|err| format!("replay_snapshot_slim_marker_dir_failed: {err}"))?;
    fs::write(&marker_path, APP_VERSION)
        .map_err(|err| format!("replay_snapshot_slim_marker_write_failed: {err}"))?;
    Ok(slimmed)
}

// 按 id 分批瘦身快照载荷并逐批提交；逐行幂等，中断后重跑可续做，有改动时收缩数据库。
pub(super) async fn slim_replay_snapshot_payloads(conn: &mut SqliteConnection) -> Result<usize, String> {
    if !table_exists(conn, "ai_replay_events").await? {
        return Ok(0);
    }
    let mut slimmed = 0usize;
    let mut last_id = 0_i64;
    loop {
        let rows = sqlx::query(
            "SELECT id, payload_json FROM ai_replay_events
             WHERE kind = 'snapshot' AND id > ?1
             ORDER BY id LIMIT ?2",
        )
        .bind(last_id)
        .bind(REPLAY_SNAPSHOT_SLIM_BATCH_SIZE)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("replay_snapshot_slim_query_failed: {err}"))?;
        let Some(last_row) = rows.last() else {
            break;
        };
        last_id = last_row
            .try_get("id")
            .map_err(|err| format!("replay_snapshot_slim_row_failed: {err}"))?;

        let mut updates = Vec::new();
        for row in &rows {
            let id: i64 = row
                .try_get("id")
                .map_err(|err| format!("replay_snapshot_slim_row_failed: {err}"))?;
            let payload_json: String = row
                .try_get("payload_json")
                .map_err(|err| format!("replay_snapshot_slim_row_failed: {err}"))?;
            let Ok(mut payload) = serde_json::from_str::<Value>(&payload_json) else {
                continue;
            };
            let Some(object) = payload.as_object_mut() else {
                continue;
            };
            if slim_replay_snapshot_payload(object) {
                let updated = serde_json::to_string(&payload)
                    .map_err(|err| format!("replay_snapshot_slim_serialize_failed: {err}"))?;
                updates.push((id, updated));
            }
        }
        drop(rows);
        if updates.is_empty() {
            continue;
        }

        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("replay_snapshot_slim_begin_failed: {err}"))?;
        for (id, payload_json) in &updates {
            if let Err(err) =
                sqlx::query("UPDATE ai_replay_events SET payload_json = ?1 WHERE id = ?2")
                    .bind(payload_json)
                    .bind(id)
                    .execute(&mut *conn)
                    .await
            {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(format!("replay_snapshot_slim_update_failed: {err}"));
            }
        }
        sqlx::query("COMMIT")
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("replay_snapshot_slim_commit_failed: {err}"))?;
        slimmed += updates.len();
    }

    if slimmed > 0 {
        compact_cli_manager_db(conn, "Replay snapshot slim").await;
    }
    Ok(slimmed)
}

// 移除快照的完整文件列表并截断变更文件名，口径与前端新快照一致；返回载荷是否被修改。
fn slim_replay_snapshot_payload(object: &mut serde_json::Map<String, Value>) -> bool {
    let files = object.remove("files");
    let changed_files = match object.remove("changedFiles") {
        Some(Value::Array(items)) => Some(items),
        Some(other) => {
            object.insert("changedFiles".to_string(), other);
            None
        }
        None => files.as_ref().and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("path").cloned())
                .collect()
        }),
    };
    let Some(mut changed_files) = changed_files else {
        return files.is_some();
    };
    let file_count = changed_files.len();
    let truncated = file_count > REPLAY_SNAPSHOT_CHANGED_FILES_LIMIT;
    if files.is_none() && !truncated {
        object.insert("changedFiles".to_string(), Value::Array(changed_files));
        return false;
    }
    changed_files.truncate(REPLAY_SNAPSHOT_CHANGED_FILES_LIMIT);
    object.insert("changedFiles".to_string(), Value::Array(changed_files));
    object
        .entry("fileCount")
        .or_insert_with(|| Value::from(file_count as u64));
    if truncated {
        object.insert("changedFilesTruncated".to_string(), Value::Bool(true));
    }
    true
}

// 在现有事务中逐条写出快照补丁文件，并将数据库载荷改为文件引用。
async fn cleanup_replay_snapshot_inline_patches_in_transaction(
    conn: &mut SqliteConnection,
    data_dir: &Path,
    rows: &[SqliteRow],
) -> Result<usize, String> {
    let mut migrated = 0usize;

    for row in rows {
        let id: i64 = row
            .try_get("id")
            .map_err(|err| format!("replay_snapshot_cleanup_row_failed: {err}"))?;
        let session_key: String = row
            .try_get("session_key")
            .map_err(|err| format!("replay_snapshot_cleanup_row_failed: {err}"))?;
        let event_index: i64 = row
            .try_get("event_index")
            .map_err(|err| format!("replay_snapshot_cleanup_row_failed: {err}"))?;
        let payload_json: String = row
            .try_get("payload_json")
            .map_err(|err| format!("replay_snapshot_cleanup_row_failed: {err}"))?;

        let Ok(mut payload) = serde_json::from_str::<Value>(&payload_json) else {
            log::warn!("Replay snapshot cleanup skipped malformed payload row id={id}");
            continue;
        };
        let Some(object) = payload.as_object_mut() else {
            continue;
        };
        let Some(patch) = object
            .get("patch")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
        else {
            continue;
        };

        let checkpoint_id = object
            .get("checkpointId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("event-{event_index}"));
        let relative_path = replay_snapshot_patch_relative_path(&session_key, &checkpoint_id);
        let target_path = data_dir.join(&relative_path);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("replay_snapshot_cleanup_dir_failed: {err}"))?;
        }
        fs::write(&target_path, patch.as_bytes())
            .map_err(|err| format!("replay_snapshot_cleanup_write_failed: {err}"))?;

        let patch_bytes = patch.len() as u64;
        object.remove("patch");
        object.insert("patchPath".to_string(), Value::String(relative_path));
        object.insert(
            "patchStorage".to_string(),
            Value::String(REPLAY_SNAPSHOT_PATCH_STORAGE.to_string()),
        );
        if object.get("patchBytes").and_then(Value::as_u64).is_none() {
            object.insert(
                "patchBytes".to_string(),
                Value::Number(serde_json::Number::from(patch_bytes)),
            );
        }
        object.insert(
            "patchStoredAt".to_string(),
            Value::String(chrono::Utc::now().to_rfc3339()),
        );

        let updated_payload_json = serde_json::to_string(&payload)
            .map_err(|err| format!("replay_snapshot_cleanup_serialize_failed: {err}"))?;
        sqlx::query("UPDATE ai_replay_events SET payload_json = ?1 WHERE id = ?2")
            .bind(updated_payload_json)
            .bind(id)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("replay_snapshot_cleanup_update_failed: {err}"))?;
        migrated += 1;
    }

    Ok(migrated)
}

// 用清理后的会话与检查点标识生成快照补丁相对路径。
fn replay_snapshot_patch_relative_path(session_key: &str, checkpoint_id: &str) -> String {
    format!(
        "{}/{}/{}.patch",
        REPLAY_SNAPSHOT_PATCH_DIR,
        sanitize_snapshot_path_segment(session_key, "session"),
        sanitize_snapshot_path_segment(checkpoint_id, "snapshot")
    )
}

// 将路径片段限制为安全 ASCII 字符和最多 120 字节，空结果使用回退名称。
fn sanitize_snapshot_path_segment(value: &str, fallback: &str) -> String {
    let mut safe = String::with_capacity(value.len().min(120));
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            safe.push(ch);
        } else {
            safe.push('-');
        }
        if safe.len() >= 120 {
            break;
        }
    }
    let trimmed = safe.trim_matches(['.', '-']);
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}
