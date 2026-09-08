use super::super::*;
use super::{V2LegacySessionRow, V2SourceInstance};
use log::warn;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

// 读取已配置且非 SSH 的活动第二代来源实例。
pub(super) async fn active_v2_source_instances(
    conn: &mut SqliteConnection,
) -> Result<Vec<V2SourceInstance>, String> {
    let rows = sqlx::query(
        "SELECT id, source_id, settings_hash
         FROM history_source_instances
         WHERE activation_state = 'active'
           AND scope_kind = 'configured'
           AND transport_kind <> 'ssh'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    rows.into_iter()
        .map(|row| {
            Ok(V2SourceInstance {
                id: row.try_get("id").map_err(|err| err.to_string())?,
                source_id: row.try_get("source_id").map_err(|err| err.to_string())?,
                settings_hash: row
                    .try_get("settings_hash")
                    .map_err(|err| err.to_string())?,
            })
        })
        .collect()
}

// 按根目录及来源读取旧目录会话与文件指纹。
pub(super) async fn legacy_sessions_for_v2(
    conn: &mut SqliteConnection,
    roots_key: &str,
    source_id: &str,
) -> Result<Vec<V2LegacySessionRow>, String> {
    let rows = sqlx::query(
        "SELECT file_path, source, project_key, session_id,
                file_created_at, file_updated_at, file_size
         FROM history_catalog_sessions
         WHERE roots_key = ?1 AND source = ?2
         ORDER BY updated_at DESC, file_path ASC",
    )
    .bind(roots_key)
    .bind(source_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    rows.into_iter()
        .map(|row| {
            let file_path: String = row.try_get("file_path").map_err(|err| err.to_string())?;
            Ok(V2LegacySessionRow {
                file_ref: SessionFileRef {
                    source: row.try_get("source").map_err(|err| err.to_string())?,
                    project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
                    path: PathBuf::from(file_path),
                },
                fingerprint: SessionFileFingerprint {
                    created_at: row
                        .try_get("file_created_at")
                        .map_err(|err| err.to_string())?,
                    updated_at: row
                        .try_get("file_updated_at")
                        .map_err(|err| err.to_string())?,
                    size: row
                        .try_get::<i64, _>("file_size")
                        .map_err(|err| err.to_string())?
                        .max(0) as u64,
                },
                session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
            })
        })
        .collect()
}

// 读取匹配当前解析器和模型版本的会话指纹映射。
pub(super) async fn existing_v2_session_fingerprints(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query(
        "SELECT source_session_id, fingerprint_value
         FROM history_sessions
         WHERE source_instance_id = ?1
           AND parser_version = ?2
           AND model_version = ?3",
    )
    .bind(source_instance_id)
    .bind(HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION)
    .bind(HISTORY_INDEX_V2_ADAPTER_MODEL_VERSION)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get("source_session_id")
                    .map_err(|err| err.to_string())?,
                row.try_get("fingerprint_value")
                    .map_err(|err| err.to_string())?,
            ))
        })
        .collect()
}

