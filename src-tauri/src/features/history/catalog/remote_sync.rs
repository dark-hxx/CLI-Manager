use super::super::*;
use super::{
    map_remote_catalog_error, map_remote_catalog_sql_error, open_catalog, CATALOG_PARSER_VERSION,
};
use cli_manager_history_core::RemoteHistorySyncResult;
use sqlx::{Connection, Row, SqliteConnection};

// 打开目录并应用远程同步结果，将目录错误映射为远程错误码。
pub(crate) async fn apply_remote_sync(
    host_id: &str,
    result: &RemoteHistorySyncResult,
) -> Result<bool, String> {
    let mut conn = open_catalog().await.map_err(map_remote_catalog_error)?;
    apply_remote_sync_with_conn(&mut conn, host_id, result)
        .await
        .map_err(map_remote_catalog_error)
}

// 将远程计数安全转换为 SQLite 整数，溢出时拒绝写入。
pub(super) fn remote_catalog_i64<T: TryInto<i64>>(value: T) -> Result<i64, String> {
    value
        .try_into()
        .map_err(|_| "history_remote_numeric_overflow".to_string())
}

// 验证远程身份和游标，在事务中更新只读摘要、用量事实与墓碑状态。
pub(super) async fn apply_remote_sync_with_conn(
    conn: &mut SqliteConnection,
    host_id: &str,
    result: &RemoteHistorySyncResult,
) -> Result<bool, String> {
    if host_id.trim().is_empty()
        || !matches!(result.source.as_str(), "claude" | "codex")
        || result.source_instance_id.trim().is_empty()
        || result.remote_machine_id.trim().is_empty()
        || result.ssh_user.trim().is_empty()
        || result.config_root_hash.trim().is_empty()
    {
        return Err("history_remote_identity_invalid".to_string());
    }
    if !result.discovery_complete && !result.tombstones.is_empty() {
        return Err("history_remote_tombstone_without_discovery".to_string());
    }
    let incoming_cursor_offset = remote_cursor_offset(&result.cursor, result.generation)?;
    let completeness_json = serde_json::to_string(&json!({
        "summary": true,
        "messages": false,
        "diff": false,
        "onlineRequired": true,
    }))
    .map_err(|err| err.to_string())?;
    let source_extension_json = serde_json::to_string(&json!({
        "hostId": host_id,
        "transportKind": "ssh",
    }))
    .map_err(|err| err.to_string())?;
    let raw_pointers_json = result
        .sessions
        .iter()
        .map(|summary| {
            if summary.session_ref.source_id != result.source
                || summary.session_ref.source_instance_id != result.source_instance_id
                || summary.session_ref.source_session_id.trim().is_empty()
                || summary.session_ref.transport_kind != "ssh"
                || summary.index_generation != result.generation
                || summary
                    .session_ref
                    .raw_pointers
                    .iter()
                    .any(|pointer| pointer.raw_key.is_empty())
            {
                return Err("history_remote_session_ref_invalid".to_string());
            }
            remote_catalog_i64(summary.message_count)?;
            remote_catalog_i64(summary.usage.input_tokens)?;
            remote_catalog_i64(summary.usage.output_tokens)?;
            remote_catalog_i64(summary.usage.cache_read_tokens)?;
            remote_catalog_i64(summary.usage.cache_creation_tokens)?;
            remote_catalog_i64(summary.parser_version)?;
            remote_catalog_i64(summary.index_generation)?;
            for fact in &summary.usage_facts {
                remote_catalog_i64(fact.event_index)?;
                remote_catalog_i64(fact.usage.input_tokens)?;
                remote_catalog_i64(fact.usage.output_tokens)?;
                remote_catalog_i64(fact.usage.cache_read_tokens)?;
                remote_catalog_i64(fact.usage.cache_creation_tokens)?;
            }
            serde_json::to_string(&summary.session_ref.raw_pointers).map_err(|err| err.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let generation = remote_catalog_i64(result.generation)?;
    let total_sessions = remote_catalog_i64(result.total_sessions)?;
    let scope_key = format!(
        "{}:{}:{}",
        result.remote_machine_id, result.ssh_user, result.config_root_hash
    );
    let locations_json = serde_json::to_string(&json!({
        "configuredConfigRoot": result.configured_config_root,
        "canonicalConfigRoot": result.canonical_config_root,
    }))
    .map_err(|err| err.to_string())?;
    let remote_identity = json!({
        "hostId": host_id,
        "installationId": result.installation_id,
        "remoteMachineId": result.remote_machine_id,
        "sshUser": result.ssh_user,
        "configRootHash": result.config_root_hash,
    });
    let remote_identity_json =
        serde_json::to_string(&remote_identity).map_err(|err| err.to_string())?;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(map_remote_catalog_sql_error)?;
    let contaminated_remote_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM history_sessions
         WHERE source_instance_id = ?1
           AND (storage_kind <> 'remote'
                OR primary_path IS NOT NULL
                OR database_path IS NOT NULL
                OR raw_key IS NOT NULL
                OR materialization_level <> 'summary')",
    )
    .bind(&result.source_instance_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    if let Some(row) = sqlx::query(
        "SELECT state.generation, instance.sync_cursor_json
         FROM history_source_instances AS instance
         LEFT JOIN history_source_state AS state ON state.source_instance_id = instance.id
         WHERE instance.id = ?1",
    )
    .bind(&result.source_instance_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| err.to_string())?
    {
        let current_generation = row
            .try_get::<Option<i64>, _>("generation")
            .map_err(|err| err.to_string())?
            .unwrap_or_default();
        let current_generation = u64::try_from(current_generation).unwrap_or_default();
        let current_cursor = row
            .try_get::<Option<String>, _>("sync_cursor_json")
            .map_err(|err| err.to_string())?
            .unwrap_or_default();
        let current_cursor_offset =
            remote_cursor_offset(&current_cursor, current_generation).unwrap_or_default();
        if contaminated_remote_rows == 0
            && (result.generation < current_generation
                || (result.generation == current_generation
                    && incoming_cursor_offset < current_cursor_offset))
        {
            tx.rollback().await.map_err(|err| err.to_string())?;
            return Ok(false);
        }
    }
    if let Some(row) = sqlx::query(
        "SELECT source_id, scope_kind, scope_key, transport_kind, remote_identity_json
         FROM history_source_instances WHERE id = ?1",
    )
    .bind(&result.source_instance_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| err.to_string())?
    {
        let existing_identity = row
            .try_get::<Option<String>, _>("remote_identity_json")
            .map_err(|err| err.to_string())?
            .and_then(|value| serde_json::from_str::<Value>(&value).ok());
        // installationId authenticates the live bridge but rotates when the Agent is reinstalled.
        // The stable source identity is machine/user/source/config root, matching source_instance_id.
        let identity_matches = existing_identity.as_ref().is_some_and(|identity| {
            ["remoteMachineId", "sshUser", "configRootHash"]
                .into_iter()
                .all(|key| identity.get(key) == remote_identity.get(key))
        });
        if row.try_get::<String, _>("source_id").ok().as_deref() != Some(result.source.as_str())
            || row.try_get::<String, _>("scope_kind").ok().as_deref() != Some("ssh")
            || row.try_get::<String, _>("scope_key").ok().as_deref() != Some(scope_key.as_str())
            || row.try_get::<String, _>("transport_kind").ok().as_deref() != Some("ssh")
            || !identity_matches
        {
            return Err("history_remote_identity_changed".to_string());
        }
    }
    if contaminated_remote_rows > 0 {
        log::warn!(
            "cleaning contaminated remote history catalog rows: source_instance_id={} rows={}",
            result.source_instance_id,
            contaminated_remote_rows
        );
        sqlx::query(
            "DELETE FROM history_sessions
             WHERE source_instance_id = ?1
               AND (storage_kind <> 'remote'
                    OR primary_path IS NOT NULL
                    OR database_path IS NOT NULL
                    OR raw_key IS NOT NULL
                    OR materialization_level <> 'summary')",
        )
        .bind(&result.source_instance_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
        sqlx::query("DELETE FROM history_source_state WHERE source_instance_id = ?1")
            .bind(&result.source_instance_id)
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
    }
    sqlx::query(
        "UPDATE history_source_instances
         SET activation_state = 'inactive', updated_at = ?1
         WHERE source_id = ?2 AND scope_kind = 'ssh' AND scope_key = ?3
           AND activation_state = 'active' AND id <> ?4",
    )
    .bind(result.as_of)
    .bind(&result.source)
    .bind(&scope_key)
    .bind(&result.source_instance_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO history_source_instances(
            id, source_id, environment_kind, environment_key, storage_kind,
            display_name, locations_json, settings_hash, activation_state,
            scope_kind, scope_key, transport_kind, materialization_level,
            freshness_state, as_of, remote_identity_json, sync_cursor_json,
            discovered, created_at, updated_at
         ) VALUES (
            ?1, ?2, 'ssh', ?3, 'file', ?4, ?5, ?6, 'active',
            'ssh', ?7, 'ssh', 'summary', ?8, ?9, ?10, ?11, 1, ?9, ?9
         )
         ON CONFLICT(id) DO UPDATE SET
            source_id = excluded.source_id,
            environment_kind = excluded.environment_kind,
            environment_key = excluded.environment_key,
            storage_kind = excluded.storage_kind,
            display_name = excluded.display_name,
            locations_json = excluded.locations_json,
            settings_hash = excluded.settings_hash,
            activation_state = 'active',
            scope_kind = excluded.scope_kind,
            scope_key = excluded.scope_key,
            transport_kind = excluded.transport_kind,
            materialization_level = excluded.materialization_level,
            freshness_state = excluded.freshness_state,
            as_of = excluded.as_of,
            remote_identity_json = excluded.remote_identity_json,
            sync_cursor_json = excluded.sync_cursor_json,
            discovered = 1,
            updated_at = excluded.updated_at",
    )
    .bind(&result.source_instance_id)
    .bind(&result.source)
    .bind(format!("{}:{}", result.remote_machine_id, result.ssh_user))
    .bind(format!("{} @ {}", result.source, result.ssh_user))
    .bind(locations_json)
    .bind(&result.config_root_hash)
    .bind(&scope_key)
    .bind(&result.freshness_state)
    .bind(result.as_of)
    .bind(remote_identity_json)
    .bind(&result.cursor)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;

    for (summary, raw_pointers_json) in result.sessions.iter().zip(&raw_pointers_json) {
        sqlx::query(
            "INSERT INTO history_sessions(
                source_instance_id, source_session_id, storage_kind,
                project_key, cwd, cwd_normalized, title, branch, lifecycle_state,
                created_at, updated_at, message_count,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                dominant_model, current_model, fingerprint_kind, fingerprint_value,
                parser_version, model_version, parse_status, materialization_level,
                freshness_state, as_of, tombstoned_at, completeness_json,
                raw_pointers_json, source_extension_json, last_seen_generation, indexed_at
             ) VALUES (
                ?1, ?2, 'remote', ?3, ?4, ?5, ?6, ?7, 'active',
                ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                'remoteGeneration', ?17, ?18, 1, 'ok', 'summary', ?19, ?20, NULL,
                ?21, ?22, ?23, ?24, ?20
             )
             ON CONFLICT(source_instance_id, source_session_id) DO UPDATE SET
                storage_kind = 'remote',
                primary_path = NULL,
                database_path = NULL,
                raw_key = NULL,
                project_key = excluded.project_key,
                cwd = excluded.cwd,
                cwd_normalized = excluded.cwd_normalized,
                title = excluded.title,
                branch = excluded.branch,
                lifecycle_state = 'active',
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                message_count = excluded.message_count,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                cache_read_tokens = excluded.cache_read_tokens,
                cache_creation_tokens = excluded.cache_creation_tokens,
                dominant_model = excluded.dominant_model,
                current_model = excluded.current_model,
                fingerprint_kind = excluded.fingerprint_kind,
                fingerprint_value = excluded.fingerprint_value,
                parser_version = excluded.parser_version,
                model_version = excluded.model_version,
                parse_status = 'ok',
                materialization_level = 'summary',
                freshness_state = excluded.freshness_state,
                as_of = excluded.as_of,
                tombstoned_at = NULL,
                completeness_json = excluded.completeness_json,
                raw_pointers_json = excluded.raw_pointers_json,
                source_extension_json = excluded.source_extension_json,
                last_seen_generation = excluded.last_seen_generation,
                indexed_at = excluded.indexed_at",
        )
        .bind(&result.source_instance_id)
        .bind(&summary.session_ref.source_session_id)
        .bind(&summary.project_key)
        .bind(summary.cwd.as_deref())
        .bind(summary.cwd.as_deref().map(normalize_history_path))
        .bind(&summary.title)
        .bind(summary.branch.as_deref())
        .bind(summary.created_at)
        .bind(summary.updated_at)
        .bind(remote_catalog_i64(summary.message_count)?)
        .bind(remote_catalog_i64(summary.usage.input_tokens)?)
        .bind(remote_catalog_i64(summary.usage.output_tokens)?)
        .bind(remote_catalog_i64(summary.usage.cache_read_tokens)?)
        .bind(remote_catalog_i64(summary.usage.cache_creation_tokens)?)
        .bind(summary.dominant_model.as_deref())
        .bind(summary.current_model.as_deref())
        .bind(format!(
            "{}:{}",
            summary.index_generation, summary.session_ref.source_session_id
        ))
        .bind(remote_catalog_i64(summary.parser_version)?)
        .bind(&result.freshness_state)
        .bind(result.as_of)
        .bind(&completeness_json)
        .bind(raw_pointers_json)
        .bind(&source_extension_json)
        .bind(remote_catalog_i64(summary.index_generation)?)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
        let session_row_id: i64 = sqlx::query_scalar(
            "SELECT id FROM history_sessions
             WHERE source_instance_id = ?1 AND source_session_id = ?2",
        )
        .bind(&result.source_instance_id)
        .bind(&summary.session_ref.source_session_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
        for table in [
            "history_tool_events",
            "history_file_changes",
            "history_messages",
            "history_usage_events",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE session_id = ?1"))
                .bind(session_row_id)
                .execute(&mut *tx)
                .await
                .map_err(|err| err.to_string())?;
        }
        for fact in &summary.usage_facts {
            sqlx::query(
                "INSERT INTO history_usage_events(
                    session_id, event_index, timestamp_ms, model,
                    input_tokens, output_tokens, cache_read_tokens,
                    cache_creation_tokens, cost_usd, raw_pointers_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL)",
            )
            .bind(session_row_id)
            .bind(remote_catalog_i64(fact.event_index)?)
            .bind(fact.timestamp_ms)
            .bind(fact.model.as_deref())
            .bind(remote_catalog_i64(fact.usage.input_tokens)?)
            .bind(remote_catalog_i64(fact.usage.output_tokens)?)
            .bind(remote_catalog_i64(fact.usage.cache_read_tokens)?)
            .bind(remote_catalog_i64(fact.usage.cache_creation_tokens)?)
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
        }
    }

    if result.discovery_complete {
        for source_session_id in &result.tombstones {
            sqlx::query(
                "UPDATE history_sessions
                 SET lifecycle_state = 'deleted', parse_status = 'tombstone',
                     tombstoned_at = ?1, freshness_state = ?2, as_of = ?1,
                     last_seen_generation = ?3, indexed_at = ?1
                 WHERE source_instance_id = ?4 AND source_session_id = ?5",
            )
            .bind(result.as_of)
            .bind(&result.freshness_state)
            .bind(generation)
            .bind(&result.source_instance_id)
            .bind(source_session_id)
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
        }
    }
    sqlx::query(
        "INSERT INTO history_source_state(
            source_instance_id, phase, generation, parser_version, settings_hash,
            discovered_sessions, indexed_sessions, failed_sessions,
            last_started_at, last_completed_at, last_success_at, error_code, error_detail
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0, ?7, ?7, ?8, NULL, NULL)
         ON CONFLICT(source_instance_id) DO UPDATE SET
            phase = excluded.phase,
            generation = excluded.generation,
            parser_version = excluded.parser_version,
            settings_hash = excluded.settings_hash,
            discovered_sessions = excluded.discovered_sessions,
            indexed_sessions = excluded.indexed_sessions,
            failed_sessions = 0,
            last_completed_at = excluded.last_completed_at,
            last_success_at = excluded.last_success_at,
            error_code = NULL,
            error_detail = NULL",
    )
    .bind(&result.source_instance_id)
    .bind(if result.partial { "partial" } else { "ready" })
    .bind(generation)
    .bind(CATALOG_PARSER_VERSION)
    .bind(&result.config_root_hash)
    .bind(total_sessions)
    .bind(result.as_of)
    .bind((!result.partial).then_some(result.as_of))
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(map_remote_catalog_sql_error)?;
    Ok(true)
}

// 校验游标代次与请求代次一致并解析分页偏移。
pub(super) fn remote_cursor_offset(cursor: &str, generation: u64) -> Result<usize, String> {
    let (cursor_generation, offset) = cursor
        .trim()
        .split_once(':')
        .ok_or_else(|| "history_remote_cursor_invalid".to_string())?;
    if cursor_generation.parse::<u64>().ok() != Some(generation) {
        return Err("history_remote_cursor_invalid".to_string());
    }
    offset
        .parse::<usize>()
        .map_err(|_| "history_remote_cursor_invalid".to_string())
}

// 事务标记远程实例及其活动会话为过期，并保存同步错误码。
pub(crate) async fn mark_remote_stale(
    source_instance_id: &str,
    error_code: &str,
) -> Result<(), String> {
    if source_instance_id.trim().is_empty() {
        return Ok(());
    }
    let mut conn = open_catalog().await?;
    let now = now_millis();
    let mut tx = conn.begin().await.map_err(|err| err.to_string())?;
    sqlx::query(
        "UPDATE history_source_instances
         SET freshness_state = 'stale', updated_at = ?1
         WHERE id = ?2 AND transport_kind = 'ssh'",
    )
    .bind(now)
    .bind(source_instance_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "UPDATE history_sessions
         SET freshness_state = 'stale'
         WHERE source_instance_id = ?1 AND lifecycle_state = 'active'",
    )
    .bind(source_instance_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "UPDATE history_source_state
         SET phase = 'stale', error_code = ?1, error_detail = NULL
         WHERE source_instance_id = ?2",
    )
    .bind(error_code)
    .bind(source_instance_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(())
}

// 读取活动远程摘要，按项目与查询筛选后分页返回只读结果。
pub(crate) async fn list_remote_cached(
    source_instance_id: &str,
    project_path: Option<&str>,
    query: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<Vec<Value>, String> {
    let mut conn = open_catalog().await?;
    let rows = sqlx::query(
        "SELECT hs.source_session_id, i.source_id, hs.project_key, hs.cwd, hs.title,
                hs.branch, hs.created_at, hs.updated_at, hs.message_count,
                hs.input_tokens, hs.output_tokens, hs.cache_read_tokens,
                hs.cache_creation_tokens, hs.total_cost_usd, hs.dominant_model, hs.current_model,
                hs.parser_version, hs.last_seen_generation, hs.raw_pointers_json,
                hs.materialization_level, hs.freshness_state,
                COALESCE(hs.as_of, i.as_of) AS as_of, i.remote_identity_json
         FROM history_sessions hs
         JOIN history_source_instances i ON i.id = hs.source_instance_id
         WHERE hs.source_instance_id = ?1 AND i.activation_state = 'active'
           AND i.transport_kind = 'ssh' AND hs.storage_kind = 'remote'
           AND hs.lifecycle_state = 'active'
           AND hs.parse_status = 'ok'
         ORDER BY hs.updated_at DESC, hs.source_session_id ASC",
    )
    .bind(source_instance_id)
    .fetch_all(&mut conn)
    .await
    .map_err(|err| err.to_string())?;
    let normalized_project = project_path.map(normalize_history_path);
    let normalized_query = query
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let mut values = Vec::new();
    for row in rows {
        let cwd = row
            .try_get::<Option<String>, _>("cwd")
            .map_err(|err| err.to_string())?;
        let project_key: String = row.try_get("project_key").map_err(|err| err.to_string())?;
        if normalized_project.as_ref().is_some_and(|project| {
            let cwd_matches = cwd.as_deref().is_some_and(|cwd| {
                let cwd = normalize_history_path(cwd);
                cwd == *project || cwd.starts_with(&format!("{project}/"))
            });
            !cwd_matches
                && !claude_project_key_from_path(project).eq_ignore_ascii_case(&project_key)
        }) {
            continue;
        }
        let source_session_id: String = row
            .try_get("source_session_id")
            .map_err(|err| err.to_string())?;
        let source_id: String = row.try_get("source_id").map_err(|err| err.to_string())?;
        let title: String = row.try_get("title").map_err(|err| err.to_string())?;
        let branch: Option<String> = row.try_get("branch").map_err(|err| err.to_string())?;
        if normalized_query.as_ref().is_some_and(|query| {
            ![
                source_session_id.as_str(),
                source_id.as_str(),
                project_key.as_str(),
                title.as_str(),
                branch.as_deref().unwrap_or_default(),
                cwd.as_deref().unwrap_or_default(),
            ]
            .iter()
            .any(|value| value.to_lowercase().contains(query))
        }) {
            continue;
        }
        if values.len() < offset {
            values.push(Value::Null);
            continue;
        }
        let raw_pointers = row
            .try_get::<Option<String>, _>("raw_pointers_json")
            .map_err(|err| err.to_string())?
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| json!([]));
        let remote_identity = row
            .try_get::<Option<String>, _>("remote_identity_json")
            .map_err(|err| err.to_string())?
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| json!({}));
        values.push(json!({
            "sessionId": source_session_id,
            "source": source_id,
            "projectKey": project_key,
            "title": title,
            "filePath": "",
            "cwd": cwd,
            "createdAt": row.try_get::<i64, _>("created_at").map_err(|err| err.to_string())?,
            "updatedAt": row.try_get::<i64, _>("updated_at").map_err(|err| err.to_string())?,
            "messageCount": row.try_get::<i64, _>("message_count").map_err(|err| err.to_string())?,
            "branch": branch,
            "sessionRef": {
                "sourceId": source_id,
                "sourceInstanceId": source_instance_id,
                "sourceSessionId": source_session_id,
                "transportKind": "ssh",
                "rawPointers": raw_pointers,
            },
            "usage": {
                "inputTokens": row.try_get::<i64, _>("input_tokens").map_err(|err| err.to_string())?,
                "outputTokens": row.try_get::<i64, _>("output_tokens").map_err(|err| err.to_string())?,
                "cacheReadTokens": row.try_get::<i64, _>("cache_read_tokens").map_err(|err| err.to_string())?,
                "cacheCreationTokens": row.try_get::<i64, _>("cache_creation_tokens").map_err(|err| err.to_string())?,
                "totalCostUsd": row.try_get::<f64, _>("total_cost_usd").map_err(|err| err.to_string())?,
                "dominantModel": row.try_get::<Option<String>, _>("dominant_model").map_err(|err| err.to_string())?,
                "currentModel": row.try_get::<Option<String>, _>("current_model").map_err(|err| err.to_string())?,
            },
            "parserVersion": row.try_get::<i64, _>("parser_version").map_err(|err| err.to_string())?,
            "indexGeneration": row.try_get::<i64, _>("last_seen_generation").map_err(|err| err.to_string())?,
            "materializationLevel": row.try_get::<String, _>("materialization_level").map_err(|err| err.to_string())?,
            "freshnessState": row.try_get::<String, _>("freshness_state").map_err(|err| err.to_string())?,
            "asOf": row.try_get::<Option<i64>, _>("as_of").map_err(|err| err.to_string())?,
            "remoteIdentity": remote_identity,
            "readOnly": true,
        }));
        if values.iter().filter(|value| !value.is_null()).count() >= limit {
            break;
        }
    }
    Ok(values
        .into_iter()
        .filter(|value| !value.is_null())
        .collect())
}