// 重新解析原会话，并在事务中替换第二代会话及消息、用量和工具数据。
pub(super) async fn replace_v2_session(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    source_instance_id: &str,
    generation: u64,
    row: &V2LegacySessionRow,
) -> Result<(), String> {
    let mut parts = scan_session_detail_parts(&row.file_ref);
    if row.file_ref.source == "codex" {
        let codex_thread_names = super::super::codex_thread_name_index(roots);
        super::super::apply_codex_thread_name(
            &row.file_ref,
            &codex_thread_names,
            &mut parts.computed,
        );
    }
    let adapted =
        build_v2_adapter_session_from_parts(&row.file_ref, roots, row.fingerprint, &parts);
    let session_ref = adapted.session_ref;
    let stats = &parts.computed.stats;
    let raw_pointers_json =
        serde_json::to_string(&session_ref.raw_pointers).map_err(|err| err.to_string())?;
    let cwd_normalized = session_ref.cwd.as_deref().map(normalize_history_path);
    let now = now_millis();
    let mut tx = conn.begin().await.map_err(|err| err.to_string())?;
    sqlx::query(
        "DELETE FROM history_sessions
         WHERE source_instance_id = ?1 AND source_session_id = ?2",
    )
    .bind(source_instance_id)
    .bind(&session_ref.source_session_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    let result = sqlx::query(
        "INSERT INTO history_sessions(
            source_instance_id, source_session_id, storage_kind, primary_path,
            database_path, raw_key, project_key, cwd, cwd_normalized, title, branch,
            lifecycle_state, created_at, updated_at, timestamp_quality, message_count,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            total_cost_usd, usage_quality, cost_kind, fingerprint_kind, fingerprint_value,
            dominant_model, current_model, context_window, last_context_tokens, reasoning_effort,
            tool_call_count, parser_version, model_version, parse_status, raw_pointers_json,
            parent_session_id, last_seen_generation, indexed_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            'active', ?12, ?13, 'reported', ?14,
            ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, 'file-stat', ?22,
            ?23, ?24, ?25, ?26, ?27,
            ?28, ?29, ?30, 'ok', ?31, ?32, ?33, ?34
         )",
    )
    .bind(source_instance_id)
    .bind(&session_ref.source_session_id)
    .bind(&session_ref.storage_kind)
    .bind(&session_ref.primary_path)
    .bind(&session_ref.database_path)
    .bind(&session_ref.raw_key)
    .bind(&session_ref.project_key)
    .bind(&session_ref.cwd)
    .bind(&cwd_normalized)
    .bind(&session_ref.title)
    .bind(&session_ref.branch)
    .bind(session_ref.created_at)
    .bind(session_ref.updated_at)
    .bind(adapted.messages.len() as i64)
    .bind(stats.input_tokens as i64)
    .bind(stats.output_tokens as i64)
    .bind(stats.cache_read_tokens as i64)
    .bind(stats.cache_creation_tokens as i64)
    .bind(stats.total_cost_usd)
    .bind(
        if stats.input_tokens > 0
            || stats.output_tokens > 0
            || stats.cache_read_tokens > 0
            || stats.cache_creation_tokens > 0
        {
            "parsed"
        } else {
            "unknown"
        },
    )
    .bind(if stats.total_cost_usd > 0.0 {
        "reported"
    } else {
        "unknown"
    })
    .bind(&session_ref.fingerprint_value)
    .bind(&stats.dominant_model)
    .bind(&stats.current_model)
    .bind(stats.context_window.map(|value| value as i64))
    .bind(stats.last_context_tokens.map(|value| value as i64))
    .bind(&stats.reasoning_effort)
    .bind(stats.tool_call_count as i64)
    .bind(HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION)
    .bind(HISTORY_INDEX_V2_ADAPTER_MODEL_VERSION)
    .bind(raw_pointers_json)
    .bind(&parts.computed.parent_session_id)
    .bind(generation as i64)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    let session_row_id = result.last_insert_rowid();
    for message in adapted.messages {
        let result = sqlx::query(
            "INSERT INTO history_messages(
                session_id, message_index, role, display_content, timestamp_ms,
                model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, editable, raw_pointers_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )
        .bind(session_row_id)
        .bind(message.message_index as i64)
        .bind(message.role)
        .bind(message.display_content)
        .bind(message.timestamp_ms)
        .bind(message.model)
        .bind(message.input_tokens.map(|value| value as i64))
        .bind(message.output_tokens.map(|value| value as i64))
        .bind(message.cache_read_tokens.map(|value| value as i64))
        .bind(message.cache_creation_tokens.map(|value| value as i64))
        .bind(if message.editable { 1_i64 } else { 0_i64 })
        .bind(serde_json::to_string(&message.raw_pointers).map_err(|err| err.to_string())?)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
        let message_row_id = result.last_insert_rowid();
        for (part_index, part) in message.parts.iter().enumerate() {
            sqlx::query(
                "INSERT INTO history_message_parts(
                    message_id, part_index, kind, text_content, tool_call_id, tool_name
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .bind(message_row_id)
            .bind(part_index as i64)
            .bind(&part.kind)
            .bind(&part.content)
            .bind(&part.call_id)
            .bind(&part.tool_name)
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
        }
    }
    for event in &stats.usage_events {
        sqlx::query(
            "INSERT INTO history_usage_events(
                session_id, event_index, timestamp_ms, model, input_tokens,
                output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                raw_pointers_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
        )
        .bind(session_row_id)
        .bind(event.event_index as i64)
        .bind(event.timestamp_ms)
        .bind(&event.model)
        .bind(event.usage.input_tokens as i64)
        .bind(event.usage.output_tokens as i64)
        .bind(event.usage.cache_read_tokens as i64)
        .bind(event.usage.cache_creation_tokens as i64)
        .bind(event.usage.total_cost_usd)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    for (model, usage) in &stats.model_usage {
        sqlx::query(
            "INSERT INTO history_session_model_usage(
                session_id, model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, cost_usd
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(session_row_id)
        .bind(model)
        .bind(usage.input_tokens as i64)
        .bind(usage.output_tokens as i64)
        .bind(usage.cache_read_tokens as i64)
        .bind(usage.cache_creation_tokens as i64)
        .bind(usage.total_cost_usd)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    for (event_index, event) in parts.tool_events.iter().enumerate() {
        sqlx::query(
            "INSERT INTO history_tool_events(
                session_id, message_id, event_index, call_id, name, category, status,
                timestamp_ms, duration_ms, input_summary, output_summary,
                input_json, output_json, raw_pointers_json, source_extension_json
             ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, NULL, NULL)",
        )
        .bind(session_row_id)
        .bind(event_index as i64)
        .bind(&event.call_id)
        .bind(&event.name)
        .bind(&event.category)
        .bind(&event.status)
        .bind(
            event
                .timestamp
                .as_deref()
                .and_then(parse_timestamp_millis_str),
        )
        .bind(event.duration_ms.map(|value| value as i64))
        .bind(&event.input_summary)
        .bind(&event.output_summary)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    let mut change_index = 0_i64;
    for change in &parts.file_changes {
        for operation in &change.operations {
            sqlx::query(
                "INSERT INTO history_file_changes(
                    session_id, change_index, message_id, source_kind, tool_name, file_path,
                    old_text, new_text, patch, additions, deletions, timestamp_ms, raw_pointers_json
                 ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
            )
            .bind(session_row_id)
            .bind(change_index)
            .bind(&operation.source)
            .bind(&operation.tool_name)
            .bind(&operation.file_path)
            .bind(&operation.old_text)
            .bind(&operation.new_text)
            .bind(&operation.patch)
            .bind(operation.additions as i64)
            .bind(operation.deletions as i64)
            .bind(
                operation
                    .timestamp
                    .as_deref()
                    .and_then(parse_timestamp_millis_str),
            )
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
            change_index += 1;
        }
    }
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(())
}

// 删除指定来源实例与发现键的索引失败记录。
pub(super) async fn clear_v2_index_failure(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
    discovery_key: &str,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM history_index_failures
         WHERE source_instance_id = ?1 AND discovery_key = ?2",
    )
    .bind(source_instance_id)
    .bind(discovery_key)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

// 记录会话索引错误、指纹及时间，重复失败时递增重试计数。
pub(super) async fn record_v2_index_failure(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
    row: &V2LegacySessionRow,
    error_code: &str,
    error_detail: &str,
) -> Result<(), String> {
    let now = now_millis();
    let session_ref_json = serde_json::to_string(&json!({
        "sourceId": row.file_ref.source.as_str(),
        "sourceSessionId": row.session_id.as_str(),
        "projectKey": row.file_ref.project_key.as_str(),
        "primaryPath": row.file_ref.path.to_string_lossy(),
    }))
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO history_index_failures(
            source_instance_id, discovery_key, session_ref_json, fingerprint_value,
            parser_version, error_code, error_detail, first_failed_at, last_failed_at,
            retry_count
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 0)
         ON CONFLICT(source_instance_id, discovery_key) DO UPDATE SET
            session_ref_json = excluded.session_ref_json,
            fingerprint_value = excluded.fingerprint_value,
            parser_version = excluded.parser_version,
            error_code = excluded.error_code,
            error_detail = excluded.error_detail,
            last_failed_at = excluded.last_failed_at,
            retry_count = history_index_failures.retry_count + 1",
    )
    .bind(source_instance_id)
    .bind(&row.session_id)
    .bind(session_ref_json)
    .bind(v2_fingerprint_value(row.fingerprint))
    .bind(HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION)
    .bind(error_code)
    .bind(error_detail)
    .bind(now)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

// 删除已有集合中未在当前发现集合出现的会话。
pub(super) async fn delete_stale_v2_sessions(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
    existing_ids: &HashSet<String>,
    current_ids: &HashSet<String>,
) -> Result<usize, String> {
    let stale: Vec<&String> = existing_ids
        .iter()
        .filter(|id| !current_ids.contains(*id))
        .collect();
    for session_id in &stale {
        sqlx::query(
            "DELETE FROM history_sessions
             WHERE source_instance_id = ?1 AND source_session_id = ?2",
        )
        .bind(source_instance_id)
        .bind(*session_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    }
    Ok(stale.len())
}

// 统计指定来源实例的会话数与消息行数。
pub(super) async fn v2_count_sessions_messages(
    conn: &mut SqliteConnection,
    source_instance_id: &str,
) -> Result<(i64, i64), String> {
    let sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM history_sessions WHERE source_instance_id = ?1")
            .bind(source_instance_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
    let messages: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM history_messages m
         JOIN history_sessions s ON s.id = m.session_id
         WHERE s.source_instance_id = ?1",
    )
    .bind(source_instance_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok((sessions, messages))
}

// 汇总指定旧目录来源的会话消息计数。
pub(super) async fn legacy_count_messages(
    conn: &mut SqliteConnection,
    roots_key: &str,
    source_id: &str,
) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(message_count), 0)
         FROM history_catalog_sessions s
         WHERE s.roots_key = ?1 AND s.source = ?2",
    )
    .bind(roots_key)
    .bind(source_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| err.to_string())
}

// 按指纹增量构建单实例第二代索引，记录失败、数量差异和同步状态。
pub(super) async fn shadow_build_v2_for_instance(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    roots_key: &str,
    generation: u64,
    instance: &V2SourceInstance,
    codex_thread_name_changed: bool,
) -> Result<(), String> {
    let started_at = now_millis();
    let run_id = format!("shadow-{}-{}-{}", instance.id, generation, started_at);
    let sessions = legacy_sessions_for_v2(conn, roots_key, &instance.source_id).await?;
    let discovered_sessions = sessions.len();
    sqlx::query(
        "INSERT INTO history_sync_runs(
            id, source_instance_id, generation, trigger_kind, phase, discovery_complete,
            discovered_sessions, changed_sessions, indexed_sessions, failed_sessions,
            started_at
         ) VALUES (?1, ?2, ?3, 'shadow', 'indexing', 1, ?4, 0, 0, 0, ?5)",
    )
    .bind(&run_id)
    .bind(&instance.id)
    .bind(generation as i64)
    .bind(discovered_sessions as i64)
    .bind(started_at)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;

    let existing = existing_v2_session_fingerprints(conn, &instance.id).await?;
    let existing_ids: HashSet<String> = existing.keys().cloned().collect();
    let current_ids: HashSet<String> = sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    let stale_count =
        delete_stale_v2_sessions(conn, &instance.id, &existing_ids, &current_ids).await?;
    let mut changed_sessions = stale_count;
    let mut indexed_sessions = 0usize;
    let mut failed_sessions = 0usize;
    for session in &sessions {
        let fingerprint_value = v2_fingerprint_value(session.fingerprint);
        if existing.get(&session.session_id).is_some_and(|existing| {
            existing == &fingerprint_value
                && !(codex_thread_name_changed && instance.source_id == "codex")
        }) {
            continue;
        }
        match replace_v2_session(conn, roots, &instance.id, generation, session).await {
            Ok(()) => {
                let _ = clear_v2_index_failure(conn, &instance.id, &session.session_id).await;
                changed_sessions = changed_sessions.saturating_add(1);
                indexed_sessions = indexed_sessions.saturating_add(1);
            }
            Err(err) => {
                failed_sessions = failed_sessions.saturating_add(1);
                let _ = record_v2_index_failure(
                    conn,
                    &instance.id,
                    session,
                    "v2_shadow_session_failed",
                    &err,
                )
                .await;
                warn!(
                    "history v2 shadow session failed: instance={} source={} session={} err={}",
                    instance.id, instance.source_id, session.session_id, err
                );
            }
        }
    }

    let (v2_sessions, v2_messages) = v2_count_sessions_messages(conn, &instance.id).await?;
    let legacy_messages = legacy_count_messages(conn, roots_key, &instance.source_id).await?;
    let mut warnings = Vec::new();
    if v2_sessions != discovered_sessions as i64 {
        warnings.push(json!({
            "code": "session_count_mismatch",
            "legacy": discovered_sessions,
            "v2": v2_sessions,
        }));
    }
    if v2_messages != legacy_messages {
        warnings.push(json!({
            "code": "message_count_mismatch",
            "legacy": legacy_messages,
            "v2": v2_messages,
        }));
    }
    let warnings_json = if warnings.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&warnings).map_err(|err| err.to_string())?)
    };
    let phase = if failed_sessions > 0 {
        "completed_with_failures"
    } else if warnings_json.is_some() {
        "completed_with_warnings"
    } else {
        "ready"
    };
    let completed_at = now_millis();
    sqlx::query(
        "UPDATE history_sync_runs
         SET phase = ?1, changed_sessions = ?2, indexed_sessions = ?3,
             failed_sessions = ?4, warnings_json = ?5, completed_at = ?6
         WHERE id = ?7",
    )
    .bind(phase)
    .bind(changed_sessions as i64)
    .bind(indexed_sessions as i64)
    .bind(failed_sessions as i64)
    .bind(warnings_json.as_deref())
    .bind(completed_at)
    .bind(&run_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO history_source_state(
            source_instance_id, phase, generation, parser_version, settings_hash,
            discovered_sessions, indexed_sessions, failed_sessions,
            last_started_at, last_completed_at, last_success_at, error_code, error_detail
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(source_instance_id) DO UPDATE SET
            phase = excluded.phase,
            generation = excluded.generation,
            parser_version = excluded.parser_version,
            settings_hash = excluded.settings_hash,
            discovered_sessions = excluded.discovered_sessions,
            indexed_sessions = excluded.indexed_sessions,
            failed_sessions = excluded.failed_sessions,
            last_started_at = excluded.last_started_at,
            last_completed_at = excluded.last_completed_at,
            last_success_at = excluded.last_success_at,
            error_code = excluded.error_code,
            error_detail = excluded.error_detail",
    )
    .bind(&instance.id)
    .bind(phase)
    .bind(generation as i64)
    .bind(HISTORY_INDEX_V2_ADAPTER_PARSER_VERSION)
    .bind(&instance.settings_hash)
    .bind(discovered_sessions as i64)
    .bind(v2_sessions)
    .bind(failed_sessions as i64)
    .bind(started_at)
    .bind(completed_at)
    .bind(if failed_sessions > 0 {
        None
    } else {
        Some(completed_at)
    })
    .bind(if failed_sessions > 0 {
        Some("v2_shadow_session_failed")
    } else {
        None
    })
    .bind(if failed_sessions > 0 {
        Some(format!("{failed_sessions} session(s) failed"))
    } else {
        None
    })
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

// 依次为活动本地来源实例执行第二代影子索引构建。
pub(super) async fn shadow_build_v2(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    roots_key: &str,
    generation: u64,
    codex_thread_name_changed: bool,
) -> Result<(), String> {
    for instance in active_v2_source_instances(conn).await? {
        shadow_build_v2_for_instance(
            conn,
            roots,
            roots_key,
            generation,
            &instance,
            codex_thread_name_changed,
        )
        .await?;
    }
    Ok(())
}
